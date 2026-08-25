'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

function freqs(n, step) { const f = []; for (let i = 1; i <= n; i++) f.push(+(i * step).toFixed(4)); return f; }

test('shTransferFunction: homogeneous column is the identity (undamped)', () => {
  const A = Physics.shTransferFunction(
    [{ vs: 500, thickness: 20, density: 2.0, damping: 0 },
     { vs: 500, density: 2.0, damping: 0 }], freqs(400, 0.01));
  for (const a of A) assert.ok(Math.abs(a - 1) < 1e-12, 'expected |A|=1, got ' + a);
});

test('shTransferFunction: single soft layer resonates at Vs/(4H) with Zb/Z1-scale peak', () => {
  const prof = [{ vs: 150, thickness: 30, density: 1.7, damping: 0.01 },
                { vs: 700, density: 2.2, damping: 0.01 }];
  const f = freqs(400, 0.01), A = Physics.shTransferFunction(prof, f);
  let bi = 0; A.forEach((a, i) => { if (a > A[bi]) bi = i; });
  assert.ok(Math.abs(f[bi] - 1.25) < 0.02, 'f0 at ' + f[bi] + ' Hz, expected 1.25');
  const Zb = 2.2 * 700, Z1 = 1.7 * 150, analyticPeak = Zb / Z1;
  assert.ok(A[bi] > 0.7 * analyticPeak && A[bi] < analyticPeak,
    'damped peak ' + A[bi].toFixed(2) + ' vs undamped ' + analyticPeak.toFixed(2));
  // low-frequency limit: the column moves rigidly with the outcrop
  assert.ok(Math.abs(A[0] - 1) < 0.02, 'A(f->0) = ' + A[0]);
});

test('shTransferFunction: stiff-over-soft impedance contrast deamplifies', () => {
  const A = Physics.shTransferFunction(
    [{ vs: 1000, thickness: 25, density: 2.1, damping: 0.02 },
     { vs: 700, density: 2.2, damping: 0.02 }], freqs(400, 0.01));
  const max = Math.max(...A);
  assert.ok(max < 1.0, 'stiff layer should deamplify at resonance, max ' + max.toFixed(3));
  assert.ok(max > 0.6, 'but not erase the motion, max ' + max.toFixed(3));
});

test('shTransferFunction: layer splitting preserves the response', () => {
  // A 40 m Vs=200 layer split into two 20 m slices must match the single layer.
  const f = freqs(300, 0.01);
  const a = Physics.shTransferFunction(
    [{ vs: 200, thickness: 40, density: 1.8, damping: 0.02 }, { vs: 900, density: 2.3, damping: 0.02 }], f);
  const b = Physics.shTransferFunction(
    [{ vs: 200, thickness: 20, density: 1.8, damping: 0.02 },
     { vs: 200, thickness: 20, density: 1.8, damping: 0.02 },
     { vs: 900, density: 2.3, damping: 0.02 }], f);
  for (let i = 0; i < f.length; i++)
    assert.ok(Math.abs(a[i] - b[i]) < 1e-9, f[i] + ' Hz: ' + a[i] + ' vs ' + b[i]);
});

test('shTransferFunction: more damping lowers the resonant peak', () => {
  const f = freqs(400, 0.01);
  const lo = Physics.shTransferFunction(
    [{ vs: 150, thickness: 30, density: 1.7, damping: 0.005 }, { vs: 700, density: 2.2, damping: 0.005 }], f);
  const hi = Physics.shTransferFunction(
    [{ vs: 150, thickness: 30, density: 1.7, damping: 0.05 }, { vs: 700, density: 2.2, damping: 0.05 }], f);
  assert.ok(Math.max(...lo) > Math.max(...hi) * 1.3, 'zeta 0.005 peak should clearly exceed zeta 0.05 (ratio ' + (Math.max(...lo) / Math.max(...hi)).toFixed(2) + ')');
});

test('densityFromVs: monotone interpolation over the anchor table', () => {
  const checks = [[100, 1.65], [150, 1.65], [275, 1.775], [400, 1.90], [700, 2.10], [1500, 2.40], [3000, 2.65], [4000, 2.65]];
  for (const [vs, rho] of checks) assert.ok(Math.abs(Physics.densityFromVs(vs) - rho) < 1e-9, vs + ' -> ' + Physics.densityFromVs(vs));
  assert.equal(Physics.densityFromVs(0), 2.0);
});

