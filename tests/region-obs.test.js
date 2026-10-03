'use strict';
//  v6.7 C batch — regional observational validation (strong motion).
//  Anchors the frozen regional obs set (public/geojson/region-obs.json,
//  tools/fetch-region-obs.js) and the deterministic scorecard
//  (tools/scorecard-region-obs.js). The scorecard tripwire compares a fresh
//  computeReport against the frozen report EXACTLY — any physics/config
//  change that moves regional predictions must re-freeze deliberately.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const Physics = require('../public/physics.js');
const { computeReport, predictionSource, stationVs30 } = require('../tools/scorecard-region-obs.js');

const OBS = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/region-obs.json'), 'utf8'));
const FROZEN_REPORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/data/region-obs-report.json'), 'utf8'));

// Frozen per-event identity (usgsId / stations / max PGA) — guards against
// silent re-association of an event to a different USGS id or a changed
// stationlist upstream (the fetch tool records productCode per event).
const EVENT_LOCK = {
  northridge1994:   { usgsId: 'ci3144585',                    stations: 185, maxPgaGal: 924.25, model: 'bssa14',  variant: 'base' },
  lomaprieta1989:   { usgsId: 'nc216859',                     stations: 106, maxPgaGal: 980.18, model: 'bssa14',  variant: 'base' },
  ridgecrest2019:   { usgsId: 'ci38457511',                   stations: 563, maxPgaGal: 558.08, model: 'bssa14',  variant: 'base' },
  parkfield2004:    { usgsId: 'nc30228270',                   stations: 137, maxPgaGal: 1287.03, model: 'bssa14', variant: 'base' },
  laquila2009:      { usgsId: 'usp000gvtu',                   stations: 66,  maxPgaGal: 612.34, model: 'bssa14',  variant: 'lowQ' },
  amatrice2016:     { usgsId: 'us10006g7d',                   stations: 135, maxPgaGal: 449.17, model: 'bssa14',  variant: 'lowQ' },
  norcia2016:       { usgsId: 'us1000731j',                   stations: 101, maxPgaGal: 460.44, model: 'bssa14',  variant: 'lowQ' },
  maule2010:        { usgsId: 'official20100227063411530_30', stations: 28,  maxPgaGal: 910.06, model: 'zhao2006' },
  illapel2015:      { usgsId: 'us20003k7a',                   stations: 29,  maxPgaGal: 814.05, model: 'zhao2006' },
  iquique2014:      { usgsId: 'usc000nzvd',                   stations: 23,  maxPgaGal: 720.34, model: 'zhao2006' },
  chichi1999:       { usgsId: 'usp0009eq0',                   stations: 414, maxPgaGal: 1134.63, model: 'bssa14', variant: 'base' },
  hualien2024:      { usgsId: 'us7000m9g4',                   stations: 350, maxPgaGal: 1478.6, model: 'zhao2006' },
  darfield2010:     { usgsId: 'usp000hk46',                   stations: 78,  maxPgaGal: 737.48, model: 'bssa14',  variant: 'base' },
  christchurch2011: { usgsId: 'usp000huvq',                   stations: 84,  maxPgaGal: 1597.41, model: 'bssa14', variant: 'base' },
  kaikoura2016:     { usgsId: 'us1000778i',                   stations: 192, maxPgaGal: 1253.75, model: 'bssa14', variant: 'base' }
};

test('region obs: schema, event set and frozen per-event identity', () => {
  assert.equal(OBS.schema, 'quake-sim-region-obs-v1');
  assert.equal(OBS.events.length, 15);
  const seen = {};
  for (const ev of OBS.events) {
    const lock = EVENT_LOCK[ev.eventId];
    assert.ok(lock, 'unexpected event in frozen set: ' + ev.eventId);
    assert.equal(ev.usgsId, lock.usgsId, ev.eventId + ' usgsId drifted');
    assert.equal(ev.stationCount, lock.stations, ev.eventId + ' station count drifted');
    assert.equal(ev.maxObservedPgaGal, lock.maxPgaGal, ev.eventId + ' max PGA drifted');
    assert.equal(ev.stations.length, lock.stations);
    assert.ok(['california', 'italy', 'chile', 'taiwan', 'newzealand'].includes(ev.region));
    seen[ev.eventId] = true;
  }
  assert.deepEqual(Object.keys(EVENT_LOCK).sort(), Object.keys(seen).sort());
});

test('region obs: instrumented-only hygiene and station sort/floor', () => {
  for (const ev of OBS.events) {
    let prev = Infinity;
    for (const st of ev.stations) {
      assert.notEqual(String(st.network).toUpperCase(), 'INTENSITY', ev.eventId + ' leaked a macroseismic pseudo-station');
      assert.ok(st.pgaGal >= 2, ev.eventId + ' station below the 2-gal floor');
      assert.ok(st.pgvCms > 0 && isFinite(st.lat) && isFinite(st.lng));
      assert.ok(st.pgaGal <= prev, ev.eventId + ' stations not sorted by pga desc');
      prev = st.pgaGal;
    }
    assert.ok(ev.stationCount >= 20, ev.eventId + ' below the 20-station quality floor');
  }
});

