#!/usr/bin/env node
'use strict';
// tools/scorecard-nw2-alias.js — R-C NGA-West2 regional-alias A/B measurement.
// Scores CY14/CB14/ASK14 base vs regional-alias ground motions against the
// frozen region-obs set (19 events / 3,235 stations, tools/data/region-obs
// report lineage) and decides alias adoption by the gates below.
//
// ============================================================================
// PREREGISTRATION (written before the first scoring run — 2026-11-08)
// ============================================================================
// Measurement instrument: per-station log10 residuals r = log10(pred/obs) on
// PGA (the scorecard family's primary metric), point-source geometry via
// Physics.nw2PointGeom (Rjb = epicenter→station surface distance, dip/rake
// from the region-pack preset mechanism). Both arms of every A/B use the SAME
// geometry, so production-vs-instrument differences (finite-fault patches for
// Mw>=6.5, GMPE calibration tables) cancel in the DELTA; absolute bias/rms
// here are not comparable to scorecard-region-obs.js numbers (documented).
// Set: crustal events only (chile megathrust presets excluded; chile has no
// mapped alias anyway). Station Vs30: stationlist first, region Vs30 grid
// fallback — identical per station across arms.
//
// Aliases under test (v7.x tree-batch limitations item):
//   cy14  JPN/ITA/WEN — mappable to our regions: italy -> ITA only.
//   ask14 CHN/JPN/TWN — mappable: taiwan -> TWN only.
//   cb14  HighQ/LowQ  — Q-regime epistemic branches, NOT region aliases.
//   The Japan-linked aliases (cy14 JPN, ask14 JPN, cb14 JapanSite/SJ) stay
//   unwired regardless of measurement: Japan routing is byte-frozen.
//
// Hypotheses (frozen):
//   H-C1  CY14 ITA (gjpit factor, 6<M<6.9 only) shifts Italy predictions by
//         at most a few percent — small vs the bssa14-lowQ production arm.
//   H-C2  ASK14 TWN (a25*rrup + a31 reference-site term) shifts Taiwan
//         predictions substantially with distance — direction unknown.
//   H-C3  CB14 HighQ/LowQ Dc20 overlays are nearly flat multipliers of the
//         anelastic tail (rrup>80 km) — effects concentrated at distance.
//
// Decision gates (frozen; PGA, per-region crustal subset):
//   G-ADOPT(model,region): adopt the mapped alias iff
//     |bias_alias| < |bias_base|  AND  rms_alias <= rms_base + 0.005
//     (0.005 = pre-declared harmlessness tolerance for 10log10 rms units).
//     Gated pairs: italy x cy14-ITA, taiwan x ask14-TWN. Everything else
//     (cy14 JPN/WEN, ask14 CHN/JPN on any region; aliases on unmapped
//     regions) is reported REFERENCE-ONLY and never adopted.
//   G-CB-BRANCH: HighQ/LowQ adoption as PSHA tree epistemic branches is a
//     USER FRAMEWORK DECISION (same standing as the R-B package question) —
//     this tool only freezes the per-region deltas; no auto-adoption.
//   Adoption surface if G-ADOPT passes: the regional pack gmpeTree branch
//   motion evaluation (_pshaBranchMotion cy14/ask14 branches) passes the
//   region alias; production predictStationMotion auto routing (crustal ->
//   bssa14) is UNCHANGED by this decision either way.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'nw2-alias-report.json');

