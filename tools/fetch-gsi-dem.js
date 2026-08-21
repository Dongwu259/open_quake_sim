#!/usr/bin/env node
'use strict';
// ================================================================
//  fetch-gsi-dem.js — GSI (国土地理院) 地理院タイル DEM mosaic pilot.
//
//  Downloads GSI terrain-tile DEM (default layer "dem": best-available
//  seamless elevation mosaic) for a bbox, decodes the comma-separated
//  256x256 value tiles and reprojects Web-Mercator pixels onto a square
//  lat/lng-degree grid (nearest pixel per node). Ocean / void pixels arrive
//  as "e" and are recorded via the counts array (0 = missing, 1 = valid) so
//  downstream blending never mistakes a void for elevation 0.
//
//  Usage:
//    node tools/fetch-gsi-dem.js --bbox=140.75,38.20,141.85,39.10 \
//        [--zoom=12] [--layer=dem] [--out=public/geojson/gsi/gsi-sanriku-sendai.json]
//
//  Output schema (quake-sim-gsi-mosaic-v1): { origin:[w,s], res, nx, ny,
//  data (elevation m, 0 where missing), counts (0/1), meta }.
//  Tiles are cached under tools/data/gsi-tiles/<layer>/ so re-runs are free.
//  Attribution: 出典「地理院タイル」国土地理院 (GSI tile terms, CC BY 4.0).
// ================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argOf = pre => {
  const a = process.argv.slice(2).find(x => x.startsWith(pre));
  return a ? a.slice(pre.length) : null;
};

const UA = 'quake-sim-dev/5.4 (geoclaw crosscheck pilot)';

// --- pure helpers (mirrored in tests/gsi-dem.test.js) ----------------------

/** Parse one GSI .txt tile body -> Float64Array(256*256) with NaN for voids. */
function parseTile(txt) {
  const out = new Float64Array(256 * 256);
  const rows = txt.split('\n');
  for (let r = 0; r < 256; r++) {
    const row = rows[r];
    if (row == null) { out.fill(NaN, r * 256, (r + 1) * 256); continue; }
    const vals = row.split(',');
    for (let c = 0; c < 256; c++) {
      const v = Number(vals[c]);
      out[r * 256 + c] = Number.isFinite(v) ? v : NaN;
    }
  }
  return out;
}

/** Tile x range covering [lngW, lngE] at zoom z. */
function tileRangeX(lngW, lngE, z) {
  const n = Math.pow(2, z);
  return {
    x0: Math.floor((lngW + 180) / 360 * n),
    x1: Math.ceil((lngE + 180) / 360 * n) - 1
  };
}

/** Tile y range covering [latS, latN] (Web Mercator) at zoom z. */
function tileRangeY(latS, latN, z) {
  const n = Math.pow(2, z);
  const yOf = lat => {
    const s = Math.sin(lat * Math.PI / 180);
    const yc = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return yc * n;
  };
  return { y0: Math.floor(yOf(latN)), y1: Math.ceil(yOf(latS)) - 1 };
}

/** lng of a pixel-center column (tx, px) at zoom z. */
function lngOfPixel(tx, px, z) {
  return ((tx + (px + 0.5) / 256) / Math.pow(2, z)) * 360 - 180;
}
/** lat of a pixel-center row (ty, py) at zoom z (inverse mercator). */
function latOfPixel(ty, py, z) {
  const n = Math.PI * (1 - 2 * (ty + (py + 0.5) / 256) / Math.pow(2, z));
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}

// --- main -------------------------------------------------------------------

