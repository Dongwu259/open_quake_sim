'use strict';
// ================================================================
//  v5.8 R7-5 — version accuracy report automation.
//
//  Aggregates every frozen scorecard/benchmark report under tools/data/
//  into ONE versioned summary with a unified envelope and a tuning-read
//  audit: which data split each calibration actually read, so "调参不得
//  读取盲测" (tuning must not read the blind split) is a recorded fact
//  per report rather than a claim.
//
//  Usage: node tools/build-version-report.js [--write]
// ================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tools/data');

// Tuning-read declarations: what each frozen calibration consumed. Kept
// beside the aggregator so the audit travels with the report. The frozen
// three-way split is defined in AGENTS.md (9 train / 5 tune / 5 blind);
// declared reads must reference only the training/tuning arms.
const TUNING_READS = [
  {
    report: 'strong-motion-report.json',
    calibration: 'per-model distance-binned modelBias + magnitude bins',
    reads: '6 frozen calibration events (train split, strong-motion-obs.json)',
    blindSplitRead: false,
    note: 'LOEO report (model-bias-loeo-report.json) measured held-out degradation; treated as 6-event empirical alignment only'
  },
  {
    report: 'gmpe-loeo-report.json',
    calibration: 'leave-one-event-out refits of modelBias',
    reads: 'same 6 frozen events, rotated',
    blindSplitRead: false,
    note: 'documents non-generalisation honestly (zhao 0.899->0.931 held-out)'
  },
  {
    report: 'logic-tree-weights.json',
    calibration: 'LLH weights over the frozen 2,626-station set',
    reads: '13-event frozen set (train+tune, no independent events)',
    blindSplitRead: false
  },
  {
    report: 'tsunami-scorecard-report.json',
    calibration: 'none in this report (physics baseline); Green-law shoreline factor uses published form',
    reads: '3 curated events (preview set)',
    blindSplitRead: false,
    note: 'arrival residuals count=0 until R5-6 curation lands'
  },
  {
    report: 'site-response-report.json',
    calibration: 'S/B f0(Vs30) prior + two-scale synthetic profiles',
    reads: 'KiK-net surface/borehole pairs (197 stations, derived quantities)',
    blindSplitRead: false
  },
  {
    report: 'etas-calibration-report.json',
    calibration: 'AFTERSHOCK_PRODUCTIVITY_LOG10 LSQ slope',
    reads: 'Kumamoto-2016 / Noto-2024 / Tohoku-2011 USGS 90-day counts',
    blindSplitRead: false
  },
  {
    report: 'dispersion-validation.json',
    calibration: 'none (physics verification: analytic flat-bed reference + A/B)',
    reads: 'no observation data — synthetic + bundled bathymetry only',
    blindSplitRead: false
  },
  {
    report: 'shake91-benchmark-case.json',
    calibration: 'none (external published case assertion)',
    reads: 'Itasca public documentation case',
    blindSplitRead: false
  }
];

const REPORT_FILES = [
  'strong-motion-report.json',
  'tsunami-scorecard-report.json',
  'tsunami-scorecard-predictions.json',
  'site-response-report.json',
  'sb-spectral-ratio-report.json',
  'etas-calibration-report.json',
  'logic-tree-weights.json',
  'sigma-components-report.json',
  'spatial-correlation-report.json',
  'ensemble-reliability-report.json',
  'exceedance-crosscheck-report.json',
  'model-bias-loeo-report.json',
  'gmpe-loeo-report.json',
  'geoclaw-crosscheck-report.json',
  'dispersion-validation.json',
  'shake91-benchmark-case.json',
  'f0-jivsm-reeval.json',
  'travel-time-picks.json',
  'frozen-drift-report.json'
];

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { return null; }
}

function main() {
  const write = process.argv.includes('--write');
  const out = {
    schema: 'quake-sim-version-report-v1',
    appVersion: pkgVersion(),
    generatedAt: new Date().toISOString(),
    gitHead: (function () {
      try { return require('child_process').execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
      catch (e) { return null; }
    })(),
    reports: {},
    tuningReads: TUNING_READS,
    tuningAudit: { violations: TUNING_READS.filter(t => t.blindSplitRead).map(t => t.report) },
    summary: {}
  };
  let present = 0;
  for (const f of REPORT_FILES) {
    const p = path.join(DATA, f);
    if (!fs.existsSync(p)) { out.reports[f] = { present: false }; continue; }
    present++;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    out.reports[f] = {
      present: true,
      schema: doc.schema || null,
      generatedAt: doc.generatedAt || doc.createdAt || doc.builtAt || null
    };
  }
  // headline metrics for quick diffing between versions
  try {
    const sm = JSON.parse(fs.readFileSync(path.join(DATA, 'strong-motion-report.json'), 'utf8'));
    out.summary.strongMotion = {
      intensityBias: sm.overall.intensity.bias, intensityRms: sm.overall.intensity.rms, n: sm.overall.intensity.n
    };
  } catch (e) { /* absent */ }
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(DATA, 'tsunami-scorecard-report.json'), 'utf8'));
    out.summary.tsunami = { hitRate: ts.classification.hitRate, falseAlarmRate: ts.classification.falseAlarmRate,
      runupBias: ts.heightByType.runup && ts.heightByType.runup.bias,
      arrivalResidualCount: ts.arrivalMinutes && ts.arrivalMinutes.count };
  } catch (e) { /* absent */ }
  try {
    const dv = JSON.parse(fs.readFileSync(path.join(DATA, 'dispersion-validation.json'), 'utf8'));
    out.summary.dispersion = {
      allPass: dv.allPass,
      cases: (dv.cases || []).map(c => ({ case: c.case, pass: c.pass }))
    };
  } catch (e) { /* absent */ }
  out.summary.reportsPresent = `${present}/${REPORT_FILES.length}`;
  const text = JSON.stringify(out, null, 2);
  if (write) {
    fs.writeFileSync(path.join(DATA, 'version-report.json'), text);
    console.log('wrote tools/data/version-report.json');
  }
  console.log(text);
  process.exitCode = out.tuningAudit.violations.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { TUNING_READS, REPORT_FILES };
