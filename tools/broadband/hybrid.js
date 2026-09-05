'use strict';
// =====================================================================
//  v6.1 B2 — hybrid broadband synthesis (research offline pipeline).
//
//  Low frequency (< fc, default 1.0 Hz): the B1 SH discrete-wavenumber
//  Green's function (tools/broadband/core.js) for the transverse
//  component. The kernel is the HARMONIC per-unit-moment response
//  (anchor A1: |kernel| = omega^1 * C2 / (4 pi rho beta^3 R)), so the
//  acceleration FAS fill is
//      X_a(f) = kernel(f) * i*omega*wc^2/(wc + i*omega)^2          (M6.0)
//  — the Brune moment spectrum M0*wc^2/(i*omega*(wc+i*omega)^2) times
//  the omega^2 acceleration operator collapses to exactly this factor.
//  B2-beta calibration fix (2026-09-01): the B2-alpha chain multiplied
//  the COMBINED spectrum by omega^2 once more (the LF fill above is
//  already acceleration) — that single over-differentiation tilted the
//  whole hybrid by f^2 away from the crossover and produced BOTH frozen
//  diagnostics at once (PGA 2.6x GMPE, PSA(2s)/PGA ~1%). The inverse-DFT
//  Riemann factor is sr (not 2*sr: the conjugate-mirror fill already
//  accounts for the negative-frequency half).
//
//  High frequency (> fc): a Boore-style stochastic series on the
//  project's own path model (Physics.bruneSpectrum x geometricSpreading
//  x Q), calibrated to ABSOLUTE physical units with the standard point-
//  source constant C = Rtheta/(4 pi rho beta^3) (Boore 1983 semantics;
//  bruneSpectrum is the M0*omega^2/(1+(f/f0)^2) relative shape, so C
//  restores m/s^2 per Hz). Random phase seeded, kappa-damped, shaped by
//  the P/S phase envelope. The crossover matching compares SMOOTHED
//  (moving geometric mean) acceleration FAS levels in [0.7 fc, 1.3 fc]
//  and applies the geometric-mean ratio as a bounded correction
//  (hfScale clamped to [0.25, 4], recorded in meta) — with the HF side
//  now independently absolute, a scale far from 1 is a calibration
//  diagnostic, not something the matching should silently absorb.
//
//  CAPABILITY BOUNDARY (public): SH only — the LF deterministic side
//  exists ONLY for the transverse component; the radial/vertical LF
//  (P-SV, Rayleigh/SV) is NOT implemented (B-stage follow-up). The
//  transverse channel is the physically grounded output; radial is
//  HF-only when requested and must not be used at periods beyond ~2 s.
// =====================================================================
const core = require('./core.js');
const psv = require('./psv.js');
const Physics = require('../../public/physics.js');

/** Double-couple moment tensor (N*m) in the geographic frame
 *  (xx = North-North, yy = East-East, zz = Down-Down, xy/... off-diagonal).
 *  Formula set = the validated implementation of tools/export-specfem-case.js
 *  (which emits SPECFEM CMTSOLUTION (r,t,p) = up/south/east), mapped via
 *  N=-t, E=p, D=-r; self-checks zero trace and |M| = sqrt(2) m0. */
function dcMomentTensor(strikeDeg, dipDeg, rakeDeg, m0) {
  const toR = Math.PI / 180;
  const f = strikeDeg * toR, d = dipDeg * toR, l = rakeDeg * toR;
  const sd = Math.sin(d), cd = Math.cos(d), s2d = Math.sin(2 * d), c2d = Math.cos(2 * d);
  const sf = Math.sin(f), cf = Math.cos(f), s2f = Math.sin(2 * f), c2f = Math.cos(2 * f);
  const sl = Math.sin(l), cl = Math.cos(l);
  const Mxx = -m0 * (sd * cl * s2f + s2d * sl * sf * sf);
  const Myy = m0 * (sd * cl * s2f - s2d * sl * cf * cf);
  const Mzz = m0 * s2d * sl;
  const Mxy = m0 * (sd * cl * c2f + 0.5 * s2d * sl * s2f);
  const Mxz = -m0 * (cd * cl * cf + c2d * sl * sf);
  const Myz = -m0 * (cd * cl * sf - c2d * sl * cf);
  const trace = Mxx + Myy + Mzz;
  const norm = Math.sqrt(Mxx * Mxx + Myy * Myy + Mzz * Mzz + 2 * (Mxy * Mxy + Mxz * Mxz + Myz * Myz));
  if (Math.abs(trace) > 1e-6 * m0) throw new Error('DC tensor non-zero trace ' + trace);
  if (Math.abs(norm - Math.SQRT2 * m0) > 0.01 * Math.SQRT2 * m0) {
    throw new Error('DC tensor norm check failed: ' + norm + ' vs ' + Math.SQRT2 * m0);
  }
  return { xx: Mxx, yy: Myy, zz: Mzz, xz: Mxz, yz: Myz, xy: Mxy };
}

