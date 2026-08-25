'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');

// Pins tools/ensemble-report.js output. Regenerate with
//   node tools/ensemble-report.js
// after any ensemble/physics change that moves the uncertainty calibration.
const R = JSON.parse(fs.readFileSync('tools/data/ensemble-reliability-report.json', 'utf8'));

test('ensemble reliability report covers all frozen-event thresholds with positive Brier skill', () => {
  assert.equal(R.schema, 'quake-sim-ensemble-reliability-v1');
  assert.equal(R.thresholds.length, 4);
  for (const t of R.thresholds) {
    assert.ok(t.n >= 1500, 'pooled sample size ' + t.n);
    assert.ok(t.brierSkill > 0.25, 'Brier skill vs climatology must be clearly positive, got ' + t.brierSkill + ' at I>=' + t.threshold);
  }
});

test('reliability bins are monotone-ish: observed frequency rises with predicted probability', () => {
  for (const t of R.thresholds) {
    const obs = t.reliabilityBins.map(b => b.observedFreq);
    for (let i = 1; i < obs.length; i++) {
      // allow one bin of non-monotonicity (sampling noise on small bins)
      assert.ok(obs[i] >= obs[i - 1] - 0.1,
        'I>=' + t.threshold + ': freq dropped ' + obs[i - 1] + ' -> ' + obs[i]);
    }
    assert.ok(obs[obs.length - 1] - obs[0] > 0.3, 'curve must discriminate (top-bottom gap)');
  }
});

test('member exceedance matches the analytic normal CDF to within 5%', () => {
  assert.ok(R.analyticCrossCheck.pairs > 4000, 'cross-check sample ' + R.analyticCrossCheck.pairs);
  assert.ok(R.analyticCrossCheck.meanAbsDeviation < 0.05,
    'mean |dev| ' + R.analyticCrossCheck.meanAbsDeviation);
});
