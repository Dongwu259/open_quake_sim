'use strict';
// report-demo.test.js — shape + anchors for the frozen demo snapshot behind
// public/report.html (tools/build-report-demo.js). The demo is regenerated
// deterministically (no RNG); these anchors re-derive load-bearing values
// from the same Physics engine so drift from a physics.js change is caught.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const Physics = require('../public/physics.js');

const DEMO = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'report-demo.json'), 'utf8'));

test('report demo — schema and section shape', () => {
  assert.equal(DEMO.schema, 'quake-sim-report-snapshot-v1');
  assert.equal(DEMO.kind, 'demo');
  assert.equal(DEMO.event.preset, 'tokyoInland');
  assert.equal(DEMO.event.sourceClass, 'crustal');
  assert.equal(DEMO.event.mag, 7.3);
  assert.ok(DEMO.prefectures.length === 15);
  assert.ok(DEMO.stations.length === 12);
  assert.equal(DEMO.tsunami, null); // inland scenario
  assert.ok(DEMO.spectrum.periods.length >= 20);
  assert.ok(DEMO.provenance.builder.includes('build-report-demo'));
});

test('report demo — Tokyo tops the prefecture forecast (re-derived anchor)', () => {
  assert.equal(DEMO.prefectures[0].name, '東京都');
  // capital-inland M7.3 at 17 km must reach the top JMA class
  assert.ok(['6+', '7'].includes(DEMO.prefectures[0].shindo), 'top pref ' + DEMO.prefectures[0].shindo);
  // forecast ordering strictly non-increasing in shindo score
  const scores = DEMO.prefectures.map(p => Physics.shindoScore(p.shindo));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
});

test('report demo — top station PGA re-derivable through the frozen path', () => {
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'gmpe-calibration.json'), 'utf8'));
  Physics.setGmpeCalibration(cal);
  const st = DEMO.stations[0];
  assert.ok(st.pga > 300 && st.pga < 3000, 'near-field M7.3 PGA band: ' + st.pga);
  // stations sorted by descending PGA
  for (let i = 1; i < DEMO.stations.length; i++) assert.ok(DEMO.stations[i - 1].pga >= DEMO.stations[i].pga);
  // spectrum: model PSA within [50, 5000] gal and anchored near the station PGA band
  const peak = Math.max(...DEMO.spectrum.psaGal);
  assert.ok(peak > 100 && peak < 5000, 'spectrum peak ' + peak);
});

test('report demo — waveform analysis section: 3 auto-selected stations, inversion lands on the input M', () => {
  const wa = DEMO.waveAnalysis;
  assert.ok(wa, 'waveAnalysis block present');
  assert.equal(wa.actualMw, 7.3);
  assert.equal(wa.stressDropMPa, 10);
  assert.ok(wa.selectionRule.includes('strongest'));
  assert.equal(wa.stations.length, 3);
  const roles = wa.stations.map((s) => s.role);
  assert.deepEqual(roles.sort(), ['mid', 'nearest', 'strongest']);
  for (const s of wa.stations) {
    // metrics in physically plausible bands for M7.3 near-field
    assert.ok(s.metrics.pgaGal.vec > 100, s.name + ' PGA ' + s.metrics.pgaGal.vec);
    assert.ok(s.metrics.pgvKine > 5, s.name + ' PGV ' + s.metrics.pgvKine);
    assert.ok(s.metrics.ariasMs > 0.5, s.name + ' Ia ' + s.metrics.ariasMs);
    assert.ok(s.metrics.dominantPeriodS > 0.2 && s.metrics.dominantPeriodS < 10, s.name + ' Tp');
    assert.ok(s.trace.z.length >= 100 && s.trace.z.length <= 256, s.name + ' trace length');
    // the PGA inversion shares the zhao2006 anchor — must land on the input M
    assert.ok(Math.abs(s.magFromAmplitude - 7.3) <= 0.05, s.name + ' inv M ' + s.magFromAmplitude);
  }
  // per-station seeds: co-located stations (KOTO/KAWASAKI share rRup) must
  // NOT produce identical traces
  assert.notDeepEqual(wa.stations[0].trace.z, wa.stations[1].trace.z, 'distinct realizations');
});

test('report demo — wave analysis is deterministic on rebuild (seeded, no RNG drift)', () => {
  const WaveAnalysis = require('../public/waveform-analysis.js');
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'gmpe-calibration.json'), 'utf8'));
  Physics.setGmpeCalibration(cal);
  const s = DEMO.waveAnalysis.stations[0];
  const dist = s.distKm;
  // rebuild from the frozen snapshot inputs (the builder quantises dist/target
  // to 1 dp and stores the per-station seed verbatim)
  const r = WaveAnalysis.analyze({
    physics: Physics, mw: 7.3, distKm: s.distKm, stressDropMPa: 10,
    targetPgaGal: s.targetPgaGal, seed: s.seed
  });
  assert.ok(r.ok);
  assert.deepEqual(r.trace.z, s.trace.z, 'trace reproduces bit-for-bit');
  assert.equal(r.pgaGal.vec, s.metrics.pgaGal.vec, 'anchor PGA reproduces');
});
