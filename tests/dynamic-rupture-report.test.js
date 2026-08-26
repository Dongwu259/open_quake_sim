// R6-2: finite-fault-v1 round trip + frozen-report tripwires (v6.0).
// A9: a solver run exported through exportFiniteFault must pass the
//     browser's FiniteFault.parse + Physics.sourceBudget without flags.
// A10: the frozen experiment report (tools/data/dynamic-rupture-report.json,
//     produced by `node tools/dynamic-rupture/run-experiment.js --suite=all
//     --write`) holds its pre-registered gates — TPV5-AP nucleation/propaga-
//     tion, SH convergence, PSV propagation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cfg = require('../tools/dynamic-rupture/configs.js');
const { exportFiniteFault } = require('../tools/dynamic-rupture/export-finite-fault.js');
const { advance } = require('../tools/dynamic-rupture/run-experiment.js');
const FiniteFault = require('../public/finite-fault.js');
const Physics = require('../public/physics.js');

test('A9 finite-fault-v1 export round-trips through the browser parser', () => {
  const S = cfg.makeShSpont({ dx: 100, halfLen: 2500, xHalf: 6000, zHalf: 8000, nucHalf: 700 });
  advance(S, 3.0, [], 1);
  const doc = exportFiniteFault(S, {
    hypoLat: 35.5, hypoLng: 139.5, alongStrikeKm: 20,
    label: 'test', eventId: 'DYNRUP-TEST-001'
  });
  assert.ok(doc.patches.length >= 10, 'patch count ' + doc.patches.length);
  const model = FiniteFault.parse(JSON.parse(JSON.stringify(doc)));
  assert.strictEqual(model.schema, 'quake-sim-finite-fault-v1');
  assert.ok(model.mw > 5 && model.mw < 9, 'exported Mw ' + model.mw.toFixed(2));
  // moment consistency: parse must reproduce the export's stated moment
  assert.ok(Math.abs(model.totalMomentNm - doc.event.momentNm) / doc.event.momentNm < 0.02,
    'moment drift ' + (Math.abs(model.totalMomentNm - doc.event.momentNm) / doc.event.momentNm).toExponential(2));
  // slip survived normalization
  const maxSlip = model.patches.reduce((v, p) => Math.max(v, p.slipM), 0);
  assert.ok(maxSlip > 0.5, 'max slip through parser ' + maxSlip.toFixed(2) + ' m');
  // the R6-1 diagnostics run clean on the dynamic source (no consistency flags).
  // The Eshelby equivalent drop sits ABOVE the 7 MPa config drop: the 2D
  // rupture's dynamic overshoot (plus the overstressed nucleation patch)
  // carries extra slip — the equivalent drop is a diagnostic, not the input.
  const budget = Physics.sourceBudget(model);
  assert.ok(budget && budget.flags.length === 0, 'sourceBudget flags ' + JSON.stringify(budget && budget.flags));
  assert.ok(budget.stressDropMPa > 0.5 && budget.stressDropMPa < 45,
    'Eshelby equivalent drop ' + budget.stressDropMPa.toFixed(2) + ' MPa');
  assert.ok(budget.ruptureSpeedKmS != null && budget.ruptureSpeedKmS > 1.0,
    'rupture speed fit ' + budget.ruptureSpeedKmS);
});

test('A10 frozen dynamic-rupture report holds its gates', () => {
  const p = path.join(__dirname, '..', 'tools', 'data', 'dynamic-rupture-report.json');
  const report = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(report.schema, 'quake-sim-dynamic-rupture-report-v1');
  const t5 = report.experiments.tpv5apHalfspace;
  assert.ok(t5, 'TPV5-AP experiment present');
  assert.ok(t5.hypoSlipM > 0.4, 'hypocenter slip ' + t5.hypoSlipM + ' m > d0=0.4');
  assert.ok(t5.downDipSpeed > 0.3 * 3464 && t5.downDipSpeed < 0.99 * 3464,
    'down-dip speed ' + t5.downDipSpeed);
  assert.ok(t5.upDipSpeed > 0.3 * 3464 && t5.upDipSpeed < 0.99 * 3464,
    'up-dip speed ' + t5.upDipSpeed);
  assert.ok(t5.stationSeries.length === 10, 'station count ' + t5.stationSeries.length);
  for (const st of t5.stationSeries) {
    assert.ok(st.series.length > 100, 'station ' + st.name + ' series length ' + st.series.length);
  }
  const sh = report.experiments.shSpont;
  assert.ok(sh && sh.dx100 && sh.dx50, 'SH convergence pair present');
  assert.ok(Math.abs(sh.dx100.centerSlipM - sh.dx50.centerSlipM) /
    Math.max(sh.dx100.centerSlipM, sh.dx50.centerSlipM) < 0.3,
    'SH center slip dx100=' + sh.dx100.centerSlipM.toFixed(2) + ' dx50=' + sh.dx50.centerSlipM.toFixed(2));
  for (const k of ['dx100', 'dx50'])
    assert.ok(sh[k].frontSpeed > 0.4 * 3464 && sh[k].frontSpeed < 0.99 * 3464,
      k + ' front speed ' + sh[k].frontSpeed);
  const psv = report.experiments.psvSpont;
  assert.ok(psv.S157.rupturedFraction > 0.6, 'PSV S=1.57 ruptured ' + psv.S157.rupturedFraction);
  // honest record: mode-II front speeds may exceed cR (Burridge-Andrews) —
  // recorded as an open calibration item, NOT gated (see PHYSICS_BENCHMARKS)
  assert.ok(report.export && report.export.patches > 10 && report.export.mw > 4,
    'export block ' + JSON.stringify(report.export));
});
