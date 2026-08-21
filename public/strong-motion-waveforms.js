(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StrongMotionWaveforms = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Event-level container for frozen K-NET/KiK-net waveform packages (see
  // tools/fetch-kyoshin-waveforms.js). Each entry of `stations` is a
  // WaveformData v1 payload, so single-station consumers keep using
  // WaveformData.validate / toObservedMotion unchanged.
  var SCHEMA = 'quake-sim-waveform-package-v1';
  var INDEX_SCHEMA = 'quake-sim-waveform-package-index-v1';

  function validatePackage(pkg) {
    var errors = [], warnings = [];
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      return { valid: false, errors: ['invalid-package'], warnings: warnings };
    }
    if (pkg.schema !== SCHEMA) errors.push('unsupported-schema');
    if (!Array.isArray(pkg.stations) || !pkg.stations.length) errors.push('no-stations');
    var ev = pkg.event || {};
    if (!ev.origintime) errors.push('missing-event-origintime');
    if (!(isFinite(Number(ev.lat)) && isFinite(Number(ev.lng)))) errors.push('missing-event-location');
    var validator = typeof WaveformData !== 'undefined' ? WaveformData : null;
    var ready = 0, seen = Object.create(null);
    (pkg.stations || []).forEach(function(s, i) {
      var id = s && s.station && s.station.id;
      if (!id) { errors.push('station-' + i + '-missing-id'); return; }
      if (seen[id]) warnings.push('duplicate-station-' + id);
      seen[id] = 1;
      if (validator) {
        var check = validator.validate(s);
        if (!check.valid) errors.push('station-' + id + ': ' + check.errors.join('|'));
        if (check.researchReady) ready++;
      }
    });
    var lengths = new Set();
    (pkg.stations || []).forEach(function(s) {
      if (s && s.components && s.components.z && s.components.n && s.components.e)
        lengths.add(s.components.z.samples.length);
    });
    if (lengths.size > 1) warnings.push('mixed-sample-lengths');
    return {
      valid: errors.length === 0, researchReady: errors.length === 0 && ready > 0,
      errors: errors, warnings: warnings, stationCount: (pkg.stations || []).length,
      certifiedStations: ready
    };
  }

  function validateIndex(index) {
    if (!index || index.schema !== INDEX_SCHEMA || !Array.isArray(index.events))
      return { valid: false, events: [] };
    return { valid: true, events: index.events };
  }

  // Vector PGA (gal) of a station payload from the frozen true peaks when
  // present, else from the decimated samples.
  function stationPga3c(payload) {
    var c = payload && payload.components;
    if (!c || !c.z || !c.n || !c.e) return null;
    function comp(v) {
      if (isFinite(Number(v && v.truePeakGal))) return Math.abs(Number(v.truePeakGal));
      var s = v && v.samples, peak = 0;
      if (s) for (var i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(Number(s[i]) || 0));
      return peak;
    }
    var z = comp(c.z), n = comp(c.n), e = comp(c.e);
    return Math.sqrt(z * z + n * n + e * e);
  }

  // Ranked per-station summary; `intensity` uses the official JMA filter when
  // Physics is on the page (browser) or passed via require (node tests).
  function packageSummary(pkg, opts) {
    opts = opts || {};
    var PhysicsRef = opts.Physics || (typeof Physics !== 'undefined' ? Physics : null);
    var rows = (pkg && pkg.stations || []).map(function(s) {
      var row = {
        id: s.station.id, name: s.station.name, network: s.station.network,
        lat: s.station.lat, lng: s.station.lng, pga3cGal: stationPga3c(s)
      };
      if (PhysicsRef && s.components && opts.computeIntensity !== false) {
        var I = PhysicsRef.calcJmaIntensity3C(
          { x: s.components.n.samples, y: s.components.e.samples, z: s.components.z.samples },
          Number(s.sampleRateHz));
        row.intensity = I;
      }
      return row;
    }).sort(function(a, b) { return (b.pga3cGal || 0) - (a.pga3cGal || 0); });
    return rows;
  }

  // Observed-vs-simulated station comparison against the frozen peaks
  // (observed) and a GMPE forecast (simulated) — the research overlay.
  function compareWithForecast(pkg, forecastFn, opts) {
    opts = opts || {};
    var rows = [];
    (pkg.stations || []).forEach(function(s) {
      var pred = forecastFn(s.station.lat, s.station.lng);
      if (pred == null || !isFinite(Number(pred))) return;
      var obs = stationPga3c(s);
      rows.push({ id: s.station.id, lat: s.station.lat, lng: s.station.lng, pga3cGal: obs, predicted: Number(pred) });
    });
    return rows;
  }

  function fetchBundledIndex(urlBase) {
    var base = urlBase || '/geojson/strong-motion-waveforms/';
    return fetch(base + 'index.json').then(function(r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(validateIndex);
  }

  function fetchPackage(id, urlBase) {
    var base = urlBase || '/geojson/strong-motion-waveforms/';
    return fetch(base + id + '.json').then(function(r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  return {
    SCHEMA: SCHEMA, INDEX_SCHEMA: INDEX_SCHEMA,
    validatePackage: validatePackage, validateIndex: validateIndex,
    stationPga3c: stationPga3c, packageSummary: packageSummary,
    compareWithForecast: compareWithForecast,
    fetchBundledIndex: fetchBundledIndex, fetchPackage: fetchPackage
  };
});
