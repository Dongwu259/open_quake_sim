'use strict';
// broadband-psv.test.js — anchor set for tools/broadband/psv.js (the P-SV
// companion of the SH kernel). Anchor discipline mirrors
// tests/broadband-green.test.js: every constant/factor the pipeline relies
// on is LOCKED here against exact or independent references:
//   R1 Rayleigh dispersion root vs the Rayleigh cubic (propagator chain)
//   R2 independent stepwise ODE integration (RK4) of the same P-SV system
//      vs the eigenvector propagator solve at production wavenumbers —
//      cross-implementation check (the k->0 analytic column limit is
//      numerically unreachable in double precision for this formulation:
//      the free-surface basis states develop 1/k-conditioned SV
//      components, so the closed-form k=0 comparison is replaced by this)
//   R3 radiation nodes (pure Mxy / pure Mzz) — assembly bookkeeping
//   R4 alpha-identity assembly vs direct numerical alpha quadrature
//   R5 dipole depth-FD convergence
//   R6 band stability (no NaN/overflow over the production band)
//   R7 absolute scale: k->0 column limit vs the exact SI 1D closed form
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const psv = require(path.join(__dirname, '..', 'tools', 'broadband', 'psv.js'));
const core = require(path.join(__dirname, '..', 'tools', 'broadband', 'core.js'));

const cabs = (c) => Math.hypot(c[0], c[1]);
const cadd = core.cadd, cmul = core.cmul, csub = core.csub, cscale = core.cscale, cdiv = core.cdiv;
const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];

function rayleighCubicRoot(eta) {
  const f = (X) => X * X * X - 8 * X * X + 8 * (3 - 2 * eta) * X - 16 * (1 - eta);
  let lo = 0.01, hi = 0.999;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return Math.sqrt(0.5 * (lo + hi));
}

test('R1 — halfspace Rayleigh root lands on the Rayleigh cubic root', () => {
  const omega = 2 * Math.PI * 0.5;
  const eta = Math.pow(3.5 / 6.0, 2);
  const cR = rayleighCubicRoot(eta) * 3500;
  let best = { d: Infinity, k: NaN };
  for (let kk = 0.3; kk <= 2.0; kk += 0.01) {
    const D = psv.psvDispersionFunction(HALF, omega, kk);
    if (D && cabs(D) < best.d) best = { d: cabs(D), k: kk };
  }
  for (const span of [0.02, 0.002]) {
    let b2 = { d: Infinity, k: NaN };
    for (let kk = best.k - span; kk <= best.k + span; kk += span / 20) {
      const D = psv.psvDispersionFunction(HALF, omega, kk);
      if (D && cabs(D) < b2.d) b2 = { d: cabs(D), k: kk };
    }
    best = b2;
  }
  const cFound = omega / (best.k / 1000);
  assert.ok(Math.abs(cFound / cR - 1) < 0.005,
    'Rayleigh speed ' + cFound.toFixed(1) + ' vs cubic root ' + cR.toFixed(1) + ' m/s');
});

