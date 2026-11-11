// ================================================================
//  NZ CHC catalog-artifact attribution — tripwire locks
//  Preregistered attribution of the Christchurch overestimate found by
//  the NZ NSHM external gate. The variant pack lives in .cache only;
//  the shipped pack stays byte-unchanged (asserted here).
//  Run with:  node --test tests/nz-chc-attribution.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nz-chc-attribution-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, removed-set shape', () => {
  assert.equal(report.schema, 'quake-sim-nz-chc-attribution-v1');
  assert.match(report.preregistration, /scorecard-nz-chc-attribution\.js/);
  assert.equal(report.removed.n, 25);
  assert.equal(report.removed.magRange[1], 7);
  assert.match(report.removed.dateRange[0], /^2010-09-03/);
  assert.match(report.note, /MEASUREMENT ONLY/);
  assert.ok(report.variantBuild.completeness && report.variantBuild.completeness.chosen,
    'variant completeness recorded');
});

test('preregistered verdicts frozen: G1/G3 pass, G2 fails as measured', () => {
  assert.equal(report.gates.G1_chc_direction, true);
  assert.equal(report.gates.G2_chc_attribution_sufficient, false);
  assert.equal(report.gates.G3_specificity_wlg, true);
  assert.equal(report.gates.G3_specificity_akl_ivc, true);
});

test('headline ratios byte-frozen: swarm carries ~70% of the CHC gap, edit is local', () => {
  const chc = report.sites.CHC, wlg = report.sites.WLG;
  assert.ok(Math.abs(chc.ratio.rp475 - 0.607) < 0.001, 'CHC variant ratio ' + chc.ratio.rp475);
  assert.ok(Math.abs(chc.delta.rp475 + 1.372) < 0.001, 'CHC delta ' + chc.delta.rp475);
  assert.ok(Math.abs(wlg.delta.rp475) < 0.005, 'WLG must not move (' + wlg.delta.rp475 + ')');
  for (const sid of ['AKL', 'NSN', 'ZQN', 'IVC']) {
    assert.ok(Math.abs(report.sites[sid].delta.rp475) <= 0.05, sid + ' delta ' + report.sites[sid].delta.rp475);
  }
});

test('shipped pack matches its registered manifest sha (the attribution writes nothing)', () => {
  // content-based invariant (NOT git status — a mirror working tree may
  // legitimately carry uncommitted sync updates): the shipped NZ pack must
  // hash to exactly the sha registered in research_data_manifest, so any
  // accidental write by the attribution run trips this assert.
  const crypto = require('node:crypto');
  const sha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-newzealand.json'))).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'research_data_manifest.json'), 'utf8'));
  const nz = manifest.resources.find((e) => e.path === 'geojson/psha-source-model-newzealand.json');
  assert.ok(nz, 'manifest entry present');
  assert.equal(sha, nz.sha256, 'shipped NZ pack bytes == registered sha');
  // determinism: re-running reproduces the frozen CHC variant ratio
  const rerun = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-nz-chc-attribution.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(Math.abs(rerun.sites.CHC.ratio.rp475 - report.sites.CHC.ratio.rp475) < 1e-9);
  assert.ok(Math.abs(rerun.sites.WLG.ratio.rp475 - report.sites.WLG.ratio.rp475) < 1e-9);
});
