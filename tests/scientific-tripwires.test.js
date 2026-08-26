'use strict';
// v5.8 R7-4 — scientific tripwires. The documented benchmark numbers in
// PHYSICS_BENCHMARKS.md and the frozen reports under tools/data/ are the
// project's scientific claims; these WIDE-gate assertions turn silent
// regressions of those claims into test failures. Gates are deliberately
// loose (they detect "the physics broke", not "the physics moved 2%"):
// tighten only with a fresh, reviewed benchmark run.
const test=require('node:test');
const assert=require('node:assert');
const fs=require('fs');
const path=require('path');

const ROOT=path.resolve(__dirname,'..');
const load=name=>JSON.parse(fs.readFileSync(path.join(ROOT,'tools/data',name),'utf8'));

test('tsunami scorecard tripwire: hit rate / false alarms / residual bands',()=>{
  const report=load('tsunami-scorecard-report.json');
  assert.equal(report.schema,'quake-sim-tsunami-validation-report-v1');
  const cl=report.classification;
  assert.ok(cl.hitRate>=0.30,`hit rate fell to ${(cl.hitRate*100).toFixed(1)}% (gate 30%)`);
  assert.ok(cl.falseAlarmRate===null||cl.falseAlarmRate<=0.25,
    `false-alarm rate rose to ${cl.falseAlarmRate}`);
  const runup=report.heightByType.runup, tide=report.heightByType['tide-gauge'];
  assert.ok(runup&&runup.count>=5,'runup sample shrank');
  assert.ok(runup.bias>-25&&runup.bias<0,`runup bias ${runup.bias} outside [-25,0] m`);
  assert.ok(Math.abs(tide.bias)<=2,`tide-gauge bias ${tide.bias} outside ±2 m`);
});

test('strong-motion scorecard tripwire: calibrated overall bands',()=>{
  const report=load('strong-motion-report.json');
  const o=report.overall;
  assert.ok(o.intensity.rms<=1.0,`intensity RMS ${o.intensity.rms} over 1.0`);
  assert.ok(Math.abs(o.intensity.bias)<=0.3,`intensity bias ${o.intensity.bias} outside ±0.3`);
  assert.ok(o.pga.rms<=0.8,`PGA ln-RMS ${o.pga.rms} over 0.8`);
  assert.ok(o.pgv.rms<=0.6,`PGV ln-RMS ${o.pgv.rms} over 0.6`);
  // frozen sample must not shrink (data was dropped)
  assert.ok(o.intensity.n>=4000,`intensity sample ${o.intensity.n} below 4000`);
});

test('GeoClaw cross-code tripwire: deep-water agreement bands',()=>{
  const report=load('geoclaw-crosscheck-report.json');
  const offshore=report.rows.filter(r=>r.gauge.startsWith('offshore'));
  assert.ok(offshore.length>=2,'offshore gauge rows missing');
  for(const row of offshore){
    assert.ok(row.peakRelDiff<=0.40,
      `offshore peak relative difference grew to ${(row.peakRelDiff*100).toFixed(1)}% at ${row.gauge}`);
    assert.ok(row.pearsonR>=0.8,`offshore correlation ${row.pearsonR} below 0.8 at ${row.gauge}`);
  }
});

test('nested-grid seam tripwire: transmission / reflection / still water',()=>{
  // Re-derives the frozen nested solver diagnostics band from the benchmark
  // tool's recorded values (L1 2.2%, reflection 0.55%); the dedicated
  // nested-grid tests gate tighter transient behaviour, this tripwire pins
  // the DOCUMENTED seam numbers.
  const out=require('child_process').execSync(
    'node tools/validate-nlswe-benchmarks.js',{cwd:ROOT,encoding:'utf8'});
  const m=out.match(/"transmissionL1":\s*([0-9.e-]+)/),r=out.match(/"interfaceReflection":\s*([0-9.e-]+)/);
  assert.ok(m&&r,'nested metrics missing from the benchmark output');
  assert.ok(parseFloat(m[1])<=0.05,`nested transmission L1 ${m[1]} over 5%`);
  assert.ok(parseFloat(r[1])<=0.02,`nested interface reflection ${r[1]} over 2%`);
});

test('dispersion validation tripwire: far-field error reduction + near-field guard',()=>{
  const report=load('dispersion-validation.json');
  assert.equal(report.schema,'quake-sim-dispersion-validation-v1');
  const byCase={};for(const c of report.cases||[])byCase[c.case]=c;
  const a=byCase['A-synthetic-flat-4000m'];
  assert.ok(a,'synthetic case A missing from the frozen report');
  assert.ok(a.rmseVsExactNormalized.boussinesq<a.rmseVsExactNormalized.swe*0.9,
    `dispersive far-field RMSE no longer beats SWE (${JSON.stringify(a.rmseVsExactNormalized)})`);
  assert.ok(a.nearFieldPeak.change<0.10,'case A near-field peak guard exceeded');
  const c=byCase['C-2011-tohoku-nested-nearfield'];
  assert.ok(c,'2011 near-field case missing');
  assert.ok(c.worstCoastalPeakChange<0.10,'2011 coastal peak guard exceeded');
});

test('SHAKE-91 external benchmark tripwire is present',()=>{
  const report=load('shake91-benchmark-case.json');
  assert.ok(report.published&&report.ourResult,
    'SHAKE-91 case lost its published/our-value blocks');
  const ours=Number(report.ourResult.surfacePeakG),
    pub=Math.max(Number(report.published.shake91SurfacePeakG),Number(report.published.flac2dSurfacePeakG));
  assert.ok(isFinite(ours)&&ours>0,'our SHAKE-91 surface peak missing');
  assert.ok(Math.abs(ours-pub)/pub<=0.12,
    `SHAKE-91 surface peak ${ours}g drifted from published ${pub}g by >12%`);
});
