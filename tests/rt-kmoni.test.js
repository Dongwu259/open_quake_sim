// ================================================================
//  Unit tests for RTKmoni — NIED kmoni realtime layer pure helpers
//  Run with:  node --test tests/rt-kmoni.test.js
//  (no DOM / Leaflet required — module must load cleanly under node)
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../public/rt-kmoni.js');

// ================================================================
//  NODE SAFETY / MODULE SHAPE
// ================================================================

test('module loads under node without DOM/Leaflet and start() is a safe no-op', () => {
  assert.ok(K, 'module should export');
  assert.strictEqual(typeof K.start, 'function');
  assert.strictEqual(K.isActive(), false);
  assert.strictEqual(K.start(), false, 'start() must no-op without window/fetch');
  assert.strictEqual(K.isActive(), false);
  K.stop(); // must not throw on fresh state
  const s = K.getState();
  assert.deepStrictEqual(Object.keys(s).sort(),
    ['activeCount', 'activeLat', 'activeLng', 'fallback', 'hideNoData', 'lastDataTime', 'officialImg', 'periodMaxLevel', 'sensitivity', 'showShindo0', 'stationCount', 'top']);
  assert.strictEqual(s.stationCount, 0);
  assert.strictEqual(s.fallback, false);
  assert.strictEqual(s.periodMaxLevel, 0);
  assert.strictEqual(s.activeCount, 0);
  assert.strictEqual(s.lastDataTime, null);
  assert.strictEqual(s.sensitivity, '2', 'default sensitivity is medium');
  assert.strictEqual(s.hideNoData, false, 'hide-no-data defaults off');
  assert.strictEqual(s.showShindo0, true, 'shindo-0 icons default on');
  assert.strictEqual(s.officialImg, false, 'official image underlay defaults off');
});

// ================================================================
//  decodeIntensity
// ================================================================

test('decodeIntensity — basic levels (charCode - 100)', () => {
  const str = String.fromCharCode(100) + String.fromCharCode(107) + String.fromCharCode(120);
  const arr = K.decodeIntensity(str);
  assert.ok(arr instanceof Int16Array);
  assert.deepStrictEqual(Array.from(arr), [0, 7, 20]);
});

test('decodeIntensity — -1 and other negatives clamp to -1', () => {
  const str = String.fromCharCode(99) + String.fromCharCode(50) + String.fromCharCode(0);
  const arr = K.decodeIntensity(str);
  assert.deepStrictEqual(Array.from(arr), [-1, -1, -1]);
});

test('decodeIntensity — high chars clamp to 20', () => {
  const str = String.fromCharCode(121) + String.fromCharCode(200) + String.fromCharCode(65535);
  const arr = K.decodeIntensity(str);
  assert.deepStrictEqual(Array.from(arr), [20, 20, 20]);
});

test('decodeIntensity — empty / non-string input', () => {
  assert.strictEqual(K.decodeIntensity('').length, 0);
  assert.strictEqual(K.decodeIntensity(null).length, 0);
  assert.strictEqual(K.decodeIntensity(undefined).length, 0);
});

// ================================================================
//  levelToShindo
// ================================================================

test('levelToShindo — band edges 7/8, 9/10, 19/20 and extremes', () => {
  assert.strictEqual(K.levelToShindo(-1), '0');
  assert.strictEqual(K.levelToShindo(0), '0');
  assert.strictEqual(K.levelToShindo(7), '0');
  assert.strictEqual(K.levelToShindo(8), '1');
  assert.strictEqual(K.levelToShindo(9), '1');
  assert.strictEqual(K.levelToShindo(10), '2');
  assert.strictEqual(K.levelToShindo(11), '2');
  assert.strictEqual(K.levelToShindo(12), '3');
  assert.strictEqual(K.levelToShindo(13), '3');
  assert.strictEqual(K.levelToShindo(14), '4');
  assert.strictEqual(K.levelToShindo(15), '4');
  assert.strictEqual(K.levelToShindo(16), '5');
  assert.strictEqual(K.levelToShindo(17), '5');
  assert.strictEqual(K.levelToShindo(18), '6');
  assert.strictEqual(K.levelToShindo(19), '6');
  assert.strictEqual(K.levelToShindo(20), '7');
  assert.strictEqual(K.levelToShindo(25), '7');
});

// ================================================================
//  buildAdjacency
// ================================================================

// 10-station line, ~0.91 km spacing (0.01° lng at lat 35)
function denseLine() {
  const items = [];
  for (let i = 0; i < 10; i++) items.push([35.0, 139.0 + i * 0.01]);
  return items;
}

test('buildAdjacency — dense line: cap at 6 nearest, sorted by distance', () => {
  const adj = K.buildAdjacency(denseLine());
  assert.strictEqual(adj.length, 10);
  // interior station 4: six nearest are indices {1,2,3,5,6,7} (<= ~2.7 km)
  const nb4 = adj[4];
  assert.strictEqual(nb4.length, 6, 'should cap at maxN=6');
  assert.deepStrictEqual(nb4.slice().sort((a, b) => a - b), [1, 2, 3, 5, 6, 7]);
  // nearest first: the two ~0.91 km neighbors must lead
  assert.deepStrictEqual(nb4.slice(0, 2).sort((a, b) => a - b), [3, 5]);
  // endpoint 0: neighbors 1..6, nearest is 1
  assert.strictEqual(adj[0].length, 6);
  assert.strictEqual(adj[0][0], 1);
  // never includes self
  for (let i = 0; i < 10; i++) assert.ok(!adj[i].includes(i));
});

test('buildAdjacency — 30 km cutoff (medium line ~27.3 km spacing)', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push([35.0, 139.0 + i * 0.3]); // ~27.3 km
  const adj = K.buildAdjacency(items);
  // only 1-step neighbors fit (2 steps = ~54.7 km > 30)
  assert.deepStrictEqual(adj[0], [1]);
  assert.deepStrictEqual(adj[4].slice().sort((a, b) => a - b), [3, 5]);
  assert.deepStrictEqual(adj[9], [8]);
});

test('buildAdjacency — island fallback: <=1 neighbor within 30 km pulls nearest within 40 km', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push([35.0, 139.0 + i * 0.35]); // ~31.9 km
  const adj = K.buildAdjacency(items);
  // no station has a neighbor inside 30 km, but the 40 km fallback links
  // each to its nearest neighbor (~31.9 km away)
  for (let i = 0; i < 10; i++) assert.strictEqual(adj[i].length, 1, 'station ' + i);
  assert.deepStrictEqual(adj[0], [1]);
  assert.deepStrictEqual(adj[9], [8]);
});

