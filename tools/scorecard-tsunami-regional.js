#!/usr/bin/env node
'use strict';
// ================================================================
//  Regional tsunami coastal scorecard (v6.7 C batch): run the bundled
//  nonlinear tsunami solver headlessly for every event in
//  public/geojson/region_tsunami_observations.json on its REGIONAL
//  bathymetry grid (cl-megathrust / nz-aotearoa) and score predicted
//  coastal heights against the curated observations via
//  TsunamiValidation.evaluate.
//
//  Differences from tools/scorecard-tsunami.js (Japan):
//    * grid comes from each event's `regionalGrid` field and the solver runs
//      STANDALONE on it — the regional grids sit outside the Japan global
//      grid, so the app's `_bathyCoarseCovers` gate runs them single-grid
//      without checkpoints; the scorecard mirrors that (no AMR nesting).
//    * no forecast-area classification: regional warning areas are an
//      app-side registry construct, not a frozen observation set (documented
//      in the dataset quality note).
//    * per-event horizons (EVENT_HORIZONS): Kaikoura's later gauge maxima
//      (Sumner ~4 h) are only partially covered at 7200 s — recorded
//      honestly per event in the report.
//
//  Source models: synthetic Wells & Coppersmith / Strasser ruptures with the
//  region-pack preset mechanisms (GCMT-derived), the same synthetic path the
//  app runs for region presets without a bundled finite-fault model. Kaikōura
//  in particular ruptured ~a dozen faults; a single-plane synthetic source is
//  a crude stand-in — residuals measure the runtime model, honestly.
//
//  Usage: node tools/scorecard-tsunami-regional.js [--write]
// ================================================================
const fs = require('fs');
const path = require('path');

const Physics = require('../public/physics.js');
const DC3D = require('../public/dc3d.js');
const TsunamiValidation = require('../public/tsunami-validation.js');
const CFG = require('../public/config.js').CFG_DEFAULTS;

global.DC3D = global.DC3D || DC3D; // physics.js references the bare global

const ROOT = path.resolve(__dirname, '..');
const dataset = require(path.join(ROOT, 'public/geojson/region_tsunami_observations.json'));

const GRID_CACHE = {};
function gridFor(rid) {
  if (!GRID_CACHE[rid]) {
    GRID_CACHE[rid] = require(path.join(ROOT, 'public/geojson/grids', rid + '.json'));
  }
  return GRID_CACHE[rid];
}

// Per-event horizons (sim seconds): the curated observation types mix
// near-field runups (first arrivals within minutes) with later gauge maxima.
// Kaikōura's Sumner gauge peaked ~4 h after origin (Heidarzadeh & Satake
// 2017); a 7200 s horizon covers the dominant energy but may under-sample
// that latest maximum — recorded in the report's horizonNote.
const EVENT_HORIZONS = { maule2010: 5400, illapel2015: 5400, kaikoura2016: 7200 };

// Region-pack preset mechanisms (ComCat/GCMT-curated; source of truth for
// the app's own synthetic rupture path).
const EVENT_MECHANISMS = {
  maule2010: { strike: 19, dip: 18, rake: 116 },
  illapel2015: { strike: 5, dip: 22, rake: 106 },
  kaikoura2016: { strike: 219, dip: 38, rake: 128 }
};

const dflt = k => CFG[k].v;

function buildSource(event) {
  const mech = EVENT_MECHANISMS[event.id];
  if (!mech) throw new Error('no curated mechanism for ' + event.id);
  const geometry = Physics.genSubSources(event.lat, event.lng, event.mw, mech.strike, mech.dip, event.depthKm, dflt('rupSpeed'), {});
  return {
    lat: event.lat, lng: event.lng, depthKm: event.depthKm,
    mag: event.mw, mw: event.mw,
    strikeDeg: mech.strike, dipDeg: mech.dip, rakeDeg: mech.rake,
    averageSlipM: geometry && geometry.averageSlipM,
    geometry
  };
}

