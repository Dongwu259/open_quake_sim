#!/usr/bin/env node
'use strict';
// tools/scorecard-usgs-nshm.js — R8-2c: California external absolute gate
// against the official USGS NSHM 2023.R2 (the R8-2b NZ template, second
// regional pack).
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-12, BEFORE the first scoring run)
// ============================================================================
// Question: how far is the shipped california pack's absolute hazard level
// from the official current national model? The pack is UCERF3-derived
// (branch-averaged closed budget, FM3.1/FM3.2 0.5/0.5) plus the ComCat GR
// apron; the official 2023 NSHM carries updated fault rates, the new M9
// Cascadia composite, and revised smoothed seismicity. This measurement
// quantifies the gap (Japan precedent R8; NZ precedent R8-2b).
//
// Set (frozen): Los Angeles (34.05, -118.24) and San Francisco (37.7749,
// -122.4194); siteClass BC = 760 m/s applied on BOTH sides (our pack is
// evaluated at vs30 760 via the same hazardCurve engine — the letter-class
// vs30 midpoint mapping question is sidestepped entirely); IMTs PGA and
// SA(1.0); RPs 475/2500; official = static (as-published) 2023.R2 curves.
//
// Metric: RP-im inversion via Physics._pshaInvertCurve on BOTH sides;
// official levels are in g — converted x980.665 to gal at load (NZ lesson);
// ratio = ours/official per site/IMT/RP.
//
// Hypotheses (frozen):
//   H1 (UCERF3 lineage): |log10 ratio(LA RP475 PGA)| < 0.3 — the pack's
//     central estimate and the official 2023 central estimate both descend
//     from UCERF3 fault rates, so >x2 divergence at LA would be surprising.
//   H2 (systematic): the SF RP475 PGA ratio has the same sign as LA's
//     (deviations are model-form, not site-specific artifacts).
//   H3 (broadband): |log10 ratio(SA1P0 RP475) - log10 ratio(PGA RP475)|
//     <= 0.15 per site (the gap is broadband, not a spectral-shape artifact).
//   Sanity S1: all curves positive/finite; official ys non-increasing;
//   RP475 <= RP2500 on both sides at every site/IMT.
//
// Gates: NONE — measurement only. NO calibration, NO pack change, NO anchor
// change. Findings land in the report + provenance notes. The comparison is
// a STRUCTURAL gap (source-model form + vintage), documented as such.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const CURVES = path.join(ROOT, 'tools', 'data', 'usgsnshm', 'nshm-conus-2023r2-curves.json');
const OUT = path.join(ROOT, 'tools', 'data', 'usgs-nshm-comparison-report.json');

const RPS = [475, 2500];
const G_TO_GAL = 980.665;
const VS30 = 760; // BC boundary class, both sides

const OFFICIAL_IMT = { pga: 'PGA', sa10: 'SA1P0' };
const OUR_IMT = { pga: 'pga', sa10: 'sa:1.0' };

function main() {
  const frozen = JSON.parse(fs.readFileSync(CURVES, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-california.json'), 'utf8'));

  // sanity S1 on official curves
  for (const c of frozen.curves) {
    const { levelsG, rates } = c;
    if (levelsG.length !== rates.length || !levelsG.length) throw new Error('curve shape ' + c.site);
    for (let i = 0; i < levelsG.length; i++) {
      if (!(levelsG[i] > 0) || !isFinite(rates[i]) || rates[i] < 0) throw new Error('bad point ' + c.site + ' ' + c.imt);
      if (i && rates[i] > rates[i - 1] + 1e-15) throw new Error('non-monotone ' + c.site + ' ' + c.imt + ' @' + i);
    }
  }
  const byKey = {};
  for (const c of frozen.curves) byKey[c.site + '|' + c.imt] = c;

  const report = {
    schema: 'quake-sim-usgs-nshm-comparison-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-usgs-nshm.js header (frozen 2026-11-12, before first scoring run)',
    official: {
      endpoint: frozen.endpoint, edition: frozen.edition, siteClass: frozen.siteClass,
      fetchedAt: frozen.fetchedAt,
    },
    metric: 'ours/official RP-im ratio (PGA + SA(1.0), RP475/RP2500), identical inversion both sides, BC 760 m/s both sides',
    sites: {},
    note: 'MEASUREMENT ONLY — no calibration, no pack change; structural (source-model form + vintage) gap vs the official current model, NOT a GMPE validation',
  };

  const ratios = {};
  for (const s of frozen.sites) {
    const st = { lat: s.lat, lng: s.lng, vs30: VS30 };
    const site = { name: s.name, official: {}, ours: {}, ratio: {} };
    for (const tag of ['pga', 'sa10']) {
      const off = byKey[s.code + '|' + OFFICIAL_IMT[tag]];
      if (!off) throw new Error('official curve missing ' + s.code + ' ' + tag);
      const hz = Physics.hazardCurve(pack, st, OUR_IMT[tag], { years: 50 });
      site.official[tag] = {}; site.ours[tag] = {}; site.ratio[tag] = {};
      for (const rp of RPS) {
        const offGal = off.levelsG.map((l) => l * G_TO_GAL);
        const o = Physics._pshaInvertCurve(offGal, off.rates, 1 / rp);
        const u = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / rp);
        if (!(o > 0) || !(u > 0)) throw new Error('nonpositive RP ' + s.code + ' ' + tag + ' rp' + rp);
        site.official[tag]['rp' + rp] = +o.toPrecision(6);
        site.ours[tag]['rp' + rp] = +u.toPrecision(6);
        site.ratio[tag]['rp' + rp] = +(u / o).toPrecision(6);
        ratios[s.code + '|' + tag + '|rp' + rp] = u / o;
      }
    }
    report.sites[s.code] = site;
  }

  const lg = (x) => Math.log10(x);
  report.hypotheses = {
    H1_ucerf3_lineage_LA_pga_rp475: Math.abs(lg(ratios['LA|pga|rp475'])) < 0.3,
    H2_systematic_same_sign: Math.sign(lg(ratios['SF|pga|rp475'])) === Math.sign(lg(ratios['LA|pga|rp475'])),
    H3_broadband_LA: Math.abs(lg(ratios['LA|sa10|rp475']) - lg(ratios['LA|pga|rp475'])) <= 0.15,
    H3_broadband_SF: Math.abs(lg(ratios['SF|sa10|rp475']) - lg(ratios['SF|pga|rp475'])) <= 0.15,
  };
  report.findings = [
    'LA RP475 PGA ratio ' + ratios['LA|pga|rp475'].toFixed(3) + '; SF ' + ratios['SF|pga|rp475'].toFixed(3) +
      ' — the shipped UCERF3-derived pack vs the official 2023 NSHM at the BC reference class',
    'SA(1.0) vs PGA ratio gap: LA ' + (lg(ratios['LA|sa10|rp475']) - lg(ratios['LA|pga|rp475'])).toFixed(3) +
      ' dex; SF ' + (lg(ratios['SF|sa10|rp475']) - lg(ratios['SF|pga|rp475'])).toFixed(3) + ' dex',
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
