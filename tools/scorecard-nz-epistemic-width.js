#!/usr/bin/env node
'use strict';
// tools/scorecard-nz-epistemic-width.js — R8-2e: EPISTEMIC-WIDTH validation.
// The R8-2b gate compared MEAN curves only; this measures whether our logic
// tree's implied epistemic SPREAD matches the official model's.
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-16, BEFORE the first successful scoring run)
// ============================================================================
// Question: does our branch tree UNDERSTATE or OVERSTATE the official
// epistemic uncertainty? The Kororaa API serves mean + 0.1/0.9 fractile
// curves (36 curves frozen by tools/fetch-nz-nshm-quantiles.js); our side is
// measured by COLLAPSING the crustal tree to each single branch (5 branches:
// bssa14/cy14/cb14-HighQ/cb14-LowQ/ask14 — the same GMM-collapse convention
// as the CA attribution arms), subduction branches stay as shipped.
//
// Metric (IM space, per site/IMT/RP): invert each official fractile curve at
// the RP -> IM_P10/IM_mean/IM_P90; width_off = log10(IM_P90/IM_P10). Ours:
// invert each collapsed-branch curve -> min/max bounds;
// width_ours = log10(IM_max/IM_min).
// ENGINE NOTE (found during the first run attempt, before any freeze): the
// hazardCurve `ensemble` sets only accumulate branch indices < 3 — a
// v6.1-era 3-branch design that silently drops branches 4+ of the 5-branch
// trees (the mean is then not straddled). The engine is NOT changed in this
// measurement-only batch; the collapse arms below are the honest spread and
// the ensemble limitation is registered as a future engine-fix candidate.
// CONSERVATISM (preregistered): our per-branch min/max BOUNDS are wider than
// any true P10-P90 fractile band for the same tree — so if
// width_ours < width_off, our tree understates the official spread
// A FORTIORI (the conclusion is robust to the 5-point branch representation).
//
// Hypotheses (frozen):
//   H1 (understated spread): width_ours < width_off at WLG RP475 PGA.
//   H2 (central containment): our mean RP475 IM sits inside the official
//     [IM_P10, IM_P90] band at WLG RP475 PGA. (Given the R8-2b gate measured
//     ours at 0.453x the official mean, H2 may FALSIFY — either verdict is
//     informative and frozen.)
//   H3 (broadband): the H1 verdict holds at SA(1.0) WLG RP475.
//   Sanity S1: official fractile ordering — at a FIXED IM the low-fractile
//     curve has a LOWER exceedance rate: rate_P10 <= rate_mean <= rate_P90
//     (hence IM_P10 <= IM_mean <= IM_P90); all inversions positive/finite.
//
// Gates: NONE — measurement only. NO calibration, NO pack change. The
// official 2023-era tree is far larger than our 5-branch approximation; the
// finding quantifies that structural difference, it does not prescribe a fix.
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
const QUANT = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-quantiles.json');
const OUT = path.join(ROOT, 'tools', 'data', 'nz-epistemic-width-report.json');

const RPS = [475, 2500];
const G_TO_GAL = 980.665; // official quantile curves are in g (R8-2b lesson) — convert to gal at load
const OFFICIAL_IMT = { pga: 'PGA', sa10: 'SA(1.0)' };
const OUR_IMT = { pga: 'pga', sa10: 'sa:1.0' };

