'use strict';
// =====================================================================
//  v6.2 candidate — P-SV (in-plane) discrete-wavenumber Green's functions
//  for layered media. Offline research kernel; NOT loaded in the browser.
//  Companion of tools/broadband/core.js (SH anti-plane): same complex
//  helpers, same Q convention (c* = c (1 - i/(2Q)), e^{-i omega t}), same
//  SI units (k in 1/m, depths in km, omega in rad/s).
//
//  Formulation (self-derived; LOCKED against the anchor set in
//  tests/broadband-psv.test.js before any pipeline use):
//
//  * State vector per horizontal wavenumber k: [u_r, u_z, tau_rz, s_zz]
//    in the (e_r(k), e_z) plane. Plane eigenvectors with
//    nu_c = sqrt(w^2/c^2 - k^2) on the Im >= 0 branch (same radiation
//    convention as core.qT_radiation, per wave type):
//      P  down: u=( i k,  i nu_a)  t=(-2 mu k nu_a,  rho w^2)
//      P  up:   u=( i k, -i nu_a)  t=(+2 mu k nu_a, -rho w^2)
//      SV down: u=( i nu_b, -i k)  t=( mu(k^2-nu_b^2), +2 mu k nu_b)
//      SV up:   u=(-i nu_b, -i k)  t=( mu(k^2-nu_b^2), -2 mu k nu_b)
//
//  * Layered surface compliance (production): two free-surface basis
//    states and two unit-jump columns propagated down (delta-matrix
//    orthonormalised chain, S = Q·T with per-layer MGS — 2026-09-09;
//    same invariance argument as the SH kernel); below the source the
//    RADIATION condition (pure downgoing P+SV admittance Y = M2 M1^-1)
//    closes u0 = -R^-1 Rw DeltaT. Receiver at the surface.
//
//  * Source representation. Point force F at zs <-> traction jump
//    (horizontal: Delta tau_rz = -F; vertical: Delta s_zz = -F). The
//    rotated moment tensor M (receiver at phi = 0) enters through the
//    exact wavenumber algebra f_j = i k_i M_ij:
//      Delta tau_rz(alpha) = -ik [ P0 + P2 cos 2a + Q2 sin 2a ]
//         P0 = (Mxx+Myy)/2, P2 = (Mxx-Myy)/2, Q2 = Mxy
//      Delta s_zz(alpha)   = -ik [ Mxz cos a + Myz sin a ]
//    plus the vertical-arm dipoles (the z-derivative content of
//    f_z = Mzz d_z and the x/y-force d_z arms of Mxz/Myz), which are
//    DEPTH-DERIVATIVES of the point-force responses (finite differences
//    at zs +/- dh, dh = 0.5 m; the propagator is smooth in zs there).
//    The SH channel of the horizontal block is core.js's (complete for
//    the horizontal 2x2 on its own); this module contributes the radial,
//    vertical and the Mxz/Myz transverse-longitudinal pieces.
//
//  * Azimuthal assembly. With the phase e^{i k r cos(a - phi)} and the
//    receiver at phi = 0, the alpha integral reduces term-by-term to
//    INT e^{iz cos a} cos(n a) da = 2 pi i^n J_n(z) (sin terms vanish);
//    identities AZ in the code. Master measure u = (1/2pi) INT k dk [ ... ]
//    (SH kernel convention).
//
//  * Pole handling (v6, 2026-09-06 layered-roots batch). Modal poles are
//    located by psvModalPoles on the RAW renormalised dispersion chain
//    (psvDispersionDetRaw: propagator products, joint per-layer scalar
//    renormalisation, NO Gram-Schmidt) — smooth in k by construction. The
//    v5 GS-consistent dispersion died here: measured on the tokyo
//    production stack, det(Rc) of the GS chain sits flat on its 1e-15
//    orthonormalisation noise floor across the whole fundamental-mode band
//    (k = 0.5-1.0/km at 0.5 Hz) and the raw un-renormalised chain rides
//    e^+-80 intermediates with e^19 subdivide staircases — neither exposed
//    roots. (The v5 GS-consistency contract existed for the residue scheme;
//    with residues abandoned for window integration, the determinant is
//    only a root locator and wants the best-conditioned chain available.)
//    Each coarse minimum is refined IN THE COMPLEX PLANE by Newton
//    iterations: kappa* = k - i*gamma with gamma = |Im kappa*| the true
//    modal damping half-width (real-axis minima are clamp-limited by the
//    chain's cancellation floor and never reach gamma — the v3 "gamma_d
//    precision gap"). The real-axis integrand still has no singularity;
//    integration adds a gamma-resolved local window per pole (gamma/4
//    steps over +-8*gamma, geometric tail to ~100*gamma) and integrates
//    with the plain non-uniform trapezoid. A range-adaptive floor
//    dk >= (2*pi/r)/10 guards the J-weight oscillation against aliasing —
//    the fixed production dkInvKm=0.02/km samples the J period 1.6 times
//    at r=198.5 km, the tokyo grid-series instability root cause.
//
//  * Scale status (2026-09-06, layered-roots batch): the absolute moment
//    response is ANCHORED against the closed-form full-space elastodynamic
//    solution (tools/broadband/psv-fullspace.js, tests/psv-fullspace.test.js
//    A1-A3: five pure tensors, complex residual <= 8%, integrand-level
//    agreement exact); the source anchor batch also fixed three missing
//    dipole terms, one wrong-column term, a RELATIVE -1 between the
//    traction and dipole families, and the razor band-nulling defect.
//    Layered root tracking is LANDED and verified where ground truth
//    exists (R8: machinery vs independent brute <= 5%; R9: grid
//    independence <= 10%; the R8 widened-Q root refines to the true
//    Rayleigh position the v5 detector missed). The below-alias-floor
//    production dk series convergence is delivered by BRANCH-TAIL SINGULAR
//    SUBTRACTION (2026-09-06 branch-cusp batch): every layer contributes
//    branch points k = omega/vp_i, omega/vs_i where the compliance carries
//    1/sqrt factors (1/nu in the admittance/Green terms) — integrable, but
//    a plain trapezoid over the cusp converges only O(sqrt(h)) (frozen v4:
//    tokyo fullTensor below-floor series spread 3.3x, dominant sample at
//    the IASP91 halfspace P branch ~0.524/km). The integrand is now
//    evaluated as (g - sum_bp A_bp/sqrt(k*_bp - k)) with the complex
//    damped branch point k* = nuOf(v, omega, 0, q) and A fitted per branch
//    point from samples just below it (median over 4 offsets); the
//    smooth/kinked remainder goes through the same trapezoid and the model
//    is re-added as its EXACT analytic integral 2A(sqrt(k*) - sqrt(k* -
//    kMax)); the Im>=0 branch continuation covers the evanescent side
//    with the same coefficient. fullSpace mode and single-layer stacks
//    stay anchored as before. The aliasing guard also implies the SH
//    kernel (core.js) at long range samples the same J oscillation with
//    the same fixed production dk — its B2-era long-range numbers carried
//    the same exposure (guard landed 2026-09-06; quantified in
//    tools/data/sh-alias-exposure.json).
//
//  * Anchor set (tests/broadband-psv.test.js — the P-SV equivalent of the
//  SH kernel's A1/A2 discipline, chosen to be exact and self-contained):
//      R1  Rayleigh dispersion root of psvDispersionFunction for a
//          halfspace lands at c = omega/k = c_R from the Rayleigh cubic
//          (self-solved in-test; 0.9194 beta at Poisson 0.25) — exercises
//          eigenvectors, propagator, admittance and the surface solve.
//      R2  independent stepwise ODE integration (RK4) of the same P-SV
//          system vs the eigenvector propagator solve at production
//          wavenumbers (cross-implementation check).
//      R3  Radiation nodes: a pure-Mxy tensor gives EXACTLY zero radial
//          and vertical P-SV motion on the receiver axis; pure Mzz gives
//          EXACTLY zero radial motion.
//      R4  alpha-identity assembly vs direct numerical alpha quadrature,
//          PER wavenumber (integrand-level; integration-free by design so
//          it stays independent of the pole machinery).
//      R5  Dipole depth-FD convergence: the Mzz/Mxz/Myz responses are
//          converged at dh = 0.5 m (|dh=0.25 - dh=1.0| relative change
//          small vs the value).
//      R6  Band stability (no NaN/overflow over the production band).
//      R7  Absolute scale: k->0 sigma_zz column matches the exact SI 1D
//          closed-form column compliance.
//      R8  Pole-separated integration vs brute-force fine-grid quadrature
//          of the SAME integrand at an artificially widened pole (heavy
//          Q) — machinery validation end to end.
//      R9  Production grid independence: two very different (dk, kMax)
//          grids agree at production Q — the failure mode that blocked
//          the v3-era plain-sum integration is closed.
// =====================================================================
const core = require('./core.js');
const psvFs = require('./psv-fullspace.js');

const cadd = core.cadd, csub = core.csub, cmul = core.cmul,
  cscale = core.cscale, cdiv = core.cdiv, cabs = core.cabs, CI = core.CI;
const csqrtPosIm = core.csqrtPosIm;

/** nu_c = sqrt(w^2/c^2 - k^2), Im >= 0, complex velocity c* = c(1-i/(2Q)).
 *  k may be a real number (1/m) or a complex pair [re, im] — the complex
 *  form exists for complex-plane root tracking (psvModalPoles Newton); the
 *  real path reproduces the historical expression bit-exactly. */
function nuOf(vKmS, omega, kInvM, q) {
  var b = vKmS * 1000;
  var b2 = (q && q > 0) ? [b * b, -b * b / q] : [b * b, 0];
  var om2 = omega * omega;
  var k2re, k2im;
  if (typeof kInvM === 'number') {
    k2re = kInvM * kInvM; k2im = 0;
  } else {
    k2re = kInvM[0] * kInvM[0] - kInvM[1] * kInvM[1];
    k2im = 2 * kInvM[0] * kInvM[1];
  }
  var val = [om2 * b2[0] / (b2[0] * b2[0] + b2[1] * b2[1]) - k2re,
             -om2 * b2[1] / (b2[0] * b2[0] + b2[1] * b2[1]) - k2im];
  return csqrtPosIm(val);
}

