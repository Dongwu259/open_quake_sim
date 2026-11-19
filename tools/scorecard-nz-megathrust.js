#!/usr/bin/env node
'use strict';
// tools/scorecard-nz-megathrust.js — R8-2e follow-up: how much of the
// Wellington structural underestimate (0.453x, tools/data/nz-nshm-comparison-
// report.json) would a HYPOTHETICAL Hikurangi megathrust source close?
// DECISION SUPPORT ONLY — whether to curate NZ fault sources into the pack
// is the user's framework decision; this tool freezes the numbers and
// changes nothing.
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-16, BEFORE the first sensitivity run)
// ============================================================================
// Question: the shipped NZ pack is grid-only (no megathrust/characteristic
// sources) and underestimates the official model at the megathrust capital
// by 0.453x. If a Hikurangi megathrust source entered the pack, how much
// would the six gate sites' ratios close toward 1.0?
//
// Source constructions (frozen — the R-B Japan-Trench template, adapted):
//   Arm A "GR cells": 23 equal point cells along the Hikurangi front line
//     (Physics.REGIONAL_SUBDUCTION_LINES.newzealand[0], [(-36.8,178.7) ..
//     (-42.3,174.6)] interpolated), srcType 'interplate', depth 20 km,
//     truncated GR M7.5-9.0 with the pack's own interplate b, total rate
//     lambda split equally. Carrier: gridMfdSources (UCERF3-batch-B
//     consumer, works on v2 packs — R-B precedent).
//   Arm B "characteristic patch": one M9.0 scenario source with a 4-row
//     depth ladder (8/16/24/32 km) x 8 along-strike columns spanning the
//     same axis segment, appended to the scenarios block (R-B carrier).
//     M9.0 = the Hikurangi M9-class possibility acknowledged in the pack
//     limitations (mMaxByClass.interplate caps the GRID at 9; the
//     scenario source is explicit and outside the grid cap).
//   Lambda bracket: {1/600, 1/1200}/yr — the R-B Japan-Trench frozen M9-class
//     bracket, BORROWED verbatim for the same magnitude class (honestly
//     marked: no NZ-official M9 recurrence anchor exists in hand; the
//     numbers are decision-support sensitivity, not recurrence estimates).
//
// Metrics: six-city ratio ours/official at RP475/RP2500 (PGA + SA1.0)
//   before (shipped) vs after (pack+arm) — closure = ratio_after/ratio_before.
//
// Hypotheses (frozen):
//   H1 (direction): both arms raise the WLG RP475 PGA ratio (a added source
//     can only raise hazard; direction-certain sanity).
//   H2 (material closure): at lambda=1/600, at least one arm lifts the WLG
//     RP475 PGA ratio by >= 0.1 absolute (0.453 -> >= 0.553).
//   H3 (specificity): AKL and IVC RP475 PGA ratios shift < 10% relative
//     (the added source is local; far cities barely move).
//   Sanity S1: shipped ratios reproduce the frozen gate report at
//     toPrecision(6); all curves positive/finite.
//
// Gates: NONE — measurement only. NO pack change, NO anchor change (the
// hypothetical source exists only inside the tool). The un-anchored lambda
// bracket is disclosed everywhere it appears.
// ============================================================================

// ── 2026-11-19 re-measurement amendment (disclosed BEFORE the re-run) ────
// The PSHA point-source distance convention changed to the finite-rupture
// sub-fault lattice (Physics._pshaPointRuptures; preregistration frozen in
// tests/psha-point-rupture.test.js BEFORE the first measurement run — the
// legacy equal-area sphere proxy collapsed giant plate-boundary cells to
// its 0.1 km floor and ate depth into the far-side subtraction). This
// report's OUR-side numbers are re-measured under the new convention and
// re-frozen; the official / J-SHIS side stays byte-unchanged (embedded
// --offline curves or locally frozen extraction artifacts). Verdicts are
// re-judged mechanically by the same preregistered gates — frozen as
// measured, never hand-set.
// ──────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const CURVES = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-curves.json');
const GATE = path.join(ROOT, 'tools', 'data', 'nz-nshm-comparison-report.json');
const OUT = path.join(ROOT, 'tools', 'data', 'nz-megathrust-sensitivity-report.json');

const LAMBDAS = [1 / 600, 1 / 1200];
const RPS = [475, 2500];
const B_INTERPLATE_KEY = 'interplate';
const M_MIN = 7.5, M_MAX = 9.0, M_BIN = 0.1;
const N_CELLS = 23;
const DEPTH_KM = 20;
const G_TO_GAL = 980.665;
const VS30 = 600;

