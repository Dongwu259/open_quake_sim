#!/usr/bin/env node
'use strict';
// =====================================================================
//  sh-alias-exposure.js — SH-kernel long-range Bessel-aliasing exposure
//  report (2026-09-06). Freezes to tools/data/sh-alias-exposure.json.
//
//  Background: the B1 SH discrete-wavenumber kernel sampled the
//  J2(k r)-weighted integral with the fixed production dkInvKm=0.01/km,
//  which resolves the J oscillation (period 2*pi/r) only out to ~63 km.
//  69% of the frozen 13-event Kyoshin scorecard paths lie beyond that,
//  median 88 km — the long-range LF numbers were grid-lucky. The kernel
//  now floors dk at (2*pi/r)/10 (core.shSpectrumAtFrequency, identical
//  output for r < 63 km); this report quantifies the exposure that
//  motivated the guard and verifies the guard against a 4x-refined grid.
//
//  The "fixed-dk (pre-guard)" arm below reimplements the plain sum
//  locally with the requested step — the production code has no
//  pre-guard escape hatch by design.
// =====================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const core = require('./core.js');
const hybrid = require('./hybrid.js');

const OUT = path.join(ROOT, 'tools', 'data', 'sh-alias-exposure.json');
const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const PROD_DK = 0.01, KMAX = 5, GUARD_DIV = 10;
const FREQS = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0];

