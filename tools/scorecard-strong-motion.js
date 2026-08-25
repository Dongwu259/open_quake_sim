#!/usr/bin/env node
'use strict';
// ================================================================
//  Strong-motion scorecard: frozen K-NET/KiK-net station peaks
//  (public/geojson/strong-motion-obs.json, fetched from USGS Shakemap
//  stationlists by tools/fetch-strong-motion-obs.js) vs the simulator's
//  GMPE prediction path.
//
//  Prediction path mirrors the app forecast (_predictPrefectureShindosFor,
//  app.js:2714) as far as a station-wise scorecard can:
//    * model routing 'auto' via Physics.resolveGmpModel with the event's
//      app-consistent sourceType (crustal -> si-midorikawa,
//      interplate/intraslab -> zhao2006);
//    * hypocentral distance (Physics.hypoDist) — the same distance the
//      zhao2006/kanno2006 forecast branches use (the si-mid Rrup branch is
//      finite-fault geometry and out of scope for a point-source scorecard);
//    * calibration applied exactly as the forecast path does:
//      Physics.setGmpeCalibration(gmpe-calibration.json) then
//      Physics.calibrateIntensity(I, eventMw) (skip with --no-calibration).
//
//  Site term (documented choice): the GMPE is evaluated on its reference
//  site (zhao2006 -> Vs30 1200 m/s SC_I rock, kanno2006 -> 800, matching the
//  app forecast's no-site reference; si-mid/log carry no Vs30 parameter),
//  then the station's own Vs30 is applied through the external power-law
//  Physics.vs30Amplification (referenced to 760 m/s) when present; stations
//  without Vs30 get no site term. Caveat: for zhao2006 the app forecast
//  feeds Vs30 natively into the site-class table instead — the external
//  multiplier on a rock base under-amplifies soft sites relative to that
//  native term, so zhao-routed events show slightly more scatter here than
//  in the app. The convention is uniform across all events.
//
//  Observed intensity: the frozen `intensity` field is shakemap
//  instrumental MMI and is NEVER mixed into JMA residuals. The observed
//  JMA intensity is derived from the observed PGA/PGV through the same
//  Physics.calcJmaIntensity the predictor uses, so both sides share one
//  scale. A clearly-labeled cross-scale MMI delta is reported per event
//  for reference only.
//
//  Prediction hypocenter (additive, default 'jma'): the frozen obs file
//  keeps USGS event metadata for provenance, but the app itself predicts
//  from JMA-catalog parameters. In 'jma' mode the prediction side uses the
//  repo's own JMA-catalog hypocenter per event (loadJmaHypocenters below);
//  --usgs-hypo reproduces the original USGS-hypocenter numbers.
//
//  Usage: node tools/scorecard-strong-motion.js [--no-calibration]
//         [--usgs-hypo] [--fit-model-bias=model]
//         [--obs=path] [--out=tools/data/strong-motion-report.json]
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

// ----------------------------------------------------------------
//  JMA-catalog hypocenters for the prediction side. The frozen obs file
//  is observational data and stays untouched; these come from the repo's
//  own catalog/preset data:
//   * public/geojson/observed.json — JMA-catalog validation dataset
//     (keys tohoku / kumamoto / tokachi2003 / noto2024);
//   * public/app.js PRESETS — standalone preset lines for the two events
//     observed.json does not cover (fukushima2022, hyuganada2024).
//  Missing or unparseable entries throw (no silent fallback).
// ----------------------------------------------------------------
const JMA_KEY_BY_EVENT = {
  tohoku2011: 'tohoku',
  kumamoto2016: 'kumamoto',
  tokachi2003: 'tokachi2003',
  noto2024: 'noto2024',
  fukushima2022: 'fukushima2022',
  hyuganada2024: 'hyuganada2024',
  // R1 expansion (2026-08-24): +7 crustal events, JMA hypocenters already
  // frozen in observed.json.
  chuetsu2004: 'chuetsu',
  iwate2008: 'iwate2008',
  fukuoka2005: 'fukuoka2005',
  noto2007: 'noto2007',
  fukushima2011: 'fukushima2011',
  yamagata2019: 'yamagata2019',
  iburihigashi2018: 'iburihigashi'
};
const PRESET_ONLY_EVENTS = ['fukushima2022', 'hyuganada2024'];

