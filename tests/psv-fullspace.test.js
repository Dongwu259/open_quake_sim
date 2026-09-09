'use strict';
// psv-fullspace.test.js — P-SV absolute source-calibration anchor against
// the closed-form full-space elastodynamic solution (the analog of the SH
// kernel's A1 discipline; registered 2026-09-05 BEFORE the repair run).
//
//   PRE-REGISTRATION (2026-09-05, before any A3 run): tools/broadband/
//   psv-fullspace.js is built from the Aki-Richards full-space Green
//   tensor, Weyl-transformed per term; A1/A2 validate the reference itself
//   (Kelvin static limit; κ-domain vs spatial closed form; G̃_θθ ==
//   core.shFullSpaceCompliance). A3 then measures psv.js's fullSpace
//   moment response against the block reference per PURE source tensor.
//   Expected failure pattern BEFORE the repair (from term-by-term
//   bookkeeping, to be confirmed numerically here):
//     Mzz : u_z matches; u_r missing in psv.js (reference ≠ 0)
//     Mxz : u_r matches; u_z dipole arm missing
//     Myz : u_t uses the wrong compliance column (∂G_rz instead of ∂G_rr);
//           u_z dipole arm missing
//     deviatoric (P0/P2/Q2 traction family): everything matches
//   The repair then completes the T5-T7 dipole terms; the corrected
//   assembly is LOCKED here complex-complex per channel.
//
//   A1  closed-form spatial tensor ω→0 == Kelvin static tensor (ν = 1/4)
//   A2  κ-domain tensor == spatial closed form via independent numeric
//       polar quadrature (force response), incl. gtt == shFullSpaceCompliance
//   A3  psv.psvMomentSpectrumAtFrequency(fullSpace) == momentBlockReference
//       per pure tensor (Mzz / Mxz / Myz / deviatoric / full thrust DC)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const psv = require(path.join(__dirname, '..', 'tools', 'broadband', 'psv.js'));
const psvFs = require(path.join(__dirname, '..', 'tools', 'broadband', 'psv-fullspace.js'));
const core = require(path.join(__dirname, '..', 'tools', 'broadband', 'core.js'));

const cabs = (c) => Math.hypot(c[0], c[1]);
const crel = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1e-300, cabs(b));
const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];

test('A1 — spatial Green tensor static limit reproduces the Kelvin tensor', () => {
  const omega = 2 * Math.PI * 5e-5; // k_β r ≈ 1.6e-3: real part O((kr)²), imag O(kr)
  const L3 = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 3.5 * Math.sqrt(3), rhoGcm3: 2.7 }];
  const mu = L3[0].rhoGcm3 * 1000 * (L3[0].vsKmS * 1000) ** 2;
  for (const [dx, dy, dz] of [[8000, 3000, -15000], [-12000, 5000, -20000], [9000, -1000, 25000]]) {
    const fs = psvFs.fullSpaceForceTensorSpatial(L3[0], omega, dx, dy, dz);
    const r = fs.r, n = fs.n;
    // Kelvin (ν = 1/4 since λ = μ for vp/vs = √3): G = 1/(4πμr)[(2/3)δ + (1/3) n̂n̂]
    for (let k = 0; k < 3; k++) for (let p = 0; p < 3; p++) {
      const expected = ((k === p ? 2 / 3 : 0) + n[k] * n[p] / 3) / (4 * Math.PI * mu * r);
      const got = fs.G[k][p];
      assert.ok(Math.abs(got[0] - expected) / expected < 2e-3,
        'Kelvin static mismatch G[' + k + '][' + p + ']: ' + got[0].toExponential(6) + ' vs ' + expected.toExponential(6));
      assert.ok(Math.abs(got[1]) / expected < 5e-3, 'static imaginary part must vanish');
    }
  }
});

