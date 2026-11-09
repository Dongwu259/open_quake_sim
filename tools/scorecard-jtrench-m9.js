#!/usr/bin/env node
'use strict';
// tools/scorecard-jtrench-m9.js — R-B Japan-Trench M9 stationary-package
// measurement (DECISION SUPPORT ONLY — the package-entry question is the
// user's framework decision; this tool freezes the numbers, changes nothing).
//
// ============================================================================
// PREREGISTRATION (written before the first run — 2026-11-08)
// ============================================================================
// Question (R8 DEFER + HANDOVER queue): if a STATIONARY (Poisson) source
// representing the Japan-Trench M9 class entered the shipped Japan PSHA
// package, how much would the six frozen decompose sites' RP475/RP2500
// curves shift, and how much would the ppeEquiv-vs-J-SHIS comparison worsen?
//
// Source constructions (frozen):
//   Arm A "GR cells" (the registered question's wording): 23 equal point
//     cells along a linear Japan-Trench axis (36.0N,142.2E) -> (41.5N,144.4E),
//     srcType 'interplate', depthKm 20, truncated GR MFD M7.5-9.1 with the
//     model's interplate b (1.135895365480147), TOTAL rate lambda split
//     equally across cells. Engine carrier: gridMfdSources (UCERF3 批 B
//     point-source equal-area proxy).
//   Arm B "characteristic patch" (Nankai-recipe sensitivity arm): one M9.1
//     scenario source with a 4-row depth ladder (8/16/24/32 km) x 8
//     along-strike columns spanning the same axis segment, appended to the
//     model's scenarios block (schema = nankaiFullM89).
//   Lambda bracket (SCIENTIFIC-REPORT §日本海沟 M9 DEFER, frozen): 1/600 and
//     1/1200 per year (pre-2011 reference P30 in the 2.4-4.9% band).
//
// Metrics (both frozen):
//   M1  package-entry view: PGA RP475/RP2500 per site on the FULL shipped
//       model vs model+arm — absolute shifts.
//   M2  J-SHIS comparison view: the decompose ppeEquiv arm rebuilt at the
//       same PGV levels as the frozen report (sites[].site.levelsCmS), with
//       and without the added source; the ratio-vs-J-SHIS delta at RP475
//       (jshis PPE RP475 inverted from the frozen PPE_MTTL 30-yr rates).
//
// Gates: NONE (measurement only). No adoption, no pack change, no anchors
// touched — production model/tests byte-frozen. The numbers arm the user's
// framework decision.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'jtrench-m9-report.json');

const LAMBDAS = [1 / 600, 1 / 1200];
const B_INTERPLATE = 1.135895365480147;
const M_MIN = 7.5, M_MAX = 9.1, M_BIN = 0.1;
const AXIS_A = { lat: 36.0, lng: 142.2 };
const AXIS_B = { lat: 41.5, lng: 144.4 };
const N_CELLS = 23;
const DEPTH_KM = 20;

const SITES = [
  { id: 'tokyo', lat: 35.6812, lng: 139.7671 },
  { id: 'osaka', lat: 34.6937, lng: 135.5022 },
  { id: 'sendai', lat: 38.2682, lng: 140.8694 },
  { id: 'kochi', lat: 33.5597, lng: 133.5311 },
  { id: 'nagoya', lat: 35.1815, lng: 136.9066 },
  { id: 'fukuoka', lat: 33.5902, lng: 130.4017 },
];

function axisPoint(t) { // t in [0,1]
  return { lat: AXIS_A.lat + (AXIS_B.lat - AXIS_A.lat) * t, lng: AXIS_A.lng + (AXIS_B.lng - AXIS_A.lng) * t };
}

// Truncated GR incremental MFD, bins of M_BIN from M_MIN to M_MAX, total 1.0
// (caller scales by the cell rate share).
function grMfd(b) {
  const bins = [];
  let total = 0;
  for (let m = M_MIN; m < M_MAX - 1e-9; m += M_BIN) {
    // incremental rate ~ 10^(-b*m) integrated over the bin (midpoint rule)
    const r = Math.pow(10, -b * (m + M_BIN / 2));
    bins.push([+(m.toFixed(2)), r]);
    total += r;
  }
  return bins.map(([m, r]) => [m, r / total]);
}

function armSources(lambda) {
  const cells = [];
  for (let i = 0; i < N_CELLS; i++) {
    const p = axisPoint((i + 0.5) / N_CELLS);
    cells.push({
      lat: +p.lat.toFixed(4), lng: +p.lng.toFixed(4), depthKm: DEPTH_KM,
      srcType: 'interplate',
      mfd: grMfd(B_INTERPLATE).map(([m, r]) => [m, r * lambda / N_CELLS]),
    });
  }
  return cells;
}