async function main() {
  const bboxArg = argOf('--bbox=');
  if (!bboxArg) throw new Error('--bbox=w,s,e,n is required');
  const [w, s, e, n] = bboxArg.split(',').map(Number);
  if (![w, s, e, n].every(Number.isFinite) || !(w < e && s < n)) throw new Error('bad --bbox (want w,s,e,n)');
  const Z = Math.max(1, parseInt(argOf('--zoom=') || '12', 10));
  const LAYER = argOf('--layer=') || 'dem';
  const OUT = path.join(ROOT, argOf('--out=') || 'public/geojson/gsi/gsi-pilot.json');

  const res = 360 / (Math.pow(2, Z) * 256);   // tile pixel size in degrees
  const nx = Math.ceil((e - w) / res);
  const ny = Math.ceil((n - s) / res);

  const { x0, x1 } = tileRangeX(w, e, Z);
  const { y0, y1 } = tileRangeY(s, n, Z);
  const cacheDir = path.join(ROOT, 'tools/data/gsi-tiles', LAYER);
  fs.mkdirSync(cacheDir, { recursive: true });

  const tiles = {};
  let fetched = 0, cached = 0, failed = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const key = tx + '-' + ty;
      const file = path.join(cacheDir, Z + '-' + key + '.txt');
      let body = null;
      if (fs.existsSync(file)) {
        body = fs.readFileSync(file, 'utf8');
        cached++;
      } else {
        const url = `https://cyberjapandata.gsi.go.jp/xyz/${LAYER}/${Z}/${tx}/${ty}.txt`;
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (r.ok) {
          body = await r.text();
          fs.writeFileSync(file, body);
          fetched++;
        } else {
          failed++; // open ocean tiles legitimately 404 for land-only layers
        }
      }
      if (body != null) tiles[key] = parseTile(body);
    }
  }
  console.log(`tiles: ${Object.keys(tiles).length} (${fetched} fetched, ${cached} cached, ${failed} missing)`);

  const data = new Array(nx * ny).fill(0);
  const counts = new Array(nx * ny).fill(0);
  let valid = 0;
  for (let j = 0; j < ny; j++) {
    const lat = s + (j + 0.5) * res;
    for (let i = 0; i < nx; i++) {
      const lng = w + (i + 0.5) * res;
      // nearest pixel of the nearest tile (gx/gy are tile-float coords;
      // pixel = fractional part * 256)
      const gx = (lng + 180) / 360 * Math.pow(2, Z);
      const sy = Math.sin(lat * Math.PI / 180);
      const gy = (0.5 - Math.log((1 + sy) / (1 - sy)) / (4 * Math.PI)) * Math.pow(2, Z);
      const tx = Math.floor(gx), ty = Math.floor(gy);
      const t = tiles[tx + '-' + ty];
      if (t) {
        const px = Math.min(255, Math.max(0, Math.floor((gx - tx) * 256)));
        const py = Math.min(255, Math.max(0, Math.floor((gy - ty) * 256)));
        const v = t[py * 256 + px];
        if (Number.isFinite(v)) {
          data[j * nx + i] = +v.toFixed(3);
          counts[j * nx + i] = 1;
          valid++;
        }
      }
    }
  }

  const mosaic = {
    schema: 'quake-sim-gsi-mosaic-v1',
    origin: [w, s], res, nx, ny, data, counts,
    meta: {
      dataset: `GSI 地理院タイル ${LAYER} mosaic (nearest-pixel reprojection, Web Mercator -> square degrees)`,
      layer: LAYER, zoom: Z,
      bbox: [w, s, e, n],
      source: 'https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.txt — 出典「地理院タイル」国土地理院 (GSI tile terms; CC BY 4.0 attribution requested)',
      verticalDatum: 'GSI 標高 (normal heights, ~MSL); voids ("e") are ocean/undeclared — see counts array',
      validNodes: valid, totalNodes: nx * ny,
      fetchedAt: new Date().toISOString()
    }
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(mosaic));
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${nx}x${ny} @ ${res.toExponential(3)} deg, ${valid}/${nx * ny} valid nodes (${(100 * valid / (nx * ny)).toFixed(1)}%)`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
module.exports = { parseTile, tileRangeX, tileRangeY, lngOfPixel, latOfPixel };