function runEvent(event) {
  const horizon = EVENT_HORIZONS[event.id] || 3600;
  const t0 = Date.now();
  const source = buildSource(event);
  const solver = Physics.createNonlinearTsunamiSolver(gridFor(event.regionalGrid), source, {
    manning: dflt('tsunamiManning'), dryTolerance: dflt('tsunamiDryTolerance'),
    arrivalThreshold: dflt('tsunamiArrivalThreshold'),
    coriolis: dflt('tsunamiCoriolis') !== 'off',
    boundary: dflt('tsunamiBoundary') === 'radiation' ? 'radiation' : 'wall'
  });
  if (!solver) throw new Error('solver unavailable for ' + event.id);
  const arrivals = (event.observations || []).map(() => null);
  const arrivalGate = 1.5 * dflt('tsunamiArrivalThreshold');
  let tNow = 0;
  while (tNow < horizon) {
    const tNext = Math.min(tNow + 60, horizon);
    solver.advanceTo(tNext);
    tNow = tNext;
    (event.observations || []).forEach((obs, oi) => {
      if (arrivals[oi] !== null) return;
      const st = solver.sampleState(obs.lat, obs.lng);
      if (st && Math.abs(st.eta) >= arrivalGate) arrivals[oi] = tNow;
    });
  }
  const observations = (event.observations || []).map((obs, oi) => {
    const row = {
      id: obs.id,
      peakHeightM: Math.abs(Physics.tsunamiCoastalHeight(solver, obs.lat, obs.lng, 10, 5))
    };
    if (arrivals[oi] !== null && event.originTime) {
      row.arrivalTime = new Date(Date.parse(event.originTime) + arrivals[oi] * 1000).toISOString();
    }
    return row;
  });
  return {
    id: event.id,
    grid: event.regionalGrid,
    nested: false,
    horizonS: horizon,
    solverSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    model: 'synthetic-' + (EVENT_MECHANISMS[event.id] ? 'pack-preset-mechanism' : 'unknown'),
    observations
  };
}

function main() {
  const check = TsunamiValidation.validate(dataset);
  if (!check.valid) throw new Error('dataset invalid: ' + check.errors.join(','));
  const predictions = { schema: 'quake-sim-tsunami-predictions-v1', generatedAt: new Date().toISOString(), events: [] };
  for (const event of dataset.events) {
    const result = runEvent(event);
    predictions.events.push(result);
    console.log(`${event.id}: ${result.observations.length} points, grid=${result.grid}, horizon=${result.horizonS}s, ${result.solverSeconds}s`);
    for (const obs of result.observations) {
      const truth = event.observations.find(o => o.id === obs.id);
      console.log(`  ${obs.id}: predicted ${obs.peakHeightM.toFixed(2)} m vs observed ${truth.peakHeightM} m (${truth.type})`);
    }
  }
  const report = TsunamiValidation.evaluate(dataset, predictions);
  console.log('\nheight residuals by type (predicted − observed, m):');
  for (const type of Object.keys(report.heightByType)) {
    const m = report.heightByType[type];
    console.log(`  ${type}: n=${m.count} bias=${m.bias.toFixed(2)} rms=${m.rms.toFixed(2)} mae=${m.mae.toFixed(2)}`);
  }
  console.log(`missing observations: ${report.missingObservations}`);
  if (process.argv.includes('--write')) {
    const outDir = path.join(ROOT, 'tools/data');
    fs.writeFileSync(path.join(outDir, 'region-tsunami-scorecard-predictions.json'), JSON.stringify(predictions, null, 2));
    fs.writeFileSync(path.join(outDir, 'region-tsunami-scorecard-report.json'), JSON.stringify({
      ...report,
      horizonNote: 'per-event horizons: ' + JSON.stringify(EVENT_HORIZONS)
        + '; Kaikōura Sumner gauge observed maximum arrived ~4 h after origin (outside the 7200 s horizon)'
        + ' — the scorecard may under-sample that latest maximum.',
      note: 'regional standalone single-grid runs (no AMR nesting — the regional grids sit outside the Japan '
        + 'global grid; mirrors the app _bathyCoarseCovers gate). No forecast-area classification: regional '
        + 'warning areas are an app-side registry, not a frozen observation set.'
    }, null, 2));
    console.log('wrote tools/data/region-tsunami-scorecard-{predictions,report}.json');
  }
  return { predictions, report };
}

if (require.main === module) main();
module.exports = { runEvent, buildSource, dataset, EVENT_HORIZONS, EVENT_MECHANISMS, gridFor };
