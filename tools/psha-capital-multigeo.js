#!/usr/bin/env node
'use strict';
// =====================================================================
//  R-A measurement: capital-inland M7.3 multi-geometry spreading
//  (open research queue R-A, HANDOVER-2 §4, run 2026-10-17)
//
//  CONTEXT / DISCOVERY (documented before this run):
//    The bundled Japan model's `tokyoInland` scenario has carried NO
//    geometry since PSHA v1 (2026-09-01) — no lat/lng, no patches. The
//    engine's point-scenario fallback (s.lat ?? 0) parks it at Null
//    Island, so the ERC capital umbrella rate (Sagami-trough 2nd ed.,
//    M7-class southern Kanto, 70%/30y -> 0.04013/yr) contributes ~zero
//    hazard everywhere. The R8 LND-arm Tokyo under-prediction (x0.725)
//    was therefore measured with the capital characteristic source
//    ABSENT — "single-geometry concentration" (the original R-A
//    registration wording) was a mis-description; the real antecedent
//    is revival, and the registered question becomes: does spreading
//    the revived rate over OFFICIAL J-SHIS fault geometries (fltinfo
//    freeze: tools/data/jshis-capital-faults.json) bring the LND arm
//    toward parity, better than a single revived geometry?
//
//  ARMS (all on the embedded J-SHIS Y2024 curves reused verbatim from
//  the frozen R8 report tools/data/jshis-decompose-report.json — no
//  live fetch, like-for-like against the published R8 numbers):
//    lndBaseline    crustal grid + tokyoInland AS SHIPPED (dead) —
//                   validity precondition, must reproduce R8
//    lndSingle      crustal grid + one revived geometry at the app.js
//                   PRESETS.tokyoInland location (35.62,139.75,17 km,
//                   full umbrella rate) — diagnostic, reported not gated
//    lndMulti       crustal grid + multi-geometry set, length-weighted
//                   rate split (W1, PRIMARY)
//    lndMultiEqual  same set, equal split (W2) — weighting robustness
//    lndMultiStrict strict-box subset (borderline-drop), W1 — subset
//                   sensitivity, reported not gated
//    ttlBaseline    full shipped model (R8 TTL reproduction)
//    ttlMulti       full model with the multi set replacing tokyoInland
//
//  PRE-REGISTERED HYPOTHESES (written before the first measured run;
//  verdicts computed mechanically from the measurement, never hand-set;
//  R8 frozen baselines cited from tools/data/jshis-decompose-report.json):
//    H-A0 (validity): lndBaseline RP475 ratios reproduce the R8 frozen
//        values at all six sites within 0.010 (tokyo 0.725, osaka 0.580,
//        sendai 1.015, kochi 0.523, nagoya 0.856, fukuoka 0.852) —
//        engine/Japan-path byte-identity check; a failure invalidates
//        the comparison basis (report and stop).
//    H-A1 (revival direction): lndMulti RP475 ratio at tokyo is
//        STRICTLY above the R8 baseline 0.725.
//    H-A2 (no far-field harm): |ratio_lndMulti(s) - ratio_R8(s)| < 0.10
//        at each of the five non-capital sites (osaka, sendai, kochi,
//        nagoya, fukuoka) — the capital set is local; remote LND arms
//        must not move materially.
//    H-A3 (bounded correction): 0.725 < ratio_lndMulti(tokyo) <= 1.30 —
//        parity is the target; > 1.30 registers overshoot (suspect
//        characteristic-vs-GR-grid double counting near the capital)
//        and blocks adoption.
//    H-A4 (R8 conclusion preservation): ttlMulti tokyo ratio <= 1.585 x
//        1.10, and ttlMulti kochi / osaka ratios stay within 0.020 of
//        the R8 frozen values (1.827 / 3.313) — the R8 finding "the
//        1.83x residual is PPE-carried" must survive the capital
//        revival.
//    H-A5 (weighting robustness): |ratio_lndMulti(tokyo) -
//        ratio_lndMultiEqual(tokyo)| / ratio_lndMulti(tokyo) < 0.15 —
//        adoption must not be an artifact of the length-vs-equal split.
//    DECISION RULE (mechanical): ADOPT the multi-geometry set into the
//        production v2 pack iff H-A0 ∧ H-A1 ∧ H-A2 ∧ H-A3 ∧ H-A4 ∧
//        H-A5. Any failing gate -> register as measured-not-adopted
//        with the failing gate documented. Rate conservation is
//        absolute: Σ rate_i = 0.04013/yr in every arm (asserted).
//
//  Honest scope notes (carried into the report):
//    - The umbrella rate is spread over MAJOR ERC-evaluated faults
//      only; unlocated M7-class activity in the domain stays carried
//      by the ComCat-derived crustal GR grid (J-SHIS also carries its
//      own background — like-for-like imperfect, stated).
//    - Overlap between the added characteristic set and the crustal GR
//      near Tokyo (double-counting risk) is exactly what H-A3's ceiling
//      guards; the seam is NOT adjusted in this measurement (mirrors
//      the pre-RELM-replacement California state; a fault-zone GR
//      replacement would be its own registered batch).
//    - This report is a frozen MEASUREMENT, not a calibration input
//      (data-honesty rule, SCIENTIFIC-REPORT §3.2).
// =====================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const FAULTS = path.join(ROOT, 'tools', 'data', 'jshis-capital-faults.json');
const R8 = path.join(ROOT, 'tools', 'data', 'jshis-decompose-report.json');
const OUT = path.join(ROOT, 'tools', 'data', 'psha-capital-multigeo-report.json');
const UMBRELLA_RATE = 0.04013; // -ln(1-0.70)/30, ERC Sagami-trough 2nd ed. headline
const R8_LND = { tokyo: 0.725, osaka: 0.580, sendai: 1.015, kochi: 0.523, nagoya: 0.856, fukuoka: 0.852 };
const R8_TTL = { tokyo: 1.585, kochi: 1.827, osaka: 3.313 };
const PATCH_SPACING_KM = 4;

