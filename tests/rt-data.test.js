// ================================================================
//  Unit tests for RTData — replay time-shifting pure helpers
//  Run with:  node --test tests/rt-data.test.js
//  (no DOM required — module must load cleanly under node)
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const RTData = require('../public/rt-data.js');

const SHIFT = 3600 * 1000; // +1 hour

test('module loads under node and exports the replay helpers', () => {
  assert.ok(RTData);
  assert.strictEqual(typeof RTData.shiftEventTimes, 'function');
  assert.strictEqual(typeof RTData.shiftTimeValue, 'function');
  assert.strictEqual(typeof RTData.isReplaying, 'function');
  assert.strictEqual(RTData.isReplaying(), false);
  assert.strictEqual(typeof RTData.getP2PSource, 'function');
  const bus = RTData.getP2PSource();
  assert.ok(bus && typeof bus.addEventListener === 'function' && typeof bus.removeEventListener === 'function',
    'event-bus facade is always available (satellite modules attach once)');
  // satellite-module APIs
  assert.strictEqual(typeof RTData.toastQueued, 'function');
  assert.strictEqual(typeof RTData.toastQueuePush, 'function');
  assert.strictEqual(typeof RTData.notifySystem, 'function');
  assert.strictEqual(typeof RTData.handleP2pquake, 'function');
});

test('shiftTimeValue — epoch ms numbers and 13-digit strings', () => {
  const t0 = 1786270000000;
  assert.strictEqual(RTData.shiftTimeValue(t0, SHIFT), t0 + SHIFT);
  assert.strictEqual(RTData.shiftTimeValue(String(t0), SHIFT), String(t0 + SHIFT));
  assert.strictEqual(RTData.shiftTimeValue(999999999999, SHIFT), 999999999999, 'below 1e12 untouched');
  assert.strictEqual(RTData.shiftTimeValue(1e13, SHIFT), 1e13, 'above 1e13 untouched');
});

test('shiftTimeValue — Wolfx JST slash format keeps shape', () => {
  const out = RTData.shiftTimeValue('2026/08/09 19:25:40', SHIFT);
  assert.strictEqual(out, '2026/08/09 20:25:40');
  // day rollover stays correct (JST calendar, zero-padded)
  assert.strictEqual(RTData.shiftTimeValue('2026/08/09 23:59:58', 2 * SHIFT), '2026/08/10 01:59:58');
});

test('shiftTimeValue — ISO strings preserve their zone', () => {
  assert.strictEqual(RTData.shiftTimeValue('2026-08-09T10:25:40Z', SHIFT), '2026-08-09T11:25:40.000Z');
  const shifted = RTData.shiftTimeValue('2026-08-09T19:25:40+09:00', SHIFT);
  assert.strictEqual(shifted, '2026-08-09T20:25:40+09:00', 'kmoni dataTime keeps the +09:00 offset');
  assert.strictEqual(RTData.shiftTimeValue('2026-08-09T05:00:00-05:00', SHIFT), '2026-08-09T06:00:00-05:00');
});

test('shiftTimeValue — non-time strings pass through', () => {
  assert.strictEqual(RTData.shiftTimeValue('紀伊半島沖', SHIFT), '紀伊半島沖');
  assert.strictEqual(RTData.shiftTimeValue('2026-08-09 19:25:40', SHIFT), '2026-08-09 19:25:40', 'no-T, no-slash ISO-ish string untouched');
  assert.strictEqual(RTData.shiftTimeValue('7.1', SHIFT), '7.1');
});

