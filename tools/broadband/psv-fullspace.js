'use strict';
// =====================================================================
//  psv-fullspace.js — closed-form FULL-SPACE elastodynamic reference for
//  tools/broadband/psv.js (v6.2 P-SV absolute source-calibration anchor,
//  2026-09-05). Offline research module; the analog of core.js's
//  shFullSpaceCompliance for the in-plane problem, plus the moment-tensor
//  response in closed form. Depends only on core.js complex helpers (the
//  nu branch convention is duplicated verbatim from psv.nuOf to keep this
//  module cycle-free).
//
//  Physics (self-derived; every constant checked in
//  tests/psv-fullspace.test.js against independent limits):
//
//  * Spatial per-force Green tensor of the homogeneous full space
//    (e^{-i omega t}, outgoing e^{+ikr}):
//        G_np(r,ω) = 1/(4πρω²) [ δ_np k_β² F_β + ∂_n∂_p (F_β − F_α) ],
//        F_c = e^{i k_c r}/r,  k_c = ω/c_c.
//    ω→0 reproduces the Kelvin static tensor exactly; the far field is the
//    classic P-on-radial / SV-on-transverse pattern (both asserted in A1).
//
//  * κ-domain tensor via the Weyl/Sommerfeld identity
//    FT[e^{ikr}/r] = −2πi e^{i q_c |h|}/q_c  (q_c = sqrt(k_c²−κ²),
//    Im q_c ≥ 0 — same branch as psv.nuOf):
//        G̃_rr = (k_β² F̃_β − κ²(F̃_β−F̃_α)) / (4πρω²)
//        G̃_rz = i κ sgn(h) (S_β−S_α) / (2ρω²)        (S_c = e^{i q_c |h|})
//        G̃_zz = (k_β² F̃_β + 2πi(q_βS_β−q_αS_α)) / (4πρω²)
//        G̃_θθ = k_β² F̃_β / (4πρω²) = +i e^{iq_β|h|}/(2μq_β)
//    All entries are the TRUE per-force response (Kelvin-anchored). Note
//    G̃_θθ = − core.shFullSpaceCompliance: core's compliance carries the
//    opposite (unit-jump insertion) sign — asserted in A2c, harmless for
//    the magnitude-domain SH product, pinned here so the P-SV anchor has
//    one explicit convention. The psv.js layered-C sign is pinned
//    empirically by A3 (see the complianceTriple comment in psv.js).
//
//  * Moment response (closed form, spatial):
//        u_k = −M_np ∂_{ξ_n} G_kp
//            = −(1/(4πρω²)) [ k_β² M_kp ∂_pF_β + M_np (T^β−T^α)_nkp ],
//    T_nkp = ∂_n∂_k∂_p F = n̂_nn̂_kn̂_p F'''
//            + [(δ_pn−n̂_pn̂_n)n̂_k + (δ_pk−n̂_pn̂_k)n̂_n](F''−F')/r
//            + (δ_nk−n̂_nn̂_k)n̂_p(F''/r − F'/r²),
//    F' = (ik−1/r)F, F'' = ((ik−1/r)²+1/r²)F,
//    F''' = ((2(ik−1/r)/r² − 2/r³) + ((ik−1/r)²+1/r²)(ik−1/r))F.
//
//  * momentBlockReference — the psv.js-comparable reference. The κ-domain
//    response is block-diagonal in the (κ̂, θ̂_κ, ẑ) frame: a (κ̂,ẑ) P-SV
//    block {G̃_rr,G̃_rz;G̃_zr,G̃_zz} and an SH block G̃_θθ. psv.js computes
//    ONLY the P-SV block's projections onto (u_r, u_θ, u_z); the SH block
//    is core.js's scope. This reference numerically integrates the P-SV
//    block's projections (α + κ quadrature — NO Bessel identities, so it
//    is independent of all identity bookkeeping):
//      κ̂-displacement:  G̃_rr f̂_r + G̃_rz f̂_z
//                        − [(M_xz cosα + M_yz sinα)∂_zsG̃_rr + M_zz ∂_zsG̃_rz]
//      ẑ-displacement :  G̃_zr f̂_r + G̃_zz f̂_z
//                        − [(M_xz cosα + M_yz sinα)∂_zsG̃_zr + M_zz ∂_zsG̃_zz]
//      f̂_r = −iκ(P0 + P2cos2α + Q2sin2α), f̂_z = −iκ(M_xz cosα + M_yz sinα)
//      u_r = proj onto r̂ (κ̂·r̂ = cosα), u_θ onto θ̂_rec (κ̂·θ̂ = sinα),
//      ∂_zs = −∂_h applied by central difference on the analytic tensor.
//    (SH-block terms f̂_θ and the G̃_θθ z-arm pieces are excluded by design,
//    matching psv.js's declared scope; hybrid consumes only ur/uz.)
// =====================================================================
const core = require('./core.js');

