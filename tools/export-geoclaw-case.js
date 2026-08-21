#!/usr/bin/env node
'use strict';
// ================================================================
//  GeoClaw crosscheck case exporter (see tools/geoclaw-crosscheck/README.md)
//
//  Exports a SELF-CONTAINED case: GeoClaw type-1 topo + dtopo (t x y dz,
//  complete grid, N->S rows, two t=0/1 s epochs), gauge table and OUR
//  solver's eta(t) reference on the SAME grid, so the two codes see
//  identical inputs.
//
//  Usage:
//    node tools/export-geoclaw-case.js [--out=DIR] [--horizon=S]
//        [--grid=public/geojson/grids/jp-sanriku.json]
//        [--coarsen=K]        # aggregate K x K base cells (mean) -> K*res grid
//        [--gauges=FILE]      # JSON [{id,name,lat,lng}] used verbatim (wet-checked)
//        [--wet-coarsen=K]    # gauge snapping must stay wet at this coarsen too
//
//  Resolution-ladder recipe (fixed gauges across all levels):
//    1. --out=.../case-sanriku-fine  --grid=grids/jp-sanriku.json --coarsen=1 --wet-coarsen=6
//       (snaps gauges on the fine grid AND requires the 6x-coarsened cell to
//        stay wet; writes gauges-fixed.json for the coarser levels)
//    2. --out=.../case-sanriku-mid   --grid=... --coarsen=2 --gauges=.../case-sanriku-fine/gauges-fixed.json
//    3. --out=.../case-sanriku-coarse --grid=... --coarsen=6 --gauges=.../gauges-fixed.json
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require(path.join(__dirname, '..', 'public', 'physics.js'));
const DC3D = require(path.join(__dirname, '..', 'public', 'dc3d.js'));
global.DC3D = global.DC3D || DC3D;

const ROOT = path.resolve(__dirname, '..');
const argOf = pre => {
  const a = process.argv.slice(2).find(x => x.startsWith(pre));
  return a ? a.slice(pre.length) : null;
};
const OUT = argOf('--out=') ? path.join(ROOT, argOf('--out=')) : path.join(ROOT, 'tools/geoclaw-crosscheck/case-sanriku');
const HORIZON = Number(argOf('--horizon=') || 7200);
const GRID_REL = argOf('--grid=') || 'public/geojson/bathymetry.json';
const COARSEN = Math.max(1, parseInt(argOf('--coarsen=') || '1', 10) || 1);
const WET_COARSEN = Math.max(1, parseInt(argOf('--wet-coarsen=') || '1', 10) || 1);
const GAUGES_FILE = argOf('--gauges=');

// Test source: a Mw 8.2 Sanriku-oki reverse plane — identical parameters to
// the tsunami-alerts tripwire scenario so the case stays reproducible.
const SOURCE = {
  lat: 38.5, lng: 143.5, mw: 8.2, depthKm: 30,
  strike: 195, dip: 20, rake: 90, sourceType: 'interplate'
};
const GAUGE_DEFS = [
  { id: 1, name: 'offshore-1', lat: 38.6, lng: 143.2 },
  { id: 2, name: 'offshore-2', lat: 38.2, lng: 142.6 },
  { id: 3, name: 'coast-sendai', lat: 38.27, lng: 140.87 },
  { id: 4, name: 'coast-ofunato', lat: 39.02, lng: 141.45 }
];

const { coarsenGrid, wet9, nodeOf, snapGaugeMulti } = require('./lib/grid-ladder.js');

// --- build the case grid --------------------------------------------------
const baseGrid = require(path.join(ROOT, GRID_REL));
const grid = coarsenGrid(baseGrid, COARSEN);

// --- gauges: fixed file or snapped on the case grid ------------------------
let SNAPPED;
let gaugeSource;
if (GAUGES_FILE) {
  const defs = JSON.parse(fs.readFileSync(path.join(ROOT, GAUGES_FILE), 'utf8'));
  if (!Array.isArray(defs) || !defs.length) throw new Error('--gauges file must be a non-empty JSON array');
  SNAPPED = defs.map(d => {
    const n = nodeOf(grid, d.lat, d.lng);
    if (n.i < 1 || n.i >= grid.nx - 1 || n.j < 1 || n.j >= grid.ny - 1 || !wet9(grid, n.j, n.i)) {
      throw new Error('fixed gauge ' + d.name + ' is not on a fully-wet stencil of this grid (' + (grid.res).toFixed(4) + ' deg) — snap further offshore on the finest level');
    }
    return Object.assign({}, d);
  });
  gaugeSource = 'fixed:' + GAUGES_FILE;
} else {
  const snapGrids = [grid];
  if (WET_COARSEN > COARSEN) snapGrids.push(coarsenGrid(baseGrid, WET_COARSEN));
  SNAPPED = GAUGE_DEFS.map(d => snapGaugeMulti(d, snapGrids));
  gaugeSource = WET_COARSEN > 1 ? 'snapped-wet-at-coarsen-' + WET_COARSEN : 'snapped';
}

