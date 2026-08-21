// ================================================================
//  Unit tests for RTData — realtime auto-focus decision logic
//  (kanameishi-style wave-ring framing: sticky EEW target, refly
//  hysteresis, ring bounds with margin/floor/cap, kmoni debounce)
//  Run with:  node --test tests/rt-focus.test.js
//  (no DOM required — module must load cleanly under node)
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const RTData = require('../public/rt-data.js');

const DEG_KM = 6371 * Math.PI / 180; // matches rt-data's KM_PER_DEG

function ev(eventId, phase, lat, lng, announcedMs, receivedAt) {
  return {
    eventId,
    phase,
    receivedAt: receivedAt != null ? receivedAt : 0,
    latest: { lat, lng, depth: 20, announcedMs: announcedMs != null ? announcedMs : null, originMs: 0 }
  };
}

// ---------------------------------------------------------------------------
//  exports
// ---------------------------------------------------------------------------

test('module loads under node and exports the focus decision helpers', () => {
  assert.strictEqual(typeof RTData.rtFocusDecide, 'function');
  assert.strictEqual(typeof RTData.rtFocusPickEewEvent, 'function');
  assert.strictEqual(typeof RTData.rtFocusNeedsRefly, 'function');
  assert.strictEqual(typeof RTData.rtFocusBounds, 'function');
  assert.strictEqual(typeof RTData.rtFocusEffectiveRadiusKm, 'function');
  assert.strictEqual(typeof RTData.rtFocusHaversineKm, 'function');
  assert.strictEqual(typeof RTData.rtFocusTick, 'function');
  assert.strictEqual(typeof RTData.refocusNow, 'function');
});

// ---------------------------------------------------------------------------
//  rtFocusEffectiveRadiusKm — floor 60 km / cap 1000 km / ×1.15 margin
// ---------------------------------------------------------------------------

test('effective radius: floor, cap, passthrough, NaN', () => {
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(0), 60 * 1.15), 'zero ring → floor');
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(30), 60 * 1.15), 'below floor pinned');
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(59.9), 60 * 1.15));
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(100), 115), 'in range → ×1.15');
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(5000), 1000 * 1.15), 'huge ring → cap');
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(NaN), 60 * 1.15), 'NaN → floor');
  assert.ok(close(RTData.rtFocusEffectiveRadiusKm(undefined), 60 * 1.15));
});

// ---------------------------------------------------------------------------
//  rtFocusBounds — epicenter ± effective radius, clamped to whole Japan
// ---------------------------------------------------------------------------

test('bounds: symmetric around the epicenter with floor + margin', () => {
  const b = RTData.rtFocusBounds(33, 136, 0); // ring not surfaced yet
  const halfDeg = (60 * 1.15) / DEG_KM;
  assert.ok(Math.abs((33 - b[0][0]) - halfDeg) < 1e-9, 'south = lat − 69 km');
  assert.ok(Math.abs((b[1][0] - 33) - halfDeg) < 1e-9, 'north = lat + 69 km');
  const halfLng = halfDeg / Math.cos(33 * Math.PI / 180);
  assert.ok(Math.abs((136 - b[0][1]) - halfLng) < 1e-9, 'longitude corrected by cos(lat)');
  // whole span ≈ 138 km — on a 900 px-tall map this is about zoom 9, never closer
  const spanKm = (b[1][0] - b[0][0]) * DEG_KM;
  assert.ok(spanKm > 130 && spanKm < 145, 'floor frame span ≈ 138 km, got ' + spanKm.toFixed(1));
});

test('bounds: ring radius frames the ring plus margin', () => {
  const b = RTData.rtFocusBounds(35, 137, 200);
  const halfKm = (b[1][0] - b[0][0]) / 2 * DEG_KM;
  assert.ok(Math.abs(halfKm - 230) < 0.5, '200 km ring → 230 km half-span, got ' + halfKm.toFixed(1));
  assert.ok(Math.abs((b[0][0] + b[1][0]) / 2 - 35) < 1e-9, 'centered on the epicenter latitude');
});

test('bounds: never wider than the whole-Japan frame (cap + clamp)', () => {
  const b = RTData.rtFocusBounds(35, 135, 5000);
  assert.ok(b[0][0] >= 24.0 && b[1][0] <= 45.8, 'latitude inside Japan frame');
  assert.strictEqual(b[0][1], 122.5, 'west clamped to Japan frame');
  assert.strictEqual(b[1][1], 146.5, 'east clamped to Japan frame');
});

