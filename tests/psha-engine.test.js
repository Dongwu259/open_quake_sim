// psha-engine.test.js — v6.1 P1 pre-registered acceptance for Physics.hazardCurve.
// The engine's INTEGRATION bookkeeping is verified against an independently
// written bin/branch loop (closed-form anchor) and a seeded Monte Carlo
// Poisson-catalog simulation; the GMPEs, sigma tables and logic-tree weights
// are themselves frozen by tests/gmpe-benchmarks.test.js and are inputs here.
// Absolute hazard LEVELS vs the official J-SHIS curves are a pending external
// gate (user data acquisition) and are deliberately NOT asserted here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

// ---------------------------------------------------------------- helpers
function tinyModel() {
  // one crustal cell 20 km south of the site, no scenarios
  return {
    schema: 'quake-sim-psha-source-v1', mc: 5.0, mMin: 5.0,
    bValues: { crustal: 0.85, interplate: 1.1, intraslab: 1.1 },
    mMaxByClass: { crustal: 7.2, interplate: 7.8, intraslab: 7.8 },
    cells: [
      { lat: 34.82, lng: 135.0, srcType: 'crustal', rateMc: 0.02, depthKm: 12 },
      { lat: 34.82, lng: 135.2, srcType: 'crustal', rateMc: 0.01, depthKm: 25 }
    ],
    scenarios: []
  };
}

const SITE = { lat: 35.0, lng: 135.0, vs30: 600 };

/** Independent re-derivation of the mean curve with the documented semantics:
 *  incremental GR bins at 0.1 from mMin to class mMax, equal-area circular
 *  Rrup proxy, logic-tree-weighted CCDF mix per bin. */
function closedFormMean(model, site, imt, imLevels, opts) {
  opts = opts || {};
  const mStep = 0.1, maxDist = opts.maxDistKm != null ? opts.maxDistKm : 500;
  const out = new Array(imLevels.length).fill(0);
  for (const c of model.cells) {
    const hd = Physics.haversineDist(site.lat, site.lng, c.lat, c.lng);
    if (hd > maxDist) continue;
    const b = model.bValues[c.srcType];
    const mMax = model.mMaxByClass[c.srcType];
    const hyp = Math.sqrt(hd * hd + c.depthKm * c.depthKm);
    for (let m = model.mMin; m <= mMax + 1e-9; m += mStep) {
      const lam = c.rateMc * (Math.pow(10, -b * (m - model.mc)) - Math.pow(10, -b * (m + mStep - model.mc)));
      if (!(lam > 1e-9)) continue;
      const mm = Math.min(m + mStep / 2, mMax);
      const rRup = Physics._pshaPointRrup(hyp, mm, c.srcType);
      for (const br of Physics.logicTreeBranches(c.srcType)) {
        const mo = Physics._pshaBranchMotion(br.model, imt, c.srcType, mm, rRup, c.depthKm, site.vs30, Physics.PSHA_CLASS_RAKE[c.srcType]);
        if (!mo || !(mo.median > 0)) continue;
        for (let i = 0; i < imLevels.length; i++) {
          out[i] += br.weight * lam * Physics.exceedanceProbability(mo.median, mo.sigmaLog10, imLevels[i]);
        }
      }
    }
  }
  return out;
}

test('psha — closed-form anchor: engine matches independent bin/branch integration', () => {
  const model = tinyModel();
  const imLevels = [10, 30, 60, 100, 200, 400];
  const hz = Physics.hazardCurve(model, SITE, 'pga', { imLevels });
  const expect = closedFormMean(model, SITE, 'pga', imLevels, {});
  for (let i = 0; i < imLevels.length; i++) {
    assert.ok(Math.abs(hz.meanRate[i] - expect[i]) <= 1e-12 * Math.max(1e-30, Math.abs(expect[i])) + 1e-18,
      `im=${imLevels[i]} engine=${hz.meanRate[i].toExponential(6)} closed-form=${expect[i].toExponential(6)}`);
  }
  assert.equal(hz.diagnostics.nScenarios, 0);
});

