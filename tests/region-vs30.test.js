// ================================================================
//  v6.4 region Vs30 — California Vs30 package + Physics.regionVs30Sample
//  Source: Yong et al. (2014) BSSA 104(5) grid (7.5 arc-sec, water=0),
//  resampled to 0.025° by tools/build-region-vs30.py. The sampler is
//  bilinear with nodata-corner renormalization; out-of-grid/all-nodata
//  returns null (caller keeps the 500 m/s default-estimate).
//  Run with:  node --test tests/region-vs30.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-california.json'), 'utf8'));
const stationsPack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-california.json'), 'utf8'));

test('package schema + provenance (data honesty contract)', () => {
  assert.equal(pack._schema, 'quake-sim-region-vs30-v1');
  assert.equal(pack.region, 'california');
  assert.equal(pack.res, 0.025);
  assert.equal(pack.nodata, 0);
  assert.equal(pack.data.length, pack.nx * pack.ny);
  const p = pack.provenance;
  for (const key of ['label', 'source', 'sourceToken', 'doi', 'license', 'url', 'nativeResolution', 'downsample', 'builder']) {
    assert.ok(p[key], 'provenance.' + key + ' present');
  }
  assert.equal(p.builder, 'tools/build-region-vs30.py');
  assert.match(p.doi, /10\.1785\/0120130312/);
});

test('grid covers the station bbox; values are physical m/s', () => {
  const [lng0, lat0] = pack.origin;
  const lat1 = lat0 + (pack.ny - 1) * pack.res;
  const lng1 = lng0 + (pack.nx - 1) * pack.res;
  // A handful of SCEDC stations sit south of the source map's own edge
  // (Yong grid starts at 32.5°N; e.g. lat 32.31 near the border) — those
  // honestly fall back to the estimate; >=98% must be covered.
  let inside = 0;
  for (const s of stationsPack.stations) {
    if (s.lat >= lat0 - pack.res && s.lat <= lat1 + pack.res &&
        s.lng >= lng0 - pack.res && s.lng <= lng1 + pack.res) inside++;
  }
  const frac = inside / stationsPack.stations.length;
  assert.ok(frac >= 0.98, 'bbox coverage ' + (frac * 100).toFixed(1) + '%');
  const valid = pack.data.filter(v => v > 0);
  assert.ok(valid.length > 50000, 'California land coverage (' + valid.length + ' cells)');
  for (const v of valid) {
    assert.ok(v >= 100 && v <= 2000, 'vs30 ' + v + ' in physical range');
    assert.ok(Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, 'one-decimal values');
  }
});

test('sampler anchors: LA basin / SF / Sierra, water + off-grid honest nulls', () => {
  // Anchors measured from the source grid at native resolution (build probe):
  // LA downtown ~352, SF ~356, Sierra east of Fresno ~710, Bakersfield ~228.
  const la = Physics.regionVs30Sample(pack, 34.05, -118.25);
  assert.ok(la > 200 && la < 450, 'LA basin Vs30 ' + la);
  const sf = Physics.regionVs30Sample(pack, 37.77, -122.42);
  assert.ok(sf > 200 && sf < 480, 'SF Vs30 ' + sf);
  const sierra = Physics.regionVs30Sample(pack, 37.5, -119.3);
  assert.ok(sierra > 550, 'Sierra Vs30 ' + sierra + ' (stiff bedrock)');
  // offshore point (Pacific, well inside the grid) — all-nodata footprint
  assert.equal(Physics.regionVs30Sample(pack, 33.0, -119.6), null);
  // out of grid
  assert.equal(Physics.regionVs30Sample(pack, 45.0, -122.0), null);
  assert.equal(Physics.regionVs30Sample(pack, 35.0, -110.0), null);
  // degenerate inputs
  assert.equal(Physics.regionVs30Sample(null, 35, -118), null);
  assert.equal(Physics.regionVs30Sample({ _schema: 'nope' }, 35, -118), null);
  assert.equal(Physics.regionVs30Sample(pack, NaN, -118), null);
});

test('bilinear interpolation continuity + nodata renormalization', () => {
  // build a tiny 3x3 pack with one nodata corner: weights must renormalize
  const tiny = {
    _schema: 'quake-sim-region-vs30-v1', region: 'x',
    origin: [0, 0], res: 1, nx: 3, ny: 3, nodata: 0,
    data: [100, 100, 100, 100, 100, 100, 100, 100, 0],
  };
  // interior of a uniform 300 block reads exactly 300
  const uni = { ...tiny, data: new Array(9).fill(300) };
  assert.equal(Physics.regionVs30Sample(uni, 1.5, 1.5), 300);
  // at the exact nodata cell itself: all-nodata footprint -> null; blended
  // interior edges renormalize to the valid-corner weighted mean (uniform
  // 100 valid corners + one nodata corner still reads exactly 100)
  assert.equal(Physics.regionVs30Sample(tiny, 2.0, 2.0), null);
  assert.equal(Physics.regionVs30Sample(tiny, 1.5, 1.5), 100);
  // determinism
  const la1 = Physics.regionVs30Sample(pack, 34.05, -118.25);
  const la2 = Physics.regionVs30Sample(pack, 34.05, -118.25);
  assert.equal(la1, la2);
});

test('station coverage: >=90% of the 6232 real stations get a grid Vs30', () => {
  let applied = 0;
  for (const s of stationsPack.stations) {
    if (Physics.regionVs30Sample(pack, s.lat, s.lng) != null) applied++;
  }
  const frac = applied / stationsPack.stations.length;
  assert.ok(frac >= 0.9, 'coverage ' + (frac * 100).toFixed(1) + '% (' + applied + '/' + stationsPack.stations.length + ')');
});

test('i18n: region.st_note_vs30 present in all three languages', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  const n = (src.match(/"region\.st_note_vs30":"[^"]+"/g) || []).length;
  assert.equal(n, 3, 'exactly 3 language entries, got ' + n);
  for (const token of ['{n}', '{src}', '{m}']) {
    assert.ok(src.indexOf(token, src.indexOf('region.st_note_vs30')) !== -1, 'placeholder ' + token);
  }
});
