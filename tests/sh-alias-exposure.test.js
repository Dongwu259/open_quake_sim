// sh-alias-exposure.test.js — tripwire for the frozen SH-kernel long-range
// aliasing reports (tools/data/sh-alias-exposure.json). History: the B1 SH
// kernel originally sampled the J2(k r)-weighted integral with the fixed
// production dkInvKm=0.01/km (alias-safe only to ~63 km; 69% of the frozen
// Kyoshin scorecard paths beyond, median 88 km). v1 (2026-09-06) landed the
// range-adaptive floor dk >= (2*pi/r)/10 and quantified the exposure;
// v2 measured that the Love-pole windows did NOT move the 0.797 residual —
// the real mechanism is the production lattice under-sampling the
// J2*compliance PRODUCT. v3 (2026-09-09) executed the v2 registered cure as
// a guard-divisor LADDER (tools/broadband/sh-alias-ladder.js, 48 points x 8
// freqs vs 16x/32x-refined references): div 80 is the smallest rung meeting
// the pre-registered far max <= 0.10 gate and SHIPS as core.SH_GUARD_DIV.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'sh-alias-exposure.json');
const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('sh-alias-exposure — schema, guard, verdict frozen', () => {
  assert.equal(r.schema, 'quake-sim-sh-alias-exposure-v3');
  assert.equal(r.verdict, 'guard_div80_landed_residual_quantified');
  assert.equal(r.guard.aliasSafeRangeKm, 7.9);
  assert.equal(r.guard.rule, 'dk = min(dkInvKm, (2*pi/r)/80)');
  // the v1 pole-grid-luck attribution must stay retired on record
  assert.ok(r.history.v2.includes('RETIRED'), 'v1 attribution retirement must persist');
  assert.ok(r.registeredFollowUp.includes('div 80') || r.reading.includes('div 80'),
    'the shipped divisor must be on record');
});

test('sh-alias-exposure — distance distribution locked (basis unchanged)', () => {
  const d = r.distanceDistribution;
  assert.ok(d.scoredPaths >= 700, 'scored path count drifted: ' + d.scoredPaths);
  assert.equal(d.median, 88);
  // rSafe is now 7.9 km under the div-80 rule, so essentially every scored
  // path is guard-managed — a drop would mean the rule text and the stats
  // disagree
  assert.ok(d.beyondFraction > 0.99, 'beyond-fraction drifted: ' + d.beyondFraction);
  assert.equal(d.perEvent.length, 13, 'the frozen 13-event set must stay the basis');
});

test('sh-alias-exposure — v3 divisor ladder frozen (div 80 ships, gate met)', () => {
  const L = r.divisorLadder;
  assert.equal(L.points, 48);
  assert.equal(L.farPoints, 40);
  // the monotone improvement ladder — the measured reason for div 80
  assert.equal(L.farStatsByDivisor.div10.max, 0.7976);
  assert.equal(L.farStatsByDivisor.div40.max, 0.1637);
  assert.deepEqual(L.farStatsByDivisor.div80, { p90: 0.0274, p95: 0.034, max: 0.0701 });
  assert.ok(L.decision.includes('div 80'), 'the decision must name the shipped divisor');
  // pre-registered gate: far max <= 0.10 — div 80 meets it, div 40 does not
  assert.ok(L.farStatsByDivisor.div80.max <= 0.10);
  assert.ok(L.farStatsByDivisor.div40.max > 0.10);
  // reference self-stability honestly recorded (p95 marginally above 0.02)
  assert.ok(L.referenceStability.all.p95 > 0.02 && L.referenceStability.all.p95 < 0.03,
    'reference stability must stay on record: ' + JSON.stringify(L.referenceStability.all));
  // the per-point arms are retired in light mode with the cost note
  assert.ok(r.perPointExposure.retired.includes('superseded by the divisor ladder'));
});
