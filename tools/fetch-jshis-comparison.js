#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.1 R8 external gate — J-SHIS hazard-curve comparison.
//
//  Fetches the official J-SHIS hazard curve (PshmHzcv API, engineering
//  bedrock PGV, total sources, 30-year window) for a frozen site set and
//  compares it against THIS project's Physics.hazardCurve at the SAME IM
//  level grid, plus return-period inversions at 475/1000/2500/5000 yr.
//
//  Basis differences are frozen in the report, not silently reconciled:
//    J-SHIS  = 2024 NIED model (Y2024), average case, all sources (TTL),
//              engineering-bedrock PGV (sim.type bv, cm/s), 250 m 3rd mesh,
//              30-yr exceedance probability Poisson-converted to annual rate
//              (rate = -ln(1-p)/30)
//    ours    = quake-sim-psha-source-v1 (ComCat self-built), 3-family GMPE
//              logic tree, PGV at the Vs30=600 reference motion, modelBias
//              deliberately NOT applied (LOEO evidence, v6.1 P1 decision)
//  The Vs30=600 reference and the J-SHIS engineering bedrock are the same
//  hardness ballpark but NOT the same site basis — the level ratios below
//  carry that confound and no equivalence claim is made in either direction.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'jshis-comparison-report.json');
const ENDPOINT = 'https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/TTL_MTTL/T30/hzcv.json';
const WINDOW_YEARS = 30;
const RPS = [475, 1000, 2500, 5000];

// frozen site set (2026-09-03): the CS-pipeline cities + Nagoya/Fukuoka for
// hazard-level spread; land sites only, JIVSM column NOT required here
const SITES = [
  { id: 'tokyo', lat: 35.6812, lng: 139.7671 },
  { id: 'osaka', lat: 34.6937, lng: 135.5022 },
  { id: 'sendai', lat: 38.2682, lng: 140.8694 },
  { id: 'kochi', lat: 33.5597, lng: 133.5311 },
  { id: 'nagoya', lat: 35.1815, lng: 136.9066 },
  { id: 'fukuoka', lat: 33.5902, lng: 130.4017 }
];

