// ================================================================
//  UCERF3 sections data batch (v7 queue item 1, batch A) — frozen
//  artifact tools/data/ucerf3-sections-california.json
//  (schema quake-sim-ucerf3-sections-v1) produced by
//  tools/fetch-ucerf3-sections.js from the Zenodo branch-averaged
//  UCERF3 fault-system solutions (DOI 10.5281/zenodo.5519802,
//  CC BY 4.0; Field et al. 2014 OFR 2013-1165/BSSA 104(3)).
//  Pre-registered count anchors come from the availability report
//  (docs/UCERF3-AVAILABILITY.md §4, measured 2026-10-07):
//    FM3.1: 253,706 ruptures / 2,606 subsections / total fault rate
//    0.469 /yr / Mmax 8.34; San Andreas (Parkfield) subsections
//    1922–1926 participate at ~0.045 /yr.
//  FM3.2 counts (305,709 / 2,664 / 0.4763 /yr) were frozen at the
//  first successful parse 2026-10-12.
//  Run with:  node --test tests/ucerf3-sections.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'ucerf3-sections-california.json'), 'utf8'));

test('schema + provenance', () => {
  assert.equal(DOC.schema, 'quake-sim-ucerf3-sections-v1');
  assert.equal(DOC.provenance.doi, '10.5281/zenodo.5519802');
  assert.equal(DOC.provenance.license, 'CC BY 4.0');
  assert.equal(DOC.provenance.tool, 'tools/fetch-ucerf3-sections.js');
  assert.ok(/Field et al\. \(2014\)/.test(DOC.provenance.citation), 'UCERF3 citation');
  const sols = DOC.provenance.solutions;
  assert.equal(sols.length, 2);
  const byModel = Object.fromEntries(sols.map((s) => [s.faultModel, s]));
  assert.equal(byModel['FM3.1'].sha256, '6804ba8e76bf65b2c18ca4b665f900db79c8d84e51639e23515a6e3e2b5902ce');
  assert.equal(byModel['FM3.1'].bytes, 17405961);
  assert.equal(byModel['FM3.2'].sha256, '714b1061aa3086c0b136334b796675f2dd021a905f8ec5d4b542598a1f04c2f7');
  assert.equal(byModel['FM3.2'].bytes, 19525785);
  assert.ok(DOC.units && DOC.units.participationRatePerYr === '1/yr');
  assert.ok(Array.isArray(DOC.notes) && DOC.notes.length >= 3, 'honesty notes present');
});

test('FM3.1 pre-registered count anchors (availability report §4)', () => {
  const m = DOC.models['FM3.1'];
  assert.ok(m, 'FM3.1 model block');
  assert.equal(m.ruptureCount, 253706);
  assert.equal(m.subsectionCount, 2606);
  assert.equal(m.parentCount, 313);
  assert.ok(Math.abs(m.totalFaultRatePerYr - 0.4694) < 0.002, 'total fault rate ' + m.totalFaultRatePerYr);
  assert.ok(Math.abs(m.mmaxOverall - 8.34) < 0.005, 'Mmax ' + m.mmaxOverall);
  assert.equal(m.branchAveraged, true);
});

test('FM3.2 frozen count anchors (first parse 2026-10-12)', () => {
  const m = DOC.models['FM3.2'];
  assert.ok(m, 'FM3.2 model block');
  assert.equal(m.ruptureCount, 305709);
  assert.equal(m.subsectionCount, 2664);
  assert.equal(m.parentCount, 320);
  assert.ok(Math.abs(m.totalFaultRatePerYr - 0.4763) < 0.002, 'total fault rate ' + m.totalFaultRatePerYr);
  assert.ok(Math.abs(m.mmaxOverall - 8.34) < 0.005, 'Mmax ' + m.mmaxOverall);
});

