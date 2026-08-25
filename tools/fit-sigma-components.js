#!/usr/bin/env node
'use strict';
// ================================================================
//  GMPE sigma-component fit (R1, 2026-08-24): one-way random-effects
//  decomposition (inter-event tau / intra-event phi) of the frozen
//  strong-motion residuals, method of moments (balanced-free ANOVA),
//  per model, in BOTH JMA-intensity units and ln-PGA units.
//
//  Zhao 2006 keeps its PAPER Table 6 tau/phi (asserted in
//  tests/gmpe-benchmarks.test.js); this tool fits the missing components
//  for si-midorikawa / kanno2006 (single-number sigmas today) and
//  cross-checks zhao's fit against the paper values.
//
//  Residuals are detrended by per-distance-bin means in each metric's own
//  space before decomposition, so tau/phi describe aleatory spread rather
//  than the known systematic bias.
//
//  Usage: node tools/fit-sigma-components.js [--out=tools/data/sigma-components-report.json]
//  Output report is frozen; the fitted values are embedded in
//  public/physics.js GMPE_SIGMA_COMPONENTS (with this report as source).
// ================================================================
const fs = require('fs');
const path = require('path');
const Scorecard = require('./scorecard-strong-motion.js');

const MODELS = ['zhao2006', 'si-midorikawa', 'kanno2006'];

// One-way random effects, method of moments (unbalanced ANOVA):
//   phi^2 = MSW (within-event mean square)
//   tau^2 = max(0, (MSB - MSW) / n0), n0 = (N - sum(n_i^2)/N)/(E-1)
function sigmaComponents(valuesByEvent) {
  const E = valuesByEvent.length;
  const ns = valuesByEvent.map(v => v.length);
  const N = ns.reduce((a, b) => a + b, 0);
  if (E < 2 || N <= E) return null;
  const grand = valuesByEvent.reduce((s, v) => s + v.reduce((x, y) => x + y, 0), 0) / N;
  const means = valuesByEvent.map(v => v.reduce((x, y) => x + y, 0) / v.length);
  let ssb = 0, ssw = 0;
  for (let i = 0; i < E; i++) {
    ssb += ns[i] * (means[i] - grand) ** 2;
    for (const v of valuesByEvent[i]) ssw += (v - means[i]) ** 2;
  }
  const msb = ssb / (E - 1);
  const msw = ssw / (N - E);
  const n0 = (N - ns.reduce((s, n) => s + n * n, 0) / N) / (E - 1);
  const phi2 = msw;
  const tau2 = Math.max(0, (msb - msw) / n0);
  return { events: E, stations: N, tau: Math.sqrt(tau2), phi: Math.sqrt(phi2),
    sigmaT: Math.sqrt(tau2 + phi2), grandBias: grand };
}

// Detrend residuals by per-distance-bin means (sigma must describe aleatory
// spread AFTER removing measurable systematic structure — pooling all
// magnitudes per bin, so no magnitude gate here).
function detrendByDistance(stations, pick) {
  const edges = Scorecard.DIST_EDGES;
  const nBins = edges.length - 1;
  const sums = new Array(nBins).fill(0), counts = new Array(nBins).fill(0);
  const binOf = st => {
    for (let k = 0; k < nBins; k++) if (st.distKm >= edges[k] && st.distKm < edges[k + 1]) return k;
    return nBins - 1;
  };
  const values = stations.map(st => pick(st));
  stations.forEach((st, i) => { const k = binOf(st); sums[k] += values[i]; counts[k]++; });
  return values.map((v, i) => v - (counts[binOf(stations[i])] ? sums[binOf(stations[i])] / counts[binOf(stations[i])] : 0));
}

function fitModel(obs, calibration, model) {
  const { events, routable } = Scorecard.collectModelBiasResiduals(obs, calibration, model);
  const all = events.flatMap(e => e.stations);
  // Pooled per-bin detrending in each metric's own space.
  const detrendedIntensity = detrendByDistance(all, st => st.residual);
  const detrendedLnPga = detrendByDistance(all, st => st.lnPgaResidual);
  const intensityByEvent = [], lnPgaByEvent = [];
  let idx = 0;
  for (const ev of events) {
    intensityByEvent.push(detrendedIntensity.slice(idx, idx + ev.stations.length));
    lnPgaByEvent.push(detrendedLnPga.slice(idx, idx + ev.stations.length));
    idx += ev.stations.length;
  }
  return {
    model, forcedFit: !routable,
    intensity: sigmaComponents(intensityByEvent),
    lnPga: sigmaComponents(lnPgaByEvent)
  };
}

function main() {
  const args = process.argv.slice(2);
  const outArg = args.find(a => a.startsWith('--out='));
  const outPath = outArg ? outArg.split('=')[1] : 'tools/data/sigma-components-report.json';

  const obs = JSON.parse(fs.readFileSync('public/geojson/strong-motion-obs.json', 'utf8'));
  const calibration = JSON.parse(fs.readFileSync(path.join('public', 'geojson', 'gmpe-calibration.json'), 'utf8'));

  const models = {};
  for (const m of MODELS) {
    const r = fitModel(obs, calibration, m);
    models[m] = r;
    const f = s => s == null ? 'n/a' : `tau ${s.tau.toFixed(3)} phi ${s.phi.toFixed(3)} sigmaT ${s.sigmaT.toFixed(3)}`;
    const n = r.intensity ? `${r.intensity.events} events, ${r.intensity.stations} stations` : 'n/a';
    console.log(`${m} (${n}${r.forcedFit ? ', forced fit' : ''})`);
    console.log(`  intensity: ${f(r.intensity)}`);
    console.log(`  ln PGA   : ${f(r.lnPga)}`);
  }

  const report = {
    schema: 'quake-sim-sigma-components-v1',
    generatedAt: new Date().toISOString(),
    method: 'one-way random-effects ANOVA (method of moments) per event on per-distance-bin-detrended frozen residuals; '
      + 'intensity in JMA units, lnPga in natural-log gal; JMA-catalog prediction hypocenters',
    obsSource: 'public/geojson/strong-motion-obs.json',
    paperReference: { zhao2006: 'Zhao et al. (2006) Table 6 tau/phi (kept as the deployed values; this fit is the cross-check)' },
    models
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log('wrote', outPath);
}

if (require.main === module) main();
module.exports = { sigmaComponents, detrendByDistance, fitModel, MODELS };
