// jshis-decompose.test.js — tripwire for the frozen eqcode-decomposed
// J-SHIS comparison (tools/data/jshis-decompose-report.json, R8
// rectification batch 2026-10-13) and the ERC primary-source scenario-rate
// review (tools/data/erc-scenario-rate-review.json). The J-SHIS side is
// LIVE-fetched official data (Y2024 PPE_MTTL/LND_MTTL/TTL_MTTL); the frozen
// numbers, the pre-registered hypothesis verdicts and the review verdicts
// are locked so silent drift turns the suite red.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'jshis-decompose-report.json'), 'utf8'));
const review = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'erc-scenario-rate-review.json'), 'utf8'));

test('jshis-decompose — schema, provenance and pre-registration frozen', () => {
  assert.equal(r.schema, 'quake-sim-jshis-decompose-v1');
  assert.equal(r.provenance.version, 'Y2024');
  assert.equal(r.provenance.sourceModel, 'quake-sim-psha-source-v2');
  assert.deepEqual(r.provenance.eqcodes, ['TTL_MTTL', 'PPE_MTTL', 'LND_MTTL']);
  assert.equal(r.preRegistered.armMapping.lndEquiv.includes('LND_MTTL'), true);
  assert.ok(r.preRegistered.note.includes('BEFORE the first measured run'));
  assert.ok(r.preRegistered.note.includes('not a calibration input'));
});

test('jshis-decompose — J-SHIS component curves are exhaustive (TTL = PPE union LND)', () => {
  // measured: independence combination reproduces the total curve to <1e-6
  // at every site — the eqcode axis is a complete tectonic partition
  assert.ok(r.aggregate.exhaustivenessMaxAbsProbDiff < 1e-6);
  for (const s of r.sites) {
    assert.ok(s.exhaustiveness.maxAbsProbDiff < 1e-6, s.site.id);
    assert.ok(s.exhaustiveness.levelsCompared >= 30, s.site.id + ' overlap levels');
  }
});

test('jshis-decompose — frozen per-arm RP475 ratios (the residual is subduction-carried)', () => {
  assert.equal(r.aggregate.nSites, 6);
  assert.deepEqual(r.aggregate.rp475RatioMedianByArm, {
    ttl: 1.827, ppeEquiv: 1.827, ppeEquivNoSlab: 1.825, lndEquiv: 0.852, ppeEquivTd: 4.538
  });
  // per-site locks
  const want = {
    tokyo: { ttl: 1.585, ppe: 1.587, lnd: 0.725 },
    osaka: { ttl: 3.313, ppe: 3.692, lnd: 0.58 },
    sendai: { ttl: 1.458, ppe: 1.457, lnd: 1.015 },
    kochi: { ttl: 1.827, ppe: 1.827, lnd: 0.523 },
    nagoya: { ttl: 1.793, ppe: 1.784, lnd: 0.856 },
    fukuoka: { ttl: 4.227, ppe: 6.099, lnd: 0.852 }
  };
  for (const s of r.sites) {
    assert.equal(s.arms.ttl.returnPeriods['475'].ratioOursOverJshis, want[s.site.id].ttl, s.site.id + ' ttl');
    assert.equal(s.arms.ppeEquiv.returnPeriods['475'].ratioOursOverJshis, want[s.site.id].ppe, s.site.id + ' ppe');
    assert.equal(s.arms.lndEquiv.returnPeriods['475'].ratioOursOverJshis, want[s.site.id].lnd, s.site.id + ' lnd');
  }
  // LND is unbiased-to-LOW at 5/6 sites — the 1.83x residual is entirely
  // subduction-side; the crustal GR grid does not overresolve W Japan
  const lndVals = r.sites.map((s) => s.arms.lndEquiv.returnPeriods['475'].ratioOursOverJshis);
  assert.ok(lndVals.filter((v) => v < 1).length >= 5);
});

test('jshis-decompose — pre-registered hypothesis verdicts locked', () => {
  // H1: tail overprediction at kochi/osaka is PPE-carried
  assert.equal(r.hypotheses.H1.verdict, 'SUPPORTED');
  // H2: REFUTED — sendai PPE over-predicts (1.457), no subduction deficit;
  // consistent with ERC carrying the Japan-Trench M9 class at ~0% (30 y)
  assert.equal(r.hypotheses.H2.verdict, 'REFUTED');
  assert.ok(r.hypotheses.H2.measured.sendai.ppe > 1);
  // H3: Vs30 ladder bounded (max 19.7% over 400..800 — the bedrock-basis
  // confound cannot explain the residual)
  assert.equal(r.hypotheses.H3.verdict, 'SUPPORTED');
  assert.equal(r.hypotheses.H3.measured.maxRelativeDeviationAcrossSites, 0.197);
  // mid-band: crustal side under-predicts, PPE TD flip reproduced
  assert.deepEqual(r.aggregate.midBandMedianLog10RateRatioByArm, {
    ttl: 0.422, ppeEquiv: 0.293, ppeEquivNoSlab: 0.204, lndEquiv: -0.146, ppeEquivTd: 0.671
  });
});