function curlJson(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', '60', '--compressed', url],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('curl failed: ' + (stderr || err.message)));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('bad JSON from ' + url + ': ' + stdout.slice(0, 120))); }
      });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const write = process.argv.includes('--write');
  // --offline: reuse the J-SHIS curves embedded in the existing frozen report
  // (identical official Y2024 data; used when the API is unreachable from
  // this network). Ours is always recomputed against the CURRENT source model.
  const offline = process.argv.includes('--offline');
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const embedded = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (offline && !embedded) throw new Error('--offline needs an existing frozen report to reuse');
  const fetchedAt = new Date().toISOString();

  const results = [];
  for (const site of SITES) {
    let levels, probs, meshcode;
    if (offline) {
      const prev = embedded.results.find((r) => r.site.id === site.id);
      if (!prev) throw new Error('--offline: site ' + site.id + ' missing from the frozen report');
      levels = prev.levelsCmS;
      probs = prev.jshisProb30;
      meshcode = prev.meshcode;
      console.log(site.id + ': reusing embedded J-SHIS curve (' + levels.length + ' levels, frozen ' + embedded.generatedAt + ')');
    } else {
    const url = ENDPOINT + '?position=' + site.lng + ',' + site.lat + '&epsg=4326';
    let doc;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { doc = await curlJson(url); break; }
      catch (e) {
        if (attempt === 3) throw e;
        console.log(site.id + ' attempt ' + attempt + ' failed (' + e.message.slice(0, 60) + '), retrying');
        await sleep(4000);
      }
    }
    if (!doc || doc.status !== 'Success' || !doc.sim || !doc.prob) {
      throw new Error(site.id + ': unexpected response ' + JSON.stringify(doc).slice(0, 200));
    }
    levels = doc.sim.value.map(Number); // cm/s, ascending
    probs = doc.prob.value.map(Number);
    meshcode = doc.metaData && doc.metaData.meshcode;
    }
    // 30-yr window Poisson conversion; levels with prob >= 1-1e-6 carry no information
    const rate = probs.map((p) => (p >= 1 - 1e-6 ? Infinity : (p <= 0 ? 0 : -Math.log(1 - p) / WINDOW_YEARS)));

    // our engine on the SAME level grid (per-level ratios) AND on an extended
    // grid (up to 1200 cm/s) so RP inversions are not clipped by their 300 cap
    const hz = Physics.hazardCurve(model, { lat: site.lat, lng: site.lng, vs30: 600 }, 'pgv', { imLevels: levels });
    const extLevels = levels.concat([320, 350, 400, 450, 500, 600, 700, 850, 1000, 1200]);
    const hzExt = Physics.hazardCurve(model, { lat: site.lat, lng: site.lng, vs30: 600 }, 'pgv', { imLevels: extLevels });
    const rateRatio = levels.map((_, i) => (isFinite(rate[i]) && rate[i] > 0 && hz.meanRate[i] > 0 ? hz.meanRate[i] / rate[i] : null));

    // mid-range comparison (rate 1e-5..0.1 both sides): away from both tails
    const midLog10 = [];
    for (let i = 0; i < levels.length; i++) {
      if (rateRatio[i] != null && rate[i] >= 1e-5 && rate[i] <= 0.1) midLog10.push(Math.log10(rateRatio[i]));
    }
    // return-period inversion (log-linear on both curves; ours on the extended grid)
    const rpTable = {};
    for (const rp of RPS) {
      const t = 1 / rp;
      rpTable[String(rp)] = {
        jshisPgvCmS: Physics._pshaInvertCurve(levels, rate.map((r) => (isFinite(r) ? r : 1e9)), t),
        oursPgvCmS: Physics._pshaInvertCurve(extLevels, hzExt.meanRate, t)
      };
      const row = rpTable[String(rp)];
      row.ratioOursOverJshis = (row.jshisPgvCmS > 0 && row.oursPgvCmS > 0) ? +(row.oursPgvCmS / row.jshisPgvCmS).toFixed(3) : null;
      if (row.jshisPgvCmS != null) row.jshisPgvCmS = +row.jshisPgvCmS.toFixed(1);
      if (row.oursPgvCmS != null) row.oursPgvCmS = +row.oursPgvCmS.toFixed(1);
    }

    // v6.2 time-dependent arm — pre-registered in psha-attribution-report.json
    // (residualStructure: "a time-dependent engine is the honest next step,
    // not further rate tuning"). Same J-SHIS curves; ours via
    // hazardCurveTimeDependent with horizon = J-SHIS's 30-y window (BPT
    // renewal Nankai sources + Poisson background). The engine returns both
    // the 30-y total probability (poissonProb) and the equivalent-Poisson
    // annual rate (meanRate), so per-level and RP comparisons keep the same
    // semantics as the stationary arm. Measurement only — no tuning input.
    const tdSite = { lat: site.lat, lng: site.lng, vs30: 600 };
    const hzTd = Physics.hazardCurveTimeDependent(model, tdSite, 'pgv', { horizonYears: WINDOW_YEARS, imLevels: levels });
    const hzTdExt = Physics.hazardCurveTimeDependent(model, tdSite, 'pgv', { horizonYears: WINDOW_YEARS, imLevels: extLevels });
    const tdRateRatio = levels.map((_, i) => (isFinite(rate[i]) && rate[i] > 0 && hzTd.meanRate[i] > 0 ? hzTd.meanRate[i] / rate[i] : null));
    const tdMidLog10 = [];
    for (let i = 0; i < levels.length; i++) {
      if (tdRateRatio[i] != null && rate[i] >= 1e-5 && rate[i] <= 0.1) tdMidLog10.push(Math.log10(tdRateRatio[i]));
    }
    const tdRpTable = {};
    for (const rp of RPS) {
      const t = 1 / rp;
      const tdRow = {
        jshisPgvCmS: rpTable[String(rp)].jshisPgvCmS,
        oursTdPgvCmS: Physics._pshaInvertCurve(extLevels, hzTdExt.meanRate, t)
      };
      tdRow.ratioTdOverJshis = (tdRow.jshisPgvCmS > 0 && tdRow.oursTdPgvCmS > 0) ? +(tdRow.oursTdPgvCmS / tdRow.jshisPgvCmS).toFixed(3) : null;
      if (tdRow.oursTdPgvCmS != null) tdRow.oursTdPgvCmS = +tdRow.oursTdPgvCmS.toFixed(1);
      tdRpTable[String(rp)] = tdRow;
    }
    const tdBlock = {
      horizonYears: WINDOW_YEARS,
      nBptSources: hzTd.diagnostics.nBptSources,
      oursTdRateAnnual: hzTd.meanRate.map((r) => +r.toPrecision(4)),
      rateRatioTdOverJshis: tdRateRatio.map((r) => (r != null ? +r.toFixed(3) : null)),
      midBand: {
        levelsCompared: tdMidLog10.length,
        medianLog10RateRatio: tdMidLog10.length ? +median(tdMidLog10).toFixed(3) : null
      },
      returnPeriods: tdRpTable
    };

    results.push({
      site, meshcode,
      levelsCmS: levels,
      jshisProb30: probs.map((p) => +p.toFixed(7)),
      jshisRateAnnual: rate.map((r) => (isFinite(r) ? +r.toPrecision(4) : null)),
      oursRateAnnual: hz.meanRate.map((r) => +r.toPrecision(4)),
      rateRatioOursOverJshis: rateRatio.map((r) => (r != null ? +r.toFixed(3) : null)),
      midBand: {
        levelsCompared: midLog10.length,
        medianLog10RateRatio: midLog10.length ? +median(midLog10).toFixed(3) : null,
        maxAbsLog10RateRatio: midLog10.length ? +Math.max(...midLog10.map(Math.abs)).toFixed(3) : null
      },
      returnPeriods: rpTable,
      timeDependent: tdBlock
    });
    console.log(site.id + ' mesh ' + results[results.length - 1].meshcode +
      ': median log10(rate ratio) ' + results[results.length - 1].midBand.medianLog10RateRatio +
      ', RP475 jshis ' + (rpTable['475'].jshisPgvCmS || 'n/a') + ' cm/s vs ours ' + (rpTable['475'].oursPgvCmS || 'n/a') +
      ' (td ' + (tdRpTable['475'].oursTdPgvCmS || 'n/a') + ')');
    if (!offline) await sleep(2000); // be polite; 403 = rate limit per the API doc
  }

  // aggregate over sites (level factor at RP475 + mid-band shape)
  const rp475Ratios = results.map((r) => r.returnPeriods['475'].ratioOursOverJshis).filter((v) => v != null);
  const midMedians = results.map((r) => r.midBand.medianLog10RateRatio).filter((v) => v != null);
  const td475Ratios = results.map((r) => r.timeDependent.returnPeriods['475'].ratioTdOverJshis).filter((v) => v != null);
  const tdMidMedians = results.map((r) => r.timeDependent.midBand.medianLog10RateRatio).filter((v) => v != null);
  const aggregate = {
    nSites: results.length,
    rp475PgvRatioOursOverJshis: {
      median: +median(rp475Ratios).toFixed(3),
      min: +Math.min(...rp475Ratios).toFixed(3),
      max: +Math.max(...rp475Ratios).toFixed(3)
    },
    midBandMedianLog10RateRatio: {
      median: +median(midMedians).toFixed(3),
      min: +Math.min(...midMedians).toFixed(3),
      max: +Math.max(...midMedians).toFixed(3)
    },
    tdRp475PgvRatioOverJshis: {
      median: +median(td475Ratios).toFixed(3),
      min: +Math.min(...td475Ratios).toFixed(3),
      max: +Math.max(...td475Ratios).toFixed(3)
    },
    tdMidBandMedianLog10RateRatio: {
      median: +median(tdMidMedians).toFixed(3),
      min: +Math.min(...tdMidMedians).toFixed(3),
      max: +Math.max(...tdMidMedians).toFixed(3)
    }
  };

  const report = {
    schema: 'quake-sim-jshis-comparison-v2',
    generatedAt: fetchedAt,
    provenance: {
      endpoint: ENDPOINT + '?position=<lng>,<lat>&epsg=4326',
      version: 'Y2024', case: 'AVR', eqcode: 'TTL_MTTL', window: 'T30',
      sim: 'engineering-bedrock PGV (bv), cm/s',
      license: 'NIED J-SHIS (防災科研 地震ハザードステーション) — government open data, attribution carried in README',
      note: (offline ? 'J-SHIS curves reused verbatim from the previous frozen fetch (embedded per site); ours recomputed on ' + model.schema + ' — live API unreachable from this network at generation time. ' : 'raw 30-yr probabilities embedded per site; ') + 'annual rate = -ln(1-p)/30 (Poisson window conversion)',
      sourceModel: model.schema,
    },
    basis: {
      jshis: 'Y2024 NIED national model, average case, all sources, engineering bedrock, official site amplification NOT included (bedrock motion)',
      ours: 'quake-sim-psha-source-v1 (USGS ComCat self-built, 0.25 deg GR + Nankai M9 / capital M7.3 scenarios), 3-family GMPE logic tree (LLH weights), PGV at Vs30=600 reference, modelBias deliberately not applied (LOEO evidence)',
      confound: 'Vs30=600 reference motion vs J-SHIS engineering bedrock: same hardness ballpark, not the same site basis; level ratios carry this confound — no equivalence claim in either direction'
    },
    findings: {
      headline: 'self-built model OVERPREDICTS PGV hazard vs J-SHIS Y2024: RP475 ratio ours/jshis ' +
        aggregate.rp475PgvRatioOursOverJshis.median + 'x median [' + aggregate.rp475PgvRatioOursOverJshis.min +
        '..' + aggregate.rp475PgvRatioOursOverJshis.max + '] across ' + aggregate.nSites +
        ' sites; mid-band annual-rate ratio median 10^' + aggregate.midBandMedianLog10RateRatio.median +
        ' log10 — the external gate answers AGAINST absolute-level parity, and this bounds every PSHA-derived number (UHS anchors, CS-pipeline targets included)',
      gradient: 'overprediction is steepest at Nankai-adjacent sites (kochi ' + results[3].returnPeriods['475'].ratioOursOverJshis +
        'x, osaka ' + results[1].returnPeriods['475'].ratioOursOverJshis + 'x) and mildest at sendai (' + results[2].returnPeriods['475'].ratioOursOverJshis +
        'x) — the tail gradient (ours flatter than J-SHIS) points at scenario-source and sigma structure, not a uniform level offset',
      candidateCausesUnverified: [
        'Nankai segmented modes (v2: nankaiFullM89 0.005698/yr + nankaiEastM82 0.001425/yr + nankaiWestM83 0.001425/yr) + capital M7.3 (0.04013/yr) scenario sources contribute high-magnitude close-distance branches at every Honshu site',
        'zhao PGV branch derives PGV from SA(1.0)/(2pi) pseudo-velocity, which typically overestimates true PGV by ~1.2-1.5x',
        '3-family logic-tree rate mixing is convex in branch CCDFs; si-mid/kanno PGV branches are unsaturated at close Rrup with the equal-area Rrup proxy',
        'Vs30=600 reference vs engineering-bedrock basis (bounded confound, cannot explain >2x alone)',
        'ComCat-derived GR grid rates (Mc=5.0@1980, 44-yr window) may overresolve western-Japan background'
      ],
      followUpExperiments: [
        'per-branch attribution: rerun the comparison with the zhao-only PGV branch and with scenario sources excluded (both are one-line source-model variants) — EXECUTED, see tools/data/psha-attribution-report.json',
        'PSV->PGV conversion factor sensitivity on the zhao branch — EXECUTED (same report)',
        'time-dependent arm (v2, this report): hazardCurveTimeDependent with the J-SHIS 30-y window — the arm the attribution report pre-registered as "the honest next step"; measurement only',
        'this report is a frozen measurement, NOT a calibration input — no parameter was tuned from it (data-honesty rule)'
      ],
      timeDependentArm: 'BPT renewal Nankai sources (ERC 1/117yr full + 1/468yr single-segment modes, elapsed to 2025.75) over the Poisson background, horizon 30 y. MEASURED: mid-band log10 rate ratio median ' + aggregate.tdMidBandMedianLog10RateRatio.median +
        ' [min ' + aggregate.tdMidBandMedianLog10RateRatio.min + '] vs stationary ' + aggregate.midBandMedianLog10RateRatio.median +
        ' [min ' + aggregate.midBandMedianLog10RateRatio.min + '] — the stationary engine mid-band DEFICIT at Nankai-adjacent sites (kochi -0.594, nagoya -0.15) flips positive under BPT, CONFIRMING the pre-registered diagnosis that J-SHIS curves carry renewal-elevated mid-band rates there; RP475 tail ratio ' + aggregate.tdRp475PgvRatioOverJshis.median + 'x [' + aggregate.tdRp475PgvRatioOverJshis.min +
        '..' + aggregate.tdRp475PgvRatioOverJshis.max + '] vs stationary ' + aggregate.rp475PgvRatioOursOverJshis.median + 'x — NOT a like-for-like tail comparison (the J-SHIS AVR product is the time-independent average case), so the stationary arm remains the external-gate tail number and the stationary-frame tail overprediction stays open. Measurement only, no tuning input'
    },
    aggregate, results
  };
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\n=== AGGREGATE ===');
  console.log('RP475 PGV ratio ours/jshis: median ' + aggregate.rp475PgvRatioOursOverJshis.median +
    ' [' + aggregate.rp475PgvRatioOursOverJshis.min + ' .. ' + aggregate.rp475PgvRatioOursOverJshis.max + ']');
  console.log('mid-band median log10(rate ratio): median ' + aggregate.midBandMedianLog10RateRatio.median +
    ' [' + aggregate.midBandMedianLog10RateRatio.min + ' .. ' + aggregate.midBandMedianLog10RateRatio.max + ']');
  console.log('TD RP475 PGV ratio/jshis: median ' + aggregate.tdRp475PgvRatioOverJshis.median +
    ' [' + aggregate.tdRp475PgvRatioOverJshis.min + ' .. ' + aggregate.tdRp475PgvRatioOverJshis.max + ']');
  console.log('TD mid-band median log10(rate ratio): median ' + aggregate.tdMidBandMedianLog10RateRatio.median +
    ' [' + aggregate.tdMidBandMedianLog10RateRatio.min + ' .. ' + aggregate.tdMidBandMedianLog10RateRatio.max + ']');
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

main().catch((e) => { console.error(e); process.exit(1); });
