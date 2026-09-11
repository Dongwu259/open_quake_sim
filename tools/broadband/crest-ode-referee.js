'use strict';
// crest-ode-referee.js — independent RK4-ODE referee for the leaky-P band
// (no matrix exponential, no MGS: the odeComplianceDamped reference from
// tests/broadband-psv.test.js R10/R11, verbatim, judging three compliance
// representations on the frozen v9/v10 config).
//
// STATUS after the 2026-09-10 adjudication: TRUSTED at the 4e-3 level —
// its Richardson extrapolation (h = 1/0.5/0.25 m) matches the balanced
// eigendecomposition transport AND the exact closed-form halfspace BVP
// (crest-halfspace-closed.js) to ~4e-3 on the deep HALF config, and
// production/Schur at the shallow anchors to ~1.5e-4. Its single-shot
// rounding floor is ~1e-2·|C| there (the u/tau dynamic range), so use the
// extrapolated form for verdicts; on the tokyo column it stays reliable at
// smooth k (7.6e-3 vs Schur) but degrades inside the crest band where every
// transport representation is ill-posed.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const core = require('./core.js');
const psv = require('./psv.js');
const cadd = core.cadd, csub = core.csub, cmul = core.cmul, cscale = core.cscale, cabs = core.cabs, cdiv = core.cdiv;
function m2mul(A, B) {
  return [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
          [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
}
function m2inv(A) {
  const det = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0]));
  return [[cdiv(A[1][1], det), cscale(cdiv(A[0][1], det), -1)], [cscale(cdiv(A[1][0], det), -1), cdiv(A[0][0], det)]];
}
function odeComplianceDamped(stack, omega, k, zs, qS, qP, hM) {
  const lay = psv.prepare(stack, zs);
  function deriv(s, z) {
    // z here is METRES (the RK4 step unit); prepare()'s layer boundaries are
    // KILOMETRES — the lookup must convert or every multi-layer stack
    // silently integrates with the halfspace moduli below z = 12 m (the
    // units bug that made the first R11 draft "diverge" from production;
    // single-layer HALF anchors never noticed because one material covers
    // the whole column either way).
    const zKm = z / 1000;
    const layer = lay.layers.find((l) => zKm >= l.topKm - 1e-9 && zKm < l.bottomKm - 1e-9) || lay.layers[lay.layers.length - 1];
    const rho = layer.rhoGcm3 * 1000;
    const vp2 = rho * Math.pow(layer.vpKmS * 1000, 2), vs2 = rho * Math.pow(layer.vsKmS * 1000, 2);
    const mC = [vs2, qS > 0 ? -vs2 / qS : 0];
    // lam* = rho*vp*^2(1-i/qp) - 2 rho vs*^2 (1-i/qs)
    const lC = [vp2 - 2 * vs2, (qP > 0 ? -vp2 / qP : 0) - 2 * mC[1]];
    const lMu = [lC[0] + 2 * mC[0], lC[1] + 2 * mC[1]];
    const ik = [0, k];
    const kk2 = k * k;
    const dup = csub(cdiv(s[2], mC), cmul(ik, s[1]));
    const t0 = cmul(cmul(ik, lC), s[0]);
    const dzp = cdiv(csub(s[3], t0), lMu);
    const c1 = csub(cdiv(cmul([kk2, 0], csub(lMu, cdiv(cmul(lC, lC), lMu))), [1, 0]), [omega * omega * rho, 0]);
    const dtr = cadd(cmul(c1, s[0]), cmul(cmul(cscale(ik, -1), cdiv(lC, lMu)), s[3]));
    const dsz = csub(cmul([-omega * omega * rho, 0], s[1]), cmul(ik, s[2]));
    return [dup, dzp, dtr, dsz];
  }
  const h = hM || 2;
  let w1 = [[0, 0], [0, 0], [1, 0], [0, 0]];
  let w2 = [[0, 0], [0, 0], [0, 0], [1, 0]];
  let s1 = [[1, 0], [0, 0], [0, 0], [0, 0]];
  let s2 = [[0, 0], [1, 0], [0, 0], [0, 0]];
  const srcM = zs * 1000;
  // boundary-segmented integration: RK4 never straddles a layer boundary
  // (the flat h-grid straddled every interface and the mid-step derivative
  // mixture made |ref| swing 8x with h on the deep tokyo column)
  const bps = [...new Set(lay.layers.flatMap((l) => [l.topKm, l.bottomKm]))]
    .filter((z) => z >= 0 && z < 1e5).sort((x, y) => x - y);
  const stops = [];
  const halfTopM = lay.layers[lay.halfIndex].topKm * 1000;
  const zMaxM = Math.max(srcM, halfTopM);
  for (const z of bps) { const zm = z * 1000; if (zm > 0 && zm <= zMaxM + 1e-9 && stops[stops.length - 1] !== zm) stops.push(zm); }
  if (stops[stops.length - 1] !== srcM) stops.push(srcM);
  // MUST be monotone: with the source above the halfspace top (any layered
  // stack), srcM lands AFTER halfTopM in push order and the unsorted list
  // made the last segment integrate BACKWARD (the 2026-09-11 regression
  // that put this referee 0.8 off production on every multi-layer config
  // while every single-layer HALF validation stayed green).
  stops.sort((a, b) => a - b);
  function step(s, z0, hh) {
    const a = deriv(s, z0);
    const b = deriv(s.map((v, j) => cadd(v, cscale(a[j], hh / 2))), z0 + hh / 2);
    const c = deriv(s.map((v, j) => cadd(v, cscale(b[j], hh / 2))), z0 + hh / 2);
    const d = deriv(s.map((v, j) => cadd(v, cscale(c[j], hh))), z0 + hh);
    return s.map((v, j) => cadd(v, cscale(cadd(cadd(a[j], cscale(b[j], 2)), cadd(c[j], cscale(d[j], 2))), hh / 6)));
  }
  let z = 0;
  for (let si = 0; si < stops.length; si++) {
    const zEnd = stops[si];
    const nSteps = Math.max(1, Math.round((zEnd - z) / h));
    const hh = (zEnd - z) / nSteps;
    for (let i = 0; i < nSteps; i++) {
      const z0 = z + i * hh;
      s1 = step(s1, z0, hh); s2 = step(s2, z0, hh);
      if (z0 >= srcM - 1e-9) { w1 = step(w1, z0, hh); w2 = step(w2, z0, hh); }
      if (i % 20 === 19) {
        const mx = Math.max(...s1.flat().map(cabs), ...s2.flat().map(cabs), ...w1.flat().map(cabs), ...w2.flat().map(cabs));
        if (mx > 1e100 || mx < 1e-100) {
          const inv = 1 / mx;
          s1 = s1.map((v) => cscale(v, inv)); s2 = s2.map((v) => cscale(v, inv));
          w1 = w1.map((v) => cscale(v, inv)); w2 = w2.map((v) => cscale(v, inv));
        }
      }
    }
    z = zEnd;
  }
  // complex-nu halfspace radiation with mu* in the traction rows
  const half = lay.layers[lay.halfIndex];
  const rhoH = half.rhoGcm3 * 1000;
  const mH = [rhoH * Math.pow(half.vsKmS * 1000, 2), qS > 0 ? -rhoH * Math.pow(half.vsKmS * 1000, 2) / qS : 0];
  // nuOf convention: nu^2 = omega^2 / c*^2 - k^2, Im >= 0 — c*^2 is the
  // squared VELOCITY (m^2/s^2), not the impedance modulus
  const nuSq = (c2re, c2im) => {
    const den = c2re * c2re + c2im * c2im;
    const val = [omega * omega * c2re / den - k * k, -omega * omega * c2im / den];
    // complex sqrt, Im >= 0
    const r = Math.hypot(val[0], val[1]);
    const re = Math.sqrt((r + val[0]) / 2);
    const im = Math.sqrt((r - val[0]) / 2);
    return [re, im];
  };
  const vpSi2 = Math.pow(half.vpKmS * 1000, 2), vsSi2 = Math.pow(half.vsKmS * 1000, 2);
  const nA = nuSq(vpSi2, qP > 0 ? -vpSi2 / qP : 0);
  const nB = nuSq(vsSi2, qS > 0 ? -vsSi2 / qS : 0);
  const ik = [0, k];
  const iAv = [ -nA[1], nA[0] ], iBv = [ -nB[1], nB[0] ]; // i*nu
  const M1 = [[ik, iBv], [iAv, cscale(ik, -1)]];
  const M2 = [
    [cmul(cmul(cscale(mH, -2), nA), [k, 0]), cmul(mH, [k * k - (nB[0] * nB[0] - nB[1] * nB[1]), -2 * nB[0] * nB[1]])],
    [csub(cmul(cscale(mH, 2), [k * k, 0]), [rhoH * omega * omega, 0]), cmul(cmul(cscale(mH, 2), nB), [k, 0])]
  ];
  const det = csub(cmul(M1[0][0], M1[1][1]), cmul(M1[0][1], M1[1][0]));
  const Y = [
    [cdiv(csub(cmul(M2[0][0], M1[1][1]), cmul(M2[0][1], M1[1][0])), det), cdiv(csub(cmul(M2[0][1], M1[0][0]), cmul(M2[0][0], M1[0][1])), det)],
    [cdiv(csub(cmul(M2[1][0], M1[1][1]), cmul(M2[1][1], M1[1][0])), det), cdiv(csub(cmul(M2[1][1], M1[0][0]), cmul(M2[1][0], M1[0][1])), det)]
  ];
  const res = (s) => [csub(s[2], cadd(cmul(Y[0][0], s[0]), cmul(Y[0][1], s[1]))),
                      csub(s[3], cadd(cmul(Y[1][0], s[0]), cmul(Y[1][1], s[1])))];
  const rA0 = res(s1), rA1 = res(s2);
  const rW0 = res(w1), rW1 = res(w2);
  const m2inv = (A) => { const dd = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0])); return [[cdiv(A[1][1], dd), cscale(cdiv(A[0][1], dd), -1)], [cscale(cdiv(A[1][0], dd), -1), cdiv(A[0][0], dd)]]; };
  const m2mul = (A, B) => [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
                           [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
  const Cc = m2mul(m2inv([[rA0[0], rA1[0]], [rA0[1], rA1[1]]]), [[rW0[0], rW1[0]], [rW0[1], rW1[1]]]);
  return [[cscale(Cc[0][0], -1), cscale(Cc[0][1], -1)], [cscale(Cc[1][0], -1), cscale(Cc[1][1], -1)]];
}
Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));