test('psha — Monte Carlo Poisson-catalog cross-check (pre-registered |ln rate| < 0.08)', () => {
  const model = tinyModel();
  const IM = 100; // gal
  const hz = Physics.hazardCurve(model, SITE, 'pga', { imLevels: [IM] });
  const rateEngine = hz.meanRate[0];

  // Aggregate over all (cell, bin): draw total event count Poisson(lambda*T),
  // assign each event to a (cell, bin) by rate share, draw the logic-tree
  // branch by weight and a log10-normal residual with that branch's sigma.
  const draws = []; // {rate, branchIdx} per (cell,bin,branch) — branch drawn per event
  const hyps = [];
  for (const c of model.cells) {
    const hd = Physics.haversineDist(SITE.lat, SITE.lng, c.lat, c.lng);
    const b = model.bValues[c.srcType];
    const mMax = model.mMaxByClass[c.srcType];
    const hyp = Math.sqrt(hd * hd + c.depthKm * c.depthKm);
    for (let m = model.mMin; m <= mMax + 1e-9; m += 0.1) {
      const lam = c.rateMc * (Math.pow(10, -b * (m - model.mc)) - Math.pow(10, -b * (m + 0.1 - model.mc)));
      if (!(lam > 1e-9)) continue;
      hyps.push({ lam, srcType: c.srcType, mm: Math.min(m + 0.05, mMax), rRup: Physics._pshaPointRrup(hyp, Math.min(m + 0.05, mMax), c.srcType), depth: c.depthKm });
    }
  }
  const lamTotal = hyps.reduce((a, h) => a + h.lam, 0);
  const T = 1e6; // simulated years (aggregate Poisson draw, not per-year loop)
  const rng = Physics.seededRng(20260901);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const poisson = (lam) => { // Knuth for small lambda, normal approx above
    if (lam <= 30) { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; }
    const g = gauss(); return Math.max(0, Math.round(lam + Math.sqrt(lam) * g));
  };
  const nEvents = poisson(lamTotal * T);
  let nExceed = 0;
  const branchesCache = {};
  for (let e = 0; e < nEvents; e++) {
    // pick (cell,bin) by rate share
    let r = rng() * lamTotal, idx = 0;
    for (; idx < hyps.length - 1; idx++) { r -= hyps[idx].lam; if (r <= 0) break; }
    const h = hyps[idx];
    if (!branchesCache[h.srcType]) branchesCache[h.srcType] = Physics.logicTreeBranches(h.srcType);
    const branches = branchesCache[h.srcType];
    let w = rng(), bi = 0;
    for (; bi < branches.length - 1; bi++) { w -= branches[bi].weight; if (w <= 0) break; }
    const mo = Physics._pshaBranchMotion(branches[bi].model, 'pga', h.srcType, h.mm, h.rRup, h.depth, SITE.vs30, Physics.PSHA_CLASS_RAKE[h.srcType]);
    if (!mo || !(mo.median > 0)) continue;
    const logA = Math.log10(mo.median) + mo.sigmaLog10 * gauss();
    if (Math.pow(10, logA) > IM) nExceed++;
  }
  const rateMC = nExceed / T;
  const dln = Math.abs(Math.log(rateMC / rateEngine));
  assert.ok(dln < 0.08, `MC=${rateMC.toExponential(3)} engine=${rateEngine.toExponential(3)} |ln|=${dln.toFixed(3)}`);
});

