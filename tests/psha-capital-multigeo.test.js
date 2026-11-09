// psha-capital-multigeo.test.js — tripwire for the R-A research batch
// (open research queue R-A, HANDOVER-2 §4; run 2026-10-17): capital-inland
// M7.3 multi-geometry spreading over official J-SHIS fltinfo fault shapes,
// measured against the R8 eqcode-decomposed J-SHIS component curves and
// REFUTED by the pre-registered gates (MEASURED-NOT-ADOPTED).
//
// Discovery locked here too: the shipped tokyoInland scenario has carried
// NO geometry since PSHA v1 — the engine's point-scenario fallback
// (s.lat ?? 0) parks it at Null Island, so the ERC capital umbrella rate
// contributes ~zero hazard. The R8 LND-arm ratios were measured in that
// state. Revival (single OR multi-geometry) over-predicts the J-SHIS LND
// arm at Tokyo by x5.1/x30.8, so the entry stays geometry-free BY
// MEASUREMENT; if anyone revives it, this suite forces a re-run of R-A.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const faults = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'jshis-capital-faults.json'), 'utf8'));
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha-capital-multigeo-report.json'), 'utf8'));

test('capital-faults — schema, selection rule and inventory frozen', () => {
  assert.equal(faults.schema, 'quake-sim-jshis-capital-faults-v1');
  assert.equal(faults.provenance.version, 'Y2024');
  assert.ok(faults.provenance.license.includes('NIED J-SHIS'));
  // universe + composite exclusion rule registered verbatim
  assert.ok(faults.selectionRule.universe.includes('^F\\d{6}$'));
  assert.ok(faults.selectionRule.primary.includes('[34.9,36.25]'));
  // 231 standalone F-codes fetched, 16 planes selected (strict 11)
  assert.equal(faults.stats.nFetchedFcodes, 231);
  assert.equal(faults.stats.nSelected, 16);
  assert.equal(faults.stats.nSelectedStrict, 11);
  assert.equal(faults.stats.selectedTotalLenKm, 393.0);
  // spot anchors (official rectangle values, verbatim)
  const tachi = faults.faults.find((f) => f.flt_id === 'F015021_00001');
  assert.equal(tachi.code, 'F015021');
  assert.equal(tachi.lenKm, 34.0);
  assert.equal(tachi.dipDeg, 80.0);
  assert.equal(tachi.topDepthKm, 2.0);
  assert.equal(tachi.polygonLngLatDep.length, 5, 'closed quad');
  // the largest entrant is the Fukaya zone; two Hirai-Matsuda-kita planes exist
  assert.equal(faults.selected.find((f) => f.code === 'F014721').lenKm, 72);
  assert.equal(faults.selected.filter((f) => f.code === 'F015521').length, 2);
  // every selected plane's polygon really intersects the registered box
  const box = { latMin: 34.90, latMax: 36.25, lngMin: 139.00, lngMax: 140.45 };
  for (const f of faults.faults.filter((x) => x.selected)) {
    assert.ok(f.polygonLngLatDep.some(([lng, lat]) =>
      lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax), f.code);
  }
});

test('multigeo report — pre-registration and mechanical verdicts locked', () => {
  assert.equal(r.schema, 'quake-sim-psha-capital-multigeo-v1');
  assert.ok(r.preRegistered.note.includes('BEFORE the first measured run'));
  assert.ok(r.preRegistered.discovery.includes('Null Island'));
  // gates registered before the run; verdicts computed mechanically
  assert.equal(Object.keys(r.preRegistered.hypotheses).length, 6);
  assert.equal(r.hypotheses['H-A0'].verdict, 'SUPPORTED');   // R8 reproduction (engine validity)
  assert.equal(r.hypotheses['H-A1'].verdict, 'SUPPORTED');   // revival direction at tokyo
  assert.equal(r.hypotheses['H-A2'].verdict, 'REFUTED');     // nagoya LND moved 0.856 -> 1.033
  assert.equal(r.hypotheses['H-A3'].verdict, 'REFUTED');     // tokyo LND x5.097 > 1.30 ceiling
  assert.equal(r.hypotheses['H-A4'].verdict, 'REFUTED');     // tokyo TTL 1.585 -> 1.911
  assert.equal(r.hypotheses['H-A5'].verdict, 'SUPPORTED');   // weighting robust (x5.097 vs x5.055)
  assert.equal(r.decision.verdict, 'MEASURED-NOT-ADOPTED');
  assert.deepEqual(r.decision.failingGates, ['H-A2', 'H-A3', 'H-A4']);
  // umbrella rate conservation asserted at 1e-4 in every arm
  const rateSum = r.multiSet.reduce((a, e) => a + e.ratePerYear, 0);
  assert.ok(Math.abs(rateSum - r.input.umbrellaRatePerYear) < 1e-4);
  assert.equal(r.input.nFaults, 16);
});

