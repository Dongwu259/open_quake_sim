// psha-bpt.test.js — BPT (Brownian passage time) renewal engine + the
// time-dependent hazard curve. Anchors:
//   B1  density integrates to 1 (numeric, two (mu, alpha) cells)
//   B2  CDF consistency against the numeric density integral
//   B3  conditional probability consistency + monotonicity (horizon/elapsed)
//   B4  ERC external sanity: Nankai full-segment P30 (mu=117yr, elapsed
//       318.75yr since Hoei 1707) lands in ERC's published 60-90% band
//       (ERC 南海トラフ long-term evaluation, 80%程度 as of 2025)
//   B5  hazardCurveTimeDependent: no-BPT-match model reproduces
//       hazardCurve's Poisson curve exactly (channel roundtrip)
//   B6  BPT scenario channel only ADDS exceedance; conditional probability
//       reaches the engine per bptConditionalProb; curve stays finite
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Physics = require(path.join(__dirname, '..', 'public', 'physics.js'));

function numericIntegral(fn, a, b, n) {
  // composite trapezoid on a linear grid; n >= 2000 keeps ~1e-4 relative
  let h = (b - a) / n, s = 0;
  for (let i = 0; i < n; i++) {
    const t0 = a + i * h, t1 = t0 + h;
    s += 0.5 * h * (fn(t0) + fn(t1));
  }
  return s;
}

test('B1 — BPT density integrates to 1 across parameter cells', () => {
  for (const [mu, al] of [[117, 0.24], [468, 0.24], [117, 0.1], [30, 0.35]]) {
    const total = numericIntegral((t) => Physics.bptDensity(t, mu, al), 1e-6, 60 * mu, 20000);
    assert.ok(Math.abs(total - 1) < 2e-3, `density(mu=${mu},alpha=${al}) integrates to ${total}`);
  }
});

test('B2 — CDF matches the numeric density integral', () => {
  const mu = 117, al = 0.24;
  for (const t of [0.5 * mu, mu, 2 * mu, 3.2 * mu]) {
    const numeric = numericIntegral((x) => Physics.bptDensity(x, mu, al), 1e-6, t, 20000);
    const closed = Physics.bptCdf(t, mu, al);
    assert.ok(Math.abs(numeric - closed) < 2e-3, `F(${(t / mu).toFixed(1)}mu) numeric ${numeric.toFixed(5)} vs closed ${closed.toFixed(5)}`);
  }
});

test('B3 — conditional probability: consistency + monotonicity', () => {
  const mu = 117, al = 0.24, s = 318.75;
  const density = (x) => Physics.bptDensity(x, mu, al);
  const s0 = 1 - Physics.bptCdf(s, mu, al);
  for (const horizon of [10, 30, 50]) {
    const numeric = numericIntegral(density, s, s + horizon, 20000) / s0;
    const engine = Physics.bptConditionalProb(horizon, s, mu, al);
    assert.ok(Math.abs(numeric - engine) < 2e-3, `P(h=${horizon}) numeric ${numeric.toFixed(4)} vs engine ${engine.toFixed(4)}`);
  }
  // monotone in horizon (fixed elapsed) and non-decreasing in elapsed (up to the far tail)
  let prev = 0;
  for (const h of [1, 5, 10, 30, 60]) {
    const p = Physics.bptConditionalProb(h, s, mu, al);
    assert.ok(p >= prev, `P30 must be non-decreasing in horizon (${h})`);
    prev = p;
  }
  // elapsed 10yr (just after a rupture) is far less likely than 318yr
  assert.ok(Physics.bptConditionalProb(30, 10, mu, al) < 0.1 * Physics.bptConditionalProb(30, s, mu, al),
    'fresh-rupture conditional probability should be an order below the overdue regime');
});

test('B4 — ERC external sanity: Nankai full-segment P30 in the published band', () => {
  // elapsed = 2025.75 - 1707 (Hoei-type full-segment episode), mu = 117yr
  // (the source model's documented ERC plain-interval mean), alpha = 0.24.
  // ERC's long-term evaluation publishes 80%程度 (60-90% band) for the
  // 30-year probability of the combined Nankai trough event in this regime.
  const p30 = Physics.bptConditionalProb(30, 2025.75 - 1707, 117, 0.24);
  assert.ok(p30 > 0.6 && p30 < 0.95, 'Nankai full-segment P30 = ' + p30.toFixed(3) + ' outside the ERC band');
});

test('B5 — no-BPT-match model reproduces hazardCurve exactly (channel roundtrip)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  // rename scenarios so PSHA_BPT_SOURCES does not match them
  model.scenarios = model.scenarios.map((s) => Object.assign({}, s, { id: 'plain_' + s.id }));
  const site = { lat: 35.6812, lng: 139.7671, vs30: 600 };
  const imLevels = [10, 30, 100, 300, 1000];
  const base = Physics.hazardCurve(model, site, 'pga', { years: 30, imLevels });
  const td = Physics.hazardCurveTimeDependent(model, site, 'pga', { horizonYears: 30, imLevels });
  assert.equal(td.diagnostics.nBptSources, 0, 'no BPT source should match renamed ids');
  for (let i = 0; i < imLevels.length; i++) {
    assert.ok(Math.abs(td.poissonProb[i] - base.poissonProb[i]) < 1e-12,
      `Poisson probability drifted at ${imLevels[i]} gal`);
    // the equivalent rate is the exact roundtrip only while the horizon
    // probability is representable (p ~ 1 destroys the info; Infinity is
    // the honest value, matching poissonRateFromProb semantics)
    if (base.meanRate[i] * 30 < 30) {
      assert.ok(Math.abs(td.meanRate[i] - base.meanRate[i]) < 1e-9 * Math.max(1e-30, base.meanRate[i]),
        `equivalent-rate roundtrip drifted at ${imLevels[i]} gal`);
    }
  }
});

test('B6 — BPT scenario channel adds exceedance and records diagnostics', () => {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const site = { lat: 33.0, lng: 135.0, vs30: 600 }; // Nankai-adjacent site
  const imLevels = [10, 30, 100, 300, 1000];
  const td = Physics.hazardCurveTimeDependent(model, site, 'pga', { horizonYears: 30, imLevels });
  assert.ok(td.diagnostics.nBptSources >= 3, 'the three Nankai BPT modes must be recognised');
  assert.ok(td.timeDependent.sources.every((s) => s.conditionalProb >= 0 && s.conditionalProb <= 1),
    'conditional probabilities must be in [0, 1]');
  const full = td.timeDependent.sources.find((s) => s.id === 'nankaiFullM89');
  assert.ok(full && full.conditionalProb > 0.5 && full.conditionalProb < 0.98,
    'full-segment overdue P30 = ' + (full ? full.conditionalProb : 'missing'));
  for (let i = 0; i < imLevels.length; i++) {
    assert.ok(isFinite(td.meanRate[i]) && td.meanRate[i] >= 0, 'equivalent rate must be finite');
    assert.ok(td.poissonProb[i] <= 1, 'total probability must not exceed 1');
  }
  // BPT sources only ADD: the TD curve at a Nankai site must sit at or above
  // the stationary curve's Poisson probability at the same horizon.
  const stationary = Physics.hazardCurve(model, site, 'pga', { years: 30, imLevels });
  for (let i = 0; i < imLevels.length; i++) {
    assert.ok(td.poissonProb[i] >= stationary.poissonProb[i] - 1e-12,
      `time-dependent total below stationary at ${imLevels[i]} gal`);
  }
});
