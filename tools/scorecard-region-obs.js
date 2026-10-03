#!/usr/bin/env node
'use strict';
// ================================================================
//  Regional strong-motion scorecard: frozen USGS Shakemap station peaks
//  (public/geojson/region-obs.json, tools/fetch-region-obs.js) vs the
//  simulator's regional GMPE prediction path — the regional counterpart of
//  tools/scorecard-strong-motion.js.
//
//  Prediction path mirrors the region-mode app forecast as far as a
//  station-wise scorecard can:
//    * Physics.setActiveGmpRegion(region) so the 'auto' router resolves
//      crustal -> bssa14 (NGA-West2) outside Japan and
//      interplate/intraslab -> zhao2006 (no regional NGA-Sub bundled);
//    * prediction-side source parameters: the region-pack preset for events
//      with presetId (app behavior), the frozen ComCat `prediction` block
//      otherwise (ridgecrest2019, parkfield2004);
//    * finite-fault geometry for mw >= 6.5 via Physics.genSubSources (the
//      same synthetic rupture the app builds), point source below — the
//      Rjb/Rrup metric choice is then made inside predictStationMotion;
//    * site term: the stationlist Vs30 when present, else the region Vs30
//      pack bilinear sample (Physics.regionVs30Sample — same fallback the
//      app uses for region stations without a grid value), else the station
//      is dropped and counted (droppedNoVs30);
//    * NO gmpe-calibration.json correction: the modelBias table is
//      Japan-fitted (LOEO evidence) and bssa14 has no block — residuals here
//      measure the raw physics, which is the quantity of interest for a
//      regional first-validation report.
//
//  Observed intensity: shakemap instrumental MMI is never mixed in; observed
//  JMA intensity is derived from pgaGal/pgvCms via Physics.calcJmaIntensity
//  on both sides. Residual convention matches the Japan scorecard:
//  log10(pred/obs) for PGA/PGV, absolute difference for intensity.
//
//  Usage: node tools/scorecard-region-obs.js [--write]
//         [--obs=path] [--out=tools/data/region-obs-report.json]
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');
const CFG = require('../public/config.js').CFG_DEFAULTS;

const ROOT = path.resolve(__dirname, '..');
const REGIONS = ['california', 'italy', 'chile', 'taiwan', 'newzealand'];
const FINITE_MW = 6.5;

const DIST_EDGES = [0, 50, 100, 200, 400, Infinity];
const DIST_LABELS = ['<50', '50-100', '100-200', '200-400', '>=400'];

function newAcc() { return { n: 0, sum: 0, sq: 0 }; }
function push(acc, r) { if (!isFinite(r)) return; acc.n++; acc.sum += r; acc.sq += r * r; }
function finalize(acc, digits) {
  const d = digits == null ? 4 : digits;
  if (!acc.n) return { n: 0, bias: null, rms: null };
  const r = v => +v.toFixed(d);
  return { n: acc.n, bias: r(acc.sum / acc.n), rms: r(Math.sqrt(acc.sq / acc.n)) };
}
function distBinIndex(rKm) {
  for (let i = 0; i < DIST_EDGES.length - 1; i++) {
    if (rKm >= DIST_EDGES[i] && rKm < DIST_EDGES[i + 1]) return i;
  }
  return DIST_LABELS.length - 1;
}

// ---- pack loading (cached) ------------------------------------------------
const _packCache = {};
function regionPack(rid) {
  if (!_packCache[rid]) {
    _packCache[rid] = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-' + rid + '.json'), 'utf8'));
  }
  return _packCache[rid];
}
const _vs30Cache = {};
function regionVs30(rid) {
  if (_vs30Cache[rid] === undefined) {
    const p = path.join(ROOT, 'public', 'geojson', 'region-vs30-' + rid + '.json');
    _vs30Cache[rid] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  }
  return _vs30Cache[rid];
}

