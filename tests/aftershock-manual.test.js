'use strict';
// v5.5: manual aftershock entries (time/mag/depth) merging into the generated
// catalog, plus the automatic-catalog invariants the manual path relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

const AS_TIME_SCALE = 21600; // must match Aftershock.AS_TIME_SCALE

test('mergeManualAftershocks — empty manual list returns a sorted copy of the catalog', () => {
  const catalog = [{id: 1, time: 500, mag: 5}, {id: 0, time: 100, mag: 4}];
  const out = Physics.mergeManualAftershocks(catalog, [], 35.0, 139.0, AS_TIME_SCALE);
  assert.equal(out.length, 2);
  assert.ok(out[0].time <= out[1].time, 'catalog must stay time-sorted');
  assert.notEqual(out, catalog, 'returns a new array');
  assert.equal(out[0].id, 0);
});

test('mergeManualAftershocks — manual entries scale sim-seconds into catalog time and carry epicenter', () => {
  const out = Physics.mergeManualAftershocks([], [{time: 60, mag: 6.2, depth: 25}], 38.3, 142.4, AS_TIME_SCALE);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, 60 * AS_TIME_SCALE);
  assert.equal(out[0].lat, 38.3);
  assert.equal(out[0].lng, 142.4);
  assert.equal(out[0].mag, 6.2);
  assert.equal(out[0].depth, 25);
  assert.equal(out[0].manual, true);
  assert.equal(typeof out[0].id, 'string');
});

test('mergeManualAftershocks — merged catalog stays globally time-sorted with unique ids', () => {
  const catalog = [{id: 0, time: 30 * AS_TIME_SCALE, mag: 5}, {id: 1, time: 90 * AS_TIME_SCALE, mag: 5}];
  const manual = [{time: 60, mag: 6.0, depth: 10}, {time: 10, mag: 5.5, depth: 8}];
  const out = Physics.mergeManualAftershocks(catalog, manual, 35, 139, AS_TIME_SCALE);
  assert.equal(out.length, 4);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].time >= out[i - 1].time, 'not sorted at ' + i);
  const ids = new Set(out.map(a => String(a.id)));
  assert.equal(ids.size, out.length, 'ids must be unique');
  assert.equal(out[0].mag, 5.5);   // t=10s manual entry first
  assert.equal(out[2].mag, 6.0);   // t=60s manual entry third
});

test('mergeManualAftershocks — clamps mag/depth and drops non-finite entries', () => {
  const out = Physics.mergeManualAftershocks([], [
    {time: 5, mag: 11, depth: -3},
    {time: 6, mag: 1, depth: 900},
    {time: 7, mag: NaN, depth: 10}
  ], 35, 139, AS_TIME_SCALE);
  assert.equal(out.length, 2);
  assert.equal(out[0].mag, 9.5);
  assert.equal(out[0].depth, 0);
  assert.equal(out[1].mag, 3.0);
  assert.equal(out[1].depth, 700);
});

test('mergeManualAftershocks — negative times clamp to the origin and null catalog is tolerated', () => {
  const out = Physics.mergeManualAftershocks(null, [{time: -30, mag: 5.0, depth: 10}], 35, 139, AS_TIME_SCALE);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, 0);
});

test('mergeManualAftershocks — per-entry lat/lng overrides the mainshock epicenter', () => {
  const out = Physics.mergeManualAftershocks([], [
    {time: 10, mag: 6.0, depth: 10, lat: 34.5, lng: 135.2},
    {time: 20, mag: 5.5, depth: 8}
  ], 38.3, 142.4, AS_TIME_SCALE);
  assert.equal(out.length, 2);
  assert.equal(out[0].lat, 34.5);
  assert.equal(out[0].lng, 135.2);
  assert.equal(out[1].lat, 38.3);   // falls back to the mainshock epicenter
  assert.equal(out[1].lng, 142.4);
});

test('generateAftershockCatalog — Omori path stays sorted, capped and on-fault', () => {
  const catalog = Physics.generateAftershockCatalog(7.3, 32.75, 130.76, 224, 65, 16,
    150, 0.1, 1.1, 0.9, 30, 0, 1.86, 200, 'crustal', 42);
  assert.ok(catalog.length >= 10 && catalog.length <= 200);
  for (let i = 1; i < catalog.length; i++) assert.ok(catalog[i].time >= catalog[i - 1].time);
  for (const a of catalog) {
    assert.ok(a.mag >= 4.0 && a.mag <= 7.3 - 0.5 + 1e-9, 'mag in [Mmin, Mmax]');
    assert.ok(a.depth >= 1, 'depth positive');
    assert.ok(Math.abs(a.lat - 32.75) < 3 && Math.abs(a.lng - 130.76) < 3, 'near the fault');
  }
});

test('generateAftershockCatalog — manual merge output feeds preComputeArrivals shape', () => {
  const auto = Physics.generateAftershockCatalog(7.3, 32.75, 130.76, 224, 65, 16,
    150, 0.1, 1.1, 0.9, 30, 0, 1.86, 200, 'crustal', 42);
  const merged = Physics.mergeManualAftershocks(auto, [{time: 45, mag: 6.0, depth: 12}], 32.75, 130.76, AS_TIME_SCALE);
  assert.equal(merged.length, auto.length + 1);
  const man = merged.find(a => a.manual);
  assert.ok(man && man.id === 'man0');
  assert.ok(man.time <= merged[merged.length - 1].time);
});
