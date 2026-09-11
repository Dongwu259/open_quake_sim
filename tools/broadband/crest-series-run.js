#!/usr/bin/env node
'use strict';
// crest-series-run.js — v10 convergence measurement: the v9 frozen config
// (tokyo 0.5 Hz Mw7.7 zs=73 r=198.5) re-run with params.dhAdaptive across
// the dk series. Compares deviatoric (dh-insensitive control) and
// fullTensor (the divergent channel) with/without the cure.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const psv = require('./psv.js');

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const col = Physics.jivsmColumnAt(35.6812, 139.7671);
const stack = hybrid.buildJivsmIaspStack(col);
const omega = 2 * Math.PI * 0.5, zs = 73;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const az = hybrid.azimuthDeg(34.0, 140.5, 35.6812, 139.7671);
const m0 = Physics.seismicMoment(7.7);
const M = hybrid.dcMomentTensor(185, 55, 90, m0);
const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);

function run(t, dkInvKm, adaptive, schur) {
  const p = psv.psvMomentSpectrumAtFrequency(stack, omega, {
    rKm, zSourceKm: zs, mxx: t.mxx, myy: t.myy, mzz: t.mzz || 0, mxy: t.mxy || 0,
    mxz: t.mxz || 0, myz: t.myz || 0, dkInvKm, kMaxInvKm: 5, qShear: 50,
    dhAdaptive: adaptive ? 1 : undefined,
    schurCompliance: schur ? 1 : undefined
  });
  return { ur: Math.hypot(p.ur[0], p.ur[1]), uz: Math.hypot(p.uz[0], p.uz[1]), ut: Math.hypot(p.ut[0], p.ut[1]) };
}
const deviatoric = { mxx: M.xx, myy: M.yy, mxy: M.xy };
const full = { mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz };
const dks = [0.02, 0.005, 0.002, 0.001, 0.0005];
const mode = process.argv[2] || 'all'; // all | legacy | dhAdaptive | schur
const arms = mode === 'all' ? ['legacy', 'dhAdaptive', 'schur'] : [mode];
const out = {};
const outFile = path.join(ROOT, 'tools', 'data', 'crest-series-run.json');
if (fs.existsSync(outFile)) {
  try { Object.assign(out, JSON.parse(fs.readFileSync(outFile, 'utf8'))); } catch (e) {}
}
for (const label of arms) {
  out[label] = out[label] || {};
  for (const dk of dks) {
    if (out[label]['dk' + dk] && mode === 'all') continue;
    const t0 = Date.now();
    const d = run(deviatoric, dk, label === 'dhAdaptive', label === 'schur');
    const f = run(full, dk, label === 'dhAdaptive', label === 'schur');
    out[label]['dk' + dk] = {
      deviatoricUr: +d.ur.toPrecision(6), fullTensorUr: +f.ur.toPrecision(6),
      fullTensorUz: +f.uz.toPrecision(6),
      minutes: +((Date.now() - t0) / 60000).toFixed(1)
    };
    console.log(label, 'dk', dk, JSON.stringify(out[label]['dk' + dk]));
    fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  }
}
console.log('DONE');
