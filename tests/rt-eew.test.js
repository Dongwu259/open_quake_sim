// ================================================================
//  Unit tests for RTEew — Wolfx jma_eew live overlay module
//  Pure helpers only: no DOM, no Leaflet.
//  Run with:  node --test tests/rt-eew.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const RTEew = require('../public/rt-eew.js');

// ================================================================
//  FIXTURES (raw Wolfx jma_eew shape, incl. upstream 'Magunitude' typo)
// ================================================================

function fullFixture() {
  return {
    type: 'jma_eew',
    Title: '緊急地震速報（警報）',
    CodeType: '0101',
    Issue: { Source: '気象庁', Status: '通常' },
    EventID: '20240101120000',
    Serial: 3,
    AnnouncedTime: '2024/01/01 12:00:05.100',
    OriginTime: '2024/01/01 12:00:00.000',
    Hypocenter: '石川県能登地方',
    Latitude: 37.5,
    Longitude: 137.2,
    Magunitude: 7.6,
    Depth: 16,
    MaxIntensity: { From: '6-', To: '7' },
    Accuracy: { Epicenter: 2, Depth: 2, Magnitude: 2 },
    MaxIntChange: { String: '不明', Reason: 4 },
    WarnArea: [
      { Chiiki: '石川県能登', Shindo1: '6+', Shindo2: '6+', Time: '', Type: 'Warning', Arrive: true },
      { Chiiki: '新潟県上越', Shindo1: '5+', Shindo2: '6-', Time: '2024/01/01 12:00:20', Type: 'Forecast', Arrive: false }
    ],
    isSea: false,
    isTraining: false,
    isAssumption: false,
    isWarn: true,
    isFinal: false,
    isCancel: false,
    OriginalText: ''
  };
}

function soundsOf(res) {
  return res.effects.filter(function(e) { return e.type === 'sound'; }).map(function(e) { return e.name; });
}

// ================================================================
//  parseWolfx
// ================================================================

test('parseWolfx — full fixture normalizes every field', () => {
  const p = RTEew.parseWolfx(fullFixture());
  assert.ok(p, 'should parse');
  assert.strictEqual(p.eventId, '20240101120000');
  assert.strictEqual(p.serial, 3);
  assert.strictEqual(p.mag, 7.6);
  assert.strictEqual(p.depth, 16);
  assert.strictEqual(p.lat, 37.5);
  assert.strictEqual(p.lng, 137.2);
  assert.strictEqual(p.place, '石川県能登地方');
  assert.strictEqual(p.maxInt, '7', 'prefer MaxIntensity.To over From');
  assert.strictEqual(p.isWarn, true);
  assert.strictEqual(p.isFinal, false);
  assert.strictEqual(p.isCancel, false);
  assert.strictEqual(p.isTraining, false);
  assert.strictEqual(p.isAssumption, false);
  assert.strictEqual(p.warnAreas.length, 2);
  assert.deepStrictEqual(p.warnAreas[0], {
    name: '石川県能登', shindo1: '6+', shindo2: '6+', type: 'Warning', arrive: true
  });
  assert.strictEqual(p.warnAreas[1].type, 'Forecast');
  assert.strictEqual(p.warnAreas[1].arrive, false);
});

test('parseWolfx — JST times become exact epoch ms (UTC+9)', () => {
  const p = RTEew.parseWolfx(fullFixture());
  assert.strictEqual(p.originMs, Date.UTC(2024, 0, 1, 3, 0, 0, 0));
  assert.strictEqual(p.announcedMs, Date.UTC(2024, 0, 1, 3, 0, 5, 100));
});

test('parseWolfx — minimal fixture gets safe defaults', () => {
  const p = RTEew.parseWolfx({ EventID: 'X1', Serial: 1, Magunitude: 5.5 });
  assert.ok(p);
  assert.strictEqual(p.eventId, 'X1');
  assert.strictEqual(p.mag, 5.5);
  assert.strictEqual(p.maxInt, '');
  assert.deepStrictEqual(p.warnAreas, []);
  assert.strictEqual(p.originMs, null);
  assert.strictEqual(p.announcedMs, null);
  assert.strictEqual(p.lat, null);
  assert.strictEqual(p.lng, null);
  assert.strictEqual(p.depth, null);
  assert.strictEqual(p.place, '');
  assert.strictEqual(p.isWarn, false);
  assert.strictEqual(p.isFinal, false);
  assert.strictEqual(p.isCancel, false);
  assert.strictEqual(p.isTraining, false);
});

test('parseWolfx — MaxIntensity as plain string passes through', () => {
  const p = RTEew.parseWolfx({ EventID: 'S1', Serial: 1, Magunitude: 6.1, MaxIntensity: '5+' });
  assert.strictEqual(p.maxInt, '5+');
});

test('parseWolfx — MaxIntensity object without To falls back to From', () => {
  const p = RTEew.parseWolfx({ EventID: 'S2', Serial: 2, Magunitude: 5.0, MaxIntensity: { From: '4' } });
  assert.strictEqual(p.maxInt, '4');
});

test('parseWolfx — missing Serial defaults to 1', () => {
  const p = RTEew.parseWolfx({ EventID: 'S3', Magunitude: 4.5 });
  assert.strictEqual(p.serial, 1);
});

test('parseWolfx — rejects missing EventID', () => {
  assert.strictEqual(RTEew.parseWolfx({ Magunitude: 7.0, Serial: 1 }), null);
  assert.strictEqual(RTEew.parseWolfx({ EventID: '', Magunitude: 7.0 }), null);
});

