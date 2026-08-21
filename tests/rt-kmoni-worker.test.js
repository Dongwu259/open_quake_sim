// ================================================================
//  Unit tests for the RTKmoni compute core / Web Worker
//  (public/rt-kmoni-worker.js — UMD: engine driven directly here,
//  plus a full message-protocol round-trip through a vm-hosted
//  worker scope with a mock postMessage).
//  Run with:  node --test tests/rt-kmoni-worker.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../public/rt-kmoni-worker.js');
const K = require('../public/rt-kmoni.js');

// kmoni wire format: level + 100 per station (same as rt-demo encodeLevels)
function enc(levels) {
  return levels.map(l => String.fromCharCode(l + 100)).join('');
}

// 4-station dense cluster (~0.91 km steps) + 6-station far quiet group
function clusterItems() {
  const items = [];
  for (let i = 0; i < 4; i++) items.push([35.0, 139.0 + i * 0.01]);
  for (let i = 0; i < 6; i++) items.push([40.0, 145.0 + i * 0.01]);
  return items;
}
function frameLevels(clusterLv, farLv) {
  return enc([clusterLv, clusterLv, clusterLv, clusterLv,
    farLv, farLv, farLv, farLv, farLv, farLv]);
}

const T = 1000000; // base epoch ms for deterministic `now`

// ================================================================
//  MODULE SHAPE
// ================================================================

test('module exports the pure helpers + createEngine (UMD under node)', () => {
  for (const fn of ['decodeIntensity', 'levelToShindo', 'haversineKm', 'buildAdjacency',
    'computeActivity', 'sensitivityThresholds', 'detectActive', 'freshPeriod',
    'nextPeriodState', 'topStations', 'realActivityInLevels', 'createEngine']) {
    assert.strictEqual(typeof Core[fn], 'function', fn + ' exported');
  }
  assert.strictEqual(Core.TOP_N, 8);
});

test('decodeIntensity — wire contract (level = charCode - 100, clamped)', () => {
  const arr = Core.decodeIntensity(String.fromCharCode(100, 107, 120, 99, 200));
  assert.ok(arr instanceof Int16Array);
  assert.deepStrictEqual(Array.from(arr), [0, 7, 20, -1, 20]);
  assert.strictEqual(Core.decodeIntensity(null).length, 0);
});

// ================================================================
//  ENGINE — frame decode + rejection paths
// ================================================================