// --- independent stepwise ODE solver (RK4, renormalized) -----------------
function odeCompliance(stack, omega, k, zs) {
  const lay = psv.prepare(stack, zs);
  function deriv(s, z) {
    const layer = lay.layers.find((l) => z >= l.topKm - 1e-9 && z < l.bottomKm - 1e-9) || lay.layers[lay.layers.length - 1];
    const m1 = layer.rhoGcm3 * 1000 * Math.pow(layer.vsKmS * 1000, 2);
    const l1 = layer.rhoGcm3 * 1000 * (Math.pow(layer.vpKmS * 1000, 2) - 2 * Math.pow(layer.vsKmS * 1000, 2));
    const r1 = layer.rhoGcm3 * 1000;
    const ik = [0, k];
    const dup = csub(cscale(s[2], 1 / m1), cmul(ik, s[1]));
    const t0 = cmul([0, l1 * k], s[0]);
    const dzp = [(s[3][0] - t0[0]) / (l1 + 2 * m1), (s[3][1] - t0[1]) / (l1 + 2 * m1)];
    const c1 = k * k * (l1 + 2 * m1 - l1 * l1 / (l1 + 2 * m1)) - omega * omega * r1;
    const t1 = cmul([0, -k * l1 / (l1 + 2 * m1)], s[3]);
    const dtr = [c1 * s[0][0] + t1[0], c1 * s[0][1] + t1[1]];
    const t2 = cmul(ik, s[2]);
    const dsz = [-omega * omega * r1 * s[1][0] - t2[0], -omega * omega * r1 * s[1][1] - t2[1]];
    return [dup, dzp, dtr, dsz];
  }
  const h = 2;
  const nSteps = Math.round((zs * 1000) / h);
  let s1 = [[1, 0], [0, 0], [0, 0], [0, 0]];
  let s2 = [[0, 0], [1, 0], [0, 0], [0, 0]];
  for (let i = 0; i < nSteps; i++) {
    const step = (s) => {
      const a = deriv(s, i * h);
      const b = deriv(s.map((v, j) => cadd(v, cscale(a[j], h / 2))), i * h + h / 2);
      const c = deriv(s.map((v, j) => cadd(v, cscale(b[j], h / 2))), i * h + h / 2);
      const d = deriv(s.map((v, j) => cadd(v, cscale(c[j], h))), i * h + h);
      return s.map((v, j) => cadd(v, cscale(cadd(cadd(a[j], cscale(b[j], 2)), cadd(c[j], cscale(d[j], 2))), h / 6)));
    };
    s1 = step(s1); s2 = step(s2);
    if (i % 200 === 199) {
      const mx = Math.max(...s1.flat().map(cabs), ...s2.flat().map(cabs));
      if (mx > 1e100) { s1 = s1.map((v) => cscale(v, 1 / mx)); s2 = s2.map((v) => cscale(v, 1 / mx)); }
    }
  }
  const half = lay.layers[lay.halfIndex];
  const mH = half.rhoGcm3 * 1000 * Math.pow(half.vsKmS * 1000, 2);
  const rH = half.rhoGcm3 * 1000;
  const nuA2 = omega * omega / Math.pow(half.vpKmS * 1000, 2) - k * k;
  const nuB2 = omega * omega / Math.pow(half.vsKmS * 1000, 2) - k * k;
  const nA = Math.sqrt(Math.max(nuA2, 0)), nB = Math.sqrt(Math.max(nuB2, 0));
  const ik = [0, k], iA = [0, nA], iB = [0, nB];
  const M1 = [[ik, iB], [iA, cscale(ik, -1)]];
  const M2 = [[[-2 * mH * k * nA, 0], [mH * (k * k - nB * nB), 0]],
              [[2 * mH * k * k - rH * omega * omega, 0], [2 * mH * k * nB, 0]]];
  const det = csub(cmul(M1[0][0], M1[1][1]), cmul(M1[0][1], M1[1][0]));
  const Y = [
    [cdiv(csub(cmul(M2[0][0], M1[1][1]), cmul(M2[0][1], M1[1][0])), det), cdiv(csub(cmul(M2[0][1], M1[0][0]), cmul(M2[0][0], M1[0][1])), det)],
    [cdiv(csub(cmul(M2[1][0], M1[1][1]), cmul(M2[1][1], M1[1][0])), det), cdiv(csub(cmul(M2[1][1], M1[0][0]), cmul(M2[1][0], M1[0][1])), det)]
  ];
  const res = (s) => [csub(s[2], cadd(cmul(Y[0][0], s[0]), cmul(Y[0][1], s[1]))),
                      csub(s[3], cadd(cmul(Y[1][0], s[0]), cmul(Y[1][1], s[1])))];
  const rA0 = res(s1), rA1 = res(s2);
  const rW0 = [[1, 0], [0, 0]], rW1 = [[0, 0], [1, 0]];
  const m2inv = (A) => { const dd = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0])); return [[cdiv(A[1][1], dd), cscale(cdiv(A[0][1], dd), -1)], [cscale(cdiv(A[1][0], dd), -1), cdiv(A[0][0], dd)]]; };
  const m2mul = (A, B) => [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
                           [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
  const Cc = m2mul(m2inv([[rA0[0], rA1[0]], [rA0[1], rA1[1]]]), [[rW0[0], rW1[0]], [rW0[1], rW1[1]]]);
  return [[cscale(Cc[0][0], -1), cscale(Cc[0][1], -1)], [cscale(Cc[1][0], -1), cscale(Cc[1][1], -1)]];
}

test('R2 — eigenvector-propagator solve matches independent RK4 ODE integration', () => {
  const omega = 2 * Math.PI * 0.5;
  for (const kKm of [0.2, 0.5]) {
    const a = psv.psvSurfaceCompliance(HALF, omega, kKm / 1000, 15);
    const b = odeCompliance(HALF, omega, kKm / 1000, 15);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const na = cabs(b[i][j]);
      assert.ok(na > 0, 'ODE compliance entry unexpectedly zero');
      const rel = Math.hypot(a[i][j][0] - b[i][j][0], a[i][j][1] - b[i][j][1]) / na;
      assert.ok(rel < 0.01, 'k=' + kKm + ' 1/km entry[' + i + '][' + j + '] rel err ' + rel.toExponential(2));
    }
  }
});

