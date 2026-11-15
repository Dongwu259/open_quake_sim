#!/usr/bin/env node
'use strict';
// tools/scorecard-usgs-nshm-attribute.js — R8-2c follow-up: attribute the
// California gap found by the external gate (LA 1.395x / SF 1.351x at RP475
// PGA, tools/data/usgs-nshm-comparison-report.json).
//
// ============================================================================
// PREREGISTRATION (frozen 2026-11-16, BEFORE the first attribution run)
// ============================================================================
// Question: which component of the shipped california pack carries the
// ~1.4x overestimate vs the official USGS NSHM 2023.R2? Arms decompose the
// pack along two axes — source composition and GMM choice:
//
// Source-composition arms (pack clones, engine-identical):
//   FULL       shipped pack as-is (baseline; must reproduce the frozen gate)
//   CHAR_ONLY  characteristicSources only (UCERF3 faults)
//   GRID_ONLY  gridMfdSources only (UCERF3 0.1-deg grid MFD nodes)
//   APRON_ONLY cells only (the self-computed ComCat GR apron outside RELM)
//   NO_APRON   characteristicSources + gridMfdSources (UCERF3 budget alone)
// GMM-collapse arms (FULL sources, crustal tree collapsed to ONE branch at
//   weight 1 — where does the official model sit relative to our own GMM
//   spread?): bssa14 base / cy14 base / cb14 base / cb14 HighQ / cb14 LowQ /
//   ask14. (2023.R2 embeds its own 2023-vintage GMMs we do not transcribe —
//   these arms bound OUR GMM spread, they do not reproduce the official GMM.)
// Rate-factor arm (derived, not a pack edit): k(site,imt,rp) = the uniform
//   source-rate factor that would match the official curve at that level,
//   k = r_official(X)/r_ours(X) where X = the official RP-im level (a uniform
//   rate scale shifts the mean curve vertically in log space).
//
// Metrics: ratio ours/official per arm/site/IMT(PGA,SA1.0)/RP(475,2500);
//   k factors at RP475.
//
// Hypotheses (frozen):
//   H1 (rate/form, not GMM choice): the official ratio at LA RP475 PGA sits
//     OUTSIDE [min,max] of the six GMM-collapse ratios (if inside, the gap
//     would be explainable by GMM choice within our own tree).
//   H2 (apron minor in RELM interior): APRON_ONLY hazard at LA and SF RP475
//     PGA is <10% of FULL (the ComCat apron cannot carry the gap there).
//   H3 (systematic): k(LA) and k(SF) at RP475 PGA agree within +/-10%
//     (a model-form/rate-vintage gap, not a site-specific artifact).
//   Sanity S1: FULL ratios reproduce the frozen gate report within 1e-6;
//     every arm curve positive/finite; official ys non-increasing.
//
// Gates: NONE — measurement only. NO calibration, NO pack change. Findings
// feed the report + provenance notes only.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const CURVES = path.join(ROOT, 'tools', 'data', 'usgsnshm', 'nshm-conus-2023r2-curves.json');
const GATE = path.join(ROOT, 'tools', 'data', 'usgs-nshm-comparison-report.json');
const OUT = path.join(ROOT, 'tools', 'data', 'usgs-nshm-attribution-report.json');

const RPS = [475, 2500];
const G_TO_GAL = 980.665;
const VS30 = 760; // BC boundary class, both sides (R8-2c convention)
const OFFICIAL_IMT = { pga: 'PGA', sa10: 'SA1P0' };
const OUR_IMT = { pga: 'pga', sa10: 'sa:1.0' };

function clonePack(pack) {
  return JSON.parse(JSON.stringify(pack));
}