test('parseWolfx — rejects invalid magnitude', () => {
  assert.strictEqual(RTEew.parseWolfx({ EventID: 'A', Magunitude: 0 }), null, 'Magunitude=0');
  assert.strictEqual(RTEew.parseWolfx({ EventID: 'A', Magunitude: -1 }), null, 'negative');
  assert.strictEqual(RTEew.parseWolfx({ EventID: 'A', Magunitude: 'abc' }), null, 'NaN');
  assert.strictEqual(RTEew.parseWolfx({ EventID: 'A' }), null, 'missing');
});

test('parseWolfx — rejects non-object input', () => {
  assert.strictEqual(RTEew.parseWolfx(null), null);
  assert.strictEqual(RTEew.parseWolfx(undefined), null);
  assert.strictEqual(RTEew.parseWolfx('jma_eew'), null);
  assert.strictEqual(RTEew.parseWolfx(42), null);
});

test('parseWolfx — isSea flag passes through (interplate forecast routing)', () => {
  const sea = RTEew.parseWolfx(Object.assign(fullFixture(), { isSea: true }));
  assert.strictEqual(sea.isSea, true);
  const land = RTEew.parseWolfx(fullFixture()); // fixture carries isSea: false
  assert.strictEqual(land.isSea, false);
  const missing = RTEew.parseWolfx({ EventID: 'X', Magunitude: 5.0 });
  assert.strictEqual(missing.isSea, false, 'absent isSea defaults to false (crustal/intraslab routing)');
});

test('parseWolfx — Accuracy block: numeric levels pass through', () => {
  const p = RTEew.parseWolfx(fullFixture()); // fixture: Accuracy {Epicenter:2, Depth:2, Magnitude:2}
  assert.deepStrictEqual(p.accuracy, {
    epicenter: 2, depth: 2, magnitude: 2, numberOfMagnitude: null
  });
});

test('parseWolfx — Accuracy block: JMA label strings and station count', () => {
  // Real-recorded Wolfx shape (recordings/20260811): label strings, no count.
  const str = RTEew.parseWolfx(Object.assign(fullFixture(), {
    Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: 'IPF 法（5 点以上）', Magnitude: '防災科研システム' }
  }));
  assert.deepStrictEqual(str.accuracy, {
    epicenter: 'IPF 法（5 点以上）', depth: 'IPF 法（5 点以上）',
    magnitude: '防災科研システム', numberOfMagnitude: null
  });
  const n = RTEew.parseWolfx(Object.assign(fullFixture(), {
    Accuracy: { Epicenter: 4, Depth: 4, Magnitude: 6, NumberOfMagnitude: 5 }
  }));
  assert.strictEqual(n.accuracy.numberOfMagnitude, 5);
});

test('parseWolfx — missing or empty Accuracy -> null', () => {
  const p = RTEew.parseWolfx({ EventID: 'X', Magunitude: 5.0 });
  assert.strictEqual(p.accuracy, null);
  const empty = RTEew.parseWolfx(Object.assign(fullFixture(), { Accuracy: {} }));
  assert.strictEqual(empty.accuracy, null, 'all-null components collapse to null');
  const partial = RTEew.parseWolfx(Object.assign(fullFixture(), { Accuracy: { Epicenter: 3 } }));
  assert.deepStrictEqual(partial.accuracy, {
    epicenter: 3, depth: null, magnitude: null, numberOfMagnitude: null
  });
});

// ================================================================
//  parseJstMs
// ================================================================

test('parseJstMs — exact epoch for JST midnight and noon', () => {
  assert.strictEqual(RTEew.parseJstMs('2024/01/01 12:00:00.000'), Date.UTC(2024, 0, 1, 3, 0, 0));
  assert.strictEqual(RTEew.parseJstMs('2024/01/01 00:00:00.000'), Date.UTC(2023, 11, 31, 15, 0, 0));
});

test('parseJstMs — fractional seconds, 1-3 digits', () => {
  assert.strictEqual(RTEew.parseJstMs('2024/01/01 12:00:00.5'), Date.UTC(2024, 0, 1, 3, 0, 0, 500));
  assert.strictEqual(RTEew.parseJstMs('2024/01/01 12:00:00.05'), Date.UTC(2024, 0, 1, 3, 0, 0, 50));
  assert.strictEqual(RTEew.parseJstMs('2024/01/01 12:00:00.123'), Date.UTC(2024, 0, 1, 3, 0, 0, 123));
});

test('parseJstMs — missing fraction tolerated, invalid input -> null', () => {
  assert.strictEqual(RTEew.parseJstMs('2024/01/01 12:00:00'), Date.UTC(2024, 0, 1, 3, 0, 0));
  assert.strictEqual(RTEew.parseJstMs('not a time'), null);
  assert.strictEqual(RTEew.parseJstMs(''), null);
  assert.strictEqual(RTEew.parseJstMs(null), null);
  assert.strictEqual(RTEew.parseJstMs(undefined), null);
});

// ================================================================
//  waveRadiusKm
// ================================================================

test('waveRadiusKm — 6 km/s stub, 60 s elapsed -> ~360 km', () => {
  // t(d) = d/6 inverts to distance = elapsed * 6: 60 s * 6 km/s = 360 km.
  const stub = function(d) { return d / 6; };
  const r = RTEew.waveRadiusKm(stub, 0, 6, 60);
  assert.ok(Math.abs(r - 360) < 1, 'expected ~360 km, got ' + r);
  // 10 km/s crustal P-wave equivalent: 60 s -> 600 km.
  const fast = function(d) { return d / 10; };
  const rFast = RTEew.waveRadiusKm(fast, 0, 10, 60);
  assert.ok(Math.abs(rFast - 600) < 1, 'expected ~600 km, got ' + rFast);
});

