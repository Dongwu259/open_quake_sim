'use strict';
// =====================================================================
//  v6.1 B2-beta — frozen-scorecard tripwires.
//
//  The pre-registered gates live in tools/data/psha-source-model-report.json
//  (preRegisteredB2, frozen 2026-09-01 before any B2 implementation run).
//  These tests lock the frozen RESULTS (tools/data/broadband-scorecard.json)
//  and the calibration freeze (broadband-hybrid-calibration.json) so any
//  re-tuning attempt trips a test, plus the units-chain invariants that the
//  B2-beta debugging established (Riemann fill convention, density units,
//  bounded crossover, Boore free-surface constant).
// =====================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const hybrid = require(path.join(ROOT, 'tools/broadband/hybrid.js'));

function load(p) { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); }

describe('broadband hybrid units chain (B2-beta invariants)', function () {
  it('ifftReal of a single conjugate-mirrored bin peaks at 2V/N (DFT fill convention)', function () {
    const NF = 1024, V = 1.5, k0 = 37;
    const spec = new Array(NF).fill(0).map(() => [0, 0]);
    spec[k0] = [V, 0]; spec[NF - k0] = [V, 0];
    const t = hybrid.ifftReal(spec, NF);
    let peak = 0;
    for (const v of t) peak = Math.max(peak, Math.abs(v));
    assert.ok(Math.abs(peak - 2 * V / NF) < 1e-12, 'peak ' + peak + ' vs ' + 2 * V / NF);
  });

  it('booreSourceConstant defaults to the transverse-SH free-surface factor 2', function () {
    const c1 = hybrid.booreSourceConstant(2650, 3500, 0.55);
    const c0 = hybrid.booreSourceConstant(2650, 3500, 0.55, 1);
    assert.ok(Math.abs(c1 / c0 - 2) < 1e-12);
  });

  it('hfAccelFAS applies the site curve (log-log interpolation)', function () {
    const base = { mw: 6.5, distKm: 40, stressMPa: 50, Q0: 200, eta: 0.7, kappaSec: 0.02, cB: 3.9e-16 };
    const curve = { freqs: [0.3, 1, 3, 10], amps: [1, 2, 4, 4] };
    const withSite = hybrid.hfAccelFAS(3, Object.assign({}, base, { siteCurve: curve }));
    const noSite = hybrid.hfAccelFAS(3, Object.assign({}, base));
    assert.ok(Math.abs(withSite / noSite - 4) < 1e-9);
    const between = hybrid.hfAccelFAS(2, Object.assign({}, base, { siteCurve: curve }))
      / hybrid.hfAccelFAS(2, Object.assign({}, base));
    assert.ok(between > 2 && between < 4, 'log-interp between anchors, got ' + between);
  });

  it('buildJivsmIaspStack keeps continuation densities in g/cm^3 (1000x regression guard)', function () {
    const col = [
      { topM: 0, bottomM: 50, vp: 1500, vs: 400, rho: 1800 },
      { topM: 50, bottomM: 1200, vp: 2600, vs: 1200, rho: 2150 }
    ];
    const stack = hybrid.buildJivsmIaspStack(col);
    assert.ok(stack.length >= 5);
    for (const lay of stack) {
      assert.ok(lay.rhoGcm3 >= 1.5 && lay.rhoGcm3 <= 3.5, 'rho ' + lay.rhoGcm3 + ' not g/cm^3 in layer ' + lay.topKm);
    }
    // the JIVSM rows convert kg/m^3 -> g/cm^3
    assert.ok(Math.abs(stack[0].rhoGcm3 - 1.8) < 1e-9);
    // the deep continuation uses densityFromVs output directly
    const deep = stack.filter((l) => l.topKm >= 40);
    assert.ok(deep.length >= 2 && deep.every((l) => l.rhoGcm3 > 2.5));
  });
});

