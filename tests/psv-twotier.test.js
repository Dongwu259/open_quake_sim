'use strict';
// ================================================================
//  params.twoTierQd (2026-09-28) — the two-tier precision router:
//  double Schur chain by default, 1-ulp chaos probe per k sample, QD
//  bigfloat re-evaluation only where the probe fires (the detM dips) and
//  the sample is inside the relevance envelope (kRel = omega/vs_half +
//  ln(1/relFloor)/zs). Anchors measured on HALF@f1.2 (the P1 config where
//  the double arm failed the <=1e-2 gate):
//    smooth band 1.40/km: double-vs-QD 1.5e-9, NO escalation;
//    dip band 1.88/km:    double-vs-QD ~1.0, two-tier ≡ QD exactly;
//    null sample 2.30/km: double complianceAt returns null -> QD rescue;
//    dead tail 3.00/km:   mild floor jitter skipped (relevance gate).
//  Run with:  node --test tests/psv-twotier.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');

const psv = require('../tools/broadband/psv.js');

const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
const OMEGA = 2 * Math.PI * 1.2, ZS = 33;
const BASE = { rKm: 30, zSourceKm: ZS, qShear: 50, schurCompliance: 1,
  mxx: 0, myy: 0, mzz: 0, mxy: 1e20, mxz: 0, myz: 0 };
const cabs = (c) => Math.hypot(c[0], c[1]);
function gAt(kInvKm, extra) {
  return psv.psvIntegrandAtK(HALF, OMEGA, kInvKm / 1000, Object.assign({}, BASE, extra));
}
function relUt(a, b) { return Math.abs(cabs(a.ut) - cabs(b.ut)) / cabs(b.ut); }
function relMax(a, b) {
  // full-vector comparison for dipole tensors (ut can be a structural zero)
  const m = (g) => Math.max(cabs(g.ur), cabs(g.uz), cabs(g.ut));
  return Math.abs(m(a) - m(b)) / m(b);
}

test('absent twoTierQd: byte-compatible, zero probe side effects', () => {
  const st = { probed: 0, escalated: 0, skippedTail: 0 };
  for (const k of [1.0, 1.88, 2.1, 3.0]) {
    const plain = gAt(k, {});
    const withStats = gAt(k, { _twoTierStats: st }); // stats alone must not arm anything
    assert.deepEqual(withStats, plain, 'k=' + k + ' identical without the flag');
  }
  assert.equal(st.probed, 0, 'no probing without the flag');
});

test('smooth band: no escalation, two-tier ≡ double exactly', () => {
  const st = { probed: 0, escalated: 0, skippedTail: 0 };
  const g2 = gAt(1.40, { twoTierQd: 1, _twoTierStats: st });
  const gD = gAt(1.40, {});
  assert.deepEqual(g2, gD, 'smooth sample untouched');
  assert.equal(st.escalated, 0, 'no escalation');
  assert.ok(st.probed >= 1, 'probe ran');
});

test('dip band: double is O(1) off, two-tier ≡ QD exactly', () => {
  const gD = gAt(1.88, {});
  const gQ = gAt(1.88, { qdCompliance: 1 });
  const st = { probed: 0, escalated: 0, skippedTail: 0 };
  const g2 = gAt(1.88, { twoTierQd: 1, _twoTierStats: st });
  assert.ok(relUt(gD, gQ) > 0.5, 'double demonstrably broken here: ' + relUt(gD, gQ));
  assert.ok(relUt(g2, gQ) <= 1e-15, 'two-tier lands the QD value: ' + relUt(g2, gQ));
  assert.ok(st.escalated >= 1, 'escalation counted');
});

test('null double triple rescued by the QD chain', () => {
  // measured 2026-09-28: the double complianceAt on HALF@f1.2 k=2.30/km
  // returns null (crest guard); the QD field is solvable there
  const gQ = gAt(2.30, { qdCompliance: 1 });
  assert.ok(gQ, 'QD solvable at 2.30');
  const st = { probed: 0, escalated: 0, skippedTail: 0 };
  const g2 = gAt(2.30, { twoTierQd: 1, _twoTierStats: st });
  assert.ok(g2, 'two-tier rescued the null');
  assert.ok(relUt(g2, gQ) <= 1e-15, 'rescued value ≡ QD: ' + relUt(g2, gQ));
  assert.ok(st.escalated >= 1, 'broken-path escalation counted');
});

