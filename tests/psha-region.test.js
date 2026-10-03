// psha-region.test.js — v6.7 D regional PSHA source models.
// Gates: pack structure + frozen build numbers per region, the engine's
// gmpeTree consumption (regional crustal = BSSA14 single branch, Japan path
// untouched), deterministic hazard anchors at one city per region, rate
// conservation, and the app-side loader contract (v1|v2 schema acceptance —
// the v2 pin parked the card from 2026-09-04 until this batch's fix).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');

const REGIONS = ['california', 'italy', 'chile', 'taiwan', 'newzealand'];
const SITES = {
  california: { lat: 34.05, lng: -118.24, vs30: 600 },  // Los Angeles
  italy:      { lat: 41.90, lng: 12.50, vs30: 600 },    // Rome
  chile:      { lat: -33.45, lng: -70.66, vs30: 600 },  // Santiago
  taiwan:     { lat: 25.03, lng: 121.57, vs30: 600 },   // Taipei
  newzealand: { lat: -41.29, lng: 174.78, vs30: 600 }   // Wellington
};
// Frozen build outputs (2026-10-01, tools/build-psha-source-model.js --region):
const FROZEN = {
  california: { cells: 2885, mainshocks: 685, rp475: 303.7, rp2500: 605.2 },
  italy:      { cells: 4510, mainshocks: 577, rp475: 96.2,  rp2500: 216.1 },
  chile:      { cells: 7940, mainshocks: 3376, rp475: 774.7, rp2500: 1877.9 },
  taiwan:     { cells: 1218, mainshocks: 997, rp475: 592.5, rp2500: 1240.2 },
  newzealand: { cells: 2765, mainshocks: 711, rp475: 537.4, rp2500: 1415.1 }
};

function loadModel(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-' + rid + '.json'), 'utf8'));
}
function loadReport(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha-source-model-report-' + rid + '.json'), 'utf8'));
}

test('regional packs — structure: schema v2, region, grid-only scenarios, regional gmpeTree', () => {
  for (const rid of REGIONS) {
    const m = loadModel(rid);
    assert.equal(m.schema, 'quake-sim-psha-source-v2', rid);
    assert.equal(m.region, rid, rid);
    assert.ok(Array.isArray(m.cells) && m.cells.length === FROZEN[rid].cells, rid + ' cells');
    // no curated characteristic recurrence rates for the regional packs: honest grid-only
    assert.deepEqual(m.scenarios, [], rid + ' scenarios must be empty (honest absent)');
    const gt = m.gmpeTree;
    assert.ok(gt && Array.isArray(gt.crustal) && gt.crustal.length === 1, rid + ' gmpeTree');
    assert.equal(gt.crustal[0].model, 'bssa14', rid + ' crustal must be BSSA14 (si-mid/kanno are Japan-calibrated)');
    assert.equal(gt.crustal[0].weight, 1);
    assert.equal(gt.crustal[0].variant, rid === 'italy' ? 'lowQ' : 'base', rid + ' BSSA14 variant');
    assert.equal(gt.interplate[0].model, 'zhao2006', rid + ' interplate');
    assert.equal(gt.intraslab[0].model, 'zhao2006', rid + ' intraslab');
    assert.ok(m.provenance.limitations.some(l => /NO scenario\/characteristic sources/.test(l)), rid + ' limitation note');
    // Italy has no registered subduction front -> no interplate class at all
    if (rid === 'italy') {
      assert.ok(!m.cells.some(c => c.srcType === 'interplate'), 'italy must carry no interplate cells');
    }
  }
});

test('regional packs — frozen decluster counts and exact rate conservation', () => {
  for (const rid of REGIONS) {
    const r = loadReport(rid);
    assert.equal(r.schema, 'quake-sim-psha-source-model-report-v1', rid);
    assert.equal(r.region, rid, rid);
    assert.equal(r.declusteredMainshocks, FROZEN[rid].mainshocks, rid + ' mainshocks');
    for (const cls of ['crustal', 'interplate', 'intraslab']) {
      const cons = r.rateConservation[cls];
      if (!cons || cons.catalogRate === 0) continue; // class absent in this region (italy interplate)
      assert.ok(Math.abs(cons.ratioAfter - 1) < 1e-3, rid + ' ' + cls + ' rate conservation ' + cons.ratioAfter);
    }
    // regional reports must NOT carry the Japan B2 pre-registration block
    assert.ok(!('preRegisteredB2' in r), rid + ' report must not carry preRegisteredB2');
  }
});