test('waveRadiusKm — radius grows monotonically with elapsed time', () => {
  const stub = function(d) { return d / 6; };
  const r30 = RTEew.waveRadiusKm(stub, 0, 6, 30);
  const r60 = RTEew.waveRadiusKm(stub, 0, 6, 60);
  const r90 = RTEew.waveRadiusKm(stub, 0, 6, 90);
  assert.ok(r30 < r60 && r60 < r90, r30 + ' < ' + r60 + ' < ' + r90);
});

test('waveRadiusKm — 0 before first arrival (depth delays surface arrival)', () => {
  // Depth term: vertical path of 30 km at 6 km/s -> 5 s before d=0 arrival.
  const stub = function(d, depth) { return (depth / 6) + (d / 6); };
  assert.strictEqual(RTEew.waveRadiusKm(stub, 30, 6, 3), 0, '3 s < 5 s vertical');
  assert.strictEqual(RTEew.waveRadiusKm(stub, 30, 6, 0), 0, 'zero elapsed');
  assert.strictEqual(RTEew.waveRadiusKm(stub, 30, 6, -10), 0, 'negative elapsed');
  const r = RTEew.waveRadiusKm(stub, 30, 6, 65); // (65-5)*6 = 360 km
  assert.ok(Math.abs(r - 360) < 1, 'expected ~360 km, got ' + r);
});

test('waveRadiusKm — caps at maxKm (default 2000)', () => {
  const stub = function(d) { return d / 6; };
  assert.strictEqual(RTEew.waveRadiusKm(stub, 0, 6, 100000), 2000);
  assert.strictEqual(RTEew.waveRadiusKm(stub, 0, 6, 100000, 100), 100);
});

test('waveRadiusKm — travelTimeFn receives depth and speed', () => {
  const seen = [];
  const stub = function(d, depth, speed) { seen.push([d, depth, speed]); return 10 + d / 4; };
  RTEew.waveRadiusKm(stub, 42, 4, 60);
  assert.ok(seen.length > 2, 'bisection should probe repeatedly');
  assert.deepStrictEqual(seen[0], [0, 42, 4], 'first probe at d=0 with depth+speed');
});

// ================================================================
//  Lifecycle tracker (pure reducer) — new -> warn -> final
// ================================================================

test('tracker — new event serial 1 plays EEW1 and stays active', () => {
  const tr = RTEew.createTracker();
  const announced = Date.UTC(2024, 0, 1, 3, 0, 0);
  const parsed = RTEew.parseWolfx({
    EventID: 'E1', Serial: 1, Magunitude: 6.0,
    AnnouncedTime: '2024/01/01 12:00:00.000', OriginTime: '2024/01/01 11:59:55.000'
  });
  const res = RTEew.trackReport(tr, parsed, announced + 2000);
  assert.ok(res);
  assert.deepStrictEqual(soundsOf(res), ['EEW1']);
  assert.strictEqual(res.state.phase, 'active');
  assert.strictEqual(res.state.serial, 1);
  assert.strictEqual(res.state.offsetMs, 2000, 'offset = receivedAt - announcedMs');
  assert.strictEqual(tr.events['E1'], res.state, 'stored in tracker');
});

test('tracker — warn upgrade plays EEW_alert once, then final plays EEW2', () => {
  const tr = RTEew.createTracker();
  const t0 = Date.UTC(2024, 0, 1, 3, 0, 0);
  const mk = function(extra) {
    return RTEew.parseWolfx(Object.assign({
      EventID: 'E2', Magunitude: 6.5,
      AnnouncedTime: '2024/01/01 12:00:00.000', OriginTime: '2024/01/01 11:59:55.000'
    }, extra));
  };
  const r1 = RTEew.trackReport(tr, mk({ Serial: 1 }), t0 + 1000);
  assert.deepStrictEqual(soundsOf(r1), ['EEW1']);
  const r2 = RTEew.trackReport(tr, mk({ Serial: 2, isWarn: true }), t0 + 5000);
  assert.deepStrictEqual(soundsOf(r2), ['EEW_alert'], 'forecast -> warning upgrade');
  assert.strictEqual(r2.state.phase, 'active');
  const r3 = RTEew.trackReport(tr, mk({ Serial: 3, isWarn: true }), t0 + 9000);
  assert.deepStrictEqual(soundsOf(r3), [], 'already warn: no second alert');
  const r4 = RTEew.trackReport(tr, mk({ Serial: 4, isWarn: true, isFinal: true }), t0 + 13000);
  assert.deepStrictEqual(soundsOf(r4), ['EEW2'], 'final report chime');
  assert.strictEqual(r4.state.phase, 'final');
  assert.strictEqual(r4.state.finalAt, t0 + 13000);
  assert.strictEqual(r4.state.serial, 4);
});

test('tracker — cancel path removes with EEW_canceled, repeat cancel is silent', () => {
  const tr = RTEew.createTracker();
  const t0 = Date.UTC(2024, 0, 1, 3, 0, 0);
  const mk = function(extra) {
    return RTEew.parseWolfx(Object.assign({
      EventID: 'E3', Magunitude: 5.0,
      AnnouncedTime: '2024/01/01 12:00:00.000', OriginTime: '2024/01/01 11:59:58.000'
    }, extra));
  };
  const r1 = RTEew.trackReport(tr, mk({ Serial: 1 }), t0 + 1000);
  assert.deepStrictEqual(soundsOf(r1), ['EEW1']);
  const r2 = RTEew.trackReport(tr, mk({ Serial: 2, isCancel: true }), t0 + 6000);
  assert.deepStrictEqual(soundsOf(r2), ['EEW_canceled']);
  assert.strictEqual(r2.state.phase, 'canceled');
  assert.strictEqual(r2.state.cancelAt, t0 + 6000);
  const r3 = RTEew.trackReport(tr, mk({ Serial: 3, isCancel: true }), t0 + 9000);
  assert.deepStrictEqual(soundsOf(r3), [], 'duplicate cancel does not re-trigger');
  assert.strictEqual(r3.state.phase, 'canceled');
});