test('San Andreas (Parkfield) participation anchor, both models', () => {
  for (const [key, expected] of [['FM3.1', 0.04666], ['FM3.2', 0.04622]]) {
    const m = DOC.models[key];
    const pk = m.parents.find((p) => /Parkfield/.test(p.name));
    assert.ok(pk, key + ' Parkfield parent present');
    assert.equal(pk.name, 'San Andreas (Parkfield)');
    assert.ok(Math.abs(pk.participationRatePerYr - expected) < 0.002,
      key + ' Parkfield participation ' + pk.participationRatePerYr + ' vs ' + expected);
    assert.ok(Math.abs(pk.mmax - 8.34) < 0.005);
    // length-weighted means: Parkfield is vertical strike-slip, fast slip, shallow
    assert.ok(Math.abs(pk.dipDeg - 90) < 1, 'dip ' + pk.dipDeg);
    assert.ok(Math.abs(pk.rakeDeg) < 1 || Math.abs(Math.abs(pk.rakeDeg) - 180) < 1, 'rake ' + pk.rakeDeg);
    assert.ok(pk.slipRateMmPerYr > 25 && pk.slipRateMmPerYr < 35, 'slip ' + pk.slipRateMmPerYr);
    assert.equal(pk.upperDepthKm, 0);
    assert.ok(pk.lowerDepthKm > 9 && pk.lowerDepthKm < 12, 'lower depth ' + pk.lowerDepthKm);
  }
  // report §4 subsection-level cross-check: subsections 1922–1925 each ~0.045 /yr
  const subs = DOC.models['FM3.1'].subsections;
  for (const id of [1922, 1923, 1924, 1925]) {
    assert.ok(Math.abs(subs[id].participationRatePerYr - 0.045) < 0.003,
      'subsection ' + id + ' rate ' + subs[id].participationRatePerYr);
    assert.equal(subs[id].parentId, 32);
    assert.ok(Math.abs(subs[id].mmax - 8.34) < 0.005);
  }
});

test('internal consistency: parent participation ∈ [max sub, Σ sub]; counts close; charMfd sums', () => {
  for (const key of ['FM3.1', 'FM3.2']) {
    const m = DOC.models[key];
    let nSubs = 0;
    for (const p of m.parents) {
      assert.equal(p.subsectionCount, p.subsectionIds.length, p.name + ' subsection count');
      nSubs += p.subsectionCount;
      const rates = p.subsectionIds.map((id) => m.subsections[id].participationRatePerYr);
      const mx = Math.max(...rates);
      const sum = rates.reduce((a, b) => a + b, 0);
      assert.ok(p.participationRatePerYr >= mx - 1e-12, p.name + ' parent rate below max subsection rate');
      assert.ok(p.participationRatePerYr <= sum + 1e-12, p.name + ' parent rate above sum of subsection rates');
      assert.ok(Number.isFinite(p.mmax) && p.mmax >= 5 && p.mmax <= 8.5, p.name + ' mmax sane');
      assert.ok(p.slipRateMmPerYr >= 0 && p.slipRateMmPerYr <= 50, p.name + ' slip rate sane');
      assert.ok(p.dipDeg > 0 && p.dipDeg <= 90, p.name + ' dip sane');
      assert.ok(p.lowerDepthKm > p.upperDepthKm, p.name + ' depth ordering');
      // charMfd: ascending 0.1 bins inside [mmax floor, mmax], sums to participation exactly
      let prev = -Infinity;
      let mfdSum = 0;
      for (const [mag, rate] of p.charMfd) {
        assert.ok(mag > prev, p.name + ' charMfd ascending');
        prev = mag;
        assert.ok(rate > 0, p.name + ' charMfd positive');
        assert.ok(mag <= p.mmax + 0.06, p.name + ' charMfd bin above mmax');
        mfdSum += rate;
      }
      assert.ok(p.charMfd.length >= 1, p.name + ' charMfd non-empty');
      assert.ok(Math.abs(mfdSum - p.participationRatePerYr) < 1e-9,
        p.name + ' charMfd sum ' + mfdSum + ' != participation ' + p.participationRatePerYr);
    }
    assert.equal(nSubs, m.subsectionCount, key + ' subsection total');
    assert.equal(m.subsections.length, m.subsectionCount);
  }
});

test('geometry: dense subsection ids, traces in/around California, 5dp rounding', () => {
  for (const key of ['FM3.1', 'FM3.2']) {
    const m = DOC.models[key];
    m.subsections.forEach((s, i) => {
      assert.equal(s.id, i, key + ' dense subsection id ' + i);
      assert.ok(m.parents.some((p) => p.parentId === s.parentId), 'parent exists for subsection ' + s.id);
      assert.ok(s.dipDeg > 0 && s.dipDeg <= 90, 'subsection dip sane');
      assert.ok(s.dipDirectionDeg >= 0 && s.dipDirectionDeg <= 360, 'subsection dipDirection sane');
      assert.ok(s.lowerDepthKm > s.upperDepthKm, 'subsection depth ordering');
      assert.ok(Array.isArray(s.trace) && s.trace.length >= 2, 'subsection trace >=2 points');
      for (const [lat, lng] of s.trace) {
        // extent measured on the frozen artifact: lat 31.53–42.48, lng −126.38–−114.93
        // (Mendocino trace runs offshore west of −126)
        assert.ok(lat >= 31 && lat <= 43 && lng >= -126.5 && lng <= -114.5,
          'subsection ' + s.id + ' point in California envelope: ' + lat + ',' + lng);
      }
    });
  }
});