// ---- geometry: bilinear patch sampling on the fltinfo corner quad ----
// corners ordered top0 -> top1 -> bottom1 -> bottom0 (verified against
// fltinfo strike/dip properties on F015021); patches in engine order
// [lat, lng, depthKm], points at cell centres of a ~4 km grid.
function samplePatches(f) {
  const poly = f.polygonLngLatDep;
  if (!poly || poly.length < 4) throw new Error(f.code + ': bad polygon');
  const c0 = poly[0], c1 = poly[1], c2 = poly[2], c3 = poly[3];
  const nu = Math.max(2, Math.ceil(f.lenKm / PATCH_SPACING_KM));
  const nv = Math.max(2, Math.ceil(f.widKm / PATCH_SPACING_KM));
  const pts = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = (i + 0.5) / nu, v = (j + 0.5) / nv;
      const pt = [0, 1, 2].map((k) => {
        const top = c0[k] + (c1[k] - c0[k]) * u;
        const bot = c3[k] + (c2[k] - c3[k]) * u;
        return top + (bot - top) * v;
      });
      pts.push([+pt[1].toFixed(4), +pt[0].toFixed(4), +pt[2].toFixed(2)]); // [lat,lng,dep]
    }
  }
  return pts;
}

function buildMultiSet(faultsDoc, subsetKey, weightMode) {
  const sel = faultsDoc.faults.filter((f) => f[subsetKey]);
  const totalLen = sel.reduce((a, f) => a + f.lenKm, 0);
  const entries = sel.map((f) => {
    const patches = samplePatches(f);
    const meanDepth = +(patches.reduce((a, p) => a + p[2], 0) / patches.length).toFixed(1);
    const w = weightMode === 'equal' ? 1 / sel.length : f.lenKm / totalLen;
    return {
      id: 'capitalM7_' + f.flt_id, mw: 7.3,
      ratePerYear: +(UMBRELLA_RATE * w).toPrecision(4),
      sourceType: 'crustal', depthKm: meanDepth,
      strikeDeg: f.strikeDeg, dipDeg: f.dipDeg, rakeDeg: 120, // rake not published per-fault by fltinfo; reverse-oblique class kept from the registered single-source class
      patches
    };
  });
  const rateSum = entries.reduce((a, e) => a + e.ratePerYear, 0);
  if (Math.abs(rateSum - UMBRELLA_RATE) > 1e-4) throw new Error('rate conservation violated: ' + rateSum);
  return { entries, nFaults: sel.length, totalLenKm: +totalLen.toFixed(1) };
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

function main() {
  const write = process.argv.includes('--write');
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const faultsDoc = JSON.parse(fs.readFileSync(FAULTS, 'utf8'));
  const r8 = JSON.parse(fs.readFileSync(R8, 'utf8'));
  const deadEntry = model.scenarios.find((s) => s.id === 'tokyoInland');
  if (!deadEntry || deadEntry.lat != null || deadEntry.patches) throw new Error('precondition: shipped tokyoInland must still be the geometry-less entry');

  const multi = buildMultiSet(faultsDoc, 'selected', 'length');
  const multiEqual = buildMultiSet(faultsDoc, 'selected', 'equal');
  const multiStrict = buildMultiSet(faultsDoc, 'selectedStrict', 'length');
  console.log('multi set: ' + multi.nFaults + ' faults, ' + multi.entries.reduce((a, e) => a + e.patches.length, 0) +
    ' patches, total trace ' + multi.totalLenKm + ' km (strict subset ' + multiStrict.nFaults + ' faults)');

  const sub = (classes, scenarioIds, extraScenarios) => Object.assign({}, model, {
    cells: model.cells.filter((c) => classes.indexOf(c.srcType) >= 0),
    scenarios: model.scenarios.filter((s) => scenarioIds.indexOf(s.id) >= 0).concat(extraScenarios || [])
  });
  const crustal = model.cells.filter((c) => c.srcType === 'crustal').length;
  const singleRevived = [{
    id: 'capitalM7_single', mw: 7.3, ratePerYear: UMBRELLA_RATE, sourceType: 'crustal',
    depthKm: 17, lat: 35.62, lng: 139.75, strikeDeg: 135, dipDeg: 60, rakeDeg: 120
  }];
  const ARMS = {
    lndBaseline: sub(['crustal'], ['tokyoInland']),
    lndSingle: sub(['crustal'], [], singleRevived),
    lndMulti: sub(['crustal'], [], multi.entries),
    lndMultiEqual: sub(['crustal'], [], multiEqual.entries),
    lndMultiStrict: sub(['crustal'], [], multiStrict.entries),
    ttlBaseline: model,
    ttlMulti: Object.assign({}, model, {
      scenarios: model.scenarios.filter((s) => s.id !== 'tokyoInland').concat(multi.entries)
    })
  };
  const ARM_EQ = { lndBaseline: 'LND_MTTL', lndSingle: 'LND_MTTL', lndMulti: 'LND_MTTL', lndMultiEqual: 'LND_MTTL', lndMultiStrict: 'LND_MTTL', ttlBaseline: 'TTL_MTTL', ttlMulti: 'TTL_MTTL' };

  const extLevels = [320, 350, 400, 450, 500, 600, 700, 850, 1000, 1200];
  const sitesOut = [];
  for (const siteBlock of r8.sites) {
    const site = siteBlock.site;
    const lv = siteBlock.jshis.LND_MTTL.levelsCmS;
    const lvTtl = siteBlock.jshis.TTL_MTTL.levelsCmS;
    const rateLnd = siteBlock.jshis.LND_MTTL.prob30.map((p) => (p >= 1 - 1e-6 ? Infinity : (p <= 0 ? 0 : -Math.log(1 - p) / 30)));
    const rateTtl = siteBlock.jshis.TTL_MTTL.prob30.map((p) => (p >= 1 - 1e-6 ? Infinity : (p <= 0 ? 0 : -Math.log(1 - p) / 30)));
    const st = { lat: site.lat, lng: site.lng, vs30: 600 };
    const arms = {};
    for (const armId of Object.keys(ARMS)) {
      const eq = ARM_EQ[armId];
      const grid = eq === 'LND_MTTL' ? lv : lvTtl;
      const eqRate = eq === 'LND_MTTL' ? rateLnd : rateTtl;
      const hz = Physics.hazardCurve(ARMS[armId], st, 'pgv', { imLevels: grid.concat(extLevels) });
      const rp = {};
      for (const period of [475, 2500]) {
        const jshisPgv = Physics._pshaInvertCurve(grid, eqRate.map((r) => (isFinite(r) ? r : 1e9)), 1 / period);
        const oursPgv = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / period);
        rp[String(period)] = {
          jshisPgvCmS: jshisPgv == null ? null : +jshisPgv.toFixed(1),
          oursPgvCmS: oursPgv == null ? null : +oursPgv.toFixed(1),
          ratioOursOverJshis: (oursPgv != null && jshisPgv > 0) ? +(oursPgv / jshisPgv).toFixed(3) : null
        };
      }
      arms[armId] = rp;
    }
    sitesOut.push({ site, arms });
    console.log(site.id + ': LND475 base x' + arms.lndBaseline['475'].ratioOursOverJshis +
      ' -> single x' + arms.lndSingle['475'].ratioOursOverJshis +
      ' multi x' + arms.lndMulti['475'].ratioOursOverJshis +
      ' (equal x' + arms.lndMultiEqual['475'].ratioOursOverJshis +
      ', strict x' + arms.lndMultiStrict['475'].ratioOursOverJshis + ')' +
      ' | TTL475 base x' + arms.ttlBaseline['475'].ratioOursOverJshis + ' -> multi x' + arms.ttlMulti['475'].ratioOursOverJshis);
  }

  const r475 = (sid, arm) => sitesOut.find((s) => s.site.id === sid).arms[arm]['475'].ratioOursOverJshis;
  const within = (v, ref, tol) => v != null && Math.abs(v - ref) <= tol;
  const farSites = ['osaka', 'sendai', 'kochi', 'nagoya', 'fukuoka'];
  const hypotheses = {
    'H-A0': {
      registered: 'lndBaseline reproduces the R8 frozen LND RP475 ratios within 0.010 at all six sites',
      measured: Object.keys(R8_LND).map((s) => ({ site: s, r8: R8_LND[s], now: r475(s, 'lndBaseline') })),
      verdict: Object.keys(R8_LND).every((s) => within(r475(s, 'lndBaseline'), R8_LND[s], 0.010)) ? 'SUPPORTED' : 'REFUTED'
    },
    'H-A1': {
      registered: 'lndMulti RP475 ratio at tokyo strictly above the R8 baseline 0.725',
      measured: { tokyoBaseline: r475('tokyo', 'lndBaseline'), tokyoMulti: r475('tokyo', 'lndMulti') },
      verdict: r475('tokyo', 'lndMulti') > R8_LND.tokyo ? 'SUPPORTED' : 'REFUTED'
    },
    'H-A2': {
      registered: '|ratio_lndMulti(s) - ratio_R8(s)| < 0.10 at each non-capital site',
      measured: farSites.map((s) => ({ site: s, r8: R8_LND[s], multi: r475(s, 'lndMulti'), delta: +(r475(s, 'lndMulti') - R8_LND[s]).toFixed(3) })),
      verdict: farSites.every((s) => within(r475(s, 'lndMulti'), R8_LND[s], 0.10)) ? 'SUPPORTED' : 'REFUTED'
    },
    'H-A3': {
      registered: '0.725 < ratio_lndMulti(tokyo) <= 1.30 (parity target; >1.30 = overshoot blocks adoption)',
      measured: { tokyoMulti: r475('tokyo', 'lndMulti') },
      verdict: (r475('tokyo', 'lndMulti') > R8_LND.tokyo && r475('tokyo', 'lndMulti') <= 1.30) ? 'SUPPORTED' : 'REFUTED'
    },
    'H-A4': {
      registered: 'ttlMulti tokyo <= 1.585x1.10; ttlMulti kochi/osaka within 0.020 of R8 frozen (1.827/3.313)',
      measured: { tokyo: { r8: R8_TTL.tokyo, multi: r475('tokyo', 'ttlMulti') }, kochi: { r8: R8_TTL.kochi, multi: r475('kochi', 'ttlMulti') }, osaka: { r8: R8_TTL.osaka, multi: r475('osaka', 'ttlMulti') } },
      verdict: (r475('tokyo', 'ttlMulti') <= R8_TTL.tokyo * 1.10 && within(r475('kochi', 'ttlMulti'), R8_TTL.kochi, 0.020) && within(r475('osaka', 'ttlMulti'), R8_TTL.osaka, 0.020)) ? 'SUPPORTED' : 'REFUTED'
    },
    'H-A5': {
      registered: '|lndMulti - lndMultiEqual| / lndMulti < 0.15 at tokyo (weighting robustness)',
      measured: { multi: r475('tokyo', 'lndMulti'), equal: r475('tokyo', 'lndMultiEqual'), relDiff: +Math.abs(r475('tokyo', 'lndMulti') - r475('tokyo', 'lndMultiEqual')) / r475('tokyo', 'lndMulti') },
      verdict: Math.abs(r475('tokyo', 'lndMulti') - r475('tokyo', 'lndMultiEqual')) / r475('tokyo', 'lndMulti') < 0.15 ? 'SUPPORTED' : 'REFUTED'
    }
  };
  const allPass = Object.keys(hypotheses).every((h) => hypotheses[h].verdict === 'SUPPORTED');
  const decision = {
    rule: 'ADOPT the multi-geometry set into the production v2 pack iff H-A0 ∧ H-A1 ∧ H-A2 ∧ H-A3 ∧ H-A4 ∧ H-A5 (mechanical, no hand override)',
    verdict: allPass ? 'ADOPT' : 'MEASURED-NOT-ADOPTED',
    failingGates: Object.keys(hypotheses).filter((h) => hypotheses[h].verdict !== 'SUPPORTED')
  };

  const report = {
    schema: 'quake-sim-psha-capital-multigeo-v1',
    generatedAt: new Date().toISOString(),
    preRegistered: {
      note: 'hypotheses H-A0..H-A5, the arm set, the weighting design and the adoption rule were written into tools/psha-capital-multigeo.js BEFORE the first measured run; verdicts and the adoption decision are computed mechanically. Frozen MEASUREMENT, not a calibration input (data-honesty rule).',
      discovery: 'shipped tokyoInland scenario carried no geometry since v1 — engine fallback (s.lat ?? 0) = Null Island, ~zero contribution; R8 LND ratios were measured with the capital source absent',
      hypotheses: Object.fromEntries(Object.keys(hypotheses).map((h) => [h, hypotheses[h].registered]))
    },
    input: {
      umbrellaRatePerYear: UMBRELLA_RATE,
      faultsFile: 'tools/data/jshis-capital-faults.json (schema ' + faultsDoc.schema + ', generated ' + faultsDoc.generatedAt + ')',
      nFaults: multi.nFaults, totalTraceKm: multi.totalLenKm,
      nFaultsStrict: multiStrict.nFaults,
      nPatches: multi.entries.reduce((a, e) => a + e.patches.length, 0),
      patchSpacingKm: PATCH_SPACING_KM,
      rateSplit: 'W1 length-share (primary) / W2 equal (sensitivity); conservation asserted at 1e-4',
      jshisCurves: 'reused verbatim (offline) from the frozen R8 report tools/data/jshis-decompose-report.json (Y2024 AVR T30)'
    },
    scopeNotes: [
      'the umbrella rate is spread over MAJOR ERC-evaluated faults only; unlocated M7-class activity in the domain stays carried by the ComCat crustal GR grid (J-SHIS carries its own background too — like-for-like imperfect, stated)',
      'characteristic-vs-GR-grid overlap near the capital (double-counting risk) is what H-A3 guards; the seam is NOT adjusted in this measurement',
      'lndSingle (single revived geometry at the app.js preset location) and lndMultiStrict (borderline-drop subset) are diagnostics, not gates'
    ],
    hypotheses,
    decision,
    diagnostics: {
      lndSingleTokyo: r475('tokyo', 'lndSingle'),
      lndMultiStrictTokyo: r475('tokyo', 'lndMultiStrict'),
      lndArmMedian: {
        baseline: +median(sitesOut.map((s) => s.arms.lndBaseline['475'].ratioOursOverJshis)).toFixed(3),
        multi: +median(sitesOut.map((s) => s.arms.lndMulti['475'].ratioOursOverJshis)).toFixed(3)
      }
    },
    sites: sitesOut,
    multiSet: multi.entries.map((e) => ({ id: e.id, ratePerYear: e.ratePerYear, nPatches: e.patches.length, depthKm: e.depthKm, dipDeg: e.dipDeg }))
  };
  console.log('\n=== VERDICTS ===');
  for (const h of Object.keys(hypotheses)) console.log(h + ' ' + hypotheses[h].verdict);
  console.log('DECISION: ' + decision.verdict + (decision.failingGates.length ? ' (failing: ' + decision.failingGates.join(', ') + ')' : ''));
  if (write) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log('wrote ' + OUT); }
  else console.log('(dry run — pass --write to freeze)');
}

main();