// ---------------------------------------------------------------------------
//  rtFocusPickEewEvent — sticky selection, no flip-flop
// ---------------------------------------------------------------------------

test('pick: empty / all-canceled / position-less events → null', () => {
  assert.strictEqual(RTData.rtFocusPickEewEvent([], ''), null);
  assert.strictEqual(RTData.rtFocusPickEewEvent(null, ''), null);
  assert.strictEqual(RTData.rtFocusPickEewEvent(undefined, 'eew:A'), null);
  assert.strictEqual(RTData.rtFocusPickEewEvent([ev('A', 'canceled', 33, 136, 100)], 'eew:A'), null,
    'a canceled focused event is never re-picked');
  assert.strictEqual(RTData.rtFocusPickEewEvent([ev('A', 'active', null, null, 100)], ''), null,
    'no valid position → not a target');
  assert.strictEqual(RTData.rtFocusPickEewEvent([ev('A', 'active', 0, 0, 100)], ''), null,
    '0,0 (null island) → not a target');
});

test('pick: newest non-canceled event wins when nothing is focused', () => {
  const older = ev('A', 'active', 33, 136, 1000);
  const newer = ev('B', 'active', 35, 140, 2000);
  // input order must not matter (getActive() ordering is the flip-flop source)
  assert.strictEqual(RTData.rtFocusPickEewEvent([older, newer], '').eventId, 'B');
  assert.strictEqual(RTData.rtFocusPickEewEvent([newer, older], '').eventId, 'B');
  // receivedAt is the fallback clock when announcedMs is missing
  const noAnn = ev('C', 'active', 36, 141, null, 3000);
  assert.strictEqual(RTData.rtFocusPickEewEvent([newer, noAnn], '').eventId, 'C');
});

test('pick: sticky — keeps the focused event over a newer concurrent one', () => {
  const focused = ev('A', 'active', 33, 136, 1000);
  const newer = ev('B', 'active', 35, 140, 2000);
  assert.strictEqual(RTData.rtFocusPickEewEvent([newer, focused], 'eew:A').eventId, 'A');
  // sticky across the FINAL transition — rings keep growing after FINAL
  const focusedFinal = ev('A', 'final', 33, 136, 1000);
  assert.strictEqual(RTData.rtFocusPickEewEvent([newer, focusedFinal], 'eew:A').eventId, 'A');
});

test('pick: focused event gone (canceled/expired) → newest remaining non-canceled', () => {
  const canceled = ev('A', 'canceled', 33, 136, 1000);
  const survivor = ev('B', 'final', 35, 140, 900);
  assert.strictEqual(RTData.rtFocusPickEewEvent([canceled, survivor], 'eew:A').eventId, 'B',
    'final survivor is a valid target (rings still grow)');
  assert.strictEqual(RTData.rtFocusPickEewEvent([survivor], 'eew:A').eventId, 'B',
    'focused event expired out of the tracker → switch');
});

// ---------------------------------------------------------------------------
//  rtFocusNeedsRefly — hysteresis vs the last flown frame
// ---------------------------------------------------------------------------

test('refly: no prior frame → fly; identical frame → hold', () => {
  assert.strictEqual(RTData.rtFocusNeedsRefly(null, { lat: 33, lng: 136, radiusKm: 0 }), true);
  assert.strictEqual(RTData.rtFocusNeedsRefly({ lat: null, lng: null, radiusKm: null }, { lat: 33, lng: 136, radiusKm: 0 }), true);
  const f = { lat: 33, lng: 136, radiusKm: 200 };
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33, lng: 136, radiusKm: 200 }), false);
});

test('refly: radius hysteresis — >12% since the last flown radius', () => {
  const f = { lat: 33, lng: 136, radiusKm: 200 };
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33, lng: 136, radiusKm: 200 * 1.13 }), true, '+13%');
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33, lng: 136, radiusKm: 200 * 1.10 }), false, '+10% holds');
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33, lng: 136, radiusKm: 200 * 0.87 }), true, '-13% (shrink counts)');
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33, lng: 136, radiusKm: 200 * 0.90 }), false, '-10% holds');
});

test('refly: silent growth under the floor never triggers a flight', () => {
  const f = { lat: 33, lng: 136, radiusKm: 0 };
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33, lng: 136, radiusKm: 50 }), false,
    '0 → 50 km raw stays under the 60 km floor: the camera frame does not change');
});

