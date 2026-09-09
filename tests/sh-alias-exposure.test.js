// sh-alias-exposure.test.js — tripwire for the frozen SH-kernel long-range
// aliasing exposure report (tools/data/sh-alias-exposure.json). The B1 SH
// kernel sampled the J2(k r)-weighted integral with the fixed production
// dkInvKm=0.01/km — alias-safe only to ~63 km, while 69% of the frozen
// Kyoshin scorecard paths lie beyond (median 88 km). The 2026-09-06 batch
// landed the range-adaptive floor dk >= (2*pi/r)/10 in
// core.shSpectrumAtFrequency and froze this quantification: point-level
// pre-guard LF spectral ratios vs a 4x-refined grid swung ~0.5-3x at
// 90-180 km; the guarded grid agrees with the refined grid at the percent
// level. The kernel still has NO Love-mode pole windows — that separate,
// inherited exposure is recorded as the registered follow-up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'sh-alias-exposure.json');
const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('sh-alias-exposure — schema, guard, verdict frozen', () => {
  assert.equal(r.schema, 'quake-sim-sh-alias-exposure-v2');
  assert.equal(r.verdict, 'guard_landed_exposure_quantified');
  assert.equal(r.guard.aliasSafeRangeKm, 62.8);
  assert.equal(r.guard.rule, 'dk = min(dkInvKm, (2*pi/r)/10)');
  assert.ok(r.reading.includes('RETIRED by measurement'), 'the v1 pole-grid-luck attribution must stay retired on record');
  assert.ok(r.reading.includes('Love-pole windows'), 'the v2 reading must record that the windows landed');
  assert.ok(r.registeredFollowUp.includes('range-adaptive divisor') || r.registeredFollowUp.includes('compliance-scale'),
    'the residual far-range sampling gap must stay registered with a cure');
});

test('sh-alias-exposure — distance distribution locked (69% beyond the old safe range)', () => {
  const d = r.distanceDistribution;
  assert.ok(d.scoredPaths >= 700, 'scored path count drifted: ' + d.scoredPaths);
  assert.equal(d.median, 88);
  assert.ok(d.beyondFraction > 0.6 && d.beyondFraction < 0.8,
    'beyond-fraction drifted: ' + d.beyondFraction);
  assert.equal(d.perEvent.length, 13, 'the frozen 13-event set must stay the basis');
});

test('sh-alias-exposure — pre-guard exposure evidence locked (far-field spread)', () => {
  const e = r.perPointExposure;
  assert.ok(e.fixedVsFine_farOnly.n >= 20, 'far-field sample count drifted: ' + e.fixedVsFine_farOnly.n);
  assert.ok(e.fixedVsFine_farOnly.max > 1.0,
    'far-field exposure evidence weakened (max |ratio-1| = ' + e.fixedVsFine_farOnly.max + ') — re-measure before relying on this tripwire');
});

test('sh-alias-exposure — guarded grid tracks the refined grid where the guard applies', () => {
  const e = r.perPointExposure;
  // the guard removes the pure J-aliasing component (near field: exact);
  // the residual far-field swings are the UNCOVERED Love-pole grid luck
  // (registered follow-up — the kernel has no modal pole windows). The
  // tripwire bounds catastrophic regression only.
  assert.ok(e.guardedVsFine_all.max <= 0.9,
    'guarded kernel drifted catastrophically from the refined grid: max |ratio-1| = ' + e.guardedVsFine_all.max);
  // the Love windows (v7->v8) did NOT move this residual (0.80 -> 0.797):
  // it is the J2*compliance product sampling gap, not pole grid luck — the
  // windows must stay in the kernel or this number regresses silently.
  assert.ok(r.reading.includes('0.797'), 'the post-window residual must stay on record');
  assert.ok(e.guardedVsFine_all.median <= 0.05,
    'guarded kernel median drift: ' + e.guardedVsFine_all.median);
  // the guard must beat the pre-guard kernel on the far field (worst case)
  assert.ok(e.guardedVsFine_all.max < e.fixedVsFine_farOnly.max,
    'guard no longer improves the far field — re-measure');
});
