'use strict';
//  v6.7 C batch — regional tsunami observations.
//  Static anchors for the curated regional dataset
//  (public/geojson/region_tsunami_observations.json) plus loose solver
//  tripwires around tools/scorecard-tsunami-regional.js — same philosophy as
//  tests/tsunami-scorecard.test.js: regression guards against a broken
//  source/grid wiring, NOT accuracy claims.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TsunamiValidation = require('../public/tsunami-validation.js');
const { runEvent, dataset, EVENT_HORIZONS, EVENT_MECHANISMS } = require('../tools/scorecard-tsunami-regional.js');

const EVENT_LOCK = {
  maule2010: { region: 'chile', grid: 'cl-megathrust', obs: 7, runup: 6, gauge: 1 },
  illapel2015: { region: 'chile', grid: 'cl-megathrust', obs: 3, runup: 1, gauge: 2 },
  kaikoura2016: { region: 'newzealand', grid: 'nz-aotearoa', obs: 7, runup: 3, gauge: 4 }
};

test('region tsunami obs: dataset validates and matches frozen event anchors', () => {
  const v = TsunamiValidation.validate(dataset);
  assert.deepEqual(v.errors, []);
  assert.equal(v.valid, true);
  assert.equal(dataset.events.length, 3);
  for (const ev of dataset.events) {
    const lock = EVENT_LOCK[ev.id];
    assert.ok(lock, 'unexpected event ' + ev.id);
    assert.equal(ev.region, lock.region);
    assert.equal(ev.regionalGrid, lock.grid);
    assert.equal(ev.observations.length, lock.obs);
    assert.equal(ev.observations.filter(o => o.type === 'runup').length, lock.runup);
    assert.equal(ev.observations.filter(o => o.type === 'tide-gauge').length, lock.gauge);
    assert.equal((ev.forecastAreas || []).length, 0, 'regional scorecard carries no forecast-area classification');
    assert.ok(EVENT_MECHANISMS[ev.id], 'curated mechanism present for ' + ev.id);
    assert.ok(EVENT_HORIZONS[ev.id] >= 3600, 'horizon present for ' + ev.id);
  }
});

test('region tsunami obs: frozen observation values (record-level anchors)', () => {
  const maule = dataset.events.find(e => e.id === 'maule2010');
  assert.equal(maule.observations.find(o => o.id === 'maule2010-loanco').peakHeightM, 14);
  assert.equal(maule.observations.find(o => o.id === 'maule2010-valparaiso').peakHeightM, 1.5);
  const illapel = dataset.events.find(e => e.id === 'illapel2015');
  assert.equal(illapel.observations.find(o => o.id === 'illapel2015-coquimbo-gauge').peakHeightM, 4.7);
  assert.equal(illapel.observations.find(o => o.id === 'illapel2015-coquimbo-bay-inner').peakHeightM, 6.1);
  const kaikoura = dataset.events.find(e => e.id === 'kaikoura2016');
  assert.equal(kaikoura.observations.find(o => o.id === 'kaikoura2016-kaikoura-gauge').peakHeightM, 2.57);
  assert.equal(kaikoura.observations.find(o => o.id === 'kaikoura2016-goose-bay').peakHeightM, 6.9);
  // Every observation cites a source registered in its own event.
  for (const ev of dataset.events) {
    const ids = new Set(ev.sources.map(s => s.id));
    for (const obs of ev.observations) assert.ok(ids.has(obs.sourceId), obs.id + ' cites unknown source');
  }
});

test('region tsunami obs: all observations and epicenters sit inside their regional grid', () => {
  for (const ev of dataset.events) {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/grids', ev.regionalGrid + '.json'), 'utf8'));
    const [lng0, lat0] = g.origin;
    const lat1 = lat0 + g.ny * g.res, lng1 = lng0 + g.nx * g.res;
    for (const obs of ev.observations) {
      assert.ok(obs.lat >= lat0 - 0.001 && obs.lat <= lat1 + 0.001 && obs.lng >= lng0 - 0.001 && obs.lng <= lng1 + 0.001,
        obs.id + ' outside ' + ev.regionalGrid);
    }
    assert.ok(ev.lat >= lat0 && ev.lat <= lat1 && ev.lng >= lng0 && ev.lng <= lng1, ev.id + ' epicenter outside grid');
  }
});

test('region tsunami scorecard: every event produces finite nonzero coastal heights', () => {
  for (const event of dataset.events) {
    const result = runEvent(event);
    assert.equal(result.nested, false, 'regional runs stay standalone single-grid');
    assert.equal(result.observations.length, event.observations.length, `${event.id} point count`);
    let maxPred = 0;
    for (const obs of result.observations) {
      assert.ok(Number.isFinite(obs.peakHeightM), `${event.id}/${obs.id} non-finite prediction`);
      if (obs.peakHeightM > maxPred) maxPred = obs.peakHeightM;
    }
    assert.ok(maxPred > 0.01, `${event.id} produced a flat-ocean prediction (${maxPred})`);
    const maxObs = Math.max(...event.observations.map(o => Number(o.peakHeightM)));
    assert.ok(maxPred < maxObs * 10 + 10, `${event.id} prediction ${maxPred} m implausibly high (obs max ${maxObs} m)`);
  }
});

test('region tsunami scorecard: near-field points stay in the observed band', () => {
  // Loose regression bands around the measured first-baseline numbers
  // (tools/data/region-tsunami-scorecard-report.json): 0.05° cells cannot
  // resolve harbor resonances or ria-coast runup, and the synthetic
  // single-plane source under-drives complex multi-fault events (Kaikōura
  // gauges/runups under-predict by up to 30× — recorded honestly, tracked as
  // TRENDS). Floors guard a flat-ocean wiring break; ceilings guard runaway
  // deformation. Tightening requires a better source/grid, not a test edit.
  const kaikoura = dataset.events.find(e => e.id === 'kaikoura2016');
  const kr = runEvent(kaikoura);
  const goose = kr.observations.find(o => o.id === 'kaikoura2016-goose-bay');
  assert.ok(goose.peakHeightM > 0.02 && goose.peakHeightM < 30,
    `Goose Bay prediction ${goose.peakHeightM.toFixed(2)} m outside 0.02-30 m band (obs 6.9 m, baseline ~0.08 m)`);
  const maule = dataset.events.find(e => e.id === 'maule2010');
  const mr = runEvent(maule);
  const loanco = mr.observations.find(o => o.id === 'maule2010-loanco');
  assert.ok(loanco.peakHeightM > 0.5 && loanco.peakHeightM < 40,
    `Loanco prediction ${loanco.peakHeightM.toFixed(2)} m outside 0.5-40 m band (obs 14 m, baseline ~9.6 m)`);
});
