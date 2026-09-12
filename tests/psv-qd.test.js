// psv-qd.test.js — tripwire for the extended-precision (BigInt bigfloat)
// Schur chain (tools/broadband/psv-qd.js, the v14-registered cure shipped
// 2026-09-12). The QD path is opt-in (params.qdCompliance); absent =
// byte-compatible double paths. v15 measured verdict: the 1-ulp gate PASSES
// at ALL FIVE discriminator points (control 0.40 and crest 0.70/0.73/0.76/
// 0.80/km) with 8-11 orders of margin — the v14 partial gate (0.80 only)
// is resolved; the crest band is a resolvable field.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Physics = require(ROOT + '/public/physics.js');
const hybrid = require(ROOT + '/tools/broadband/hybrid.js');
const psv = require(ROOT + '/tools/broadband/psv.js');
const psvqd = require(ROOT + '/tools/broadband/psv-qd.js');
const psvdd = require(ROOT + '/tools/broadband/psv-dd.js');
const bf = psvqd.bf;

Physics.setJivsmColumns(JSON.parse(fs.readFileSync(ROOT + '/public/geojson/jivsm-columns.json', 'utf8')));
const stack = hybrid.buildJivsmIaspStack(Physics.jivsmColumnAt(35.6812, 139.7671));
const omega = Math.PI, zs = 73, Q = 50;
const num = (x) => bf.toNumber(x);

test('psv-qd — bigfloat primitive precision anchors (256-bit, correctly rounded)', () => {
  const third = bf.bdiv(bf.one(), bf.fromNumber(3));
  assert.ok(Math.abs(num(bf.bsub(bf.bmul(third, bf.fromNumber(3)), bf.one()))) < 1e-70,
    '1/3*3 must round-trip to full precision');
  const s2 = bf.bsqrt(bf.fromNumber(2));
  assert.ok(Math.abs(num(bf.bsub(bf.bmul(s2, s2), bf.fromNumber(2)))) < 1e-70, 'sqrt(2)^2 = 2');
  const rt = num(bf.bsub(bf.bexp(bf.blog(bf.fromNumber(5))), bf.fromNumber(5)));
  assert.ok(Math.abs(rt) < 1e-70, 'exp(log(5)) roundtrip must be bigfloat-accurate (got ' + rt + ')');
  const rt2 = num(bf.bsub(bf.blog(bf.bexp(bf.fromNumber(2.5))), bf.fromNumber(2.5)));
  assert.ok(Math.abs(rt2) < 1e-70, 'log(exp(2.5)) roundtrip must be bigfloat-accurate (got ' + rt2 + ')');
  // ln2 to its last double limb (the bf value must beat the double's own ulp)
  const ln2err = num(bf.bsub(bf.blog(bf.fromNumber(2)), bf.fromNumber(Math.LN2)));
  assert.ok(Math.abs(ln2err - 2.3190468138462996e-17) < 1e-25,
    'bf ln2 must equal LN2_HI + LN2_LO to ~1e-25 (got ' + ln2err + ')');
  // complex sqrt branch convention (Im >= 0, matches core.csqrtPosIm)
  const z = bf.csqrtPosIm([bf.fromNumber(-4), bf.fromNumber(0)]);
  assert.ok(Math.abs(num(z[0])) < 1e-70 && Math.abs(num(z[1]) - 2) < 1e-70, 'sqrt(-4) = 2i');
  // the precision knob actually scales (128-bit roundtrip ~1e-38)
  psvqd.setPrecision(128);
  const rt128 = num(bf.bsub(bf.bexp(bf.blog(bf.fromNumber(5))), bf.fromNumber(5)));
  psvqd.setPrecision(256);
  assert.ok(Math.abs(rt128) > 1e-42 && Math.abs(rt128) < 1e-30,
    '128-bit roundtrip error must sit at the 128-bit scale (got ' + rt128 + ')');
});

