#!/usr/bin/env node
'use strict';
// crest-dh-probe.js — mechanism test: the dipole channels use a depth
// finite-difference dC = (Cdn - Cup)/(2*dh). If the crest spikes are chain
// residual-direction noise amplified by the 1/(2dh) factor, enlarging the
// FD stencil (dh 0.5 -> 20 m, truncation still negligible vs km-scale
// fields) must collapse them; a physical depth-derivative resonance would
// be dh-independent.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const core = require('./core.js');
const psv = require('./psv.js');

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const col = Physics.jivsmColumnAt(35.6812, 139.7671);
const stack = hybrid.buildJivsmIaspStack(col);
const omega = 2 * Math.PI * 0.5, zs = 73, rKm = 198.5;
const az = hybrid.azimuthDeg(34.0, 140.5, 35.6812, 139.7671);
const m0 = Physics.seismicMoment(7.7);
const M = hybrid.dcMomentTensor(185, 55, 90, m0);
const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);

function g(kKm, dhM) {
  const r = psv.psvIntegrandAtK(stack, omega, kKm / 1000, {
    rKm, zSourceKm: zs, mxx: Mr.mxx, myy: Mr.myy, mzz: Mr.mzz, mxy: Mr.mxy,
    mxz: Mr.mxz, myz: Mr.myz, kMaxInvKm: 5, qShear: 50, dhM
  });
  return r ? { ur: Math.hypot(r.ur[0], r.ur[1]), uz: Math.hypot(r.uz[0], r.uz[1]) } : null;
}
const ks = [0.4400, 0.4602, 0.5067, 0.5112, 0.5142, 0.5187, 0.5205, 0.5242, 0.5295, 0.5320, 0.5405, 0.5500];
for (const k0 of ks) {
  const line = ['k=' + k0.toFixed(4)];
  for (const dh of [0.5, 2, 5, 20]) {
    const r = g(k0, dh);
    line.push('dh' + dh + ':' + (r ? ('uz ' + r.uz.toExponential(3)) : 'NULL'));
  }
  console.log(line.join('  '));
}
