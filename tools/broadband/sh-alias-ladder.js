#!/usr/bin/env node
'use strict';
// =====================================================================
//  sh-alias-ladder.js — guard-divisor convergence ladder (2026-09-09,
//  the v2 registered cure: "tighten the range-adaptive divisor").
//
//  Same path set and frequencies as sh-alias-exposure.js; for each
//  divisor D in {10, 20, 40} the guarded production spectrum is compared
//  against a 16x-refined reference (guardDiv 160), plus a 320-divisor
//  arm bounding the reference's own convergence. Pre-registered decision
//  rule: ship the smallest D with far-only max |ratio-1| <= 0.10, given
//  reference self-stability p95 <= 0.02; if none qualifies, keep 10 and
//  register compliance-scale k-stepping as the next cure.
//
//  One-time measurement; the outcome freezes into
//  tools/data/sh-alias-exposure.json (v3). Uses the account-gated
//  Kyoshin waveform packages (local download, not committed).
// =====================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const core = require('./core.js');
const hybrid = require('./hybrid.js');

const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const PROD_DK = 0.01, KMAX = 5;
const FREQS = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0];
const LADDER = [10, 20, 40, 80];
const REF_DIV = 160, REF2_DIV = 320;

function main() {
  Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
  const idx = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'index.json'), 'utf8'));
  const mechs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'broadband-event-mechanisms.json'), 'utf8'));

  // identical path selection to sh-alias-exposure.js
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

  function specAt(p, fHz, guardDiv, dkScale) {
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
      dkInvKm: PROD_DK / dkScale, kMaxInvKm: KMAX, qShear: 50, guardDiv
    }, [fHz]);
    return Math.hypot(out.spectra[0][0], out.spectra[0][1]);
  }

  const rSafe10 = 2 * Math.PI / (10 * PROD_DK); // 62.8 km — the v2 far boundary
  const rows = [];
  for (const p of picked) {
    for (const fHz of FREQS) {
      const ref = specAt(p, fHz, REF_DIV, 1);
      const ref2 = specAt(p, fHz, REF2_DIV, 1);
      if (!ref || !ref2) continue;
      const row = { ev: p.ev, distKm: +p.d.toFixed(0), fHz,
        refStability: +Math.abs(ref2 / ref - 1).toFixed(4) };
      for (const D of LADDER) {
        const g = specAt(p, fHz, D, 1);
        if (g) row['g' + D + 'VsRef'] = +(g / ref - 1).toFixed(4);
      }
      rows.push(row);
    }
  }
  const far = rows.filter((r2) => r2.distKm > rSafe10);
  const stats = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const pk = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(4);
    return { n: s.length, median: pk(0.5), p90: pk(0.9), p95: pk(0.95), max: pk(1) };
  };
  console.log('points:', rows.length, '| far (>', rSafe10.toFixed(0), 'km):', far.length);
  console.log('reference stability |ref320/ref160 - 1|: all', JSON.stringify(stats(rows.map((r2) => r2.refStability))));
  for (const D of LADDER) {
    const key = 'g' + D + 'VsRef';
    console.log('div ' + D + ': all', JSON.stringify(stats(rows.map((r2) => Math.abs(r2[key])))),
      '| far', JSON.stringify(stats(far.map((r2) => Math.abs(r2[key])))));
  }
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