test('tracker — first-seen serial above 1 does not play EEW1', () => {
  const tr = RTEew.createTracker();
  const parsed = RTEew.parseWolfx({ EventID: 'E4', Serial: 4, Magunitude: 6.0 });
  const res = RTEew.trackReport(tr, parsed, Date.UTC(2024, 0, 1, 3, 0, 0));
  assert.deepStrictEqual(soundsOf(res), []);
  assert.strictEqual(res.state.serial, 4);
});

test('tracker — offset estimated once and clamped to [-5000, +60000]', () => {
  const tr = RTEew.createTracker();
  const announced = Date.UTC(2024, 0, 1, 3, 0, 0);
  const mk = function(serial) {
    return RTEew.parseWolfx({
      EventID: 'E5', Serial: serial, Magunitude: 6.0,
      AnnouncedTime: '2024/01/01 12:00:00.000'
    });
  };
  const r1 = RTEew.trackReport(tr, mk(1), announced + 999999);
  assert.strictEqual(r1.state.offsetMs, 60000, 'clamped high');
  const r2 = RTEew.trackReport(tr, mk(2), announced - 999999);
  assert.strictEqual(r2.state.offsetMs, 60000, 'not re-estimated on later frames');
  assert.strictEqual(r2.state.receivedAt, announced - 999999, 'receivedAt still updates');
  assert.strictEqual(RTEew.clampOffsetMs(-999999), -5000, 'clamped low');
  assert.strictEqual(RTEew.clampOffsetMs(NaN), 0);
});

test('tracker — out-of-order older serial keeps latest report (and does not refresh receivedAt)', () => {
  const tr = RTEew.createTracker();
  const mk = function(serial, mag) {
    return RTEew.parseWolfx({ EventID: 'E6', Serial: serial, Magunitude: mag });
  };
  const t0 = Date.UTC(2024, 0, 1, 3, 0, 0);
  RTEew.trackReport(tr, mk(3, 6.2), t0);
  const r = RTEew.trackReport(tr, mk(2, 5.0), t0 + 1000);
  assert.strictEqual(r.state.serial, 3);
  assert.strictEqual(r.state.latest.mag, 6.2, 'latest stays the newer report');
  // Stale/duplicate serials must not re-stamp receivedAt — the 120 s expiry
  // sweep used to be kept alive forever by them (2026-08-23 audit fix).
  assert.strictEqual(r.state.receivedAt, t0);
});

test('elapsedSec — local clock since origin, clamped >= 0', () => {
  const origin = Date.UTC(2024, 0, 1, 3, 0, 0);
  const tr = RTEew.createTracker();
  const parsed = RTEew.parseWolfx({
    EventID: 'E7', Serial: 1, Magunitude: 6.0, OriginTime: '2024/01/01 12:00:00.000'
  });
  const res = RTEew.trackReport(tr, parsed, origin + 1000);
  assert.strictEqual(RTEew.elapsedSec(res.state, origin + 5000), 5);
  assert.strictEqual(RTEew.elapsedSec(res.state, origin - 5000), 0, 'before origin clamps to 0');
  assert.strictEqual(RTEew.elapsedSec(null, origin), 0);
  const noOrigin = RTEew.parseWolfx({ EventID: 'E8', Serial: 1, Magunitude: 6.0 });
  const res2 = RTEew.trackReport(tr, noOrigin, origin);
  assert.strictEqual(RTEew.elapsedSec(res2.state, origin + 9999), 0, 'missing origin -> 0');
});

// ================================================================
//  Public API surface
// ================================================================

test('API — exposes start/stop/getActive/demo plus pure helpers', () => {
  assert.strictEqual(typeof RTEew.start, 'function');
  assert.strictEqual(typeof RTEew.stop, 'function');
  assert.strictEqual(typeof RTEew.getActive, 'function');
  assert.strictEqual(typeof RTEew.demo, 'function');
  assert.strictEqual(typeof RTEew.getClockOffsetMs, 'function');
  assert.strictEqual(typeof RTEew.refreshNtp, 'function');
  assert.strictEqual(typeof RTEew.parseWolfx, 'function');
  assert.strictEqual(typeof RTEew.formatAccuracy, 'function');
  assert.strictEqual(typeof RTEew.accuracyIsLow, 'function');
  assert.strictEqual(typeof RTEew.waveRadiusKm, 'function');
  assert.strictEqual(typeof RTEew.createTracker, 'function');
  assert.strictEqual(typeof RTEew.trackReport, 'function');
  assert.strictEqual(typeof RTEew.shindoToJp, 'function');
  assert.strictEqual(typeof RTEew.shindoRank, 'function');
  assert.strictEqual(typeof RTEew.formatWarnAreas, 'function');
  assert.strictEqual(typeof RTEew.matchWarnPrefectures, 'function');
  assert.strictEqual(typeof RTEew.haversineKm, 'function');
  assert.strictEqual(typeof RTEew.countdownRemainSec, 'function');
  assert.deepStrictEqual(RTEew.getActive(), [], 'no events tracked in a fresh module');
  assert.strictEqual(RTEew.getClockOffsetMs(), 0, 'clock offset defaults to local clock');
  RTEew.stop(); // no-op outside the browser: must not throw
});

// ================================================================
//  NTP clock offset
// ================================================================

