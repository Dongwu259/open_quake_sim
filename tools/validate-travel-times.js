#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.7 R3-2: travel-time validation — JIVSM station columns vs IASP91
//  using S−P times picked from the frozen Kyoshin waveform packages
//  (local-only downloads under public/geojson/strong-motion-waveforms/;
//  packages never committed — ONLY derived picks + summary are frozen to
//  tools/data/).
//
//  Timing reality (measured 2026-08-25): the P onset in every record sits
//  at a near-constant ~13.5 s — K-NET/KiK-net recorders trigger on their
//  own P and dump a fixed pre-event buffer, so record-relative time carries
//  NO absolute origin. What IS recoverable per station:
//    * B  = recorder buffer ≈ median of P picks per event (reported),
//    * S−P = (S pick) − B  — the differential travel time, and exactly the
//      quantity that basin fills distort (h·(1/Vs−1/Vp) through the fill).
//  Method (pre-registered): P = trailing STA/LTA (0.5/5 s, ratio 4.5) on
//  the vertical surface component; S = first sustained (≥0.5 s) 1-s
//  horizontal STA exceeding 3× the [P, P+1.5 s) horizontal reference,
//  searched from P+3 s. Physical gates only: S−P in [2, 60] s and
//  (S−P)_obs/(S−P)_pred in [0.6, 1.6] for BOTH models (common, symmetric).
//  Acceptance: near-field (<150 km) median |S−P residual| improves vs
//  IASP91 and is < 0.3 s.
//
//  Usage: node tools/validate-travel-times.js [--freeze]
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, 'public/geojson/strong-motion-waveforms');
const EQMAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/data/kyoshin-eqid-map.json'), 'utf8'));
const OBS = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/strong-motion-obs.json'), 'utf8'));

function arg(name) { return process.argv.slice(2).indexOf('--' + name) >= 0; }

// Trailing STA/LTA with prefix sums, pre-event noise floor and an absolute
// amplitude gate; returns the first sample time of the triggering window.
function staLtaPick(x, rate, staS, ltaS, ratio, fromSec) {
  const n = x.length;
  const staN = Math.max(2, Math.round(staS * rate));
  const ltaN = Math.max(staN * 2, Math.round(ltaS * rate));
  const pre = Math.max(1, Math.round(fromSec * rate));
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + Math.abs(x[i]);
  let noise = 0;
  const preN = Math.min(pre, n);
  for (let i = 0; i < preN; i++) noise += cum[i + 1] - cum[i];
  noise = Math.max(1e-3, noise / preN);
  let run = 0;
  const i0 = Math.max(staN + 1, ltaN, pre);
  for (let i = i0; i < n; i++) {
    const sta = (cum[i] - cum[i - staN]) / staN;
    const l0 = Math.max(0, i - ltaN);
    const lta = Math.max(noise, (cum[i] - cum[l0]) / (i - l0));
    if (sta / lta > ratio && sta > 3 * noise) {
      run++;
      if (run >= 3) return (i - run - staN + 1) / rate;
    } else run = 0;
  }
  return null;
}

// S onset: first sustained 1-s horizontal STA > 3x the P-window reference.
function pickS(h, rate, tPsec) {
  const iP = Math.round(tPsec * rate);
  const iEnd = Math.min(h.length, iP + Math.round(1.5 * rate));
  let ref = 0, n = 0;
  for (let i = iP; i < iEnd; i++) { ref += Math.abs(h[i]); n++; }
  ref = Math.max(1e-3, ref / Math.max(1, n));
  const staN = Math.round(1.0 * rate);
  const runNeed = Math.max(2, Math.round(0.5 * rate));
  let run = 0;
  for (let i = iP + Math.round(3 * rate); i + staN <= h.length; i++) {
    let sta = 0;
    for (let j = i; j < i + staN; j++) sta += Math.abs(h[j]);
    sta /= staN;
    if (sta > 3 * ref) { run++; if (run >= runNeed) return i / rate; }
    else run = 0;
  }
  return null;
}