/** Horizontal tensor components rotated into the receiver frame
 *  (x = radial from source to receiver, y = transverse). azimuthDeg is the
 *  source-to-receiver azimuth from North, clockwise. */
function rotateHorizontal(M, azimuthDeg) {
  const a = azimuthDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  // x = N*ca + E*sa ; y = -N*sa + E*ca
  const xx = M.xx * ca * ca + M.yy * sa * sa + 2 * M.xy * ca * sa;
  const yy = M.xx * sa * sa + M.yy * ca * ca - 2 * M.xy * ca * sa;
  const xy = (M.yy - M.xx) * ca * sa + M.xy * (ca * ca - sa * sa);
  return { mxx: xx, myy: yy, mxy: xy };
}

/** Great-circle azimuth source -> receiver (deg from North). */
function azimuthDeg(lat1, lng1, lat2, lng2) {
  const toR = Math.PI / 180;
  const f1 = lat1 * toR, f2 = lat2 * toR, dl = (lng2 - lng1) * toR;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return Math.atan2(y, x) * 180 / Math.PI;
}

/** Boore (1983) point-source constant C = Rtheta / (4 pi rho beta^3),
 *  SI (rho kg/m^3, beta m/s). With bruneSpectrum (M0 omega^2 relative
 *  shape) and 1/R in metres this returns the acceleration FAS in
 *  m/s^2 per Hz. */
function booreSourceConstant(rhoKgM3, betaMS, rThetaPhi, freeSurfaceF) {
  // freeSurfaceF: SH free-surface doubling for the transverse channel
  // (no horizontal partition loss — all SH lands on transverse). Default 2.
  return ((rThetaPhi == null ? 0.55 : rThetaPhi) * (freeSurfaceF == null ? 2 : freeSurfaceF))
    / (4 * Math.PI * rhoKgM3 * Math.pow(betaMS, 3));
}

/** Absolute stochastic acceleration FAS (m/s^2 per Hz) at frequency f.
 *  ctx: {mw, distKm, stressMPa, siteAmp, Q0, eta, kappaSec, cB}. */
function hfAccelFAS(f, ctx) {
  const site = ctx.siteCurve ? siteAmpAt(ctx.siteCurve, f) : (ctx.siteAmp || 1);
  const a = Physics.bruneSpectrum(f, ctx.mw, ctx.stressMPa)
    * Physics.geometricSpreading(ctx.distKm) / 1000 // 1/km -> 1/m
    * Physics.qAttenuation(f, ctx.distKm, ctx.Q0 == null ? 200 : ctx.Q0, ctx.eta == null ? 0.7 : ctx.eta)
    * site
    * Math.exp(-Math.PI * (ctx.kappaSec == null ? 0.04 : ctx.kappaSec) * f);
  return a * ctx.cB;
}

/** Log-log interpolation of a site-amplification curve given as
 *  {freqs[], amps[]} onto an arbitrary frequency (constant outside). */
function siteAmpAt(curve, f) {
  if (!curve || !curve.freqs || curve.freqs.length < 2) return 1;
  const fr = curve.freqs, am = curve.amps;
  if (!(f > 0)) return am[0];
  if (f <= fr[0]) return am[0];
  if (f >= fr[fr.length - 1]) return am[fr.length - 1];
  let lo = 0;
  while (lo < fr.length - 2 && fr[lo + 1] < f) lo++;
  const t = (Math.log(f) - Math.log(fr[lo])) / (Math.log(fr[lo + 1]) - Math.log(fr[lo]));
  return Math.exp((1 - t) * Math.log(am[lo]) + t * Math.log(am[lo + 1]));
}

