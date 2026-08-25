#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.6 R1-3: exceedance-probability cross-check — the analytic
//  lognormal CCDF (Physics.exceedanceProbability, used by the station
//  popup/CSV paths) versus the empirical member fraction from the Monte
//  Carlo ensemble engine (Physics.ensembleIntensityField, the P10-P90
//  overlay path).
//
//  Apples-to-apples arm 'single-model': jitter OFF + one fixed GMPE, so a
//  member's PGA multiplier is exactly lognormal(0, sqrt(tau^2+phi^2)) in
//  ln space — the same distribution the analytic CCDF encodes. Gate:
//  pooled mean |P_emp - P_ana| within the binomial MC noise band.
//
//  Documentation arm 'deployed': jitter ON + logic-tree, the shipped
//  overlay configuration. Its spread is deliberately wider (epistemic
//  branches + M/depth/epicenter jitter on top of tau/phi) — reported as
//  a widening ratio, NOT gated.
//
//  Report -> tools/data/exceedance-crosscheck-report.json (always exit 0;
//  the tripwire lives in tests/ensemble.test.js).
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');
const Scorecard = require('./scorecard-strong-motion.js');

const ROOT = path.resolve(__dirname, '..');
const OBS_PATH = path.join(ROOT, 'public/geojson/strong-motion-obs.json');
const CAL_PATH = path.join(ROOT, 'public/geojson/gmpe-calibration.json');
const OUT_PATH = path.join(ROOT, 'tools/data/exceedance-crosscheck-report.json');

function exceedStats(vals, sigmaLog10, thresholds) {
  const n = vals.length;
  const median = vals[Math.floor(n / 2)];
  const out = [];
  for (const thr of thresholds) {
    if (!(thr > 0) || !(median > 0)) continue;
    const emp = vals.filter(v => v >= thr).length / n;
    const ana = Physics.exceedanceProbability(median, sigmaLog10, thr);
    out.push({ threshold: +thr.toFixed(2), pEmp: +emp.toFixed(4), pAna: +ana.toFixed(4),
      absDiff: +Math.abs(emp - ana).toFixed(4) });
  }
  return { median: +median.toFixed(2), points: out };
}

function main() {
  const obs = JSON.parse(fs.readFileSync(OBS_PATH, 'utf8'));
  Physics.setGmpeCalibration(JSON.parse(fs.readFileSync(CAL_PATH, 'utf8')));
  const hypos = Scorecard.loadJmaHypocenters();

  const arms = {
    'single-model': { jitter: false, fixedModel: true, note: 'jitter OFF, one GMPE — member multipliers exactly lognormal(tau,phi); gated against the analytic CCDF' },
    'deployed': { jitter: true, fixedModel: false, note: 'jitter ON + logic-tree — the shipped overlay config; spread widened by epistemic branches + M/depth/epicenter jitter (reported, not gated)' }
  };
  const report = { meta: { generatedBy: 'tools/crosscheck-exceedance.js', members: 200, thresholdsRel: [0.5, 1, 2], thresholdsGal: [80, 250] }, arms: {} };

  for (const [armName, cfg] of Object.entries(arms)) {
    const diffs = [];
    let maxAbs = 0, worst = null;
    const perEvent = [];
    let lnHalfWidths = [], lnHalfWidthsAna = [];
    for (const ev0 of obs.events) {
      const h = hypos[ev0.eventId];
      if (!h) continue;
      const model = cfg.fixedModel
        ? Physics.resolveGmpModel('auto', ev0.sourceType, h.mw)
        : 'logic-tree';
      const ctx = { source: { lat: h.lat, lng: h.lng, mw: h.mw, depthKm: h.depthKm, sourceType: ev0.sourceType },
        geometry: null, gmpModel: model, options: {} };
      const sts = ev0.stations.filter((s, i) => i % 3 === 0 && s.pgaGal > 0)
        .map(s => ({ lat: s.lat, lng: s.lng, vs30: s.vs30 || 400 }));
      const res = Physics.ensembleIntensityField(ctx, sts,
        { members: 200, seed: 'xcheck-' + armName + '-' + ev0.eventId, jitter: cfg.jitter, keepPga: true });
      const comp = Physics.getGmpSigmaComponents(cfg.fixedModel ? model : Physics.resolveGmpModel('auto', ev0.sourceType, h.mw), ev0.sourceType);
      const sigmaT = comp.sigmaT || 0.3;
      let evDiff = 0, evN = 0;
      for (const row of res.perStation) {
        const vals = row.pgaMembers;
        if (!vals || vals.length < 100) continue;
        const med = vals[Math.floor(vals.length / 2)];
        const st = exceedStats(vals, sigmaT, [med * 0.5, med, med * 2, 80, 250]);
        for (const p of st.points) { diffs.push(p.absDiff); evDiff += p.absDiff; evN++; if (p.absDiff > maxAbs) { maxAbs = p.absDiff; worst = p; } }
        // spread diagnostics (ln half-widths of the central 68%)
        const lo = vals[Math.floor(vals.length * 0.16)], hi = vals[Math.floor(vals.length * 0.84)];
        if (lo > 0 && hi > 0) lnHalfWidths.push(Math.log(hi / lo) / 2);
        if (cfg.fixedModel) lnHalfWidthsAna.push(sigmaT * Math.log(10));
      }
      perEvent.push({ eventId: ev0.eventId, meanAbsDiff: +(evDiff / Math.max(1, evN)).toFixed(4), n: evN });
    }
    const mean = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1);
    const mcTol = 1.96 * Math.sqrt(0.25 / 200); // binomial worst-case at p=0.5
    report.arms[armName] = {
      config: cfg.note,
      pooled: { nPoints: diffs.length, meanAbsDiff: +mean.toFixed(4), maxAbsDiff: +maxAbs.toFixed(4), mcTolerance95: +mcTol.toFixed(4) },
      worst: worst, perEvent,
      spread: {
        empiricalLn68HalfWidthMedian: lnHalfWidths.length ? +lnHalfWidths.sort((a, b) => a - b)[Math.floor(lnHalfWidths.length / 2)].toFixed(3) : null,
        analyticLn68HalfWidthMedian: lnHalfWidthsAna.length ? +lnHalfWidthsAna.sort((a, b) => a - b)[Math.floor(lnHalfWidthsAna.length / 2)].toFixed(3) : null
      }
    };
    console.log(armName.padEnd(13),
      'mean|dP|', mean.toFixed(4), 'max', maxAbs.toFixed(4), '(mc95', mcTol.toFixed(4) + ')',
      '| ln68 half-width emp', report.arms[armName].spread.empiricalLn68HalfWidthMedian,
      'ana', report.arms[armName].spread.analyticLn68HalfWidthMedian);
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 1));
  console.log('report ->', OUT_PATH);
}

if (require.main === module) main();
module.exports = { exceedStats };
