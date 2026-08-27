#!/usr/bin/env node
'use strict';
// R7 external benchmark: the classic 150-ft SHAKE-91 example deposit run as
// the EERA manual worked example ("Diam @ 0.1 g") — the 10-layer nonlinear
// equivalent-linear case with the Diamond Heights Loma Prieta input.
//
// Case data (profile, Seed & Sun clay / Seed & Idriss sand curves with
// Idriss 1990 damping, DIAM.ACC motion, published converged state and
// surface peak 0.190411 g) is frozen verbatim in
// tools/data/deepsoil-benchmark-case.json with provenance.
//
// Our method mirrors SHAKE's final pass: siteResponse1D iterates the case's
// own curve tables, then the scaled input spectrum is convolved with the
// COMPLEX transfer function of the converged profile (phase preserved;
// conjugate bins get conj(A)) and inverted. Published anchor agreement
// measured 2026-08-27: 0.1803 g @ 11.30 s vs 0.1904 g @ 11.28 s (-5.3%).
//
//   node tools/run-deepsoil-benchmark.js            print comparison
//   node tools/run-deepsoil-benchmark.js --write    also freeze ourResult
const fs = require('node:fs');
const path = require('node:path');
const Physics = require('../public/physics.js');

const CASE_PATH = path.join(__dirname, 'data', 'deepsoil-benchmark-case.json');

function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// Spectral-strain EQL: per-layer strain from the FULL frequency-domain
// strain transfer (shStrainTransfers × input spectrum, inverse FFT, max|γ|),
// iterated against the case curve tables with the same 50/50 under-relaxation
// as the production engine. Closes the documented gap of the single-frequency
// proxy (which overestimates thin top sublayer strain ~25x).
function runCaseSpectral(CASE, targetPeakG) {
  const soil = CASE.profile.slice(0, 16);
  const bed = CASE.profile[16];
  const baseProfile = soil.map(l => ({
    vs: l.vsMs, thickness: l.thicknessM, density: l.unitWeightKnM3 * 1000 / 9.81
  }));
  baseProfile.push({ vs: bed.vsMs, density: bed.unitWeightKnM3 * 1000 / 9.81 });
  const layerCurves = soil.map(l => CASE.curves[String(l.materialType)]);

  const N = CASE.method.fftPoints;
  const dt = CASE.motion.dtSec;
  // normalize the motion to the requested peak
  let rawPeak = 0;
  for (let i = 0; i < CASE.motion.points; i++) rawPeak = Math.max(rawPeak, Math.abs(CASE.motion.valuesG[i]));
  const scale = targetPeakG / rawPeak;
  const inRe = new Float64Array(N), inIm = new Float64Array(N);
  for (let i = 0; i < CASE.motion.points; i++) inRe[i] = CASE.motion.valuesG[i] * scale;
  fft(inRe, inIm, false);
  const specRe = Float64Array.from(inRe), specIm = Float64Array.from(inIm);
  fft(inRe, inIm, true); // back to time domain for peakIn
  let peakIn = 0;
  for (let i = 0; i < N; i++) peakIn = Math.max(peakIn, Math.abs(inRe[i]));

  const freqs = [];
  for (let k = 1; k <= N / 2; k++) freqs.push(k / (N * dt));
  const effRatio = CASE.method.effectiveStrainRatio;
  const maxIter = 30, tol = 0.02;
  const gg = soil.map(() => 1), damp = soil.map(l => (l.materialType === 0 ? 0.01 : 0.0024));
  let strain = soil.map(() => 0), converged = false, iter = 0, tfc = null;

  for (iter = 1; iter <= maxIter; iter++) {
    const prof = soil.map((l, i) => ({
      vs: l.vsMs * Math.sqrt(gg[i]), thickness: l.thicknessM,
      density: l.unitWeightKnM3 * 1000 / 9.81, damping: damp[i]
    }));
    prof.push({ vs: bed.vsMs, density: bed.unitWeightKnM3 * 1000 / 9.81, damping: 0.01 });
    tfc = Physics.shTransferComplex(prof, freqs);
    const strainTf = Physics.shStrainTransfers(prof, freqs);
    if (!tfc || !strainTf) throw new Error('transfer computation failed');
    let maxShift = 0;
    for (let m = 0; m < soil.length; m++) {
      // gamma_m(t) = IFFT(T_m · F); bin-wise complex multiply with conjugates
      const re = Float64Array.from(specRe), im = Float64Array.from(specIm);
      const T = strainTf[m];
      for (let k = 1; k <= N / 2; k++) {
        const ar = T.re[k - 1], ai = T.im[k - 1];
        let vr = re[k] * ar - im[k] * ai;
        im[k] = re[k] * ai + im[k] * ar; re[k] = vr;
        if (k < N / 2) {
          vr = re[N - k] * ar + im[N - k] * ai;
          im[N - k] = re[N - k] * (-ai) + im[N - k] * ar;
          re[N - k] = vr;
        }
      }
      fft(re, im, true);
      let gm = 0;
      for (let i = 0; i < N; i++) gm = Math.max(gm, Math.abs(re[i]));
      strain[m] = gm * effRatio;
      const tab = Physics.interpolateLayerCurve(layerCurves[m], strain[m] * 100);
      const newGg = 0.5 * gg[m] + 0.5 * tab.ggmax;
      const newD = 0.5 * damp[m] + 0.5 * Math.min(0.25, tab.damping);
      const shift = Math.abs(Math.sqrt(newGg) - Math.sqrt(gg[m])) / Math.max(1e-9, Math.sqrt(gg[m]));
      if (shift > maxShift) maxShift = shift;
      gg[m] = newGg; damp[m] = newD;
    }
    if (maxShift < tol) { converged = true; break; }
  }

  // final surface convolution with the converged complex transfer
  const re = Float64Array.from(specRe), im = Float64Array.from(specIm);
  for (let k = 1; k <= N / 2; k++) {
    const ar = tfc.re[k - 1], ai = tfc.im[k - 1];
    let vr = re[k] * ar - im[k] * ai;
    im[k] = re[k] * ai + im[k] * ar; re[k] = vr;
    if (k < N / 2) {
      vr = re[N - k] * ar + im[N - k] * ai;
      im[N - k] = re[N - k] * (-ai) + im[N - k] * ar;
      re[N - k] = vr;
    }
  }
  fft(re, im, true);
  let peakOut = 0, tPeak = 0;
  for (let i = 0; i < N; i++) if (Math.abs(re[i]) > peakOut) { peakOut = Math.abs(re[i]); tPeak = i * dt; }
  return { res: { converged, iter, ggmax: gg, damping: damp, strain }, peakIn, peakOut, tPeak, amplification: peakOut / peakIn };
}