let _jmaHypoCache = null;
function loadJmaHypocenters(rootDir) {
  if (_jmaHypoCache && !rootDir) return _jmaHypoCache;
  const root = rootDir || path.join(__dirname, '..');
  const out = {};
  const observed = JSON.parse(fs.readFileSync(path.join(root, 'public', 'geojson', 'observed.json'), 'utf8'));
  for (const evId of Object.keys(JMA_KEY_BY_EVENT)) {
    if (PRESET_ONLY_EVENTS.includes(evId)) continue;
    const key = JMA_KEY_BY_EVENT[evId];
    const e = observed[key];
    if (!e) throw new Error('observed.json missing JMA catalog entry: ' + key);
    const h = {
      lat: Number(e.epi_lat), lng: Number(e.epi_lng),
      depthKm: Number(e.depth), mw: Number(e.mw),
      source: 'public/geojson/observed.json#' + key
    };
    if (![h.lat, h.lng, h.depthKm, h.mw].every(isFinite)) {
      throw new Error('observed.json#' + key + ' has non-finite hypocenter fields');
    }
    out[evId] = h;
  }
  const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const block = appSrc.match(/var PRESETS = \{[\s\S]*?\n\};/);
  if (!block) throw new Error('PRESETS block not found in public/app.js');
  for (const evId of PRESET_ONLY_EVENTS) {
    const key = JMA_KEY_BY_EVENT[evId];
    const re = new RegExp('^\\s*' + key + '\\s*:\\s*\\{lat:([\\d.]+),lng:([\\d.]+),mag:([\\d.]+),depth:([\\d.]+)', 'm');
    const m = block[0].match(re);
    if (!m) throw new Error('PRESETS.' + key + ' not parseable in public/app.js');
    const h = {
      lat: Number(m[1]), lng: Number(m[2]), mw: Number(m[3]), depthKm: Number(m[4]),
      source: 'public/app.js PRESETS.' + key
    };
    if (![h.lat, h.lng, h.depthKm, h.mw].every(isFinite)) {
      throw new Error('PRESETS.' + key + ' has non-finite hypocenter fields');
    }
    out[evId] = h;
  }
  if (!rootDir) _jmaHypoCache = out;
  return out;
}

// The event object the prediction side sees in 'jma' mode: frozen station
// data untouched, event hypocenter/magnitude swapped to the JMA catalog.
function predictionEvent(ev, hypoMode, jmaHypos) {
  if (hypoMode !== 'jma') return ev;
  const h = jmaHypos[ev.eventId];
  if (!h) throw new Error('no JMA hypocenter mapped for event ' + ev.eventId);
  return Object.assign({}, ev, { lat: h.lat, lng: h.lng, depthKm: h.depthKm, mw: h.mw });
}

const DIST_EDGES = [0, 50, 100, 200, 400, Infinity];
const DIST_LABELS = ['<50', '50-100', '100-200', '200-400', '>=400'];

function newAcc() {
  return { n: 0, sum: 0, sq: 0 };
}
function push(acc, r) {
  if (!isFinite(r)) return;
  acc.n++; acc.sum += r; acc.sq += r * r;
}
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
  return DIST_EDGES.length - 2;
}