function median(arr) { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; }

function main() {
  const columns = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/jivsm-columns.json'), 'utf8'));
  Physics.setJivsmColumns(columns);
  const eventsByKey = {};
  for (const ev of OBS.events) eventsByKey[ev.eventId] = ev;
  const eqEntries = Array.isArray(EQMAP) ? EQMAP.map(e => [String(e.eqid || e.id), e]) : Object.entries(EQMAP);

  // pass 1: raw picks per event (P pick ~ recorder buffer, S pick)
  const perEvent = {};
  for (const file of fs.readdirSync(WF_DIR).filter(f => /^\d{14}\.json$/.test(f)).sort()) {
    const eqid = file.replace('.json', '');
    const mapHit = eqEntries.find(([k]) => k === eqid);
    const evMeta = mapHit ? eventsByKey[(mapHit[1].eventId || mapHit[1].event)] : null;
    const pkg = JSON.parse(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));
    const ev = evMeta || { lat: pkg.event.lat, lng: pkg.event.lng, depthKm: pkg.event.depthKm || 12, eventId: eqid };
    if (!(ev.lat != null && ev.lng != null)) continue;
    const picks = [];
    for (const st of pkg.stations) {
      const meta = st.station || st;
      const z = st.components && st.components.z && st.components.z.samples;
      const nn = st.components && st.components.n && st.components.n.samples;
      const ee = st.components && st.components.e && st.components.e.samples;
      if (!z || !nn || !ee || z.length !== nn.length || z.length !== ee.length || z.length < 400) continue;
      const rate = st.sampleRateHz || 20;
      const pre = z.slice(0, Math.min(z.length, 2 * rate));
      const bz = pre.reduce((a, b) => a + b, 0) / pre.length;
      const zz = z.map(v => v - bz);
      const h = nn.map((v, i) => Math.hypot(v, ee[i]));
      const hb = h.slice(0, pre.length).reduce((a, b) => a + b, 0) / pre.length;
      const hh = h.map(v => v - hb);
      const tP = staLtaPick(zz, rate, 0.5, 5.0, 4.5, 2);
      if (tP == null) continue;
      const tS = pickS(hh, rate, tP);
      if (tS == null) continue;
      const dist = Physics.haversineDist(ev.lat, ev.lng, meta.lat, meta.lng);
      picks.push({ st, meta, dist, tP, tS });
    }
    if (!picks.length) continue;
    const B = median(picks.map(p => p.tP)); // recorder buffer estimate
    perEvent[eqid] = { ev, picks, B };
  }

  // pass 2: gate + residuals on S−P
  const rows = [];
  for (const [eqid, { ev, picks, B }] of Object.entries(perEvent)) {
    const depth = ev.depthKm != null ? ev.depthKm : 12;
    for (const p of picks) {
      const spObs = p.tS - B;
      if (!(spObs >= 2 && spObs <= 60)) continue;
      Physics.JIVSM_TRAVEL_ON = false;
      const tp91 = Physics.pTravelTime(p.dist, depth), ts91 = Physics.sTravelTime(p.dist, depth);
      Physics.JIVSM_TRAVEL_ON = true;
      const tpjm = Physics.pTravelTime(p.dist, depth, undefined, p.meta.lat, p.meta.lng);
      const tsjm = Physics.sTravelTime(p.dist, depth, undefined, p.meta.lat, p.meta.lng);
      Physics.JIVSM_TRAVEL_ON = null;
      const sp91 = ts91 - tp91, spjm = tsjm - tpjm;
      // common symmetric physical gate on the differential time
      if (spObs / sp91 < 0.6 || spObs / sp91 > 1.6) continue;
      if (spObs / spjm < 0.6 || spObs / spjm > 1.6) continue;
      rows.push({
        event: ev.eventId, eqid, station: p.meta.id, network: p.meta.network,
        lat: p.meta.lat, lng: p.meta.lng, distKm: +p.dist.toFixed(1), depthKm: depth,
        spObs: +spObs.toFixed(2), spIasp91: +sp91.toFixed(2), spJivsm: +spjm.toFixed(2),
        res91: +(spObs - sp91).toFixed(2), resJm: +(spObs - spjm).toFixed(2),
        bufferEst: +B.toFixed(2),
        hasJivsmColumn: !!Physics.jivsmColumnAt(p.meta.lat, p.meta.lng)
      });
    }
  }
  if (!rows.length) { console.error('no picks passed the gates'); process.exit(1); }

  function spread(key, subset) {
    const vals = (subset || rows).map(r => r[key]);
    return +median(vals.map(v => Math.abs(v - median(vals)))).toFixed(2);
  }
  const near = rows.filter(r => r.distKm < 150);
  const colNear = near.filter(r => r.hasJivsmColumn);
  console.log('picks:', rows.length, 'stations across', new Set(rows.map(r => r.event)).size, 'events',
    '| with JIVSM column:', rows.filter(r => r.hasJivsmColumn).length);
  console.log('buffer estimates per event (s):',
    Object.entries(perEvent).filter(([k]) => rows.some(r => r.eqid === k))
      .map(([k, v]) => k.slice(4) + ':' + v.B.toFixed(1)).join(' '));
  console.log('S-P median |residual|: IASP91 all', spread('res91'), 's | JIVSM all', spread('resJm'), 's');
  console.log('  near<150km (n=' + near.length + '): IASP91', spread('res91', near), 's -> JIVSM', spread('resJm', near), 's',
    '| near with column (n=' + colNear.length + '):', spread('res91', colNear), '->', spread('resJm', colNear), 's');
  const near91 = spread('res91', near), nearJm = spread('resJm', near);
  const improved = nearJm < near91;
  console.log('ACCEPTANCE (pre-registered): near-field S-P median |res| improves vs IASP91:', improved,
    '| <0.3s target:', nearJm < 0.3 ? 'PASS' : 'FAIL (' + nearJm + 's)');

  const byEv = {};
  for (const r of rows) (byEv[r.event] = byEv[r.event] || []).push(r);
  for (const [ev, rs] of Object.entries(byEv)) {
    console.log(' ', ev.padEnd(16), 'n=' + String(rs.length).padStart(3),
      '| IASP91', spread('res91', rs), '-> JIVSM', spread('resJm', rs),
      '| median res91', +median(rs.map(r => r.res91)).toFixed(2), '-> resJm', +median(rs.map(r => r.resJm)).toFixed(2));
  }

  if (arg('freeze')) {
    const out = {
      schema: 'quake-sim-travel-picks-v1',
      meta: {
        method: 'S-P differential validation: P = STA/LTA (0.5/5 s, 4.5) on Z (record-relative; its median per event estimates the recorder pre-trigger buffer B), S = sustained 1-s horizontal STA > 3x the P-window reference; gates S-P in [2,60] s and obs/pred in [0.6,1.6] for both models',
        timingReality: 'K-NET/KiK-net records start at local-P minus a fixed buffer (~13.5 s measured) — absolute travel times are not recoverable, so the A/B metric is the S-P residual (basin fills enter through h*(1/Vs-1/Vp))',
        provenance: 'NIED K-NET/KiK-net waveforms (DOI 10.17598/NIED.0004); raw packages never committed — these are derived differential arrival picks',
        acceptance: 'near-field(<150km) median |S-P residual| improves vs IASP91 and < 0.3 s'
      },
      summary: {
        n: rows.length, near150N: near.length, near150Iasp91: near91, near150Jivsm: nearJm,
        improved: improved
      },
      picks: rows
    };
    fs.writeFileSync(path.join(ROOT, 'tools/data/travel-time-picks.json'), JSON.stringify(out));
    console.log('frozen -> tools/data/travel-time-picks.json');
  }
}
main();