test('R7 — absolute scale: k->0 sigma_zz column matches the exact 1D column compliance (SI)', () => {
  const omega = 2 * Math.PI * 1.0;
  const stack = [{ topKm: 0, bottomKm: Infinity, vsKmS: 2.0, vpKmS: 3.4641, rhoGcm3: 2.7 }];
  const alpha = 3464, rhoSI = 2700, nu = omega / alpha, d = 5000;
  // 1D vertical column, free surface, radiation below, jump convention
  // [sigma_below - sigma_above] = +1:  u_z(0) = 1/(rho_SI alpha^2 nu (i cos(nu d) + sin(nu d)))
  const den = rhoSI * alpha * alpha * nu;
  const c = Math.cos(nu * d), s = Math.sin(nu * d);
  const expected = [s / den, -c / den];
  for (const kKm of [0.001, 0.01, 0.05]) {
    const C = psv.psvSurfaceCompliance(stack, omega, kKm / 1000, 5);
    assert.ok(C, 'compliance solve failed at k=' + kKm);
    const cz = C[1][1];
    const rel = Math.hypot(cz[0] - expected[0], cz[1] - expected[1]) / Math.hypot(expected[0], expected[1]);
    assert.ok(rel < 0.02, 'k=' + kKm + ' 1/km: C_zz rel err ' + rel.toExponential(2) + ' (absolute-scale lock)');
  }
});

test('R3 — radiation nodes: pure Mxy gives zero radial/vertical; pure Mzz gives zero radial', () => {
  const omega = 2 * Math.PI * 0.5;
  const base = { rKm: 30, zSourceKm: 15, dkInvKm: 0.05, kMaxInvKm: 3, mxx: 0, myy: 0, mzz: 0, mxy: 0, mxz: 0, myz: 0 };
  const ss = psv.psvMomentSpectrumAtFrequency(HALF, omega, Object.assign({}, base, { mxy: 1e18 }));
  assert.ok(cabs(ss.ur) < 1e-30 && cabs(ss.uz) < 1e-30, 'strike-slip radial/vertical must be structurally zero');
  const ex = psv.psvMomentSpectrumAtFrequency(HALF, omega, Object.assign({}, base, { mzz: 1e18 }));
  assert.ok(cabs(ex.ur) < 1e-30, 'explosive radial must be structurally zero');
  assert.ok(cabs(ex.uz) > 0, 'explosive vertical must be nonzero');
});

