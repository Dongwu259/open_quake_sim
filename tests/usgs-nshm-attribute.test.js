// ================================================================
//  R8-2c attribution decomposition — tripwire locks
//  MEASUREMENT ONLY. The preregistered H1 was FALSIFIED as measured
//  (the official model sits INSIDE our GMM-collapse spread) — frozen
//  verbatim; H2/H3 pass. Re-runs must reproduce every arm ratio.
//  Run with:  node --test tests/usgs-nshm-attribute.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'usgs-nshm-attribution-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, arm set shape', () => {
  assert.equal(report.schema, 'quake-sim-usgs-nshm-attribution-v1');
  assert.match(report.preregistration, /scorecard-usgs-nshm-attribute\.js/);
  assert.deepEqual(Object.keys(report.arms).sort(),
    ['APRON_ONLY', 'CHAR_ONLY', 'FULL', 'GMM_ask14', 'GMM_bssa14', 'GMM_cb14_HighQ', 'GMM_cb14_LowQ', 'GMM_cb14_base', 'GMM_cy14', 'GRID_ONLY', 'NO_APRON']);
});

test('preregistered verdicts frozen: H1 falsified, H2/H3 pass', () => {
  assert.equal(report.hypotheses.H1_gap_outside_our_gmm_spread, false, 'H1 frozen falsified');
  assert.equal(report.hypotheses.H2_apron_minor_at_LA, true);
  assert.equal(report.hypotheses.H2_apron_minor_at_SF, true);
  assert.equal(report.hypotheses.H3_k_consistent_LA_SF, true);
});

test('headline arm ratios byte-frozen', () => {
  const la = report.arms.FULL.LA;
  assert.ok(Math.abs(la.pga.rp475 - 1.394) < 0.001, 'FULL LA ' + la.pga.rp475);
  assert.ok(Math.abs(report.arms.CHAR_ONLY.LA.pga.rp475 - 1.217) < 0.001, 'CHAR_ONLY LA');
  assert.ok(Math.abs(report.arms.GRID_ONLY.LA.pga.rp475 - 0.884) < 0.001, 'GRID_ONLY LA');
  assert.ok(Math.abs(report.arms.APRON_ONLY.LA.pga.rp475 - 0.020) < 0.001, 'APRON_ONLY LA (1.4% of FULL)');
  assert.ok(Math.abs(la.pga.rp475 - report.arms.NO_APRON.LA.pga.rp475) < 1e-9, 'apron negligible at RP475');
  assert.ok(Math.abs(report.rateFactorK.LA.pga.k - 0.435) < 0.001, 'k LA ' + report.rateFactorK.LA.pga.k);
  assert.ok(Math.abs(report.rateFactorK.SF.pga.k - 0.445) < 0.001, 'k SF ' + report.rateFactorK.SF.pga.k);
});

test('determinism: re-running reproduces the frozen arm ratios and k factors', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-usgs-nshm-attribute.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rerun = JSON.parse(out);
  assert.ok(Math.abs(rerun.arms.FULL.LA.pga.rp475 - report.arms.FULL.LA.pga.rp475) < 1e-9);
  assert.ok(Math.abs(rerun.rateFactorK.SF.pga.k - report.rateFactorK.SF.pga.k) < 1e-9);
});
