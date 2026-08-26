#!/usr/bin/env node
// Offline dynamic-rupture experiment runner (R6-2, v6.0).
// Usage:
//   node tools/dynamic-rupture/run-experiment.js --suite=all|tpv5|sh|psv [--write]
// --write freezes the report to tools/data/dynamic-rupture-report.json
// (the npm-test tripwire re-asserts the frozen gates from that file).
//
// Provenance: SCEC TPV5 official description (TPV5_forwebsite.pdf, Aug 4
// 2005 version) fetched 2026-08-26 from strike.scec.org/cvws and archived
// locally; official station reference solutions are login-gated on the CVWS
// viewer (docs/CVWS-UPLOAD.md records the user-action runbook).
'use strict';
const fs = require('fs');
const path = require('path');
const { TPV5, makeTpv5Ap, makeShSpont, makePsvSpont, rayleighSpeed } = require('./configs.js');
const { exportFiniteFault } = require('./export-finite-fault.js');

// advance with per-node rise-time tracking (|V| falling under 0.05 m/s
// after rupture; capped at the run length)
function advance(S, tEnd, sampleSpecs, sampleEvery) {
  const rise = new Float64Array(S.nz);
  const stations = sampleSpecs.map(s => ({ name: s.name, z: s.z, series: [] }));
  let t = 0;
  const n = Math.round(tEnd / S.dt);
  // sampleEvery is in SECONDS — convert to a step stride
  const every = Math.max(1, Math.round((sampleEvery || 0.1) / S.dt));
  for (let k = 0; k < n; k++) {
    t = S.step(t);
    for (let j = 0; j < S.nz; j++) {
      if (S.rupTime[j] > 0 && rise[j] === 0 && Math.abs(S.slipRate[j]) < 0.05
        && t - S.rupTime[j] > 0.05) rise[j] = t - S.rupTime[j];
    }
    if (k % every === 0) {
      for (const st of stations) {
        const s = S.sample(st.z);
        st.series.push([+t.toFixed(3), +s.slip.toFixed(4), +s.slipRate.toFixed(4), +(s.trac / 1e6).toFixed(3)]);
      }
    }
  }
  S.riseTime = rise;
  return { t, stations };
}

function frontSpeed(S, zA, zB) {
  const a = S.sample(zA), b = S.sample(zB);
  if (!(a.rupTime > 0) || !(b.rupTime > 0)) return null;
  return Math.abs(zB - zA) / Math.abs(b.rupTime - a.rupTime);
}

function runTpv5Ap(dx, tEnd) {
  const S = makeTpv5Ap({ dx, mediumHalf: 24000 });
  const specs = [750, 1500, 3000, 4500, 6000, 7500, 9000, 10500, 12000, 13500]
    .map(d => ({ name: 'faultst000dp' + String(d / 1000).padStart(3, '0'), z: d }));
  const { t, stations } = advance(S, tEnd, specs, 0.1);
  let maxSlip = 0, areaM2 = 0, momentNm = 0, hypo = null;
  for (let j = 0; j < S.nz; j++) {
    const z = S.zOf(j);
    if (z < S.dx / 2) continue;
    if (S.slip[j] > 0) { maxSlip = Math.max(maxSlip, S.slip[j]); momentNm += S.mu * S.dx * S.dx * S.slip[j]; }
    if (Math.abs(z - 7500) < S.dx / 2) hypo = S.sample(7500);
  }
  return {
    solver: 'sh-fd-tsn', dx, tEndS: tEnd, cs: TPV5.vs,
    downDipSpeed: frontSpeed(S, 9000, 12000),   // same side of the hypocenter
    upDipSpeed: frontSpeed(S, 6000, 3000),      // (opposite-side pairs double-count)
    maxSlipM: maxSlip, momentNm, hypoSlipM: hypo ? hypo.slip : null,
    stationSeries: stations
  };
}

function runShSpont(dx) {
  const S = makeShSpont({ dx, halfLen: 3000, xHalf: 12000, zHalf: 16000, nucHalf: 800 });
  const { t } = advance(S, 5.0, [], 1);
  let center = 0, maxSlip = 0, momentNm = 0;
  for (let j = 0; j < S.nz; j++) {
    if (S.slip[j] > 0) { maxSlip = Math.max(maxSlip, Math.abs(S.slip[j])); momentNm += S.mu * S.dx * S.dx * Math.abs(S.slip[j]); }
    if (Math.abs(S.zOf(j)) < S.dx / 2) center = S.slip[j];
  }
  return { dx, centerSlipM: center, maxSlipM: maxSlip, momentNm,
    frontSpeed: frontSpeed(S, 1500, 2500), cs: 3464 };
}

