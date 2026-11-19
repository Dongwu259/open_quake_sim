#!/usr/bin/env node
'use strict';
// =====================================================================
//  cli/simulate.js — headless simulation runner (v1, 2026-11-17).
//
//  Scenario spec or preset in → per-station physical results + aftershock
//  catalog (+ optional PSHA point curves) out as ONE JSON document. No DOM,
//  no display layer: the per-station numbers come from the SAME engine
//  primitives the web app consumes (createGroundMotionContext →
//  predictStationMotion), so a CLI run is the deterministic contract twin
//  of the browser run for the same config.
//
//  v1 scope (documented honestly):
//   - single events and chains: each event (chain sub-event) is processed
//     independently; the `combined` block is max-over-events per station,
//     NOT envelope superposition (the browser's live summing is display
//     semantics).
//   - intensity method: the shipped default `empirical` only (motion.intensity);
//     the jma3c display path is out of scope.
//   - site model: the shipped default `vs30` path (geo soil amp / eqlin-1d
//     bedrock profiles are app-side terrain loaders, not wired here).
//   - land + seafloor stations in the browser merge order (ids continue).
//   - aftershock outputs are the CATALOG only (time in real seconds, 30-day
//     window); the browser's per-station aftershock shim (vs30 pinned 400)
//     is display semantics, not reproduced.
//   - no EEW detection tracks / prefecture forecast fields / bulletins / TTS.
//
//  Usage:
//    node cli/simulate.js --preset tokyoInland --out result.json
//    node cli/simulate.js --preset tohoku --psha --out result.json
//    node cli/simulate.js --spec scenario.json [--seed 20260725]
//         [--config overrides.json] [--out result.json]
//  spec: {lat,lng,mag,depth,strike?,dip?,rake?,mechanismKnown?,sourceType?,
//         faultModel?,manualAftershocks?:[{timeSec,mag,depth?}],label?}
// =====================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Physics = require('../public/physics.js');
const Config = require('../public/config.js');
const Research = require('../public/research.js');
const FiniteFault = require('../public/finite-fault.js');
const ObservedModels = require('../public/observed-fault-models.js');
const PRESET_CATALOG = require('../public/presets-catalog.js');

const AS_TIME_SCALE = 21600; // aftershock.js AS_TIME_SCALE (real sec per sim sec)
const SCHEMA = 'quake-sim-cli-simulation-v1';

function die(msg) { console.error('cli/simulate: ' + msg); process.exit(1); }

function parseArgs(argv) {
  const args = { psha: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') args.preset = argv[++i];
    else if (a === '--spec') args.spec = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--psha') args.psha = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else die('unknown argument: ' + a + ' (see --help)');
  }
  return args;
}

function cfg(k) { return Config.cfgGet(k); }

// ---- data loaders (same files the browser fetches) --------------------
function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function loadVs30Grid() {
  try {
    const g = loadJson('public/geojson/vs30.json');
    const check = Physics.validateResearchGrid(g, 'vs30');
    return check.valid ? g : null; // mirror the browser: invalid → null
  } catch (e) { return null; }
}
function makeVs30Lookup(grid) {
  // mirror app.js _externalVs30Lookup: J-SHIS grid first, station value second
  return function (lat, lng) {
    const v = Physics.lookupResearchGrid(grid, lat, lng);
    if (v && v > 0) return { value: v, source: (grid.meta && grid.meta.vs30SourceClass) || 'j-shis-grid' };
    return null;
  };
}

// ---- ocean/land determination (mirror isOceanPoint semantics) ----------
function makeOceanCheck(prefGeo, bathyGrid) {
  const feats = (prefGeo && prefGeo.features) || [];
  const boxes = feats.map(function (f) {
    let w = 180, e = -180, s = 90, n = -90;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : (f.geometry.coordinates || []);
    for (const poly of polys) for (const ring of poly) for (const pt of ring) {
      if (pt[0] < w) w = pt[0]; if (pt[0] > e) e = pt[0];
      if (pt[1] < s) s = pt[1]; if (pt[1] > n) n = pt[1];
    }
    return [s, n, w, e];
  });
  function inRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function isLand(lat, lng) {
    for (let i = 0; i < feats.length; i++) {
      const bb = boxes[i];
      if (lat < bb[0] || lat > bb[1] || lng < bb[2] || lng > bb[3]) continue;
      const f = feats[i];
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : (f.geometry.coordinates || []);
      for (const poly of polys) {
        // even-odd across ALL rings of one polygon — holes toggle back out
        let crossings = 0;
        for (const ring of poly) if (inRing(lng, lat, ring)) crossings++;
        if (crossings % 2 === 1) return true;
      }
    }
    return false;
  }
  return function isOcean(lat, lng) {
    if (isLand(lat, lng)) return false;
    const d = Physics.lookupResearchGrid(bathyGrid, lat, lng);
    // the grid stores ELEVATION: negative = water (mirror _waterDepth:
    // d >= 0 → land, d < 0 → ocean at -d)
    if (d !== null && d !== undefined) return d < 0;
    return false; // no reliable data → assume land (browser-safe default)
  };
}

