// ================================================================
//  Unit tests for Physics.activeEventIndex — the v5.2 multi-event
//  display-event selector used by chain presets (japanSinks).
//  Run with:  node --test tests/display-event.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

function ev(originTime) { return { originTime }; }

test('activeEventIndex — empty and single-event inputs', () => {
  assert.strictEqual(Physics.activeEventIndex([], 10), 0);
  assert.strictEqual(Physics.activeEventIndex(null, 10), 0);
  assert.strictEqual(Physics.activeEventIndex([ev(0)], 0), 0);
  assert.strictEqual(Physics.activeEventIndex([ev(0)], 9999), 0);
});

test('activeEventIndex — latest fired event wins', () => {
  const events = [ev(0), ev(43), ev(82), ev(109)];
  assert.strictEqual(Physics.activeEventIndex(events, 0), 0);
  assert.strictEqual(Physics.activeEventIndex(events, 42.9), 0);
  assert.strictEqual(Physics.activeEventIndex(events, 43), 1, 'boundary: originTime reached exactly');
  assert.strictEqual(Physics.activeEventIndex(events, 100), 2);
  assert.strictEqual(Physics.activeEventIndex(events, 865), 3, 'clamps to last event after the chain ends');
});

test('activeEventIndex — before any event has fired falls back to 0', () => {
  const events = [ev(100), ev(200)];
  assert.strictEqual(Physics.activeEventIndex(events, 0), 0);
  assert.strictEqual(Physics.activeEventIndex(events, 99), 0);
});

test('activeEventIndex — robust to unsorted originTimes and missing fields', () => {
  const events = [ev(200), ev(50), {}, ev(120)];
  assert.strictEqual(Physics.activeEventIndex(events, 130), 3, 'greatest originTime <= t wins regardless of order');
  assert.strictEqual(Physics.activeEventIndex(events, 60), 1);
  assert.strictEqual(Physics.activeEventIndex(events, 10), 2, 'missing originTime counts as 0');
});
