#!/usr/bin/env node
'use strict';
// ================================================================
//  Build public/geojson/vs30.json (the research-grid Vs30 layer the app
//  already knows how to consume: Physics.validateResearchGrid('vs30') +
//  lookupResearchGrid) from the J-SHIS 2020 surface-ground AVS30 mesh.
//
//  Source (free download under the J-SHIS terms, no account):
//    https://www.j-shis.bosai.go.jp/labs/wm2020/data/Z-WM2020-JAPAN-M250.zip
//    (CSV rows: 10-digit 250m mesh code, microtopography class, AVS30 m/s)
//
//  The 250m mesh is block-averaged onto a national 0.05° grid. Ocean /
//  no-data cells become 0 — the consumer treats non-positive lookups as
//  "no grid value" and falls back to station/regional-zone estimates.
//
//  This is a PROCESSED DERIVATIVE: the J-SHIS terms (Article 5.1) allow
//  free distribution of edited products with attribution; verbatim
//  redistribution of the source files is not permitted (Article 5.2).
//
//  Usage: node tools/build-vs30-grid.js [--src=path] [--out=path] [--res=0.05]
// ================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC_DEFAULT = '.cache/jshis/Z-WM2020-JAPAN-M250.zip';
const OUT_DEFAULT = 'public/geojson/vs30.json';

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

// 10-digit 250m mesh code -> {lat, lng} of the cell centre.
// Composition: 1st mesh (2 digits lat /1.5° + 2 digits lng -100),
// 2nd (1 digit x 5' lat / 1 digit x 1/8° lng), 3rd (1 digit x 30" lat /
// 1 digit x 45" lng), then a 4x4 quartering for 250m (1 digit each, 1-4).
function decodeMesh(code) {
  const a = +code.slice(0, 2), b = +code.slice(2, 4);
  const c = +code.slice(4, 5), d = +code.slice(5, 6);
  const e = +code.slice(6, 7), f = +code.slice(7, 8);
  const g = +code.slice(8, 9), h = +code.slice(9, 10);
  if (!(a && b) || c > 7 || d > 7 || e > 9 || f > 9 || g < 1 || g > 4 || h < 1 || h > 4) return null;
  const lat = a * (2 / 3) + c / 12 + e / 120 + (g - 0.5) / 480;
  const lng = 100 + b + d / 8 + f / 80 + (h - 0.5) / 320;
  return { lat, lng };
}

function main() {
  const src = arg('src', SRC_DEFAULT);
  const outPath = arg('out', OUT_DEFAULT);
  const res = parseFloat(arg('res', '0.05'));
  const LATS = [20, 46.5], LNGS = [121.5, 146.5];
  const nx = Math.round((LNGS[1] - LNGS[0]) / res), ny = Math.round((LATS[1] - LATS[0]) / res);

  // read the CSV straight out of the zip (stored or deflate entries)
  const buf = fs.readFileSync(src);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16), csv = null;
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
    csv = method === 0 ? comp : zlib.inflateRawSync(comp);
  }
  if (!csv) throw new Error('no CSV entry in ' + src);

  const sums = new Float64Array(nx * ny), cnts = new Uint32Array(nx * ny);
  let rows = 0, used = 0, skipped = 0;
  const text = csv.toString('utf8');
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line || line[0] === '#' || line[0] === ',') continue;
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const avs = parseFloat(cols[2]);
    rows++;
    if (!(avs > 0)) continue;
    const cell = decodeMesh(cols[0].trim());
    if (!cell) { skipped++; continue; }
    const cx = Math.floor((cell.lng - LNGS[0]) / res), cy = Math.floor((cell.lat - LATS[0]) / res);
    if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) { skipped++; continue; }
    const idx = cy * nx + cx;
    sums[idx] += avs; cnts[idx]++; used++;
  }
  const data = new Array(nx * ny).fill(0);
  let cells = 0, sumVs = 0, minVs = 1e9, maxVs = 0;
  for (let i = 0; i < nx * ny; i++) {
    if (!cnts[i]) continue;
    const v = sums[i] / cnts[i];
    data[i] = Math.round(v * 10) / 10;
    cells++; sumVs += v;
    if (v < minVs) minVs = v;
    if (v > maxVs) maxVs = v;
  }
  const grid = {
    origin: [LNGS[0], LATS[0]],
    res: res, nx: nx, ny: ny, data: data,
    meta: {
      schema: 'quake-sim-vs30-grid-v1',
      dataset: 'J-SHIS 2020 表層地盤データ AVS30 (Z-WM2020-JAPAN-M250, 250m mesh) block-averaged to ' + res + '°',
      source: 'National Research Institute for Earth Science and Disaster Resilience (NIED) J-SHIS — https://www.j-shis.bosai.go.jp/labs/wm2020/',
      license: 'J-SHIS利用規約 https://www.j-shis.bosai.go.jp/agreement — processed derivative; cite J-SHIS / NIED on republication',
      vs30SourceClass: 'j-shis-grid',
      statistics: {
        sourceRows: rows, sourceCellsUsed: used, skippedRows: skipped,
        outputCellsWithData: cells, meanVs30: +(sumVs / cells).toFixed(1),
        minVs30: +minVs.toFixed(1), maxVs30: +maxVs.toFixed(1)
      },
      builtAt: new Date().toISOString().slice(0, 10),
      builtBy: 'tools/build-vs30-grid.js'
    }
  };
  fs.writeFileSync(outPath, JSON.stringify(grid));
  console.log('rows', rows, '-> land cells', cells,
    'mean/min/max Vs30', grid.meta.statistics.meanVs30, minVs.toFixed(1), maxVs.toFixed(1));
  console.log('wrote', outPath, (fs.statSync(outPath).size / 1048576).toFixed(2) + ' MB', nx + 'x' + ny);
}
main();