test('psv-qd — control band: QD reproduces DD bit-shape and the double path to ~1e-11', () => {
  const Cd = psv.psvSchurCompliance(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  const Cdd = psvdd.schurComplianceDD(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  const Cqd = psvqd.schurComplianceQD(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  assert.ok(Cd && Cdd && Cqd, 'all three paths must return a compliance at the smooth control k');
  const magC = (r) => Math.max(...r.flat().map((c) => Math.hypot(c[0], c[1])));
  const relDd = Math.abs(magC(Cqd) - magC(Cdd)) / magC(Cdd);
  assert.ok(relDd < 1e-12, 'QD must reproduce the DD chain at the control band (got ' + relDd.toExponential(3) + ')');
  const relDbl = Math.abs(magC(Cqd) - magC(Cd)) / magC(Cd);
  assert.ok(relDbl > 0 && relDbl < 1e-9,
    'QD-vs-double agreement must sit at the double chain noise level ~1.2e-11 (got ' + relDbl.toExponential(3) + ')');
});

test('psv-qd — ACCEPTANCE GATE at all five discriminator points: 1-ulp chaos collapses', () => {
  const rKm = Physics.haversineDist(34.0, 140.5, 35.6812, 139.7671);
  const M = hybrid.dcMomentTensor(185, 55, 90, Physics.seismicMoment(7.7));
  const base = { rKm, zSourceKm: zs, mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz, kMaxInvKm: 5, qShear: Q, schurCompliance: 1 };
  const m3 = (km, p) => {
    const g = psv.psvIntegrandAtK(stack, omega, km, p);
    return g ? Math.max(Math.hypot(g.ur[0], g.ur[1]), Math.hypot(g.uz[0], g.uz[1]), Math.hypot(g.ut[0], g.ut[1])) : null;
  };
  const pQd = Object.assign({}, base, { qdCompliance: 1 });
  for (const kKm of [0.40, 0.70, 0.73, 0.76, 0.80]) {
    const k0m = kKm / 1000, u = 2 ** (Math.floor(Math.log2(k0m)) - 52);
    const m0 = m3(k0m, pQd), first = m3(k0m + u, pQd);
    assert.ok(m0 != null && first != null, 'the QD integrand must evaluate at ' + kKm + '/km');
    const rel1 = Math.abs(first - m0) / m0;
    assert.ok(rel1 < 1e-6, 'the QD 1-ulp chaos at ' + kKm + '/km must stay below 1e-6 (got ' + rel1.toExponential(3) + ')');
  }
  // contrast: the double path at 0.73 still swings O(1) at 1 ulp
  const k0m = 0.73 / 1000, u = 2 ** (Math.floor(Math.log2(k0m)) - 52);
  const m0d = m3(k0m, base), firstd = m3(k0m + u, base);
  const relD = Math.abs(firstd - m0d) / m0d;
  assert.ok(relD > 0.1, 'the double path must stay chaotic at 0.73/km (got ' + relD.toExponential(3) + ') — the contrast IS the evidence');
});

test('psv-qd — the compliance magnitude itself is ulp-stable at the crest', () => {
  // v13 measured the double C(zs) swinging 15-567% at 1 ulp at 0.73; the QD
  // C is stable to ~1e-15 relative at 1 ulp (output double-rounding scale).
  const magC = (v) => v ? Math.max(...v.flat().map((c) => Math.hypot(c[0], c[1]))) : null;
  const k0m = 0.73 / 1000, u = 2 ** (Math.floor(Math.log2(k0m)) - 52);
  const c0 = magC(psvqd.schurComplianceQD(stack, omega, k0m, zs, { qShear: Q, qP: Q }));
  for (const n of [1, 2, 4, 16, 256, 65536]) {
    const m = magC(psvqd.schurComplianceQD(stack, omega, k0m + n * u, zs, { qShear: Q, qP: Q }));
    assert.ok(m != null, 'the QD compliance must evaluate at +' + n + ' ulp');
    const rel = Math.abs(m - c0) / c0;
    assert.ok(rel < 1e-8, 'the QD C(zs) must stay ulp-stable at 0.73/km +' + n + ' ulp (got ' + rel.toExponential(3) + ')');
  }
});

test('psv-qd — up-leg step-det cancellation: cross-precision at the control, deeper-than-DD at the crest', () => {
  // 0.40 is a property of the MATH: QD must reproduce the v14 DD table value
  const r40 = psvqd.upLegStepCancellationQD(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  const r40d = psvdd.upLegStepCancellation(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q });
  assert.ok(r40 && r40d && r40.brokeAt === null, 'the smooth-k diagnostic must complete');
  assert.ok(r40.worst < 1e3, 'the smooth-k step cancellation must stay small (got ' + r40.worst.toExponential(3) + ')');
  const relX = Math.abs(r40.worst - r40d.worst) / r40d.worst;
  assert.ok(relX < 1e-6, 'QD must reproduce the DD step-cancel at the control (got ' + relX.toExponential(3) + ')');
  // at the crest the TRUE cancellation is DEEPER than the v14 DD table: DD's
  // own eps saturated its measurement at ~1.4e31; QD resolves ~3.4e35
  const r73 = psvqd.upLegStepCancellationQD(stack, omega, 0.73 / 1000, zs, { qShear: Q, qP: Q });
  assert.ok(r73 && r73.worst > 1e33,
    'the crest step-det cancellation must resolve BELOW the DD saturation floor (got ' + (r73 && r73.worst.toExponential(3)) + ')');
});

test('psv-qd — dispatcher contract: qdCompliance opt-in, absent = double path', () => {
  const C1 = psv.complianceAt(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q, schurCompliance: 1 });
  const C2 = psv.complianceAt(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q, schurCompliance: 1, qdCompliance: 1 });
  assert.ok(Array.isArray(C1) && Array.isArray(C2), 'both dispatcher branches must return a 2x2 compliance');
  assert.ok(Number.isFinite(C1[0][0][0]) && Number.isFinite(C2[0][0][0]), 'shape sanity (both [re,im] pairs)');
  // ddCompliance still routes (the v14 contract survives the new branch)
  const C3 = psv.complianceAt(stack, omega, 0.40 / 1000, zs, { qShear: Q, qP: Q, schurCompliance: 1, ddCompliance: 1 });
  assert.ok(Array.isArray(C3) && Number.isFinite(C3[0][0][0]), 'the DD branch must still route');
});