test('elapsedSec — applies the NTP clock offset (+ and -)', () => {
  const origin = Date.UTC(2024, 0, 1, 3, 0, 0);
  const tr = RTEew.createTracker();
  const parsed = RTEew.parseWolfx({
    EventID: 'N1', Serial: 1, Magunitude: 6.0, OriginTime: '2024/01/01 12:00:00.000'
  });
  const res = RTEew.trackReport(tr, parsed, origin + 1000);
  try {
    RTEew._setClockOffsetMs(5000); // local clock 5 s behind the server
    assert.strictEqual(RTEew.elapsedSec(res.state, origin + 10000), 15);
    RTEew._setClockOffsetMs(-3000); // local clock 3 s ahead
    assert.strictEqual(RTEew.elapsedSec(res.state, origin + 10000), 7);
    assert.strictEqual(RTEew.elapsedSec(res.state, origin + 1000), 0, 'still clamps >= 0');
    assert.strictEqual(RTEew.getClockOffsetMs(), -3000);
  } finally {
    RTEew._setClockOffsetMs(0);
  }
});

test('NTP — offset computed from a stubbed /api/ntp fetch', async () => {
  const realFetch = global.fetch;
  const serverMs = Math.floor((Date.now() + 42000) / 1000) * 1000; // server 42 s ahead
  global.fetch = async (url) => {
    assert.strictEqual(url, '/api/ntp');
    return { ok: true, json: async () => ({ JST: '', CST: '', str: '', int: 0, timestamp: serverMs / 1000 }) };
  };
  try {
    const off = await RTEew.refreshNtp();
    const expected = serverMs - Date.now();
    assert.ok(off !== null, 'fetch should succeed');
    assert.ok(Math.abs(off - expected) < 2000, 'offset ≈ server−local (got ' + off + ', expected ≈ ' + expected + ')');
    assert.strictEqual(RTEew.getClockOffsetMs(), off, 'stored for elapsedSec');
  } finally {
    global.fetch = realFetch;
    RTEew._setClockOffsetMs(0);
  }
});

test('NTP — millisecond timestamp (the real Wolfx form) is NOT re-multiplied', async () => {
  const realFetch = global.fetch;
  const serverMs = Date.now() + 42000; // real API serves 13-digit ms
  global.fetch = async () => ({ ok: true, json: async () => ({ timestamp: serverMs }) });
  try {
    const off = await RTEew.refreshNtp();
    const expected = serverMs - Date.now();
    assert.ok(off !== null, 'fetch should succeed');
    assert.ok(Math.abs(off - expected) < 2000, 'offset ≈ server−local (got ' + off + ', expected ≈ ' + expected + ')');
  } finally {
    global.fetch = realFetch;
    RTEew._setClockOffsetMs(0);
  }
});

test('NTP — failed fetch keeps the previous offset (local-clock fallback)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    RTEew._setClockOffsetMs(0);
    const off = await RTEew.refreshNtp();
    assert.strictEqual(off, null);
    assert.strictEqual(RTEew.getClockOffsetMs(), 0, 'offset stays 0 -> local clock');
  } finally {
    global.fetch = realFetch;
  }
});

test('NTP — midpoint RTT compensation: offset uses serverMs + RTT/2 - t1', async () => {
  const realFetch = global.fetch;
  const serverMs = Date.now() + 42000;
  const delayMs = 120; // simulated one-way-ish round trip
  global.fetch = async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { ok: true, json: async () => ({ timestamp: serverMs }) };
  };
  try {
    const off = await RTEew.refreshNtp();
    assert.ok(off !== null, 'fetch should succeed');
    // Without compensation the offset would be serverMs - t1; with it the
    // offset lands ~RTT/2 above that plain estimate.
    const plain = serverMs - Date.now();
    const gain = off - plain;
    assert.ok(gain > 10, 'expected a measurable RTT/2 lift, got ' + gain + ' ms');
    assert.ok(gain < 2000, 'lift should stay within the round trip, got ' + gain + ' ms');
  } finally {
    global.fetch = realFetch;
    RTEew._setClockOffsetMs(0);
  }
});

// ================================================================
//  shindoToJp / formatWarnAreas / matchWarnPrefectures / countdownRemainSec
// ================================================================

test('shindoToJp — all bands', () => {
  assert.strictEqual(RTEew.shindoToJp('5-'), '5弱');
  assert.strictEqual(RTEew.shindoToJp('5+'), '5強');
  assert.strictEqual(RTEew.shindoToJp('6-'), '6弱');
  assert.strictEqual(RTEew.shindoToJp('6+'), '6強');
  assert.strictEqual(RTEew.shindoToJp('7'), '7', 'plain bands pass through');
  assert.strictEqual(RTEew.shindoToJp('4'), '4');
  assert.strictEqual(RTEew.shindoToJp('1'), '1');
  assert.strictEqual(RTEew.shindoToJp(''), '不明');
  assert.strictEqual(RTEew.shindoToJp(null), '不明');
  assert.strictEqual(RTEew.shindoToJp(undefined), '不明');
});

test('formatWarnAreas — rank sort, top-N cap, 他N suffix', () => {
  const areas = [
    { name: '奈良県', shindo1: '4', shindo2: '4' },
    { name: '和歌山県南部', shindo1: '5+', shindo2: '6+' },
    { name: '三重県南部', shindo1: '4', shindo2: '5-' },
    { name: '大阪府南部', shindo1: '5-', shindo2: '5+' },
    { name: '徳島県北部', shindo1: '4', shindo2: '5-' }
  ];
  assert.strictEqual(
    RTEew.formatWarnAreas(areas),
    '和歌山県南部 6+、大阪府南部 5+、三重県南部 5- 他2',
    '6+ > 5+ > 5- (5+ ranks above 5-), capped at 3 with 他2');
  assert.strictEqual(
    RTEew.formatWarnAreas(areas, 2),
    '和歌山県南部 6+、大阪府南部 5+ 他3');
  assert.strictEqual(RTEew.formatWarnAreas([areas[0]]), '奈良県 4', 'single area, no suffix');
  assert.strictEqual(
    RTEew.formatWarnAreas([{ name: '足摺岬沖', shindo1: '', shindo2: '' }]),
    '足摺岬沖', 'area without shindo omits the label');
  assert.strictEqual(RTEew.formatWarnAreas([]), '');
  assert.strictEqual(RTEew.formatWarnAreas(null), '');
});

