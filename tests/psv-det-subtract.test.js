'use strict';
// det-subtract pole-model tripwires (2026-09-11 batch). The v11 registered
// cure for the non-converged Schur dk series was "analytic det-based
// principal-value subtraction"; the shipped architecture fits each modal
// pole as A/(k-kp)+B per channel on REAL-AXIS samples (complex-k Newton on
// either chain determinant measured infeasible: the Schur up-leg step det
// crosses zero AT the poles, the raw cascade det Newton was the v4
// failure), drops the fitted poles' gamma-windows, integrates the smooth
// remainder on the production lattice and re-adds the exact principal-
// branch complex-log pole integrals. These tests lock the machinery.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const psv = require('../tools/broadband/psv.js');
const { cadd, csub, cmul, cscale, cabs, cdiv } = require('../tools/broadband/core.js');

const mag = (c) => Math.hypot(c[0], c[1]);

function closedFormG(kp, chans, lam) {
  let n = 0;
  return function (k) {
    n++;
    if (n % 7 === 0) return null; // exercise the null-sample path
    const out = {};
    for (const ch of Object.keys(chans)) {
      const c = chans[ch];
      out[ch] = cadd(cadd(cdiv(c.A, csub([k, 0], kp)), c.B), cscale(c.C, Math.exp(-lam * k)));
    }
    return out;
  };
}

const CH = {
  ur: { A: [3.2, -1.1], B: [0.30, 0.12], C: [0.20, 0.10] },
  uz: { A: [-1.7, 0.9], B: [0.21, -0.05], C: [0.11, 0.04] },
  ut: { A: [0.8, 2.2], B: [0.15, 0.30], C: [0.07, -0.02] }
};

test('R1: pole-channel LS recovers exact A/(w)+B coefficients', () => {
  const kp = [1.005e-3, 2.6e-5];
  const w = [0.25, 0.5, 1, 2, 4, 8].flatMap((m) => [m, -m])
    .map((s) => cdiv([1, 0], csub([1.005e-3 + s * 6e-5, 0], kp)));
  const A = [3.2, -1.1], B = [0.30, 0.12];
  const g = w.map((x) => cadd(cmul(A, x), B));
  const ls = psv.poleChannelLS(w, g);
  assert.ok(ls, 'LS solved');
  assert.ok(mag(csub(ls.A, A)) / mag(A) < 1e-12, 'A exact, got ' + JSON.stringify(ls.A));
  assert.ok(mag(csub(ls.B, B)) / mag(B) < 1e-9, 'B exact to conditioning, got ' + JSON.stringify(ls.B));
});

test('R2: pole-model fit recovers a closed-form pole (position to 1e-4 rel, residual < 0.02)', () => {
  const kp = [1.005e-3, 2.6e-5];
  const gOf = closedFormG(kp, CH, 300);
  const fit = psv.psvPoleModelFit([], 2 * Math.PI * 0.5, { k: 1.005, gammaKm: 0.06 }, { qShear: 50 }, gOf);
  assert.ok(fit, 'fit produced');
  assert.ok(fit.rel < 0.02, 'rel ' + fit.rel);
  assert.ok(Math.abs(fit.kp[0] - kp[0]) / kp[0] < 1e-4, 'kr ' + fit.kp[0]);
  assert.ok(Math.abs(Math.abs(fit.kp[1]) - kp[1]) / kp[1] < 0.25, 'gamma ' + fit.kp[1]);
});