// ---- source resolution (mirror buildSourceModel/_faultOpts) ------------
function faultOptions(sourceType) {
  return {
    randomSeed: Research.normalizeSeed(cfg('randomSeed')),
    hypocenterFrac: cfg('hypocenterFrac'),
    slipPerturbation: cfg('slipPerturbation'),
    ruptureVelocityModel: cfg('ruptureVelocityModel'),
    sourceTimeFunction: cfg('sourceTimeFunction'),
    rigidityGPa: sourceType === 'intraslab' ? 50 : (sourceType === 'interplate' ? 40 : 30)
  };
}
function parseFaultModel(id) {
  const raw = ObservedModels.get(id);
  if (!raw) die('faultModel not found in the bundled catalog: ' + id);
  return FiniteFault.parse(raw);
}
function modalPatchStrike(model) {
  // mirror _activatePresetFaultModel: modal patch strike overrides the
  // moment-weighted axial representative strike for the displayed plane
  const votes = {};
  for (const p of model.patches) votes[p.strikeDeg] = (votes[p.strikeDeg] || 0) + 1;
  let best = 0, strike = model.representativePlane.strikeDeg;
  for (const k in votes) if (votes[k] > best) { best = votes[k]; strike = Number(k); }
  return strike;
}
function resolveEvent(ev, oceanCheck) {
  // mirror the browser's preset activation: a faultModel preset takes its
  // source parameters from the PARSED model (epicenter/mw/depth from event,
  // strike = modal patch strike, dip/rake = representative plane)
  let src = {
    lat: ev.lat, lng: ev.lng, mag: ev.mag, depthKm: ev.depth,
    strike: ev.strike, dip: ev.dip, rake: ev.rake,
    mechanismKnown: !!ev.mechanismKnown, faultModel: ev.faultModel || null,
    sourceTypeOverride: ev.sourceType || null, time: ev.time != null ? ev.time : null,
  };
  let ff = null;
  if (ev.faultModel) {
    ff = parseFaultModel(ev.faultModel);
    const plane = ff.representativePlane;
    src = {
      lat: ff.event.lat, lng: ff.event.lng, mag: ff.mw, depthKm: ff.event.depthKm,
      strike: modalPatchStrike(ff), dip: plane.dipDeg, rake: plane.rakeDeg,
      mechanismKnown: true, faultModel: ev.faultModel,
      sourceTypeOverride: ff.event.sourceType || ev.sourceType || null,
      time: ev.time != null ? ev.time : null,
    };
  }
  const offshore = oceanCheck(src.lat, src.lng);
  const sourceType = Physics.resolveSourceTypeAt(src.lat, src.lng, src.depthKm,
    src.sourceTypeOverride, cfg('sourceTypeOverride'), offshore);
  return { src: src, ff: ff, sourceType: sourceType, offshore: offshore };
}

