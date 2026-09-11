'use strict';
// crest-det-subtract.js — analytic pole-model subtraction experiment
// (v2, 2026-09-11; the v1 complex-Newton det prototype is retired — this
// batch measured that BOTH chain determinants are Newton-hostile on the
// tokyo stack: the Schur up-leg admittance step det crosses zero AT the
// modal poles so complex-k evaluations null around every hunt point, and
// the raw cascade det Newton was the registered v4 failure).
//
// The production machinery now lives in psv.js (psvPoleModelFit +
// params.detSubtract in psvMomentSpectrumAtFrequency): each modal pole is
// fitted as A_c/(k - kp) + B_c per integrand channel ENTIRELY on real-axis
// samples (2-param Nelder-Mead on (kr, ln gamma) x both Im-kp signs, inner
// conjugated complex LS), its gamma-resolved window is dropped, the
// subtracted remainder is integrated by the plain two-zone lattice, and the
// exact principal-branch complex-log pole integrals are re-added over the
// lattice's own interval. Fitted-but-failed poles keep their windows.
//
// This driver:
//   1. self-tests the whole pipeline against a CLOSED-FORM integrand
//      A/(k-kp)+B+C e^{-lambda k} on a lattice that deliberately
//      under-resolves the pole (plain trapezoid fails, subtracted matches
//      the analytic integral);
//   2. prints the real fit table (kp, gamma, rel, |A| per channel) for the
//      frozen tokyo config;
//   3. measures the Schur-arm dk series with and without detSubtract
//      (frozen plain values 194.41/194.41/194.41/523.05/679.98/540.93
//      fullTensor, 0.0178..0.0089 deviatoric — the v11 non-convergence).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const core = require('./core.js');
const hybrid = require('./hybrid.js');
const psv = require('./psv.js');
const { cadd, csub, cmul, cscale, cabs, cdiv } = core;

const mag = (c) => Math.hypot(c[0], c[1]);

// ---------------------------------------------------------------------------
// 1. synthetic closed-form self-test
// ---------------------------------------------------------------------------
(function selfTest() {
  const kp = [1.005e-3, 2.6e-5]; // 1/m (pole ABOVE axis; both signs fitted)
  const Ch = {
    ur: { A: [3.2, -1.1], B: [0.30, 0.12], C: [0.20, 0.10] },
    uz: { A: [-1.7, 0.9], B: [0.21, -0.05], C: [0.11, 0.04] },
    ut: { A: [0.8, 2.2], B: [0.15, 0.30], C: [0.07, -0.02] }
  };
  const lam = 300; // 1/m smooth decay
  const om2 = 2 * Math.PI * 0.5;
  let nEval = 0;
  function gOf(k) {
    nEval++;
    if (nEval % 7 === 0) return null; // exercise the null-sample path
    const out = {};
    for (const ch of Object.keys(Ch)) {
      const c = Ch[ch];
      let g = cadd(cadd(cdiv(c.A, csub([k, 0], kp)), c.B),
                   cscale(c.C, Math.exp(-lam * k)));
      out[ch] = g;
    }
    return out;
  }
  const cand = { k: 1.005, gammaKm: 0.06 }; // initial width guess 2.3x too big
  const fit = psv.psvPoleModelFit([], om2, cand, { qShear: 50 }, gOf);
  if (!fit) { console.log('SELF-TEST FAIL: no fit'); process.exit(1); }
  const dKr = Math.abs(fit.kp[0] - kp[0]) / kp[0];
  const dGam = Math.abs(fit.kp[1] - kp[1]) / kp[1];
  console.log('self-test fit: kp', fit.kp[0].toExponential(6), '+', fit.kp[1].toExponential(3), 'i  rel', fit.rel.toExponential(3),
    ' (dKr', dKr.toExponential(2), ', dGam', dGam.toExponential(2), ', samples', fit.n + ')');
  if (fit.rel > 0.02 || dKr > 1e-4 || dGam > 0.25) { console.log('SELF-TEST FAIL: fit off'); process.exit(1); }

  // integration: uniform lattice under-resolving the pole
  const k0 = 2e-7, K = 5e-3;
  function exact(ch) {
    const c = Ch[ch];
    const I = csub(cmul(c.A, psv.clog(csub([K, 0], kp))), cmul(c.A, psv.clog(csub([k0, 0], kp))));
    const lin = cscale(c.B, K - k0);
    const sm = cscale(c.C, (Math.exp(-lam * k0) - Math.exp(-lam * K)) / lam);
    return cadd(cadd(I, lin), sm);
  }
  function runLattice(dk) {
    const pts = [];
    for (let k = k0; k <= K + 1e-15; k += dk) pts.push(k);
    const sums = { ur: [0, 0], uz: [0, 0], ut: [0, 0] };
    for (const variant of ['plain', 'sub']) {
      sums.ur = [0, 0]; sums.uz = [0, 0]; sums.ut = [0, 0];
      const vals = pts.map((k) => {
        let g = gOf(k);
        if (g && variant === 'sub') {
          const w = cdiv([1, 0], csub([k, 0], fit.kp));
          for (const ch of Object.keys(Ch)) g[ch] = csub(g[ch], cmul(fit.A[ch], w));
        }
        return g;
      });
      for (let i = 0; i < pts.length; i++) {
        if (!vals[i]) continue;
        const hL = i === 0 ? pts[1] - pts[0] : pts[i] - pts[i - 1];
        const hR = i === pts.length - 1 ? pts[i] - pts[i - 1] : pts[i + 1] - pts[i];
        const w = (hL + hR) / 2;
        for (const ch of Object.keys(Ch)) sums[ch] = cadd(sums[ch], cscale(vals[i][ch], w));
      }
      if (variant === 'sub') {
        for (const ch of Object.keys(Ch)) {
          const IK = csub(psv.clog(csub([K, 0], fit.kp)), psv.clog(csub([pts[0], 0], fit.kp)));
          sums[ch] = cadd(sums[ch], cmul(fit.A[ch], IK));
        }
      }
      const ex = exact('ur');
      const err = mag(csub(sums.ur, ex)) / mag(ex);
      console.log('  dk', dk.toExponential(1), variant + ': |ur|', mag(sums.ur).toExponential(6), ' rel-err vs exact', err.toExponential(3));
      if (variant === 'sub' && err > 2e-3) { console.log('SELF-TEST FAIL: subtracted integration off'); process.exit(1); }
    }
  }
  console.log('self-test integration (exact = closed form):');
  runLattice(2e-5); // ~0.77 points per gamma-width: plain MUST fail
  runLattice(5e-6);
  console.log('self-test PASS');
})();

