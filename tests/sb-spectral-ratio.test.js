'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { amplitudeSpectrum, konnoOhmachi } = require('../tools/sb-spectral-ratio.js');

test('amplitudeSpectrum: sine peaks at the right frequency bin', () => {
  const hz = 20, n = 4096, f0 = 5;
  const samples = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f0 * i / hz));
  const { amp, df } = amplitudeSpectrum(samples, hz);
  const peakBin = amp.indexOf(Math.max(...amp));
  assert.ok(Math.abs(peakBin * df - f0) < df * 1.5,
    'peak at ' + (peakBin * df) + ' Hz, expected ~' + f0);
});

test('konnoOhmachi: smoothing preserves a broadband level and narrows nothing to zero', () => {
  const df = 0.05, amp = Array.from({ length: 400 }, (_, k) => (k * df <= 20 ? 1 : 0));
  const grid = [0.5, 1, 2, 5, 10];
  const sm = konnoOhmachi(amp, df, grid);
  for (const v of sm) assert.ok(v > 0.5 && v < 1.5, 'flat spectrum must stay ~1, got ' + v);
});

test('sb-spectral-ratio calibration file: schema, coverage, physical ranges', () => {
  const p = path.resolve(__dirname, '../public/geojson/sb-spectral-ratio.json');
  assert.ok(fs.existsSync(p), 'calibration file missing');
  const cal = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cal.schema, 'quake-sim-sb-spectral-ratio-v1');
  assert.ok(cal.stations.length >= 150, 'expected a substantial S/B station set, got ' + cal.stations.length);
  assert.ok(cal.meta.provenance.indexOf('10.17598/NIED.0004') >= 0, 'DOI provenance required');
  for (const s of cal.stations) {
    assert.ok(s.f0Hz >= 0.3 && s.f0Hz <= 10, s.code + ' f0 out of band: ' + s.f0Hz);
    assert.ok(s.peakAmp > 1, s.code + ' S/B peak must exceed 1 (surface over borehole)');
    assert.ok(isFinite(s.lat) && isFinite(s.lng));
  }
  // ensemble direction: surface amplification medians above 1 in both bands
  assert.ok(cal.ensemble.empiricalAmpMedian.pgaBand > 1.5);
  assert.ok(cal.ensemble.empiricalAmpMedian.pgvBand > 1.0);
  assert.ok(cal.ensemble.f0Agreement && cal.ensemble.f0Agreement.n >= 150);
  assert.ok(cal.ensemble.f0Agreement.withinHalfOctavePct >= 30,
    'model-vs-empirical f0 agreement regressed: ' + cal.ensemble.f0Agreement.withinHalfOctavePct + '%');
  // f0(Vs30) prior — the runtime-consumed quantity (anchor-invariant)
  const fit = cal.ensemble.f0Vs30Fit;
  assert.ok(fit && fit.n >= 30 && isFinite(fit.a) && isFinite(fit.b), 'f0 fit missing/insufficient');
  assert.ok(fit.b > 0.2 && fit.b < 0.8, 'f0(Vs30) slope out of physical range: ' + fit.b);
  assert.ok(fit.residLogStd > 0.1 && fit.residLogStd < 0.8, 'f0 fit residual std implausible: ' + fit.residLogStd);
  for (const v of [150, 300, 600, 900]) {
    const f0 = Math.pow(10, fit.a + fit.b * Math.log10(v));
    assert.ok(f0 > 1 && f0 < 8, 'f0(' + v + ') = ' + f0 + ' Hz out of the observed KiK-net band');
  }
  // bin median curves: reference calibration data (shape/dispersion only)
  assert.ok(Array.isArray(cal.ensemble.bins) && cal.ensemble.bins.length >= 3);
  for (const b of cal.ensemble.bins) {
    assert.ok(b.n >= 20, 'bin ' + b.f0Min + '-' + b.f0Max + ' thin: n=' + b.n);
    assert.equal(b.freqs.length, b.medRatio.length);
    for (let i = 0; i < b.freqs.length; i++) {
      assert.ok(isFinite(b.medRatio[i]) && b.medRatio[i] > 0 && b.medRatio[i] < 50);
    }
    // each bin's curve peaks inside its own f0 span (or its upper neighborhood)
    const pk = b.medRatio.reduce((m, v, i) => v > b.medRatio[m] ? i : m, 0);
    assert.ok(b.freqs[pk] >= b.f0Min * 0.8 && b.freqs[pk] <= b.f0Max * 2,
      'bin ' + b.f0Min + '-' + b.f0Max + ' peak at ' + b.freqs[pk] + ' Hz displaced');
  }
});