function runPsvSpont(Sval) {
  const S = makePsvSpont({ dx: 100, halfLen: 6000, zHalf: 16000, xHalf: 12000, S: Sval });
  const { t } = advance(S, 3.0, [], 1);
  let nRup = 0, nWin = 0, maxSlip = 0;
  for (let j = 0; j < S.nz; j++) if (S.fl[j]) {
    nWin++;
    if (S.rupTime[j] > 0) { nRup++; maxSlip = Math.max(maxSlip, Math.abs(S.slip[j])); }
  }
  return { S: Sval, dx: 100, rupturedFraction: nRup / nWin, maxSlipM: maxSlip,
    frontSpeed1000_2500: frontSpeed(S, 1000, 2500), cs: 3464, cR: rayleighSpeed(6000, 3464) };
}

function main() {
  const args = process.argv.slice(2);
  const suite = (args.find(a => a.startsWith('--suite=')) || '--suite=all').split('=')[1];
  const write = args.includes('--write');
  const report = {
    schema: 'quake-sim-dynamic-rupture-report-v1',
    generated: new Date().toISOString(),
    provenance: {
      tpv5: 'SCEC TPV5 official description v2005-08-04 (strike.scec.org/cvws, TPV5_forwebsite.pdf), 2D anti-plane reduction (TPV5-AP); along-strike stress patches not representable',
      references: 'Official CVWS station references are login-gated; verification anchors are analytic (radiation damping μ/2cs, static dislocation kernel, discrete energy closure) — see tests/dynamic-rupture.test.js'
    },
    experiments: {}
  };
  const t0 = Date.now();
  if (suite === 'all' || suite === 'tpv5') {
    console.log('TPV5-AP halfspace dx=100 t=15s ...');
    const t1 = Date.now();
    report.experiments.tpv5apHalfspace = runTpv5Ap(100, 15.0);
    console.log('  done in', ((Date.now() - t1) / 1000).toFixed(0) + 's; v_down =',
      report.experiments.tpv5apHalfspace.downDipSpeed && report.experiments.tpv5apHalfspace.downDipSpeed.toFixed(0), 'm/s');
  }
  if (suite === 'all' || suite === 'sh') {
    console.log('SH spontaneous dx=100/50 (convergence pair) ...');
    report.experiments.shSpont = { dx100: runShSpont(100), dx50: runShSpont(50) };
    const a = report.experiments.shSpont;
    console.log('  center slip', a.dx100.centerSlipM.toFixed(2), '/', a.dx50.centerSlipM.toFixed(2),
      'm; v_front', a.dx100.frontSpeed.toFixed(0), '/', a.dx50.frontSpeed.toFixed(0));
  }
  if (suite === 'all' || suite === 'psv') {
    console.log('PSV spontaneous S=1.57 / S=2.0 ...');
    report.experiments.psvSpont = { S157: runPsvSpont(1.57), S20: runPsvSpont(2.0) };
    for (const k of Object.keys(report.experiments.psvSpont)) {
      const r = report.experiments.psvSpont[k];
      console.log('  ' + k + ' ruptured ' + (r.rupturedFraction * 100).toFixed(0) + '%, front ' +
        (r.frontSpeed1000_2500 ? r.frontSpeed1000_2500.toFixed(0) : 'n/a') + ' m/s (cR=' + r.cR.toFixed(0) + ')');
    }
  }
  // finite-fault-v1 export demo from the SH spontaneous run
  if (suite === 'all' || suite === 'sh' || suite === 'tpv5') {
    const S = makeShSpont({ dx: 100, halfLen: 3000, xHalf: 12000, zHalf: 16000, nucHalf: 800 });
    advance(S, 5.0, [], 1);
    const doc = exportFiniteFault(S, { hypoLat: 35.5, hypoLng: 139.5, alongStrikeKm: 30, label: 'sh-spont', eventId: 'DYNRUP-SH-001' });
    report.export = { patches: doc.patches.length, mw: +doc.event.mw.toFixed(3), totalMomentNm: doc.event.momentNm };
    report.exportSample = doc;
  }
  report.runtimeSec = +((Date.now() - t0) / 1000).toFixed(1);
  if (write) {
    const out = path.join(__dirname, '..', 'data', 'dynamic-rupture-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    console.log('written', out, '(' + report.runtimeSec + 's)');
  } else {
    console.log(JSON.stringify({ ...report, exportSample: undefined }, null, 1).slice(0, 2500));
  }
}

if (require.main === module) main();
module.exports = { advance, frontSpeed, runTpv5Ap, runShSpont, runPsvSpont };
