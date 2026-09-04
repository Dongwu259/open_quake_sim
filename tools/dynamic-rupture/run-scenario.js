#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.2 tier-2 — dynamic-rupture → simulator pipeline CLI.
//
//  Runs one offline dynamic-rupture scenario (2D velocity-stress FD +
//  TSN slip-weakening, the frozen R6-2 engine), exports it in the app's
//  finite-fault-v1 import contract, validates through the app's OWN
//  parser (public/finite-fault.js) and writes the model JSON plus the
//  registry entry the browser's import card lists as a bundled model.
//
//  Usage:
//    node tools/dynamic-rupture/run-scenario.js --list
//    node tools/dynamic-rupture/run-scenario.js --config tpv5ap \
//        --id my-run --strike 233 --dip 90 --rake 180 \
//        --along-strike-km 40 --lat 34.6 --lng 135.0 \
//        [--t-end 8] [--dx 100] [--out <file.json>] [--quiet]
//    --config <file.json>  custom scenario: {"type":"sh"|"psv", ...solver opts}
//
//  Honest scope (stated in every exported provenance block): the solver is
//  a 2D along-strike-uniform rupture; the along-strike extent is a
//  geometric ASSUMPTION of the export, not a computed result.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { makeTpv5Ap, makeShSpont, makePsvSpont } = require('./configs.js');
const { exportFiniteFault } = require('./export-finite-fault.js');

const ROOT = path.resolve(__dirname, '..', '..');
const MODELS_DIR = path.join(ROOT, 'public', 'geojson', 'fault-models');
const REGISTRY = path.join(MODELS_DIR, 'index.json');

const PRESETS = {
  'tpv5ap': { make: makeTpv5Ap, label: 'SCEC TPV5-AP (anti-plane, official stresses)', tEnd: 8 },
  'sh-spont': { make: makeShSpont, label: 'generic whole-space spontaneous rupture (SH / anti-plane)', tEnd: 6 },
  'psv-spont': { make: makePsvSpont, label: 'generic whole-space spontaneous rupture (PSV / mode II)', tEnd: 8 }
};

// advance with per-node rise-time tracking (same rule as run-experiment:
// |V| falling under 0.05 m/s after rupture, capped at the run length)
function advanceWithRise(S, tEnd) {
  const rise = new Float64Array(S.nz);
  let t = 0;
  const n = Math.round(tEnd / S.dt);
  for (let k = 0; k < n; k++) {
    t = S.step(t);
    for (let j = 0; j < S.nz; j++) {
      if (S.rupTime[j] > 0 && rise[j] === 0 && Math.abs(S.slipRate[j]) < 0.05) {
        rise[j] = t - S.rupTime[j];
      }
    }
  }
  S.riseTime = rise;
  return t;
}

