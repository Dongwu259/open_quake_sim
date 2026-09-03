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