// --- small complex 2x2 / 4x4 helpers ------------------------------------
function m4v(M, v) {
  var out = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (var i = 0; i < 4; i++) {
    var s = [0, 0];
    for (var l = 0; l < 4; l++) s = cadd(s, cmul(M[i][l], v[l]));
    out[i] = s;
  }
  return out;
}
function m4mul(A, B) {
  var out = [];
  for (var i = 0; i < 4; i++) {
    var row = [];
    for (var j = 0; j < 4; j++) {
      var s = [0, 0];
      for (var l = 0; l < 4; l++) s = cadd(s, cmul(A[i][l], B[l][j]));
      row.push(s);
    }
    out.push(row);
  }
  return out;
}
function m4inv(A) {
  var M = A.map(function (row, i) {
    return row.concat([[1, 0], [0, 0], [0, 0], [0, 0]].map(function (e, j) { return i === j ? [1, 0] : [0, 0]; }));
  });
  for (var col = 0; col < 4; col++) {
    var piv = col;
    for (var r2 = col + 1; r2 < 4; r2++) if (cabs(M[r2][col]) > cabs(M[piv][col])) piv = r2;
    var t = M[col]; M[col] = M[piv]; M[piv] = t;
    var d = M[col][col];
    if (cabs(d) < 1e-300) throw new Error('psv: singular 4x4');
    for (var c4 = 0; c4 < 8; c4++) M[col][c4] = cdiv(M[col][c4], d);
    for (var rr = 0; rr < 4; rr++) if (rr !== col) {
      var f = M[rr][col];
      if (cabs(f) === 0) continue;
      for (var cc = 0; cc < 8; cc++) M[rr][cc] = csub(M[rr][cc], cmul(f, M[col][cc]));
    }
  }
  return [M[0].slice(4), M[1].slice(4), M[2].slice(4), M[3].slice(4)];
}
function m2mul(A, B) {
  return [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
          [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
}
function m2inv(A) {
  var det = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0]));
  if (cabs(det) < 1e-300) throw new Error('psv: singular 2x2');
  return [[cdiv(A[1][1], det), cscale(cdiv(A[0][1], det), -1)],
          [cscale(cdiv(A[1][0], det), -1), cdiv(A[0][0], det)]];
}

/** Eigenvector matrix E, columns (P down, P up, SV down, SV up), rows
 *  (u_r, u_z, tau_rz, s_zz). P s_zz = ±(2 mu k^2 - rho w^2): from
 *  s_zz = lam(-k^2 - nu_a^2) + 2 mu (i nu_a)^2 with nu_a^2 = w^2/a^2 - k^2
 *  and lam w^2/a^2 = rho w^2 (lam+2mu)/lam — = -(rho w^2 - 2 mu k^2). */
function psvEigenvectors(layer, omega, k, opts) {
  var kp = typeof k === 'number' ? [k, 0] : k;
  var mu = layer.rhoGcm3 * 1000 * Math.pow(layer.vsKmS * 1000, 2);
  var nuA = nuOf(layer.vpKmS, omega, kp, opts && opts.qP);
  var nuB = nuOf(layer.vsKmS, omega, kp, opts && opts.qShear);
  var ik = cmul(kp, CI);
  var iA = cmul(nuA, CI), iB = cmul(nuB, CI);
  var szP = csub(cmul(cmul([2 * mu, 0], kp), kp), [layer.rhoGcm3 * 1000 * omega * omega, 0]);
  var svs = cmul([mu, 0], csub(cmul(kp, kp), cmul(nuB, nuB)));
  var m2kA = cmul(cmul([-2 * mu, 0], nuA), kp);
  var p2kA = cmul(cmul([2 * mu, 0], nuA), kp);
  var m2kB = cmul(cmul([2 * mu, 0], nuB), kp);
  return [
    [ik, ik, iB, cscale(iB, -1)],
    [iA, cscale(iA, -1), cscale(ik, -1), cscale(ik, -1)],
    [m2kA, p2kA, svs, svs],
    // s_zz(P) = lam(-k^2 - nu_a^2) + 2 mu (±i nu_a)^2 = 2 mu k^2 - rho w^2
    // for BOTH directions (u_z and dz u_z both flip; the product doesn't).
    // Only the SV s_zz flips (2 mu dz u_z with dz u_z = -ik for both, times
    // ±i nu_b from u_r's derivative).
    [szP, szP, m2kB, cscale(m2kB, -1)]
  ];
}

function expITheta(z) { var w = [-z[1], z[0]]; return [Math.exp(w[0]) * Math.cos(w[1]), Math.exp(w[0]) * Math.sin(w[1])]; }

/** 4x4 layer propagator P = E diag(e^{i nuA h}, e^{-i nuA h}, e^{i nuB h}, e^{-i nuB h}) E^-1.
 *  EVALUATED WITHOUT EIGENDECOMPOSITION (2026-09-06 layered-roots batch):
 *  the propagator is the matrix exponential exp(A h) of the layer ODE
 *  system (the same system the R2 RK4 cross-check integrates), computed by
 *  scaling-and-squaring with a Taylor series. The E diag D E^-1 form is
 *  singular at the layer branch points k = omega/v_p, omega/v_s (P up/down
 *  eigenvectors coalesce at nu = 0, det(E) -> 0) — measured on the tokyo
 *  stack at 0.5 Hz, k = 1.68/km: the compliance jumped 8 orders across the
 *  branch point and the windowed grid series diverged (rel 1.1-4.4). The
 *  matrix exponential is an ENTIRE function of the entries: no branch
 *  structure, smooth in k, uniformly conditioned (error ~ eps*||P||).
 *  Subdivide still bounds ||A h|| <= ~30 so the exponential entries stay
 *  within e^+-30. */