function regionPack(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-' + rid + '.json'), 'utf8'));
}
function regionVs30(rid) {
  const p = path.join(ROOT, 'public', 'geojson', 'region-vs30-' + rid + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// Event set from the frozen region-obs.json (same lineage as the scorecard).
const REGION_IDS = ['california', 'italy', 'chile', 'taiwan', 'newzealand', 'ecuador'];
const MAPPED_ALIAS = { cy14: { italy: 'ITA' }, ask14: { taiwan: 'TWN' } };
// Reference-only arms (never gated, never adopted).
const REFERENCE_ARMS = {
  cy14: ['JPN', 'WEN'],
  ask14: ['CHN', 'JPN'],
  cb14: [],
};
const CB_VARIANTS = ['HighQ', 'LowQ'];

function newAcc() { return { n: 0, sum: 0, sq: 0 }; }
function push(acc, r) { if (!isFinite(r)) return; acc.n++; acc.sum += r; acc.sq += r * r; }
function finalize(acc) {
  if (!acc.n) return { n: 0, bias: null, rms: null };
  return { n: acc.n, bias: acc.sum / acc.n, rms: Math.sqrt(acc.sq / acc.n) };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toR = Math.PI / 180;
  const dLa = (lat2 - lat1) * toR, dLo = (lng2 - lng1) * toR;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function eventSource(ev) {
  const pack = regionPack(ev.region);
  const p = (pack.presets || []).find(x => x.id === ev.presetId);
  if (p) return { lat: p.lat, lng: p.lng, depthKm: p.depth, mw: p.mag, dip: p.dip, rake: p.rake, sourceType: p.sourceType };
  const q = ev.prediction;
  if (!q) return null;
  return { lat: q.lat, lng: q.lng, depthKm: q.depthKm, mw: q.mw, dip: q.dipDeg, rake: q.rakeDeg, sourceType: q.sourceType };
}

function main() {
  const obs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-obs.json'), 'utf8'));
  const events = obs.events || [];
  const perRegion = {}; // region -> model -> arm -> acc
  const armsFor = (region) => {
    // arm list per model for this region: base + mapped alias + references
    const map = { cy14: ['base'], ask14: ['base'], cb14: ['base'] };
    for (const [model, rmap] of Object.entries(MAPPED_ALIAS)) {
      if (rmap[region]) map[model].push(rmap[region]);
    }
    for (const [model, refs] of Object.entries(REFERENCE_ARMS)) map[model].push(...refs);
    map.cb14.push(...CB_VARIANTS);
    return map;
  };

  let stations = 0, dropped = 0, crustalEvents = 0;
  for (const ev of events) {
    const src = eventSource(ev);
    if (!src) continue;
    if (src.sourceType !== 'crustal') continue; // gates are crustal-only
    crustalEvents++;
    const arms = armsFor(ev.region);
    if (!perRegion[ev.region]) {
      perRegion[ev.region] = {};
      for (const [model, list] of Object.entries(arms)) {
        perRegion[ev.region][model] = {};
        list.forEach((a) => { perRegion[ev.region][model][a] = newAcc(); });
      }
    }
    const vpack = regionVs30(ev.region);
    for (const st of ev.stations || []) {
      if (!(st.pgaGal > 0)) { dropped++; continue; }
      let vs30 = (st.vs30 && st.vs30 > 0) ? st.vs30 : null;
      if (!vs30 && vpack) {
        const v = Physics.regionVs30Sample(vpack, st.lat, st.lng);
        if (v && v > 0) vs30 = v;
      }
      if (!vs30) { dropped++; continue; }
      const rjb = haversineKm(src.lat, src.lng, st.lat, st.lng);
      const geom = Physics.nw2PointGeom(src.mw, rjb, src.depthKm, vs30, src.rake, src.dip);
      const pred = (model, arm) => {
        const a = (!arm || arm === 'base') ? undefined : arm;
        if (model === 'cy14') return Physics.pgaCy2014(src.mw, geom, a);
        if (model === 'ask14') return Physics.pgaAsk2014(geom, a);
        if (model === 'cb14') return Physics.pgaCb2014(geom, a);
        throw new Error('model ' + model);
      };
      for (const [model, list] of Object.entries(arms)) {
        for (const arm of list) {
          const p = pred(model, arm);
          if (!(p > 0)) { continue; }
          push(perRegion[ev.region][model][arm], Math.log10(p / st.pgaGal));
        }
      }
      stations++;
    }
  }

  // Finalize + gate evaluation (frozen G-ADOPT above).
  const report = {
    schema: 'quake-sim-nw2-alias-report-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-nw2-alias.js header (gates frozen 2026-11-08, before first run)',
    set: {
      events: events.length, crustalEvents: crustalEvents, stationsScored: stations, droppedStations: dropped,
      metric: 'pga', residual: 'log10(pred/obs)', geometry: 'point-source nw2PointGeom (both arms identical)',
    },
    regions: {},
    gates: {},
  };
  for (const region of Object.keys(perRegion).sort()) {
    report.regions[region] = {};
    for (const [model, arms] of Object.entries(perRegion[region])) {
      report.regions[region][model] = {};
      for (const [arm, acc] of Object.entries(arms)) report.regions[region][model][arm] = finalize(acc);
    }
  }
  // G-ADOPT evaluation
  const gate = (b, a) => {
    if (!b || !a || b.bias === null || a.bias === null) return { pass: false, reason: 'insufficient data' };
    const biasBetter = Math.abs(a.bias) < Math.abs(b.bias);
    const rmsOk = a.rms <= b.rms + 0.005;
    return { pass: biasBetter && rmsOk, biasBetter: biasBetter, rmsOk: rmsOk,
             dBias: a.bias - b.bias, dRms: a.rms - b.rms };
  };
  const mapped = { cy14: MAPPED_ALIAS.cy14, ask14: MAPPED_ALIAS.ask14 };
  for (const [model, rmap] of Object.entries(mapped)) {
    for (const [region, alias] of Object.entries(rmap)) {
      const r = report.regions[region];
      if (!r || !r[model]) continue;
      report.gates[model + ':' + alias + '@' + region] = gate(r[model].base, r[model][alias]);
    }
  }
  // Reference arms get an explicit never-adopt marker.
  report.gatesNote = 'reference arms (cy14 JPN/WEN, ask14 CHN/JPN anywhere; any alias on unmapped regions) are never adopted; CB14 HighQ/LowQ = user framework decision (no auto-adoption)';

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
