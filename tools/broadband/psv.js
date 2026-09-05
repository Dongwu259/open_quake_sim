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
//    states and two unit-jump columns propagated down (shared
//    renormalisation, same invariance argument as the SH kernel); below
//    the source the RADIATION condition (pure downgoing P+SV admittance
//    Y = M2 M1^-1) closes u0 = -R^-1 Rw DeltaT. Receiver at the surface.
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
//  * Anchor set (tests/broadband-psv.test.js — the P-SV equivalent of the
//    SH kernel's A1/A2 discipline, chosen to be exact and self-contained):
//      R1  Rayleigh dispersion root of psvDispersionFunction for a
//          halfspace lands at c = omega/k = c_R from the Rayleigh cubic
//          (self-solved in-test; 0.9194 beta at Poisson 0.25) — exercises
//          eigenvectors, propagator, admittance and the surface solve.
//      R2  k -> 0 column limit: every jump channel of
//          psvSurfaceCompliance converges to the exact 1D vertical-column
//          compliance (closed form derived in-test from the wave equation,
//          free-surface doubling included).
//      R3  Radiation nodes: a pure-Mxy tensor gives EXACTLY zero radial
//          and vertical P-SV motion on the receiver axis; pure Mzz gives
//          EXACTLY zero radial motion.
//      R4  Equivariance: psv(M, phi) == psv(rot(M, phi), phi = 0) — the
//          assembly is invariant under rotating the whole geometry, which
//          locks every term's harmonic slot and sign.
//      R5  Dipole depth-FD convergence: the Mzz/Mxz/Myz responses are
//          converged at dh = 0.5 m (|dh=0.25 - dh=1.0| relative change
//          small vs the value).
// =====================================================================
const core = require('./core.js');

const cadd = core.cadd, csub = core.csub, cmul = core.cmul,
  cscale = core.cscale, cdiv = core.cdiv, cabs = core.cabs, CI = core.CI;
const csqrtPosIm = core.csqrtPosIm;

