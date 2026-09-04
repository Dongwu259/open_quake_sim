// ================================================================
//  Pipeline tests for the v6.2 tier-2 dynamic-rupture → simulator
//  productization (tools/dynamic-rupture/run-scenario.js):
//    - scenario run → export → validated by the app's OWN parser
//    - createSourceModel consumes the model (imported geometry)
//    - dip-aware export placement (+ vertical byte-compat shape)
//    - bundled example models + registry consistency
//  Run with:  node --test tests/dynamic-rupture-pipeline.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('../tools/dynamic-rupture/run-scenario.js');
const { exportFiniteFault } = require('../tools/dynamic-rupture/export-finite-fault.js');
const { makeShSpont } = require('../tools/dynamic-rupture/configs.js');
const FiniteFault = require('../public/finite-fault.js');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'geojson', 'fault-models');

// ================================================================
//  RUN → EXPORT → VALIDATE
// ================================================================
test('runScenario: sh-spont scenario exports a model the app parser accepts', () => {
  const r = runScenario({
    config: 'sh-spont', id: 'pipeline-test-sh', tEnd: 4, dx: 200,
    strike: 233, dip: 90, rake: 180, alongStrikeKm: 40, lat: 34.6, lng: 135.0
  });
  assert.ok(r.model.schema === 'quake-sim-finite-fault-v1');
  assert.ok(r.parsed.patches.length >= 5, 'ruptured patches exported');
  assert.ok(r.parsed.mw > 6 && r.parsed.mw < 8, 'Mw band: ' + r.parsed.mw);
  assert.ok(r.summary.peakSlipM > 0.1, 'physically meaningful slip: ' + r.summary.peakSlipM);
  // every patch carries the kinematics the rupture card consumes
  for (const p of r.model.patches) {
    assert.ok(p.slipM > 0);
    assert.ok(p.ruptureTime >= 0);
    assert.ok(p.riseTime > 0);
    assert.ok(p.rigidityGPa > 0);
  }
  // provenance honestly states the 2D assumption
  assert.ok(r.model.provenance.notes.includes('geometric assumption'));
});

test('runScenario: psv-spont scenario with dip<90 — same contract', () => {
  const r = runScenario({
    config: 'psv-spont', id: 'pipeline-test-psv', tEnd: 4, dx: 200,
    strike: 250, dip: 60, rake: 90, alongStrikeKm: 30, lat: 36.8, lng: 137.3
  });
  assert.ok(r.parsed.patches.length >= 5);
  const dips = new Set(r.model.patches.map(p => p.dipDeg));
  assert.deepStrictEqual([...dips], [60]);
});

test('createSourceModel consumes the exported model end-to-end (imported geometry + rupture stats)', () => {
  const r = runScenario({ config: 'sh-spont', id: 'pipeline-csm', tEnd: 4, dx: 200, alongStrikeKm: 40 });
  const parsed = FiniteFault.parse(JSON.parse(JSON.stringify(r.model)));
  const src = Physics.createSourceModel({
    lat: parsed.event.lat, lng: parsed.event.lng, mw: parsed.mw, depth: parsed.event.depthKm,
    strike: parsed.representativePlane.strikeDeg, dip: parsed.representativePlane.dipDeg,
    rake: parsed.representativePlane.rakeDeg,
    finiteFault: parsed, sourceType: 'crustal'
  });
  assert.strictEqual(src.geometry.kind, 'imported-finite-fault');
  const stats = Physics.faultRuptureStats(src.geometry.subs, src.geometry);
  assert.ok(stats && stats.patches >= 5);
  assert.ok(stats.maxSlipM > 0.1);
  const mr = Physics.momentRateSeries(src.geometry.subs, null, 0.25);
  assert.ok(mr && Math.abs(mr.finalCum - 1) < 1e-9);
});

