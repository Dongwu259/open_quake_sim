'use strict';
// Two-level nested-grid tsunami solver (Physics.createNestedTsunamiSolver):
// grid validation, the still-water (C-property) identity across the
// coarse/fine seam, wave transmission vs a uniform-fine reference, interface
// reflection, and the production 0.15° -> 0.025° (ratio 6) pairing.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Physics = require('../public/physics.js');

const D = 111320, G = 9.80665;

// Index (x,y) is CENTRED at origin+(x,y)*res (the solver's own convention);
// grids are authored in metres and converted to the solver's degree units.
function makeGrid(ox, oy, nx, ny, resM, terr) {
  const res = resM / D, data = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) data.push(terr(ox + x * resM, oy + y * resM));
  return { origin: [ox / D, oy / D], res, nx, ny, data, meta: { quality: 'verification', dataset: 'nested-grid-test' } };
}
// Sloped bed with land borders and an island inside the fine patch, so both
// grids satisfy the land-water mask and the fine level exercises wet/dry.
// Coarse cells are 50 m; the fine patch [1000,2000]x[300,700] m at 50/3 m.
const sloped = (x, y) => (y < 50 || y > 950) ? 5 : (x > 1900 && x < 2100 && y > 500 && y < 600) ? 4
  : -Math.max(1, 20 + 5 * Math.sin(2 * Math.PI * x / 3000) + 2 * Math.cos(2 * Math.PI * y / 500));
const nestedPair = () => ({ coarse: makeGrid(0, 0, 61, 21, 50, sloped), fine: makeGrid(1000, 300, 61, 25, 50 / 3, sloped) });

test('validateNestedGrids accepts the aligned pair and reports geometry', () => {
  const { coarse, fine } = nestedPair();
  const check = Physics.validateNestedGrids(coarse, fine);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(check.ratio, 3);
  const [w, s, e, n] = check.fineExtent;
  assert.ok(Math.abs(w * D - (1000 - 25 / 3)) < 1e-6 && Math.abs(e * D - (1000 + 60.5 * 50 / 3)) < 1e-6);
  assert.ok(Math.abs(s * D - (300 - 25 / 3)) < 1e-6 && Math.abs(n * D - (300 + 24.5 * 50 / 3)) < 1e-6);
});

test('validateNestedGrids rejects non-integer ratio and non-interior patches', () => {
  const { coarse } = nestedPair();
  const oddRatio = makeGrid(1000, 300, 61, 25, 50 / 2.5, sloped); // ratio 2.5
  assert.equal(Physics.validateNestedGrids(coarse, oddRatio).valid, false);
  const touching = makeGrid(0, 0, 61, 25, 50 / 3, sloped); // shares the coarse west edge
  assert.equal(Physics.validateNestedGrids(coarse, touching).valid, false);
});

test('nested lake at rest stays exactly still across the seam', () => {
  const { coarse, fine } = nestedPair();
  const solver = Physics.createNestedTsunamiSolver(coarse, fine, null, { initialState: () => ({ eta: 0 }), manning: 0, coriolis: false });
  assert.ok(solver, 'solver built');
  solver.advanceTo(120);
  let worst = 0;
  for (let mx = 50; mx < 2950; mx += 50) for (let my = 50; my < 950; my += 50) {
    const s = solver.sampleState(my / D, mx / D);
    if (s && s.h > 0.1) worst = Math.max(worst, Math.abs(s.eta), Math.abs(s.u), Math.abs(s.v));
  }
  assert.ok(worst < 1e-9, `still-water perturbation ${worst}`);
  const d = solver.getDiagnostics();
  assert.equal(d.nonFiniteCells, 0);
  assert.equal(d.nested.model, 'two-way-amr');
  assert.ok(d.nested.restrictionCells > 0 && d.nested.ghostCells > 0);
});