describe('broadband hybrid calibration freeze', function () {
  const cal = load('tools/data/broadband-hybrid-calibration.json');

  it('froze stress 50 MPa / kappa 0.02 s with the boundary-chasing note', function () {
    assert.strictEqual(cal.chosenStressMPa, 50);
    assert.strictEqual(cal.chosenKappaSec, 0.02);
    assert.ok(cal.boundaryNote && cal.boundaryNote.indexOf('50 MPa') >= 0);
  });

  it('documents the pre-registration gap it closes', function () {
    assert.ok(cal.note.indexOf('preRegisteredB2') >= 0);
    assert.deepStrictEqual(cal.calibrationFreqsHz, [0.3, 1, 3]);
  });
});

describe('broadband scorecard frozen results (2026-09-01)', function () {
  const sc = load('tools/data/broadband-scorecard.json');

  it('covers all 13 frozen events with mechanisms', function () {
    assert.strictEqual(sc.schema, 'quake-sim-broadband-scorecard-v1');
    assert.strictEqual(sc.perEvent.length, 13);
    for (const ev of sc.perEvent) {
      assert.ok(!ev.skipped, ev.id + ' skipped');
      assert.ok(ev.mechanism && isFinite(ev.mechanism.strike));
      assert.ok(ev.hybrid && ev.hybrid.pga != null);
    }
  });

  it('froze the exact band/scalar AbsMax numbers', function () {
    assert.strictEqual(sc.bands['0.1-0.5s'].hybrid.absMax, 1.402);
    assert.strictEqual(sc.bands['0.5-2s'].hybrid.absMax, 1.587);
    assert.strictEqual(sc.bands['2-10s'].hybrid.absMax, 2.228);
    assert.strictEqual(sc.bands['2-10s'].brune.absMax, 2.371);
    assert.strictEqual(sc.scalars.pga.hybrid.absMax, 1.344);
    assert.strictEqual(sc.scalars.pga.brune.absMax, 0.902);
    assert.strictEqual(sc.scalars.pga.gmpe.absMax, 0.538);
    assert.strictEqual(sc.scalars.pgv.hybrid.absMax, 2.017);
  });

  it('gate verdicts frozen: long-period improvement PASS, absolute gates FAIL, JMA N/A', function () {
    assert.strictEqual(sc.gates.longPeriodImprovementVsBrune.pass, true);
    assert.strictEqual(sc.gates.longPeriodImprovementVsBrune.improvement, 0.143);
    assert.strictEqual(sc.gates.pgaLog10BiasAbsMax.pass, false);
    assert.strictEqual(sc.gates.pgvLog10BiasAbsMax.pass, false);
    assert.strictEqual(sc.gates.pgaNonRegressionVsBrune.pass, false);
    for (const b of ['0.1-0.5s', '0.5-2s', '2-10s']) {
      assert.strictEqual(sc.gates.psaLog10BiasAbsMax[b].pass, false, b);
    }
    assert.strictEqual(sc.gates.jmaIntensityBiasAbsMax.status, 'N/A');
  });

  it('records the selection-bias floor finding (GMPE arm also fails the gates)', function () {
    assert.ok(sc.findings && sc.findings.absoluteGates.indexOf('intensity-selected') >= 0);
    assert.ok(sc.findings.longPeriod.indexOf('PASS') >= 0);
  });
});

describe('broadband event mechanisms freeze', function () {
  const mechs = load('tools/data/broadband-event-mechanisms.json');

  it('resolved all 13 events with USGS/GCMT moment tensors', function () {
    assert.strictEqual(mechs.events.length, 13);
    for (const ev of mechs.events) {
      assert.ok(ev.resolved && ev.mechanism, ev.id + ' unresolved');
      const m = ev.mechanism;
      assert.ok(m.strike >= 0 && m.strike < 360 && m.dip > 0 && m.dip <= 90 && m.rake > -180 && m.rake <= 180, ev.id);
      assert.ok(ev.comcatId && ev.depthKm != null);
    }
  });

  it('keeps provenance on every mechanism', function () {
    for (const ev of mechs.events) {
      assert.ok(ev.mechanism.source && ev.mechanism.source.length > 3, ev.id);
    }
  });
});