// --- independent numeric polar quadrature of the κ-domain FORCE response --
function forceResponseKappaIntegral(layer, omega, hM, rM, F, opts) {
  const kVs = omega / (layer.vsKmS * 1000);
  const kappaMax = Math.max(2.5 * kVs, kVs + 40 / Math.abs(hM)); // evanescent tail e^{-q'h} < 1e-17
  const dk = (2 * Math.PI / rM) / 192; // branch-kink trapezoid error O(dk^1.5)
  const nAlpha = 512;
  const acc = [[0, 0], [0, 0], [0, 0]]; // displacement x, y, z
  for (let kap = dk; kap <= kappaMax + 1e-15; kap += dk) {
    const t = psvFs.fullSpaceForceTensorKappa(layer, omega, kap, hM, opts);
    const sx = [0, 0], sy = [0, 0], sz = [0, 0];
    for (let ia = 0; ia < nAlpha; ia++) {
      const al = (ia + 0.5) * 2 * Math.PI / nAlpha;
      const ca = Math.cos(al), sa = Math.sin(al);
      const fr = F[0] * ca + F[1] * sa;   // force components in the κ frame
      const ft = -F[0] * sa + F[1] * ca;
      const fz = F[2];
      const kHatR = t.grr[0] * fr + t.grz[0] * fz, kHatI = t.grr[1] * fr + t.grz[1] * fz;
      const tHatR = t.gtt[0] * ft, tHatI = t.gtt[1] * ft;
      const zHatR = t.grz[0] * fr + t.gzz[0] * fz, zHatI = t.grz[1] * fr + t.gzz[1] * fz;
      const dxR = kHatR * ca - tHatR * sa, dxI = kHatI * ca - tHatI * sa; // κ̂·x̂ = cosα, θ̂κ·x̂ = −sinα
      const dyR = kHatR * sa + tHatR * ca, dyI = kHatI * sa + tHatI * ca;
      const kr = kap * rM * ca;
      const ph = [Math.cos(kr), Math.sin(kr)];
      sx[0] += ph[0] * dxR - ph[1] * dxI; sx[1] += ph[0] * dxI + ph[1] * dxR;
      sy[0] += ph[0] * dyR - ph[1] * dyI; sy[1] += ph[0] * dyI + ph[1] * dyR;
      sz[0] += ph[0] * zHatR - ph[1] * zHatI; sz[1] += ph[0] * zHatI + ph[1] * zHatR;
    }
    const w = kap * dk * (2 * Math.PI / nAlpha) / (4 * Math.PI * Math.PI);
    for (const [a, b] of [[acc[0], sx], [acc[1], sy], [acc[2], sz]]) {
      a[0] += b[0] * w; a[1] += b[1] * w;
    }
  }
  return acc;
}

test('A2 — κ-domain tensor agrees with the spatial closed form (force response)', () => {
  const omega = 2 * Math.PI * 0.5;
  const layer = HALF[0];
  const Q = { qShear: 50, qP: 50 }; // same damping convention on BOTH sides
  for (const [rKm, hKm] of [[30, -15], [8, -6], [50, 20]]) {
    for (const F of [[1, 0, 0], [0, 0, 1]]) {
      const got = forceResponseKappaIntegral(layer, omega, hKm * 1000, rKm * 1000, F, Q);
      const G = psvFs.fullSpaceForceTensorSpatial(layer, omega, rKm * 1000, 0, hKm * 1000, Q).G;
      const scale = Math.max(...[0, 1, 2].map((k) => Math.hypot(...[0, 1, 2].reduce((s, p) => [s[0] + G[k][p][0] * F[p], s[1] + G[k][p][1] * F[p]], [0, 0]))));
      for (let k = 0; k < 3; k++) {
        const ref = [0, 1, 2].reduce((s, p) => [s[0] + G[k][p][0] * F[p], s[1] + G[k][p][1] * F[p]], [0, 0]);
        if (cabs(ref) < 1e-8 * scale) {
          assert.ok(cabs(got[k]) < 1e-8 * scale,
            'kappa vs spatial comp' + k + ' structurally zero but got ' + cabs(got[k]).toExponential(3));
          continue;
        }
        const rel = crel(got[k], ref);
        assert.ok(rel < 0.02,
          'kappa vs spatial @r=' + rKm + 'km h=' + hKm + 'km F=' + F + ' comp' + k + ': rel ' + rel.toExponential(2));
      }
    }
  }
});

