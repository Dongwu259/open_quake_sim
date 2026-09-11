#!/usr/bin/env node
'use strict';
// crest-noise-probe.js — discriminator: PHYSICAL resonance vs CHAIN NOISE.
// A true damped resonance at k0 with damping floor gamma >= k/(2Q) = 0.0052/km
// (qP=qS=50) is CONTINUOUS on scales delta << gamma: |g(k0 +/- delta)| must
// agree to O(delta/gamma) ~ 0.2% for delta = 1e-5/km. Chain conditioning
// noise (near-degenerate residual basis) decorrelates at the float-noise
// scale instead. Probe both the spiky zone and a smooth control.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const psv = require('./psv.js');

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const col = Physics.jivsmColumnAt(35.6812, 139.7671);
const stack = hybrid.buildJivsmIaspStack(col);
const omega = 2 * Math.PI * 0.5, zs = 73, rKm = 198.5;
const az = hybrid.azimuthDeg(34.0, 140.5, 35.6812, 139.7671);
const m0 = Physics.seismicMoment(7.7);
const M = hybrid.dcMomentTensor(185, 55, 90, m0);
const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);
const base = { rKm, zSourceKm: zs, mxx: Mr.mxx, myy: Mr.myy, mzz: Mr.mzz, mxy: Mr.mxy, mxz: Mr.mxz, myz: Mr.myz, kMaxInvKm: 5, qShear: 50 };

function g(k) {
  const r = psv.psvIntegrandAtK(stack, omega, k / 1000, Object.assign({}, base));
  return r ? { ur: Math.hypot(r.ur[0], r.ur[1]), uz: Math.hypot(r.uz[0], r.uz[1]) } : null;
}
// also expose raw compliance magnitude at zs (no Bessel/J weighting) for the test
function cMag(k) {
  const ent = psv.psvSurfaceCompliance(stack, omega, k / 1000, zs, Object.assign({ qP: 50 }, base));
  let m = 0;
  for (const row of ent) for (const c of row) m = Math.max(m, Math.hypot(c[0], c[1]));
  return m;
}

const ks = [0.4400, 0.4602, 0.5112, 0.5187, 0.5242, 0.5295, 0.5320, 0.6200];
for (const k0 of ks) {
  console.log('\nk0 =', k0.toFixed(4), '/km   (gamma_material = k/(2*50) =', (k0 / 100).toFixed(5), '/km)');
  const base1 = g(k0), baseC = cMag(k0);
  console.log('  g(k0)      :', base1 ? ('ur ' + base1.ur.toExponential(4) + '  uz ' + base1.uz.toExponential(4)) : 'NULL', ' |C|', baseC === null ? 'FAIL' : baseC.toExponential(4));
  for (const d of [1e-5, 1e-4, 5e-4]) {
    const gp = g(k0 + d), gm = g(k0 - d);
    const cp = cMag(k0 + d), cm = cMag(k0 - d);
    const fmt = (x) => x == null ? 'NULL' : x.toExponential(3);
    console.log('  +-' + d + ': g(k+d) uz', fmt(gp && gp.uz), ' g(k-d) uz', fmt(gm && gm.uz),
      ' | ratio to base:', gp && base1 ? (gp.uz / base1.uz).toFixed(3) : '-', '/', gm && base1 ? (gm.uz / base1.uz).toFixed(3) : '-',
      ' |C|:', fmt(cp), fmt(cm));
  }
}
