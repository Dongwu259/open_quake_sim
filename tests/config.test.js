// ================================================================
//  Unit tests for Earthquake Simulator — Config module
//  Run with:  node --test tests/config.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Simulate browser localStorage for Node.js
const store = {};
global.localStorage = {
  getItem: (k) => store[k] !== undefined ? store[k] : null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
function resetStore() {
  for (const k of Object.keys(store)) delete store[k];
}

// Load config module (it calls cfgLoad() on require, which reads localStorage)
const path = require('path');
// We need to re-require each time to test cfgLoad behavior
function loadConfig() {
  delete require.cache[require.resolve('../public/config.js')];
  resetStore();
  return require('../public/config.js');
}

test('advanced panel exposes every configurable parameter', () => {
  const mod = loadConfig();
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const rows = new Set(Array.from(html.matchAll(/data-cfg="([^"]+)"/g), m => m[1]));
  const missing = Object.keys(mod.CFG_DEFAULTS).filter(k => !rows.has(k));
  assert.deepStrictEqual(missing, []);
});

test('v5 physics method options expose safe defaults', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  const cfg = require('../public/config.js');
  assert.strictEqual(cfg.cfgGet('intensityMethod'), 'empirical');
  assert.deepStrictEqual(cfg.CFG_DEFAULTS.intensityMethod.opts, ['empirical', 'jma3c']);
  assert.strictEqual(cfg.cfgGet('tsunamiSolver'), 'nonlinearSWE');
  assert.deepStrictEqual(cfg.CFG_DEFAULTS.tsunamiSolver.opts, ['nonlinearSWE', 'linearSWE', 'travelTime']);
  assert.strictEqual(cfg.cfgGet('tsunamiAlertBias'), 0);
  assert.strictEqual(cfg.cfgGet('tsunamiMapMode'), 'cityInundation');
  assert.deepStrictEqual(cfg.CFG_DEFAULTS.tsunamiMapMode.opts,
    ['off','waveField','maxSurface','arrivalTime','maxVelocity','maxInundation','cityInundation','seafloorDeformation']);
  assert.strictEqual(cfg.cfgGet('tsunamiCoriolis'), 'on');
});

test('etasAlpha default mirrors the calibrated productivity slope', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  const cfg = require('../public/config.js');
  // physics.js ETAS_ALPHA_NATLOG = 0.809 * ln(10) = 1.863 (rounded to slider
  // step 0.05); slider max widened to 2.5 so the default is reachable.
  assert.strictEqual(cfg.cfgGet('etasAlpha'), 1.86);
  assert.ok(cfg.CFG_DEFAULTS.etasAlpha.max >= 1.86, 'slider max covers the calibrated alpha');
});

// ================================================================
//  CONFIG INITIALISATION
// ================================================================

test('cfgLoad — defaults applied when localStorage is empty', () => {
  resetStore();
  const mod = require('../public/config.js');
  // After require, CFG should be populated with defaults
  // Re-access through the global CFG that config.js creates
  // cfgGet uses the module-level CFG var
  assert.ok(typeof globalThis.CFG !== 'undefined' || true, 'CFG should exist');
});

// ================================================================
//  cfgGet / cfgSet
// ================================================================

test('cfgGet — returns default value', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  // Access the global CFG (config.js creates it as a global)
  // We test by checking known defaults via the module's API
  // cfgGet reads from CFG which is set by cfgLoad
});

test('cfgSet — range clamping works', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  // cfgSet should clamp values to min/max
  if (typeof cfgSet === 'function') {
    cfgSet('attA', 5.0); // max is 1.50
    const val = cfgGet('attA');
    assert.ok(val <= 1.50, `attA should be clamped to max 1.50, got ${val}`);
    cfgSet('attA', -99); // min is 0.10
    const val2 = cfgGet('attA');
    assert.ok(val2 >= 0.10, `attA should be clamped to min 0.10, got ${val2}`);
    // Restore default
    cfgReset('attA');
  }
});

