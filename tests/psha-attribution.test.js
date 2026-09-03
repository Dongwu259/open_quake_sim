// psha-attribution.test.js — tripwire for the frozen PSHA overprediction
// attribution (tools/data/psha-attribution-report.json). Locks the frozen
// decomposition numbers so silent drift turns the suite red, re-derives the
// tokyo baseline/endpoint arms and the per-class additivity identity from
// first principles. This is a measurement decomposition, NOT a calibration
// input — assertions here exist to keep the frozen numbers honest.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha-attribution-report.json'), 'utf8'));

test('attribution — schema, arms and chain frozen', () => {
  assert.equal(r.schema, 'quake-sim-psha-attribution-v1');
  assert.deepEqual(r.basis.arms.map((a) => a.id), [
    'baseline', 'zhaoOnly', 'noScenarios', 'zhaoOnlyNoScenarios',
    'psv1p20', 'psv1p35', 'sigma0p80', 'gridZhaoPsv'
  ]);
  assert.deepEqual(r.basis.decompositionChain, ['baseline', 'noScenarios', 'zhaoOnlyNoScenarios', 'gridZhaoPsv']);
  assert.ok(r.basis.comparison.includes('NOT re-fetched'));
  const sigmaArm = r.basis.arms.find((a) => a.id === 'sigma0p80');
  assert.ok(sigmaArm.label.includes('DIAGNOSTIC'), 'sigma arm must stay labelled diagnostic');
});

test('attribution — frozen decomposition numbers locked', () => {
  // v2 segmented-source re-freeze (2026-09-04)
  assert.equal(r.aggregate.armRatioMedian.baseline, 1.827);
  assert.equal(r.aggregate.armRatioMedian.zhaoOnly, 1.395);
  assert.equal(r.aggregate.armRatioMedian.noScenarios, 0.923);
  assert.equal(r.aggregate.armRatioMedian.zhaoOnlyNoScenarios, 0.948);
  assert.equal(r.aggregate.armRatioMedian.psv1p20, 1.756);
  assert.equal(r.aggregate.armRatioMedian.psv1p35, 1.72);
  assert.equal(r.aggregate.armRatioMedian.sigma0p80, 1.713);
  assert.equal(r.aggregate.armRatioMedian.gridZhaoPsv, 0.702);
  assert.deepEqual(r.aggregate.chainMedian, { dropScenarios: 0.218, zhaoCollapse: 0.946, psvFactor: 0.741 });
  assert.deepEqual({ median: r.aggregate.scenarioShareMedian, min: r.aggregate.scenarioShareMin, max: r.aggregate.scenarioShareMax },
    { median: 0.9729, min: 0.0358, max: 0.9965 });
  assert.ok(r.aggregate.classRateAdditivityMaxRelative < 1e-4, 'class rates must re-sum to the baseline rate');
});

test('attribution — findings carry the honest direction and levers', () => {
  assert.ok(r.findings.headline.includes('v2 SEGMENTED source model'));
  assert.ok(r.findings.residualStructure.includes('time-dependent engine is the honest next step'));
  assert.ok(r.findings.scenarioDomination.includes('grid-dominated'));
  assert.ok(r.findings.honestyNote.includes('no engine parameter was tuned'));
  assert.ok(r.findings.honestyNote.includes('INDEPENDENT source'));
});

test('attribution — monotonicity: removing sources can only lower the curve', () => {
  for (const s of r.sites) {
    for (const rp of ['475', '1000', '2500', '5000']) {
      const a = s.arms.baseline[rp].oursPgvCmS, b = s.arms.noScenarios[rp].oursPgvCmS;
      if (a == null || b == null) continue;
      assert.ok(b <= a + 0.11, s.site.id + ' RP' + rp + ': noScenarios ' + b + ' must not exceed baseline ' + a);
    }
  }
});