const cadd = core.cadd, csub = core.csub, cmul = core.cmul,
  cscale = core.cscale, cdiv = core.cdiv, csqrtPosIm = core.csqrtPosIm;

function expI(x) { return [Math.cos(x), Math.sin(x)]; }
function rmul(a, c) { return [a * c[0], a * c[1]]; }

/** nu_c = sqrt(w²/c² − k²), Im ≥ 0, complex c* = c(1 − i/(2Q)) — verbatim
 *  copy of psv.nuOf so the reference shares the exact Q branch. */
function nuOf(vKmS, omega, kInvM, q) {
  const b = vKmS * 1000;
  const b2 = (q && q > 0) ? [b * b, -b * b / q] : [b * b, 0];
  const om2 = omega * omega;
  const val = [om2 * b2[0] / (b2[0] * b2[0] + b2[1] * b2[1]) - kInvM * kInvM,
    -om2 * b2[1] / (b2[0] * b2[0] + b2[1] * b2[1])];
  return csqrtPosIm(val);
}

/** κ-domain per-force P-SV block + SH column. hM = zr − zs in METRES
 *  (z down, signed); kappaInvM in 1/m. Complex {grr, grz, gzz, gtt}.
 *  Undamped calls (falsy q) default to Q = 1e4 for BOTH waves: the tensor
 *  carries explicit 1/q_c factors that diverge at the κ = ω/c_c branch
 *  points when a quadrature sample lands on them exactly; a 1e-4 relative
 *  damping bounds 1/q with negligible physical effect. (The layered kernel
 *  has no such terms — its compliance is algebraic in the propagators.) */
function fullSpaceForceTensorKappa(layer, omega, kappaInvM, hM, opts) {
  const vs = layer.vsKmS * 1000, rho = layer.rhoGcm3 * 1000;
  const qS = (opts && opts.qShear) || 1e4;
  const qP = (opts && opts.qP) || 1e4;
  const nuB = nuOf(layer.vsKmS, omega, kappaInvM, qS);
  const nuA = nuOf(layer.vpKmS, omega, kappaInvM, qP);
  const sgn = hM >= 0 ? 1 : -1;
  const hAbs = Math.abs(hM);
  const S = (nu) => { const a = -nu[1] * hAbs, b = nu[0] * hAbs, e = Math.exp(a); return [e * Math.cos(b), e * Math.sin(b)]; };
  const Fw = (nu) => cdiv(cmul([0, 2 * Math.PI], S(nu)), nu); // +2πi e^{iq|h|}/q (Weyl, force-response convention)
  const FB = Fw(nuB), FA = Fw(nuA), SB = S(nuB), SA = S(nuA);
  const kB2 = (omega / vs) * (omega / vs);
  const den = 4 * Math.PI * rho * omega * omega;
  const grr = cdiv(csub(rmul(kB2, FB), rmul(kappaInvM * kappaInvM, csub(FB, FA))), [den, 0]);
  const grz = cdiv(cmul([0, -kappaInvM * sgn * 2 * Math.PI], csub(SB, SA)), [den, 0]);
  const gzz = cdiv(csub(rmul(kB2, FB), cmul([0, 2 * Math.PI], csub(cmul(nuB, SB), cmul(nuA, SA)))), [den, 0]);
  const gtt = cdiv(rmul(kB2, FB), [den, 0]);
  return { grr: grr, grz: grz, gzz: gzz, gtt: gtt };
}

/** Spatial per-force 3×3 Green tensor (rows = displacement x,y,z;
 *  cols = force x,y,z). r vec = receiver − source in metres, z down.
 *  opts.qShear/qP give the waves the SAME c* damping convention as the
 *  κ-domain tensor (complex k_c = nuOf(c, ω, 0, q) — exactly ω/c*). */
