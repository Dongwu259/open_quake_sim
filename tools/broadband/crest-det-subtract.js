'use strict';
// crest-det-subtract.js — analytic det-based principal-value subtraction
// prototype (v11 registered cure, 2026-09-11). The Schur compliance is
// C = e^-sigma M^-1: near a k* with det M(k*) ~ 0 every integrand channel
// behaves as A/(k - kp) + B with a COMPLEX pole kp (Im kp = gamma, the
// mode loss). Recipe per pole:
//   1. locate det dips on a fine |detM| scan (the smooth factor — no 1/D
//      amplification);
//   2. fit (kp, A_c, B_c) on a geometric ladder of offsets around the dip
//      (outer 2D search on kp; inner 2x2 linear least squares per channel);
//   3. integrate g minus sum A_c/(k - kp) on the production-style two-zone
//      lattice, then add back each pole's EXACT complex-log integral
//      A_c [Log(kMax - kp) - Log(-kp)] (principal branch, Im kp > 0: no
//      branch crossing on the real axis).
// Verdict metric: the tokyo frozen-config dk series (frozen plain-Schur
// values 194.41/194.41/523.05/679.98 are non-converged).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const core = require('./core.js');
const hybrid = require('./hybrid.js');
const psv = require('./psv.js');
const { cadd, csub, cmul, cscale, cabs, cdiv } = core;

function logC(z) { // principal branch
  return [Math.log(cabs(z)), Math.atan2(z[1], z[0])];
}

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = 2 * Math.PI * 0.5, zs = 73;
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
const M0 = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
const base = {
  rKm, zSourceKm: zs, mxx: M0.xx, myy: M0.yy, mzz: M0.zz, mxy: M0.xy,
  mxz: M0.xz, myz: M0.yz, kMaxInvKm: 5, qShear: 50, schurCompliance: 1
};
const mag = (c) => Math.hypot(c[0], c[1]);

function gOf(kKm) {
  const g = psv.psvIntegrandAtK(stack, omega, kKm / 1000, base);
  return g ? { ur: g.ur, uz: g.uz, ut: g.ut } : null;
}
function detAt(kKm) {
  const r = psv.psvSchurCompliance(stack, omega, kKm / 1000, zs, { qShear: 50, qP: 50, _wantDet: true });
  return r ? Math.abs(r.detM ? cabs(r.detM) : 0) : NaN;
}

// ---- 1. det scan ---------------------------------------------------------
const scan0 = 0.35, scan1 = 0.75, scanStep = 1e-4; // /km
const det = new Array(Math.round((scan1 - scan0) / scanStep) + 1);
for (let i = 0; i < det.length; i++) det[i] = detAt(scan0 + i * scanStep);
const ldet = det.map((v) => (v > 0 ? Math.log(v) : -70));
const dips = [];
for (let i = 2; i < ldet.length - 2; i++) {
  if (ldet[i] < ldet[i - 1] && ldet[i] < ldet[i + 1] && ldet[i] < ldet[i - 2] && ldet[i] < ldet[i + 2]) {
    // prominence vs the mean of +-20 samples
    let bg = 0, n = 0;
    for (let j = Math.max(0, i - 200); j <= Math.min(ldet.length - 1, i + 200); j++) { bg += ldet[j]; n++; }
    const prom = (bg / n) - ldet[i];
    if (prom > 2) dips.push({ kKm: scan0 + i * scanStep, prom, idx: i });
  }
}
console.log('det dips (prominence > 2 ln):', dips.map((d) => d.kKm.toFixed(4)).join(' '));

