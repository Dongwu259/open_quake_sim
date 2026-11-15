// ================================================================
//  Canterbury aftershock-productivity cross-region validation — locks
//  MEASUREMENT ONLY. Preregistered verdicts: H1 FALSIFIED as measured
//  (the Japan-calibrated law over-predicts the Canterbury 90-day M>=5
//  count by ~25x — outside the declared x3 transferability band),
//  H2 PASS (the sequence outlives the 720-d simulated window).
//  Single-sequence result — no law change, no config change.
//  Run with:  node --test tests/canterbury-etas.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'canterbury-etas-validation-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, law provenance', () => {
  assert.equal(report.schema, 'quake-sim-canterbury-etas-validation-v1');
  assert.match(report.preregistration, /scorecard-canterbury-etas\.js/);
  assert.equal(report.law.productivityLog10, 0.809);
  assert.equal(report.law.asyB, 0.9);
  assert.match(report.note, /MEASUREMENT ONLY/);
  assert.match(report.note, /single-parent Omori/);
});

test('preregistered verdicts frozen: H1 falsified, H2 pass', () => {
  assert.equal(report.hypotheses.H1_transferability_90d_x3band, false, 'H1 frozen falsified');
  assert.equal(report.hypotheses.H2_sequence_outlives_720d_window, true);
});

test('headline numbers byte-frozen: 25x over-prediction, 4/90d observed', () => {
  assert.ok(Math.abs(report.law.nPredM5_90d - 100.377) < 0.001, 'nPred ' + report.law.nPredM5_90d);
  assert.equal(report.observed.windows['90d'], 4);
  assert.equal(report.observed.windows['30d'], 3);
  assert.equal(report.observed.windows['720d'], 23);
  assert.equal(report.observed.aftershocksM5, 24);
  assert.ok(Math.abs(report.ratioPredOverObs90d - 25.0942) < 0.001, 'ratio ' + report.ratioPredOverObs90d);
  // the outliving event: 2016-02-14 M5.8 (Valentine's Day)
  const last = report.observed.outliving720d[report.observed.outliving720d.length - 1];
  assert.match(last.time, /^2016-02-14/);
  assert.equal(last.mag, 5.8);
});

test('determinism: re-running reproduces the frozen prediction and ratio', () => {
  const rerun = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-canterbury-etas.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(Math.abs(rerun.law.nPredM5_90d - report.law.nPredM5_90d) < 1e-9);
  assert.ok(Math.abs(rerun.ratioPredOverObs90d - report.ratioPredOverObs90d) < 1e-9);
  assert.equal(rerun.observed.windows['full'], report.observed.windows['full']);
});
