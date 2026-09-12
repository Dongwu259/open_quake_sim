'use strict';
// psv-qd-series.js — the v15 payoff measurement: the dk series on the QD
// field (tools/broadband/psv-qd.js chain, params.qdCompliance), testing
// dh invariance (the v13 "dh = noise-realization knob" verdict must die on
// a resolvable field) and dk convergence of the fullTensor channel.
// Results are frozen into tools/data/psv-scale-diagnosis.json
// layeredContext.qdSeriesUrm as literals with this provenance — the run
// costs ~40+ min, so the probe does NOT re-measure it live; re-run this
// driver to re-verify.
const ROOT = require('path').join(__dirname, '..', '..');
const Physics = require(ROOT + '/public/physics.js');
const hybrid = require(ROOT + '/tools/broadband/hybrid.js');
const psv = require(ROOT + '/tools/broadband/psv.js');

Physics.setJivsmColumns(JSON.parse(require('fs').readFileSync(ROOT + '/public/geojson/jivsm-columns.json', 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = 2 * Math.PI * 0.5, zs = 73;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
const deviatoric = { mxx: M.xx, myy: M.yy, mxy: M.xy };
const full = { mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz };
const mag = (p) => { const r = psv.psvMomentSpectrumAtFrequency(stack, omega, p); return r ? Math.hypot(r.ur[0], r.ur[1]) : NaN; };

function run(label, t, dk, dh) {
  const p = Object.assign({ rKm, zSourceKm: zs, dkInvKm: dk, kMaxInvKm: 5, qShear: 50,
    mxx: t.mxx, myy: t.myy, mzz: t.mzz || 0, mxy: t.mxy || 0, mxz: t.mxz || 0, myz: t.myz || 0,
    schurCompliance: 1, qdCompliance: 1, dhM: dh });
  const t0 = Date.now();
  const v = mag(p);
  console.log(label, 'dk' + dk, 'dh' + dh, '=', v.toExponential(6), '(' + ((Date.now() - t0) / 1000).toFixed(0) + 's)');
  return v;
}

// single-run mode (the v15 batch measurement ran the grid as parallel
// single-run processes — one QD chain saturates one core, ~20-90 min/run):
//   node psv-qd-series.js <full|dev> <dkInvKm> <dhM>
if (process.argv.length >= 5) {
  const t = process.argv[2] === 'dev' ? deviatoric : full;
  run(process.argv[2], t, +process.argv[3], +process.argv[4]);
} else {
  const out = { fullTensor: {}, deviatoric: {} };
  for (const dh of [0.5, 2, 16, 32, 64]) {
    out.fullTensor['dh' + String(dh).replace('.', 'p')] = { dk0p02: run('full', full, 0.02, dh) };
  }
  for (const dh of [0.5, 32]) {
    out.fullTensor['dh' + String(dh).replace('.', 'p')].dk0p002 = run('full', full, 0.002, dh);
  }
  out.deviatoric.dh0p5 = { dk0p02: run('dev', deviatoric, 0.02, 0.5), dk0p002: run('dev', deviatoric, 0.002, 0.5) };
  out.deviatoric.dh32 = { dk0p02: run('dev', deviatoric, 0.02, 32) };
  console.log('JSON:' + JSON.stringify(out));
}
