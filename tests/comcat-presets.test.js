'use strict';
// =====================================================================
//  v6.6.0 ComCat-sourced region presets — frozen snapshot contract.
//
//  tools/fetch-comcat-presets.js freezes USGS ComCat authoritative values
//  (hypocenter / preferred magnitude / origin time / moment-tensor or
//  focal-mechanism nodal planes) into tools/data/comcat-presets-<region>.json
//  and rewrites the pack presets arrays from them. These tests lock:
//   (1) the snapshot schema and per-preset provenance (query/detail URLs,
//       ComCat event id, match-guard distances);
//   (2) pack <-> snapshot param consistency (pack values are the rounded
//       snapshot values; the keep-list exception is explicit);
//   (3) mechanism honesty — pre-instrumental events carry mechanism:null
//       with the kept-mechanism note, never an invented beachball;
//   (4) the frozen event-id anchors, so a future re-resolution cannot
//       silently re-associate an event;
//   (5) the Messina 1908 epicenter keep-list (HANDOVER 6.6.0 decision 3).
//  Run with:  node --test tests/comcat-presets.test.js
// =====================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REGIONS = ['california', 'chile', 'italy', 'taiwan', 'newzealand'];

function loadSnap(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'comcat-presets-' + rid + '.json'), 'utf8'));
}
function loadPack(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-' + rid + '.json'), 'utf8'));
}

test('snapshot schema + every preset resolved with provenance', () => {
  for (const rid of REGIONS) {
    const snap = loadSnap(rid);
    assert.equal(snap.schema, 'quake-sim-comcat-presets-v1', rid + ' schema');
    assert.equal(snap.region, rid, rid + ' region tag');
    assert.ok(!Number.isNaN(Date.parse(snap.generatedAt)), rid + ' generatedAt parseable');
    assert.ok(/ComCat/.test(snap.provenance), rid + ' provenance names ComCat');
    assert.ok(Array.isArray(snap.presets) && snap.presets.length >= 4, rid + ' presets present');
    for (const p of snap.presets) {
      assert.ok(p.resolved === true, rid + '/' + p.id + ' resolved');
      assert.ok(typeof p.comcatId === 'string' && p.comcatId.length > 4, p.id + ' comcatId');
      assert.ok(p.queryUrl.includes('fdsnws/event/1/query'), p.id + ' queryUrl');
      assert.ok(p.detailUrl.includes('eventid=' + encodeURIComponent(p.comcatId)), p.id + ' detailUrl carries the event id');
      const c = p.comcat;
      assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lng) && Number.isFinite(c.mag) && Number.isFinite(c.depthKm), p.id + ' comcat values finite');
      assert.ok(!Number.isNaN(Date.parse(c.originTimeUtc)), p.id + ' origin time parseable');
      // match guards (the tool refuses candidates outside these bounds)
      assert.ok(p.match.dtHours <= 36 && p.match.distKm <= 250 && p.match.dMag <= 1.5, p.id + ' within match guards');
    }
  }
});

test('pack values equal the rounded snapshot values (keep-list explicit)', () => {
  for (const rid of REGIONS) {
    const snap = loadSnap(rid), pack = loadPack(rid);
    assert.deepEqual(pack.presets.map(p => p.id), snap.presets.map(p => p.id), rid + ' preset id order stable');
    for (let i = 0; i < pack.presets.length; i++) {
      const pp = pack.presets[i], sp = snap.presets[i];
      assert.equal(pp.label.startsWith(sp.label.slice(0, 8)), true, pp.id + ' label family stable');
      if (sp.epicenterKept) {
        assert.equal(pp.lat, sp.previous.lat, pp.id + ' kept epicenter lat');
        assert.equal(pp.lng, sp.previous.lng, pp.id + ' kept epicenter lng');
      } else {
        assert.equal(pp.lat, +sp.comcat.lat.toFixed(3), pp.id + ' lat = comcat');
        assert.equal(pp.lng, +sp.comcat.lng.toFixed(3), pp.id + ' lng = comcat');
      }
      assert.equal(pp.mag, +sp.comcat.mag.toFixed(1), pp.id + ' mag = comcat preferred');
      assert.equal(pp.depth, Math.max(0, +sp.comcat.depthKm.toFixed(1)), pp.id + ' depth = comcat');
      if (sp.mechanism) {
        assert.equal(pp.strike, sp.mechanism.strikeDeg, pp.id + ' strike = mechanism');
        assert.equal(pp.dip, sp.mechanism.dipDeg, pp.id + ' dip = mechanism');
        assert.equal(pp.rake, sp.mechanism.rakeDeg, pp.id + ' rake = mechanism');
      } else {
        assert.equal(pp.strike, sp.previous.strike, pp.id + ' strike kept (no ComCat mechanism)');
        assert.equal(pp.dip, sp.previous.dip, pp.id + ' dip kept');
        assert.equal(pp.rake, sp.previous.rake, pp.id + ' rake kept');
      }
      assert.strictEqual(pp.mechanismKnown, true, pp.id + ' mechanismKnown contract');
      assert.ok(/^\d{4}\/\d{2}\/\d{2}/.test(pp.time), pp.id + ' time string kept');
    }
  }
});

