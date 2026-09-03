// cs-pipeline.test.js — tripwire for the frozen conditional-spectrum pipeline
// report (tools/data/cs-pipeline-report.json, schema quake-sim-cs-pipeline-v1).
// The gates failed honestly where they failed: these assertions freeze the
// frozen numbers so any drift from a re-run without conscious refreezing
// (experiment manifest + this file) turns the suite red.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'cs-pipeline-report.json');
const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('cs-pipeline — schema and pre-registration present', () => {
  assert.equal(r.schema, 'quake-sim-cs-pipeline-v1');
  assert.equal(r.preRegistered.batch.includes('frozen 2026-09-03'), true);
  assert.deepEqual(r.preRegistered.sites.map((s) => s.id), ['tokyo', 'osaka', 'sendai', 'kochi']);
  assert.deepEqual(r.preRegistered.returnPeriods, [475, 2500]);
  assert.equal(r.preRegistered.anchorPeriodSec, 1.0);
  assert.equal(r.preRegistered.realizationsPerCase, 25);
});

test('cs-pipeline — frozen gate outcomes (honest FAILs locked)', () => {
  const g = r.gates;
  assert.equal(g.anchorExact.pass, true);
  assert.equal(g.anchorExact.observedAbsMax, 0);
  // shape gates: all FAIL, numbers frozen
  assert.equal(g.bandAbsMax['0.1-0.5s'].pass, false);
  assert.equal(g.bandAbsMax['0.1-0.5s'].hybridAbsMax, 0.935); // v2 anchors re-freeze 2026-09-04
  assert.equal(g.bandAbsMax['0.5-2s'].pass, false);
  assert.equal(g.bandAbsMax['0.5-2s'].hybridAbsMax, 0.433);
  assert.equal(g.bandAbsMax['2-5s'].pass, false);
  assert.equal(g.bandAbsMax['2-5s'].hybridAbsMax, 0.576);
  assert.equal(g.containmentInSigma.pass, false);
  assert.equal(g.containmentInSigma.observed, 0.359);
  assert.equal(g.lpImprovementVsBrune.pass, true);
  assert.equal(g.lpImprovementVsBrune.improvement, 0.691);
  assert.equal(g.pgaShapeNonRegressionVsBrune.pass, false);
  assert.equal(g.pgaShapeNonRegressionVsBrune.deltaHybridMinusBrune, 0.153);
});

test('cs-pipeline — MS-CS anchor identity and realization bookkeeping', () => {
  const valid = r.cases.filter((c) => c.mscs);
  assert.equal(valid.length, 6); // sendai skipped: no JIVSM column (frozen)
  const sendai = r.cases.find((c) => c.site.id === 'sendai');
  assert.equal(sendai.skipped, 'no JIVSM column');
  const anchorIdx = 7; // periods[7] = 1.0 s
  for (const c of valid) {
    // mixture conditional mean at the anchor equals the conditioning level (rho(T*,T*)=1)
    assert.ok(Math.abs(c.mscs.meanGal[anchorIdx] / c.imTarget - 1) < 0.02,
      c.site.id + ' RP' + c.rp + ' anchor identity broken: ' + c.mscs.meanGal[anchorIdx] + ' vs ' + c.imTarget);
    assert.ok(c.mscs.sigmaLn[anchorIdx] < 0.02, 'anchor conditional sigma must collapse');
  }
  assert.equal(r.invalidRealizations, 0);
  const rows = r.realizations.filter((x) => x.psaGal);
  assert.equal(rows.length, 300); // 3 sites x 2 RPs x 2 arms x 25
  // anchor exactness per realization (recomputed from the stored rows)
  for (const row of rows) {
    const c = valid.find((cc) => cc.site.id === row.site && cc.rp === row.rp);
    assert.ok(Math.abs(Math.log10(row.psaGal[anchorIdx] / c.imTarget)) <= 0.01, 'anchor scale drift');
  }
});

test('cs-pipeline — perCase bias recomputable from stored realizations', () => {
  const anchorIdx = 7;
  const periods = r.preRegistered.periodsSec;
  for (const p of r.perCase) {
    if (p.arm !== 'hybrid') continue;
    const rows = r.realizations.filter((x) => x.site === p.site && x.rp === p.rp && x.arm === 'hybrid' && x.psaGal);
    assert.equal(rows.length, p.n);
    // spot-check two periods (anchor + one long) against the frozen bias
    for (const pi of [anchorIdx, periods.length - 1]) {
      let s = 0;
      for (const row of rows) s += Math.log(row.psaGal[pi]);
      const c = r.cases.find((cc) => cc.site.id === p.site && cc.rp === p.rp);
      const recomputed = (s / rows.length - Math.log(c.mscs.meanGal[pi])) / Math.LN10;
      assert.ok(Math.abs(recomputed - p.biasLog10[pi]) < 5e-3,
        p.site + ' RP' + p.rp + ' T=' + periods[pi] + ' bias ' + p.biasLog10[pi] + ' vs recomputed ' + recomputed.toFixed(3));
    }
  }
});

test('cs-pipeline — scale-factor transparency block frozen', () => {
  assert.equal(r.scaleFactors.hybrid.n, 150);
  assert.equal(r.scaleFactors.hybrid.median, 1.33); // v2 anchors re-freeze 2026-09-04
  assert.equal(r.scaleFactors.brune.median, 0.931);
  assert.ok(r.findings.summary.join(' ').includes('diagnostic'));
});
