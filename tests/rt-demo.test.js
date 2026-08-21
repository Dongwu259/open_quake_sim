// ================================================================
//  Unit tests for RTDemo — EEW 演示 scenario driver pure helpers
//  Run with:  node --test tests/rt-demo.test.js
//  (no DOM / Leaflet required — module must load cleanly under node)
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/rt-demo.js');
const K = require('../public/rt-kmoni.js');

// ================================================================
//  NODE SAFETY / MODULE SHAPE
// ================================================================

test('module loads under node; start() is a safe no-op without realtime', () => {
  assert.ok(D, 'module should export');
  assert.strictEqual(typeof D.start, 'function');
  assert.strictEqual(D.isRunning(), false);
  assert.strictEqual(D.start(), false, 'start() must no-op without RTData/realtime');
  assert.strictEqual(D.isRunning(), false);
  D.stop(); // must not throw on fresh state
  const s = D.getState();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.stationCount, 0);
  assert.ok(D.SCENARIO && typeof D.SCENARIO.lat === 'number' && typeof D.SCENARIO.mw === 'number');
});

// ================================================================
//  baselineLevel — deterministic quiet band 3..5
// ================================================================

test('baselineLevel — deterministic, within 3..5', () => {
  for (let i = 0; i < 500; i++) {
    const v = D.baselineLevel(i);
    assert.ok(v >= 3 && v <= 5, 'baseline in 3..5, got ' + v);
    assert.strictEqual(v, D.baselineLevel(i), 'same index -> same level');
  }
  // spread: all three values occur across a station network
  const set = new Set();
  for (let i = 0; i < 100; i++) set.add(D.baselineLevel(i));
  assert.ok(set.size >= 2, 'baselines vary across stations');
});

// ================================================================
//  encodeLevels — kmoni wire format (level+100), roundtrip via RTKmoni
// ================================================================

test('encodeLevels — roundtrip through RTKmoni.decodeIntensity', () => {
  const levels = [3, 5, 8, 12, 16, 20, 0, 7];
  const str = D.encodeLevels(levels);
  assert.strictEqual(str.length, levels.length);
  const decoded = K.decodeIntensity(str);
  assert.deepStrictEqual(Array.from(decoded), levels);
});

test('encodeLevels — clamps above 20 and encodes no-data as 99', () => {
  const str = D.encodeLevels([25, -1, 33]);
  assert.strictEqual(str.charCodeAt(0), 120, 'level clamps to 20');
  assert.strictEqual(str.charCodeAt(1), 99, 'no-data marker');
  assert.strictEqual(str.charCodeAt(2), 120);
  const decoded = K.decodeIntensity(str);
  assert.strictEqual(decoded[0], 20);
  assert.strictEqual(decoded[1], -1);
});

// ================================================================
//  stationLevel — envelope gating (P ramp / S hold / decay)
// ================================================================

test('stationLevel — quiet before P arrival', () => {
  assert.strictEqual(D.stationLevel(0, 10, 20, 18, 4, 17, 27), 4);
  assert.strictEqual(D.stationLevel(9.9, 10, 20, 18, 4, 17, 27), 4);
});

test('stationLevel — ramp between P and S rises slowly from base', () => {
  const atP = D.stationLevel(10, 10, 20, 18, 4, 17, 27);   // P coda frac 0.05
  const mid = D.stationLevel(15, 10, 20, 18, 4, 17, 27);   // P coda frac ~0.085
  assert.ok(atP > 4 && atP < mid, 'ramp starts above base and rises: ' + atP + ' < ' + mid);
  assert.ok(mid < 18, 'mid-ramp below peak');
});

test('stationLevel — S arrival ramps to peak over waveSRampDur, holds, then decays', () => {
  const atS = D.stationLevel(20, 10, 20, 18, 4, 17, 27);
  assert.ok(atS < 18 && atS > 4, 'S arrival still ramping (weak onset): ' + atS);
  assert.strictEqual(D.stationLevel(24, 10, 20, 18, 4, 17, 27), 18, 'peak after the 3 s S ramp (default mag 6)');
  assert.strictEqual(D.stationLevel(30, 10, 20, 18, 4, 17, 27), 18, 'inside hold');
  const d1 = D.stationLevel(45, 10, 20, 18, 4, 17, 27);
  const d2 = D.stationLevel(60, 10, 20, 18, 4, 17, 27);
  assert.ok(d1 < 18 && d1 > 4, 'decay below peak, above base');
  assert.ok(d2 < d1 && d2 >= 4, 'decay is monotonic toward base');
});

