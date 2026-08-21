'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stations = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'public', 'geojson', 'seafloor_stations.json'),
  'utf8',
));

test('bundled seafloor catalog matches the official NIED network inventory', () => {
  assert.equal(stations.length, 237);
  const counts = Object.groupBy
    ? Object.fromEntries(Object.entries(Object.groupBy(stations, station => station.network)).map(([key, rows]) => [key, rows.length]))
    : stations.reduce((result, station) => {
      result[station.network] = (result[station.network] || 0) + 1;
      return result;
    }, {});
  assert.deepEqual(counts, { DONET1: 22, DONET2: 29, 'S-net': 150, 'N-net': 36 });
});

test('seafloor stations have unique official identities and provenance', () => {
  const codes = new Set();
  for (const station of stations) {
    assert.match(station.officialCode, /^[MN]\.[A-Z0-9]+$/);
    assert.equal(station.name, station.officialCode);
    assert.equal(codes.has(station.officialCode), false, station.officialCode);
    assert.equal(station.sourceUrl, 'https://www.seafloor.bosai.go.jp/st_info/');
    assert.equal(station.catalogStatus, 'listed');
    assert.equal(station.operationalStatus, 'not-provided');
    assert.match(station.sourceRetrieved, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(station.lat >= 30 && station.lat <= 45, station.officialCode);
    assert.ok(station.lng >= 130 && station.lng <= 148, station.officialCode);
    assert.ok(Number.isInteger(station.depth) && station.depth > 0 && station.depth < 9000, station.officialCode);
    codes.add(station.officialCode);
  }
  assert.equal(codes.has('M.KMDB1'), false);
});

test('official coordinate anchors prevent a synthetic-grid regression', () => {
  const byCode = new Map(stations.map(station => [station.officialCode, station]));
  assert.deepEqual(
    { lat: byCode.get('N.S1N01').lat, lng: byCode.get('N.S1N01').lng, depth: byCode.get('N.S1N01').depth },
    { lat: 35.8968, lng: 141.0535, depth: 169 },
  );
  assert.deepEqual(
    { lat: byCode.get('N.S6N25').lat, lng: byCode.get('N.S6N25').lng, depth: byCode.get('N.S6N25').depth },
    { lat: 34.6696, lng: 139.8167, depth: 2411 },
  );
  assert.equal(byCode.get('M.KMC21').network, 'DONET1');
  assert.equal(byCode.get('M.KME22').network, 'DONET1');
  assert.deepEqual(
    { lat: byCode.get('N.NAE01').lat, lng: byCode.get('N.NAE01').lng, depth: byCode.get('N.NAE01').depth },
    { lat: 32.7687, lng: 134.2661, depth: 1563 },
  );
  assert.deepEqual(
    { lat: byCode.get('N.NBE18').lat, lng: byCode.get('N.NBE18').lng, depth: byCode.get('N.NBE18').depth },
    { lat: 31.6569, lng: 131.7726, depth: 471 },
  );
});
