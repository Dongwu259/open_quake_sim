#!/usr/bin/env node
'use strict';
// tools/scorecard-usgs-nshm-uhs.js — R8-2f: the California mean-gap's
// SPECTRAL DIMENSION. The v7.1 attribution (scorecard-usgs-nshm-attribute.js)
// placed the RP475 PGA gap in GMM vintage with a near-uniform rate factor
// k = 0.435/0.445 (LA/SF); this measurement asks whether that uniform-rate
// story holds across the whole uniform-hazard period grid, or whether a
// spectral-shape (attenuation/SA-vintage) component hides inside the mean gap.
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-16, BEFORE the first scoring run)
// ============================================================================
// Known anchors (declared upfront, from the frozen v7.1 report): the RP475
// PGA ratios are LA 1.395 / SF 1.351 and |log10 ratio(SA1P0) − log10 ratio(PGA)|
// <= 0.03 dex at both cities. Everything below concerns the UNSEEN periods
// 0.1/0.2/0.5/2.0/3.0/5.0 s.
//
// Set (frozen): LA (34.05, -118.24), SF (37.7749, -122.4194); siteClass BC =
// 760 m/s both sides; RP = 475 only; periods = the shipped UHS grid
// {0.10, 0.20, 0.50, 1.00, 2.00, 3.00, 5.00} s + the PGA anchor; official =
// static (as-published) 2023.R2 curves fetched to
// tools/data/usgsnshm/nshm-conus-2023r2-uhs-curves.json (data acquisition
// preceded hypothesis freeze; the two-IMT v7.1 artifact is untouched).
//
// Metric: RP475 inversion via Physics._pshaInvertCurve on BOTH sides;
// official levels converted g -> gal x980.665 at load; ours = Physics.uhs on
// the byte-frozen california pack at vs30 760. ratio(T) = ours/official.
//
// Hypotheses (frozen):
//   H1 (pure-rate persistence): per city, max − min of log10 ratio(T) over
//     the full set {PGA ∪ 0.1..5.0 s} <= 0.15 dex. A uniform rate factor
//     multiplies every period equally (spread exactly 0); the 0.15 dex band
//     is the declared a-priori tolerance, anchored on the pack's own GMM
//     epistemic spread measured in R8-2c (collapse arms 1.250-1.591 ≈ 0.104
//     dex) — drift beyond that would mean a period-dependent GMM vintage
//     difference, not a rate story.
//   H2 (spectral-shape agreement): per city/period, |log10(ours(T)/ours(PGA))
//     − log10(official(T)/official(PGA))| <= 0.10 dex — the UHS SHAPE
//     (level removed) agrees; shape disagreement would locate a spectral
//     component in the gap independent of the rate factor.
//   H3 (anchor drift): per city/period, |log10 ratio(T) − log10 ratio(PGA)|
//     <= 0.15 dex — no period drifts from the KNOWN v7.1 anchor by more than
//     the H1 band.
//   Sanity S1: ys finite and non-increasing (an exact-zero TAIL at the
//   lowest-probability end is legitimate — the static service reports zeros
//   there; amendment 2026-11-16 before any successful run, the first run
//   errored on this at LA/SA2P0 without freezing anything); levels positive;
//   RP475 inversion succeeds on both sides at every period (the positivity
//   that matters — target reachability).
//
// Gates: NONE — measurement only. NO calibration, NO pack change, NO anchor
// change. A falsified H2/H1 would REGISTER a spectral-vintage component in
// the report; the uniform-rate-factor attribution of v7.1 would then need
// the report-level caveat (documented, not re-fitted).
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
const CURVES = path.join(ROOT, 'tools', 'data', 'usgsnshm', 'nshm-conus-2023r2-uhs-curves.json');
const OUT = path.join(ROOT, 'tools', 'data', 'usgs-nshm-uhs-spectral-report.json');

const G_TO_GAL = 980.665;
const VS30 = 760; // BC boundary class, both sides
const RP = 475;
const PERIODS = ['0.10', '0.20', '0.50', '1.00', '2.00', '3.00', '5.00'];
const OFFICIAL_IMT = { PGA: 'PGA', '0.10': 'SA0P1', '0.20': 'SA0P2', '0.50': 'SA0P5', '1.00': 'SA1P0', '2.00': 'SA2P0', '3.00': 'SA3P0', '5.00': 'SA5P0' };

function invertRp475(levelsGal, rates) {
  return Physics._pshaInvertCurve(levelsGal, rates, 1 / RP);
}

