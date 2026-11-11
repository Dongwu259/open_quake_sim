#!/usr/bin/env node
'use strict';
// tools/broadband/cs-multi-anchor.js — R10 follow-up (ROADMAP "多锚周期扩展"):
// run the frozen cs-pipeline case construction at anchor periods T*=0.5 s and
// T*=2.0 s (cs-pipeline --anchor=, added for this study; default 1.0 stays
// byte-compat) and compare the shape-gate band structure across anchors.
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-10, BEFORE the first multi-anchor run)
// ============================================================================
// Question: the shipped pipeline froze its shape gates at the single anchor
// T*=1 s (tools/data/cs-pipeline-report.json). Does the band structure — and
// the DW-side 2-5 s value proposition — move with the anchor?
//
// Set: identical frozen preRegistered sites/RPs/periods/realizations (same
// per-case seeds) as the shipped report; ONLY the anchor changes. Each anchor
// run emits its own full pipeline report into .cache (never shipped).
//
// Hypotheses (frozen):
//   H-A (structural): the 0.1-0.5 s band stays FAIL at all three anchors —
//     cs-diagnose A3 measured the 0.1 s MS-CS target structurally unreachable
//     in 4/6 cases regardless of anchor.
//   H-B (DW value): the 2-5 s hybrid-vs-Brune improvement is >= 0.05 at
//     T*=2.0 s — anchoring inside the DW band should showcase the long-period
//     arm where it lives.
//   H-C (middle band, direction-only): the 0.5-2 s hybrid absMax at T*=0.5
//     differs from the T*=1.0 value; recorded either way, no sign promised.
//
// Gates: the SAME preregistered limits evaluated per anchor (bands 0.3/0.25/
// 0.25, anchorExact 0.01, containment 0.8, lpImprovement 0.05, pga
// non-regression 0.05) — recorded per anchor, NO adoption: the shipped
// pipeline report and its T*=1.0 freeze remain untouched (study freeze only).
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FROZEN_T1 = path.join(ROOT, 'tools', 'data', 'cs-pipeline-report.json');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-multi-anchor-report.json');

const ANCHORS = [0.5, 2.0];

function anchorSummary(rep) {
  const g = rep.gates;
  return {
    anchorPeriodSec: rep.preRegistered.anchorPeriodSec,
    bands: {
      '0.1-0.5s': { hybrid: g.bandAbsMax['0.1-0.5s'].hybridAbsMax, brune: g.bandAbsMax['0.1-0.5s'].bruneAbsMax, pass: g.bandAbsMax['0.1-0.5s'].pass },
      '0.5-2s': { hybrid: g.bandAbsMax['0.5-2s'].hybridAbsMax, brune: g.bandAbsMax['0.5-2s'].bruneAbsMax, pass: g.bandAbsMax['0.5-2s'].pass },
      '2-5s': { hybrid: g.bandAbsMax['2-5s'].hybridAbsMax, brune: g.bandAbsMax['2-5s'].bruneAbsMax, pass: g.bandAbsMax['2-5s'].pass },
    },
    anchorExactPass: g.anchorExact.pass,
    lpImprovement: g.lpImprovementVsBrune.improvement,
    lpImprovementPass: g.lpImprovementVsBrune.pass,
    containment: g.containmentInSigma.observed,
    pgaDeltaHybridMinusBrune: g.pgaShapeNonRegressionVsBrune.deltaHybridMinusBrune,
  };
}

function main() {
  const frozen = JSON.parse(fs.readFileSync(FROZEN_T1, 'utf8'));
  if (frozen.preRegistered.anchorPeriodSec !== 1) throw new Error('reference report is not the T*=1.0 freeze');

  const summaries = { '1.0': anchorSummary(frozen) };
  for (const t of ANCHORS) {
    const key = t.toFixed(1); // '0.5' / '2.0'
    const outPath = path.join(ROOT, '.cache', 'cs-anchor-T' + key.replace('.', '_') + '.json');
    let rep;
    if (fs.existsSync(outPath)) {
      rep = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (rep.preRegistered.anchorPeriodSec !== t) throw new Error('stale cached anchor report ' + t + ' — delete and re-run');
      console.log('=== reusing cached anchor run T*=' + t + ' s ===');
    } else {
      console.log('=== running cs-pipeline at anchor T*=' + t + ' s (full synthesis, several minutes) ===');
      execFileSync(process.execPath, [path.join(__dirname, 'cs-pipeline.js'),
        '--anchor=' + t, '--out=' + path.relative(ROOT, outPath).split(path.sep).join('/'), '--write'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
      rep = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (rep.preRegistered.anchorPeriodSec !== t) throw new Error('anchor override did not land in report ' + t);
    }
    summaries[key] = anchorSummary(rep);
  }

  const report = {
    schema: 'quake-sim-cs-multi-anchor-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/broadband/cs-multi-anchor.js header (frozen 2026-11-10, before first run)',
    reference: 'tools/data/cs-pipeline-report.json (shipped T*=1.0 freeze, untouched)',
    anchors: summaries,
    hypotheses: {
      HA_shortBandFailAtAllAnchors: ['0.5', '1.0', '2.0'].every((k) => summaries[k].bands['0.1-0.5s'].pass === false),
      HB_dwImprovementAt2s: summaries['2.0'].lpImprovement >= 0.05,
      HC_midBandT05: { t05: summaries['0.5'].bands['0.5-2s'].hybrid, t10: summaries['1.0'].bands['0.5-2s'].hybrid },
    },
    note: 'STUDY FREEZE — shipped pipeline report (T*=1.0) untouched; anchor runs live in .cache; nothing adopted',
  };

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