test('buildAdjacency — beyond 40 km: truly isolated', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push([35.0, 139.0 + i * 0.5]); // ~45.6 km
  const adj = K.buildAdjacency(items);
  for (let i = 0; i < 10; i++) assert.strictEqual(adj[i].length, 0);
});

test('buildAdjacency — custom maxKm / maxN', () => {
  const adj = K.buildAdjacency(denseLine(), 1.0, 6);
  // only ~0.91 km step neighbors within 1.0 km
  assert.deepStrictEqual(adj[4].slice().sort((a, b) => a - b), [3, 5]);
  const adj2 = K.buildAdjacency(denseLine(), 30, 2);
  assert.strictEqual(adj2[4].length, 2, 'maxN=2 caps to nearest two');
  assert.deepStrictEqual(adj2[4].slice().sort((a, b) => a - b), [3, 5]);
});

// ================================================================
//  computeActivity
// ================================================================

test('computeActivity — constant spot-checks (kanameishi parity gating)', () => {
  // gate: nothing scores unless rising (ascend > 0) or already active
  assert.strictEqual(K.computeActivity(8, 0, false), 0, 'steady level, no ascend -> 0');
  assert.strictEqual(K.computeActivity(12, 0, false), 0);
  assert.strictEqual(K.computeActivity(6, 0, false), 0);
  assert.strictEqual(K.computeActivity(-1, 5, false), 0, 'no data -> 0');
  // ... but already-active stations keep a level term even without ascend
  assert.strictEqual(K.computeActivity(7, 0, true), 1,   'active level 7: 0.5*(7-5)');
  assert.strictEqual(K.computeActivity(10, 0, true), 6,  'active level 10: 2*(10-7)');
  // the ascend term counts even at low levels — the weak-shaking halo
  assert.strictEqual(K.computeActivity(4, 5, false), 7,  'level 4 rising 5: 2*(5-2)+1');
  assert.strictEqual(K.computeActivity(5, 3, false), 3,  'level 5 rising 3');
  // level 6-7 baseline 0.25*(level-5), x2 when already active
  assert.strictEqual(K.computeActivity(6, 1, false), 0.5);  // 0.25 + 0.25
  assert.strictEqual(K.computeActivity(7, 1, true), 1.5);   // 1 + 0.5
  // level 8-11: 2*(level-7)
  assert.strictEqual(K.computeActivity(8, 1, false), 2.25); // 2 + 0.25
  assert.strictEqual(K.computeActivity(10, 3, false), 9);   // 6 + (2*(3-2)+1)
  // level >= 12: 6*(level-10)
  assert.strictEqual(K.computeActivity(12, 1, false), 12.25);
  assert.strictEqual(K.computeActivity(15, 7, false), 42);  // 30 + 6*(7-5)
  // low level but already active: level term 0, ascend still counts
  assert.strictEqual(K.computeActivity(5, 3, true), 3);     // 2*(3-2)+1
  // ascend <= 1: +0.25 / +0.5
  assert.strictEqual(K.computeActivity(8, 1, true), 2.5);
  // ascend 2-6 band edge
  assert.strictEqual(K.computeActivity(8, 6, false), 2 + (2 * 4 + 1)); // 11
});

// ================================================================
//  detectActive
// ================================================================

function mkStations(defs) {
  return defs.map(function(d) {
    return { lat: d[0], lng: d[1], level: d[2], activity: d[3],
      ascend: d[4] === undefined ? 99 : d[4], isActive: !!d[5] };
  });
}

test('detectActive — quiet field: none active', () => {
  const items = denseLine();
  const defs = items.map(function(it) { return [it[0], it[1], 2, 0]; });
  const stations = mkStations(defs);
  const adj = K.buildAdjacency(items);
  assert.deepStrictEqual(K.detectActive(stations, adj), []);
});

test('detectActive — single spike rejected by neighbor count', () => {
  const items = [];
  for (let i = 0; i < 5; i++) items.push([35.0, 139.0 + i * 0.01]);
  const defs = items.map(function(it) { return [it[0], it[1], 2, 0]; });
  defs[2] = [items[2][0], items[2][1], 15, K.computeActivity(15, 8, false)]; // 48
  const stations = mkStations(defs);
  const adj = K.buildAdjacency(items);
  assert.deepStrictEqual(K.detectActive(stations, adj), [],
    'lone spike without active-ish neighbors must not activate');
});

test('detectActive — cluster of 4 rising stations chain-activates', () => {
  const items = [];
  for (let i = 0; i < 4; i++) items.push([35.0, 139.0 + i * 0.01]); // cluster, ~0.91 km
  for (let i = 0; i < 6; i++) items.push([40.0, 145.0 + i * 0.01]); // far quiet group
  const act = K.computeActivity(8, 2, false); // 3
  const defs = items.map(function(it, i) {
    return (i < 4) ? [it[0], it[1], 8, act] : [it[0], it[1], 2, 0];
  });
  const stations = mkStations(defs);
  const adj = K.buildAdjacency(items);
  // seed: 3 neighbors with data, all activity>0 -> near=3 >= med(3)=1.5;
  // pool = 3+3+3 (seed's own activity NOT pooled) + triangular(3)=6 = 15 >= ACT[3]=14
  // -> activates, BFS chains all 4
  assert.deepStrictEqual(K.detectActive(stations, adj), [0, 1, 2, 3]);
});

test('detectActive — weak pair below threshold, strong pair activates', () => {
  const items = [[35.0, 139.0], [35.0, 139.01]];
  // two level-8 risers: pool 3 + tri(1)=1 = 4 < ACT[1]=9 -> no
  let defs = items.map(function(it) { return [it[0], it[1], 8, K.computeActivity(8, 2, false)]; });
  let adj = K.buildAdjacency(items);
  assert.deepStrictEqual(K.detectActive(mkStations(defs), adj), []);
  // two level-12 risers: activity 15 each, pool 15 + 1 >= 9 -> yes
  defs = items.map(function(it) { return [it[0], it[1], 12, K.computeActivity(12, 3, false)]; });
  assert.deepStrictEqual(K.detectActive(mkStations(defs), adj), [0, 1]);
});

test('detectActive — barely-twitched neighbors (ascend <= 1) count half toward the quorum', () => {
  const items = [[35.0, 139.0], [35.0, 139.01], [35.0, 139.02]];
  // every station activity 6 but ascend 1: each counts only 0.5 toward the
  // quorum -> near = 1 < medium need (2+1)/2=1.5 -> rejected even though
  // the pool (6+6+tri(1)=13) would clear ACT[2]=12. Undiscounted (near=2)
  // this would activate.
  const defs = [
    [35.0, 139.0, 8, 6, 1],
    [35.0, 139.01, 8, 6, 1],
    [35.0, 139.02, 8, 6, 1]
  ];
  const adj = K.buildAdjacency(items);
  assert.deepStrictEqual(K.detectActive(mkStations(defs), adj, '2'), []);
});

