// ================================================================
//  Unit tests for BulletinBuilder — TTS fragment playlist construction
//  Run with:  node --test tests/bulletin.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../tools/bulletin-builder.js');

// ================================================================
//  LANGUAGES
// ================================================================

test('LANGUAGES — three languages supported', () => {
  assert.deepStrictEqual(B.LANGUAGES, ['jp', 'en', 'zh']);
});

// ================================================================
//  BASIC BULLETIN
// ================================================================

test('buildBulletin — minimal params (no time, no tsunami, no affected)', () => {
  const result = B.buildBulletin({
    lang: 'jp', mag: 6.5, depth: 30, maxShindo: '5-'
  });
  assert.ok(result.fragments, 'should have fragments array');
  assert.ok(result.fragments.length >= 5, 'should have at least intro+mag+depth fragments');
  assert.strictEqual(result.summary.lang, 'jp');

  // Check essential fragments exist
  const names = result.fragments.map(f => f.name);
  assert.ok(names.includes('ph_intro1'), 'should include intro1');
  assert.ok(names.includes('ph_mag'), 'should include ph_mag');
  assert.ok(names.includes('num_06'), 'should include mag integer (6)');
  assert.ok(names.includes('num_05'), 'should include mag decimal (5)');
  assert.ok(names.includes('ph_depth'), 'should include ph_depth');
  assert.ok(names.includes('num_30'), 'should include depth (30)');
  assert.ok(names.includes('ph_km'), 'should include ph_km');
});

test('buildBulletin — with time (Japanese)', () => {
  // Use a fixed UTC time that resolves predictably
  var t = new Date(Date.UTC(2026, 5, 27, 5, 30, 0)); // 05:30 UTC
  var result = B.buildBulletin({
    lang: 'jp', mag: 7.0, depth: 55, maxShindo: '6+',
    time: t
  });
  var names = result.fragments.map(f => f.name);
  // getHours() returns local time; we test that time fragments were generated
  assert.ok(names.some(function(n) { return n.startsWith('num_'); }), 'should have hour number');
  assert.ok(names.includes('ph_hour'), 'JP should have hour suffix');
  assert.ok(names.includes('ph_min'), 'JP should have minute suffix');
});

test('buildBulletin — with time (English, no hour/min suffix)', () => {
  var t = new Date(Date.UTC(2026, 5, 27, 9, 5, 0));
  var result = B.buildBulletin({
    lang: 'en', mag: 7.0, depth: 55, maxShindo: '6+',
    time: t
  });
  var names = result.fragments.map(f => f.name);
  assert.ok(names.some(function(n) { return n.startsWith('num_'); }), 'should have time numbers');
  assert.ok(!names.includes('ph_hour'), 'EN should NOT have hour suffix');
  assert.ok(!names.includes('ph_min'), 'EN should NOT have minute suffix');
});

test('buildBulletin — time is null/omitted', () => {
  const result = B.buildBulletin({
    lang: 'zh', mag: 5.0, depth: 10, maxShindo: 4
  });
  const names = result.fragments.map(f => f.name);
  assert.ok(!names.includes('ph_hour'), 'should skip time when null');
  assert.ok(!names.includes('ph_min'), 'should skip time when null');
});

// ================================================================
//  TSUNAMI LEVELS
// ================================================================

test('buildBulletin — tsunami major (level 3)', () => {
  const r = B.buildBulletin({ lang: 'jp', mag: 9.0, depth: 24, maxShindo: 7, tsunamiLevel: 3 });
  assert.ok(r.fragments.some(f => f.name === 'ph_tsu_major'));
});

test('buildBulletin — tsunami warning (level 2)', () => {
  const r = B.buildBulletin({ lang: 'jp', mag: 8.0, depth: 30, maxShindo: '6+', tsunamiLevel: 2 });
  assert.ok(r.fragments.some(f => f.name === 'ph_tsu_warning'));
  assert.ok(!r.fragments.some(f => f.name === 'ph_tsu_major'));
});

test('buildBulletin — tsunami advisory (level 1)', () => {
  const r = B.buildBulletin({ lang: 'jp', mag: 7.5, depth: 40, maxShindo: '5+', tsunamiLevel: 1 });
  assert.ok(r.fragments.some(f => f.name === 'ph_tsu_advisory'));
});

test('buildBulletin — no tsunami (level 0)', () => {
  const r = B.buildBulletin({ lang: 'jp', mag: 7.0, depth: 60, maxShindo: '5-', tsunamiLevel: 0 });
  assert.ok(!r.fragments.some(f => f.name.startsWith('ph_tsu')));
});

// ================================================================
//  AFFECTED PREFECTURES
// ================================================================

