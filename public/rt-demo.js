// ================================================================
//  rt-demo.js — EEW 演示 scenario driver
//  Turns the "EEW 演示" button into a full realtime-monitoring rehearsal:
//  a simulated earthquake (Nankai-margin M7.1 off the Kii peninsula) whose
//  shaking is rendered through the REALTIME display language — rt-eew wave
//  rings/panel/TTS plus rt-kmoni square station markers lighting up as the
//  P/S fronts sweep past the 1725-station kmoni network.
//
//  The site simulation engine is NOT started: its round station circles,
//  EEW bulletin box and wave rings would fight the realtime overlays. The
//  demo recomputes shaking with the same Physics functions instead (Zhao
//  2006 GMPE + JMA instrumental intensity + IASP91 travel times).
//
//  Synthetic kmoni_rt frames enter rt-kmoni through injectDemoFrame() and
//  take the exact live path — chain detection, 1° grid flash, period-max
//  shindo toast/sound and the realtime auto-focus all fire as they would
//  for a real event. Live kmoni frames are paused while the demo runs
//  (RTKmoni.setDemoMode), and a real incoming EEW aborts the demo.
//
//  Load after: rt-data.js, rt-kmoni.js, rt-eew.js, physics.js
//  Module pattern: browser global `RTDemo`; module.exports for node tests.
// ================================================================
var RTDemo = (function() {

  var SITE_API = '/api/kmoni/sitelist';   // same contract rt-kmoni consumes
  var TICK_MS = 1000;                     // kmoni_rt cadence
  var MAX_DURATION_S = 150;               // auto-stop (waves long past Japan)
  var MAX_LEVEL = 20;                     // kmoni wire clamp (level 20 = shindo 7)
  var SITELIST_TTL_MS = 6 * 3600e3;       // cached sitelist expires after 6 h

  // Demo source — matches the RTEew.demo() EEW reports (紀伊半島沖 M7.1)
  var SCENARIO = { lat: 33.0, lng: 136.0, depthKm: 20, mw: 7.1 };

  var running = false;
  var timer = null;
  var originMs = 0;
  var stationsPromise = null;             // cached sitelist fetch
  var stationsFetchedAt = 0;              // stationsPromise creation time (TTL above)
  var derived = null;                     // per-station {pT, sT, peak, base}
  var holdS = 0, tauS = 0, mwS = 6;
  var stateListener = null;               // UI hook (demo button label)
  var demoTimers = [];                    // scheduled 551 bulletin emissions
  var areasPromise = null;                // cached jma_subareas.json fetch
  var prefsPromise = null;                // cached japan_prefectures.geojson fetch
  var issued551 = false;                  // stop() clears the demo's map fills

  // ================================================================
  //  PURE HELPERS (node-testable, no DOM / no Physics dependency)
  // ================================================================

  // Deterministic quiet-period baseline per station (levels 3-5, like the
  // real network's microtremor band) — stable across frames and reloads.
  function baselineLevel(i) {
    return 3 + (((i * 2654435761) >>> 0) % 3);
  }

  // kmoni wire encoding: char code = level + 100; no-data (-1) -> 99.
  function encodeLevels(levels) {
    var out = '';
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i];
      if (lv < 0) out += String.fromCharCode(99);
      else out += String.fromCharCode(100 + Math.min(MAX_LEVEL, Math.round(lv)));
    }
    return out;
  }

  // Envelope for one station (mirrors the sim's Physics.wavePhaseEnvelope).
  // Before the P front: baseline. P phase: weak P coda only (5%→12% of peak,
  // level-capped at 15 ≈ 震度4). S phase: ramp to peak over waveSRampDur(mag).
  // Peak holds through sT+ramp+hold, then exponential decay toward baseline.
  // Peak <= base stays at baseline.
  function stationLevel(elapsedS, pT, sT, peak, base, hold, tau, mag) {
    if (peak <= base || elapsedS < pT) return base;
    var P = (typeof Physics !== 'undefined') ? Physics : null;
    var m = mag || 6;
    var rampDur = (P && P.waveSRampDur) ? P.waveSRampDur(m) : Math.min(12, Math.max(2, 1.5 * (m - 4)));
    if (elapsedS < sT + rampDur) {
      var frac;
      if (P && P.wavePhaseEnvelope) frac = P.wavePhaseEnvelope(elapsedS, pT, sT, m);
      else if (elapsedS < sT) frac = 0.05 + 0.07 * (elapsedS - pT) / Math.max(sT - pT, 0.1);
      else frac = Math.min(1, 0.12 + 0.88 * (elapsedS - sT) / rampDur);
      var lv = base + (peak - base) * frac;
      if (elapsedS < sT && lv > 15) lv = 15; // P-phase ceiling ≈ 震度4
      return lv;
    }
    if (elapsedS < sT + rampDur + hold) return peak;
    return base + (peak - base) * Math.exp(-(elapsedS - sT - rampDur - hold) / tau);
  }

  // Peak kmoni level from the Zhao 2006 GMPE pair — the same physics the sim
  // uses. The kmoni level scale follows rt-kmoni's levelToShindo bands
  // (shindo 1 starts at level 8, one shindo step ≈ 2 levels), which the JMA
  // instrumental intensity maps onto as level = 2·I + 6 — NOT I×10 (that
  // saturates: even 400 km out an M7.1 would read "shindo 7").
  // phys injectable for tests.
  function peakLevelFor(distKm, mw, depthKm, phys) {
    var P = phys || (typeof Physics !== 'undefined' ? Physics : null);
    if (!P) return 0;
    var pga = P.pgaZhao2006(mw, distKm, depthKm, 'crustal');
    var pgv = P.pgvZhao2006(mw, distKm, depthKm, 'crustal');
    var I = P.calcJmaIntensity(pga, pgv);
    return Math.max(0, Math.min(MAX_LEVEL, Math.round(2 * I + 6)));
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // JST ISO timestamp like the live feed emits ("2026-08-11T11:19:43+09:00")
  function jstIso(nowMs) {
    var d = new Date(nowMs + 9 * 3600e3);
    return d.toISOString().slice(0, 19) + '+09:00';
  }

  // kmoni level (0-20) -> P2P integer shindo scale (10..70, 0 = below 1)
  function levelToScaleInt(lv) {
    if (lv <= 7) return 0; if (lv <= 9) return 10; if (lv <= 11) return 20;
    if (lv <= 13) return 30; if (lv <= 15) return 40; if (lv === 16) return 45;
    if (lv === 17) return 50; if (lv === 18) return 55; if (lv === 19) return 60;
    return 70;
  }

  // ================================================================
  //  DRIVER (browser only)
  // ================================================================

  function isRtActive() {
    return typeof RTData !== 'undefined' && typeof RTData.isActive === 'function' && RTData.isActive();
  }

  // Sitelist cache: shared by concurrent start() clicks, re-fetched once it
  // is older than SITELIST_TTL_MS (a sitelist change or a transiently bad
  // 2xx payload must not stick for the whole session). Failures still clear
  // the slot so the next click retries — same as before.
  function stationsCacheFresh(fetchedAt, now) {
    return fetchedAt > 0 && now - fetchedAt < SITELIST_TTL_MS;
  }

  function fetchStations() {
    if (stationsPromise && stationsCacheFresh(stationsFetchedAt, Date.now())) return stationsPromise;
    stationsFetchedAt = Date.now(); // creation time — pending fetches are shared too
    var p = fetch(SITE_API).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(json) {
      var items = Array.isArray(json) ? json : ((json && json.items) || []);
      return items.map(function(it) {
        return { lat: Array.isArray(it) ? it[0] : it.lat, lng: Array.isArray(it) ? it[1] : it.lng };
      });
    }).catch(function(e) {
      if (stationsPromise === p) { stationsPromise = null; stationsFetchedAt = 0; } // allow retry on next click
      throw e;
    });
    stationsPromise = p;
    return p;
  }

  function fetchJsonCached(which, url) {
    var slot = which === 'areas' ? 'areasPromise' : 'prefsPromise';
    if (which === 'areas' ? areasPromise : prefsPromise) return which === 'areas' ? areasPromise : prefsPromise;
    var p = fetch(url).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function(e) {
      if (slot === 'areas') areasPromise = null; else prefsPromise = null;
      throw e;
    });
    if (slot === 'areas') areasPromise = p; else prefsPromise = p;
    return p;
  }

  // ================================================================
  //  SYNTHETIC 551 BULLETINS (drive RTQuakeInfo's fills/TTS like JMA does)
  //  ScalePrompt (prefecture fills) ~12 s in, DetailScale (subdivision fills)
  //  ~25 s in — the same sequence a real event follows, compressed.
  // ================================================================

  // Per-subdivision peak level: GMPE at each area's centroid. Returns
  // [{name, pref, level}] sorted by level desc. turf + Physics required.
  function computeAreaLevels(areasGeo, prefsGeo) {
    var out = [];
    var feats = (areasGeo && areasGeo.features) || [];
    var prefs = (prefsGeo && prefsGeo.features) || [];
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      var c = null;
      try { c = turf.centroid(f).geometry.coordinates; } catch (e) { continue; }
      var prefName = '';
      for (var j = 0; j < prefs.length; j++) {
        try {
          if (turf.booleanPointInPolygon(turf.point(c), prefs[j])) {
            prefName = prefs[j].properties.nam_ja || prefs[j].properties.nam || '';
            break;
          }
        } catch (e2) {}
      }
      var d = haversineKm(SCENARIO.lat, SCENARIO.lng, c[1], c[0]);
      out.push({ name: f.properties.name, pref: prefName, level: peakLevelFor(d, SCENARIO.mw, SCENARIO.depthKm) });
    }
    out.sort(function(a, b) { return b.level - a.level; });
    return out;
  }

  function emit551(issueType, areaLevels) {
    if (typeof RTQuakeInfo === 'undefined' || !RTQuakeInfo.handleEvent) return;
    var points = [];
    var maxScale = 0;
    var i;
    if (issueType === 'ScalePrompt') {
      // prefecture scope, shindo >= 3 only (level >= 12)
      var byPref = {};
      for (i = 0; i < areaLevels.length; i++) {
        var a = areaLevels[i];
        if (!a.pref || a.level < 12) continue;
        if (!(a.pref in byPref) || a.level > byPref[a.pref]) byPref[a.pref] = a.level;
      }
      for (var pn in byPref) {
        var sc = levelToScaleInt(byPref[pn]);
        if (sc > maxScale) maxScale = sc;
        points.push({ pref: pn, addr: pn, scale: sc, isArea: false });
      }
    } else {
      // DetailScale: subdivision scope, shindo 1+ (level >= 8)
      for (i = 0; i < areaLevels.length; i++) {
        var ar = areaLevels[i];
        if (ar.level < 8) continue;
        var sc2 = levelToScaleInt(ar.level);
        if (sc2 > maxScale) maxScale = sc2;
        points.push({ pref: ar.pref, addr: ar.name, scale: sc2, isArea: true });
      }
    }
    if (!points.length) return;
    issued551 = true;
    RTQuakeInfo.handleEvent({
      code: 551,
      id: 'RTDEMO-' + originMs + '-' + issueType,
      issueType: issueType,
      maxIntensity: maxScale,
      originTime: jstIso(originMs).slice(0, 19).replace('T', ' ').replace(/-/g, '/'),
      time: jstIso(Date.now()),
      serial: 1,
      place: '紀伊半島沖', mag: SCENARIO.mw, depth: SCENARIO.depthKm,
      domesticTsunami: 'None',
      points: points
    });
  }

  function scheduleBulletins() {
    // kick the geojson fetches immediately so they are ready when due
    var geo = Promise.all([
      fetchJsonCached('areas', '/geojson/jma_subareas.json'),
      fetchJsonCached('prefs', '/geojson/japan_prefectures.geojson')
    ]);
    demoTimers.push(setTimeout(function() {
      if (!running) return;
      geo.then(function(rs) {
        if (!running) return;
        emit551('ScalePrompt', computeAreaLevels(rs[0], rs[1]));
      }).catch(function() {});
    }, 12000));
    demoTimers.push(setTimeout(function() {
      if (!running) return;
      geo.then(function(rs) {
        if (!running) return;
        emit551('DetailScale', computeAreaLevels(rs[0], rs[1]));
      }).catch(function() {});
    }, 25000));
  }

  // One-shot per-station precomputation: distance, P/S arrival seconds and
  // the peak level each station will reach. The 1 Hz tick then only evaluates
  // the cheap envelope gate per station.
  function buildDerived(stations) {
    var depth = SCENARIO.depthKm, mw = SCENARIO.mw;
    var pSpeed = (typeof cfgGet === 'function' ? cfgGet('pWaveSpeed') : 0) || 5.8;
    var sSpeed = (typeof cfgGet === 'function' ? cfgGet('sWaveSpeed') : 0) || 3.3;
    var out = new Array(stations.length);
    for (var i = 0; i < stations.length; i++) {
      var d = haversineKm(SCENARIO.lat, SCENARIO.lng, stations[i].lat, stations[i].lng);
      var base = baselineLevel(i);
      var pk = peakLevelFor(d, mw, depth);
      // below the shindo-1 band the station does not visibly react — stays on
      // its quiet baseline (avoids the whole country popping shindo-0 icons)
      out[i] = {
        pT: Physics.pTravelTime(d, depth, pSpeed),
        sT: Physics.sTravelTime(d, depth, sSpeed),
        peak: pk >= 8 ? pk : base,
        base: base
      };
    }
    holdS = mw * 2.5;          // same hold law as the sim (mag * 2.5 s)
    tauS = 6 + mw * 3;         // gentle decay tail for the demo
    mwS = mw;                  // for the S-ramp duration in stationLevel
    return out;
  }

  function tick() {
    if (!running || !derived) return;
    var elapsed = (Date.now() - originMs) / 1000;
    if (elapsed > MAX_DURATION_S) { stop(); return; }
    var levels = new Array(derived.length);
    for (var i = 0; i < derived.length; i++) {
      var st = derived[i];
      levels[i] = Math.round(stationLevel(elapsed, st.pT, st.sT, st.peak, st.base, holdS, tauS, mwS));
    }
    try {
      RTKmoni.injectDemoFrame({ dataTime: jstIso(Date.now()), intensity: encodeLevels(levels) });
    } catch (e) {}
  }

  // Start the rehearsal. Requires realtime mode; returns false otherwise.
  // EEW rings start immediately; station reactions begin once the sitelist
  // is ready (first click may fetch it, later clicks reuse the cache).
  function start() {
    if (!isRtActive()) return false;
    if (typeof RTKmoni === 'undefined' || typeof Physics === 'undefined') return false;
    if (running) stop(); // clean restart on repeated clicks

    running = true;
    originMs = Date.now();

    // EEW rings / panel / TTS pinned to the same origin time; the demo event
    // stays on screen for the whole rehearsal and is removed by stop()
    if (typeof RTEew !== 'undefined') {
      if (RTEew.setDemoPinned) { try { RTEew.setDemoPinned(true); } catch (e) {} }
      if (RTEew.demo) { try { RTEew.demo(originMs); } catch (e) {} }
    }
    // Real shaking on the live feed aborts the rehearsal (rt-kmoni watches)
    if (RTKmoni.setDemoAbortHandler) {
      try { RTKmoni.setDemoAbortHandler(function() { stop(); }); } catch (e) {}
    }
    if (stateListener) { try { stateListener(true); } catch (e) {} }

    fetchStations().then(function(stations) {
      if (!running || !stations.length) return;
      if (RTKmoni.setDemoMode) RTKmoni.setDemoMode(true); // pause the live feed
      derived = buildDerived(stations);
      tick();
      timer = setInterval(tick, TICK_MS);
      scheduleBulletins(); // 551 fills/TTS at +12 s (pref) and +25 s (areas)
    }).catch(function(e) {
      if (typeof console !== 'undefined') console.warn('RTDemo sitelist failed:', e && e.message);
      stop();
    });
    return true;
  }

  function stop() {
    if (!running) return;
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    for (var i = 0; i < demoTimers.length; i++) clearTimeout(demoTimers[i]);
    demoTimers = [];
    derived = null;
    if (typeof RTKmoni !== 'undefined') {
      if (RTKmoni.setDemoAbortHandler) { try { RTKmoni.setDemoAbortHandler(null); } catch (e) {} }
      if (RTKmoni.setDemoMode) { try { RTKmoni.setDemoMode(false); } catch (e) {} }
    }
    // Rings + panel close together with the station reactions; demo-issued
    // 551 fills are cleared too (a real bulletin's fills stay — issued551 is
    // only set by our own emissions)
    if (typeof RTEew !== 'undefined') {
      if (RTEew.setDemoPinned) { try { RTEew.setDemoPinned(false); } catch (e) {} }
      if (RTEew.clearDemo) { try { RTEew.clearDemo(); } catch (e) {} }
    }
    if (issued551) {
      issued551 = false;
      if (typeof RTQuakeInfo !== 'undefined' && RTQuakeInfo.clearObserved) {
        try { RTQuakeInfo.clearObserved(); } catch (e) {}
      }
    }
    if (stateListener) { try { stateListener(false); } catch (e) {} }
  }

  function isRunning() { return running; }

  // UI hook: called with true on start, false on stop (any cause — manual,
  // auto-timeout, realtime off, real EEW, real shaking)
  function setStateListener(fn) { stateListener = (typeof fn === 'function') ? fn : null; }

  function getState() {
    return {
      running: running,
      elapsedS: running ? (Date.now() - originMs) / 1000 : 0,
      stationCount: derived ? derived.length : 0
    };
  }

  return {
    start: start,
    stop: stop,
    isRunning: isRunning,
    setStateListener: setStateListener,
    getState: getState,
    SCENARIO: SCENARIO,
    // pure helpers (exported for node tests)
    baselineLevel: baselineLevel,
    encodeLevels: encodeLevels,
    stationLevel: stationLevel,
    peakLevelFor: peakLevelFor,
    levelToScaleInt: levelToScaleInt,
    haversineKm: haversineKm,
    // sitelist cache TTL (exported for node tests — stub globalThis.fetch)
    fetchStations: fetchStations,
    stationsCacheFresh: stationsCacheFresh,
    SITELIST_TTL_MS: SITELIST_TTL_MS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTDemo;