// One station prediction. Returns {pga, pgv, intensity, rHypoKm, model}.
// forceModel (optional) pins the GMPE to a named model instead of 'auto'
// routing — used by fitModelBias for models the auto-router never emits
// (kanno2006, user-selectable for every source type). With no forceModel
// the path is unchanged.
function predictStation(ev, st, forceModel) {
  const rHypo = Physics.hypoDist(st.lat, st.lng, ev.lat, ev.lng, ev.depthKm);
  const model = forceModel || Physics.resolveGmpModel('auto', ev.sourceType, ev.mw);
  // Site-term convention, matching the app forecast default: zhao2006/kanno2006
  // take the station Vs30 NATIVELY (paper site classes inside the GMPE — no
  // external amplification on top, that would double-count site response).
  // si-midorikawa has no Vs30 input, so it predicts on a rock reference and
  // the external Physics.vs30Amplification factor supplies the site term.
  const nativeVs = model === 'zhao2006' || model === 'kanno2006';
  const refVs = nativeVs ? (st.vs30 && st.vs30 > 0 ? st.vs30 : 400) : undefined;
  let pga = Physics.calcPGA(ev.mw, rHypo, forceModel || 'auto', ev.depthKm, null, null, ev.sourceType,
    undefined, undefined, undefined, undefined, refVs);
  let pgv = Physics.calcPGV(ev.mw, rHypo, forceModel || 'auto', ev.depthKm, null, null, ev.sourceType,
    undefined, refVs);
  // External Vs30 site term only for the reference-site models.
  if (!nativeVs && st.vs30 && st.vs30 > 0) {
    pga *= Physics.vs30Amplification(st.vs30, 'pga');
    pgv *= Physics.vs30Amplification(st.vs30, 'pgv');
  }
  let intensity = Physics.calcJmaIntensity(pga, pgv);
  // Calibration exactly as the forecast path applies it (app.js
  // _predictPrefectureShindosFor / rt-eew.js forecastShindoAt): magnitude
  // bins plus the additive model/distance-keyed block when the table
  // carries one. Skip entirely with --no-calibration.
  intensity = Physics.calibrateIntensity(intensity, ev.mw, { model: model, distKm: rHypo });
  return { pga, pgv, intensity, rHypoKm: rHypo, model };
}