function fullSpaceForceTensorSpatial(layer, omega, dxM, dyM, dzM, opts) {
  const r = Math.sqrt(dxM * dxM + dyM * dyM + dzM * dzM);
  const n = [dxM / r, dyM / r, dzM / r];
  const rho = layer.rhoGcm3 * 1000;
  const den = 4 * Math.PI * rho * omega * omega;
  function radial(cKmS, q) {
    const k = nuOf(cKmS, omega, 0, q); // complex ω/c* — exponent/damping only
    const ea = -k[1] * r, eb = k[0] * r, ee = Math.exp(ea);
    const F = cscale([ee * Math.cos(eb), ee * Math.sin(eb)], 1 / r);
    const g = csub(cmul([0, 1], k), [1 / r, 0]); // ik − 1/r
    const g2 = cmul(g, g);
    const W = cadd(g2, [1 / (r * r), 0]);
    const F1 = cmul(g, F);
    const F2 = cmul(W, F);
    const Wp = csub(cscale(g, 2 / (r * r)), [2 / (r * r * r), 0]);
    const F3 = cmul(cadd(Wp, cmul(W, g)), F);
    return { F: F, F1: F1, F2: F2, F3: F3, k: k, k2: (omega / (cKmS * 1000)) * (omega / (cKmS * 1000)) };
  }
  const B = radial(layer.vsKmS, opts && opts.qShear), A = radial(layer.vpKmS, opts && opts.qP);
  // δ-term prefactor stays REAL ω²/c² (damping enters the dispersion k* in
  // F and its derivatives, never the source-strength moduli — same rule as
  // the κ-domain tensor, where den = 4πρω² is real).
  const kB2 = B.k2;
  const G = [];
  for (let k = 0; k < 3; k++) {
    const row = [];
    for (let p = 0; p < 3; p++) {
      const nknp = n[k] * n[p];
      const off = (k === p ? 1 : 0) - nknp;
      const d2B = cadd(rmul(nknp, B.F2), rmul(off / r, B.F1));
      const d2A = cadd(rmul(nknp, A.F2), rmul(off / r, A.F1));
      row.push(cdiv(cadd(rmul(k === p ? kB2 : 0, B.F), csub(d2B, d2A)), [den, 0]));
    }
    G.push(row);
  }
  return { G: G, radialB: B, radialA: A, n: n, r: r, den: den, kB2: kB2 };
}

/** Spatial moment-tensor response (FULL vector incl. the SH block). */
function fullSpaceMomentResponseSpatial(layer, omega, dxM, dyM, dzM, M) {
  const m = [[M.mxx, M.mxy, M.mxz], [M.mxy, M.myy, M.myz], [M.mxz, M.myz, M.mzz]];
  const fs = fullSpaceForceTensorSpatial(layer, omega, dxM, dyM, dzM);
  const n = fs.n, r = fs.r;
  function Tnkp(rad, i, k, p) {
    const triple = n[i] * n[k] * n[p];
    const Aikp = ((p === i ? 1 : 0) - n[p] * n[i]) * n[k] + ((p === k ? 1 : 0) - n[p] * n[k]) * n[i];
    const t1 = rmul(triple, rad.F3);
    const t2 = rmul(Aikp / r, csub(rad.F2, rad.F1));
    const dik = ((k === i ? 1 : 0) - n[k] * n[i]) * n[p];
    const t3 = rmul(dik, csub(cscale(rad.F2, 1 / r), cscale(rad.F1, 1 / (r * r))));
    return cadd(cadd(t1, t2), t3);
  }
  const u = [];
  for (let k = 0; k < 3; k++) {
    let s1 = [0, 0];
    for (let p = 0; p < 3; p++) s1 = cadd(s1, rmul(m[k][p] * n[p], fs.radialB.F1));
    let s2 = [0, 0];
    for (let i = 0; i < 3; i++) for (let p = 0; p < 3; p++) {
      s2 = cadd(s2, cmul([m[i][p], 0], csub(Tnkp(fs.radialB, i, k, p), Tnkp(fs.radialA, i, k, p))));
    }
    u.push(cscale(csub(rmul(fs.kB2, s1), s2), -1 / fs.den));
  }
  return { ux: u[0], uy: u[1], uz: u[2] };
}

/** P-SV-block reference comparable to
 *  psv.psvMomentSpectrumAtFrequency(stack, ω, {...params, fullSpace:true}).
 *  params: { rM, zSourceKm, mxx,myy,mzz,mxy,mxz,myz, qShear, qP,
 *  dkInvKm (default 0.005), kMaxInvKm (default 6), alphaN (default 1024),
 *  dhFdM (default 1) }. Receiver at the surface (zr = 0), source below. */