test('detectActive — already-active station still rising re-chains without a quorum', () => {
  const items = [[35.0, 139.0], [35.0, 140.5]]; // ~137 km apart, no neighbors
  const defs = [
    [35.0, 139.0, 9, 2, 3, true],  // isActive and still ascending
    [35.0, 140.5, 2, 0]
  ];
  const adj = K.buildAdjacency(items);
  assert.deepStrictEqual(K.detectActive(mkStations(defs), adj, '2'), [0]);
  // same activity but NOT active and no neighbor support -> rejected
  defs[0] = [35.0, 139.0, 9, 2, 3, false];
  assert.deepStrictEqual(K.detectActive(mkStations(defs), adj, '2'), []);
});

test('detectActive — 4th+ neighbor beyond 15 km contributes half activity', () => {
  // star topology: hub + four spokes ~25 km N/S/E/W (spokes ~35 km apart,
  // outside each other's 30 km adjacency), everyone has activity 1.3
  const items = [
    [35.0, 139.0],
    [35.225, 139.0], [34.775, 139.0],
    [35.0, 139.275], [35.0, 138.725]
  ];
  const defs = items.map(function(it) { return [it[0], it[1], 8, 1.3, 5]; });
  const adj = K.buildAdjacency(items);
  // hub seed: near=4 >= med(4)=2; decayed pool = 1.3*3 + 1.3/2 (4th
  // with-data neighbor at ~25 km > 15 km) = 4.55 + tri(4)=10 -> 14.55
  // < ACT[4]=15 -> rejected. Without the distance decay the pool would be
  // 5.2 + 10 = 15.2 >= 15 and the whole star would chain-activate.
  // A spoke seed never passes: its pool is far below ACT[1..2].
  assert.deepStrictEqual(K.detectActive(mkStations(defs), adj, '2'), []);
});

// ================================================================
//  nextPeriodState (period max + 60 s quiet reset)
// ================================================================

test('nextPeriodState — rise, band-cross notify, and quiet reset', () => {
  let ps = K.freshPeriod();
  ps = K.nextPeriodState(ps, 7, 2, 1000);
  assert.strictEqual(ps.max, 7);
  assert.strictEqual(ps.notify, -1, 'below level 8 -> no feedback');

  ps = K.nextPeriodState(ps, 9, 2, 2000);
  assert.strictEqual(ps.max, 9);
  assert.strictEqual(ps.band, 1);
  assert.strictEqual(ps.notify, 1, 'crossing into shindo 1 band notifies');

  ps = K.nextPeriodState(ps, 9, 2, 3000);
  assert.strictEqual(ps.notify, -1, 'same band -> no repeat notify');

  ps = K.nextPeriodState(ps, 14, 2, 4000);
  assert.strictEqual(ps.notify, 4, 'rising into shindo 4 band notifies');

  ps = K.nextPeriodState(ps, -1, 0, 4000 + 30000);
  assert.strictEqual(ps.max, 14, '30 s quiet: period max retained');

  ps = K.nextPeriodState(ps, -1, 0, 4000 + 61001);
  assert.strictEqual(ps.max, 0, 'over 60 s quiet: period max resets');
  assert.strictEqual(ps.band, 0);

  ps = K.nextPeriodState(ps, 8, 1, 4000 + 62002);
  assert.strictEqual(ps.notify, 1, 'after reset a new episode notifies again');
});

// ================================================================
//  sensitivityThresholds (detection sensitivity presets)
// ================================================================

test('sensitivityThresholds — mode math and ACT offsets (kanameishi parity)', () => {
  const hi = K.sensitivityThresholds('3');
  assert.strictEqual(hi.actOffset, -2);
  assert.strictEqual(hi.numThres(6), 3, 'high: half the with-data neighbors');
  assert.strictEqual(hi.numThres(5), 2.5);
  assert.strictEqual(hi.numThres(2), 1);
  assert.strictEqual(hi.numThres(1), 0.5);
  assert.strictEqual(hi.numThres(0), 0);

  const med = K.sensitivityThresholds('2');
  assert.strictEqual(med.actOffset, 0, 'medium: no ACT offset (current behavior)');
  assert.strictEqual(med.numThres(3), 1.5);
  assert.strictEqual(med.numThres(4), 2);
  assert.strictEqual(med.numThres(2), 1.5, 'medium: (w+1)/2 when w <= 2');
  assert.strictEqual(med.numThres(1), 1);
  assert.strictEqual(med.numThres(0), 0.5);

  const lo = K.sensitivityThresholds('1');
  assert.strictEqual(lo.actOffset, 2);
  assert.strictEqual(lo.numThres(6), 3, 'low: fixed 3-neighbor quorum');
  assert.strictEqual(lo.numThres(1), 3);
  assert.strictEqual(lo.numThres(0), 3);

  // unknown / omitted mode falls back to medium
  const d1 = K.sensitivityThresholds('x');
  assert.strictEqual(d1.actOffset, 0);
  assert.strictEqual(d1.numThres(3), 1.5);
  const d2 = K.sensitivityThresholds();
  assert.strictEqual(d2.actOffset, 0);
  assert.strictEqual(d2.numThres(3), 1.5);
});

// ================================================================
//  detectActive — sensitivity mode
// ================================================================

test('detectActive — 3-station cluster: medium rejects, high accepts', () => {
  const items = [[35.0, 139.0], [35.0, 139.01], [35.0, 139.02]]; // ~0.91 km steps
  // activity 3.5 each: pool 3.5+3.5 + triangular(2)=3 -> 10
  const defs = items.map(function(it) { return [it[0], it[1], 8, 3.5]; });
  const stations = mkStations(defs);
  const adj = K.buildAdjacency(items);
  // medium: need (2+1)/2=1.5 ok, but 10 < ACT[2]=12 -> rejected
  assert.deepStrictEqual(K.detectActive(stations, adj, '2'), []);
  // high: need 2/2=1, thr 12-2=10 -> 10 >= 10 -> chain of 3
  assert.deepStrictEqual(K.detectActive(stations, adj, '3'), [0, 1, 2]);
  // omitted mode -> live default medium (no DOM / setter state under node)
  assert.deepStrictEqual(K.detectActive(stations, adj), []);
});

