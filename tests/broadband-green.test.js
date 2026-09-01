// broadband-green.test.js — v6.1 B1 tripwires for the SH discrete-wavenumber
// kernel (tools/broadband/core.js). Frozen-report gates + two fast live
// re-checks (vertical-incidence cross-check vs physics.js, and a coarse-grid
// full-space anchor point). The full anchor suite lives in the frozen report
// (tools/data/broadband-green-report.json, regenerated deliberately via
// `node tools/broadband/run-experiment.js --write`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../tools/broadband/core.js');
const Physics = require('../public/physics.js');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'broadband-green-report.json');

test('broadband-green — frozen report: all anchors pass, capability boundary recorded', () => {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.equal(report.schema, 'quake-sim-broadband-green-report-v1');
  assert.ok(report.allPass, `anchors: ${JSON.stringify(Object.keys(report.anchors))}`);
  for (const key of ['a1_fullSpace', 'a2_staticLimit', 'a3_loveDispersion', 'a4_verticalIncidence', 'a5_kSampling']) {
    assert.ok(report.anchors[key], key);
    assert.ok(report.anchors[key].pass, `${key} regressed — rerun tools/broadband/run-experiment.js --write after a deliberate change`);
  }
  // A1 frozen tolerances (amplitude/phase gates; complex metric recorded ungated)
  assert.equal(report.anchors.a1_fullSpace.tolerances.ampAbs, 0.05);
  assert.equal(report.anchors.a1_fullSpace.tolerances.phaseRad, 0.25);
  assert.ok(Number(report.anchors.a1_fullSpace.worst.ampAbs) < 0.05);
  assert.ok(Number(report.anchors.a1_fullSpace.worst.phaseRad) < 0.25);
  // A3: fundamental-only below the first-overtone cutoff, two+ roots above
  const a3rows = report.anchors.a3_loveDispersion.rows;
  assert.equal(a3rows[0].phaseVelsKmS.length, 1);
  assert.ok(a3rows[1].phaseVelsKmS.length >= 2);
  // capability boundary + the gated time-domain case
  assert.match(report.kernel, /no P-SV/);
  assert.ok(report.jivsmCase.pass, 'JIVSM time-domain case regressed');
  assert.ok(report.jivsmCase.peakUm > 1e3 && report.jivsmCase.peakUm < 1e7, `peak ${report.jivsmCase.peakUm}um outside [1e3,1e7]`);
  assert.ok(report.jivsmCase.peakWithinWindow);
  assert.match(report.status, /time-domain case gated/);
});

test('broadband-green — live: vertical-incidence transfer matches physics.js site propagator', () => {
  const layers = [
    { vs: 400, thickness: 30, damping: 0, density: 1.8 },
    { vs: 900, thickness: 200, damping: 0, density: 2.1 },
    { vs: 2200, thickness: 2000, damping: 0, density: 2.5 },
    { vs: 3500, thickness: 0, damping: 0, density: 2.7 }
  ];
  const stack = [
    { topKm: 0, bottomKm: 0.03, vsKmS: 0.4, rhoGcm3: 1.8 },
    { topKm: 0.03, bottomKm: 0.23, vsKmS: 0.9, rhoGcm3: 2.1 },
    { topKm: 0.23, bottomKm: 2.23, vsKmS: 2.2, rhoGcm3: 2.5 },
    { topKm: 2.23, bottomKm: Infinity, vsKmS: 3.5, rhoGcm3: 2.7 }
  ];
  const ref = Physics.shTransferFunction(layers, [1.0, 5.0]);
  for (let i = 0; i < 2; i++) {
    const w = 2 * Math.PI * [1.0, 5.0][i];
    const D = core.shDispersionFunction(stack, w, 1e-6);
    const qT = core.qT_radiation(3.5, w, 1e-6, 0);
    const muH = 2.7 * 1000 * Math.pow(3500, 2);
    const transfer = core.cabs(core.cdiv(core.cmul(qT, [muH, 0]), D));
    assert.ok(Math.abs(transfer - ref[i]) / ref[i] < 0.02, `f=${[1.0, 5.0][i]}: ${transfer} vs ${ref[i]}`);
  }
});

test('broadband-green — live: full-space DW anchor point (coarse grid)', () => {
  const vs = 3.5, rho = 2.7, Q = 50, w = Math.PI;
  const stack = [{ topKm: 0, bottomKm: Infinity, vsKmS: vs, rhoGcm3: rho }];
  const c = { rKm: 60, phiRad: Math.PI / 4, zSourceKm: 10, zReceiverKm: 0, mxx: 1e16, myy: -1e16, mxy: 0 };
  const dw = core.shSpectrumAtFrequency(stack, w, Object.assign({}, c, { dkInvKm: 0.01, kMaxInvKm: 8, halfSpace: true, qShear: Q }));
  const cf = core.fullSpaceClosedForm(vs, rho, 60, Math.PI / 4, 0, 10, w, 1e16, -1e16, 0, Q);
  const amp = core.cabs(dw) / core.cabs(cf);
  assert.ok(Math.abs(amp - 1) < 0.05, `amp ratio ${amp}`);
  const phase = Math.abs(Math.atan2(dw[1], dw[0]) - Math.atan2(cf[1], cf[0]));
  assert.ok(phase < 0.25, `phase ${phase}`);
});
