// ================================================================
//  R8-2b NZ NSHM external-gate comparison — tripwire locks
//  The frozen report is MEASUREMENT ONLY (no calibration, pack
//  unchanged). These locks keep the preregistered comparison
//  reproducible and make any silent re-pull or pack drift that would
//  change the gate numbers fail loudly.
//  Run with:  node --test tests/nz-nshm.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nz-nshm-comparison-report.json'), 'utf8'));
const curves = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-curves.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, official provenance', () => {
  assert.equal(report.schema, 'quake-sim-nz-nshm-comparison-v1');
  assert.match(report.preregistration, /scorecard-nz-nshm\.js/);
  assert.equal(report.official.hazardModel, 'NSHM_v1.0.4');
  assert.equal(report.official.aggregate, 'mean');
  assert.equal(report.official.vs30, 600);
  assert.match(report.official.viewerKeySha256_12, /^[0-9a-f]{12}$/);
  assert.match(report.note, /MEASUREMENT ONLY/);
  // raw curve freeze: 6 sites x 2 IMTs, provenance verbatim
  assert.equal(curves.schema, 'quake-sim-nz-nshm-curves-v1');
  assert.equal(curves.curves.length, 12);
  assert.equal(curves.hazardModel, 'NSHM_v1.0.4');
});

test('preregistered verdicts frozen: H1/H2 pass, H3 falsified as measured', () => {
  assert.equal(report.hypotheses.H1_wlg_underestimate_pga_rp475, true);
  assert.equal(report.hypotheses.H2_akl_smallest_gap_of_six_pga_rp475, true);
  assert.equal(report.hypotheses.H3_wlg_gap_grows_with_rp, false);
});

test('headline ratios byte-frozen (Wellington underestimate, Christchurch overestimate)', () => {
  const wlg = report.sites.WLG, chc = report.sites.CHC, akl = report.sites.AKL;
  assert.ok(Math.abs(wlg.ratio.pga.rp475 - 0.453) < 0.001, 'WLG rp475 ' + wlg.ratio.pga.rp475);
  assert.ok(Math.abs(wlg.ratio.pga.rp2500 - 0.619) < 0.001, 'WLG rp2500 ' + wlg.ratio.pga.rp2500);
  assert.ok(Math.abs(akl.ratio.pga.rp475 - 0.801) < 0.001, 'AKL rp475 ' + akl.ratio.pga.rp475);
  assert.ok(Math.abs(chc.ratio.pga.rp475 - 1.978) < 0.001, 'CHC rp475 ' + chc.ratio.pga.rp475);
  assert.ok(Math.abs(wlg.ratio.sa10.rp475 - 0.366) < 0.001, 'WLG sa10 rp475 ' + wlg.ratio.sa10.rp475);
  // every site carries both RPs on both IMTs, all positive
  for (const [sid, v] of Object.entries(report.sites)) {
    for (const imt of ['pga', 'sa10']) {
      for (const rp of ['rp475', 'rp2500']) {
        assert.ok(v.official[imt][rp] > 0 && v.ours[imt][rp] > 0, sid + ' ' + imt + ' ' + rp);
      }
    }
  }
});

test('determinism: re-running the scorecard reproduces the frozen our-side values', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-nz-nshm.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rerun = JSON.parse(out);
  for (const sid of ['WLG', 'AKL', 'CHC', 'NSN', 'ZQN', 'IVC']) {
    assert.ok(Math.abs(rerun.sites[sid].ours.pga.rp475 - report.sites[sid].ours.pga.rp475) < 1e-9, sid);
    assert.ok(Math.abs(rerun.sites[sid].ratio.pga.rp2500 - report.sites[sid].ratio.pga.rp2500) < 1e-9, sid + ' rp2500');
  }
});