function runScenario(opts) {
  opts = opts || {};
  const cfgName = opts.config || 'tpv5ap';
  let maker, label;
  if (PRESETS[cfgName]) {
    maker = PRESETS[cfgName].make;
    label = PRESETS[cfgName].label;
  } else {
    const file = path.resolve(process.cwd(), cfgName);
    const custom = JSON.parse(fs.readFileSync(file, 'utf8'));
    const type = custom.type === 'psv' ? 'psv' : 'sh';
    maker = type === 'psv' ? makePsvSpont : makeShSpont;
    label = 'custom scenario (' + type + ', ' + path.basename(cfgName) + ')';
    // pass the custom solver opts through (minus the type marker)
    const solverOpts = Object.assign({}, custom);
    delete solverOpts.type;
    opts.solverOpts = solverOpts;
  }
  const solverOpts = Object.assign({}, opts.solverOpts || {});
  if (opts.dx) solverOpts.dx = opts.dx;
  const S = maker(solverOpts);
  if (!S) throw new Error('solver construction failed');
  const tEnd = opts.tEnd != null ? opts.tEnd
    : (PRESETS[cfgName] ? PRESETS[cfgName].tEnd : 6);
  const tFinal = advanceWithRise(S, tEnd);

  const model = exportFiniteFault(S, {
    eventId: opts.id || ('dynrup-' + cfgName),
    label: cfgName,
    strikeDeg: opts.strike != null ? opts.strike : 90,
    dipDeg: opts.dip != null ? opts.dip : 90,
    rakeDeg: opts.rake != null ? opts.rake : 180,
    alongStrikeKm: opts.alongStrikeKm != null ? opts.alongStrikeKm : 30,
    hypoLat: opts.lat != null ? opts.lat : 38.0,
    hypoLng: opts.lng != null ? opts.lng : 142.0,
    hypoDepthKm: opts.depth != null ? opts.depth : undefined,
    sourceLabel: label + ' — offline pipeline (tools/dynamic-rupture/run-scenario.js)'
  });

  // validate through the app's own import contract before anything ships
  const FiniteFault = require(path.join(ROOT, 'public', 'finite-fault.js'));
  const parsed = FiniteFault.parse(JSON.parse(JSON.stringify(model)));
  if (!parsed || !parsed.patches || !parsed.patches.length) {
    throw new Error('exported model failed the app-side finite-fault-v1 validation');
  }
  return {
    model, parsed, tFinal,
    summary: {
      id: model.id,
      mw: parsed.mw,
      patches: parsed.patches.length,
      peakSlipM: model.patches.reduce((m, p) => Math.max(m, p.slipM), 0),
      maxRuptureS: model.patches.reduce((m, p) => Math.max(m, p.ruptureTime || 0), 0),
      label
    }
  };
}

function updateRegistry(entry) {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  let reg = { schema: 'quake-sim-fault-models-index-v1', models: [] };
  if (fs.existsSync(REGISTRY)) {
    reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  }
  reg.models = (reg.models || []).filter(m => m.id !== entry.id);
  reg.models.push(entry);
  reg.models.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 1) + '\n');
  return reg;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--list') || argv.length === 0) {
    console.log('presets:');
    for (const k of Object.keys(PRESETS)) console.log('  ' + k + ' — ' + PRESETS[k].label);
    console.log('custom: --config <file.json> with {"type":"sh"|"psv", ...solver opts}');
    return;
  }
  const out = flag('out') || path.join(MODELS_DIR, (flag('id') || 'dynrup-run') + '.json');
  const num = (v) => (v == null ? undefined : Number(v));
  const r = runScenario({
    config: flag('config'),
    id: flag('id'),
    tEnd: num(flag('t-end')),
    dx: num(flag('dx')),
    strike: num(flag('strike')),
    dip: num(flag('dip')),
    rake: num(flag('rake')),
    alongStrikeKm: num(flag('along-strike-km')),
    lat: num(flag('lat')),
    lng: num(flag('lng')),
    depth: num(flag('depth'))
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r.model, null, 1) + '\n');
  updateRegistry({
    id: r.summary.id,
    file: path.relative(MODELS_DIR, out).replace(/\\/g, '/'),
    label: r.summary.label,
    mw: +r.summary.mw.toFixed(2),
    patches: r.summary.patches,
    peakSlipM: +r.summary.peakSlipM.toFixed(2),
    durationS: +r.summary.maxRuptureS.toFixed(1),
    kind: 'dynamic-rupture',
    provenance: r.model.provenance.source
  });
  if (!argv.includes('--quiet')) {
    console.log('wrote ' + out);
    console.log('  id ' + r.summary.id + ' · Mw ' + r.summary.mw.toFixed(2)
      + ' · ' + r.summary.patches + ' patches · peak slip ' + r.summary.peakSlipM.toFixed(2)
      + ' m · rupture ≤ ' + r.summary.maxRuptureS.toFixed(1) + ' s');
    console.log('  registry: ' + REGISTRY);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
module.exports = { runScenario, advanceWithRise, updateRegistry, PRESETS };
