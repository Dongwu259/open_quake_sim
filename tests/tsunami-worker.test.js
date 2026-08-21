'use strict';
// v5.5: tsunami solver worker — UMD driver core (in-process), the main-thread
// host fallback path, and the function-stripping transport for source models.
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');
const TsunamiWorkerCore = require('../public/tsunami-worker.js');
const TsunamiSolverHost = require('../public/tsunami-solver-host.js');

function syntheticGrid() {
  const nx = 80, ny = 60, res = 0.05, origin = [138, 33];
  const data = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    data[y * nx + x] = x > nx - 6 ? 50 : -2000; // land strip on the east edge
  }
  return {origin, res, nx, ny, data};
}
function syntheticSource() {
  return Physics.createSourceModel({lat: 33.6, lng: 139.2, mag: 8.0, mw: 8.0, depthKm: 20,
    strikeDeg: 180, dipDeg: 30, rakeDeg: 90, mechanismKnown: true, sourceType: 'interplate'});
}
const CPS = [{lat: 33.8, lng: 139.0}, {lat: 33.4, lng: 139.6}];

test('worker core — init/advance/snapshot/drop round trip in-process', () => {
  const core = TsunamiWorkerCore.create();
  const replies = [];
  const post = m => replies.push(m);
  core.handle({type: 'init', key: 'ev1', gridId: 'g1', grid: syntheticGrid(),
    source: syntheticSource(), options: {}, checkpoints: CPS}, post);
  assert.equal(replies[0].type, 'ready');
  assert.equal(replies[0].key, 'ev1');
  assert.equal(replies[0].waterDepths.length, 2);
  assert.ok(replies[0].waterDepths[0] > 100, 'ocean checkpoint has water depth');
  replies.length = 0;
  core.handle({type: 'advance', key: 'ev1', t: 120, stride: 2, force: true}, post);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].type, 'snapshot');
  const snap = replies[0].snapshot;
  assert.equal(Math.round(snap.time), 120);
  assert.ok(snap.cells.length > 0, 'wave field rendered into cells');
  assert.ok(snap.maxWaveHeight > 0.1, 'wave height is physical');
  assert.equal(replies[0].peaks.length, 2);
  assert.ok(replies[0].peaks.every(p => isFinite(p)));
  core.handle({type: 'drop', key: 'ev1'}, post);
  replies.length = 0;
  core.handle({type: 'advance', key: 'ev1', t: 200, stride: 2, force: true}, post);
  assert.equal(replies.length, 0, 'dropped solver stays silent');
});

test('worker core — snapshot posts are throttled unless forced', () => {
  const core = TsunamiWorkerCore.create();
  const replies = [];
  const post = m => replies.push(m);
  core.handle({type: 'init', key: 'k', gridId: 'g', grid: syntheticGrid(), source: syntheticSource(), options: {}, checkpoints: CPS}, post);
  replies.length = 0;
  core.handle({type: 'advance', key: 'k', t: 30, stride: 2, force: true}, post);
  core.handle({type: 'advance', key: 'k', t: 31, stride: 2}, post); // within the 180 ms window
  assert.equal(replies.filter(r => r.type === 'snapshot').length, 1, 'second advance throttled');
  core.handle({type: 'reset'}, post);
  core.handle({type: 'advance', key: 'k', t: 60, stride: 2, force: true}, post);
  assert.equal(replies.filter(r => r.type === 'snapshot').length, 1, 'reset clears solvers');
});

test('worker core — function-stripped source models solve identically (rehydrate path)', () => {
  const src = syntheticSource();
  const plain = TsunamiSolverHost._stripFunctions(src, []);
  assert.equal(typeof plain.geometry.point, 'undefined', 'helpers stripped');
  const core = TsunamiWorkerCore.create();
  const replies = [];
  const post = m => replies.push(m);
  core.handle({type: 'init', key: 'k', gridId: 'g', grid: syntheticGrid(), source: plain, options: {}, checkpoints: CPS}, post);
  assert.equal(replies[0].type, 'ready');
  core.handle({type: 'advance', key: 'k', t: 120, stride: 2, force: true}, post);
  const workerSnap = replies[1].snapshot;
  // Reference: in-process solver with the original (function-carrying) source.
  const ref = Physics.createNonlinearTsunamiSolver(syntheticGrid(), syntheticSource(), {});
  ref.advanceTo(120);
  const refSnap = ref.getSnapshot(2);
  assert.ok(Math.abs(workerSnap.maxWaveHeight - refSnap.maxWaveHeight) < 1e-6,
    `worker ${workerSnap.maxWaveHeight} vs local ${refSnap.maxWaveHeight}`);
});

test('worker core — unknown grid id and null solver surface as keyed errors', () => {
  const core = TsunamiWorkerCore.create();
  const replies = [];
  core.handle({type: 'init', key: 'bad', gridId: 'missing', source: null, options: {}, checkpoints: []}, m => replies.push(m));
  assert.equal(replies[0].type, 'error');
  assert.equal(replies[0].key, 'bad');
});

test('host — no Worker in node falls back to a working in-process solver', () => {
  TsunamiSolverHost.resetAll();
  const proxy = TsunamiSolverHost.create({key: 'evA', grid: syntheticGrid(), source: syntheticSource(),
    options: {}, checkpoints: CPS});
  assert.equal(proxy.isWorker, false, 'node has no Worker -> local mode');
  assert.equal(proxy.isReady, true);
  const snap0 = proxy.getSnapshot(2);
  assert.ok(snap0 && snap0.time === 0, 't=0 snapshot before any stepping');
  proxy.advanceTo(120);
  const snap = proxy.getSnapshot(2);
  assert.ok(snap && Math.round(snap.time) === 120);
  assert.ok(snap.cells.length > 0);
  assert.ok(isFinite(proxy.samplePeak(CPS[0].lat, CPS[0].lng)));
  assert.ok(proxy.sampleWaterDepth(CPS[0].lat, CPS[0].lng) > 100);
  proxy.dispose();
  TsunamiSolverHost.resetAll();
});

test('host — _stripFunctions keeps typed arrays and plain data intact', () => {
  const typed = new Float32Array([1, 2, 3]);
  const out = TsunamiSolverHost._stripFunctions({a: 1, f: function() {}, t: typed, nest: {g: () => 1, v: 'x'}}, []);
  assert.equal(out.a, 1);
  assert.equal(out.f, undefined);
  assert.equal(out.nest.g, undefined);
  assert.equal(out.nest.v, 'x');
  assert.ok(out.t instanceof Float32Array && out.t.length === 3);
});
