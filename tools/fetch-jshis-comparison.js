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
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  const fetchedAt = new Date().toISOString();

  const results = [];
  for (const site of SITES) {
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
    const levels = doc.sim.value.map(Number); // cm/s, ascending
    const probs = doc.prob.value.map(Number);
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

    results.push({
      site, meshcode: doc.metaData && doc.metaData.meshcode,
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
      returnPeriods: rpTable
    });
    console.log(site.id + ' mesh ' + results[results.length - 1].meshcode +
      ': median log10(rate ratio) ' + results[results.length - 1].midBand.medianLog10RateRatio +
      ', RP475 jshis ' + (rpTable['475'].jshisPgvCmS || 'n/a') + ' cm/s vs ours ' + (rpTable['475'].oursPgvCmS || 'n/a') + ' cm/s');
    await sleep(2000); // be polite; 403 = rate limit per the API doc
  }

  // aggregate over sites (level factor at RP475 + mid-band shape)
  const rp475Ratios = results.map((r) => r.returnPeriods['475'].ratioOursOverJshis).filter((v) => v != null);
  const midMedians = results.map((r) => r.midBand.medianLog10RateRatio).filter((v) => v != null);
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
    }
  };

  const report = {
    schema: 'quake-sim-jshis-comparison-v1',
    generatedAt: fetchedAt,
    provenance: {
      endpoint: ENDPOINT + '?position=<lng>,<lat>&epsg=4326',
      version: 'Y2024', case: 'AVR', eqcode: 'TTL_MTTL', window: 'T30',
      sim: 'engineering-bedrock PGV (bv), cm/s',
      license: 'NIED J-SHIS (防災科研 地震ハザードステーション) — government open data, attribution carried in README',
      note: 'raw 30-yr probabilities embedded per site; annual rate = -ln(1-p)/30 (Poisson window conversion)'
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
        'Nankai M9 (0.0462/yr) + capital M7.3 (0.0401/yr) scenario sources contribute high-magnitude close-distance branches at every Honshu site',
        'zhao PGV branch derives PGV from SA(1.0)/(2pi) pseudo-velocity, which typically overestimates true PGV by ~1.2-1.5x',
        '3-family logic-tree rate mixing is convex in branch CCDFs; si-mid/kanno PGV branches are unsaturated at close Rrup with the equal-area Rrup proxy',
        'Vs30=600 reference vs engineering-bedrock basis (bounded confound, cannot explain >2x alone)',
        'ComCat-derived GR grid rates (Mc=5.0@1980, 44-yr window) may overresolve western-Japan background'
      ],
      followUpExperiments: [
        'per-branch attribution: rerun the comparison with the zhao-only PGV branch and with scenario sources excluded (both are one-line source-model variants)',
        'PSV->PGV conversion factor sensitivity on the zhao branch',
        'this report is a frozen measurement, NOT a calibration input — no parameter was tuned from it (data-honesty rule)'
      ]
    },
    aggregate, results
  };
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\n=== AGGREGATE ===');
  console.log('RP475 PGV ratio ours/jshis: median ' + aggregate.rp475PgvRatioOursOverJshis.median +
    ' [' + aggregate.rp475PgvRatioOursOverJshis.min + ' .. ' + aggregate.rp475PgvRatioOursOverJshis.max + ']');
  console.log('mid-band median log10(rate ratio): median ' + aggregate.midBandMedianLog10RateRatio.median +
    ' [' + aggregate.midBandMedianLog10RateRatio.min + ' .. ' + aggregate.midBandMedianLog10RateRatio.max + ']');
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

main().catch((e) => { console.error(e); process.exit(1); });