function computeEvent(evResolved, stations, vs30Lookup, idx, label) {
  const src = evResolved.src;
  const ffGeom = evResolved.ff ? evResolved.ff.geometry : null;
  const canonical = Physics.createSourceModel({
    lat: src.lat, lng: src.lng, mag: src.mag, mw: src.mag, depthKm: src.depthKm,
    strikeDeg: src.strike, dipDeg: src.dip != null ? src.dip : 60, rakeDeg: src.rake != null ? src.rake : 0,
    mechanismKnown: src.mechanismKnown, finiteFault: evResolved.ff,
    momentTensor: null, mechanismProvenance: null, faultPlaneIndex: null,
    sourceType: evResolved.sourceType, faultOptions: faultOptions(evResolved.sourceType),
    generateSubSources: true, rupSpeed: cfg('rupSpeed'), originTime: 0
  });
  const useFF = canonical.mag >= 6.5 || !!canonical.finiteFault;
  const ff = useFF ? canonical.geometry : null;
  let gmpResolved = cfg('gmpModel');
  if (gmpResolved === 'auto') gmpResolved = Physics.resolveGmpModel(gmpResolved, evResolved.sourceType, canonical.mag);
  const context = Physics.createGroundMotionContext({
    lat: canonical.lat, lng: canonical.lng, mag: canonical.mag, mw: canonical.mw,
    depthKm: canonical.depthKm, strikeDeg: canonical.strikeDeg,
    dipDeg: canonical.dipDeg, sourceType: canonical.sourceType
  }, {
    gmpModel: gmpResolved, geometry: ff, finiteFault: useFF, rupSpeed: cfg('rupSpeed'),
    attA: cfg('attA'), attB: cfg('attB'), attC: cfg('attC'), anelastic: cfg('anelastic'),
    siteModel: cfg('siteModel'), siteBase: cfg('siteBase'), siteSoftMax: cfg('siteSoftMax'),
    siteHardMin: cfg('siteHardMin'), siteNonlinear: cfg('siteNonlinear'),
    directivity: cfg('directivity')
  });
  if (cfg('intensityMethod') !== 'empirical') {
    console.error('cli/simulate: intensityMethod ' + cfg('intensityMethod') + ' not supported in v1 — using empirical (documented scope)');
  }
  const rows = [];
  for (let i = 0; i < stations.length; i++) {
    const pt = stations[i];
    const stationFactor = 0.82 + Research.randomAt(cfg('randomSeed'), 'station-factor:' + (pt.id != null ? pt.id : (pt.lat + ',' + pt.lng)), 0) * 0.36;
    const vs30Details = Physics.lookupVs30Details(pt.lat, pt.lng, pt.vs30, vs30Lookup, 'station-estimate');
    const motion = Physics.predictStationMotion(context, {
      lat: pt.lat, lng: pt.lng, vs30: vs30Details.value, siteFactor: pt.siteFactor
    }, {
      stationFactor: stationFactor, siteModel: cfg('siteModel'), siteNonlinear: cfg('siteNonlinear')
    });
    let earliestP = Infinity, earliestS = Infinity;
    for (let si = 0; si < motion.patches.length; si++) {
      const patch = motion.patches[si], s = patch.source;
      const p = s.ruptureTime + Physics.pTravelTime(patch.horizontalKm, s.depth, cfg('pWaveSpeed'), pt.lat, pt.lng);
      const sT = s.ruptureTime + Physics.sTravelTime(patch.horizontalKm, s.depth, cfg('sWaveSpeed'), pt.lat, pt.lng);
      if (p < earliestP) earliestP = p;
      if (sT < earliestS) earliestS = sT;
    }
    const pointH = motion.horizontalKm;
    const pA = motion.patches.length ? earliestP : Physics.pTravelTime(pointH, src.depthKm, cfg('pWaveSpeed'), pt.lat, pt.lng);
    const sA = motion.patches.length ? earliestS : Physics.sTravelTime(pointH, src.depthKm, cfg('sWaveSpeed'), pt.lat, pt.lng);
    const I = motion.intensity;
    const sh = Physics.intensityToShindo(I);
    if (sh === 0 && !(motion.pga >= 0.8)) continue; // mirror the browser filter
    rows.push({
      id: pt.id, name: pt.name, lat: pt.lat, lng: pt.lng,
      distanceKm: +motion.distanceKm.toFixed(3),
      vs30: vs30Details.value, vs30Source: vs30Details.source,
      pArriveSec: pA == null ? null : +pA.toFixed(3), sArriveSec: sA == null ? null : +sA.toFixed(3),
      peakPgaGal: +motion.pga.toPrecision(9), peakPgvCms: +motion.pgv.toPrecision(9),
      intensity: +I.toPrecision(9), shindo: sh,
      lpgmClass: Physics.calcLPGM(canonical.mag, motion.distanceKm, motion.pga, motion.sitePga, { lat: pt.lat, lng: pt.lng }),
      gmpeModel: gmpResolved, sourceType: evResolved.sourceType, distanceMetric: motion.distanceMetric,
      siteAmpNL: +motion.sitePga.toPrecision(9)
    });
  }
  rows.sort(function (a, b) { return a.pArriveSec - b.pArriveSec; });
  return {
    label: label || ('event-' + idx),
    originTimeSec: src.time != null ? src.time : 0,
    source: {
      lat: canonical.lat, lng: canonical.lng, mag: canonical.mag, mw: canonical.mw,
      depthKm: canonical.depthKm, strikeDeg: canonical.strikeDeg, dipDeg: canonical.dipDeg,
      rakeDeg: canonical.rakeDeg, sourceType: canonical.sourceType,
      faultModel: src.faultModel, finiteFaultPatches: ff ? (ff.subs ? ff.subs.length : 0) : 0,
      offshore: evResolved.offshore
    },
    stationCount: rows.length,
    stations: rows
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.preset && !args.spec)) {
    console.log('usage: node cli/simulate.js --preset <id> | --spec <file> [--out <file>] [--psha] [--seed N] [--config overrides.json]');
    process.exit(args.help ? 0 : 1);
  }
  if (args.seed != null) Config.cfgSet('randomSeed', args.seed);
  if (args.config) {
    const o = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    for (const k in o) Config.cfgSet(k, o[k]);
  }

  // scenario resolution
  let spec = null, presetId = null;
  if (args.preset) {
    presetId = args.preset;
    const p = PRESET_CATALOG[presetId];
    if (!p) die('unknown preset: ' + presetId + ' (available: ' + Object.keys(PRESET_CATALOG).join(', ') + ')');
    spec = p;
  } else {
    spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
  }

  // data (same files the browser fetches)
  const stations = loadJson('public/geojson/stations.json');
  // seafloor stations: ids continue after the land set (browser merge order)
  let seafloor = [];
  try {
    seafloor = loadJson('public/geojson/seafloor_stations.json').map(function (s, i) {
      return Object.assign({}, s, { isSeafloor: true, id: stations.length + i });
    });
  } catch (e) { seafloor = []; }
  const allStations = stations.concat(seafloor);
  // the browser applies the shipped GMPE calibration table at boot (before any
  // run) — the CLI must consume the same table to stay the contract twin
  try {
    const cal = loadJson('public/geojson/gmpe-calibration.json');
    if (Physics.setGmpeCalibration) Physics.setGmpeCalibration(cal);
  } catch (e) { /* calibration absent: native physics, honestly noted */ }
  const vs30Grid = loadVs30Grid();
  const vs30Lookup = makeVs30Lookup(vs30Grid);
  let prefGeo = null, bathyGrid = null;
  try { prefGeo = loadJson('public/geojson/japan_prefectures.geojson'); } catch (e) { prefGeo = null; }
  try { bathyGrid = loadJson('public/geojson/bathymetry.json'); } catch (e) { bathyGrid = null; }
  const oceanCheck = makeOceanCheck(prefGeo, bathyGrid);

  // event list: chain sub-events or the single preset/spec event
  const eventsIn = spec.subEvents && spec.subEvents.length
    ? spec.subEvents.map(function (se) { return Object.assign({}, se); })
    : [Object.assign({}, spec, { subEvents: undefined })];
  const results = [];
  for (let k = 0; k < eventsIn.length; k++) {
    const evResolved = resolveEvent(eventsIn[k], oceanCheck);
    // eslint-disable-next-line
    results.push(computeEvent(evResolved, allStations, vs30Lookup, k,
      eventsIn.length > 1 ? ('sub-' + k) : (presetId || 'spec')));
  }

  // combined block (chains): max per station id over events
  let combined = null;
  if (results.length > 1) {
    const byId = {};
    for (const r of results) for (const st of r.stations) {
      const cur = byId[st.id];
      if (!cur || st.peakPgaGal > cur.peakPgaGal) {
        byId[st.id] = { id: st.id, name: st.name, lat: st.lat, lng: st.lng, shindo: st.shindo,
          peakPgaGal: st.peakPgaGal, intensity: st.intensity, fromEvent: r.label };
      }
    }
    combined = Object.keys(byId).map(function (k) { return byId[k]; })
      .sort(function (a, b) { return b.peakPgaGal - a.peakPgaGal; });
  }

  // aftershock catalog (main event only, mirrors the browser flow)
  const mainRes = results[0];
  const mainSrc = mainRes.source;
  const catalog = Physics.generateAftershockCatalog(mainSrc.mw, mainSrc.lat, mainSrc.lng,
    mainSrc.strikeDeg, mainSrc.dipDeg, mainSrc.depthKm,
    cfg('asyK'), cfg('asyC'), cfg('asyP'), cfg('asyB'), 30,
    cfg('etasEnable'), cfg('etasAlpha'), cfg('catalogCap') || 50,
    mainSrc.sourceType, Research.normalizeSeed(cfg('randomSeed')));
  const manual = (spec.manualAftershocks || []).map(function (m) {
    return { time: m.timeSec != null ? m.timeSec : m.time, mag: m.mag, depth: m.depth != null ? m.depth : mainSrc.depthKm };
  });
  const catalogFull = Physics.mergeManualAftershocks(catalog, manual, mainSrc.lat, mainSrc.lng, AS_TIME_SCALE);

  // optional PSHA point curves (Japan source model, engine defaults)
  let psha = null;
  if (args.psha) {
    const model = loadJson('public/geojson/psha-source-model.json');
    const site = { lat: mainSrc.lat, lng: mainSrc.lng, vs30: 600 };
    const hz = Physics.hazardCurve(model, site, 'pga', { years: 50 });
    const uhs = Physics.uhs(model, site, [475, 2500], { periods: ['0.10', '0.20', '0.50', '1.00', '2.00', '3.00', '5.00'], years: 50 });
    psha = {
      note: 'Japan source model, Poisson engine, vs30 600 — external absolute gates are the region-pack measurements (v7.1 series)',
      pgaRp475Gal: +(Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 475) || 0).toPrecision(8),
      pgaRp2500Gal: +(Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 2500) || 0).toPrecision(8),
      uhs: uhs.uhs, periodsSec: uhs.periodsSec,
      ensembleSets: hz.ensemble.length,
      branchSetCount: hz.diagnostics.branchSetCount
    };
  }

  const maxShindo = (combined || results[0].stations).reduce(function (m, s) {
    return Physics.shindoScore(s.shindo) > Physics.shindoScore(m.shindo) ? s : m;
  }, { shindo: 0 });

  const out = {
    schema: SCHEMA,
    scenario: {
      preset: presetId,
      specFile: args.spec || null,
      chain: results.length > 1,
      eventCount: results.length,
      label: presetId || spec.label || 'spec'
    },
    config: {
      gmpModel: cfg('gmpModel'), siteModel: cfg('siteModel'),
      siteNonlinear: cfg('siteNonlinear'), directivity: cfg('directivity'),
      intensityMethod: 'empirical', randomSeed: cfg('randomSeed'),
      rupSpeed: cfg('rupSpeed'), catalogCap: cfg('catalogCap'),
      etasEnable: cfg('etasEnable'), asyK: cfg('asyK'), asyP: cfg('asyP'),
      note: 'shipped defaults; --config/--seed override (config.js is the single source)'
    },
    events: results.map(function (r) {
      return { label: r.label, originTimeSec: r.originTimeSec, source: r.source, stationCount: r.stationCount, stations: r.stations };
    }),
    combined: combined,
    maxShindo: { shindo: maxShindo.shindo, stationId: maxShindo.id, name: maxShindo.name },
    aftershocks: {
      timeScaleNote: 'timeSec = real seconds (30-day window); AS_TIME_SCALE 21600 real-sec per sim-sec',
      count: catalogFull.length,
      events: catalogFull.map(function (a) {
        return { timeSec: +a.time.toPrecision(9), timeDays: +(a.time / 86400).toPrecision(9), mag: +a.mag.toPrecision(6), lat: +a.lat.toPrecision(9), lng: +a.lng.toPrecision(9), depthKm: +a.depth.toPrecision(6) };
      })
    },
    psha: psha,
    diagnostics: {
      stationSource: 'public/geojson/stations.json + seafloor_stations.json (browser merge order; ids continue)',
      vs30Grid: vs30Grid ? 'public/geojson/vs30.json (J-SHIS AVS30, external lookup first)' : 'absent — station/zone fallback',
      intensityMethod: 'empirical (motion.intensity)',
      scopeNotes: 'chains are per-event (combined = max-over-events); jma3c/geo-site/eqlin-1d/seafloor/EEW display layers not in v1'
    }
  };
  const text = JSON.stringify(out, null, 1) + '\n';
  if (args.out) {
    fs.writeFileSync(args.out, text);
    console.log('wrote ' + args.out);
  } else {
    process.stdout.write(text);
  }
}

try { main(); } catch (e) { console.error(String(e && e.stack || e)); process.exit(1); }