test('shiftEventTimes — shifts *time* keys only, never replayTs, input not mutated', () => {
  const evt = {
    EventID: '20260809190000',
    OriginTime: '2026/08/09 19:00:00',
    AnnouncedTime: '2026/08/09 19:00:03',
    Magunitude: 7.1,
    Hypocenter: '紀伊半島沖',
    replayTs: 1786270000000
  };
  const out = RTData.shiftEventTimes('wolfx_eew', evt, SHIFT);
  assert.strictEqual(out.OriginTime, '2026/08/09 20:00:00');
  assert.strictEqual(out.AnnouncedTime, '2026/08/09 20:00:03');
  assert.strictEqual(out.replayTs, 1786270000000, 'replayTs keeps the original record time');
  assert.strictEqual(out.Magunitude, 7.1);
  assert.strictEqual(out.Hypocenter, '紀伊半島沖');
  assert.strictEqual(evt.OriginTime, '2026/08/09 19:00:00', 'original object untouched');
  // zero shift returns the same reference (cheap live-path pass-through)
  assert.strictEqual(RTData.shiftEventTimes('wolfx_eew', evt, 0), evt);
});

test('shiftEventTimes — kmoni frames (dataTime ISO) shift, intensity string untouched', () => {
  const evt = { dataTime: '2026-08-09T19:25:40+09:00', siteConfigId: 'abc', intensity: 'ddddd' };
  const out = RTData.shiftEventTimes('kmoni_rt', evt, SHIFT);
  assert.strictEqual(out.dataTime, '2026-08-09T20:25:40+09:00');
  assert.strictEqual(out.intensity, 'ddddd');
  assert.strictEqual(out.siteConfigId, 'abc');
});

test('shiftTimeValue — JST slash format without seconds (P2P 552 arrival times)', () => {
  assert.strictEqual(RTData.shiftTimeValue('2026/08/09 19:30', SHIFT), '2026/08/09 20:30:00');
  assert.strictEqual(RTData.shiftTimeValue('2026/08/09 23:59', 2 * SHIFT), '2026/08/10 01:59:00', 'day rollover');
});

test('shiftEventTimes — nested 552 tsunami first-wave arrival times shift', () => {
  const evt = {
    code: 552,
    time: '2026-08-09T10:10:00.000Z',
    tsunamiAreas: [
      { name: '岩手県', grade: 'MajorWarning',
        firstHeight: { arrivalTime: '2026/08/09 19:30' }, maxHeight: { description: '巨大' } },
      // firstHeight as a bare string is also a supported shape (rt-tsunami parser)
      { name: '宮城県', grade: 'Warning', firstHeight: '2026/08/09 19:40:00' },
      { name: '福島県', grade: 'Watch' } // no firstHeight at all — passes through
    ],
    replayTs: 1786270000000
  };
  const out = RTData.shiftEventTimes('p2pquake', evt, SHIFT);
  assert.strictEqual(out.tsunamiAreas[0].firstHeight.arrivalTime, '2026/08/09 20:30:00');
  assert.strictEqual(out.tsunamiAreas[1].firstHeight, '2026/08/09 20:40:00');
  assert.strictEqual(out.tsunamiAreas[2].firstHeight, undefined);
  assert.strictEqual(out.tsunamiAreas[0].maxHeight.description, '巨大', 'non-time nested fields untouched');
  assert.strictEqual(out.tsunamiAreas[0].name, '岩手県');
  assert.strictEqual(out.replayTs, 1786270000000, 'replayTs keeps the original record time');
  // originals (including the nested objects) are never mutated
  assert.strictEqual(evt.tsunamiAreas[0].firstHeight.arrivalTime, '2026/08/09 19:30');
  assert.strictEqual(evt.tsunamiAreas[1].firstHeight, '2026/08/09 19:40:00');
});

// ---------------------------------------------------------------------------
//  handleP2pquake — list-path junk filter (P2P 554 / hypocenter-less frames)
// ---------------------------------------------------------------------------