test('refly: center hysteresis — >20 km since the last flown center', () => {
  const f = { lat: 33, lng: 136, radiusKm: 200 };
  const deg19 = 19 / DEG_KM, deg21 = 21 / DEG_KM;
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33 + deg19, lng: 136, radiusKm: 200 }), false, '19 km holds');
  assert.strictEqual(RTData.rtFocusNeedsRefly(f, { lat: 33 + deg21, lng: 136, radiusKm: 200 }), true, '21 km revision refocuses');
});

// ---------------------------------------------------------------------------
//  rtFocusDecide — one-tick target selection
// ---------------------------------------------------------------------------

test('decide: EEW acquisition flies the ring frame exactly once', () => {
  const ring = () => 0; // first report: wave has not surfaced
  const evs = [ev('A', 'active', 33, 136, 1000)];
  const d1 = RTData.rtFocusDecide({}, { events: evs, ringKmOf: ring, kmoni: null });
  assert.ok(d1.fly, 'first sighting flies');
  assert.strictEqual(d1.fly.kind, 'eew');
  assert.strictEqual(d1.fly.key, 'eew:A');
  assert.strictEqual(d1.fly.lat, 33);
  assert.strictEqual(d1.fly.lng, 136);
  assert.strictEqual(d1.hasTarget, true);
  assert.strictEqual(d1.st.key, 'eew:A');
  // same ring next tick → no flight, target held
  const d2 = RTData.rtFocusDecide(d1.st, { events: evs, ringKmOf: ring, kmoni: null });
  assert.strictEqual(d2.fly, null);
  assert.strictEqual(d2.hasTarget, true);
  assert.strictEqual(d2.st.key, 'eew:A');
});

test('decide: ring growth re-fits only past the 12% hysteresis', () => {
  const evs = [ev('A', 'active', 33, 136, 1000)];
  let st = RTData.rtFocusDecide({}, { events: evs, ringKmOf: () => 100, kmoni: null }).st;
  assert.strictEqual(st.radiusKm, 100);
  st = RTData.rtFocusDecide(st, { events: evs, ringKmOf: () => 110, kmoni: null });
  assert.strictEqual(st.fly, null, '+10% holds the frame');
  assert.strictEqual(st.st.radiusKm, 100, 'last-flown radius is NOT silently updated');
  const d = RTData.rtFocusDecide(st.st, { events: evs, ringKmOf: () => 113, kmoni: null });
  assert.ok(d.fly, 'vs the flown 100 km, 113 km is +13% → re-fit');
  assert.strictEqual(d.fly.radiusKm, 113);
});

test('decide: active→final keeps the focus (no drop-out snap)', () => {
  const active = [ev('A', 'active', 33, 136, 1000)];
  let d = RTData.rtFocusDecide({}, { events: active, ringKmOf: () => 50, kmoni: null });
  const final = [ev('A', 'final', 33, 136, 1000)];
  d = RTData.rtFocusDecide(d.st, { events: final, ringKmOf: () => 53, kmoni: null });
  assert.strictEqual(d.fly, null, 'small growth after FINAL: no flight');
  assert.strictEqual(d.st.key, 'eew:A', 'still focused on the final event');
  assert.strictEqual(d.hasTarget, true, 'final event still counts as a target (no quiet fallback)');
});

test('decide: no flip-flop between concurrent events; switch only on disappearance', () => {
  const a = ev('A', 'active', 33, 136, 1000);
  const b = ev('B', 'active', 35, 140, 2000); // newer
  let d = RTData.rtFocusDecide({}, { events: [a, b], ringKmOf: () => 50, kmoni: null });
  assert.strictEqual(d.st.key, 'eew:B', 'newest event acquired first');
  // order flips in a later getActive() snapshot → must NOT switch
  d = RTData.rtFocusDecide(d.st, { events: [b, a], ringKmOf: () => 51, kmoni: null });
  assert.strictEqual(d.st.key, 'eew:B');
  assert.strictEqual(d.fly, null);
  // B canceled → fall to A (one flight, A's frame)
  const bGone = [a, ev('B', 'canceled', 35, 140, 2100)];
  d = RTData.rtFocusDecide(d.st, { events: bGone, ringKmOf: () => 50, kmoni: null });
  assert.ok(d.fly);
  assert.strictEqual(d.fly.key, 'eew:A');
});

test('decide: nothing tracked → hasTarget false (quiet bookkeeping stays outside)', () => {
  const d = RTData.rtFocusDecide({}, { events: [], ringKmOf: () => 0, kmoni: null });
  assert.strictEqual(d.fly, null);
  assert.strictEqual(d.hasTarget, false);
});

