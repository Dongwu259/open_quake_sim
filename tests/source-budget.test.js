// R6-1: kinematic source budget diagnostics (v6.0)
// Closed-form anchors: Eshelby circular-crack stress drop, Orowan/Brune
// radiated energy identities (η ≡ 1/2 for a slip-consistent model), and a
// least-squares rupture-front speed recovery test.
const test = require('node:test');
const assert = require('node:assert');
const Physics = require('../public/physics.js');

function uniformModel(nPatches, slip, areaKm2, rigidity, overrides) {
  overrides = overrides || {};
  const patches = [];
  for (let i = 0; i < nPatches; i++) {
    const p = {
      slipM: slip, areaKm2: areaKm2, rigidityGPa: rigidity,
      momentNm: rigidity * 1e9 * areaKm2 * 1e6 * slip,
      ruptureTime: 0, riseTime: 1,
      lat: 35, lng: 135, depthKm: 10
    };
    if (overrides.patch) Object.assign(p, overrides.patch(i));
    patches.push(p);
  }
  return Object.assign({ patches, mw: 7.0, totalMomentNm: patches.reduce((v, p) => v + p.momentNm, 0), geometry: { L: 40, W: 10 } }, overrides.model || {});
}

test('sourceBudget: Eshelby circular-crack stress drop matches closed form', () => {
  const m = uniformModel(16, 2, 62.5, 33.3); // 1000 km² total, D̄ = 2 m
  const b = Physics.sourceBudget(m);
  const mu = 33.3e9, A = 1000e6, r = Math.sqrt(A / Math.PI);
  const expectedMPa = (7 * Math.PI / 16) * mu * 2 / r / 1e6;
  assert.ok(b);
  assert.ok(Math.abs(b.areaKm2 - 1000) < 1e-9);
  assert.ok(Math.abs(b.avgSlipM - 2) < 1e-12);
  assert.ok(Math.abs(b.stressDropMPa - expectedMPa) < 1e-9, 'Δτ = 7π/16·μ·D̄/r, got ' + b.stressDropMPa + ' expected ' + expectedMPa);
  // strip variant: Δτ = 4μD̄/(πW), W = 10 km from geometry
  const stripExpected = 4 * mu * 2 / (Math.PI * 10e3) / 1e6;
  assert.ok(Math.abs(b.stressDropStripMPa - stripExpected) < 1e-9);
});

test('sourceBudget: Orowan/Brune identities — η ≡ 0.5, τa = Δτ/2, Er = M0Δτ/2μ', () => {
  const m = uniformModel(8, 1.5, 100, 30);
  const b = Physics.sourceBudget(m);
  assert.ok(Math.abs(b.radiationEfficiency - 0.5) < 1e-12);
  assert.ok(Math.abs(b.apparentStressMPa - b.stressDropMPa / 2) < 1e-12);
  const Er = b.momentNm * b.stressDropMPa * 1e6 / (2 * 30e9);
  assert.ok(Math.abs(b.radiatedEnergyJ - Er) / Er < 1e-12);
});

test('sourceBudget: supplied-moment vs slip inconsistency raises the η>1 flag', () => {
  const m = uniformModel(8, 1.0, 100, 30, { patch: (i) => ({ momentNm: 3 * 30e9 * 100e6 * 1.0 }) });
  const b = Physics.sourceBudget(m);
  assert.ok(b.radiationEfficiency > 1.4, 'η ≈ 1.5 when M0 = 3×μA·D̄, got ' + b.radiationEfficiency);
  assert.ok(b.flags.indexOf('radiation_efficiency_gt_1') >= 0);
});

test('sourceBudget: rupture-front speed LSQ recovery and supershear flag', () => {
  // 3×7 grid, t = d/v exactly → vFit recovered, r² = 1
  const nuc = { lat: 35, lng: 135, depthKm: 10 };
  const vTrue = 3.0;
  const patches = [];
  for (let ix = -1; ix <= 1; ix++) for (let iz = 0; iz < 7; iz++) {
    const lat = 35 + iz * 0.02, lng = 135 + ix * 0.02, depthKm = 10 + ix * 0.5;
    const dx = (lng - nuc.lng) * Math.PI / 180 * Physics.EARTH_R * Math.cos(nuc.lat * Math.PI / 180);
    const dy = (lat - nuc.lat) * Math.PI / 180 * Physics.EARTH_R;
    const dz = depthKm - nuc.depthKm;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    patches.push({ slipM: 1, areaKm2: 20, rigidityGPa: 30, momentNm: 30e9 * 20e6, ruptureTime: d / vTrue, riseTime: 1, lat, lng, depthKm });
  }
  const b = Physics.sourceBudget({ patches, mw: 6.5, totalMomentNm: patches.reduce((v, p) => v + p.momentNm, 0), geometry: { L: 10, W: 20 } });
  assert.ok(b.ruptureSpeedKmS != null);
  assert.ok(Math.abs(b.ruptureSpeedKmS - vTrue) < 0.02, 'recovered v=' + b.ruptureSpeedKmS);
  assert.ok(b.ruptureSpeedR2 > 0.999);
  assert.ok(b.flags.indexOf('rupture_speed_supershear_vs_rigidity') < 0, '3.0 km/s < 0.95·Vs(3.33)');

  const fast = patches.map(p => Object.assign({}, p, { ruptureTime: p.ruptureTime * 3.0 / 4.0 })); // 4.0 km/s
  const b2 = Physics.sourceBudget({ patches: fast, mw: 6.5, totalMomentNm: 1, geometry: { L: 10, W: 20 } });
  assert.ok(b2.ruptureSpeedKmS > 3.9);
  assert.ok(b2.flags.indexOf('rupture_speed_supershear_vs_rigidity') >= 0, '4.0 km/s > 0.95·Vs → flag');
});

test('sourceBudget: corner frequency uses the Eshelby drop via cornerFrequency()', () => {
  const m = uniformModel(4, 2, 250, 30);
  const b = Physics.sourceBudget(m);
  const fc = Physics.cornerFrequency(m.mw, b.stressDropMPa);
  assert.ok(Math.abs(b.bruneCornerHz - fc) / fc < 1e-12);
  assert.ok(fc > 0.01 && fc < 10, 'M7, few-MPa drop → fc in a physical band, got ' + fc);
});

test('sourceBudget: degenerate inputs return null and spike ratio flags', () => {
  assert.strictEqual(Physics.sourceBudget({ patches: [] }), null);
  assert.strictEqual(Physics.sourceBudget(null), null);
  // slip-spike: one patch 8 m among 10×1 m
  const spikes = [];
  for (let i = 0; i < 11; i++) spikes.push({ slipM: i === 10 ? 8 : 1, areaKm2: 10, rigidityGPa: 30, momentNm: 30e9 * 10e6 * (i === 10 ? 8 : 1), ruptureTime: 0, riseTime: 1, lat: 35, lng: 135, depthKm: 10 });
  const b = Physics.sourceBudget({ patches: spikes, mw: 6, totalMomentNm: 1, geometry: { L: 10, W: 11 } });
  assert.ok(b.maxOverMeanSlip > 4);
  assert.ok(b.flags.indexOf('slip_spike_ratio_gt_4') >= 0);
});
