'use strict';
// tests for tools/calibrate-gmpe.js — magnitude-binned GMPE bias calibration
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCalibration, binIndex, preserveForeignBlocks } = require('../tools/calibrate-gmpe.js');

// 4 stations near a fake epicenter; intensity strings are level+100 chars.
const STATIONS = [[35.0, 139.0], [35.1, 139.0], [35.0, 139.1], [35.1, 139.1]];
const T0 = Date.parse('2026-08-12T01:00:00+09:00');

function eewFrame(eventId, serial, dtMs, isFinal) {
  return {
    t: T0 + dtMs, type: 'wolfx_eew',
    event: {
      type: 'jma_eew', EventID: eventId, Serial: serial,
      Latitude: 35.05, Longitude: 139.05, Magunitude: 3.1, Depth: 10,
      OriginTime: '2026/08/12 01:00:00', isFinal: !!isFinal
    }
  };
}
function eqFrame(eventId) {
  return {
    t: T0 + 60000, type: 'wolfx_eq',
    event: {
      EventID: eventId, latitude: 35.05, longitude: 139.05,
      magnitude: 3.1, depth: '10km', time_full: '2026/08/12 01:00:00'
    }
  };
}
function kmoniFrame(dtMs, level) {
  return {
    t: T0 + dtMs, type: 'kmoni_rt',
    event: { dataTime: 'x', intensity: String.fromCharCode(level + 100).repeat(STATIONS.length) }
  };
}

function makeFrames() {
  const frames = [];
  for (const id of ['E1', 'E2']) {
    frames.push(eewFrame(id, 1, 5000, false));
    frames.push(eewFrame(id, 2, 20000, true));
    frames.push(eqFrame(id));
  }
  // window: origin-120s .. last report +600s -> cover it with quiet stations
  for (let dt = -120000; dt <= 620000; dt += 60000) frames.push(kmoniFrame(dt, 6)); // level 6 -> I = 0
  return frames;
}

test('binIndex maps magnitudes to the configured bins', () => {
  assert.equal(binIndex(3.0), 0);
  assert.equal(binIndex(4.5), 1);
  assert.equal(binIndex(5.4), 1);
  assert.equal(binIndex(6.5), 3);
  assert.equal(binIndex(9.1), 3);
});

test('buildCalibration fits a bounded negative correction for overpredicted small events', () => {
  const table = buildCalibration(makeFrames(), STATIONS);
  assert.equal(table.schema, 'quake-sim-gmpe-calibration-v1');
  const b0 = table.bins[0];
  assert.equal(b0.events, 2, 'both events land in the M<4.5 bin');
  assert.ok(b0.stations > 0);
  // quiet kmoni (I=0) vs positive GMPE predictions -> positive bias -> negative deltaI
  assert.ok(b0.bias > 0, 'bias positive, got ' + b0.bias);
  assert.ok(b0.deltaI < 0 && b0.deltaI >= -1.5, 'deltaI bounded, got ' + b0.deltaI);
  assert.ok(b0.rmsAfter < b0.rmsBefore, 'correction reduces in-sample RMS');
  for (let i = 1; i < table.bins.length; i++) {
    assert.equal(table.bins[i].deltaI, 0, 'empty bins stay at zero');
    assert.equal(table.bins[i].events, 0);
  }
});

test('buildCalibration: fewer than MIN_EVENTS events leave the bin at zero', () => {
  const frames = [eewFrame('E1', 1, 5000, true), eqFrame('E1')];
  for (let dt = -120000; dt <= 620000; dt += 60000) frames.push(kmoniFrame(dt, 6));
  const table = buildCalibration(frames, STATIONS);
  assert.equal(table.bins[0].events, 1);
  assert.equal(table.bins[0].deltaI, 0, 'single event is not enough evidence');
});

test('buildCalibration: no recordings -> identity table', () => {
  const table = buildCalibration([], STATIONS);
  assert.equal(table.bins.length, 4);
  assert.ok(table.bins.every(b => b.deltaI === 0));
});

test('preserveForeignBlocks keeps blocks the tool does not own (e.g. modelBias)', () => {
  const prev = { schema: 'quake-sim-gmpe-calibration-v1', bins: [1], modelBias: { zhao2006: { minM: 7 } } };
  const next = { schema: 'quake-sim-gmpe-calibration-v1', bins: [2] };
  preserveForeignBlocks(prev, next);
  assert.deepEqual(next.bins, [2], 'owned keys are regenerated, not preserved');
  assert.deepEqual(next.modelBias, { zhao2006: { minM: 7 } }, 'foreign block carried over');
});

test('preserveForeignBlocks: missing/invalid previous file is a no-op', () => {
  const next = { bins: [] };
  assert.equal(preserveForeignBlocks(null, next), next);
  assert.equal(preserveForeignBlocks(undefined, next), next);
  assert.deepEqual(next, { bins: [] });
});
