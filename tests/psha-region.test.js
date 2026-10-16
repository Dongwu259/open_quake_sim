// psha-region.test.js — v6.7 D regional PSHA source models.
// Gates: pack structure + frozen build numbers per region, the engine's
// gmpeTree consumption (regional crustal = four-model NGA-West2 tree at
// 0.25 each since the v7.x batch — BSSA14+CY14+CB14+ASK14, USGS 2014 NSHM
// convention; Japan path untouched), deterministic hazard anchors at one
// city per region, rate conservation, and the app-side loader contract
// (v1|v2|v3 schema acceptance — the v2 pin parked the card from 2026-09-04
// until this batch's fix).
// UCERF3 batch B (2026-10-12): california is a v3 pack — ComCat cells inside
// the RELM polygon REPLACED by the UCERF3 branch-averaged closed budget
// (gridMfdSources + characteristicSources), double-counting measured and
// eliminated by construction (tools/data/ucerf3-reconcile-report.json);
// LA long-RP hazard rose ~2x to the published-model level (0.63 g @RP475,
// Vs30 600 — official NSHM ballpark, vs the v2 self-computed 0.31 g).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');

const REGIONS = ['california', 'italy', 'chile', 'taiwan', 'newzealand', 'ecuador'];
const SITES = {
  california: { lat: 34.05, lng: -118.24, vs30: 600 },  // Los Angeles
  italy:      { lat: 41.90, lng: 12.50, vs30: 600 },    // Rome
  chile:      { lat: -33.45, lng: -70.66, vs30: 600 },  // Santiago
  taiwan:     { lat: 25.03, lng: 121.57, vs30: 600 },   // Taipei
  newzealand: { lat: -41.29, lng: 174.78, vs30: 600 },  // Wellington
  ecuador:    { lat: -0.18, lng: -78.47, vs30: 600 }    // Quito
};
// Frozen build outputs (cells/mainshocks: 2026-10-01; RP anchors re-based
// 2026-10-06 by the v6.8 NGA-Sub batch — the subduction classes moved from
// zhao2006 (Japan-calibrated) to NGA-Sub Parker 2022 with the frozen
// region/saturation pair, changing subduction-driven hazard: LA unchanged
// (crustal-dominated), Rome -5% (intraslab, Parker global), Santiago +6.5%
// (Parker SA_S lifts megathrust — the v6.7 zhao bias measured -0.55 LOW),
// Taipei -17% (Parker TW constants sit ~1 ln below zhao), Wellington -28%
// (Parker global vs zhao). Deliberate model-form change, frozen here.
// UCERF3 batch B (2026-10-12): california v3 — RELM-interior cells (1,269)
// replaced by UCERF3 closed budget (7,636 grid MFD nodes + 633 characteristic
// sources, FM3.1/FM3.2 0.5/0.5): cells 2885->1616; LA RP475 303.7->618.3 gal
// (+104%), RP2500 605.2->1055.5 (+74%) — the published model concentrates
// rate on the fault traces (deagg dominant: M7.2@4 km characteristic), fixing
// the documented v2 underestimate (vs30-600 official-NSHM ballpark ~0.6 g).
// v7.x NGA-West2 tree batch (2026-10-12): the crustal class moved from
// single-branch BSSA14 to the published four-model NGA-West2 logic tree at
// equal weight 0.25 (BSSA14 keeps its regional Dc3 variant; CY14/CB14/ASK14
// base forms). Measured anchor movement (single-branch -> tree):
//   LA 618.3->651.8 (+5.4%), Rome 91.3->117.0 (+28% — CY14/ASK14 sit well
//   above BSSA14-lowQ's fast-decay crustal branch), Santiago 825.3->826.1
//   (+0.1%, subduction-dominated), Taipei 493.7->502.3, Wellington
//   387.2->387.3. Deliberate model-form change, frozen here.
// Ecuador (2026-10-14 new-region batch): first build on the ComCat window
// (1923+, M>=5.0, 1,092 events -> 898 mainshocks, Mc=5.0@1980), NGA-Sub
// variant SA/SA_N (northern South America, PEER 2020/03 §4.3.4); Quito
// anchors frozen from the v2 pack as built.
const FROZEN = {
  california: { cells: 1616, mainshocks: 685, rp475: 651.8, rp2500: 1094.5 },
  italy:      { cells: 4510, mainshocks: 577, rp475: 117.0, rp2500: 249.5 },
  chile:      { cells: 7940, mainshocks: 3376, rp475: 826.1, rp2500: 1950.1 },
  taiwan:     { cells: 1218, mainshocks: 997, rp475: 502.3, rp2500: 1111.1 },
  newzealand: { cells: 2765, mainshocks: 711, rp475: 387.3, rp2500: 1081.4 },
  ecuador:    { cells: 3387, mainshocks: 898, rp475: 300.5, rp2500: 629.7 }
};

