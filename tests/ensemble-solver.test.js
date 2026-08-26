'use strict';
// v5.7 tail: ensemble worker host — protocol + fallback parity.
// Node cannot spawn the browser Worker, so the tests drive the UMD core
// (EnsembleWorkerCore.handle) and the host's synchronous fallback path; the
// threshold logic and message shapes are what the browser path relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');
const Core = require('../public/ensemble-worker.js');
const Host = require('../public/ensemble-solver-host.js');

const CTX = {
  source: { lat: 35.7, lng: 140.3, mw: 7.0, depthKm: 20, strikeDeg: 0, dipDeg: 90, rakeDeg: 0, sourceType: 'crustal' },
  geometry: null, gmpModel: 'zhao2006', options: {}
};
const STATIONS = [
  { lat: 35.72, lng: 140.31, vs30: 350 },
  { lat: 35.85, lng: 140.5, vs30: 600 },
  { lat: 36.2, lng: 139.8, vs30: 900 }
];

test('EnsembleWorkerCore: boot + run + error protocol', async () => {
  const posted = [];
  Core.handle({ type: 'boot' }, m => posted.push(m));
  assert.ok(posted.some(m => m.type === 'booted'));
  Core.handle({ id: 7, type: 'run', context: CTX, stations: STATIONS, options: { members: 6, seed: 3 } }, m => posted.push(m));
  const result = posted.find(m => m.id === 7 && m.type === 'result');
  assert.ok(result, 'run posts a result');
  assert.equal(result.result.perStation.length, STATIONS.length);
  assert.ok(result.result.coverage === null); // no observedIntensity on synthetic stations
  // engine errors surface as typed error messages, not crashes
  Core.handle({ id: 8, type: 'run', context: null, stations: STATIONS, options: {} }, m => posted.push(m));
  const err = posted.find(m => m.id === 8 && m.type === 'error');
  assert.ok(err && err.message, 'error message posted');
});

test('EnsembleSolverHost: sync fallback below threshold, identical numbers', async () => {
  assert.ok(Host.WORKER_MIN_MEMBERS >= 100, 'worker threshold is the research regime');
  // node has no Worker -> the fallback runs regardless of member count
  const viaHost = await Host.run(CTX, STATIONS, { members: 12, seed: 5 });
  const direct = Physics.ensembleIntensityField(CTX, STATIONS, { members: 12, seed: 5 });
  assert.deepEqual(viaHost.perStation.map(r => r.p50), direct.perStation.map(r => r.p50),
    'same engine, same seed -> byte-identical medians');
  // large member counts resolve through the same fallback in node
  const big = await Host.run(CTX, STATIONS, { members: 120, seed: 5 });
  assert.equal(big.members, 120);
  Host.dispose();
  assert.ok(Host.workerDead(), 'dispose marks the permanent-fallback state');
});
