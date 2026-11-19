// ================================================================
//  NZ deagg-mode comparison (R8-2g) — tripwire locks.
//  Preregistered verdicts frozen AS MEASURED: H1 PASS (CHC RP2475 near-field
//  shallow driver on both sides, magnitudes coincide to 0.05 — independent
//  corroboration of the v7.1 catalog-artifact attribution), H2 FALSIFIED
//  (3/12; misses are the documented equal-area Rrup proxy artifact on giant
//  interface cells, not hazard-level disagreement), H3 FALSIFIED (8/12).
//  Run with:  node --test tests/nz-deagg-mode.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nz-deagg-mode-comparison-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, honest channel boundary', () => {
  assert.equal(report.schema, 'quake-sim-nz-deagg-mode-comparison-v1');
  assert.match(report.preregistration, /scorecard-nz-deagg-mode\.js/);
  assert.equal(report.vs30, 750);
  assert.match(report.note, /MEASUREMENT ONLY/);
  assert.match(report.note, /NOT-OPENED/); // TRT raster-only disclosure
});

test('preregistered verdicts frozen: H1 pass, H2/H3 falsified as measured', () => {
  assert.equal(report.hypotheses.H1_chc_rp2475_nearfield_both, true, 'H1 frozen pass');
  assert.equal(report.hypotheses.H2_modeDist_inOurTopBin_10of12, false, 'H2 frozen falsified');
  assert.equal(report.hypotheses.H3_modeMag_within0p7_10of12, false, 'H3 frozen falsified');
  // 2026-11-19 巨源距离代理整改 re-freeze (finite-rupture lattice): the 1-3 km
  // collapse is eliminated (h2DistPass 3->4; our top bins now sit in the
  // official 25-120 km order) — but the contributor-IDENTITY swap worsened
  // (h3MagPass 8->3): the old proxy's "closest giant cell" naming happened to
  // coincide with the official giant modes, the geometrically honest grid
  // names local shallow sources instead. Frozen as measured.
  assert.deepEqual(report.counts, { comparisons: 12, h2DistPass: 4, h3MagPass: 3 });
});

test('CHC RP2475 headline byte-frozen: both sides near-field (<30 km)', () => {
  const x = report.sites.chc.byRp.rp2475;
  assert.equal(x.officialMode.mag, 6.7);
  assert.equal(x.officialMode.distKm, 7.5);
  // 2026-11-19 re-freeze under the finite-rupture convention (was
  // meanMag 6.74492 @ meanRrupKm 2.13854 — the proxy-collapse artifact)
  assert.ok(Math.abs(x.ourTopBin.meanMag - 6.26415) < 1e-6, 'our meanMag ' + x.ourTopBin.meanMag);
  assert.ok(Math.abs(x.ourTopBin.meanRrupKm - 8.5936) < 1e-6, 'our meanRrup ' + x.ourTopBin.meanRrupKm);
  assert.ok(x.ourTopBin.meanRrupKm < 30 && x.officialMode.distKm < 30);
  assert.equal(x.ourTopBin.srcType, 'crustal');
  const d = report.sites.chc.byRp.rp2475_chc_h1_detail;
  assert.ok(d && Math.abs(d.ourMeanRrupKm - 8.5936) < 1e-6);
});

test('production pack matches its registered manifest sha + determinism', () => {
  const crypto = require('node:crypto');
  const sha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-newzealand.json'))).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'research_data_manifest.json'), 'utf8'));
  const nz = manifest.resources.find((e) => e.path === 'geojson/psha-source-model-newzealand.json');
  assert.equal(sha, nz.sha256, 'shipped NZ pack bytes == registered sha');
  const rerun = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-nz-deagg-mode.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(Math.abs(rerun.sites.chc.byRp.rp2475.ourTopBin.meanMag - report.sites.chc.byRp.rp2475.ourTopBin.meanMag) < 1e-9);
  assert.equal(rerun.counts.h2DistPass, 4);
});

test('official mode artifact: extraction channel provenance + corrected POE mapping', () => {
  const modes = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-disagg-modes.json'), 'utf8'));
  assert.equal(modes.schema, 'quake-sim-nz-nshm-disagg-modes-v1');
  assert.match(modes.extractionNote, /TRT contributions are raster-only/);
  assert.match(modes.vs30Note, /declared deviation/);
  for (const s of Object.keys(modes.sites)) {
    for (const p of ['0.1', '0.02']) {
      const rp = modes.sites[s].byPoe[p].returnPeriod;
      const expected = Math.round(-50 / Math.log(1 - parseFloat(p)));
      assert.equal(rp, expected, 'POE->RP mapping correct for ' + s + '/' + p);
    }
  }
});
