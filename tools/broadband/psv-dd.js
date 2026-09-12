'use strict';
// =====================================================================
// psv-dd.js — double-double (compensated) arithmetic port of the Schur
// compliance chain (2026-09-12, DD batch — the v13 registered cure).
//
// WHY: the v13 chaos diagnosis (psv-scale-diagnosis v13) measured the
// chain-evaluated crest band at ZERO stable digits — a 1-ulp k-perturbation
// moves the integrand O(1) — with the mechanism pinned to detM sitting at
// ~1e-16*|M|^2 (cond(M) ~ 1e16): the 2x2 determinant cancellation noise IS
// the output scale. Roundoff enters at eps = 1e-16 and the amplification
// is fixed by the physics (the near-singular up-leg inversions), so the
// only cure is a smaller eps: double-double arithmetic (eps ~ 1e-32, no
// FMA needed — Dekker/Knuth algorithms) drops the crest-band output chaos
// to ~1e-16 relative and restores a resolvable field.
//
// SCOPE: the full Schur path in DD — nuOf, the halfspace eigenvector
// admittance, the expm propagator (with the mu* back-transform), the
// above-source jointly-scaled product, and C = -e^-sigma (Y*Q11 - Q21)^-1.
// Material products are formed in DD from the double inputs (exact
// two-products). Layer thickness is handled by expm4's adaptive scaling —
// no subdivision, exactly like the double Schur path. The result
// is rounded back to doubles — everything downstream (complianceTriple's
// depth FD, the integrand) runs unchanged.
//
// ACCEPTANCE (the v13 gate): the 1-ulp discriminator must go quiet at the
// crest — swings <= 1e-12 at 1 ulp. MEASURED 2026-09-12 (probe v14): the
// gate PASSES at k = 0.80/km (1-ulp chaos -76% -> 2.9e-5%) and the control
// band sits at DD-noise level (1e-13%, agreeing with the double path to
// 1.2e-11 relative), but k = 0.70/0.73/0.76 STAY chaotic (O(10-600%) at
// 1 ulp): the up-leg admittance step det(P22 - Y*P12) carries a STRUCTURAL
// cancellation of ~1.4e31 there (the recursion crosses the below-source
// subsystem's near-resonance while the P wave traverses the 190-km mantle
// layer evanescently, e^{+-114}), on top of detM's own ~1e16 — a total
// amplification ~1e47 that consumes DD's 1e-32 exactly. The per-layer
// propagator normalization in the up-leg (algebraically free: Y is
// invariant under P -> alpha*P) removes the e^{+-114} SCALE but not the
// structural cancellation. Registered cure: quad-double arithmetic
// (eps ~ 1e-64 -> output noise ~1e-17, margin 4+ orders). Bit-exact
// invariance is NOT the gate: the TRUE compliance moves by ~1e-17/ulp
// near a pole, so the rounded doubles may flip at the 1e-16 level even
// with perfect arithmetic.
// =====================================================================
const P = require('./psv.js');

// ---- DD real primitives (hi/lo pairs, QD-style, no FMA) ----------------
const SPLITTER = 134217729; // 2^27 + 1
const LN2_HI = 0.6931471805599453, LN2_LO = 2.3190468138462996e-17;

function toDD(x) { return [x, 0]; }
function ddToNumber(a) { return a[0] + a[1]; }
function twoSum(a, b) {
  const s = a + b, bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}
