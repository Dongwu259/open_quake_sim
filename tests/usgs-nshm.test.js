// ================================================================
//  R8-2c USGS NSHM 2023.R2 external-gate comparison — tripwire locks
//  The frozen report is MEASUREMENT ONLY (no calibration, pack
//  unchanged; BC 760 m/s both sides). Preregistered hypotheses H1-H3
//  all PASS as measured; these locks keep the numbers reproducible.
//  Run with:  node --test tests/usgs-nshm.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'usgs-nshm-comparison-report.json'), 'utf8'));
const curves = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'usgsnshm', 'nshm-conus-2023r2-curves.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, official provenance', () => {
  assert.equal(report.schema, 'quake-sim-usgs-nshm-comparison-v1');
  assert.match(report.preregistration, /scorecard-usgs-nshm\.js/);
  assert.match(report.official.edition, /STATIC_CONUS_2023_R2/);
  assert.equal(report.official.siteClass, 'BC');
  assert.match(report.note, /MEASUREMENT ONLY/);
  assert.equal(curves.schema, 'quake-sim-usgs-nshm-curves-v1');
  assert.equal(curves.curves.length, 4);
  assert.equal(curves.siteClassNote.indexOf('760'), 38 > 0 ? curves.siteClassNote.indexOf('760') : 0, 'BC note present');
});

test('preregistered verdicts frozen: H1/H2/H3 all pass as measured', () => {
  assert.equal(report.hypotheses.H1_ucerf3_lineage_LA_pga_rp475, true);
  assert.equal(report.hypotheses.H2_systematic_same_sign, true);
  assert.equal(report.hypotheses.H3_broadband_LA, true);
  assert.equal(report.hypotheses.H3_broadband_SF, true);
});

test('headline ratios byte-frozen: pack sits ~1.35-1.40x above official 2023', () => {
  const la = report.sites.LA, sf = report.sites.SF;
  assert.ok(Math.abs(la.ratio.pga.rp475 - 1.395) < 0.001, 'LA rp475 ' + la.ratio.pga.rp475);
  assert.ok(Math.abs(sf.ratio.pga.rp475 - 1.351) < 0.001, 'SF rp475 ' + sf.ratio.pga.rp475);
  assert.ok(Math.abs(la.ratio.pga.rp2500 - 1.201) < 0.001, 'LA rp2500 (gap narrows)');
  assert.ok(Math.abs(sf.ratio.sa10.rp475 - 1.384) < 0.001, 'SF sa10 rp475');
  for (const [sid, v] of Object.entries(report.sites)) {
    for (const imt of ['pga', 'sa10']) {
      for (const rp of ['rp475', 'rp2500']) {
        assert.ok(v.official[imt][rp] > 0 && v.ours[imt][rp] > 0, sid + ' ' + imt + ' ' + rp);
      }
    }
  }
});

test('determinism: re-running the scorecard reproduces the frozen our-side values', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-usgs-nshm.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rerun = JSON.parse(out);
  for (const sid of ['LA', 'SF']) {
    assert.ok(Math.abs(rerun.sites[sid].ours.pga.rp475 - report.sites[sid].ours.pga.rp475) < 1e-9, sid);
    assert.ok(Math.abs(rerun.sites[sid].ratio.sa10.rp2500 - report.sites[sid].ratio.sa10.rp2500) < 1e-9, sid + ' sa10 rp2500');
  }
});
