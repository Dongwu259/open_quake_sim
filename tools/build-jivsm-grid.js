#!/usr/bin/env node
'use strict';
// ================================================================
//  Build public/geojson/jivsm-bedrock.json from the J-SHIS 深部地盤構造
//  モデル JIVSM V4 (D-V4-STRUCT_DEEP-LYRD.zip — 250m-code-ordered national
//  CSV, 891 MB uncompressed, free download under the J-SHIS terms).
//
//  File layout (verified 2026-08-24 against the live archive):
//    header: # CODE,S0,D0..D31
//    CODE = standard 8-digit 1km mesh (1st 4 digits + 2nd mesh two digits
//           0-7 each + 3rd mesh two digits 0-9 each):
//    lat  = a*(2/3) + c2/12 + c3/120 (+1/240 to centre)
//    lng  = 100 + b + d2/8 + d3/80   (+1/160 to centre)
//    S0   = ground/seafloor surface (m, depth positive)
//    D_i  = depth (m) of the BOTTOM of layer i+1; consecutive equal values
//           are zero-thickness (absent) layers. Layer velocities come from
//    the PYS table (STN i -> Vp, Vs, rho, Qp, Qs); Vs ladder 350..3200 m/s.
//
//  Derived product (processed derivative — J-SHIS Article 5.1 permits
//  distribution with attribution; source ZIP stays in .cache/):
//    * engineering-bedrock depth: surface to the top of the first layer
//      with Vs >= 700 m/s   -> standard research-grid array (data)
//    * seismic-bedrock depth: surface to the top of the first layer with
//      Vs >= 2700 m/s       -> meta.extraSeismicBedrock grid
//    both block-averaged to --res degrees; absent/ocean cells -> 0.
//
//  Usage: node tools/build-jivsm-grid.js [--src=path] [--out=path] [--res=0.05]
// ================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const SRC_DEFAULT = '.cache/jshis/D-V4-STRUCT_DEEP-LYRD.zip';
const OUT_DEFAULT = 'public/geojson/jivsm-bedrock.json';
// JIVSM V4 PYS S-wave ladder (STN 1..32) — embedded from D-V4-STRUCT_DEEP-PYS.csv
const PYS_VS = [350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000,
  1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2100, 2700, 2900, 2700, 3100, 3100, 3200];

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

function unzipCsvStream(buf) {
  // single stored/deflated entry; inflate the whole CSV (891 MB) into memory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip EOCD not found — archive truncated');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(ptr + 10), compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28), extraLen = buf.readUInt16LE(ptr + 30), commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('latin1');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (!/\.csv$/i.test(name)) continue;
    const lhName = buf.readUInt16LE(localOff + 26), lhExtra = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhName + lhExtra;
    const comp = buf.slice(dataStart, dataStart + compSize);
    return method === 0 ? comp : zlib.inflateRawSync(comp);
  }
  throw new Error('no CSV entry in archive');
}

/** Depth (m below surface) of the top of the first present layer with
 *  Vs >= threshold; 0 when the bedrock outcrops. When no explicit layer
 *  qualifies (the official columns SATURATE — e.g. Kanto basin cells define
 *  nothing below the deepest distinct boundary because everything below is
 *  the basement halfspace, verified against the official dstrct API), the
 *  deepest distinct boundary IS the bedrock top. */
function bedrockDepth(depths, s0, threshold, saturateFallback) {
  let lastDistinct = null;
  for (let i = 0; i < PYS_VS.length; i++) {
    const bottom = depths[i], topPrev = i > 0 ? depths[i - 1] : 0;
    if (bottom > topPrev) lastDistinct = topPrev;
    if (PYS_VS[i] < threshold) continue;
    if (bottom > topPrev) return Math.max(0, topPrev - s0); // first present >= threshold layer: its TOP
  }
  if (saturateFallback && lastDistinct != null) return Math.max(0, lastDistinct - s0);
  return 0;
}

