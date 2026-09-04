// ================================================================
//  Unit tests for RTWave — live multi-station seismogram panel helpers
//  Run with:  node --test tests/rt-waveform.test.js
//  (no DOM/fetch required — start() is a safe no-op like rt-kmoni)
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const RTWave = require('../public/rt-waveform.js');
const Physics = require('../public/physics.js');

// ================================================================
//  NODE SAFETY / MODULE SHAPE
// ================================================================
test('module loads under node without DOM/fetch and start() is a safe no-op', () => {
  assert.ok(RTWave, 'module should export');
  assert.strictEqual(typeof RTWave.start, 'function');
  assert.strictEqual(RTWave.isActive(), false);
  assert.strictEqual(RTWave.start(), false, 'start() must no-op without document/fetch');
  assert.strictEqual(RTWave.isActive(), false);
  RTWave.stop(); // must not throw on fresh state
});

test('frozen station set rings Japan (MAJO/YSS/INCN/TATO, matching the server whitelist)', () => {
  const stas = RTWave.stations().map(s => s.sta).sort();
  assert.deepStrictEqual(stas, ['INCN', 'MAJO', 'TATO', 'YSS']);
  for (const s of RTWave.stations()) {
    assert.ok(isFinite(s.lat) && isFinite(s.lng), s.sta + ' needs coordinates for P/S ticks');
  }
});

// ================================================================
//  parseSettings — localStorage shape with hard clamps
// ================================================================
test('parseSettings: defaults, valid values, and bad/legacy values', () => {
  assert.deepStrictEqual(RTWave.parseSettings(null), { windowSec: 600, collapsed: false });
  assert.deepStrictEqual(RTWave.parseSettings(''), { windowSec: 600, collapsed: false });
  assert.deepStrictEqual(RTWave.parseSettings('garbage{'), { windowSec: 600, collapsed: false });
  assert.deepStrictEqual(RTWave.parseSettings({ windowSec: 1200, collapsed: true }), { windowSec: 1200, collapsed: true });
  // only 300/600/1200 are legal; anything else falls back to the default
  assert.strictEqual(RTWave.parseSettings({ windowSec: 900 }).windowSec, 600);
  assert.strictEqual(RTWave.parseSettings({ windowSec: -5 }).windowSec, 600);
  assert.strictEqual(RTWave.parseSettings({ collapsed: 'yes' }).collapsed, false);
});

// ================================================================
//  minMaxEnvelope — loss-free pixel decimation
// ================================================================
test('minMaxEnvelope: min/max per bucket, out-of-window samples dropped, gaps null', () => {
  const t0 = 1000000, sps = 40;
  const counts = [];
  for (let i = 0; i < 40; i++) counts.push(i < 20 ? i : 40 - i); // 0..19..1 triangle
  const segs = [{ startMs: t0, sps, counts }];
  const env = RTWave.minMaxEnvelope(segs, t0, t0 + 1000, 10); // 1 s window, 10 buckets
  assert.ok(env, 'envelope exists');
  assert.strictEqual(env.buckets.length, 10);
  // bucket 0 covers t0..t0+100ms = samples 0..3 → [0, 3]
  assert.deepStrictEqual(env.buckets[0], [0, 3]);
  // bucket 4 covers samples ~16..19 → [16, 19] (peak)
  assert.deepStrictEqual(env.buckets[4], [16, 19]);
  assert.ok(env.coverage > 0.9, 'fully covered window');
  // half-empty window: buckets past the data stay null
  const env2 = RTWave.minMaxEnvelope(segs, t0 - 4000, t0 + 1000, 50);
  assert.strictEqual(env2.buckets[0], null, 'bucket before the data start is null');
  assert.ok(env2.coverage <= 0.21, 'only the last fifth of the window has data');
  // out-of-range window entirely
  assert.strictEqual(RTWave.minMaxEnvelope(segs, t0 + 5000, t0 + 6000, 10), null);
  // malformed input
  assert.strictEqual(RTWave.minMaxEnvelope([], t0, t0 + 1000, 10), null);
  assert.strictEqual(RTWave.minMaxEnvelope(segs, t0, t0, 10), null);
});

