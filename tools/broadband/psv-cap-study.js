'use strict';
// fullTensor cap-closure measurement (v8 batch): post-triMul-fix dk series
// at tightened subdivide caps. Question: does the fullTensor series converge
// at cap <= 10, and do cap 6 / cap 4 agree (cap-converged regime)?
const fs = require('fs');
const path = require('path');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const psv = require('./psv.js');
Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const col = Physics.jivsmColumnAt(35.6812, 139.7671);
const stack = hybrid.buildJivsmIaspStack(col);
const om = 2 * Math.PI * 0.5, zs = 73;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const az = hybrid.azimuthDeg(34.0, 140.5, 35.6812, 139.7671);
const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);
const TENSORS = {
  deviatoric: { mxx: M.xx, myy: M.yy, mxy: M.xy },
  fullTensor: { mxx: Mr.mxx, myy: Mr.myy, mzz: Mr.mzz, mxy: Mr.mxy, mxz: Mr.mxz, myz: Mr.myz }
};
const DKS = [0.02, 0.002, 0.001, 0.0005];
function series(t, cap) {
  const out = [];
  for (const dk of DKS) {
    const p = psv.psvMomentSpectrumAtFrequency(stack, om, {
      rKm, zSourceKm: zs, mxx: t.mxx, myy: t.myy, mzz: t.mzz || 0, mxy: t.mxy || 0,
      mxz: t.mxz || 0, myz: t.myz || 0, dkInvKm: dk, kMaxInvKm: 5, qShear: 50, _subCap: cap });
    out.push(Math.hypot(p.ur[0], p.ur[1]));
  }
  return out;
}
const result = { startedAt: new Date().toISOString(), caps: {} };
for (const cap of [10, 6, 4]) {
  result.caps['cap' + cap] = {};
  for (const [label, t] of Object.entries(TENSORS)) {
    const s = series(t, cap);
    result.caps['cap' + cap][label] = s.map((v) => +v.toPrecision(6));
    const below = s.slice(1); // dk 0.002/0.001/0.0005 (below the alias floor)
    result.caps['cap' + cap][label + 'BelowSpread'] = +(Math.max(...below) / Math.min(...below)).toFixed(4);
    console.error(`cap${cap} ${label}: ${s.map((v) => v.toExponential(4)).join(' ')} spread(below) ${result.caps['cap' + cap][label + 'BelowSpread']}`);
  }
  fs.writeFileSync(path.join(__dirname, 'psv-cap-study.tmp.json'), JSON.stringify(result, null, 1));
}
// cross-cap agreement of the fullTensor series at the finest dk
const f10 = result.caps.cap10.fullTensor, f6 = result.caps.cap6.fullTensor, f4 = result.caps.cap4.fullTensor;
result.crossCap = {
  cap10_vs_cap6_dk0005: +(f10[3] / f6[3]).toPrecision(4),
  cap6_vs_cap4_dk0005: +(f6[3] / f4[3]).toPrecision(4),
  cap10_vs_cap6_dk002: +(f10[1] / f6[1]).toPrecision(4),
  cap6_vs_cap4_dk002: +(f6[1] / f4[1]).toPrecision(4)
};
console.error('crossCap', JSON.stringify(result.crossCap));
result.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(__dirname, 'psv-cap-study.tmp.json'), JSON.stringify(result, null, 1));
console.log('DONE');
