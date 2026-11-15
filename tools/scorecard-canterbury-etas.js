#!/usr/bin/env node
'use strict';
// tools/scorecard-canterbury-etas.js — aftershock-productivity CROSS-REGION
// validation: the Japan-calibrated law (AFTERSHOCK_PRODUCTIVITY_LOG10 = 0.809,
// LSQ over Kumamoto/Noto/Tohoku 90-day USGS counts) vs the Canterbury
// sequence actually in the shipped NZ catalog.
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-16, BEFORE the first validation run)
// ============================================================================
// Question: does the Japan-calibrated aftershock productivity law transfer
// to a foreign (NZ) sequence? The Darfield M7.0 (2010-09-03) Canterbury
// sequence is IN the shipped catalog (25 events M5-7 in the preregistered
// Canterbury box, 24 aftershocks + the mainshock through 2016).
//
// Prediction (the engine's own law, defaults from config.js asyP=1.1 /
// asyB=0.9): prodScale = 10^(0.809*(M-5)); N_pred(M>=4, 90 d) = 20*prodScale
// (uncapped law path, v5.4-calibrated magnitude slope). Converted to the
// catalog's M>=5 floor via a truncated GR fraction with b=0.9 over
// [Mmin=4.0, Mmax=6.5] (the engine's Mmax = mainshock - 0.5 convention):
//   frac(M>=5) = (10^(-b*5) - 10^(-b*6.5)) / (10^(-b*4) - 10^(-b*6.5)).
//
// Observed: events in the preregistered Canterbury box (lat [-44,-43],
// lng [171.4,173.3] — the CHC-attribution box) with time >= Darfield origin,
// EXCLUDING the mainshock itself, counted over windows of 30/90/720 days and
// the full catalog span.
//
// Hypotheses (frozen):
//   H1 (transferability): N_pred(90d, M>=5) lands within the declared x3
//     transferability band [N_obs(90d)/3, N_obs(90d)x3] — a Japan-calibrated
//     law transferring to a foreign sequence within one order of magnitude.
//     The x3 band is the preregistered a-priori transferability tolerance
//     (cross-region GMM/site/catalog-floor variance); it is a DECLARED band,
//     not a fitted one.
//   H2 (window): the sequence OUTLIVES the project's magnitude-scaled
//     aftershock window (min(720, 60*10^(0.5*(M-5))) days = 720 d for M7.0)
//     — i.e. at least one cataloged aftershock occurs later than 720 d after
//     the mainshock (the simulated-window cap is a display budget, not a
//     physical prediction).
//
// Caveats (frozen): single-parent Omori comparison vs the real multi-parent
// ETAS reality (the M6.3 Christchurch event at +172 d is itself a parent —
// its aftershocks are counted in N_obs but the law predicts a single
// parent's tail); catalog floor M>=5 (M>=4 counts are unavailable); b=0.9
// is the config default, not a Canterbury-fitted value.
//
// Gates: NONE — measurement only. NO law change, NO config change.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'canterbury-etas-validation-report.json');

const BOX = { minLat: -44.0, maxLat: -43.0, minLng: 171.4, maxLng: 173.3 };
const CUTOFF_MS = Date.parse('2009-09-04T00:00:00.000Z'); // the CHC-attribution cutoff
const MAIN = { time: '2010-09-03T16:35:47.770Z', mag: 7.0 };
const MAIN_MS = Date.parse(MAIN.time);
const WINDOWS_DAYS = [30, 90, 720, null]; // null = full catalog span
const ASY_P = 1.1;  // config.js defaults
const ASY_B = 0.9;
const MMIN_LAW = 4.0;

