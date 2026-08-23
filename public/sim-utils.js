// ================================================================
//  SimUtils — Pure computation utilities for Earthquake Simulator
//  UMD wrapper: works in browser (window.SimUtils) and Node.js (require)
//  ALL functions are pure: no DOM, no globals, explicit parameters only
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SimUtils = factory(); }
}(typeof self !== 'undefined' ? self : this, function() {

var U = {};

// ================================================================
//  XSS PREVENTION
// ================================================================

/**
 * Escape HTML special characters to prevent XSS injection.
 * Converts & < > " ' to their entity equivalents.
 * @param {*} str - Value to escape (non-strings are coerced)
 * @returns {string} HTML-safe string
 */
U.escapeHTML = function(str) {
  if (typeof str !== 'string') str = String(str == null ? '' : str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

// ================================================================
//  URL QUERY STRING PARSING
// ================================================================

/**
 * Parse a URL query string into a key-value object.
 * @param {string} qs - Raw query string (e.g. "lat=35.6&lng=139.7&mag=7.0")
 * @returns {object} Parsed parameters (values are URI-decoded strings)
 */
U.parseQueryString = function(qs) {
  var p = {};
  if (!qs) return p;
  // Strip leading '?' if present
  if (qs.charAt(0) === '?') qs = qs.substring(1);
  if (!qs) return p;
  var parts = qs.split('&');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var eq = parts[i].indexOf('=');
    if (eq <= 0) continue;
    try {
      var key = decodeURIComponent(parts[i].slice(0, eq).replace(/\+/g, ' '));
      var val = decodeURIComponent(parts[i].slice(eq + 1).replace(/\+/g, ' '));
      p[key] = val;
    } catch(e) {
      // Ignore malformed percent-encoded pairs while preserving valid params.
    }
  }
  return p;
};

// ================================================================
//  EPICENTER VALIDATION
// ================================================================

/**
 * Validate epicenter coordinates are within Japan region bounds.
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {boolean} True if coordinates are within Japan region (24-46N, 122-150E)
 */
U.isValidEpicenter = function(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (isNaN(lat) || isNaN(lng)) return false;
  return lat >= 24 && lat <= 46 && lng >= 122 && lng <= 150;
};

// ================================================================
//  SCENARIO ENCODING (multi-event share URL)
// ================================================================

/**
 * Encode a multi-event scenario to URL-safe base64 for share links.
 * Each event is [lat, lng, mag, depth, strike, dip, rake, time, mechanismKnown].
 * @param {Array<Array<number>>} events - Array of event tuples
 * @param {object} flags - {detect:bool, aftershock:bool, tsunami:bool}
 * @param {object|null} faultOpts - Optional finite-fault editor state
 * @param {Array} [manualAftershocks] - Optional manual aftershocks ({time,mag,depth,lat?,lng?})
 * @returns {string} URL-safe base64-encoded scenario string
 */
U.encodeScenario = function(events, flags, faultOpts, manualAftershocks) {
  var scn = {
    v: 1,
    e: events.map(function(ev) {
      // Null-safe fallbacks — an `||` chain here used to swallow falsy zeros
      // (strike=0 north, depth=0 surface, time=0) into the defaults, silently
      // rewriting shared mechanisms on a encode/decode round-trip.
      return [
        +(+(ev[0] != null ? ev[0] : ev.lat)).toFixed(3),
        +(+(ev[1] != null ? ev[1] : ev.lng)).toFixed(3),
        +(ev[2] != null ? ev[2] : (ev.mag != null ? ev.mag : 7.0)),
        +(ev[3] != null ? ev[3] : (ev.depth != null ? ev.depth : 30)),
        +(ev[4] != null ? ev[4] : (ev.strike != null ? ev.strike : 45)),
        +(ev[5] != null ? ev[5] : (ev.dip != null ? ev.dip : 90)),
        +(ev[6] != null ? ev[6] : (ev.rake != null ? ev.rake : 0)),
        +(ev[7] != null ? ev[7] : (ev.time != null ? ev.time : 0)),
        !!(ev[8] != null ? ev[8] : ev.mechanismKnown),
        // Optional 10th slot: bundled fault-model id (e.g. 'tohoku') so
        // shared chains keep observed slip models. Older links lack it.
        (ev[9] != null ? ev[9] : (ev.faultModel || null))
      ];
    }),
    f: { d: +!!flags.detect, a: +!!flags.aftershock, t: +!!flags.tsunami },
    fo: faultOpts || null
  };
  // Optional manual aftershocks: [time, mag, depth] per entry, with
  // [lat, lng] appended when the entry has its own map-picked epicenter.
  // Older links lack the field and decode with an empty list.
  if (manualAftershocks && manualAftershocks.length) {
    scn.asman = manualAftershocks.map(function(m) {
      var row = [Math.round(+m.time || 0), +(+m.mag || 0).toFixed(1), Math.round(+m.depth || 0)];
      if (isFinite(+m.lat) && isFinite(+m.lng)) { row.push(+(+m.lat).toFixed(3)); row.push(+(+m.lng).toFixed(3)); }
      return row;
    });
  }
  // UTF-8 safe Base64 encode (replaces deprecated unescape/encodeURIComponent)
  var raw = JSON.stringify(scn);
  var bytes = [];
  for (var bi = 0; bi < raw.length; bi++) {
    var cp = raw.charCodeAt(bi);
    if (cp < 0x80) { bytes.push(cp); }
    else if (cp < 0x800) { bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
    else { bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
  }
  var b64 = btoa(String.fromCharCode.apply(null, bytes));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Decode a URL-safe base64 scenario string back to a scenario object.
 * @param {string} b64 - URL-safe base64-encoded scenario string
 * @returns {object|null} Decoded scenario with .events, .flags, .faultOpts, .manualAftershocks, or null on error
 */
U.decodeScenario = function(b64) {
  try {
    // Normalize URL-safe base64 to standard base64
    var normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    // UTF-8 safe Base64 decode (replaces deprecated escape/atob combo)
    var bin = atob(normalized);
    var bytes = new Array(bin.length);
    for (var bj = 0; bj < bin.length; bj++) bytes[bj] = bin.charCodeAt(bj) & 0xff;
    var json = '';
    var bpos = 0;
    while (bpos < bytes.length) {
      var c1 = bytes[bpos++];
      var cp;
      if (c1 < 0x80) { cp = c1; }
      else if ((c1 & 0xe0) === 0xc0) { var c2 = bytes[bpos++]; cp = ((c1 & 0x1f) << 6) | (c2 & 0x3f); }
      else { var c2 = bytes[bpos++], c3 = bytes[bpos++]; cp = ((c1 & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f); }
      json += String.fromCharCode(cp);
    }
    var scn = JSON.parse(json);
    if (!scn || !scn.e || !Array.isArray(scn.e)) return null;
    return {
      events: scn.e.map(function(a) {
        return {
          lat: a[0], lng: a[1], mag: a[2], depth: a[3],
          strike: a[4], dip: a[5], rake: a[6], time: a[7] || 0,
          mechanismKnown:a.length>8 ? !!a[8] : false,
          faultModel:(a.length>9 && a[9]) ? String(a[9]) : null
        };
      }),
      flags: {
        tsunami: !!(scn.f && scn.f.t),
        detect: !!(scn.f && scn.f.d),
        aftershock: !!(scn.f && scn.f.a),
        multiEvent: true
      },
      faultOpts: scn.fo || null,
      manualAftershocks: (Array.isArray(scn.asman) ? scn.asman : []).filter(function(a) {
        return Array.isArray(a) && typeof a[1] === 'number' && isFinite(a[1]) && typeof a[2] === 'number' && isFinite(a[2]);
      }).map(function(a) {
        var e = { time: (typeof a[0] === 'number' && isFinite(a[0])) ? a[0] : 0, mag: a[1], depth: a[2] };
        if (typeof a[3] === 'number' && isFinite(a[3]) && typeof a[4] === 'number' && isFinite(a[4])) { e.lat = a[3]; e.lng = a[4]; }
        return e;
      })
    };
  } catch(e) {
    return null;
  }
};

// ================================================================
//  EEW GRID-SEARCH TRIANGULATION (pure computation core)
// ================================================================

/**
 * Core EEW triangulation: find the best-fit hypocenter by grid search.
 * Minimizes weighted RMS arrival-time residual over a lat/lng/depth grid.
 *
 * @param {Array<{lat:number,lng:number,t:number}>} stations - Stations with P-wave arrival times
 * @param {number} pWaveSpeed - P-wave velocity in km/s
 * @param {Array<number>} depthTry - Depths to sweep (e.g. [5, 15, 30, 50, 80, 120])
 * @param {object} [opts] - Optional tuning
 * @param {number} [opts.searchStep] - Grid step in degrees (auto if omitted)
 * @param {number} [opts.searchRange] - Search radius in degrees (auto if omitted)
 * @returns {{lat:number,lng:number,depth:number,error:number,originTime:number,uncertainty:number}}
 */
U.gridSearchTriangulate = function(stations, pWaveSpeed, depthTry, opts) {
  opts = opts || {};
  var n = stations.length;
  if (n < 3) return null;

  var nUse = Math.min(n, 50);
  var stns = stations.slice(0, nUse);

  // Compute centroid of triggering stations
  var centerLat = 0, centerLng = 0;
  for (var i = 0; i < nUse; i++) { centerLat += stns[i].lat; centerLng += stns[i].lng; }
  centerLat /= nUse; centerLng /= nUse;

  // Adaptive search resolution
  var searchStep = opts.searchStep;
  var searchRange = opts.searchRange;
  if (!searchStep) {
    searchStep = n < 10 ? 0.5 : n < 20 ? 0.2 : n < 50 ? 0.1 : 0.05;
  }
  if (!searchRange) {
    searchRange = n < 10 ? 8 : n < 20 ? 3 : n < 50 ? 1.5 : 1.0;
  }

  var bestLat = 36, bestLng = 138, bestDepth = 30, bestErr = Infinity;

  for (var di = 0; di < depthTry.length; di++) {
    var tryDepth = depthTry[di];
    for (var dlat = -searchRange; dlat <= searchRange; dlat += searchStep) {
      for (var dlng = -searchRange; dlng <= searchRange; dlng += searchStep) {
        var tLat = centerLat + dlat;
        var tLng = centerLng + dlng;

        // Compute origin time estimates from each station
        var times = [];
        for (var si = 0; si < stns.length; si++) {
          var d = U._haversine(tLat, tLng, stns[si].lat, stns[si].lng);
          d = Math.sqrt(d * d + tryDepth * tryDepth);
          times.push(stns[si].t - d / pWaveSpeed);
        }
        times.sort(function(a, b) { return a - b; });
        if (times.length === 0) continue;
        var t0 = times[Math.floor(times.length / 2)]; // median = robust origin time

        // Weighted RMS: earlier-arriving stations get higher weight
        var err = 0, wSum = 0;
        for (var si2 = 0; si2 < stns.length; si2++) {
          var d2 = U._haversine(tLat, tLng, stns[si2].lat, stns[si2].lng);
          d2 = Math.sqrt(d2 * d2 + tryDepth * tryDepth);
          var pred = t0 + d2 / pWaveSpeed;
          var w = 1.0 / Math.max(si2 + 1, 1);
          err += w * (pred - stns[si2].t) * (pred - stns[si2].t);
          wSum += w;
        }
        err = Math.sqrt(err / wSum);
        if (err < bestErr) {
          bestErr = err; bestLat = tLat; bestLng = tLng; bestDepth = tryDepth;
        }
      }
    }
  }

  return {
    lat: bestLat,
    lng: bestLng,
    depth: bestDepth,
    error: bestErr,
    uncertainty: Math.max(3, bestErr * pWaveSpeed * 0.8)
  };
};

// Internal haversine (avoid circular dependency with physics.js in test)
U._haversine = function(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat * 0.5) * Math.sin(dLat * 0.5) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng * 0.5) * Math.sin(dLng * 0.5);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ================================================================
//  SIMULATION STATE MACHINE
// ================================================================

/**
 * Simulation phase constants and valid transitions.
 * READY -> COUNTDOWN -> RUNNING -> COMPLETE
 */
U.SIM_PHASE = { READY: 'ready', COUNTDOWN: 'countdown', RUNNING: 'running', COMPLETE: 'complete' };

/**
 * Check if a phase transition is valid.
 * @param {string} from - Current phase
 * @param {string} to - Target phase
 * @returns {boolean}
 */
U.isValidPhaseTransition = function(from, to) {
  var order = { ready: 0, countdown: 1, running: 2, complete: 3 };
  var f = order[from], t = order[to];
  return f !== undefined && t !== undefined && t > f;
};

// ================================================================
//  SHINDO LABEL FORMATTING
// ================================================================

/**
 * Format a Shindo level as a display string with the appropriate symbol.
 * @param {number|string} shindo - Shindo level (0-7, 5-, 5+, 6-, 6+)
 * @returns {string} Formatted string e.g. "震度6+"
 */
U.formatShindoLabel = function(shindo) {
  if (shindo === 0 || shindo === '0') return '震度0';
  return '震度' + shindo;
};

// ================================================================
//  EEW FIRST-REPORT MAGNITUDE BIAS CORRECTION
// ================================================================

// Measured by tools/probe-eew-mag-bias.js (tools/data/eew-mag-bias-report.json,
// "before" phase): in detect mode the first bulletin underestimates the track's
// OWN converged (FINAL) magnitude by 0.79 / 1.03 / 1.09 M across the M5.0 /
// M6.8 / M9.1 probe scenarios — the earliest stations are still inside their
// P-S ramp when the bulletin is cut, so the nowcast PGA feeding the inversion
// is low. By bulletin 2 the residual is already <= 0.35 M. (The bias vs the
// TRUE magnitude is not sign-consistent — small events read hot steady-state,
// giant events saturate low — so only this same-signed first-report
// underestimate is corrected, never the steady-state offset.) Lift: +0.7 M at
// bulletin 1 (below the smallest measured delta), x0.25 per bulletin, exactly
// zero from bulletin 5 on — a converged FINAL is always >= #5, and app.js
// strips any residual lift explicitly when FINAL fires.
U.EEW_MAG_B1_LIFT = 0.7;
U.EEW_MAG_LIFT_DECAY = 0.25;
U.EEW_MAG_LIFT_LAST_BULLETIN = 4; // lift is exactly 0 from bulletin 5 on

/**
 * First-report magnitude bias correction for detect-mode EEW bulletins.
 * Positive lift only (underestimate correction), decaying with bulletin
 * number and exactly zero at/after bulletin 5 (FINAL convergence).
 * stationCount is validated but currently unused: the measured lift showed no
 * significant station-count dependence across 4-16 stations at bulletin 1.
 * @param {number} rawM - Uncorrected inverted magnitude
 * @param {number} bulletin - 1-based bulletin number this estimate publishes under
 * @param {number} stationCount - Stations in the track at solve time
 * @returns {number} Corrected magnitude, clamped to the [3, 10] app domain
 */
U.eewMagBulletinCorrection = function(rawM, bulletin, stationCount) {
  var M = Number(rawM);
  if (!isFinite(M)) return 0;
  var b = Math.floor(Number(bulletin));
  if (!isFinite(b) || b < 1) b = 1;
  var n = Math.floor(Number(stationCount));
  if (!isFinite(n) || n < 0) n = 0;
  var lift = 0;
  if (b <= U.EEW_MAG_LIFT_LAST_BULLETIN) lift = U.EEW_MAG_B1_LIFT * Math.pow(U.EEW_MAG_LIFT_DECAY, b - 1);
  var corrected = M + lift;
  if (corrected < 3) corrected = 3;
  if (corrected > 10) corrected = 10;
  return corrected;
};

// ================================================================
//  EEW GIANT-EVENT SATURATION-SPREAD LIFT
// ================================================================

// Measured by tools/probe-eew-mag-bias.js (round2 diag): once the inversion
// median is restricted to ramp-complete stations, a great interplate rupture
// reads as a tight distribution PINNED at the Zhao-2006 near-field saturation
// plateau (Tohoku M9.1: med ~7.9) with a positive far-field over-rupture tail
// (trimmed top ~8.3). Mid-size events sit below the plateau (M6.8 med 6.85,
// M7.3 med 7.38) with thin tails (top-med <= 0.15). The legacy wide-spread
// rule (spread > 1.0, +1.5 cap, >= 20 stations) stays for the mixed-ramp
// early-bulletin regime; the plateau rule below handles the ramp-complete
// steady state, lifting the median toward the tail (capped) so Tohoku-class
// FINALs land ~8.3 (JMA's own operational read was 7.9) instead of pinning
// at ~7.4. M6.5-7.5 events fail the plateau gate and move <= 0.2 even if a
// run-to-run flap opens it (the top clamp binds at top-med ~0.15).
U.EEW_MAG_GIANT_MED_GATE = 7.3;    // great-quake saturation plateau (faithful-Zhao regime: Tohoku med 7.44/top 8.02; M7.3 7.39/7.54 and M6.8 6.81/6.96 fail the 0.3 spread gate)
U.EEW_MAG_GIANT_SPREAD_GATE = 0.3; // far-field tail must be present, not huge
U.EEW_MAG_GIANT_LIFT_CAP = 0.5;    // max plateau lift toward the trimmed top
U.EEW_MAG_SPREAD_MIN_STATIONS = 20;  // legacy wide-spread rule gates
U.EEW_MAG_SPREAD_LEGACY = 1.0;
U.EEW_MAG_SPREAD_LEGACY_CAP = 1.5;

/**
 * Giant-event saturation-spread lift for the detect-mode trimmed-median
 * magnitude (JMA 巨大地震フラグ equivalent). Positive lift only, always
 * clamped to [medM, topM]: the far-field tail is evidence, not a target to
 * exceed. Two rules, whichever lifts more:
 *   legacy  — nVals >= 20 and spread > 1.0: min(topM, medM + 1.5)
 *   plateau — nVals >= 5, medM > 7.3, spread > 0.3: min(topM, medM + 0.5)
 * @param {number} medM - trimmed median of the per-station inversions
 * @param {number} topM - trimmed maximum of the same set
 * @param {number} nVals - number of inversions in the set
 * @returns {number} lifted median, clamped to the [3, 10] app domain
 */
U.eewGiantEventLift = function(medM, topM, nVals) {
  var med = Number(medM), top = Number(topM);
  if (!isFinite(med)) return 0;
  if (!isFinite(top) || top < med) top = med;
  var n = Math.floor(Number(nVals));
  if (!isFinite(n) || n < 0) n = 0;
  var spread = top - med;
  var lifted = med;
  if (n >= U.EEW_MAG_SPREAD_MIN_STATIONS && spread > U.EEW_MAG_SPREAD_LEGACY) {
    lifted = Math.min(top, med + U.EEW_MAG_SPREAD_LEGACY_CAP);
  }
  if (n >= 5 && med > U.EEW_MAG_GIANT_MED_GATE && spread > U.EEW_MAG_GIANT_SPREAD_GATE) {
    var plateau = Math.min(top, med + U.EEW_MAG_GIANT_LIFT_CAP);
    if (plateau > lifted) lifted = plateau;
  }
  if (lifted < 3) lifted = 3;
  if (lifted > 10) lifted = 10;
  return lifted;
};

return U;

}));