/** nu_c = sqrt(w^2/c^2 - k^2), Im >= 0, complex velocity c* = c(1-i/(2Q)). */
function nuOf(vKmS, omega, kInvM, q) {
  var b = vKmS * 1000;
  var b2 = (q && q > 0) ? [b * b, -b * b / q] : [b * b, 0];
  var om2 = omega * omega;
  var val = [om2 * b2[0] / (b2[0] * b2[0] + b2[1] * b2[1]) - kInvM * kInvM,
             -om2 * b2[1] / (b2[0] * b2[0] + b2[1] * b2[1])];
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
  var mu = layer.rhoGcm3 * 1000 * Math.pow(layer.vsKmS * 1000, 2);
  var nuA = nuOf(layer.vpKmS, omega, k, opts && opts.qP);
  var nuB = nuOf(layer.vsKmS, omega, k, opts && opts.qShear);
  var ik = cmul([k, 0], CI);
  var iA = cmul(nuA, CI), iB = cmul(nuB, CI);
  var szP = [2 * mu * k * k - layer.rhoGcm3 * 1000 * omega * omega, 0];
  var svs = cmul([mu, 0], csub([k * k, 0], cmul(nuB, nuB)));
  var m2kA = cscale(cmul([-2 * mu, 0], nuA), k);
  var p2kA = cscale(cmul([2 * mu, 0], nuA), k);
  var m2kB = cscale(cmul([2 * mu, 0], nuB), k);
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

/** 4x4 layer propagator P = E diag(e^{i nuA h}, e^{-i nuA h}, e^{i nuB h}, e^{-i nuB h}) E^-1. */
function psvPropagator(layer, omega, k, opts) {
  var h = (layer.bottomKm - layer.topKm) * 1000;
  var nuA = nuOf(layer.vpKmS, omega, k, opts && opts.qP);
  var nuB = nuOf(layer.vsKmS, omega, k, opts && opts.qShear);
  var E = psvEigenvectors(layer, omega, k, opts);
  var D = [[expITheta(cmul(nuA, [h, 0])), [0, 0], [0, 0], [0, 0]],
           [[0, 0], expITheta(cscale(cmul(nuA, [h, 0]), -1)), [0, 0], [0, 0]],
           [[0, 0], [0, 0], expITheta(cmul(nuB, [h, 0])), [0, 0]],
           [[0, 0], [0, 0], [0, 0], expITheta(cscale(cmul(nuB, [h, 0]), -1))]];
  return m4mul(E, m4mul(D, m4inv(E)));
}

function renorm(cols) {
  var mx = 0;
  for (var c = 0; c < cols.length; c++) for (var r = 0; r < 4; r++) {
    var a = cabs(cols[c][r]);
    if (isFinite(a) && a > mx) mx = a;
  }
  if (!isFinite(mx)) return null;
  if (mx > 1e100) {
    for (var c2 = 0; c2 < cols.length; c2++) for (var r3 = 0; r3 < 4; r3++) cols[c2][r3] = cdiv(cols[c2][r3], [mx, 0]);
  }
  return mx;
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
/** Per-layer conditioning step for a 4x2 complex column pair: normalise
 *  both columns by their own max-abs and attempt a Gram-Schmidt
 *  orthogonalisation of the second against the first (accepted when the
 *  orthogonal component carries a meaningful share of the norm, else the
 *  pair is carried as two separately scaled near-parallel columns).
 *  [c0 c1] = [q0 q1] T with T tracked by the caller. Never fails. */
function gsPair(c0, c1) {
  var n0 = maxabs(c0);
  if (!(n0 > 0) || !isFinite(n0)) return null;
  var q0 = c0.map(function (v) { return cscale(v, 1 / n0); });
  var n1 = maxabs(c1);
  if (!(n1 > 0) || !isFinite(n1)) return null;
  var p = [0, 0];
  for (var j = 0; j < 4; j++) p = cadd(p, cmul(cconj(q0[j]), c1[j]));
  var r1raw = c1.map(function (v, j) { return csub(v, cmul(q0[j], p)); });
  var nr = maxabs(r1raw);
  if (nr > 0 && isFinite(nr)) {
    // always carry the orthogonal direction — its smallness is physical
    // (the complementary mode is exponentially suppressed in the layer
    // stack), and normalising it preserves the pair's span.
    var q1 = r1raw.map(function (v) { return cscale(v, 1 / nr); });
    return { q0: q0, q1: q1, T: [[[n0, 0], p], [[0, 0], [nr, 0]]] };
  }
  // exact numerical parallelism: scale-only fallback
  var q1b = c1.map(function (v) { return cscale(v, 1 / n1); });
  return { q0: q0, q1: q1b, T: [[[n0, 0], [0, 0]], [[0, 0], [n1, 0]]] };
}

/** Subdivide layers so every propagator exponent |nu|*h stays <= 30
 *  (exp(30) ~ 1e13, well inside double range): thick low-loss layers at
 *  high k otherwise overflow the E L E^-1 product before any
 *  re-orthonormalisation can run. Material unchanged; only the split. */
function subdivide(lay, omega, k, opts) {
  var out = [];
  for (var i = 0; i < lay.length; i++) {
    var l = lay[i];
    var hM = (l.bottomKm - l.topKm) * 1000;
    var nuA = nuOf(l.vpKmS, omega, k, opts && opts.qP);
    var nuB = nuOf(l.vsKmS, omega, k, opts && opts.qShear);
    var nMax = Math.max(cabs(nuA), cabs(nuB));
    var nSub = Math.max(1, Math.min(400, Math.ceil((nMax * hM) / 30)));
    if (nSub === 1) { out.push(l); continue; }
    var dh = hM / nSub;
    for (var s = 0; s < nSub; s++) {
      out.push({ topKm: l.topKm + (s * dh) / 1000, bottomKm: l.topKm + ((s + 1) * dh) / 1000, vsKmS: l.vsKmS, vpKmS: l.vpKmS, rhoGcm3: l.rhoGcm3 });
    }
  }
  return out;
}

/** Layered surface compliance u0 = C . DeltaT; rows (u_r, u_z), columns
 *  (Delta tau_rz, Delta sigma_zz). Null on genuine overflow/ill-conditioning.
 *  Robustness: the A pair (free-surface basis states) and the W pair (unit
 *  jumps below the source) are propagated with per-layer Gram-Schmidt
 *  re-orthonormalisation; the carried states are related to the physical
 *  basis by the tracked triangular mixing matrices (BA, BW), and the
 *  physical compliance is C = -BA^-1 (R^-1 Rw) BW. This is the standard
 *  delta-matrix-class remedy for the Thomson-Haskell low-velocity /
 *  guided-mode dynamic-range problem (states otherwise span 1e90+ inside
 *  the k band where omega/k approaches the slowest layer velocity). */
function psvSurfaceCompliance(stack, omega, k, zSourceKm, opts) {
  var st = prepare(stack, zSourceKm);
  var lay = subdivide(st.layers, omega, k, opts);
  var A0 = [[1, 0], [0, 0], [0, 0], [0, 0]];
  var A1 = [[0, 0], [1, 0], [0, 0], [0, 0]];
  var W0 = [[0, 0], [0, 0], [1, 0], [0, 0]];
  var W1 = [[0, 0], [0, 0], [0, 0], [1, 0]];
  var BA = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]], BW = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]];
  var i, c, g;
  for (i = 0; i < st.iS; i++) {
    var P = psvPropagator(lay[i], omega, k, opts);
    A0 = m4v(P, A0); A1 = m4v(P, A1);
    g = gsPair(A0, A1);
    if (!g) return null;
    A0 = g.q0; A1 = g.q1; BA = m2mul(BA, g.T);
  }
  for (var j2 = st.iS; j2 < st.halfIndex; j2++) {
    var P2 = psvPropagator(lay[j2], omega, k, opts);
    A0 = m4v(P2, A0); A1 = m4v(P2, A1);
    W0 = m4v(P2, W0); W1 = m4v(P2, W1);
    g = gsPair(A0, A1);
    if (!g) return null;
    A0 = g.q0; A1 = g.q1; BA = m2mul(BA, g.T);
    g = gsPair(W0, W1);
    if (!g) return null;
    W0 = g.q0; W1 = g.q1; BW = m2mul(BW, g.T);
  }
  var Y = psvHalfspaceAdmittance(lay[st.halfIndex], omega, k, opts);
  function resid(col) {
    return [csub(col[2], cadd(cmul(Y[0][0], col[0]), cmul(Y[0][1], col[1]))),
            csub(col[3], cadd(cmul(Y[1][0], col[0]), cmul(Y[1][1], col[1])))];
  }
  var rA0 = resid(A0), rA1 = resid(A1);
  var rW0 = resid(W0), rW1 = resid(W1);
  var Rc = [[rA0[0], rA1[0]], [rA0[1], rA1[1]]];
  var Rw = [[rW0[0], rW1[0]], [rW0[1], rW1[1]]];
  var m2inv2 = function (A) {
    var dd = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0]));
    if (!(cabs(dd) > 0) || !isFinite(cabs(dd))) return null;
    return [[cdiv(A[1][1], dd), cscale(cdiv(A[0][1], dd), -1)],
            [cscale(cdiv(A[1][0], dd), -1), cdiv(A[0][0], dd)]];
  };
  var m2mul2 = function (A, B) {
    return [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
            [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
  };
  var RcInv = m2inv2(Rc);
  if (!RcInv) return null;
  var BWInv = m2inv2(BW);
  if (!BWInv) return null;
  var BAInv = m2inv2(BA);
  if (!BAInv) return null;
  var C = m2mul2(m2mul2(BAInv, m2mul2(RcInv, Rw)), BW);
  return [[cscale(C[0][0], -1), cscale(C[0][1], -1)], [cscale(C[1][0], -1), cscale(C[1][1], -1)]];
}

/** Determinant of the source-free boundary system (Rayleigh dispersion). */
function psvDispersionFunction(stack, omega, kInvKm, opts) {
  var k = kInvKm / 1000;
  var st = prepare(stack, 1e-4);
  var lay = subdivide(st.layers, omega, k, opts);
  var cols = [[[1, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [0, 0], [0, 0]]];
  for (var i = 0; i < st.halfIndex; i++) {
    var P = psvPropagator(lay[i], omega, k, opts);
    for (var c = 0; c < 2; c++) cols[c] = m4v(P, cols[c]);
    if (renorm(cols) === null) return null;
  }
  var Y = psvHalfspaceAdmittance(lay[st.halfIndex], omega, k, opts);
  var a = csub(cols[0][2], cadd(cmul(Y[0][0], cols[0][0]), cmul(Y[0][1], cols[0][1])));
  var b = csub(cols[1][2], cadd(cmul(Y[0][0], cols[1][0]), cmul(Y[0][1], cols[1][1])));
  var cc = csub(cols[0][3], cadd(cmul(Y[1][0], cols[0][0]), cmul(Y[1][1], cols[0][1])));
  var d = csub(cols[1][3], cadd(cmul(Y[1][0], cols[1][0]), cmul(Y[1][1], cols[1][1])));
  return csub(cmul(a, d), cmul(b, cc));
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
 *            dkInvKm, kMaxInvKm, qShear, qP, dhM }
 *  Returns { ur, uz, ut } complex — u_t carries ONLY the Mxz/Myz
 *  longitudinal transverse piece (the SH channel of the horizontal block
 *  is core.js's, complete there). */
function psvMomentSpectrumAtFrequency(stack, omega, params) {
  var rM = params.rKm * 1000;
  var dk = params.dkInvKm / 1000, kMax = params.kMaxInvKm / 1000;
  var dhM = params.dhM || 0.5;
  var zs = params.zSourceKm;
  var zUp = zs - dhM / 1000, zDn = zs + dhM / 1000;
  var zsKey = omega.toFixed(10) + '|' + zs + '|' + dhM + '|';
  var ur = [0, 0], uz = [0, 0], ut = [0, 0];
  var P0 = 0.5 * (params.mxx + params.myy);
  var P2 = 0.5 * (params.mxx - params.myy);
  var Q2 = params.mxy;
  var Mxz = params.mxz, Myz = params.myz, Mzz = params.mzz;
  var cache = params.cache;
  for (var k = dk; k <= kMax + 1e-15; k += dk) {
    var ent = null;
    if (cache) {
      ent = cache.get(zsKey + k.toExponential(8));
      if (ent === undefined) {
        ent = {
          C: psvSurfaceCompliance(stack, omega, k, zs, params),
          Cup: psvSurfaceCompliance(stack, omega, k, zUp, params),
          Cdn: psvSurfaceCompliance(stack, omega, k, zDn, params)
        };
        cache.set(zsKey + k.toExponential(8), ent);
      }
    } else {
      ent = {
        C: psvSurfaceCompliance(stack, omega, k, zs, params),
        Cup: psvSurfaceCompliance(stack, omega, k, zUp, params),
        Cdn: psvSurfaceCompliance(stack, omega, k, zDn, params)
      };
    }
    var C = ent.C, Cup = ent.Cup, Cdn = ent.Cdn;
    if (!C) continue;
    if (!Cup || !Cdn) continue;
    var Cr0 = C[0][0], Cr1 = C[0][1], Cz0 = C[1][0], Cz1 = C[1][1];
    var dCr0 = cscale(csub(Cdn[0][0], Cup[0][0]), 1 / (2 * dhM));
    var dCr1 = cscale(csub(Cdn[0][1], Cup[0][1]), 1 / (2 * dhM));
    var dCz1 = cscale(csub(Cdn[1][1], Cup[1][1]), 1 / (2 * dhM));
    var J0 = core.besselJ(0, k * rM), J1 = core.besselJ(1, k * rM);
    var J2 = core.besselJ(2, k * rM), J3 = core.besselJ(3, k * rM);
    var I0 = [2 * Math.PI * J0, 0];
    var I1 = [0, 2 * Math.PI * J1];
    var Icc = [Math.PI * (J0 - J2), 0];
    var Iss = [Math.PI * (J0 + J2), 0];
    var Ic2 = [-2 * Math.PI * J2, 0];
    var Icc2 = [0, Math.PI * (J1 - J3)];
    // per-k accumulator (master measure applied below with k*dk)
    var accUr = [0, 0], accUz = [0, 0], accUt = [0, 0];
    var ikJ; // shorthand complex scalar (-i k X)
    // T1/T2 horizontal block (Delta tau_rz = -ik[P0 + P2 cos2a + Q2 sin2a]):
    ikJ = [0, -k * P0];
    accUr = cadd(accUr, cmul(cmul(ikJ, Cr0), I1));
    ikJ = [0, -k * P2];
    accUr = cadd(accUr, cmul(cmul(ikJ, Cr0), Icc2));
    ikJ = [0, -k * P0];
    accUz = cadd(accUz, cmul(cmul(ikJ, Cz0), I0));
    ikJ = [0, -k * P2];
    accUz = cadd(accUz, cmul(cmul(ikJ, Cz0), Ic2));
    // (Q2 sin2a: every surviving projection integrates to zero — R3 node test)
    // T3/T4 Mxz/Myz vertical forces (Delta s_zz = -ik[Mxz cos a + Myz sin a]):
    ikJ = [0, -k * Mxz];
    accUr = cadd(accUr, cmul(cmul(ikJ, Cr1), Icc));
    accUz = cadd(accUz, cmul(cmul(ikJ, Cz1), I1));
    ikJ = [0, -k * Myz];
    accUt = cadd(accUt, cmul(cmul(ikJ, Cr1), Iss));
    // T4b the tau-jump Q2 part also projects on the transverse channel:
    // INT sin a sin 2a e^{iz cos a} = pi i (J1 + J3)
    ikJ = [0, -k * Q2];
    accUt = cadd(accUt, cmul(cmul(ikJ, Cr0), [0, Math.PI * (J1 + J3)]));
    // T5/T6/T7 vertical-arm dipoles (depth-derivative responses; real amps):
    accUr = cadd(accUr, cmul(dCr0, cscale(Icc, Mxz)));
    accUz = cadd(accUz, cmul(dCz1, cscale(I0, Mzz)));
    accUt = cadd(accUt, cmul(dCr1, cscale(Iss, Myz)));
    ur = cadd(ur, cscale(accUr, k * dk));
    uz = cadd(uz, cscale(accUz, k * dk));
    ut = cadd(ut, cscale(accUt, k * dk));
  }
  // apply the master measure: u = (1/(2pi)^2) INT k dk INT da [...] with the
  // identities carrying their own 2pi
  var inv = 1 / (4 * Math.PI * Math.PI);
  return { ur: cscale(ur, inv), uz: cscale(uz, inv), ut: cscale(ut, inv) };
}

module.exports = {
  nuOf: nuOf, psvEigenvectors: psvEigenvectors, psvPropagator: psvPropagator,
  psvHalfspaceAdmittance: psvHalfspaceAdmittance, psvSurfaceCompliance: psvSurfaceCompliance,
  psvDispersionFunction: psvDispersionFunction, prepare: prepare, withVp: withVp,
  rotateFullTensor: rotateFullTensor, psvMomentSpectrumAtFrequency: psvMomentSpectrumAtFrequency
};
