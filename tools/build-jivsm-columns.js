#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.7 R3-1: Build public/geojson/jivsm-columns.json — the JIVSM V4
//  layered Vs/Vp COLUMN grid (per-cell distinct-layer bottoms on the
//  national 32-unit velocity ladder) from the same source archive as
//  tools/build-jivsm-grid.js (.cache/jshis/D-V4-STRUCT_DEEP-LYRD.zip,
//  891 MB CSV, J-SHIS terms permit processed derivatives — see the
//  license block in the output meta).
//
//  Column semantics (verified against the official dstrct API sample
//  .cache/jshis/dstrct_koto.json, mesh 53394606 — Koto-ku, Tokyo):
//    S0    = surface/seafloor depth (m, positive down)
//    D_i   = ABSOLUTE bottom of STN layer i+1; layer present iff
//            D_i > D_{i-1}; below the deepest distinct boundary the model
//            saturates (uniform halfspace — the runtime splices IASP91
//            there; see Physics.jivsmColumnAt).
//  Per output cell (block mean over the 1-km mesh cells inside it) we
//  store ONLY the distinct layers as RLE [stn (1-32), bottomBelowSurfaceM]
//  pairs — the layer velocities are national constants from the PYS table
//  (embedded in meta.pys), so depth is the only spatially varying datum.
//
//  Usage: node tools/build-jivsm-columns.js [--src=path] [--out=path]
//          [--res=0.125] [--verify-mesh=53394606]
// ================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const SRC_DEFAULT = '.cache/jshis/D-V4-STRUCT_DEEP-LYRD.zip';
const OUT_DEFAULT = 'public/geojson/jivsm-columns.json';
const PYS_ROWS = [
  [1600, 350, 1850], [1600, 400, 1850], [1700, 450, 1900], [1800, 500, 1900],
  [1800, 550, 1900], [2000, 600, 1900], [2000, 650, 1950], [2100, 700, 2000],
  [2100, 750, 2000], [2200, 800, 2000], [2300, 850, 2050], [2400, 900, 2050],
  [2400, 950, 2100], [2500, 1000, 2100], [2500, 1100, 2150], [2600, 1200, 2150],
  [2700, 1300, 2200], [3000, 1400, 2250], [3200, 1500, 2250], [3400, 1600, 2300],
  [3500, 1700, 2300], [3600, 1800, 2350], [3700, 1900, 2350], [3800, 2000, 2400],
  [4000, 2100, 2400], [4000, 2100, 2400], [5000, 2700, 2500], [4600, 2900, 2550],
  [5000, 2700, 2500], [5500, 3100, 2600], [5500, 3100, 2600], [5500, 3200, 2650]
];

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