// Pure, deterministic report computation (no clock, no randomness).
// opts.hypoMode: 'jma' (default — app-catalog prediction hypocenters) or
// 'usgs' (frozen-file hypocenters, reproducing the original run).
function computeReport(obs, calibrationTable, opts) {
  const hypoMode = (opts && opts.hypoMode === 'usgs') ? 'usgs' : 'jma';
  const jmaHypos = hypoMode === 'jma' ? loadJmaHypocenters() : null;
  Physics.setGmpeCalibration(calibrationTable || null);
  const overall = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
  const overallDist = DIST_LABELS.map(() => ({ pga: newAcc(), pgv: newAcc(), intensity: newAcc() }));
  const byModel = {};
  const eventAccs = [];
  const events = [];

  for (const ev0 of obs.events) {
    const ev = predictionEvent(ev0, hypoMode, jmaHypos);
    const acc = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
    const dist = DIST_LABELS.map(() => ({ pga: newAcc(), pgv: newAcc(), intensity: newAcc() }));
    const model = Physics.resolveGmpModel('auto', ev.sourceType, ev.mw);
    if (!byModel[model]) byModel[model] = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
    let mmiSum = 0, mmiN = 0;
    for (const st of ev.stations) {
      if (!(st.pgaGal > 0) || !(st.pgvCms > 0)) continue;
      const pred = predictStation(ev, st);
      const obsI = Physics.calcJmaIntensity(st.pgaGal, st.pgvCms);
      const rPga = Math.log10(pred.pga / st.pgaGal);
      const rPgv = Math.log10(pred.pgv / st.pgvCms);
      const rI = pred.intensity - obsI;
      const bi = distBinIndex(pred.rHypoKm);
      for (const [key, r] of [['pga', rPga], ['pgv', rPgv], ['intensity', rI]]) {
        push(acc[key], r); push(overall[key], r);
        push(dist[bi][key], r); push(overallDist[bi][key], r);
        push(byModel[model][key], r);
      }
      if (typeof st.intensity === 'number') { mmiSum += pred.intensity - st.intensity; mmiN++; }
    }
    events.push({
      eventId: ev0.eventId, usgsId: ev0.usgsId, mw: ev.mw, depthKm: ev.depthKm,
      sourceType: ev.sourceType, model,
      // Prediction-side hypocenter actually used (additive; the USGS event
      // metadata above stays as frozen for provenance).
      predictionHypocenter: {
        mode: hypoMode,
        lat: ev.lat, lng: ev.lng, depthKm: ev.depthKm, mw: ev.mw,
        source: hypoMode === 'jma' ? jmaHypos[ev0.eventId].source : 'frozen obs file (USGS)',
        usgs: { lat: ev0.lat, lng: ev0.lng, depthKm: ev0.depthKm, mw: ev0.mw }
      },
      stations: acc.pga.n,
      pga: finalize(acc.pga), pgv: finalize(acc.pgv), intensity: finalize(acc.intensity),
      distanceBins: dist.map((d, i) => ({
        rangeKm: DIST_LABELS[i], pga: finalize(d.pga), pgv: finalize(d.pgv), intensity: finalize(d.intensity)
      })),
      // INFORMATIONAL ONLY — predicted JMA intensity minus shakemap MMI.
      // Different scales by construction (JMA 7 ~ MMI 9+); never a residual.
      crossScaleMmiReference: mmiN ? { n: mmiN, meanPredJmaMinusMmi: +(mmiSum / mmiN).toFixed(4) } : null
    });
    // Exact per-event accumulators for the correction evaluation below.
    eventAccs.push({ eventId: ev0.eventId, model, intensity: acc.intensity });
  }

  // Correction evaluation: reference what a blanket shift of the M>=6.5
  // magnitude bin (all frozen events fall in it) would do, computed exactly
  // (residual -> residual + s transforms bias -> bias + s and
  // E[r^2] -> E[r^2] + 2s*E[r] + s^2). Model/distance-keyed corrections
  // (calibration table `modelBias` block, applied when the caller passes
  // {model, distKm}) are already reflected in the headline residuals above.
  const nAll = overall.intensity.n;
  const shift = nAll ? -(overall.intensity.sum / nAll) : 0;
  const afterOverallSq = nAll
    ? (overall.intensity.sq + 2 * shift * overall.intensity.sum + nAll * shift * shift) / nAll : null;
  const correctionEvaluation = {
    type: 'blanket magnitude-bin (M>=6.5) additive intensity shift, evaluated as a '
      + 'reference; the shipped calibration may additionally carry a modelBias '
      + 'block keyed by routed model and hypocentral distance, which the '
      + 'prediction path applies through calibrateIntensity(I, mag, {model, distKm})',
    fittedShift: +shift.toFixed(4),
    overall: {
      before: finalize(overall.intensity),
      after: nAll ? { n: nAll, bias: 0, rms: +Math.sqrt(afterOverallSq).toFixed(4) } : null
    },
    perEvent: eventAccs.map(e => {
      const a = e.intensity;
      const bias = a.sum / a.n;
      const rms = Math.sqrt(a.sq / a.n);
      const rmsAfter = Math.sqrt((a.sq + 2 * shift * a.sum + a.n * shift * shift) / a.n);
      return {
        eventId: e.eventId, model: e.model, n: a.n,
        biasBefore: +bias.toFixed(4), rmsBefore: +rms.toFixed(4),
        biasAfter: +(bias + shift).toFixed(4), rmsAfter: +rmsAfter.toFixed(4)
      };
    })
  };

  return {
    schema: 'quake-sim-strong-motion-scorecard-v1',
    method: 'auto-routed GMPE (per-event app sourceType), hypocentral distance, reference-site GMPE '
      + '+ station-Vs30 Physics.vs30Amplification when present; observed JMA intensity derived from '
      + 'observed PGA/PGV via Physics.calcJmaIntensity (shakemap MMI never mixed in); '
      + 'Physics.calibrateIntensity applied with event Mw (plus {model, distKm} when the table '
      + 'carries a modelBias block) unless --no-calibration; prediction hypocenters: ' + hypoMode,
    hypocenterMode: hypoMode,
    calibrationApplied: !!calibrationTable,
    overall: {
      pga: finalize(overall.pga), pgv: finalize(overall.pgv), intensity: finalize(overall.intensity),
      distanceBins: overallDist.map((d, i) => ({
        rangeKm: DIST_LABELS[i], pga: finalize(d.pga), pgv: finalize(d.pgv), intensity: finalize(d.intensity)
      }))
    },
    byModel: Object.keys(byModel).sort().map(m => ({
      model: m, pga: finalize(byModel[m].pga), pgv: finalize(byModel[m].pgv),
      intensity: finalize(byModel[m].intensity)
    })),
    correctionEvaluation,
    events
  };
}

