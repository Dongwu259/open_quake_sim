'use strict';
// =====================================================================
//  v6.1 B1 — SH (anti-plane) Green's functions for layered media via the
//  discrete-wavenumber (DW) method. Offline research kernel; NOT loaded in
//  the browser (capability boundary: no P-SV, no 3D, no scattering).
//
//  Formulation (self-derived; every sign/factor LOCKED against analytic
//  anchors in tools/broadband/run-experiment.js + tests/broadband-green.test.js):
//
//  * Anti-plane displacement for a plane wave with horizontal propagation
//    azimuth a points along s_hat(a) = (-sin a, cos a), no vertical
//    component. With e^{-i omega t} the vertical spectral wavenumber is
//    qT = sqrt(omega^2/beta^2 - k^2) on the branch Im(qT) >= 0: propagating
//    waves go as e^{+i qT z} (down) / e^{-i qT z} (up); evanescent fields
//    (qT = i|qT|) decay in both directions. The layer system is
//      d/dz [u; tau] = [[0, 1/mu], [mu(k^2 - omega^2/beta^2), 0]] [u; tau]
//    with Thomson-Haskell propagator (algebraically identical in the
//    cosh/sinh vs cos/sin forms):
//      P = [[C, S/(mu q)], [mu q S, C]], C = cosh(q h), S = sinh(q h),
//      q = sqrt(k^2 - omega^2/beta^2) (any branch; P only uses even/odd
//      combinations that are branch-independent).
//
//  * Radiation into the halfspace: tau_H = i qT_H mu_H u_H (downgoing).
//
//  * A horizontal double couple (Mxx, Myy, Mxy=Myx in N*m; receiver azimuth
//    phi from +x) couples to the anti-plane field ONLY through the m=2
//    angular harmonic,
//      C2(phi) = 0.5 * [(Myy - Mxx) sin 2phi + 2 Mxy cos 2phi],
//    entering the layer system as a traction jump dTau = -i k C2 at the
//    source level (integrating the horizontal force-dipole source density
//    across z = zs). The DW integral over horizontal wavenumbers is
//      u_theta(r, phi, omega) = prefac * Int_0^inf k J2(k r) dTau(k) Y(k,omega) dk
//    with Y the layered response per unit traction jump and prefac fixed by
//    the full-space anchors (A1/A2 below).
//
//  * Full-space reference (anchor): the anti-plane response of a uniform
//    medium to the force-dipole source is, per (k, alpha),
//      G(k) = -i exp(i qT |zr - zs|) / (2 mu qT)
//    and the assembled field must equal the exact closed form
//      u_theta = -sin(phi) u_x + cos(phi) u_y,
//      u_x = -(Mxx d/dx + Mxy d/dy) G3,  u_y = -(Myx d/dx + Myy d/dy) G3,
//      G3 = exp(i omega R / beta) / (4 pi mu R).
// =====================================================================

// --- minimal complex helpers (pairs [re, im]) -----------------------------
function cadd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function csub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function cmul(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
function cscale(a, s) { return [a[0] * s, a[1] * s]; }
function cdiv(a, b) {
  var d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
}
function cabs(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1]); }
function ccosh(z) { return [Math.cosh(z[0]) * Math.cos(z[1]), Math.sinh(z[0]) * Math.sin(z[1])]; }
function csinh(z) { return [Math.sinh(z[0]) * Math.cos(z[1]), Math.cosh(z[0]) * Math.sin(z[1])]; }
function csqrtIm(a, imSign) {
  // sqrt of the complex value (val, 0|tiny) with a requested imaginary sign
  // convention; used for the Im>=0 branches.
  var z = [a, imSign || 0];
  var r = Math.sqrt(cabs(z)), th = Math.atan2(z[1], z[0]);
  return [r * Math.cos(th / 2), r * Math.sin(th / 2)];
}
var CI = [0, 1];

/** qT = sqrt(omega^2/beta^2 - k^2) with Im(qT) >= 0 (radiation branch).
 *  SI throughout: k in 1/m, beta in m/s. For a negative real argument the
 *  sqrt is +i*|.| on this branch. */