test('detectActive — strong pair: medium accepts, low rejects (fixed quorum 3)', () => {
  const items = [[35.0, 139.0], [35.0, 139.01]];
  // two level-12 risers, activity 15 each: sum 30 + triangular(1)=1 = 31
  const defs = items.map(function(it) { return [it[0], it[1], 12, 15]; });
  const stations = mkStations(defs);
  const adj = K.buildAdjacency(items);
  // medium: need 1, thr ACT[1]=9 -> activates
  assert.deepStrictEqual(K.detectActive(stations, adj, '2'), [0, 1]);
  // low: fixed quorum 3 > near=1 -> rejected regardless of activity
  assert.deepStrictEqual(K.detectActive(stations, adj, '1'), []);
});

// ================================================================
//  markerStyle — hide-no-data composition
// ================================================================

test('markerStyle — level -1: zero opacity when hidden, gray 0.4 otherwise', () => {
  const on = K.markerStyle(-1, 2, true);
  assert.strictEqual(on.opacity, 0);
  assert.strictEqual(on.fillOpacity, 0);
  const off = K.markerStyle(-1, 2, false);
  assert.strictEqual(off.opacity, 0.4);
  assert.strictEqual(off.fillOpacity, 0.4);
  assert.strictEqual(off.color, '#cfcfcf');
  const dflt = K.markerStyle(-1, 2);
  assert.strictEqual(dflt.opacity, 0.4, 'hidden omitted -> legacy gray style');
  // stations with data are solid official-ramp dots (never hidden by the flag)
  const d8 = K.markerStyle(8, 2, true);
  assert.strictEqual(d8.opacity, 1);
  assert.strictEqual(d8.fillOpacity, 1);
  assert.strictEqual(d8.weight, 0);
  assert.strictEqual(d8.fillColor, '#9dfe17', 'NIED ramp level 8');
  const d0 = K.markerStyle(0, 2);
  assert.strictEqual(d0.fillColor, '#0003cf', 'NIED ramp level 0 is blue');
});

// ================================================================
//  markerKindFor / iconSizeForZoom (shindo-number icons, kanameishi curve)
// ================================================================

test('markerKindFor — zoom >= 4 AND level >= 8 -> icon; level 6-7 with shindo0 on', () => {
  assert.strictEqual(K.markerKindFor(3, 20, true), 'dot', 'below zoom 4 always dot');
  assert.strictEqual(K.markerKindFor(4, 8, false), 'icon', 'zoom 4 + shindo 1 -> icon');
  assert.strictEqual(K.markerKindFor(4, 8, true), 'icon');
  assert.strictEqual(K.markerKindFor(4, 7, false), 'dot', 'level 6-7 needs the shindo-0 flag');
  assert.strictEqual(K.markerKindFor(4, 6, true), 'icon', 'shindo-0 flag shows level 6-7');
  assert.strictEqual(K.markerKindFor(4, 5, true), 'dot', 'below level 6 always dot');
  assert.strictEqual(K.markerKindFor(12, 20, false), 'icon');
  assert.strictEqual(K.markerKindFor(4, -1, true), 'dot', 'no-data never an icon');
  // omitted flag -> live setting; node default is shindo-0 ON
  assert.strictEqual(K.markerKindFor(4, 6), 'icon');
});

test('iconSizeForZoom — 16 px at zoom 6, x1.5 per two zooms, zoom clamped 6..10', () => {
  assert.strictEqual(K.iconSizeForZoom(6), 16);
  assert.strictEqual(K.iconSizeForZoom(7), 20);
  assert.strictEqual(K.iconSizeForZoom(8), 24);
  assert.strictEqual(K.iconSizeForZoom(9), 29);
  assert.strictEqual(K.iconSizeForZoom(10), 36);
  assert.strictEqual(K.iconSizeForZoom(12), 36, 'clamped high');
  assert.strictEqual(K.iconSizeForZoom(4), 16, 'clamped low');
});

// ================================================================
//  setSensitivity / setHideNoData (node-safe setters + getState fields)
// ================================================================

test('setSensitivity / setHideNoData / setShowShindo0 — reflected in getState, invalid ignored', () => {
  K.setSensitivity('3');
  assert.strictEqual(K.getState().sensitivity, '3');
  K.setSensitivity('1');
  assert.strictEqual(K.getState().sensitivity, '1');
  K.setSensitivity('9');
  assert.strictEqual(K.getState().sensitivity, '1', 'invalid mode ignored');
  K.setHideNoData(true);
  assert.strictEqual(K.getState().hideNoData, true);
  K.setHideNoData(false);
  assert.strictEqual(K.getState().hideNoData, false);
  K.setShowShindo0(false);
  assert.strictEqual(K.getState().showShindo0, false);
  assert.strictEqual(K.markerKindFor(4, 6), 'dot', 'live flag off hides level 6-7 icons');
  K.setShowShindo0(true);
  assert.strictEqual(K.getState().showShindo0, true);
  K.setSensitivity('2'); // restore default so later detection tests stay medium
});


// ================================================================
//  realActivityInLevels — demo abort watcher (single-spike tolerant)
// ================================================================

test('realActivityInLevels — quiet network does not abort', () => {
  const levels = new Int16Array(1725).fill(4);
  assert.strictEqual(K.realActivityInLevels(levels), false, 'uniform quiet');
  levels[100] = 8; levels[500] = 9; // isolated single-station blips
  assert.strictEqual(K.realActivityInLevels(levels), false, 'two level-8/9 blips are noise');
  levels[200] = 8; levels[201] = 8; levels[202] = 8; // 5 total >= 8
  assert.strictEqual(K.realActivityInLevels(levels), true, 'network-wide shindo-1 rise aborts');
});

test('realActivityInLevels — shindo-2 band station aborts immediately', () => {
  const levels = new Int16Array(1725).fill(3);
  levels[42] = 11;
  assert.strictEqual(K.realActivityInLevels(levels), true);
  const calm = new Int16Array(1725).fill(3);
  calm[42] = 10;
  assert.strictEqual(K.realActivityInLevels(calm), false, 'single level-10 stays below the abort bar');
});

test('demo abort handler registration is node-safe', () => {
  K.setDemoAbortHandler(() => {});
  K.setDemoAbortHandler(null); // clears without throwing
  assert.strictEqual(K.isDemoMode(), false);
});


// ================================================================
//  levelToShindoFine — 5-/5+/6-/6+ sub-band display labels
// ================================================================

test('levelToShindoFine — coarse bands match levelToShindo below 5', () => {
  for (let lv = -1; lv <= 15; lv++) {
    assert.strictEqual(K.levelToShindoFine(lv), K.levelToShindo(lv), 'level ' + lv);
  }
});

test('levelToShindoFine — sub-bands at the top end', () => {
  assert.strictEqual(K.levelToShindoFine(16), '5-');
  assert.strictEqual(K.levelToShindoFine(17), '5+');
  assert.strictEqual(K.levelToShindoFine(18), '6-');
  assert.strictEqual(K.levelToShindoFine(19), '6+');
  assert.strictEqual(K.levelToShindoFine(20), '7');
  // coarse band compatibility: fine label's number equals the coarse band
  for (let lv = 16; lv <= 20; lv++) {
    assert.strictEqual(K.levelToShindoFine(lv).charAt(0), K.levelToShindo(lv), 'level ' + lv);
  }
});