test('region obs: Maule shakemap product fallback is recorded honestly', () => {
  const ev = OBS.events.find(e => e.eventId === 'maule2010');
  assert.equal(ev.provenance.productCode, 'atlas20100227063414');
  assert.ok(Array.isArray(ev.provenance.productFallback) && ev.provenance.productFallback.length === 1);
  assert.equal(ev.provenance.productFallback[0].productCode, 'official20100227063411530_30');
  assert.equal(ev.provenance.productFallback[0].instrumented, 0);
});

test('region obs: prediction links resolve (pack presets + frozen ComCat blocks)', () => {
  for (const ev of OBS.events) {
    const src = predictionSource(ev);
    assert.ok([src.lat, src.lng, src.depthKm, src.mw, src.strikeDeg, src.dipDeg, src.rakeDeg].every(isFinite),
      ev.eventId + ' prediction source incomplete');
    assert.ok(['crustal', 'interplate', 'intraslab'].includes(src.sourceType));
  }
  const ridge = OBS.events.find(e => e.eventId === 'ridgecrest2019');
  assert.equal(ridge.predictionSource, 'comcat-frozen');
  assert.equal(ridge.prediction.mechanism.productType, 'focal-mechanism');
  // Ridgecrest 2019 M7.1: near-vertical left-lateral strike-slip (documented
  // plane choice np1) — a wrong mechanism here would poison the BSSA14 SS/NS/RS
  // classification, so lock the physical band.
  assert.ok(ridge.prediction.dipDeg >= 70, 'ridgecrest dip out of strike-slip band');
  assert.ok(ridge.prediction.rakeDeg <= -135 || ridge.prediction.rakeDeg >= 135, 'ridgecrest rake out of strike-slip band');
});

test('region scorecard: fresh computeReport reproduces the frozen report exactly', () => {
  const fresh = computeReport(OBS);
  const frozen = { ...FROZEN_REPORT };
  delete frozen.generatedAt;
  assert.deepEqual(fresh, frozen);
});

test('region scorecard: routing + model variants per event', () => {
  for (const ev of FROZEN_REPORT.events) {
    const lock = EVENT_LOCK[ev.eventId];
    assert.equal(ev.model, lock.model, ev.eventId + ' model route drifted');
    if (lock.variant) assert.equal(ev.bssa2014Variant, lock.variant, ev.eventId + ' bssa14 variant drifted');
    else assert.equal(ev.bssa2014Variant, null);
    // BSSA14 only on crustal regional events; zhao2006 on subduction classes.
    if (lock.model === 'bssa14') assert.equal(ev.sourceType, 'crustal');
    else assert.ok(ev.sourceType === 'interplate' || ev.sourceType === 'intraslab');
  }
});

test('region scorecard: Maule Vs30 grid fallback and frozen headline numbers', () => {
  const maule = FROZEN_REPORT.events.find(e => e.eventId === 'maule2010');
  assert.equal(maule.droppedNoVs30, 0);
  assert.equal(maule.gridVs30, 28, 'all 28 Maule stations fall back to the region Vs30 grid');
  assert.deepEqual(FROZEN_REPORT.overall, {
    pga: { n: 2491, bias: -0.1692, rms: 0.4001 },
    pgv: { n: 2491, bias: -0.2116, rms: 0.4138 },
    intensity: { n: 2491, bias: -0.4348, rms: 0.7847 }
  });
  assert.equal(FROZEN_REPORT.schema, 'quake-sim-region-obs-report-v1');
});

test('region scorecard: stationVs30 fallback chain (stationlist -> grid -> null)', () => {
  // stationlist value wins
  assert.deepEqual(stationVs30({ region: 'california' }, { lat: 34.0, lng: -118.5, vs30: 500 }).source, 'stationlist');
  // Maule stations carry null vs30 — the Chile grid must supply a value
  const ev = OBS.events.find(e => e.eventId === 'maule2010');
  const st = ev.stations[0];
  assert.equal(st.vs30, null);
  const v = stationVs30(ev, st);
  assert.equal(v.source, 'region-vs30-grid');
  assert.ok(v.vs30 > 0 && isFinite(v.vs30));
  // far offshore / nowhere: honest null
  assert.equal(stationVs30({ region: 'chile' }, { lat: -36.0, lng: -90.0, vs30: null }).vs30, null);
});

test('region routing: setActiveGmpRegion drives auto resolve + variant', () => {
  try {
    Physics.setActiveGmpRegion('california');
    assert.equal(Physics.resolveGmpModel('auto', 'crustal', 6.7), 'bssa14');
    assert.equal(Physics.activeBssa2014Variant(), 'base');
    Physics.setActiveGmpRegion('italy');
    assert.equal(Physics.activeBssa2014Variant(), 'lowQ');
    Physics.setActiveGmpRegion('chile');
    assert.equal(Physics.resolveGmpModel('auto', 'interplate', 8.8), 'zhao2006');
    Physics.setActiveGmpRegion(null);
    assert.equal(Physics.resolveGmpModel('auto', 'crustal', 6.7), 'si-midorikawa');
  } finally {
    Physics.setActiveGmpRegion(null);
  }
});