test('engine rejects frames without stations / with bad length', () => {
  const e = Core.createEngine();
  let r = e.frame(T, enc([5, 5]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-stations');

  e.init([[35.0, 139.0], [35.1, 139.1]]);
  assert.strictEqual(e.stationCount(), 2);
  r = e.frame(T, enc([5, 5, 5]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-length');
  r = e.frame(T, null);
  assert.strictEqual(r.ok, false, 'non-string intensity rejected');
});

test('engine decodes a quiet frame: levels/raw/top, no activity', () => {
  const e = Core.createEngine();
  e.init(clusterItems(), '2');
  const r = e.frame(T, frameLevels(2, 3));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.now, T);
  assert.ok(r.raw instanceof Int16Array && r.levels instanceof Int16Array);
  assert.deepStrictEqual(Array.from(r.raw), [2, 2, 2, 2, 3, 3, 3, 3, 3, 3]);
  assert.deepStrictEqual(Array.from(r.levels), Array.from(r.raw), 'first frame: effective == raw');
  assert.deepStrictEqual(r.active, []);
  assert.deepStrictEqual(r.detected, []);
  assert.strictEqual(r.activeCount, 0);
  assert.strictEqual(r.maxLevel, -1);
  assert.strictEqual(r.hotIdx, -1);
  assert.strictEqual(r.periodMax, 0);
  assert.strictEqual(r.notify, -1);
  assert.strictEqual(r.top.length, 8, 'top capped at 8');
  assert.strictEqual(r.top[0].level, 3, 'highest level first');
});

// ================================================================
//  ENGINE — no-data 4-frame reuse (effective vs raw levels)
// ================================================================

test('engine reuses the last valid reading for 4 frames, then goes dark', () => {
  const e = Core.createEngine();
  e.init([[35.0, 139.0]]);
  const NODATA = String.fromCharCode(99); // level -1
  assert.strictEqual(e.frame(T, enc([8])).levels[0], 8);
  for (let i = 1; i <= 4; i++) {
    const r = e.frame(T + i * 1000, NODATA);
    assert.strictEqual(r.raw[0], -1, 'raw keeps the no-data marker');
    assert.strictEqual(r.levels[0], 8, 'frame +' + i + 's reuses the last valid level');
  }
  const dark = e.frame(T + 5000, NODATA);
  assert.strictEqual(dark.levels[0], -1, '5th consecutive no-data frame goes dark');
});

// ================================================================
//  ENGINE — chain activation through real frames: trigger + settle
// ================================================================

test('chain activation triggers on a rising cluster and settles after the hold', () => {
  const e = Core.createEngine();
  e.init(clusterItems(), '2');

  e.frame(T, frameLevels(2, 2)); // baseline
  const rise = e.frame(T + 1000, frameLevels(8, 2)); // cluster jumps 2 -> 8
  assert.deepStrictEqual(rise.detected, [0, 1, 2, 3], 'whole cluster chain-activates');
  assert.deepStrictEqual(rise.active, [0, 1, 2, 3]);
  assert.strictEqual(rise.activeCount, 4);
  assert.strictEqual(rise.maxLevel, 8);
  assert.strictEqual(rise.hotIdx, 0, 'first hottest active station');
  assert.strictEqual(rise.periodMax, 8);
  assert.strictEqual(rise.notify, 1, 'crossing into the shindo-1 band notifies');
  assert.strictEqual(rise.top[0].level, 8);

  const steady = e.frame(T + 2000, frameLevels(8, 2)); // held cluster re-chains
  assert.deepStrictEqual(steady.active, [0, 1, 2, 3], 'still rising while held -> re-chain');
  assert.strictEqual(steady.notify, -1, 'same band does not re-notify');

  // shaking stops; hold (10.5 s from the last detection) expires
  const calm = e.frame(T + 2000 + 10501, frameLevels(2, 2));
  assert.deepStrictEqual(calm.active, [], 'active set empties once the hold lapses');
  assert.strictEqual(calm.activeCount, 0);
  assert.strictEqual(calm.hotIdx, -1);
  assert.strictEqual(calm.periodMax, 8, 'period max retained within the quiet window');

  // >60 s without any active station resets the period max
  const reset = e.frame(T + 2000 + 10501 + 60001, frameLevels(2, 2));
  assert.strictEqual(reset.periodMax, 0, 'period max resets after 60 s quiet');
});

test('init rebuilds state (period + history cleared)', () => {
  const e = Core.createEngine();
  e.init(clusterItems(), '2');
  e.frame(T, frameLevels(2, 2));
  const rise = e.frame(T + 1000, frameLevels(8, 2));
  assert.strictEqual(rise.periodMax, 8);
  e.init(clusterItems(), '2'); // sitelist reload
  const r = e.frame(T + 2000, frameLevels(2, 2));
  assert.strictEqual(r.periodMax, 0, 'period tracker reset by init');
  assert.deepStrictEqual(r.active, []);
  assert.deepStrictEqual(Array.from(r.levels), [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    'no -1 reuse from the previous incarnation (history cleared)');
});

// ================================================================
//  ENGINE — top-N ranking in frame results
// ================================================================

test('frame top list: sorted desc, index tie-break, cap 8', () => {
  const e = Core.createEngine();
  const items = [];
  for (let i = 0; i < 12; i++) items.push([35.0, 139.0 + i * 0.5]); // isolated stations
  e.init(items, '2');
  // levels 0..11 with a tie at the top (station 11 shares level 11)
  const levels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const r = e.frame(T, enc(levels));
  assert.strictEqual(r.top.length, 8);
  assert.deepStrictEqual(r.top.map(x => x.idx), [11, 10, 9, 8, 7, 6, 5, 4]);
  assert.strictEqual(r.top[0].level, 11);
  assert.strictEqual(typeof r.top[0].lat, 'number', 'entries carry lat/lng for flyTo');
});

// ================================================================
//  ENGINE — sensitivity: config message + per-frame override
// ================================================================

test('config sensitivity: medium rejects, high accepts the same cluster', () => {
  const e = Core.createEngine();
  const items = [[35.0, 139.0], [35.0, 139.01], [35.0, 139.02]];
  e.init(items, '2');
  e.frame(T, enc([4, 4, 4]));
  // jump 4 -> 7: ascend 3, activity 3.5 each; pool 7 + tri(2)=3 = 10
  const med = e.frame(T + 1000, enc([7, 7, 7]));
  assert.deepStrictEqual(med.active, [], 'medium: 10 < ACT[2]=12 -> rejected');
  e.config({ sensitivity: '3' });
  const hi = e.frame(T + 2000, enc([7, 7, 7]));
  assert.deepStrictEqual(hi.active, [0, 1, 2], 'high: bar 12-2=10 -> accepted');
  e.config({ sensitivity: '9' });
  const still = e.frame(T + 3000, enc([7, 7, 7]));
  assert.deepStrictEqual(still.active, [0, 1, 2], 'invalid config ignored, mode kept');
});

test('per-frame sensitivity overrides the stored mode for that frame only', () => {
  const e = Core.createEngine();
  const items = [[35.0, 139.0], [35.0, 139.01], [35.0, 139.02]];
  e.init(items, '2');
  e.frame(T, enc([2, 2, 2]));
  // jump 2 -> 9: activity 16 each — medium accepts, low (quorum 3) rejects
  const lo = e.frame(T + 1000, enc([9, 9, 9]), '1');
  assert.deepStrictEqual(lo.active, [], 'low override: fixed quorum 3 > 2 neighbors');
  const med = e.frame(T + 2000, enc([9, 9, 9])); // stored mode '2' again
  assert.deepStrictEqual(med.active, [0, 1, 2], 'stored medium mode accepts');
});

// ================================================================
//  DEMO-SHAPED INJECTION (rt-demo encodeLevels envelope -> engine)
//  rt-kmoni's injectDemoFrame routes through processFrame, which feeds
//  exactly this engine input; here the demo path is driven end-to-end.
// ================================================================

test('demo-shaped frames: rise to shindo-3 band, decay, settle after hold', () => {
  const e = Core.createEngine();
  e.init(clusterItems(), '2');
  e.frame(T, frameLevels(3, 3));                        // quiet baseline
  const peak = e.frame(T + 1000, frameLevels(12, 3));   // demo P/S peak
  assert.deepStrictEqual(peak.active, [0, 1, 2, 3], 'demo rise detected');
  assert.strictEqual(peak.notify, 3, 'band-3 crossing notifies');
  const decay1 = e.frame(T + 2000, frameLevels(10, 3)); // decaying envelope
  assert.deepStrictEqual(decay1.active, [0, 1, 2, 3], 'still ascending vs baseline -> held');
  const decay2 = e.frame(T + 3000, frameLevels(5, 3));
  assert.deepStrictEqual(decay2.active, [0, 1, 2, 3], 'within the 10.5 s hold');
  const over = e.frame(T + 3000 + 10501, frameLevels(3, 3));
  assert.deepStrictEqual(over.active, [], 'demo settles once the hold lapses');
});

test('rt-kmoni injectDemoFrame entry point survives the worker rewiring (node-safe)', () => {
  // no stations under node (no fetch/window) — must be a silent no-op
  assert.doesNotThrow(() => K.injectDemoFrame({ dataTime: 'x', intensity: enc([5, 5]) }));
  assert.strictEqual(K.isDemoMode(), false);
  K.setDemoMode(true);
  assert.strictEqual(K.isDemoMode(), true);
  K.setDemoMode(false);
});

// ================================================================
//  PROTOCOL ROUND-TRIP — vm-hosted worker scope, mock postMessage
// ================================================================

function makeWorkerScope() {
  const outbox = [];
  const ctx = {};
  ctx.self = ctx;                       // worker global === self
  ctx.importScripts = function() {};    // marks this as a worker scope
  ctx.postMessage = function(msg, transfer) { outbox.push({ msg, transfer }); };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'rt-kmoni-worker.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'rt-kmoni-worker.js' });
  return { ctx, outbox };
}

test('worker protocol: init/frame/reset round-trip with transferables', () => {
  const { ctx, outbox } = makeWorkerScope();
  assert.ok(ctx.RTKmoniCore, 'UMD published on the worker scope');
  assert.strictEqual(typeof ctx.onmessage, 'function', 'bootstrap installed onmessage');

  ctx.onmessage({ data: { type: 'init', stations: clusterItems(), sensitivity: '2' } });
  assert.strictEqual(outbox.length, 0, 'init is acknowledged silently');

  ctx.onmessage({ data: { type: 'frame', now: T, intensity: frameLevels(2, 2) } });
  assert.strictEqual(outbox.length, 1);
  const quiet = outbox[0];
  assert.strictEqual(quiet.msg.type, 'frame');
  assert.strictEqual(quiet.msg.ok, true);
  assert.ok(Array.isArray(quiet.transfer) && quiet.transfer.length === 2,
    'raw/levels buffers are transferred');
  assert.strictEqual(quiet.transfer[0], quiet.msg.raw.buffer);
  assert.strictEqual(quiet.transfer[1], quiet.msg.levels.buffer);
  assert.deepStrictEqual(Array.from(quiet.msg.active), []);

  ctx.onmessage({ data: { type: 'frame', now: T + 1000, intensity: frameLevels(8, 2) } });
  const rise = outbox[1].msg;
  // vm-realm arrays: normalize with Array.from before deep comparison
  assert.deepStrictEqual(Array.from(rise.active), [0, 1, 2, 3],
    'detection flows through the protocol');
  assert.strictEqual(rise.notify, 1);
  assert.strictEqual(rise.top[0].level, 8);

  // bad length is reported, not thrown
  ctx.onmessage({ data: { type: 'frame', now: T + 2000, intensity: enc([1, 2, 3]) } });
  const bad = outbox[2].msg;
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'bad-length');
  assert.strictEqual(outbox[2].transfer, undefined, 'no transfer on rejection');

  // unknown / malformed messages are ignored
  ctx.onmessage({ data: { type: 'nope' } });
  ctx.onmessage({ data: null });
  assert.strictEqual(outbox.length, 3);

  // reset drops all state — later frames reject with no-stations
  ctx.onmessage({ data: { type: 'reset' } });
  ctx.onmessage({ data: { type: 'frame', now: T + 3000, intensity: frameLevels(8, 2) } });
  const afterReset = outbox[3].msg;
  assert.strictEqual(afterReset.ok, false);
  assert.strictEqual(afterReset.reason, 'no-stations');
});

test('worker protocol: config message changes detection behavior', () => {
  const { ctx, outbox } = makeWorkerScope();
  const items = [[35.0, 139.0], [35.0, 139.01], [35.0, 139.02]];
  ctx.onmessage({ data: { type: 'init', stations: items, sensitivity: '2' } });
  ctx.onmessage({ data: { type: 'frame', now: T, intensity: enc([4, 4, 4]) } });
  ctx.onmessage({ data: { type: 'frame', now: T + 1000, intensity: enc([7, 7, 7]) } });
  assert.deepStrictEqual(Array.from(outbox[1].msg.active), [], 'medium rejects');
  ctx.onmessage({ data: { type: 'config', sensitivity: '3' } });
  ctx.onmessage({ data: { type: 'frame', now: T + 2000, intensity: enc([7, 7, 7]) } });
  assert.deepStrictEqual(Array.from(outbox[2].msg.active), [0, 1, 2], 'high accepts after config');
});

// ================================================================
//  SINGLE-IMPLEMENTATION WIRING — rt-kmoni delegates to the same core
// ================================================================

test('rt-kmoni pure exports are the core implementation (no drift)', () => {
  const str = String.fromCharCode(100, 115, 99, 131);
  assert.deepStrictEqual(Array.from(K.decodeIntensity(str)),
    Array.from(Core.decodeIntensity(str)));

  // detectActive with omitted mode == core with the node default '2'
  const items = [];
  for (let i = 0; i < 4; i++) items.push([35.0, 139.0 + i * 0.01]);
  const act = Core.computeActivity(8, 2, false);
  const sts = items.map(it => ({ lat: it[0], lng: it[1], level: 8,
    activity: act, ascend: 2, isActive: false }));
  const adj = Core.buildAdjacency(items);
  assert.deepStrictEqual(K.detectActive(sts, adj), Core.detectActive(sts, adj, '2'));
  assert.deepStrictEqual(K.detectActive(sts, adj), [0, 1, 2, 3]);

  const states = [{ lat: 1, lng: 1, level: 9 }, { lat: 2, lng: 2, level: 12 }];
  assert.deepStrictEqual(K.topStations(states, 1), Core.topStations(states, 1));
  assert.strictEqual(K.realActivityInLevels(new Int16Array(10).fill(11)),
    Core.realActivityInLevels(new Int16Array(10).fill(11)));
  assert.strictEqual(K.levelToShindo(17), Core.levelToShindo(17));
});
