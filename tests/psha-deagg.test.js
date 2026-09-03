// psha-deagg.test.js — v6.1 CS-pipeline groundwork acceptance for
// Physics.deaggregate. The bin/branch bookkeeping is verified against an
// independently written deaggregation loop (same semantics, separate code
// path) plus conservation against Physics.hazardCurve's mean rate at the
// conditioning level. Absolute hazard levels vs J-SHIS remain the separate
// pending external gate and are NOT asserted here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

function tinyModel() {
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

/** Independent deaggregation re-derivation: same GR bins / Rrup proxy /
 *  branch mix / CCDF helper, but its own bin-keying and accumulation.
 *  Returns a flat list of {srcType, mag, rRupKm, depthKm, rate, eps, lat, lng}. */
function closedFormContribs(model, site, imt, imTarget) {
  const out = [];
  const logT = Math.log10(imTarget);
  const push = (srcType, mag, rRup, depth, rate, lat, lng) => {
    for (const br of Physics.logicTreeBranches(srcType)) {
      const mo = Physics._pshaBranchMotion(br.model, imt, srcType, mag, rRup, depth, site.vs30, Physics.PSHA_CLASS_RAKE[srcType]);
      if (!mo || !(mo.median > 0)) continue;
      const z = (logT - Math.log10(mo.median)) / mo.sigmaLog10;
      const p = Physics.exceedanceProbability(mo.median, mo.sigmaLog10, imTarget);
      if (p > 0) out.push({ srcType, mag, rRupKm: rRup, depthKm: depth, rate: br.weight * rate * p, eps: z, lat, lng });
    }
  };
  for (const c of model.cells) {
    const hd = Physics.haversineDist(site.lat, site.lng, c.lat, c.lng);
    const b = model.bValues[c.srcType];
    const mMax = model.mMaxByClass[c.srcType];
    const hyp = Math.sqrt(hd * hd + c.depthKm * c.depthKm);
    for (let m = model.mMin; m <= mMax + 1e-9; m += 0.1) {
      const lam = c.rateMc * (Math.pow(10, -b * (m - model.mc)) - Math.pow(10, -b * (m + 0.1 - model.mc)));
      if (!(lam > 1e-9)) continue;
      const mm = Math.min(m + 0.05, mMax);
      push(c.srcType, mm, Physics._pshaPointRrup(hyp, mm, c.srcType), c.depthKm, lam, c.lat, c.lng);
    }
  }
  for (const s of model.scenarios || []) {
    let rRup, depth, slat, slng;
    if (s.patches && s.patches.length) {
      rRup = Infinity; depth = s.depthKm != null ? s.depthKm : 0;
      for (const p of s.patches) {
        const d3 = Math.sqrt(Math.pow(Physics.haversineDist(site.lat, site.lng, p[0], p[1]), 2) + p[2] * p[2]);
        if (d3 < rRup) { rRup = d3; slat = p[0]; slng = p[1]; }
      }
    } else {
      depth = s.depthKm != null ? s.depthKm : 15;
      slat = s.lat || 0; slng = s.lng || 0;
      const hd = Physics.haversineDist(site.lat, site.lng, slat, slng);
      rRup = Physics._pshaPointRrup(Math.sqrt(hd * hd + depth * depth), s.mw, s.sourceType || 'crustal');
    }
    push(s.sourceType || 'crustal', s.mw, Math.max(rRup, 0.1), depth, s.ratePerYear, slat, slng);
  }
  return out;
}

function keyOf(row) { return row.srcType + '|' + Math.floor(row.mag / 0.5 + 1e-9) + '|' + rBinOf(row.rRupKm); }
function rBinOf(r) {
  const edges = [0, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, Infinity];
  for (let i = 1; i < edges.length - 1; i++) if (r < edges[i]) return i - 1;
  return edges.length - 2;
}

test('deagg — matches an independent bin/branch accumulation, bin by bin', () => {
  const model = tinyModel();
  const IM = 120; // gal
  const d = Physics.deaggregate(model, SITE, 'pga', { imTarget: IM });
  assert.ok(d, 'deaggregate returned null');
  const expect = {};
  for (const row of closedFormContribs(model, SITE, 'pga', IM)) {
    const k = keyOf(row);
    if (!expect[k]) expect[k] = { rate: 0, eps: 0, mag: 0, rRup: 0, lat: 0, lng: 0 };
    const e = expect[k];
    e.rate += row.rate; e.eps += row.rate * row.eps; e.mag += row.rate * row.mag;
    e.rRup += row.rate * row.rRupKm; e.lat += row.rate * row.lat; e.lng += row.rate * row.lng;
  }
  assert.equal(d.bins.length, Object.keys(expect).length, 'bin count mismatch');
  for (const bin of d.bins) {
    const e = expect[bin.srcType + '|' + bin.magBin + '|' + bin.rBin];
    assert.ok(e, 'unexpected bin ' + JSON.stringify(bin.srcType + bin.magBin + bin.rBin));
    const rel = (a, b) => Math.abs(a - b) / Math.max(1e-30, Math.abs(b));
    assert.ok(rel(bin.rate, e.rate) < 1e-12, 'rate ' + bin.rate + ' vs ' + e.rate);
    assert.ok(rel(bin.meanEps, e.eps / e.rate) < 1e-10, 'meanEps');
    assert.ok(rel(bin.meanMag, e.mag / e.rate) < 1e-10, 'meanMag');
    assert.ok(rel(bin.meanRrupKm, e.rRup / e.rate) < 1e-10, 'meanRrup');
    assert.ok(rel(bin.repr.lat, e.lat / e.rate) < 1e-10 && rel(bin.repr.lng, e.lng / e.rate) < 1e-10, 'repr geometry');
  }
});

test('deagg — contribution conservation vs hazardCurve mean rate at the level', () => {
  const model = tinyModel();
  const IM = 120;
  const hz = Physics.hazardCurve(model, SITE, 'pga', { imLevels: [IM] });
  const d = Physics.deaggregate(model, SITE, 'pga', { imTarget: IM });
  assert.ok(Math.abs(d.totalRate - hz.meanRate[0]) <= 1e-15 * Math.max(1e-30, Math.abs(hz.meanRate[0])) + 1e-18,
    'totalRate=' + d.totalRate.toExponential(6) + ' vs hazard=' + hz.meanRate[0].toExponential(6));
});

test('deagg — probabilities sum to 1; means are prob-weighted; bins sorted by rate', () => {
  const model = tinyModel();
  const d = Physics.deaggregate(model, SITE, 'pga', { imTarget: 120 });
  let pSum = 0, m = 0, r = 0, eps = 0;
  for (const bin of d.bins) pSum += bin.prob;
  assert.ok(Math.abs(pSum - 1) < 1e-12, 'prob sum ' + pSum);
  for (const bin of d.bins) { m += bin.prob * bin.meanMag; r += bin.prob * bin.meanRrupKm; eps += bin.prob * bin.meanEps; }
  assert.ok(Math.abs(m - d.mean.mw) < 1e-12 && Math.abs(r - d.mean.rRupKm) < 1e-12 && Math.abs(eps - d.mean.eps) < 1e-12);
  for (let i = 1; i < d.bins.length; i++) assert.ok(d.bins[i].rate <= d.bins[i - 1].rate + 1e-30);
  // bin geometry bounds: every mean mag/rrup inside the bin's own edges
  for (const bin of d.bins) {
    assert.ok(bin.meanMag >= bin.magLo - 1e-9 && bin.meanMag <= bin.magHi + 1e-9, 'mag outside bin');
    assert.ok(bin.meanRrupKm >= bin.rLo - 1e-9 && (bin.rHi == null || bin.meanRrupKm <= bin.rHi + 1e-9), 'rrup outside bin');
  }
});

test('deagg — returnPeriod inversion matches the uhs anchor convention', () => {
  const model = tinyModel();
  const rp = 475;
  const hz = Physics.hazardCurve(model, SITE, 'pga', {});
  const want = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / rp);
  const d = Physics.deaggregate(model, SITE, 'pga', { returnPeriod: rp });
  assert.ok(d && d.imTarget === want, 'imTarget ' + (d && d.imTarget) + ' vs ' + want);
  // conditioning rate sanity: total exceedance rate at that level ~ 1/RP
  assert.ok(Math.abs(d.totalRate - 1 / rp) / (1 / rp) < 0.35,
    'deagg rate ' + d.totalRate.toExponential(3) + ' vs 1/RP ' + (1 / rp).toExponential(3) + ' (grid interpolation slack)');
  assert.equal(null, Physics.deaggregate(model, SITE, 'pga', {}));
});