// ================================================================
//  stationPopupHtml — per-station click detail
// ================================================================

test('stationPopupHtml — shows fine shindo, realtime intensity, sparkline', () => {
  const st = {
    lat: 35.3, lng: 136.8, level: 16,
    recentLevel: [16, 15, 14, 12, 8, 4, 4]
  };
  const html = K.stationPopupHtml(st, 41);
  assert.ok(html.indexOf('#42') >= 0, 'station index is 1-based');
  assert.ok(html.indexOf('5-') >= 0, 'fine shindo label');
  assert.ok(html.indexOf('1.6') >= 0, 'realtime intensity = level/10');
  assert.ok(html.indexOf('<polyline') >= 0, 'sparkline present');
  assert.ok(html.indexOf('直近7秒') >= 0, 'window label');
});

test('stationPopupHtml — no-data station degrades cleanly', () => {
  const html = K.stationPopupHtml({ lat: 35.0, lng: 136.0, level: -1, recentLevel: [] }, 0);
  assert.ok(html.indexOf('—') >= 0);
  assert.ok(html.indexOf('<polyline') < 0, 'no sparkline without history');
});

// ================================================================
//  topStations — strongest-stations ranking (panel data source)
// ================================================================

test('topStations — sorted desc, index tie-break, no-data/malformed excluded, n cap', () => {
  const states = [
    { lat: 35.0, lng: 139.0, level: 8 },
    { lat: 35.1, lng: 139.1, level: -1 },   // no data -> excluded
    { lat: 35.2, lng: 139.2, level: 15 },
    { lat: 35.3, lng: 139.3, level: 15 },   // tie with idx 2 -> lower idx first
    { lat: 35.4, lng: 139.4, level: 20 },
    null,                                    // malformed -> excluded
    { lat: 35.6, lng: 139.6, level: NaN }    // non-finite -> excluded
  ];
  const top = K.topStations(states, 8);
  assert.deepStrictEqual(top.map(e => e.idx), [4, 2, 3, 0]);
  assert.strictEqual(top[0].level, 20);
  assert.strictEqual(top[0].lat, 35.4, 'entries carry lat/lng for the flyTo');
  const top2 = K.topStations(states, 2);
  assert.deepStrictEqual(top2.map(e => e.idx), [4, 2], 'n caps the list');
  assert.deepStrictEqual(K.topStations(states, 0), [], 'n=0 -> empty');
  assert.deepStrictEqual(K.topStations([], 8), []);
  assert.deepStrictEqual(K.topStations(null, 8), []);
});

test('topStations — default n is 8', () => {
  const states = [];
  for (let i = 0; i < 12; i++) states.push({ lat: 35.0, lng: 139.0 + i * 0.01, level: i });
  const top = K.topStations(states);
  assert.strictEqual(top.length, 8, 'default cap');
  assert.strictEqual(top[0].level, 11, 'highest first');
  assert.strictEqual(top[7].level, 4, 'lowest kept');
});

// ================================================================
//  predictStationShindo / simVsObsRow — sim-vs-obs popup row
// ================================================================

test('predictStationShindo — null without Physics/epicenter; decays with distance', () => {
  // no Physics global -> null
  assert.strictEqual(K.predictStationShindo(35.0, 139.0, 7.0, 10, 'crustal'), null);
  globalThis.Physics = require('../public/physics.js');
  try {
    // Physics present but no epicenter global -> null
    assert.strictEqual(K.predictStationShindo(35.0, 139.0, 7.0, 10, 'crustal'), null);
    globalThis.epicenter = { lat: 35.0, lng: 139.0 };
    const near = K.predictStationShindo(35.05, 139.05, 7.0, 10, 'crustal');
    const far = K.predictStationShindo(36.5, 140.5, 7.0, 10, 'crustal');
    assert.ok(near && typeof near.intensity === 'number' && isFinite(near.intensity));
    assert.ok(near.intensity > far.intensity, 'intensity decays with distance');
    assert.ok(far.rKm > near.rKm, 'hypocentral distance grows with range');
    assert.ok(near.shindo !== undefined, 'shindo label attached');
    // invalid inputs -> null
    assert.strictEqual(K.predictStationShindo(35.0, 139.0, NaN, 10, 'crustal'), null);
    assert.strictEqual(K.predictStationShindo(35.0, 139.0, 7.0, -5, 'crustal'), null);
    assert.strictEqual(K.predictStationShindo('x', 139.0, 7.0, 10, 'crustal'), null);
    // null epicenter -> null
    globalThis.epicenter = null;
    assert.strictEqual(K.predictStationShindo(35.0, 139.0, 7.0, 10, 'crustal'), null);
  } finally {
    delete globalThis.Physics;
    delete globalThis.epicenter;
  }
});

test('simVsObsRow — prediction vs observation with signed diff', () => {
  const row = K.simVsObsRow({ rKm: 50, intensity: 3.24, shindo: 3 }, 12);
  assert.ok(row.indexOf('rt-kmoni-simobs') >= 0, 'row marker class');
  assert.ok(row.indexOf('3.2') >= 0, 'predicted intensity');
  assert.ok(row.indexOf('(3)') >= 0, 'shindo labels present');
  assert.ok(row.indexOf('1.2') >= 0, 'observed intensity = level/10');
  assert.ok(row.indexOf('+2.0') >= 0, 'signed diff (pred - obs)');
  const under = K.simVsObsRow({ rKm: 50, intensity: 1.5, shindo: 1 }, 19);
  assert.ok(under.indexOf('-0.4') >= 0, 'negative diff when observation is higher');
  assert.ok(under.indexOf('(6+)') >= 0, 'observed fine sub-band label shown');
  const noObs = K.simVsObsRow({ rKm: 50, intensity: 3.24, shindo: 3 }, -1);
  assert.ok(noObs.indexOf('—') >= 0, 'no-data observation degrades to dash');
  assert.ok(noObs.indexOf('差') < 0, 'diff omitted without observation');
  assert.strictEqual(K.simVsObsRow(null, 10), '');
  assert.strictEqual(K.simVsObsRow({ intensity: NaN }, 10), '');
});

