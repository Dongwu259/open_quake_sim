'use strict';
// Region pack (global mode pilot) contract: quake-sim-region-pack-v1.
// The California pack is the first consumer of the lazy global-region loader;
// these checks lock the schema so future packs (and the loader) stay honest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-california.json'), 'utf8'));

test('region pack: schema identity and test flag', () => {
  assert.strictEqual(pack.schema, 'quake-sim-region-pack-v1');
  assert.strictEqual(pack.id, 'california');
  // The pilot must stay test-flagged until regional GMPE calibration lands.
  assert.strictEqual(pack.test, true);
  assert.ok(Array.isArray(pack.bounds) && pack.bounds.length === 2);
  const [[s, w], [n, e]] = pack.bounds;
  assert.ok(s < n && w < e, 'bounds ordered');
  assert.ok(s > 30 && n < 45 && w > -128 && e < -110, 'bounds inside California region');
  // v6.5 California-tsunami batch: the pack carries a GEBCO 2025 strip
  // (grids/us-california.json) and runs the standalone regional solver with
  // honest notes (see tests/region-bathy.test.js for the terrain contract).
  assert.strictEqual(pack.tsunami, true, 'california runs regional tsunami since v6.5');
});

test('region pack: stations complete, in bounds, unique', () => {
  assert.ok(Array.isArray(pack.stations) && pack.stations.length >= 40, '>=40 city stations');
  const [[s, w], [n, e]] = pack.bounds;
  const seen = new Set();
  for (const st of pack.stations) {
    assert.ok(Number.isFinite(st.lat) && Number.isFinite(st.lng), st.name + ' finite coords');
    assert.ok(st.lat >= s && st.lat <= n && st.lng >= w && st.lng <= e, st.name + ' inside bounds');
    assert.ok(typeof st.name === 'string' && st.name.length > 0, 'named');
    assert.ok(st.vs30 == null || (st.vs30 >= 100 && st.vs30 <= 2000), st.name + ' vs30 sane');
    assert.ok(!seen.has(st.name), 'unique: ' + st.name);
    seen.add(st.name);
  }
});

test('region pack: presets carry full focal mechanism for applyPresetSelection', () => {
  assert.ok(Array.isArray(pack.presets) && pack.presets.length >= 4, '>=4 presets');
  for (const p of pack.presets) {
    assert.ok(/^cal-/.test(p.id), 'preset id prefix: ' + p.id);
    assert.ok(typeof p.label === 'string' && p.label.length > 0, 'label');
    const [[s, w], [n, e]] = pack.bounds;
    assert.ok(p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e, p.id + ' epicenter in bounds');
    assert.ok(p.mag >= 5.5 && p.mag <= 8.5, p.id + ' mag sane');
    assert.ok(p.depth >= 0 && p.depth <= 40, p.id + ' depth sane');
    assert.ok(p.strike >= 0 && p.strike <= 360, p.id + ' strike');
    assert.ok(p.dip >= 15 && p.dip <= 90, p.id + ' dip');
    assert.ok(p.rake >= -180 && p.rake <= 180, p.id + ' rake');
    assert.strictEqual(p.mechanismKnown, true, p.id + ' mechanism declared');
    assert.ok(typeof p.time === 'string' && /^\d{4}\/\d{2}\/\d{2}/.test(p.time), p.id + ' UTC time string');
  }
});

test('region pack: honesty notes present', () => {
  assert.ok(pack.notes && /UNCALIBRATED/.test(pack.notes.source), 'uncalibrated declared');
  assert.ok(/JMA-shindo-equivalent/.test(pack.notes.scale), 'scale caveat declared');
});
