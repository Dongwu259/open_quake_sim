// ================================================================
//  CS multi-anchor study (T*=0.5/2.0 vs shipped 1.0) — tripwire locks
//  STUDY FREEZE: the shipped pipeline report stays T*=1.0; the anchor
//  runs live in .cache. These locks keep the preregistered hypotheses
//  and headline numbers reproducible.
//  Run with:  node --test tests/cs-multi-anchor.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-multi-anchor-report.json'), 'utf8'));
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-pipeline-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, three anchors present', () => {
  assert.equal(report.schema, 'quake-sim-cs-multi-anchor-v1');
  assert.match(report.preregistration, /cs-multi-anchor\.js/);
  assert.deepEqual(Object.keys(report.anchors).sort(), ['0.5', '1.0', '2.0']);
  assert.match(report.note, /STUDY FREEZE/);
  // the shipped T*=1.0 freeze is untouched by the study
  assert.equal(shipped.preRegistered.anchorPeriodSec, 1);
  assert.equal(report.anchors['1.0'].bands['2-5s'].hybrid, shipped.gates.bandAbsMax['2-5s'].hybridAbsMax);
});

test('preregistered verdicts frozen: H-A pass, H-B pass, H-C recorded', () => {
  assert.equal(report.hypotheses.HA_shortBandFailAtAllAnchors, true);
  assert.equal(report.hypotheses.HB_dwImprovementAt2s, true);
  assert.ok(Math.abs(report.hypotheses.HC_midBandT05.t05 - 0.491) < 0.001);
});

test('headline band values byte-frozen across anchors', () => {
  const b = (k) => report.anchors[k].bands;
  assert.ok(Math.abs(b('0.5')['0.1-0.5s'].hybrid - 0.496) < 0.001, 'T0.5 short ' + b('0.5')['0.1-0.5s'].hybrid);
  assert.ok(Math.abs(b('1.0')['0.1-0.5s'].hybrid - 0.776) < 0.001, 'T1.0 short');
  assert.ok(Math.abs(b('2.0')['0.1-0.5s'].hybrid - 1.323) < 0.001, 'T2.0 short (worsens with longer anchor)');
  assert.ok(Math.abs(report.anchors['0.5'].lpImprovement - 0.735) < 0.001);
  assert.ok(Math.abs(report.anchors['2.0'].lpImprovement - 0.203) < 0.001);
  // anchor-dependent PGA non-regression: -0.030 at T*=0.5 vs the shipped +0.125 FAIL
  assert.ok(Math.abs(report.anchors['0.5'].pgaDeltaHybridMinusBrune + 0.030) < 0.001);
  assert.ok(Math.abs(report.anchors['2.0'].pgaDeltaHybridMinusBrune - 0.490) < 0.001);
  // all anchor runs had exact anchors (construction)
  for (const k of ['0.5', '1.0', '2.0']) assert.equal(report.anchors[k].anchorExactPass, true, k);
});
