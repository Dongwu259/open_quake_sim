#!/usr/bin/env node
'use strict';
// =====================================================================
//  CS aligned-config retest (PRE_REG_V7, 2026-09-15 — gate written
//  BEFORE the run, psv-horizontal-anchor precedent). The last
//  discriminating experiment of the CS research line.
//
//  QUESTION
//  --------
//  The same synthesis carries the scenario gate's +0.3 shape heat vs
//  zhao (cs-diagnosis-v3, U=0.318) while the arbiter's synth reads
//  COLD vs observed shapes (-0.24..-0.28 at 0.1-0.3 s) on the same 13
//  real events. But the arbiter ran a DIFFERENT ARM
//  (bruneBaselineSynthesis, vs30 600 fixed, stress 50 flat, no site
//  curve, no JIVSM stack) — the contrast is arm+population+config
//  confounded. This batch runs the SHIPPED pipeline arm, configured
//  EXACTLY as the gate configures it, on the real events:
//
//    hybridSynthesis(stack = station JIVSM column,
//                    vs30   = research grid at the station,
//                    siteCurve = synthSiteProfile(vs30, bedrock),
//                    stressMPa = cal.stressByClass[srcType],
//                    kappaSec   = cal.kappaSec,
//                    lfGainFn   = lfGainFnFor(cal, mj, repi),
//                    dip = DIP_PRIOR[srcType], strike = seed-sampled,
//                    50 Hz, duration 300 s)
//
//  and measures the paired shape residual against the OBSERVED gm
//  horizontals: DsA(T) = log10(synth(T)/synth(1s)) - log10(obs(T)/obs(1s)).
//
//  DECISION RULES (pre-registered)
//  -------------------------------
//   R1 configOwned  : aggregate alignedDs(0.2 s) >= 0.0 — the shipped
//      configuration carries the short-period heat onto real events;
//      the cure is recalibrating that configuration chain AGAINST
//      OBSERVATIONS (non-circular), registered as the cure candidate.
//   R2 populationOwned: alignedDs(0.2 s) <= -0.10 — the shipped arm
//      stays cold on real events; the scenario gate's heat is a
//      population property (M7-8 near-field deagg bins); no
//      real-event-calibrated cure exists, the gate role is rewritten.
//   else MIXED — magnitudes frozen, direction undecided.
//
//  Threshold rationale: the legacy brune-arm Ds at 0.2 s is -0.238 and
//  the scenario untiltedShape at ~0.1-0.2 s is ~+0.2..+0.4; 0.0 and
//  -0.10 split that span away from both anchors. 0.1 s is REPORTED but
//  excluded from the decision (station 20 Hz packages -> 9 Hz fMax).
//
//  Mechanism disclosure: strike is seed-sampled and dip is the class
//  prior — the SAME convention the scenario gate itself carries (its
//  deaggregation has no per-event mechanism), so the comparison is
//  convention-matched. DIAGNOSIS ONLY: no parameter is retuned.
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');
const { lfGainFnFor, DIP_PRIOR } = require('./cs-pipeline.js');

const ROOT = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-align-retest-report.json');

const PERIODS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
const ANCHOR = 1.0;
const DECIDE_T = 0.2;

const EVENTS = {
  '20030926045007': { name: 'tokachi2003',   mj: 8.0, depthKm: 42, srcType: 'interplate' },
  '20041023180730': { name: 'chuetsu2004',   mj: 6.8, depthKm: 13, srcType: 'crustal' },
  '20050320105319': { name: 'fukuoka2005',   mj: 7.0, depthKm: 10, srcType: 'crustal' },
  '20070325094145': { name: 'noto2007',      mj: 6.9, depthKm: 11, srcType: 'crustal' },
  '20080614084331': { name: 'iwate2008',     mj: 7.2, depthKm: 8,  srcType: 'crustal' },
  '20110311144626': { name: 'tohoku2011',    mj: 9.0, depthKm: 24, srcType: 'interplate' },
  '20110411171556': { name: 'fukushima2011', mj: 7.0, depthKm: 10, srcType: 'crustal' },
  '20160416012405': { name: 'kumamoto2016',  mj: 7.3, depthKm: 10, srcType: 'crustal' },
  '20180906030750': { name: 'iburi2018',     mj: 6.7, depthKm: 37, srcType: 'intraslab' },
  '20190618222207': { name: 'yamagata2019',  mj: 6.7, depthKm: 14, srcType: 'crustal' },
  '20220316233630': { name: 'fukushima2022', mj: 7.3, depthKm: 60, srcType: 'intraslab' },
  '20240101160813': { name: 'noto2024',      mj: 7.6, depthKm: 16, srcType: 'crustal' },
  '20240808164247': { name: 'hyuganada2024', mj: 7.1, depthKm: 30, srcType: 'interplate' }
};