// ================================================================
//  DIP-AWARE PLACEMENT
// ================================================================
test('export placement: dip<90 offsets patch centres downdip; dip=90 keeps the vertical line', () => {
  // tiny deterministic state stub — only slip/rupTime/riseTime/zOf are read
  function stubState() {
    const nz = 5, dx = 1000;
    return {
      nz, dx, mu: 3.3e10,
      slip: [0, 1, 2, 1, 0],
      rupTime: [null, 0.5, 0.2, 0.8, null],
      riseTime: [0, 1, 1, 1, 0],
      zOf: (j) => j * dx
    };
  }
  const vert = exportFiniteFault(stubState(), { dipDeg: 90, strikeDeg: 0 });
  for (const p of vert.patches) {
    assert.ok(Math.abs(p.lat - 38) < 1e-9 && Math.abs(p.lng - 142) < 1e-9, 'vertical: centres stay on the line');
  }
  const dipped = exportFiniteFault(stubState(), { dipDeg: 45, strikeDeg: 0 });
  // strike 0 → dip direction bearing 90° (east); offset = z/tan(45°) = z
  for (const p of dipped.patches) {
    const offKm = (p.lng - 142) * 111.32 * Math.cos(38 * Math.PI / 180);
    const expect = p.depthKm * 1; // cot(45°) = 1
    assert.ok(Math.abs(offKm - expect) < 0.05, 'dip 45 offset: ' + offKm.toFixed(2) + ' vs ' + expect);
    assert.ok(Math.abs(p.lat - 38) < 1e-6, 'strike 0: no lat displacement');
  }
});

// ================================================================
//  BUNDLED MODELS + REGISTRY
// ================================================================
test('bundled dynamic-rupture models: registry consistent, both parse, provenance recorded', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'index.json'), 'utf8'));
  assert.strictEqual(reg.schema, 'quake-sim-fault-models-index-v1');
  assert.ok(reg.models.length >= 2, 'two bundled examples');
  const ids = new Set();
  for (const m of reg.models) {
    assert.ok(ids.has(m.id) === false);
    ids.add(m.id);
    assert.strictEqual(m.kind, 'dynamic-rupture');
    const file = path.join(MODELS_DIR, m.file);
    assert.ok(fs.existsSync(file), m.file + ' exists');
    const model = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parsed = FiniteFault.parse(model);
    assert.ok(Math.abs(parsed.mw - m.mw) < 0.02, 'registry Mw in sync: ' + parsed.mw + ' vs ' + m.mw);
    assert.strictEqual(model.provenance.format, 'dynamic-rupture-export-v1');
    assert.ok(model.provenance.source.includes('offline pipeline'));
    assert.ok(parsed.patches.length === m.patches, 'patch count in sync');
  }
  assert.ok(ids.has('dynrup-strikeslip-sh'));
  assert.ok(ids.has('dynrup-dipslip-psv'));
});

test('bundled strikeslip model: seismologically plausible bands (TPV5-AP stresses)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'dynrup-strikeslip-sh.json'), 'utf8'));
  const parsed = FiniteFault.parse(model);
  assert.ok(parsed.mw > 7 && parsed.mw < 7.8, 'Mw band: ' + parsed.mw);
  const slips = model.patches.map(p => p.slipM);
  assert.ok(Math.max(...slips) > 5, 'TPV5-AP peak slip >5 m: ' + Math.max(...slips).toFixed(2));
  assert.ok(Math.max(...slips) < 20, 'peak slip physically bounded');
  // vertical right-lateral: all patches share the mechanism
  for (const p of model.patches) {
    assert.strictEqual(p.dipDeg, 90);
    assert.strictEqual(p.rakeDeg, 180);
  }
});

// ================================================================
//  DETERMINISM (regeneration drift guard)
// ================================================================
test('runScenario is deterministic — same inputs reproduce the same model bit-for-bit', () => {
  const a = runScenario({ config: 'sh-spont', id: 'det', tEnd: 3, dx: 250, alongStrikeKm: 30, randomize: false });
  const b = runScenario({ config: 'sh-spont', id: 'det', tEnd: 3, dx: 250, alongStrikeKm: 30, randomize: false });
  assert.deepStrictEqual(a.model.patches, b.model.patches);
  assert.strictEqual(a.model.event.mw, b.model.event.mw);
});