function psvPropagator(layer, omega, k, opts) {
  var h = (layer.bottomKm - layer.topKm) * 1000;
  var kp = typeof k === 'number' ? [k, 0] : k;
  var rho = layer.rhoGcm3 * 1000;
  var vsSi = layer.vsKmS * 1000, vpSi = layer.vpKmS * 1000;
  var qs = (opts && opts.qShear) || 0, qp = (opts && opts.qP) || 0;
  // DAMPED MODULI (2026-09-06 branch-cusp batch regression fix): c*^2 =
  // c^2 (1 - i/q) for q > 0 — EXACTLY nuOf's convention
  // (nuOf: omega^2/b^2 * (1+i/q)/(1+1/q^2) = omega^2/(b^2 (1-i/q))), so the
  // layer ODE eigenvalues are +-i*nuOf(c, omega, k, q) and expm carries the
  // e^{-Im(nu) h} layer attenuation. The 2026-09-06 layered-roots expm
  // rewrite built A from REAL moduli and silently dropped every layer's Q
  // (damping then entered only through the halvespace admittance: R8/R9
  // were blind because their stacks never run the propagator loop, R2 was
  // blind because it cross-checks the same system undamped) — interior
  // leaky resonances stayed ON the real axis at any q, which was the
  // measured tokyo fullTensor series blocker.
  var muR = rho * vsSi * vsSi;
  var muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  var lam2R = rho * vpSi * vpSi;
  var lamC = [lam2R - 2 * muR, (qs > 0 ? 2 * muR / qs : 0) - (qp > 0 ? lam2R / qp : 0)];
  var lamMu = cadd(lamC, cscale(muC, 2)); // lambda* + 2 mu*
  var ik = cmul(kp, CI);
  var ikLam = cmul(ik, cdiv(lamC, lamMu));
  var c1s = cdiv(csub(cmul(cmul(kp, kp), csub(lamMu, cdiv(cmul(lamC, lamC), lamMu))), [rho * omega * omega, 0]), muC);
  var w2vs2 = cdiv([-rho * omega * omega, 0], muC); // -rho w^2 / mu*
  var A = [
    [[0, 0], cscale(ik, -1), [1, 0], [0, 0]],
    [cscale(ikLam, -1), [0, 0], [0, 0], cdiv(muC, lamMu)],
    [c1s, [0, 0], [0, 0], cscale(ikLam, -1)],
    [[0, 0], w2vs2, cscale(ik, -1), [0, 0]]
  ];
  var P = expm4(A, h);
  // Back-transform the traction rows/cols from the mu*-scaled state. The
  // transform MUST use the COMPLEX mu* (v7 fix 2026-09-09: the v6 batch
  // wrote the real muR here — with damping on, that mixes the state
  // convention by |mu*/muR| = |1 - i/q| per layer, a 2-4% per-layer
  // inconsistency the single-layer RK4 cross-check measured at 3.3% on the
  // R8 layer, q = 50; undamped mu* = muR keeps every legacy path
  // bit-identical).
  var muCinv = cdiv([1, 0], muC);
  var out = [];
  for (var i = 0; i < 4; i++) {
    var row = [];
    for (var j = 0; j < 4; j++) {
      var v = P[i][j];
      if (i >= 2) v = cmul(v, muC);
      if (j >= 2) v = cmul(v, muCinv);
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

/** exp(A*h) for a 4x4 complex matrix by scaling-and-squaring + Taylor
 *  (||A h|| scaled to <= 0.25, 24 terms -> truncation < 1e-24 relative). */
function expm4(A, h) {
  var norm = 0, i, j, l;
  for (i = 0; i < 4; i++) {
    var rowSum = 0;
    for (j = 0; j < 4; j++) rowSum += cabs(A[i][j]);
    if (rowSum > norm) norm = rowSum;
  }
  var s = 0;
  while (norm * h > 0.25) { s++; norm /= 2; }
  var B = [];
  for (i = 0; i < 4; i++) {
    B.push([]);
    for (j = 0; j < 4; j++) B[i].push(cscale(A[i][j], h / Math.pow(2, s)));
  }
  var E = [[1, 0], [0, 0], [0, 0], [0, 0]],
    E2 = [[0, 0], [1, 0], [0, 0], [0, 0]],
    E3 = [[0, 0], [0, 0], [1, 0], [0, 0]],
    E4 = [[0, 0], [0, 0], [0, 0], [1, 0]];
  var sum = [E, E2, E3, E4];
  var term = sum.map(function (r) { return r.slice(); });
  for (var n2 = 1; n2 <= 24; n2++) {
    var next = [];
    for (i = 0; i < 4; i++) {
      next.push([]);
      for (j = 0; j < 4; j++) {
        var acc = [0, 0];
        for (l = 0; l < 4; l++) acc = cadd(acc, cmul(term[i][l], B[l][j]));
        next[i].push(cscale(acc, 1 / n2));
      }
    }
    term = next;
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) sum[i][j] = cadd(sum[i][j], term[i][j]);
  }
  for (var q2 = 0; q2 < s; q2++) sum = m4mul(sum, sum);
  return sum;
}

/** Halfspace downgoing admittance tau = Y u for pure downgoing P+SV. */
function psvHalfspaceAdmittance(layer, omega, k, opts) {
  var E = psvEigenvectors(layer, omega, k, opts);
  var M1 = [[E[0][0], E[0][2]], [E[1][0], E[1][2]]];
  var M2 = [[E[2][0], E[2][2]], [E[3][0], E[3][2]]];
  return m2mul(M2, m2inv(M1));
}

/** Stack defaulting vp (soft-sediment ramp below 1 km/s, Poisson solid
 *  above; overridable per layer). */
function withVp(stack) {
  return stack.map(function (l) {
    if (l.vpKmS) return l;
    var vs = l.vsKmS;
    var vp = vs < 1.0 ? 0.35 + vs * 2.1 : vs * 1.732;
    return { topKm: l.topKm, bottomKm: l.bottomKm, vsKmS: vs, vpKmS: vp, rhoGcm3: l.rhoGcm3 };
  });
}

/** Split the stack at zSourceKm (boundary resolves to the layer TOP, same
 *  convention as core.prepareStack). */
function prepare(stack, zSourceKm) {
  var lay = withVp(stack).map(function (l) {
    return { topKm: l.topKm, bottomKm: isFinite(l.bottomKm) ? l.bottomKm : 1e6, vsKmS: l.vsKmS, vpKmS: l.vpKmS, rhoGcm3: l.rhoGcm3 };
  });
  for (var i = 0; i < lay.length; i++) {
    if (zSourceKm > lay[i].topKm + 1e-9 && zSourceKm < lay[i].bottomKm - 1e-9) {
      lay.splice(i + 1, 0, { topKm: zSourceKm, bottomKm: lay[i].bottomKm, vsKmS: lay[i].vsKmS, vpKmS: lay[i].vpKmS, rhoGcm3: lay[i].rhoGcm3 });
      lay[i].bottomKm = zSourceKm;
      break;
    }
  }
  var iS = 0;
  for (var j = 0; j < lay.length; j++) if (lay[j].topKm >= zSourceKm - 1e-9) { iS = j; break; }
  return { layers: lay, halfIndex: lay.length - 1, iS: iS };
}

function cconj(c) { return [c[0], -c[1]]; }
function maxabs(v) { var m = 0; for (var i = 0; i < v.length; i++) { var a = cabs(v[i]); if (a > m) m = a; } return m; }

/** Subdivide layers so every propagator exponent |nu|*h stays <= 30
 *  (exp(30) ~ 1e13, well inside double range): thick low-loss layers at
 *  high k otherwise overflow the E L E^-1 product before any
 *  re-orthonormalisation can run. Material unchanged; only the split.
 *  opts._subCap overrides the cap (dual-chain invariance confirmations:
 *  a physical value is cap-invariant, a rounding artifact moves with the
 *  split pattern — same contract as psvDispersionDetRaw). */
function subdivide(lay, omega, k, opts) {
  return subdivideCap(lay, omega, k, opts, (opts && opts._subCap) || 30);
}

/** Shared surface propagation — the single source of the A/W chain.
 *  DELTA-MATRIX (ORTHONORMALISATION) CHAIN (2026-09-09, Rc-degeneracy
 *  batch): the carried column set S (A pair above the source, A+W below)
 *  is factorised EXACTLY as S = Q·T with Q orthonormal columns and T
 *  upper-triangular; every layer multiplies Q by the propagator and
 *  re-orthonormalises by modified Gram-Schmidt (two passes), pushing the
 *  growth into R and accumulating T <- R·T. The physical amplitudes live
 *  in T as PRODUCTS of per-layer R factors — never as differences of
 *  large numbers. The retired joint-scalar chain preserved column RATIOS
 *  but not column INDEPENDENCE: over the deep above-source leg both A
 *  columns converge onto the dominant solution, their difference decays
 *  like e^-80 relative, and in the tokyo leaky-P crest band the residual
 *  basis went float-exactly PARALLEL — det(Rc) read exact 0, m2inv threw,
 *  and the null-riddled crest made the fullTensor dk series non-monotone.
 *  (The v5 GS failure is NOT this chain: v5 switched between orthogonalise
 *  and scale-only representations — 1e-8 discontinuities amplified by
 *  Rc^-1. Here there are NO representation decisions: MGS always runs,
 *  R is continuous in k, T is jointly rescaled by a single continuous
 *  factor — the whole chain is a continuous function of k.)
 *
 *  Bookkeeping mirrors the retired chain exactly: T is divided per layer
 *  by its own max entry (ALL columns by the SAME factor — the ratio
 *  Rc^-1 Rw is invariant); ABOVE the source that factor scales the A pair
 *  alone, so its log accumulates in sigma exactly as before and the
 *  physical compliance is C = -exp(-sigma) * (Rc^-1 Rw). Below the source
 *  the factor hits both pairs and cancels.
 *
 *  Returns the residual matrices { Rc, Rw } in the renormalised frame plus
 *  sigma. Null on genuine overflow/underflow (a column norm < 1e-290, a
 *  non-finite T, or |sigma| > 650: the above-source evanescent decoupling
 *  makes the surface response genuinely zero there — dropping the sample
 *  is the correct answer). */
function surfacePropagation(stack, omega, k, zSourceKm, opts) {
  var st = prepare(stack, zSourceKm);
  var lay = subdivide(st.layers, omega, k, opts);
  var cols = [[[1, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [0, 0], [0, 0]]];
  var w = 2;
  var T = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]];
  var sigma = 0, i, m, step;
  for (i = 0; i < st.iS; i++) {
    step = mgsStep(cols, psvPropagator(lay[i], omega, k, opts));
    if (!step) return null;
    T = triMul(step.R, T, w);
    m = triMax(T);
    if (!(m > 0) || !isFinite(m)) return null;
    T = triScale(T, 1 / m, w);
    sigma += Math.log(m);
    cols = step.Q;
  }
  // below the source the W pair joins on the canonical basis vectors; the
  // next MGS pass orthogonalises them against the carried A directions.
  cols = cols.concat([[[0, 0], [0, 0], [1, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [1, 0]]]);
  T = T.map(function (row) { return row.concat([[0, 0], [0, 0]]); })
    .concat([[[0, 0], [0, 0], [1, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [1, 0]]]);
  w = 4;
  for (var j2 = st.iS; j2 < st.halfIndex; j2++) {
    step = mgsStep(cols, psvPropagator(lay[j2], omega, k, opts));
    if (!step) return null;
    T = triMul(step.R, T, w);
    m = triMax(T);
    if (!(m > 0) || !isFinite(m)) return null;
    T = triScale(T, 1 / m, w); // joint A+W factor — cancels in the ratio
    cols = step.Q;
  }
  if (!(sigma > -650) || !(sigma < 650)) return null;
  function colOf(c) {
    var out = [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (var r = 0; r < w; r++) {
      var f = T[r][c];
      if (f[0] === 0 && f[1] === 0) continue;
      for (var rr = 0; rr < 4; rr++) out[rr] = cadd(out[rr], cmul(cols[r][rr], f));
    }
    return out;
  }
  var Y = psvHalfspaceAdmittance(lay[st.halfIndex], omega, k, opts);
  if (!Y) return null;
  function resid(col) {
    return [csub(col[2], cadd(cmul(Y[0][0], col[0]), cmul(Y[0][1], col[1]))),
            csub(col[3], cadd(cmul(Y[1][0], col[0]), cmul(Y[1][1], col[1])))];
  }
  var rA0 = resid(colOf(0)), rA1 = resid(colOf(1));
  var Rc = [[rA0[0], rA1[0]], [rA0[1], rA1[1]]];
  var rW0 = resid(colOf(2)), rW1 = resid(colOf(3));
  var Rw = [[rW0[0], rW1[0]], [rW0[1], rW1[1]]];
  return { Rc: Rc, Rw: Rw, sigma: sigma };
}

/** One modified-Gram-Schmidt step: M = P·cols factorised as Q·R (Q
 *  orthonormal 4-vectors, R upper-triangular with a real positive
 *  diagonal), two reorthogonalisation passes. Continuous in k wherever the
 *  column norms are nonzero; null on a degenerate (norm < 1e-290) column. */
function mgsStep(cols, P) {
  var w = cols.length;
  var Q = [], R = [];
  for (var i = 0; i < w; i++) { R.push([]); for (var j = 0; j < w; j++) R[i].push([0, 0]); }
  for (var c = 0; c < w; c++) {
    var v = m4v(P, cols[c]);
    for (var pass = 0; pass < 2; pass++) {
      for (var kk = 0; kk < c; kk++) {
        var d = [0, 0];
        for (var r = 0; r < 4; r++) d = cadd(d, cmul(cconj(Q[kk][r]), v[r]));
        if (pass === 0) R[kk][c] = d; else R[kk][c] = cadd(R[kk][c], d);
        for (var r2 = 0; r2 < 4; r2++) v[r2] = csub(v[r2], cmul(Q[kk][r2], d));
      }
    }
    var n2 = 0;
    for (var r3 = 0; r3 < 4; r3++) n2 += v[r3][0] * v[r3][0] + v[r3][1] * v[r3][1];
    var n = Math.sqrt(n2);
    if (!(n > 1e-290) || !isFinite(n)) return null;
    var q = [];
    for (var r4 = 0; r4 < 4; r4++) q.push(cscale(v[r4], 1 / n));
    Q.push(q);
    R[c][c] = [n, 0];
  }
  return { Q: Q, R: R };
}
/** w×w complex product for the T bookkeeping (R upper-triangular; the
 *  full sum is kept — the 2026-09-09 first cut bounded l <= i, which is the
 *  DIAGONAL's index and silently dropped every j > i cross term of the
 *  upper-triangular product). */
function triMul(R, T, w) {
  var out = [];
  for (var i = 0; i < w; i++) {
    var row = [];
    for (var j = 0; j < w; j++) {
      var s = [0, 0];
      for (var l = 0; l < w; l++) s = cadd(s, cmul(R[i][l], T[l][j]));
      row.push(s);
    }
    out.push(row);
  }
  return out;
}
function triMax(T) {
  var m = 0;
  for (var i = 0; i < T.length; i++) for (var j = 0; j < T[i].length; j++) {
    var a = cabs(T[i][j]);
    if (a > m) m = a;
  }
  return m;
}
function triScale(T, s, w) {
  var out = [];
  for (var i = 0; i < w; i++) {
    var row = [];
    for (var j = 0; j < w; j++) row.push(cscale(T[i][j], s));
    out.push(row);
  }
  return out;
}

/** Scale every entry of a 4-vector-of-complex-pairs column. */
function scaleCols4(cols, s) {
  var out = [];
  for (var i = 0; i < cols.length; i++) out.push(cscale(cols[i], s));
  return out;
}

/** Layered surface compliance u0 = C . DeltaT; rows (u_r, u_z), columns
 *  (Delta tau_rz, Delta sigma_zz). Null on genuine overflow/ill-conditioning.
 *  Delta-matrix chain (see surfacePropagation): the physical compliance is
 *  C = -exp(-sigma) * (Rc^-1 Rw); sigma is now the accumulated log of the
 *  above-source T rescalings (the below-source factor cancels as before). */
function psvSurfaceCompliance(stack, omega, k, zSourceKm, opts) {
  var pr = surfacePropagation(stack, omega, k, zSourceKm, opts);
  if (!pr) return null;
  var RcInv;
  try { RcInv = m2inv(pr.Rc); } catch (e) { return null; }
  // C = -exp(-sigma) * (Rc^-1 Rw): the A pair was scaled DOWN by e^{sigma}
  // above the source (W starts at the source; the joint below-source factors
  // hit both pairs and cancel), so Rc_ren = e^{-sigma} Rc_phys and
  // Rc_phys^-1 = e^{-sigma} Rc_ren^-1 carries the factor back IN.
  var fac = Math.exp(-pr.sigma);
  var C = m2mul(RcInv, pr.Rw);
  var out = [[cscale(C[0][0], -fac), cscale(C[0][1], -fac)], [cscale(C[1][0], -fac), cscale(C[1][1], -fac)]];
  for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
    if (!isFinite(out[i][j][0]) || !isFinite(out[i][j][1])) return null;
  }
  return out;
}

/** Dispersion determinant on the SHARED raw renormalised chain (kept for
 *  the R1 halfspace Rayleigh-root anchor; production root finding uses
 *  psvDispersionDetRaw — same chain family, with the accumulated scale
 *  tracked separately so log|D| stays meaningful on deep stacks). */
function psvDispersionFunction(stack, omega, kInvKm, opts) {
  var k = kInvKm / 1000;
  var zs = (opts && opts.zSourceKm != null) ? opts.zSourceKm : 1e-4;
  var pr = surfacePropagation(stack, omega, k, zs, opts);
  if (!pr) return null;
  var Rc = pr.Rc;
  return csub(cmul(Rc[0][0], Rc[1][1]), cmul(Rc[1][0], Rc[0][1]));
}

var poleCache = new Map();
/** The halfspace (terminating) layer of a stack: the infinite-bottom entry,
 *  else the last one. Its branch points are the compliance chain's only
 *  true real-axis non-analyticities. */
function wvHalfspace(stack) {
  for (var i = 0; i < stack.length; i++) {
    if (!isFinite(stack[i].bottomKm)) return withVp([stack[i]])[0];
  }
  return stack.length ? withVp([stack[stack.length - 1]])[0] : null;
}
function stackSig(stack, opts) {
  var s = '';
  for (var i = 0; i < stack.length; i++) {
    var l = stack[i];
    s += '[' + l.topKm + ',' + l.bottomKm + ',' + l.vsKmS + ',' + (l.vpKmS || 0) + ',' + l.rhoGcm3 + ']';
  }
  return s + '|Q' + ((opts && opts.qShear) || 0) + '/' + ((opts && opts.qP) || 0);
}

/** RAW dispersion determinant for ROOT FINDING (complex kappa, 1/m pair).
 *  Plain propagator-product chain over the subdivided stack (NO
 *  Gram-Schmidt, hence no orthonormalisation noise floor) with a JOINT
 *  per-layer scalar renormalisation: after every layer both basis columns
 *  are scaled by 1/max|entry| — max() of continuous entries is continuous,
 *  so the chain has no staircase — and the accumulated factor is returned
 *  separately as logScale. The returned det carries an arbitrary smooth
 *  scale; zeros are the modal poles. rescaled = det * exp(-logScale) is the
 *  scale-free determinant (may over/underflow; compare via
 *  log|det| - logScale instead). Returns null on degenerate columns.
 *  zSourceKm only decides where the chain is split for the subdivide step —
 *  the product covers every layer above the halfspace, so the roots are
 *  the full-column surface-wave modes regardless.
 *  opts._subCap overrides the subdivide exponent cap (dual-chain pole
 *  confirmation: a PHYSICAL det dip is chain-invariant, a float-noise dip
 *  moves with the rounding pattern). */
function psvDispersionDetRaw(stack, omega, kappa, opts) {
  var zs = (opts && opts.zSourceKm != null) ? opts.zSourceKm : 1e-4;
  var st = prepare(stack, zs);
  var lay = subdivideCap(st.layers, omega, kappa, opts, (opts && opts._subCap) || 30);
  var A0 = [[1, 0], [0, 0], [0, 0], [0, 0]];
  var A1 = [[0, 0], [1, 0], [0, 0], [0, 0]];
  var logScale = 0;
  for (var i = 0; i < st.halfIndex; i++) {
    var P = psvPropagator(lay[i], omega, kappa, opts);
    A0 = m4v(P, A0); A1 = m4v(P, A1);
    var m = maxabs(A0);
    var m1 = maxabs(A1);
    if (m1 > m) m = m1;
    if (!(m > 0) || !isFinite(m)) return null;
    A0 = scaleCols4(A0, 1 / m);
    A1 = scaleCols4(A1, 1 / m);
    logScale += 2 * Math.log(m);
  }
  var Y = psvHalfspaceAdmittance(lay[st.halfIndex], omega, kappa, opts);
  if (!Y) return null;
  function resid(col) {
    return [csub(col[2], cadd(cmul(Y[0][0], col[0]), cmul(Y[0][1], col[1]))),
            csub(col[3], cadd(cmul(Y[1][0], col[0]), cmul(Y[1][1], col[1])))];
  }
  var rA0 = resid(A0), rA1 = resid(A1);
  var det = csub(cmul(rA0[0], rA1[1]), cmul(rA1[0], rA0[1]));
  if (!isFinite(det[0]) || !isFinite(det[1])) return null;
  return { det: det, logScale: logScale };
}

/** subdivide with an explicit exponent cap (the production cap is 30;
 *  pole confirmation re-runs the chain at 24 — see psvDispersionDetRaw). */
function subdivideCap(lay, omega, k, opts, cap) {
  var out = [];
  for (var i = 0; i < lay.length; i++) {
    var l = lay[i];
    var hM = (l.bottomKm - l.topKm) * 1000;
    var nuA = nuOf(l.vpKmS, omega, k, opts && opts.qP);
    var nuB = nuOf(l.vsKmS, omega, k, opts && opts.qShear);
    var nMax = Math.max(cabs(nuA), cabs(nuB));
    var nSub = Math.max(1, Math.min(400, Math.ceil((nMax * hM) / cap)));
    if (nSub === 1) { out.push(l); continue; }
    var dh = hM / nSub;
    for (var s = 0; s < nSub; s++) {
      out.push({ topKm: l.topKm + (s * dh) / 1000, bottomKm: l.topKm + ((s + 1) * dh) / 1000, vsKmS: l.vsKmS, vpKmS: l.vpKmS, rhoGcm3: l.rhoGcm3 });
    }
  }
  return out;
}

/** Scale every entry of a 4-vector-of-complex-pairs column. */
function scaleCols4(cols, s) {
  var out = [];
  for (var i = 0; i < cols.length; i++) out.push(cscale(cols[i], s));
  return out;
}

/** Modal (surface-wave) pole wavenumbers of the stack inside (0, kMaxInvKm).
 *
 *  COMPLIANCE-RIDGE DETECTION (2026-09-06 branch-cusp batch re-diagnosis;
 *  replaces the dispersion-determinant dip scanner wholesale).
 *
 *  WHY THE DET SCANNER DIED (measured on the tokyo 13-layer JIVSM+IASP91
 *  column, 0.5 Hz, production qShear 50): the renormalised determinant sits
 *  at e^-288 there — dip depths comparable to the chain's cancellation
 *  noise, the 400-point scan (step 0.0124/km) steps clean OVER the
 *  fundamental (a basin-trapped mode at k = 1.005/km with ridge HWHM
 *  ~1.5e-3/km and a 10-order integrand contrast), and the 2D complex Newton
 *  fails for every candidate. The v4 root table (4/4 raw at f0p5: 1.514,
 *  1.875, 3.232, 3.805/km) was noise dips — the integrand at those k is
 *  ~1e-13 (nothing). The windowed integration then rode the coarse
 *  production lattice across the unresolved fundamental and the tokyo dk
 *  series scattered over 286 -> 86 while the plain fine-grid sum sat at
 *  ~56-62. The surface compliance, by contrast, is BOUNDED and smooth
 *  (the Rc^-1 Rw 1/nu factors cancel — measured: |g| plateaus toward every
 *  branch point), tensor-free, and its modal resonances are unambiguous
 *  local ridges. So detect on the ridge directly:
 *    1. SCAN log max|C_ij| at a fixed 5e-4/km step — the resolution floor;
 *       measured basin-trapped modes run HWHM ~1e-3/km (effective Q far
 *       above the material Q because the energy is trapped in the low-loss
 *       sediment), so anything coarser steps over them;
 *    2. LOCAL MAXIMA with prominence >= 0.75 against a LINEAR background
 *       fit over +-0.12/km (halvespace branch zones excluded) — the
 *       e^{-k z} evanescent background is linear in log, the fit removes
 *       it, and a monotone slope alone cannot manufacture prominence;
 *    3. BRANCH-POINT EXCLUSION +-0.05/km for the HALVESPACE branches ONLY
 *       (k = omega/vp_hs, omega/vs_hs): with the matrix-exponential
 *       propagator the INTERIOR layer branch points are not singular
 *       points of the compliance chain at all (the layer ODE matrix A
 *       contains no nu; the only nu-dependent piece is the halvespace
 *       admittance) — and measured on the tokyo column the interior
 *       "branch" neighbourhoods actually carry the stack's LEAKY P
 *       resonances (huge bounded integrand spikes at 0.436/0.476/0.520/km,
 *       the v4 series chaos), which an interior-branch exclusion would
 *       hide. There is no proper-mode gate either: leaky resonances are
 *       real integrand structure and need windows exactly like trapped
 *       modes;
 *    4. golden-section refinement of the peak position, then gamma from
 *       the HWHM walk of the bounded ridge (|C| ~ A/sqrt(delta^2+gamma^2)
 *       halves at delta = sqrt(3) gamma), floored at max(2 scan steps,
 *       k/(32 Q)) and capped at 0.4 k.
 *  Entries stay { k, gammaKm, refined } in 1/km, refined: true — position
 *  and width are measured on the bounded ridge, not on a noise-buried det.
 *  Module-cached per (stack, omega, Q, kMax). */
function psvModalPoles(stack, omega, kMaxInvKm, opts) {
  if (opts && !opts.qP && opts.qShear) {
    opts = Object.assign({}, opts, { qP: opts.qShear });
  }
  var key = stackSig(stack, opts) + '|' + omega.toFixed(10) + '|' + kMaxInvKm;
  var hit = poleCache.get(key);
  if (hit) return hit;
  var lo = 0.02, hi = Math.max(kMaxInvKm, 0.1);
  var N = Math.min(24000, Math.ceil((hi - lo) / 2.5e-4));
  var step = (hi - lo) / N;
  // Scan object (v6): log|det(Rc)| at a SURFACE source (zs = 1e-4). The
  // pole condition is source-independent, and a buried-source scan loses
  // exactly the modes whose depth eigenfunction is small at zs (measured:
  // the R8 widened-Q Rayleigh ridge in |C(zs=15km)| sank under the
  // e^{-kz} background once layer attenuation was restored, and the
  // detector went blind to it). The surface-source det(Rc) landscape is
  // healthy post-attenuation-fix on both the R8 halfspace (dip ~1 log
  // unit deep) and the tokyo column (background e^-24..e^-38, no e^-288
  // chain floor anymore). Poles are DIPS of this landscape.
  var zs = 1e-4;
  function logC(kk) {
    var pr = surfacePropagation(stack, omega, kk / 1000, zs, opts);
    if (!pr) return null;
    return Math.log(cabs(csub(cmul(pr.Rc[0][0], pr.Rc[1][1]), cmul(pr.Rc[1][0], pr.Rc[0][1]))) + 1e-300);
  }
  // HALVESPACE branch points only (1/km) — see the doc: interior layers'
  // branch points are analytic points of the expm chain, and their
  // neighbourhoods carry leaky resonances the detector must SEE.
  var wBP = 0.05;
  var bp = [];
  var hs = wvHalfspace(stack);
  if (hs) bp.push(omega / hs.vpKmS, omega / hs.vsKmS);
  function nearBranch(kk) {
    for (var b = 0; b < bp.length; b++) if (Math.abs(kk - bp[b]) < wBP) return true;
    return false;
  }
  var lc = [];
  for (var i0 = 0; i0 <= N; i0++) lc.push(logC(lo + step * i0));
  // linear background fit over +-0.12/km around sample j0 (branch zones and
  // a +-0.015/km near-peak strip excluded); null when too few samples.
  function bgFit(j0) {
    var k0 = lo + step * j0;
    var pts = [];
    // +-0.25/km window: a mode dip is itself up to ~0.1/km wide, and the
    // halvespace-branch exclusion removes its steep flank samples — a
    // +-0.12 fit rode inside the dip and measured the R8 widened-Q
    // Rayleigh dip at prominence 0.25 (< gate). Skip +-0.02 around the dip.
    var jA = Math.max(0, j0 - Math.round(0.25 / step)), jB = Math.min(N, j0 + Math.round(0.25 / step));
    var skip = Math.max(1, Math.round(0.02 / step));
    for (var q = jA; q <= jB; q++) {
      if (Math.abs(q - j0) < skip) continue;
      if (lc[q] == null || !isFinite(lc[q])) continue;
      var kx = lo + step * q;
      if (nearBranch(kx)) continue;
      pts.push([kx, lc[q]]);
    }
    if (pts.length < 6) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var p = 0; p < pts.length; p++) {
      sx += pts[p][0]; sy += pts[p][1]; sxx += pts[p][0] * pts[p][0]; sxy += pts[p][0] * pts[p][1];
    }
    var n = pts.length, den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-30) return sy / n;
    var slope = (n * sxy - sx * sy) / den, icpt = (sy - slope * sx) / n;
    return icpt + slope * k0;
  }
  function val(kk) {
    var v = logC(kk);
    return (v == null || !isFinite(v)) ? -1e6 : v;
  }
  var found = [];
  for (var j1 = 1; j1 < N; j1++) {
    var kj = lo + step * j1;
    if (nearBranch(kj)) continue;
    if (lc[j1] == null || !isFinite(lc[j1])) continue;
    // sampled local minimum (null neighbours read as -Infinity: a null
    // sample at the dip bottom qualifies as the minimum)
    if (lc[j1] > val(kj - step) || lc[j1] > val(kj + step)) continue;
    var bg = bgFit(j1);
    if (bg == null) continue;
    if (!(bg - lc[j1] > 0.5)) continue;
    var dup = false;
    for (var f = 0; f < found.length; f++) if (Math.abs(found[f].k - kj) < 4 * step) { dup = true; break; }
    if (dup) continue;
    // golden-section refine of the dip within +-2 scan steps (minimise)
    var ga = kj - 2 * step, gb = kj + 2 * step, gr = 0.6180339887;
    var c = gb - gr * (gb - ga), d = ga + gr * (gb - ga);
    var fc = val(c), fd = val(d);
    for (var it = 0; it < 40 && (gb - ga) > 1e-6 * step; it++) {
      if (fc < fd) { gb = d; d = c; fd = fc; c = gb - gr * (gb - ga); fc = val(c); }
      else { ga = c; c = d; fc = fd; d = ga + gr * (gb - ga); fd = val(d); }
    }
    var kpk = (ga + gb) / 2;
    if (nearBranch(kpk)) continue;
    var dup2 = false;
    for (var f2 = 0; f2 < found.length; f2++) if (Math.abs(found[f2].k - kpk) < 0.02) { dup2 = true; break; }
    if (dup2) continue;
    // gamma from the HWHM walk of the det dip (rise by ln2 above the dip
    // bottom on both sides). A noise-floored bottomless dip (near-axis
    // poles: measured det -> exact 0 on tokyo at ~0.53-0.56/km) walks out
    // to the floor fallback — the material scale / 16 — which still
    // centres a deterministic, grid-independent bridge window on the
    // degenerate band.
    var lmin = val(kpk);
    function hwhmSide(sgn) {
      var dd = Math.max(step / 2, 1e-4);
      for (var w = 0; w < 60; w++) {
        var v = val(kpk + sgn * dd);
        if (v > lmin + Math.LN2) return dd;
        dd *= 1.3;
        if (dd > 0.4 * kpk) break;
      }
      return 0;
    }
    var hL = hwhmSide(-1), hR = hwhmSide(1);
    var hwhm = (hL > 0 && hR > 0) ? (hL + hR) / 2 : Math.max(hL, hR);
    var qS0 = (opts && opts.qShear) || 0;
    var gMat = qS0 > 0 ? kpk / (2 * qS0) : 1e-6 * kpk;
    var gamma = hwhm > 0 ? hwhm : 0;
    gamma = Math.max(gamma, 2 * step, gMat / 16);
    if (!(gamma < 0.4 * kpk)) continue;
    found.push({ k: kpk, gammaKm: gamma, refined: true });
  }
  if (poleCache.size > 400) poleCache.clear();
  poleCache.set(key, found);
  return found;
}

/** Rotate the FULL moment tensor about the vertical by azimuthDeg
 *  (source-to-receiver azimuth from North; x = North, y = East, z = down
 *  frame, matching hybrid.dcMomentTensor's xx/yy/zz). */
function rotateFullTensor(M, azimuthDeg) {
  var a = azimuthDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  // R = [[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]] acting as M' = R M R^T
  var m = [[M.mxx, M.mxy, M.mxz], [M.mxy, M.myy, M.myz], [M.mxz, M.myz, M.mzz]];
  var R = [[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]];
  var out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
    var s = 0;
    for (var l = 0; l < 3; l++) for (var n = 0; n < 3; n++) s += R[i][l] * m[l][n] * R[j][n];
    out[i][j] = s;
  }
  return { mxx: out[0][0], myy: out[1][1], mzz: out[2][2], mxy: out[0][1], mxz: out[0][2], myz: out[1][2] };
}