// ---------------------------------------------------------------------------
// 2. real config: fit table + dk series (Schur arm, plain vs detSubtract)
// ---------------------------------------------------------------------------
Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = 2 * Math.PI * 0.5, zs = 73, mW = 7.7;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const az = hybrid.azimuthDeg(34.0, 140.5, 35.6812, 139.7671);
const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(mW));
// tensor protocol: the probe freeze keeps the full tensor UNROTATED
// (source frame) — the first draft of this driver rotated it and produced
// a different (rotated) fullTensor series, which briefly masqueraded as a
// stale-freeze reproducibility crisis. Keep unrotated to stay comparable
// with tools/data/psv-scale-diagnosis.json.
const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az); // (kept only for reference; NOT used below)
void Mr;
const deviatoric = { mxx: M.xx, myy: M.yy, mxy: M.xy, mxz: 0, myz: 0, mzz: 0, rKm, zSourceKm: zs, kMaxInvKm: 5, qShear: 50, schurCompliance: 1 };
const full = { mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz, rKm, zSourceKm: zs, kMaxInvKm: 5, qShear: 50, schurCompliance: 1 };

console.log('\n== real fit table (tokyo 0.5 Hz zs=73 Schur integrand) ==');
const tFit0 = Date.now();
const poles = psv.psvModalPoles(stack, omega, 5, { qShear: 50, qP: 50 });
const gProbe = (k) => psv.psvIntegrandAtK(stack, omega, k, Object.assign({}, full));
for (const p of poles) {
  const f = psv.psvPoleModelFit(stack, omega, p, full, gProbe);
  if (f && f.rel < 0.15) {
    console.log('k=', p.k.toFixed(4), '-> kp', (f.kp[0] * 1000).toFixed(5), '+', (f.kp[1] * 1000).toExponential(3), 'i /km  gm0', p.gammaKm.toExponential(2),
      ' rel', f.rel.toExponential(2), ' n', f.n, ' |A|', mag(f.A.ur).toExponential(2) + '/' + mag(f.A.uz).toExponential(2) + '/' + mag(f.A.ut).toExponential(2));
  } else {
    console.log('k=', p.k.toFixed(4), ' gm0', p.gammaKm.toExponential(2), ' -> fit FAILED/weak:', f ? f.rel.toExponential(2) : 'null', '(window fallback)');
  }
}
const set = psv.psvPoleModelSet(stack, omega, poles, full, gProbe);
console.log('production set (gate 0.15 + dedupe):', set.length, 'models —',
  set.map((m) => (m.kp[0] * 1000).toFixed(3) + '+' + (m.kp[1] * 1000).toExponential(2) + 'i').join(', '));
console.log('(' + ((Date.now() - tFit0) / 1000).toFixed(1) + ' s)');

console.log('\n== dk series, |ur| (Schur arm) ==');
const dks = [0.02, 0.005, 0.002, 0.001, 0.0005, 0.00025];
for (const [label, base] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
  for (const variant of ['plain', 'detSubtract']) {
    for (const dk of dks) {
      const p = Object.assign({}, base, variant === 'detSubtract' ? { detSubtract: 1 } : {});
      const t0 = Date.now();
      const r = psv.psvMomentSpectrumAtFrequency(stack, omega, Object.assign({}, p, { dkInvKm: dk }));
      console.log(label, variant, 'dk', dk, '|ur|', mag(r.ur).toExponential(4), '(' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
    }
  }
}
