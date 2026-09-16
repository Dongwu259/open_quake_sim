#!/usr/bin/env node
'use strict';
// =====================================================================
//  CS per-class kappa recalibration (PRE_REG_V8, 2026-09-17 — written
//  BEFORE the fit and the validation runs; user-scheduled as the
//  registered cure candidate from CS_GATE_ROLE).
//
//  PARAMETERIZATION (the minimal physical knob)
//  -------------------------------------------
//  kappaByClass {crustal, interplate, intraslab} — the spectral
//  attenuation kappa is HF-only (the Boore branch; v5 measured the
//  short band HF-owned at share 1.000) and physically class-dependent
//  (crustal vs subduction attenuation). Fitted as OFFSETS from the
//  shipped global 0.04 on the FROZEN v7 aligned-retest shapes:
//
//    DsA_c(f) + 2*pi*(f-1)*dKappa_c/ln(10)  ->  min over dKappa_c
//
//    (0.1 s excluded: the station packages are 20 Hz, 9 Hz fMax)
//    kappa_c = clamp(0.04 + dKappa_c, 0.005, 0.10)
//
//  The fit is AGAINST OBSERVATIONS (the v7 observed gm shapes) — not
//  against zhao, so it is non-circular even though obs~zhao in shape
//  (DBAR -0.02..-0.04).
//
//  ACCEPTANCE GATES (all must PASS for the recalibration to land)
//  ---------------------------------------------------------------
//   G1 analytic  : the fitted per-class residual at 0.2 s <= 0.05 dex
//                  and the class spread at 0.2 s <= 0.10.
//   G2 paired    : the FULL aligned retest re-run with kappaByClass —
//                  per-class median |DsA(0.2 s)| <= 0.06 and class
//                  spread <= 0.12 (synthesis nonlinearity margin over
//                  G1). ~160 min, determinism-paired seeds.
//   G3 scenario  : the scenario hybrid arm (6 cases x 25, paired
//                  seeds) re-scored with kappaByClass — short-band
//                  absMax STRICTLY DECREASES from the frozen 0.776,
//                  no other band worsens by > 0.05, anchor stays exact.
//
//  DISPOSITION: if G1+G2+G3 all PASS -> kappaByClass is wired into the
//  shipped calibration (cs-repair-calibration.json gains the field) and
//  the full v3 gate set is re-run and re-frozen; CS_GATE_ROLE updated
//  (recalibration LANDED). If ANY gate fails -> NEGATIVE published,
//  nothing wired, kappa stays global 0.04.
//
//  Honest limits: n=13 events (crustal 8 / interplate 3 / intraslab 2);
//  the class medians rest on 2-3 events for the subduction classes —
//  the fit carries that sample size on its face.
// =====================================================================
const fs = require('fs');
const path = require('path');
const LN10 = Math.LN10;

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'tools', 'data', 'cs-align-retest-report.json');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-kappa-by-class.json');
const GLOBAL_KAPPA = 0.04;
const FIT_PERIODS = [0.15, 0.2, 0.3, 0.4, 0.5]; // 0.1 s excluded (20 Hz edge)
const KAPPA_MIN = 0.005, KAPPA_MAX = 0.10;

function median(a) { if (!a.length) return null; const s2 = a.slice().sort((x, y) => x - y); const m = s2.length >> 1; return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; }