// Fit a model-keyed distance-binned correction for one routed model from
// JMA-hypocenter residuals: per-bin deltaI = -(measured bin bias), i.e.
// clipped to the measured bias by construction, hard-capped at +/-1.0
// intensity unit; bins without stations get no entry (no extrapolation
// beyond measured ranges). Any existing modelBias in the table is ignored
// for the fit so re-fitting never double-counts a shipped correction.
// A model the auto-router emits for at least one frozen event is fitted on
// its routed events only; a model it never emits (kanno2006 — user-
// selectable for every source type) is instead forced onto all events.
//
// R0-4: the residual collection and the pure bin fit are split out so the
// leave-one-event-out report (buildModelBiasLoeo) refits through exactly
// the deployed code path.
function collectModelBiasResiduals(obs, calibrationTable, model) {
  const jmaHypos = loadJmaHypocenters();
  const baseTable = calibrationTable
    ? Object.assign({}, calibrationTable, { modelBias: undefined }) : null;
  Physics.setGmpeCalibration(baseTable);
  const routable = obs.events.some(ev0 => {
    const ev = predictionEvent(ev0, 'jma', jmaHypos);
    return Physics.resolveGmpModel('auto', ev.sourceType, ev.mw) === model;
  });
  const events = [];
  for (const ev0 of obs.events) {
    const ev = predictionEvent(ev0, 'jma', jmaHypos);
    if (routable && Physics.resolveGmpModel('auto', ev.sourceType, ev.mw) !== model) continue;
    const stations = [];
    for (const st of ev.stations) {
      if (!(st.pgaGal > 0) || !(st.pgvCms > 0)) continue;
      const pred = predictStation(ev, st, routable ? undefined : model);
      const obsI = Physics.calcJmaIntensity(st.pgaGal, st.pgvCms);
      stations.push({
        residual: pred.intensity - obsI, distKm: pred.rHypoKm, mw: ev.mw,
        // Extra fields for the sigma-component / spatial-correlation fits
        // (R1): station coordinates and the ln-space PGA residual.
        lat: st.lat, lng: st.lng,
        lnPgaResidual: Math.log(pred.pga / st.pgaGal)
      });
    }
    if (stations.length) events.push({ eventId: ev.eventId, stations });
  }
  Physics.setGmpeCalibration(null);
  return { events, routable };
}

// Pure fit: per-event station residual lists -> per-distance-bin deltaI
// (null where the bin has no stations). Shared by the deployed fit and the
// leave-one-event-out refits.
function fitBinDeltas(events) {
  const bins = DIST_LABELS.map(() => newAcc());
  for (const ev of events) {
    for (const st of ev.stations) push(bins[distBinIndex(st.distKm)], st.residual);
  }
  return bins.map((b, i) => {
    if (!b.n) return null;
    const bias = b.sum / b.n;
    let deltaI = -bias;
    if (deltaI > 1) deltaI = 1; else if (deltaI < -1) deltaI = -1;
    return { minKm: DIST_EDGES[i], maxKm: DIST_EDGES[i + 1], bias, deltaI, n: b.n };
  });
}

// Published distBins shape for gmpe-calibration.json.
function fitDistBinsFromEvents(events) {
  const distBins = [];
  for (const b of fitBinDeltas(events)) {
    if (!b) continue;
    distBins.push({
      minKm: b.minKm === Infinity ? null : b.minKm,
      maxKm: b.maxKm === Infinity ? null : b.maxKm,
      measuredBias: +b.bias.toFixed(4), stations: b.n,
      deltaI: +b.deltaI.toFixed(3)
    });
  }
  return distBins;
}

function fitModelBias(obs, calibrationTable, model) {
  const { events } = collectModelBiasResiduals(obs, calibrationTable, model);
  return fitDistBinsFromEvents(events);
}

