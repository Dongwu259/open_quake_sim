'use strict';
// ================================================================
//  Tsunami coastal scorecard: run the bundled tsunami model headlessly for
//  every historical event in geojson/historical_tsunami_observations.json
//  and score predicted coastal heights against the curated observations
//  (runup / tide-gauge / inundation points) via TsunamiValidation.evaluate.
//
//  Usage: node tools/scorecard-tsunami.js [--write] [--horizon=3600]
//    --write   persist predictions + report under tools/data/
//
//  Caveat: the bundled terrain grid is a 0.15° block-mean resample of the
//  GEBCO 2025 Grid (water-mean for mixed coastal cells). Ria-coast runup is
//  resolution-limited at 16.7 km cells, so absolute residuals measure what
//  users see, not site-specific engineering accuracy. Track TRENDS.
// ================================================================
const fs = require('fs');
const path = require('path');

const Physics = require('../public/physics.js');
const DC3D = require('../public/dc3d.js'); // registers global DC3D used by buildOkadaDeformation
const FiniteFault = require('../public/finite-fault.js');
const ObservedFaultModels = require('../public/observed-fault-models.js');
const TsunamiValidation = require('../public/tsunami-validation.js');
const CFG = require('../public/config.js').CFG_DEFAULTS;

global.DC3D = global.DC3D || DC3D; // physics.js references the bare global

const ROOT = path.resolve(__dirname, '..');
const grid = require(path.join(ROOT, 'public/geojson/bathymetry.json'));
const dataset = require(path.join(ROOT, 'public/geojson/historical_tsunami_observations.json'));

// Events whose epicenter sits inside a bundled high-resolution regional grid
// (public/geojson/grids/, GEBCO 2025 0.025° resamples) run on that grid —
// ria-coast runup is resolution-limited on the 0.15° global grid.
const EVENT_REGIONAL_GRIDS = { tohoku2011: 'jp-sanriku', noto2024: 'jp-noto', hokkaido1993: 'jp-hokkaido-sw' };
// Diagnostic override (does not touch the default path or written reports):
//   --grid=tohoku2011:jp-sanriku-gsi  — run one event on a merged/pilot grid.
const GRID_OVERRIDES = {};
(function () {
  const a = process.argv.find(x => x.startsWith('--grid='));
  if (!a) return;
  for (const pair of a.slice(7).split(',')) {
    const [ev, rid] = pair.split(':');
    if (ev && rid) GRID_OVERRIDES[ev] = rid;
  }
})();
function gridForEvent(event) {
  const rid = GRID_OVERRIDES[event.id] || EVENT_REGIONAL_GRIDS[event.id];
  if (rid) {
    const p = path.join(ROOT, 'public/geojson/grids', rid + '.json');
    if (fs.existsSync(p)) {
      try { return require(p); } catch (e) { /* fall through to the global grid */ }
    }
  }
  return grid;
}

const WRITE = process.argv.includes('--write');
const horizonArg = process.argv.find(a => a.startsWith('--horizon='));
const HORIZON_S = horizonArg ? Number(horizonArg.split('=')[1]) : 3600;
const nestedArg = process.argv.find(a => a.startsWith('--nested='));
const NESTED_MODE = nestedArg ? nestedArg.split('=')[1] : 'auto';
function globalGridRef() { return grid; }
const dflt = k => CFG[k].v;

// Observed slip models bundled for some events; the rest use a synthetic
// Wells & Coppersmith / Strasser plane with an assumed mechanism (noted).
const EVENT_MODELS = { tohoku2011: 'tohoku', noto2024: 'noto2024' };
const SYNTHETIC_MECHANISMS = {
  // 1993-07-12 Hokkaido Nansei-oki: JMA/Harvard CMT reverse fault on the
  // Japan trench-ward margin of the Sea of Japan — assumed mechanism.
  hokkaido1993: { strike: 190, dip: 30, rake: 90 }
};