// --- run our solver on the case grid --------------------------------------
const src = Physics.createSourceModel(Object.assign({ generateSubSources: true }, SOURCE));
const solver = Physics.createNonlinearTsunamiSolver(grid, src, { manning: 0.025, coriolis: true, boundary: 'radiation' });
if (!solver) throw new Error('solver unavailable');

fs.mkdirSync(OUT, { recursive: true });

// 1. Deformation -> dtopo. GeoClaw dtopo_type=1 expects a COMPLETE grid
// (x-fastest) in epoch-major blocks, one dz per `t x y dz` row; two epochs
// (t=0, t=1 s) is the standard "instantaneous" convention. Rows are listed
// north-to-south (GeoClaw type-1 scanners read yhi from the FIRST row).
solver.advanceTo(0.001); // ensure the source is materialized
const snap = solver.getSnapshot(Math.max(1, Math.floor(grid.nx / 120)));
const deformation = snap.deformation;
if (!deformation || !deformation.data) throw new Error('snapshot carries no deformation block');

const lines = [];
for (const epoch of [0.0, 1.0]) {
  for (let y = grid.ny - 1; y >= 0; y--) {
    for (let x = 0; x < grid.nx; x++) {
      const dz = deformation.data[y * grid.nx + x];
      const lng = grid.origin[0] + x * grid.res;
      const lat = grid.origin[1] + y * grid.res;
      lines.push(`${epoch.toFixed(1)} ${lng.toFixed(5)} ${lat.toFixed(5)} ${(isFinite(dz) ? dz : 0).toFixed(4)}`);
    }
  }
}
fs.writeFileSync(path.join(OUT, 'dtopo.txyz'), lines.join('\n') + '\n');

// 2. Bathymetry as GeoClaw style-1 ASCII topography (x y z, z up) —
// same north-to-south row convention as the dtopo above.
const topo = [];
for (let y = grid.ny - 1; y >= 0; y--) {
  for (let x = 0; x < grid.nx; x++) {
    const lng = grid.origin[0] + x * grid.res;
    const lat = grid.origin[1] + y * grid.res;
    topo.push(`${lng.toFixed(5)} ${lat.toFixed(5)} ${grid.data[y * grid.nx + x].toFixed(2)}`);
  }
}
fs.writeFileSync(path.join(OUT, 'topo.xyz'), topo.join('\n') + '\n');

// 3. Gauges (GeoClaw gauge format: t0 t1 gauge# x y) + our eta(t) CSV.
fs.writeFileSync(path.join(OUT, 'gauges.txt'),
  SNAPPED.map(g => `-1e10 1e10 ${g.id} ${g.lng} ${g.lat}`).join('\n') + '\n');
// Fixed-gauge coordinates for coarser ladder levels (see header recipe).
fs.writeFileSync(path.join(OUT, 'gauges-fixed.json'),
  JSON.stringify(SNAPPED.map(({ id, name, lat, lng }) => ({ id, name, lat, lng })), null, 2) + '\n');
const csv = ['t_s,' + SNAPPED.map(g => g.name).join(',')];
for (let t = 0; t <= HORIZON; t += 60) {
  solver.advanceTo(t);
  csv.push(t + ',' + SNAPPED.map(g => {
    const s = solver.sampleState(g.lat, g.lng);
    return s ? s.eta.toFixed(4) : '';
  }).join(','));
}
fs.writeFileSync(path.join(OUT, 'sim-gauges.csv'), csv.join('\n') + '\n');

// 4. Provenance.
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
  schema: 'quake-sim-geoclaw-case-v1',
  generatedAt: new Date().toISOString(),
  grid: {
    dataset: grid.meta && grid.meta.dataset, nx: grid.nx, ny: grid.ny, res: grid.res,
    origin: grid.origin.slice(), source: grid.meta && grid.meta.source,
    baseGrid: GRID_REL, coarsen: COARSEN
  },
  source: SOURCE,
  solver: 'Physics.createNonlinearTsunamiSolver (Rusanov FV, MUSCL gated at 20 m, forward Euler, manning 0.025, coriolis, radiation BC)',
  horizonSeconds: HORIZON,
  dtopoNote: 'two epochs t=0/1 s (static DC3D uplift, Tanioka-Satake slope-corrected) on the complete grid in GeoClaw dtopo_type=1 layout (t x y dz, x-fastest, epoch-major)',
  gaugeSource: gaugeSource,
  gauges: SNAPPED
}, null, 2) + '\n');

console.log(`exported case to ${path.relative(ROOT, OUT)}`);
console.log(`  grid ${grid.nx}x${grid.ny} @ ${grid.res}deg (base ${GRID_REL}, coarsen ${COARSEN})`);
console.log(`  dtopo cells: ${lines.length}, topo cells: ${topo.length}, horizon ${HORIZON}s, gauges ${SNAPPED.length} (${gaugeSource})`);