test('stationLevel — unaffected station (peak <= base) stays at baseline', () => {
  assert.strictEqual(D.stationLevel(100, 10, 20, 4, 5, 17, 27), 5);
  assert.strictEqual(D.stationLevel(100, 10, 20, 3, 5, 17, 27), 5);
});

// ================================================================
//  peakLevelFor — GMPE -> kmoni level (stub physics)
// ================================================================

test('peakLevelFor — maps JMA intensity to kmoni level (2·I + 6)', () => {
  const stub = {
    pgaZhao2006: () => 100,
    pgvZhao2006: () => 10,
    calcJmaIntensity: (pga, pgv) => (pga === 100 && pgv === 10 ? 1.84 : 0)
  };
  assert.strictEqual(D.peakLevelFor(50, 7, 20, stub), 10, 'I=1.84 -> level 10 (shindo 2 band)');
});

test('peakLevelFor — clamps at 20 and quiet floor', () => {
  const big = { pgaZhao2006: () => 9999, pgvZhao2006: () => 999, calcJmaIntensity: () => 6.8 };
  assert.strictEqual(D.peakLevelFor(5, 9, 10, big), 20);
  const zero = { pgaZhao2006: () => 0, pgvZhao2006: () => 0, calcJmaIntensity: () => 0 };
  assert.strictEqual(D.peakLevelFor(800, 5, 30, zero), 6, 'I=0 -> level 6 (quiet band)');
});

test('peakLevelFor — real Physics: near-field strong, far-field quiet', () => {
  const P = require('../public/physics.js');
  const near = D.peakLevelFor(30, 7.1, 20, P);
  const far = D.peakLevelFor(900, 7.1, 20, P);
  assert.ok(near >= 17, 'near-field reaches shindo 5+/6 band, got ' + near);
  // The faithful paper PGV proxy (1.0 s SA, b=-0.0022/km) decays more slowly
  // than PGA, so 900 km sits at intensity ~1.5 — still the shindo-1 band.
  assert.ok(far <= 9, 'far-field stays in the shindo-1 band (level<=9), got ' + far);
  assert.ok(near > far);
});

// ================================================================
//  haversineKm sanity
// ================================================================

test('haversineKm — Tokyo to Osaka ≈ 400 km', () => {
  const d = D.haversineKm(35.68, 139.69, 34.69, 135.50);
  assert.ok(d > 380 && d < 430, 'got ' + d);
});

// ================================================================
//  stationsCacheFresh / fetchStations — 6 h sitelist cache TTL
// ================================================================

test('stationsCacheFresh — TTL boundaries', () => {
  const T0 = 1000000;
  assert.strictEqual(D.SITELIST_TTL_MS, 6 * 3600e3, '6 h TTL');
  assert.strictEqual(D.stationsCacheFresh(0, T0), false, 'never fetched -> stale');
  assert.strictEqual(D.stationsCacheFresh(T0, T0), true, 'just fetched -> fresh');
  assert.strictEqual(D.stationsCacheFresh(T0, T0 + D.SITELIST_TTL_MS - 1), true, 'inside the TTL');
  assert.strictEqual(D.stationsCacheFresh(T0, T0 + D.SITELIST_TTL_MS), false, 'TTL reached -> re-fetch');
});

test('fetchStations — failure clears the cache, success dedups within the TTL', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  // failure first (cache empty): rejects and clears the slot for a retry
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500 }; };
  try {
    await assert.rejects(D.fetchStations(), /HTTP 500/);
    assert.strictEqual(calls, 1);
    // the retry refetches (slot was cleared) and then dedups within the TTL
    globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ items: [[35.0, 139.0]] }) }; };
    const a = await D.fetchStations();
    const b = await D.fetchStations();
    assert.strictEqual(calls, 2, 'second success served from the cache');
    assert.deepStrictEqual(a, [{ lat: 35.0, lng: 139.0 }], 'array items mapped to {lat,lng}');
    assert.strictEqual(b, a, 'same cached promise result');
  } finally {
    globalThis.fetch = origFetch;
  }
});