test('handleP2pquake — code 554 and hypocenter-less frames never reach the list', () => {
  RTData.resetState();
  // 554 = EEW detection-point bulletin (no earthquake block)
  RTData.handleP2pquake({ type: 'p2pquake', event: { id: 'p2pq_554', code: 554, mag: 0, lat: 0, lng: 0, time: '2026-08-09T10:00:00.000Z' } });
  assert.strictEqual(RTData.getData().length, 0, 'code 554 dropped');
  // any other hypocenter-less frame (e.g. 551 震度速報 before the hypocenter exists)
  RTData.handleP2pquake({ type: 'p2pquake', event: { id: 'p2pq_nohypo', code: 551, mag: 0, lat: 0, lng: 0, time: '2026-08-09T10:01:00.000Z' } });
  assert.strictEqual(RTData.getData().length, 0, 'mag 0 @(0,0) dropped');
  // a real event with a usable hypocenter lands in the list
  RTData.handleP2pquake({ type: 'p2pquake', event: { id: 'p2pq_ok', code: 551, mag: 5.2, lat: 35.5, lng: 140.2, depth: 40, place: '千葉県北西部', time: '2026-08-09T10:02:00.000Z' } });
  assert.strictEqual(RTData.getData().length, 1, 'valid event listed');
  assert.strictEqual(RTData.getData()[0].id, 'p2pq_ok');
  // tsunami bulletins (552) carry the parent quake hypocenter and must survive
  RTData.handleP2pquake({ type: 'p2pquake', event: { id: 'p2pq_tsu', code: 552, mag: 8.4, lat: 39.6, lng: 144.0, time: '2026-08-09T10:03:00.000Z', tsunamiAreas: [] } });
  assert.strictEqual(RTData.getData().length, 2, '552 with hypocenter is not filtered');
  RTData.resetState();
});

// ---------------------------------------------------------------------------
//  toastQueuePush — shared toast FIFO (cap 5, drop oldest, priority front)
// ---------------------------------------------------------------------------

test('toastQueuePush — FIFO cap drops the oldest; priority jumps the front', () => {
  const msgs = (q) => q.map((x) => x.msg);
  let q = [];
  for (let i = 1; i <= 5; i++) RTData.toastQueuePush(q, { msg: 'm' + i, ttl: 4000 }, 5, false);
  assert.deepStrictEqual(msgs(q), ['m1', 'm2', 'm3', 'm4', 'm5'], 'FIFO order up to the cap');
  RTData.toastQueuePush(q, { msg: 'm6', ttl: 4000 }, 5, false);
  assert.deepStrictEqual(msgs(q), ['m2', 'm3', 'm4', 'm5', 'm6'], 'over cap evicts the oldest pending entry');
  RTData.toastQueuePush(q, { msg: 'urgent', ttl: 4000 }, 5, true);
  assert.deepStrictEqual(msgs(q), ['urgent', 'm2', 'm3', 'm4', 'm5'],
    'priority unshifts to the front and never evicts itself');
});

test('fmtJstHm — JST HH:mm regardless of the host timezone', () => {
  assert.strictEqual(typeof RTData.fmtJstHm, 'function');
  assert.strictEqual(RTData.fmtJstHm(Date.UTC(2026, 7, 9, 15, 4)), '00:04', 'UTC 15:04 rolls to JST 00:04 the next day');
  assert.strictEqual(RTData.fmtJstHm(Date.UTC(2026, 7, 12, 3, 45)), '12:45');
  assert.strictEqual(RTData.fmtJstHm(Date.UTC(2026, 7, 12, 0, 0)), '09:00');
});

test('computeReplayClock — replay position = from + wall-elapsed × speed', () => {
  assert.strictEqual(typeof RTData.computeReplayClock, 'function');
  const from = 1786500000000, wall = 1786510000000;
  assert.strictEqual(RTData.computeReplayClock(from, wall, 5, wall + 10000), from + 50000);
  assert.strictEqual(RTData.computeReplayClock(from, wall, 1, wall), from, 'no elapsed wall time → the start itself');
  assert.strictEqual(RTData.computeReplayClock(from, wall, 60, wall + 1000), from + 60000);
});