function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function hashSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function main() {
  const t0 = Date.now();
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-repair-calibration.json'), 'utf8'));
  const vs30Grid = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'vs30.json'), 'utf8'));
  const bedrockGrid = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-bedrock.json'), 'utf8'));
  Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));

  const events = [];
  for (const id of Object.keys(EVENTS)) {
    const meta = EVENTS[id];
    const ev = JSON.parse(fs.readFileSync(path.join(PKG_DIR, id + '.json'), 'utf8'));
    const eLat = ev.event.lat, eLng = ev.event.lng;
    const evT0 = Date.now();
    const ds = {}; for (const T of PERIODS) ds[T] = [];
    let nUsed = 0, nSkipped = 0, nTimeout = 0;
    const STATION_BUDGET_MS = 90000; // one K-NET station spun >19 min on tohoku-2011 once — bound it
    for (const st of ev.stations) {
      const stT0 = Date.now();
      const z = { n: st.components.n, e: st.components.e };
      if (!z.n || !z.e || !z.n.samples || !z.e.samples) { nSkipped++; continue; }
      const vs30 = Physics.lookupResearchGrid(vs30Grid, st.station.lat, st.station.lng) || 600;
      const col = Physics.jivsmColumnAt(st.station.lat, st.station.lng);
      if (!col) { nSkipped++; continue; }
      const stack = hybrid.buildJivsmIaspStack(col);
      const bedrockM = Physics.lookupResearchGrid(bedrockGrid, st.station.lat, st.station.lng);
      const profile = Physics.synthSiteProfile(vs30, bedrockM);
      const repi = Physics.haversineDist(eLat, eLng, st.station.lat, st.station.lng);
      const rake = Physics.PSHA_CLASS_RAKE[meta.srcType] || 0;
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', meta.srcType, meta.mj, repi, meta.depthKm, vs30, rake);
      let siteCurve = null;
      if (profile && profile.length >= 2 && g && g.median > 0) {
        const freqs = [];
        for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
        const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
        if (res && res.amp) siteCurve = { freqs, amps: res.amp.map((a) => Math.max(0.2, Math.min(8, a))) };
      }
      // observed gm-horizontal shape
      if (Date.now() - stT0 > STATION_BUDGET_MS) { nTimeout++; nSkipped++; continue; }
      const az = hybrid.azimuthDeg(eLat, eLng, st.station.lat, st.station.lng);
      const rot = hybrid.rotateNE(z.n.samples, z.e.samples, az);
      const psaN = Physics.sdofResponseSpectrum(z.n.samples, st.sampleRateHz || 20, PERIODS, 0.05).map((r) => r.psaGal);
      const psaE = Physics.sdofResponseSpectrum(z.e.samples, st.sampleRateHz || 20, PERIODS, 0.05).map((r) => r.psaGal);
      const gm = PERIODS.map((_, i) => Math.sqrt(Math.max(psaN[i], 0) * Math.max(psaE[i], 0)));
      const iA = PERIODS.indexOf(ANCHOR);
      if (!(gm[iA] > 0)) { nSkipped++; continue; }
      // aligned shipped-arm synth
      const seed = hashSeed('align:' + id + ':' + st.station.id);
      const strike = +(Physics.seededRng(seed)() * 360).toFixed(2);
      let r;
      try {
        if (Date.now() - stT0 > STATION_BUDGET_MS) { nTimeout++; nSkipped++; continue; }
        const out = hybrid.hybridSynthesis({
          sourceLat: eLat, sourceLng: eLng, sourceDepthKm: meta.depthKm,
          mw: meta.mj, strike, dip: DIP_PRIOR[meta.srcType] || 45, rake,
          receiverLat: st.station.lat, receiverLng: st.station.lng,
          vs30, stack, siteCurve, stressMPa: cal.stressByClass[meta.srcType] || 50,
          kappaSec: cal.kappaSec, lfGainFn: lfGainFnFor(cal, meta.mj, repi),
          sampleRateHz: 50, durationS: 300, seed
        });
        r = Physics.sdofResponseSpectrum(out.transverse, out.sampleRateHz, PERIODS, 0.05).map((row) => row.psaGal);
      } catch (e) { nSkipped++; continue; }
      if (!(r[iA] > 0)) { nSkipped++; continue; }
      let ok = false;
      for (let pi = 0; pi < PERIODS.length; pi++) {
        if (!(gm[pi] > 0) || !(r[pi] > 0)) continue;
        ds[PERIODS[pi]].push(Math.log10(r[pi] / r[iA]) - Math.log10(gm[pi] / gm[iA]));
        ok = true;
      }
      if (ok) nUsed++;
    }
    const row = { id, name: meta.name, mj: meta.mj, srcType: meta.srcType, nUsed, nSkipped, nTimeout, alignedDs: {} };
    for (const T of PERIODS) row.alignedDs[String(T)] = ds[T].length ? +median(ds[T]).toFixed(3) : null;
    events.push(row);
    console.log(meta.name.padEnd(15), 'n=' + String(nUsed).padStart(2), 'to=' + nTimeout, 'DsA(0.2s)=' + row.alignedDs['0.2'], 'DsA(0.3s)=' + row.alignedDs['0.3'], 'DsA(3s)=' + row.alignedDs['3'], '(' + ((Date.now() - evT0) / 60000).toFixed(1) + ' min)');
    if (nTimeout) console.log('  NOTE: ' + nTimeout + ' station(s) exceeded the ' + STATION_BUDGET_MS / 1000 + ' s wall budget and were skipped');
  }

  const agg = {};
  for (const T of PERIODS) {
    const vals = events.map((e) => e.alignedDs[String(T)]).filter((v) => v != null);
    agg[String(T)] = vals.length ? +median(vals).toFixed(3) : null;
  }
  const d02 = agg[String(DECIDE_T)];
  const verdict = d02 == null ? 'n/a' :
    d02 >= 0.0 ? 'CONFIG-OWNED: the shipped configuration carries the short-period heat onto real events (alignedDs(0.2s)=' + d02 + ' >= 0.0) — recalibrating the configuration chain AGAINST OBSERVATIONS is the registered cure candidate' :
    d02 <= -0.10 ? 'POPULATION-OWNED: the shipped arm stays cold on real events (alignedDs(0.2s)=' + d02 + ' <= -0.10) — the scenario gate heat is a population property; no real-event-calibrated cure exists' :
    'MIXED: alignedDs(0.2s)=' + d02 + ' sits between the pre-registered anchors — magnitudes frozen, direction undecided';

  const report = {
    schema: 'quake-sim-cs-align-retest-v1',
    generatedAt: new Date().toISOString(),
    preRegistered: {
      gate: 'R1 configOwned if alignedDs(0.2s) >= 0.0; R2 populationOwned if <= -0.10; else MIXED — thresholds written before the run (this header); 0.1 s reported but excluded (20 Hz packages, 9 Hz fMax)',
      arm: 'the SHIPPED pipeline arm on real events: hybrid stack=station JIVSM column, vs30 grid, siteCurve synthSiteProfile, stressByClass, kappaSec, lfGainFn, DIP_PRIOR dip, seed-sampled strike',
      references: { legacyArbiterBruneArmDs: { '0.1': -0.275, '0.2': -0.238, '0.3': -0.216, '0.5': -0.123 }, scenarioUntiltedShapeU: 0.318 },
      disclosure: 'mechanism is class-prior (strike seed-sampled) — convention-matched to the scenario gate; DIAGNOSIS ONLY, no parameter retuned'
    },
    aggregate: { alignedDs: agg, alignedDs02: d02, verdict },
    events
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\n=== CS ALIGNED-CONFIG RETEST (PRE_REG_V7) ===');
  console.log('alignedDs:', JSON.stringify(agg));
  console.log('verdict:', verdict);
  console.log('wrote ' + OUT);
  console.log('elapsed ' + ((Date.now() - t0) / 1000 / 60).toFixed(1) + ' min');
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