function main() {
  const v7 = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const byClass = {};
  for (const e of v7.events) {
    (byClass[e.srcType] = byClass[e.srcType] || []).push(e);
  }
  const classes = {};
  const g1 = {};
  for (const cls of Object.keys(byClass)) {
    const evs = byClass[cls];
    const dsa = FIT_PERIODS.map((T) => median(evs.map((e) => e.alignedDs[String(T)]).filter((v) => v != null)));
    // LSQ through origin. PHYSICAL SIGN: raising kappa by dK multiplies the
    // synth FAS at f by exp(-2*pi*f*dK) relative to exp(-2*pi*1*dK) at the
    // anchor, so the T-vs-1s shape shifts by -2*pi*(f-1)*dK/ln10 dex —
    // dKappa = +ln10 * sum(DsA*x) / (2*pi * sum(x^2)), x = f-1
    // (first draft had the sign inverted: it "passed" G1 because the
    // analytic residual reused the same wrong-sign model — the physical
    // direction must be pinned by re-synthesis, G2).
    let sxy = 0, sxx = 0;
    FIT_PERIODS.forEach((T, i) => {
      if (dsa[i] == null) return;
      const x = 1 / T - 1;
      sxy += dsa[i] * x; sxx += x * x;
    });
    const dKappa = sxx > 0 ? +(LN10 * sxy) / (2 * Math.PI * sxx) : 0;
    const kappa = Math.max(KAPPA_MIN, Math.min(KAPPA_MAX, GLOBAL_KAPPA + dKappa));
    const resid = {};
    FIT_PERIODS.forEach((T, i) => {
      if (dsa[i] == null) return;
      resid[String(T)] = +(dsa[i] - 2 * Math.PI * (1 / T - 1) * dKappa / LN10).toFixed(4);
    });
    classes[cls] = {
      n: evs.length, dsaMedians: dsa.reduce((o, v, i) => (o[String(FIT_PERIODS[i])] = v, o), {}),
      dKappa: +dKappa.toFixed(5), kappa: +kappa.toFixed(5),
      clamped: (GLOBAL_KAPPA + dKappa) !== kappa,
      fitResidual: resid
    };
    g1[cls] = { residual02: resid['0.2'], pass: Math.abs(resid['0.2']) <= 0.05 };
  }
  const r02 = Object.keys(g1).map((c) => g1[c].residual02);
  const spread = +(Math.max(...r02) - Math.min(...r02)).toFixed(4);
  const g1Pass = spread <= 0.10 && Object.keys(g1).every((c) => g1[c].pass);

  const report = {
    schema: 'quake-sim-cs-kappa-by-class-v1',
    generatedAt: new Date().toISOString(),
    preRegistered: {
      gate: 'G1 analytic residual(0.2s) <= 0.05/class and spread <= 0.10; G2 paired re-synthesis per-class median |DsA(0.2s)| <= 0.06, spread <= 0.12; G3 scenario short-band absMax strictly decreases from 0.776, no other band worsens by > 0.05, anchor exact. All three PASS -> wire kappaByClass into cs-repair-calibration + full v3 gate re-freeze + CS_GATE_ROLE updated; any FAIL -> NEGATIVE published, nothing wired',
      model: 'physical sign: shape shifts by -2pi(f-1)*dKappa/ln10 dex per +dKappa; dKappa_c = +ln10 * sum(DsA*x) / (2pi * sum(x^2)), x = f-1, f in {2,2.5,3.33,5,6.67} Hz (0.1 s excluded); kappa_c = clamp(0.04 + dKappa_c, 0.005, 0.10)',
      basis: 'tools/data/cs-align-retest-report.json (frozen 2026-09-16); against OBSERVED shapes, not zhao (non-circular)',
      sampleSizes: Object.fromEntries(Object.keys(byClass).map((c) => [c, byClass[c].length]))
    },
    classes,
    G1: { perClass: g1, spread02: spread, pass: g1Pass }
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('=== PRE_REG_V8 kappa-by-class fit ===');
  for (const cls of Object.keys(classes)) {
    const c = classes[cls];
    console.log(cls.padEnd(11), 'n=' + c.n, 'kappa', GLOBAL_KAPPA, '->', c.kappa, '(dKappa', c.dKappa + ')', 'resid(0.2s)', g1[cls].residual02);
  }
  console.log('G1:', g1Pass ? 'PASS' : 'FAIL', '| spread(0.2s)', spread);
  console.log('wrote ' + OUT);
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
