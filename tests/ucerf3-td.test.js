// UCERF3-TD batch A anchors: the frozen date-of-last-event artifact
// (tools/build-ucerf3-td.js -> tools/data/ucerf3-td-sections-california.json,
// schema quake-sim-ucerf3-td-v1). Values cross-checked against the official
// UCERF3-TD paper (Field et al. 2015, BSSA 105(2A)) Table 2 at its 2014 basis
// (paper "Average Years Since" = openInterval + 1).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'ucerf3-td-sections-california.json'), 'utf8'));

test('schema + provenance pins', () => {
  assert.equal(doc.schema, 'quake-sim-ucerf3-td-v1');
  assert.equal(doc.provenance.sha256, '4cae78f96ad8839e9b3cab353d600806d80d79bd889512179fdc952c88aa6635');
  assert.equal(doc.provenance.bytes, 3205120);
  assert.equal(doc.provenance.openIntervalBasisYear, 2013);
});

test('row mapping: 391 staging rows, FM-exclusive parents, 65 parents with data per FM', () => {
  const a = doc.models['FM3.1'], b = doc.models['FM3.2'];
  assert.equal(a.rowsMapped, 386);
  assert.equal(b.rowsMapped, 385);
  assert.equal(a.parentsWithData, 65);
  assert.equal(b.parentsWithData, 65);
  // union covers all 391 rows; intersection = rows on parents shared by both FMs
  assert.equal(a.rowsMapped + b.rowsMapped - 391, 380);
  // FM-exclusive geometry variants (measured 2026-10-12): alt-1 -> FM3.1 only,
  // alt-2 / Santa Fe Springs -> FM3.2 only
  const ids31 = new Set(a.parents.map(p => p.parentId));
  const ids32 = new Set(b.parents.map(p => p.parentId));
  for (const pid of [235, 236, 240]) { assert.ok(ids31.has(pid) && !ids32.has(pid), 'alt-1 parent ' + pid + ' FM3.1-only'); }
  for (const pid of [234, 237, 242]) { assert.ok(!ids31.has(pid) && ids32.has(pid), 'alt-2 parent ' + pid + ' FM3.2-only'); }
});

test('Parkfield anchor: 8 uniform rows, open interval exactly 9.0 (2004 event, basis 2013)', () => {
  const p = doc.models['FM3.1'].parents.find(x => x.name === 'San Andreas (Parkfield)');
  assert.ok(p, 'Parkfield parent present');
  assert.equal(p.parentId, 32);
  assert.equal(p.nRows, 8);
  assert.ok(p.rows.every(r => r.oi === 9.0), 'all 8 rows OI=9.0');
  assert.equal(p.meanOpenIntervalYears, 9);
  assert.equal(p.lastEventYear, 2004);
});

test('paper Table 2 spot anchors (paper "Average Years Since" @2014 = OI+1)', () => {
  const m = doc.models['FM3.1'];
  const spots = [
    ['San Andreas (Coachella) rev', 333, 334],
    ['San Andreas (Mojave S)', 156, 157],
    ['San Andreas (Mojave N)', 156, 157],
    ['Rodgers Creek - Healdsburg 2011 CFM', 268, 269],
    ['San Jacinto (Anza) rev', 142.2, 143],
    ['Elsinore (Temecula) rev', 280.5, 281],
    ['Garlock (West)', 328, 329],
    ['Hayward (No) 2011 CFM', 300, 301]
  ];
  for (const [name, oi, paper] of spots) {
    const p = m.parents.find(x => x.name === name);
    assert.ok(p, name + ' present');
    assert.ok(Math.abs(p.meanOpenIntervalYears - oi) < 0.3, name + ' OI ' + p.meanOpenIntervalYears + ' ~ ' + oi);
    assert.ok(Math.abs((p.meanOpenIntervalYears + 1) - paper) < 0.8, name + ' vs paper Table 2: ' + (p.meanOpenIntervalYears + 1) + ' ~ ' + paper);
  }
});

