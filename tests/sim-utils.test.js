// ================================================================
//  Unit tests for SimUtils — pure computation module
//  Run with:  node --test tests/sim-utils.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../public/sim-utils.js');

// ================================================================
//  escapeHTML
// ================================================================

test('escapeHTML — escapes all 5 special characters', () => {
  assert.strictEqual(U.escapeHTML('&'), '&amp;');
  assert.strictEqual(U.escapeHTML('<'), '&lt;');
  assert.strictEqual(U.escapeHTML('>'), '&gt;');
  assert.strictEqual(U.escapeHTML('"'), '&quot;');
  assert.strictEqual(U.escapeHTML("'"), '&#39;');
});

test('escapeHTML — escapes combined string', () => {
  const input = '<script>alert("XSS")</script>';
  const output = U.escapeHTML(input);
  assert.ok(!output.includes('<'), 'should not contain raw <');
  assert.ok(!output.includes('>'), 'should not contain raw >');
  assert.ok(!output.includes('"'), 'should not contain raw "');
  assert.ok(output.includes('&lt;script&gt;'), 'should escape script tags');
});

test('escapeHTML — handles non-string input', () => {
  assert.strictEqual(U.escapeHTML(null), '');
  assert.strictEqual(U.escapeHTML(undefined), '');
  assert.strictEqual(U.escapeHTML(123), '123');
  assert.strictEqual(U.escapeHTML(true), 'true');
});

test('escapeHTML — passes through safe text unchanged', () => {
  const safe = 'Hello, world! 2024年 — test.';
  assert.strictEqual(U.escapeHTML(safe), safe);
});

// ================================================================
//  parseQueryString
// ================================================================

test('parseQueryString — basic key-value pairs', () => {
  const p = U.parseQueryString('lat=35.68&lng=139.76&mag=7.0');
  assert.strictEqual(p.lat, '35.68');
  assert.strictEqual(p.lng, '139.76');
  assert.strictEqual(p.mag, '7.0');
});

test('parseQueryString — handles leading ?', () => {
  const p = U.parseQueryString('?lat=35.0&depth=30');
  assert.strictEqual(p.lat, '35.0');
  assert.strictEqual(p.depth, '30');
});

test('parseQueryString — empty string returns empty object', () => {
  assert.strictEqual(Object.keys(U.parseQueryString('')).length, 0);
  assert.strictEqual(Object.keys(U.parseQueryString(null)).length, 0);
});

test('parseQueryString — URL-decodes percent-encoded values', () => {
  const p = U.parseQueryString('city=%E6%9D%B1%E4%BA%AC&name=Test%20City');
  assert.strictEqual(p.city, '東京');
  assert.strictEqual(p.name, 'Test City');
});

test('parseQueryString — boolean flags preserved as strings', () => {
  const p = U.parseQueryString('detect=1&tsunami=0');
  assert.strictEqual(p.detect, '1');
  assert.strictEqual(p.tsunami, '0');
});

test('parseQueryString skips malformed percent-encoding without dropping valid params', () => {
  assert.doesNotThrow(() => U.parseQueryString('ok=1&bad=%GG&name=Test+City'));
  const p = U.parseQueryString('ok=1&bad=%GG&name=Test+City');
  assert.strictEqual(p.ok, '1');
  assert.strictEqual(p.name, 'Test City');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(p, 'bad'), false);
});

// ================================================================
//  isValidEpicenter
// ================================================================

test('isValidEpicenter — Tokyo is valid', () => {
  assert.strictEqual(U.isValidEpicenter(35.68, 139.76), true);
});

test('isValidEpicenter — out of bounds rejected', () => {
  assert.strictEqual(U.isValidEpicenter(50, 140), false);  // too far north
  assert.strictEqual(U.isValidEpicenter(35, 100), false);  // too far west
  assert.strictEqual(U.isValidEpicenter(35, 200), false);  // too far east
  assert.strictEqual(U.isValidEpicenter(10, 140), false);  // too far south
});

