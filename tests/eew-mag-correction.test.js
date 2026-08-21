// ================================================================
//  Unit tests for SimUtils.eewMagBulletinCorrection
//  (EEW detect-mode first-report magnitude bias correction)
//  Run with:  node --test tests/eew-mag-correction.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../public/sim-utils.js');

// Measured constants (tools/data/eew-mag-bias-report.json): bulletin 1 reads
// 0.79-1.09 M below the track's own FINAL estimate; correction is a positive
// lift of 0.7 M at bulletin 1, x0.25 per bulletin, zero from bulletin 5 on.

test('eewMagBulletinCorrection — bulletin 1 lifts by the measured constant', () => {
  assert.strictEqual(U.eewMagBulletinCorrection(6.0, 1, 10), 6.0 + U.EEW_MAG_B1_LIFT);
  assert.strictEqual(U.EEW_MAG_B1_LIFT, 0.7);
});

test('eewMagBulletinCorrection — zero correction at/after FINAL-convergence bulletin count', () => {
  // A converged FINAL is bulletin #5 or later (MIN_BULLETINS = 4 in app.js).
  assert.strictEqual(U.eewMagBulletinCorrection(6.0, 5, 100), 6.0);
  assert.strictEqual(U.eewMagBulletinCorrection(6.0, 6, 100), 6.0);
  assert.strictEqual(U.eewMagBulletinCorrection(7.4, 12, 353), 7.4);
});

test('eewMagBulletinCorrection — monotone decay with bulletin number', () => {
  const M = 6.0;
  let prev = Infinity;
  for (let b = 1; b <= 8; b++) {
    const lift = U.eewMagBulletinCorrection(M, b, 10) - M;
    assert.ok(lift <= prev, 'lift at bulletin ' + b + ' must not exceed previous');
    prev = lift;
  }
  assert.strictEqual(prev, 0);
});

test('eewMagBulletinCorrection — lift never exceeds the measured bulletin-1 bias', () => {
  // Smallest measured first-report underestimate vs the track's own FINAL: 0.79 M.
  for (let b = 1; b <= 4; b++) {
    const lift = U.eewMagBulletinCorrection(6.0, b, 10) - 6.0;
    assert.ok(lift >= 0, 'correction is a positive lift only');
    assert.ok(lift <= 0.79, 'lift at bulletin ' + b + ' exceeds the measured minimum bias');
  }
});

test('eewMagBulletinCorrection — output bounded to the [3, 10] magnitude domain', () => {
  assert.strictEqual(U.eewMagBulletinCorrection(9.9, 1, 3), 10);
  assert.strictEqual(U.eewMagBulletinCorrection(1.0, 5, 3), 3);
  for (const M of [3.5, 5.0, 6.8, 9.1]) {
    for (let b = 1; b <= 10; b++) {
      const out = U.eewMagBulletinCorrection(M, b, 10);
      assert.ok(out >= 3 && out <= 10, 'out of domain for M=' + M + ' b=' + b);
    }
  }
});

test('eewMagBulletinCorrection — no NaN on edge inputs', () => {
  for (const args of [[NaN, 1, 3], [6.0, NaN, 3], [6.0, 1, NaN],
    [undefined, undefined, undefined], [null, null, null],
    ['6.5', '2', '10'], [6.0, -1, -5], [6.0, 0, 0], [Infinity, 1, 3]]) {
    const out = U.eewMagBulletinCorrection(args[0], args[1], args[2]);
    assert.ok(Number.isFinite(out), 'non-finite output for ' + JSON.stringify(args));
  }
});

test('eewMagBulletinCorrection — non-finite raw magnitude returns 0 (no estimate)', () => {
  assert.strictEqual(U.eewMagBulletinCorrection(NaN, 1, 3), 0);
  assert.strictEqual(U.eewMagBulletinCorrection(Infinity, 2, 3), 0);
});

test('eewMagBulletinCorrection — invalid bulletin numbers treated as first report', () => {
  // b < 1 or non-numeric falls back to bulletin 1 (the maximum-lift case is the
  // conservative one for a first report).
  assert.strictEqual(U.eewMagBulletinCorrection(6.0, 0, 10), 6.0 + U.EEW_MAG_B1_LIFT);
  assert.strictEqual(U.eewMagBulletinCorrection(6.0, 'x', 10), 6.0 + U.EEW_MAG_B1_LIFT);
});


// ================================================================
//  Unit tests for SimUtils.eewGiantEventLift
//  (detect-mode giant-event saturation-spread lift, round 2)
// ================================================================

// Measured operating points (tools/data/eew-mag-bias-report.json, round2 diag,
// ramp-complete steady state, faithful-Zhao2006 forward physics 2026-08-19):
// Tohoku M9.1 (med 7.44, top 8.02, spread 0.58) is pinned at the saturation
// plateau with a far-field tail; M7.3 (7.39/7.54, spread 0.15), M6.8
// (6.81/6.96, 0.15) and M5.0 (~4.4/5.2, <0.2) fail the spread gate.