function loadModel(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-' + rid + '.json'), 'utf8'));
}
function loadReport(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha-source-model-report-' + rid + '.json'), 'utf8'));
}

test('regional packs — structure: schema v2 (california v3), region, grid-only scenarios, regional gmpeTree', () => {
  for (const rid of REGIONS) {
    const m = loadModel(rid);
    assert.equal(m.schema, rid === 'california' ? 'quake-sim-psha-source-v3' : 'quake-sim-psha-source-v2', rid);
    assert.equal(m.region, rid, rid);
    assert.ok(Array.isArray(m.cells) && m.cells.length === FROZEN[rid].cells, rid + ' cells');
    // no curated characteristic recurrence rates for the regional packs: honest grid-only
    assert.deepEqual(m.scenarios, [], rid + ' scenarios must be empty (honest absent)');
    const gt = m.gmpeTree;
    // v7.x: crustal = four-model NGA-West2 tree at equal 0.25 (BSSA14 keeps
    // the regional Dc3 variant; CY14/CB14/ASK14 base forms)
    assert.ok(gt && Array.isArray(gt.crustal) && gt.crustal.length === 4, rid + ' gmpeTree crustal 4-branch');
    assert.deepEqual(gt.crustal.map(b => b.model), ['bssa14', 'cy14', 'cb14', 'ask14'], rid + ' crustal tree models');
    for (const b of gt.crustal) assert.equal(b.weight, 0.25, rid + ' ' + b.model + ' weight 0.25');
    assert.equal(gt.crustal[0].variant, rid === 'italy' ? 'lowQ' : 'base', rid + ' BSSA14 variant');
    // v6.8: subduction classes single-branch NGA-Sub with the frozen
    // region/saturation pair (PEER 2020/03 §4.3.4 assignments)
    const EXPECT_VARIANT = {
      california: { region: 'Cascadia', sat: null },
      chile: { region: 'SA', sat: 'SA_S' },
      taiwan: { region: 'TW', sat: 'TW_E' },
      newzealand: { region: null, sat: null },
      italy: { region: null, sat: null },
      ecuador: { region: 'SA', sat: 'SA_N' }
    };
    for (const cls of ['interplate', 'intraslab']) {
      assert.equal(gt[cls][0].model, 'ngasub', rid + ' ' + cls + ' must be NGA-Sub (Parker 2022)');
      assert.deepEqual(gt[cls][0].variant, EXPECT_VARIANT[rid], rid + ' ' + cls + ' variant');
    }
    if (rid === 'california') {
      // UCERF3 batch B v3: RELM-interior ComCat cells replaced by the UCERF3
      // closed budget — the "no characteristic sources" limitation no longer
      // applies; the swap note and the two v3 blocks must be present.
      assert.ok(m.provenance.limitations.some(l => /UCERF3 batch B v3/.test(l)), 'california UCERF3 swap note');
      assert.ok(Array.isArray(m.gridMfdSources) && m.gridMfdSources.length === 7636, 'california gridMfdSources 7636');
      assert.ok(Array.isArray(m.characteristicSources) && m.characteristicSources.length === 633, 'california characteristicSources 633');
      for (const s of m.characteristicSources) {
        assert.equal(s.distanceMetric, 'rjb', s.id + ' rjb metric');
        assert.equal(s.weight, 0.5, s.id + ' FM weight');
        assert.ok(Array.isArray(s.mfd) && s.mfd.length >= 1, s.id + ' mfd');
        assert.ok(Array.isArray(s.patches) && s.patches.length >= 4 && s.patches.length <= 80, s.id + ' patches in [4,80]');
        const mfdSum = s.mfd.reduce((a, b) => a + b[1], 0);
        assert.ok(Math.abs(mfdSum - s.participationRatePerYr) < 1e-9, s.id + ' mfd sums to participation');
      }
      const pk = m.characteristicSources.find(s => /Parkfield/.test(s.name) && s.faultModel === 'FM3.1');
      assert.ok(pk && Math.abs(pk.participationRatePerYr - 0.04666) < 0.002, 'Parkfield characteristic source');
      // apron: no ComCat cells remain inside the RELM polygon
      const poly = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'ucerf3-grid-mfd.json'), 'utf8')).region.polygon;
      const inPoly = (lat, lng) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
          if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
      };
      assert.ok(!m.cells.some(c => inPoly(c.lat, c.lng)), 'no ComCat cells inside RELM polygon');
    } else {
      assert.ok(m.provenance.limitations.some(l => /NO scenario\/characteristic sources/.test(l)), rid + ' limitation note');
    }
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

