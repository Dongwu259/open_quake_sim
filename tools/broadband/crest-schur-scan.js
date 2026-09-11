'use strict';
// crest-schur-scan.js — sample-level wildness scan of the SCHUR-compliance
// integrand on the frozen band config (tokyo 0.5 Hz, zs=73, q50), before
// any quadrature work: if the validated Schur integrand still decorrelates
// at 1e-5/km offsets the cure is NOT pole quadrature but another look at
// the depth-FD; if it is continuous, the sub-grid-pole diagnosis stands.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const psv = require('./psv.js');

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = 2 * Math.PI * 0.5, zs = 73;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
const full = { rKm, zSourceKm: zs, mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.myz, kMaxInvKm: 5, qShear: 50, schurCompliance: 1 };
const dev = Object.assign({}, full, { mzz: 0, mxz: 0, myz: 0 });

const g = (params, k) => {
  const r = psv.psvIntegrandAtK(stack, omega, k, params);
  return r ? Math.hypot(r.ur[0], r.ur[1]) : NaN;
};
const magC = (c) => Math.hypot(c[0], c[1]);

console.log('== Schur integrand: continuity discriminator (offsets 1e-5, 1e-4, 1e-3 /km) ==');
for (const [tag, params] of [['full', full], ['dev', dev]]) {
  for (const kKm of [0.44, 0.46, 0.50, 0.5112, 0.5187, 0.5242, 0.5295, 0.55, 0.58]) {
    const k = kKm / 1000;
    const g0 = g(params, k);
    if (!isFinite(g0)) { console.log(tag, kKm, 'g0 non-finite'); continue; }
    const row = [1e-5, 1e-4, 1e-3].map((off) => {
      const gp = g(params, k + off / 1000), gm = g(params, Math.max(k - off / 1000, 1e-9));
      const r = (x) => (isFinite(x) ? (Math.hypot(x - g0, 0) / g0) : NaN);
      return [off, r(gp), r(gm)];
    });
    console.log(tag, kKm.toFixed(4), 'g0', g0.toExponential(3),
      row.map(([o, rp, gm]) => '+' + o + ':' + (isFinite(rp) ? rp.toFixed(3) : 'NaN') + '/-' + o + ':' + (isFinite(gm) ? gm.toFixed(3) : 'NaN')).join(' '));
  }
}

console.log('== Schur compliance |C| and depth-FD channels across the band (dh 0.5 m vs 4 m) ==');
for (const kKm of [0.44, 0.50, 0.5112, 0.5187, 0.5242, 0.5295, 0.55]) {
  const k = kKm / 1000;
  const C = psv.psvSchurCompliance(stack, omega, k, zs, { qShear: 50, qP: 50 });
  if (!C) { console.log(kKm, 'C null'); continue; }
  const mC = Math.max(...C.flat().map((v) => Math.hypot(v[0], v[1])));
  for (const dh of [0.5, 4]) {
    const Cup = psv.psvSchurCompliance(stack, omega, k, zs - dh / 1000, { qShear: 50, qP: 50 });
    const Cdn = psv.psvSchurCompliance(stack, omega, k, zs + dh / 1000, { qShear: 50, qP: 50 });
    if (!Cup || !Cdn) { console.log(kKm, 'dh', dh, 'null'); continue; }
    // dCr0 = (Cdn[0][0]-Cup[0][0])/(2dh) — the deepest-amplified channel
    const dCr0 = [(Cdn[0][0][0] - Cup[0][0][0]) / (2 * dh), (Cdn[0][0][1] - Cup[0][0][1]) / (2 * dh)];
    console.log('k', kKm.toFixed(4), 'dh', dh, '|C|', mC.toExponential(3), '|dCr0|', magC(dCr0).toExponential(3));
  }
}