test('fast-slab sanity: top participation parents are the known fast faults', () => {
  const top = [...DOC.models['FM3.1'].parents]
    .sort((a, b) => b.participationRatePerYr - a.participationRatePerYr)
    .slice(0, 5)
    .map((p) => p.name);
  assert.ok(/Parkfield/.test(top[0]), 'Parkfield is the fastest, got ' + top[0]);
  for (const want of ['San Andreas (Creeping Section) 2011 CFM', 'Mendocino', 'San Andreas (Mojave S)', 'Imperial']) {
    assert.ok(top.includes(want), 'top-5 includes ' + want + ' (got ' + top.join(' | ') + ')');
  }
});

test('Parkfield charMfd carries the M6 characteristic peak', () => {
  const pk = DOC.models['FM3.1'].parents.find((p) => /Parkfield/.test(p.name));
  // measured on the frozen artifact 2026-10-12: the M5.9/6.0/6.1 bins hold
  // ~0.0117/0.0137/0.0166 per yr — the repeating ~M6 Parkfield episodes —
  // with a long multi-segment tail to M8.3
  const at = (m) => (pk.charMfd.find((b) => Math.abs(b[0] - m) < 1e-9) || [m, 0])[1];
  assert.ok(at(6.0) > 0.01 && at(6.0) < 0.02, 'M6.0 bin ' + at(6.0));
  assert.ok(at(6.1) > at(6.0), 'M6.1 above M6.0');
  assert.ok(at(7.0) < 0.001, 'M7.0 tail small ' + at(7.0));
});

test('grid-mfd companion artifact: schema, counts, totals, bins', () => {
  const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'ucerf3-grid-mfd.json'), 'utf8'));
  assert.equal(G.schema, 'quake-sim-ucerf3-gridmfd-v1');
  assert.equal(G.provenance.doi, '10.5281/zenodo.5519802');
  assert.equal(G.provenance.relmCsv.sha256, 'dc83d1f159b75e2c19facb3c63630ea9f9033146748ad210ea9a373c9d81eb53');
  assert.equal(G.region.nodeCount, 7636);
  assert.equal(G.region.polygon.length, 16);
  assert.equal(G.mfdDef.binWidth, 0.1);
  // totals frozen at first successful parse 2026-10-12 (tool prints + gates them)
  assert.ok(Math.abs(G.models['FM3.1'].totalUnassocRateM5 - 3.6058) < 0.01, 'FM3.1 unassoc ' + G.models['FM3.1'].totalUnassocRateM5);
  assert.ok(Math.abs(G.models['FM3.1'].totalSubseismoRateM5 - 4.1972) < 0.01, 'FM3.1 subseismo');
  assert.ok(Math.abs(G.models['FM3.2'].totalUnassocRateM5 - 3.5964) < 0.01, 'FM3.2 unassoc ' + G.models['FM3.2'].totalUnassocRateM5);
  assert.ok(Math.abs(G.models['FM3.2'].totalSubseismoRateM5 - 4.1999) < 0.01, 'FM3.2 subseismo');
  for (const key of ['FM3.1', 'FM3.2']) {
    const nodes = G.models[key].nodes;
    assert.equal(nodes.length, 7636);
    let prevLat = -Infinity;
    for (const [lat, lng, u, s] of nodes) {
      assert.ok(lat >= 31 && lat <= 43 && lng >= -126.5 && lng <= -113, 'node in RELM envelope');
      assert.ok(lat >= prevLat - 1e-9, 'nodes ordered by latitude (RELM row-major)');
      prevLat = lat;
      for (const arr of [u, s]) {
        let pm = -Infinity;
        for (const [mag, rate] of arr) {
          assert.ok(mag >= 5.049 && mag <= 8.951, 'bin center in [5.05,8.95]');
          assert.ok(rate >= 1e-7, 'bin above floor (4-sig rounding can land exactly on 1e-7)');
          assert.ok(mag > pm, 'bins ascending');
          pm = mag;
        }
      }
    }
  }
});