function buildSource(event) {
  const modelId = EVENT_MODELS[event.id];
  if (modelId) {
    const model = FiniteFault.parse(ObservedFaultModels.get(modelId));
    return {
      lat: event.lat, lng: event.lng, depthKm: event.depthKm,
      mag: event.mw, mw: event.mw,
      strikeDeg: model.representativePlane.strikeDeg, dipDeg: model.representativePlane.dipDeg,
      rakeDeg: model.representativePlane.rakeDeg,
      averageSlipM: model.geometry.averageSlipM,
      geometry: model.geometry
    };
  }
  const mech = SYNTHETIC_MECHANISMS[event.id] || { strike: 0, dip: 45, rake: 90 };
  // Same synthetic rupture path the app uses (moment-conserving subsources),
  // so the scorecard measures the runtime model, not a shortcut.
  const geometry = Physics.genSubSources(event.lat, event.lng, event.mw, mech.strike, mech.dip, event.depthKm, dflt('rupSpeed'), {});
  return {
    lat: event.lat, lng: event.lng, depthKm: event.depthKm,
    mag: event.mw, mw: event.mw,
    strikeDeg: mech.strike, dipDeg: mech.dip, rakeDeg: mech.rake,
    averageSlipM: geometry && geometry.averageSlipM,
    geometry: geometry
  };
}

