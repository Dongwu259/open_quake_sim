// ================================================================
//  sh-branch-diagnosis — tripwire for the retired registration check
//  (2026-11-16). The HANDOVER-registered "below-alias-floor dk series
//  O(sqrt(h)) cusp" was MEASURED NOT-REPRODUCED on the shipped kernel
//  (post v8 Love-pole windows + v3 guardDiv 80): every arm/frequency is
//  roundoff-bound at ~1e-10..1e-11 relative with noisy non-monotone
//  orders; no quadrature cure was implemented and core.js is untouched.
//  Run with:  node --test tests/sh-branch-diagnosis.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'sh-branch-diagnosis-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, kernel provenance', () => {
  assert.equal(report.schema, 'quake-sim-sh-branch-diagnosis-v1');
  assert.match(report.preregistration, /sh-branch-diagnose\.js/);
  assert.match(report.kernel, /Love-pole windows/);
  assert.match(report.kernel, /guardDiv 80/);
});

test('preregistered verdict frozen: cusp NOT reproduced (0/3 arms)', () => {
  assert.equal(report.cuspConfirmedArms, 0);
  assert.equal(report.hypotheses.H_yes_cusp_stable_p_half_every_arm, false);
  assert.match(report.verdict, /NOT-REPRODUCED/);
  assert.match(report.verdict, /registration retired/);
  assert.match(report.note, /core\.js untouched/);
});

test('measured pattern byte-frozen: clamp identity + roundoff-bound ladder', () => {
  const a = report.arms[0].points[1]; // layered 250km f=0.5
  assert.equal(a.ladder[0].relResidual, a.ladder[1].relResidual, 'clamp identity: floor*1.5 rung == floor rung');
  assert.equal(a.ladder[0].order, null, 'first rung carries no order (no previous rung)');
  assert.equal(a.ladder[1].order, 0, 'clamped rung pair order is exactly 0');
  for (const arm of report.arms) {
    for (const pt of arm.points) {
      assert.ok(pt.refSelfStability <= 1e-9, 'reference self-stability gate');
      assert.equal(pt.clampIdentityBit, true, 'clamp identity asserted per frequency');
      for (const rung of pt.ladder) assert.ok(rung.relResidual < 5e-10, 'roundoff-bound residual ' + rung.relResidual);
    }
  }
});

test('determinism: the tool reruns cleanly and the frozen ladder matches its literals', () => {
  // no-arg rerun (no --write): must exit 0 — the measurement re-derives
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'broadband', 'sh-branch-diagnose.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const a = report.arms[2].points[0]; // fullspace f=0.5
  assert.ok(Math.abs(a.ladder[1].relResidual - 9.64e-11) < 1e-13, 'fullspace floor residual ' + a.ladder[1].relResidual);
  assert.equal(a.ladder[1].order, 0);
});