const OFFICIAL_IMT = { pga: 'PGA', sa10: 'SA(1.0)' };
const OUR_IMT = { pga: 'pga', sa10: 'sa:1.0' };

// Hikurangi front line (Physics.REGIONAL_SUBDUCTION_LINES.newzealand[0])
const FRONT = [[-36.8, 178.7], [-38, 179], [-39.3, 178.5], [-40.5, 177.3], [-41.5, 175.6], [-42.3, 174.6]];

function axisPoint(t) { // t in [0,1] along the polyline
  const segs = FRONT.length - 1;
  const x = t * segs;
  const i = Math.min(Math.floor(x), segs - 1);
  const f = x - i;
  return {
    lat: FRONT[i][0] + (FRONT[i + 1][0] - FRONT[i][0]) * f,
    lng: FRONT[i][1] + (FRONT[i + 1][1] - FRONT[i][1]) * f,
  };
}

function grMfd(b) {
  const bins = [];
  let total = 0;
  for (let m = M_MIN; m < M_MAX - 1e-9; m += M_BIN) {
    const r = Math.pow(10, -b * (m + M_BIN / 2));
    bins.push([+(m.toFixed(2)), r]);
    total += r;
  }
  return bins.map(([m, r]) => [m, r / total]);
}

function armCells(lambda, b) {
  const cells = [];
  for (let i = 0; i < N_CELLS; i++) {
    const p = axisPoint((i + 0.5) / N_CELLS);
    cells.push({
      lat: +p.lat.toFixed(4), lng: +p.lng.toFixed(4), depthKm: DEPTH_KM,
      srcType: 'interplate',
      mfd: grMfd(b).map(([m, r]) => [m, r * lambda / N_CELLS]),
    });
  }
  return cells;
}

function armScenario(lambda) {
  const patches = [];
  const depths = [8, 16, 24, 32];
  const cols = 8;
  for (let i = 0; i < cols; i++) {
    const p = axisPoint(0.12 + 0.76 * (i / (cols - 1)));
    for (const d of depths) patches.push([+p.lat.toFixed(4), +p.lng.toFixed(4), d]);
  }
  return { id: 'hikurangiM90Hypo', mw: 9.0, ratePerYear: lambda, sourceType: 'interplate', depthKm: DEPTH_KM, patches: patches };
}

function withGridMfd(model, cells) {
  const m = JSON.parse(JSON.stringify(model));
  m.gridMfdSources = cells;
  return m;
}
function withScenario(model, scenario) {
  const m = JSON.parse(JSON.stringify(model));
  m.scenarios = (m.scenarios || []).concat([scenario]);
  return m;
}