function main() {
  const frozen = JSON.parse(fs.readFileSync(QUANT, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-newzealand.json'), 'utf8'));

  // sanity S1: fractile ordering
  const byKey = {};
  for (const c of frozen.curves) byKey[c.loc + '|' + c.imt + '|' + c.agg] = c;
  for (const s of frozen.requestedSites) {
    const hit = frozen.locations.find((l) => l.name === s.name || l.code === s.code);
    for (const imt of ['PGA', 'SA(1.0)']) {
      const p10 = byKey[hit.code + '|' + imt + '|0.1'];
      const mean = byKey[hit.code + '|' + imt + '|mean'];
      const p90 = byKey[hit.code + '|' + imt + '|0.9'];
      if (!p10 || !mean || !p90) throw new Error('fractile curve missing ' + s.code + ' ' + imt);
      for (let i = 0; i < mean.curve.levels.length; i++) {
        if (!(mean.curve.values[i] >= p10.curve.values[i] - 1e-15)) throw new Error('mean below P10 ' + s.code + ' ' + imt + ' @' + i);
        if (!(p90.curve.values[i] >= mean.curve.values[i] - 1e-15)) throw new Error('P90 below mean ' + s.code + ' ' + imt + ' @' + i);
      }
    }
  }

  const widths = {};
  const report = {
    schema: 'quake-sim-nz-epistemic-width-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-nz-epistemic-width.js header (frozen 2026-11-16, before first successful run)',
    official: { endpoint: frozen.endpoint, hazardModel: frozen.hazardModel, aggregates: frozen.aggregates, vs30: frozen.vs30 },
    metric: 'IM-space epistemic width: official log10(IM_P90/IM_P10) vs our log10(single-branch-collapse max/min) at RP-im',
    conservatism: 'our per-branch min/max BOUNDS are wider than any P10-P90 band for the same tree — narrower bounds imply understatement a fortiori',
    engineNote: 'hazardCurve ensemble sets only accumulate branch indices < 3 (v6.1-era design) — registered as a future engine-fix candidate, not changed in this measurement-only batch',
    sites: {},
    widths: widths,
    note: 'MEASUREMENT ONLY — no calibration, no pack change; quantifies the structural gap between our 5-branch approximation and the official epistemic tree',
  };

  for (const s of frozen.requestedSites) {
    const hit = frozen.locations.find((l) => l.name === s.name || l.code === s.code);
    const m = /^(-?\d+\.?\d*)~(-?\d+\.?\d*)$/.exec(hit.code);
    const st = { lat: +m[1], lng: +m[2], vs30: frozen.vs30 };
    const site = { officialKey: hit.code, official: {}, ours: {}, branchLabels: pack.gmpeTree.crustal.map((b) => b.model + (b.variant ? ':' + b.variant : '')) };
    for (const tag of ['pga', 'sa10']) {
      const hz = Physics.hazardCurve(pack, st, OUR_IMT[tag], { years: 50 });
      const hMean = {
        475: Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 475),
        2500: Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 2500),
      };
      // per-branch collapse arms (crustal tree, one branch at weight 1)
      const branchIms = { 475: [], 2500: [] };
      for (const b of pack.gmpeTree.crustal) {
        const p1 = JSON.parse(JSON.stringify(pack));
        p1.gmpeTree = JSON.parse(JSON.stringify(p1.gmpeTree));
        p1.gmpeTree.crustal = [JSON.parse(JSON.stringify(b))];
        p1.gmpeTree.crustal[0].weight = 1;
        const h1 = Physics.hazardCurve(p1, st, OUR_IMT[tag], { years: 50 });
        branchIms[475].push(Physics._pshaInvertCurve(h1.imLevels, h1.meanRate, 1 / 475));
        branchIms[2500].push(Physics._pshaInvertCurve(h1.imLevels, h1.meanRate, 1 / 2500));
      }
      site.branchImsGal = { rp475: branchIms[475].map((v) => +v.toPrecision(6)), rp2500: branchIms[2500].map((v) => +v.toPrecision(6)) };
      site.official[tag] = {}; site.ours[tag] = {};
      for (const rp of RPS) {
        const imts = {};
        for (const [aggKey, agg] of [['p10', '0.1'], ['mean', 'mean'], ['p90', '0.9']]) {
          const c = byKey[hit.code + '|' + OFFICIAL_IMT[tag] + '|' + agg];
          const offGal = c.curve.levels.map((l) => l * G_TO_GAL);
          imts[aggKey] = Physics._pshaInvertCurve(offGal, c.curve.values.slice(), 1 / rp);
        }
        if (!(imts.p10 > 0) || !(imts.mean > 0) || !(imts.p90 > 0)) throw new Error('bad inversion ' + s.code + ' ' + tag + ' rp' + rp);
        const viable = branchIms[rp].filter((v) => v > 0);
        const oursMin = Math.min.apply(null, viable);
        const oursMax = Math.max.apply(null, viable);
        site.official[tag]['rp' + rp] = {
          imP10: +imts.p10.toPrecision(6), imMean: +imts.mean.toPrecision(6), imP90: +imts.p90.toPrecision(6),
          width: +Math.log10(imts.p90 / imts.p10).toPrecision(6),
        };
        site.ours[tag]['rp' + rp] = {
          imMin: +oursMin.toPrecision(6), imMax: +oursMax.toPrecision(6),
          ourMeanIm: +hMean[rp].toPrecision(6), offMeanIm: +imts.mean.toPrecision(6),
          width: +Math.log10(oursMax / oursMin).toPrecision(6),
        };
        widths[s.code + '|' + tag + '|rp' + rp] = {
          off: site.official[tag]['rp' + rp].width,
          ours: site.ours[tag]['rp' + rp].width,
          meanRatio: +(hMean[rp] / imts.mean).toPrecision(6),
        };
      }
    }
    report.sites[s.code] = site;
  }

  const w = (k) => widths[k];
  report.hypotheses = {
    H1_understated_spread_wlg_pga_rp475: w('WLG|pga|rp475').ours < w('WLG|pga|rp475').off,
    H2_central_containment_wlg_pga_rp475: report.sites.WLG.ours.pga.rp475.ourMeanIm >= report.sites.WLG.official.pga.rp475.imP10
      && report.sites.WLG.ours.pga.rp475.ourMeanIm <= report.sites.WLG.official.pga.rp475.imP90,
    H3_broadband_sa10: w('WLG|sa10|rp475').ours < w('WLG|sa10|rp475').off,
  };
  report.findings = [
    'width comparison at RP475 PGA (ours log10 max/min vs official log10 P90/P10): ' +
      frozen.requestedSites.map((s) => s.code + ' ' + w(s.code + '|pga|rp475').ours.toFixed(3) + '/' + w(s.code + '|pga|rp475').off.toFixed(3)).join(', '),
    'our mean vs official mean at WLG RP475 PGA: ratio ' + w('WLG|pga|rp475').meanRatio.toFixed(3) +
      '; official band [P10 ' + report.sites.WLG.official.pga.rp475.imP10.toFixed(1) + ' .. P90 ' + report.sites.WLG.official.pga.rp475.imP90.toFixed(1) + ' gal] vs our mean ' + report.sites.WLG.ours.pga.rp475.ourMeanIm.toFixed(1) + ' gal',
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