test('R3: subtract-and-re-add integrates an under-resolved pole to 0.3% (plain trapezoid fails)', () => {
  const kp = [1.005e-3, 2.6e-5];
  const gOf = closedFormG(kp, CH, 300);
  const fit = psv.psvPoleModelFit([], 2 * Math.PI * 0.5, { k: 1.005, gammaKm: 0.06 }, { qShear: 50 }, gOf);
  const k0 = 2e-7, K = 5e-3, dk = 2e-5; // ~0.77 samples per gamma width
  function integrate(sub) {
    const pts = [];
    for (let k = k0; k <= K + 1e-15; k += dk) pts.push(k);
    const vals = pts.map((k) => {
      let g = gOf(k);
      if (g && sub) {
        const w = cdiv([1, 0], csub([k, 0], fit.kp));
        for (const ch of Object.keys(CH)) g[ch] = csub(g[ch], cmul(fit.A[ch], w));
      }
      return g;
    });
    const sums = { ur: [0, 0], uz: [0, 0], ut: [0, 0] };
    for (let i = 0; i < pts.length; i++) {
      if (!vals[i]) continue;
      const hL = i === 0 ? pts[1] - pts[0] : pts[i] - pts[i - 1];
      const hR = i === pts.length - 1 ? pts[i] - pts[i - 1] : pts[i + 1] - pts[i];
      const w = (hL + hR) / 2;
      for (const ch of Object.keys(CH)) sums[ch] = cadd(sums[ch], cscale(vals[i][ch], w));
    }
    if (sub) {
      for (const ch of Object.keys(CH)) {
        const IK = csub(psv.clog(csub([K, 0], fit.kp)), psv.clog(csub([pts[0], 0], fit.kp)));
        sums[ch] = cadd(sums[ch], cmul(fit.A[ch], IK));
      }
    }
    return sums;
  }
  function exact(ch) {
    const c = CH[ch];
    const I = csub(cmul(c.A, psv.clog(csub([K, 0], kp))), cmul(c.A, psv.clog(csub([k0, 0], kp))));
    return cadd(cadd(I, cscale(c.B, K - k0)), cscale(c.C, (Math.exp(-300 * k0) - Math.exp(-300 * K)) / 300));
  }
  const plain = integrate(false), subd = integrate(true);
  const errPlain = mag(csub(plain.ur, exact('ur'))) / mag(exact('ur'));
  const errSub = mag(csub(subd.ur, exact('ur'))) / mag(exact('ur'));
  assert.ok(errPlain > 0.05, 'plain trapezoid must fail on this lattice, err ' + errPlain);
  assert.ok(errSub < 3e-3, 'subtracted must match the closed form, err ' + errSub);
});

test('R4: fit refuses a pole-free smooth landscape (no false models)', () => {
  const gOf = (k) => ({ ur: [0.5, 0.1], uz: [0.2, -0.05], ut: [0.05, 0.02] });
  const fit = psv.psvPoleModelFit([], 2 * Math.PI, { k: 0.8, gammaKm: 0.02 }, { qShear: 50 }, gOf);
  if (fit) {
    // a constant landscape CAN be fit by A->0; require the amplitude to be
    // negligible so no window would be dropped for it
    const amp = mag(fit.A.ur) + mag(fit.A.uz) + mag(fit.A.ut);
    assert.ok(amp < 1e-6, 'pole-free landscape must not yield a finite-amplitude model, |A| ' + amp);
  }
});

test('R5: clog principal branch sanity', () => {
  const l1 = psv.clog([Math.E, 0]);
  assert.ok(Math.abs(l1[0] - 1) < 1e-15 && Math.abs(l1[1]) < 1e-15);
  const l2 = psv.clog([-Math.E, 0]);
  assert.ok(Math.abs(l2[0] - 1) < 1e-15 && Math.abs(l2[1] - Math.PI) < 1e-15);
  const l3 = psv.clog([0, Math.E]);
  assert.ok(Math.abs(l3[0] - 1) < 1e-15 && Math.abs(l3[1] - Math.PI / 2) < 1e-15);
});

test('R6: psvMomentSpectrumAtFrequency byte-compat — detSubtract absent equals explicitly off', () => {
  // small 2-layer config, low resolution: the new code path is gated on the
  // truthiness of params.detSubtract, so absent must equal 0 bitwise
  const stack = [
    { topKm: 0, bottomKm: 5, vsKmS: 2.0, vpKmS: 4.0, rhoGcm3: 2.2 },
    { topKm: 5, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }
  ];
  const base = {
    rKm: 40, zSourceKm: 8, dkInvKm: 0.05, kMaxInvKm: 4, qShear: 50,
    mxx: 1, myy: 0.5, mxy: 0.2, mxz: 0, myz: 0, mzz: 0
  };
  const a = psv.psvMomentSpectrumAtFrequency(stack, 2 * Math.PI * 0.8, Object.assign({}, base));
  const b = psv.psvMomentSpectrumAtFrequency(stack, 2 * Math.PI * 0.8, Object.assign({}, base, { detSubtract: 0 }));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'absent vs 0 must be identical');
});