test('R4 — identity assembly matches direct numerical alpha quadrature', () => {
  const omega = 2 * Math.PI * 0.5;
  const params = { rKm: 30, zSourceKm: 15, dkInvKm: 0.05, kMaxInvKm: 3,
    mxx: 3e17, myy: -1e17, mzz: 5e16, mxy: 2e17, mxz: 4e17, myz: -3e17 };
  const assembled = psv.psvMomentSpectrumAtFrequency(HALF, omega, params);
  const kMax = params.kMaxInvKm / 1000, dk = params.dkInvKm / 1000;
  const rM = params.rKm * 1000, N = 2048, dh = 0.5 / 1000;
  const zs = params.zSourceKm, zUp = zs - dh, zDn = zs + dh;
  const P0 = 0.5 * (params.mxx + params.myy), P2 = 0.5 * (params.mxx - params.myy);
  let ur = [0, 0], uz = [0, 0], ut = [0, 0];
  for (let k = dk; k <= kMax + 1e-15; k += dk) {
    const C = psv.psvSurfaceCompliance(HALF, omega, k, zs);
    const Cup = psv.psvSurfaceCompliance(HALF, omega, k, zUp);
    const Cdn = psv.psvSurfaceCompliance(HALF, omega, k, zDn);
    if (!C || !Cup || !Cdn) continue;
    const dCr0 = [(Cdn[0][0][0] - Cup[0][0][0]), (Cdn[0][0][1] - Cup[0][0][1])];
    const dCr1 = [(Cdn[0][1][0] - Cup[0][1][0]), (Cdn[0][1][1] - Cup[0][1][1])];
    const dCz1 = [(Cdn[1][1][0] - Cup[1][1][0]), (Cdn[1][1][1] - Cup[1][1][1])];
    let s0 = [0, 0], s1 = [0, 0], s2 = [0, 0];
    for (let i = 0; i < N; i++) {
      const a = (i + 0.5) * (2 * Math.PI) / N, ca = Math.cos(a), sa = Math.sin(a);
      const c2 = Math.cos(2 * a), s2a = Math.sin(2 * a);
      const ph = [Math.cos(k * rM * ca), Math.sin(k * rM * ca)];
      const dtauR = -k * (P0 + P2 * c2 + params.mxy * s2a);
      const dsigR = -k * (params.mxz * ca + params.myz * sa);
      const cm = (jr, ji, cr, ci) => [jr * cr - ji * ci, jr * ci + ji * cr];
      const rr = cm(0, dtauR, C[0][0][0], C[0][0][1]).map((v, i2) => v + cm(0, dsigR, C[0][1][0], C[0][1][1])[i2]);
      const zz = cm(0, dtauR, C[1][0][0], C[1][0][1]).map((v, i2) => v + cm(0, dsigR, C[1][1][0], C[1][1][1])[i2]);
      const urD = cm(params.mxz, 0, dCr0[0], dCr0[1]);
      const uzD = cm(params.mzz, 0, dCz1[0], dCz1[1]);
      const utD = cm(params.myz, 0, dCr1[0], dCr1[1]);
      const phx = (v) => [ph[0] * v[0] - ph[1] * v[1], ph[0] * v[1] + ph[1] * v[0]];
      const uF = phx(rr), uD = phx(urD);
      s0[0] += ca * uF[0] + ca * ca * uD[0]; s0[1] += ca * uF[1] + ca * ca * uD[1];
      const zA = phx(zz.map((v, i2) => v + uzD[i2]));
      s1[0] += zA[0]; s1[1] += zA[1];
      const uTf = phx(rr), uTd = phx(utD);
      s2[0] += sa * uTf[0] + sa * sa * uTd[0]; s2[1] += sa * uTf[1] + sa * sa * uTd[1];
    }
    const w = (k * dk) / (4 * Math.PI * Math.PI) * (2 * Math.PI / N);
    ur[0] += s0[0] * w; ur[1] += s0[1] * w;
    uz[0] += s1[0] * w; uz[1] += s1[1] * w;
    ut[0] += s2[0] * w; ut[1] += s2[1] * w;
  }
  const rel = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1e-30, Math.hypot(b[0], b[1]));
  assert.ok(rel(ur, assembled.ur) < 0.01, 'u_r quadrature mismatch ' + rel(ur, assembled.ur).toExponential(2));
  assert.ok(rel(uz, assembled.uz) < 0.01, 'u_z quadrature mismatch ' + rel(uz, assembled.uz).toExponential(2));
  assert.ok(rel(ut, assembled.ut) < 0.01, 'u_t quadrature mismatch ' + rel(ut, assembled.ut).toExponential(2));
});

test('R5 — dipole depth-FD converged at dh = 0.5 m', () => {
  const omega = 2 * Math.PI * 0.5;
  const base = { rKm: 30, zSourceKm: 15, dkInvKm: 0.05, kMaxInvKm: 3, mxx: 0, myy: 0, mzz: 0, mxy: 0, mxz: 0, myz: 0 };
  const a = psv.psvMomentSpectrumAtFrequency(HALF, omega, Object.assign({}, base, { mzz: 1e17, dhM: 0.25 }));
  const b = psv.psvMomentSpectrumAtFrequency(HALF, omega, Object.assign({}, base, { mzz: 1e17, dhM: 1.0 }));
  const na = cabs(a.uz), nb = cabs(b.uz);
  assert.ok(na > 0 && nb > 0, 'Mzz responses must be nonzero');
  const rel = Math.hypot(a.uz[0] - b.uz[0], a.uz[1] - b.uz[1]) / na;
  assert.ok(rel < 0.05, 'Mzz FD convergence rel diff ' + rel.toExponential(2));
});

test('R6 — band stability: compliance finite over the production band', () => {
  for (let f = 0.05; f <= 2.0; f += 0.15) {
    for (const kKm of [1e-3, 0.01, 0.1, 0.5, 2.0, 5.0]) {
      const C = psv.psvSurfaceCompliance(HALF, 2 * Math.PI * f, kKm / 1000, 10);
      assert.ok(C, 'overflow at f=' + f.toFixed(2) + ' k=' + kKm);
      for (const row of C) for (const c of row) {
        assert.ok(isFinite(c[0]) && isFinite(c[1]), 'NaN at f=' + f.toFixed(2) + ' k=' + kKm);
        assert.ok(cabs(c) < 1e8, 'compliance blowup at f=' + f.toFixed(2) + ' k=' + kKm);
      }
    }
  }
});
