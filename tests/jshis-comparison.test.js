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
  assert.equal(r.schema, 'quake-sim-jshis-comparison-v2');
  assert.equal(r.provenance.version, 'Y2024');
  assert.equal(r.provenance.sourceModel, 'quake-sim-psha-source-v2');
  assert.equal(r.provenance.case, 'AVR');
  assert.equal(r.provenance.eqcode, 'TTL_MTTL');
  assert.equal(r.provenance.window, 'T30');
  assert.ok(r.basis.confound.includes('no equivalence claim'));
  assert.ok(r.findings.headline.includes('OVERPREDICTS'));
  assert.ok(r.findings.followUpExperiments.join(' ').includes('NOT a calibration input'));
  // v2 (2026-09-09): the pre-registered time-dependent arm landed
  assert.ok(r.findings.followUpExperiments.join(' ').includes('time-dependent arm'));
  assert.ok(r.findings.timeDependentArm.includes('CONFIRMING the pre-registered diagnosis'));
  assert.ok(r.findings.timeDependentArm.includes('NOT a like-for-like tail comparison'));
});

test('jshis — frozen comparison numbers (6 sites, honest overprediction locked)', () => {
  assert.equal(r.aggregate.nSites, 6);
  // v2 segmented-source re-freeze (2026-09-04): J-SHIS curves reused verbatim
  // from the frozen 2026-09-03 fetch (live API unreachable), ours recomputed
  assert.deepEqual(r.aggregate.rp475PgvRatioOursOverJshis, { median: 1.827, min: 1.458, max: 4.227 });
  assert.deepEqual(r.aggregate.midBandMedianLog10RateRatio, { median: 0.422, min: -0.594, max: 0.836 });
  const want = { tokyo: 1.585, osaka: 3.313, sendai: 1.458, kochi: 1.827, nagoya: 1.793, fukuoka: 4.227 };
  for (const s of r.results) assert.equal(s.returnPeriods['475'].ratioOursOverJshis, want[s.site.id], s.site.id);
});

test('jshis — time-dependent arm frozen (v2: mid-band deficit closes, tail is not like-for-like)', () => {
  // aggregate TD locks
  assert.deepEqual(r.aggregate.tdRp475PgvRatioOverJshis, { median: 4.513, min: 1.552, max: 10.94 });
  assert.deepEqual(r.aggregate.tdMidBandMedianLog10RateRatio, { median: 0.667, min: 0.234, max: 1.607 });
  // THE pre-registered scientific claim: every stationary mid-band deficit
  // (kochi -0.594, nagoya -0.15) flips POSITIVE under the BPT engine — J-SHIS
  // carries renewal-elevated mid-band rates at Nankai-adjacent sites
  for (const s of r.results) {
    const stat = s.midBand.medianLog10RateRatio, td = s.timeDependent.midBand.medianLog10RateRatio;
    if (stat != null && stat < 0) assert.ok(td > 0, s.site.id + ': stationary deficit ' + stat + ' must flip positive under BPT, got ' + td);
    assert.equal(s.timeDependent.nBptSources, 3, s.site.id + ': 3 Nankai BPT modes recognised');
  }
  // per-site TD RP475 locks (kochi/nagoya/fukuoka tail uplift; sendai nearest unchanged)
  const tdWant = { tokyo: 2.481, osaka: 7.979, sendai: 1.552, kochi: 4.485, nagoya: 4.513, fukuoka: 10.94 };
  for (const s of r.results) assert.equal(s.timeDependent.returnPeriods['475'].ratioTdOverJshis, tdWant[s.site.id], s.site.id);
});

test('jshis — TD tokyo curve recomputable from the frozen source model (drift guard)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const site = r.results.find((s) => s.site.id === 'tokyo');
  const hzTd = Physics.hazardCurveTimeDependent(model, { lat: site.site.lat, lng: site.site.lng, vs30: 600 }, 'pgv',
    { horizonYears: 30, imLevels: site.levelsCmS });
  for (let i = 0; i < site.levelsCmS.length; i++) {
    const stored = site.timeDependent.oursTdRateAnnual[i], now = hzTd.meanRate[i];
    // TD probabilities saturate at the low-level end (P30 -> 1): the stored
    // equivalent rate is null (Infinity does not survive JSON) — assert the
    // engine agrees the level is saturated instead of comparing ratios
    if (stored == null) { assert.ok(now > 1e9, 'level ' + site.levelsCmS[i] + ' should be saturated, got ' + now); continue; }
    assert.ok(Math.abs(now - stored) / Math.max(stored, 1e-12) < 1e-3,
      'level ' + site.levelsCmS[i] + ' cm/s: TD engine ' + now.toExponential(4) + ' vs stored ' + stored);
  }
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
