#!/usr/bin/env node
// v6.0.1 R5 收尾: landuse Manning 数据包构建器
// ------------------------------------------------------------------
// Source: 国土数値情報 土地利用細分メッシュ(ラスタ版) L03-b-14 (平成26年度/2014)
//   https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-L03-b_r.html
//   CC BY 4.0 (オープンデータ). Direct file pattern:
//   /ksj/gml/data/L03-b_r/L03-b_r-14/L03-b-14_<uuvv>.zip  (1次メッシュ tile)
// TIFF flavour (fixed, asserted): II LE, magic 42, 8-bit, 1 sample,
//   UNCOMPRESSED strips, palette photometric (pixel value == class code).
// Pixel-value classification (verified against the bundled LandUseCd-TIFF.htm,
//   Shift-JIS, 平成26年度): 10 田 / 20 その他の農用地 / 50 森林 / 60 荒地 /
//   70 建物用地 / 91 道路 / 92 鉄道 / 100 その他の用地 / 110 河川地及び湖沼 /
//   140 海浜 / 150 海水域 / 160 ゴルフ場 / 0 解析範囲外.
//   (NOTE: the 4-digit vector codes are the same numbers ×100; the raster
//   palette carries them divided by 100.)
//
// Output: public/geojson/landuse-manning.json
//   schema quake-sim-landuse-manning-v1 {origin,res,nx,ny,data:[classId]}
//   covering the REGIONAL_BATHY union box [132,30]-[144.5,43.5] at 0.025° —
//   the resolution of the regional/nested-fine tsunami grids where
//   inundation actually happens. The global 0.15° grid keeps the scalar
//   Manning (per-cell roughness is meaningless at 14-18 km cells).
// Downsampling: each 0.025° pack cell maps to exactly 20×30 source pixels
//   (0.025 = 20×1/800 lng = 30×(1/1200) lat); value = dominant non-zero
//   class by pixel count (ties → larger code); no valid pixel → 0.
//
// Manning class table (app.js LANDUSE_MANNING_BY_CLASS) — convention values
// from Japanese tsunami runup practice (小谷ほか 1998-family landuse sets as
// adopted by 内閣府 南海トラフ巨大地震モデル 2012 津波計算); where the
// literature spreads (荒地・道路・鉄道・海浜・ゴルフ場) mid-range choices are
// frozen here and in app.js. Sea keeps the project scalar default 0.025.
//
// Usage:
//   node tools/build-landuse-manning.js           # build + stats (no write)
//   node tools/build-landuse-manning.js --write   # write the pack JSON
//   node tools/build-landuse-manning.js --probe <zip>  # inspect one tile
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache/landuse');
const OUT = path.join(ROOT, 'public/geojson/landuse-manning.json');

const BASE = 'https://nlftp.mlit.go.jp/ksj/gml/data/L03-b_r/L03-b_r-14/L03-b-14_';
// Pack grid: REGIONAL_BATHY union (public/app.js), all edges 0.025 multiples,
// PLUS one extra east/north cell — the loader samples pack cells at solver
// grid CENTERS, and the easternmost/northernmost regional centers sit exactly
// on the bbox edge (e.g. 144.5); without the margin column/row those cells
// would silently fall back to the scalar Manning.
const ORIGIN = [132.0, 30.0];
const RES = 0.025;
const NX = 501, NY = 541; // covers centers 132..144.5 / 30..43.5

const CLASS_CODES = [10, 20, 50, 60, 70, 91, 92, 100, 110, 140, 150, 160];