test('Imperial weighted mean frozen at 47.0 (paper Table 2 lists 34 = latest-event semantics; documented divergence)', () => {
  const p = doc.models['FM3.1'].parents.find(x => x.name === 'Imperial');
  assert.equal(p.nRows, 12); // 4 rows @OI 73 (1940) + 8 rows @OI 34 (1979), uniform 5.2 km spans
  assert.ok(Math.abs(p.meanOpenIntervalYears - 47.0) < 0.01, 'OI ' + p.meanOpenIntervalYears);
});

test('global sanity: all OI>0, lastEventYear<2013, nRows sum = rowsMapped', () => {
  for (const fm of ['FM3.1', 'FM3.2']) {
    const m = doc.models[fm];
    let sum = 0;
    for (const p of m.parents) {
      assert.ok(p.meanOpenIntervalYears > 0 && p.lastEventYear < 2013, fm + ' pid ' + p.parentId);
      assert.ok(Math.abs(p.lastEventYear - (2013 - p.meanOpenIntervalYears)) < 0.001, fm + ' pid ' + p.parentId + ' year/OI consistency');
      sum += p.nRows;
    }
    assert.equal(sum, m.rowsMapped, fm + ' nRows sum');
  }
});

// ---------------------------------------------------------------------------
// Batch B engine anchors (physics.js UCERF3-TD primitives + engine wiring)
// ---------------------------------------------------------------------------

const Physics = require(path.join(ROOT, 'public', 'physics.js'));
const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-california.json'), 'utf8'));

test('bptProbOpenInterval (Field&Jordan eq.6): equilibrium identity + frozen precision anchors', () => {
  // TH=0, T<<mu -> T/mu (equilibrium first-order)
  assert.ok(Math.abs(Physics.bptProbOpenInterval(1, 0, 1000, 0.3) - 0.001) < 1e-5, 'equilibrium identity');
  // frozen literals (adaptive Simpson, verified against 200k-pt trapezoid brute force, rel <= 3e-5)
  const anchors = [
    [30, 139, 100, 0.3, 0.76202708, 1e-6],
    [50, 151.75, 500, 0.2, 0.14357498, 1e-6],
    [30, 139, 5000, 0.5, 0.0061720282, 1e-6],
    // deep-tail regression: T_H >> mu (Creeping-Section-like) — the mu-minus-partial
    // denominator cancelled catastrophically here before the direct-tail fix
    [30, 139, 28.2, 0.4, 0.96955880, 1e-3]
  ];
  for (const [T, TH, mu, a, want, tol] of anchors) {
    const got = Physics.bptProbOpenInterval(T, TH, mu, a);
    assert.ok(Math.abs(got - want) / want < tol, `openInterval(${T},${TH},${mu},${a}) = ${got}, want ${want}`);
  }
});

test('ucerf3TdAperForMag: paper Table 1 magnitude bins verbatim', () => {
  assert.deepEqual(Physics.ucerf3TdAperForMag(6.5), { low: 0.4, mid: 0.5, high: 0.6 });
  assert.deepEqual(Physics.ucerf3TdAperForMag(6.7), { low: 0.4, mid: 0.5, high: 0.6 });
  assert.deepEqual(Physics.ucerf3TdAperForMag(7.0), { low: 0.3, mid: 0.4, high: 0.5 });
  assert.deepEqual(Physics.ucerf3TdAperForMag(7.5), { low: 0.2, mid: 0.3, high: 0.4 });
  assert.deepEqual(Physics.ucerf3TdAperForMag(8.0), { low: 0.1, mid: 0.2, high: 0.3 });
  const w = Physics.UCERF3_TD_APERIODICITY.weights;
  assert.ok(Math.abs(w.low + w.mid + w.high + w.poisson - 1) < 1e-15, 'blend weights sum to 1');
  assert.equal(Physics.UCERF3_TD_HISTORIC_OPEN_START_YEAR, 1875);
});