async function main() {
  const src = arg('src', SRC_DEFAULT);
  const outPath = arg('out', OUT_DEFAULT);
  const res = parseFloat(arg('res', '0.05'));
  const LATS = [20, 46.5], LNGS = [121.5, 146.5];
  const nx = Math.round((LNGS[1] - LNGS[0]) / res), ny = Math.round((LATS[1] - LATS[0]) / res);
  console.log('inflating archive (891 MB CSV)...');
  const csv = unzipCsvStream(fs.readFileSync(src));

  const sumE = new Float64Array(nx * ny), sumS = new Float64Array(nx * ny);
  const cnt = new Uint32Array(nx * ny);
  const rl = readline.createInterface({
    input: require('stream').Readable.from(function* () {
      // one giant Buffer chunk overflows readline's string limit — 8 MB pieces
      for (let i = 0; i < csv.length; i += 8 << 20) yield csv.slice(i, i + (8 << 20));
    }()),
    crlfDelay: Infinity
  });
  let rows = 0, used = 0;
  for await (const line of rl) {
    if (!line || line[0] === '#' || line[0] === ',') continue;
    const cols = line.split(',');
    const code = cols[0];
    if (code.length !== 8) continue;
    rows++;
    const a = +code.slice(0, 2), b = +code.slice(2, 4);
    const c2 = +code[4], d2 = +code[5], c3 = +code[6], d3 = +code[7];
    if (!(a > 0) || c2 > 7 || d2 > 7 || c3 > 9 || d3 > 9) continue;
    const lat = a * (2 / 3) + c2 / 12 + (c3 + 0.5) / 120;
    const lng = 100 + b + d2 / 8 + (d3 + 0.5) / 80;
    const s0 = parseFloat(cols[1]) || 0;
    const depths = [];
    for (let i = 0; i < 32; i++) depths.push(parseFloat(cols[2 + i]) || 0);
    const eng = bedrockDepth(depths, s0, 700, false);
    const sei = bedrockDepth(depths, s0, 2700, true);
    const cx = Math.floor((lng - LNGS[0]) / res), cy = Math.floor((lat - LATS[0]) / res);
    if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) continue;
    const idx = cy * nx + cx;
    sumE[idx] += eng; sumS[idx] += sei; cnt[idx]++; used++;
  }
  const data = new Array(nx * ny).fill(0);
  const seis = new Array(nx * ny).fill(0);
  let cells = 0, sumEng = 0, deep = 0;
  for (let i = 0; i < nx * ny; i++) {
    if (!cnt[i]) continue;
    data[i] = Math.round(sumE[i] / cnt[i]);
    seis[i] = Math.round(sumS[i] / cnt[i]);
    cells++; sumEng += data[i];
    if (data[i] > 500) deep++;
  }
  const grid = {
    origin: [LNGS[0], LATS[0]],
    res: res, nx: nx, ny: ny, data: data,
    meta: {
      schema: 'quake-sim-jivsm-bedrock-v1',
      dataset: 'J-SHIS 深部地盤構造モデル JIVSM V4 (D-V4-STRUCT_DEEP-LYRD, 2023-12-11) — engineering-bedrock depth (top of first Vs>=700 m/s layer, m below surface), ' + res + '° block mean',
      source: 'National Research Institute for Earth Science and Disaster Resilience (NIED) J-SHIS — https://www.j-shis.bosai.go.jp/map/JSHIS2/data/D/V4/STRUCT_DEEP/D-V4-STRUCT_DEEP-LYRD.zip',
      license: 'J-SHIS利用規約 https://www.j-shis.bosai.go.jp/agreement — processed derivative; cite J-SHIS / NIED on republication',
      units: 'm below ground surface (0 = outcrop / no data)',
      extraSeismicBedrock: { description: 'same grid, top of first Vs>=2700 m/s layer (seismic bedrock)', data: seis },
      statistics: {
        sourceRows: rows, sourceCellsUsed: used, outputCellsWithData: cells,
        meanEngDepthM: Math.round(sumEng / cells),
        cellsEngDeeper500m: deep
      },
      builtAt: new Date().toISOString().slice(0, 10),
      builtBy: 'tools/build-jivsm-grid.js'
    }
  };
  fs.writeFileSync(outPath, JSON.stringify(grid));
  console.log('rows', rows, '-> cells', cells, '| mean eng depth', grid.meta.statistics.meanEngDepthM + 'm | cells>500m:', deep);
  console.log('wrote', outPath, (fs.statSync(outPath).size / 1048576).toFixed(2) + ' MB', nx + 'x' + ny);
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
