'use strict';
// psv-qd-detsub-series.js — the v16 subtraction payoff: the dk series with
// params.detSubtract on the QD field (the pole windows, fits and lattice
// all route through params.qdCompliance — the locator QD branch feeds the
// windows and the fits run on the clean integrand). Acceptance: on a
// RESOLVED field a correct subtraction is near-neutral (subtract+re-add is
// exact for the model component), so the series must match the plain QD
// series (v15: 1.243517/1.237305/1.236935/1.235870) within a few percent
// and stay below-floor converged; a disturbance would mean the fit table
// (the v12 thicket record) is still wrong. First run in a process pays the
// full QD dip scan (~25 min, cached per (stack, omega)).
//   node psv-qd-detsub-series.js <full|dev> <dkInvKm> <dhM>
const ROOT = require('path').join(__dirname, '..', '..');
const Physics = require(ROOT + '/public/physics.js');
const hybrid = require(ROOT + '/tools/broadband/hybrid.js');
const psv = require(ROOT + '/tools/broadband/psv.js');

Physics.setJivsmColumns(JSON.parse(require('fs').readFileSync(ROOT + '/public/geojson/jivsm-columns.json', 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = 2 * Math.PI * 0.5, zs = 73;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
const t = process.argv[2] === 'dev'
  ? { mxx: M.xx, myy: M.yy, mzz: 0, mxy: M.xy, mxz: 0, myz: 0 }
  : { mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz };
const dk = +process.argv[3], dh = +process.argv[4];
const p = Object.assign({ rKm, zSourceKm: zs, dkInvKm: dk, kMaxInvKm: 5, qShear: 50,
  mxx: t.mxx, myy: t.myy, mzz: t.mzz, mxy: t.mxy, mxz: t.mxz, myz: t.myz,
  schurCompliance: 1, qdCompliance: 1, detSubtract: 1, dhM: dh });
const t0 = Date.now();
const r = psv.psvMomentSpectrumAtFrequency(stack, omega, p);
console.log(process.argv[2], 'dk' + dk, 'dh' + dh, '=', (r ? Math.hypot(r.ur[0], r.ur[1]) : NaN).toExponential(6),
  '(' + ((Date.now() - t0) / 1000).toFixed(0) + 's)');