test('jshis-decompose — our tokyo component arms recomputable from the current source model (drift guard)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const s = r.sites.find((x) => x.site.id === 'tokyo');
  const st = { lat: s.site.lat, lng: s.site.lng, vs30: 600 };
  const mPpe = Object.assign({}, model, {
    cells: model.cells.filter((c) => c.srcType === 'interplate' || c.srcType === 'intraslab'),
    scenarios: model.scenarios.filter((x) => x.id !== 'tokyoInland')
  });
  const mLnd = Object.assign({}, model, {
    cells: model.cells.filter((c) => c.srcType === 'crustal'),
    scenarios: model.scenarios.filter((x) => x.id === 'tokyoInland')
  });
  const gridPpe = s.jshis.PPE_MTTL.levelsCmS;
  const hzPpe = Physics.hazardCurve(mPpe, st, 'pgv', { imLevels: gridPpe });
  const hzLnd = Physics.hazardCurve(mLnd, st, 'pgv', { imLevels: s.jshis.LND_MTTL.levelsCmS });
  // recompute the frozen RP475 ratios end-to-end (engine + inversion path)
  const extLevels = s.levelsCmS.concat([320, 350, 400, 450, 500, 600, 700, 850, 1000, 1200]);
  const hzPpeExt = Physics.hazardCurve(mPpe, st, 'pgv', { imLevels: extLevels });
  const hzLndExt = Physics.hazardCurve(mLnd, st, 'pgv', { imLevels: extLevels });
  const ppeRate = s.jshis.PPE_MTTL.rateAnnual.map((v) => (v == null ? 1e9 : v));
  const lndRate = s.jshis.LND_MTTL.rateAnnual.map((v) => (v == null ? 1e9 : v));
  const jshisPpe475 = Physics._pshaInvertCurve(gridPpe, ppeRate, 1 / 475);
  const jshisLnd475 = Physics._pshaInvertCurve(s.jshis.LND_MTTL.levelsCmS, lndRate, 1 / 475);
  const oursPpe475 = Physics._pshaInvertCurve(extLevels, hzPpeExt.meanRate, 1 / 475);
  const oursLnd475 = Physics._pshaInvertCurve(extLevels, hzLndExt.meanRate, 1 / 475);
  assert.ok(Math.abs(oursPpe475 / jshisPpe475 - s.arms.ppeEquiv.returnPeriods['475'].ratioOursOverJshis) < 0.002,
    'ppe drift: ' + (oursPpe475 / jshisPpe475) + ' vs frozen ' + s.arms.ppeEquiv.returnPeriods['475'].ratioOursOverJshis);
  assert.ok(Math.abs(oursLnd475 / jshisLnd475 - s.arms.lndEquiv.returnPeriods['475'].ratioOursOverJshis) < 0.002,
    'lnd drift: ' + (oursLnd475 / jshisLnd475) + ' vs frozen ' + s.arms.lndEquiv.returnPeriods['475'].ratioOursOverJshis);
  assert.ok(hzPpe.meanRate.length === gridPpe.length && hzLnd.meanRate.length > 0);
});

test('erc-review — schema, primary sources and per-scenario verdicts frozen', () => {
  assert.equal(review.schema, 'quake-sim-erc-scenario-review-v1');
  assert.equal(review.primarySources.length, 3);
  // primary documents carry sha256 / official URLs
  const ichiran = review.primarySources.find((s) => s.id === 'erc-ichiran-2026');
  assert.equal(ichiran.sha256, 'df8f77cdc487f761c8884c356cba72f321ea43e9ba644b59ee348cc3562c4b3e');
  assert.ok(ichiran.url.startsWith('https://www.jishin.go.jp/'));
  // verdicts: Nankai keep (1/117 == ERC 117.4 yr), capital keep-rate +
  // citation fix (2014 2nd edition), Japan Trench M9 deferred (ERC ~0% TD)
  const nankai = review.scenarios[0];
  assert.ok(nankai.erc.meanIntervalYears === 117.4 && nankai.verdict.startsWith('KEEP'));
  const capital = review.scenarios[1];
  assert.ok(capital.verdict.startsWith('KEEP-RATE / FIX-CITATION'));
  assert.equal(capital.erc.meanIntervalYears, 27.5);
  const jt = review.scenarios[2];
  assert.ok(jt.verdict.startsWith('DEFER'));
  assert.equal(review.reviewOutcome.ratesChanged, false);
});

test('erc-review — model provenance carries the corrected capital citation', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const sc = model.scenarios.find((x) => x.id === 'tokyoInland');
  assert.ok(sc.provenance.rate.includes('2014-04-25'), 'citation fix landed');
  assert.ok(sc.provenance.rate.includes('27.5'), 'primary recurrence interval recorded');
  assert.ok(sc.provenance.rate.includes('erc-scenario-rate-review.json'), 'review pointer recorded');
  assert.equal(sc.ratePerYear, 0.04013, 'rate unchanged (headline 70% back-conversion)');
});