function quickTwoSum(a, b) {
  const s = a + b;
  return [s, b - (s - a)];
}
function splitD(a) {
  const t = SPLITTER * a, hi = t - (t - a);
  return [hi, a - hi];
}
function twoProdErr(a, b, p) {
  const ah = splitD(a), bh = splitD(b);
  return ((ah[0] * bh[0] - p) + ah[0] * bh[1] + ah[1] * bh[0]) + ah[1] * bh[1];
}
function ddAdd(a, b) {
  let s, e;
  { const r = twoSum(a[0], b[0]); s = r[0]; e = r[1]; }
  let t, f;
  { const r = twoSum(a[1], b[1]); t = r[0]; f = r[1]; }
  e += t;
  { const r = quickTwoSum(s, e); s = r[0]; e = r[1]; }
  e += f;
  return quickTwoSum(s, e);
}
function ddSub(a, b) { return ddAdd(a, [-b[0], -b[1]]); }
function ddNeg(a) { return [-a[0], -a[1]]; }
function ddMul(a, b) {
  const p = a[0] * b[0];
  const e = twoProdErr(a[0], b[0], p) + a[0] * b[1] + a[1] * b[0];
  return quickTwoSum(p, e);
}
function ddDiv(a, b) {
  const q1 = a[0] / b[0];
  // r = a - b*q1 (dd)
  let r = ddSub(a, ddMul(b, [q1, 0]));
  const q2 = r[0] / b[0];
  r = ddSub(r, ddMul(b, [q2, 0]));
  const q3 = r[0] / b[0];
  let s = quickTwoSum(q1, q2);
  return quickTwoSum(s[0], s[1] + q3);
}
function ddSqrt(a) {
  if (a[0] === 0 && a[1] === 0) return [0, 0];
  const s = Math.sqrt(a[0]);
  const tp = (function () { const p = s * s; return [p, twoProdErr(s, s, p)]; })();
  const r = ddSub(a, tp);
  return quickTwoSum(s, r[0] / (2 * s));
}
function ddScalePow2(a, n) { return [a[0] * Math.pow(2, n), a[1] * Math.pow(2, n)]; }
function ddAbs(a) { return a[0] < 0 || (a[0] === 0 && a[1] < 0) ? ddNeg(a) : a; }
function ddLog(a) {
  // a > 0; log(a) = log(m) + e*ln2 with m = a/2^e in [sqrt(1/2), sqrt(2)),
  // log(m) = 2*atanh((m-1)/(m+1)) (|u| <= sqrt(2)-1 ~ 0.414 -> wait:
  // m in [0.707, 1.414) => u in [-0.1716, 0.1716]); 25 odd terms give
  // u^49/49 ~ 1e-37.
  let e = Math.floor(Math.log2(a[0]));
  let m = ddScalePow2(a, -e);
  if (m[0] >= 1.4142135623730951) { m = ddScalePow2(m, -1); e++; }
  else if (m[0] < 0.7071067811865476) { m = ddScalePow2(m, 1); e--; }
  const u = ddDiv(ddSub(m, [1, 0]), ddAdd(m, [1, 0]));
  const u2 = ddMul(u, u);
  let term = u, sum = [0, 0];
  for (let k = 1; k <= 49; k += 2) {
    sum = ddAdd(sum, ddDiv(term, [k, 0]));
    term = ddMul(term, u2);
  }
  sum = ddAdd(sum, sum);
  return ddAdd(sum, ddMul([e, 0], [LN2_HI, LN2_LO]));
}
function ddExp(a) {
  const n = Math.round(a[0] / LN2_HI);
  const r = ddSub(a, ddMul([n, 0], [LN2_HI, LN2_LO]));
  let term = [1, 0], sum = [1, 0];
  for (let k = 1; k <= 24; k++) {
    term = ddDiv(ddMul(term, r), [k, 0]);
    sum = ddAdd(sum, term);
  }
  return ddScalePow2(sum, n);
}

// ---- complex DD ([[reh,rel],[imh,iml]]) --------------------------------
function cdd(re, im) { return [re, im]; }
function cddAdd(a, b) { return [ddAdd(a[0], b[0]), ddAdd(a[1], b[1])]; }
function cddSub(a, b) { return [ddSub(a[0], b[0]), ddSub(a[1], b[1])]; }
function cddNeg(a) { return [ddNeg(a[0]), ddNeg(a[1])]; }
function cddScale(a, s) { return [ddMul(a[0], s), ddMul(a[1], s)]; }
function cddMul(a, b) {
  return [ddSub(ddMul(a[0], b[0]), ddMul(a[1], b[1])),
          ddAdd(ddMul(a[0], b[1]), ddMul(a[1], b[0]))];
}
function cddAbs(a) { return ddSqrt(ddAdd(ddMul(a[0], a[0]), ddMul(a[1], a[1]))); }
function cddDiv(a, b) {
  const den = ddAdd(ddMul(b[0], b[0]), ddMul(b[1], b[1]));
  return [ddDiv(ddAdd(ddMul(a[0], b[0]), ddMul(a[1], b[1])), den),
          ddDiv(ddSub(ddMul(a[1], b[0]), ddMul(a[0], b[1])), den)];
}
/** sqrt with Im(result) >= 0 — the exact csqrtPosIm convention (core.js):
 *  principal Smith sqrt, negated when the imaginary part comes out < 0.
 *  On the real-k production path Im(nu^2) >= 0 always, so this agrees with
 *  the principal branch; the flip is kept for branch fidelity. */
