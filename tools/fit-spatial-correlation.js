#!/usr/bin/env node
'use strict';
// ================================================================
//  Spatial-correlation calibration (R1, 2026-08-24): empirical semivariogram
//  of normalized intra-event residuals from the frozen 13-event station set,
//  fitted by the Jayaram & Baker (2009) exponential form rho(h) = exp(-3h/b).
//
//  Method (paper Section 4-5): per event, residuals (which mix the
//  inter-event term eta) are differenced PAIRWISE within the event — Eq.(13)
//  of the paper shows the constant eta cancels in the pairwise difference,
//  so the empirical semivariogram isolates the intra-event structure without
//  subtracting event means. Residuals are normalized per model/metric by the
//  fitted phi (tools/data/sigma-components-report.json) so gamma(h) has unit
//  sill; the exponential range b is then fitted with short-distance priority
//  (weights 1/h on bin centers up to 60 km).
//
//  Deployed residuals use each event's auto-routed model (zhao2006 for the
//  4 interface/slab events, si-midorikawa for the 9 crustal events); kanno
//  is user-select-only and not part of the deployed path.
//
//  Usage: node tools/fit-spatial-correlation.js
//  Output: tools/data/spatial-correlation-report.json (frozen; the fitted
//  ranges are embedded in public/physics.js SPATIAL_CORRELATION).
// ================================================================
const fs = require('fs');
const Scorecard = require('./scorecard-strong-motion.js');

const BIN_EDGES = [0, 5, 10, 15, 20, 30, 40, 60, 80, 120];
const FIT_MAX_KM = 60;   // short-distance priority per paper Section 5
const ROUTED_MODELS = ['zhao2006', 'si-midorikawa'];

function binnedSemivariogram(events, pick, phiByModel) {
  const bins = new Array(BIN_EDGES.length - 1).fill(null).map(() => ({ sum: 0, n: 0 }));
  let pairsTotal = 0;
  for (const ev of events) {
    const sts = ev.stations;
    const phi = phiByModel(ev.model);
    for (let i = 0; i < sts.length; i++) {
      for (let j = i + 1; j < sts.length; j++) {
        const hKm = haversine(sts[i].lat, sts[i].lng, sts[j].lat, sts[j].lng);
        if (hKm >= BIN_EDGES[BIN_EDGES.length - 1]) continue;
        let k = 0;
        while (k < bins.length && hKm >= BIN_EDGES[k + 1]) k++;
        if (k >= bins.length) continue;
        const u = pick(sts[i]) / phi, v = pick(sts[j]) / phi;
        bins[k].sum += 0.5 * (u - v) * (u - v);
        bins[k].n++;
        pairsTotal++;
      }
    }
  }
  return {
    bins: bins.map((b, k) => ({
      minKm: BIN_EDGES[k], maxKm: BIN_EDGES[k + 1],
      centerKm: 0.5 * (BIN_EDGES[k] + BIN_EDGES[k + 1]),
      gamma: b.n ? b.sum / b.n : null, pairs: b.n
    })),
    pairsTotal
  };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Fit b in exp(-3h/b) by minimizing distance-weighted squared error against
// the empirical gamma (gamma = 1 - exp(-3h/b)); weight 1/h (short priority).
function fitRange(bins) {
  const usable = bins.filter(b => b.gamma != null && b.centerKm <= FIT_MAX_KM && b.pairs >= 30);
  if (usable.length < 3) return null;
  let best = null;
  for (let b = 3; b <= 120; b += 0.5) {
    let sse = 0, wsum = 0;
    for (const u of usable) {
      const w = 1 / u.centerKm;
      const model = 1 - Math.exp(-3 * u.centerKm / b);
      sse += w * (u.gamma - model) ** 2;
      wsum += w;
    }
    const rmse = Math.sqrt(sse / wsum);
    if (!best || rmse < best.rmse) best = { rangeKm: b, rmse };
  }
  return best;
}

function main() {
  const obs = JSON.parse(fs.readFileSync('public/geojson/strong-motion-obs.json', 'utf8'));
  const calibration = JSON.parse(fs.readFileSync('public/geojson/gmpe-calibration.json', 'utf8'));
  const sigmaRep = JSON.parse(fs.readFileSync('tools/data/sigma-components-report.json', 'utf8'));

  // Deployed-path residuals: each routed model contributes its own events.
  const events = [];
  for (const m of ROUTED_MODELS) {
    const { events: evs } = Scorecard.collectModelBiasResiduals(obs, calibration, m);
    for (const ev of evs) events.push(Object.assign({ model: m }, ev));
  }
  const phi = (metric, model) => sigmaRep.models[model][metric].phi;

  const metrics = {
    lnPga: { pick: st => st.lnPgaResidual, phiByModel: m => phi('lnPga', m) },
    intensity: { pick: st => st.residual, phiByModel: m => phi('intensity', m) }
  };
  const out = {
    schema: 'quake-sim-spatial-correlation-v1',
    generatedAt: new Date().toISOString(),
    method: 'empirical semivariogram of phi-normalized residuals; pairwise differencing within events '
      + '(inter-event term cancels per Jayaram & Baker 2009 Eq.(13)); exponential rho(h)=exp(-3h/b) '
      + 'fitted with 1/h weighting up to ' + FIT_MAX_KM + ' km',
    events: events.length,
    stations: events.reduce((n, e) => n + e.stations.length, 0),
    paperReference: {
      model: 'Jayaram & Baker (2009) Eq.(17)-(20)',
      t0Case1RangeKm: 8.5, t0Case2RangeKm: 40.7,
      note: 'case split by Vs30 clustering; T=0 in paper units'
    },
    metrics: {}
  };
  for (const name of Object.keys(metrics)) {
    const m = metrics[name];
    const sv = binnedSemivariogram(events, m.pick, m.phiByModel);
    const fit = fitRange(sv.bins);
    out.metrics[name] = { rangeKm: fit ? fit.rangeKm : null, fitRmse: fit ? +fit.rmse.toFixed(4) : null,
      pairs: sv.pairsTotal, bins: sv.bins.map(b => ({ minKm: b.minKm, maxKm: b.maxKm, gamma: b.gamma == null ? null : +b.gamma.toFixed(3), pairs: b.pairs })) };
    console.log(`${name}: fitted range ${fit ? fit.rangeKm + ' km' : 'n/a'} (rmse ${fit && fit.rmse.toFixed(4)}), ${sv.pairsTotal} pairs`);
    for (const b of sv.bins) if (b.gamma != null) console.log(`  ${String(b.minKm).padStart(3)}-${String(b.maxKm).padStart(3)} km  gamma ${b.gamma.toFixed(3)}  (${b.pairs})`);
  }
  fs.writeFileSync('tools/data/spatial-correlation-report.json', JSON.stringify(out, null, 2) + '\n');
  console.log('wrote tools/data/spatial-correlation-report.json');
}

if (require.main === module) main();
module.exports = { binnedSemivariogram, fitRange, haversine };
