// ================================================================
//  Earthquake Simulator Pro v5.2 — NIED kmoni (強震モニタ) compute core
//  + classic Web Worker bootstrap.
//
//  This file is the SINGLE implementation of the per-frame heavy work
//  that used to run on the main thread inside rt-kmoni.js:
//    - 1725-char intensity string decoding (level = charCode - 100)
//    - per-station level time-series state (30-frame history ring,
//      no-data reuse, ascend window grow/collapse, frozen-feed reset)
//    - kanameishi-parity chain-activation shaking detection
//    - period-max tracker (60 s quiet reset, band-cross notify)
//    - strongest-stations top-N ranking
//
//  UMD shape:
//    - inside a classic Worker  -> sets self.RTKmoniCore and, because
//      importScripts exists there, installs self.onmessage (see protocol)
//    - under node (require)     -> module.exports = the same API, so
//      rt-kmoni.js can run the identical engine in-process as the
//      no-Worker fallback path and tests can drive it directly
//    - as a plain browser <script> -> window.RTKmoniCore (fallback path)
//
//  ----------------------- MESSAGE PROTOCOL -----------------------
//  Main -> Worker (structured clone):
//    {type:'init', stations:[[lat,lng],...], sensitivity?:'1'|'2'|'3'}
//        (Re)build the station state table + adjacency; resets the
//        period tracker and all per-station history. Sent after every
//        sitelist (re)load.
//    {type:'frame', now:<ms epoch>, intensity:<1725-char string>,
//                   sensitivity?:'1'|'2'|'3'}
//        Process one frame. `sensitivity` overrides the stored mode for
//        this frame only — mirrors the legacy "read the DOM select at
//        every detection pass" behavior; rt-kmoni sends the live value
//        with each frame.
//    {type:'config', sensitivity?:'1'|'2'|'3'}
//        Persist a detection mode for frames that omit `sensitivity`.
//    {type:'reset'}
//        Drop all state (engine back to empty; frames then reject with
//        reason 'no-stations').
//
//  Worker -> Main:
//    {type:'frame', ok:true, now,
//      raw:Int16Array,       // decoded levels as sent (-1 = no data)
//      levels:Int16Array,    // effective display levels after the
//                            // 4-frame no-data reuse
//      active:[idx...],      // detected + still-held stations
//      detected:[idx...],    // newly detected this frame (subset)
//      activeCount, maxLevel, hotIdx,   // hotIdx = hottest active station
//      periodMax, notify,    // notify = newly crossed shindo band 1..7, else -1
//      top:[{idx,lat,lng,level}...]}    // strongest stations, cap 8
//      — raw/levels are transferred (zero-copy), never retained.
//    {type:'frame', ok:false, reason:'no-stations'|'bad-length'}
// ================================================================
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.RTKmoniCore = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function() {

  // --- constants (moved verbatim from rt-kmoni.js) ---
  // detection threshold by neighbor-with-data count (medium sensitivity)
  var ACT = [Infinity, 9, 12, 14, 15, 16, 16];
  var ACTIVE_HOLD_MS = 10500;    // isActive hold after last detection
  var QUIET_RESET_MS = 60000;    // period-max reset after this much quiet
  var FEEDBACK_MIN_LEVEL = 8;    // shindo 1
  var TOP_N = 8;                 // strongest-stations panel rows

  // ================================================================
  //  PURE HELPERS
  // ================================================================

  // Decode the per-station intensity string: level = charCodeAt - 100,
  // clamped to [-1, 20] (-1 = no data; rare other negatives collapse to -1).
  function decodeIntensity(str) {
    var n = (typeof str === 'string') ? str.length : 0;
    var out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var v = str.charCodeAt(i) - 100;
      if (v < 0) v = -1;
      else if (v > 20) v = 20;
      out[i] = v;
    }
    return out;
  }

  // kanameishi-style level bands -> JMA shindo number ('0'..'7')
  function levelToShindo(level) {
    if (level <= 7) return '0';
    if (level <= 9) return '1';
    if (level <= 11) return '2';
    if (level <= 13) return '3';
    if (level <= 15) return '4';
    if (level <= 17) return '5';
    if (level <= 19) return '6';
    return '7';
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function itemLat(it) { return Array.isArray(it) ? it[0] : it.lat; }
  function itemLng(it) { return Array.isArray(it) ? it[1] : it.lng; }

  // For every station: indices of the nearest maxN stations within maxKm,
  // sorted by ascending distance. One-shot O(n^2). Island stations with at
  // most one neighbor inside maxKm additionally get their nearest station
  // within 40 km appended (kanameishi parity — otherwise they can never
  // form a detection quorum).
  function buildAdjacency(items, maxKm, maxN) {
    if (maxKm === undefined) maxKm = 30;
    if (maxN === undefined) maxN = 6;
    var n = items.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      var latI = itemLat(items[i]), lngI = itemLng(items[i]);
      var cand = [];
      var fbDist = 40, fbIdx = -1;
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var d = haversineKm(latI, lngI, itemLat(items[j]), itemLng(items[j]));
        if (d <= maxKm) cand.push([d, j]);
        else if (d < fbDist) { fbDist = d; fbIdx = j; }
      }
      cand.sort(function(a, b) { return a[0] - b[0]; });
      if (cand.length <= 1 && fbIdx >= 0) cand.push([fbDist, fbIdx]);
      var k = Math.min(cand.length, maxN);
      var nb = new Array(k);
      for (var m = 0; m < k; m++) nb[m] = cand[m][1];
      out[i] = nb;
    }
    return out;
  }

  // Per-station activity score from current level, recent ascend and
  // whether the station is already in the active set. Matches the
  // kanameishi/NIED-style gating: a station only scores when it is rising
  // (ascend > 0) or already active, and the ascend contribution counts
  // even at low levels — this is what lets a broad halo of slightly
  // elevated stations light up during weak shaking.
  function computeActivity(level, ascend, isActive) {
    if (level < 0) return 0;
    if (!(ascend > 0 || isActive)) return 0;
    var a = 0;
    if (level >= 12) a += 6 * (level - 10);
    else if (level >= 8) a += 2 * (level - 7);
    else if (level >= 6) a += (isActive ? 0.5 : 0.25) * (level - 5);
    // level <= 5: no level term, but the ascend term below still counts
    if (ascend >= 1) {
      if (ascend <= 1) a += isActive ? 0.5 : 0.25;
      else if (ascend <= 6) a += 2 * (ascend - 2) + 1;
      else a += 6 * (ascend - 5);
    }
    return a;
  }

  function triangular(n) { return n * (n + 1) / 2; }

  // Detection-sensitivity presets (kanameishi parity). mode '3' (high):
  // half the data-bearing neighbors as quorum and a -2 activity bar;
  // mode '1' (low): fixed 3-neighbor quorum and a +2 activity bar;
  // anything else: medium. Quorums are fractional on purpose — the
  // active-neighbor count below is discounted by 0.5 for stations that
  // barely moved (ascend <= 1 while not yet active).
  function sensitivityThresholds(mode) {
    if (mode === '3') {
      return { numThres: function(w) { return w / 2; }, actOffset: -2 };
    }
    if (mode === '1') {
      return { numThres: function() { return 3; }, actOffset: 2 };
    }
    return { numThres: function(w) { return w <= 2 ? (w + 1) / 2 : w / 2; }, actOffset: 0 };
  }

  // Chain-activation detection over candidate stations (activity > 0),
  // kanameishi parity. A seed station activates when enough of its
  // data-bearing neighbors are also active-ish (quorum per
  // sensitivityThresholds; stations that only twitched — ascend <= 1 and
  // not yet active — count half) AND the neighbor activity pool (seed's
  // own activity NOT included; neighbors ranked 4th+ and farther than
  // 15 km contribute half) plus a triangular-number bonus clears the ACT
  // threshold with the mode's offset. An already-active station that is
  // still rising re-chains immediately without a quorum test.
  // Activated seeds chain-activate every connected activity > 0 station.
  // Returns sorted indices of the detected set. `mode` ('1'|'2'|'3') is
  // explicit here — the UI default resolution lives in rt-kmoni.js.
  function detectActive(stations, adjacency, mode) {
    var th = sensitivityThresholds(mode);
    var n = stations.length;
    var result = [];
    var isIn = new Array(n);
    var checked = new Array(n);
    function chain(seed) {
      var queue = [seed];
      while (queue.length) {
        var cur = queue.pop();
        if (isIn[cur]) continue;
        isIn[cur] = true;
        result.push(cur);
        var cn = adjacency[cur] || [];
        for (var m = 0; m < cn.length; m++) {
          var j = cn[m];
          if (!isIn[j] && stations[j] && stations[j].activity > 0) {
            checked[j] = true; // already active via chain — no seed test needed
            queue.push(j);
          }
        }
      }
    }
    for (var i = 0; i < n; i++) {
      var st = stations[i];
      if (!st || st.activity <= 0 || checked[i]) continue;
      checked[i] = true;
      if (st.isActive && st.ascend > 0) { chain(i); continue; }
      var nb = adjacency[i] || [];
      var withData = 0, near = 0, pool = 0;
      for (var k = 0; k < nb.length; k++) {
        var ns = stations[nb[k]];
        if (!ns || ns.level <= -1) continue;
        withData++;
        if (ns.activity > 0) {
          near += (ns.ascend <= 1 && !ns.isActive) ? 0.5 : 1;
          var contrib = ns.activity;
          if (withData >= 4 && haversineKm(st.lat, st.lng, ns.lat, ns.lng) > 15) contrib /= 2;
          pool += contrib;
        }
      }
      var need = th.numThres(withData);
      var thr = ACT[Math.min(withData, 6)] + th.actOffset;
      if (near < need || pool + triangular(near) < thr) continue;
      chain(i);
    }
    result.sort(function(a, b) { return a - b; });
    return result;
  }

  // Period max-level tracker. Pure: takes previous state, returns new state.
  // {max, lastActiveMs, band, notify} — notify is the newly-crossed shindo
  // band number (1..7) when period max rises to >=8 into a higher band,
  // else -1. Resets after QUIET_RESET_MS with no active stations.
  function freshPeriod() {
    return { max: 0, lastActiveMs: 0, band: 0, notify: -1 };
  }

  function nextPeriodState(prev, activeMaxLevel, activeCount, nowMs) {
    var st = { max: prev.max, lastActiveMs: prev.lastActiveMs, band: prev.band, notify: -1 };
    if (activeCount > 0) {
      st.lastActiveMs = nowMs;
      if (activeMaxLevel > st.max) st.max = activeMaxLevel;
      var b = Number(levelToShindo(st.max));
      if (st.max >= FEEDBACK_MIN_LEVEL && b > st.band) {
        st.band = b;
        st.notify = b;
      }
    } else if (nowMs - st.lastActiveMs > QUIET_RESET_MS) {
      st.max = 0;
      st.band = 0;
    }
    return st;
  }

  // Strongest-stations ranking (panel data source). Pure: takes the station
  // records (or any [{lat,lng,level}...]), returns up to n entries
  // {idx, lat, lng, level} sorted by level desc with an index-ascending
  // tie-break (deterministic row order); no-data stations (level < 0) and
  // malformed entries are excluded. n defaults to TOP_N.
  function topStations(states, n) {
    var list = [];
    var len = (states && states.length) || 0;
    for (var i = 0; i < len; i++) {
      var st = states[i];
      if (!st || typeof st.level !== 'number' || !isFinite(st.level) || st.level < 0) continue;
      list.push({ idx: i, lat: st.lat, lng: st.lng, level: st.level });
    }
    list.sort(function(a, b) { return (b.level - a.level) || (a.idx - b.idx); });
    if (n == null) n = TOP_N;
    return list.slice(0, Math.max(0, n));
  }

  // Lightweight real-shaking check used while a demo suppresses the live
  // display: any station at shindo-2 band (level >= 11), or a network-wide
  // rise (>= 5 stations at shindo-1 band). Single-station level-8 blips occur
  // in the quiet feed and must not abort.
  function realActivityInLevels(levels) {
    var count8 = 0;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] >= 11) return true;
      if (levels[i] >= 8) count8++;
    }
    return count8 >= 5;
  }

  // ================================================================
  //  FRAME ENGINE — the per-frame state machine. One engine instance
  //  lives inside the worker; the no-Worker fallback path in rt-kmoni.js
  //  runs a second instance in-process. Same code, same results.
  // ================================================================
  function createEngine() {
    var stations = [];   // {lat,lng,level,recentLevel,ascend,activity,isActive,activeUntil,expireS,defaultExpireS}
    var adjacency = [];
    var period = freshPeriod();
    var cfgMode = '2';   // persisted sensitivity for frames that omit it

    function validMode(v) { return v === '1' || v === '2' || v === '3'; }

    // (Re)build the station table from [[lat,lng],...] or [{lat,lng},...].
    // expireS derives from the farthest adjacency distance (wave travel at
    // ~3.5 km/s) exactly as the legacy main-thread buildStations did.
    function init(items, sensitivity) {
      items = Array.isArray(items) ? items : [];
      stations = new Array(items.length);
      for (var i = 0; i < items.length; i++) {
        stations[i] = {
          lat: itemLat(items[i]), lng: itemLng(items[i]),
          level: -1, recentLevel: [], ascend: 0, activity: 0,
          isActive: false, activeUntil: 0, expireS: 5, defaultExpireS: 5
        };
      }
      adjacency = buildAdjacency(items, 30, 6);
      for (var s = 0; s < stations.length; s++) {
        var nb = adjacency[s];
        var far = 0;
        for (var k = 0; k < nb.length; k++) {
          var d = haversineKm(stations[s].lat, stations[s].lng,
            stations[nb[k]].lat, stations[nb[k]].lng);
          if (d > far) far = d;
        }
        stations[s].defaultExpireS = Math.max(5, Math.round(far / 3.5));
        stations[s].expireS = stations[s].defaultExpireS;
      }
      period = freshPeriod();
      if (validMode(sensitivity)) cfgMode = sensitivity;
    }

    function config(cfg) {
      if (cfg && validMode(cfg.sensitivity)) cfgMode = cfg.sensitivity;
    }

    function reset() {
      stations = [];
      adjacency = [];
      period = freshPeriod();
    }

    // Per-frame station update (kanameishi parity):
    // - a -1 (no data) frame reuses the last valid reading within 4 frames
    //   before going dark, so a single dropped frame never zeroes activity
    // - the ascend window (expireS) grows by 2 s per rising frame up to 30 s,
    //   which makes slow-building weak shaking accumulate ascend from a
    //   deeper baseline; it collapses back to the default on any drop
    // - a frozen feed (extended window with zero variation) also collapses
    function updateStations(levels, now) {
      for (var i = 0; i < stations.length; i++) {
        var st = stations[i];
        var origin = levels[i];
        var lv = origin;
        if (origin === -1) {
          lv = -1;
          for (var g = 0; g < Math.min(4, st.recentLevel.length); g++) {
            var rv = st.recentLevel[g];
            if (rv !== -1) { lv = rv; break; }
          }
        }
        if (lv > st.level && st.level !== -1) st.expireS = Math.min(st.expireS + 2, 30);
        else if (lv < st.level || lv === -1) st.expireS = st.defaultExpireS;
        st.level = lv;
        var min = Infinity, firstVal = -2, allSame = true, valid = 0;
        var w = Math.min(st.expireS, st.recentLevel.length);
        for (var k = 0; k < w; k++) {
          var v = st.recentLevel[k];
          if (v === -1) continue;
          if (v < min) min = v;
          if (firstVal === -2) firstVal = v;
          else if (v !== firstVal) allSame = false;
          valid++;
        }
        st.ascend = (lv > -1 && min < Infinity) ? Math.max(0, lv - min) : 0;
        st.isActive = now < st.activeUntil;
        st.activity = computeActivity(lv, st.ascend, st.isActive);
        st.recentLevel.unshift(origin);
        if (st.recentLevel.length > 30) st.recentLevel.pop();
        // frozen-feed reset: extended window with zero variation collapses
        if (st.expireS > st.defaultExpireS && !st.isActive &&
            st.recentLevel.length >= st.expireS && valid > 0 && allSame) {
          st.expireS = st.defaultExpireS;
        }
      }
    }

    // One frame: decode -> station update -> detect -> active set -> period.
    // Returns the wire result object (fresh Int16Arrays every call, safe to
    // transfer). sensitivity omits -> the persisted cfgMode.
    function frame(now, intensity, sensitivity) {
      if (!stations.length) return { type: 'frame', ok: false, reason: 'no-stations' };
      if (typeof intensity !== 'string') return { type: 'frame', ok: false, reason: 'bad-length' };
      var raw = decodeIntensity(intensity);
      if (raw.length !== stations.length) return { type: 'frame', ok: false, reason: 'bad-length' };
      if (typeof now !== 'number' || !isFinite(now)) now = Date.now();
      var mode = validMode(sensitivity) ? sensitivity : cfgMode;

      updateStations(raw, now);

      var detected = detectActive(stations, adjacency, mode);
      for (var d = 0; d < detected.length; d++) {
        var dst = stations[detected[d]];
        dst.activeUntil = now + ACTIVE_HOLD_MS;
        dst.isActive = true;
      }
      // effective active set: freshly detected + still-held stations
      var activeIdx = [];
      var maxLv = -1;
      var hotIdx = -1;
      var eff = new Int16Array(stations.length);
      for (var i = 0; i < stations.length; i++) {
        var st = stations[i];
        eff[i] = st.level;
        if (st.isActive) {
          activeIdx.push(i);
          if (st.level > maxLv) { maxLv = st.level; hotIdx = i; }
        }
      }

      period = nextPeriodState(period, maxLv, activeIdx.length, now);

      return {
        type: 'frame', ok: true, now: now,
        raw: raw, levels: eff,
        active: activeIdx, detected: detected,
        activeCount: activeIdx.length,
        maxLevel: maxLv, hotIdx: hotIdx,
        periodMax: period.max, notify: period.notify,
        top: topStations(stations, TOP_N)
      };
    }

    return {
      init: init,
      config: config,
      reset: reset,
      frame: frame,
      stationCount: function() { return stations.length; }
    };
  }

  return {
    // pure helpers (shared with rt-kmoni.js — single implementation)
    decodeIntensity: decodeIntensity,
    levelToShindo: levelToShindo,
    haversineKm: haversineKm,
    buildAdjacency: buildAdjacency,
    computeActivity: computeActivity,
    sensitivityThresholds: sensitivityThresholds,
    detectActive: detectActive,
    freshPeriod: freshPeriod,
    nextPeriodState: nextPeriodState,
    topStations: topStations,
    realActivityInLevels: realActivityInLevels,
    // engine factory + constants the main thread still renders with
    createEngine: createEngine,
    TOP_N: TOP_N,
    ACTIVE_HOLD_MS: ACTIVE_HOLD_MS
  };
});

// ================================================================
//  WORKER BOOTSTRAP — only inside a classic Worker scope (importScripts
//  exists). Plain browser windows and node skip this entirely.
// ================================================================
(function() {
  if (typeof importScripts !== 'function') return; // not a worker
  var core = (typeof self !== 'undefined' && self.RTKmoniCore) ? self.RTKmoniCore : null;
  if (!core) return;
  var engine = core.createEngine();
  self.onmessage = function(e) {
    var msg = e && e.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'init') { engine.init(msg.stations, msg.sensitivity); return; }
    if (msg.type === 'config') { engine.config(msg); return; }
    if (msg.type === 'reset') { engine.reset(); return; }
    if (msg.type === 'frame') {
      var res = engine.frame(msg.now, msg.intensity, msg.sensitivity);
      if (res && res.ok) self.postMessage(res, [res.raw.buffer, res.levels.buffer]);
      else self.postMessage(res);
    }
  };
})();