/** Azimuth identities (z = k r): INT e^{iz cos a} cos(n a) da = 2 pi i^n J_n.
 *  Entries used: I0, I1 (pure imaginary), Icc = INT cos^2 = pi(J0-J2),
 *  Iss = INT sin^2 = pi(J0+J2), Ic2 = INT cos2a = -2 pi J2,
 *  Icc2 = INT cos a cos 2a = pi i (J1 - J3). */

/** DW spectrum of a rotated moment tensor at one frequency (layered path).
 *  params: { rKm, phiRad (default 0), zSourceKm, mxx,myy,mzz,mxy,mxz,myz,
 *            dkInvKm, kMaxInvKm, qShear, qP, dhM, cache }
 *  Returns { ur, uz, ut } complex — u_t carries ONLY the Mxz/Myz
 *  longitudinal transverse piece (the SH channel of the horizontal block
 *  is core.js's, complete there).
 *  Integration: modal poles inside the band are RESOLVED by gamma-resolved
 *  tiered windows (the real-axis integrand is smooth there — damped peak),
 *  and the branch-tail cusp at every k = omega/vp_i, omega/vs_i is handled
 *  by analytic singular-factor subtraction (fit A/sqrt(k* - k) per branch
 *  point, trapezoid the remainder, re-add the exact model integral — see
 *  the header Scale status). */