test('ucerf3TdRateGain: frozen gains (OpenSHA probGain semantics at parent-participation level)', () => {
  const charByName = (n) => PACK.characteristicSources.find((s) => s.name === n && s.faultModel === 'FM3.1');
  const pk = charByName('San Andreas (Parkfield)');
  // recent event (2004, elapsed 10 @2014) suppresses: gain < 1
  const gPk = Physics.ucerf3TdRateGain(30, 6.0, pk.participationRatePerYr, 10, 2014);
  assert.ok(Math.abs(gPk - 0.7285) / 0.7285 < 0.01, 'Parkfield gain ' + gPk);
  assert.ok(gPk < 1, 'Parkfield TD < TI');
  // overdue (1680) lifts: gain > 1
  const co = charByName('San Andreas (Coachella) rev');
  const gCo = Physics.ucerf3TdRateGain(30, 7.5, co.participationRatePerYr, 334, 2014);
  assert.ok(Math.abs(gCo - 2.7499) / 2.7499 < 0.01, 'Coachella gain ' + gCo);
  // null-date -> historic-open-interval form (T_H=139 @2014), frozen
  const creep = charByName('San Andreas (Creeping Section) 2011 CFM');
  const gCr = Physics.ucerf3TdRateGain(30, 6.8, creep.participationRatePerYr, null, 2014);
  assert.ok(Math.abs(gCr - 0.9115) / 0.9115 < 0.01, 'Creeping null-date gain ' + gCr);
  // NOTE (honest gap, docs/UCERF3-TD-AVAILABILITY.md §7): these are parent-
  // participation-level gains; the official rupture-level fault-aggregate
  // gains in Table 6 run lower (NSA 0.96 vs our per-bin 1.925, Coachella ~1.5
  // vs our 2.75) because the official model area-averages normTS over the
  // multi-parent ruptures — our granularity keeps each parent's extreme.
  const nc = charByName('San Andreas (North Coast) 2011 CFM');
  const gNc = Physics.ucerf3TdRateGain(30, 7.6, nc.participationRatePerYr, 108, 2014);
  assert.ok(Math.abs(gNc - 1.9250) / 1.9250 < 0.01, 'NSA NorthCoast gain ' + gNc);
});

test('pack v3 carries UCERF3-TD: bptReady + 633 bpt blocks (130 dated)', () => {
  assert.equal(PACK.bptReady, true);
  assert.ok(PACK.bptMeta && /UCERF3-TD/.test(PACK.bptMeta.model), 'bptMeta');
  const dated = PACK.characteristicSources.filter((s) => s.bpt && s.bpt.lastEventYear != null);
  assert.equal(dated.length, 130, '65 dated parents x 2 FMs');
  assert.equal(PACK.characteristicSources.length, 633);
  const pk = PACK.characteristicSources.find((s) => s.name === 'San Andreas (Parkfield)' && s.faultModel === 'FM3.1');
  assert.equal(pk.bpt.lastEventYear, 2004);
});