test('attribution — tokyo baseline + chain endpoint + class additivity recomputable (drift guard)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const site = r.sites.find((s) => s.site.id === 'tokyo');
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'jshis-comparison-report.json'), 'utf8'));
  const fr = frozen.results.find((s) => s.site.id === 'tokyo');
  const extLevels = fr.levelsCmS.concat([320, 350, 400, 450, 500, 600, 700, 850, 1000, 1200]);
  const where = { lat: site.site.lat, lng: site.site.lng, vs30: 600 };

  const base = Physics.hazardCurve(model, where, 'pgv', { imLevels: extLevels });
  const baseRp475 = Physics._pshaInvertCurve(extLevels, base.meanRate, 1 / 475);
  assert.ok(Math.abs(baseRp475 - site.arms.baseline['475'].oursPgvCmS) < 0.05,
    'tokyo baseline RP475 drift: ' + baseRp475 + ' vs stored ' + site.arms.baseline['475'].oursPgvCmS);

  // re-apply the endpoint arm patch (zhao-only + no scenarios + PSV/1.35)
  const modelNoScen = Object.assign({}, model, { scenarios: [] });
  const origBranches = Physics._pshaBranchesFor, origMotion = Physics._pshaBranchMotion;
  Physics._pshaBranchesFor = (srcType, imt) => (String(imt).slice(0, 3) === 'sa:') ? origBranches(srcType, imt) : [{ model: 'zhao2006', weight: 1 }];
  Physics._pshaBranchMotion = function(modelName, imt, srcType, mw, rRupKm, depthKm, vs30, rake) {
    const m = origMotion.call(Physics, modelName, imt, srcType, mw, rRupKm, depthKm, vs30, rake);
    if (!m) return m;
    return { median: (modelName === 'zhao2006' && imt === 'pgv') ? m.median / 1.35 : m.median, sigmaLog10: m.sigmaLog10 };
  };
  let endRp475;
  try {
    const end = Physics.hazardCurve(modelNoScen, where, 'pgv', { imLevels: extLevels });
    endRp475 = Physics._pshaInvertCurve(extLevels, end.meanRate, 1 / 475);
  } finally {
    Physics._pshaBranchesFor = origBranches;
    Physics._pshaBranchMotion = origMotion;
  }
  assert.ok(Math.abs(endRp475 - site.arms.gridZhaoPsv['475'].oursPgvCmS) < 0.05,
    'tokyo endpoint RP475 drift: ' + endRp475 + ' vs stored ' + site.arms.gridZhaoPsv['475'].oursPgvCmS);

  // per-class rates at the baseline level must re-sum (engine additivity)
  const rateAt = (curve, level) => {
    const lv = curve.imLevels, rt = curve.meanRate;
    if (level <= lv[0]) return rt[0];
    if (level >= lv[lv.length - 1]) return rt[rt.length - 1];
    for (let i = 1; i < lv.length; i++) if (lv[i] >= level) {
      const x0 = Math.log10(lv[i - 1]), x1 = Math.log10(lv[i]);
      const fac = x1 === x0 ? 0 : (Math.log10(level) - x0) / (x1 - x0);
      return Math.exp(Math.log(Math.max(rt[i - 1], 1e-300)) + fac * (Math.log(Math.max(rt[i], 1e-300)) - Math.log(Math.max(rt[i - 1], 1e-300))));
    }
    return rt[rt.length - 1];
  };
  let sum = 0;
  for (const cls of ['crustal', 'interplate', 'intraslab']) {
    const sub = Object.assign({}, model, { cells: model.cells.filter((c) => c.srcType === cls), scenarios: [] });
    sum += rateAt(Physics.hazardCurve(sub, where, 'pgv', { imLevels: extLevels }), baseRp475);
  }
  for (const sc of model.scenarios) {
    const sub = Object.assign({}, model, { cells: [], scenarios: [sc] });
    sum += rateAt(Physics.hazardCurve(sub, where, 'pgv', { imLevels: extLevels }), baseRp475);
  }
  const total = rateAt(base, baseRp475);
  assert.ok(Math.abs(sum - total) / total < 1e-3, 'tokyo class additivity: ' + sum + ' vs ' + total);
  const storedShareSum = Object.values(site.classSharesAtBaselineRp475.shares).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(storedShareSum - 1) < 1e-3, 'stored shares must sum to 1, got ' + storedShareSum);
});