function arms(pack) {
  const out = {};
  out.FULL = clonePack(pack);
  const charOnly = clonePack(pack); charOnly.cells = []; delete charOnly.gridMfdSources;
  out.CHAR_ONLY = charOnly;
  const gridOnly = clonePack(pack); gridOnly.cells = []; delete gridOnly.characteristicSources;
  out.GRID_ONLY = gridOnly;
  const apronOnly = clonePack(pack); apronOnly.cells = pack.cells.slice(); delete apronOnly.gridMfdSources; delete apronOnly.characteristicSources;
  out.APRON_ONLY = apronOnly;
  const noApron = clonePack(pack); noApron.cells = [];
  out.NO_APRON = noApron;
  for (const [label, branch] of Object.entries({
    GMM_bssa14: { model: 'bssa14', weight: 1, variant: 'base' },
    GMM_cy14: { model: 'cy14', weight: 1 },
    GMM_cb14_base: { model: 'cb14', weight: 1 },
    GMM_cb14_HighQ: { model: 'cb14', weight: 1, variant: 'HighQ' },
    GMM_cb14_LowQ: { model: 'cb14', weight: 1, variant: 'LowQ' },
    GMM_ask14: { model: 'ask14', weight: 1 },
  })) {
    const g = clonePack(pack);
    g.gmpeTree = JSON.parse(JSON.stringify(g.gmpeTree));
    g.gmpeTree.crustal = [JSON.parse(JSON.stringify(branch))];
    out[label] = g;
  }
  return out;
}

