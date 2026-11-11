#!/usr/bin/env node
'use strict';
// tools/scorecard-nz-chc-attribution.js — R8-2b follow-up: attribute the
// Christchurch OVERestimate found by the NZ NSHM external gate (rp475 PGA
// ratio 1.978x, tools/data/nz-nshm-comparison-report.json).
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-10, BEFORE the first attribution run)
// ============================================================================
// Hypothesis: the 2010-2011 Canterbury sequence (Darfield M7.0 + Christchurch
// M6.3 + aftershocks, 25 M>=5 events post 2009-09-04 inside the box below)
// inflates the shipped pack's ComCat-window declustered rates around
// Christchurch — the official NZ NSHM's fault-source model does not carry
// that swarm at the same escalated rate, hence our overestimate.
//
// Variant build (NOT shipped, .cache only): the shipped NZ catalog with
//   every M>=5 event REMOVED that satisfies
//     lat in [-44.0, -43.0], lng in [171.4, 173.3], time >= 2009-09-04T00:00Z
//   (preregistered box = Darfield-Christchurch aftershock zone + margin).
//   The FULL builder pipeline re-runs on the filtered catalog (declustering,
//   completeness scan, b-values, smoothing, mass renormalisation) — the
//   variant's own chosen Mc/window is recorded from its build report.
//   Build: tools/build-psha-source-model.js --region=newzealand --catalog=...
//     --out=... --report-out=... (defaults byte-identical when absent).
//
// Metric: per-site PGA RP475/RP2500 ours/official ratios on the VARIANT pack
// (same official frozen curves, same snapped sites, vs30 600), delta vs the
// shipped-gate ratios frozen in tools/data/nz-nshm-comparison-report.json.
//
// Gates (frozen):
//   G1 (direction): CHC rp475 ratio DECREASES.
//   G2 (attribution sufficient): new CHC rp475 ratio lands in [0.7, 1.3].
//   G3 (specificity): WLG rp475 ratio within 0.453 +/- 0.02 (absolute) AND
//     AKL and IVC rp475 ratios within their shipped values +/- 0.05 — the
//     edit must be local, not a global rate shift.
// Verdicts are recorded; NO calibration and NO pack change either way
// (measurement only). If G2 fails, the attribution is INSUFFICIENT and the
// residual is frozen honestly for future work.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'tools', 'data', 'psha', 'comcat-newzealand.json');
const OFFICIAL = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-curves.json');
const SHIPPED_GATE = path.join(ROOT, 'tools', 'data', 'nz-nshm-comparison-report.json');
const OUT = path.join(ROOT, 'tools', 'data', 'nz-chc-attribution-report.json');
const WORK = path.join(ROOT, '.cache', 'nz-chc-variant');

const BOX = { minLat: -44.0, maxLat: -43.0, minLng: 171.4, maxLng: 173.3 };
const CUTOFF_ISO = '2009-09-04T00:00:00.000Z';
const CUTOFF_MS = Date.parse(CUTOFF_ISO);
const G_TO_GAL = 980.665;
const RPS = [475, 2500];