/** Build the absolute HF acceleration FAS array (NF bins, conjugate
 *  mirrored, random phase) for the given ctx + fill factor. */
function buildHfSpectrum(NF, df, ctx, seed, fillScale) {
  // continuous-FAS amplitudes -> DFT bins via X_dft = sr*X_cont (same
  // Riemann convention as the LF fill; the flat-FAS reference test pins
  // this — omitting sr under-scales the time series by sr)
  const sr = NF * df;
  const rng = Physics.seededRng(seed);
  const fMax = Math.min(20, sr * 0.45);
  const out = new Array(NF).fill(0).map(() => [0, 0]);
  for (let i = 1; i < NF / 2; i++) {
    const f = i * df;
    if (f > fMax) break;
    const amp = hfAccelFAS(f, ctx) * (fillScale || 1) * sr;
    const ph = 2 * Math.PI * rng();
    out[i] = [amp * Math.cos(ph), amp * Math.sin(ph)];
    out[NF - i] = [amp * Math.cos(ph), -amp * Math.sin(ph)];
  }
  return out;
}

/** One-pole-style power-complementary pair around fcHz. */
function spectralFilter(spec, mode, fcHz) {
  const NF = spec.length, df = arguments.length > 3 ? arguments[3] : null;
  const out = new Array(NF).fill(0).map(() => [0, 0]);
  for (let i = 1; i < NF / 2; i++) {
    const f = df != null ? i * df : i; // df omitted: assume 1 Hz/bin (tests)
    const x = f / fcHz;
    const g = mode === 'lp' ? 1 / Math.sqrt(1 + x * x * x * x)
      : x * x / Math.sqrt(1 + Math.pow(x, 4));
    out[i] = [spec[i][0] * g, spec[i][1] * g];
    out[NF - i] = [out[i][0], -out[i][1]];
  }
  return out;
}

/** Moving geometric mean of |X(f)| over +/- halfWindow bins. */
function smoothedMagnitude(spec, halfWindow) {
  const NF = spec.length;
  const out = new Array(NF).fill(0);
  for (let i = 1; i < NF / 2; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(1, i - halfWindow); j <= Math.min(NF / 2 - 1, i + halfWindow); j++) {
      const a = core.cabs(spec[j]);
      if (a > 0) { s += Math.log(a); n++; }
    }
    out[i] = n ? Math.exp(s / n) : 0;
  }
  return out;
}

/** Inverse FFT (real output) of a conjugate-mirrored spectrum, in the
 *  fill convention X_dft[k] = sr * X_cont(f_k). */
function ifftReal(spec, NF) {
  const re = new Array(NF).fill(0), im = new Array(NF).fill(0);
  for (let i = 0; i < NF; i++) { re[i] = spec[i][0]; im[i] = -spec[i][1]; }
  fftInPlace(re, im);
  const out = new Array(NF);
  for (let i = 0; i < NF; i++) out[i] = re[i] / NF;
  return out;
}

/** One hybrid transverse-channel synthesis.
 *  opts: { stack, sourceLat, sourceLng, sourceDepthKm, mw, strike, dip, rake,
 *          receiverLat, receiverLng, vs30, fcHz=1.0, sampleRateHz=20,
 *          durationS (default sT+70, cap 180), qShear=50, dkInvKm=0.01,
 *          kMaxInvKm=5, lfMaxHz=2.0, seed, stressMPa=3, kappaSec=0.04,
 *          rhoKgM3=2700, rThetaPhi=0.55, hfScaleClamp=[0.25,4] }
 *  Returns { transverse, radial (HF-only), sampleRateHz, nSamples,
 *            units:'m/s^2', meta } — meta carries the calibration
 *  diagnostics (band FAS levels, hfScale, fcSrc, travel times). */