function tensorTerms(params) {
  return {
    P0: 0.5 * (params.mxx + params.myy), P2: 0.5 * (params.mxx - params.myy),
    Q2: params.mxy, Mxz: params.mxz, Myz: params.myz, Mzz: params.mzz,
    dhM: params.dhM || 0.5
  };
}

/** Compliance triple (C at zs, Cup/Cdn at zs -/+ dhM) with the per-call
 *  cache contract of the original inline loop (key omega|zs|dhM|k).
 *  fullSpace mode: params.fullSpace swaps the layered free-surface solve
 *  for the analytic homogeneous full-space κ-domain tensor (per-force
 *  entries, psv-fullspace.js) evaluated at the same three depths — the
 *  absolute source-calibration anchor path (tests/psv-fullspace.test.js);
 *  cheap enough to skip the cache. */
function complianceTriple(stack, omega, kInvM, params) {
  var zs = params.zSourceKm, dhM = params.dhM || 0.5;
  if (params.fullSpace) {
    var lay = withVp(stack)[0];
    var h0 = -zs * 1000; // receiver at the surface (zr = 0), z down
    var Cof = function (h) {
      var t = psvFs.fullSpaceForceTensorKappa(lay, omega, kInvM, h, params);
      // psv's compliance convention = unit-jump insertion = the NEGATIVE of
      // the per-force response (the core.shFullSpaceCompliance convention;
      // pinned empirically by the A3 anchor: the integrands matched at −1).
      return [[cscale(t.grr, -1), cscale(t.grz, -1)], [cscale(t.grz, -1), cscale(t.gzz, -1)]];
    };
    return { C: Cof(h0), Cup: Cof(h0 + dhM), Cdn: Cof(h0 - dhM) };
  }
  var zUp = zs - dhM / 1000, zDn = zs + dhM / 1000;
  var zsKey = omega.toFixed(10) + '|' + zs + '|' + dhM + '|';
  var cache = params.cache;
  var solve = function () {
    return {
      C: psvSurfaceCompliance(stack, omega, kInvM, zs, params),
      Cup: psvSurfaceCompliance(stack, omega, kInvM, zUp, params),
      Cdn: psvSurfaceCompliance(stack, omega, kInvM, zDn, params)
    };
  };
  if (!cache) return solve();
  var key = zsKey + kInvM.toExponential(8);
  var ent = cache.get(key);
  if (ent === undefined) { ent = solve(); cache.set(key, ent); }
  return ent;
}