function cddSqrtPosIm(z) {
  const az = cddAbs(z);
  let re, im;
  if (z[0][0] >= 0) {
    const t = ddSqrt(ddMul(ddAdd(az, z[0]), [0.5, 0]));
    re = t; im = ddDiv(z[1], ddAdd(t, t));
  } else {
    const t = ddSqrt(ddMul(ddSub(az, z[0]), [0.5, 0]));
    re = ddDiv(ddAbs(z[1]), ddAdd(t, t));
    im = z[1][0] < 0 || (z[1][0] === 0 && z[1][1] < 0) ? ddNeg(t) : t;
  }
  if (im[0] < 0 || (im[0] === 0 && im[1] < 0 && re[0] < 0)) return [ddNeg(re), ddNeg(im)];
  return [re, im];
}
const CDD0 = [[0, 0], [0, 0]], CDD1 = [[1, 0], [0, 0]];
function cddFinite(a) {
  return isFinite(a[0][0] + a[0][1] + a[1][0] + a[1][1]);
}

// ---- 2x2 / 4x4 complex-DD matrix helpers -------------------------------
function m2mulDD(A, B) {
  return [[cddAdd(cddMul(A[0][0], B[0][0]), cddMul(A[0][1], B[1][0])),
           cddAdd(cddMul(A[0][0], B[0][1]), cddMul(A[0][1], B[1][1]))],
          [cddAdd(cddMul(A[1][0], B[0][0]), cddMul(A[1][1], B[1][0])),
           cddAdd(cddMul(A[1][0], B[0][1]), cddMul(A[1][1], B[1][1]))]];
}
function m2invDD(A) {
  const det = cddSub(cddMul(A[0][0], A[1][1]), cddMul(A[0][1], A[1][0]));
  if (ddToNumber(cddAbs(det)) < 1e-300) throw new Error('psv-dd: singular 2x2');
  return [[cddDiv(A[1][1], det), cddScale(cddDiv(A[0][1], det), [-1, 0])],
          [cddScale(cddDiv(A[1][0], det), [-1, 0]), cddDiv(A[0][0], det)]];
}
function m4mulDD(A, B) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      let s = CDD0;
      for (let l = 0; l < 4; l++) s = cddAdd(s, cddMul(A[i][l], B[l][j]));
      row.push(s);
    }
    out.push(row);
  }
  return out;
}
function m4maxabsDD(A) {
  let m = [0, 0]; // REAL dd zero — a complex here would poison ddToNumber comparisons
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const a = cddAbs(A[i][j]);
    if (ddToNumber(a) > ddToNumber(m)) m = a;
  }
  return m;
}

// ---- DD ports of the psv chain pieces ----------------------------------
const CDDI = [[0, 0], [1, 0]]; // i

/** nu_c = sqrt(w^2/c*^2 - k^2), Im >= 0 — psv.nuOf in DD (exact same
 *  expression structure; the material products are exact two-products). */
function nuOfDD(vKmS, omega, kInvM, q) {
  const b = toDD(vKmS * 1000);
  const b2re = ddMul(b, b);
  const b2im = (q && q > 0) ? ddNeg(ddDiv(b2re, [q, 0])) : [0, 0];
  const om2 = ddMul(toDD(omega), toDD(omega));
  const k = toDD(kInvM);
  const k2re = ddMul(k, k);
  const den = ddAdd(ddMul(b2re, b2re), ddMul(b2im, b2im));
  const val = cddSub(cdd(ddDiv(ddMul(om2, b2re), den), ddNeg(ddDiv(ddMul(om2, b2im), den))),
                     cdd(k2re, [0, 0]));
  return cddSqrtPosIm(val);
}

/** Eigenvector matrix (P down, P up, SV down, SV up) x (u_r, u_z, tau_rz,
 *  s_zz) in DD — psv.psvEigenvectors with complex mu* traction rows. */
