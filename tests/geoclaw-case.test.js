'use strict';
// Grid-ladder helpers used by tools/export-geoclaw-case.js (resolution ladder
// for the GeoClaw crosscheck) — pure functions, no I/O.
const test = require('node:test');
const assert = require('node:assert/strict');
const { coarsenGrid, wet9, nodeOf, snapGaugeMulti } = require('../tools/lib/grid-ladder.js');

function gridOf(nx, ny, res, fill) {
  const data = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = fill(i, j);
  return { origin: [140.5, 35], res, nx, ny, data, meta: { dataset: 'synthetic' } };
}

test('coarsenGrid — K x K plain mean, geometry and metadata', () => {
  const g = gridOf(8, 8, 0.1, (i, j) => i + j * 10);
  const c = coarsenGrid(g, 2);
  assert.equal(c.nx, 4); assert.equal(c.ny, 4);
  assert.equal(c.res, 0.2);
  assert.deepEqual(c.origin, [140.5, 35]);
  // cell (0,0) = mean of (0,0),(1,0),(0,1),(1,1) = (0+1+10+11)/4 = 5.5
  assert.equal(c.data[0], 5.5);
  // cell (3,3) = mean of (6,6),(7,6),(6,7),(7,7) = (66+67+76+77)/4 = 71.5
  assert.equal(c.data[3 * 4 + 3], 71.5);
  assert.equal(c.meta.coarsenFactor, 2);
  assert.ok(/K=2/.test(c.meta.dataset), 'dataset records the coarsen factor');
});

test('coarsenGrid — K=1 passthrough, residual cells dropped, tiny grids rejected', () => {
  const g = gridOf(7, 7, 0.1, () => -100);
  assert.equal(coarsenGrid(g, 1), g, 'K=1 returns the same object');
  const g13 = gridOf(13, 13, 0.1, () => -100);
  assert.equal(coarsenGrid(g13, 3).nx, 4, 'residual cells dropped (13/3 -> 4)');
  const tiny = gridOf(9, 9, 0.1, () => -100);
  assert.throws(() => coarsenGrid(tiny, 8), /too small/);
});

test('wet9 — full 3x3 stencil must be wet, edges are never wet', () => {
  const g = gridOf(6, 6, 0.1, () => -50);
  assert.ok(wet9(g, 3, 3), 'interior all-wet stencil is wet');
  assert.ok(!wet9(g, 0, 0), 'domain edge is not a valid stencil');
  g.data[3 * 6 + 3] = 10; // one land node inside the stencil
  assert.ok(!wet9(g, 3, 2), 'land node inside the stencil breaks wet9');
  assert.ok(!wet9(g, 3, 3), 'the land node itself is not a valid center');
  assert.ok(wet9(g, 1, 1), 'a stencil away from the land node stays wet');
});

test('snapGaugeMulti — in place, ring snap, multi-level constraint, hopeless throw', () => {
  const fine = gridOf(10, 10, 0.025, () => -100);
  // in-place wet
  let s = snapGaugeMulti({ id: 1, name: 'a', lat: 35.1, lng: 140.6 }, [fine]);
  assert.ok(!s.snapped, 'already-wet gauge stays in place');
  // land at the target -> snaps to nearest wet ring node
  const coast = gridOf(10, 10, 0.025, (i, j) => (j >= 5 ? 100 : -100));
  s = snapGaugeMulti({ id: 2, name: 'b', lat: 35.1, lng: 140.6 }, [coast]);
  assert.ok(s.snapped, 'land gauge snaps');
  const n = nodeOf(coast, s.lat, s.lng);
  assert.ok(n.j < 5 && wet9(coast, n.j, n.i), 'snapped onto a fully-wet fine-grid stencil');
  // multi-level: fine-wet spots whose 2x-coarsened cell averages land must be rejected
  const fineMixed = gridOf(12, 12, 0.025, (i, j) => (j >= 8 ? 5 : -100));
  const coarse = coarsenGrid(fineMixed, 2); // coarse cells 4+ average land
  s = snapGaugeMulti({ id: 3, name: 'c', lat: 35.225, lng: 140.55 }, [fineMixed, coarse]);
  const nc = nodeOf(coarse, s.lat, s.lng);
  assert.ok(wet9(coarse, nc.j, nc.i), 'snapped position stays wet at the coarse level too');
  assert.ok(s.snapped, 'had to move off the land band');
  // impossible: all land
  const land = gridOf(10, 10, 0.025, () => 100);
  assert.throws(() => snapGaugeMulti({ id: 4, name: 'd', lat: 35.1, lng: 140.6 }, [land]), /no fully-wet stencil/);
});