/** Per-k accumulator channels (no k weight, no master measure). */
function integrandTerms(ent, kInvM, rM, T) {
  var C = ent.C, Cup = ent.Cup, Cdn = ent.Cdn;
  var Cr0 = C[0][0], Cr1 = C[0][1], Cz0 = C[1][0], Cz1 = C[1][1];
  var dCr0 = cscale(csub(Cdn[0][0], Cup[0][0]), 1 / (2 * T.dhM));
  var dCr1 = cscale(csub(Cdn[0][1], Cup[0][1]), 1 / (2 * T.dhM));
  var dCz1 = cscale(csub(Cdn[1][1], Cup[1][1]), 1 / (2 * T.dhM));
  var J0 = core.besselJ(0, kInvM * rM), J1 = core.besselJ(1, kInvM * rM);
  var J2 = core.besselJ(2, kInvM * rM), J3 = core.besselJ(3, kInvM * rM);
  var I0 = [2 * Math.PI * J0, 0];
  var I1 = [0, 2 * Math.PI * J1];
  var Icc = [Math.PI * (J0 - J2), 0];
  var Iss = [Math.PI * (J0 + J2), 0];
  var Ic2 = [-2 * Math.PI * J2, 0];
  var Icc2 = [0, Math.PI * (J1 - J3)];
  var accUr = [0, 0], accUz = [0, 0], accUt = [0, 0];
  var ikJ;
  ikJ = [0, -kInvM * T.P0];
  accUr = cadd(accUr, cmul(cmul(ikJ, Cr0), I1));
  ikJ = [0, -kInvM * T.P2];
  accUr = cadd(accUr, cmul(cmul(ikJ, Cr0), Icc2));
  ikJ = [0, -kInvM * T.P0];
  accUz = cadd(accUz, cmul(cmul(ikJ, Cz0), I0));
  ikJ = [0, -kInvM * T.P2];
  accUz = cadd(accUz, cmul(cmul(ikJ, Cz0), Ic2));
  ikJ = [0, -kInvM * T.Mxz];
  accUr = cadd(accUr, cmul(cmul(ikJ, Cr1), Icc));
  accUz = cadd(accUz, cmul(cmul(ikJ, Cz1), I1));
  ikJ = [0, -kInvM * T.Myz];
  accUt = cadd(accUt, cmul(cmul(ikJ, Cr1), Iss));
  ikJ = [0, -kInvM * T.Q2];
  accUt = cadd(accUt, cmul(cmul(ikJ, Cr0), [0, Math.PI * (J1 + J3)]));
  // T5-T7 vertical-arm dipole terms — depth derivatives of the point-force
  // compliance columns (dCx = ∂C/∂zs), carrying the − sign that puts them
  // on the SAME total-output convention as the traction lines (the complex
  // full-space anchor, tests/psv-fullspace.test.js 2026-09-05, measured the
  // pre-anchor assembly with a RELATIVE −1 between the two families — the
  // interference of any both-families tensor was wrong). Full set:
  //   u_r: −(Mxz·Icc·dCr0 + Mzz·I1·dCr1)
  //   u_z: −(Mzz·I0·dCz1 + Mxz·I1·dCr1)     [the Myz twin is structurally
  //          ZERO: u_z(Myz) carries sinα¹ (G_zy = sinα·G̃_zr, no projection
  //          factor) and ∫e^{iκrcosα}sinα dα = 0 — mirror antisymmetry about
  //          the receiver line; using Iss there instead was a sign-power slip
  //          the anchor caught at 1e13 σ]
  //   u_t: −(Myz·Iss·dCr0)
  // (the pre-anchor assembly had only the Mxz-ur / Mzz-uz lines and a Myz-ut
  // line on the WRONG column — ∂C01 belongs to the u_z family.)
  accUr = cadd(accUr, cscale(cmul(dCr0, cscale(Icc, T.Mxz)), -1));
  accUr = cadd(accUr, cscale(cmul(dCr1, cscale(I1, T.Mzz)), -1));
  accUz = cadd(accUz, cscale(cmul(dCz1, cscale(I0, T.Mzz)), -1));
  accUz = cadd(accUz, cscale(cmul(dCr1, cscale(I1, T.Mxz)), -1));
  accUt = cadd(accUt, cscale(cmul(dCr0, cscale(Iss, T.Myz)), -1));
  return { ur: accUr, uz: accUz, ut: accUt };
}

/** Exact per-unit-dk integrand addend at one wavenumber (1/m), master
 *  measure 1/(4 pi^2) and the k weight folded in. Exposed for the R4
 *  per-wavenumber assembly anchor and the R8/R9 integration anchors. */
function psvIntegrandAtK(stack, omega, kInvM, params) {
  // single point of the qP default (see qPOrDefault note at
  // psvMomentSpectrumAtFrequency): EVERY consumer of the integrand —
  // machinery, brute references, probes — must see the same effective
  // damping, or comparisons compare different physics (measured: the R8
  // gate failed 9% because the machinery ran qP=20 while its brute ran
  // undamped P).
  if (!params.fullSpace && !params.qP && params.qShear) {
    params = Object.assign({}, params, { qP: params.qShear });
  }
  var ent = complianceTriple(stack, omega, kInvM, params);
  if (!ent.C || !ent.Cup || !ent.Cdn) return null;
  var t = integrandTerms(ent, kInvM, params.rKm * 1000, tensorTerms(params));
  var kw = kInvM / (4 * Math.PI * Math.PI);
  return { ur: cscale(t.ur, kw), uz: cscale(t.uz, kw), ut: cscale(t.ut, kw) };
}

/** Fit the branch-tail model amplitude: near k = Re(k*) the integrand
 *  behaves as A/sqrt(k* - k) with k* the COMPLEX damped branch point
 *  k* = nuOf(v, omega, 0, q) (Q damping parks k* just above the real
 *  axis, so the model is smooth everywhere on it — no true singular, only
 *  the cusp the coarse grid cannot resolve). A is measured per channel
 *  from samples 2..16 fine steps below Re(k*) as g(k)·sqrt(k* - k)
 *  (constant when the model dominates), taking the MEDIAN by modulus —
 *  robust against a neighbouring modal-pole tail or one conditioning
 *  failure. Returns { kstar, A: {ur, uz, ut} } with A = null per channel
 *  when fewer than 2 samples succeeded. dkF = the integration fine step
 *  (1/m) sets the offset ladder. */
function psvBranchModelFit(stack, omega, kstar, params, dkF) {
  var base = Math.min(Math.max(dkF, 5e-7), 2e-6); // 1/m
  var offs = [2, 4, 8, 16];
  var got = { ur: [], uz: [], ut: [] };
  for (var j = 0; j < offs.length; j++) {
    var kj = kstar[0] - offs[j] * base;
    if (!(kj > 0)) continue;
    var g = psvIntegrandAtK(stack, omega, kj, params);
    if (!g) continue;
    var sq = csqrtPosIm(csub(kstar, [kj, 0]));
    for (var ch in got) {
      if (g[ch]) got[ch].push(cmul(g[ch], sq));
    }
  }
  function median(list) {
    if (list.length < 2) return null;
    var idx = list.map(function (v, i) { return i; });
    idx.sort(function (a, b) { return cabs(list[a]) - cabs(list[b]); });
    return list[idx[Math.floor((idx.length - 1) / 2)]];
  }
  return { kstar: kstar, A: { ur: median(got.ur), uz: median(got.uz), ut: median(got.ut) } };
}

