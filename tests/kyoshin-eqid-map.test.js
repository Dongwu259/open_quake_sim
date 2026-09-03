'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');

// The map is the contract between tools/find-kyoshin-eqids.js (eqsearch,
// no login needed) and tools/fetch-kyoshin-waveforms.js --events=all (login
// needed). If this breaks, the approval-day batch fetch breaks.
const MAP = JSON.parse(fs.readFileSync('tools/data/kyoshin-eqid-map.json', 'utf8'));
const OBS = JSON.parse(fs.readFileSync('public/geojson/strong-motion-obs.json', 'utf8'));

test('kyoshin eqid map covers the 13 waveform-package events exactly once', () => {
  // v6.2 (2026-09-03): the strong-motion obs set grew 13 -> 19, but the eqid
  // map only needs to cover the 13 Kyoshin WAVEFORM-package events (the map
  // is the fetch-kyoshin-waveforms contract, not the obs-scorecard contract;
  // new v6.2 events have no waveform packages yet and enter the map only
  // when tools/find-kyoshin-eqids.js is re-run against them).
  assert.equal(MAP.length, 13);
  const ids = MAP.map(r => r.eventId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate eventIds');
  const obsIds = OBS.events.map(e => e.eventId);
  for (const id of ids) assert.ok(obsIds.includes(id), id + ' not in the frozen obs set');
});

test('every mapped eqid passed the origin-time and distance gates', () => {
  for (const row of MAP) {
    assert.ok(row.eqid, row.eventId + ' has no eqid');
    assert.match(row.eqid, /^\d{14}$/, row.eventId + ' eqid format');
    assert.ok(row.dtSec <= 600, row.eventId + ' origin-time gate');
    assert.ok(row.distKm <= 120, row.eventId + ' distance gate');
    assert.ok(row.mag > 0 && row.sitenum > 0, row.eventId + ' portal metadata');
    assert.ok(row.retrievedAt, row.eventId + ' provenance date');
  }
});

test('spot-check anchors: portal magnitudes track the JMA solutions', () => {
  const by = Object.fromEntries(MAP.map(r => [r.eventId, r]));
  assert.equal(by.noto2024.eqid, '20240101160813');
  assert.equal(by.tohoku2011.eqid, '20110311144626');
  assert.equal(by.fukushima2011.eqid, '20110411171556'); // 2011 Hamadori mainshock (JMA M7.0), not the +3.4h aftershock
  assert.ok(Math.abs(by.tohoku2011.mag - 9.0) < 0.15);
  assert.ok(Math.abs(by.noto2024.mag - 7.6) < 0.15);
});