test('A2c — gtt is the exact negation of core.shFullSpaceCompliance', () => {
  // core's SH compliance carries the unit-jump insertion sign (− force
  // response); the Weyl-anchored force response here is its exact negation.
  const omega = 2 * Math.PI * 0.8;
  const layer = HALF[0];
  for (const [kKm, hKm] of [[0.5, -12], [1.8, -12], [3.0, -25]]) {
    const t = psvFs.fullSpaceForceTensorKappa(layer, omega, kKm / 1000, hKm * 1000, { qShear: 50 });
    const sh = core.shFullSpaceCompliance(layer, omega, kKm / 1000, 0, -hKm, { qShear: 50 });
    const rel = crel(t.gtt, [-sh[0], -sh[1]]);
    assert.ok(rel < 1e-12, 'gtt vs −shFullSpaceCompliance @' + kKm + '/km: rel ' + rel.toExponential(2));
  }
});

// --- A3: psv.js fullSpace moment response vs the block reference ---------
const A3_OPTS = { qShear: 50 };
function a3Case(name, tensor) {
  const omega = 2 * Math.PI * 0.5;
  const psvParams = Object.assign({
    rKm: 30, zSourceKm: 15, dkInvKm: 0.0025, kMaxInvKm: 6, fullSpace: true,
    mxx: 0, myy: 0, mzz: 0, mxy: 0, mxz: 0, myz: 0
  }, tensor, A3_OPTS);
  const refParams = Object.assign({
    rM: 30000, zSourceKm: 15, dkInvKm: 0.001, kMaxInvKm: 6, alphaN: 2048
  }, tensor, A3_OPTS);
  const got = psv.psvMomentSpectrumAtFrequency(HALF, omega, psvParams);
  const ref = psvFs.momentBlockReference(HALF[0], omega, refParams);
  return { got: got, ref: ref, name: name };
}

test('A3 — psv fullSpace matches the closed-form block reference, per pure tensor', () => {
  const cases = [
    a3Case('Mzz', { mzz: 1e18 }),
    a3Case('Mxz', { mxz: 1e18 }),
    a3Case('Myz', { myz: 1e18 }),
    a3Case('deviatoric', { mxx: 3e17, myy: -1e17, mxy: 2e17 }),
    a3Case('thrust-DC', { mxx: 2.4e17, myy: -5.6e17, mzz: 3.2e17, mxz: 1.5e17, myz: -0.9e17, mxy: 0.4e17 })
  ];
  // TOL 0.08: at these settings the per-wavenumber integrands agree exactly
  // (checked at 0.05..2.0 1/km), so the residual is pure κ-quadrature on
  // both sides — each converges to the same limit (~4% apart at the finest
  // settings probed); the pre-repair defects were 60-1200x, far outside.
  const TOL = 0.08;
  for (const c of cases) {
    const scale = Math.max(cabs(c.ref.ur), cabs(c.ref.ut), cabs(c.ref.uz));
    for (const ch of ['ur', 'ut', 'uz']) {
      // psv's total output carries the global unit-jump insertion convention
      // (− closed-form physics, pinned empirically: with the compliance in
      // the R7/insertion convention the integrands matched the reference at
      // exactly −1 for BOTH source families). Residual = |got − (−ref)|.
      const gotAbs = cabs(c.got[ch]), refAbs = cabs(c.ref[ch]);
      if (refAbs < 1e-9 * scale) {
        assert.ok(gotAbs < 1e-9 * scale,
          c.name + '.' + ch + ': reference is structurally zero but code returned ' + gotAbs.toExponential(3));
        continue;
      }
      const resid = cabs([c.got[ch][0] + c.ref[ch][0], c.got[ch][1] + c.ref[ch][1]]);
      const rel = resid / refAbs;
      assert.ok(rel < TOL, c.name + '.' + ch + ' rel ' + rel.toExponential(3) +
        ' (|code|=' + gotAbs.toExponential(3) + ' |ref|=' + refAbs.toExponential(3) + ')');
    }
  }
});
