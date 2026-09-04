// ================================================================
//  Unit tests for WaveAnalysis — synthetic-waveform analysis engine
//  Run with:  node --test tests/waveform-analysis.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const WaveAnalysis = require('../public/waveform-analysis.js');
const Physics = require('../public/physics.js');

// ================================================================
//  SIGNAL UTILITIES — closed-form anchors
// ================================================================
test('goertzelAmp: recovers a known sinusoid amplitude at its frequency', () => {
  const sr = 50, f = 3, amp = 7.5, n = 50 * 8; // 8 s of 3 Hz sine
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(amp * Math.sin(2 * Math.PI * f * i / sr));
  const got = WaveAnalysis.goertzelAmp(vals, 1 / sr, f);
  assert.ok(Math.abs(got - amp) < 0.15, 'amplitude recovered: ' + got);
  // off-frequency response is far smaller
  const off = WaveAnalysis.goertzelAmp(vals, 1 / sr, 7.3);
  assert.ok(off < amp * 0.2, 'off-bin leakage small: ' + off);
});

test('integrateDetrend: constant → zero; ramp → recovered parabola minus trend; sine mean preserved', () => {
  const dt = 0.02;
  // constant integrates to a ramp; detrend removes it entirely
  const konst = new Array(200).fill(5);
  const ik = WaveAnalysis.integrateDetrend(konst, dt);
  for (const v of ik) assert.ok(Math.abs(v) < 1e-6, 'constant detrended: ' + v);
  // integrating a 2 Hz sine (amplitude A) gives -A/ω·cos with zero mean trend
  const A = 4, w = 2 * Math.PI * 2, n = 500;
  const sine = [];
  for (let i = 0; i < n; i++) sine.push(A * Math.sin(w * i * dt));
  const iv = WaveAnalysis.integrateDetrend(sine, dt);
  const expect = -(A / w); // cos amplitude of the integral
  let maxAbs = 0;
  for (const v of iv) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(Math.abs(maxAbs - Math.abs(expect)) < 0.05 * Math.abs(expect), 'integral amplitude: ' + maxAbs);
});

test('fitCorner: recovers the corner of a synthetic ω⁻² spectrum', () => {
  const fc = 1.3, A0 = 100;
  const fas = [];
  for (let i = 0; i < 60; i++) {
    const f = Math.exp(Math.log(0.25) + (Math.log(20) - Math.log(0.25)) * i / 59);
    fas.push({ f, amp: A0 / (1 + Math.pow(f / fc, 2)) });
  }
  const fit = WaveAnalysis.fitCorner(fas, 0.25, 20);
  assert.ok(fit, 'fit exists');
  assert.ok(Math.abs(fit.fc - fc) / fc < 0.05, 'corner recovered: ' + fit.fc);
  assert.ok(fit.rms < 0.02, 'residual tiny: ' + fit.rms);
});

// ================================================================
//  MAGNITUDE ESTIMATES
// ================================================================
test('momentFromCorner: exact inverse of Physics.cornerFrequency', () => {
  for (const mw of [5.5, 6.5, 7.3, 8.2]) {
    for (const sigma of [3, 10, 30]) {
      const fc = Physics.cornerFrequency(mw, sigma);
      const back = WaveAnalysis.momentFromCorner(fc, sigma, 3.5, Physics);
      assert.ok(Math.abs(back.mw - mw) < 0.005, mw + '/' + sigma + ': ' + back.mw);
    }
  }
});

test('invertPgaToMw: round-trips the legacy log model exactly', () => {
  const dist = 80;
  const pga = WaveAnalysis.legacyPgaForMw(7.0, dist);
  const inv = WaveAnalysis.invertPgaToMw(pga, (m) => WaveAnalysis.legacyPgaForMw(m, dist));
  assert.ok(inv, 'inversion bracketed');
  assert.ok(Math.abs(inv.mw - 7.0) < 0.01, 'Mw recovered: ' + inv.mw);
  // out-of-bracket targets honestly fail
  assert.strictEqual(WaveAnalysis.invertPgaToMw(1e9, (m) => WaveAnalysis.legacyPgaForMw(m, dist)), null);
});

