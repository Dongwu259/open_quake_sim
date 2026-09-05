// cs-pipeline.test.js — tripwire for the frozen conditional-spectrum pipeline
// report (tools/data/cs-pipeline-report.json, schema quake-sim-cs-pipeline-v1,
// pipelineVersion 3). The v3 repair batch (2026-09-04) executed the three
// registered directions and froze the outcomes honestly: bin-conditional
// scoring + kappa 0.04 shipped; stress re-calibration measured FLAT (negative
// result); the (mw,rRup) LF gain REFUTED by residual structure (negative
// result). The shape gates still FAIL and the info-page productization stays
// frozen — these assertions lock the v3 numbers so any drift from a re-run
// without conscious refreezing (experiment manifest + this file) turns red.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'cs-pipeline-report.json');
const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('cs-pipeline — schema, v1+v3 pre-registration present', () => {
  assert.equal(r.schema, 'quake-sim-cs-pipeline-v1');
  assert.equal(r.pipelineVersion, 3);
  assert.equal(r.preRegistered.batch.includes('frozen 2026-09-03'), true);
  assert.deepEqual(r.preRegistered.sites.map((s) => s.id), ['tokyo', 'osaka', 'sendai', 'kochi']);
  assert.deepEqual(r.preRegistered.returnPeriods, [475, 2500]);
  assert.equal(r.preRegistered.anchorPeriodSec, 1.0);
  assert.equal(r.preRegistered.realizationsPerCase, 25);
  assert.equal(r.preRegisteredV3.batch.includes('pre-registered 2026-09-04'), true);
  assert.equal(r.preRegisteredV3.scoringChange.gatesUnchanged.includes('unchanged'), true);
});

test('cs-pipeline — frozen v3 gate outcomes (honest FAILs locked with the repair record)', () => {
  const g = r.gates;
  assert.equal(g.anchorExact.pass, true);
  assert.equal(g.anchorExact.observedAbsMax, 0);
  // shape gates: all FAIL, v3 numbers frozen
  assert.equal(g.bandAbsMax['0.1-0.5s'].pass, false);
  assert.equal(g.bandAbsMax['0.1-0.5s'].hybridAbsMax, 0.776); // v3: kappa 0.04 + bin-conditional scoring (v2 mixture: 0.935)
  assert.equal(g.bandAbsMax['0.5-2s'].pass, false);
  assert.equal(g.bandAbsMax['0.5-2s'].hybridAbsMax, 0.432);
  assert.equal(g.bandAbsMax['2-5s'].pass, false);
  assert.equal(g.bandAbsMax['2-5s'].hybridAbsMax, 0.574);
  assert.equal(g.containmentInSigma.pass, false);
  assert.equal(g.containmentInSigma.observed, 0.385);
  assert.equal(g.lpImprovementVsBrune.pass, true);
  assert.equal(g.lpImprovementVsBrune.improvement, 0.753); // brune 1.327 - hybrid 0.574
  assert.equal(g.pgaShapeNonRegressionVsBrune.pass, false);
  assert.equal(g.pgaShapeNonRegressionVsBrune.deltaHybridMinusBrune, 0.125);
  // worst-case attribution frozen (the two documented residual regimes)
  assert.equal(g.bandAbsMax['0.1-0.5s'].worstAt, 'osaka RP2500 @0.1s'); // megathrust HF-vs-zhao short shape
  assert.equal(g.bandAbsMax['2-5s'].worstAt, 'kochi RP475 @4s');       // site/basin-specific DW deficit
});

test('cs-pipeline — calibration record: stress flatness + LF-gain refutation frozen', () => {
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'data', 'cs-repair-calibration.json'), 'utf8'));
  assert.equal(cal.schema, 'quake-sim-cs-repair-calibration-v1');
  assert.equal(cal.kappaSec, 0.04);
  // negative result #1: the stress scan is flat within noise — B2's 50 MPa kept
  assert.deepEqual(cal.stressByClass, { crustal: 50, interplate: 50, intraslab: 50 });
  for (const cls of Object.keys(cal.stressScan)) {
    const meds = cal.stressScan[cls].map((x) => x.medianAbsBias);
    assert.ok(Math.max(...meds) - Math.min(...meds) < 0.05, cls + ' stress scan drifted from the frozen flatness');
  }
  // negative result #2: the (mw,rRup) LF gain is refuted (kochi vs osaka same
  // (M,R) band, opposite-signed 2-4 s residuals) and must stay disabled
  assert.equal(cal.lfGainApplied, false);
  assert.ok(cal.lfGainDecision.includes('REFUTED'));
  assert.equal(r.calibration.stressByClass.crustal, 50);
});

test('cs-pipeline — bin-conditional anchor identity and realization bookkeeping', () => {
  const valid = r.cases.filter((c) => c.mscs);
  assert.equal(valid.length, 6); // sendai skipped: no JIVSM column (frozen)
  const sendai = r.cases.find((c) => c.skipped);
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
  for (const row of rows) {
    const c = valid.find((cc) => cc.site.id === row.site && cc.rp === row.rp);
    assert.ok(Math.abs(Math.log10(row.psaGal[anchorIdx] / c.imTarget)) <= 0.01, 'anchor scale drift');
    // every valid realization carries its own bin-conditional target row
    assert.ok(Array.isArray(row.condMuLn) && Math.abs(Math.abs(row.condMuLn[anchorIdx] - Math.log(c.imTarget)) < 1e-3), 'condMuLn anchor mismatch');
  }
});

test('cs-pipeline — perCase bin-conditional bias recomputable from stored realizations', () => {
  const anchorIdx = 7;
  const periods = r.preRegistered.periodsSec;
  for (const p of r.perCase) {
    if (p.arm !== 'hybrid') continue;
    const rows = r.realizations.filter((x) => x.site === p.site && x.rp === p.rp && x.arm === 'hybrid' && x.psaGal);
    assert.equal(rows.length, p.n);
    // spot-check two periods (anchor + one long) against the frozen bias
    for (const pi of [anchorIdx, periods.length - 1]) {
      let s = 0;
      for (const row of rows) s += Math.log(row.psaGal[pi]) - row.condMuLn[pi];
      const recomputed = s / rows.length / Math.LN10;
      assert.ok(Math.abs(recomputed - p.biasLog10[pi]) < 5e-3,
        p.site + ' RP' + p.rp + ' T=' + periods[pi] + ' bias ' + p.biasLog10[pi] + ' vs recomputed ' + recomputed.toFixed(3));
    }
  }
});

test('cs-pipeline — scale-factor transparency block frozen', () => {
  assert.equal(r.scaleFactors.hybrid.n, 150);
  assert.equal(r.scaleFactors.hybrid.median, 1.359); // v3 (kappa 0.04, stress 50, no LF gain)
  assert.equal(r.scaleFactors.brune.median, 0.97);
  assert.ok(r.findings.summary.join(' ').includes('circularity') || r.findings.summary.join(' ').includes('diagnostic'));
});