function hybridSynthesis(opts) {
  const fcHz = opts.fcHz || 1.0;
  const sr = opts.sampleRateHz || 20;
  const distKm = Physics.haversineDist(opts.sourceLat, opts.sourceLng, opts.receiverLat, opts.receiverLng);
  const az = azimuthDeg(opts.sourceLat, opts.sourceLng, opts.receiverLat, opts.receiverLng);
  const pT = Physics.pTravelTime(distKm, opts.sourceDepthKm);
  const sT = Physics.sTravelTime(distKm, opts.sourceDepthKm);
  const dur = Math.min(180, Math.max(opts.durationS || 0, sT + 70, 80));
  const NF = 1 << Math.ceil(Math.log2(sr * dur));
  const df = sr / NF;
  const seed = opts.seed || 20260901;
  const ramp = Physics.waveSRampDur(opts.mw);
  const lfMaxHz = opts.lfMaxHz || 2.0;

  // ---- LF: B1 SH kernel x Brune factor = acceleration FAS ---------------
  const m0 = Physics.seismicMoment(opts.mw);
  const M = dcMomentTensor(opts.strike, opts.dip, opts.rake, m0);
  const R = rotateHorizontal(M, az);
  const stress = opts.stressMPa || 3;
  // source-layer velocity/density for the source constants
  let betaKmS = 3.5, rhoGcm3 = 2.7;
  for (const lay of opts.stack) {
    if (lay.topKm <= opts.sourceDepthKm && opts.sourceDepthKm < (lay.bottomKm == null ? Infinity : lay.bottomKm)) {
      betaKmS = lay.vsKmS; rhoGcm3 = lay.rhoGcm3; break;
    }
  }
  const fcSrc = Physics.cornerFrequency(opts.mw, stress, betaKmS);
  const lfFreqs = [];
  for (let i = 1; i <= NF / 2 && i * df <= lfMaxHz; i++) lfFreqs.push(i * df);
  const lfSpec = core.shGreenSpectrum(opts.stack, {
    rKm: distKm, phiRad: 0, zSourceKm: opts.sourceDepthKm, zReceiverKm: 0,
    mxx: R.mxx, myy: R.myy, mxy: R.mxy,
    dkInvKm: opts.dkInvKm || 0.01, kMaxInvKm: opts.kMaxInvKm || 5, qShear: opts.qShear || 50
  }, lfFreqs);
  // phiRad folded into C2(phi): tensor already rotated into the receiver
  // frame, radiation factor at phi=0 is C2(0) = Mxy.
  const lfF = new Array(NF).fill(0).map(() => [0, 0]);
  for (let i = 0; i < lfFreqs.length; i++) {
    const w = 2 * Math.PI * lfFreqs[i];
    // acceleration fill: kernel * i*w*wc^2/(wc+i*w)^2; Riemann factor sr
    const den = [1, w / fcSrc];
    const fac = core.cdiv([0, w], core.cmul(den, den));
    const v = core.cscale(core.cmul(lfSpec.spectra[i], fac), sr);
    lfF[i + 1] = v;
    lfF[NF - i - 1] = [v[0], -v[1]];
  }
  // v3 CS repair (2026-09-04): optional empirical long-period gain on the LF
  // channel — the 1D SH kernel underestimates 2-4 s vs the GMPE the pipeline
  // targets (zhao embeds 3D/basin amplification the DW kernel lacks). The
  // gain is fitted OUTSIDE (cs-pipeline calibration, frozen) and applied as a
  // smooth frequency multiplier; absent option = byte-identical output.
  if (typeof opts.lfGainFn === 'function') {
    for (let i = 0; i < lfFreqs.length; i++) {
      const g = opts.lfGainFn(lfFreqs[i]);
      if (g === 1) continue;
      lfF[i + 1] = core.cscale(lfF[i + 1], g);
      lfF[NF - i - 1] = core.cscale(lfF[NF - i - 1], g);
    }
  }

  // ---- HF: absolute stochastic FAS ---------------------------------------
  const vs30 = opts.vs30 || 600;
  const site = opts.siteCurve ? 1 : (vs30 > 0 ? Math.min(4, Math.max(0.25, Math.pow(760 / vs30, 0.35))) : 1);
  const rho = opts.rhoKgM3 || rhoGcm3 * 1000;
  const rTheta = opts.rThetaPhi == null ? 0.55 : opts.rThetaPhi;
  const cB = booreSourceConstant(rho, betaKmS * 1000, rTheta, opts.freeSurfaceF);
  const hfCtx = {
    mw: opts.mw, distKm, stressMPa: stress, siteAmp: site, siteCurve: opts.siteCurve || null,
    Q0: opts.Q0 == null ? 200 : opts.Q0, eta: opts.eta == null ? 0.7 : opts.eta,
    kappaSec: opts.kappaSec == null ? 0.04 : opts.kappaSec, cB
  };

  // ---- crossover: smoothed-FAS geometric-mean ratio, bounded ------------
  const smLf = smoothedMagnitude(lfF, 4), smHf0 = smoothedMagnitude(buildHfSpectrum(NF, df, hfCtx, seed, 1), 4);
  let sLog = 0, nLog = 0;
  for (let i = 1; i < NF / 2; i++) {
    const f = i * df;
    if (f >= 0.7 * fcHz && f <= 1.3 * fcHz && smLf[i] > 0 && smHf0[i] > 0) {
      sLog += Math.log(smLf[i] / smHf0[i]); nLog++;
    }
  }
  // B2-beta: with BOTH sides independently absolute (LF = A1-anchored DW,
  // HF = ensemble-calibrated Boore), the crossover is a SEAM SMOOTHER, not a
  // level transfer — the B2-alpha full transfer (clamp [0.25,4]) silently
  // destroyed the HF calibration wherever the two site models disagreed
  // (measured hfScaleRaw 0.04 at a near-field basin station). Bounded to
  // [0.7, 1.4]; the raw ratio stays in meta as the seam-mismatch diagnostic.
  const clamp = opts.hfScaleClamp || [0.7, 1.4];
  let hfScale = nLog ? Math.exp(sLog / nLog) : 1;
  const hfScaleRaw = hfScale;
  hfScale = Math.min(clamp[1], Math.max(clamp[0], hfScale));
  const hfF = buildHfSpectrum(NF, df, hfCtx, seed, hfScale);

  // ---- v4 (2026-09-04): optional P-SV radial/vertical LF channels --------
  // opts.psv adds the deterministic LF radial/vertical from
  // tools/broadband/psv.js (R1-R6 anchored) on the FULL rotated double
  // couple, plus an HF vertical carrier (independent seed, half amplitude —
  // the registered V/H convention; the horizontal HF is untouched). Without
  // opts.psv the output is byte-identical to the SH-only pipeline.
  // opts.psvCache: Map shared across realizations of the same (site, source
  // depth) — the per-(k,omega) compliance solves are strike-independent.
  let psvRadialLf = null, psvVerticalLf = null, hfVertTime = null;
  if (opts.psv) {
    const cache = (opts.psvCache instanceof Map) ? opts.psvCache : new Map();
    const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);
    const radialF = new Array(NF).fill(0).map(() => [0, 0]);
    const verticalF = new Array(NF).fill(0).map(() => [0, 0]);
    for (let i = 0; i < lfFreqs.length; i++) {
      const fHz = lfFreqs[i];
      const spec = psv.psvMomentSpectrumAtFrequency(opts.stack, 2 * Math.PI * fHz, {
        rKm: distKm, zSourceKm: opts.sourceDepthKm,
        mxx: Mr.mxx, myy: Mr.myy, mzz: Mr.mzz, mxy: Mr.mxy, mxz: Mr.mxz, myz: Mr.myz,
        dkInvKm: opts.dkInvKm || 0.01, kMaxInvKm: opts.kMaxInvKm || 5,
        qShear: opts.qShear || 50, dhM: opts.psvDhM || 0.5, cache
      });
      const w = 2 * Math.PI * fHz;
      const den = [1, w / fcSrc];
      const fac = core.cdiv([0, w], core.cmul(den, den));
      const vr = core.cscale(core.cmul(spec.ur, fac), sr);
      const vz = core.cscale(core.cmul(spec.uz, fac), sr);
      radialF[i + 1] = vr; radialF[NF - i - 1] = [vr[0], -vr[1]];
      verticalF[i + 1] = vz; verticalF[NF - i - 1] = [vz[0], -vz[1]];
    }
    psvRadialLf = ifftReal(spectralFilter(radialF, 'lp', fcHz, df), NF);
    psvVerticalLf = ifftReal(spectralFilter(verticalF, 'lp', fcHz, df), NF);
    const hfVertF = buildHfSpectrum(NF, df, hfCtx, seed + 1, 0.5 * hfScale);
    hfVertTime = ifftReal(spectralFilter(hfVertF, 'hp', fcHz, df), NF);
  }

  // ---- filter + separate inverse FFTs (both sides already acceleration) --
  const lfFilt = spectralFilter(lfF, 'lp', fcHz, df);
  const hfFilt = spectralFilter(hfF, 'hp', fcHz, df);
  const lfTime = ifftReal(lfFilt, NF);
  const hfTime = ifftReal(hfFilt, NF);

  // ---- envelopes: HF gets the P/S window; LF only the causal pre-P cut ---
  const transverse = [];
  for (let i = 0; i < NF; i++) {
    const t = i / sr;
    const lf = t < pT ? 0 : lfTime[i];
    transverse.push(lf + hfTime[i] * envelopeAt(t, pT, sT, ramp));
  }
  const radial = [], vertical = [];
  for (let i = 0; i < NF; i++) {
    const t = i / sr;
    const env = envelopeAt(t, pT, sT, ramp);
    radial.push((psvRadialLf && t >= pT ? psvRadialLf[i] : 0) + hfTime[i] * env);
    if (hfVertTime) vertical.push((t >= pT ? psvVerticalLf[i] : 0) + hfVertTime[i] * env);
  }

  const bandLevel = (arr, f) => {
    const i = Math.round(f / df);
    return i > 0 && i < NF / 2 ? core.cabs(arr[i]) : null;
  };
  return {
    transverse, radial, vertical, sampleRateHz: sr, nSamples: NF, units: 'm/s^2',
    meta: {
      distKm, azimuthDeg: az, fcHz, sourceCornerHz: fcSrc, durationS: dur,
      pTravelS: pT, sTravelS: sT, hfScale, hfScaleRaw,
      betaKmS, rhoGcm3, cB, siteAmp: site,
      lfFas: { '0.2': bandLevel(lfF, 0.2), '0.5': bandLevel(lfF, 0.5), '1': bandLevel(lfF, 1.0) },
      hfFas: { '0.2': bandLevel(hfF, 0.2), '0.5': bandLevel(hfF, 0.5), '1': bandLevel(hfF, 1.0) },
      psv: !!opts.psv,
      lfOnly: opts.psv ? null : 'transverse',
      radialIsHfOnly: !opts.psv,
      note: opts.psv
        ? '3-component: SH + P-SV LF (R1-R6 anchored); vertical HF = independent-seed Boore at half amplitude'
        : 'SH-only LF (P-SV off); radial channel is HF-only and unusable beyond ~2 s'
    }
  };
}