// ---- 2. pole fit at each dip --------------------------------------------
// geometric offset ladder (1/m): W_0 x (1/2)^j
function fitPole(kDipKm) {
  const chans = ['ur', 'uz', 'ut'];
  let best = null;
  const W0 = 2e-5; // /m — inside the feature, outside the finest scale we trust
  const offs = [];
  for (let j = 0; j < 10; j++) offs.push(W0 * Math.pow(2, j)); // up to ~1e-2 /m
  const samples = [];
  for (const o of offs) {
    for (const s of [1, -1]) {
      const kKm = kDipKm + s * o * 1000;
      const g = gOf(kKm);
      if (g) samples.push({ k: kKm / 1000, g });
    }
  }
  if (samples.length < 8) return null;
  // outer search: kr over +-3e-5/m around the dip, ki over a ladder
  const kr0 = kDipKm / 1000;
  for (const krOff of [-3e-5, -1e-5, 0, 1e-5, 3e-5]) {
    for (const ki of [1e-8, 3e-8, 1e-7, 3e-7, 1e-6, 3e-6, 1e-5, 3e-5, 1e-4]) {
      const kp = [kr0 + krOff, ki];
      // inner linear LS per channel: g = A/(k-kp) + B
      let res = 0, norm = 0;
      const As = {};
      for (const ch of chans) {
        let s11 = [0, 0], s12 = [0, 0], s22 = [0, 0], t1 = [0, 0], t2 = [0, 0];
        for (const smp of samples) {
          const w = cdiv([1, 0], csub(smp.k, kp));
          const g = smp.g[ch];
          s11 = cadd(s11, cmul(w, w)); s12 = cadd(s12, w); s22 = cadd(s22, [1, 0]);
          t1 = cadd(t1, cmul(w, g)); t2 = cadd(t2, g);
        }
        const detS = csub(cmul(s11, s22), cmul(s12, s12));
        if (cabs(detS) < 1e-300) { res = NaN; break; }
        const A = cdiv(csub(cmul(t1, s22), cmul(t2, s12)), detS);
        const B = cdiv(csub(cmul(t2, s11), cmul(t1, s12)), detS);
        As[ch] = { A, B };
        for (const smp of samples) {
          const model = cadd(cdiv(A, csub(smp.k, kp)), B);
          res += Math.hypot(smp.g[ch][0] - model[0], smp.g[ch][1] - model[1]);
          norm += cabs(smp.g[ch]);
        }
      }
      if (!isFinite(res)) continue;
      if (!best || res / norm < best.rel) best = { kp, rel: res / norm, As };
    }
  }
  return best;
}
const poles = [];
for (const d of dips) {
  const f = fitPole(d.kKm);
  if (f && f.rel < 0.2) {
    poles.push(f);
    console.log('pole @', d.kKm.toFixed(4), 'kp', f.kp[0].toExponential(3) + '+' + f.kp[1].toExponential(3) + 'i',
      'rel', f.rel.toExponential(2), '|A_ur|', mag(f.As.ur.A).toExponential(3));
  } else {
    console.log('dip @', d.kKm.toFixed(4), 'fit failed/weak:', f ? f.rel.toExponential(2) : 'null');
  }
}

// ---- 3. integration with subtraction ------------------------------------
function integrate(dks) {
  const kMax = 5e-3; // 1/m
  const vsMax = 4.58 * 1000;
  const kBreak = Math.min(kMax, omega / vsMax);
  function evalSub(k) { // g minus fitted poles
    const g = gOf(k * 1000);
    if (!g) return null;
    const out = { ur: g.ur.slice(), uz: g.uz.slice(), ut: g.ut.slice() };
    for (const p of poles) {
      const w = cdiv([1, 0], csub(k, p.kp));
      for (const ch of ['ur', 'uz', 'ut']) out[ch] = csub(out[ch], cmul(p.As[ch].A, w));
    }
    return out;
  }
  let sumUr = [0, 0], sumUz = [0, 0], sumUt = [0, 0];
  const pts = [];
  for (let k = 5e-8; k <= kBreak; k += dks / 4) pts.push(k);
  for (let k = Math.ceil(kBreak / (dks)) * dks; k <= kMax; k += dks) pts.push(k);
  const gs = pts.map((k) => evalSub(k));
  for (let i = 0; i < pts.length; i++) {
    if (!gs[i]) continue;
    const hL = i === 0 ? (pts[1] - pts[0]) : (pts[i] - pts[i - 1]);
    const hR = i === pts.length - 1 ? (pts[i] - pts[i - 1]) : (pts[i + 1] - pts[i]);
    const w = (hL + hR) / 2;
    sumUr = cadd(sumUr, cscale(gs[i].ur, w));
    sumUz = cadd(sumUz, cscale(gs[i].uz, w));
    sumUt = cadd(sumUt, cscale(gs[i].ut, w));
  }
  // analytic pole re-add over [~0, kMax]
  for (const p of poles) {
    const IK = csub(logC(csub([kMax, 0], p.kp)), logC(csub([5e-8, 0], p.kp)));
    for (const ch of ['ur', 'uz', 'ut']) {
      const add = cmul(p.As[ch].A, IK);
      if (ch === 'ur') sumUr = cadd(sumUr, add);
      if (ch === 'uz') sumUz = cadd(sumUz, add);
      if (ch === 'ut') sumUt = cadd(sumUt, add);
    }
  }
  return { ur: sumUr, uz: sumUz, ut: sumUt };
}

console.log('== dk series with det-pole subtraction (Schur arm) ==');
for (const dk of [0.02, 0.005, 0.002, 0.001]) {
  const t0 = Date.now();
  const r = integrate(dk);
  console.log('dk', dk, '|ur|', mag(r.ur).toExponential(4), '(' + ((Date.now() - t0) / 60000).toFixed(1) + ' min)');
}