test('stationPopupHtml — sim-vs-obs row only while a simulation runs', () => {
  const st = { lat: 35.3, lng: 136.8, level: 14, recentLevel: [] };
  assert.ok(K.stationPopupHtml(st, 0).indexOf('rt-kmoni-simobs') < 0,
    'no row without sim globals');
  globalThis.Physics = require('../public/physics.js');
  globalThis.isRunning = true;
  globalThis.epicenter = { lat: 35.0, lng: 139.0 };
  globalThis.eventMw = 7.0;
  globalThis.depthSlider = { value: '10' };
  try {
    const html = K.stationPopupHtml(st, 0);
    assert.ok(html.indexOf('rt-kmoni-simobs') >= 0, 'row present while sim runs');
    assert.ok(html.indexOf('予測') >= 0 && html.indexOf('実測') >= 0, 'pred/obs labels');
    assert.ok(html.indexOf('差') >= 0, 'diff label');
    // eventMw null falls back to magSlider.value
    globalThis.eventMw = null;
    globalThis.magSlider = { value: '6.5' };
    assert.ok(K.stationPopupHtml(st, 0).indexOf('rt-kmoni-simobs') >= 0,
      'magSlider fallback supplies the magnitude');
    // no-data station still gets the row (obs side degrades), sim off does not
    globalThis.isRunning = false;
    assert.ok(K.stationPopupHtml(st, 0).indexOf('rt-kmoni-simobs') < 0,
      'row hidden when the sim stops');
  } finally {
    delete globalThis.Physics;
    delete globalThis.isRunning;
    delete globalThis.epicenter;
    delete globalThis.eventMw;
    delete globalThis.depthSlider;
    delete globalThis.magSlider;
  }
  // after cleanup the row must be gone again
  assert.ok(K.stationPopupHtml(st, 0).indexOf('rt-kmoni-simobs') < 0);
});

// ================================================================
//  OFFICIAL IMAGE UNDERLAY (NIED RealTimeImg)
// ================================================================

test('officialImgUrl — cache-bust URL shape', () => {
  assert.strictEqual(K.officialImgUrl(1700000000000), '/api/kmoni/image?t=1700000000000');
  assert.ok(/^\/api\/kmoni\/image\?t=\d+$/.test(K.officialImgUrl()), 'defaults to Date.now()');
});

test('officialImgShouldDisable — 6 consecutive failures across sources trip the auto-off', () => {
  assert.strictEqual(K.officialImgShouldDisable(0), false);
  assert.strictEqual(K.officialImgShouldDisable(5), false);
  assert.strictEqual(K.officialImgShouldDisable(6), true);
  assert.strictEqual(K.officialImgShouldDisable(10), true);
});

test('officialImgJstStrings — JST wall clock independent of process TZ', () => {
  // UTC 2026-01-01 15:00:00 = JST 2026-01-02 00:00:00
  const ts = K.officialImgJstStrings(Date.UTC(2026, 0, 1, 15, 0, 0));
  assert.strictEqual(ts.date, '20260102');
  assert.strictEqual(ts.time, '20260102000000');
});

test('officialImgDirectUrl — NIED RealTimeImg path with publication delay', () => {
  // now = UTC 2026-01-02 00:00:10 -> minus 10 s delay -> JST 2026-01-02 09:00:00
  const now = Date.UTC(2026, 0, 2, 0, 0, 10);
  assert.strictEqual(K.officialImgDirectUrl(0, now),
    'https://www.kmoni.bosai.go.jp/new/data/map_img/RealTimeImg/jma_s/20260102/20260102090000.jma_s.gif');
  assert.strictEqual(K.officialImgDirectUrl(1, now),
    'https://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_s/20260102/20260102090000.jma_s.gif');
});

test('officialImgBounds — calibrated Japan extent, defensive copy', () => {
  const b = K.officialImgBounds();
  assert.strictEqual(b.length, 2);
  const s = b[0][0], w = b[0][1], n = b[1][0], e = b[1][1];
  assert.ok(s < n && w < e, 'south<north, west<east');
  // the grid must contain the mainland station network
  const spots = [[35.68, 139.69], [43.06, 141.35], [33.59, 130.40], [34.69, 135.50]];
  for (const [lat, lng] of spots) {
    assert.ok(lat > s && lat < n && lng > w && lng < e, 'contains ' + lat + ',' + lng);
  }
  // equirectangular 352x400 fit (RMS 0.68 px over 1122 mainland stations)
  assert.ok(Math.abs(s - 29.96) < 0.5 && Math.abs(n - 46.26) < 0.5, 'lat extent near the calibrated grid');
  assert.ok(Math.abs(w - 128.60) < 0.5 && Math.abs(e - 145.90) < 0.5, 'lng extent near the calibrated grid');
  b[0][0] = 0;
  assert.notStrictEqual(K.officialImgBounds()[0][0], 0, 'mutation must not leak into the constant');
});

test('setOfficialImg — node-safe, reflected in getState, restored off', () => {
  assert.strictEqual(K.getState().officialImg, false, 'underlay defaults off');
  K.setOfficialImg(true); // no DOM/Leaflet — must not throw
  assert.strictEqual(K.getState().officialImg, true);
  K.setOfficialImg(false);
  assert.strictEqual(K.getState().officialImg, false);
});

// ================================================================
//  KMONI_WORKER_V — one version constant for both worker URLs
// ================================================================

test('KMONI_WORKER_V — exported hex version shared by both worker URL constructions', () => {
  assert.ok(typeof K.KMONI_WORKER_V === 'string' && /^[0-9a-f]{6}$/.test(K.KMONI_WORKER_V),
    'content-hash style version');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'rt-kmoni.js'), 'utf8');
  const expr = "'rt-kmoni-worker.js?v=' + KMONI_WORKER_V";
  assert.strictEqual(src.split(expr).length - 1, 2,
    'core script injection and Worker construction must share the constant');
  assert.ok(!/rt-kmoni-worker\.js\?v=[0-9a-f]/.test(src),
    'no hardcoded worker version may remain');
});

// ================================================================
//  sseResumeNext / sseShouldResume — fallback -> SSE resume streak
// ================================================================

test('sseResumeNext / sseShouldResume — consecutive-frame streak with gap reset', () => {
  assert.strictEqual(K.sseResumeNext(0, 0, 1000), 1, 'first frame starts the streak at 1');
  assert.strictEqual(K.sseResumeNext(1, 1000, 2000), 2, 'close frames are consecutive');
  assert.strictEqual(K.sseResumeNext(1, 1000, 5000), 2, 'a gap exactly at the limit still counts');
  assert.strictEqual(K.sseResumeNext(1, 1000, 5001), 1, 'a wider gap restarts the streak');
  assert.strictEqual(K.sseResumeNext(7, 0, 500), 1, 'no previous frame -> restart at 1');
  assert.strictEqual(K.sseShouldResume(0), false);
  assert.strictEqual(K.sseShouldResume(1), false, 'a single stray frame must not switch back');
  assert.strictEqual(K.sseShouldResume(2), true);
  assert.strictEqual(K.sseShouldResume(5), true);
});

