#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const Physics = require('../public/physics.js');

function buildCoastalGrid() {
  const nx = 52;
  const ny = 34;
  const data = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (x < 36) data.push(-Math.max(2, (36 - x) * 28));
      else data.push(Math.min(8, (x - 36) * 0.35));
    }
  }
  return { origin: [140, 35], res: 0.02, nx, ny, data, meta: { quality: 'verification', dataset: 'synthetic coastal benchmark' } };
}

const grid = buildCoastalGrid();
const source = Physics.createSourceModel({
  lat: 35.34,
  lng: 140.42,
  mw: 8.4,
  depth: 12,
  strike: 5,
  dip: 18,
  rake: 90,
  sourceType: 'interplate',
  mechanismKnown: true
});

const started = performance.now();
const solver = Physics.createNonlinearTsunamiSolver(grid, source, { dryTolerance: 0.02, manning: 0.025 });
assert.ok(solver, 'NLSWE solver could not be created');
solver.advanceTo(6 * 3600);
const elapsedMs = performance.now() - started;
const diagnostics = solver.getDiagnostics();
const snapshot = solver.getSnapshot(1);

assert.equal(diagnostics.timeSeconds, 6 * 3600, 'solver did not reach the six-hour target');
assert.ok(diagnostics.steps > 100, 'long-duration scenario used unexpectedly few steps');
assert.ok(Number.isFinite(diagnostics.stableDtSeconds) && diagnostics.stableDtSeconds > 0, 'stable time step is invalid');
assert.ok(diagnostics.maxCfl <= diagnostics.cflLimit + 1e-12, `CFL ${diagnostics.maxCfl} exceeded ${diagnostics.cflLimit}`);
assert.equal(diagnostics.nonFiniteCorrections, 0, 'solver had to correct non-finite state');
assert.equal(diagnostics.nonFiniteCells, 0, 'solver ended with non-finite cells');
assert.ok(Math.abs(diagnostics.massResidualFraction) < 5e-5, `mass residual ${diagnostics.massResidualFraction} is too large`);
assert.ok(Number.isFinite(snapshot.maxRunup) && Number.isFinite(snapshot.maxInundation), 'run-up diagnostics are not finite');
assert.ok(snapshot.cells.every(cell => Number.isFinite(cell.eta) && Number.isFinite(cell.maxDepth) && cell.maxDepth >= 0), 'snapshot contains invalid cell output');

const fresh = Physics.createNonlinearTsunamiSolver(grid, source, { dryTolerance: 0.02, manning: 0.025 });
assert.equal(fresh.getTime(), 0, 'new solver inherited time from a previous run');
assert.equal(fresh.getDiagnostics().steps, 0, 'new solver inherited step state from a previous run');

const wetNx = 50;
const wetNy = 30;
const wetData = [];
for (let y = 0; y < wetNy; y++) {
  for (let x = 0; x < wetNx; x++) wetData.push(x < 30 ? -Math.max(0.2, (30 - x) * 2) : Math.min(3, (x - 30) * 0.1));
}
const wetGrid = { origin: [0, 0], res: 0.002, nx: wetNx, ny: wetNy, data: wetData, meta: { quality: 'verification', dataset: 'wetting-drying stress benchmark' } };
const wetSource = Physics.createSourceModel({ lat: 0.03, lng: 0.045, mw: 10, depth: 1, strike: 0, dip: 5, rake: 90, sourceType: 'interplate' });
const wetSolver = Physics.createNonlinearTsunamiSolver(wetGrid, wetSource, { dryTolerance: 0.001, manning: 0 });
wetSolver.advanceTo(3600);
const wetSnapshot = wetSolver.getSnapshot(1);
const wetDiagnostics = wetSolver.getDiagnostics();
assert.ok(wetSnapshot.maxRunup > 0 && wetSnapshot.maxInundation > 0, 'wetting/drying stress case produced no run-up or inundation');
assert.equal(wetDiagnostics.nonFiniteCorrections, 0, 'wetting/drying stress case produced non-finite state');
assert.ok(Math.abs(wetDiagnostics.massResidualFraction) < 5e-5, `wetting/drying mass residual ${wetDiagnostics.massResidualFraction} is too large`);

console.log('Tsunami stability validation passed.');
console.log(`  simulated: 6.0 h, steps: ${diagnostics.steps}, wall time: ${(elapsedMs / 1000).toFixed(2)} s`);
console.log(`  max CFL: ${diagnostics.maxCfl.toFixed(4)} / ${diagnostics.cflLimit.toFixed(2)}`);
console.log(`  mass residual: ${(diagnostics.massResidualFraction * 100).toExponential(3)}%`);
console.log(`  wet/dry stress run-up: ${wetSnapshot.maxRunup.toFixed(3)} m, inundation: ${wetSnapshot.maxInundation.toFixed(3)} m`);