/** Full-band absolute Brune/stochastic baseline (no deterministic LF side)
 *  — the B2-beta scorecard comparison arm. Same Boore calibration, same
 *  envelope; extends down to the first bin so the 2-10 s band is covered. */
function bruneBaselineSynthesis(opts) {
  const sr = opts.sampleRateHz || 20;
  const distKm = Physics.haversineDist(opts.sourceLat, opts.sourceLng, opts.receiverLat, opts.receiverLng);
  const pT = Physics.pTravelTime(distKm, opts.sourceDepthKm);
  const sT = Physics.sTravelTime(distKm, opts.sourceDepthKm);
  const dur = Math.min(180, Math.max(opts.durationS || 0, sT + 70, 80));
  const NF = 1 << Math.ceil(Math.log2(sr * dur));
  const df = sr / NF;
  const ramp = Physics.waveSRampDur(opts.mw);
  let betaKmS = 3.5, rhoGcm3 = 2.7;
  for (const lay of (opts.stack || [])) {
    if (lay.topKm <= opts.sourceDepthKm && opts.sourceDepthKm < (lay.bottomKm == null ? Infinity : lay.bottomKm)) {
      betaKmS = lay.vsKmS; rhoGcm3 = lay.rhoGcm3; break;
    }
  }
  const vs30 = opts.vs30 || 600;
  const site = opts.siteCurve ? 1 : (vs30 > 0 ? Math.min(4, Math.max(0.25, Math.pow(760 / vs30, 0.35))) : 1);
  const ctx = {
    mw: opts.mw, distKm, stressMPa: opts.stressMPa || 3, siteAmp: site, siteCurve: opts.siteCurve || null,
    Q0: opts.Q0 == null ? 200 : opts.Q0, eta: opts.eta == null ? 0.7 : opts.eta,
    kappaSec: opts.kappaSec == null ? 0.04 : opts.kappaSec,
    cB: booreSourceConstant(opts.rhoKgM3 || rhoGcm3 * 1000, betaKmS * 1000, opts.rThetaPhi == null ? 0.55 : opts.rThetaPhi, opts.freeSurfaceF)
  };
  const spec = buildHfSpectrum(NF, df, ctx, opts.seed || 20260901, 1);
  const time = ifftReal(spec, NF);
  const out = [];
  for (let i = 0; i < NF; i++) out.push(time[i] * envelopeAt(i / sr, pT, sT, ramp));
  return { transverse: out, sampleRateHz: sr, nSamples: NF, units: 'm/s^2', meta: { distKm, pTravelS: pT, sTravelS: sT } };
}