// ================================================================
//  sitelistRetryDelay — bounded backoff ladder
// ================================================================

test('sitelistRetryDelay — 5 s / 15 s / 60 s ladder, then null', () => {
  assert.strictEqual(K.sitelistRetryDelay(0), 5000);
  assert.strictEqual(K.sitelistRetryDelay(1), 15000);
  assert.strictEqual(K.sitelistRetryDelay(2), 60000);
  assert.strictEqual(K.sitelistRetryDelay(3), null, 'bounded — ladder exhausted');
  assert.strictEqual(K.sitelistRetryDelay(-1), null);
});

// ================================================================
//  TRANSPORT RIG — minimal browser-ish environment so the module's
//  start()/stop() state machine runs under node: mock window/fetch/
//  RTData (shared SSE source), a fake clock and capture-only timers
//  fired manually by the test.
// ================================================================

function installRig(hooks) {
  hooks = hooks || {};
  const SITELIST = [[35.0, 139.0], [35.01, 139.0], [35.02, 139.0]];
  const rig = {
    now: 1000000,
    timers: [],        // {id, fn, ms, iv, dead}
    _nextId: 1,
    listeners: {},     // SSE event name -> handler
    yahooFetches: 0,
    sitelistFetches: 0,
    levels: (n) => String.fromCharCode(100 + n).repeat(SITELIST.length)
  };
  const savedGlobals = {};
  for (const k of ['window', 'fetch', 'RTData']) {
    savedGlobals[k] = { had: k in globalThis, val: globalThis[k] };
  }
  const realNow = Date.now;
  const realST = global.setTimeout, realSI = global.setInterval;
  const realCT = global.clearTimeout, realCI = global.clearInterval;
  const realWarn = console.warn;

  globalThis.window = {};
  globalThis.fetch = function(url) {
    url = String(url);
    if (url.indexOf('RealTimeData') >= 0) {
      rig.yahooFetches++;
      if (hooks.onYahoo) return hooks.onYahoo(url, rig);
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve({ realTimeData: { intensity: rig.levels(0), dataTime: 'yahoo-' + rig.yahooFetches } }) });
    }
    rig.sitelistFetches++;
    if (hooks.onSitelist) return hooks.onSitelist(url, rig);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SITELIST.slice()) });
  };
  globalThis.RTData = {
    getP2PSource() {
      return {
        addEventListener(name, fn) { rig.listeners[name] = fn; },
        removeEventListener(name) { delete rig.listeners[name]; }
      };
    },
    isReplaying() { return false; }
  };
  console.warn = () => {}; // sitelist-failure warnings are expected in rig tests

  global.setTimeout = (fn, ms) => { const t = { id: rig._nextId++, fn, ms, iv: false, dead: false }; rig.timers.push(t); return t.id; };
  global.setInterval = (fn, ms) => { const t = { id: rig._nextId++, fn, ms, iv: true, dead: false }; rig.timers.push(t); return t.id; };
  const kill = (id) => { for (const t of rig.timers) if (t.id === id) t.dead = true; };
  global.clearTimeout = kill;
  global.clearInterval = kill;
  Date.now = () => rig.now;

  rig.flush = () => new Promise(r => realST(r, 0)); // drain the fetch promise chains
  rig.fireTimeout = (ms) => {
    for (const t of rig.timers.slice()) {
      if (!t.dead && !t.iv && t.ms === ms) { t.dead = true; t.fn(); }
    }
  };
  rig.fireInterval = (ms) => {
    for (const t of rig.timers.slice()) {
      if (!t.dead && t.iv && t.ms === ms) t.fn();
    }
  };
  rig.liveTimeouts = (ms) => rig.timers.filter(t => !t.dead && !t.iv && (ms === undefined || t.ms === ms)).length;
  rig.sse = (ev) => { if (rig.listeners.kmoni_rt) rig.listeners.kmoni_rt({ data: JSON.stringify(ev) }); };
  rig.restore = () => {
    Date.now = realNow;
    global.setTimeout = realST; global.setInterval = realSI;
    global.clearTimeout = realCT; global.clearInterval = realCI;
    console.warn = realWarn;
    for (const k of ['window', 'fetch', 'RTData']) {
      if (savedGlobals[k].had) globalThis[k] = savedGlobals[k].val;
      else delete globalThis[k];
    }
  };
  return rig;
}

// ================================================================
//  Fallback transport — reversible SSE <-> Yahoo switching
// ================================================================

test('fallback transport — 8 s SSE silence -> Yahoo polling -> 2 consecutive SSE frames resume', async () => {
  const rig = installRig();
  try {
    assert.strictEqual(K.start(), true);
    await rig.flush(); // sitelist + attachSSE
    assert.strictEqual(K.getState().stationCount, 3, 'sitelist loaded');
    assert.ok(rig.listeners.kmoni_rt, 'SSE kmoni_rt listener attached');
    // healthy SSE frame
    rig.sse({ intensity: rig.levels(0), dataTime: 'sse-1' });
    assert.strictEqual(K.getState().fallback, false);
    assert.strictEqual(K.getState().lastDataTime, 'sse-1');
    // SSE goes silent: +9 s and a watchdog tick switch to Yahoo polling
    rig.now += 9000;
    rig.fireInterval(1000);
    assert.strictEqual(K.getState().fallback, true, '8 s silence switches to Yahoo polling');
    await rig.flush(); // the immediate poll's fetch
    assert.strictEqual(rig.yahooFetches, 1, 'startFallback polls immediately');
    assert.strictEqual(K.getState().lastDataTime, 'yahoo-1', 'Yahoo path renders frames');
    // the 1 s fallback interval keeps polling
    rig.now += 1000;
    rig.fireInterval(1000); // watchdog + fallback poll
    await rig.flush();
    assert.strictEqual(rig.yahooFetches, 2);
    assert.strictEqual(K.getState().lastDataTime, 'yahoo-2');
    // one stray SSE frame: counted, transport unchanged, frame NOT processed
    rig.now += 1000;
    rig.sse({ intensity: rig.levels(0), dataTime: 'sse-stray' });
    assert.strictEqual(K.getState().fallback, true, 'a single stray frame must not switch back');
    assert.strictEqual(K.getState().lastDataTime, 'yahoo-2', 'counted frames are not processed');
    // a wide gap restarts the streak ...
    rig.now += 5000;
    rig.sse({ intensity: rig.levels(0), dataTime: 'sse-gap' });
    assert.strictEqual(K.getState().fallback, true, 'wide gap resets the streak (back to 1 of 2)');
    // ... so a further consecutive frame is still needed to resume
    rig.now += 1000;
    rig.sse({ intensity: rig.levels(0), dataTime: 'sse-resume' });
    assert.strictEqual(K.getState().fallback, false, 'second consecutive frame resumes SSE');
    assert.strictEqual(K.getState().lastDataTime, 'sse-resume', 'the resuming frame processes via SSE');
    // polling stopped and the watchdog does not flip back (lastFrameAt is fresh)
    rig.now += 1000;
    rig.fireInterval(1000);
    await rig.flush();
    assert.strictEqual(rig.yahooFetches, 2, 'Yahoo polling stopped after the resume');
    assert.strictEqual(K.getState().fallback, false, 'no flip-flop back to polling');
  } finally {
    K.stop();
    rig.restore();
  }
});