/** Branch-point list of the stack inside (0, kMax) (1/m, complex k* =
 *  nuOf(v, omega, 0, q), deduplicated) — the psvBranchModelFit inputs. */
function psvBranchPoints(stack, omega, kMax, opts) {
  var out = [], seen = {};
  var wv = withVp(stack);
  for (var b = 0; b < wv.length; b++) {
    var cand = [[wv[b].vpKmS, opts && opts.qP], [wv[b].vsKmS, opts && opts.qShear]];
    for (var c = 0; c < 2; c++) {
      var kst = nuOf(cand[c][0], omega, 0, cand[c][1]);
      if (!(kst[0] > 0) || kst[0] >= kMax) continue;
      var key = kst[0].toPrecision(12) + '|' + kst[1].toPrecision(12);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(kst);
    }
  }
  return out;
}

/** qP default for the LAYERED path (2026-09-06 branch-cusp batch): an
 *  undamped P wave (qP falsy) puts the interior layers' LEAKY P resonances
 *  ON the real axis — measured on the tokyo column at 0.5 Hz, the
 *  0.50-0.55/km band then alternates exact compliance nulls (det(Rc)
 *  through zero, m2inv throw) with 1e8 spikes: the k integral is a
 *  PRINCIPAL VALUE and no quadrature can converge (the v4 "series does
 *  not converge" was this, not a branch cusp). Damping P moves the poles
 *  off-axis by Im k* ~ k/(2 qP) and makes them bounded, windowable
 *  resonances. Production research configs should pass qP explicitly;
 *  defaulting to qShear matches the Q structure most layered codes use.
 *  Both entry points below clone params/opts when the default fires. */

