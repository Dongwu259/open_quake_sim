// ================================================================
//  Global-mode land fill batch — the offline vector world basemap
//  (_globalVectorBuild canvas tiles) used to stroke ONLY coastline lines,
//  leaving land as the transparent CSS background. world-land-10m.json
//  (tools/build-world-land.py from Natural Earth 10m land, 2-decimal
//  quantization matching world-coastline-10m.json) now fills land, and the
//  tile painter carries an opaque ocean + theme palette following the root
//  .light class (redraw via _globalVectorReskin on toggleTheme).
//  Run with:  node --test tests/world-land.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const LAND = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'world-land-10m.json'), 'utf8'));

const GEOM = LAND.features[0].geometry;

function eachRing(fn) {
  for (const poly of GEOM.coordinates) for (const ring of poly) fn(ring);
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Land = inside an odd number of rings (evenodd semantics, holes punch out).
function isLand(x, y) {
  let hits = 0;
  eachRing((ring) => { if (ringContains(ring, x, y)) hits++; });
  return hits % 2 === 1;
}

test('land pack schema + provenance honesty', () => {
  assert.equal(LAND.type, 'FeatureCollection');
  assert.equal(LAND.name, 'world-land-10m');
  assert.match(LAND.provenance.source, /Natural Earth 10m land/);
  assert.match(LAND.provenance.builder, /build-world-land\.py/);
  assert.equal(LAND.features.length, 1);
  assert.equal(GEOM.type, 'MultiPolygon');
  assert.ok(GEOM.coordinates.length > 5000, 'polygon count ' + GEOM.coordinates.length);
});

test('rings valid, closed, antimeridian-cut, 2-decimal quantized', () => {
  let pts = 0;
  eachRing((ring) => {
    assert.ok(ring.length >= 4, 'ring needs >=4 closed points, got ' + ring.length);
    assert.deepEqual(ring[0], ring[ring.length - 1], 'ring closed');
    for (let i = 1; i < ring.length; i++) {
      assert.ok(Math.abs(ring[i][0] - ring[i - 1][0]) <= 180, 'antimeridian jump');
    }
    for (const [x, y] of ring) {
      assert.ok(Math.abs(x * 100 - Math.round(x * 100)) < 1e-6, 'lng quantized: ' + x);
      assert.ok(Math.abs(y * 100 - Math.round(y * 100)) < 1e-6, 'lat quantized: ' + y);
      pts++;
    }
  });
  assert.ok(pts > 300000, 'detail preserved, points=' + pts);
});

test('global coverage: three pilot regions + Japan on land, mid-Pacific wet', () => {
  assert.ok(isLand(-122.42, 37.78), 'San Francisco on land');
  assert.ok(isLand(-73.05, -36.83), 'Concepción on land');
  assert.ok(isLand(15.55, 38.19), 'Messina (Sicily side) on land');
  assert.ok(isLand(139.76, 35.68), 'Tokyo on land');
  assert.ok(!isLand(-160.0, 0.0), 'mid-Pacific is water');
  assert.ok(!isLand(-70.0, 40.0), 'NW Atlantic is water');
});

test('app wiring: fill in tile painter, theme palette, redraw hooks', () => {
  assert.match(APP, /function _globalVectorBuild\(geo, land\)/, 'two-source build signature');
  assert.match(APP, /world-land-10m\.json/, 'land pack fetched');
  assert.match(APP, /ctx\.fill\('evenodd'\)/, 'evenodd fill (holes)');
  assert.match(APP, /GLOBAL_LAND_FILL/, 'fill ring registry');
  // palette parity with the Japan offline basemaps (same literals as
  // oceanBg/darkOceanBg and the two prefecture-fill constants)
  assert.match(APP, /ocean: '#d8e8f0', land: '#e8e0d5', line: '#7a8a99'/, 'light palette');
  assert.match(APP, /ocean: '#0a1628', land: '#1a1a2e', line: '#2d4060'/, 'dark palette');
  assert.match(APP, /fillColor: '#d8e8f0'/, 'Japan light ocean literal still present (parity source)');
  assert.match(APP, /fillColor: '#0a1628'/, 'Japan dark ocean literal still present (parity source)');
  // theme detection = the REAL theme switch (root .light), not the dead
  // body.dark-mode legacy; tiles read the palette per tile so redraw reskins
  const colorsBlock = APP.match(/function _globalBaseColors[\s\S]*?\n}/);
  assert.ok(colorsBlock, '_globalBaseColors exists');
  assert.match(colorsBlock[0], /documentElement\.classList\.contains\('light'\)/);
  assert.ok(!/body\.classList\.contains\('dark-mode'\)/.test(colorsBlock[0]), 'dead dark-mode probe gone');
  // redraw on theme toggle + scenario theme apply
  assert.match(APP, /function toggleTheme\(\)[\s\S]*?_globalVectorReskin\(\)/, 'toggleTheme repaints tiles');
  const scn = APP.match(/scn\.display\.theme==='dark'\)\)\{[^}]*\}/);
  assert.ok(scn && /_globalVectorReskin\(\)/.test(scn[0]), 'scenario theme apply repaints tiles');
});

test('dead .global-land-vector CSS retired (canvas owns the basemap now)', () => {
  assert.ok(!/^\.global-land-vector/m.test(CSS), 'style.css selector removed');
});
