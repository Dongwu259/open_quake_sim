#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.1 B2-beta — ensemble calibration of the hybrid broadband model.
//
//  The pre-registered scorecard gates (tools/data/psha-source-model-report.json
//  preRegisteredB2, frozen 2026-09-01 before ANY B2 implementation run) pin
//  the METRICS but did not pin two model degrees of freedom: the Brune
//  stress drop and the site term. This tool calibrates them on the ENSEMBLE
//  MEDIAN of a non-gated diagnostic (observed transverse FAS ratios at
//  0.3/1/3 Hz) and freezes the choice to
//  tools/data/broadband-hybrid-calibration.json BEFORE the gated scorecard
//  runs. The procedure and both candidate values are recorded here so the
//  calibration cannot be silently re-tuned against the gates.
//
//  Site term: Physics.synthSiteProfile(vs30, bedrockDepthM) +
//  Physics.siteResponse1D (the project's own eqlin-1d machinery), strained
//  at the zhao2006 rock PGA per station. vs30 from the bundled J-SHIS grid,
//  bedrock depth from the bundled JIVSM grid.
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');

const ROOT = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const OUT = path.join(ROOT, 'tools', 'data', 'broadband-hybrid-calibration.json');
const CAL_FREQS = [0.3, 1, 3];
const STRESSES = [20, 30, 50, 80];
const KAPPAS = [0.02, 0.03, 0.04];

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function observedFAS(gal, sr, freqs) {
  const n = gal.length;
  const NF = 1 << Math.ceil(Math.log2(n));
  const re = new Array(NF).fill(0), im = new Array(NF).fill(0);
  let best = 0, bi = 0;
  for (let i = 0; i + 40 * sr <= n; i += Math.floor(5 * sr)) {
    let s = 0;
    for (let j = i; j < i + 40 * sr; j += 4) s += gal[j] * gal[j];
    if (s > best) { best = s; bi = i; }
  }
  const w0 = Math.max(0, bi - 5 * sr), w1 = Math.min(n, bi + 45 * sr), m = w1 - w0;
  for (let i = 0; i < m; i++) {
    const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (m - 1));
    re[i] = gal[w0 + i] * hann / 100; // gal -> m/s^2
  }
  hybrid.fftInPlace(re, im);
  const df = sr / NF;
  const out = {};
  for (const f of freqs) {
    const k = Math.round(f / df);
    let s = 0, c = 0;
    for (let j = k - 3; j <= k + 3; j++) {
      if (j > 0 && j < NF / 2) { s += Math.hypot(re[j], im[j]) / sr * 2 / 0.5; c++; }
    }
    out[f] = c ? s / c : null;
  }
  return out;
}

