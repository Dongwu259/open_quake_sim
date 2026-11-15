// ================================================================
//  NZ megathrust sensitivity — tripwire locks
//  DECISION SUPPORT ONLY (R-B standing): the hypothetical Hikurangi
//  source exists only inside the tool; the production pack stays
//  byte-frozen. Preregistered verdicts: H1/H3 pass, H2 falsified as
//  measured (a full M9 patch source at lambda=1/600 closes only ~15%
//  of the Wellington gap).
//  Run with:  node --test tests/nz-megathrust.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nz-megathrust-sensitivity-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, bracket disclosure', () => {
  assert.equal(report.schema, 'quake-sim-nz-megathrust-sensitivity-v1');
  assert.match(report.preregistration, /scorecard-nz-megathrust\.js/);
  assert.deepEqual(report.lambdaBracket,
    [+(1 / 600).toPrecision(6), +(1 / 1200).toPrecision(6)]);
  assert.match(report.lambdaProvenance, /BORROWED verbatim/);
  assert.match(report.lambdaProvenance, /no NZ-official M9 recurrence anchor/);
  assert.match(report.note, /production pack byte-frozen/);
  assert.equal(report.frontLine.length, 6);
});

test('preregistered verdicts frozen: H1/H3 pass, H2 falsified as measured', () => {
  assert.equal(report.hypotheses.H1_direction_wlg, true);
  assert.equal(report.hypotheses.H2_material_closure, false, 'H2 frozen falsified');
  assert.equal(report.hypotheses.H3_specificity_akl_ivc, true);
});

test('headline ratios byte-frozen: closure ~15% at 1/600, far cities untouched', () => {
  const before = report.sites.WLG.before.pga.rp475;
  const afterA = report.sites.WLG.after.pga['A-1/600|rp475'];
  const afterB = report.sites.WLG.after.pga['B-1/600|rp475'];
  assert.ok(Math.abs(before - 0.453) < 0.001, 'before ' + before);
  assert.ok(Math.abs(afterA - 0.480) < 0.001, 'A-1/600 ' + afterA);
  assert.ok(Math.abs(afterB - 0.522) < 0.001, 'B-1/600 ' + afterB);
  assert.ok(Math.abs(report.sites.WLG.closure.pga['B-1/600|rp475'] - 1.15152) < 1e-4, 'closure B');
  assert.ok(Math.abs(report.sites.AKL.closure.pga['A-1/600|rp475'] - 1.00185) < 1e-4, 'AKL closure');
  assert.ok(Math.abs(report.sites.IVC.closure.pga['A-1/600|rp475'] - 1) < 1e-4, 'IVC closure');
  // lambda halving roughly halves the lift (near-linear in rate at these levels)
  const liftA = (arm) => report.sites.WLG.after.pga[arm + '|rp475'] - report.sites.WLG.before.pga.rp475;
  assert.ok(liftA('A-1/1200') < liftA('A-1/600') / 1.5, 'lambda-1200 lift materially smaller');
});

test('production pack matches its registered manifest sha + determinism', () => {
  // content invariant (NOT git status — mirror working trees legitimately
  // carry uncommitted sync updates; HANDOVER-2 §5)
  const crypto = require('node:crypto');
  const sha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-newzealand.json'))).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'research_data_manifest.json'), 'utf8'));
  const nz = manifest.resources.find((e) => e.path === 'geojson/psha-source-model-newzealand.json');
  assert.equal(sha, nz.sha256, 'shipped NZ pack bytes == registered sha');
  const rerun = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-nz-megathrust.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(Math.abs(rerun.sites.WLG.after.pga['B-1/600|rp475'] - report.sites.WLG.after.pga['B-1/600|rp475']) < 1e-9);
});