function psvEigenvectorsDD(layer, omega, k, opts) {
  const qs = (opts && opts.qShear) || 0;
  const rho = toDD(layer.rhoGcm3 * 1000);
  const vs = toDD(layer.vsKmS * 1000);
  const muR = ddMul(rho, ddMul(vs, vs));
  const mu = qs > 0 ? cdd(muR, ddNeg(ddDiv(muR, [qs, 0]))) : cdd(muR, [0, 0]);
  const nuA = nuOfDD(layer.vpKmS, omega, k, opts && opts.qP);
  const nuB = nuOfDD(layer.vsKmS, omega, k, qs);
  const kk = toDD(k);
  const ik = cddMul(cdd(kk, [0, 0]), CDDI);
  const iA = cddMul(nuA, CDDI), iB = cddMul(nuB, CDDI);
  const szP = cddSub(cddMul(cddMul(cddScale(mu, [2, 0]), cdd(kk, [0, 0])), cdd(kk, [0, 0])),
                     cdd(ddMul(rho, ddMul(toDD(omega), toDD(omega))), [0, 0]));
  const svs = cddMul(mu, cddSub(cddMul(cdd(kk, [0, 0]), cdd(kk, [0, 0])), cddMul(nuB, nuB)));
  const m2kA = cddMul(cddMul(cddScale(mu, [-2, 0]), nuA), cdd(kk, [0, 0]));
  const p2kA = cddMul(cddMul(cddScale(mu, [2, 0]), nuA), cdd(kk, [0, 0]));
  const m2kB = cddMul(cddMul(cddScale(mu, [2, 0]), nuB), cdd(kk, [0, 0]));
  return [
    [ik, ik, iB, cddScale(iB, [-1, 0])],
    [iA, cddScale(iA, [-1, 0]), cddScale(ik, [-1, 0]), cddScale(ik, [-1, 0])],
    [m2kA, p2kA, svs, svs],
    [szP, szP, m2kB, cddScale(m2kB, [-1, 0])]
  ];
}

/** Halfspace downgoing admittance tau = Y u in DD. */
function hsAdmittanceDD(layer, omega, k, opts) {
  const E = psvEigenvectorsDD(layer, omega, k, opts);
  const M1 = [[E[0][0], E[0][2]], [E[1][0], E[1][2]]];
  const M2 = [[E[2][0], E[2][2]], [E[3][0], E[3][2]]];
  return m2mulDD(M2, m2invDD(M1));
}

/** exp(A*h) scaling-and-squaring + 24-term Taylor in DD (psv.expm4 port;
 *  the scaling count comes from the double hi of the row-sum norm — the
 *  count only chooses a power-of-two split, it is not precision-bearing). */
function expm4DD(A, h) {
  let norm = 0;
  for (let i = 0; i < 4; i++) {
    let rowSum = 0;
    for (let j = 0; j < 4; j++) rowSum += ddToNumber(cddAbs(A[i][j]));
    if (rowSum > norm) norm = rowSum;
  }
  let s = 0;
  while (norm * h > 0.25) { s++; norm /= 2; }
  const hS = toDD(h / Math.pow(2, s)); // exact power-of-two scaling of h
  const B = A.map((row) => row.map((e) => cddScale(e, hS)));
  let sum = [[CDD1, CDD0, CDD0, CDD0], [CDD0, CDD1, CDD0, CDD0],
             [CDD0, CDD0, CDD1, CDD0], [CDD0, CDD0, CDD0, CDD1]];
  let term = sum.map((r) => r.slice());
  for (let n = 1; n <= 24; n++) {
    const next = [];
    for (let i = 0; i < 4; i++) {
      const row = [];
      for (let j = 0; j < 4; j++) {
        let acc = CDD0;
        for (let l = 0; l < 4; l++) acc = cddAdd(acc, cddMul(term[i][l], B[l][j]));
        row.push(cddScale(acc, ddDiv([1, 0], [n, 0])));
      }
      next.push(row);
    }
    term = next;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) sum[i][j] = cddAdd(sum[i][j], term[i][j]);
  }
  for (let q = 0; q < s; q++) sum = m4mulDD(sum, sum);
  return sum;
}

/** Layer propagator P = exp(A h) with the mu* traction back-transform, DD
 *  port of psv.psvPropagator (same A construction, same conventions). */