test('gaussian pulse transmits into the fine patch with small error and reflection', () => {
  const H = 20, c = Math.sqrt(G * H), x0 = 500, sig = 60, amp = 0.5;
  const flat = (x, y) => (y < 50 || y > 950) ? 5 : (x > 1900 && x < 2100 && y > 500 && y < 600) ? 4 : -H;
  const init = cell => {
    const e = cell.terrain < 0 ? amp * Math.exp(-0.5 * Math.pow((cell.lng * D - x0) / sig, 2)) : 0;
    return { eta: e, u: cell.terrain < 0 ? c * e / (H + e) : 0 };
  };
  const { coarse, fine } = { coarse: makeGrid(0, 0, 61, 21, 50, flat), fine: makeGrid(1000, 300, 61, 25, 50 / 3, flat) };
  const nested = Physics.createNestedTsunamiSolver(coarse, fine, null, { initialState: init, manning: 0, coriolis: false, boundary: 'wall' });
  const reference = Physics.createNonlinearTsunamiSolver(makeGrid(0, 0, 181, 61, 50 / 3, flat), null,
    { initialState: init, manning: 0, coriolis: false, boundary: 'wall' });
  nested.advanceTo(150); reference.advanceTo(150);
  // Probe the clean mid-channel row (y=300 m): the island at y 500-600 m
  // diffracts differently on the two grids, which measures grid-resolution
  // difference, not coupling quality.
  let l1 = 0, n = 0, l1f = 0, nf = 0, reflection = 0;
  for (let mx = 40; mx < 2960; mx += 10) {
    const sN = nested.sampleState(300 / D, mx / D), sR = reference.sampleState(300 / D, mx / D);
    if (sN && sR && sN.h > 0.1 && sR.h > 0.1) {
      const e = Math.abs(sN.eta - sR.eta);
      l1 += e; n++;
      if (mx >= 1000 && mx <= 2000) { l1f += e; nf++; }
    }
  }
  for (let mx = 40; mx < 980; mx += 10) {
    const s = nested.sampleState(300 / D, mx / D);
    if (s && s.h > 0.1) reflection = Math.max(reflection, s.eta);
  }
  assert.ok(n > 200 && nf > 80, `probe coverage n=${n} nf=${nf}`);
  assert.ok(l1f / nf < 0.03 * amp, `fine-region L1 ${(l1f / nf).toExponential(3)} exceeds 3% of amplitude`);
  assert.ok(reflection < 0.015 * amp, `interface reflection ${reflection.toExponential(3)} exceeds 1.5% of amplitude`);
  const d = nested.getDiagnostics();
  assert.ok(d.maxCfl <= d.cflLimit + 1e-9, `maxCfl ${d.maxCfl} over limit ${d.cflLimit}`);
  assert.equal(d.nonFiniteCells, 0);
  assert.ok(Math.abs(d.massResidualFraction) < 1e-3, `mass residual ${d.massResidualFraction}`);
});

test('production 0.15° global + 0.025° regional grids nest at ratio 6 and run healthy', () => {
  const root = path.resolve(__dirname, '..');
  const coarse = require(path.join(root, 'public/geojson/bathymetry.json'));
  const fine = require(path.join(root, 'public/geojson/grids/jp-sanriku.json'));
  const check = Physics.validateNestedGrids(coarse, fine);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(check.ratio, 6);
  const solver = Physics.createNestedTsunamiSolver(coarse, fine, null,
    { initialState: () => ({ eta: 0 }), manning: 0.025, coriolis: false });
  assert.ok(solver, 'production nested solver built');
  solver.advanceTo(60);
  const d = solver.getDiagnostics();
  assert.equal(d.nonFiniteCells, 0);
  assert.ok(d.maxCfl <= d.cflLimit + 1e-9, `maxCfl ${d.maxCfl}`);
  // Query routing: a point inside the fine patch and one far outside.
  const inFine = solver.samplePeak(38.2, 142.0), outside = solver.samplePeak(34.6, 135.2);
  assert.ok(isFinite(inFine) && isFinite(outside));
  const snap = solver.getSnapshot(2);
  assert.equal(snap.model, 'nonlinearSWE-nested');
  assert.ok(snap.deformationGrid && snap.deformationGrid.res === coarse.res); // sourceless run reports the coarse deformation grid
  const [fw, fs, fe, fn] = check.fineExtent;
  for (const c of snap.cells) {
    assert.ok(isFinite(c.lat) && isFinite(c.lng) && isFinite(c.res), 'snapshot cells carry absolute coordinates');
    // coarse-origin cells must not double-draw the fine patch
    if (c.res === coarse.res && c.lat >= fs && c.lat <= fn && c.lng >= fw && c.lng <= fe) assert.fail('coarse cell inside fine extent');
  }
});