test('eewGiantEventLift — plateau rule lifts a saturation-pinned median toward the tail', () => {
  // Tohoku M9.1 ramp-complete FINAL solve (faithful-Zhao): lift = min(top, med+cap).
  assert.strictEqual(U.eewGiantEventLift(7.44, 8.02, 8), 7.94);
  assert.strictEqual(U.EEW_MAG_GIANT_MED_GATE, 7.3);
  assert.strictEqual(U.EEW_MAG_GIANT_SPREAD_GATE, 0.3);
  assert.strictEqual(U.EEW_MAG_GIANT_LIFT_CAP, 0.5);
});

test('eewGiantEventLift — plateau lift is capped when the tail is far above', () => {
  assert.strictEqual(U.eewGiantEventLift(8.0, 9.5, 10), 8.0 + U.EEW_MAG_GIANT_LIFT_CAP);
});

test('eewGiantEventLift — plateau gates are strict and both must open', () => {
  // med exactly at the gate: no fire
  assert.strictEqual(U.eewGiantEventLift(U.EEW_MAG_GIANT_MED_GATE, 8.4, 10), U.EEW_MAG_GIANT_MED_GATE);
  // spread below the gate (exactly-representable 0.125): no fire
  assert.strictEqual(U.eewGiantEventLift(7.8, 7.925, 10), 7.8);
  // fewer than 5 inversions: no fire
  assert.strictEqual(U.eewGiantEventLift(7.9, 8.4, 4), 7.9);
  // spread 0.25 is now BELOW the 0.3 spread gate: no fire
  assert.strictEqual(U.eewGiantEventLift(7.8, 8.05, 10), 7.8);
  // just past every gate (spread 0.42 > 0.3): fires, clamped at top
  assert.ok(Math.abs(U.eewGiantEventLift(7.61, 8.03, 5) - 8.03) < 1e-9);
});

test('eewGiantEventLift — mid-size events (M5-M7.5) are untouched', () => {
  assert.strictEqual(U.eewGiantEventLift(7.38, 7.51, 35), 7.38); // m73 FINAL solve
  assert.strictEqual(U.eewGiantEventLift(6.85, 6.96, 28), 6.85); // m68 FINAL solve
  assert.strictEqual(U.eewGiantEventLift(5.10, 5.22, 32), 5.10); // m50 FINAL solve
});

test('eewGiantEventLift — a mid-size event with a thin tail never fires (spread gate)', () => {
  // M7.3/M6.8-class solves sit above the 7.3 med gate but their tails are thin
  // (spread ~0.15 < 0.3), so the plateau rule stays closed for them.
  assert.strictEqual(U.eewGiantEventLift(7.62, 7.77, 12), 7.62);
  assert.strictEqual(U.eewGiantEventLift(7.39, 7.54, 33), 7.39);
});

test('eewGiantEventLift — legacy wide-spread rule preserved (mixed-ramp early bulletins)', () => {
  assert.strictEqual(U.EEW_MAG_SPREAD_MIN_STATIONS, 20);
  assert.strictEqual(U.EEW_MAG_SPREAD_LEGACY, 1.0);
  assert.strictEqual(U.EEW_MAG_SPREAD_LEGACY_CAP, 1.5);
  assert.strictEqual(U.eewGiantEventLift(7.2, 8.64, 29), 8.64);        // spread 1.44 > 1.0, cap not binding
  assert.strictEqual(U.eewGiantEventLift(7.2, 9.5, 25), 7.2 + 1.5);    // cap binds
  assert.strictEqual(U.eewGiantEventLift(7.2, 8.9, 19), 7.2);          // station gate closed
  assert.strictEqual(U.eewGiantEventLift(7.2, 8.2, 25), 7.2);          // spread gate closed (spread = 1.0, strict)
});

test('eewGiantEventLift — never exceeds topM, never below medM', () => {
  for (const [med, top, n] of [[7.9, 8.3, 8], [8.4, 8.4, 30], [7.7, 9.9, 40], [5.0, 7.0, 25], [7.8, 8.1, 6]]) {
    const out = U.eewGiantEventLift(med, top, n);
    assert.ok(out >= med, 'below med for ' + [med, top, n]);
    assert.ok(out <= Math.max(top, med), 'above top for ' + [med, top, n]);
  }
});

test('eewGiantEventLift — output bounded to the [3, 10] magnitude domain', () => {
  assert.strictEqual(U.eewGiantEventLift(9.9, 12, 30), 10);
  assert.strictEqual(U.eewGiantEventLift(1.0, 1.5, 30), 3);
});

test('eewGiantEventLift — no NaN on edge inputs', () => {
  for (const args of [[NaN, 8, 10], [7.9, NaN, 10], [7.9, 8.3, NaN],
    [undefined, undefined, undefined], [null, null, null],
    ['7.9', '8.3', '8'], [7.9, 8.3, -4], [Infinity, 9, 10], [7.9, 6.0, 10]]) {
    const out = U.eewGiantEventLift(args[0], args[1], args[2]);
    assert.ok(Number.isFinite(out), 'non-finite output for ' + JSON.stringify(args));
  }
  // top < med is nonsense input; degenerates to med (no negative spread lift)
  assert.strictEqual(U.eewGiantEventLift(7.9, 6.0, 10), 7.9);
  // non-finite median means no estimate at all (parity with eewMagBulletinCorrection)
  assert.strictEqual(U.eewGiantEventLift(NaN, 8.0, 10), 0);
});