function psvMomentSpectrumAtFrequency(stack, omega, params) {
  if (!params.fullSpace && !params.qP && params.qShear) {
    params = Object.assign({}, params, { qP: params.qShear });
  }
  var dk = params.dkInvKm / 1000, kMax = params.kMaxInvKm / 1000;
  // Bessel-aliasing guard: the integrand oscillates at the J-weight period
  // 2*pi/r, so the sample step may never exceed ~1/10 of that period. The
  // fixed production dkInvKm=0.02/km is tuned for ~30 km paths; at 200 km
  // it samples the J oscillation 1.6 times per period and ALIASES it (the
  // 2026-09-05 tokyo grid-series instability root cause — the SH kernel
  // carries the same exposure at long range). Range-adaptive floor wins.
  var dkAlias = (2 * Math.PI / (params.rKm * 1000)) / 10;
  dk = Math.min(dk, dkAlias);
  function gOf(k) { return psvIntegrandAtK(stack, omega, k, params); }
  // ---- modal poles inside the band (location only) -----------------------
  // fullSpace mode has a pole-free analytic integrand (branch points only).
  var poleList = params.fullSpace ? [] : psvModalPoles(stack, omega, params.kMaxInvKm, params);
  // ---- branch-tail singular subtraction ----------------------------------
  // TWO DIFFERENT branch behaviours, measured 2026-09-06 (this matters):
  //  * FULL-SPACE path (params.fullSpace): the Weyl factors carry explicit
  //    1/nu_c — the integrand truly cusps like 1/sqrt(k* - k) at
  //    k* = nuOf(v, omega, 0, q). Treatment: subtract
  //    A_bp/sqrt(k*_bp - k) from EVERY sample (A fitted just below Re k*,
  //    median over 4 offsets), integrate the smooth/kinked remainder by
  //    the same trapezoid, re-add the model's EXACT analytic integral
  //    over [0, kMax]: int_0^K dk/sqrt(k* - k) = 2(sqrt(k*) - sqrt(k*-K)).
  //    The Im>=0 branch continuation of 1/sqrt(k* - k) matches the
  //    evanescent side with the same coefficient.
  //  * LAYERED path: the free-surface compliance is Rc^-1 Rw and BOTH
  //    residual matrices carry the same 1/nu admittance factors — they
  //    CANCEL (measured on the R8 halfspace: |g.ur| plateaus at ~7e2
  //    toward the P branch, ~3.5e1 toward the S branch; no divergence).
  //    A 1/sqrt model does not exist there and fitting one produces
  //    garbage A — the subtraction stays OFF on this path (the v4 frozen
  //    "branch-tail cusp" attribution for the tokyo series was written
  //    before this measurement and is corrected in the v5 report).
  // Samples nulled by the guards keep their null in BOTH sums; a lattice
  // sample landing ON a branch point (0/0) is nulled with +-dkF/2 of it.
  var bpModels = [];
  if (params.fullSpace) {
    var bpList = psvBranchPoints(stack, omega, kMax, params);
    for (var b0 = 0; b0 < bpList.length; b0++) {
      var bm0 = psvBranchModelFit(stack, omega, bpList[b0], params, dk / 4);
      if (bm0 && (bm0.A.ur || bm0.A.uz || bm0.A.ut)) bpModels.push(bm0);
    }
  }
  function subtractBranchModels(g, kk) {
    for (var b = 0; b < bpModels.length; b++) {
      var sq = csqrtPosIm(csub(bpModels[b].kstar, [kk, 0]));
      if (bpModels[b].A.ur) g.ur = csub(g.ur, cdiv(bpModels[b].A.ur, sq));
      if (bpModels[b].A.uz) g.uz = csub(g.uz, cdiv(bpModels[b].A.uz, sq));
      if (bpModels[b].A.ut) g.ut = csub(g.ut, cdiv(bpModels[b].A.ut, sq));
    }
    return g;
  }
  // ---- quadrature grid: two-zone lattice + gamma-resolved pole windows ---
  // The real-axis integrand has NO singularity: a modal pole is a smooth
  // (damped) peak of half-width gamma = k/(2Q). The earlier residue scheme
  // (subtract R/(k-kp), integrate the smooth remainder, add analytic
  // half-line pieces) relied on [g*D] scale cancellation that the GS-carried
  // chain cannot honour near its own roots (the GS orthogonalisation
  // magnitude collapses exponentially there — measured det(BA) V-dips of
  // 1e13 within +-3e-7 of the Rayleigh root on a halfspace), so residues
  // came out garbage on hard stacks. This version just RESOLVES the peak:
  // per pole, a local window of +-6*gamma at gamma/4 steps (floored at the
  // fine-zone step) is added to the deterministic two-zone lattice
  // (dk/4 fine zone over the surface-wave band, plain dk beyond) and the
  // whole thing is integrated by the plain non-uniform trapezoid.
  // WINDOWS FOR RAW CANDIDATES TOO (2026-09-06 branch-cusp batch
  // re-diagnosis): on deep production stacks the renormalised dispersion
  // determinant sits at e^-288 (tokyo 13-layer column, 0.5 Hz) and its
  // Im-kappa dependence is buried under the chain's cancellation noise —
  // the 2D Newton fails there for EVERY detected mode (v4 root tables:
  // 4/4 raw at f0p5), leaving their narrow resonances (gamma ~ k/(2Q)
  // ~ 0.008-0.015/km) to be sampled by the coarse production lattice —
  // the measured tokyo series chaos (286 -> 86 over the dk series while
  // the plain fine-grid sum sits at ~56-62). The dip POSITION is still
  // bisected from real-axis log|det| differences (informative); only the
  // width is not. So raw candidates get the SAME tiered window with the
  // material width gamma = k/(2Q) — the physically correct resonance width
  // under Q-damping — and the needle passes below guard their crest the
  // same way they guard refined poles.
  var n = Math.max(1, Math.floor((kMax + 1e-12) / dk));
  var dkF = dk / 4;
  var vsMax = 0;
  var wv = withVp(stack);
  for (var lv = 0; lv < wv.length; lv++) {
    if (wv[lv].bottomKm > 0 && wv[lv].vsKmS > vsMax) vsMax = wv[lv].vsKmS;
  }
  if (!(vsMax > 0)) vsMax = 1;
  var kBreak = Math.min(kMax, omega / (vsMax * 1000) + 5 * dkF);
  var kset = {};
  var klist = [];
  var needleK = {};
  function addK(kk) {
    if (!(kk > 0) || kk > kMax + 1e-15) return;
    var key = kk.toPrecision(14);
    if (kset[key]) return;
    kset[key] = true;
    klist.push(kk);
  }
  for (var i = 1; i <= Math.floor((kBreak + 1e-12) / dkF); i++) addK(i * dkF);
  for (var i2 = Math.max(1, Math.ceil(kBreak / dk - 1e-9)); i2 <= n; i2++) addK(i2 * dk);
  // ---- branch-point resolution windows -----------------------------------
  // The (damped) halvespace branch points are bounded kinks/peaks of the
  // integrand with rounding width ~Im(k*) = k/(2q); the plain lattice
  // undersamples them (measured R8: a dk-independent 10% machinery-vs-brute
  // gap concentrated in the halvespace P-branch band 0.45-0.55/km). Graded
  // rings of samples around each Re(k*) inside the band, inside-out:
  // dkF/4 steps to 4*dkF, then dkF steps to 24*dkF.
  var hsL = wvHalfspace(stack);
  if (hsL) {
    var bpR = [[omega / hsL.vpKmS, (params && params.qP) || 0], [omega / hsL.vsKmS, (params && params.qShear) || 0]];
    for (var ib = 0; ib < 2; ib++) {
      var bpk = bpR[ib][0]; // 1/km
      if (!(bpk > 0) || bpk / 1000 >= kMax) continue;
      var bq = bpR[ib][1];
      // ring step (1/km): the branch rounding half-width k/(2q), floored at
      // the fine-zone step; undamped branches (q = 0) take 4 fine steps.
      var bw = bq > 0 ? Math.max(dkF * 1000, bpk / (2 * bq)) : 4 * dkF * 1000;
      // inner ladder bw/32 x64 (the branch kink has a ~bw/16-wide cliff —
      // measured on the R8 halfspace P branch: |g| drops 30% within
      // 0.001/km) + outer ladder bw x24 for the tails.
      for (var mB1 = 1; mB1 <= 64; mB1++) { addK((bpk - mB1 * bw / 32) / 1000); addK((bpk + mB1 * bw / 32) / 1000); }
      for (var mB2 = 3; mB2 <= 24; mB2++) { addK((bpk - mB2 * bw) / 1000); addK((bpk + mB2 * bw) / 1000); }
    }
  }
  for (var p3 = 0; p3 < poleList.length; p3++) {
    // Windows for refined AND raw candidates alike (see the block comment
    // above): refined poles carry the Newton/HWHM half-width, raw ones the
    // material width gammaMat = k/(2Q) — the resonance is damping-dominated
    // when the chain noise buries the Im-kappa info.
    var kp3 = poleList[p3].k / 1000;
    // Window scale: the refined pole carries the TRUE modal half-width
    // (2D complex Newton |Im kappa*|, HWHM cross-check — see psvModalPoles):
    // the window resolves the actual resonance instead of the material
    // damping proxy the pre-2026-09-06 code clamped to (the v3 gamma_d gap).
    var gm = Math.max(poleList[p3].gammaKm / 1000, 1e-12);
    // TIERED window: the INTEGRAND peak can be much narrower than the det
    // dip width gamma (the compliance numerator channels carry cancelling
    // structure near the pole — measured on the R8 halfspace: integrand
    // HWHM ~ gamma/8), so a single gamma/4 step undersamples the crest and
    // the trapezoid overshoots it (measured +76%). Tiers: gamma/32 within
    // +-gamma/2, gamma/8 within +-2*gamma, gamma/4 within +-8*gamma,
    // geometric tail to ~100*gamma for the Lorentzian wings.
    var stepA = gm / 32, stepB = gm / 8, stepC = gm / 4;
    var nA = 16, nB = 12, nC = 24;
    for (var m2 = 1; m2 <= nA; m2++) { addK(kp3 - m2 * stepA); addK(kp3 + m2 * stepA); }
    // stepB starts where stepA ended (ceil(nA*stepA/stepB) = gamma/2) — the
    // historical `mB = nA` start left (gamma/2, 2*gamma) unsampled; the
    // coarse lattice hid that for wide poles, but basin-trapped modes
    // (measured HWHM ~1.5e-3/km) lost exactly their peak shoulders.
    for (var mB = Math.ceil(nA * stepA / stepB); mB <= nA + nB; mB++) { addK(kp3 - mB * stepB); addK(kp3 + mB * stepB); }
    for (var mC = Math.ceil((nA + nB) * stepB / stepC); mC <= nA + nB + nC; mC++) { addK(kp3 - mC * stepC); addK(kp3 + mC * stepC); }
    addK(kp3);
    needleK[kp3.toPrecision(14)] = true; // exact-root sample: the compliance
    // det sits on its cancellation needle there — see the razor pass
    // Lorentzian wings: geometric steps out past 100*gamma AND far enough to
    // bridge to the lattice (an edge sample half-spanning a wide gap to a
    // distant lattice point otherwise multiplies its value by that gap —
    // measured +76% on the R8 halfspace when gamma collapsed to noise).
    var tail = 8 * gm, tailCap = Math.min(Math.max(100 * gm, 4 * dk), 1e-4);
    for (var t2 = 0; t2 < 14; t2++) {
      tail *= 1.6;
      if (tail > tailCap) break;
      addK(kp3 - tail); addK(kp3 + tail);
    }
  }
  klist.sort(function (a, b) { return a - b; });
  function max3(g) {
    if (!g) return 0;
    return Math.max(cabs(g.ur), cabs(g.uz), cabs(g.ut));
  }
  var pts = [];
  for (var i3 = 0; i3 < klist.length; i3++) {
    var g3 = gOf(klist[i3]);
    if (g3 && bpModels.length) {
      // branch-needle cells: a lattice sample can land ON (or within an
      // ulp of) a branch point — g blows up as 1/sqrt(dist) and the
      // g-model cancellation goes 0/0. Null the +-dkF/2 neighbourhood of
      // every branch point: the cell is carried by the analytic model
      // integral instead, and only one cell-width of the O(1) smooth
      // residual is lost (measured negligible vs the totals).
      var dead = false;
      for (var b6 = 0; b6 < bpModels.length; b6++) {
        if (Math.abs(klist[i3] - bpModels[b6].kstar[0]) < 0.5 * dkF) { dead = true; break; }
      }
      if (dead) g3 = null;
      else g3 = subtractBranchModels(g3, klist[i3]);
    }
    pts.push({ k: klist[i3], g: g3 });
  }
  // raw candidates now carry full windows (see the block comment above),
  // but their exact-root neighbourhood is still a compliance needle (the
  // chain's cancellation floor / smooth value can be 1e10+ on deep stacks;
  // measured needle width ~1e-4/km on the R8 halfspace). Null a +-1e-4/km
  // zone around every such candidate — deliberately INSIDE the gamma/32
  // window ring (stepA >= 4.7e-4/km for the production Q band) so the
  // crest keeps its samples and only the broken centre bridges; the
  // needleK 8x test at the centre stays armed via the marker set during
  // window construction.
  for (var p4 = 0; p4 < poleList.length; p4++) {
    if (poleList[p4].refined) continue;
    var kc4 = poleList[p4].k / 1000;
    for (var i6 = 0; i6 < pts.length; i6++) {
      if (pts[i6].g && Math.abs(pts[i6].k - kc4) < 1e-7) pts[i6].g = null;
    }
  }
  // conditioning-razor gate: drop samples >50x the LARGER NEIGHBOR's scale
  // (near-singular det(Rc) of the GS-carried basis: isolated spikes of width
  // << dk). The original global-median criterion silently nulled ENTIRE live
  // bands whenever the integrand decays hard past kBreak — the median then
  // sits in the evanescent tail and the propagating band reads as "400x the
  // median" (exposed by the fullSpace anchor: 180/388 samples nulled, 198x
  // integral loss); 400x LOCAL neighbour was still too loose for the pole
  // windows: the GS normalisation factor nr collapses through a float-noise
  // V-zero within ~gamma/90 of each modal root, jumping the COMPLIANCE
  // itself ~1.4e3x on 1-3 samples inside the resolved window (measured on
  // the halfspace at 1.2 Hz). 50x nulls those wall samples (legit resolved
  // peak/kink neighbours move O(1) per step) and the trapezoid bridges the
  // ~gamma/90-wide hole.
  var mags = pts.map(function (p) { return max3(p.g); });
  for (var i4 = 0; i4 < pts.length; i4++) {
    if (!pts[i4].g) continue;
    var neigh = 0;
    if (i4 > 0 && pts[i4 - 1].g) neigh = Math.max(neigh, mags[i4 - 1]);
    if (i4 < pts.length - 1 && pts[i4 + 1].g) neigh = Math.max(neigh, mags[i4 + 1]);
    if (neigh > 0 && mags[i4] > 50 * neigh) { pts[i4].g = null; continue; }
    // window-centre needle test: at the refined root the compliance det is
    // on its cancellation floor, so the exact-root sample can carry a
    // junk amplification far above the smooth peak crest while staying
    // under the 50x razor (measured 14x). Null it when it exceeds 8x the
    // mean of its two neighbours (both clean tier samples); the trapezoid
    // bridges the crest from the gamma/32 ring.
    if (needleK[pts[i4].k.toPrecision(14)] && i4 > 0 && i4 < pts.length - 1
        && pts[i4 - 1].g && pts[i4 + 1].g) {
      var interp = 0.5 * (mags[i4 - 1] + mags[i4 + 1]);
      if (interp > 0 && mags[i4] > 8 * interp) pts[i4].g = null;
    }
  }
  var ur = [0, 0], uz = [0, 0], ut = [0, 0];
  for (var i5 = 0; i5 < pts.length; i5++) {
    var p = pts[i5];
    if (!p.g) continue;
    var hL = i5 === 0 ? (pts[1].k - pts[0].k) : (p.k - pts[i5 - 1].k);
    var hR = i5 === pts.length - 1 ? (pts[i5].k - pts[i5 - 1].k) : (pts[i5 + 1].k - p.k);
    var w = (hL + hR) / 2;
    ur = cadd(ur, cscale(p.g.ur, w));
    uz = cadd(uz, cscale(p.g.uz, w));
    ut = cadd(ut, cscale(p.g.ut, w));
  }
  // analytic re-add of the subtracted branch models over [0, kMax]
  for (var b5 = 0; b5 < bpModels.length; b5++) {
    var bm5 = bpModels[b5];
    var Is = cscale(csub(csqrtPosIm(bm5.kstar), csqrtPosIm(csub(bm5.kstar, [kMax, 0]))), 2);
    if (bm5.A.ur) ur = cadd(ur, cmul(bm5.A.ur, Is));
    if (bm5.A.uz) uz = cadd(uz, cmul(bm5.A.uz, Is));
    if (bm5.A.ut) ut = cadd(ut, cmul(bm5.A.ut, Is));
  }
  return { ur: ur, uz: uz, ut: ut };
}

module.exports = {
  nuOf: nuOf, psvEigenvectors: psvEigenvectors, psvPropagator: psvPropagator,
  psvHalfspaceAdmittance: psvHalfspaceAdmittance, psvSurfaceCompliance: psvSurfaceCompliance,
  surfacePropagation: surfacePropagation,
  psvDispersionFunction: psvDispersionFunction, psvDispersionDetRaw: psvDispersionDetRaw,
  prepare: prepare, withVp: withVp,
  rotateFullTensor: rotateFullTensor, psvMomentSpectrumAtFrequency: psvMomentSpectrumAtFrequency,
  psvIntegrandAtK: psvIntegrandAtK, psvModalPoles: psvModalPoles,
  psvBranchPoints: psvBranchPoints, psvBranchModelFit: psvBranchModelFit
};