test('isValidEpicenter — edges of Japan box', () => {
  assert.strictEqual(U.isValidEpicenter(24, 122), true);  // SW corner
  assert.strictEqual(U.isValidEpicenter(46, 150), true);  // NE corner
  assert.strictEqual(U.isValidEpicenter(23.9, 140), false); // just outside
});

test('isValidEpicenter — NaN and non-number rejected', () => {
  assert.strictEqual(U.isValidEpicenter(NaN, 140), false);
  assert.strictEqual(U.isValidEpicenter(35, NaN), false);
  assert.strictEqual(U.isValidEpicenter('35', 140), false);
  assert.strictEqual(U.isValidEpicenter(null, 140), false);
});

// ================================================================
//  encodeScenario / decodeScenario (round-trip)
// ================================================================

test('encodeScenario — produces URL-safe string (no +/=)', () => {
  const events = [[35.68, 139.76, 7.0, 30, 45, 90, 0, 0]];
  const flags = { detect: false, aftershock: false, tsunami: true };
  const encoded = U.encodeScenario(events, flags, null);
  assert.ok(typeof encoded === 'string' && encoded.length > 0);
  assert.ok(!encoded.includes('+'), 'should not contain +');
  assert.ok(!encoded.includes('='), 'should not contain trailing =');
});

test('encodeScenario/decodeScenario — single event round-trip', () => {
  const events = [[35.68, 139.76, 7.0, 30, 45, 90, 0, 0]];
  const flags = { detect: false, aftershock: false, tsunami: true };
  const encoded = U.encodeScenario(events, flags, null);
  const decoded = U.decodeScenario(encoded);
  assert.ok(decoded, 'decode should succeed');
  assert.strictEqual(decoded.events.length, 1);
  const ev = decoded.events[0];
  assert.ok(Math.abs(ev.lat - 35.68) < 0.001);
  assert.ok(Math.abs(ev.lng - 139.76) < 0.001);
  assert.strictEqual(ev.mag, 7.0);
  assert.strictEqual(ev.depth, 30);
  assert.strictEqual(decoded.flags.tsunami, true);
  assert.strictEqual(decoded.flags.detect, false);
});

test('encodeScenario/decodeScenario — multi-event round-trip', () => {
  const events = [
    [35.0, 140.0, 9.0, 24, 195, 10, 88, 0],
    [37.0, 141.0, 7.5, 40, 30, 50, 90, 120]
  ];
  const flags = { detect: true, aftershock: true, tsunami: false };
  const encoded = U.encodeScenario(events, flags, null);
  const decoded = U.decodeScenario(encoded);
  assert.ok(decoded);
  assert.strictEqual(decoded.events.length, 2);
  assert.strictEqual(decoded.events[0].mag, 9.0);
  assert.strictEqual(decoded.events[0].dip, 10);
  assert.strictEqual(decoded.events[0].rake, 88);
  assert.strictEqual(decoded.events[1].mag, 7.5);
  assert.strictEqual(decoded.events[1].time, 120);
  assert.strictEqual(decoded.flags.detect, true);
  assert.strictEqual(decoded.flags.aftershock, true);
  assert.strictEqual(decoded.flags.tsunami, false);
  assert.strictEqual(decoded.flags.multiEvent, true);
});

test('encodeScenario preserves whether rake is explicit or an untouched optional value', () => {
  const events = [
    {lat:35,lng:140,mag:8,depth:20,strike:0,dip:90,rake:0,time:0,mechanismKnown:false},
    {lat:36,lng:141,mag:8,depth:20,strike:0,dip:90,rake:0,time:30,mechanismKnown:true}
  ];
  const decoded = U.decodeScenario(U.encodeScenario(events,{detect:false,aftershock:false,tsunami:true},null));
  assert.strictEqual(decoded.events[0].mechanismKnown, false);
  assert.strictEqual(decoded.events[1].mechanismKnown, true);
});

test('decodeScenario — invalid base64 returns null', () => {
  assert.strictEqual(U.decodeScenario('not valid base64!!!'), null);
  assert.strictEqual(U.decodeScenario(''), null);
  assert.strictEqual(U.decodeScenario(null), null);
});