test('matchWarnPrefectures — prefix, alias and fullwidth-digit matching', () => {
  // JMA prefecture order: id = index + 1 (1 北海道 .. 47 沖縄県).
  const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県',
    '埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県',
    '岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
    '鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県',
    '佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
  const m = RTEew.matchWarnPrefectures(
    ['宮城県北部', '伊豆諸島', '小笠原諸島', '東京都２３区', '和歌山県南部', '火星県北部'],
    PREFS);
  assert.strictEqual(m['宮城県北部'], 4, '宮城県北部 -> 宮城県 (id 4)');
  assert.strictEqual(m['伊豆諸島'], 13, '伊豆諸島 -> 東京都 (id 13)');
  assert.strictEqual(m['小笠原諸島'], 13, '小笠原諸島 -> 東京都');
  assert.strictEqual(m['東京都２３区'], 13, 'fullwidth ２３ normalized -> 東京都');
  assert.strictEqual(m['和歌山県南部'], 30, '和歌山県南部 -> 和歌山県 (id 30)');
  assert.strictEqual(m['火星県北部'], null, 'unknown chiiki -> null');
});

test('countdownRemainSec — S travel time minus elapsed (stub travel-time)', () => {
  const stub = (d, depth, speed) => d / speed + depth / 10;
  const r = RTEew.countdownRemainSec(stub, 99, 20, 3.3, 5);
  assert.ok(Math.abs(r - (99 / 3.3 + 2 - 5)) < 1e-9, 'dist/speed + depth term − elapsed');
  assert.ok(RTEew.countdownRemainSec(stub, 10, 0, 3.3, 60) < 0, 'negative once the S wave has arrived');
  assert.strictEqual(RTEew.countdownRemainSec(null, 10, 0, 3.3, 5), null, 'no travel-time fn -> null');
  assert.strictEqual(RTEew.countdownRemainSec(() => NaN, 10, 0, 3.3, 5), null, 'non-finite -> null');
});

// ================================================================
//  TTS effect descriptors (pure reducer output)
// ================================================================

test('tracker — TTS effects for serial 1, warn upgrade and cancel', () => {
  const tr = RTEew.createTracker();
  const t0 = Date.UTC(2024, 0, 1, 3, 0, 0);
  const mk = (extra) => RTEew.parseWolfx(Object.assign({
    EventID: 'TTS1', Magunitude: 6.9, Hypocenter: '紀伊半島沖',
    AnnouncedTime: '2024/01/01 12:00:00.000', OriginTime: '2024/01/01 11:59:55.000',
    MaxIntensity: { From: '4', To: '5-' }
  }, extra));
  const ttsOf = (res) => res.effects.filter((e) => e.type === 'tts').map((e) => e.messages[0]);

  const r1 = RTEew.trackReport(tr, mk({ Serial: 1 }), t0);
  assert.deepStrictEqual(ttsOf(r1),
    ['緊急地震速報。紀伊半島沖で地震、マグニチュード6.9、最大震度5弱の予想。']);

  const r2 = RTEew.trackReport(tr, mk({
    Serial: 2, isWarn: true, MaxIntensity: { From: '5+', To: '6+' },
    WarnArea: [
      { Chiiki: '和歌山県南部', Shindo1: '6+', Shindo2: '6+' },
      { Chiiki: '奈良県', Shindo1: '4', Shindo2: '4' },
      { Chiiki: '三重県南部', Shindo1: '5-', Shindo2: '5-' }
    ]
  }), t0 + 4000);
  assert.deepStrictEqual(ttsOf(r2),
    ['緊急地震速報（警報）です。和歌山県南部、三重県南部では強い揺れに警戒してください。'],
    'top-2 areas by shindo rank');

  const r3 = RTEew.trackReport(tr, mk({ Serial: 3, isCancel: true }), t0 + 8000);
  assert.deepStrictEqual(ttsOf(r3), ['緊急地震速報は取り消されました。']);

  const r4 = RTEew.trackReport(tr, mk({ Serial: 4, isFinal: true }), t0 + 12000);
  assert.deepStrictEqual(ttsOf(r4), [], 'final report has no TTS');
});

// ================================================================
//  demo()
// ================================================================

test('demo() — no-op returning false when realtime is inactive', () => {
  global.RTData = { isActive: function() { return false; } };
  try {
    assert.strictEqual(RTEew.demo(), false);
    assert.deepStrictEqual(RTEew.getActive(), [], 'no demo event ingested');
  } finally {
    delete global.RTData;
  }
});

test('demo() — ingests training report 1 immediately when realtime is active', () => {
  global.RTData = { isActive: function() { return true; } };
  try {
    assert.strictEqual(RTEew.demo(), true);
    const act = RTEew.getActive();
    assert.strictEqual(act.length, 1, 'one demo event tracked');
    assert.strictEqual(act[0].eventId, 'RTEEW-DEMO');
    assert.strictEqual(act[0].phase, 'active');
    assert.strictEqual(act[0].isTraining, true);
    assert.strictEqual(act[0].serial, 1);
    assert.strictEqual(act[0].latest.mag, 6.9);
    assert.strictEqual(act[0].latest.place, '紀伊半島沖');
    assert.strictEqual(act[0].latest.lat, 33.0);
    assert.strictEqual(act[0].latest.lng, 136.0);
    assert.strictEqual(act[0].latest.depth, 20);
    assert.strictEqual(act[0].latest.maxInt, '5-');
    assert.strictEqual(act[0].latest.warnAreas.length, 3);
    assert.ok(Math.abs(act[0].latest.originMs - (Date.now() - 6000)) < 5000, 'origin ≈ now−6s');
  } finally {
    RTEew.stop(); // clears intervals + pending demo timers
    delete global.RTData;
  }
});

