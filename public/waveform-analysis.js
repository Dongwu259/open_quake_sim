// =====================================================================
// WaveAnalysis — synthetic-waveform analysis engine (info-panel tool +
// report page). Pure functions, UMD (browser global `WaveAnalysis`,
// module.exports for node tests).
//
// Source waveform: Physics.synthesizeWaveform3C (deterministic — the
// default RNG seed is derived from Mw/dist), anchored to a physical PGA
// (gal) exactly like Physics.calcStochasticJmaIntensity: vector peak of
// the normalized carrier is scaled to the target PGA.
//
// Metrics (all standard, closed-form testable):
//   PGA (gal, per-component + vector), PGV (kine = cm/s, trapezoid
//   integration + linear detrend), PGD (cm, double integration + detrend),
//   Arias intensity Ia = π/(2g)∫a²dt (m/s), CAV = ∫|a|dt (gal·s, vector),
//   significant duration D5-95 (s), Fourier amplitude spectrum (Hann +
//   Goertzel at 96 log-spaced 0.1–20 Hz bins), dominant period (FAS peak
//   in 0.2–10 Hz), Brune corner frequency fc (ω⁻² two-segment log-space
//   least-squares fit).
//
// Magnitude estimates vs the input Mw:
//   magFromAmplitude — waveform-derived magnitude: bisection inversion of
//                    the trace's PGA through a forward PGA(M, R) relation
//                    (caller-supplied pgaForMw — production passes the app's
//                    own GMPE forward; classic log-attenuation fallback).
//                    Inverting a nonlinear attenuation at fixed distance is
//                    a real inversion, but it shares the model family with
//                    the amplitude anchor — labelled as model-relative
//                    consistency, NOT an external validation.
//   NOTE on spectral-shape magnitude: for M ≥ ~6.5 at σ=10 MPa the Brune
//   corner sits below the 0.1 Hz FAS grid floor, so the 0.1–20 Hz shape
//   carries essentially no magnitude information (any M fits after a free
//   scale) — an honest dead end, recorded here; the apparent corner and
//   theoretical corner stay as descriptive metrics only. momentFromCorner
//   remains exported as the reference algebraic inverse for other uses.
// =====================================================================
var WaveAnalysis = (function () {
  'use strict';

  var G_GAL = 980.665;        // standard gravity in gal
  var LEGACY_ATT = { a: 0.50, b: 1.20, k: 0.0055, c: 0.30 }; // classic textbook log model

  function finite(v) { return typeof v === 'number' && isFinite(v); }

  // ------------------------------------------------------------------
  //  SIGNAL UTILITIES
  // ------------------------------------------------------------------

  // Trapezoid integration + linear detrend (least-squares line removed) —
  // the standard simple baseline correction for double-integrated synthetics.
  function integrateDetrend(values, dt) {
    var n = values.length;
    if (!n || !(dt > 0)) return [];
    var out = new Array(n), acc = 0;
    out[0] = 0;
    for (var i = 1; i < n; i++) {
      acc += (values[i - 1] + values[i]) * 0.5 * dt;
      out[i] = acc;
    }
    // remove mean + linear trend (least squares on t)
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var j = 0; j < n; j++) {
      var tj = j * dt;
      sx += tj; sy += out[j]; sxx += tj * tj; sxy += tj * out[j];
    }
    var den = n * sxx - sx * sx;
    var slope = den !== 0 ? (n * sxy - sx * sy) / den : 0;
    var intercept = (sy - slope * sx) / n;
    for (var k = 0; k < n; k++) out[k] -= intercept + slope * (k * dt);
    return out;
  }

  // Goertzel amplitude at one frequency for one real series (Hann-windowed).
  // For a bin-centered sinusoid of amplitude A: |X| = A·Σw/2 → A = 2|X|/Σw.
  function goertzelAmp(values, dt, f) {
    var n = values.length;
    if (!n) return 0;
    var w = 2 * Math.PI * f * dt;
    var coeff = 2 * Math.cos(w);
    var s1 = 0, s2 = 0, u = 0, win, winSum = 0;
    for (var i = 0; i < n; i++) {
      win = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
      winSum += win;
      u = values[i] * win + coeff * s1 - s2;
      s2 = s1; s1 = u;
    }
    var re = s1 - s2 * Math.cos(w);
    var im = s2 * Math.sin(w);
    var amp2 = re * re + im * im;
    return winSum > 0 ? 2 * Math.sqrt(amp2) / winSum : 0;
  }

  // Fourier amplitude spectrum of the vector motion (SRSS of components),
  // 96 log-spaced bins over 0.1–20 Hz (same grid as the synthesizer).
  function fasVector(comps, dt) {
    var nFreq = 96, fMin = 0.1, fMax = 20;
    var out = [];
    for (var i = 0; i < nFreq; i++) {
      var f = Math.exp(Math.log(fMin) + (Math.log(fMax) - Math.log(fMin)) * i / (nFreq - 1));
      var sq = 0;
      for (var c = 0; c < comps.length; c++) {
        var a = goertzelAmp(comps[c], dt, f);
        sq += a * a;
      }
      out.push({ f: f, amp: Math.sqrt(sq) });
    }
    return out;
  }

  // Brune ω⁻² two-segment fit in log space: A(f) = A0 / (1+(f/fc)²).
  // Grid over candidate fc; optimal log A0 closed-form per candidate.
  function fitCorner(fas, fLo, fHi) {
    var pts = [];
    for (var i = 0; i < fas.length; i++) {
      if (fas[i].f >= fLo && fas[i].f <= fHi && fas[i].amp > 0) {
        pts.push({ lf: Math.log10(fas[i].f), la: Math.log10(fas[i].amp) });
      }
    }
    if (pts.length < 8) return null;
    var best = null;
    for (var gi = 0; gi <= 160; gi++) {
      var fc = Math.pow(10, Math.log10(fLo) + (Math.log10(fHi) - Math.log10(fLo)) * gi / 160);
      var lfc = Math.log10(fc);
      // log A0 = mean over points of (la + log10(1+(f/fc)²))  [LSQ intercept]
      var s = 0, model, resid, ss = 0;
      for (var p = 0; p < pts.length; p++) {
        model = pts[p].la + Math.log10(1 + Math.pow(10, 2 * (pts[p].lf - lfc)));
        s += model;
      }
      var la0 = s / pts.length;
      for (p = 0; p < pts.length; p++) {
        model = la0 - Math.log10(1 + Math.pow(10, 2 * (pts[p].lf - lfc)));
        resid = pts[p].la - model;
        ss += resid * resid;
      }
      if (!best || ss < best.ss) best = { fc: fc, logA0: la0, ss: ss };
    }
    best.rms = Math.sqrt(best.ss / pts.length);
    return best;
  }

  // ------------------------------------------------------------------
  //  MAGNITUDE ESTIMATES
  // ------------------------------------------------------------------

  // Exact algebraic inverse of Physics.cornerFrequency (Brune/Boore):
  //   fc = 4.9e6·β·(Δσ_bar/M0_dyne)^(1/3)  →  M0_dyne = Δσ_bar·(4.9e6·β/fc)³
  // (kept as a reference helper; the pipeline's magnitude estimate uses the
  // scale-free spectral-shape grid below because the observed FAS corner is
  // shifted by path Q attenuation and the time-envelope coloration)
  function momentFromCorner(fcHz, stressDropMPa, betaKmS, physics) {
    if (!(fcHz > 0)) return null;
    var P = physics;
    var dSigmaBar = Math.max(0.01, stressDropMPa || 10) * 10; // MPa → bar
    var beta = betaKmS || 3.5;
    var m0DyneCm = dSigmaBar * Math.pow(4.9e6 * beta / fcHz, 3);
    var m0Nm = m0DyneCm * 1e-7;
    var mw = P && P.momentMagnitude ? P.momentMagnitude(m0Nm)
      : (Math.log10(Math.max(m0Nm, 1)) - 9.1) / 1.5;
    return { m0Nm: m0Nm, mw: mw, stressDropBar: dSigmaBar, betaKmS: beta };
  }

  // Classic log attenuation fallback (independent second opinion when the
  // caller does not inject the app's own forward model):
  //   log10 PGA = a·M − b·log10 R − k·R + c   (PGA gal, R hypocentral km)
  function legacyPgaForMw(mw, distKm, att) {
    var A = att || LEGACY_ATT;
    return Math.pow(10, A.a * mw - A.b * Math.log10(Math.max(distKm, 1)) - A.k * distKm + A.c);
  }

  // Bisection inversion of a monotone forward PGA(M) relation
  function invertPgaToMw(targetPga, pgaForMw) {
    if (!(targetPga > 0)) return null;
    var lo = 3.0, hi = 9.8, fLo = pgaForMw(lo), fHi = pgaForMw(hi);
    if (!(fLo > 0) || !(fHi > 0)) return null;
    if (fLo > targetPga || fHi < targetPga) return null; // out of bracket
    for (var it = 0; it < 60; it++) {
      var mid = (lo + hi) / 2;
      var fMid = pgaForMw(mid);
      if (fMid < targetPga) lo = mid; else hi = mid;
    }
    return { mw: (lo + hi) / 2 };
  }

  // ------------------------------------------------------------------
  //  MAIN ENTRY
  // ------------------------------------------------------------------
  // opts: {
  //   physics (Physics ref, required),
  //   mw, distKm           — event magnitude + hypocentral distance (required)
  //   stressDropMPa        — assumed Δσ for the synthesizer AND the corner
  //                          inversion (default 10)
  //   siteAmp              — site amplification factor (default 1)
  //   targetPgaGal         — physical anchor for the trace (required > 0)
  //   sampleRate           — default 50
  //   seed                 — default derived from (mw, dist) — deterministic
  //   pgaForMw             — optional forward PGA(M) for the amplitude
  //                          inversion; defaults to the classic log model
  // }
  function analyze(opts) {
    var P = opts && opts.physics;
    if (!P || !P.synthesizeWaveform3C) return { ok: false, error: 'physics-required' };
    var mw = opts.mw, distKm = opts.distKm;
    var target = opts.targetPgaGal;
    if (!finite(mw) || !finite(distKm) || !(target > 0)) return { ok: false, error: 'bad-args' };
    var stressDropMPa = finite(opts.stressDropMPa) ? opts.stressDropMPa : 10;
    var siteAmp = finite(opts.siteAmp) ? opts.siteAmp : 1;
    var sampleRate = finite(opts.sampleRate) && opts.sampleRate >= 20 ? opts.sampleRate : 50;

    var wave = P.synthesizeWaveform3C(mw, distKm, stressDropMPa, siteAmp, null, sampleRate, opts.seed);
    if (!wave || !wave.x || !wave.x.length) return { ok: false, error: 'synthesis-failed' };
    var n = wave.x.length, dt = 1 / sampleRate;

    // anchor: vector peak → target PGA (gal); same convention as
    // Physics.calcStochasticJmaIntensity
    var vecPeak = 0, i;
    for (i = 0; i < n; i++) {
      var v = Math.sqrt(wave.x[i] * wave.x[i] + wave.y[i] * wave.y[i] + wave.z[i] * wave.z[i]);
      if (v > vecPeak) vecPeak = v;
    }
    if (!(vecPeak > 0)) return { ok: false, error: 'zero-carrier' };
    var scale = target / vecPeak;
    var ax = wave.x.map(function (v2) { return v2 * scale; });
    var ay = wave.y.map(function (v2) { return v2 * scale; });
    var az = wave.z.map(function (v2) { return v2 * scale; });

    // PGA (gal)
    var pga = { x: 0, y: 0, z: 0, vec: 0 };
    for (i = 0; i < n; i++) {
      var axx = Math.abs(ax[i]), ayy = Math.abs(ay[i]), azz = Math.abs(az[i]);
      if (axx > pga.x) pga.x = axx;
      if (ayy > pga.y) pga.y = ayy;
      if (azz > pga.z) pga.z = azz;
      var av = Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i] + az[i] * az[i]);
      if (av > pga.vec) pga.vec = av;
    }

    // velocity (cm/s) and displacement (cm) — integrate + linear detrend
    var vx = integrateDetrend(ax, dt), vy = integrateDetrend(ay, dt), vz = integrateDetrend(az, dt);
    var dx = integrateDetrend(vx, dt), dy = integrateDetrend(vy, dt), dz = integrateDetrend(vz, dt);
    var pgv = { vec: 0 }, pgd = { vec: 0 };
    for (i = 0; i < n; i++) {
      var vv = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
      if (vv > pgv.vec) pgv.vec = vv;
      var dv = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i]);
      if (dv > pgd.vec) pgd.vec = dv;
    }

    // Arias intensity (vector form, m/s), CAV (gal·s), D5-95 duration
    var ia = new Array(n), iaCum = 0, cav = 0;
    var kArias = Math.PI / (2 * G_GAL * 100); // a in m/s² = gal/100
    for (i = 0; i < n; i++) {
      var av2 = ax[i] * ax[i] + ay[i] * ay[i] + az[i] * az[i];
      iaCum += av2 * dt;
      ia[i] = kArias * iaCum;
      cav += Math.sqrt(av2) * dt;
    }
    var iaTotal = ia[n - 1];
    var t5 = null, t95 = null;
    for (i = 0; i < n; i++) {
      if (t5 === null && ia[i] >= 0.05 * iaTotal) t5 = i * dt;
      if (t95 === null && ia[i] >= 0.95 * iaTotal) t95 = i * dt;
    }
    var d5d95 = (t5 != null && t95 != null) ? (t95 - t5) : null;

    // energy-density proxy: ∫v²dt (cm²/s) — kinematic energy content index
    var energyV2 = 0;
    for (i = 0; i < n; i++) {
      energyV2 += (vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]) * dt;
    }

    // FAS + dominant period + apparent-corner fit
    var fas = fasVector([ax, ay, az], dt);
    var dom = null;
    for (i = 0; i < fas.length; i++) {
      if (fas[i].f >= 0.2 && fas[i].f <= 10 && (!dom || fas[i].amp > dom.amp)) dom = fas[i];
    }
    var fit = fitCorner(fas, 0.25, Math.min(20, sampleRate * 0.45));

    // amplitude inversion (anchor-consistency demonstration)
    var pgaForMw = (typeof opts.pgaForMw === 'function')
      ? opts.pgaForMw
      : function (m) { return legacyPgaForMw(m, distKm); };
    var ampInv = invertPgaToMw(target, pgaForMw);

    // decimated Z trace for report thumbnails (≤256 points, [t, gal] pairs)
    var step = Math.max(1, Math.ceil(n / 256));
    var trace = { dt: dt * step, z: [], pgaGal: target };
    for (i = 0; i < n; i += step) trace.z.push(+az[i].toFixed(2));

    return {
      ok: true,
      inputMw: mw,
      distKm: distKm,
      stressDropMPa: stressDropMPa,
      sampleRate: sampleRate,
      samples: n,
      durationS: +(n * dt).toFixed(1),
      pgaGal: { x: +pga.x.toFixed(1), y: +pga.y.toFixed(1), z: +pga.z.toFixed(1), vec: +pga.vec.toFixed(1) },
      pgvKine: +pgv.vec.toFixed(2),
      pgdCm: +pgd.vec.toFixed(2),
      ariasMs: +iaTotal.toPrecision(4),
      cavGalS: +cav.toFixed(1),
      d5d95S: d5d95 != null ? +d5d95.toFixed(1) : null,
      energyV2: +energyV2.toPrecision(4),
      dominantPeriodS: dom ? +(1 / dom.f).toFixed(3) : null,
      dominantFreqHz: dom ? +dom.f.toFixed(3) : null,
      apparentCornerHz: fit ? +fit.fc.toFixed(3) : null,
      cornerFitRms: fit ? +fit.rms.toPrecision(3) : null,
      theoreticalCornerHz: +(P.cornerFrequency(mw, stressDropMPa)).toPrecision(4),
      magFromAmplitude: ampInv ? +ampInv.mw.toFixed(2) : null,
      magFromAmplitudeModel: (typeof opts.pgaForMw === 'function') ? 'caller-forward' : 'legacy-log',
      trace: trace
    };
  }

  return {
    analyze: analyze,
    // pure helpers (exported for node tests)
    integrateDetrend: integrateDetrend,
    goertzelAmp: goertzelAmp,
    fitCorner: fitCorner,
    momentFromCorner: momentFromCorner,
    legacyPgaForMw: legacyPgaForMw,
    invertPgaToMw: invertPgaToMw,
    LEGACY_ATT: LEGACY_ATT
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WaveAnalysis;
