'use strict';
// crest-eig-vs-expm.js — SAME-convention propagator comparison: production
// psvPropagator output (TRUE traction) transformed back to the SCALED
// convention (rows 2,3 / mu*, cols 2,3 x mu*) vs the balanced
// eigendecomposition exp(A_scaled h). Plus semigroup checks for both.
const psv = require('./psv.js');
const core = require('./core.js');
const { layerA, m4mul, m4inv, rel4, maxabs4 } = require('./crest-probe-lib.js');
const cadd = core.cadd, csub = core.csub, cmul = core.cmul, cscale = core.cscale, cabs = core.cabs, cdiv = core.cdiv;

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
/** production propagator output converted to the scaled-traction state. */
function prodPropagatorScaled(layer, omega, k, opts) {
  const P = psv.psvPropagator(layer, omega, k, opts);
  const rho = layer.rhoGcm3 * 1000;
  const muR = rho * Math.pow(layer.vsKmS * 1000, 2);
  const qs = (opts && opts.qShear) || 0;
  const muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  const iMu = cdiv([1, 0], muC);
  return P.map((row, i) => row.map((v, j) => {
    let o = v;
    if (i >= 2) o = cmul(o, iMu);
    if (j >= 2) o = cmul(o, muC);
    return o;
  }));
}

const HALF = { topKm: 0, bottomKm: 73, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 };
const omega = 2 * Math.PI * 1.2, opts = { qShear: 50, qP: 50 }, k = 0.2e-3;
for (const hSub of [12166.7, 4000, 1000, 100]) {
  const layH = { topKm: 0, bottomKm: hSub / 1000, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 };
  const layH2 = { topKm: 0, bottomKm: hSub / 2000, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 };
  const Pexp = prodPropagatorScaled(layH, omega, k, opts);
  const PexpH = prodPropagatorScaled(layH2, omega, k, opts);
  const Peig = eigPropagatorScaled(HALF, omega, k, hSub, opts);
  const PeigH = eigPropagatorScaled(HALF, omega, k, hSub / 2, opts);
  console.log('h', hSub.toFixed(0), 'm',
    '| exp-vs-eig', rel4(Pexp, Peig).toExponential(2),
    '| exp-sg', rel4(m4mul(PexpH, PexpH), Pexp).toExponential(2),
    '| eig-sg', rel4(m4mul(PeigH, PeigH), Peig).toExponential(2),
    '| maxExp', maxabs4(Pexp).toExponential(2), 'maxEig', maxabs4(Peig).toExponential(2));
}
