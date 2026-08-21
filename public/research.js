(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Research = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var SCENARIO_SCHEMA = 'quake-sim-scenario-v2';
  var SNAPSHOT_SCHEMA = 'quake-sim-result-v1';
  var _experimentCounter = 0;

  function stableStringify(value) {
    function normalize(v, stack) {
      if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
      if (typeof v === 'number') return isFinite(v) ? v : null;
      if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') return undefined;
      if (stack.indexOf(v) >= 0) throw new TypeError('Cannot hash cyclic data');
      stack.push(v);
      var out;
      if (Array.isArray(v)) {
        out = v.map(function(item) {
          var normalized = normalize(item, stack);
          return normalized === undefined ? null : normalized;
        });
      } else {
        out = {};
        Object.keys(v).sort().forEach(function(key) {
          var normalized = normalize(v[key], stack);
          if (normalized !== undefined) out[key] = normalized;
        });
      }
      stack.pop();
      return out;
    }
    return JSON.stringify(normalize(value, []));
  }

  // Two independently-seeded FNV-1a passes. This is a compact content
  // fingerprint for provenance and cache identity, not a cryptographic hash.
  function hash(value) {
    var str = typeof value === 'string' ? value : stableStringify(value);
    var h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      h1 ^= code; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= code + (i & 255); h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  function normalizeSeed(value) {
    if (typeof value === 'string' && !/^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(value)) {
      return parseInt(hash(value).slice(0, 8), 16) >>> 0;
    }
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return Math.floor(n) >>> 0;
  }

  function randomAt(seed, stream, index) {
    var x = normalizeSeed(seed) ^ parseInt(hash(String(stream || '')).slice(0, 8), 16) ^ normalizeSeed(index);
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967296;
  }

  function createRng(seed, stream) {
    var index = 0;
    return function() { return randomAt(seed, stream, index++); };
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function collectResourceVersions(doc) {
    var versions = {};
    if (!doc || !doc.querySelectorAll) return versions;
    var nodes = doc.querySelectorAll('script[src],link[href]');
    for (var i = 0; i < nodes.length; i++) {
      var raw = nodes[i].getAttribute('src') || nodes[i].getAttribute('href') || '';
      var match = raw.match(/(?:^|\/)([^/?#]+)\?v=([^&#]+)/);
      if (match) versions[match[1]] = match[2];
    }
    var build = doc.getElementById && doc.getElementById('build-ver');
    if (build && build.getAttribute('data-sw')) versions.serviceWorker = build.getAttribute('data-sw');
    return versions;
  }

  function createExperiment(options) {
    options = options || {};
    var createdAt = options.createdAt || new Date().toISOString();
    var seed = normalizeSeed(options.seed);
    var scenario = clone(options.scenario || {});
    var config = clone(options.config || {});
    var dataVersions = clone(options.dataVersions || {});
    var modelVersions = clone(options.modelVersions || {});
    var counter = options.nonce != null ? String(options.nonce) : String(++_experimentCounter);
    var configHash = hash(config);
    var scenarioHash = hash(scenario);
    var dataHash = hash(dataVersions);
    var modelHash = hash(modelVersions);
    var identity = hash({createdAt:createdAt, counter:counter, seed:seed, scenarioHash:scenarioHash, configHash:configHash});
    return {
      schema: 'quake-sim-experiment-v1',
      id: 'exp-' + createdAt.replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + identity.slice(0, 8),
      createdAt: createdAt,
      seed: seed,
      hashes: {config:configHash, scenario:scenarioHash, data:dataHash, model:modelHash},
      hashAlgorithm: 'fnv1a64-composite'
    };
  }

  function migrateScenario(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid scenario');
    var src = clone(payload);
    var events = Array.isArray(src.events) ? src.events.filter(function(e) {
      return e && isFinite(Number(e.lat)) && isFinite(Number(e.lng)) && isFinite(Number(e.mag)) && isFinite(Number(e.depth));
    }).map(function(e) {
      return {
        lat:Number(e.lat), lng:Number(e.lng), mag:Number(e.mag), depth:Number(e.depth),
        strike:isFinite(Number(e.strike)) ? Number(e.strike) : 0,
        dip:isFinite(Number(e.dip)) ? Number(e.dip) : 90,
        rake:isFinite(Number(e.rake)) ? Number(e.rake) : 0,
        mechanismKnown:e.mechanismKnown === true,
        time:isFinite(Number(e.time)) ? Number(e.time) : 0
      };
    }) : [];
    if (!events.length) throw new TypeError('Scenario has no valid events');
    var migrated = {
      schema: SCENARIO_SCHEMA,
      version: 2,
      name: typeof src.name === 'string' ? src.name.slice(0, 160) : 'Untitled',
      appVersion: typeof src.appVersion === 'string' ? src.appVersion : 'v5.4',
      created: typeof src.created === 'string' ? src.created : '',
      seed: normalizeSeed(src.seed == null ? 20260725 : src.seed),
      events: events,
      flags: clone(src.flags || {}),
      config: clone(src.config || {}),
      faultOpts: clone(src.faultOpts || {}),
      // v5.5: manual aftershocks ride along with the scenario (older payloads
      // lack the field -> []). Structural filter only; ranges clamp on apply.
      manualAftershocks: (Array.isArray(src.manualAftershocks) ? src.manualAftershocks : []).filter(function(m) {
        return m && isFinite(Number(m.mag)) && isFinite(Number(m.depth));
      }).map(function(m) {
        var e = { time:isFinite(Number(m.time)) ? Number(m.time) : 0, mag:Number(m.mag), depth:Number(m.depth) };
        if (isFinite(Number(m.lat)) && isFinite(Number(m.lng))) { e.lat = Number(m.lat); e.lng = Number(m.lng); }
        return e;
      }),
      display: clone(src.display || {}),
      dataVersions: clone(src.dataVersions || {}),
      modelVersions: clone(src.modelVersions || {}),
      experiment: clone(src.experiment || null)
    };
    return migrated;
  }

  function downsample(samples, maxPoints) {
    if (!Array.isArray(samples)) return [];
    maxPoints = Math.max(2, Math.floor(Number(maxPoints) || 2));
    if (samples.length <= maxPoints) return clone(samples);
    var out = [], last = -1;
    for (var i = 0; i < maxPoints; i++) {
      var idx = Math.round(i * (samples.length - 1) / (maxPoints - 1));
      if (idx !== last) out.push(clone(samples[idx]));
      last = idx;
    }
    return out;
  }

  function createSnapshot(options) {
    options = options || {};
    var stations = Array.isArray(options.stations) ? options.stations.slice() : [];
    stations.sort(function(a, b) { return Number(b.peakPga || 0) - Number(a.peakPga || 0); });
    return {
      schema: SNAPSHOT_SCHEMA,
      experiment: clone(options.experiment || null),
      scenario: clone(options.scenario || {}),
      config: clone(options.config || {}),
      summary: clone(options.summary || {}),
      waveform: downsample(options.waveform || [], options.maxWaveformPoints || 400),
      intensitySeries: downsample(options.intensitySeries || [], options.maxIntensityPoints || 180),
      stations: clone(stations.slice(0, options.maxStations || 250)),
      tsunami: clone(options.tsunami || {}),
      dataCertification: clone(options.dataCertification || null),
      diagnostics: clone(options.diagnostics || {}),
      completedAt: options.completedAt || new Date().toISOString()
    };
  }

  function flatten(value, prefix, out) {
    out = out || {};
    prefix = prefix || '';
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.keys(value).sort().forEach(function(key) { flatten(value[key], prefix ? prefix + '.' + key : key, out); });
    } else if (Array.isArray(value)) {
      out[prefix] = stableStringify(value);
    } else out[prefix] = value;
    return out;
  }

  function numericSeriesDiff(a, b, field) {
    var count = Math.min(a.length, b.length), sumSq = 0, maxAbs = 0;
    for (var i = 0; i < count; i++) {
      var av = Number(a[i] && a[i][field]), bv = Number(b[i] && b[i][field]);
      if (!isFinite(av) || !isFinite(bv)) continue;
      var d = bv - av; sumSq += d * d; if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    }
    return {count:count, rmse:count ? Math.sqrt(sumSq / count) : null, maxAbs:maxAbs};
  }

  function keyedDiff(a, b, keyFn, fields) {
    var left = {}, right = {}, keys = {};
    (a || []).forEach(function(item) { var key = keyFn(item); if (key) { left[key] = item; keys[key] = 1; } });
    (b || []).forEach(function(item) { var key = keyFn(item); if (key) { right[key] = item; keys[key] = 1; } });
    return Object.keys(keys).sort().map(function(key) {
      var row = {key:key, status:left[key] && right[key] ? 'matched' : (left[key] ? 'removed' : 'added')};
      fields.forEach(function(field) {
        var av = left[key] ? left[key][field] : null, bv = right[key] ? right[key][field] : null;
        row[field] = {a:av, b:bv, delta:isFinite(Number(av)) && isFinite(Number(bv)) ? Number(bv) - Number(av) : null};
      });
      return row;
    });
  }

  function compareSnapshots(a, b) {
    if (!a || !b) throw new TypeError('Two snapshots are required');
    var af = flatten({scenario:a.scenario || {}, config:a.config || {}});
    var bf = flatten({scenario:b.scenario || {}, config:b.config || {}});
    var all = {}; Object.keys(af).forEach(function(k){all[k]=1;}); Object.keys(bf).forEach(function(k){all[k]=1;});
    var parameterDiff = Object.keys(all).sort().filter(function(key) {
      return stableStringify(af[key]) !== stableStringify(bf[key]);
    }).map(function(key) { return {key:key, a:af[key], b:bf[key]}; });
    var summary = {};
    ['maxPga','maxPgv','maxShindoScore','maxTsunamiHeight'].forEach(function(key) {
      var av = Number(a.summary && a.summary[key]), bv = Number(b.summary && b.summary[key]);
      summary[key] = {a:isFinite(av)?av:null, b:isFinite(bv)?bv:null, delta:isFinite(av)&&isFinite(bv)?bv-av:null};
    });
    return {
      schema: 'quake-sim-comparison-v1',
      experiments: {a:a.experiment && a.experiment.id || null, b:b.experiment && b.experiment.id || null},
      parameterDiff: parameterDiff,
      summary: summary,
      waveform: numericSeriesDiff(a.waveform || [], b.waveform || [], 'a'),
      intensitySeries: numericSeriesDiff(a.intensitySeries || [], b.intensitySeries || [], 'shindo'),
      stations: keyedDiff(a.stations, b.stations, function(x){return String(x.id || x.name || '');}, ['peakPga','peakPgv','intensity']),
      tsunamiRegions: keyedDiff(a.tsunami && a.tsunami.regions, b.tsunami && b.tsunami.regions, function(x){return String(x.code || x.name || '');}, ['height','level'])
    };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    var index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
  }

  function residualMetrics(rows) {
    var residuals = (rows || []).map(function(row){return Number(row.residual);}).filter(isFinite);
    residuals.sort(function(a,b){return a-b;});
    if (!residuals.length) return {count:0,bias:null,rms:null,mae:null,median:null,p10:null,p50:null,p90:null};
    var sum=0,sumAbs=0,sumSq=0;
    residuals.forEach(function(v){sum+=v;sumAbs+=Math.abs(v);sumSq+=v*v;});
    return {count:residuals.length,bias:sum/residuals.length,rms:Math.sqrt(sumSq/residuals.length),mae:sumAbs/residuals.length,
      median:percentile(residuals,.5),p10:percentile(residuals,.1),p50:percentile(residuals,.5),p90:percentile(residuals,.9)};
  }

  return {
    SCENARIO_SCHEMA:SCENARIO_SCHEMA, SNAPSHOT_SCHEMA:SNAPSHOT_SCHEMA,
    stableStringify:stableStringify, hash:hash, normalizeSeed:normalizeSeed,
    randomAt:randomAt, createRng:createRng, collectResourceVersions:collectResourceVersions,
    createExperiment:createExperiment, migrateScenario:migrateScenario, downsample:downsample,
    createSnapshot:createSnapshot, compareSnapshots:compareSnapshots, residualMetrics:residualMetrics
  };
});