test('engine: LA TD hazard (UCERF3-TD channels) + Japan TD byte-compat', () => {
  const site = { lat: 34.05, lng: -118.24, vs30: 600 };
  const td = Physics.hazardCurveTimeDependent(PACK, site, 'pga', { horizonYears: 50 });
  assert.equal(td.diagnostics.nCharTdSources, 478, 'char TD sources at LA');
  assert.ok(td.timeDependent.ucerf3Td && /Field et al. 2015/.test(td.timeDependent.ucerf3Td.model), 'ucerf3Td diagnostics block');
  const rp475 = Physics._pshaInvertCurve(td.imLevels, td.meanRate, 1 / 475);
  const rp2500 = Physics._pshaInvertCurve(td.imLevels, td.meanRate, 1 / 2500);
  // frozen 2026-10-12 on the v7.x four-model NGA-West2 crustal tree:
  // 665.8 / 1108.8 (single-branch BSSA14 tree gave 628.9 / 1071.2; TI anchors
  // 651.8 / 1094.5 stay pinned in psha-region)
  assert.ok(Math.abs(rp475 - 665.8) / 665.8 < 0.01, 'LA TD RP475 ' + rp475);
  assert.ok(Math.abs(rp2500 - 1108.8) / 1108.8 < 0.01, 'LA TD RP2500 ' + rp2500);
  const u = Physics.uhs(PACK, site, [475], { periods: ['0.20', '0.50', '1.00'], years: 50, timeDependent: true });
  // v7.x four-model tree: 1641.8 / 1058.5 / 574.4 (BSSA14-only: 1386.3/869.0/488.6)
  const want = [1641.8, 1058.5, 574.4];
  u.uhs['475'].forEach((v, i) => assert.ok(Math.abs(v - want[i]) / want[i] < 0.01, 'TD UHS475 ' + i + ' ' + v));
  // Japan TD path untouched: no char TD sources, the 3 Nankai BPT scenarios intact
  const jp = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const tdj = Physics.hazardCurveTimeDependent(jp, { lat: 34.35, lng: 136.5, vs30: 600 }, 'pga', { horizonYears: 50 });
  assert.equal(tdj.diagnostics.nCharTdSources, 0);
  assert.equal(tdj.diagnostics.nBptSources, 3);
  assert.equal(tdj.timeDependent.ucerf3Td, null);
});

test('paper Table 6 honest band: fault-aggregate M>=6.7 30yr participation (parent granularity)', () => {
  // Official UCERF3-TD Table 6 means (2014 start) vs our parent-level values.
  // The systematic +2-4x lift is the documented parent-granularity gap (the
  // official model area-averages normTS over multi-parent ruptures) — assert
  // the band, freeze ours, keep the paper values in the comment.
  //   SSA 0.53 | NSA 0.33 | HRC 0.32 | Calaveras 0.25 | SJ 0.09 | Garlock 0.08 | Elsinore 0.05
  const parentP = (s, thr) => {
    const ley = s.bpt ? s.bpt.lastEventYear : null;
    const el = ley != null ? Math.max(0, 2014 - ley) : null;
    let rate = 0;
    for (const [mag, r] of s.mfd) {
      if (mag < thr - 0.051 || !(r > 0)) continue;
      rate += r * Physics.ucerf3TdRateGain(30, mag, s.participationRatePerYr, el, 2014);
    }
    return 1 - Math.exp(-rate * 30);
  };
  const grp = (names) => {
    let logS = 0;
    for (const s of PACK.characteristicSources) {
      if (!names.some((n) => s.name.includes(n))) continue;
      logS += Math.log(1 - s.weight * parentP(s, 6.7));
    }
    return 1 - Math.exp(logS);
  };
  const ours = [
    grp(['San Andreas (Parkfield', 'San Andreas (Cholame', 'San Andreas (Carrizo', 'San Andreas (Big Bend', 'San Andreas (Mojave', 'San Andreas (San Bernardino', 'San Andreas (San Gorgonio', 'San Andreas (North Branch', 'San Andreas (Coachella']),
    grp(['San Andreas (Offshore', 'San Andreas (North Coast', 'San Andreas (Peninsula', 'San Andreas (Santa Cruz']),
    grp(['Rodgers Creek', 'Hayward']),
    grp(['Calaveras']),
    grp(['San Jacinto']),
    grp(['Garlock']),
    grp(['Whittier', 'Elsinore'])
  ];
  const frozen = [0.939, 0.592, 0.605, 0.468, 0.381, 0.214, 0.200];
  const paper = [0.53, 0.33, 0.32, 0.25, 0.09, 0.08, 0.05];
  ours.forEach((v, i) => {
    assert.ok(Math.abs(v - frozen[i]) / frozen[i] < 0.02, 'group ' + i + ' ours ' + v + ' vs frozen ' + frozen[i]);
    assert.ok(v / paper[i] > 0.8 && v / paper[i] < 5, 'group ' + i + ' ratio to paper ' + (v / paper[i]).toFixed(2));
  });
});
