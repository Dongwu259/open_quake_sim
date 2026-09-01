// psha-source-model.test.js — unit gates for tools/build-psha-source-model.js
// (declustering semantics, tectonic classification, completeness rule) plus
// frozen-report structure gates. The full model regeneration itself is a
// manual `node tools/build-psha-source-model.js` run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { classifyEvent, decluster, decadeRateCV } = require('../tools/build-psha-source-model.js');

test('source-model — decluster: window semantics, equal magnitudes, no chain extension', () => {
  const DAY = 86400000;
  const base = Date.UTC(2000, 0, 1);
  const ev = (dDays, mag, lat = 36, lng = 138) => ({ tsMs: base + dDays * DAY, time: new Date(base + dDays * DAY).toISOString(), mag, lat, lng, depthKm: 10 });
  // M7 mainshock, aftershock 30 days later 40 km away (inside window),
  // a same-magnitude later twin 40 days on (kept: equal mag -> earlier is main),
  // an event after the window (kept), and an aftershock-of-aftershock whose
  // own window would swallow a later event (must NOT — no chaining).
  const events = [
    ev(0, 7.0, 36.0, 138.0),          // mainshock
    ev(30, 5.0, 36.25, 138.0),        // ~28 km away, inside R(7)=95 km & T(7)=600 d -> aftershock
    ev(70, 7.0, 36.3, 138.0),         // equal magnitude, later -> independent
    ev(3000, 5.5, 36.0, 138.0),       // beyond T(7)=600 d -> kept
    ev(100, 5.2, 36.1, 138.0),        // inside main window -> aftershock
    ev(130, 6.0, 36.1, 138.0)         // inside MAINSHOCK window (T(7)=600d, R=95km) -> aftershock even though also near the M5.2
  ];
  const out = decluster(events);
  assert.equal(out.mainshocks.length, 3);
  assert.equal(out.nAftershocks, 3);
  const kept = out.mainshocks.map(e => e.mag).sort();
  assert.deepEqual(kept, [5.5, 7.0, 7.0]);
});

test('source-model — classification: trench distance gates interplate, depth splits the rest', () => {
  assert.equal(classifyEvent({ depthKm: 30 }, 9), 'interplate');   // near trench, shallow-ish
  assert.equal(classifyEvent({ depthKm: 30 }, 200), 'crustal');    // far from trench, depth<32
  assert.equal(classifyEvent({ depthKm: 50 }, 200), 'intraslab');  // far, deep
  assert.equal(classifyEvent({ depthKm: 80 }, 9), 'intraslab');    // near trench but >60 km deep
  assert.equal(classifyEvent({ depthKm: 20 }, 149.9), 'interplate');
});

test('source-model — decadeRateCV measures stability and ignores partial decades', () => {
  const mk = (year, mag) => ({ time: year + '-01-01T00:00:00.000Z', mag });
  const flat = [];
  for (let y = 1990; y <= 2019; y++) for (let k = 0; k < 2; k++) flat.push(mk(y + (k ? '-07-01' : ''), 5.2).time && { time: `${y}-0${k + 1}-01T00:00:00.000Z`, mag: 5.2 });
  const cvFlat = decadeRateCV(flat, 5.0, 1990);
  assert.ok(cvFlat.cv < 0.05);
  // a burst in one decade inflates CV
  const burst = flat.concat(new Array(60).fill(0).map((_, i) => ({ time: `2005-01-01T00:00:00.000Z`, mag: 5.2 })));
  const cvBurst = decadeRateCV(burst, 5.0, 1990);
  assert.ok(cvBurst.cv > cvFlat.cv * 3);
});

test('source-model — frozen report structure and pre-registered gates', () => {
  const report = JSON.parse(fs.readFileSync(require.resolve('../tools/data/psha-source-model-report.json'), 'utf8'));
  assert.equal(report.schema, 'quake-sim-psha-source-model-report-v1');
  assert.ok(report.completeness.chosen.cv <= 0.25 || report.completeness.chosen.count >= 500);
  for (const cls of ['crustal', 'interplate', 'intraslab']) {
    assert.ok(report.bValues[cls] > 0.5 && report.bValues[cls] < 1.6, `b ${cls}=${report.bValues[cls]}`);
  }
  // B2 broadband acceptance numbers frozen BEFORE any B2 implementation run
  const b2 = report.preRegisteredB2;
  assert.ok(b2 && b2.metrics && b2.metrics.psaLog10BiasAbsMax['2-10s'] === 0.25);
  assert.match(b2.batch, /frozen 2026-09-01/);
  const model = JSON.parse(fs.readFileSync(require.resolve('../public/geojson/psha-source-model.json'), 'utf8'));
  assert.equal(model.schema, 'quake-sim-psha-source-v1');
  assert.ok(model.cells.length > 5000);
  assert.equal(model.scenarios.length, 2);
  assert.ok(model.provenance.limitations.length >= 4);
});