/** Site-amplification curve for one station (log-spaced 0.3-20 Hz). */
function siteCurve(vs30, bedrockDepthM, rockPgaGal) {
  if (!(vs30 > 0) || !(rockPgaGal > 0)) return null;
  const profile = Physics.synthSiteProfile(vs30, bedrockDepthM);
  if (!profile || profile.length < 2) return null;
  const freqs = [];
  for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
  const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: rockPgaGal / 980.665 });
  if (!res || !res.amp) return null;
  return { freqs, amps: res.amp.map((a) => Math.max(0.2, Math.min(8, a))), f0: res.f0 };
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const write = process.argv.includes('--write');
  const idx = loadJson(path.join(PKG_DIR, 'index.json'));
  const mechs = loadJson(path.join(ROOT, 'tools', 'data', 'broadband-event-mechanisms.json'));
  const vs30Grid = loadJson(path.join(ROOT, 'public', 'geojson', 'vs30.json'));
  const bedrockGrid = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-bedrock.json'));

  const events = [];
  for (const ev of idx.events) {
    const pkg = loadJson(path.join(PKG_DIR, ev.file));
    const e = pkg.event;
    const mech = mechs.events.find((m) => m.id === ev.id);
    if (!mech || !mech.mechanism) continue;
    const mw = mech.comcatMag, depth = mech.depthKm || 10, rake = mech.mechanism.rake;
    const rows = [];
    for (const rec of pkg.stations) {
      const st = rec.station;
      const distKm = Physics.haversineDist(e.lat, e.lng, st.lat, st.lng);
      if (distKm < 5 || distKm > 250) continue;
      const vs30 = Physics.lookupResearchGrid(vs30Grid, st.lat, st.lng) || 600;
      const bedrockM = Physics.lookupResearchGrid(bedrockGrid, st.lat, st.lng);
      // rock PGA for the equivalent-linear strain level: zhao2006 median
      const srcType = Physics.resolveSourceTypeAt(e.lat, e.lng, depth, null, null, distKm > 60);
      const rRup = Physics._pshaPointRrup(distKm, mw, srcType);
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRup, depth, vs30 || 600, rake);
      const curve = siteCurve(vs30, bedrockM, g ? g.median : 100);
      const az = hybrid.azimuthDeg(e.lat, e.lng, st.lat, st.lng);
      const rt = hybrid.rotateNE(rec.components.n.samples, rec.components.e.samples, az);
      const obs = observedFAS(rt.transverse, rec.sampleRateHz, CAL_FREQS);
      rows.push({ distKm, vs30, curve, obs });
    }
    events.push({ id: ev.id, mw, depth, rows });
    process.stdout.write(ev.id + ': ' + rows.length + ' stations  ');
  }
  console.log('');

  const scan = {};
  const best = { key: null, objective: Infinity };
  for (const stress of STRESSES) {
    for (const kappa of KAPPAS) {
      const key = stress + 'MPa_k' + kappa;
      scan[key] = { stressMPa: stress, kappaSec: kappa, perEvent: {}, ensemble: {} };
      const all = { 0.3: [], 1: [], 3: [] };
      for (const ev of events) {
        const logs = { 0.3: [], 1: [], 3: [] };
        for (const r of ev.rows) {
          const ctx = {
            mw: ev.mw, distKm: r.distKm, stressMPa: stress, siteCurve: r.curve,
            Q0: 200, eta: 0.7, kappaSec: kappa,
            cB: hybrid.booreSourceConstant(2650, 3500, 0.55) // +F=2 default inside
          };
          for (const f of CAL_FREQS) {
            const p = hybrid.hfAccelFAS(f, ctx);
            if (r.obs[f] > 0 && p > 0) logs[f].push(Math.log10(r.obs[f] / p));
          }
        }
        scan[key].perEvent[ev.id] = {};
        for (const f of CAL_FREQS) {
          const m = median(logs[f]);
          scan[key].perEvent[ev.id][f] = m == null ? null : +m.toFixed(3);
          if (m != null) all[f].push(m);
        }
      }
      for (const f of CAL_FREQS) scan[key].ensemble[f] = +median(all[f]).toFixed(3);
      scan[key].objective = +(CAL_FREQS.reduce((s, f) => s + Math.abs(scan[key].ensemble[f]), 0) / CAL_FREQS.length).toFixed(3);
      if (scan[key].objective < best.objective) { best.key = key; best.objective = scan[key].objective; }
    }
  }
  const chosen = scan[best.key];

  const report = {
    schema: 'quake-sim-broadband-hybrid-calibration-v1',
    generatedAt: new Date().toISOString(),
    procedure: 'ensemble median of log10(obsFAS/predFAS) on the transverse component at 0.3/1/3 Hz; '
      + 'objective = mean |median| over the three frequencies; stress chosen BEFORE the gated scorecard runs',
    calibrationFreqsHz: CAL_FREQS,
    stressCandidatesMPa: STRESSES,
    scan, chosenStressMPa: chosen.stressMPa, chosenKappaSec: chosen.kappaSec,
    siteTerm: 'synthSiteProfile(vs30 grid, jivsm bedrock grid) + siteResponse1D strained at the zhao2006 rock PGA, clip [0.2,8]',
    freeSurface: 'booreSourceConstant defaults to F=2 for the transverse SH channel (no partition loss)',
    note: 'preRegisteredB2 gates were frozen without pinning stressMPa or the site term; this calibration closes those two degrees of freedom and is itself frozen before any gated metric is computed'
  };
  const outStr = JSON.stringify(report, null, 2);
  fs.writeFileSync(OUT, outStr);
  console.log('chosen: stress', chosen.stressMPa, 'MPa, kappa', chosen.kappaSec, 's');
  for (const key of Object.keys(scan)) {
    const it = scan[key];
    console.log('  ' + key + ': medians ' + CAL_FREQS.map((f) => it.ensemble[f]).join('/') + '  |obj| ' + it.objective);
  }
  console.log('wrote ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
