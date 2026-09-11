'use strict';
// crest-band-adjudicate.js — production-config adjudication: tokyo JIVSM
// 13-layer column, 0.5 Hz, zs = 73 km, k sweep across the leaky-P crest
// band. Four evaluations:
//   prod   psvSurfaceCompliance (expm + MGS A/W chain, production path)
//   schur  psvSchurCompliance   (admittance stepping, v11 batch)
//   eig    independent chain: canonical u-columns transported by the
//          balanced eigendecomposition propagator (validated 7e-13 vs expm
//          at HALF@1.2Hz), joint rescale, residuals at the halfspace top
//   ref    segmented RK4 referee (crest-ode-referee), Richardson ext at
//          h = 0.5/0.25 m for a subset (h = 1 m single-shot elsewhere)
// Trusted pair = { eig, ref }: every ingredient cross-validated
// (crest-referee-deep-probe.js: schur-vs-eig 1e-11, eig-vs-refext 4e-3).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const core = require('./core.js');
const psv = require('./psv.js');
const hybrid = require('./hybrid.js');
const referee = require('./crest-ode-referee.js');
const { layerA, m4mul, m4v, m4inv, rel4 } = require('./crest-probe-lib.js');
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
/** Multi-layer independent chain in the scaled-traction convention,
 *  production-isomorphic: A columns from the surface (tau=0) to the SOURCE
 *  (layers [0, iS)), then A+W together (W = canonical jump basis joined at
 *  the source) through layers [iS, halfIndex) to the halfspace top with a
 *  JOINT rescale (cancels in the residual ratio), residuals vs the
 *  halfspace admittance there, C = -exp(-sigma) Rc^-1 Rw. The above-source
 *  rescale log accumulates in sigma exactly like production's. */
function eigChainCompliance(stack, omega, k, zsKm, opts, dbgTag) {
  const st = psv.prepare(stack, zsKm);
  const sublayers = [];
  for (let i = 0; i < st.halfIndex; i++) {
    const l = st.layers[i];
    const hM = (l.bottomKm - l.topKm) * 1000;
    const nuA = psv.nuOf(l.vpKmS, omega, k, opts && opts.qP);
    const nuB = psv.nuOf(l.vsKmS, omega, k, opts && opts.qShear);
    const nMax = Math.max(cabs(nuA), cabs(nuB));
    const nSub = Math.max(1, Math.min(400, Math.ceil((nMax * hM) / 30)));
    const dh = hM / nSub;
    for (let s = 0; s < nSub; s++) sublayers.push({ i, layer: l, hM: dh });
  }
  let s1 = [[1, 0], [0, 0], [0, 0], [0, 0]];
  let s2 = [[0, 0], [1, 0], [0, 0], [0, 0]];
  let w1 = [[0, 0], [0, 0], [1, 0], [0, 0]];
  let w2 = [[0, 0], [0, 0], [0, 0], [1, 0]];
  let sigma = 0;
  for (const { i, layer, hM } of sublayers) {
    const below = i >= st.iS;
    const P = eigPropagatorScaled(layer, omega, k, hM, opts);
    s1 = m4v(P, s1);
    s2 = m4v(P, s2);
    if (below) { w1 = m4v(P, w1); w2 = m4v(P, w2); }
    const m = Math.max(...s1.map(cabs), ...s2.map(cabs),
      ...(below ? [...w1, ...w2] : []).map(cabs));
    if (!(m > 0) || !isFinite(m)) {
      console.log('  [eig ' + dbgTag + '] transport blew up at layer', i, 'm=', m);
      return null;
    }
    const inv = 1 / m;
    s1 = s1.map((v) => cscale(v, inv));
    s2 = s2.map((v) => cscale(v, inv));
    if (below) { w1 = w1.map((v) => cscale(v, inv)); w2 = w2.map((v) => cscale(v, inv)); }
    else sigma += Math.log(m);
  }
  const half = st.layers[st.halfIndex];
  const Y = psv.psvHalfspaceAdmittance(half, omega, k, opts);
  if (!Y) return null;
  const rho = half.rhoGcm3 * 1000;
  const muR = rho * Math.pow(half.vsKmS * 1000, 2);
  const qs = (opts && opts.qShear) || 0;
  const muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  const Yeff = [[cdiv(Y[0][0], muC), cdiv(Y[0][1], muC)], [cdiv(Y[1][0], muC), cdiv(Y[1][1], muC)]];
  const res = (s) => [csub(s[2], cadd(cmul(Yeff[0][0], s[0]), cmul(Yeff[0][1], s[1]))),
                      csub(s[3], cadd(cmul(Yeff[1][0], s[0]), cmul(Yeff[1][1], s[1])))];
  const iMu = cdiv([1, 0], muC);
  const rA0 = res(s1), rA1 = res(s2);
  const rW0 = res(w1), rW1 = res(w2);
  const Rc = [[rA0[0], rA1[0]], [rA0[1], rA1[1]]];
  const Rw = [[rW0[0], rW1[0]], [rW0[1], rW1[1]]];
  let Cc;
  const detRc = csub(cmul(Rc[0][0], Rc[1][1]), cmul(Rc[0][1], Rc[1][0]));
  const sRc = Math.max(...Rc.flat().map(cabs), ...Rw.flat().map(cabs));
  try { Cc = m2mul(m2inv(Rc), Rw); } catch (e) {
    console.log('  [eig ' + dbgTag + '] Rc singular: det', detRc, 'scale', sRc.toExponential(3),
      'cond~', (sRc * sRc / Math.max(cabs(detRc), 1e-300)).toExponential(2));
    return null;
  }
  if (!Cc.every((row) => row.every((v) => isFinite(v[0]) && isFinite(v[1])))) {
    console.log('  [eig ' + dbgTag + '] non-finite Cc');
    return null;
  }
  const fac = Math.exp(-sigma);
  return [[cscale(Cc[0][0], -fac), cscale(Cc[0][1], -fac)], [cscale(Cc[1][0], -fac), cscale(Cc[1][1], -fac)]];
}

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const fHz = 0.5, omega = 2 * Math.PI * fHz, zs = 73;
const opts = { qShear: 50, qP: 50 };

console.log('== tokyo JIVSM @', fHz, 'Hz zs', zs, 'km q50 — crest-band adjudication ==');
for (const kKm of [0.30, 0.44, 0.46, 0.48, 0.50, 0.5067, 0.5112, 0.5187, 0.5205, 0.5242, 0.5295, 0.5320, 0.55, 0.58, 0.62]) {
  const k = kKm / 1000;
  const Cprod = psv.psvSurfaceCompliance(stack, omega, k, zs, opts);
  const Csch = psv.psvSchurCompliance(stack, omega, k, zs, opts);
  const Ceig = eigChainCompliance(stack, omega, k, zs, opts, 'k' + kKm);
  const Cref1 = referee.odeComplianceDamped(stack, omega, k, zs, 50, 50, 1);
  const base = Ceig || Csch;
  const mag = base ? Math.max(...base.flat().map(cabs)) : NaN;
  const f = (x, b) => (x ? relC(x, b).toExponential(2) : 'NULL');
  console.log('k', kKm.toFixed(4),
    '| prod-vs-eig', f(Cprod, Ceig),
    '| schur-vs-eig', f(Csch, Ceig),
    '| ref1-vs-eig', f(Cref1, Ceig),
    '| schur-vs-ref', f(Csch, Cref1),
    '| |C|', mag.toExponential(3));
}