function runEvent(event) {
  const t0 = Date.now();
  const source = buildSource(event);
  const grid = gridForEvent(event);
  const solverOpts = {
    manning: dflt('tsunamiManning'), dryTolerance: dflt('tsunamiDryTolerance'),
    arrivalThreshold: dflt('tsunamiArrivalThreshold'),
    coriolis: dflt('tsunamiCoriolis') !== 'off',
    boundary: dflt('tsunamiBoundary') === 'radiation' ? 'radiation' : 'wall',
    // v5.8 R5-2 A/B: --dispersion=boussinesq runs the dispersive arm;
    // --dtopo=per-patch runs the per-subfault timing arm
    dispersion: process.argv.find(a => a.startsWith('--dispersion='))?.split('=')[1] === 'boussinesq' ? 'boussinesq' : 'off',
    dtopoTiming: process.argv.find(a => a.startsWith('--dtopo='))?.split('=')[1] === 'per-patch' ? 'per-patch' : 'cumulative'
  };
  // Two-level AMR: regional-grid events run as a fine level over the global
  // grid (mirrors the app's tsunamiNested:'auto' path); --nested=off restores
  // the sealed single-grid regional box for A/B measurement.
  let nestedUsed = false;
  let solver = null;
  if (NESTED_MODE !== 'off' && grid !== globalGridRef()) {
    solver = Physics.createNestedTsunamiSolver(globalGridRef(), grid, source, solverOpts);
    nestedUsed = !!solver;
  }
  if (!solver) solver = Physics.createNonlinearTsunamiSolver(grid, source, solverOpts);
  if (!solver) throw new Error('solver unavailable for ' + event.id);
  // v5.8 R5-6: track first-arrival times (|eta| past the arrival threshold)
  // at 60 s resolution while advancing, so the report can score arrival
  // residuals once curated observations carry arrivalTime fields.
  const arrivals = (event.observations || []).map(() => null);
  const arrivalGate = 1.5 * dflt('tsunamiArrivalThreshold');
  let tNow = 0;
  while (tNow < HORIZON_S) {
    const tNext = Math.min(tNow + 60, HORIZON_S);
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
  const forecastAreas = predictForecastAreas(event, solver);
  return {
    id: event.id,
    nested: nestedUsed,
    solverSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    model: EVENT_MODELS[event.id] || 'synthetic',
    observations,
    forecastAreas
  };
}

// ---- Forecast-area warning levels (restored 2026-08-17) ----
// The JMA 66-segment coastline geometry (jma_tsunami_forecast_areas.json)
// gives every forecast area's shoreline; the maximum modelled coastal height
// along it feeds the app's jmaTsunamiForecast decision — no conservative
// envelope and no user uplift, i.e. the pure physical baseline. The scorecard
// used to delete the resulting confusion matrix "rather than report 0% hit
// rates"; the honest baseline is now recorded and tracked instead.
const AREA_LEVEL_MAP = { major: 'major', warn: 'warning', adv: 'advisory' };
const AREA_GEOMETRY = require(path.join(ROOT, 'public/geojson/jma_tsunami_forecast_areas.json'));
const AREA_BY_CODE = Object.create(null);
for (const f of AREA_GEOMETRY.features || []) AREA_BY_CODE[String(f.properties.code)] = f;
function predictForecastAreas(event, solver) {
  return (event.forecastAreas || []).map(area => {
    const feature = AREA_BY_CODE[String(area.code)];
    let maxH = 0;
    if (feature && feature.geometry) {
      const lines = feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates : [feature.geometry.coordinates];
      for (const line of lines) {
        for (let i = 0; i < line.length; i += 2) {
          const h = Math.abs(Physics.tsunamiCoastalHeight(solver, line[i][1], line[i][0], 10, 5));
          if (h > maxH) maxH = h;
        }
      }
    }
    const fc = Physics.jmaTsunamiForecast(maxH, 0, 1);
    return {
      code: area.code,
      physicalHeightM: +maxH.toFixed(3),
      predictedLevel: fc.level ? AREA_LEVEL_MAP[fc.level] : 'none'
    };
  });
}

function main() {
  const check = TsunamiValidation.validate(dataset);
  if (!check.valid) throw new Error('dataset invalid: ' + check.errors.join(','));
  const predictions = { schema: 'quake-sim-tsunami-predictions-v1', generatedAt: new Date().toISOString(), events: [] };
  for (const event of dataset.events) {
    const result = runEvent(event);
    predictions.events.push(result);
    console.log(`${event.id}: ${result.observations.length} points, model=${result.model}, ${result.solverSeconds}s`);
    for (const obs of result.observations) {
      const truth = event.observations.find(o => o.id === obs.id);
      console.log(`  ${obs.id}: predicted ${obs.peakHeightM.toFixed(2)} m vs observed ${truth.peakHeightM} m`);
    }
  }
  const report = TsunamiValidation.evaluate(dataset, predictions);
  // Forecast-area classification IS scored now (restored 2026-08-17): the
  // physical-baseline confusion matrix is recorded as the honest baseline for
  // the v5.4 nested-grid remediation instead of being silently dropped.
  const cm = report.confusionMatrix, cl = report.classification;
  console.log('\nforecast-area confusion (rows observed / cols predicted):');
  console.log('  ' + cm.labels.map(l => String(l).padEnd(9)).join(''));
  for (let a = 0; a < 4; a++) {
    console.log('  ' + String(cm.labels[a]).padEnd(9) + cm.matrix[a].map(n => String(n).padEnd(9)).join(''));
  }
  console.log(`  hits=${cl.hits} misses=${cl.misses} falseAlarms=${cl.falseAlarms} hitRate=${cl.hitRate === null ? 'n/a' : (cl.hitRate * 100).toFixed(1) + '%'} falseAlarmRate=${cl.falseAlarmRate === null ? 'n/a' : (cl.falseAlarmRate * 100).toFixed(1) + '%'}`);
  console.log('\nheight residuals by type (predicted − observed, m):');
  for (const type of Object.keys(report.heightByType)) {
    const m = report.heightByType[type];
    console.log(`  ${type}: n=${m.count} bias=${m.bias.toFixed(2)} rms=${m.rms.toFixed(2)} mae=${m.mae.toFixed(2)}`);
  }
  console.log(`missing observations: ${report.missingObservations}`);
  if (WRITE) {
    const outDir = path.join(ROOT, 'tools/data');
    fs.writeFileSync(path.join(outDir, 'tsunami-scorecard-predictions.json'), JSON.stringify(predictions, null, 2));
    fs.writeFileSync(path.join(outDir, 'tsunami-scorecard-report.json'), JSON.stringify(report, null, 2));
    console.log('wrote tools/data/tsunami-scorecard-{predictions,report}.json');
  }
  return { predictions, report };
}

if (require.main === module) main();
module.exports = { runEvent, buildSource, dataset, HORIZON_S };