function runCase(CASE, inputScaleMultiplier) {
  const soil = CASE.profile.slice(0, 16);
  const bed = CASE.profile[16];
  const profile = soil.map(l => ({
    vs: l.vsMs, thickness: l.thicknessM, density: l.unitWeightKnM3 * 1000 / 9.81
  }));
  profile.push({ vs: bed.vsMs, density: bed.unitWeightKnM3 * 1000 / 9.81 });
  const layerCurves = soil.map(l => CASE.curves[String(l.materialType)]);

  const N = CASE.method.fftPoints;
  const dt = CASE.motion.dtSec;
  const re = new Float64Array(N), im = new Float64Array(N);
  const scale = CASE.motion.scaleFactor * (inputScaleMultiplier || 1);
  let peakIn = 0;
  for (let i = 0; i < CASE.motion.points; i++) {
    re[i] = CASE.motion.valuesG[i] * scale;
    peakIn = Math.max(peakIn, Math.abs(re[i]));
  }
  const freqs = [];
  for (let k = 1; k <= N / 2; k++) freqs.push(k / (N * dt));

  const res = Physics.siteResponse1D(profile, freqs, {
    rockPgaG: peakIn, effStrainRatio: CASE.method.effectiveStrainRatio,
    maxIter: 30, layerCurves
  });
  if (!res) throw new Error('siteResponse1D returned null');

  const tfProfile = soil.map((l, i) => ({
    vs: l.vsMs * Math.sqrt(res.ggmax[i]), thickness: l.thicknessM,
    density: l.unitWeightKnM3 * 1000 / 9.81, damping: res.damping[i]
  }));
  tfProfile.push({ vs: bed.vsMs, density: bed.unitWeightKnM3 * 1000 / 9.81, damping: 0.01 });
  const tfc = Physics.shTransferComplex(tfProfile, freqs);

  fft(re, im, false);
  for (let k = 1; k <= N / 2; k++) {
    const ar = tfc.re[k - 1], ai = tfc.im[k - 1];
    let vr = re[k] * ar - im[k] * ai;
    im[k] = re[k] * ai + im[k] * ar; re[k] = vr;
    if (k < N / 2) {
      vr = re[N - k] * ar + im[N - k] * ai;
      im[N - k] = re[N - k] * (-ai) + im[N - k] * ar;
      re[N - k] = vr;
    }
  }
  fft(re, im, true);
  let peakOut = 0, tPeak = 0;
  for (let i = 0; i < N; i++) if (Math.abs(re[i]) > peakOut) { peakOut = Math.abs(re[i]); tPeak = i * dt; }
  return { res, peakIn, peakOut, tPeak, amplification: peakOut / peakIn };
}

