'use strict';
// GSI 地理院タイル mosaic pilot — tile decode, reprojection math and the
// GEBCO blend rule (tools/fetch-gsi-dem.js + tools/blend-gsi-gebco.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTile, tileRangeX, tileRangeY, lngOfPixel, latOfPixel } = require('../tools/fetch-gsi-dem.js');
const { blendIntoBase } = require('../tools/blend-gsi-gebco.js');

function syntheticTile(pattern) {
  // 256x256 comma-separated rows; pattern(row, col) -> number | 'e'
  const rows = [];
  for (let r = 0; r < 256; r++) {
    const vals = [];
    for (let c = 0; c < 256; c++) vals.push(pattern(r, c));
    rows.push(vals.join(','));
  }
  return rows.join('\n') + '\n';
}

test('parseTile — 256x256 CSV with "e" voids decodes row-major', () => {
  const txt = syntheticTile((r, c) => (r === 0 && c === 0 ? 'e' : r * 1000 + c + 0.5));
  const t = parseTile(txt);
  assert.equal(t.length, 256 * 256);
  assert.ok(Number.isNaN(t[0]), 'top-left void is NaN');
  assert.equal(t[1], 1.5);
  assert.equal(t[255], 255.5);
  assert.equal(t[256], 1000.5, 'row-major: second row starts at index 256');
  assert.equal(t[255 * 256 + 255], 255255.5);
});

test('tileRange / pixel projection — consistent roundtrip over the pilot bbox', () => {
  const Z = 12;
  const { x0, x1 } = tileRangeX(140.75, 141.85, Z);
  const { y0, y1 } = tileRangeY(38.20, 39.10, Z);
  assert.ok(x1 >= x0 && y1 >= y0, 'non-empty ranges');
  // west edge of the tile range must be at/before the bbox west edge
  assert.ok(lngOfPixel(x0, 0, Z) <= 140.75 + 1e-9, 'covers west');
  assert.ok(lngOfPixel(x1, 255, Z) >= 141.85 - 1e-9, 'covers east');
  // tile 3652/1575 (z12) is the Sendai tile fetched during the pilot
  const lngMid = lngOfPixel(3652, 128, Z);
  const latMid = latOfPixel(1575, 128, Z);
  assert.ok(Math.abs(lngMid - 141.02) < 0.05, 'mid-pixel longitude near 141.02, got ' + lngMid.toFixed(3));
  assert.ok(Math.abs(latMid - 38.32) < 0.05, 'mid-pixel latitude near 38.32, got ' + latMid.toFixed(3));
  // mercator y grows southward: northern rows have larger latitude
  assert.ok(latOfPixel(1575, 0, Z) > latMid && latMid > latOfPixel(1575, 255, Z));
});

function mosaicWith(validFn, valFn) {
  // 0.02 deg mosaic over [140,38]-[140.4,38.4]: 20x20 nodes
  const nx = 20, ny = 20, res = 0.02;
  const data = new Array(nx * ny).fill(0);
  const counts = new Array(nx * ny).fill(0);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (validFn(i, j)) { counts[k] = 1; data[k] = valFn(i, j); }
    }
  }
  return {
    schema: 'quake-sim-gsi-mosaic-v1', origin: [140, 38], res, nx, ny, data, counts,
    meta: { source: 'synthetic', zoom: 12, bbox: [140, 38, 140.4, 38.4] }
  };
}

test('blendIntoBase — frac rule replaces, feathers, and leaves ocean alone', () => {
  // base 2x2 @0.1 deg over [140,38]-[140.2,38.4]; mosaic @0.02 deg (5 nodes/cell,
  // center-aligned). Column zones: base cell 0 sees mosaic i=0..4, cell 1 sees i=5..9.
  const base = {
    origin: [140, 38], res: 0.1, nx: 2, ny: 2,
    data: [-50, -50, -50, -50],
    meta: { dataset: 'base' }
  };
  const mosaic = mosaicWith(i => i < 2 || i >= 5, () => 100); // cell0 frac 0.4, cell1 frac 1.0
  const { grid, stats } = blendIntoBase(base, mosaic, 1);
  // frac 0.4 -> feathered: 0.4*100 + 0.6*(-50) = 10
  assert.equal(grid.data[0], 10);
  assert.equal(grid.data[2], 10, 'same rule on the second row');
  // frac 1.0 -> GSI mean
  assert.equal(grid.data[1], 100);
  assert.equal(stats.replaced, 2);
  assert.equal(stats.feathered, 2);
  assert.equal(stats.signFlips, 4, 'wet->dry flips counted');
});

test('blendIntoBase — minNodes suppresses stray single samples', () => {
  const base = { origin: [140, 38], res: 0.1, nx: 2, ny: 2, data: [-50, -50, -50, -50], meta: {} };
  const mosaic = mosaicWith((i, j) => i === 7 && j === 3, () => 999); // one valid node, in base cell (1,0)
  const { grid } = blendIntoBase(base, mosaic, 3);
  assert.equal(grid.data[0], -50, 'cell without samples keeps GEBCO');
  assert.equal(grid.data[1], -50, 'fewer than minNodes valid samples keeps GEBCO');
});

test('committed GSI-merged grids validate as terrain research grids', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const Physics = require('../public/physics.js');
  // Sanriku is the original pilot; the 2026 extension covers the other four
  // regional windows (Noto, Hokkaido-SW/Okushiri, Nankai, Sagami).
  const merged = ['jp-sanriku-gsi', 'jp-noto-gsi', 'jp-hokkaido-sw-gsi', 'jp-nankai-gsi', 'jp-sagami-gsi'];
  let checked = 0;
  for (const name of merged) {
    const p = path.join(__dirname, '..', 'public/geojson/grids', name + '.json');
    if (!fs.existsSync(p)) continue; // generated artifacts; skip when absent
    const g = JSON.parse(fs.readFileSync(p, 'utf8'));
    const chk = Physics.validateResearchGrid(g, 'terrain');
    assert.ok(chk.valid, name + ' validates: ' + chk.errors.join(','));
    assert.ok(g.meta.gsiMerge && g.meta.gsiMerge.replacedCells > 500, name + ' merge provenance recorded');
    checked++;
  }
  assert.ok(checked >= 1, 'at least the pilot grid must be committed');
});
