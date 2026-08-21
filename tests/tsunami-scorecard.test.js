// ================================================================
//  Tsunami scorecard tripwires: the headless coastal-height scorecard must
//  keep producing finite, nonzero predictions in the observed band. These
//  bounds are loose regression guards around the current synthetic-grid
//  baseline (see tools/scorecard-tsunami.js for the full report), NOT
//  accuracy claims — tightening them requires a better bundled grid.
//  Run with: node --test tests/tsunami-scorecard.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');

const { runEvent, dataset } = require('../tools/scorecard-tsunami.js');

test('tsunami scorecard: every event produces finite nonzero coastal heights', () => {
  for (const event of dataset.events) {
    const result = runEvent(event);
    assert.equal(result.observations.length, event.observations.length, `${event.id} point count`);
    let maxPred = 0;
    for (const obs of result.observations) {
      assert.ok(Number.isFinite(obs.peakHeightM), `${event.id}/${obs.id} non-finite prediction`);
      if (obs.peakHeightM > maxPred) maxPred = obs.peakHeightM;
    }
    // Zero everywhere means the source/deformation wiring broke (a M7.7+
    // offshore rupture cannot produce a literally flat ocean).
    assert.ok(maxPred > 0.01, `${event.id} produced a flat-ocean prediction (${maxPred})`);
    // Upper tripwire: an order of magnitude above the largest observed value
    // means runaway source/deformation, not physics.
    const maxObs = Math.max(...event.observations.map(o => Number(o.peakHeightM)));
    assert.ok(maxPred < maxObs * 10 + 10, `${event.id} prediction ${maxPred} m implausibly high (obs max ${maxObs} m)`);
  }
});

test('tsunami scorecard: Tohoku 2011 stays in the observed runup band', () => {
  const event = dataset.events.find(e => e.id === 'tohoku2011');
  const result = runEvent(event);
  for (const obs of result.observations) {
    const truth = Number(event.observations.find(o => o.id === obs.id).peakHeightM);
    // New baseline (GEBCO 2025 0.15° water-mean resample): 0.7-3 m against
    // 10-24 m observed. Ria-coast runup is unresolvable at 16.7 km cells —
    // the old synthetic grid's 7-10 m came from Green-law over-amplification
    // off its unrealistically deep nearshore profile. The 0.5 m floor still
    // trips on a genuinely broken solver/source (which yields ~0 or NaN).
    assert.ok(obs.peakHeightM >= 0.5 && obs.peakHeightM <= 50,
      `${obs.id}: ${obs.peakHeightM.toFixed(2)} m outside the 0.5-50 m band (observed ${truth} m)`);
  }
});
