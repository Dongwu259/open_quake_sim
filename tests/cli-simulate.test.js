// ================================================================
//  cli/simulate.js — contract tests (2026-11-17, CLI v1 batch).
//  The CLI is the deterministic headless twin of the browser sim: same
//  engine primitives (createGroundMotionContext → predictStationMotion),
//  same station data (land + seafloor, J-SHIS vs30 grid first), same GMPE
//  calibration table, same config defaults. The BROWSER-side twin proof
//  (16/16 station-by-station agreement at declared output precision, two
//  presets incl. an observed finite-fault model) ran as
//  .browser-test/probe-cli-golden.js — a scratch probe, not part of this
//  hermetic chain. These tests lock the CLI contract itself.
//  Run with:  node --test tests/cli-simulate.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'simulate.js');
const Physics = require('../public/physics.js');
const Config = require('../public/config.js');
const Research = require('../public/research.js');
const FiniteFault = require('../public/finite-fault.js');
const ObservedModels = require('../public/observed-fault-models.js');
const PRESET_CATALOG = require('../public/presets-catalog.js');

function runCli(args) {
  // CI checkouts have no .cache/ — the --out targets below need the parent
  // directory to exist (ENOENT otherwise, 2026-11-20 mirror CI)
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0 && args[outIdx + 1]) {
    const p = args[outIdx + 1];
    fs.mkdirSync(path.dirname(path.isAbsolute(p) ? p : path.join(ROOT, p)), { recursive: true });
  }
  return execFileSync(process.execPath, [CLI].concat(args), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('preset catalog: 24 static presets, frozen anchors, fault-model refs resolvable', () => {
  const ids = Object.keys(PRESET_CATALOG);
  assert.equal(ids.length, 24);
  for (const id of ids) {
    const p = PRESET_CATALOG[id];
    assert.ok(p.lat != null && p.lng != null && p.mag != null && p.depth != null && p.strike != null, id + ' core fields');
    if (p.faultModel) assert.ok(ObservedModels.get(p.faultModel), id + ' faultModel resolvable');
    if (p.subEvents) for (const se of p.subEvents) if (se.faultModel) assert.ok(ObservedModels.get(se.faultModel), id + ' sub-event faultModel resolvable');
  }
  assert.equal(PRESET_CATALOG.tohoku.lat, 38.10);
  assert.equal(PRESET_CATALOG.tohoku.mag, 9.1);
  assert.equal(PRESET_CATALOG.tohoku.depth, 24);
  assert.equal(PRESET_CATALOG.tohoku.faultModel, 'tohoku');
  assert.equal(PRESET_CATALOG.japanSinks.subEvents.length, 19);
  // app.js consumes the same catalog (extraction left no inline literal)
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(appSrc.includes("require('./presets-catalog.js')"), 'app.js consumes presets-catalog.js');
  assert.ok(!/var PRESETS = \{\n  \/\/ 2011 Tohoku-Oki/.test(appSrc), 'inline literal removed');
});

test('CLI determinism: two runs produce byte-identical JSON', () => {
  const a = path.join(ROOT, '.cache', 'cli-det-a.json');
  const b = path.join(ROOT, '.cache', 'cli-det-b.json');
  runCli(['--preset', 'tokyoInland', '--out', a]);
  runCli(['--preset', 'tokyoInland', '--out', b]);
  const ra = fs.readFileSync(a, 'utf8'), rb = fs.readFileSync(b, 'utf8');
  assert.equal(ra, rb, 'byte-identical runs (no wall-clock in the document)');
  fs.unlinkSync(a); fs.unlinkSync(b);
  const doc = JSON.parse(ra);
  assert.equal(doc.schema, 'quake-sim-cli-simulation-v1');
  assert.equal(doc.scenario.preset, 'tokyoInland');
  assert.ok(doc.events[0].stationCount > 800, 'full station set (land+seafloor)');
});

test('engine twin: CLI station values re-derive exactly from the shared primitives', () => {
  const out = path.join(ROOT, '.cache', 'cli-twin.json');
  runCli(['--preset', 'tokyoInland', '--out', out]);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  // independent re-derivation of ONE station through the same primitives the
  // browser and the CLI both consume — pins every CLI input (stationFactor
  // seed, J-SHIS vs30 lookup, calibration table, context options)
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'gmpe-calibration.json'), 'utf8'));
  if (Physics.setGmpeCalibration) Physics.setGmpeCalibration(cal);
  const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'stations.json'), 'utf8'));
  const seafloor = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'seafloor_stations.json'), 'utf8'))
    .map((s, i) => Object.assign({}, s, { isSeafloor: true, id: stations.length + i }));
  const all = stations.concat(seafloor);
  const grid = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'vs30.json'), 'utf8'));
  const src = doc.events[0].source;
  // same source canonicalization the CLI runs (the twin value here is the
  // per-station pipeline: stationFactor seed / vs30 lookup / calibration /
  // context options — a wrong CLI input shows up as a value mismatch here)
  const canonical = Physics.createSourceModel({
    lat: src.lat, lng: src.lng, mag: src.mag, mw: src.mw, depthKm: src.depthKm,
    strikeDeg: src.strikeDeg, dipDeg: src.dipDeg, rakeDeg: src.rakeDeg,
    mechanismKnown: true, finiteFault: null, momentTensor: null, mechanismProvenance: null,
    faultPlaneIndex: null, sourceType: src.sourceType,
    faultOptions: { randomSeed: Research.normalizeSeed(Config.cfgGet('randomSeed')),
      hypocenterFrac: Config.cfgGet('hypocenterFrac'), slipPerturbation: Config.cfgGet('slipPerturbation'),
      ruptureVelocityModel: Config.cfgGet('ruptureVelocityModel'), sourceTimeFunction: Config.cfgGet('sourceTimeFunction'),
      rigidityGPa: 30 },
    generateSubSources: true, rupSpeed: Config.cfgGet('rupSpeed'), originTime: 0
  });
  const gmpResolved = Physics.resolveGmpModel(Config.cfgGet('gmpModel'), src.sourceType, src.mw);
  const context = Physics.createGroundMotionContext({
    lat: canonical.lat, lng: canonical.lng, mag: canonical.mag, mw: canonical.mw, depthKm: canonical.depthKm,
    strikeDeg: canonical.strikeDeg, dipDeg: canonical.dipDeg, sourceType: canonical.sourceType
  }, {
    gmpModel: gmpResolved, geometry: canonical.geometry, finiteFault: true, rupSpeed: Config.cfgGet('rupSpeed'),
    attA: Config.cfgGet('attA'), attB: Config.cfgGet('attB'), attC: Config.cfgGet('attC'),
    anelastic: Config.cfgGet('anelastic'), siteModel: Config.cfgGet('siteModel'),
    siteBase: Config.cfgGet('siteBase'), siteSoftMax: Config.cfgGet('siteSoftMax'),
    siteHardMin: Config.cfgGet('siteHardMin'), siteNonlinear: Config.cfgGet('siteNonlinear'),
    directivity: Config.cfgGet('directivity')
  });
  const target = doc.events[0].stations.find((s) => s.id === 302) || doc.events[0].stations[0];
  const pt = all.find((p) => p.id === target.id);
  assert.ok(pt, 'station ' + target.id + ' exists');
  const stationFactor = 0.82 + Research.randomAt(Config.cfgGet('randomSeed'), 'station-factor:' + pt.id, 0) * 0.36;
  const vs30Details = Physics.lookupVs30Details(pt.lat, pt.lng, pt.vs30, (lat, lng) => {
    const v = Physics.lookupResearchGrid(grid, lat, lng);
    return v && v > 0 ? { value: v, source: 'j-shis-grid' } : null;
  }, 'station-estimate');
  const motion = Physics.predictStationMotion(context, { lat: pt.lat, lng: pt.lng, vs30: vs30Details.value, siteFactor: pt.siteFactor },
    { stationFactor: stationFactor, siteModel: Config.cfgGet('siteModel'), siteNonlinear: Config.cfgGet('siteNonlinear') });
  assert.equal(String(motion.pga.toPrecision(9)), String(target.peakPgaGal), 'peakPga twin at declared precision');
  assert.equal(Physics.intensityToShindo(motion.intensity), target.shindo, 'shindo twin');
  assert.equal(vs30Details.source, target.vs30Source, 'vs30 source twin');
});