// Prediction-side source object for one obs event. Pack presets are the app's
// own curated values (ComCat-refreshed); the frozen prediction block is the
// ComCat detail+mechanism captured at fetch time.
function predictionSource(ev) {
  if (ev.presetId) {
    const pack = regionPack(ev.region);
    const p = (pack.presets || []).find(x => x.id === ev.presetId);
    if (!p) throw new Error('pack ' + ev.region + ' missing preset ' + ev.presetId);
    return {
      lat: p.lat, lng: p.lng, depthKm: p.depth, mw: p.mag,
      strikeDeg: p.strike, dipDeg: p.dip, rakeDeg: p.rake,
      sourceType: p.sourceType,
      ref: 'region pack ' + ev.region + ' preset ' + ev.presetId
    };
  }
  const q = ev.prediction;
  if (!q) throw new Error('event ' + ev.eventId + ' has neither presetId nor frozen prediction block');
  return {
    lat: q.lat, lng: q.lng, depthKm: q.depthKm, mw: q.mw,
    strikeDeg: q.strikeDeg, dipDeg: q.dipDeg, rakeDeg: q.rakeDeg,
    sourceType: q.sourceType,
    ref: 'frozen ComCat prediction block (region-obs.json)'
  };
}

function stationVs30(ev, st) {
  if (st.vs30 && st.vs30 > 0) return { vs30: st.vs30, source: 'stationlist' };
  const pack = regionVs30(ev.region);
  if (pack) {
    const v = Physics.regionVs30Sample(pack, st.lat, st.lng);
    if (v && v > 0) return { vs30: v, source: 'region-vs30-grid' };
  }
  return { vs30: null, source: 'none' };
}

// Pure, deterministic report computation (no clock, no randomness).
function computeReport(obs) {
  const overall = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
  const overallDist = DIST_LABELS.map(() => ({ pga: newAcc(), pgv: newAcc(), intensity: newAcc() }));
  const byRegion = {}, byModel = {};
  const events = [];
  const dflt = k => CFG[k].v;

  for (const ev of obs.events) {
    const src = predictionSource(ev);
    Physics.setActiveGmpRegion(ev.region);
    const model = Physics.resolveGmpModel('auto', src.sourceType, src.mw);
    const variant = model === 'bssa14' ? Physics.activeBssa2014Variant() : null;
    const geometry = src.mw >= FINITE_MW
      ? Physics.genSubSources(src.lat, src.lng, src.mw, src.strikeDeg, src.dipDeg, src.depthKm, dflt('rupSpeed'), {})
      : null;
    const acc = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
    const dist = DIST_LABELS.map(() => ({ pga: newAcc(), pgv: newAcc(), intensity: newAcc() }));
    if (!byRegion[ev.region]) byRegion[ev.region] = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
    if (!byModel[model]) byModel[model] = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
    let dropped = 0, gridVs = 0, maxPred = 0;
    const context = {
      source: {
        lat: src.lat, lng: src.lng, depthKm: src.depthKm, mw: src.mw,
        sourceType: src.sourceType, strikeDeg: src.strikeDeg, dipDeg: src.dipDeg, rakeDeg: src.rakeDeg
      },
      geometry,
      gmpModel: 'auto',
      options: {}
    };
    for (const st of ev.stations) {
      if (!(st.pgaGal > 0) || !(st.pgvCms > 0)) continue;
      const v = stationVs30(ev, st);
      if (!v.vs30) { dropped++; continue; }
      if (v.source === 'region-vs30-grid') gridVs++;
      const pred = Physics.predictStationMotion(context, { lat: st.lat, lng: st.lng, vs30: v.vs30 }, {});
      if (!pred || !(pred.pga > 0) || !(pred.pgv > 0)) { dropped++; continue; }
      if (pred.pga > maxPred) maxPred = pred.pga;
      const obsI = Physics.calcJmaIntensity(st.pgaGal, st.pgvCms);
      const rPga = Math.log10(pred.pga / st.pgaGal);
      const rPgv = Math.log10(pred.pgv / st.pgvCms);
      const rI = pred.intensity - obsI;
      const bi = distBinIndex(pred.distanceKm);
      for (const [key, r] of [['pga', rPga], ['pgv', rPgv], ['intensity', rI]]) {
        push(acc[key], r); push(overall[key], r);
        push(dist[bi][key], r); push(overallDist[bi][key], r);
        push(byRegion[ev.region][key], r); push(byModel[model][key], r);
      }
    }
    events.push({
      eventId: ev.eventId, region: ev.region, usgsId: ev.usgsId,
      mw: src.mw, depthKm: src.depthKm, sourceType: src.sourceType,
      model, bssa2014Variant: variant, geometry: geometry ? 'finite-fault' : 'point-source',
      predictionSource: { mode: ev.predictionSource, ref: src.ref },
      stations: acc.pga.n, droppedNoVs30: dropped, gridVs30: gridVs,
      maxPredPgaGal: +maxPred.toFixed(2), maxObsPgaGal: ev.maxObservedPgaGal,
      pga: finalize(acc.pga), pgv: finalize(acc.pgv), intensity: finalize(acc.intensity),
      distanceBins: dist.map((d, i) => ({
        rangeKm: DIST_LABELS[i], pga: finalize(d.pga), pgv: finalize(d.pgv), intensity: finalize(d.intensity)
      }))
    });
  }
  Physics.setActiveGmpRegion(null);

  const fin = o => ({ pga: finalize(o.pga), pgv: finalize(o.pgv), intensity: finalize(o.intensity) });
  return {
    schema: 'quake-sim-region-obs-report-v1',
    hypoNote: 'prediction side: region-pack preset for events with presetId (app behavior); frozen ComCat '
      + 'prediction block otherwise. USGS event metadata stays as frozen for provenance.',
    siteNote: 'station Vs30 = shakemap stationlist value, else the region Vs30 pack bilinear sample '
      + '(Physics.regionVs30Sample), else dropped (counted in droppedNoVs30). Native-Vs30 models '
      + '(bssa14/zhao2006) take it inside the GMPE; no external amplification is stacked on top.',
    calibrationNote: 'NO gmpe-calibration.json correction is applied: the modelBias table is Japan-fitted '
      + 'and bssa14 carries no block — residuals are the raw regional physics.',
    overall: fin(overall),
    byRegion: Object.fromEntries(Object.entries(byRegion).map(([k, v]) => [k, fin(v)])),
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, fin(v)])),
    distanceBins: overallDist.map((d, i) => ({
      rangeKm: DIST_LABELS[i], pga: finalize(d.pga), pgv: finalize(d.pgv), intensity: finalize(d.intensity)
    })),
    events
  };
}

