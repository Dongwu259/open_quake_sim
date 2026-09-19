// ================================================================
//  v6.4 lazy-script round 1 — research/fault-import modules (~775KB)
//  moved off the boot path (window._ensureScript + LAZY_SCRIPTS
//  manifest + sw precache trim). These tests pin the contract:
//   1. inline lazy URLs carry CURRENT content hashes (staleness gate
//      independent of tools/bump-versions.js having run),
//   2. sw.js no longer precaches the lazy set (runtime-cached on
//      first use instead) while the boot-critical core stays listed,
//   3. index.html really dropped the <script src> tags and kept the
//      loader/manifest inline,
//   4. app.js keeps the entry-point gates (honest degrades when a
//      module has not landed yet).
//  Run with:  node --test tests/lazy-scripts.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

function sha1_6(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex').slice(0, 6);
}

const LAZY_FILES = [
  'observed-fault-models.js', 'finite-fault.js', 'waveform-analysis.js',
  'moment-tensor.js', 'waveform-data.js', 'strong-motion-data.js',
  'strong-motion-waveforms.js',
];

test('LAZY_SCRIPTS manifest carries current content hashes', () => {
  const block = html.match(/window\.LAZY_SCRIPTS = \{([\s\S]*?)\};/);
  assert.ok(block, 'LAZY_SCRIPTS manifest must exist in index.html');
  for (const file of LAZY_FILES) {
    const re = new RegExp("'" + file.replace('.', '\\.') + "\\?v=([0-9a-fA-F]*)'");
    const m = block[1].match(re);
    assert.ok(m, 'manifest must list ' + file);
    assert.equal(m[1], sha1_6(file), file + ' inline ?v= must equal the file content hash (run tools/bump-versions.js)');
  }
});

test('_loadThreeJS array is hash-versioned too (no bare immutable URLs)', () => {
  const m = html.match(/var scripts = \[([^\]]+)\]/);
  assert.ok(m, 'three.js loader array must exist');
  assert.match(m[1], /'three\.min\.js\?v=[0-9a-f]{6}'/, 'three.min.js must carry a ?v= hash');
  assert.equal(m[1].match(/three\.min\.js\?v=([0-9a-f]{6})/)[1], sha1_6('three.min.js'));
  assert.match(m[1], /'OrbitControls\.js\?v=[0-9a-f]{6}'/);
  assert.match(m[1], /'quake3d\.js\?v=[0-9a-f]{6}'/);
});

test('index.html no longer boot-loads the lazy set (loader kept inline)', () => {
  for (const file of LAZY_FILES) {
    assert.doesNotMatch(html, new RegExp('<script src="' + file.replace('.', '\\.'))), 'no boot tag for ' + file;
  }
  assert.match(html, /window\._ensureScript = function/, 'inline _ensureScript loader must exist');
  assert.match(html, /window\._loadScript = function/, 'inline _loadScript loader must exist');
  // reference-backend is node-test-only — not a boot script and not lazy-loaded either
  assert.doesNotMatch(html, /<script src="reference-backend\.js/);
  assert.ok(!Object.keys(html.match(/window\.LAZY_SCRIPTS = \{([\s\S]*?)\};/)[1].match(/[a-z\-]+\.js\?v=[0-9a-f]+/g) || [])
    .includes('reference-backend.js?v='), 'reference-backend must not be in the lazy manifest');
});

test('sw.js precache drops the lazy set, keeps the boot core', () => {
  const m = swSrc.match(/PRECACHE_URLS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PRECACHE_URLS must exist');
  for (const file of LAZY_FILES) {
    assert.ok(!m[1].includes("'" + file + "'"), file + ' must NOT be precached (runtime-cached on first use)');
  }
  assert.ok(!m[1].includes('reference-backend.js'), 'reference-backend must NOT be precached');
  for (const keep of ['app.js', 'physics.js', 'settings.js', 'i18n.js', 'audio.js', 'tsunami-validation.js', 'dc3d.js']) {
    assert.ok(m[1].includes("'" + keep + "'"), keep + ' stays precached (boot-critical)');
  }
});

test('app.js entry gates pin the lazy wiring', () => {
  assert.match(appSrc, /function _ensureFaultModelLibs\(/, 'fault-model libs resolver must exist');
  // preset fault-model branch must load-then-re-activate instead of silently skipping
  assert.match(appSrc, /_ensureFaultModelLibs\(\)\.then\(function \(ok\) \{\s*\n\s*if \(ok && currentPreset === value\) _activatePresetFaultModel/);
  // each on-demand consumer must gate on its module
  assert.match(appSrc, /_ensureScript\('MomentTensor',\s*'moment-tensor'\)/);
  assert.match(appSrc, /_ensureScript\('WaveAnalysis',\s*'waveform-analysis'\)/);
  assert.match(appSrc, /_ensureScript\('WaveFormData|_ensureScript\('WaveformData',\s*'waveform-data'\)/);
  assert.match(appSrc, /_ensureScript\('StrongMotionData',\s*'strong-motion-data'\)/);
  assert.match(appSrc, /_ensureScript\('StrongMotionWaveforms',\s*'strong-motion-waveforms'\)/);
  // sim start prefetches the analysis engine for end-of-run report capture
  assert.match(appSrc, /if \(typeof WaveAnalysis === 'undefined'\) _ensureScript\('WaveAnalysis', 'waveform-analysis'\)/);
  // the honest per-call guards stay (absent module = null result, never a crash)
  assert.match(appSrc, /typeof WaveAnalysis === 'undefined' \|\| !epicenter\) return null/);
  assert.match(appSrc, /typeof ObservedFaultModels==='undefined'\|\|typeof FiniteFault==='undefined'\)return null/);
});