test('mechanism honesty: pre-instrumental events carry mechanism:null, never invented', () => {
  const noMechanism = ['cal-1906-sanfrancisco', 'cal-1971-sanfernando', 'cl-1960-valdivia', 'it-1908-messina'];
  const withMechanism = ['cal-1989-lomaprieta', 'cal-1994-northridge', 'cl-2010-maule', 'cl-2015-illapel', 'cl-2014-iquique',
    'it-2016-norcia', 'it-2016-amatrice', 'it-2009-laquila', 'it-1980-irpinia',
    'tw-1999-chichi', 'tw-2024-hualien', 'tw-2016-meinong', 'tw-2018-hualien',
    'nz-2010-darfield', 'nz-2011-christchurch', 'nz-2016-kaikoura', 'nz-2009-dusky'];
  for (const rid of REGIONS) {
    for (const p of loadSnap(rid).presets) {
      if (noMechanism.includes(p.id)) {
        assert.equal(p.mechanism, null, p.id + ' mechanism null (pre-instrumental)');
        assert.ok(p.keptMechanism && /no ComCat/.test(p.keptMechanism), p.id + ' kept-mechanism note');
      }
      if (withMechanism.includes(p.id)) {
        const m = p.mechanism;
        assert.ok(m, p.id + ' mechanism present');
        assert.ok(m.source.includes('/'), p.id + ' source tagged');
        assert.ok(m.productType === 'moment-tensor' || m.productType === 'focal-mechanism', p.id + ' productType');
        for (const f of [m.strikeDeg, m.dipDeg, m.rakeDeg]) assert.ok(Number.isFinite(f), p.id + ' plane finite');
        assert.ok(m.dipDeg > 0 && m.dipDeg <= 90, p.id + ' dip range');
        assert.ok(m.rakeDeg > -180 && m.rakeDeg <= 180, p.id + ' rake canonicalized');
        assert.ok(m.alternatePlane && Number.isFinite(m.alternatePlane.strikeDeg), p.id + ' alternate plane recorded');
        assert.equal(m.selection, 'nearest-current-preset-plane', p.id + ' plane-selection rule recorded');
      }
    }
  }
});

test('frozen ComCat event-id anchors (no silent re-association)', () => {
  const anchors = {
    'cal-1906-sanfrancisco': 'official19060418131226300_12',
    'cal-1989-lomaprieta': 'nc216859',
    'cal-1994-northridge': 'ci3144585',
    'cal-1971-sanfernando': 'ci3347678',
    'cl-1960-valdivia': 'official19600522191120_30',
    'cl-2010-maule': 'official20100227063411530_30',
    'cl-2015-illapel': 'us20003k7a',
    'cl-2014-iquique': 'usc000nzvd',
    'it-2016-norcia': 'us1000731j',
    'it-2016-amatrice': 'us10006g7d',
    'it-2009-laquila': 'usp000gvtu',
    'it-1980-irpinia': 'usp0001ay4',
    'it-1908-messina': 'iscgem16958009',
    // v6.7 regions (Taiwan BATS / New Zealand GeoNet packs)
    'tw-1999-chichi': 'usp0009eq0',
    'tw-2024-hualien': 'us7000m9g4',
    'tw-2016-meinong': 'us20004y6h',
    'tw-2018-hualien': 'us1000chhc',
    'nz-2010-darfield': 'usp000hk46',
    'nz-2011-christchurch': 'usp000huvq',
    'nz-2016-kaikoura': 'us1000778i',
    'nz-2009-dusky': 'usp000gz8j'
  };
  for (const rid of REGIONS) {
    for (const p of loadSnap(rid).presets) {
      assert.equal(p.comcatId, anchors[p.id], p.id + ' event id anchor');
    }
  }
});

test('Messina 1908 epicenter keep-list honored (honesty note not flushed)', () => {
  const snap = loadSnap('italy');
  const rec = snap.presets.find(p => p.id === 'it-1908-messina');
  assert.ok(rec.epicenterKept, 'keep reason recorded');
  assert.ok(rec.comcatEpicenter && Number.isFinite(rec.comcatEpicenter.lat), 'comcat epicenter recorded for the record');
  // the pack keeps the documented literature epicenter
  assert.equal(rec.previous.lat, 38.15);
  assert.equal(rec.previous.lng, 15.68);
  const pack = loadPack('italy');
  const pp = pack.presets.find(p => p.id === 'it-1908-messina');
  assert.equal(pp.lat, 38.15, 'pack lat unchanged');
  assert.equal(pp.lng, 15.68, 'pack lng unchanged');
});