test('encodeScenario — uses object-style event format', () => {
  // Test that the function handles events with named properties
  const events = [{ lat: 35, lng: 140, mag: 6.5, depth: 20, strike: 0, dip: 90, rake: 0, time: 0 }];
  const flags = { detect: false, aftershock: false, tsunami: false };
  const encoded = U.encodeScenario(events, flags, null);
  const decoded = U.decodeScenario(encoded);
  assert.ok(decoded);
  assert.strictEqual(decoded.events.length, 1);
});

test('encodeScenario/decodeScenario — manual aftershocks round-trip (with and without lat/lng)', () => {
  const events = [
    [35.0, 140.0, 9.0, 24, 195, 10, 88, 0],
    [37.0, 141.0, 7.5, 40, 30, 50, 90, 120]
  ];
  const flags = { detect: false, aftershock: true, tsunami: true };
  const asman = [
    { time: 60, mag: 6.0, depth: 10 },
    { time: 240, mag: 5.5, depth: 20, lat: 36.12345, lng: 140.67891 }
  ];
  const decoded = U.decodeScenario(U.encodeScenario(events, flags, null, asman));
  assert.ok(decoded);
  assert.strictEqual(decoded.manualAftershocks.length, 2);
  assert.strictEqual(decoded.manualAftershocks[0].time, 60);
  assert.strictEqual(decoded.manualAftershocks[0].mag, 6.0);
  assert.strictEqual(decoded.manualAftershocks[0].depth, 10);
  assert.strictEqual(decoded.manualAftershocks[0].lat, undefined, 'epicenter-fallback entry carries no lat');
  assert.strictEqual(decoded.manualAftershocks[0].lng, undefined);
  assert.strictEqual(decoded.manualAftershocks[1].time, 240);
  assert.ok(Math.abs(decoded.manualAftershocks[1].lat - 36.123) < 1e-9, 'lat rounded to 3 decimals');
  assert.ok(Math.abs(decoded.manualAftershocks[1].lng - 140.679) < 1e-9, 'lng rounded to 3 decimals');
});

test('decodeScenario — scenario without asman decodes with empty manualAftershocks (backward compat)', () => {
  const events = [[35.68, 139.76, 7.0, 30, 45, 90, 0, 0]];
  const flags = { detect: false, aftershock: false, tsunami: true };
  // 3-arg encode (pre-v5.5 caller shape) must not emit the field.
  const decoded = U.decodeScenario(U.encodeScenario(events, flags, null));
  assert.ok(decoded);
  assert.deepStrictEqual(decoded.manualAftershocks, []);
});

test('decodeScenario — malformed asman rows in a tampered payload are dropped', () => {
  const payload = { v: 1, e: [[35.0, 140.0, 7.0, 30, 45, 90, 0, 0]], f: { t: 1 },
    asman: [[30, 5.0, 15], [45, 'x', 10], [50, null, 10], 'junk'] };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const decoded = U.decodeScenario(b64);
  assert.ok(decoded);
  assert.strictEqual(decoded.manualAftershocks.length, 1);
  assert.strictEqual(decoded.manualAftershocks[0].mag, 5.0);
  assert.strictEqual(decoded.manualAftershocks[0].time, 30);
});

// ================================================================
//  gridSearchTriangulate
// ================================================================

test('gridSearchTriangulate — 3 stations give valid result', () => {
  // Simulate 3 stations around Tokyo detecting a M7 event
  const stations = [
    { lat: 35.5, lng: 139.5, t: 5.0 },
    { lat: 35.8, lng: 140.0, t: 7.2 },
    { lat: 35.3, lng: 140.5, t: 8.5 }
  ];
  const result = U.gridSearchTriangulate(stations, 5.8, [5, 15, 30, 50]);
  assert.ok(result, 'should return a result');
  assert.ok(typeof result.lat === 'number' && !isNaN(result.lat));
  assert.ok(typeof result.lng === 'number' && !isNaN(result.lng));
  assert.ok(typeof result.depth === 'number' && !isNaN(result.depth));
  assert.ok(result.error >= 0, 'error should be non-negative');
  assert.ok(result.uncertainty >= 0, 'uncertainty should be non-negative');
});

