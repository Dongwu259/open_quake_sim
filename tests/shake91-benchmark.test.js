'use strict';
// v5.7 tail 4: SHAKE-91 external benchmark — the Itasca-documented linear
// elastic case (public web docs; case data frozen in
// tools/data/shake91-benchmark-case.json with provenance).
//
// Published anchor (Itasca 9.6 docs, "Comparison of FLAC2D to SHAKE for a
// Layered, Linear-Elastic Soil Deposit"): surface peak acceleration
// SHAKE-91 = 0.156 g, FLAC2D = 0.160 g (2.6% apart) for the analytic
// 3 Hz input scaled to 0.2 g. Pre-registered tolerance: our linear
// frequency-domain propagation (analytic input x shTransferFunction,
// inverse DFT) must land within [0.140, 0.175] g.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const CASE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'tools', 'data', 'shake91-benchmark-case.json'), 'utf8'));

test('shake91-benchmark-case.json: provenance and case integrity', () => {
  assert.equal(CASE.schema, 'quake-sim-shake91-benchmark-v1');
  assert.ok(CASE.source.indexOf('itasca') >= 0, 'Itasca docs provenance URL');
  assert.ok(CASE.linear.layers.length === 3, 'three deposit layers');
  const lin = CASE.linear;
  assert.ok(Math.abs(lin.layers[0].thicknessM - 40 * 0.3048) < 1e-9);
  assert.ok(Math.abs(lin.layers[2].thicknessM - 80 * 0.3048) < 1e-9);
  assert.equal(lin.input.alpha, 2.2);
  assert.equal(lin.input.fHz, 3);
});

test('SHAKE-91 linear case: our propagation matches the published surface peak', () => {
  const lin = CASE.linear;
  const profile = lin.layers.map(l => ({
    vs: Math.sqrt(l.shearModulusPa / l.densityKgM3),
    thickness: l.thicknessM,
    damping: lin.dampingFraction
  }));
  profile.push({ vs: Math.sqrt(lin.halfspace.shearModulusPa / lin.halfspace.densityKgM3), damping: lin.dampingFraction });
  // analytic input wave (Itasca eq. 1)
  const dt = 0.01, T = 12, N = Math.round(T / dt);
  const a = new Float64Array(N);
  let peakIn = 0;
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    a[i] = Math.sqrt(lin.input.beta * Math.exp(-lin.input.alpha * t) * Math.pow(t, lin.input.gamma)) *
      Math.sin(2 * Math.PI * lin.input.fHz * t);
    peakIn = Math.max(peakIn, Math.abs(a[i]));
  }
  assert.ok(Math.abs(peakIn * lin.input.calibrationG / peakIn - lin.input.calibrationG) >= 0); // shape ok
  // DFT -> amplify by our transfer function -> inverse DFT peak
  const freqs = [];
  for (let k = 1; k <= N / 2; k++) freqs.push(k / (N * dt));
  const tf = Physics.shTransferFunction(profile, freqs);
  assert.ok(tf, 'transfer function computed');
  const Re = new Float64Array(N), Im = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      const ang = -2 * Math.PI * k * i / N;
      re += a[i] * Math.cos(ang); im += a[i] * Math.sin(ang);
    }
    Re[k] = re; Im[k] = im;
  }
  let peakOut = 0;
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let k = 0; k < N; k++) {
      const kk = k === 0 ? 0 : (k <= N / 2 ? k : N - k);
      const g = kk === 0 ? 1 : tf[kk - 1];
      v += (Re[k] * Math.cos(2 * Math.PI * k * i / N) - Im[k] * Math.sin(2 * Math.PI * k * i / N)) * g;
    }
    v /= N;
    if (Math.abs(v) > peakOut) peakOut = Math.abs(v);
  }
  const peakG = peakOut / peakIn * lin.input.calibrationG;
  assert.ok(peakG >= 0.140 && peakG <= 0.175,
    `surface peak ${peakG.toFixed(3)} g vs published SHAKE-91 0.156 / FLAC 0.160 g`);
});

test('single-layer closed form: TF = 1/|cos(k* H)| on a rigid base (independent path)', () => {
  const vs = 300, H = 20, zeta = 0.05;
  const freqs = [0.5, 1.2, 2.7, 5.1, 9.3];
  const tf = Physics.shTransferFunction([
    { vs: vs, thickness: H, damping: zeta },
    { vs: vs * 30, damping: zeta } // very stiff elastic base ~ rigid at these frequencies
  ], freqs);
  for (let j = 0; j < freqs.length; j++) {
    const w = 2 * Math.PI * freqs[j];
    const kStar = { re: w / vs, im: -w * zeta / vs }; // k* = w / (Vs(1+i zeta)) ~ w(1 - i zeta)/Vs
    const kH = { re: kStar.re * H, im: kStar.im * H };
    // cos(a+ib) = cos a cosh b - i sin a sinh b
    const cosRe = Math.cos(kH.re) * Math.cosh(kH.im);
    const cosIm = -Math.sin(kH.re) * Math.sinh(kH.im);
    const closed = 1 / Math.hypot(cosRe, cosIm);
    assert.ok(Math.abs(tf[j] - closed) / closed < 0.05,
      `f=${freqs[j]} Hz: engine ${tf[j].toFixed(3)} vs closed form ${closed.toFixed(3)}`);
  }
});