function main() {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'psha', 'comcat-newzealand.json'), 'utf8'));
  const boxEvents = cat.events.filter((ev) =>
    ev.lat >= BOX.minLat && ev.lat <= BOX.maxLat && ev.lng >= BOX.minLng && ev.lng <= BOX.maxLng && ev.tsMs >= CUTOFF_MS);
  const main = boxEvents.find((ev) => ev.time === MAIN.time && ev.mag >= MAIN.mag - 0.01);
  if (!main) throw new Error('Darfield mainshock not found in the box');
  const aftershocks = boxEvents.filter((ev) => ev !== main && ev.tsMs >= MAIN_MS)
    .sort((a, b) => a.tsMs - b.tsMs);
  // the catalog stores the 2011-02-22 Christchurch event at M6.1 (ComCat magnitude for this product; the published name-figure is M6.3)
  if (aftershocks.length !== 24 || Math.max(...aftershocks.map((e) => e.mag)) < 6.0) {
    throw new Error('observed set shape changed: n=' + aftershocks.length);
  }

  // the engine's law, uncapped
  const prodScale = Math.pow(10, Physics.AFTERSHOCK_PRODUCTIVITY_LOG10 * (MAIN.mag - 5));
  const nPredM4 = 20 * prodScale; // 90-day count at the law's M>=4 floor
  const mMaxLaw = MAIN.mag - 0.5;
  const frac = (Math.pow(10, -ASY_B * 5) - Math.pow(10, -ASY_B * mMaxLaw)) /
    (Math.pow(10, -ASY_B * MMIN_LAW) - Math.pow(10, -ASY_B * mMaxLaw));
  const nPredM5_90d = nPredM4 * frac;

  const observed = {};
  for (const d of WINDOWS_DAYS) {
    if (d === null) { observed['full'] = aftershocks.length; continue; }
    observed[d + 'd'] = aftershocks.filter((ev) => ev.tsMs - MAIN_MS <= d * 86400000).length;
  }
  const outliving720 = aftershocks.filter((ev) => ev.tsMs - MAIN_MS > 720 * 86400000);

  const ratio90 = nPredM5_90d / observed['90d'];
  const report = {
    schema: 'quake-sim-canterbury-etas-validation-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-canterbury-etas.js header (frozen 2026-11-16, before first run)',
    law: {
      productivityLog10: Physics.AFTERSHOCK_PRODUCTIVITY_LOG10,
      prodScale: +prodScale.toPrecision(6),
      nPredM4_90d: +nPredM4.toPrecision(6),
      asyB: ASY_B, asyP: ASY_P, mMaxLaw: mMaxLaw,
      fracM5: +frac.toPrecision(6),
      nPredM5_90d: +nPredM5_90d.toPrecision(6),
    },
    observed: {
      box: BOX, mainshock: { time: MAIN.time, mag: MAIN.mag },
      aftershocksM5: aftershocks.length,
      windows: observed,
      outliving720d: outliving720.map((e) => ({ time: e.time, mag: e.mag, place: e.place.slice(0, 50) })),
      magRange: [Math.min.apply(null, aftershocks.map((e) => e.mag)), Math.max.apply(null, aftershocks.map((e) => e.mag))],
    },
    hypotheses: {
      H1_transferability_90d_x3band: ratio90 >= 1 / 3 && ratio90 <= 3,
      H2_sequence_outlives_720d_window: outliving720.length >= 1,
    },
    ratioPredOverObs90d: +ratio90.toPrecision(6),
    note: 'MEASUREMENT ONLY — the law and config are unchanged; single-parent Omori comparison vs multi-parent ETAS reality (frozen caveat)',
  };
  report.findings = [
    'the Japan-calibrated law predicts ' + nPredM5_90d.toFixed(1) + ' aftershocks M>=5 in 90 d after the M7.0; observed ' +
      observed['90d'] + ' — ratio ' + ratio90.toFixed(2) + ' (H1 ' + (report.hypotheses.H1_transferability_90d_x3band ? 'PASS: within the declared x3 band' : 'FALSIFIED: outside the declared x3 band') + ')',
    'the sequence outlives the 720-d simulated window by ' + outliving720.length + ' event(s), latest ' +
      (outliving720.length ? outliving720[outliving720.length - 1].time.slice(0, 10) : '-') + ' (H2 ' + (report.hypotheses.H2_sequence_outlives_720d_window ? 'PASS' : 'FALSIFIED') + ')',
    'the 2011-02-22 Christchurch event (catalog M6.1, published figure M6.3) at +172 d is itself a parent — multi-parent ETAS reality vs the single-parent law comparison (frozen caveat)',
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