function fmtRow(x) {
  return 'n=' + String(x.n).padEnd(4) + ' bias=' + (x.bias == null ? 'null' : (x.bias >= 0 ? '+' : '') + x.bias)
    + ' rms=' + (x.rms == null ? 'null' : x.rms);
}

function main() {
  const args = process.argv.slice(2);
  const obsArg = args.find(a => a.startsWith('--obs='));
  const outArg = args.find(a => a.startsWith('--out='));
  const obsPath = obsArg ? obsArg.split('=')[1] : path.join(ROOT, 'public', 'geojson', 'region-obs.json');
  const outPath = outArg ? outArg.split('=')[1] : path.join(ROOT, 'tools', 'data', 'region-obs-report.json');
  const write = args.includes('--write');

  const obs = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
  if (obs.schema !== 'quake-sim-region-obs-v1') throw new Error('unsupported obs schema: ' + obs.schema);
  const report = computeReport(obs);

  console.log('overall: pga ' + fmtRow(report.overall.pga));
  console.log('         pgv ' + fmtRow(report.overall.pgv));
  console.log('         int ' + fmtRow(report.overall.intensity));
  for (const [rid, r] of Object.entries(report.byRegion)) {
    console.log(rid.padEnd(12) + ' pga ' + fmtRow(r.pga) + '  pgv ' + fmtRow(r.pgv));
  }
  for (const ev of report.events) {
    console.log('  ' + ev.region + '/' + ev.eventId + ' [' + ev.model
      + (ev.bssa2014Variant ? ':' + ev.bssa2014Variant : '') + ', ' + ev.geometry + ']'
      + ' stations=' + ev.stations + (ev.droppedNoVs30 ? ' dropped=' + ev.droppedNoVs30 : '')
      + ' pga bias=' + (ev.pga.bias >= 0 ? '+' : '') + ev.pga.bias + ' rms=' + ev.pga.rms
      + ' pgv bias=' + (ev.pgv.bias >= 0 ? '+' : '') + ev.pgv.bias + ' rms=' + ev.pgv.rms
      + ' maxPred=' + ev.maxPredPgaGal + '/' + ev.maxObsPgaGal + ' gal');
  }
  if (write) {
    const out = { ...report, generatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote ' + outPath);
  }
  return report;
}

if (require.main === module) main();
module.exports = { computeReport, predictionSource, stationVs30, REGIONS, FINITE_MW, DIST_LABELS };