// ---------- minimal ZIP reader (central directory, stored+deflate) ----------
function unzipFirst(buffer, suffix) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central entry');
    const method = buffer.readUInt16LE(p + 10);
    const csize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
    const lfh = buffer.readUInt32LE(p + 42);
    const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name.toLowerCase().endsWith(suffix)) {
      const lnl = buffer.readUInt16LE(lfh + 26), lel = buffer.readUInt16LE(lfh + 28);
      const data = buffer.slice(lfh + 30 + lnl + lel, lfh + 30 + lnl + lel + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip: no ' + suffix + ' entry');
}

// ---------- minimal TIFF reader (this L03-b_r flavour only) ----------
function readTiff(buf) {
  if (buf.readUInt16LE(0) !== 0x4949 || buf.readUInt16LE(2) !== 42) throw new Error('tiff: not II/magic42');
  const off0 = buf.readUInt32LE(4);
  const n = buf.readUInt16LE(off0);
  let width, height, bits, comp, spp, rowsPerStrip, tiepoint = null, scale = null;
  const stripOffsets = [], stripCounts = [];
  for (let i = 0; i < n; i++) {
    const e = off0 + 2 + i * 12;
    const tag = buf.readUInt16LE(e), type = buf.readUInt16LE(e + 2), cnt = buf.readUInt32LE(e + 4);
    const tsize = { 1: 1, 3: 2, 4: 4, 12: 8 }[type] || 1;
    const po = tsize * cnt <= 4 ? e + 8 : buf.readUInt32LE(e + 8);
    const rdInt = (k) => (type === 3 ? buf.readUInt16LE(po + k * 2) : buf.readUInt32LE(po + k * 4));
    switch (tag) {
      case 256: width = rdInt(0); break;
      case 257: height = rdInt(0); break;
      case 258: bits = rdInt(0); break;
      case 259: comp = rdInt(0); break;
      case 277: spp = rdInt(0); break;
      case 278: rowsPerStrip = rdInt(0); break;
      case 273: for (let k = 0; k < cnt; k++) stripOffsets.push(rdInt(k)); break;
      case 279: for (let k = 0; k < cnt; k++) stripCounts.push(rdInt(k)); break;
      case 33922: tiepoint = [0, 1, 2, 3, 4, 5].map((k) => buf.readDoubleLE(po + k * 8)); break;
      case 33550: scale = [0, 1, 2].map((k) => buf.readDoubleLE(po + k * 8)); break;
    }
  }
  if (bits !== 8 || spp !== 1 || comp !== 1) throw new Error('tiff: unexpected flavour bits=' + bits + ' spp=' + spp + ' comp=' + comp);
  if (!tiepoint || !scale) throw new Error('tiff: missing geotiepoint/pixelscale');
  const px = Buffer.alloc(width * height);
  let row = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    const rows = Math.min(rowsPerStrip, height - row);
    const bytes = rows * width;
    buf.copy(px, row * width, stripOffsets[s], stripOffsets[s] + bytes);
    row += rows;
  }
  if (row !== height) throw new Error('tiff: strip rows incomplete');
  return { width, height, px, west: tiepoint[3], north: tiepoint[4], slng: scale[0], slat: scale[1] };
}