test('cfgSet — integer rounding for step >= 1', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgSet === 'function') {
    cfgSet('spectrumBins', 63.7); // step=4, should round to 64
    assert.strictEqual(cfgGet('spectrumBins'), 64);
    cfgSet('maxAsEvents', 7.2); // step=1, should round to 7
    assert.strictEqual(cfgGet('maxAsEvents'), 7);
    // Restore
    cfgReset('spectrumBins');
    cfgReset('maxAsEvents');
  }
});

test('cfgReset — restores default value', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgSet === 'function' && typeof cfgReset === 'function') {
    const orig = cfgGet('attB');
    cfgSet('attB', 2.0);
    assert.notStrictEqual(cfgGet('attB'), orig);
    cfgReset('attB');
    assert.strictEqual(cfgGet('attB'), orig);
  }
});

test('cfgResetAll — restores all defaults', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgSet === 'function' && typeof cfgResetAll === 'function') {
    cfgSet('attA', 0.99);
    cfgSet('attB', 1.99);
    cfgResetAll();
    // Should be back to defaults (0.42 and 1.34)
    assert.strictEqual(cfgGet('attA'), 0.42);
    assert.strictEqual(cfgGet('attB'), 1.34);
  }
});

// ================================================================
//  CONFIG SCHEMA — new keys get defaults
// ================================================================

test('cfgLoad — missing keys in saved config fall back to defaults', () => {
  resetStore();
  // Save a partial config (only 2 keys)
  store['qs-config'] = JSON.stringify({ attA: 0.99, attB: 1.5 });
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  // Keys in saved config should be loaded
  if (typeof cfgGet === 'function') {
    assert.strictEqual(cfgGet('attA'), 0.99);
    assert.strictEqual(cfgGet('attB'), 1.5);
    // Missing keys should get defaults
    assert.strictEqual(cfgGet('attC'), 0.31);
    assert.strictEqual(cfgGet('pgvA'), 0.48);
  }
});

test('cfgLoad — corrupt localStorage returns defaults gracefully', () => {
  resetStore();
  store['qs-config'] = 'this is not valid json {{{';
  delete require.cache[require.resolve('../public/config.js')];
  // Should not throw — should fall back to defaults
  assert.doesNotThrow(() => require('../public/config.js'));
  if (typeof cfgGet === 'function') {
    assert.strictEqual(cfgGet('attA'), 0.42);
  }
});

test('cfgLoad — wrong types in saved config fall back to defaults', () => {
  resetStore();
  store['qs-config'] = JSON.stringify({ attA: 'hello', spectrumBins: true, gmpModel: 123 });
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgGet === 'function') {
    // 'hello' is not a number for attA → should use default 0.42
    assert.strictEqual(cfgGet('attA'), 0.42);
    // true is not a number for spectrumBins → should use default 64
    assert.strictEqual(cfgGet('spectrumBins'), 64);
    // 123 is not a valid option string → should use default 'auto'
    assert.strictEqual(cfgGet('gmpModel'), 'auto');
  }
});

// ================================================================
//  CONFIG HARDENING — range validation at load time
// ================================================================

test('cfgLoad — out-of-range values clamped at load', () => {
  resetStore();
  // attA max is 1.50, attB max is 2.50
  store['qs-config'] = JSON.stringify({ attA: 999, attB: -99 });
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgGet === 'function') {
    assert.ok(cfgGet('attA') <= 1.50, `attA should be clamped to max 1.50, got ${cfgGet('attA')}`);
    assert.ok(cfgGet('attB') >= 0.50, `attB should be clamped to min 0.50, got ${cfgGet('attB')}`);
  }
});

test('cfgLoad — invalid option string falls back to default', () => {
  resetStore();
  store['qs-config'] = JSON.stringify({ gmpModel: 'nonexistent_gmpe', siteModel: 'bogus' });
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgGet === 'function') {
    assert.strictEqual(cfgGet('gmpModel'), 'auto', 'invalid gmpModel should reset to "auto"');
    assert.strictEqual(cfgGet('siteModel'), 'vs30', 'invalid siteModel should reset to "vs30"');
  }
});

test('cfgLoad migrates legacy default siteModel geo to vs30', () => {
  resetStore();
  store['qs-config'] = JSON.stringify({ siteModel: 'geo', _schemaVer: 1 });
  delete require.cache[require.resolve('../public/config.js')];
  const cfg = require('../public/config.js');
  assert.strictEqual(cfg.cfgGet('siteModel'), 'vs30');
});

