'use strict';
// crest-referee-deep-probe.js — attribute the deep-config compliance
// disagreement (HALF @ 1.2 Hz, q=50, zs=73 km measured 2.2x, 2026-09-09)
// between: (a) the legacy expm+MGS A/W chain, (b) the RK4 referee, (c) the
// Schur admittance chain. Third independent evaluation: an EIGENDECOMPOSITION
// transport chain (same A/W residual algebra as production, but exp(Ah)
// computed from the convention-aligned eigenvectors, kappa(E) ~ 1e3 —
// no scaling-and-squaring, no MGS). Comparisons only ever pair SAME-state-
// convention quantities (the eig chain lives in the scaled-traction
// convention end to end; the referee solves in true traction but the final
// compliance is convention-free).
// NOTE: psvPropagator's OUTPUT is the TRUE-traction propagator (rows/cols
// 2,3 back-transformed by mu*); comparing it against scaled-convention
// references is meaningless (measured: apparent 1e5 "disagreements" that
// are pure convention). All cross-checks here go through compliances.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const core = require('./core.js');
const psv = require('./psv.js');
const referee = require('./crest-ode-referee.js');
const { layerA, m4mul, m4v, m4inv, rel4, maxabs4 } = require('./crest-probe-lib.js');
const cadd = core.cadd, csub = core.csub, cmul = core.cmul, cscale = core.cscale, cabs = core.cabs, cdiv = core.cdiv;

function m2inv(A) {
  const det = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0]));
  return [[cdiv(A[1][1], det), cscale(cdiv(A[0][1], det), -1)], [cscale(cdiv(A[1][0], det), -1), cdiv(A[0][0], det)]];
}
function m2mul(A, B) {
  return [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
          [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
}
function relC(a, b) {
  if (!a || !b) return NaN;
  let num = 0, den = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    num = Math.max(num, Math.hypot(a[i][j][0] - b[i][j][0], a[i][j][1] - b[i][j][1]));
    den = Math.max(den, Math.hypot(b[i][j][0], b[i][j][1]));
  }
  return den > 0 ? num / den : NaN;
}
/** Scaled-traction eigenvectors of layerA (psvEigenvectors rows 2,3 divided
 *  by mu*), column-normalised — kappa ~ 1e3 (raw true-traction pairing with
 *  the scaled A is NOT an eigenpair: measured 3e2 residuals). */
function scaledEigenvectors(layer, omega, k, opts) {
  const E0 = psv.psvEigenvectors(layer, omega, k, opts);
  const rho = layer.rhoGcm3 * 1000;
  const muR = rho * Math.pow(layer.vsKmS * 1000, 2);
  const qs = (opts && opts.qShear) || 0;
  const muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  const E = E0.map((row, i) => row.map((v) => (i >= 2 ? cdiv(v, muC) : v)));
  for (let j = 0; j < 4; j++) {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, cabs(E[i][j]));
    for (let i = 0; i < 4; i++) E[i][j] = cscale(E[i][j], 1 / m);
  }
  return E;
}
/** exp(A_scaled h) via balanced eigendecomposition. */
function eigPropagatorScaled(layer, omega, k, h, opts) {
  const A = layerA(layer, omega, k, opts);
  const E = scaledEigenvectors(layer, omega, k, opts);
  const nuA = psv.nuOf(layer.vpKmS, omega, k, opts && opts.qP);
  const nuB = psv.nuOf(layer.vsKmS, omega, k, opts && opts.qShear);
  const d = [
    [Math.exp(-nuA[1] * h) * Math.cos(nuA[0] * h), Math.exp(-nuA[1] * h) * Math.sin(nuA[0] * h)],
    [Math.exp(nuA[1] * h) * Math.cos(nuA[0] * h), -Math.exp(nuA[1] * h) * Math.sin(nuA[0] * h)],
    [Math.exp(-nuB[1] * h) * Math.cos(nuB[0] * h), Math.exp(-nuB[1] * h) * Math.sin(nuB[0] * h)],
    [Math.exp(nuB[1] * h) * Math.cos(nuB[0] * h), -Math.exp(nuB[1] * h) * Math.sin(nuB[0] * h)]
  ];
  const ED = E.map((row) => row.map((v, j) => cmul(v, d[j])));
  return m4mul(ED, m4inv(E));
}
/** Compliance through the SAME A/W residual algebra as production
 *  (canonical u-columns transported surface -> source, W pair canonical at
 *  the source = halfspace top for a source-at-halfspace-top stack), with
 *  the eigendecomposition propagator. Single material layer [0, zs]. */