// Leave-one-event-out generalization report for the modelBias layer (R0-4):
// for each frozen event, refit the distance-binned deltaI from the OTHER
// events and score this event's stations with that refit correction
// (magnitude gate mirrors the deployed table). If the correction generalizes,
// held-out intensity RMS stays at or below the uncorrected RMS.
function buildModelBiasLoeo(obs, calibrationTable, model) {
  const { events, routable } = collectModelBiasResiduals(obs, calibrationTable, model);
  const gate = (calibrationTable && calibrationTable.modelBias
    && calibrationTable.modelBias[model]) || { minM: 7, maxM: Infinity };
  const correctionAt = (binDeltas, st) => {
    if (st.mw < (gate.minM == null ? 0 : gate.minM) || st.mw > (gate.maxM == null ? Infinity : gate.maxM)) return 0;
    return binDeltas[distBinIndex(st.distKm)] ? binDeltas[distBinIndex(st.distKm)].deltaI : 0;
  };
  const rms = rs => rs.length ? Math.sqrt(rs.reduce((s, r) => s + r * r, 0) / rs.length) : null;
  const r3 = v => v == null ? null : +v.toFixed(3);
  const deployedDeltas = fitBinDeltas(events);
  const deployed = fitDistBinsFromEvents(events);
  const folds = events.map(ev => {
    const refitDeltas = fitBinDeltas(events.filter(e => e !== ev));
    let un = [], held = [], dep = [];
    for (const st of ev.stations) {
      un.push(st.residual);
      held.push(st.residual + correctionAt(refitDeltas, st));
      dep.push(st.residual + correctionAt(deployedDeltas, st));
    }
    return {
      eventId: ev.eventId, stations: ev.stations.length,
      rmsUncorrected: r3(rms(un)), rmsHeldOutRefit: r3(rms(held)), rmsDeployed: r3(rms(dep))
    };
  });
  const binLevelHeld = rms(events.flatMap(ev => {
    const refitDeltas = fitBinDeltas(events.filter(e => e !== ev));
    return ev.stations.map(st => st.residual + correctionAt(refitDeltas, st));
  }));
  const binLevelUn = rms(events.flatMap(ev => ev.stations.map(st => st.residual)));
  const worse = binLevelHeld != null && binLevelUn != null && binLevelHeld > binLevelUn + 1e-9;
  return {
    schema: 'quake-sim-model-bias-loeo-v1',
    model, forcedFit: !routable,
    magnitudeGate: { minM: gate.minM == null ? null : gate.minM, maxM: gate.maxM == null || !isFinite(gate.maxM) ? null : gate.maxM },
    events: events.length,
    stations: events.reduce((s, e) => s + e.stations.length, 0),
    deployedDistBins: deployed,
    rmsUncorrected: r3(binLevelUn),
    rmsHeldOutLOO: r3(binLevelHeld),
    heldOutWorseThanUncorrected: worse,
    folds,
    conclusion: events.length < 2
      ? 'fewer than two events — leave-one-out not meaningful'
      : (worse
        ? 'held-out RMS exceeds uncorrected RMS: the modelBias correction does not generalize to unseen events'
        : 'held-out RMS does not exceed uncorrected RMS: no leave-one-out evidence of overfitting')
  };
}

function fmt(v, w) {
  const s = v == null ? '  null' : (v >= 0 ? '+' : '') + v.toFixed(3);
  return s.padStart(w || 7);
}