// ================================================================
//  Sitelist retry — bounded backoff + re-attempt on start()
// ================================================================

test('sitelist retry — failed loads re-attempt on the 5 s/15 s/60 s backoff ladder', async () => {
  let failFetches = 6; // three full attempts (same-origin API + Yahoo direct each)
  const rig = installRig({
    onSitelist() {
      if (failFetches-- > 0) return Promise.reject(new Error('boom'));
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve([[35.0, 139.0], [35.01, 139.0], [35.02, 139.0]]) });
    }
  });
  try {
    assert.strictEqual(K.start(), true);
    await rig.flush(); // attempt 1 fails, first retry scheduled
    assert.strictEqual(K.getState().stationCount, 0);
    assert.ok(rig.liveTimeouts(5000) >= 1, 'first retry after 5 s');
    rig.fireTimeout(5000);
    await rig.flush(); // attempt 2 fails
    assert.ok(rig.liveTimeouts(15000) >= 1, 'second retry after 15 s');
    rig.fireTimeout(15000);
    await rig.flush(); // attempt 3 fails
    assert.ok(rig.liveTimeouts(60000) >= 1, 'third retry after 60 s');
    rig.fireTimeout(60000);
    await rig.flush(); // attempt 4 succeeds
    assert.strictEqual(K.getState().stationCount, 3, 'a retry eventually loads the sitelist');
    assert.strictEqual(rig.liveTimeouts(), 0, 'no retry pending after success');
  } finally {
    K.stop();
    rig.restore();
  }
});

test('sitelist retry — ladder exhausts after 3 retries; start() re-attempts fresh', async () => {
  let down = true;
  const rig = installRig({
    onSitelist() {
      if (down) return Promise.reject(new Error('down'));
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve([[35.0, 139.0], [35.01, 139.0], [35.02, 139.0]]) });
    }
  });
  try {
    K.start();
    await rig.flush();
    rig.fireTimeout(5000); await rig.flush();
    rig.fireTimeout(15000); await rig.flush();
    rig.fireTimeout(60000); await rig.flush(); // 4th attempt fails -> ladder exhausted
    assert.strictEqual(K.getState().stationCount, 0);
    assert.strictEqual(rig.liveTimeouts(), 0, 'no further retry once the ladder is exhausted');
    // a later start() re-attempts from scratch while the list is missing
    K.stop();
    down = false;
    assert.strictEqual(K.start(), true);
    await rig.flush();
    assert.strictEqual(K.getState().stationCount, 3, 'start() re-attempts when the list is missing');
  } finally {
    K.stop();
    rig.restore();
  }
});

// ================================================================
//  toast — shared RTData.toastQueued contract with local fallback
// ================================================================

test('toast — delegates to RTData.toastQueued when available', () => {
  const calls = [];
  const had = 'RTData' in globalThis;
  const prev = globalThis.RTData;
  globalThis.RTData = { toastQueued: (msg, opts) => calls.push([msg, opts]) };
  try {
    K.toast('hello', { sticky: true });
    assert.deepStrictEqual(calls, [['hello', { sticky: true }]], 'message + opts passed through');
    K.toast('second');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1][1], undefined, 'opts is optional');
  } finally {
    if (had) globalThis.RTData = prev; else delete globalThis.RTData;
  }
});

test('toast — local fallback renders #rt-toast without a usable queue', () => {
  const appended = [];
  const hadDoc = 'document' in globalThis;
  const prevDoc = globalThis.document;
  const hadRT = 'RTData' in globalThis;
  const prevRT = globalThis.RTData;
  const realST = global.setTimeout;
  globalThis.document = {
    body: { appendChild: (el) => appended.push(el) },
    createElement: () => ({ id: '', style: {}, textContent: '' }),
    getElementById: () => null
  };
  global.setTimeout = () => 0; // capture-only: the 4 s fade timer must never fire
  try {
    delete globalThis.RTData; // rt-data.js absent -> local path
    K.toast('local msg');
    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0].id, 'rt-toast');
    assert.strictEqual(appended[0].textContent, 'local msg');
    globalThis.RTData = {}; // loaded but no toastQueued yet -> still local
    K.toast('local msg 2');
    assert.strictEqual(appended.length, 2);
    assert.strictEqual(appended[1].textContent, 'local msg 2');
    globalThis.RTData = { toastQueued: () => { throw new Error('x'); } }; // throwing queue -> local
    K.toast('still shown');
    assert.strictEqual(appended.length, 3);
    assert.strictEqual(appended[2].textContent, 'still shown');
  } finally {
    global.setTimeout = realST;
    if (hadDoc) globalThis.document = prevDoc; else delete globalThis.document;
    if (hadRT) globalThis.RTData = prevRT; else delete globalThis.RTData;
  }
});

test('activationSoundName — quiet→active transition cues sub-band-1 shaking only', () => {
  const t0 = 1786270000000;
  // the transition fires the Shindo0 cue
  assert.strictEqual(K.activationSoundName(0, 3, -1, 0, t0), 'Shindo0');
  // not a transition (already active / going quiet / no change)
  assert.strictEqual(K.activationSoundName(2, 3, -1, 0, t0), null);
  assert.strictEqual(K.activationSoundName(3, 0, -1, 0, t0), null);
  assert.strictEqual(K.activationSoundName(0, 0, -1, 0, t0), null);
  // band-cross feedback owns the frame — no double cue
  assert.strictEqual(K.activationSoundName(0, 5, 2, 0, t0), null);
  // 30 s cooldown
  assert.strictEqual(K.activationSoundName(0, 3, -1, t0 - 10000, t0), null);
  assert.strictEqual(K.activationSoundName(0, 3, -1, t0 - 30000, t0), 'Shindo0', 'cooldown over');
});

test('getState exposes the engine top-stations ranking for the EEW page', () => {
  const st = K.getState();
  assert.ok(st && Array.isArray(st.top), 'top is always an array');
  assert.strictEqual(typeof st.activeCount, 'number');
});