test('psha — mean rate strictly non-increasing in IM; single-class mean bounded by branch-set ensemble', () => {
  const model = tinyModel();
  const hz = Physics.hazardCurve(model, SITE, 'pga', {});
  for (let i = 1; i < hz.imLevels.length; i++) {
    assert.ok(hz.meanRate[i] <= hz.meanRate[i - 1] + 1e-15, `rate increased at im=${hz.imLevels[i]}`);
  }
  // single-class model: mean is a convex combination of per-branch rates
  for (let i = 0; i < hz.imLevels.length; i++) {
    const lo = Math.min(hz.ensemble[0][i], hz.ensemble[1][i], hz.ensemble[2][i]);
    const hi = Math.max(hz.ensemble[0][i], hz.ensemble[1][i], hz.ensemble[2][i]);
    assert.ok(hz.meanRate[i] >= lo - 1e-15 && hz.meanRate[i] <= hi + 1e-15,
      `im=${hz.imLevels[i]} mean=${hz.meanRate[i].toExponential(3)} ensemble=[${lo.toExponential(3)},${hi.toExponential(3)}]`);
  }
});

test('psha — Poisson helpers round-trip', () => {
  assert.equal(Physics.poissonExceedProb(0, 50), 0);
  assert.ok(Math.abs(Physics.poissonExceedProb(0.01, 50) - (1 - Math.exp(-0.5))) < 1e-12);
  for (const rate of [0.001, 0.02, 0.4]) {
    const p = Physics.poissonExceedProb(rate, 30);
    assert.ok(Math.abs(Physics.poissonRateFromProb(p, 30) - rate) < 1e-12);
  }
  assert.equal(Physics.poissonRateFromProb(0.75, 30), -Math.log(0.25) / 30); // scenario-rate convention
});

test('psha — scenario patches: min-3D-distance Rrup and diagnostics', () => {
  const model = tinyModel();
  model.cells = []; // isolate the scenario
  model.scenarios = [
    { id: 'testPatch', mw: 8.0, ratePerYear: 0.01, sourceType: 'interplate', depthKm: 20,
      patches: [[35.0, 135.0, 20], [34.0, 134.0, 30], [33.0, 133.0, 40]] }
  ];
  const hz = Physics.hazardCurve(model, SITE, 'pga', { imLevels: [50, 200, 600] });
  assert.equal(hz.diagnostics.nScenarios, 1);
  assert.equal(hz.diagnostics.nCellsUsed, 0);
  // site sits on patch 1 (3-D distance 20 km): M8 interplate at Rrup 20 must
  // exceed 200 gal at a non-trivial rate
  assert.ok(hz.meanRate[1] > 1e-3, `patch scenario rate@200gal=${hz.meanRate[1]}`);
  assert.ok(hz.meanRate[0] > hz.meanRate[1] && hz.meanRate[1] > hz.meanRate[2]);
});

test('psha — PGV path runs and is monotone', () => {
  const hz = Physics.hazardCurve(tinyModel(), SITE, 'pgv', {});
  assert.ok(hz.imLevels.length > 10);
  for (let i = 1; i < hz.meanRate.length; i++) assert.ok(hz.meanRate[i] <= hz.meanRate[i - 1] + 1e-15);
  assert.ok(hz.meanRate.every(v => isFinite(v) && v >= 0));
});

test('psha — _pshaInvertCurve brackets, clamps and rejects out-of-grid targets', () => {
  const im = [1, 10, 100], rates = [1e-1, 1e-3, 1e-5]; // rates descend with IM
  const mid = Physics._pshaInvertCurve(im, rates, 1e-4);
  assert.ok(Math.abs(mid - Math.sqrt(10 * 100)) < 1e-9); // log-mid interpolation
  assert.ok(Math.abs(Physics._pshaInvertCurve(im, rates, 1e-2) - Math.sqrt(10)) < 1e-9);
  assert.strictEqual(Physics._pshaInvertCurve(im, rates, 2e-1), null); // rarer than grid top
  assert.strictEqual(Physics._pshaInvertCurve(im, rates, 1e-7), null); // more frequent than grid bottom
  assert.strictEqual(Physics._pshaInvertCurve(im, rates, 1e-1), 1);    // exactly the top level
});