test('orthogonalComponentCorrelation: Jayaram et al. (2011) Eq. 6 anchors', () => {
  const f = Physics.orthogonalComponentCorrelation;
  assert.equal(f(0.05), 0.96);                       // short-period branch
  assert.equal(f(1.0), 0.865 - 0.041 * Math.log(1)); // T = 1 s -> 0.865
  assert.ok(Math.abs(f(5.0) - (0.865 - 0.041 * Math.log(5))) < 1e-12);
  assert.ok(f(5.0) > 0.75 && f(5.0) < 0.82, 'T=5s value ' + f(5.0));
  // monotone decreasing above the branch cut; Japanese values exceed the
  // classic worldwide ~0.7-0.8 at long periods
  assert.ok(f(4.0) < f(0.5));
  assert.equal(f(0), null);
});

// ---- Darendeli (2001) curves + equivalent-linear siteResponse1D (R2) ----

test('darendeliCurves: dissertation Tables 10.13/10.14 reference values', () => {
  // PI=30, OCR=1, sigma'_m = 0.25 atm, f = 1 Hz, N = 10 cycles
  const c = Physics.darendeliCurves([1e-7, 2.2e-5, 1e-2],
    { pi: 30, sigmaEffKPa: 0.25 * 101.325 });
  const ggExp = [1.0, 0.936, 0.050], dExp = [0.01778, 0.02476, 0.21542];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(c.ggmax[i] - ggExp[i]) / ggExp[i] < 0.01,
      'ggmax[' + i + '] ' + c.ggmax[i] + ' vs ' + ggExp[i]);
    assert.ok(Math.abs(c.damping[i] - dExp[i]) / dExp[i] < 0.01,
      'damping[' + i + '] ' + c.damping[i] + ' vs ' + dExp[i]);
  }
});

test('darendeliCurves: PI=0 reference strain at 1 atm and monotone damping', () => {
  const c0 = Physics.darendeliCurves([1e-10], {});
  assert.ok(Math.abs(c0.strainRef - 3.52e-4) / 3.52e-4 < 0.01,
    'gammaRef ' + c0.strainRef);
  const gs = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2];
  const c = Physics.darendeliCurves(gs, {});
  for (let i = 1; i < gs.length; i++) {
    assert.ok(c.ggmax[i] <= c.ggmax[i - 1], 'ggmax must decrease with strain');
    assert.ok(c.damping[i] >= c.damping[i - 1], 'damping must increase with strain');
  }
  // confining pressure stiffens: higher sigma' shifts the curve right
  const soft = Physics.darendeliCurves(1e-3, { sigmaEffKPa: 25 });
  const deep = Physics.darendeliCurves(1e-3, { sigmaEffKPa: 400 });
  assert.ok(deep.ggmax[0] > soft.ggmax[0], 'confining pressure must stiffen');
});

test('siteResponse1D: linear limit matches the undamped transfer function', () => {
  const f = freqs(400, 0.01);
  const prof = [{ vs: 150, thickness: 20, density: 1.65 },
                { vs: 700, density: 2.1 }];
  const r = Physics.siteResponse1D(prof, f, { rockPgaG: 1e-6 });
  const ref = Physics.shTransferFunction(
    [{ vs: 150, thickness: 20, density: 1.65, damping: r.damping[0] },
     { vs: 700, density: 2.1 }], f);
  const peak = Math.max(...r.amp), refPeak = Math.max(...ref);
  assert.ok(r.converged);
  assert.ok(r.ggmax.every(g => g > 0.995), 'linear limit must keep G/Gmax=1');
  assert.ok(Math.abs(peak - refPeak) / refPeak < 0.05,
    'linear peak ' + peak + ' vs damped-linear ref ' + refPeak);
  // resonant frequency tracks Vs/(4H)
  const rIdx = r.amp.indexOf(peak);
  assert.ok(Math.abs(f[rIdx] - 150 / (4 * 20)) < 0.1,
    'f0 ' + f[rIdx] + ' vs Vs/4H ' + (150 / 80));
});

test('siteResponse1D: softening ladder — f0 down, amplification down, damping up', () => {
  const f = freqs(400, 0.01);
  const prof = [{ vs: 150, thickness: 20, density: 1.65 },
                { vs: 700, density: 2.1 }];
  const ladder = [1e-4, 1e-2, 0.1, 0.5].map(pga =>
    Physics.siteResponse1D(prof, f, { rockPgaG: pga }));
  for (const r of ladder) assert.ok(r.converged, 'every rung must converge');
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(Math.max(...ladder[i].amp) <= Math.max(...ladder[i - 1].amp) + 1e-9,
      'peak amplification must not grow with input level');
    assert.ok(ladder[i].damping[0] >= ladder[i - 1].damping[0],
      'damping must grow with input level');
    assert.ok(ladder[i].f0 <= ladder[i - 1].f0 + 1e-9,
      'resonant frequency must shift down (softening)');
  }
  assert.ok(ladder[3].ggmax[0] < 0.1, 'strong shaking must soften the soft layer');
  assert.ok(ladder[3].strain[0] <= 0.03, 'strain cap holds');
});

