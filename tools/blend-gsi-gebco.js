#!/usr/bin/env node
'use strict';
// ================================================================
//  blend-gsi-gebco.js — pilot coastal-DEM merge for the tsunami grids.
//
//  GEBCO regional grids are water-mean resamples: their land elevations are
//  coarse and the coastline smears over ~grid-cell widths. The GSI 地理院
//  タイル mosaic (fetch-gsi-dem.js) gives real land topography + a true
//  shoreline at ~30-150 m. This tool merges the two at the BASE grid's own
//  spacing (0.025 deg regional pilot):
//
//    per base cell, frac = share of GSI-valid nodes inside the cell
//      frac >= 0.5   -> GSI mean elevation (land / shoreline cells)
//      0 < frac < 0.5 -> frac-weighted blend toward GEBCO (feathered edge)
//      frac == 0     -> GEBCO unchanged (open ocean / outside pilot bbox)
//
//  Usage:
//    node tools/blend-gsi-gebco.js --gsi=public/geojson/gsi/gsi-pilot.json \
//        [--base=public/geojson/grids/jp-sanriku.json] \
//        [--out=public/geojson/grids/jp-sanriku-gsi.json] [--min-nodes=3]
// ================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argOf = pre => {
  const a = process.argv.slice(2).find(x => x.startsWith(pre));
  return a ? a.slice(pre.length) : null;
};

// --- pure helpers (mirrored in tests/gsi-dem.test.js) ----------------------

/**
 * Merge a GSI mosaic into a base terrain grid at the base grid's spacing.
 * Returns {grid, stats} — grid keeps the base geometry; cells inside the
 * mosaic follow the frac rule above.
 */
function blendIntoBase(base, mosaic, minNodes) {
  const nx = base.nx, ny = base.ny;
  const data = base.data.slice();
  let replaced = 0, feathered = 0, signFlips = 0;
  const sign = v => v >= 0 ? 1 : -1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const w = base.origin[0] + i * base.res;
      const e = w + base.res;
      const s = base.origin[1] + j * base.res;
      const n = s + base.res;
      // GSI mosaic nodes are CENTER-aligned (node k spans [k*res, (k+1)*res),
      // center at (k+0.5)*res — the same convention as fetch-gsi-dem.js).
      // A node belongs to the base cell that contains its center.
      const i0 = Math.max(0, Math.ceil((w - mosaic.origin[0]) / mosaic.res - 0.5 - 1e-9));
      const i1 = Math.min(mosaic.nx - 1, Math.floor((e - mosaic.origin[0]) / mosaic.res - 0.5 + 1e-9));
      const j0 = Math.max(0, Math.ceil((s - mosaic.origin[1]) / mosaic.res - 0.5 - 1e-9));
      const j1 = Math.min(mosaic.ny - 1, Math.floor((n - mosaic.origin[1]) / mosaic.res - 0.5 + 1e-9));
      if (i1 < i0 || j1 < j0) continue;
      let count = 0, sum = 0;
      for (let jj = j0; jj <= j1; jj++) {
        for (let ii = i0; ii <= i1; ii++) {
          const k = jj * mosaic.nx + ii;
          if (mosaic.counts[k] > 0) { count++; sum += mosaic.data[k]; }
        }
      }
      if (count < minNodes) continue;
      const total = (i1 - i0 + 1) * (j1 - j0 + 1);
      const frac = count / total;
      const baseV = data[j * nx + i];
      let out;
      if (frac >= 0.5) { out = sum / count; replaced++; }
      else { out = frac * (sum / count) + (1 - frac) * baseV; feathered++; }
      if (sign(out) !== sign(baseV)) signFlips++;
      data[j * nx + i] = +out.toFixed(3);
    }
  }
  const grid = {
    origin: base.origin.slice(), res: base.res, nx, ny, data,
    meta: Object.assign({}, base.meta, {
      dataset: (base.meta && base.meta.dataset || 'grid') + ' + GSI 地理院タイル coastal-DEM merge (pilot)',
      gsiMerge: {
        source: mosaic.meta && mosaic.meta.source,
        zoom: mosaic.meta && mosaic.meta.zoom,
        bbox: mosaic.meta && mosaic.meta.bbox,
        rule: 'frac>=0.5 GSI mean; 0<frac<0.5 feathered; else GEBCO',
        replacedCells: replaced, featheredCells: feathered, signFlips
      }
    })
  };
  const landCells = data.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0);
  return { grid, stats: { replaced, feathered, signFlips, landCells, landCellsBase: base.data.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0) } };
}

// --- main -------------------------------------------------------------------

function main() {
  const GSI_REL = argOf('--gsi=');
  if (!GSI_REL) throw new Error('--gsi=<mosaic.json> is required');
  const BASE_REL = argOf('--base=') || 'public/geojson/grids/jp-sanriku.json';
  const OUT_REL = argOf('--out=') || 'public/geojson/grids/jp-sanriku-gsi.json';
  const MIN_NODES = Math.max(1, parseInt(argOf('--min-nodes=') || '3', 10) || 3);

  const base = require(path.join(ROOT, BASE_REL));
  const mosaic = require(path.join(ROOT, GSI_REL));
  if (mosaic.schema !== 'quake-sim-gsi-mosaic-v1') throw new Error('not a GSI mosaic: ' + GSI_REL);

  const t0 = Date.now();
  const { grid, stats } = blendIntoBase(base, mosaic, MIN_NODES);
  fs.writeFileSync(path.join(ROOT, OUT_REL), JSON.stringify(grid));
  console.log(`wrote ${OUT_REL} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  cells: ${grid.nx * grid.ny}, GSI-replaced ${stats.replaced}, feathered ${stats.feathered}, wet<->dry flips ${stats.signFlips}`);
  console.log(`  land cells: ${stats.landCellsBase} -> ${stats.landCells}`);
}

if (require.main === module) main();
module.exports = { blendIntoBase };
