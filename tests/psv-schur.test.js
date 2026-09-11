'use strict';
// psv-schur.test.js — the Schur admittance compliance representation
// (psv.psvSchurCompliance, v11 batch) and its 2026-09-10 production wiring
// (params.schurCompliance through the complianceAt dispatcher).
//
// Adjudication context (frozen in tools/data/psv-scale-diagnosis.json v11):
// at deep configs the legacy A/W chain is O(1) off a set of mutually
// agreeing references — RK4-ODE referee (extrapolated), eigendecomposition
// transport, the closed-form halfspace BVP (crest-halfspace-closed.js) and
// Schur itself. R2 locks that verdict so any change of state (a legacy
// chain fix, or a Schur regression) trips consciously.
const assert = require('assert');
const test = require('node:test');
const core = require('../tools/broadband/core.js');
const psv = require('../tools/broadband/psv.js');
const closedMod = require('../tools/broadband/crest-halfspace-closed.js');
const refereeMod = require('../tools/broadband/crest-ode-referee.js');
const { csub, cscale, cabs } = core;

function relC(a, b) {
  let num = 0, den = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    num = Math.max(num, Math.hypot(a[i][j][0] - b[i][j][0], a[i][j][1] - b[i][j][1]));
    den = Math.max(den, Math.hypot(b[i][j][0], b[i][j][1]));
  }
  return den > 0 ? num / den : NaN;
}
const neg = (C) => C.map((r) => r.map((v) => cscale(v, -1)));
const mag = (c) => Math.hypot(c[0], c[1]);

const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
const LAYERED = [
  { topKm: 0, bottomKm: 3, vsKmS: 1.6, vpKmS: 2.8, rhoGcm3: 2.2 },
  { topKm: 3, bottomKm: Infinity, vsKmS: 3.4, vpKmS: 5.9, rhoGcm3: 2.8 }
];

test('R1 — Schur agrees with the legacy chain at shallow/smooth configs', () => {
  // where the legacy chain is well-conditioned both representations are the
  // same physics; measured agreement 0.3-0.4% (v11 batch), locked at 1%.
  const omega = 2 * Math.PI * 0.5;
  const cases = [
    { stack: HALF, zs: 15, kKm: 0.2 },
    { stack: HALF, zs: 15, kKm: 0.5 },
    { stack: LAYERED, zs: 8, kKm: 0.3 }
  ];
  for (const c of cases) {
    const a = psv.psvSurfaceCompliance(c.stack, omega, c.kKm / 1000, c.zs, {});
    const b = psv.psvSchurCompliance(c.stack, omega, c.kKm / 1000, c.zs, {});
    const r = relC(a, b);
    assert.ok(r < 0.01, 'legacy-vs-schur smooth rel ' + r.toExponential(2) + ' at zs' + c.zs + ' k' + c.kKm);
  }
});

test('R2 — deep-config adjudication: Schur matches the closed-form halfspace BVP, legacy does not', () => {
  // HALF @ 1.2 Hz, zs = 73 km, q = 50 — the minimal repro of the v10
  // deep-config validation gap. The closed form is exact (sign convention:
  // it imposes tau_above - tau_below = +J, the chains use the opposite
  // orientation, hence the negation); the RK4 referee's Richardson
  // extrapolation agrees with Schur to ~4e-3 (crest-referee-deep-probe).
  const omega = 2 * Math.PI * 1.2, zs = 73;
  for (const kKm of [0.2, 0.5]) {
    const k = kKm / 1000;
    const opts = { qShear: 50, qP: 50 };
    const cc = closedMod.halfspaceClosedCompliance(HALF[0], omega, k, zs * 1000, opts);
    const sch = psv.psvSchurCompliance(HALF, omega, k, zs, opts);
    const leg = psv.psvSurfaceCompliance(HALF, omega, k, zs, opts);
    const rSch = relC(neg(cc), sch);
    assert.ok(rSch < 0.01, 'schur-vs-closed rel ' + rSch.toExponential(2) + ' at k' + kKm);
    // documented legacy failure at this config (v10 gap -> 2026-09-10 verdict):
    const rLeg = relC(neg(cc), leg);
    assert.ok(rLeg > 0.5, 'legacy unexpectedly close to the closed form (' +
      rLeg.toExponential(2) + ') at k' + kKm + ' — the chain conditioning verdict has changed, re-freeze');
  }
});

test('R3 — Schur matches the RK4-ODE referee on the deep HALF config', () => {
  const omega = 2 * Math.PI * 1.2, zs = 73;
  const k = 0.2e-3;
  const sch = psv.psvSchurCompliance(HALF, omega, k, zs, { qShear: 50, qP: 50 });
  const ref = refereeMod.odeComplianceDamped(HALF, omega, k, zs, 50, 50, 1);
  const r = relC(sch, ref);
  // the referee's single-shot rounding floor at this config is ~1e-2
  // (h-ladder; extrapolation vs the closed form lands at 4e-3)
  assert.ok(r < 0.05, 'schur-vs-rk4referee rel ' + r.toExponential(2));
});

test('R4 — complianceAt dispatch: the schur flag switches the deep-config compliance; falsy flag leaves legacy bit-identical', () => {
  const omega = 2 * Math.PI * 1.2, zs = 73, k = 0.5e-3;
  const params = { qShear: 50, qP: 50 };
  const leg = psv.complianceAt(HALF, omega, k, zs, params);
  const sch = psv.complianceAt(HALF, omega, k, zs, Object.assign({ schurCompliance: 1 }, params));
  assert.ok(leg && sch, 'both representations must evaluate on the deep config');
  const r = relC(leg, sch);
  assert.ok(r > 0.1, 'the schur flag did not change the deep-config compliance (rel ' + r.toExponential(2) + ')');
  const leg2 = psv.complianceAt(HALF, omega, k, zs, Object.assign({ schurCompliance: 0 }, params));
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    assert.deepStrictEqual(leg2[i][j], leg[i][j], 'falsy schurCompliance must not alter the legacy path');
  }
  // and the Schur dispatch equals the direct psvSchurCompliance call
  const direct = psv.psvSchurCompliance(HALF, omega, k, zs, params);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    assert.deepStrictEqual(sch[i][j], direct[i][j], 'complianceAt schur dispatch must be the Schur chain');
  }
});
