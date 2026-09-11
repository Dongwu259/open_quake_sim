#!/usr/bin/env node
'use strict';
// crest-diagnose.js — v9 fullTensor divergence diagnosis (step 1):
// characterise the leaky-P crest band on the frozen v9 config:
//   tokyo JIVSM+IASP91 stack, 0.5 Hz, zs=73 km, r=198.5 km, qShear=50 (qP default),
//   Mw 7.7 DC(185/55/90) rotated to az -19.5.
// Reports: detector poleList, |ur|/|uz| profile across [0.40, 0.70]/km,
// peak widths, guard-null census, channel composition.
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

const fHz = 0.5, omega = 2 * Math.PI * fHz, mW = 7.7, zs = 73;
const srcLat = 34.0, srcLng = 140.5, recLat = 35.6812, recLng = 139.7671;
const rKm = Physics.haversineDist(srcLat, srcLng, recLat, recLng);
const az = hybrid.azimuthDeg(srcLat, srcLng, recLat, recLng);
const m0 = Physics.seismicMoment(mW);
const M = hybrid.dcMomentTensor(185, 55, 90, m0);
const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);

const base = {
  rKm, zSourceKm: zs, mxx: Mr.mxx, myy: Mr.myy, mzz: Mr.mzz, mxy: Mr.mxy,
  mxz: Mr.mxz, myz: Mr.myz, kMaxInvKm: 5, qShear: 50
};

const t0 = Date.now();
const g1 = psv.psvIntegrandAtK(stack, omega, 0.5 / 1000, Object.assign({}, base));
console.log('single integrand call:', Date.now() - t0, 'ms |', g1 ? 'ok' : 'null');
if (g1) console.log('  |ur|', Math.hypot(g1.ur[0], g1.ur[1]).toExponential(3),
  '|uz|', Math.hypot(g1.uz[0], g1.uz[1]).toExponential(3),
  '|ut|', Math.hypot(g1.ut[0], g1.ut[1]).toExponential(3));

const poleList = psv.psvModalPoles(stack, omega, 5, Object.assign({}, base));
console.log('\npoleList (' + poleList.length + ' entries):');
for (const p of poleList) {
  console.log('  k =', (p.k / 1000).toFixed(4), '/km  gamma =', (p.gammaKm / 1000).toExponential(3), '/km  refined:', p.refined);
}

// ---- band scan ------------------------------------------------------------
const kLo = 0.40, kHi = 0.70, step = 2.5e-4; // 1/km
const rows = [];
const t1 = Date.now();
for (let k = kLo; k <= kHi + 1e-12; k += step) {
  const g = psv.psvIntegrandAtK(stack, omega, k / 1000, Object.assign({}, base));
  rows.push({
    k, g,
    ur: g ? Math.hypot(g.ur[0], g.ur[1]) : 0,
    uz: g ? Math.hypot(g.uz[0], g.uz[1]) : 0,
    ut: g ? Math.hypot(g.ut[0], g.ut[1]) : 0,
    nulled: !g
  });
}
console.log('\nband scan', kLo, '-', kHi, '/km @', step, '/km:', rows.length, 'pts in', ((Date.now() - t1) / 1000).toFixed(1), 's');

// peak census per channel (local maxima above 10x median)
function census(name) {
  const vals = rows.map((r) => r[name]);
  const sorted = vals.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const peaks = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const v = rows[i][name];
    if (v > rows[i - 1][name] && v >= rows[i + 1][name] && v > 10 * med && v > 0) {
      if (peaks.length && rows[i].k - peaks[peaks.length - 1].k < 4 * step) {
        if (v > peaks[peaks.length - 1].v) { peaks[peaks.length - 1] = { k: rows[i].k, v }; }
        continue;
      }
      peaks.push({ k: rows[i].k, v });
    }
  }
  console.log('\n[' + name + '] median', med.toExponential(3), '| peaks > 10x median:');
  for (const p of peaks) {
    // walk HWHM
    const half = p.v / 2;
    let l = p.k, r = p.k;
    const idx = (kk) => Math.round((kk - kLo) / step);
    while (idx(l) > 0 && rows[idx(l)][name] > half) l -= step;
    while (idx(r) < rows.length - 1 && rows[idx(r)][name] > half) r += step;
    console.log('  peak @', p.k.toFixed(4), '/km  |v|', p.v.toExponential(3), ' HWHM~', ((r - l) / 2).toExponential(2), '/km  v*FWHM~', (p.v * (r - l)).toExponential(3));
  }
}
census('ur'); census('uz'); census('ut');

// null census
const nulls = rows.filter((r) => r.nulled).map((r) => r.k);
console.log('\nnulled samples:', nulls.length, nulls.length ? '(' + nulls[0].toFixed(4) + ' .. ' + nulls[nulls.length - 1].toFixed(4) + ')' : '');

// coarse trapezoid of the band per channel vs the machinery at two dks
function trap(name) {
  let s = 0;
  for (let i = 1; i < rows.length; i++) s += 0.5 * (rows[i - 1][name] + rows[i][name]) * step / 1000;
  return s;
}
console.log('\nraw trapezoid over band (1/m units, this scan only): ur', trap('ur').toExponential(4), 'uz', trap('uz').toExponential(4), 'ut', trap('ut').toExponential(4));