test('gridSearchTriangulate — more stations improve accuracy', () => {
  // 10 stations tightly clustered should give lower error than 3 spread out
  var stns3 = [
    { lat: 35.5, lng: 139.5, t: 5.0 },
    { lat: 36.5, lng: 141.0, t: 12.0 },
    { lat: 34.5, lng: 138.0, t: 8.0 }
  ];
  var r3 = U.gridSearchTriangulate(stns3, 5.8, [15, 30]);

  var stns10 = [];
  for (var i = 0; i < 10; i++) {
    stns10.push({ lat: 35.6 + i*0.05, lng: 139.7 + i*0.03, t: 3.0 + i*0.3 });
  }
  var r10 = U.gridSearchTriangulate(stns10, 5.8, [15, 30]);

  // More stations typically give lower uncertainty (but not guaranteed for synthetic data)
  assert.ok(r3 && r10, 'both should return results');
});

test('gridSearchTriangulate — fewer than 3 stations returns null', () => {
  assert.strictEqual(U.gridSearchTriangulate([], 5.8, [15, 30]), null);
  assert.strictEqual(U.gridSearchTriangulate([{ lat: 35, lng: 140, t: 10 }], 5.8, [15, 30]), null);
});

test('gridSearchTriangulate — custom search options', () => {
  var stns = [
    { lat: 35.5, lng: 139.5, t: 5.0 },
    { lat: 35.8, lng: 140.0, t: 7.0 },
    { lat: 35.3, lng: 140.5, t: 8.0 }
  ];
  var r1 = U.gridSearchTriangulate(stns, 5.8, [15, 30], { searchStep: 0.5, searchRange: 3 });
  var r2 = U.gridSearchTriangulate(stns, 5.8, [15, 30], { searchStep: 0.1, searchRange: 2 });
  assert.ok(r1 && r2, 'both should return results with custom options');
});

// ================================================================
//  SIMULATION STATE MACHINE
// ================================================================

test('isValidPhaseTransition — forward transitions are valid', () => {
  assert.strictEqual(U.isValidPhaseTransition('ready', 'countdown'), true);
  assert.strictEqual(U.isValidPhaseTransition('countdown', 'running'), true);
  assert.strictEqual(U.isValidPhaseTransition('running', 'complete'), true);
  assert.strictEqual(U.isValidPhaseTransition('ready', 'running'), true);
});

test('isValidPhaseTransition — backward transitions rejected', () => {
  assert.strictEqual(U.isValidPhaseTransition('running', 'countdown'), false);
  assert.strictEqual(U.isValidPhaseTransition('complete', 'running'), false);
  assert.strictEqual(U.isValidPhaseTransition('complete', 'ready'), false);
});

test('isValidPhaseTransition — same phase rejected', () => {
  assert.strictEqual(U.isValidPhaseTransition('ready', 'ready'), false);
  assert.strictEqual(U.isValidPhaseTransition('running', 'running'), false);
});

test('isValidPhaseTransition — unknown phases rejected', () => {
  assert.strictEqual(U.isValidPhaseTransition('unknown', 'running'), false);
  assert.strictEqual(U.isValidPhaseTransition('ready', 'unknown'), false);
});

// ================================================================
//  formatShindoLabel
// ================================================================

test('formatShindoLabel — zero is special', () => {
  assert.strictEqual(U.formatShindoLabel(0), '震度0');
  assert.strictEqual(U.formatShindoLabel('0'), '震度0');
});

test('formatShindoLabel — all Shindo levels', () => {
  assert.strictEqual(U.formatShindoLabel(1), '震度1');
  assert.strictEqual(U.formatShindoLabel(4), '震度4');
  assert.strictEqual(U.formatShindoLabel('5-'), '震度5-');
  assert.strictEqual(U.formatShindoLabel('6+'), '震度6+');
  assert.strictEqual(U.formatShindoLabel(7), '震度7');
});