test('deagg — longer return period shifts mass toward larger magnitudes', () => {
  const model = tinyModel();
  const d100 = Physics.deaggregate(model, SITE, 'pga', { returnPeriod: 100 });
  const d2500 = Physics.deaggregate(model, SITE, 'pga', { returnPeriod: 2500 });
  assert.ok(d100 && d2500);
  assert.ok(d2500.mean.mw > d100.mean.mw,
    'mean Mw not increasing with RP: ' + d100.mean.mw.toFixed(3) + ' -> ' + d2500.mean.mw.toFixed(3));
  assert.ok(d2500.imTarget > d100.imTarget);
});

test('deagg — scenario source lands in its own bin with the nearest-patch repr', () => {
  const model = tinyModel();
  model.cells = [];
  model.scenarios = [
    { id: 'testPatch', mw: 8.0, ratePerYear: 0.01, sourceType: 'interplate', depthKm: 20,
      patches: [[35.0, 135.0, 20], [34.0, 134.0, 30], [33.0, 133.0, 40]] }
  ];
  const d = Physics.deaggregate(model, SITE, 'pga', { imTarget: 200 });
  assert.ok(d && d.bins.length === 1, 'expected exactly one bin, got ' + (d && d.bins.length));
  const bin = d.bins[0];
  assert.equal(bin.srcType, 'interplate');
  assert.equal(bin.magBin, 16); // M8.0 -> [8.0, 8.5)
  assert.equal(bin.rBin, 2); // Rrup 20 km -> [20, 30)
  // nearest patch to the site is patch 1 (3-D distance 20 km)
  assert.ok(Math.abs(bin.repr.lat - 35.0) < 1e-9 && Math.abs(bin.repr.lng - 135.0) < 1e-9);
  assert.ok(Math.abs(bin.repr.mw - 8.0) < 1e-12);
  assert.equal(d.classShares.interplate, 1);
  assert.equal(d.diagnostics.nScenarios, 1);
});

test('deagg — SA imt path runs through the zhao single-model branches', () => {
  const model = tinyModel();
  const d = Physics.deaggregate(model, SITE, 'sa:1.00', { imTarget: 80 });
  assert.ok(d);
  assert.equal(d.imt, 'sa:1.00');
  assert.ok(d.bins.length >= 1 && d.totalRate > 0);
  assert.equal(d.diagnostics.vs30, 600);
});