test('siteResponse1D: rejects bad input', () => {
  const f = freqs(10, 1);
  assert.equal(Physics.siteResponse1D(null, f, { rockPgaG: 0.1 }), null);
  assert.equal(Physics.siteResponse1D([{ vs: 100 }], f, { rockPgaG: 0.1 }), null);
  assert.equal(Physics.siteResponse1D([{ vs: 100, thickness: 5 }, { vs: 500 }], f, {}), null);
  assert.equal(Physics.siteResponse1D(
    [{ vs: 100, thickness: 5 }, { vs: 500 }], f, { rockPgaG: -1 }), null);
});

test('S/B prior: two-scale synth column targets the empirical f0; legacy column without it', () => {
  Physics.setSbEnsemble(null);
  const legacy = Physics.synthSiteProfile(250, 300);
  assert.equal(legacy.length, 3, 'null registry keeps the v1 uniform column');
  assert.equal(legacy[0].thickness, 300);
  assert.ok(legacy.synthetic === true, 'synth stratigraphy is flagged');

  // frozen-form fit (a=-0.69, b=0.46): f0(250) ≈ 2.59 Hz -> H1 ≈ 24.2 m
  Physics.setSbEnsemble({ bins: [], f0Vs30Fit: { a: -0.69, b: 0.46, residLogStd: 0.34, n: 193 } });
  const f0Emp = Physics.sbF0ForVs30(250);
  assert.ok(Math.abs(f0Emp - 2.589) < 0.02, 'f0(250)=' + f0Emp);
  const two = Physics.synthSiteProfile(250, 300);
  assert.equal(two.length, 4, 'resonant + transition + blanket + halfspace');
  assert.ok(Math.abs(two[0].thickness - 250 / (4 * f0Emp)) < 1e-6,
    'resonant block must travel-time-target vs30/(4·f0Emp)');
  assert.ok(two[1].thickness > 0 && two[1].vs > two[0].vs, 'transition fill is stiffer than the resonant block');
  assert.ok(two[two.length - 1].vs >= 3000 && !two[two.length - 1].thickness);

  // shallow bedrock caps the resonant block; deep-vs30 clip stays
  const shallow = Physics.synthSiteProfile(250, 12);
  assert.ok(shallow[0].thickness <= 12 + 1e-9 && shallow.length === 3);
  assert.ok(Physics.synthSiteProfile(250, 5000).reduce((t, l) => t + (l.thickness || 0), 0) <= 600 + 50 + 1);

  // degenerate fits are rejected, column falls back to legacy
  Physics.setSbEnsemble({ f0Vs30Fit: { a: NaN, b: 0.46, n: 193 } });
  assert.equal(Physics.sbF0ForVs30(250), 0);
  assert.equal(Physics.synthSiteProfile(250, 300).length, 3);
  Physics.setSbEnsemble({ f0Vs30Fit: { a: -0.69, b: 0.46, n: 5 } });
  assert.equal(Physics.SB_F0_FIT, null, 'n<30 fit must not register');
  Physics.setSbEnsemble(null);
});

test('S/B prior: two-scale column lifts the soft-deep PGA band (2026-08-25 scorecard finding)', () => {
  // moderate input: the uniform 60 m soft column floors the PGA band while
  // the empirical-f0 column amplifies — this is the soft-site rms 1.30->0.99
  // scorecard move. At strong input (>=100 gal) BOTH columns floor at 0.25:
  // strain damping in a 60 m soft stack is physical, not a regression.
  Physics.setSbEnsemble(null);
  const fLegacy = Physics.eqlinSiteFactor(Physics.synthSiteProfile(150, 60), 30);
  Physics.setSbEnsemble({ f0Vs30Fit: { a: -0.69, b: 0.46, residLogStd: 0.34, n: 193 } });
  const fTwo = Physics.eqlinSiteFactor(Physics.synthSiteProfile(150, 60), 30);
  assert.ok(fTwo.pga > fLegacy.pga + 0.1,
    'PGA band at 30 gal rock: legacy ' + fLegacy.pga.toFixed(2) + ' vs two-scale ' + fTwo.pga.toFixed(2));
  assert.ok(fTwo.pgv > fLegacy.pgv, 'PGV band must lift at every level');
  const fStrong = Physics.eqlinSiteFactor(Physics.synthSiteProfile(150, 60), 300);
  assert.ok(fStrong.pga >= 0.25 && fStrong.pga <= 6, 'strong-shake factors stay inside the clip band');
  Physics.setSbEnsemble(null);
});
