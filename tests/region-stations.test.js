'use strict';
// Region real-station package contract: quake-sim-region-stations-v1.
// Frozen by tools/fetch-region-stations.js from the data centers' own FDSN
// station-text output (SCEDC / NCEDC / EarthScope backbone). These are
// display-only metadata stations - never sim receivers - so the package must
// carry provenance and stay inside the region bounds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-california.json'), 'utf8'));

test('region stations: schema, region identity, provenance', () => {
  assert.strictEqual(pkg.schema, 'quake-sim-region-stations-v1');
  assert.strictEqual(pkg.region, 'california');
  assert.match(pkg.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(/FDSN/.test(pkg.note), 'display-only note present');
  assert.ok(Array.isArray(pkg.sources) && pkg.sources.length >= 3, 'all three sources recorded');
  for (const s of pkg.sources) {
    assert.ok(/^https:\/\//.test(s.url), 'source url recorded: ' + s.name);
    assert.ok(s.returned >= s.operational, 'returned >= operational: ' + s.name);
    assert.ok(s.operational >= s.dedupedKept, 'operational >= kept: ' + s.name);
    assert.ok(s.dedupedKept >= 0 && Number.isFinite(s.dedupedKept), 'kept finite');
  }
  // dedupedKept sums must equal the frozen station count - no silent drops.
  assert.strictEqual(pkg.sources.reduce((a, s) => a + s.dedupedKept, 0), pkg.count);
});

test('region stations: count, uniqueness, bounds', () => {
  assert.ok(Array.isArray(pkg.stations) && pkg.stations.length === pkg.count);
  assert.ok(pkg.count >= 5000, 'dense California set frozen, got ' + pkg.count);
  const [minlat, minlon, maxlat, maxlon] = pkg.bbox;
  const seen = new Set();
  for (const st of pkg.stations) {
    const key = st.net + '|' + st.code;
    assert.ok(!seen.has(key), 'unique net|code: ' + key);
    seen.add(key);
    assert.ok(Number.isFinite(st.lat) && Number.isFinite(st.lng), key + ' finite coords');
    assert.ok(st.lat >= minlat && st.lat <= maxlat && st.lng >= minlon && st.lng <= maxlon, key + ' inside bbox');
    assert.ok(typeof st.site === 'string' && st.site.length > 0, key + ' site name');
    assert.ok(typeof st.net === 'string' && st.net.length > 0 && typeof st.code === 'string' && st.code.length > 0, key + ' identity');
  }
});

test('region stations: known anchor stations present (spot check)', () => {
  // PAS (Caltech/SCSN Pasadena) exists in every historic SCSN epoch.
  assert.ok(pkg.stations.some(s => s.net === 'CI' && s.code === 'PAS'), 'CI.PAS present');
  // The EarthScope backbone contributes its global-channel stations.
  assert.ok(pkg.stations.some(s => (s.net === 'IU' || s.net === 'II' || s.net === 'US') ), 'backbone station present');
});