test('psha — SA period imt: branch collapse, degenerate ensemble, monotone curve', () => {
  const model = tinyModel();
  const hz = Physics.hazardCurve(model, SITE, 'sa:1.00', {});
  assert.equal(hz.diagnostics.singleModel, true);
  for (const set of hz.diagnostics.branchSets) {
    assert.deepEqual(set, ['zhao2006']); // si-mid/kanno publish no SA rows
  }
  for (let i = 1; i < hz.meanRate.length; i++) assert.ok(hz.meanRate[i] <= hz.meanRate[i - 1] + 1e-15);
  // degenerate ensemble = mean curve copies
  for (let i = 0; i < hz.meanRate.length; i++) {
    assert.strictEqual(hz.ensemble[0][i], hz.ensemble[2][i]);
  }
});

test('psha — UHS: RP monotonicity and PGA cross-consistency (frozen model)', () => {
  const fs = require('fs');
  const model = JSON.parse(fs.readFileSync(require.resolve('../public/geojson/psha-source-model.json'), 'utf8'));
  const periods = ['0.20', '0.50', '1.00', '2.00', '5.00'];
  const u = Physics.uhs(model, { lat: 35.68, lng: 139.76, vs30: 600 }, [475, 2500], { periods });
  assert.deepEqual(u.periodsSec, [0.2, 0.5, 1, 2, 5]);
  for (let i = 0; i < periods.length; i++) {
    const a = u.uhs['475'][i], b = u.uhs['2500'][i];
    if (a != null && b != null) assert.ok(b >= a, `RP monotonicity at T=${periods[i]}s`);
    assert.ok(a == null || (a > 0.1 && a < 3200), `UHS 475 range at ${periods[i]}`);
  }
  assert.ok(u.pga['475'] > 100 && u.pga['475'] < 3000, `pga 475 = ${u.pga['475']}`);
  assert.ok(u.pga['2500'] >= u.pga['475']);
  assert.equal(u.diagnostics.singleModel, true);
});

test('psha — full frozen model smoke: Tokyo curve sane, conservation honoured', () => {
  const fs = require('fs');
  const model = JSON.parse(fs.readFileSync(require.resolve('../public/geojson/psha-source-model.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(require.resolve('../tools/data/psha-source-model-report.json'), 'utf8'));
  // modelled Mc-rate equals the declustered catalog rate per class (renormalised)
  for (const cls of ['crustal', 'interplate', 'intraslab']) {
    assert.ok(Math.abs(report.rateConservation[cls].ratioAfter - 1) <= 0.005, cls);
  }
  const hz = Physics.hazardCurve(model, { lat: 35.68, lng: 139.76 }, 'pga', { years: 30 });
  assert.ok(hz.diagnostics.nCellsUsed > 1000);
  assert.ok(hz.diagnostics.nScenarios === 4); // v2: 3 Nankai modes + tokyoInland
  const at = (gal) => { const i = hz.imLevels.findIndex(v => v >= gal) - 1; return hz.meanRate[i]; };
  // documented sanity anchors (rock Vs30=600): 100 gal every few years near
  // Tokyo is consistent with observed shindo-5+ occurrence there; 800 gal is
  // rare. Absolute-level comparison vs J-SHIS is the pending external gate.
  assert.ok(at(100) > 0.01 && at(100) < 5, `100gal rate=${at(100)}`);
  assert.ok(at(800) < 0.02 && at(800) > 1e-5, `800gal rate=${at(800)}`);
  // Nankai scenario must register at a Shikoku site
  const hzSk = Physics.hazardCurve(model, { lat: 33.5, lng: 133.5 }, 'pga', { imLevels: [800] });
  assert.ok(hzSk.meanRate[0] > 1e-5, `nankai contribution at Shikoku=${hzSk.meanRate[0].toExponential(2)}`);
});