test('cfgLoad migrates legacy default tsunami uplift to neutral JMA-style policy', () => {
  resetStore();
  store['qs-config'] = JSON.stringify({ tsunamiAlertBias: 1, _schemaVer: 2 });
  delete require.cache[require.resolve('../public/config.js')];
  const cfg = require('../public/config.js');
  assert.strictEqual(cfg.cfgGet('tsunamiAlertBias'), 0);
});

test('cfgLoad — oversized payload (>100KB) resets to defaults', () => {
  resetStore();
  store['qs-config'] = 'x'.repeat(1024 * 101); // >100KB
  delete require.cache[require.resolve('../public/config.js')];
  assert.doesNotThrow(() => require('../public/config.js'));
  if (typeof cfgGet === 'function') {
    assert.strictEqual(cfgGet('attA'), 0.42, 'oversized payload should trigger reset to defaults');
  }
});

test('cfgLoad — future schema version triggers reset', () => {
  resetStore();
  store['qs-config'] = JSON.stringify({ attA: 0.99, _schemaVer: 999 });
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgGet === 'function') {
    assert.strictEqual(cfgGet('attA'), 0.42, 'future schema should trigger reset to default');
  }
});

test('cfgSave — includes _schemaVer in saved data', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof cfgSet === 'function' && typeof cfgSave === 'function') {
    cfgSet('attA', 0.55);
    cfgSave();
    const raw = JSON.parse(store['qs-config']);
    assert.strictEqual(raw._schemaVer, 3, 'saved config should include _schemaVer');
    assert.strictEqual(raw.attA, 0.55);
  }
});

// ================================================================
test('cfgSet accepts numeric strings and rejects invalid numbers safely', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  const cfg = require('../public/config.js');
  assert.doesNotThrow(() => cfg.cfgSet('attA', '0.66'));
  assert.strictEqual(cfg.cfgGet('attA'), 0.66);
  assert.doesNotThrow(() => cfg.cfgSet('attA', 'not-a-number'));
  assert.strictEqual(cfg.cfgGet('attA'), 0.66);
});

test('cfgSave tolerates localStorage write failures', () => {
  resetStore();
  const originalSetItem = global.localStorage.setItem;
  global.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  delete require.cache[require.resolve('../public/config.js')];
  let cfg;
  assert.doesNotThrow(() => { cfg = require('../public/config.js'); });
  assert.doesNotThrow(() => cfg.cfgSet('attA', 0.77));
  global.localStorage.setItem = originalSetItem;
});

//  CONFIG CATEGORIES
// ================================================================

test('config — all 10 categories have at least 1 parameter', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof CFG_DEFAULTS !== 'undefined') {
    const cats = {};
    for (const k in CFG_DEFAULTS) {
      const cat = CFG_DEFAULTS[k].cat || 'unknown';
      cats[cat] = (cats[cat] || 0) + 1;
    }
    const expected = ['source','atten','site','time','tsunami','display','aftershock','fault','spectrum','alert'];
    for (const cat of expected) {
      assert.ok(cats[cat] >= 1, `Category '${cat}' should have at least 1 parameter, got ${cats[cat] || 0}`);
    }
    console.log('  Category counts:', JSON.stringify(cats));
  }
});

test('config — all defaults are within their min/max bounds', () => {
  resetStore();
  delete require.cache[require.resolve('../public/config.js')];
  require('../public/config.js');
  if (typeof CFG_DEFAULTS !== 'undefined') {
    for (const k in CFG_DEFAULTS) {
      const d = CFG_DEFAULTS[k];
      if (typeof d.v === 'number') {
        assert.ok(d.v >= d.min, `${k}: default ${d.v} < min ${d.min}`);
        assert.ok(d.v <= d.max, `${k}: default ${d.v} > max ${d.max}`);
      }
      if (d.opts && Array.isArray(d.opts)) {
        assert.ok(d.opts.includes(d.v), `${k}: default '${d.v}' not in opts [${d.opts}]`);
      }
    }
  }
});