// ================================================================
//  forecastShindoAt — GMPE model forecast field (Zhao 2006)
// ================================================================

test('forecastShindoAt — empty without Physics or usable hypocenter', () => {
  delete global.Physics;
  assert.strictEqual(RTEew.forecastShindoAt({ lat: 33, lng: 136, mag: 7.1, depth: 20 }, 34, 135.5), '');
  global.Physics = require('../public/physics.js');
  try {
    assert.strictEqual(RTEew.forecastShindoAt(null, 34, 135.5), '');
    assert.strictEqual(RTEew.forecastShindoAt({ lat: 33, lng: 136, mag: 0 }, 34, 135.5), '');
    assert.strictEqual(RTEew.forecastShindoAt({ lat: null, lng: null, mag: 7.1 }, 34, 135.5), '');
  } finally {
    delete global.Physics;
  }
});

test('forecastShindoAt — near field predicts strong shaking, far field decays', () => {
  global.Physics = require('../public/physics.js');
  try {
    // M7.1 interplate event off the Kii peninsula (rt-demo scenario)
    const latest = { lat: 33.0, lng: 136.0, mag: 7.1, depth: 20, isSea: true };
    const near = RTEew.forecastShindoAt(latest, 34.0, 135.5); // 和歌山県南部 ~150 km
    assert.ok(RTEew.shindoRank(near) >= RTEew.shindoRank('4+'),
      'near field should predict at least 4+, got ' + near);
    const far = RTEew.forecastShindoAt(latest, 43.06, 141.35); // 札幌 ~1100 km
    assert.ok(RTEew.shindoRank(far) < RTEew.shindoRank('3'),
      'far field should decay below the paint threshold, got ' + far);
  } finally {
    delete global.Physics;
  }
});

test('forecastShindoAt — source class routing: sea (interplate) ≡ land (crustal) at PGA per Zhao (2006)', () => {
  global.Physics = require('../public/physics.js');
  try {
    // Zhao (2006) Table 4: the interface-specific PGA coefficients are all
    // zero (SI=0.000, QI=0, WI=0) — interface and crustal PGA predictions
    // coincide exactly; the tectonic classes differentiate only at
    // spectral periods (the PGV proxy uses the 1.0 s row, SI=-0.239).
    const sea = RTEew.forecastShindoAt({ lat: 35, lng: 140, mag: 6.5, depth: 20, isSea: true }, 35.5, 140.5);
    const land = RTEew.forecastShindoAt({ lat: 35, lng: 140, mag: 6.5, depth: 20, isSea: false }, 35.5, 140.5);
    assert.ok(RTEew.shindoRank(sea) === RTEew.shindoRank(land),
      `interplate PGA should equal crustal PGA at the same geometry: sea=${sea} land=${land}`);
  } finally {
    delete global.Physics;
  }
});

test('forecastShindoAt — parsed sea event feeds the interplate branch end to end', () => {
  global.Physics = require('../public/physics.js');
  try {
    const parsed = RTEew.parseWolfx(Object.assign(fullFixture(), { isSea: true }));
    assert.strictEqual(parsed.isSea, true, 'parseWolfx carried isSea');
    const qLat = parsed.lat + 0.5, qLng = parsed.lng + 0.5;
    const viaParsed = RTEew.forecastShindoAt(parsed, qLat, qLng);
    const explicit = RTEew.forecastShindoAt(
      { lat: parsed.lat, lng: parsed.lng, mag: parsed.mag, depth: parsed.depth, isSea: true }, qLat, qLng);
    assert.strictEqual(viaParsed, explicit, 'parsed report routes exactly like an explicit sea event');
    const land = RTEew.forecastShindoAt(
      { lat: parsed.lat, lng: parsed.lng, mag: parsed.mag, depth: parsed.depth, isSea: false }, qLat, qLng);
    // Paper semantics: interface PGA ≡ crustal PGA (SI_PGA = 0) — the
    // interplate branch must never read lower at the same geometry.
    assert.ok(RTEew.shindoRank(viaParsed) >= RTEew.shindoRank(land),
      'interplate should not under-shake crustal at the same geometry: sea=' + viaParsed + ' land=' + land);
  } finally {
    delete global.Physics;
  }
});

// ================================================================
//  normChiikiName — WarnArea Chiiki normalization
// ================================================================

test('normChiikiName — fullwidth digits and whitespace folded', () => {
  assert.strictEqual(RTEew.normChiikiName('東京都２３区'), '東京都23区');
  assert.strictEqual(RTEew.normChiikiName('和歌山県南部'), '和歌山県南部');
  assert.strictEqual(RTEew.normChiikiName(' 宮城県北部 '), '宮城県北部');
  assert.strictEqual(RTEew.normChiikiName(''), '');
  assert.strictEqual(RTEew.normChiikiName(null), '');
});

// ================================================================
//  formatAccuracy / accuracyIsLow — precision badge line
// ================================================================

test('formatAccuracy — numeric levels in all three languages', () => {
  const acc = { epicenter: 2, depth: 2, magnitude: 2, numberOfMagnitude: 5 };
  assert.strictEqual(RTEew.formatAccuracy(acc, 'ja'),
    '震源精度 Lv2 · 深度精度 Lv2 · M精度 Lv2 · 使用站数 5');
  assert.strictEqual(RTEew.formatAccuracy(acc, 'en'),
    'Epicenter Lv2 · Depth Lv2 · M Lv2 · 5 stations');
  assert.strictEqual(RTEew.formatAccuracy(acc, 'zh'),
    '震源精度 Lv2 · 深度精度 Lv2 · M精度 Lv2 · 使用台站 5');
  const one = { epicenter: null, depth: null, magnitude: null, numberOfMagnitude: 1 };
  assert.strictEqual(RTEew.formatAccuracy(one, 'en'), '1 station', 'singular station');
});

