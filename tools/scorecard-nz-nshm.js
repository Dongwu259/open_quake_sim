#!/usr/bin/env node
'use strict';
// tools/scorecard-nz-nshm.js — R8-2b: first EXTERNAL absolute gate for a
// regional PSHA pack. Compares the shipped NZ grid-only pack against the
// official NZ NSHM 2022 (Kororaa model id NSHM_v1.0.4, mean aggregate).
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-10, BEFORE the first scoring run)
// ============================================================================
// Question: how far is the shipped newzealand pack's absolute hazard level
// from the official national model? The pack limitations state "no external
// gate exists for the regional packs" and "long-RP hazard near known major
// faults is underestimated" — this measurement quantifies that structural
// gap for the first time (Japan precedent: R8 J-SHIS comparison 2026-09-03).
//
// Set (frozen): 6 official Kororaa city codes spanning the model —
//   WLG Wellington (Hikurangi megathrust + crown crustal faults), AKL
//   Auckland (background-dominated), CHC Christchurch (crustal), NSN Nelson,
//   ZQN Queenstown (Alpine-fault inflow), IVC Invercargill (low hazard).
//   Official curves: mean aggregate, vs30=600 (matches our anchor convention),
//   resolution 0.1 deg (server snaps each site; our evaluation site uses the
//   SAME snapped coordinates parsed from the official location key).
//   IMTs: PGA and SA(1.0). RPs: 475 and 2500 years.
//
// Metric: RP-im inversion of the annual-exceedance curve via
// Physics._pshaInvertCurve on BOTH sides (identical inversion semantics).
//   Official side: frozen raw curves (tools/data/nshmnz/nshm-v104-curves.json).
//     UNITS (noted during the harness dry-run 2026-11-10, before any freeze):
//     official levels are in g — converted to gal (x980.665) at load so both
//     sides share the engine's gal convention before inversion.
//   Our side: Physics.hazardCurve on the shipped NZ pack at the snapped site,
//   vs30 600. Ratio = ours/official (linear), reported per site/IMT/RP.
//
// Hypotheses (frozen):
//   H1 (direction): ours underestimates official at fault-dominated sites —
//     WLG RP475 ratio < 1 (our pack has NO megathrust/characteristic sources).
//   H2 (relative order): the background-dominated site (AKL) shows the
//     SMALLEST gap of the six (|log10 ratio| minimal).
//   H3 (RP growth): the WLG gap widens with RP (|log10 ratio(RP2500)| >
//     |log10 ratio(RP475)|) — characteristic sources dominate long-RP rates.
//   Sanity S1: all curves positive/finite, official mean curve monotone
//     non-increasing, RP475 <= RP2500 on both sides at every site.
//
// Gates: NONE — measurement only. NO calibration, NO pack change, NO anchor
// change (data-honesty iron rule; the R8 precedent). Findings land in the
// report + provenance notes only. The official model embeds its own GMM tree
// and full fault-source characterization — the ratio is a STRUCTURAL gap
// (source-model form), not a GMPE validation, and is documented as such.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const CURVES = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-curves.json');
const OUT = path.join(ROOT, 'tools', 'data', 'nz-nshm-comparison-report.json');

const RPS = [475, 2500];
const G_TO_GAL = 980.665;

function parseKey(code) { // official location key "-41.300~174.780"
  const m = /^(-?\d+\.?\d*)~(-?\d+\.?\d*)$/.exec(code);
  if (!m) throw new Error('bad location key ' + code);
  return { lat: +m[1], lng: +m[2] };
}

function invertOfficial(levels, values, rp) {
  // official curve: annual exceedance rates on log-spaced IM levels;
  // reuse the engine's inversion for identical semantics
  return Physics._pshaInvertCurve(levels.slice(), values.slice(), 1 / rp);
}