test('--spec path + chain semantics: combined block is max-over-events', () => {
  const specPath = path.join(ROOT, '.cache', 'cli-spec-chain.json');
  fs.writeFileSync(specPath, JSON.stringify({
    label: 'chain-spec-test',
    events: null,
    subEvents: [
      { lat: 35.62, lng: 139.75, mag: 6.4, depth: 17, strike: 135, dip: 60, rake: 120, mechanismKnown: true, time: 0 },
      { lat: 35.62, lng: 139.75, mag: 7.3, depth: 17, strike: 135, dip: 60, rake: 120, mechanismKnown: true, time: 40 }
    ]
  }));
  const out = path.join(ROOT, '.cache', 'cli-chain.json');
  const text = runCli(['--spec', specPath, '--out', out]);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out); fs.unlinkSync(specPath);
  assert.equal(doc.scenario.chain, true);
  assert.equal(doc.events.length, 2);
  assert.ok(doc.combined && doc.combined.length > 0, 'combined block present');
  // every combined row is the max over per-event rows for that station
  for (const c of doc.combined.slice(0, 20)) {
    const per = doc.events.map((e) => (e.stations.find((s) => s.id === c.id) || { peakPgaGal: -1 }).peakPgaGal);
    assert.ok(Math.abs(Math.max.apply(null, per) - c.peakPgaGal) <= 1e-12, 'combined max semantics at ' + c.id);
    assert.equal(c.peakPgaGal, Math.max.apply(null, per));
  }
  void text;
});

test('aftershock catalog: deterministic, inside the 30-day window, manual merge works', () => {
  const out = path.join(ROOT, '.cache', 'cli-as.json');
  runCli(['--preset', 'tokyoInland', '--out', out]);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  const evs = doc.aftershocks.events;
  assert.ok(doc.aftershocks.count > 0 && evs.length === doc.aftershocks.count);
  for (const a of evs.slice(0, 10)) {
    assert.ok(a.timeSec >= 0 && a.timeSec <= 30 * 86400, '30-day window');
    assert.ok(a.mag >= 3 && a.mag <= 9, 'sane magnitude');
  }
  assert.ok(doc.aftershocks.timeScaleNote.includes('21600'), 'time-scale disclosure');
});

test('--psha arm: Japan-model point curves ride the same engine (3-branch ensemble)', () => {
  const out = path.join(ROOT, '.cache', 'cli-psha.json');
  runCli(['--preset', 'tokyoInland', '--psha', '--out', out]);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  assert.ok(doc.psha, 'psha block present');
  assert.ok(doc.psha.pgaRp475Gal > 100 && doc.psha.pgaRp475Gal < 3000, 'sane RP475 PGA: ' + doc.psha.pgaRp475Gal);
  assert.equal(doc.psha.branchSetCount, 3, 'Japan model keeps the three-branch tree');
  assert.deepEqual(doc.psha.periodsSec, [0.1, 0.2, 0.5, 1, 2, 3, 5]);
  assert.ok(doc.psha.uhs['475'].every((v) => v == null || v > 0));
});
