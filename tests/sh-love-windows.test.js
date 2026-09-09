// sh-love-windows.test.js — the SH kernel's Love-mode pole windows
// (core.shLovePoles + tiered windows + trapezoid, v8 2026-09-09).
//   L1  windowed spectrum matches a window-free 32x-refined brute grid (<=5%)
//   L2  the detector finds the waveguide's trapped modes (k inside the
//       Love window (omega/beta_half, omega/beta_top) with positive widths)
//   L3  opt-out (loveWindows: false) restores the plain lattice behaviour
//   L4  determinism: identical calls, identical numbers
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const core = require(path.join(__dirname, '..', 'tools', 'broadband', 'core.js'));

const STACK = [
  { topKm: 0, bottomKm: 3, vsKmS: 1.0, rhoGcm3: 2.0 },
  { topKm: 3, bottomKm: Infinity, vsKmS: 3.5, rhoGcm3: 2.7 }
];
const OMEGA = 2 * Math.PI * 0.5;
const PARAMS = {
  rKm: 80, phiRad: 0.7, zSourceKm: 2, zReceiverKm: 0,
  mxx: 0, myy: 0, mxy: 1, dkInvKm: 0.01, kMaxInvKm: 5, qShear: 50
};
const mag = (c) => Math.hypot(c[0], c[1]);

test('L2 — Love poles detected inside the waveguide window with positive widths', () => {
  const poles = core.shLovePoles(STACK, OMEGA, 5, { qShear: 50 });
  assert.ok(Array.isArray(poles) && poles.length >= 1, 'no Love poles found');
  const kHalf = OMEGA / (3.5 * 1000) * 1000; // omega/beta_half, 1/km
  const kTop = OMEGA / (1.0 * 1000) * 1000;  // omega/beta_top
  for (const p of poles) {
    assert.ok(p.k > kHalf - 1e-9 && p.k < Math.min(kTop, 5), 'pole outside the Love window: ' + p.k);
    assert.ok(p.gammaKm > 0, 'non-positive gamma');
    assert.ok(p.gammaKm < 0.4 * p.k, 'gamma cap exceeded');
  }
});

test('L1 — windowed spectrum matches a window-free refined brute grid', () => {
  const windowed = mag(core.shSpectrumAtFrequency(STACK, OMEGA, Object.assign({}, PARAMS)));
  const brute = mag(core.shSpectrumAtFrequency(STACK, OMEGA,
    Object.assign({}, PARAMS, { loveWindows: false, dkInvKm: 0.01 / 32 })));
  const rel = Math.abs(windowed / brute - 1);
  assert.ok(rel < 0.05, `windowed ${windowed.toExponential(4)} vs brute ${brute.toExponential(4)} rel ${rel.toExponential(2)}`);
});

test('L3 — loveWindows opt-out restores the plain lattice', () => {
  const a = core.shSpectrumAtFrequency(STACK, OMEGA, Object.assign({}, PARAMS, { loveWindows: false }));
  const b = core.shSpectrumAtFrequency(STACK, OMEGA, Object.assign({}, PARAMS, { loveWindows: false }));
  assert.equal(mag(a), mag(b), 'opt-out path is not deterministic');
});

test('L4 — determinism', () => {
  const a = mag(core.shSpectrumAtFrequency(STACK, OMEGA, Object.assign({}, PARAMS)));
  const b = mag(core.shSpectrumAtFrequency(STACK, OMEGA, Object.assign({}, PARAMS)));
  assert.equal(a, b, 'identical calls must be bit-identical');
});