function main() {
  const frozen = JSON.parse(fs.readFileSync(CURVES, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-california.json'), 'utf8'));

  const official = {};
  for (const c of frozen.curves) {
    const levelsGal = c.levelsG.map((g) => g * G_TO_GAL);
    for (let i = 1; i < c.rates.length; i++) {
      if (!(c.rates[i] <= c.rates[i - 1])) throw new Error('official ys not non-increasing: ' + c.site + '/' + c.imt + ' @' + i);
      if (!(c.rates[i] >= 0) || !isFinite(c.rates[i]) || !(levelsGal[i] > 0)) throw new Error('non-finite curve value: ' + c.site + '/' + c.imt + ' @' + i);
    }
    const im475 = invertRp475(levelsGal, c.rates);
    if (!(im475 > 0)) throw new Error('official RP475 inversion failed: ' + c.site + '/' + c.imt);
    official[c.site + '|' + c.imt] = im475;
  }

  const ours = {};
  for (const s of frozen.sites) {
    const site = { lat: s.lat, lng: s.lng, vs30: VS30 };
    const u = Physics.uhs(pack, site, [RP], { periods: PERIODS, years: 50 });
    if (!(u.pga[String(RP)] > 0)) throw new Error('our PGA RP475 inversion failed: ' + s.code);
    ours[s.code + '|PGA'] = u.pga[String(RP)];
    u.periodsSec.forEach((p, i) => {
      const v = u.uhs[String(RP)][i];
      if (!(v > 0)) throw new Error('our UHS RP475 inversion failed: ' + s.code + ' @' + p);
      ours[s.code + '|' + p.toFixed(2)] = v;
    });
  }

  const periodKeys = ['PGA', '0.10', '0.20', '0.50', '1.00', '2.00', '3.00', '5.00'];
  const sites = {};
  let h1 = true, h2 = true, h3 = true;
  for (const s of frozen.sites) {
    const ratios = {}, shapes = {}, drift = {};
    let spread = 0;
    for (const pk of periodKeys) {
      const o = ours[s.code + '|' + pk], f = official[s.code + '|' + OFFICIAL_IMT[pk]];
      ratios[pk] = +(o / f).toPrecision(6);
      const dex = Math.log10(o / f);
      if (Math.abs(dex) > spread) spread = Math.abs(dex);
      drift[pk] = +(dex - Math.log10(ratios.PGA)).toPrecision(6);
      shapes[pk] = +(Math.log10(o / ours[s.code + '|PGA']) - Math.log10(f / official[s.code + '|PGA'])).toPrecision(6);
    }
    // H1 spread: max-min across the whole set (dex)
    const allDex = periodKeys.map((pk) => Math.log10(ratios[pk]));
    const spreadDex = +(Math.max.apply(null, allDex) - Math.min.apply(null, allDex)).toPrecision(6);
    const h1City = spreadDex <= 0.15;
    const h2City = periodKeys.every((pk) => Math.abs(shapes[pk]) <= 0.10);
    const h3City = periodKeys.every((pk) => Math.abs(drift[pk]) <= 0.15);
    if (!h1City) h1 = false;
    if (!h2City) h2 = false;
    if (!h3City) h3 = false;
    sites[s.code] = {
      name: s.name, lat: s.lat, lng: s.lng,
      ratioByPeriod: ratios, ratioSpreadDex: spreadDex,
      shapeDiffDexByPeriod: shapes, driftDexByPeriod: drift,
      oursGalByPeriod: periodKeys.reduce((acc, pk) => { acc[pk] = +ours[s.code + '|' + pk].toPrecision(8); return acc; }, {}),
      officialGalByPeriod: periodKeys.reduce((acc, pk) => { acc[pk] = +official[s.code + '|' + OFFICIAL_IMT[pk]].toPrecision(8); return acc; }, {}),
      hypotheses: { H1_spread_le_0p15: h1City, H2_shape_le_0p10: h2City, H3_drift_le_0p15: h3City },
    };
  }

  const report = {
    schema: 'quake-sim-usgs-nshm-uhs-spectral-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-usgs-nshm-uhs.js header (frozen 2026-11-16, before first run; known v7.1 anchors declared)',
    officialArtifact: 'tools/data/usgsnshm/nshm-conus-2023r2-uhs-curves.json',
    officialShaNote: 'fetched ' + frozen.fetchedAt.slice(0, 10) + ', sha256 ' + require('crypto').createHash('sha256').update(fs.readFileSync(CURVES)).digest('hex').slice(0, 12),
    rp: RP, vs30: VS30, periods: periodKeys,
    hypotheses: {
      H1_pureRate_spread_le_0p15dex: h1,
      H2_spectralShape_le_0p10dex: h2,
      H3_anchorDrift_le_0p15dex: h3,
    },
    sites: sites,
    note: 'MEASUREMENT ONLY — the pack is byte-frozen (tests/psha-region style sha invariant in tests/usgs-nshm-uhs.test.js); no calibration, no anchor change',
  };
  report.findings = [
    'ratio spread across {PGA ∪ 0.1-5.0 s}: LA ' + sites.LA.ratioSpreadDex.toFixed(3) + ' dex / SF ' + sites.SF.ratioSpreadDex.toFixed(3) + ' dex (H1 gate 0.15) — ' + (h1 ? 'the v7.1 uniform-rate-factor story persists across the UHS grid' : 'a period-dependent component exists beyond the declared band'),
    'spectral-shape agreement (level removed): max |shape diff| LA ' + Math.max.apply(null, periodKeys.map((p) => Math.abs(sites.LA.shapeDiffDexByPeriod[p]))).toFixed(3) + ' dex / SF ' + Math.max.apply(null, periodKeys.map((p) => Math.abs(sites.SF.shapeDiffDexByPeriod[p]))).toFixed(3) + ' dex (H2 gate 0.10)',
    'anchor drift: max |drift| LA ' + Math.max.apply(null, periodKeys.map((p) => Math.abs(sites.LA.driftDexByPeriod[p]))).toFixed(3) + ' dex / SF ' + Math.max.apply(null, periodKeys.map((p) => Math.abs(sites.SF.driftDexByPeriod[p]))).toFixed(3) + ' dex (H3 gate 0.15)',
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