function momentBlockReference(layer, omega, params) {
  const kappaMax = (params.kMaxInvKm || 6) / 1000;
  const dKappa = (params.dkInvKm || 0.005) / 1000;
  const nAlpha = params.alphaN || 1024;
  const dh = params.dhFdM || 1.0;
  const h0 = -params.zSourceKm * 1000;
  const Mzz = params.mzz || 0, Mxz = params.mxz || 0, Myz = params.myz || 0;
  const P0 = 0.5 * ((params.mxx || 0) + (params.myy || 0));
  const P2 = 0.5 * ((params.mxx || 0) - (params.myy || 0));
  const Q2 = params.mxy || 0;
  const rM = params.rM;
  const dA = 2 * Math.PI / nAlpha;
  // Branch-aware kappa sampling (2026-09-06 branch-cusp batch): the 1/q_c
  // Weyl factors cusp the integrand like 1/sqrt(kappa_bp - kappa) at the
  // branch points kappa = Re(nuOf(c, omega, 0, q)) — integrable, but a
  // plain kappa grid converges only O(sqrt(h)) there (measured: the A3
  // deviatoric.ur residual is dominated by exactly this quadrature bias
  // once the psv.js machinery subtracts the singular factor analytically).
  // On both sides of every SHARP branch point (Im k* below the grid —
  // damped branch points are already rounded over Im k* and resolve) the
  // segment is integrated by the xi = sqrt(|k - k_bp|) substitution,
  // kappa = k_bp -+ xi^2, dk = 2 xi dxi: 2 xi g is smooth in xi. The
  // substitution is INDEPENDENT of the consumer's analytic-factor
  // subtraction (no shared fit code) — it integrates the raw integrand.
  const qSe = params.qShear || 1e4, qPe = params.qP || 1e4;
  const bps = [];
  for (const vc of [[layer.vsKmS, qSe], [layer.vpKmS, qPe]]) {
    const kst = nuOf(vc[0], omega, 0, vc[1]);
    if (kst[0] > 0 && kst[0] < kappaMax && kst[1] < dKappa / 2) bps.push(kst[0]);
  }
  const delta = 5e-5, nXi = 300, dXi = Math.sqrt(delta) / nXi; // +-0.05/km window
  const samples = [];
  for (let kap = dKappa; kap <= kappaMax + 1e-15; kap += dKappa) {
    let inB = false;
    for (const b of bps) if (Math.abs(kap - b) < delta) { inB = true; break; }
    if (!inB) samples.push([kap, dKappa]);
  }
  for (const b of bps) {
    for (let j = 0; j < nXi; j++) {
      const xi = (j + 0.5) * dXi;
      samples.push([b - xi * xi, 2 * xi * dXi]);
      samples.push([b + xi * xi, 2 * xi * dXi]);
    }
  }
  let urA = [0, 0], utA = [0, 0], uzA = [0, 0];
  for (const [kap, dw] of samples) {
    const t0 = fullSpaceForceTensorKappa(layer, omega, kap, h0, params);
    const tp = fullSpaceForceTensorKappa(layer, omega, kap, h0 + dh, params);
    const tm = fullSpaceForceTensorKappa(layer, omega, kap, h0 - dh, params);
    const dGrr = cscale(csub(tp.grr, tm.grr), -1 / (2 * dh)); // dG/dzs = −dG/dh
    const dGrz = cscale(csub(tp.grz, tm.grz), -1 / (2 * dh));
    const dGzz = cscale(csub(tp.gzz, tm.gzz), -1 / (2 * dh));
    let kUr = [0, 0], kUt = [0, 0], kUz = [0, 0];
    for (let ia = 0; ia < nAlpha; ia++) {
      const al = (ia + 0.5) * dA;
      const ca = Math.cos(al), sa = Math.sin(al), c2 = Math.cos(2 * al), s2 = Math.sin(2 * al);
      const kr = kap * rM * ca;
      const ph = [Math.cos(kr), Math.sin(kr)];
      const frI = -(P0 + P2 * c2 + Q2 * s2); // f̂_r = i·κ·frI
      const fzI = -(Mxz * ca + Myz * sa);    // f̂_z = i·κ·fzI
      const mix = Mxz * ca + Myz * sa;
      let UrK = cadd(cmul([0, kap * frI], t0.grr), cmul([0, kap * fzI], t0.grz));
      UrK = csub(UrK, cadd(rmul(mix, dGrr), rmul(Mzz, dGrz)));
      let UzK = cadd(cmul([0, kap * frI], t0.grz), cmul([0, kap * fzI], t0.gzz));
      UzK = csub(UzK, cadd(rmul(mix, dGrz), rmul(Mzz, dGzz)));
      const phUr = cmul(ph, UrK), phUz = cmul(ph, UzK);
      kUr = cadd(kUr, cscale(phUr, ca));
      kUt = cadd(kUt, cscale(phUr, sa));
      kUz = cadd(kUz, phUz);
    }
    const w = kap * dw * dA / (4 * Math.PI * Math.PI);
    urA = cadd(urA, cscale(kUr, w));
    utA = cadd(utA, cscale(kUt, w));
    uzA = cadd(uzA, cscale(kUz, w));
  }
  return { ur: urA, uz: uzA, ut: utA };
}

module.exports = {
  nuOf: nuOf,
  fullSpaceForceTensorKappa: fullSpaceForceTensorKappa,
  fullSpaceForceTensorSpatial: fullSpaceForceTensorSpatial,
  fullSpaceMomentResponseSpatial: fullSpaceMomentResponseSpatial,
  momentBlockReference: momentBlockReference
};