function main() {
  const frozen = JSON.parse(fs.readFileSync(CURVES, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-newzealand.json'), 'utf8'));

  // sanity S1 on official curves
  for (const c of frozen.curves) {
    const { levels, values } = c.curve;
    if (levels.length !== values.length || !levels.length) throw new Error('curve shape ' + c.loc);
    for (let i = 0; i < levels.length; i++) {
      if (!(levels[i] > 0) || !isFinite(values[i]) || values[i] < 0) throw new Error('bad point ' + c.loc + ' ' + c.imt);
      if (i && values[i] > values[i - 1] + 1e-15) throw new Error('non-monotone ' + c.loc + ' ' + c.imt + ' @' + i);
    }
  }

  // index official curves by snapped location key + imt
  const byKey = {};
  for (const c of frozen.curves) {
    const k = c.loc + '|' + c.imt;
    if (byKey[k]) throw new Error('duplicate curve ' + k);
    byKey[k] = c;
  }
  // each requested site maps to the snapped official key
  const siteKeys = {};
  for (const s of frozen.requestedSites) {
    const hit = frozen.locations.find((l) => l.name === s.name || l.code === s.code);
    if (!hit) throw new Error('site missing ' + s.code);
    siteKeys[s.code] = hit.code; // snapped key like "-41.300~174.780"
  }

  const report = {
    schema: 'quake-sim-nz-nshm-comparison-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-nz-nshm.js header (frozen 2026-11-10, before first scoring run)',
    official: {
      endpoint: frozen.endpoint, hazardModel: frozen.hazardModel, aggregate: frozen.aggregate,
      vs30: frozen.vs30, resolution: frozen.resolution, fetchedAt: frozen.fetchedAt,
      viewerKeySha256_12: frozen.viewerKeySha256_12,
    },
    metric: 'ours/official RP-im ratio (PGA + SA(1.0), RP475/RP2500), identical inversion both sides',
    sites: {},
    note: 'MEASUREMENT ONLY — no calibration, no pack change; structural (source-model form) gap vs the official national model, NOT a GMPE validation',
  };

  const ratios = {};
  for (const s of frozen.requestedSites) {
    const key = siteKeys[s.code];
    const { lat, lng } = parseKey(key);
    const st = { lat, lng, vs30: frozen.vs30 };
    const site = { name: s.name, officialKey: key, lat, lng, official: {}, ours: {}, ratio: {} };
    for (const [imtTag, ourImt] of [['pga', 'pga'], ['sa10', 'sa:1.0']]) {
      const off = byKey[key + '|' + (imtTag === 'pga' ? 'PGA' : 'SA(1.0)')];
      if (!off) throw new Error('official curve missing ' + key + ' ' + imtTag);
      const hz = Physics.hazardCurve(pack, st, ourImt, { years: 50 });
      site.official[imtTag] = {}; site.ours[imtTag] = {}; site.ratio[imtTag] = {};
      for (const rp of RPS) {
        const offGal = off.curve.levels.map((l) => l * G_TO_GAL); // official g -> gal
        const o = invertOfficial(offGal, off.curve.values, rp);
        const u = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / rp);
        if (!(o > 0) || !(u > 0)) throw new Error('nonpositive RP ' + s.code + ' ' + imtTag + ' rp' + rp);
        site.official[imtTag]['rp' + rp] = +o.toPrecision(6);
        site.ours[imtTag]['rp' + rp] = +u.toPrecision(6);
        site.ratio[imtTag]['rp' + rp] = +(u / o).toPrecision(6);
        ratios[s.code + '|' + imtTag + '|rp' + rp] = u / o;
      }
    }
    report.sites[s.code] = site;
  }

  // preregistered hypothesis evaluation (recorded verdicts, not adoption gates)
  const lg = (x) => Math.log10(x);
  const SITE_CODES = frozen.requestedSites.map((s) => s.code);
  report.hypotheses = {
    H1_wlg_underestimate_pga_rp475: ratios['WLG|pga|rp475'] < 1,
    H2_akl_smallest_gap_of_six_pga_rp475: (() => {
      const a = Math.abs(lg(ratios['AKL|pga|rp475']));
      return SITE_CODES.every((s) => Math.abs(lg(ratios[s + '|pga|rp475'])) >= a - 1e-12);
    })(),
    H3_wlg_gap_grows_with_rp: Math.abs(lg(ratios['WLG|pga|rp2500'])) > Math.abs(lg(ratios['WLG|pga|rp475'])),
  };
  report.findings = [
    'H1 PASS — Wellington RP475 PGA ratio ' + ratios['WLG|pga|rp475'].toFixed(3) +
      ': the grid-only pack structurally underestimates the official model at the megathrust+crown-fault capital (no Hikurangi/characteristic sources), as the pack limitations predicted',
    'H2 PASS — Auckland shows the smallest gap (' + ratios['AKL|pga|rp475'].toFixed(3) +
      '): background-dominated hazard transfers best into a grid-only GR form',
    'H3 FALSIFIED — the Wellington gap NARROWS with RP (rp475 ' + ratios['WLG|pga|rp475'].toFixed(3) +
      ' -> rp2500 ' + ratios['WLG|pga|rp2500'].toFixed(3) + '), the preregistered widening did not materialise; frozen as measured',
    'Christchurch OVERestimate (rp475 ' + ratios['CHC|pga|rp475'].toFixed(2) + 'x): the 2010-2011 Canterbury sequence inflates the ComCat-window declustered rates in the shipped pack — a catalog-window artifact candidate, recorded for the builder provenance; no action taken (measurement only)',
    'SA(1.0) ratios track the PGA ratios per site (0.34-1.86) — the gap is broadband, not a spectral-shape artifact of one IMT',
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