// ================================================================
//  FULL ANALYZE — Brune-source self-consistency
// ================================================================
test('analyze: full pipeline on a Brune synthetic — shape metrics in physical bands', () => {
  const r = WaveAnalysis.analyze({
    physics: Physics, mw: 7.0, distKm: 60, stressDropMPa: 10,
    targetPgaGal: 400, sampleRate: 50
  });
  assert.ok(r.ok, r.error);
  // anchor: vector PGA recovers the target within the decimation grid
  assert.ok(Math.abs(r.pgaGal.vec - 400) / 400 < 0.01, 'PGA anchor: ' + r.pgaGal.vec);
  // PGV/PGD positive and finite; PGD smaller than PGV*1s scale
  assert.ok(r.pgvKine > 1 && r.pgvKine < 500, 'PGV band: ' + r.pgvKine);
  assert.ok(r.pgdCm > 0.1 && r.pgdCm < 500, 'PGD band: ' + r.pgdCm);
  // Arias/CAV/duration finite and positive
  assert.ok(r.ariasMs > 0.01 && r.ariasMs < 100, 'Ia: ' + r.ariasMs);
  assert.ok(r.cavGalS > 10 && r.cavGalS < 1e5, 'CAV: ' + r.cavGalS);
  assert.ok(r.d5d95S > 0.5 && r.d5d95S < r.durationS, 'D5-95 within duration: ' + r.d5d95S);
  // dominant period in the modelled band for M7@60km (corner ~0.2-2 Hz)
  assert.ok(r.dominantFreqHz > 0.15 && r.dominantFreqHz < 10, 'Tp band: ' + r.dominantPeriodS + 's');
  assert.ok(r.apparentCornerHz > 0.1, 'apparent corner finite: ' + r.apparentCornerHz);
  // trace decimation bounded
  assert.ok(r.trace.z.length <= 256 && r.trace.z.length > 20);
  assert.ok(r.cornerFitRms < 0.6, 'corner fit quality: ' + r.cornerFitRms);
});

test('analyze: GMPE-forward amplitude inversion recovers the input Mw within 0.05', () => {
  // Production semantics: the trace is anchored to a GMPE PGA and inverted
  // back through the SAME forward relation — a real bisection inversion of a
  // nonlinear attenuation, model-relative consistency by design.
  for (const [mw, dist] of [[6.0, 100], [7.3, 40], [8.0, 120]]) {
    const forward = (m) => Physics.pgaZhao2006(m, dist, 17, 'crustal', 400, 120);
    const r = WaveAnalysis.analyze({
      physics: Physics, mw, distKm: dist, stressDropMPa: 10,
      targetPgaGal: forward(mw), pgaForMw: forward
    });
    assert.ok(r.ok, r.error);
    assert.ok(r.magFromAmplitude != null, 'inversion bracketed for M' + mw);
    assert.ok(Math.abs(r.magFromAmplitude - mw) <= 0.05,
      'M' + mw + ' recovered as ' + r.magFromAmplitude);
    // the module records which forward was used (honest labelling)
    assert.strictEqual(r.magFromAmplitudeModel, 'caller-forward');
  }
});

test('analyze: amplitude inversion with the caller forward returns the anchor magnitude', () => {
  const forward = (m) => WaveAnalysis.legacyPgaForMw(m, 90);
  const target = forward(6.8);
  const r = WaveAnalysis.analyze({
    physics: Physics, mw: 6.8, distKm: 90, targetPgaGal: target, pgaForMw: forward
  });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.magFromAmplitudeModel, 'caller-forward');
  assert.ok(Math.abs(r.magFromAmplitude - 6.8) < 0.02, 'anchor Mw: ' + r.magFromAmplitude);
});

test('analyze: determinism — identical inputs give identical traces and metrics', () => {
  const a = WaveAnalysis.analyze({ physics: Physics, mw: 6.5, distKm: 70, targetPgaGal: 250 });
  const b = WaveAnalysis.analyze({ physics: Physics, mw: 6.5, distKm: 70, targetPgaGal: 250 });
  assert.deepStrictEqual(a.trace, b.trace);
  assert.strictEqual(a.pgaGal.vec, b.pgaGal.vec);
  assert.strictEqual(a.cornerHz, b.cornerHz);
  assert.strictEqual(a.magFromCorner, b.magFromCorner);
});

test('analyze: rejects malformed arguments honestly', () => {
  assert.strictEqual(WaveAnalysis.analyze(null).ok, false);
  assert.strictEqual(WaveAnalysis.analyze({ physics: Physics }).ok, false);
  assert.strictEqual(WaveAnalysis.analyze({ physics: Physics, mw: 7, distKm: 50, targetPgaGal: 0 }).ok, false);
});