function printReport(report) {
  console.log('hypocenter mode:', report.hypocenterMode, '| calibration applied:', report.calibrationApplied);
  console.log('\nper event (log10 residuals for PGA/PGV, intensity units for I):');
  console.log('event             model          n  pgaBias pgaRms pgvBias pgvRms   iBias   iRms');
  for (const e of report.events) {
    console.log(
      e.eventId.padEnd(17), e.model.padEnd(14), String(e.stations).padStart(3),
      fmt(e.pga.bias), fmt(e.pga.rms), fmt(e.pgv.bias), fmt(e.pgv.rms),
      fmt(e.intensity.bias), fmt(e.intensity.rms));
  }
  const o = report.overall;
  console.log('OVERALL'.padEnd(17), ''.padEnd(14), String(o.pga.n).padStart(3),
    fmt(o.pga.bias), fmt(o.pga.rms), fmt(o.pgv.bias), fmt(o.pgv.rms),
    fmt(o.intensity.bias), fmt(o.intensity.rms));
  console.log('\noverall by hypocentral distance (intensity units):');
  console.log('rangeKm      n  pgaBias   iBias   iRms');
  for (const b of report.overall.distanceBins) {
    console.log(b.rangeKm.padEnd(10), String(b.intensity.n).padStart(4),
      fmt(b.pga.bias), fmt(b.intensity.bias), fmt(b.intensity.rms));
  }
  console.log('\noverall by routed model:');
  for (const m of report.byModel) {
    console.log(m.model.padEnd(14), String(m.intensity.n).padStart(4),
      fmt(m.pga.bias), fmt(m.pgv.bias), fmt(m.intensity.bias), fmt(m.intensity.rms));
  }
  const ce = report.correctionEvaluation;
  console.log('\ncorrection evaluation — reference blanket M>=6.5 shift', fmt(ce.fittedShift) + ':');
  console.log('event             model          n  iBiasBefore iBiasAfter iRmsBefore iRmsAfter');
  for (const e of ce.perEvent) {
    console.log(e.eventId.padEnd(17), e.model.padEnd(14), String(e.n).padStart(4),
      fmt(e.biasBefore, 11), fmt(e.biasAfter, 10), fmt(e.rmsBefore, 10), fmt(e.rmsAfter, 9));
  }
  console.log('overall intensity rms', ce.overall.before.rms, '->', ce.overall.after.rms);
  console.log('\ncross-scale reference (pred JMA I minus shakemap MMI; NOT a residual):');
  for (const e of report.events) {
    if (e.crossScaleMmiReference) {
      console.log(' ', e.eventId, fmt(e.crossScaleMmiReference.meanPredJmaMinusMmi));
    }
  }
}

function printComparison(primary, preMB, alt) {
  const rows = primary.events.map(e => {
    const b = preMB.events.find(x => x.eventId === e.eventId);
    const a = alt.events.find(x => x.eventId === e.eventId);
    return { id: e.eventId, full: e.intensity.bias, pre: b ? b.intensity.bias : null, alt: a ? a.intensity.bias : null };
  });
  console.log('\nbias progression (' + alt.hypocenterMode + ' raw -> ' + preMB.hypocenterMode
    + ' raw -> ' + primary.hypocenterMode + ' +modelBias, intensity bias):');
  for (const r of rows) {
    console.log(' ' + r.id.padEnd(17), fmt(r.alt), '->', fmt(r.pre), '->', fmt(r.full));
  }
  console.log(' OVERALL'.padEnd(17), fmt(alt.overall.intensity.bias), '->',
    fmt(preMB.overall.intensity.bias), '->', fmt(primary.overall.intensity.bias));
  console.log(' overall intensity rms:', alt.overall.intensity.rms, '->',
    preMB.overall.intensity.rms, '->', primary.overall.intensity.rms);
}

// Calibration table minus the modelBias block (magnitude bins unchanged) —
// used for the pre-correction comparison runs.
function stripModelBias(table) {
  if (!table || !table.modelBias) return table || null;
  const t = Object.assign({}, table);
  delete t.modelBias;
  return t;
}

