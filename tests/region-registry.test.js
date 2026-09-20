// ================================================================
//  v6.4 multi-region — the global-mode region catalog (california,
//  italy, chile): catalog/i18n/pack-file consistency + the new
//  region station & area packages (INGV Italy provinces, CSN Chile,
//  NE 10m admin-1 regions).
//  Run with:  node --test tests/region-registry.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const CATALOG = (appSrc.match(/var REGION_CATALOG = \[([^\]]*)\]/) || [])[1];
const ids = (CATALOG || '').match(/'([a-z]+)'/g).map((s) => s.replace(/'/g, ''));

test('catalog declares california, italy, chile in app.js', () => {
  assert.deepEqual(ids, ['california', 'italy', 'chile']);
});

test('every catalog region has: pack file + i18n key x3', () => {
  for (const id of ids) {
    const packPath = path.join(ROOT, 'public', 'geojson', 'region-' + id + '.json');
    assert.ok(fs.existsSync(packPath), 'region-' + id + '.json exists');
    const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    assert.equal(pack.schema, 'quake-sim-region-pack-v1');
    assert.equal(pack.id, id, 'pack id matches file');
    assert.ok(pack.stations.length >= 10, id + ' seed stations >= 10');
    assert.ok(pack.presets.length >= 3, id + ' presets >= 3');
    for (const p of pack.presets) {
      assert.ok(p.lat > -90 && p.lat < 90 && p.lng > -180 && p.lng < 180, id + ' preset coords finite');
      assert.ok(p.mag >= 5 && p.mag <= 9.6, id + ' preset mag sane');
    }
    const n = (i18nSrc.match(new RegExp('"region\\.' + id + '":"[^"]+"', 'g')) || []).length;
    assert.equal(n, 3, 'region.' + id + ' i18n x3, got ' + n);
  }
});

test('italy stations package: INGV provenance + operational count', () => {
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-italy.json'), 'utf8'));
  assert.equal(pk.schema, 'quake-sim-region-stations-v1');
  assert.equal(pk.region, 'italy');
  assert.equal(pk.count, pk.stations.length);
  const kept = pk.sources.reduce((a, s) => a + s.dedupedKept, 0);
  assert.equal(kept, pk.count, 'provenance conservation (kept sums to count)');
  assert.ok(pk.stations.length >= 500, 'italy operational stations >= 500 (' + pk.stations.length + ')');
  assert.ok(pk.sources.some((s) => /INGV/.test(s.name)), 'INGV source present');
  for (const st of pk.stations) {
    assert.ok(st.lat >= pk.bbox[0] - 0.01 && st.lat <= pk.bbox[2] + 0.01, 'lat in bbox');
    assert.ok(st.lng >= pk.bbox[1] - 0.01 && st.lng <= pk.bbox[3] + 0.01, 'lng in bbox');
  }
});

test('chile stations package: CSN/EarthScope provenance', () => {
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-chile.json'), 'utf8'));
  assert.equal(pk.schema, 'quake-sim-region-stations-v1');
  assert.equal(pk.region, 'chile');
  assert.ok(pk.stations.length >= 60, 'chile operational stations >= 60 (' + pk.stations.length + ')');
  const kept = pk.sources.reduce((a, s) => a + s.dedupedKept, 0);
  assert.equal(kept, pk.count, 'provenance conservation');
  assert.ok(pk.stations.some((st) => st.net === 'C1'), 'CSN C1 stations present');
});

test('italy/chile area packages: provinces and regions', () => {
  const it = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-areas-italy.json'), 'utf8'));
  assert.equal(it._schema, 'quake-sim-region-areas-v1');
  assert.equal(it.unit, 'province');
  assert.equal(it.areas.features.length, 110, '110 provinces');
  assert.ok(it.provenance.license.includes('CC-BY'), 'istat cc-by license');
  const uniqueIt = new Set(it.areas.features.map((f) => f.properties.name));
  assert.equal(uniqueIt.size, 110, 'province names unique');

  const cl = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-areas-chile.json'), 'utf8'));
  assert.equal(cl._schema, 'quake-sim-region-areas-v1');
  assert.equal(cl.unit, 'region');
  const uniqueCl = new Set(cl.areas.features.map((f) => f.properties.name));
  assert.ok(uniqueCl.size >= 14 && uniqueCl.size <= 16, 'chile regions 14-16, got ' + uniqueCl.size);
  for (const expected of ['Valparaíso', 'Antofagasta', 'Región Metropolitana de Santiago']) {
    assert.ok(uniqueCl.has(expected), 'contains ' + expected);
  }
});

test('region select options carry data-i18n and the fetch is catalog-driven', () => {
  assert.match(appSrc, /region-areas-'/, "loader fetches region-areas-<rid>.json");
  assert.match(appSrc, /'\/geojson\/region-' \+ rid \+ '\.json'/, 'activation fetch is catalog-driven (not hardcoded california)');
  assert.ok(!/fetch\('\/geojson\/region-california\.json'\)/.test(appSrc), 'hardcoded california fetch removed');
  // static california option stays; dynamic ones come from REGION_CATALOG
  assert.match(indexSrc, /<select id="region-select"/);
});