function main() {
  const write = process.argv.includes('--write');
  Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
  const idx = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'index.json'), 'utf8'));
  const mechs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'broadband-event-mechanisms.json'), 'utf8'));

  // ---- 1. distance distribution over all scored paths -------------------
  const dists = [];
  const perEvent = [];
  for (const ev of idx.events) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, ev.file), 'utf8'));
    const e = pkg.event;
    const d = [];
    for (const rec of pkg.stations) {
      const st = rec.station;
      if (!rec.components || !rec.components.n || !rec.components.n.samples) continue;
      const dist = Physics.haversineDist(e.lat, e.lng, st.lat, st.lng);
      if (dist < 5 || dist > 250) continue;
      d.push(dist);
      dists.push(dist);
    }
    perEvent.push({ id: ev.id, stations: d.length, medianKm: d.length ? +d.slice().sort((a, b) => a - b)[Math.floor(d.length / 2)].toFixed(0) : null });
  }
  dists.sort((a, b) => a - b);
  const q = (p) => +dists[Math.min(dists.length - 1, Math.floor(dists.length * p))].toFixed(0);
  const rSafe = +(2 * Math.PI / (GUARD_DIV * PROD_DK)).toFixed(1);
  const beyond = dists.filter((x) => x > rSafe).length;

  // ---- 2. per-point exposure: fixed-dk vs guarded vs 4x-refined ---------
  // deterministic subset: 3 stations per event (5/50/95th percentile of the
  // distance list), every 7th pair kept, 8 scored-band LF frequencies
  function specAt(p, fHz, dkInvKm) {
    const col = Physics.jivsmColumnAt(p.lat, p.lng);
    if (!col) return null;
    const stack = hybrid.buildJivsmIaspStack(col);
    const mech = mechs.events.find((m) => m.id === p.ev);
    const m = mech.mechanism;
    const az = hybrid.azimuthDeg(p.slat, p.slng, p.lat, p.lng);
    const M = hybrid.dcMomentTensor(m.strike, m.dip, m.rake, 1e17);
    const R = hybrid.rotateHorizontal(M, az);
    const depth = mech.depthKm || 10;
    const out = core.shGreenSpectrum(stack, {
      rKm: p.d, phiRad: 0, zSourceKm: depth, zReceiverKm: 0,
      mxx: R.mxx, myy: R.myy, mxy: R.mxy,
      dkInvKm, kMaxInvKm: KMAX, qShear: 50
    }, [fHz]);
    return Math.hypot(out.spectra[0][0], out.spectra[0][1]);
  }
  function fixedSum(p, fHz, dkInvKm) {
    // pre-guard plain sum: identical to the kernel loop but WITHOUT the
    // adaptive floor (local reimplementation, no production escape hatch)
    const col = Physics.jivsmColumnAt(p.lat, p.lng);
    if (!col) return null;
    const stack = hybrid.buildJivsmIaspStack(col);
    const mech = mechs.events.find((m) => m.id === p.ev);
    const m = mech.mechanism;
    const az = hybrid.azimuthDeg(p.slat, p.slng, p.lat, p.lng);
    const M = hybrid.dcMomentTensor(m.strike, m.dip, m.rake, 1e17);
    const R = hybrid.rotateHorizontal(M, az);
    const rM = p.d * 1000, depth = mech.depthKm || 10;
    const dk = dkInvKm / 1000;
    let sum = [0, 0];
    for (let k = dk; k <= KMAX / 1000 + 1e-15; k += dk) {
      const j2 = core.besselJ(2, k * rM);
      if (Math.abs(j2) < 1e-14) continue;
      const dTau = core.shSourceJump(R.mxx, R.myy, R.mxy, k, 0);
      const Y = core.shUnitJumpResponse(stack, 2 * Math.PI * fHz, k, depth, 0, { qShear: 50 });
      if (!Y || !isFinite(Y[0]) || !isFinite(Y[1])) continue;
      sum = core.cadd(sum, core.cmul(core.cmul(dTau, Y), [k * dk * j2, 0]));
    }
    return Math.hypot(sum[0], sum[1]) / (2 * Math.PI);
  }
  const paths = [];
  for (const ev of idx.events) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, ev.file), 'utf8'));
    const e = pkg.event;
    const cand = [];
    for (const rec of pkg.stations) {
      const st = rec.station;
      if (!rec.components || !rec.components.n || !rec.components.n.samples) continue;
      const dist = Physics.haversineDist(e.lat, e.lng, st.lat, st.lng);
      if (dist < 5 || dist > 250) continue;
      cand.push({ d: dist, st });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const frac of [0.05, 0.5, 0.95]) {
      const c = cand[Math.min(cand.length - 1, Math.floor(cand.length * frac))];
      if (c) paths.push({ ev: ev.id, d: c.d, lat: c.st.lat, lng: c.st.lng, slat: e.lat, slng: e.lng });
    }
  }
  const picked = paths.filter((p, i) => i % 7 === 0);
  const rows = [];
  for (const p of picked) {
    const dkAdaptive = Math.min(PROD_DK, 2 * Math.PI / (p.d * 1000) / GUARD_DIV);
    const dkFine = dkAdaptive / 4;
    for (const fHz of FREQS) {
      const fixed = fixedSum(p, fHz, PROD_DK);
      const guarded = specAt(p, fHz, PROD_DK); // kernel now floors adaptively
      const fine = specAt(p, fHz, dkFine);
      if (!fixed || !guarded || !fine) continue;
      rows.push({ ev: p.ev, distKm: +p.d.toFixed(0), fHz,
        fixedVsFine: +(fixed / fine).toFixed(3), guardedVsFine: +(guarded / fine).toFixed(3) });
    }
  }
  const stats = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const pk = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3);
    return { n: s.length, median: pk(0.5), p90: pk(0.9), max: pk(1) };
  };
  const far = rows.filter((r2) => r2.distKm > rSafe);
  const exposure = {
    sampledPoints: rows.length,
    fixedVsFine_all: stats(rows.map((r2) => Math.abs(r2.fixedVsFine - 1))),
    fixedVsFine_farOnly: stats(far.map((r2) => Math.abs(r2.fixedVsFine - 1))),
    guardedVsFine_all: stats(rows.map((r2) => Math.abs(r2.guardedVsFine - 1))),
    worstFixedPoints: rows.filter((r2) => Math.abs(r2.fixedVsFine - 1) > 0.1)
      .sort((a, b) => Math.abs(b.fixedVsFine - 1) - Math.abs(a.fixedVsFine - 1)).slice(0, 12)
  };

  const report = {
    schema: 'quake-sim-sh-alias-exposure-v1',
    generatedAt: new Date().toISOString(),
    kernel: 'tools/broadband/core.js shSpectrumAtFrequency (B1 SH discrete wavenumber, production dkInvKm=0.01/km, kMaxInvKm=5, qShear=50)',
    guard: {
      rule: 'dk = min(dkInvKm, (2*pi/r)/10)',
      aliasSafeRangeKm: rSafe,
      note: 'byte-identical output for r < ' + rSafe + ' km; long-range LF grids refine by up to 4x at 250 km',
      date: '2026-09-06'
    },
    distanceDistribution: {
      scoredPaths: dists.length,
      min: q(0), p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: q(1),
      beyondAliasSafe: beyond,
      beyondFraction: +(beyond / dists.length).toFixed(3),
      perEvent
    },
    perPointExposure: exposure,
    reading: 'The pre-guard fixed grid mis-sampled the J2 oscillation on the majority of scored paths (the long-range LF numbers were grid-lucky): point-level ratios vs a 4x-refined grid swung up to ~3x at 90-180 km. The guard removes that component (worst points improve: 3.08->1.71, 2.42->0.96, 2.05->0.67) but the residual O(1) far-range swings (max |ratio-1| ~0.8 vs the refined grid) are the UNCOVERED Love-pole grid luck: the kernel has no modal pole windows, so the narrow resonant peaks are still sampled at whatever the grid catches — exactly the disease the P-SV layered-roots batch cured on its side (tools/broadband/psv.js v6). Registered as the follow-up, not closed by this batch.',
    verdict: 'guard_landed_exposure_quantified',
    registeredFollowUp: 'the re-frozen Kyoshin scorecard (tools/data/broadband-scorecard.json, same date) carries the guard; band-metric deltas vs the previous freeze are the recalibration record — the SH kernel still has NO Love-mode pole windows (the plain sum samples narrow modal peaks at grid luck); that exposure is inherited from the B1 design and is NOT covered by the alias guard',
    history: {
      preGuardScorecard: 'the 2026-09-05 freeze of tools/data/broadband-scorecard.json was produced by the fixed-grid kernel; it remains in git history as the pre-guard measurement'
    }
  };
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ distanceDistribution: report.distanceDistribution, perPointExposure: exposure }, null, 1));
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