test('formatAccuracy — label strings pass through (whitespace stripped, capped)', () => {
  const acc = { epicenter: 'IPF 法（5 点以上）', depth: 'IPF 法（5 点以上）', magnitude: '防災科研システム', numberOfMagnitude: null };
  const line = RTEew.formatAccuracy(acc, 'ja');
  assert.ok(line.indexOf('IPF法（5点以上）') >= 0, 'string label kept, whitespace stripped: ' + line);
  assert.ok(line.indexOf('防災科研システム') >= 0);
  const long = { epicenter: 'IPF 法（5 点以上の観測点）', depth: null, magnitude: null, numberOfMagnitude: null };
  assert.ok(RTEew.formatAccuracy(long, 'ja').indexOf('…') >= 0, 'long labels truncated with …');
});

test('formatAccuracy — missing components omitted, empty -> empty string', () => {
  assert.strictEqual(RTEew.formatAccuracy(null, 'ja'), '');
  assert.strictEqual(RTEew.formatAccuracy({}, 'ja'), '');
  const partial = { epicenter: 3, depth: null, magnitude: null, numberOfMagnitude: null };
  assert.strictEqual(RTEew.formatAccuracy(partial, 'ja'), '震源精度 Lv3');
});

test('accuracyIsLow — numeric <=2, 試験 labels and 1-2 点 labels flagged', () => {
  assert.strictEqual(RTEew.accuracyIsLow(null), false);
  assert.strictEqual(RTEew.accuracyIsLow({ epicenter: 2, depth: 4, magnitude: 6 }), true, 'Lv2 epicenter is low');
  assert.strictEqual(RTEew.accuracyIsLow({ epicenter: 4, depth: 4, magnitude: 6 }), false);
  assert.strictEqual(RTEew.accuracyIsLow({ epicenter: '試験', depth: '試験', magnitude: '試験' }), true, 'test feed flagged');
  assert.strictEqual(RTEew.accuracyIsLow({ epicenter: 'IPF 法（1 点）', depth: null, magnitude: null }), true, 'IPF 1 point is low');
  assert.strictEqual(RTEew.accuracyIsLow({ epicenter: 'IPF 法（2 点）', depth: null, magnitude: null }), true, 'IPF 2 points is low');
  assert.strictEqual(RTEew.accuracyIsLow({ epicenter: 'IPF 法（5 点以上）', depth: 'IPF 法（5 点以上）', magnitude: '防災科研システム' }), false);
});

test('validateUserLatLng — bounds, NaN and the null island rejected', () => {
  assert.strictEqual(RTEew.validateUserLatLng(35.68, 139.69), true);
  assert.strictEqual(RTEew.validateUserLatLng(-33.86, 151.2), true);
  assert.strictEqual(RTEew.validateUserLatLng(90, 180), true);
  assert.strictEqual(RTEew.validateUserLatLng(90.01, 140), false);
  assert.strictEqual(RTEew.validateUserLatLng(35, 180.01), false);
  assert.strictEqual(RTEew.validateUserLatLng(0, 0), false, '0,0 treated as unset');
  assert.strictEqual(RTEew.validateUserLatLng(NaN, 140), false);
  assert.strictEqual(RTEew.validateUserLatLng('abc', 140), false);
  assert.strictEqual(RTEew.validateUserLatLng(undefined, null), false);
});

test('set/get/clearUserLocation — manual pin lifecycle without DOM', () => {
  assert.strictEqual(RTEew.getUserLocation(), null, 'no pin initially under node');
  assert.strictEqual(RTEew.setUserLocation(35.68, 139.69), true);
  const loc = RTEew.getUserLocation();
  assert.ok(loc && loc.manual === true);
  assert.ok(Math.abs(loc.lat - 35.68) < 1e-9 && Math.abs(loc.lng - 139.69) < 1e-9);
  assert.strictEqual(RTEew.setUserLocation(999, 0), false, 'invalid coords rejected');
  const loc2 = RTEew.getUserLocation();
  assert.ok(Math.abs(loc2.lat - 35.68) < 1e-9, 'rejected set leaves the old pin');
  // map-pick state machine
  assert.strictEqual(RTEew.isUserLocPickArmed(), false);
  RTEew.armUserLocPick();
  assert.strictEqual(RTEew.isUserLocPickArmed(), true);
  assert.strictEqual(RTEew.completeUserLocPick(34.69, 135.5), true, 'pick completes into a manual pin');
  assert.strictEqual(RTEew.isUserLocPickArmed(), false, 'pick disarmed after completion');
  const loc3 = RTEew.getUserLocation();
  assert.ok(Math.abs(loc3.lat - 34.69) < 1e-9 && Math.abs(loc3.lng - 135.5) < 1e-9);
  RTEew.armUserLocPick();
  RTEew.cancelUserLocPick();
  assert.strictEqual(RTEew.isUserLocPickArmed(), false);
  RTEew.clearUserLocation();
  assert.strictEqual(RTEew.getUserLocation(), null, 'clear drops the pin');
});

test('countdownWarnThresholdSec / mainviewEnabled — node defaults (no localStorage)', () => {
  assert.strictEqual(RTEew.countdownWarnThresholdSec(), 30, 'default countdown warning 30 s');
  assert.strictEqual(RTEew.mainviewEnabled(), true, 'main view on by default');
});
