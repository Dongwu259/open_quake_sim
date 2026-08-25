#!/usr/bin/env node
'use strict';
// ================================================================
//  GMPE logic-tree weights from Scherbaum-style LLH model selection
//  (R1, 2026-08-24).
//
//  For each tectonic class present in the frozen 13-event station set,
//  every candidate model (si-midorikawa / zhao2006 / kanno2006) is FORCED
//  onto all of that class's events (JMA-catalog hypocenters) and scored by
//  the average log-likelihood of the observed ln PGA under a lognormal
//  predictive distribution (median = model prediction, total sigma = the
//  model's fitted ln-PGA sigmaT from tools/data/sigma-components-report.json,
//  in-sample caveat documented). Weights are Delavaud information weights
//  w ∝ exp(-(LLH - LLH_min)), normalized to 1.
//
//  LLH = -(1/N) Σ ln N(r_i | 0, sigma) on ln-PGA residuals r_i (Scherbaum
//  et al. 2004); lower LLH = better predictive distribution.
//
//  Output: tools/data/logic-tree-weights.json — frozen; embedded in
//  public/physics.js GMPE_LOGIC_TREE.
//
//  Usage: node tools/fit-logic-tree-weights.js
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');
const Scorecard = require('./scorecard-strong-motion.js');

const MODELS = ['si-midorikawa', 'zhao2006', 'kanno2006'];

function normalPdfLn(x, sigma) {
  return -0.5 * Math.log(2 * Math.PI) - Math.log(sigma) - (x * x) / (2 * sigma * sigma);
}

function main() {
  const obs = JSON.parse(fs.readFileSync('public/geojson/strong-motion-obs.json', 'utf8'));
  const calibration = JSON.parse(fs.readFileSync(path.join('public', 'geojson', 'gmpe-calibration.json'), 'utf8'));
  const sigmaRep = JSON.parse(fs.readFileSync('tools/data/sigma-components-report.json', 'utf8'));

  const jmaHypos = Scorecard.loadJmaHypocenters();
  Physics.setGmpeCalibration(calibration);
  // ln-PGA residuals are calibration-independent (calibrateIntensity only
  // shifts intensity), so the table state only matters for intensity fields
  // we do not use here.

  // Group frozen events by the app's tectonic class.
  const byClass = {};
  for (const ev0 of obs.events) {
    const h = jmaHypos[ev0.eventId];
    if (!h) throw new Error('no JMA hypocenter for ' + ev0.eventId);
    const ev = Object.assign({}, ev0, { lat: h.lat, lng: h.lng, depthKm: h.depthKm, mw: h.mw });
    (byClass[ev.sourceType] = byClass[ev.sourceType] || []).push(ev);
  }

  const classes = {};
  for (const cls of Object.keys(byClass)) {
    const events = byClass[cls];
    const N = events.reduce((n, e) => n + e.stations.length, 0);
    const rows = MODELS.map(m => {
      const sigma = sigmaRep.models[m].lnPga.sigmaT;
      let sum = 0;
      for (const ev of events) {
        for (const st of ev.stations) {
          const pred = Scorecard.predictStation(ev, st, m);
          sum += normalPdfLn(Math.log(pred.pga / st.pgaGal), sigma);
        }
      }
      return { model: m, sigmaLnPga: +sigma.toFixed(3), llh: -(sum / N) };
    });
    const llhMin = Math.min(...rows.map(r => r.llh));
    let wsum = 0;
    for (const r of rows) { r.weight = Math.exp(-(r.llh - llhMin)); wsum += r.weight; }
    for (const r of rows) r.weight = +(r.weight / wsum).toFixed(4);
    rows.sort((a, b) => b.weight - a.weight);
    classes[cls] = { events: events.length, stations: N,
      eventsUsed: events.map(e => e.eventId), branches: rows };
    console.log(`${cls} (${events.length} events, ${N} stations)`);
    for (const r of rows) console.log(`  ${r.model.padEnd(15)} LLH ${r.llh.toFixed(4)}  sigma ${r.sigmaLnPga}  weight ${r.weight}`);
  }
  Physics.setGmpeCalibration(null);

  const report = {
    schema: 'quake-sim-logic-tree-weights-v1',
    generatedAt: new Date().toISOString(),
    method: 'Scherbaum et al. (2004) LLH on ln-PGA residuals with per-model fitted total sigma '
      + '(tools/data/sigma-components-report.json, in-sample sigma caveat); Delavaud information '
      + 'weights w ∝ exp(-(LLH - LLH_min)); forced-model predictions on every event of the class; '
      + 'JMA-catalog hypocenters',
    classes
  };
  fs.writeFileSync('tools/data/logic-tree-weights.json', JSON.stringify(report, null, 2) + '\n');
  console.log('wrote tools/data/logic-tree-weights.json');
}

if (require.main === module) main();
module.exports = { normalPdfLn };