// ---------- network ----------
function fetchZip(code) {
  return new Promise((resolve, reject) => {
    const req = https.get(BASE + code + '.zip', { headers: { 'User-Agent': 'quake_sim-data-builder/1.0 (research tool)' }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function loadTile(code) {
  const file = path.join(CACHE, 'meshes', code + '.zip');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const buf = await fetchZip(code);
  fs.writeFileSync(file, buf);
  return buf;
}

// ---------- main ----------
function tileList() {
  // 1次メッシュ uuvv: uu = floor(lat*1.5), vv = floor(lng-100).
  // Pack box lat 30..43.5 → uu 45..65; lng 132..144.5 → vv 32..44.
  const list = [];
  for (let uu = 45; uu <= 65; uu++) for (let vv = 32; vv <= 44; vv++) list.push(String(uu) + String(vv).padStart(2, '0'));
  return list;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--probe') {
    const t = readTiff(unzipFirst(fs.readFileSync(args[1]), '.tif'));
    console.log(JSON.stringify(t, (k, v) => k === 'px' ? undefined : v, 2));
    const uniq = new Set();
    for (const b of t.px) uniq.add(b);
    console.log('classes present:', [...uniq].sort((a, b) => a - b).join(','));
    return;
  }
  const write = args.includes('--write');

  const data = new Uint8Array(NX * NY); // 0 = 解析範囲外
  const tally = new Uint16Array(NX * NY * 13); // per-cell class counts (code→slot)
  const slot = {}; CLASS_CODES.forEach((c, i) => (slot[c] = i));
  const fetched = [], skipped = [];
  const tiles = tileList();
  for (const code of tiles) {
    let buf;
    try { buf = await loadTile(code); } catch (e) { skipped.push(code + ':' + e.message); continue; }
    let t;
    try { t = readTiff(unzipFirst(buf, '.tif')); } catch (e) { skipped.push(code + ':tiff ' + e.message); continue; }
    // geotransform sanity vs the mesh-code geometry (uu*2/3° lat, 100+vv° lng)
    const uu = Math.floor(code / 100), vv = code % 100;
    const west = 100 + vv, north = (uu + 1) / 1.5;
    if (Math.abs(t.west - west) > 1e-6 || Math.abs(t.north - north) > 1e-6 || Math.abs(t.slng * t.width - 1) > 1e-4 || Math.abs(t.slat * t.height - 1 / 1.5) > 1e-4)
      throw new Error('tile ' + code + ' geotransform mismatch: ' + [t.west, t.north, t.slng, t.slat].join(','));
    // fast all-zero skip (open-ocean tiles are pure 0)
    let any = false;
    for (let i = 0; i < t.px.length && !any; i++) if (t.px[i]) any = true;
    if (!any) { skipped.push(code + ':nodata'); continue; }
    // accumulate: pixel centers, PixelIsArea
    for (let py = 0; py < t.height; py++) {
      const latC = t.north - (py + 0.5) * t.slat;
      const Y = Math.floor((latC - ORIGIN[1]) / RES + 1e-9);
      if (Y < 0 || Y >= NY) continue;
      const row = py * t.width;
      for (let px = 0; px < t.width; px++) {
        const cls = t.px[row + px];
        if (!cls) continue;
        const lngC = t.west + (px + 0.5) * t.slng;
        const X = Math.floor((lngC - ORIGIN[0]) / RES + 1e-9);
        if (X < 0 || X >= NX) continue;
        const s = slot[cls];
        if (s === undefined) continue; // unknown class → treat as no-data
        tally[(Y * NX + X) * 13 + s]++;
      }
    }
    fetched.push(code);
    process.stdout.write('tile ' + code + ' ok (' + fetched.length + ')\r');
  }
  const hist = {};
  for (let i = 0; i < NX * NY; i++) {
    // empty cells must stay 0 — init bestN at 0 so an all-zero tally wins nothing
    let best = 0, bestN = 0;
    for (let s = 0; s < CLASS_CODES.length; s++) {
      const c = tally[i * 13 + s];
      if (c > bestN || (c === bestN && c > 0 && CLASS_CODES[s] > best)) { bestN = c; best = CLASS_CODES[s]; }
    }
    data[i] = best;
    if (best) hist[best] = (hist[best] || 0) + 1;
  }
  const total = NX * NY, covered = Object.values(hist).reduce((a, b) => a + b, 0);
  const stats = {
    tilesFetched: fetched.length, tilesSkippedNoData: skipped.filter((s) => s.includes('nodata')).length,
    tilesSkippedOther: skipped.filter((s) => !s.includes('nodata')).length,
    cells: total, covered, coveragePct: +(100 * covered / total).toFixed(2),
    classHistogram: hist
  };
  console.log(JSON.stringify(stats, null, 2));
  if (!write) { console.log('(dry run — pass --write to write ' + path.relative(ROOT, OUT) + ')'); return; }

  const doc = {
    _schema: 'quake-sim-landuse-manning-v1',
    origin: ORIGIN, res: RES, nx: NX, ny: NY,
    data: Array.from(data),
    provenance: {
      source: '国土数値情報 土地利用細分メッシュ(ラスタ版) L03-b-14 (平成26年度)',
      publisher: '国土交通省 (MLIT)', license: 'CC BY 4.0',
      url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-L03-b_r.html',
      classes: 'LandUseCd-TIFF.htm (平成26年度): 10田/20その他農用地/50森林/60荒地/70建物用地/91道路/92鉄道/100その他用地/110河川湖沼/140海浜/150海域水/160ゴルフ場/0範囲外',
      downsample: 'dominant class over the 20x30 source pixels per 0.025° cell (ties→larger code)',
      builder: 'tools/build-landuse-manning.js', generatedUtc: new Date().toISOString(),
      stats
    }
  };
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log('written', OUT, (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
}
main().catch((e) => { console.error(e); process.exit(1); });