test('regional engine — gmpeTree consumption: crustal four-model NGA-West2 tree, deterministic RP anchors', () => {
  for (const rid of REGIONS) {
    const m = loadModel(rid);
    const hz = Physics.hazardCurve(m, SITES[rid], 'pga', { years: 50 });
    assert.deepEqual(hz.diagnostics.branchSets, [['bssa14', 'cy14', 'cb14', 'ask14'], ['ngasub'], ['ngasub']], rid + ' branch sets');
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

// v6.9 UHS anchors (2026-10-07 re-base): regional SA/UHS periods now follow
// the pack gmpeTree (crustal BSSA14 — full 107-row table transcribed from the
// same frozen hazardlib boore_2014.py) instead of collapsing to the
// Japan-calibrated zhao2006 single model. Deliberate model-form change;
// RP475 UHS moved as measured on 2026-10-07 (old zhao collapse -> new):
//   LA     0.2s 986.1->673.7 / 1.0s 284.2->190.4  (zhao short-period shape sat high)
//   Rome   0.2s 310.9->195.6 / 1.0s  71.5-> 50.1
//   Santiago 0.2s 2041.8->1827.1 / 1.0s 669.0->451.3 (megathrust class still
//     ngasub at both periods — the shift here is the crustal fraction)
//   Taipei 0.2s 1731.4->1210.4 / 1.0s 424.8->455.4 (BSSA14 long-period shape
//     crosses ABOVE zhao — spectral-shape difference, not a level bias)
//   Wellington 0.2s 1445.7->889.3 / 1.0s 420.7->244.7
// PGA anchors (FROZEN.rp475/rp2500 above) are untouched: the pga path never
// collapsed. Japan keeps the zhao collapse byte-identical (asserted below).
// UCERF3 batch B (2026-10-12): california UHS anchors re-based on the v3 pack
// (UCERF3 closed budget inside RELM) — LA RP475 0.2s 673.7->1362.0 /
// 0.5s 372.5->848.6 / 1.0s 190.4->472.4 (characteristic near-fault sources).
// v7.x NGA-West2 tree batch (2026-10-12 re-base): crustal SA/UHS now follow
// the four-model tree (BSSA14+CY14+CB14+ASK14 at 0.25) instead of BSSA14
// alone. Measured movement (BSSA14-only -> tree):
//   LA     0.2s 1362.0->1600.6 / 0.5s 848.6->1011.9 / 1.0s 472.4->542.6
//   Rome   0.2s  195.6-> 263.2 / 0.5s 100.0-> 147.2 / 1.0s  50.1-> 70.1
//   Santiago 0.2s 1827.1->1835.9 / 0.5s 1014.1->1017.2 / 1.0s 451.3->451.6
//     (megathrust-dominated; the crustal fraction shift is small)
//   Taipei 0.2s 1210.4->1233.3 / 0.5s 905.4->910.3 / 1.0s 455.4->456.3
//   Wellington 0.2s 889.3->889.4 / 0.5s 535.4->536.0 / 1.0s 244.7->245.4
// PGA anchors (FROZEN.rp475/rp2500 above) re-based in the same batch. Japan
// keeps the zhao collapse byte-identical (asserted below).
const FROZEN_UHS_475 = {
  california: { '0.20': 1600.6, '0.50': 1011.9, '1.00': 542.6 },
  italy:      { '0.20': 263.2, '0.50': 147.2, '1.00': 70.1 },
  chile:      { '0.20': 1835.9, '0.50': 1017.2, '1.00': 451.6 },
  taiwan:     { '0.20': 1233.3, '0.50': 910.3, '1.00': 456.3 },
  newzealand: { '0.20': 889.4, '0.50': 536.0, '1.00': 245.4 },
  // Ecuador batch (2026-10-14): Quito anchors from the first v2 pack build
  ecuador:    { '0.20': 736.3, '0.50': 462.7, '1.00': 203.6 }
};
test('regional engine — UHS anchors: crustal SA on the four-model NGA-West2 tree (re-based 2026-10-12)', () => {
  for (const rid of REGIONS) {
    const m = loadModel(rid);
    const periods = ['0.20', '0.50', '1.00'];
    const u = Physics.uhs(m, SITES[rid], [475], { periods, years: 50 });
    periods.forEach((p, i) => {
      const got = u.uhs['475'][i];
      const want = FROZEN_UHS_475[rid][p];
      assert.ok(got != null && Math.abs(got - want) / want < 0.002,
        `${rid} UHS475 ${p}s: ${got} vs frozen ${want}`);
    });
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
  // v6.9: BSSA14 SA rows are transcribed (full 107-row table, same frozen
  // hazardlib source) — the crustal SA tree branch no longer collapses to
  // zhao2006; regional spectral periods now follow the pack gmpeTree.
  // v7.x: the crustal SA tree has all four NGA-West2 branches.
  const sa = Physics._pshaBranchesFor('crustal', 'sa:0.50', loadModel('california'));
  assert.deepEqual(sa.map(b => b.model), ['bssa14', 'cy14', 'cb14', 'ask14']);
  assert.equal(sa[0].variant, 'base');
  const saMo = Physics._pshaBranchMotion('bssa14', 'sa:0.50', 'crustal', 7.0, 30, 10, 600, 0, sa[0].variant);
  assert.ok(saMo && saMo.median > 0 && isFinite(saMo.median), 'crustal SA branch motion finite');
  // a zhao-only period that BSSA14 lacks is impossible on this table (0.65 s
  // IS a bssa14 row; 0.70 s too) — an off-grid period interpolates honestly
  const saInterp = Physics._pshaBranchMotion('bssa14', 'sa:1.75', 'crustal', 7.0, 30, 10, 600, 0, 'base');
  assert.ok(saInterp && saInterp.median > 0, 'off-grid SA period interpolates');
  assert.equal(Physics._pshaBranchMotion('bssa14', 'sa:15.00', 'crustal', 7, 30, 10, 600, 0, 'base'), null,
    'outside [0.01,10] s is honest no-coverage');
});

test('regional engine — ngasub branch motion: pga/pgv/sa, variant forwarding, SA tree consumption', () => {
  const mo = Physics._pshaBranchMotion('ngasub', 'pga', 'interplate', 8.8, 100, 30, 600, 0, { region: 'SA', sat: 'SA_S' });
  assert.ok(mo && mo.median > 200 && mo.median < 260, 'Maule-like median ' + mo.median);
  assert.ok(mo.sigmaLog10 > 0.2 && mo.sigmaLog10 < 0.5, 'sigma ' + mo.sigmaLog10);
  // slab depth scaling: at fixed Rrup, DEEPER intraslab events are STRONGER
  // (fd = m*(zhyp-db)+d, m>0, clamped to d at zhyp>=db — the report's
  // best-fit depth scaling rises with hypocentral depth; inputs here are
  // geometrically consistent, Rrup >= zhyp)
  const shallow = Physics._pshaBranchMotion('ngasub', 'pga', 'intraslab', 7.0, 200, 20, 600, 0, { region: null, sat: null });
  const deep = Physics._pshaBranchMotion('ngasub', 'pga', 'intraslab', 7.0, 200, 120, 600, 0, { region: null, sat: null });
  assert.ok(deep.median > shallow.median, 'intraslab depth scaling rises with zhyp at fixed Rrup');
  // SA capable: subduction classes consume the pack gmpeTree for spectra;
  // exact Parker period and an interpolated zhao-only period both finite
  const tree = Physics._pshaBranchesFor('interplate', 'sa:0.50', loadModel('chile'));
  assert.equal(tree[0].model, 'ngasub', 'subduction SA consumes the ngasub tree');
  const saExact = Physics._pshaBranchMotion('ngasub', 'sa:0.50', 'interplate', 8.8, 100, 30, 600, 0, tree[0].variant);
  const saInterp = Physics._pshaBranchMotion('ngasub', 'sa:0.70', 'interplate', 8.8, 100, 30, 600, 0, tree[0].variant);
  assert.ok(saExact.median > 0 && saInterp.median > 0, 'SA exact + interpolated medians');
  assert.ok(Physics._pshaBranchMotion('ngasub', 'sa:15.00', 'interplate', 8, 100, 30, 600, 0, tree[0].variant) === null,
    'outside [0.01,10] s is honest no-coverage');
  // variant sanity: Taiwan interface constants sit below South-America-South
  const tw = Physics._pshaBranchMotion('ngasub', 'pga', 'interplate', 8.0, 100, 30, 600, 0, { region: 'TW', sat: 'TW_E' });
  const sas = Physics._pshaBranchMotion('ngasub', 'pga', 'interplate', 8.0, 100, 30, 600, 0, { region: 'SA', sat: 'SA_S' });
  assert.ok(tw.median < sas.median, 'TW_E below SA_S at the same condition');
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
  // v6.9 byte-identity: the Japan SA collapse (zhao2006 single model) is
  // untouched by the BSSA14 SA transcription — frozen 2026-10-07.
  const uj = Physics.uhs(m, { lat: 35.68, lng: 139.69, vs30: 600 }, [475],
    { periods: ['0.20', '0.50', '1.00'], years: 50 });
  const TOKYO_SA_475 = { '0.20': 2421.5, '0.50': 1155.2, '1.00': 562.5 };
  ['0.20', '0.50', '1.00'].forEach((p, i) => {
    assert.ok(Math.abs(uj.uhs['475'][i] - TOKYO_SA_475[p]) / TOKYO_SA_475[p] < 0.002,
      `Tokyo UHS475 ${p}s ${uj.uhs['475'][i]} (zhao collapse unchanged)`);
  });
});

test('app-side loader contract — v1|v2|v3 schema acceptance + regional pack routing', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // The v1-only pin (2026-09-04..2026-10-01) parked the card in its waiting
  // state against the bundled v2 Japan model — the check must accept both.
  assert.ok(!/doc\.schema !== 'quake-sim-psha-source-v1'\s*\|\|\s*!Array/.test(src),
    'the v1-only loader pin must not come back');
  assert.ok(src.includes("doc.schema !== 'quake-sim-psha-source-v1' && doc.schema !== 'quake-sim-psha-source-v2' && doc.schema !== 'quake-sim-psha-source-v3'"),
    'loader accepts v1|v2|v3');
  assert.ok(src.includes("'geojson/psha-source-model-' + rid + '.json'"), 'regional pack fetch path');
  assert.ok(src.includes("(doc.region || 'japan') !== (_pshaRegionActive() || 'japan')"), 'region-switch race guard compares the CURRENT scope');
  // TD toggle gating (UCERF3-TD batch B, 2026-10-12): Japan by default; a
  // regional pack opts in via bptReady (California v3 char sources carry
  // bpt.lastEventYear). The old blanket region-disable must not come back.
  assert.ok(!src.includes("pt.disabled = !!_pshaRegionActive()"), 'blanket TD region-disable must not come back');
  assert.ok(src.includes("pt.disabled = !!rid && !regionTdOk"), 'TD toggle disabled for regions without bptReady');
  assert.ok(src.includes("!!(_pshaSourceModel && _pshaSourceModel.bptReady)"), 'TD gate reads the pack bptReady flag');
});

test('UCERF3 batch B — v3 blocks consumed at LA + reconcile report frozen', () => {
  const m = loadModel('california');
  const hz = Physics.hazardCurve(m, SITES.california, 'pga', { years: 50 });
  assert.ok(hz.diagnostics.nGridMfdUsed > 1000, 'grid MFD nodes consumed: ' + hz.diagnostics.nGridMfdUsed);
  assert.ok(hz.diagnostics.nCharUsed > 200, 'characteristic sources consumed: ' + hz.diagnostics.nCharUsed);
  // deaggregation at LA is dominated by near-fault characteristic events
  // (frozen 2026-10-12: top bins M7.2@4 km + M6.7@4 km crustal)
  const dg = Physics.deaggregate(m, SITES.california, 'pga', { returnPeriod: 475 });
  const top = dg.bins[0];
  assert.ok(top.srcType === 'crustal' && top.meanRrupKm < 15 && top.meanMag > 6.5,
    'LA deagg dominated by near-fault characteristic: ' + JSON.stringify({ m: top.meanMag, r: top.meanRrupKm }));
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'ucerf3-reconcile-report.json'), 'utf8'));
  assert.equal(rec.schema, 'quake-sim-ucerf3-reconcile-v1');
  assert.equal(rec.decision.id, 'gamma-replacement-inside-RELM');
  const b65 = rec.bands.find(r => r.threshold === 6.5);
  // pre-swap double-count evidence + post-swap closure are both frozen
  assert.ok(Math.abs(b65.faultShare - 0.825) < 0.01, 'faultShare @M6.5 ' + b65.faultShare);
  assert.ok(b65.packOverUcerf3 < 0.15, 'post-swap apron leakage inside RELM bbox small: ' + b65.packOverUcerf3);
  assert.ok(rec.packV3 && rec.packV3.nGrid === 7636 && rec.packV3.nChar === 633, 'v3 block counts in report');
});

test('comcat regional catalogs — frozen schema, counts above floors', () => {
  const floors = { california: 300, italy: 200, chile: 1000, taiwan: 200, newzealand: 300, ecuador: 400 };
  for (const rid of REGIONS) {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha', 'comcat-' + rid + '.json'), 'utf8'));
    assert.equal(c.schema, 'quake-sim-comcat-region-v1', rid);
    assert.equal(c.region, rid, rid);
    assert.ok(c.count >= floors[rid] && c.events.length === c.count, rid + ' count ' + c.count);
  }
});