function qT_radiation(vsKmS, omega, kInvM, qShear) {
  // complex velocity beta* = beta (1 - i/(2Q)) for the e^{-i omega t}
  // convention: waves e^{i qT z} then DECAY with distance (standard DW
  // practice for softening the k = omega/beta branch point)
  var b = vsKmS * 1000;
  var b2;
  if (qShear && qShear > 0) {
    b2 = [b * b, -b * b / qShear];
  } else {
    b2 = [b * b, 0];
  }
  var om2 = omega * omega;
  var val = [om2 * b2[0] / (b2[0] * b2[0] + b2[1] * b2[1]) - kInvM * kInvM,
             -om2 * b2[1] / (b2[0] * b2[0] + b2[1] * b2[1])];
  return csqrtPosIm(val);
}

function q_layer(vsKmS, omega, kInvM, qShear) {
  var q = qT_radiation(vsKmS, omega, kInvM, qShear);
  // q_layer = sqrt(k^2 - w^2/b^2) = -i * qT on the matching branch; the
  // cosh/sinh layer forms are even/odd in q so return qT * (-i) consistently
  return cmul([-0, 1], q); // i*qT... sign fixed by anchor consistency
}

/** sqrt of a complex value with Im(result) >= 0. */
function csqrtPosIm(z) {
  var r = Math.sqrt(cabs(z));
  var th = Math.atan2(z[1], z[0]);
  var half = th / 2;
  var re = r * Math.cos(half), im = r * Math.sin(half);
  if (im < 0 || (im === 0 && re < 0)) { re = -re; im = -im; }
  return [re, im];
}

// --- Bessel J_n: power series (x <= 12) + DLMF 10.17 asymptotic (x > 12) ---
function besselJ(n, x) {
  x = Math.abs(x);
  if (x < 1e-12) return n === 0 ? 1 : 0;
  if (x <= 12) {
    var half = x / 2, logHalf = Math.log(half), s = 0;
    for (var k = 0; k <= 80; k++) {
      var lg = (n + 2 * k) * logHalf;
      for (var j = 1; j <= k; j++) lg -= Math.log(j);
      for (var j2 = 1; j2 <= n + k; j2++) lg -= Math.log(j2);
      var term = (k % 2 ? -1 : 1) * Math.exp(lg);
      s += term;
      if (k > 4 && Math.abs(term) < 1e-17 * (Math.abs(s) + 1e-300)) break;
    }
    return s;
  }
  // DLMF 10.17.3 to O(1/x^2)
  var chi = x - (0.5 * n + 0.25) * Math.PI;
  var mu = 4 * n * n, x8 = 8 * x;
  var p = 1 - (mu - 1) * (mu - 9) / (2 * x8 * x8);
  var qterm = (mu - 1) / x8 * (1 - (mu - 9) * (mu - 25) / (6 * x8 * x8));
  return Math.sqrt(2 / (Math.PI * x)) * (p * Math.cos(chi) - qterm * Math.sin(chi));
}

// --- layered-stack SH propagator -------------------------------------------
// stack: [{topKm, bottomKm, vsKmS, rhoGcm3}, ...] top-first; final entry is
// the halfspace (bottomKm = Infinity or a large number).

function muOf(l) { return l.rhoGcm3 * 1000 * Math.pow(l.vsKmS * 1000, 2); } // Pa

/** 2x2 complex layer propagator over one layer (Thomson-Haskell). */
function shPropagator(layer, omega, k, opts) {
  var qs = opts && opts.qShear ? opts.qShear : 0;
  var mu = muOf(layer);
  var h = (layer.bottomKm - layer.topKm) * 1000; // m
  var q = q_layer(layer.vsKmS, omega, k, qs);
  var qh = cmul(q, [h, 0]);
  var C = ccosh(qh), S = csinh(qh);
  var muq = cmul([mu, 0], q);
  // q = i|q| for propagating: S/(mu q) = i sin/(mu i nu) fine; all pairs
  // branch-independent because they appear as sinh(qh)/q, mu q sinh(qh).
  return [
    [C, cdiv(S, muq)],
    [cmul(muq, S), C]
  ];
}