test('regional engine — gmpeTree consumption: crustal BSSA14 branch, deterministic RP anchors', () => {
  for (const rid of REGIONS) {
    const m = loadModel(rid);
    const hz = Physics.hazardCurve(m, SITES[rid], 'pga', { years: 50 });
    assert.deepEqual(hz.diagnostics.branchSets, [['bssa14'], ['zhao2006'], ['zhao2006']], rid + ' branch sets');
    assert.ok(hz.diagnostics.nCellsUsed > 100, rid + ' cells used');
    // monotonic non-increasing exceedance rates
    for (let i = 1; i < hz.meanRate.length; i++) assert.ok(hz.meanRate[i] <= hz.meanRate[i - 1] + 1e-12, rid + ' monotonic');
    const rp475 = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 475);
    const rp2500 = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 2500);
    assert.ok(Math.abs(rp475 - FROZEN[rid].rp475) / FROZEN[rid].rp475 < 0.002, rid + ' RP475 ' + rp475);
    assert.ok(Math.abs(rp2500 - FROZEN[rid].rp2500) / FROZEN[rid].rp2500 < 0.002, rid + ' RP2500 ' + rp2500);
  }
});

test('regional engine — uhs + deaggregate smoke at every regional city', () => {
  for (const rid of REGIONS) {
    const m = loadModel(rid);
    const u = Physics.uhs(m, SITES[rid], [475], { periods: ['0.20', '1.00'], years: 50 });
    const row = u.uhs['475'];
    assert.ok(row[0] > row[1] && row[1] > 0, rid + ' uhs ordering 0.2s > 1s');
    const dg = Physics.deaggregate(m, SITES[rid], 'pga', { returnPeriod: 475 });
    assert.ok(dg && dg.bins.length > 10, rid + ' deagg bins');
    const share = dg.bins.reduce((a, b) => a + b.rate, 0);
    assert.ok(share > 0, rid + ' deagg total rate positive');
  }
});

test('regional engine — bssa14 branch motion: finite median + positive sigma (pga/pgv)', () => {
  for (const imt of ['pga', 'pgv']) {
    const mo = Physics._pshaBranchMotion('bssa14', imt, 'crustal', 7.0, 30, 10, 600, 0, 'base');
    assert.ok(mo && mo.median > 0 && isFinite(mo.median), imt + ' median');
    assert.ok(mo.sigmaLog10 > 0.1 && mo.sigmaLog10 < 0.5, imt + ' sigma ' + mo.sigmaLog10);
  }
  // variant forwarding: lowQ (Japan/Italy Dc3) decays faster than base at long range
  const a = Physics._pshaBranchMotion('bssa14', 'pga', 'crustal', 7.0, 300, 10, 600, 0, 'lowQ');
  const b = Physics._pshaBranchMotion('bssa14', 'pga', 'crustal', 7.0, 300, 10, 600, 0, 'base');
  assert.ok(a.median < b.median, 'lowQ must attenuate below base at 300 km');
  // SA imt still collapses to the zhao2006 single model regardless of gmpeTree
  const sa = Physics._pshaBranchesFor('crustal', 'sa:0.50', loadModel('california'));
  assert.deepEqual(sa, [{ model: 'zhao2006', weight: 1 }]);
});

test('Japan path untouched — no gmpeTree, three-branch logic tree, Tokyo anchor', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  assert.ok(!m.gmpeTree, 'Japan model must not carry a gmpeTree');
  assert.equal(m.region, 'japan');
  const br = Physics._pshaBranchesFor('crustal', 'pga', m);
  assert.equal(br.length, 3);
  assert.deepEqual(br.map(x => x.model), ['si-midorikawa', 'kanno2006', 'zhao2006']);
  const hz = Physics.hazardCurve(m, { lat: 35.68, lng: 139.69, vs30: 600 }, 'pga', { years: 50 });
  const rp475 = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 475);
  assert.ok(Math.abs(rp475 - 901.9) / 901.9 < 0.002, 'Tokyo RP475 anchor ' + rp475);
});

test('app-side loader contract — v1|v2 schema acceptance + regional pack routing', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // The v1-only pin (2026-09-04..2026-10-01) parked the card in its waiting
  // state against the bundled v2 Japan model — the check must accept both.
  assert.ok(!/doc\.schema !== 'quake-sim-psha-source-v1'\s*\|\|\s*!Array/.test(src),
    'the v1-only loader pin must not come back');
  assert.ok(src.includes("doc.schema !== 'quake-sim-psha-source-v1' && doc.schema !== 'quake-sim-psha-source-v2'"),
    'loader accepts v1|v2');
  assert.ok(src.includes("'geojson/psha-source-model-' + rid + '.json'"), 'regional pack fetch path');
  assert.ok(src.includes("(doc.region || 'japan') !== (_pshaRegionActive() || 'japan')"), 'region-switch race guard compares the CURRENT scope');
  // TD toggle disabled in region mode (regional packs carry no BPT sources)
  assert.ok(src.includes("pt.disabled = !!_pshaRegionActive()"), 'TD toggle region disable');
});

test('comcat regional catalogs — frozen schema, counts above floors', () => {
  const floors = { california: 300, italy: 200, chile: 1000, taiwan: 200, newzealand: 300 };
  for (const rid of REGIONS) {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha', 'comcat-' + rid + '.json'), 'utf8'));
    assert.equal(c.schema, 'quake-sim-comcat-region-v1', rid);
    assert.equal(c.region, rid, rid);
    assert.ok(c.count >= floors[rid] && c.events.length === c.count, rid + ' count ' + c.count);
  }
});