function main() {
  const args = process.argv.slice(2);
  const obsArg = args.find(a => a.startsWith('--obs='));
  const outArg = args.find(a => a.startsWith('--out='));
  const fitArg = args.find(a => a.startsWith('--fit-model-bias='));
  const loeoArg = args.find(a => a.startsWith('--loeo-model-bias'));
  const loeoModels = loeoArg && loeoArg.includes('=') ? loeoArg.split('=')[1].split(',')
    : ['zhao2006', 'si-midorikawa'];
  const obsPath = obsArg ? obsArg.split('=')[1] : 'public/geojson/strong-motion-obs.json';
  const outPath = outArg ? outArg.split('=')[1] : 'tools/data/strong-motion-report.json';
  const useCalibration = !args.includes('--no-calibration');
  const hypoMode = args.includes('--usgs-hypo') ? 'usgs' : 'jma';

  const obs = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
  if (obs.schema !== 'quake-sim-strong-motion-obs-v1') {
    throw new Error('unsupported obs schema: ' + obs.schema);
  }
  let calibration = null;
  if (useCalibration) {
    const calPath = path.join('public', 'geojson', 'gmpe-calibration.json');
    calibration = JSON.parse(fs.readFileSync(calPath, 'utf8'));
  }

  if (loeoArg) {
    // Leave-one-event-out generalization report for the modelBias layer
    // (R0-4); report-only, never rewrites the calibration table.
    const models = {};
    for (const model of loeoModels) {
      const r = buildModelBiasLoeo(obs, calibration, model);
      models[model] = r;
      console.log(`${model}: events=${r.events} stations=${r.stations} `
        + `LOO held-out intensity RMS ${r.rmsHeldOutLOO} vs uncorrected ${r.rmsUncorrected}`);
      console.log('  ' + r.conclusion);
    }
    const out = {
      schema: 'quake-sim-model-bias-loeo-bundle-v1',
      generatedAt: new Date().toISOString(),
      obsSource: obsPath,
      models
    };
    fs.writeFileSync('tools/data/model-bias-loeo-report.json', JSON.stringify(out, null, 2) + '\n');
    console.log('wrote tools/data/model-bias-loeo-report.json');
    return;
  }

  if (fitArg) {
    // Print the fitted modelBias distBins block (JMA hypocenters); merge it
    // into gmpe-calibration.json by hand after review — the tool never
    // rewrites the calibration table itself.
    const model = fitArg.split('=')[1];
    const distBins = fitModelBias(obs, calibration, model);
    console.log(JSON.stringify({ model: model, distBins: distBins }, null, 2));
    return;
  }

  const report = computeReport(obs, calibration, { hypoMode: hypoMode });
  // Comparison blocks (additive, each a self-contained v1 report):
  //  * preModelBiasRun — same hypocenters, calibration minus modelBias:
  //    isolates the model-keyed correction. With --usgs-hypo this block
  //    reproduces the original pre-correction run's numbers.
  //  * <alt>HypocenterRun — the other hypocenter mode, also minus
  //    modelBias: isolates the hypocenter fix. The default-mode file's
  //    usgsHypocenterRun is therefore the preserved original (USGS
  //    hypocenters, magnitude-bin calibration only) report block.
  const altMode = hypoMode === 'jma' ? 'usgs' : 'jma';
  const rawCal = stripModelBias(calibration);
  const preMB = computeReport(obs, rawCal, { hypoMode: hypoMode });
  const alt = computeReport(obs, rawCal, { hypoMode: altMode });
  const jmaHypos = loadJmaHypocenters();
  const out = Object.assign({}, report, {
    schema: 'quake-sim-strong-motion-scorecard-v2',
    jmaHypocenters: Object.keys(jmaHypos).sort().map(id => Object.assign({ eventId: id }, jmaHypos[id])),
    preModelBiasRun: Object.assign({}, preMB, {
      note: 'same hypocenter mode as the primary report, calibration table without the modelBias block'
    })
  });
  out[altMode === 'usgs' ? 'usgsHypocenterRun' : 'jmaHypocenterRun'] = Object.assign({}, alt, {
    note: 'alternate hypocenter mode, calibration table without the modelBias block'
      + (altMode === 'usgs' ? ' — preserves the original USGS-hypocenter report numbers' : '')
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  printReport(report);
  printComparison(report, preMB, alt);
  console.log('\nwrote ' + outPath);
}

if (require.main === module) {
  main();
}

module.exports = { computeReport, predictStation, fitModelBias, buildModelBiasLoeo,
  collectModelBiasResiduals, fitDistBinsFromEvents, loadJmaHypocenters, DIST_LABELS, DIST_EDGES };