test('multigeo report — frozen Tokyo numbers (the refutation evidence)', () => {
  const t = r.sites.find((s) => s.site.id === 'tokyo');
  // J-SHIS LND at Tokyo is only ~15.6 cm/s RP475; any characteristic
  // revival of the umbrella rate over-predicts it
  assert.equal(t.arms.lndBaseline['475'].jshisPgvCmS, 15.6);
  assert.equal(t.arms.lndBaseline['475'].ratioOursOverJshis, 0.725); // dead-source state = R8
  assert.equal(t.arms.lndSingle['475'].oursPgvCmS, 481.9);           // single revived geometry
  assert.equal(t.arms.lndSingle['475'].ratioOursOverJshis, 30.805);
  assert.equal(t.arms.lndMulti['475'].oursPgvCmS, 79.7);             // official multi-geometry, W1
  assert.equal(t.arms.lndMulti['475'].ratioOursOverJshis, 5.097);
  assert.equal(t.arms.ttlBaseline['475'].ratioOursOverJshis, 1.585);
  assert.equal(t.arms.ttlMulti['475'].ratioOursOverJshis, 1.911);    // R8 PPE-carried conclusion strain
  // far-field: nagoya is the only material mover (0.856 -> 1.033, toward parity)
  const nagoya = r.sites.find((s) => s.site.id === 'nagoya');
  assert.equal(nagoya.arms.lndMulti['475'].ratioOursOverJshis, 1.033);
  const fukuoka = r.sites.find((s) => s.site.id === 'fukuoka');
  assert.equal(fukuoka.arms.lndMulti['475'].ratioOursOverJshis, 0.852);
});

test('multigeo — baseline + multi arms recomputable from the current model and frozen faults (drift guard)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const t = r.sites.find((s) => s.site.id === 'tokyo');
  const st = { lat: t.site.lat, lng: t.site.lng, vs30: 600 };
  const lv = t.arms.lndBaseline; // report stores RP tables only — recompute the grids from the R8 embed
  const r8 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'jshis-decompose-report.json'), 'utf8'));
  const r8t = r8.sites.find((s) => s.site.id === 'tokyo');
  const grid = r8t.jshis.LND_MTTL.levelsCmS;
  const extLevels = grid.concat([320, 350, 400, 450, 500, 600, 700, 850, 1000, 1200]);
  const jshisRate = r8t.jshis.LND_MTTL.prob30.map((p) => (p >= 1 - 1e-6 ? Infinity : (p <= 0 ? 0 : -Math.log(1 - p) / 30)));
  const jshis475 = Physics._pshaInvertCurve(grid, jshisRate.map((v) => (isFinite(v) ? v : 1e9)), 1 / 475);
  // rebuild the exact frozen multi set (same sampling + W1 weights)
  const sel = faults.faults.filter((f) => f.selected);
  const totalLen = sel.reduce((a, f) => a + f.lenKm, 0);
  const entries = sel.map((f) => {
    const poly = f.polygonLngLatDep;
    const nu = Math.max(2, Math.ceil(f.lenKm / 4)), nv = Math.max(2, Math.ceil(f.widKm / 4));
    const patches = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const u = (i + 0.5) / nu, v = (j + 0.5) / nv;
      const pt = [0, 1, 2].map((k) => {
        const top = poly[0][k] + (poly[1][k] - poly[0][k]) * u;
        const bot = poly[3][k] + (poly[2][k] - poly[3][k]) * u;
        return top + (bot - top) * v;
      });
      patches.push([+pt[1].toFixed(4), +pt[0].toFixed(4), +pt[2].toFixed(2)]);
    }
    return {
      id: 'capitalM7_' + f.flt_id, mw: 7.3, ratePerYear: +(0.04013 * f.lenKm / totalLen).toPrecision(4),
      sourceType: 'crustal',
      depthKm: +(patches.reduce((a, p) => a + p[2], 0) / patches.length).toFixed(1),
      patches
    };
  });
  const arm = (scenarios) => Object.assign({}, model, {
    cells: model.cells.filter((c) => c.srcType === 'crustal'),
    scenarios
  });
  const ratio475 = (m) => {
    const hz = Physics.hazardCurve(m, st, 'pgv', { imLevels: extLevels });
    const ours = Physics._pshaInvertCurve(extLevels, hz.meanRate, 1 / 475);
    return ours / jshis475;
  };
  const baseRatio = ratio475(arm(model.scenarios.filter((s) => s.id === 'tokyoInland')));
  const multiRatio = ratio475(arm(entries));
  assert.ok(Math.abs(baseRatio - lv['475'].ratioOursOverJshis) < 0.002,
    'baseline drift: ' + baseRatio + ' vs frozen ' + lv['475'].ratioOursOverJshis);
  assert.ok(Math.abs(multiRatio - t.arms.lndMulti['475'].ratioOursOverJshis) < 0.002,
    'multi drift: ' + multiRatio + ' vs frozen ' + t.arms.lndMulti['475'].ratioOursOverJshis);
});

test('shipped model — tokyoInland stays geometry-free BY MEASUREMENT (dead-source contract)', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const sc = model.scenarios.find((s) => s.id === 'tokyoInland');
  assert.ok(sc, 'entry retained');
  assert.ok(sc.lat == null && sc.lng == null && !sc.patches, 'geometry-free');
  assert.equal(sc.ratePerYear, 0.04013);
  // the pack's own provenance must disclose the state and the R-A pointer
  assert.ok(sc.provenance.geometry.includes('geometry-free'), 'geometry note landed');
  assert.ok(sc.provenance.geometry.includes('psha-capital-multigeo-report.json'), 'R-A report pointer');
  // capitalM7_* entries must NOT exist in the production pack (not adopted)
  assert.ok(!model.scenarios.some((s) => s.id.startsWith('capitalM7_')));
});