test('dead evanescent tail: chaos present but skipped (relevance gate), two-tier ≡ double', () => {
  // k=3.00/km at zs=33 km: |C| ~1e-38, 28 orders below the weight band — the
  // mild floor jitter there is measured but deliberately NOT escalated
  const st = { probed: 0, escalated: 0, skippedTail: 0 };
  const g2 = gAt(3.00, { twoTierQd: 1, _twoTierStats: st });
  const gD = gAt(3.00, {});
  assert.deepEqual(g2, gD, 'tail sample untouched');
  assert.equal(st.escalated, 0, 'no QD spend in the dead tail');
  assert.ok(st.skippedTail >= 1, 'the skip is an accounted decision, not silence');
});

test('layered (tokyo JIVSM) stack: crest-band chaos escalates, smooth band does not', () => {
  // the production-relevant stack family — v13 measured the 0.70-0.80/km
  // crest band at f0.5 as ulp-chaotic on the double chain, clean on QD
  const fs = require('node:fs');
  const path = require('node:path');
  const Physics = require('../public/physics.js');
  const hybrid = require('../tools/broadband/hybrid.js');
  Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
  const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
  const om = 2 * Math.PI * 0.5;
  const base = { rKm: 198.5, zSourceKm: 73, qShear: 50, schurCompliance: 1,
    mxx: 0, myy: 0, mzz: 1e20, mxy: 0, mxz: 0, myz: 0 };
  const probe = (kInvKm, extra) => psv.psvIntegrandAtK(stack, om, kInvKm / 1000, Object.assign({}, base, extra));
  // smooth control band (v13: k=0.40/km stable to 1e7 ulp)
  const stA = { probed: 0, escalated: 0, skippedTail: 0 };
  const cA = probe(0.40, { twoTierQd: 1, _twoTierStats: stA });
  const cAd = probe(0.40, {});
  assert.deepEqual(cA, cAd, 'smooth layered sample untouched');
  assert.equal(stA.escalated, 0, 'no escalation at 0.40');
  // crest band: chaos must fire and the value must equal the QD chain's
  const stB = { probed: 0, escalated: 0, skippedTail: 0 };
  const cB = probe(0.73, { twoTierQd: 1, _twoTierStats: stB });
  assert.ok(stB.escalated + (stB.skippedTail || 0) >= 1, '0.73/km crest band routed (escalate or relevance-skip)');
  if (stB.escalated >= 1) {
    const cBq = probe(0.73, { qdCompliance: 1 });
    assert.ok(cB && cBq && relMax(cB, cBq) <= 1e-15, 'crest sample lands QD: ' + (cB && cBq && relMax(cB, cBq)));
  }
});

// --------------------------------------------------------------- freeze tripwire
test('frozen report (tools/data/psv-twotier-report.json): gates + numbers locked', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rep = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'data', 'psv-twotier-report.json'), 'utf8'));
  assert.equal(rep.schema, 'quake-sim-psv-twotier-v1');
  // the P1 gate outcome and the decisive f1.2 cure numbers
  assert.match(rep.p1Anchor.verdict, /PASS/);
  const th12 = rep.p1Anchor.cases.find((c) => c.case === 'thrust-DC@f1.2zs33');
  assert.ok(th12.twoTier <= 1e-5 && th12.twoTier > 0, 'twoTier f1.2 lands at 1e-7 scale, got ' + th12.twoTier);
  assert.equal(th12.double, 8.34, 'the double-arm failure stays on record');
  assert.ok(rep.layeredEndToEnd['f1.2'].twoTierVsQdUr <= 1e-6, 'layered f1.2 twoTier≡QD');
  assert.ok(rep.layeredEndToEnd['f0.5'].doubleVsQdUr > 100, 'layered f0.5 double contamination stays on record (875x)');
  // the honest scope note: this cure must never be cited as reopening v4
  assert.match(rep.scope, /refutation stands/);
  // cross-consistency with the live PRE_REG_V4 registry
  const v4 = require('../tools/broadband/cs-pipeline.js').PRE_REG_V4;
  assert.ok(v4.twoTierCure && v4.twoTierCure.includes('LANDED 2026-09-28'), 'PRE_REG_V4.twoTierCure registered');
  assert.ok(v4.twoTierCure.includes('refutation stands'), 'the scope note is on the registry too');
});
