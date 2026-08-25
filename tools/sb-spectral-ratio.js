#!/usr/bin/env node
'use strict';
// ================================================================
//  R2 calibration: empirical surface/borehole spectral ratios from the
//  frozen KiK-net waveform pairs (public/geojson/strong-motion-waveforms,
//  station.borehole blocks) cross-checked against Physics.siteResponse1D
//  on the station's real PS-log profile.
//
//  Method (classic KiK-net S/B site-transfer estimate):
//    * per component pair, Hann-tapered record, radix-2 FFT (zero-padded)
//    * Konno–Ohmachi (b=40) smoothing on log-spaced bins 0.3–20 Hz
//    * horizontal ratio = geometric mean of N and E component ratios
//    * empirical f0 = argmax of the smoothed horizontal ratio
//  S/B ratios are DERIVED quantities (licensing matrix: distributable) —
//  the frozen per-station summary may be committed; raw waveforms stay
//  account-gated and gitignored.
//
//  Report: tools/data/sb-spectral-ratio-report.json
//  Calibration output: public/geojson/sb-spectral-ratio.json (committed —
//  per-station empirical f0 + band amplifications + ensemble model/empirical
//  correction factors for the runtime eqlin path; consumed next batch).
//
//  Usage: node tools/sb-spectral-ratio.js [--summary]
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, 'public/geojson/strong-motion-waveforms');
const LOGS_PATH = path.join(ROOT, '.cache/kiknet-logs/kiknet-ps-logs.json');
const OUT_REPORT = path.join(ROOT, 'tools/data/sb-spectral-ratio-report.json');
const OUT_CAL = path.join(ROOT, 'public/geojson/sb-spectral-ratio.json');

// ---- spectral machinery -----------------------------------------------------
function fftRadix2(reIn, imIn) {
  const n = reIn.length;
  if (n & (n - 1)) throw new Error('fft: non-power-of-2');
  const re = reIn.slice(), im = imIn ? imIn.slice() : new Array(n).fill(0);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
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
  return { re, im };
}

function amplitudeSpectrum(samples, srcHz) {
  let n = 1;
  while (n < samples.length) n <<= 1;
  const re = new Array(n).fill(0), im = new Array(n).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1)); // Hann
    re[i] = samples[i] * w;
  }
  const F = fftRadix2(re, im);
  const nBins = Math.floor(n / 2);
  const amp = new Array(nBins);
  for (let k = 0; k < nBins; k++) amp[k] = Math.hypot(F.re[k], F.im[k]);
  return { amp, df: srcHz / n };
}

// Konno–Ohmachi smoothing over a log-spaced output grid
function konnoOhmachi(amp, df, outFreqs, b = 40) {
  const out = new Array(outFreqs.length).fill(0);
  const wSum = new Array(outFreqs.length).fill(0);
  for (let k = 0; k < amp.length; k++) {
    const f = k * df;
    if (f <= 0 || f > 25) continue;
    for (let j = 0; j < outFreqs.length; j++) {
      const x = b * Math.log10(f / outFreqs[j]);
      if (Math.abs(x) > b * 0.6) continue; // kernel support cut
      const w = Math.abs(x) < 1e-8 ? 1 : Math.pow(Math.sin(x) / x, 4);
      out[j] += w * amp[k]; wSum[j] += w;
    }
  }
  return out.map((v, j) => wSum[j] > 0 ? v / wSum[j] : 0);
}

function logGrid() {
  const f = [];
  for (let i = 0; i < 60; i++) f.push(0.3 * Math.pow(20 / 0.3, i / 59));
  return f;
}

