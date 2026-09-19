// ================================================================
//  v6.4 region areas — California county boundaries for the live
//  shindo coloring layer + area forecast table (region mode).
//  Source: US Census cb_2018 20m via the plotly/datasets mirror,
//  frozen by tools/fetch-region-counties.js (58 counties, 71KB).
//  Run with:  node --test tests/region-areas.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-counties-california.json'), 'utf8'));
const stationsPack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson/region-stations-california.json'), 'utf8'));

test('package schema + provenance (data honesty contract)', () => {
  assert.equal(pack._schema, 'quake-sim-region-areas-v1');
  assert.equal(pack.region, 'california');
  assert.equal(pack.unit, 'county');
  assert.equal(pack.areas.type, 'FeatureCollection');
  assert.equal(pack.areas.features.length, 58, 'California has 58 counties');
  const p = pack.provenance;
  for (const key of ['label', 'source', 'license', 'url', 'builder']) assert.ok(p[key], 'provenance.' + key);
  assert.match(p.license, /public domain/i);
  assert.equal(p.builder, 'tools/fetch-region-counties.js');
});

test('features: named, FIPS 06-prefixed, unique, valid geometry types', () => {
  const names = new Set();
  const fips = new Set();
  for (const f of pack.areas.features) {
    assert.equal(f.type, 'Feature');
    assert.ok(f.properties.name && f.properties.name.length > 0, 'county name present');
    assert.match(f.properties.fips, /^06\d{3}$/, 'CA FIPS prefix');
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type), 'polygon geometry');
    names.add(f.properties.name);
    fips.add(f.properties.fips);
  }
  assert.equal(names.size, 58, 'county names unique');
  assert.equal(fips.size, 58, 'FIPS unique');
  for (const expected of ['Los Angeles', 'San Francisco', 'San Diego', 'Kern', 'Fresno']) {
    assert.ok(names.has(expected), 'contains ' + expected);
  }
});

test('counties geographically cover the station network (bbox sanity)', () => {
  const fc = pack.areas;
  // national bbox of the pack vs stations bbox — every station must sit inside
  const bboxes = fc.features.map((f) => {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    const walk = (coords) => {
      if (typeof coords[0] === 'number') {
        if (coords[0] < x0) x0 = coords[0];
        if (coords[0] > x1) x1 = coords[0];
        if (coords[1] < y0) y0 = coords[1];
        if (coords[1] > y1) y1 = coords[1];
      } else coords.forEach(walk);
    };
    walk(f.geometry.coordinates);
    return [x0, y0, x1, y1];
  });
  let covered = 0;
  for (const s of stationsPack.stations) {
    if (bboxes.some((b) => s.lng >= b[0] && s.lng <= b[2] && s.lat >= b[1] && s.lat <= b[3])) covered++;
  }
  assert.ok(covered / stationsPack.stations.length >= 0.95,
    'station bbox coverage ' + (100 * covered / stationsPack.stations.length).toFixed(1) + '% (coastal/island stragglers fall back)');
});

test('i18n: area table labels present in all three languages', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  for (const key of ['region.area_th', 'region.area_forecast']) {
    const n = (src.match(new RegExp('"' + key + '":"[^"]+"', 'g')) || []).length;
    assert.equal(n, 3, key + ' x3 languages, got ' + n);
  }
});

test('app.js region-area pipeline hooks exist', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(src, /function _areaLayerSource\(\)/, 'layer source helper');
  assert.match(src, /function _computeRegionAreaShindos\(\)/, 'observed aggregation');
  assert.match(src, /function _predictRegionAreaShindos\(\)/, 'centroid forecast');
  assert.match(src, /function _regionLoadAreas\(/, 'package loader');
  assert.match(src, /_regionUnloadAreas\(\)/, 'teardown');
  // the live layer reads the region source first
  assert.match(src, /_areaLayerSource\(\);\s*\n\s*if \(!src\) return;/, 'layer functions consume the helper');
  // the forecast table renders counties instead of hiding
  assert.match(src, /regionMode \? _regionAreaForecast : _predictedPrefectureShindos/);
  assert.match(src, /region\.area_th/, 'header label switches to county');
  // quick intensity-scale toggle lives in the preferences panel too
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal((html.match(/data-cfg="intensityScale"/g) || []).length, 2, 'ADV row + preferences quick toggle');
});
