'use strict';
// psv-qd-locator.js — the v16 locator rebuild measurement driver.
// Re-runs the pole locator on the resolvable Schur-QD field:
//   1. the dip scan (psvModalPoles with params.qdCompliance — the Schur
//      detM = det(Y*Q11-Q21) landscape at a surface source, bigfloat chain);
//   2. the 1-ulp stability ladder of that landscape at candidates + a
//      smooth-band control (the v13 discriminator, now applied FOR the
//      detector instead of against it);
//   3. the pole-model fit (psvPoleModelSet) with the QD integrand — the
//      v12-era mislocation record (every fit slid into the 0.70-0.88/km
//      thicket, single-sample anchored) re-measured on the clean field.
// Results are frozen into tools/data/psv-scale-diagnosis.json
// layeredContext.qdLocatorArm as literals with this provenance (the full
// scan costs ~25 min; the fit ~1-2 min; ulp ladders seconds).
//   node psv-qd-locator.js <fHz> [kMaxInvKm]
const ROOT = require('path').join(__dirname, '..', '..');
const Physics = require(ROOT + '/public/physics.js');
const hybrid = require(ROOT + '/tools/broadband/hybrid.js');
const psv = require(ROOT + '/tools/broadband/psv.js');

Physics.setJivsmColumns(JSON.parse(require('fs').readFileSync(ROOT + '/public/geojson/jivsm-columns.json', 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const fHz = +(process.argv[2] || 0.5), kMax = +(process.argv[3] || 5);
const omega = 2 * Math.PI * fHz;
const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);

// ---- 1. the QD dip scan -------------------------------------------------
// A candidates-JSON file (from a previous scan run) skips the ~25-60 min
// scan; poles keep the psvModalPoles convention (k in 1/km) either way.
const candFile = process.argv[4];
let poles, scanSecs, scanSource;
if (candFile && require('fs').existsSync(candFile)) {
  const saved = JSON.parse(require('fs').readFileSync(candFile, 'utf8'));
  scanSource = 'file ' + candFile;
  scanSecs = -1;
  poles = saved.candidates.map((c) => ({ k: c.kInvKm, gammaKm: c.gammaKm, refined: true }));
} else {
  const t0 = Date.now();
  poles = psv.psvModalPoles(stack, omega, kMax, { qShear: 50, qdCompliance: 1 });
  scanSecs = (Date.now() - t0) / 1000;
  scanSource = 'live scan';
}
console.log('scan f=' + fHz, 'kMax=' + kMax, '(' + scanSource + (scanSecs >= 0 ? ' ' + scanSecs.toFixed(0) + 's' : '') + ') candidates=' + poles.length);
const table = poles.map((p) => ({ kInvKm: +p.k.toFixed(4), gammaKm: +p.gammaKm.toExponential(3), refined: !!p.refined }));
console.log('candidates:', JSON.stringify(table));

// ---- 2. ulp stability of the landscape ----------------------------------
// NOTE the double-return floor: detM is computed in 256-bit but returned
// rounded to doubles, and log() carries a +1e-300 guard — dips whose true
// detM sinks below ~1e-300 (near-axis poles) SATURATE the return and their
// ulp ladder measures the floor jitter, not the chain (|v0| ~ 690 flags it).
const psvqd = require(ROOT + '/tools/broadband/psv-qd.js');
const logdetM = (k0m) => {
  const r = psvqd.schurComplianceQD(stack, omega, k0m, 1e-4, { qShear: 50, qP: 50, _wantDet: 1 });
  return r ? Math.log(Math.hypot(r.detM[0], r.detM[1]) + 1e-300) : null;
};
const uOf = (k0m) => 2 ** (Math.floor(Math.log2(k0m)) - 52);
const ulp = {};
const probeKs = poles.slice(0, 5).map((p) => p.k / 1000).concat([0.40 / 1000]); // up to 5 candidates + the smooth control
for (const k0m of probeKs) {
  const u = uOf(k0m), v0 = logdetM(k0m);
  ulp[+(k0m * 1000).toFixed(4)] = { v0: v0 == null ? 'null' : +v0.toFixed(2),
    ladder: [1, 16, 65536].map((n) => {
      const v = logdetM(k0m + n * u);
      return v == null || v0 == null ? 'null' : (v - v0).toExponential(2);
    }).join(' / ') };
}
console.log('ulp:', JSON.stringify(ulp));

// ---- 3. the pole-model fit on the QD integrand --------------------------
const fitParams = { rKm, zSourceKm: 73, kMaxInvKm: 5, qShear: 50, schurCompliance: 1, qdCompliance: 1,
  mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz };
const gOf = (k) => psv.psvIntegrandAtK(stack, omega, k, fitParams);
let t0 = Date.now();
const modelSet = psv.psvPoleModelSet(stack, omega, poles, fitParams, gOf);
console.log('fit', ((Date.now() - t0) / 1000).toFixed(0) + 's kept=' + modelSet.length);
const magc = (c) => Math.hypot(c[0], c[1]);
const models = modelSet.map((m) => ({
  kpInvKm: +(m.kp[0] * 1000).toFixed(5), gammaInvKm: +(Math.abs(m.kp[1]) * 1000).toExponential(3),
  sign: m.kp[1] >= 0 ? '+' : '-', rel: +m.rel.toExponential(3), n: m.n,
  absA: { ur: +magc(m.A.ur).toExponential(3), uz: +magc(m.A.uz).toExponential(3), ut: +magc(m.A.ut).toExponential(3) },
  candKInvKm: +(m.cand.k).toFixed(4)
}));
console.log('models:', JSON.stringify(models, null, 1));
console.log('JSON:' + JSON.stringify({ fHz: fHz, scanSecs: +scanSecs.toFixed(0), candidates: table, ulp: ulp, models: models }));