module.exports = { odeComplianceDamped: odeComplianceDamped };

function main() {
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = 2 * Math.PI * 0.5, zs = 73;
const rel = (a, b) => {
  let num = 0, den = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    num = Math.max(num, Math.hypot(a[i][j][0] - b[i][j][0], a[i][j][1] - b[i][j][1]));
    den = Math.max(den, Math.hypot(b[i][j][0], b[i][j][1]));
  }
  return den > 0 ? num / den : NaN;
};
for (const kKm of [0.30, 0.44, 0.4602, 0.5067, 0.5112, 0.5187, 0.5205, 0.5242, 0.5295, 0.5320, 0.55, 0.62]) {
  const k = kKm / 1000;
  const opts = { qShear: 50, qP: 50 };
  const ref = odeComplianceDamped(stack, omega, k, zs, 50, 50);
  let leg = null, sch = null;
  try { leg = psv.psvSurfaceCompliance(stack, omega, k, zs, opts); } catch (e) {}
  try { sch = psv.psvSchurCompliance(stack, omega, k, zs, opts); } catch (e) {}
  const f = (x) => x ? rel(x, ref).toExponential(2) : 'NULL';
  const mag = Math.max(...ref.flat().map(cabs));
  console.log(kKm.toFixed(4), '|ref|', mag.toExponential(3), ' legacy-vs-ref', f(leg), ' schur-vs-ref', f(sch));
}
}

if (require.main === module) main();

