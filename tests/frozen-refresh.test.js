// frozen-refresh.test.js — R7-1 monthly snapshot tool: month-key + drift semantics
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { monthKey, driftOf } = require('../tools/refresh-frozen-data.js');

describe('refresh-frozen-data monthKey', function() {

  it('keys on the LOCAL calendar month, not UTC', function() {
    // Local Sep 1 00:32 (the 2026-09-01 incident time at UTC+8): UTC derivation
    // landed this in '2026-08' and overwrote that month's snapshot.
    const d = new Date(2026, 8, 1, 0, 32, 0);
    assert.strictEqual(monthKey(d), '2026-09');
  });

  it('pads single-digit months', function() {
    assert.strictEqual(monthKey(new Date(2026, 0, 15)), '2026-01');
    assert.strictEqual(monthKey(new Date(2026, 11, 15)), '2026-12');
  });

  it('honors an explicit YYYY-MM override and rejects malformed values', function() {
    assert.strictEqual(monthKey(new Date(2026, 8, 1), '2026-09'), '2026-09');
    assert.strictEqual(monthKey(new Date(2026, 8, 1), '2027-01'), '2027-01');
    for (const bad of ['2026-9', '202609', '2026-13', '2026-00', 'abc']) {
      assert.throws(() => monthKey(new Date(), bad), /YYYY-MM/);
    }
  });

});

describe('refresh-frozen-data driftOf', function() {

  it('marks the first snapshot', function() {
    assert.deepStrictEqual(driftOf(null, { sha256: 'x', payload: {} }), { firstSnapshot: true });
  });

  it('flags upstream hash changes separately from structural count changes', function() {
    const prev = { sha256: 'a', payload: { events: [{ observations: [1, 2], forecastAreas: [1] }] } };
    const sameCounts = { sha256: 'b', payload: { events: [{ observations: [1, 2], forecastAreas: [1] }] } };
    const d1 = driftOf(prev, sameCounts);
    assert.strictEqual(d1.upstreamChanged, true);
    assert.strictEqual(d1.countsChanged, false);
    assert.deepStrictEqual(d1.after, { events: 1, observations: 2, forecastAreas: 1 });

    const grown = { sha256: 'b', payload: { events: [{ observations: [1, 2, 3], forecastAreas: [1] }, {}] } };
    const d2 = driftOf(prev, grown);
    assert.strictEqual(d2.upstreamChanged, true);
    assert.strictEqual(d2.countsChanged, true);
    assert.deepStrictEqual(d2.after, { events: 2, observations: 3, forecastAreas: 1 });
  });

});