function eigChainCompliance(layer, omega, k, zsKm, opts, nSub, dbgTag) {
  const hSub = (zsKm * 1000) / nSub;
  const P = eigPropagatorScaled(layer, omega, k, hSub, opts);
  let s1 = [[1, 0], [0, 0], [0, 0], [0, 0]];
  let s2 = [[0, 0], [1, 0], [0, 0], [0, 0]];
  const step = (s) => m4v(P, s);
  for (let i = 0; i < nSub; i++) { s1 = step(s1); s2 = step(s2); }
  const Y = psv.psvHalfspaceAdmittance(layer, omega, k, opts);
  const rho = layer.rhoGcm3 * 1000;
  const muR = rho * Math.pow(layer.vsKmS * 1000, 2);
  const qs = (opts && opts.qShear) || 0;
  const muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  // residual rows mix u (unscaled) and tau — the tau rows of s are SCALED
  // here: res = tau_s - (Y/mu*) u (res_true/mu*, same 2x2 cancellation)
  const Yeff = [[cdiv(Y[0][0], muC), cdiv(Y[0][1], muC)], [cdiv(Y[1][0], muC), cdiv(Y[1][1], muC)]];
  const res = (s) => [csub(s[2], cadd(cmul(Yeff[0][0], s[0]), cmul(Yeff[0][1], s[1]))),
                      csub(s[3], cadd(cmul(Yeff[1][0], s[0]), cmul(Yeff[1][1], s[1])))];
  const rA0 = res(s1), rA1 = res(s2);
  // W basis = canonical TRUE-traction jump columns at the source = e_j/mu*
  // in the scaled convention (production's Rw for a source-at-halfspace-top
  // stack is the identity in true traction)
  const iMu = cdiv([1, 0], muC);
  const Rc = [[rA0[0], rA1[0]], [rA0[1], rA1[1]]];
  const Rw = [[iMu, [0, 0]], [[0, 0], iMu]];
  const detRc = csub(cmul(Rc[0][0], Rc[1][1]), cmul(Rc[0][1], Rc[1][0]));
  const sRc = Math.max(...Rc.flat().map(cabs));
  if (!(cabs(detRc) > 0) || !isFinite(cabs(detRc))) {
    console.log('  [eig ' + dbgTag + '] det(Rc) =', detRc, ' scale =', sRc.toExponential(3), ' rA0 =', rA0.map(cabs).map((v) => v.toExponential(2)).join(' '), ' rA1 =', rA1.map(cabs).map((v) => v.toExponential(2)).join(' '));
  }
  const Cc = m2mul(m2inv(Rc), Rw);
  // the A-pair columns were unit-norm at the SURFACE (no rescale anywhere):
  // C maps the source traction jump to SURFACE displacement u(0) directly.
  return [[cscale(Cc[0][0], -1), cscale(Cc[0][1], -1)], [cscale(Cc[1][0], -1), cscale(Cc[1][1], -1)]];
}

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const HALF_INF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
const HALF = { topKm: 0, bottomKm: 73, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 };
const fHz = 1.2, omega = 2 * Math.PI * fHz, zs = 73, qS = 50, qP = 50;
const opts = { qShear: qS, qP: qP };

console.log('== HALF @', fHz, 'Hz zs', zs, 'km q', qS, '— compliance three-way ==');
for (const kKm of [0.2, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2]) {
  const k = kKm / 1000;
  const Cprod = psv.psvSurfaceCompliance(HALF_INF, omega, k, zs, opts);
  const Csch = psv.psvSchurCompliance(HALF_INF, omega, k, zs, opts);
  const Cref1 = referee.odeComplianceDamped(HALF_INF, omega, k, zs, qS, qP, 1);
  const Cref05 = referee.odeComplianceDamped(HALF_INF, omega, k, zs, qS, qP, 0.5);
  const Cref025 = referee.odeComplianceDamped(HALF_INF, omega, k, zs, qS, qP, 0.25);
  const Ceig1 = eigChainCompliance(HALF, omega, k, zs, opts, 6, "n6");
  const Ceig2 = eigChainCompliance(HALF, omega, k, zs, opts, 12, "n12");
  const Ceig12 = eigChainCompliance(HALF, omega, k, zs, opts, 24, "n24");
  // Richardson extrapolation of the referee ladder (O(h^2), halving):
  // C_true ~= C025 + (C025 - C05) / 3
  const ext = Cref05.map((row, i) => row.map((v, j) => cadd(Cref025[i][j], cscale(csub(Cref025[i][j], Cref05[i][j]), 1 / 3))));
  console.log('k', kKm.toFixed(2),
    '| prod-vs-ref1', relC(Cprod, Cref1).toExponential(2),
    '| schur-vs-refext', relC(Csch, ext).toExponential(2),
    '| eig-vs-refext', relC(Ceig12, ext).toExponential(2),
    '| eig ladder', relC(Ceig1, Ceig2).toExponential(1), relC(Ceig2, Ceig12).toExponential(1),
    '| schur-vs-eig', relC(Csch, Ceig12).toExponential(2),
    '| |C|', Math.max(...ext.flat().map(cabs)).toExponential(2));
}