function matVec2(M, v) {
  return [cadd(cmul(M[0][0], v[0]), cmul(M[0][1], v[1])),
          cadd(cmul(M[1][0], v[0]), cmul(M[1][1], v[1]))];
}
function matMul2(A, B) {
  return [
    [cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
    [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]
  ];
}

/** Prepare a layer list with the source and receiver depths as layer
 *  boundaries. Returns {layers, halfIndex, iS, iR}. */
function prepareStack(stack, zSourceKm, zReceiverKm) {
  var lay = stack.map(function (l) {
    return { topKm: l.topKm, bottomKm: isFinite(l.bottomKm) ? l.bottomKm : 1e6, vsKmS: l.vsKmS, rhoGcm3: l.rhoGcm3 };
  });
  var halfIndex = lay.length - 1;
  function insertSplit(depthKm) {
    for (var i = 0; i < lay.length - 1; i++) {
      if (depthKm > lay[i].topKm + 1e-9 && depthKm < lay[i].bottomKm - 1e-9) {
        lay.splice(i + 1, 0, { topKm: depthKm, bottomKm: lay[i].bottomKm, vsKmS: lay[i].vsKmS, rhoGcm3: lay[i].rhoGcm3 });
        lay[i].bottomKm = depthKm;
        return;
      }
    }
  }
  insertSplit(zSourceKm); insertSplit(zReceiverKm);
  // Boundary depths must resolve to the layer STARTING at the boundary (its
  // top), so the source/receiver loops slice [0,iS) above and [iS,..) below
  // without propagating any layer twice. Resolving to the layer ENDING at
  // the boundary duplicated that layer's propagation and inflated layered
  // responses by orders of magnitude (caught by the JIVSM anchor case).
  function idxAt(d) {
    for (var i = 0; i < lay.length; i++) if (lay[i].topKm >= d - 1e-9) return i;
    return lay.length - 1;
  }
  return { layers: lay, halfIndex: lay.length - 1, iS: idxAt(zSourceKm), iR: idxAt(zReceiverKm) };
}

/** Layered response Y(k, omega): u_theta at zReceiver per unit traction
 *  jump at zSource (compliance, m/Pa). Free surface at the top; radiation
 *  into the bottom halfspace. All depths in km, k in 1/km, omega in rad/s. */
function shUnitJumpResponse(stack, omega, k, zSourceKm, zReceiverKm, opts) {
  var qs = opts && opts.qShear ? opts.qShear : 0;
  var st = prepareStack(stack, zSourceKm, zReceiverKm);
  var lay = st.layers;

  // column from the free surface down to just above the source: [u;tau] = colA * u0
  var v = [[1, 0], [0, 0]];
  for (var i = 0; i < st.iS; i++) v = matVec2(shPropagator(lay[i], omega, k, opts), v);
  var colA = v;

  // radiation: tau_H = i qT mu_H u_H
  var half = lay[st.halfIndex];
  var muH = muOf(half);
  var qH = qT_radiation(half.vsKmS, omega, k, qs);
  var rad = cmul(cmul(CI, qH), [muH, 0]);

  // Propagate the two B-side columns TOGETHER with common renormalisation:
  // thick evanescent layers overflow cosh/sinh, and scaling both columns by
  // the same factor leaves u0PerTau = -r2/r1 invariant (the system is linear
  // and both columns share the same layer products).
  var v1 = colA.slice();          // column (u0=1, dTau=0)
  var v2 = [[0, 0], [1, 0]];      // column (u0=0, dTau=1)
  for (var j = st.iS; j < st.halfIndex; j++) {
    var L = shPropagator(lay[j], omega, k, opts);
    v1 = matVec2(L, v1);
    v2 = matVec2(L, v2);
    var sc = Math.max(cabs(v1[0]), cabs(v1[1]), cabs(v2[0]), cabs(v2[1]));
    if (isFinite(sc) && sc > 1e100) {
      v1 = [cdiv(v1[0], [sc, 0]), cdiv(v1[1], [sc, 0])];
      v2 = [cdiv(v2[0], [sc, 0]), cdiv(v2[1], [sc, 0])];
    } else if (!isFinite(sc)) {
      return null; // genuine overflow (should not happen after renormalisation)
    }
  }
  var r1 = csub(v1[1], cmul(rad, v1[0]));
  var r2 = csub(v2[1], cmul(rad, v2[0]));
  var u0PerTau = cdiv(cscale(r2, -1), r1); // u0 / dTau

  // Receiver state: for receivers ABOVE the source, propagate the free-
  // surface state [u0; 0] down to the receiver (u0 itself at the surface);
  // for receivers BELOW, continue from the source-bottom state (traction
  // jumped by dTau, u continuous). (Returning the SOURCE-level state for
  // above-source receivers was a real bug — it reported the resonance-
  // enhanced source depth motion instead.)
  if (zReceiverKm <= zSourceKm + 1e-9) {
    var vUp = [u0PerTau, [0, 0]];
    for (var m2 = 0; m2 < st.iR; m2++) vUp = matVec2(shPropagator(lay[m2], omega, k, opts), vUp);
    return vUp[0];
  }
  var vTop = [cmul(colA[0], u0PerTau), cmul(colA[1], u0PerTau)];
  var vBot = [vTop[0], cadd(vTop[1], [1, 0])];
  var vCur = vBot;
  for (var m = st.iS; m < st.iR; m++) vCur = matVec2(shPropagator(lay[m], omega, k, opts), vCur);
  return vCur[0];
}

/** Full-space spectral compliance (anchor reference): response per unit
 *  anti-plane force delta at zs observed at zr,
 *      G(k) = -i exp(i qT |zr - zs|) / (2 mu qT),  qT = sqrt(w^2/b^2 - k^2), Im>=0.
 *  Sign locked by anchor A1 (Sommerfeld identity + closed form). */
function shFullSpaceCompliance(layer, omega, k, zsKm, zrKm, opts) {
  var qs = opts && opts.qShear ? opts.qShear : 0;
  var mu = muOf(layer);
  var q = qT_radiation(layer.vsKmS, omega, k, qs);
  var dz = Math.abs(zrKm - zsKm) * 1000;
  var ex = cmul(cmul(CI, q), [dz, 0]); // i q dz
  var e = [Math.exp(ex[0]) * Math.cos(ex[1]), Math.exp(ex[0]) * Math.sin(ex[1])];
  var num = cmul(cscale(e, -1), CI); // -i e^{i q dz}
  var den = cmul(cmul([2 * mu, 0], q), [1, 0]);
  return cdiv(num, den);
}

/** m=2 source traction-jump amplitude per the formulation header. */
function shSourceJump(mxx, myy, mxy, k, phi) {
  var c2 = 0.5 * ((myy - mxx) * Math.sin(2 * phi) + 2 * mxy * Math.cos(2 * phi));
  return cmul(CI, [-k * c2, 0]); // -i k C2
}

/** DW spectrum at one frequency. params: {rKm, phiRad, zSourceKm,
 *  zReceiverKm, mxx, myy, mxy, dkInvKm, kMaxInvKm, halfSpace (bool)}.
 *  k grid is specified in 1/km for convenience and converted to SI 1/m. */
function shSpectrumAtFrequency(stack, omega, params) {
  var rM = params.rKm * 1000, phi = params.phiRad;
  var dk = params.dkInvKm / 1000, kMax = params.kMaxInvKm / 1000; // 1/m
  var sum = [0, 0];
  for (var k = dk; k <= kMax + 1e-15; k += dk) {
    var j2 = besselJ(2, k * rM);
    if (Math.abs(j2) < 1e-14) continue;
    var dTau = shSourceJump(params.mxx, params.myy, params.mxy, k, phi);
    var Y = params.halfSpace
      ? shFullSpaceCompliance(stack[0], omega, k, params.zSourceKm, params.zReceiverKm, params)
      : shUnitJumpResponse(stack, omega, k, params.zSourceKm, params.zReceiverKm, params);
    if (!Y || !isFinite(Y[0]) || !isFinite(Y[1])) continue;
    sum = cadd(sum, cmul(cmul(dTau, Y), [k * dk * j2, 0]));
  }
  return cscale(sum, 1 / (2 * Math.PI));
}

/** Frequency response for one receiver. freqsHz ascending, u_theta in m. */
function shGreenSpectrum(stack, params, freqsHz) {
  var out = [];
  for (var i = 0; i < freqsHz.length; i++) {
    out.push(shSpectrumAtFrequency(stack, 2 * Math.PI * freqsHz[i], params));
  }
  return { freqsHz: freqsHz.slice(), spectra: out };
}

/** Exact full-space displacement (anchor reference), metres. Optional
 *  qShear applies the SAME complex velocity beta* = beta(1 + i/(2Q)) as the
 *  kernel so the anchor comparison stays exact under attenuation. */
function fullSpaceClosedForm(vsKmS, rhoGcm3, rKm, phiRad, zrKm, zsKm, omega, mxx, myy, mxy, qShear) {
  var beta = vsKmS * 1000, eps = qShear && qShear > 0 ? 1 / (2 * qShear) : 0;
  var betaC = [beta, -beta * eps]; // beta* = beta (1 - i/(2Q)) for e^{-i omega t}
  var b2 = cmul(betaC, betaC);
  var muC = [rhoGcm3 * 1000 * b2[0], rhoGcm3 * 1000 * b2[1]];
  var x = rKm * 1000 * Math.cos(phiRad), y = rKm * 1000 * Math.sin(phiRad);
  var dz = (zsKm - zrKm) * 1000;
  var R = Math.sqrt(x * x + y * y + dz * dz);
  var ph = cdiv([omega * R, 0], betaC);
  var eip = [Math.cos(ph[0]) * Math.exp(-ph[1]), Math.sin(ph[0]) * Math.exp(-ph[1])];
  var deip = [-eip[1], eip[0]]; // i e^{i ph}
  var den = cmul([4 * Math.PI * R, 0], muC);
  var dphdR = cdiv([omega, 0], betaC);
  var dgdr = cadd(cdiv(cmul(deip, dphdR), den),
                  cdiv(cmul(eip, [-1, 0]), cmul([4 * Math.PI * R * R, 0], muC)));
  function dd(coord) { return cscale(dgdr, coord / R); }
  var ux = cscale(cadd(cscale(dd(x), mxx), cscale(dd(y), mxy)), -1);
  var uy = cscale(cadd(cscale(dd(x), mxy), cscale(dd(y), myy)), -1);
  return cadd(cscale(ux, -Math.sin(phiRad)), cscale(uy, Math.cos(phiRad)));
}

/** k is in 1/km (converted to SI 1/m internally, consistent with the DW API). */
function shDispersionFunction(stack, omega, kInvKm) {
  var k = kInvKm / 1000; // 1/m
  var v = [[1, 0], [0, 0]];
  for (var i = 0; i < stack.length - 1; i++) v = matVec2(shPropagator(stack[i], omega, k), v);
  var half = stack[stack.length - 1];
  var rad = cmul(cmul(CI, qT_radiation(half.vsKmS, omega, k)), [muOf(half), 0]);
  return csub(v[1], cmul(rad, v[0]));
}

module.exports = {
  cadd: cadd, csub: csub, cmul: cmul, cscale: cscale, cdiv: cdiv, cabs: cabs, CI: CI,
  besselJ: besselJ, qT_radiation: qT_radiation, q_layer: q_layer, csqrtPosIm: csqrtPosIm,
  shPropagator: shPropagator, shUnitJumpResponse: shUnitJumpResponse,
  shFullSpaceCompliance: shFullSpaceCompliance, shSourceJump: shSourceJump,
  shSpectrumAtFrequency: shSpectrumAtFrequency, shGreenSpectrum: shGreenSpectrum,
  fullSpaceClosedForm: fullSpaceClosedForm, shDispersionFunction: shDispersionFunction
};