test('decide: kmoni fallback needs 2 consecutive ticks before flying', () => {
  const k = { activeCount: 4, activeLat: 35, activeLng: 140 };
  let d = RTData.rtFocusDecide({}, { events: [], ringKmOf: () => 0, kmoni: k });
  assert.strictEqual(d.fly, null, 'first tick: candidate only');
  assert.strictEqual(d.hasTarget, true, 'shaking still suppresses the quiet zoom-out');
  assert.strictEqual(d.st.kmoniTicks, 1);
  d = RTData.rtFocusDecide(d.st, { events: [], ringKmOf: () => 0, kmoni: k });
  assert.ok(d.fly, 'second tick with the same target → fly');
  assert.strictEqual(d.fly.kind, 'kmoni');
  assert.strictEqual(d.st.key, 'kmoni');
});

test('decide: kmoni candidate jumping >20 km resets the debounce', () => {
  let d = RTData.rtFocusDecide({}, { events: [], ringKmOf: () => 0, kmoni: { activeCount: 4, activeLat: 35, activeLng: 140 } });
  assert.strictEqual(d.st.kmoniTicks, 1);
  // ~167 km away — a different cluster: restart the count
  d = RTData.rtFocusDecide(d.st, { events: [], ringKmOf: () => 0, kmoni: { activeCount: 4, activeLat: 36.5, activeLng: 140 } });
  assert.strictEqual(d.fly, null);
  assert.strictEqual(d.st.kmoniTicks, 1, 'moved candidate restarts the debounce');
});

test('decide: kmoni never preempts an EEW focus', () => {
  const evs = [ev('A', 'final', 33, 136, 1000)];
  let d = RTData.rtFocusDecide({}, { events: evs, ringKmOf: () => 50, kmoni: null });
  d = RTData.rtFocusDecide(d.st, {
    events: evs, ringKmOf: () => 51,
    kmoni: { activeCount: 40, activeLat: 35, activeLng: 140 }
  });
  assert.strictEqual(d.fly, null);
  assert.strictEqual(d.st.key, 'eew:A', 'EEW focus holds over shaking');
  assert.strictEqual(d.st.kmoniTicks, 0, 'kmoni candidate discarded while EEW-focused');
});

test('decide: EEW arrival preempts a kmoni focus', () => {
  const k = { activeCount: 4, activeLat: 35, activeLng: 140 };
  let d = RTData.rtFocusDecide({}, { events: [], ringKmOf: () => 0, kmoni: k });
  d = RTData.rtFocusDecide(d.st, { events: [], ringKmOf: () => 0, kmoni: k });
  assert.strictEqual(d.st.key, 'kmoni');
  d = RTData.rtFocusDecide(d.st, { events: [ev('A', 'active', 33, 136, 1000)], ringKmOf: () => 50, kmoni: k });
  assert.ok(d.fly);
  assert.strictEqual(d.fly.kind, 'eew', 'EEW takes the camera from the kmoni fallback');
});

test('decide: kmoni focus follows the hottest station only on material moves', () => {
  const k0 = { activeCount: 4, activeLat: 35, activeLng: 140 };
  let d = RTData.rtFocusDecide({}, { events: [], ringKmOf: () => 0, kmoni: k0 });
  d = RTData.rtFocusDecide(d.st, { events: [], ringKmOf: () => 0, kmoni: k0 });
  assert.strictEqual(d.st.key, 'kmoni');
  // ~11 km drift → hold
  d = RTData.rtFocusDecide(d.st, { events: [], ringKmOf: () => 0, kmoni: { activeCount: 4, activeLat: 35.1, activeLng: 140 } });
  assert.strictEqual(d.fly, null);
  // ~22 km jump → follow
  d = RTData.rtFocusDecide(d.st, { events: [], ringKmOf: () => 0, kmoni: { activeCount: 4, activeLat: 35.2, activeLng: 140 } });
  assert.ok(d.fly);
  assert.strictEqual(d.fly.kind, 'kmoni');
});

test('decide: at most one flight per call, and NaN ring radius frames the floor', () => {
  const d = RTData.rtFocusDecide({}, { events: [ev('A', 'active', 33, 136, 1000)], ringKmOf: () => NaN, kmoni: null });
  assert.ok(d.fly);
  assert.strictEqual(d.fly.kind, 'eew');
  assert.ok(Number.isNaN(d.fly.radiusKm), 'raw NaN passed through — rtFocusBounds floors it');
  const b = RTData.rtFocusBounds(d.fly.lat, d.fly.lng, d.fly.radiusKm);
  const spanKm = (b[1][0] - b[0][0]) * DEG_KM;
  assert.ok(spanKm > 130 && spanKm < 145, 'NaN ring → floor frame');
});