function envelopeAt(t, pT, sT, rampDur) {
  if (t < pT) return 0;
  if (t < sT) return 0.08;
  const dt = t - sT;
  if (dt < rampDur) return 0.08 + 0.92 * dt / rampDur;
  return Math.exp(-(dt - rampDur) / (2.5 * rampDur + 3));
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; const t2 = im[i]; im[i] = im[j]; im[j] = t2; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

/** JIVSM column (Physics.jivsmColumnAt) -> layered stack with the IASP91
 *  continuation and halfspace. B2-beta units fix (2026-09-01): decoded
 *  JIVSM rows carry rho in kg/m^3 (-> /1000 for g/cm^3, as the B1 recipe
 *  did), but Physics.densityFromVs returns g/cm^3 ALREADY — the B1
 *  jivsmCase divided its continuation/halfspace densities by 1000 again,
 *  making every layer below the JIVSM column 1000x too soft (mu), source
 *  depth included. Caught by the B2 absolute-calibration chain. */
function buildJivsmIaspStack(col) {
  const stack = [];
  let prevBottom = 0;
  for (const row of col) {
    const topKm = row.topM / 1000, bottomKm = row.bottomM / 1000;
    if (bottomKm <= topKm) continue;
    stack.push({ topKm: Math.max(0, topKm), bottomKm, vsKmS: row.vs / 1000, rhoGcm3: row.rho / 1000 });
    prevBottom = bottomKm;
  }
  for (const pair of [[prevBottom, 40], [40, 80], [80, 220], [220, 410]]) {
    const top = pair[0], bot = pair[1];
    if (bot <= prevBottom) continue;
    const vs = (Physics.iasp91SVelocity(top) + Physics.iasp91SVelocity(bot)) / 2;
    stack.push({ topKm: Math.max(prevBottom, top), bottomKm: bot, vsKmS: vs, rhoGcm3: Physics.densityFromVs(vs * 1000) });
  }
  stack.push({ topKm: 410, bottomKm: Infinity, vsKmS: Physics.iasp91SVelocity(450), rhoGcm3: Physics.densityFromVs(Physics.iasp91SVelocity(450) * 1000) });
  return stack;
}

/** Peak values of an acceleration series (m/s^2) -> {pga, pgv}
 *  (PGV by trapezoidal integration). */
function peakMotion(accel, sr) {
  let pga = 0;
  for (const a of accel) { const v = Math.abs(a); if (v > pga) pga = v; }
  let vel = 0, pgv = 0;
  for (let i = 1; i < accel.length; i++) {
    vel += 0.5 * (accel[i] + accel[i - 1]) / sr;
    const v = Math.abs(vel); if (v > pgv) pgv = v;
  }
  return { pga, pgv };
}

/** Rotate horizontal components (n, e arrays) to (radial, transverse). */
function rotateNE(nArr, eArr, azimuthDeg) {
  const a = azimuthDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const radial = [], transverse = [];
  for (let i = 0; i < nArr.length; i++) {
    radial.push(nArr[i] * ca + eArr[i] * sa);
    transverse.push(-nArr[i] * sa + eArr[i] * ca);
  }
  return { radial, transverse };
}

module.exports = {
  dcMomentTensor, rotateHorizontal, azimuthDeg, hybridSynthesis,
  bruneBaselineSynthesis, booreSourceConstant, hfAccelFAS, buildHfSpectrum,
  spectralFilter, smoothedMagnitude, ifftReal, rotateNE, envelopeAt, siteAmpAt,
  fftInPlace, peakMotion, buildJivsmIaspStack
};