function main() {
  const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const keep = [], removed = [];
  for (const ev of cat.events) {
    const inBox = ev.lat >= BOX.minLat && ev.lat <= BOX.maxLat && ev.lng >= BOX.minLng && ev.lng <= BOX.maxLng;
    const ts = ev.tsMs != null ? ev.tsMs : Date.parse(ev.time);
    if (inBox && ts >= CUTOFF_MS) removed.push(ev); else keep.push(ev);
  }
  // sanity: the removed set must be the Canterbury post-Darfield sequence
  if (removed.length !== 25 || Math.max(...removed.map((e) => e.mag)) < 6.9) {
    throw new Error('removed set shape changed: n=' + removed.length + ' maxM=' + Math.max(...removed.map((e) => e.mag)));
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const varCatalog = path.join(WORK, 'comcat-newzealand-chc-variant.json');
  fs.writeFileSync(varCatalog, JSON.stringify(Object.assign({}, cat, {
    generatedAt: new Date().toISOString(), count: keep.length,
    note: 'CHC-attribution variant (preregistered): post-2009-09-04 Canterbury-box M>=5 events removed',
    events: keep,
  })));

  const varPackPath = path.join(WORK, 'psha-source-model-newzealand-variant.json');
  const varReportPath = path.join(WORK, 'build-report-variant.json');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-psha-source-model.js'),
    '--region=newzealand',
    '--catalog=' + path.relative(ROOT, varCatalog).split(path.sep).join('/'),
    '--out=' + path.relative(ROOT, varPackPath).split(path.sep).join('/'),
    '--report-out=' + path.relative(ROOT, varReportPath).split(path.sep).join('/')],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  const variant = JSON.parse(fs.readFileSync(varPackPath, 'utf8'));
  const varBuildReport = JSON.parse(fs.readFileSync(varReportPath, 'utf8'));

  const official = JSON.parse(fs.readFileSync(OFFICIAL, 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(SHIPPED_GATE, 'utf8'));
  const byKey = {};
  for (const c of official.curves) byKey[c.loc + '|' + c.imt] = c;

  const sites = {};
  const ratios = {};
  for (const s of official.requestedSites) {
    const hit = official.locations.find((l) => l.name === s.name);
    const m = /^(-?\d+\.?\d*)~(-?\d+\.?\d*)$/.exec(hit.code);
    const st = { lat: +m[1], lng: +m[2], vs30: official.vs30 };
    const hz = Physics.hazardCurve(variant, st, 'pga', { years: 50 });
    const site = { variant: {}, ratio: {}, shippedRatio: shipped.sites[s.code].ratio.pga, delta: {} };
    for (const rp of RPS) {
      const off = byKey[hit.code + '|PGA'];
      const offGal = off.curve.levels.map((l) => l * G_TO_GAL);
      const o = Physics._pshaInvertCurve(offGal, off.curve.values, 1 / rp);
      const u = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / rp);
      const r = u / o;
      site.variant['rp' + rp] = +u.toPrecision(6);
      site.ratio['rp' + rp] = +r.toPrecision(6);
      site.delta['rp' + rp] = +(r - shipped.sites[s.code].ratio.pga['rp' + rp]).toPrecision(6);
      ratios[s.code + '|rp' + rp] = r;
    }
    sites[s.code] = site;
  }

  const report = {
    schema: 'quake-sim-nz-chc-attribution-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-nz-chc-attribution.js header (frozen 2026-11-10, before first run)',
    removed: {
      n: removed.length, cutoffIso: CUTOFF_ISO, box: BOX,
      magRange: [Math.min(...removed.map((e) => e.mag)), Math.max(...removed.map((e) => e.mag))],
      dateRange: [removed.map((e) => e.time).sort()[0], removed.map((e) => e.time).sort().pop()],
    },
    variantBuild: {
      completeness: varBuildReport.completeness ? { chosen: varBuildReport.completeness.chosen, rule: varBuildReport.completeness.rule } : null,
      cells: variant.cells.length, bValues: { crustal: variant.bValues.crustal, interplate: variant.bValues.interplate, intraslab: variant.bValues.intraslab },
    },
    gates: {
      G1_chc_direction: ratios['CHC|rp475'] < shipped.sites.CHC.ratio.pga.rp475,
      G2_chc_attribution_sufficient: ratios['CHC|rp475'] >= 0.7 && ratios['CHC|rp475'] <= 1.3,
      G3_specificity_wlg: Math.abs(ratios['WLG|rp475'] - shipped.sites.WLG.ratio.pga.rp475) <= 0.02,
      G3_specificity_akl_ivc: Math.abs(ratios['AKL|rp475'] - shipped.sites.AKL.ratio.pga.rp475) <= 0.05
        && Math.abs(ratios['IVC|rp475'] - shipped.sites.IVC.ratio.pga.rp475) <= 0.05,
    },
    sites: sites,
    note: 'MEASUREMENT ONLY — variant pack stays in .cache, shipped pack byte-unchanged; verdicts recorded, nothing retuned',
  };

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
