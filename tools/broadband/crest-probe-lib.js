'use strict';
// crest-probe-lib.js — shared helpers for the crest/referee probe scripts:
// the production A matrix in the scaled-traction convention (verbatim
// psvPropagator construction), complex 4x4 linear algebra, relative norms.
const core = require('./core.js');
const cadd = core.cadd, csub = core.csub, cmul = core.cmul, cscale = core.cscale, cabs = core.cabs, cdiv = core.cdiv;

function layerA(layer, omega, k, opts) {
  const rho = layer.rhoGcm3 * 1000;
  const vsSi = layer.vsKmS * 1000, vpSi = layer.vpKmS * 1000;
  const qs = (opts && opts.qShear) || 0, qp = (opts && opts.qP) || 0;
  const muR = rho * vsSi * vsSi;
  const muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  const lam2R = rho * vpSi * vpSi;
  const lamC = [lam2R - 2 * muR, (qs > 0 ? 2 * muR / qs : 0) - (qp > 0 ? lam2R / qp : 0)];
  const lamMu = cadd(lamC, cscale(muC, 2));
  const kp = [k, 0];
  const ik = cmul(kp, [0, 1]);
  const ikLam = cmul(ik, cdiv(lamC, lamMu));
  const c1s = cdiv(csub(cmul(cmul(kp, kp), csub(lamMu, cdiv(cmul(lamC, lamC), lamMu))), [rho * omega * omega, 0]), muC);
  const w2vs2 = cdiv([-rho * omega * omega, 0], muC);
  return [
    [[0, 0], cscale(ik, -1), [1, 0], [0, 0]],
    [cscale(ikLam, -1), [0, 0], [0, 0], cdiv(muC, lamMu)],
    [c1s, [0, 0], [0, 0], cscale(ikLam, -1)],
    [[0, 0], w2vs2, cscale(ik, -1), [0, 0]]
  ];
}
function m4mul(A, B) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push([]);
    for (let j = 0; j < 4; j++) {
      let acc = [0, 0];
      for (let l = 0; l < 4; l++) acc = cadd(acc, cmul(A[i][l], B[l][j]));
      out[i].push(acc);
    }
  }
  return out;
}
function m4v(M, v) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    let acc = [0, 0];
    for (let l = 0; l < 4; l++) acc = cadd(acc, cmul(M[i][l], v[l]));
    out.push(acc);
  }
  return out;
}
function m4inv(A) {
  const n = 4;
  const aug = A.map((r, i) => r.slice().concat([[1, 0], [0, 0], [0, 0], [0, 0]].map((e, j) => (j === i ? [1, 0] : [0, 0]))));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (cabs(aug[r][col]) > cabs(aug[piv][col])) piv = r;
    const t = aug[col]; aug[col] = aug[piv]; aug[piv] = t;
    const pv = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] = cdiv(aug[col][j], pv);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      if (f[0] === 0 && f[1] === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r][j] = csub(aug[r][j], cmul(f, aug[col][j]));
    }
  }
  return aug.map((r) => r.slice(n));
}
function rel4(A, B) {
  let num = 0, den = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    num = Math.max(num, Math.hypot(A[i][j][0] - B[i][j][0], A[i][j][1] - B[i][j][1]));
    den = Math.max(den, Math.hypot(B[i][j][0], B[i][j][1]));
  }
  return den > 0 ? num / den : NaN;
}
function maxabs4(A) {
  let m = 0;
  for (const row of A) for (const v of row) m = Math.max(m, cabs(v));
  return m;
}

module.exports = { layerA, m4mul, m4v, m4inv, rel4, maxabs4, cadd, csub, cmul, cscale, cabs, cdiv };