test('replay timeline refresh is a safe no-op without a DOM', () => {
  assert.strictEqual(typeof RTData.refreshReplayTimeline, 'function');
  assert.strictEqual(typeof RTData.fetchReplayTimeline, 'function');
  // must not throw under node (document is undefined)
  RTData.refreshReplayTimeline({ frames: 5, earliest: 1, latest: 2, events: [] });
});

// ---------------------------------------------------------------------------
//  shouldReviseAutoSim — EEW 続報 revision thresholds
//  (|ΔM| ≥ 0.2, epicenter move ≥ 30 km haversine, |Δdepth| ≥ 20 km)
// ---------------------------------------------------------------------------

test('shouldReviseAutoSim — exported and identical params never revise', () => {
  assert.strictEqual(typeof RTData.shouldReviseAutoSim, 'function');
  const base = { mag: 6.8, lat: 35.0, lng: 140.0, depth: 40 };
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lat: 35.0, lng: 140.0, depth: 40 }), false);
  // small drift below every threshold
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.9, lat: 35.1, lng: 140.1, depth: 50 }), false,
    '+0.1 M, ~14 km, +10 km depth all below thresholds');
});

test('shouldReviseAutoSim — magnitude threshold, exact boundary counts (both directions)', () => {
  const base = { mag: 6.8, lat: 35.0, lng: 140.0, depth: 40 };
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 7.0, lat: 35.0, lng: 140.0, depth: 40 }), true,
    'exactly +0.2 (upward revision)');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.6, lat: 35.0, lng: 140.0, depth: 40 }), true,
    'exactly -0.2 (downward revision counts too)');
  assert.strictEqual(RTData.shouldReviseAutoSim({ mag: 7.0, lat: 35.0, lng: 140.0, depth: 40 }, base), true,
    'reversed argument order is symmetric');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.7, lat: 35.0, lng: 140.0, depth: 40 }), false,
    '-0.1 stays below the threshold');
});

test('shouldReviseAutoSim — depth threshold, exact boundary counts (both directions)', () => {
  const shallow = { mag: 6.8, lat: 35.0, lng: 140.0, depth: 40 };
  assert.strictEqual(RTData.shouldReviseAutoSim(shallow, { mag: 6.8, lat: 35.0, lng: 140.0, depth: 60 }), true,
    'exactly +20 km');
  assert.strictEqual(RTData.shouldReviseAutoSim({ mag: 6.8, lat: 35.0, lng: 140.0, depth: 60 }, shallow), true,
    'exactly -20 km (shallowing revision)');
  assert.strictEqual(RTData.shouldReviseAutoSim(shallow, { mag: 6.8, lat: 35.0, lng: 140.0, depth: 59 }), false,
    '+19 km stays below the threshold');
});

test('shouldReviseAutoSim — epicenter move threshold (30 km haversine)', () => {
  const base = { mag: 6.8, lat: 35.0, lng: 140.0, depth: 40 };
  // latitude offset that is exactly 30 km on the R=6371 haversine
  const deg30 = 30 * 180 / (Math.PI * 6371);
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lat: 35.0 + deg30, lng: 140.0, depth: 40 }), true,
    'exactly 30 km north counts');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lat: 35.0 - deg30 * 1.2, lng: 140.0, depth: 40 }), true,
    '~36 km south (direction does not matter)');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lat: 35.0 + deg30 * 0.8, lng: 140.0, depth: 40 }), false,
    '~24 km stays below the threshold');
  // longitude degrees shrink with latitude: at 35°N 1° lng ≈ 91.1 km
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lat: 35.0, lng: 140.3, depth: 40 }), false,
    '0.3° lng at 35°N ≈ 27 km — below');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lat: 35.0, lng: 140.4, depth: 40 }), true,
    '0.4° lng at 35°N ≈ 36 km — above');
});

