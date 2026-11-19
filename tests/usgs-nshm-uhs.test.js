// ================================================================
//  CA spectral-dimension measurement (R8-2f) — tripwire locks.
//  Preregistered verdicts: H1/H2/H3 all PASS as measured — the v7.1
//  uniform-rate-factor attribution persists across the whole UHS grid
//  (ratio spread 0.055/0.063 dex vs the 0.15 gate; shape diff <=0.053 dex).
//  Run with:  node --test tests/usgs-nshm-uhs.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'usgs-nshm-uhs-spectral-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, sanity amendment disclosed', () => {
  assert.equal(report.schema, 'quake-sim-usgs-nshm-uhs-spectral-v1');
  assert.match(report.preregistration, /scorecard-usgs-nshm-uhs\.js/);
  assert.match(report.preregistration, /known v7.1 anchors declared/);
  assert.match(report.note, /MEASUREMENT ONLY/);
  assert.equal(report.rp, 475);
  assert.equal(report.vs30, 760);
  assert.deepEqual(report.periods, ['PGA', '0.10', '0.20', '0.50', '1.00', '2.00', '3.00', '5.00']);
});

test('preregistered verdicts frozen: H1/H2/H3 all pass', () => {
  assert.equal(report.hypotheses.H1_pureRate_spread_le_0p15dex, true);
  assert.equal(report.hypotheses.H2_spectralShape_le_0p10dex, true);
  assert.equal(report.hypotheses.H3_anchorDrift_le_0p15dex, true);
  for (const s of ['LA', 'SF']) {
    assert.equal(report.sites[s].hypotheses.H1_spread_le_0p15, true);
    assert.equal(report.sites[s].hypotheses.H2_shape_le_0p10, true);
    assert.equal(report.sites[s].hypotheses.H3_drift_le_0p15, true);
  }
});

test('headline ratios byte-frozen: broadband ~1.2-1.4x, mild long-period narrowing', () => {
  // 2026-11-19 巨源距离代理整改 re-freeze (finite-rupture convention; the
  // official USGS 2023 curves byte-unchanged): the k~0.44 uniform-rate-factor
  // story survives — ratios moved 1.3945->1.34126 (LA PGA) etc. with the
  // inflated near-field background rates removed
  assert.ok(Math.abs(report.sites.LA.ratioByPeriod.PGA - 1.34126) < 1e-6, 'LA PGA ratio');
  assert.ok(Math.abs(report.sites.LA.ratioByPeriod['5.00'] - 1.23051) < 1e-6, 'LA 5.0s ratio');
  assert.ok(Math.abs(report.sites.SF.ratioByPeriod.PGA - 1.32038) < 1e-6, 'SF PGA ratio');
  assert.ok(Math.abs(report.sites.SF.ratioByPeriod['5.00'] - 1.19659) < 1e-6, 'SF 5.0s ratio');
  assert.ok(Math.abs(report.sites.LA.ratioSpreadDex - 0.0421585) < 1e-6, 'LA spread');
  assert.ok(Math.abs(report.sites.SF.ratioSpreadDex - 0.0600414) < 1e-6, 'SF spread');
  // the RP475 anchors reproduce from the re-run comparison report (2026-11-19)
  const v71 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'usgs-nshm-comparison-report.json'), 'utf8'));
  assert.ok(Math.abs(v71.sites.LA.ratio.pga.rp475 - 1.34126) < 1e-4, 'LA RP475 PGA anchor');
  assert.ok(Math.abs(v71.sites.SF.ratio.pga.rp475 - 1.32038) < 1e-4, 'SF RP475 PGA anchor');
});

test('production pack matches its registered manifest sha + determinism', () => {
  const crypto = require('node:crypto');
  const sha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-california.json'))).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'research_data_manifest.json'), 'utf8'));
  const ca = manifest.resources.find((e) => e.path === 'geojson/psha-source-model-california.json');
  assert.equal(sha, ca.sha256, 'shipped CA pack bytes == registered sha');
  const rerun = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-usgs-nshm-uhs.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(Math.abs(rerun.sites.LA.ratioByPeriod['5.00'] - report.sites.LA.ratioByPeriod['5.00']) < 1e-9);
  assert.ok(Math.abs(rerun.sites.SF.ratioSpreadDex - report.sites.SF.ratioSpreadDex) < 1e-9);
});