// same single-entry zip reader as build-jivsm-grid.js
function unzipCsvStream(buf) {
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

function meshToLatLng(code) {
  const a = +code.slice(0, 2), b = +code.slice(2, 4);
  const c2 = +code[4], d2 = +code[5], c3 = +code[6], d3 = +code[7];
  return {
    lat: a * (2 / 3) + c2 / 12 + (c3 + 0.5) / 120,
    lng: 100 + b + d2 / 8 + (d3 + 0.5) / 80
  };
}

async function main() {
  const src = arg('src', SRC_DEFAULT);
  const outPath = arg('out', OUT_DEFAULT);
  const res = parseFloat(arg('res', '0.125'));
  const verifyMesh = arg('verify-mesh', '53394606');
  const LATS = [20, 46.5], LNGS = [121.5, 146.5];
  const nx = Math.round((LNGS[1] - LNGS[0]) / res), ny = Math.round((LATS[1] - LATS[0]) / res);
  console.log('inflating archive (891 MB CSV)...');
  const csv = unzipCsvStream(fs.readFileSync(src));

  // accumulate mean D_i and mean S0 per block cell
  const sums = Array.from({ length: nx * ny }, () => new Float64Array(33)); // [S0, D0..D31]
  const cnt = new Uint32Array(nx * ny);
  let rows = 0, verifyRow = null;
  const rl = readline.createInterface({
    input: require('stream').Readable.from(function* () {
      for (let i = 0; i < csv.length; i += 8 << 20) yield csv.slice(i, i + (8 << 20));
    }()),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line || line[0] === '#' || line[0] === ',') continue;
    const cols = line.split(',');
    const code = cols[0];
    if (code.length !== 8) continue;
    rows++;
    if (code === verifyMesh) verifyRow = cols.slice(1).map(parseFloat);
    const a = +code.slice(0, 2), b = +code.slice(2, 4);
    const c2 = +code[4], d2 = +code[5], c3 = +code[6], d3 = +code[7];
    if (!(a > 0) || c2 > 7 || d2 > 7 || c3 > 9 || d3 > 9) continue;
    const lat = a * (2 / 3) + c2 / 12 + (c3 + 0.5) / 120;
    const lng = 100 + b + d2 / 8 + (d3 + 0.5) / 80;
    const cx = Math.floor((lng - LNGS[0]) / res), cy = Math.floor((lat - LATS[0]) / res);
    if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) continue;
    const acc = sums[cy * nx + cx];
    acc[0] += parseFloat(cols[1]) || 0;
    for (let i = 0; i < 32; i++) acc[1 + i] += parseFloat(cols[2 + i]) || 0;
    cnt[cy * nx + cx]++;
  }

  // dstrct cross-check on the raw mesh row BEFORE block averaging
  if (!verifyRow) throw new Error('verify mesh ' + verifyMesh + ' not found in source');
  const expectKoto = { 0: 85.5, 3: 90.2, 4: 228.5, 8: 462.6, 12: 1276.1, 19: 2402.8 };
  for (const [di, v] of Object.entries(expectKoto)) {
    if (Math.abs(verifyRow[1 + +di] - v) > 0.05) throw new Error( // [0]=S0, [1+i]=D_i
      `dstrct verification failed: D${di}=${verifyRow[1 + +di]} vs official ${v}`);
  }
  console.log('dstrct anchor OK (mesh', verifyMesh + ', 6 boundaries bit-exact)');

  // RLE columns per block cell
  const data = {};
  let layerTot = 0, cells = 0, maxLayers = 0, deepCells = 0;
  for (let idx = 0; idx < nx * ny; idx++) {
    if (!cnt[idx]) continue;
    const acc = sums[idx], n = cnt[idx];
    const s0 = acc[0] / n;
    const col = [];
    let prevTop = s0;
    for (let i = 0; i < 32; i++) {
      const bottom = acc[1 + i] / n;
      if (bottom > prevTop + 0.5) {
        col.push(i + 1, Math.round(bottom - s0)); // STN (1-32), bottom below surface (m)
        prevTop = bottom;
      }
    }
    if (!col.length) continue; // no distinct structure (outcrop) — bedrock at surface
    data[idx] = col;
    cells++;
    layerTot += col.length / 2;
    maxLayers = Math.max(maxLayers, col.length / 2);
    if (col[col.length - 1] > 3000) deepCells++;
  }
  const doc = {
    schema: 'quake-sim-jivsm-columns-v1',
    origin: [LNGS[0], LATS[0]],
    res: res, nx: nx, ny: ny,
    data: data,
    pys: PYS_ROWS,
    meta: {
      dataset: 'J-SHIS 深部地盤構造モデル JIVSM V4 (D-V4-STRUCT_DEEP-LYRD, 2023-12-11) — layered velocity columns: distinct-layer bottoms (m below surface) on the national 32-unit PYS ladder, ' + res + '° block mean',
      source: 'National Research Institute for Earth Science and Disaster Resilience (NIED) J-SHIS — https://www.j-shis.bosai.go.jp/map/JSHIS2/data/D/V4/STRUCT_DEEP/D-V4-STRUCT_DEEP-LYRD.zip',
      license: 'J-SHIS利用規約 https://www.j-shis.bosai.go.jp/agreement — processed derivative; cite J-SHIS / NIED on republication',
      columnSemantics: 'cell value = flat [STN, bottomM, STN, bottomM, ...]; layer velocities are meta.pys[STN-1] = [Vp m/s, Vs m/s, rho kg/m3]; below the deepest listed boundary JIVSM saturates (uniform) — the runtime splices IASP91 there; absent cells = bedrock outcrop',
      pysSource: '.cache/jshis/D-V4-STRUCT_DEEP-PYS.csv (embedded — STN,SVP,SVS,SRO,SQP,SQS)',
      verification: 'mesh 53394606 boundaries bit-verified against the official dstrct API sample (.cache/jshis/dstrct_koto.json)',
      statistics: {
        sourceRows: rows, outputCells: cells, meanDistinctLayers: +(layerTot / cells).toFixed(2),
        maxDistinctLayers: maxLayers, cellsDeeper3000m: deepCells
      },
      builtAt: new Date().toISOString().slice(0, 10),
      builtBy: 'tools/build-jivsm-columns.js'
    }
  };
  fs.writeFileSync(outPath, JSON.stringify(doc));
  console.log('rows', rows, '-> cells', cells, '| mean layers', (layerTot / cells).toFixed(2),
    '| max', maxLayers, '| >3km deep', deepCells);
  console.log('wrote', outPath, (fs.statSync(outPath).size / 1048576).toFixed(2) + ' MB', nx + 'x' + ny);
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
