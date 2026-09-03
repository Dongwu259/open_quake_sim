// jshis-comparison.test.js — tripwire for the frozen J-SHIS hazard-curve
// comparison (tools/data/jshis-comparison-report.json, the v6.1 R8 external
// gate measurement). The embedded J-SHIS probabilities are LIVE-fetched
// official data (NIED J-SHIS Y2024); these assertions freeze the frozen
// comparison numbers so silent drift turns the suite red, and re-derive the
// Poisson conversion + our tokyo curve from first principles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const r = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'data', 'jshis-comparison-report.json'), 'utf8'));

test('jshis — schema, provenance and basis frozen', () => {
  assert.equal(r.schema, 'quake-sim-jshis-comparison-v1');
  assert.equal(r.provenance.version, 'Y2024');
  assert.equal(r.provenance.case, 'AVR');
  assert.equal(r.provenance.eqcode, 'TTL_MTTL');
  assert.equal(r.provenance.window, 'T30');
  assert.ok(r.basis.confound.includes('no equivalence claim'));
  assert.ok(r.findings.headline.includes('OVERPREDICTS'));
  assert.ok(r.findings.followUpExperiments.join(' ').includes('NOT a calibration input'));
});

test('jshis — frozen comparison numbers (6 sites, honest overprediction locked)', () => {
  assert.equal(r.aggregate.nSites, 6);
  assert.deepEqual(r.aggregate.rp475PgvRatioOursOverJshis, { median: 5.971, min: 1.692, max: 14.537 });
  assert.deepEqual(r.aggregate.midBandMedianLog10RateRatio, { median: 0.805, min: 0.176, max: 1.66 });
  const want = { tokyo: 3.186, osaka: 10.4, sendai: 1.692, kochi: 5.777, nagoya: 5.971, fukuoka: 14.537 };
  for (const s of r.results) assert.equal(s.returnPeriods['475'].ratioOursOverJshis, want[s.site.id], s.site.id);
});

test('jshis — embedded data integrity: monotone curves + Poisson conversion re-derived', () => {
  for (const s of r.results) {
    assert.equal(s.levelsCmS.length, 46);
    for (let i = 1; i < s.levelsCmS.length; i++) {
      assert.ok(s.levelsCmS[i] > s.levelsCmS[i - 1], 'levels not ascending');
      assert.ok(s.jshisProb30[i] <= s.jshisProb30[i - 1] + 1e-9, 'probabilities not monotone');
    }
    for (let i = 0; i < s.levelsCmS.length; i++) {
      const p = s.jshisProb30[i];
      if (s.jshisRateAnnual[i] == null) { assert.ok(p >= 1 - 1e-6); continue; }
      const rate = -Math.log(1 - p) / 30;
      // embedded probs carry 7 decimals: half-ULP/30 ~ 1.7e-9 absolute error
      // dominates relative error for the smallest probabilities
      assert.ok(Math.abs(rate - s.jshisRateAnnual[i]) <= 2e-9 + 0.02 * Math.abs(s.jshisRateAnnual[i]),
        s.site.id + ' level ' + s.levelsCmS[i] + ': conversion ' + rate + ' vs stored ' + s.jshisRateAnnual[i]);
    }
  }
});

test('jshis — our tokyo curve recomputable from the frozen source model (drift guard)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const site = r.results.find((s) => s.site.id === 'tokyo');
  const hz = Physics.hazardCurve(model, { lat: site.site.lat, lng: site.site.lng, vs30: 600 }, 'pgv', { imLevels: site.levelsCmS });
  for (let i = 0; i < site.levelsCmS.length; i++) {
    const stored = site.oursRateAnnual[i], now = hz.meanRate[i];
    assert.ok(Math.abs(now - stored) / Math.max(stored, 1e-12) < 1e-3,
      'level ' + site.levelsCmS[i] + ' cm/s: engine ' + now.toExponential(4) + ' vs stored ' + stored);
  }
});