function armScenario(lambda) {
  // Nankai-recipe: 4-row depth ladder x 8 along-strike columns (like the
  // shipped nankaiFullM89 patch ladder), spanning the trench axis segment.
  const patches = [];
  const depths = [8, 16, 24, 32];
  const cols = 8;
  for (let i = 0; i < cols; i++) {
    const p = axisPoint(0.12 + 0.76 * (i / (cols - 1)));
    for (const d of depths) patches.push([+p.lat.toFixed(4), +p.lng.toFixed(4), d]);
  }
  return { id: 'jtrenchM91Hypo', mw: 9.1, ratePerYear: lambda, sourceType: 'interplate', depthKm: DEPTH_KM, patches: patches };
}

function withGridMfd(model, cells) {
  const m = JSON.parse(JSON.stringify(model));
  m.gridMfdSources = cells; // UCERF3 批 B v3 consumer reads this block
  return m;
}
function withScenario(model, scenario) {
  const m = JSON.parse(JSON.stringify(model));
  m.scenarios = (m.scenarios || []).concat([scenario]);
  return m;
}

function rpAt(imLevels, meanRate, rp) {
  return Physics._pshaInvertCurve(imLevels, meanRate, 1 / rp);
}

function main() {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'jshis-decompose-report.json'), 'utf8'));

  const out = {
    schema: 'quake-sim-jtrench-m9-report-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-jtrench-m9.js header (frozen 2026-11-08, before first run)',
    lambdaBracket: LAMBDAS.map((l) => +l.toPrecision(6)),
    note: 'MEASUREMENT ONLY — package entry is a user framework decision; production model byte-frozen',
    sites: {},
  };

  for (const site of SITES) {
    const st = { lat: site.lat, lng: site.lng, vs30: 600 };
    const hzBase = Physics.hazardCurve(model, st, 'pga', { years: 50 });
    const res = { pga: { base: { rp475: rpAt(hzBase.imLevels, hzBase.meanRate, 475), rp2500: rpAt(hzBase.imLevels, hzBase.meanRate, 2500) } }, ppe: {} };

    for (const lambda of LAMBDAS) {
      const tag = '1/' + Math.round(1 / lambda);
      const hzA = Physics.hazardCurve(withGridMfd(model, armSources(lambda)), st, 'pga', { years: 50 });
      const hzB = Physics.hazardCurve(withScenario(model, armScenario(lambda)), st, 'pga', { years: 50 });
      res.pga['A-' + tag] = { rp475: rpAt(hzA.imLevels, hzA.meanRate, 475), rp2500: rpAt(hzA.imLevels, hzA.meanRate, 2500) };
      res.pga['B-' + tag] = { rp475: rpAt(hzB.imLevels, hzB.meanRate, 475), rp2500: rpAt(hzB.imLevels, hzB.meanRate, 2500) };
    }

    // M2: ppeEquiv PGV ratio shift (decompose metric)
    const siteFrozen = frozen.sites.find((s) => s.site.id === site.id);
    const levels = siteFrozen.levelsCmS;
    const jshisPpe = siteFrozen.jshis.PPE_MTTL;
    // jshis PPE -> RP475: the frozen report carries already-annualized rates
    // (rateAnnual; None = saturated leading levels — dropped before inversion)
    const lv = [], rr = [];
    for (let i = 0; i < levels.length; i++) {
      if (jshisPpe.rateAnnual[i] != null) { lv.push(levels[i]); rr.push(jshisPpe.rateAnnual[i]); }
    }
    const jshisRp475 = Physics._pshaInvertCurve(lv, rr, 1 / 475);
    // ppeEquiv submodel: interplate+intraslab cells + Nankai x3
    const mPpe = JSON.parse(JSON.stringify(model));
    mPpe.cells = mPpe.cells.filter((c) => c.srcType === 'interplate' || c.srcType === 'intraslab');
    mPpe.scenarios = (mPpe.scenarios || []).filter((s) => s.id.indexOf('nankai') === 0);
    function ppeRp(extra) {
      const hz = Physics.hazardCurve(extra || mPpe, st, 'pgv', { imLevels: levels, years: 1 });
      return rpAt(hz.imLevels, hz.meanRate, 475);
    }
    const oursPpe = ppeRp(null);
    res.ppe = {
      jshisRp475PgvCmS: jshisRp475,
      oursRp475PgvCmS: oursPpe,
      ratioBase: oursPpe / jshisRp475,
    };
    for (const lambda of LAMBDAS) {
      const tag = '1/' + Math.round(1 / lambda);
      const withSource = JSON.parse(JSON.stringify(mPpe));
      withSource.gridMfdSources = armSources(lambda);
      const oursWith = ppeRp(withSource);
      res.ppe['ratioA-' + tag] = oursWith / jshisRp475;
      res.ppe['ratioB-' + tag] = ppeRp(withScenario(mPpe, armScenario(lambda))) / jshisRp475;
    }
    out.sites[site.id] = res;
  }

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(out, null, 1));
}

main();
