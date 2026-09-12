// psv-dd.test.js — tripwire for the double-double Schur chain
// (tools/broadband/psv-dd.js, the v13-registered cure shipped 2026-09-12).
// The DD path is opt-in (params.ddCompliance); absent = byte-compatible
// double paths (locked by the psv-scale-diagnosis tripwire's frozen series).
// v14 measured verdict: the 1-ulp gate PASSES at 0.80/km and the control
// band sits at DD-noise level; 0.70/0.73/0.76 stay chaotic on the up-leg
// step-det cancellation (~5e30-8e31) — quad-double is the registered cure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Physics = require(ROOT + '/public/physics.js');
const hybrid = require(ROOT + '/tools/broadband/hybrid.js');
const psv = require(ROOT + '/tools/broadband/psv.js');
const psvdd = require(ROOT + '/tools/broadband/psv-dd.js');
const dd = psvdd.dd;

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(ROOT + '/public/geojson/jivsm-columns.json', 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = Math.PI, zs = 73, Q = 50;
const num = (a) => a[0] + a[1];

test('psv-dd — DD primitive precision anchors', () => {
  // exact roundtrips the double primitives cannot do
  const third = dd.ddDiv([1, 0], [3, 0]);
  assert.ok(Math.abs(num(dd.ddSub(dd.ddMul(third, [3, 0]), [1, 0]))) === 0, '1/3*3 must be exactly 1 in DD');
  const s2 = dd.ddSqrt([2, 0]);
  assert.ok(Math.abs(num(dd.ddSub(dd.ddMul(s2, s2), [2, 0]))) === 0, 'sqrt(2)^2 must be exactly 2 in DD');
  const rt = num(dd.ddSub(dd.ddExp(dd.ddLog([5, 0])), [5, 0]));
  assert.ok(Math.abs(rt) < 1e-30, 'exp(log(5)) roundtrip must be DD-accurate (got ' + rt + ')');
  // complex sqrt branch convention (Im >= 0, matches core.csqrtPosIm)
  const z = dd.cddSqrtPosIm([[-4, 0], [0, 0]]);
  assert.ok(Math.abs(num(z[0])) < 1e-30 && Math.abs(num(z[1]) - 2) < 1e-30, 'sqrt(-4) = 2i');
});

test('psv-dd — control band: DD agrees with the double path to ~1e-11', () => {
  const Cd = psv.psvSchurCompliance(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  const Cdd = psvdd.schurComplianceDD(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  assert.ok(Cd && Cdd, 'both paths must return a compliance at the smooth control k');
  const magC = (r) => Math.max(...r.flat().map((c) => Math.hypot(c[0], c[1])));
  const rel = Math.abs(magC(Cdd) - magC(Cd)) / magC(Cd);
  assert.ok(rel < 1e-9, 'DD must reproduce the clean double path at the control band (got ' + rel.toExponential(3) + ')');
});

test('psv-dd — ACCEPTANCE GATE at 0.80/km: 1-ulp chaos collapses under DD', () => {
  const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
  const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
  const base = { rKm, zSourceKm: zs, mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz, kMaxInvKm: 5, qShear: Q, schurCompliance: 1 };
  const m3 = (km, p) => {
    const g = psv.psvIntegrandAtK(stack, omega, km, p);
    return g ? Math.max(Math.hypot(g.ur[0], g.ur[1]), Math.hypot(g.uz[0], g.uz[1]), Math.hypot(g.ut[0], g.ut[1])) : null;
  };
  const k0m = 0.80 / 1000, u = 2 ** (Math.floor(Math.log2(k0m)) - 52);
  const pDd = Object.assign({}, base, { ddCompliance: 1 });
  const m0 = m3(k0m, pDd);
  const first = m3(k0m + u, pDd);
  assert.ok(m0 != null && first != null, 'the DD integrand must evaluate at the crest');
  const rel1 = Math.abs(first - m0) / m0;
  assert.ok(rel1 < 1e-6, 'the DD 1-ulp chaos at 0.80/km must stay below 1e-6 (the measured gate; got ' + rel1.toExponential(3) + ')');
  // contrast: the double path at the same point swings O(1)
  const m0d = m3(k0m, base);
  const firstd = m3(k0m + u, base);
  const relD = Math.abs(firstd - m0d) / m0d;
  assert.ok(relD > 0.1, 'the double path must stay chaotic at 0.80/km (got ' + relD.toExponential(3) + ') — the contrast IS the evidence');
});

test('psv-dd — honest FAIL lock at 0.73/km: chaos stays visible until quad-double', () => {
  const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
  const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
  const base = { rKm, zSourceKm: zs, mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz, kMaxInvKm: 5, qShear: Q, schurCompliance: 1 };
  const m3 = (km, p) => {
    const g = psv.psvIntegrandAtK(stack, omega, km, p);
    return g ? Math.max(Math.hypot(g.ur[0], g.ur[1]), Math.hypot(g.uz[0], g.uz[1]), Math.hypot(g.ut[0], g.ut[1])) : null;
  };
  const k0m = 0.73 / 1000, u = 2 ** (Math.floor(Math.log2(k0m)) - 52);
  const pDd = Object.assign({}, base, { ddCompliance: 1 });
  const m0 = m3(k0m, pDd);
  const first = m3(k0m + u, pDd);
  assert.ok(m0 != null && first != null, 'the DD integrand must evaluate at 0.73/km');
  const rel1 = Math.abs(first - m0) / m0;
  assert.ok(rel1 > 0.01, 'the DD 1-ulp chaos at 0.73/km must stay visible until quad-double lands (got ' + rel1.toExponential(3) + ') — upgrade CONSCIOUSLY via the v14 gate');
});

test('psv-dd — up-leg step-det cancellation budget frozen', () => {
  // healthy at the smooth control, ~1e31 at the crest — the measured
  // arithmetic-precision budget that DD (1e-32) exactly consumes.
  const r40 = psvdd.upLegStepCancellation(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  assert.ok(r40 && r40.worst < 1e3 && r40.brokeAt === null, 'the smooth-k step cancellation must stay small');
  const r73 = psvdd.upLegStepCancellation(stack, omega, 0.73 / 1000, zs, { qShear: Q, qP: Q });
  assert.ok(r73 && r73.worst > 1e29, 'the crest step-det cancellation must stay on record (got ' + r73.worst.toExponential(3) + ')');
});

test('psv-dd — dispatcher contract: ddCompliance opt-in, absent = double path', () => {
  const C1 = psv.complianceAt(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q, schurCompliance: 1 });
  const C2 = psv.complianceAt(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q, schurCompliance: 1, ddCompliance: 1 });
  assert.ok(Array.isArray(C1) && Array.isArray(C2), 'both dispatcher branches must return a 2x2 compliance');
  assert.ok(Number.isFinite(C1[0][0][0]) && Number.isFinite(C2[0][0][0]), 'shape sanity (both [re,im] pairs)');
});