function main() {
  const frozen = JSON.parse(fs.readFileSync(CURVES, 'utf8'));
  const gate = JSON.parse(fs.readFileSync(GATE, 'utf8'));
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-california.json'), 'utf8'));

  for (const c of frozen.curves) {
    for (let i = 1; i < c.rates.length; i++) {
      if (c.rates[i] > c.rates[i - 1] + 1e-15) throw new Error('non-monotone ' + c.site + ' ' + c.imt);
    }
  }
  const byKey = {};
  for (const c of frozen.curves) byKey[c.site + '|' + c.imt] = c;

  const report = {
    schema: 'quake-sim-usgs-nshm-attribution-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/scorecard-usgs-nshm-attribute.js header (frozen 2026-11-16, before first run)',
    official: { endpoint: frozen.endpoint, edition: frozen.edition, siteClass: frozen.siteClass },
    metric: 'ratio ours/official per arm at RP-im; k = uniform source-rate factor matching official at the level',
    arms: {},
    rateFactorK: {},
    note: 'MEASUREMENT ONLY — no calibration, no pack change; the 2023 official GMMs are not transcribed, GMM arms bound OUR tree spread',
  };

  const armList = arms(pack);
  const ratios = {};
  for (const [armName, p] of Object.entries(armList)) {
    const armRes = {};
    for (const s of frozen.sites) {
      const st = { lat: s.lat, lng: s.lng, vs30: VS30 };
      const siteRes = {};
      for (const tag of ['pga', 'sa10']) {
        const off = byKey[s.code + '|' + OFFICIAL_IMT[tag]];
        const offGal = off.levelsG.map((l) => l * G_TO_GAL);
        const hz = Physics.hazardCurve(p, st, OUR_IMT[tag], { years: 50 });
        siteRes[tag] = {};
        for (const rp of RPS) {
          const o = Physics._pshaInvertCurve(offGal, off.rates, 1 / rp);
          const u = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / rp);
          if (!(o > 0) || !(u > 0)) throw new Error('nonpositive ' + armName + ' ' + s.code + ' ' + tag + ' rp' + rp);
          siteRes[tag]['rp' + rp] = +(u / o).toPrecision(6);
          ratios[armName + '|' + s.code + '|' + tag + '|rp' + rp] = u / o;
        }
      }
      armRes[s.code] = siteRes;
    }
    report.arms[armName] = armRes;
  }

  // S1: FULL reproduces the frozen gate ratios (compare at the gate's own
  // toPrecision(6) quantization — a full-precision ratio differs by ~1e-6
  // relative, exactly at a naive threshold's edge)
  for (const s of ['LA', 'SF']) {
    for (const tag of ['pga', 'sa10']) {
      for (const rp of ['rp475', 'rp2500']) {
        const want = gate.sites[s].ratio[tag][rp];
        const got = ratios['FULL|' + s + '|' + tag + '|' + rp];
        if (Math.abs(+got.toPrecision(6) - want) > 1e-9) throw new Error('FULL gate mismatch ' + s + ' ' + tag + ' ' + rp);
      }
    }
  }

  // rate factor k: at the official RP475 level, k = r_off(X)/r_ours(X)
  for (const s of frozen.sites) {
    const st = { lat: s.lat, lng: s.lng, vs30: VS30 };
    report.rateFactorK[s.code] = {};
    for (const tag of ['pga', 'sa10']) {
      const off = byKey[s.code + '|' + OFFICIAL_IMT[tag]];
      const offGal = off.levelsG.map((l) => l * G_TO_GAL);
      const X = Physics._pshaInvertCurve(offGal, off.rates, 1 / 475);
      const hz = Physics.hazardCurve(armList.FULL, st, OUR_IMT[tag], { years: 50 });
      // interpolate ours and official annual rates at the SAME level X
      function rateAt(levels, rates, x) {
        for (let i = 1; i < levels.length; i++) {
          if (levels[i - 1] <= x && x <= levels[i]) {
            const t = (Math.log(x) - Math.log(levels[i - 1])) / (Math.log(levels[i]) - Math.log(levels[i - 1]));
            return Math.exp(Math.log(rates[i - 1]) + t * (Math.log(rates[i]) - Math.log(rates[i - 1])));
          }
        }
        return null;
      }
      const rOff = rateAt(offGal, off.rates, X);
      const rOurs = rateAt(hz.imLevels, hz.meanRate, X);
      report.rateFactorK[s.code][tag] = { levelGal: +X.toPrecision(6), k: +((rOff && rOurs) ? (rOff / rOurs) : NaN).toPrecision(6) };
    }
  }

  const lg = (x) => Math.log10(x);
  const gmmRatios = ['GMM_bssa14', 'GMM_cy14', 'GMM_cb14_base', 'GMM_cb14_HighQ', 'GMM_cb14_LowQ', 'GMM_ask14']
    .map((a) => ratios[a + '|LA|pga|rp475']);
  const officialRatio = ratios['FULL|LA|pga|rp475'];
  report.hypotheses = {
    H1_gap_outside_our_gmm_spread: officialRatio < Math.min.apply(null, gmmRatios) || officialRatio > Math.max.apply(null, gmmRatios),
    H2_apron_minor_at_LA: ratios['APRON_ONLY|LA|pga|rp475'] < 0.10 * ratios['FULL|LA|pga|rp475'],
    H2_apron_minor_at_SF: ratios['APRON_ONLY|SF|pga|rp475'] < 0.10 * ratios['FULL|SF|pga|rp475'],
    H3_k_consistent_LA_SF: Math.abs(report.rateFactorK.LA.pga.k / report.rateFactorK.SF.pga.k - 1) <= 0.10,
  };
  report.findings = [
    'source-composition arms at LA RP475 PGA: ' +
      ['FULL', 'CHAR_ONLY', 'GRID_ONLY', 'APRON_ONLY', 'NO_APRON'].map((a) => a + '=' + ratios[a + '|LA|pga|rp475'].toFixed(3)).join(', '),
    'GMM-collapse spread at LA RP475 PGA: min ' + Math.min.apply(null, gmmRatios).toFixed(3) +
      ' max ' + Math.max.apply(null, gmmRatios).toFixed(3) + ' vs official ratio ' + officialRatio.toFixed(3),
    'uniform rate factor k to match official at LA RP475: PGA ' + report.rateFactorK.LA.pga.k.toFixed(3) +
      ', SA1.0 ' + report.rateFactorK.LA.sa10.k.toFixed(3) + ' (SF: ' + report.rateFactorK.SF.pga.k.toFixed(3) + ' / ' + report.rateFactorK.SF.sa10.k.toFixed(3) + ')',
  ];

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log(JSON.stringify(report, null, 1));
}

main();