test('shouldReviseAutoSim — missing or invalid fields always return false', () => {
  const base = { mag: 6.8, lat: 35.0, lng: 140.0, depth: 40 };
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 7.4, lat: 35.0, lng: 140.0 }), false,
    'missing next.depth → false even with a huge magnitude jump');
  assert.strictEqual(RTData.shouldReviseAutoSim({ lat: 35.0, lng: 140.0, depth: 40 }, base), false,
    'missing prev.mag → false');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: 6.8, lng: 140.0, depth: 40 }), false,
    'missing next.lat → false');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, { mag: NaN, lat: 35.0, lng: 140.0, depth: 40 }), false,
    'NaN magnitude → false');
  assert.strictEqual(RTData.shouldReviseAutoSim(base, null), false);
  assert.strictEqual(RTData.shouldReviseAutoSim(null, base), false);
  assert.strictEqual(RTData.shouldReviseAutoSim(undefined, undefined), false);
});

test('normalizeUSGS — live-feed properties.source maps to the issuing agency', () => {
  const mk = (src) => ({ type: 'Feature', id: 'live-1',
    geometry: { type: 'Point', coordinates: [140.1, 36.2, 30] },
    properties: { mag: 5.1, place: 'X', time: 1786270000000, source: src } });
  assert.strictEqual(RTData.normalizeUSGS(mk('WOLFX_EQ')).source, 'JMA');
  assert.strictEqual(RTData.normalizeUSGS(mk('WOLFX_CENC')).source, 'CENC');
  assert.strictEqual(RTData.normalizeUSGS(mk('P2PQUAKE')).source, 'JMA');
  assert.strictEqual(RTData.normalizeUSGS(mk('WOLFX_CWA')).source, 'CWA');
  assert.strictEqual(RTData.normalizeUSGS(mk('GEOFON')).source, 'GEOFON', 'unknown ids pass through upper-cased');
  const plain = { type: 'Feature', id: 'us7000x', geometry: { type: 'Point', coordinates: [140.1, 36.2, 30] },
    properties: { mag: 5.1, place: 'X', time: 1786270000000 } };
  assert.strictEqual(RTData.normalizeUSGS(plain).source, 'USGS', 'plain USGS features stay USGS');
});

test('bulletinSoundFor — JMA/CENC get their own chimes, P2P/EEW stay silent', () => {
  assert.strictEqual(RTData.bulletinSoundFor('JMA'), 'Bulletin_JMA');
  assert.strictEqual(RTData.bulletinSoundFor('CENC'), 'Bulletin_CENC');
  assert.strictEqual(RTData.bulletinSoundFor('USGS'), 'Bulletin_Other');
  assert.strictEqual(RTData.bulletinSoundFor('EMSC'), 'Bulletin_Other');
  assert.strictEqual(RTData.bulletinSoundFor('P2P'), null, '551 bulletins already sound via rt-quakeinfo');
  assert.strictEqual(RTData.bulletinSoundFor('Wolfx'), null, 'EEW reports have their own sound set');
  assert.strictEqual(RTData.bulletinSoundFor(''), 'Bulletin_Other');
});

test('isFreshBulletin — only items inside the freshness window chime', () => {
  const now = 1786270000000;
  const item = (minAgo) => ({ time: new Date(now - minAgo * 60000).toISOString() });
  assert.strictEqual(RTData.isFreshBulletin(item(2), now), true);
  assert.strictEqual(RTData.isFreshBulletin(item(14.9), now), true);
  assert.strictEqual(RTData.isFreshBulletin(item(15.1), now), false, 'backlog older than 15 min stays silent');
  assert.strictEqual(RTData.isFreshBulletin(item(-5), now), false, 'future timestamps never chime');
  assert.strictEqual(RTData.isFreshBulletin({ time: 'garbage' }, now), false);
  assert.strictEqual(RTData.isFreshBulletin(null, now), false);
});