function main() {
  const frozen = JSON.parse(fs.readFileSync(CURVES, 'utf8'));
  const gate = JSON.parse(fs.readFileSync(GATE, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-newzealand.json'), 'utf8'));
  const b = pack.bValues[B_INTERPLATE_KEY];

  // Kororaa curves: keyed by snapped location code + imt (+ agg mean)
  const byKey = {};
  for (const c of frozen.curves) byKey[c.loc + '|' + c.imt + '|' + c.agg] = c;

  const report = {
    schema: 'quake-sim-nz-megathrust-sensitivity-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-nz-megathrust.js header (frozen 2026-11-16, before first run)',
    lambdaBracket: LAMBDAS.map((l) => +l.toPrecision(6)),
    lambdaProvenance: 'the R-B Japan-Trench frozen M9-class bracket {1/600, 1/1200}/yr, BORROWED verbatim for the same magnitude class — no NZ-official M9 recurrence anchor exists in hand; sensitivity decision-support only',
    frontLine: FRONT,
    note: 'MEASUREMENT ONLY — the hypothetical source exists only inside the tool; production pack byte-frozen',
    sites: {},
  };

  const ratios = {};
  for (const s of frozen.requestedSites) {
    const hit = frozen.locations.find((l) => l.name === s.name || l.code === s.code);
    const m = /^(-?\d+\.?\d*)~(-?\d+\.?\d*)$/.exec(hit.code);
    const st = { lat: +m[1], lng: +m[2], vs30: frozen.vs30 };
    const siteRes = { before: {}, after: {}, closure: {} };
    for (const tag of ['pga', 'sa10']) {
      const off = byKey[hit.code + '|' + OFFICIAL_IMT[tag] + '|mean'];
      const offGal = off.curve.levels.map((l) => l * G_TO_GAL);
      const hz0 = Physics.hazardCurve(pack, st, OUR_IMT[tag], { years: 50 });
      siteRes.before[tag] = {};
      siteRes.after[tag] = {};
      siteRes.closure[tag] = {};
      for (const rp of RPS) {
        const o = Physics._pshaInvertCurve(offGal, off.curve.values, 1 / rp);
        const u0 = Physics._pshaInvertCurve(hz0.imLevels, hz0.meanRate, 1 / rp);
        // S1: shipped reproduces the frozen gate at toPrecision(6)
        const want = gate.sites[s.code].ratio[tag]['rp' + rp];
        if (Math.abs(+((u0 / o).toPrecision(6)) - want) > 1e-9) throw new Error('S1 gate mismatch ' + s.code + ' ' + tag + ' rp' + rp);
        siteRes.before[tag]['rp' + rp] = +(u0 / o).toPrecision(6);
        ratios['BEFORE|' + s.code + '|' + tag + '|rp' + rp] = u0 / o;
        for (const lambda of LAMBDAS) {
          const tag2 = '1/' + Math.round(1 / lambda);
          const key = (arm) => arm + '-' + tag2 + '|' + s.code + '|' + tag + '|rp' + rp;
          const hzA = Physics.hazardCurve(withGridMfd(pack, armCells(lambda, b)), st, OUR_IMT[tag], { years: 50 });
          const uA = Physics._pshaInvertCurve(hzA.imLevels, hzA.meanRate, 1 / rp);
          const hzB = Physics.hazardCurve(withScenario(pack, armScenario(lambda)), st, OUR_IMT[tag], { years: 50 });
          const uB = Physics._pshaInvertCurve(hzB.imLevels, hzB.meanRate, 1 / rp);
          siteRes.after[tag]['A-' + tag2 + '|rp' + rp] = +(uA / o).toPrecision(6);
          siteRes.after[tag]['B-' + tag2 + '|rp' + rp] = +(uB / o).toPrecision(6);
          siteRes.closure[tag]['A-' + tag2 + '|rp' + rp] = +((uA / o) / (u0 / o)).toPrecision(6);
          siteRes.closure[tag]['B-' + tag2 + '|rp' + rp] = +((uB / o) / (u0 / o)).toPrecision(6);
          ratios['A-' + tag2 + '|' + s.code + '|' + tag + '|rp' + rp] = uA / o;
          ratios['B-' + tag2 + '|' + s.code + '|' + tag + '|rp' + rp] = uB / o;
        }
      }
    }
    report.sites[s.code] = siteRes;
  }

  const lift = (arm) => ratios[arm + '|WLG|pga|rp475'] - ratios['BEFORE|WLG|pga|rp475'];
  report.hypotheses = {
    H1_direction_wlg: lift('A-1/600') > 0 && lift('B-1/600') > 0,
    H2_material_closure: Math.max(lift('A-1/600'), lift('B-1/600')) >= 0.1,
    H3_specificity_akl_ivc: Math.abs(ratios['A-1/600|AKL|pga|rp475'] / ratios['BEFORE|AKL|pga|rp475'] - 1) < 0.10
      && Math.abs(ratios['A-1/600|IVC|pga|rp475'] / ratios['BEFORE|IVC|pga|rp475'] - 1) < 0.10
      && Math.abs(ratios['B-1/600|AKL|pga|rp475'] / ratios['BEFORE|AKL|pga|rp475'] - 1) < 0.10
      && Math.abs(ratios['B-1/600|IVC|pga|rp475'] / ratios['BEFORE|IVC|pga|rp475'] - 1) < 0.10,
  };
  report.findings = [
    'WLG RP475 PGA ratio before ' + ratios['BEFORE|WLG|pga|rp475'].toFixed(3) +
      ' -> A-1/600 ' + ratios['A-1/600|WLG|pga|rp475'].toFixed(3) + ' / B-1/600 ' + ratios['B-1/600|WLG|pga|rp475'].toFixed(3) +
      ' / A-1/1200 ' + ratios['A-1/1200|WLG|pga|rp475'].toFixed(3) + ' / B-1/1200 ' + ratios['B-1/1200|WLG|pga|rp475'].toFixed(3),
    'closure factors at WLG RP475 PGA: ' + report.sites.WLG.closure.pga['A-1/600|rp475'] + ' (A-1/600) / ' + report.sites.WLG.closure.pga['B-1/600|rp475'] + ' (B-1/600)',
    'far-city specificity at 1/600 (closure factor): AKL ' + report.sites.AKL.closure.pga['A-1/600|rp475'] + ' / IVC ' + report.sites.IVC.closure.pga['A-1/600|rp475'],
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