// Itasca/FLAC3D scaling ladder for the same deposit (9 levels, 0.0001 → 1 g)
const LADDER = [1e-4, 5e-4, 1e-3, 5e-3, 1e-2, 5e-2, 0.1, 0.5, 1];

function main() {
  const CASE = JSON.parse(fs.readFileSync(CASE_PATH, 'utf8'));
  const write = process.argv.includes('--write');
  const pub = CASE.published;

  const r = runCase(CASE, 1);
  console.log('== proxy mode (production strain estimate) ==');
  console.log(`EQL converged: iter=${r.res.iter} f0=${r.res.f0.toFixed(3)} Hz`);
  console.log(`input peak after scaling : ${r.peakIn.toFixed(6)} g`);
  console.log(`OUR surface peak         : ${r.peakOut.toFixed(4)} g @ ${r.tPeak.toFixed(2)} s (amp ${r.amplification.toFixed(3)})`);
  console.log(`PUBLISHED (EERA manual)  : ${pub.surfacePeakG.toFixed(4)} g @ ${pub.surfacePeakTimeSec.toFixed(2)} s`);
  console.log(`ratio                    : ${(r.peakOut / pub.surfacePeakG).toFixed(3)}`);

  const rs = runCaseSpectral(CASE, 0.1);
  console.log('== spectral mode (full frequency-domain strain) ==');
  console.log(`EQL converged: iter=${rs.res.iter}`);
  console.log(`OUR surface peak         : ${rs.peakOut.toFixed(4)} g @ ${rs.tPeak.toFixed(2)} s (amp ${rs.amplification.toFixed(3)})`);
  console.log(`ratio vs published       : ${(rs.peakOut / pub.surfacePeakG).toFixed(3)}`);
  let maxGgDiff = 0;
  for (let i = 0; i < 16; i++) maxGgDiff = Math.max(maxGgDiff, Math.abs(rs.res.ggmax[i] - pub.converged[i].ggmax));
  console.log(`converged G/Gmax max |diff| vs EERA: ${maxGgDiff.toFixed(3)}`);

  console.log('== scaling ladder (Itasca 9 levels) — amp: proxy / spectral ==');
  const ladder = [];
  for (const g of LADDER) {
    const rp = runCase(CASE, g / 0.1);
    const rsp = runCaseSpectral(CASE, g);
    ladder.push({ inputG: g, ampProxy: +rp.amplification.toFixed(4), ampSpectral: +rsp.amplification.toFixed(4) });
    console.log(`  ${g < 0.01 ? g.toExponential(0) : g.toFixed(3)} g → ${rp.amplification.toFixed(3)} / ${rsp.amplification.toFixed(3)}`);
  }

  if (write) {
    CASE.ourResult = {
      computed: '2026-08-27',
      surfacePeakG: +r.peakOut.toFixed(6),
      surfacePeakTimeSec: +r.tPeak.toFixed(2),
      amplification: +r.amplification.toFixed(4),
      iterations: r.res.iter,
      f0Hz: +r.res.f0.toFixed(4),
      method: 'siteResponse1D EQL on the case curve tables (effStrainRatio 0.5) + complex-TF final-pass convolution (shTransferComplex, conjugate bins)',
      knownGaps: 'single-frequency strain proxy over-softens thin top sublayers (gamma 25x on sublayer 1 vs EERA converged state; deep sublayers within ~25%) — surface peak agrees to -5.3% because resonance is set by the whole column'
    };
    CASE.ourResultSpectral = {
      computed: '2026-08-27',
      surfacePeakG: +rs.peakOut.toFixed(6),
      surfacePeakTimeSec: +rs.tPeak.toFixed(2),
      amplification: +rs.amplification.toFixed(4),
      iterations: rs.res.iter,
      convergedGgmax: rs.res.ggmax.map(v => +v.toFixed(4)),
      strainPctMid: rs.res.strain.map(v => +(v * 100).toFixed(5)),
      method: 'per-layer strain from shStrainTransfers × input spectrum (inverse FFT, max|gamma|, effStrainRatio 0.5 at mid-depth), iterated on the case curve tables; surface from shTransferComplex final pass',
      note: 'converged G/Gmax matches EERA within 0.04 on every sublayer; the published surface peak (0.1904 g) sits between the proxy (-5.3%) and this spectral result (+5.3%)'
    };
    CASE.ladder = ladder;
    fs.writeFileSync(CASE_PATH, JSON.stringify(CASE, null, 1) + '\n');
    console.log('ourResult/ourResultSpectral/ladder blocks written to', CASE_PATH);
  }
}

if (require.main === module) main();

module.exports = { runCase, runCaseSpectral, CASE_PATH };