// ---- main -------------------------------------------------------------------
function compute() {
  const freqs = logGrid();
  const idx = JSON.parse(fs.readFileSync(path.join(WF_DIR, 'index.json'), 'utf8'));
  let logs = null;
  try { logs = JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8')); } catch (e) { /* optional */ }
  const profiles = logs ? new Map(logs.stations.map(s => [s.code, s.rows])) : new Map();

  const perStation = new Map(); // code -> {ratios: [...arrays], events, lat, lng}
  for (const ev of idx.events) {
    const pkg = JSON.parse(fs.readFileSync(path.join(WF_DIR, ev.file), 'utf8'));
    for (const st of pkg.stations) {
      if (!st.borehole || !st.components || !st.station) continue;
      const hz = st.sampleRateHz || 20;
      const key = st.station.id;
      const horiz = [];
      for (const comp of ['n', 'e']) {
        const s = st.components[comp], b = st.borehole[comp];
        if (!s || !b || !s.samples || s.samples.length < 600) continue;
        const sA = amplitudeSpectrum(s.samples, hz);
        const bA = amplitudeSpectrum(b.samples, hz);
        const rs = konnoOhmachi(sA.amp, sA.df, freqs);
        const rb = konnoOhmachi(bA.amp, bA.df, freqs);
        const ratio = freqs.map((f, j) => (rb[j] > 1e-9 ? rs[j] / rb[j] : null));
        horiz.push(ratio);
      }
      if (horiz.length < 2) continue;
      // geometric mean of N and E ratios (null-safe)
      const gm = freqs.map((f, j) => {
        const vals = horiz.map(h => h[j]).filter(v => v != null && isFinite(v) && v > 0);
        if (!vals.length) return null;
        return Math.exp(vals.reduce((s, v) => s + Math.log(v), 0) / vals.length);
      });
      if (!perStation.has(key)) perStation.set(key, { code: key, ratios: [], events: 0, lat: st.station.lat, lng: st.station.lng });
      const rec = perStation.get(key);
      rec.ratios.push(gm); rec.events++;
    }
  }

  const stations = [];
  const medCurves = new Map(); // code -> station-median ratio curve (nulls kept, freq-aligned)
  let f0Pairs = []; // {empirical, model}
  for (const rec of perStation.values()) {
    // station-median ratio across events — nulls stay IN PLACE so curve
    // indices keep matching the freq grid (a .filter() here used to shift
    // every later index whenever a single bin was uncovered)
    const med = freqs.map((f, j) => {
      const vals = rec.ratios.map(r => r[j]).filter(v => v != null && isFinite(v) && v > 0);
      if (!vals.length) return null;
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)];
    });
    const coverage = med.filter(v => v != null).length;
    if (coverage < freqs.length * 0.9) continue;
    let f0 = freqs[0], peak = 0;
    for (let j = 0; j < freqs.length; j++) {
      if (med[j] != null && freqs[j] >= 0.3 && freqs[j] <= 10 && med[j] > peak) { peak = med[j]; f0 = freqs[j]; }
    }
    const band = f => {
      let s = 0, n = 0;
      for (let j = 0; j < freqs.length; j++) if (med[j] != null && freqs[j] >= f[0] && freqs[j] <= f[1]) { s += Math.log(med[j]); n++; }
      return n ? Math.exp(s / n) : null;
    };
    const entry = {
      code: rec.code, lat: rec.lat, lng: rec.lng, events: rec.events,
      f0Hz: +f0.toFixed(3), peakAmp: +peak.toFixed(3),
      ampPgaBand: band([5, 10]), ampPgvBand: band([0.7, 2])
    };
    // model comparison on the real profile
    const rows = profiles.get(rec.code);
    if (rows) {
      const prof = Physics.psLogToProfile(rows);
      if (prof) {
        const res = Physics.siteResponse1D(prof, freqs, { rockPgaG: 0.05 });
        if (res && res.amp) {
          let mf0 = freqs[0], mpk = 0;
          for (let j = 0; j < freqs.length; j++) if (freqs[j] >= 0.3 && freqs[j] <= 10 && res.amp[j] > mpk) { mpk = res.amp[j]; mf0 = freqs[j]; }
          entry.modelF0Hz = +mf0.toFixed(3);
          f0Pairs.push({ empirical: f0, model: mf0 });
        }
      }
    }
    stations.push(entry);
    medCurves.set(rec.code, med);
  }

  // ensemble: median empirical/model amplification ratio per band — the
  // runtime correction candidates for the synthesized-profile path
  const withModel = stations.filter(s => s.modelF0Hz != null);
  const med = arr => { const v = arr.slice().sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const ensemble = {
    stations: stations.length, stationsWithModel: withModel.length,
    f0Agreement: (() => {
      if (!f0Pairs.length) return null;
      const logDiff = f0Pairs.map(p => Math.abs(Math.log(p.empirical / p.model)));
      const withinHalfOctave = f0Pairs.filter(p => Math.abs(Math.log(p.empirical / p.model)) <= Math.log(2) / 2).length;
      return {
        medianLogDiff: +med(logDiff).toFixed(3),
        withinHalfOctavePct: +(100 * withinHalfOctave / f0Pairs.length).toFixed(1),
        n: f0Pairs.length
      };
    })(),
    empiricalAmpMedian: {
      pgaBand: med(stations.map(s => s.ampPgaBand).filter(Boolean)),
      pgvBand: med(stations.map(s => s.ampPgvBand).filter(Boolean))
    }
  };

  // Empirical f0(Vs30) prior — log10(f0) = a + b·log10(Vs30) over the S/B
  // stations with a PS-log travel-time Vs30. This is the anchor-invariant
  // quantity the runtime synth-profile correction consumes (2026-08-25 A/B:
  // blending the ratio CURVES/levels toward the borehole-referenced bins
  // shifted intensity bias +0.42 and worsened RMS — the borehole reference
  // mixes the target-site amplification with the borehole-site response, so
  // amplitudes do not transfer; a resonance FREQUENCY does). The fit puts
  // the real resonant column at ~19-48 m for Vs30 150-900, far shallower
  // than the JIVSM engineering-bedrock depth.
  const f0Pts = [];
  for (const s of stations) {
    const rows = profiles.get(s.code);
    if (!rows) continue;
    let tt = 0, H = 0;
    for (const r of rows) { tt += (r.to - r.from) / r.vs; H += r.to - r.from; }
    if (H > 0 && tt > 0) f0Pts.push([H / tt, s.f0Hz]);
  }
  if (f0Pts.length >= 30) {
    const n = f0Pts.length;
    const xm = f0Pts.reduce((t, p) => t + Math.log10(p[0]), 0) / n;
    const ym = f0Pts.reduce((t, p) => t + Math.log10(p[1]), 0) / n;
    let num = 0, den = 0;
    for (const p of f0Pts) {
      const dx = Math.log10(p[0]) - xm, dy = Math.log10(p[1]) - ym;
      num += dx * dy; den += dx * dx;
    }
    if (den > 0) {
      const b = num / den, a = ym - b * xm;
      const resid = f0Pts.map(p => a + b * Math.log10(p[0]) - Math.log10(p[1]));
      const std = Math.sqrt(resid.reduce((t, v) => t + v * v, 0) / n);
      ensemble.f0Vs30Fit = { a: +a.toFixed(4), b: +b.toFixed(4), residLogStd: +std.toFixed(4), n };
    }
  }

  // f0-binned ensemble median ratio curves — calibration reference data
  // (shape/dispersion diagnostics). The runtime correction consumes
  // f0Vs30Fit above, NOT these amplitude curves — see the anchor note there.
  // Bin edges cover the observed empirical-f0 range 0.32-9.8 Hz; thin bins
  // (<10 members) are dropped rather than merged to keep each curve honest.
  const BIN_EDGES = [0.3, 1.2, 2.4, 4.8, 12];
  const bins = [];
  for (let b = 0; b < BIN_EDGES.length - 1; b++) {
    const members = stations.filter(s => s.f0Hz >= BIN_EDGES[b] && s.f0Hz < BIN_EDGES[b + 1]);
    if (members.length < 10) continue;
    let ratio = freqs.map((f, j) => {
      const vals = members.map(s => medCurves.get(s.code)[j]).filter(v => v != null && isFinite(v) && v > 0);
      if (!vals.length) return null;
      vals.sort((x, y) => x - y);
      return vals[Math.floor(vals.length / 2)];
    });
    // residual single-bin gaps: log-linear fill from the nearest covered bin
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < ratio.length; j++) {
        if (ratio[j] != null) continue;
        const prev = [...ratio.slice(0, j)].reverse().find(v => v != null);
        const next = ratio.slice(j + 1).find(v => v != null);
        ratio[j] = prev != null && next != null ? Math.sqrt(prev * next) : (prev != null ? prev : next);
      }
    }
    if (ratio.some(v => v == null)) continue;
    bins.push({
      f0Min: BIN_EDGES[b], f0Max: BIN_EDGES[b + 1], n: members.length,
      freqs: freqs.map(f => +f.toFixed(4)),
      medRatio: ratio.map(v => +v.toFixed(4))
    });
  }
  ensemble.bins = bins;

  const report = {
    meta: {
      generatedBy: 'tools/sb-spectral-ratio.js',
      method: 'Hann + radix-2 FFT + Konno-Ohmachi b=40; horizontal = geomean(N,E); S/B station median across events',
      freqGridHz: [0.3, 20], freqBins: freqs.length,
      data: 'frozen waveform packages station.borehole (account-gated, gitignored); ratios are derived quantities'
    },
    ensemble, stations
  };
  fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
  fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 1));

  // committed calibration summary (derived data — distributable)
  const cal = {
    schema: 'quake-sim-sb-spectral-ratio-v1',
    meta: {
      ...report.meta,
      provenance: 'NIED K-NET/KiK-net waveforms (DOI 10.17598/NIED.0004); surface/borehole spectral ratios are derived quantities per the NIED terms',
      stations: stations.length
    },
    ensemble,
    stations: stations.map(s => ({
      code: s.code, lat: s.lat, lng: s.lng, f0Hz: s.f0Hz, peakAmp: s.peakAmp,
      ampPgaBand: s.ampPgaBand ? +s.ampPgaBand.toFixed(3) : null,
      ampPgvBand: s.ampPgvBand ? +s.ampPgvBand.toFixed(3) : null,
      modelF0Hz: s.modelF0Hz != null ? s.modelF0Hz : null
    }))
  };
  fs.writeFileSync(OUT_CAL, JSON.stringify(cal));

  if (process.argv.includes('--summary')) {
    console.log('stations with S/B pairs:', stations.length, '| with model f0:', withModel.length);
    console.log('f0 agreement:', JSON.stringify(ensemble.f0Agreement));
    console.log('empirical amp medians:', JSON.stringify(ensemble.empiricalAmpMedian));
    console.log('f0 bins:', JSON.stringify(ensemble.bins.map(b => [b.f0Min, b.f0Max, b.n])));
  }
  console.log('report ->', OUT_REPORT);
  console.log('calibration ->', OUT_CAL);
  return report;
}

if (require.main === module) compute();
module.exports = { compute, amplitudeSpectrum, konnoOhmachi };
