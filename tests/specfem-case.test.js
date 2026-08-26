'use strict';
// v5.7 R3-4: specfem3d-crosscheck case assets (offline external comparison
// only) — structural validity gates so the case cannot silently rot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CASE = path.join(__dirname, '..', 'tools', 'specfem3d-crosscheck', 'case-kumamoto2016');

test('specfem case: CMTSOLUTION format + moment tensor validity', () => {
  const txt = fs.readFileSync(path.join(CASE, 'CMTSOLUTION'), 'utf8');
  const g = k => {
    const m = txt.match(new RegExp(k + ':\\s+(-?[\\d.eE+]+)'));
    return m ? Number(m[1]) : null;
  };
  const mrr = g('Mrr'), mtt = g('Mtt'), mpp = g('Mpp');
  assert.ok([mrr, mtt, mpp].every(v => v != null && isFinite(v)));
  assert.ok(Math.abs(mrr + mtt + mpp) < 1e-3 * Math.max(Math.abs(mrr), 1), 'zero trace');
  // M7.3 -> M0 ~ 1.4e26 dyne-cm; |M| = sqrt(2)*M0
  const m0 = Math.hypot(mrr, mtt, mpp) / Math.SQRT2;
  assert.ok(m0 > 5e25 && m0 < 5e27, 'M0 scale for M7.3, got ' + m0.toExponential(2));
  const half = g('half duration');
  assert.ok(half > 0.5 && half < 15, 'physical half duration, got ' + half);
});

test('specfem case: STATIONS + model_1d + expected.json consistency', () => {
  const st = fs.readFileSync(path.join(CASE, 'STATIONS'), 'utf8').trim().split('\n');
  assert.ok(st.length > 30, 'station count');
  const ids = new Set();
  for (const line of st.slice(1)) {
    const c = line.trim().split(/\s+/);
    const lat = Number(c[2]), lng = Number(c[3]);
    assert.ok(isFinite(lat) && lat > 30 && lat < 36, 'Kyushu latitude');
    assert.ok(isFinite(lng) && lng > 129 && lng < 133, 'Kyushu longitude');
    ids.add(c[1]);
  }
  const model = fs.readFileSync(path.join(CASE, 'model_1d.txt'), 'utf8').trim().split('\n')
    .filter(l => !l.startsWith('#')).map(l => l.split(/\s+/).map(Number));
  assert.ok(model.length >= 8, 'model rows');
  let prev = -1;
  for (const [d, vp, vs, rho] of model) {
    assert.ok(d > prev, 'monotonic depths');
    assert.ok(vp > vs && vs > 0 && rho > 1500 && rho < 4000, 'physical layer');
    assert.ok(d - prev === 0 || d - prev >= 0.049 || prev < 0, 'no sub-50m interfaces');
    prev = d;
  }
  const exp = JSON.parse(fs.readFileSync(path.join(CASE, 'expected.json'), 'utf8'));
  assert.equal(exp.schema, 'quake-sim-specfem-crosscheck-v1');
  assert.ok(exp.stations.length >= ids.size - 1, 'expected rows cover the stations');
  for (const s of exp.stations) {
    assert.ok(s.pIasp91S > 0 && s.sIasp91S > s.pIasp91S, 'P before S');
    assert.ok(s.sJivsmS >= s.sIasp91S - 1e-6, 'JIVSM S never beats IASP91 (fill only slows)');
  }
});