// ================================================================
//  eewTicks — predicted P/S arrivals from tracked events
// ================================================================
test('eewTicks: P before S, sorted, cancels and hypocenter-less events skipped (physics stub)', () => {
  const stub = {
    haversineDist: (lat1, lng1, lat2, lng2) => Math.abs(lat1 - lat2) * 111 + Math.abs(lng1 - lng2) * 90,
    pTravelTime: (km) => 10 + km / 6,
    sTravelTime: (km) => 10 + km / 3.5
  };
  const station = { lat: 36.5, lng: 138.2 };
  const origin = 2000000;
  const dist = stub.haversineDist(37.0, 138.0, station.lat, station.lng);
  const events = [
    { id: 'A', originMs: origin, lat: 37.0, lng: 138.0, depthKm: 30 },
    { id: 'B', originMs: origin, lat: 37.0, lng: 138.0, isCancel: true },       // canceled — skipped
    { id: 'C', originMs: origin, lat: null, lng: 138.0 },                        // no hypocenter — skipped
    { id: 'D', originMs: origin, lat: 40.0, lng: 140.0, depthKm: null }          // depth fallback = 10
  ];
  const t0 = origin, t1 = origin + 120000;
  const ticks = RTWave.eewTicks(events, station, t0, t1, stub);
  assert.ok(ticks.length >= 3, 'A:P, A:S, D:P/D at minimum: ' + JSON.stringify(ticks));
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].ms >= ticks[i - 1].ms, 'sorted');
  const kinds = ticks.map(t => t.kind).join('');
  assert.ok(kinds.indexOf('P') < kinds.lastIndexOf('S') || ticks.length === 0);
  // event A's P/S exactly at origin + travel seconds
  const pA = origin + stub.pTravelTime(dist, 30) * 1000;
  const sA = origin + stub.sTravelTime(dist, 30) * 1000;
  assert.ok(ticks.some(t => t.kind === 'P' && Math.abs(t.ms - pA) < 1), 'event A P tick present');
  assert.ok(ticks.some(t => t.kind === 'S' && Math.abs(t.ms - sA) < 1), 'event A S tick present');
  // empty inputs / missing physics
  assert.deepStrictEqual(RTWave.eewTicks([], station, t0, t1, stub), []);
  assert.deepStrictEqual(RTWave.eewTicks(events, station, t0, t1, null), []);
});

test('eewTicks: real Physics travel times — Nankai-trough event reaches MAJO with P < S < window end', () => {
  const station = { lat: 36.54567, lng: 138.20406 }; // MAJO
  const ev = { id: 'X', originMs: 0, lat: 33.5, lng: 135.0, depthKm: 20 };
  const dist = Physics.haversineDist(ev.lat, ev.lng, station.lat, station.lng);
  const ticks = RTWave.eewTicks([ev], station, 0, 600000, Physics);
  assert.strictEqual(ticks.length, 2);
  assert.strictEqual(ticks[0].kind, 'P');
  assert.strictEqual(ticks[1].kind, 'S');
  assert.ok(ticks[0].ms < ticks[1].ms);
  assert.ok(Math.abs(ticks[0].ms - Physics.pTravelTime(dist, 20) * 1000) < 1.5);
  assert.ok(Math.abs(ticks[1].ms - Physics.sTravelTime(dist, 20) * 1000) < 1.5);
});

// ================================================================
//  dataAgeMs — staleness cue
// ================================================================
test('dataAgeMs: end-of-last-segment vs wall clock; null without data', () => {
  assert.strictEqual(RTWave.dataAgeMs(null, 5000), null);
  assert.strictEqual(RTWave.dataAgeMs({ segments: [] }, 5000), null);
  const seg = { startMs: 0, sps: 10, counts: new Array(10).fill(0) }; // ends at 900 ms
  assert.strictEqual(RTWave.dataAgeMs({ segments: [seg] }, 5000), 4100);
  const two = { segments: [{ startMs: 0, sps: 10, counts: [0] }, { startMs: 10000, sps: 10, counts: [0, 0, 0, 0, 0] }] };
  assert.strictEqual(RTWave.dataAgeMs(two, 10500), 100); // 5 samples → ends 10400; uses the NEWEST segment
});