function propagatorDD(layer, omega, k, opts) {
  const h = (layer.bottomKm - layer.topKm) * 1000;
  const rho = toDD(layer.rhoGcm3 * 1000);
  const vsSi = toDD(layer.vsKmS * 1000), vpSi = toDD(layer.vpKmS * 1000);
  const qs = (opts && opts.qShear) || 0, qp = (opts && opts.qP) || 0;
  const muR = ddMul(rho, ddMul(vsSi, vsSi));
  const muC = qs > 0 ? cdd(muR, ddNeg(ddDiv(muR, [qs, 0]))) : cdd(muR, [0, 0]);
  const lam2R = ddMul(rho, ddMul(vpSi, vpSi));
  const lamC = cdd(ddSub(lam2R, ddMul(muR, [2, 0])),
                   ddSub(qs > 0 ? ddMul(muR, ddDiv([2, 0], [qs, 0])) : [0, 0],
                         qp > 0 ? ddDiv(lam2R, [qp, 0]) : [0, 0]));
  const lamMu = cddAdd(lamC, cddScale(muC, [2, 0]));
  const kk = cdd(toDD(k), [0, 0]);
  const ik = cddMul(kk, CDDI);
  const ikLam = cddMul(ik, cddDiv(lamC, lamMu));
  const c1s = cddDiv(cddSub(cddMul(cddMul(kk, kk),
                                   cddSub(lamMu, cddDiv(cddMul(lamC, lamC), lamMu))),
                            cdd(ddMul(rho, ddMul(toDD(omega), toDD(omega))), [0, 0])), muC);
  const w2vs2 = cddDiv(cdd(ddNeg(ddMul(rho, ddMul(toDD(omega), toDD(omega)))), [0, 0]), muC);
  const A = [
    [CDD0, cddScale(ik, [-1, 0]), CDD1, CDD0],
    [cddScale(ikLam, [-1, 0]), CDD0, CDD0, cddDiv(muC, lamMu)],
    [c1s, CDD0, CDD0, cddScale(ikLam, [-1, 0])],
    [CDD0, w2vs2, cddScale(ik, [-1, 0]), CDD0]
  ];
  const P = expm4DD(A, h);
  const muCinv = cddDiv(CDD1, muC);
  const out = [];
  for (let i = 0; i < 4; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      let v = P[i][j];
      if (i >= 2) v = cddMul(v, muC);
      if (j >= 2) v = cddMul(v, muCinv);
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

function roundC(c) { return [ddToNumber(c[0]), ddToNumber(c[1])]; }
function roundM2(M) { return [[roundC(M[0][0]), roundC(M[0][1])], [roundC(M[1][0]), roundC(M[1][1])]]; }

/** psv.psvSchurCompliance in double-double arithmetic — same structure,
 *  same guards, same subdivision lattice (the double path's), same return
 *  shapes ([re,im] doubles; _wantDet adds the rounded detM). */
function schurComplianceDD(stack, omega, kInvM, zKm, opts) {
  const dbg = typeof process !== 'undefined' && process.env.PSV_DD_DBG;
  const trace = (msg) => { if (dbg) console.error('PSV_DD_DBG ' + msg); };
  const st = P.prepare(stack, zKm);
  // NO subdivision (exactly like psv.psvSchurCompliance): expm4's adaptive
  // scaling-and-squaring handles any layer thickness.
  const lay = st.layers;
  const k = toDD(kInvM);
  // ---- up-leg: admittance from the halfspace top to the source depth ----
  let Y = hsAdmittanceDD(lay[st.halfIndex], omega, kInvM, opts);
  if (!Y) { trace('halfspace admittance null'); return null; }
  for (let i = st.halfIndex - 1; i >= st.iS; i--) {
    let Pd = propagatorDD(lay[i], omega, kInvM, opts);
    // Per-layer normalization: the admittance recursion Y -> S*(Y*P11 - P21)
    // is INVARIANT under P -> alpha*P (S -> S/alpha, rhs -> alpha*rhs), so
    // scaling each layer's propagator by 1/max|P| is algebraically free and
    // removes the e^{+Im(nu)*h} evanescent growth (up to e^{+-114} on the
    // 190-km mantle layer at the crest band) whose raw-scale subtraction
    // det(P22 - Y*P12) measured cancellation ~2e31 — beyond even DD.
    const pmax = m4maxabsDD(Pd);
    if (!(ddToNumber(pmax) > 0) || !isFinite(ddToNumber(pmax))) { trace('up-leg P scale bad at layer ' + i); return null; }
    const pinv = ddDiv([1, 0], pmax);
    Pd = Pd.map((row) => row.map((e) => cddScale(e, pinv)));
    const P22 = [[Pd[2][2], Pd[2][3]], [Pd[3][2], Pd[3][3]]];
    const P12 = [[Pd[0][2], Pd[0][3]], [Pd[1][2], Pd[1][3]]];
    const P11 = [[Pd[0][0], Pd[0][1]], [Pd[1][0], Pd[1][1]]];
    const P21 = [[Pd[2][0], Pd[2][1]], [Pd[3][0], Pd[3][1]]];
    const YP12 = m2mulDD(Y, P12), YP11 = m2mulDD(Y, P11);
    let S;
    try {
      S = m2invDD([[cddSub(P22[0][0], YP12[0][0]), cddSub(P22[0][1], YP12[0][1])],
                   [cddSub(P22[1][0], YP12[1][0]), cddSub(P22[1][1], YP12[1][1])]]);
    } catch (e) { trace('up-leg S singular at layer ' + i); return null; }
    const rhs = [[cddSub(YP11[0][0], P21[0][0]), cddSub(YP11[0][1], P21[0][1])],
                 [cddSub(YP11[1][0], P21[1][0]), cddSub(YP11[1][1], P21[1][1])]];
    Y = m2mulDD(S, rhs);
    if (!Y || !cddFinite(Y[0][0]) || !cddFinite(Y[1][1])) { trace('up-leg Y non-finite at layer ' + i); return null; }
  }
  // ---- above-source propagator product with joint scalar scaling --------
  let Q = [[CDD1, CDD0, CDD0, CDD0], [CDD0, CDD1, CDD0, CDD0],
           [CDD0, CDD0, CDD1, CDD0], [CDD0, CDD0, CDD0, CDD1]];
  let sigma = [0, 0];
  for (let i2 = 0; i2 < st.iS; i2++) {
    Q = m4mulDD(propagatorDD(lay[i2], omega, kInvM, opts), Q);
    const s = m4maxabsDD(Q);
    if (!(ddToNumber(s) > 0) || !isFinite(ddToNumber(s))) { trace('Q scale bad at layer ' + i2); return null; }
    const inv = ddDiv([1, 0], s);
    for (let r2 = 0; r2 < 4; r2++) for (let c2 = 0; c2 < 4; c2++) Q[r2][c2] = cddScale(Q[r2][c2], inv);
    sigma = ddAdd(sigma, ddLog(s));
  }
  const sig = ddToNumber(sigma);
  if (!(sig > -650) || !(sig < 650)) { trace('sigma out of range: ' + sig); return null; }
  const Q11 = [[Q[0][0], Q[0][1]], [Q[1][0], Q[1][1]]];
  const Q21 = [[Q[2][0], Q[2][1]], [Q[3][0], Q[3][1]]];
  let M = m2mulDD(Y, Q11);
  M = [[cddSub(M[0][0], Q21[0][0]), cddSub(M[0][1], Q21[0][1])],
       [cddSub(M[1][0], Q21[1][0]), cddSub(M[1][1], Q21[1][1])]];
  const detM = cddSub(cddMul(M[0][0], M[1][1]), cddMul(M[0][1], M[1][0]));
  let C;
  try { C = m2invDD(M); } catch (e) { trace('M inversion failed: detM ' + ddToNumber(cddAbs(detM))); return opts && opts._wantDet ? { C: null, detM: roundC(detM) } : null; }
  const fac = ddExp(ddNeg(sigma));
  if (dbg) trace('sigma ' + ddToNumber(sigma) + ' |detM| ' + ddToNumber(cddAbs(detM)) + ' |C00| ' + ddToNumber(cddAbs(C[0][0])) + ' fac ' + ddToNumber(fac));
  const out = roundM2([[cddScale(C[0][0], fac), cddScale(C[0][1], fac)],
                        [cddScale(C[1][0], fac), cddScale(C[1][1], fac)]]);
  for (let i3 = 0; i3 < 2; i3++) for (let j3 = 0; j3 < 2; j3++) {
    if (!isFinite(out[i3][j3][0] + out[i3][j3][1])) {
      if (dbg) trace('C non-finite [' + i3 + '][' + j3 + ']: ' + out[i3][j3][0] + ' + ' + out[i3][j3][1]);
      return opts && opts._wantDet ? { C: out, detM: roundC(detM) } : null;
    }
  }
  if (opts && opts._wantDet) return { C: out, detM: roundC(detM) };
  return out;
}

/** Diagnostic: the max cancellation |terms|/|det| over the up-leg admittance
 *  step dets det(P22 - Y*P12), with the production per-layer normalization.
 *  The v14 blocker measurement: ~1.4e31 at k = 0.70-0.76/km on the tokyo
 *  config (vs ~O(10-100) at smooth k) — this is the arithmetic-precision
 *  budget any chain evaluation must beat at the crest. Returns
 *  { worst, brokeAt } (brokeAt = the layer index where Y went non-finite,
 *  or null). */
function upLegStepCancellation(stack, omega, kInvM, zKm, opts) {
  const st = P.prepare(stack, zKm);
  let Y = hsAdmittanceDD(st.layers[st.halfIndex], omega, kInvM, opts);
  if (!Y) return null;
  let worst = 0;
  for (let i = st.halfIndex - 1; i >= st.iS; i--) {
    let Pd = propagatorDD(st.layers[i], omega, kInvM, opts);
    const pmax = m4maxabsDD(Pd);
    const pinv = ddDiv([1, 0], pmax);
    Pd = Pd.map((row) => row.map((e) => cddScale(e, pinv)));
    const P22 = [[Pd[2][2], Pd[2][3]], [Pd[3][2], Pd[3][3]]];
    const P12 = [[Pd[0][2], Pd[0][3]], [Pd[1][2], Pd[1][3]]];
    const P11 = [[Pd[0][0], Pd[0][1]], [Pd[1][0], Pd[1][1]]];
    const P21 = [[Pd[2][0], Pd[2][1]], [Pd[3][0], Pd[3][1]]];
    const YP12 = m2mulDD(Y, P12);
    const D = [[cddSub(P22[0][0], YP12[0][0]), cddSub(P22[0][1], YP12[0][1])],
               [cddSub(P22[1][0], YP12[1][0]), cddSub(P22[1][1], YP12[1][1])]];
    const t1 = cddAbs(cddMul(D[0][0], D[1][1])), t2 = cddAbs(cddMul(D[0][1], D[1][0]));
    const det = cddSub(cddMul(D[0][0], D[1][1]), cddMul(D[0][1], D[1][0]));
    const scale = Math.max(ddToNumber(t1), ddToNumber(t2));
    const cancel = scale / (ddToNumber(cddAbs(det)) || 1e-300);
    if (cancel > worst) worst = cancel;
    let S;
    try { S = m2invDD(D); } catch (e) { return { worst: worst, brokeAt: i }; }
    const YP11 = m2mulDD(Y, P11);
    const rhs = [[cddSub(YP11[0][0], P21[0][0]), cddSub(YP11[0][1], P21[0][1])],
                 [cddSub(YP11[1][0], P21[1][0]), cddSub(YP11[1][1], P21[1][1])]];
    Y = m2mulDD(S, rhs);
    if (!Y || !cddFinite(Y[0][0]) || !cddFinite(Y[1][1])) return { worst: worst, brokeAt: i };
  }
  return { worst: worst, brokeAt: null };
}

module.exports = {
  schurComplianceDD: schurComplianceDD,
  upLegStepCancellation: upLegStepCancellation,
  // internals exported for the test anchors and cross-checks
  propagatorDD: propagatorDD, hsAdmittanceDD: hsAdmittanceDD,
  psvEigenvectorsDD: psvEigenvectorsDD, expm4DD: expm4DD,
  // primitives exported for the test anchors
  dd: {
    toDD: toDD, ddToNumber: ddToNumber, ddAdd: ddAdd, ddSub: ddSub, ddMul: ddMul,
    ddDiv: ddDiv, ddSqrt: ddSqrt, ddLog: ddLog, ddExp: ddExp, ddNeg: ddNeg,
    cddAdd: cddAdd, cddSub: cddSub, cddMul: cddMul, cddDiv: cddDiv, cddAbs: cddAbs,
    cddScale: cddScale, cddSqrtPosIm: cddSqrtPosIm, nuOfDD: nuOfDD
  }
};