test('buildBulletin — affected prefectures (array format)', () => {
  const r = B.buildBulletin({
    lang: 'jp', mag: 7.0, depth: 30, maxShindo: '6+',
    affected: [
      { id: 13, shindo: '6+' },
      { id: 14, shindo: '5+' },
      { id: 11, shindo: 4 }
    ]
  });
  const names = r.fragments.map(f => f.name);
  assert.ok(names.includes('ph_affected'), 'should have ph_affected header');
  assert.ok(names.includes('pref_13'), 'Tokyo (pref 13)');
  assert.ok(names.includes('pref_14'), 'Kanagawa (pref 14)');
  assert.ok(names.includes('pref_11'), 'Saitama (pref 11)');
  // Check ordering: 6+ before 5+ before 4
  const prefIndices = ['pref_13','pref_14','pref_11'].map(n => names.indexOf(n));
  assert.ok(prefIndices[0] < prefIndices[1], '6+ should be announced before 5+');
  assert.ok(prefIndices[1] < prefIndices[2], '5+ should be announced before 4');
});

test('buildBulletin — affectedByShindo map format', () => {
  const r = B.buildBulletin({
    lang: 'zh', mag: 6.5, depth: 20, maxShindo: '5+',
    affectedByShindo: { 13: '5+', 14: '5-', 1: '3', 2: '2' }
  });
  const names = r.fragments.map(f => f.name);
  assert.ok(names.includes('pref_13'), 'should include Shindo >=3 prefecture');
  assert.ok(names.includes('pref_14'));
  assert.ok(names.includes('pref_01'));
  assert.ok(!names.includes('pref_02'), 'Shindo 2 should be excluded (<3)');
});

// ================================================================
//  DEEP EARTHQUAKE DEPTH (>= 100 km)
// ================================================================

test('buildBulletin — deep earthquake splits depth into digits', () => {
  const r = B.buildBulletin({ lang: 'jp', mag: 7.5, depth: 150, maxShindo: 4 });
  const names = r.fragments.map(f => f.name);
  // Should see num_01, num_05, num_00 instead of num_150
  assert.ok(names.includes('num_01'), 'digit 1');
  assert.ok(names.includes('num_05'), 'digit 5');
  assert.ok(names.includes('num_00'), 'digit 0');
  assert.ok(!names.includes('num_150'), 'should NOT have num_150');
});

// ================================================================
//  URL BASE
// ================================================================

test('buildBulletin — urlBase prefixes paths', () => {
  const r = B.buildBulletin({
    lang: 'en', mag: 6.0, depth: 10, maxShindo: 3,
    urlBase: 'https://quake.example.com'
  });
  const first = r.fragments[0];
  assert.ok(first.path.startsWith('https://quake.example.com/'), 'should have full URL');
  assert.ok(first.path.includes('/sounds/en/info/female/'), 'should include sound path');
});

test('buildBulletin — no urlBase gives relative paths', () => {
  const r = B.buildBulletin({ lang: 'jp', mag: 6.0, depth: 10, maxShindo: 3 });
  const first = r.fragments[0];
  assert.ok(first.path.startsWith('sounds/'), 'should be relative path');
});

// ================================================================
//  INVALID INPUT
// ================================================================

test('buildBulletin — invalid lang falls back to jp', () => {
  const r = B.buildBulletin({ lang: 'fr', mag: 5.0, depth: 20, maxShindo: 2 });
  assert.strictEqual(r.summary.lang, 'jp');
});

test('buildBulletin — zero magnitude produces valid output', () => {
  const r = B.buildBulletin({ mag: 0, depth: 10, maxShindo: 0 });
  assert.ok(r.fragments.length > 0);
  assert.ok(r.fragments.some(f => f.name === 'num_00'), 'mag 0 → num_00');
});

// ================================================================
//  FRAGMENT CATALOG
// ================================================================

test('getFragmentCatalog — returns structure', () => {
  const cat = B.getFragmentCatalog();
  assert.ok(cat.numbers);
  assert.strictEqual(cat.numbers.count, 100);
  assert.ok(cat.prefectures);
  assert.strictEqual(cat.prefectures.count, 47);
  assert.ok(cat.fixedPhrases);
  assert.ok(cat.fixedPhrases.keysEN.indexOf('ph_hour') === -1, 'EN should lack ph_hour');
  assert.ok(cat.fixedPhrases.keysJP.indexOf('ph_hour') >= 0, 'JP should have ph_hour');
  assert.deepStrictEqual(cat.languages, ['jp', 'en', 'zh']);
});

// ================================================================
//  FRAGMENT TYPE TAGS
// ================================================================

test('buildBulletin — fragments have type tags', () => {
  const r = B.buildBulletin({
    lang: 'zh', mag: 7.0, depth: 30, maxShindo: '6+',
    time: '2026-01-01T12:00:00Z',
    tsunamiLevel: 2,
    affected: [{ id: 13, shindo: '6+' }]
  });
  const types = r.fragments.map(f => f.type);
  assert.ok(types.includes('time'), 'should have time type');
  assert.ok(types.includes('intro'), 'should have intro type');
  assert.ok(types.includes('shindo'), 'should have shindo type');
  assert.ok(types.includes('mag'), 'should have mag type');
  assert.ok(types.includes('depth'), 'should have depth type');
  assert.ok(types.includes('tsunami'), 'should have tsunami type');
  assert.ok(types.includes('affected'), 'should have affected type');
  assert.ok(types.includes('pref'), 'should have pref type');
  assert.ok(types.includes('pref_int'), 'should have pref_int type');
});
