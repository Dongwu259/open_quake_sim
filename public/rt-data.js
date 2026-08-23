// ================================================================
//  Earthquake Simulator Pro v4.3 — Real-Time Data Subsystem
//  SSE/WebSocket + USGS polling + live earthquake events
//  Load after: physics.js, config.js, i18n.js, sim-utils.js
//  Load before: app.js
// ================================================================
var RTData = (function() {
  // --- state ---
  var mode = false;
  var timer = null;
  var data = [];
  var seen = {};
  var seenKeys = [];
  var usgsLast = 0;
  var p2pLast = 0;
  var liveSources = null;
  var skipCountdown = false;
  var renderTimer = null;
  var fetching = false;
  var mapLayer = null;
  var mapMarkers = [];
  var lastHTML = '';
  var delegated = false;

  // EEW 続報 auto-sim revision — set only when THIS module auto-started the
  // currently running sim from a Wolfx EEW serial-1 frame. Single-event runs
  // only: chain/scenario sims are never tracked, so revisions/cancels can
  // never touch them (or any sim the user started manually).
  var _autoSimEventId = null;
  var _autoSimParams = null;    // {mag, lat, lng, depth} the running sim was launched with

  // P2P connection
  var p2pSource = null;
  var p2pReconnectTimeout = null;
  var p2pRetries = 0;
  var lastSseFrameAt = 0;      // last frame of ANY type on the active stream
  var sseWatchdogTimer = null;
  var SSE_SILENCE_MS = 30000;  // kmoni/jma_feed frames arrive every ~1-2 s

  // --- constants ---
  var MAX_SEEN = 200;
  var MAX_ITEMS = 15;

  var SRC_COLORS = {
    'USGS':'#ccee33','EMSC':'#f1c40f','P2P':'#2ecc71','Wolfx':'#e67e22',
    'GEOFON':'#9b59b6','CENC':'#e74c3c','GEONET':'#3498db',
    'CWA':'#1abc9c','IRIS':'#95a5a6','IRIS-WS':'#7f8c8d','JMA':'#fd79a8','JMA-Feed':'#e84393'
  };

  // Live-feed agency ids -> display agency. Wolfx republishes official JMA /
  // CENC / CWA bulletins, so the list credits the issuing agency, not the relay.
  var SRC_ALIAS = {
    'WOLFX_EQ': 'JMA', 'WOLFX_JMA': 'JMA', 'P2PQUAKE': 'JMA',
    'WOLFX_CENC': 'CENC', 'WOLFX_CWA': 'CWA', 'WOLFX_USGS': 'USGS'
  };

  var MAG_COLORS = ['#a0d2f0','#6cb4ee','#2ecc71','#f1c40f','#e67e22','#e74c3c','#c0392b','#8e44ad'];

  // Per-agency bulletin chimes for brand-new history entries. P2P returns
  // null: JMA 551 bulletins already sound + speak through rt-quakeinfo.
  var BULLETIN_SOUNDS = { 'JMA': 'Bulletin_JMA', 'CENC': 'Bulletin_CENC' };
  var BULLETIN_FRESH_MS = 15 * 60 * 1000; // backlog items never chime

  function bulletinSoundFor(src) {
    if (!src) return 'Bulletin_Other';
    var s = String(src).toUpperCase();
    if (s === 'P2P' || s === 'WOLFX') return null; // EEW / 551 have their own cues
    return BULLETIN_SOUNDS[s] || 'Bulletin_Other';
  }

  // Only genuinely fresh bulletins chime — a stream reconnect / first fetch
  // must not replay chimes for hour-old backlog entries.
  function isFreshBulletin(item, nowMs, windowMs) {
    var t = new Date(item && item.time).getTime();
    var win = (windowMs > 0) ? windowMs : BULLETIN_FRESH_MS;
    return isFinite(t) && (nowMs - t) >= 0 && (nowMs - t) < win;
  }

  function playBulletinChime(src) {
    if (replaying) return; // replayed history is silent
    var name = bulletinSoundFor(src);
    if (!name) return;
    if (typeof playEEWSound === 'function') { try { playEEWSound(name); } catch (e) {} }
  }

  function t(k) { return (typeof window.t === 'function') ? window.t(k) : k; }

  // i18n with inline fallback: realtime.autosim_revised / autosim_canceled
  // are in i18n.js now; t() echoes the key back when no translation exists,
  // so the Japanese fallback only survives for stale cached dictionaries.
  function tFb(k, fb) {
    var s = t(k);
    return (s === k) ? fb : s;
  }

  // ================================================================
  //  NORMALIZERS — pure data transforms
  // ================================================================

  function normalizeUSGS(f) {
    var props = f.properties || {};
    var coords = (f.geometry && f.geometry.coordinates) ? f.geometry.coordinates : [0, 0, 0];
    // /api/earthquakes merges the live multi-source feed; properties.source
    // then carries the real agency (WOLFX_EQ/WOLFX_CENC/P2PQUAKE/...). Plain
    // USGS features have no such field and stay 'USGS'.
    var srcRaw = String(props.source || 'USGS').toUpperCase();
    var src = SRC_ALIAS[srcRaw] || srcRaw;
    return {
      id: 'usgs_' + (props.ids || props.code || f.id || ''),
      mag: Math.round((props.mag || 0) * 10) / 10,
      lat: Math.round(coords[1] * 10000) / 10000,
      lng: Math.round(coords[0] * 10000) / 10000,
      depth: Math.round(coords[2] || 10),
      place: props.place || '',
      maxShindo: (props.maxShindo !== undefined && props.maxShindo !== null) ? String(props.maxShindo) : '',
      time: (props.time) ? new Date(props.time).toISOString() : '',
      source: src,
      sources: [src],
      raw: f
    };
  }

  function normalizeP2P(evt) {
    var em = evt.earthquake || evt;
    return {
      id: 'p2p_' + (em.id || em.event_id || ''),
      code: (typeof evt.code !== 'undefined') ? evt.code : 0,
      mag: Math.round((em.mag || em.magnitude || 0) * 10) / 10,
      lat: Math.round((em.lat || em.latitude || 0) * 10000) / 10000,
      lng: Math.round((em.lng || em.longitude || 0) * 10000) / 10000,
      depth: Math.round(em.depth || 30),
      place: em.place || em.region || '',
      time: (em.time) ? new Date(em.time).toISOString() : '',
      source: 'P2P',
      sources: ['P2P'],
      raw: evt
    };
  }

  function parseJstTime(s) {
    // 'YYYY/MM/DD HH:mm:ss.SSS' in JST (UTC+9) → epoch ms; NaN on failure
    if (!s) return NaN;
    var ms = Date.parse(String(s).replace(/\//g, '-').replace(' ', 'T') + '+09:00');
    return ms;
  }

  function normalizeWolfxEEW(evt) {
    // Raw Wolfx jma_eew schema (note upstream 'Magunitude' typo). One list
    // entry per EventID — later reports upsert the same slot.
    var maxInt = evt.MaxIntensity;
    var maxShindo = '';
    if (maxInt) maxShindo = (typeof maxInt === 'object') ? (maxInt.To || maxInt.From || '') : String(maxInt);
    var originMs = parseJstTime(evt.OriginTime);
    return {
      id: 'wolfx_eew_' + (evt.EventID || ''),
      mag: Math.round((evt.Magunitude || 0) * 10) / 10,
      lat: Math.round((evt.Latitude || 0) * 10000) / 10000,
      lng: Math.round((evt.Longitude || 0) * 10000) / 10000,
      depth: Math.round(evt.Depth || 30),
      place: evt.Hypocenter || '',
      maxShindo: maxShindo,
      time: isNaN(originMs) ? '' : new Date(originMs).toISOString(),
      source: 'Wolfx',
      sources: ['Wolfx'],
      raw: evt
    };
  }

  function normalizeWolfxEq(evt) {
    // Wolfx jma_eqlist entry: string fields — magnitude '3.4', shindo '1',
    // depth '60km', latitude/longitude '34.1', time_full '2026/08/09 14:05:00'
    var originMs = parseJstTime(evt.time_full || evt.time);
    return {
      id: 'wolfx_eq_' + (evt.EventID || evt.md5 || evt.time_full || ''),
      mag: Math.round(parseFloat(evt.magnitude || 0) * 10) / 10,
      lat: Math.round(parseFloat(evt.latitude || 0) * 10000) / 10000,
      lng: Math.round(parseFloat(evt.longitude || 0) * 10000) / 10000,
      depth: Math.round(parseFloat(evt.depth) || 30),
      place: evt.location || '',
      maxShindo: evt.shindo || '',
      time: isNaN(originMs) ? '' : new Date(originMs).toISOString(),
      source: 'JMA',
      sources: ['JMA'],
      raw: evt
    };
  }

  function normalizeEMSC(data) {
    var props = data.properties || {};
    var coords = (data.geometry && data.geometry.coordinates) ? data.geometry.coordinates : [0, 0, 0];
    return {
      id: 'emsc_' + (props.id || ''),
      mag: Math.round((props.mag || 0) * 10) / 10,
      lat: Math.round(coords[1] * 10000) / 10000,
      lng: Math.round(coords[0] * 10000) / 10000,
      depth: Math.round(coords[2] || 10),
      place: props.place || '',
      time: (props.time) ? new Date(props.time).toISOString() : '',
      source: 'EMSC',
      sources: ['EMSC'],
      raw: data
    };
  }

  function normalizeJMAFeed(entry) {
    var title = entry.title || '';
    var magMatch = title.match(/M(\d+\.?\d*)/);
    var mag = magMatch ? parseFloat(magMatch[1]) : 0;
    return {
      id: 'jmafeed_' + (entry.link || entry.id || ''),
      mag: Math.round(mag * 10) / 10,
      lat: 0, lng: 0,
      depth: entry.depth || 30,
      place: entry.place || title,
      time: (entry.updated) ? new Date(entry.updated).toISOString() : '',
      source: 'JMA-Feed',
      sources: ['JMA-Feed'],
      raw: entry
    };
  }

  // ================================================================
  //  CORE OPERATIONS
  // ================================================================

  function markSeen(id) {
    if (seen[id]) return false;
    seen[id] = true;
    seenKeys.push(id);
    if (seenKeys.length > MAX_SEEN) {
      var old = seenKeys.shift();
      delete seen[old];
    }
    return true;
  }

  function upsert(item) {
    for (var i = 0; i < data.length; i++) {
      if (data[i].id === item.id) { data[i] = item; return; }
    }
    data.push(item);
    data.sort(function(a, b) { return new Date(b.time) - new Date(a.time); });
    if (data.length > MAX_ITEMS) data.length = MAX_ITEMS;
  }

  function isNearJapan(item) {
    if (item.lat < 22 || item.lat > 48 || item.lng < 120 || item.lng > 152) return false;
    // Must have at least one station within 800 km
    var jpCenterLat = 36, jpCenterLng = 138;
    var distToJpCenter = Physics.haversineDist(item.lat, item.lng, jpCenterLat, jpCenterLng);
    if (distToJpCenter > 1500) return false;
    if (typeof rawLandGrid !== 'undefined' && rawLandGrid.length > 0) {
      var found = false;
      for (var si = 0; si < Math.min(rawLandGrid.length, 100); si++) {
        var d = Physics.haversineDist(item.lat, item.lng, rawLandGrid[si].lat, rawLandGrid[si].lng);
        if (d < 800) { found = true; break; }
      }
      if (!found) return false;
    }
    return true;
  }

  function nearestJapanDistance(item) {
    var best = Physics.haversineDist(item.lat, item.lng, 36, 138);
    if (typeof rawLandGrid !== 'undefined' && rawLandGrid.length) {
      best = Infinity;
      for (var i = 0; i < rawLandGrid.length; i++) {
        var d = Physics.haversineDist(item.lat, item.lng, rawLandGrid[i].lat, rawLandGrid[i].lng);
        if (d < best) best = d;
      }
    }
    return best;
  }

  function estimatedMaxShindo(item) {
    var stations = (typeof rawLandGrid !== 'undefined' && rawLandGrid.length) ? rawLandGrid : [{lat:36, lng:138}];
    var depth = Math.max(0, Number(item.depth) || 10);
    var get = typeof cfgGet === 'function' ? cfgGet : function() { return undefined; };
    var src = Physics.resolveSourceType(depth, item.sourceType, get('sourceTypeOverride') || 'auto');
    var model = Physics.resolveGmpModel(get('gmpModel') || 'auto', src, item.mag);
    // Same site-term convention as the app forecast path: zhao/kanno take the
    // station Vs30 natively (paper site classes); only the reference-site
    // models get the external 760-anchored amplification.
    var nativeVs = (model === 'zhao2006' || model === 'kanno2006');
    var best = 0;
    for (var i = 0; i < stations.length; i++) {
      var station = stations[i];
      var surface = Physics.haversineDist(item.lat, item.lng, station.lat, station.lng);
      var dist = Math.sqrt(surface * surface + depth * depth);
      var vs = Physics.lookupVs30(station.lat, station.lng, station.vs30);
      var gmpeVs = nativeVs ? (vs > 0 ? vs : 400) : 760;
      var pga = Physics.calcPGA(item.mag, dist, model, depth, item.mw, item.mag, src,
        get('attA'), get('attB'), get('attC'), get('anelastic'), gmpeVs, item.rake);
      var pgv = Physics.calcPGV(item.mag, dist, model, depth, item.mw, item.mag, src, get('anelastic'), gmpeVs, item.rake);
      var ampPga = nativeVs ? 1 : Physics.vs30Amplification(vs, 'pga');
      var ampPgv = nativeVs ? 1 : Physics.vs30Amplification(vs, 'pgv');
      var intensity = Physics.calcJmaIntensity(pga * ampPga, pgv * ampPgv);
      if (intensity > best) best = intensity;
    }
    return Physics.intensityToShindo(best);
  }

  function _toastEl() {
    var el = document.getElementById('rt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rt-toast';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,0,0,.85);color:#fff;padding:10px 18px;border-radius:8px;z-index:10000;font-size:14px;max-width:360px;pointer-events:none;transition:opacity .5s';
      document.body.appendChild(el);
    }
    return el;
  }

  function notify(msg) {
    // Route through the shared FIFO as a priority entry. The old direct
    // write clobbered el._timeout while a queued toast was mid-display, so
    // the pump's resume callback never fired and toastBusy stayed true — a
    // single notify() permanently froze the whole satellite toast queue.
    toastQueued(msg, { priority: true });

    // v4.2: Browser notification for background monitoring
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('QuakeSim Alert', { body: msg, icon: '/icon.svg', tag: 'quake-alert' }); } catch(e) {}
    }
  }

  // v4.2: Request notification permission (called from UI checkbox)
  function requestNotificationPermission() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // Browser Notification wrapper for satellite modules. Permission is
  // requested lazily on the FIRST call, realtime mode only; while the user
  // has not granted (or has denied) the call is a silent no-op. The default
  // tag is title|body so different events never replace each other.
  function notifySystem(title, body, tag) {
    if (!mode) return false;
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) {}
      return false;
    }
    if (Notification.permission !== 'granted') return false;
    try {
      new Notification(String(title), {
        body: String(body == null ? '' : body),
        icon: '/icon.svg',
        tag: tag || (String(title) + '|' + String(body == null ? '' : body))
      });
      return true;
    } catch (e) { return false; }
  }

  // ================================================================
  //  SHARED TOAST QUEUE — FIFO display for satellite-module messages.
  //  Reuses the #rt-toast element; each entry stays visible for its ttl,
  //  then the next one shows. notify() above stays independent (auto-sim).
  // ================================================================
  var TOAST_QUEUE_CAP = 5;
  var toastQueue = [];
  var toastBusy = false;

  // Pure queue-mutation helper (exported for tests): regular entries append
  // to the back and, over cap, evict the OLDEST pending entry (front);
  // priority entries jump the front and never evict themselves (the back is
  // dropped instead).
  function toastQueuePush(queue, item, cap, priority) {
    if (priority) {
      queue.unshift(item);
      while (queue.length > cap) queue.pop();
    } else {
      queue.push(item);
      while (queue.length > cap) queue.shift();
    }
    return queue;
  }

  function toastQueued(msg, opts) {
    opts = opts || {};
    var ttl = Number(opts.ttl);
    toastQueuePush(toastQueue,
      { msg: String(msg), ttl: (isFinite(ttl) && ttl > 0) ? ttl : 4000 },
      TOAST_QUEUE_CAP, !!opts.priority);
    _toastPump();
  }

  function _toastPump() {
    if (toastBusy) return;
    if (typeof document === 'undefined' || !document.getElementById) return;
    var item = toastQueue.shift();
    if (!item) return;
    toastBusy = true;
    var el = _toastEl();
    clearTimeout(el._timeout); // a stray notify() timer must not hide us early
    el.textContent = item.msg;
    el.style.opacity = '1';
    el._timeout = setTimeout(function() {
      el.style.opacity = '0';
      // let the .5 s opacity fade finish before the next message swaps in
      setTimeout(function() { toastBusy = false; _toastPump(); }, 550);
    }, item.ttl);
  }

  // ================================================================
  //  AUTO-START
  // ================================================================

  // Returns true when a sim was actually launched (callers key follow-up
  // EEW-report revision tracking off that).
  function autoStartFromEvent(item) {
    if (typeof isRunning !== 'undefined' && isRunning) return false;
    if (typeof isCountingDown !== 'undefined' && isCountingDown) return false;
    if (!isNearJapan(item)) return false;
    var minMag = (typeof cfgGet !== 'undefined') ? cfgGet('alertMinMag') : 6.0;
    if (item.mag < minMag) return false;
    var maxDist = (typeof cfgGet !== 'undefined') ? cfgGet('alertMaxDist') : 1500;
    if (nearestJapanDistance(item) > maxDist) return false;
    var predicted = estimatedMaxShindo(item);
    var minShindo = (typeof cfgGet !== 'undefined') ? cfgGet('alertMinShindo') : 3;
    var minScore = minShindo >= 7 ? Physics.shindoScore(7) : (minShindo >= 6 ? Physics.shindoScore('6-') : (minShindo >= 5 ? Physics.shindoScore('5-') : minShindo));
    if (Physics.shindoScore(predicted) < minScore) return false;
    if (item._autoStarted) return false;
    item._autoStarted = true;
    notify('📡 ' + t('info.estimated_intensity') + ' ' + predicted + ': M' + item.mag.toFixed(1) + ' ' + (item.place || ''));
    skipCountdown = true;
    // app.js owns the countdown UI; keep its legacy state in sync until that
    // orchestration code is fully moved into this module.
    if (typeof window !== 'undefined') window._rtSkipCountdown = true;
    if (typeof magSlider !== 'undefined') magSlider.value = item.mag;
    if (typeof magVal !== 'undefined') magVal.textContent = 'M' + item.mag.toFixed(1);
    if (typeof depthSlider !== 'undefined') depthSlider.value = Math.round(item.depth);
    if (typeof depthVal !== 'undefined') depthVal.textContent = Math.round(item.depth) + ' km';
    // Programmatic slider writes fire no 'input' event — mirror the app's
    // live params explicitly or startCountdown/startSimulation would run
    // with the PREVIOUS magnitude/depth.
    if (typeof _liveMag !== 'undefined') _liveMag = item.mag;
    if (typeof _liveDepth !== 'undefined') _liveDepth = Math.round(item.depth);
    if (typeof strikeSlider !== 'undefined') strikeSlider.value = 45;
    if (typeof strikeVal !== 'undefined') strikeVal.textContent = '45°';
    if (typeof setEpicenter === 'function') setEpicenter(item.lat, item.lng);
    if (typeof map !== 'undefined') map.setView([item.lat, item.lng], 7);
    if (typeof updateEpicenterInfo === 'function') updateEpicenterInfo();
    if (typeof startCountdown === 'function') startCountdown();
    return true;
  }

  // --- EEW 続報 revision (中途修正) ---
  // Later EEW reports refine M / hypocenter / depth. When the running sim is
  // one THIS module auto-started from the same EventID, restart it with the
  // revised parameters once they drift past the thresholds below.

  var REVISE_MAG_DELTA = 0.2;   // |ΔM|
  var REVISE_DIST_KM = 30;      // epicenter horizontal move (haversine)
  var REVISE_DEPTH_KM = 20;     // |Δdepth|

  // Great-circle distance in km — prefer Physics.haversineDist; inline the
  // same haversine (R=6371) so the pure revision predicate stays testable
  // under node without loading physics.js.
  function _surfaceDistKm(lat1, lng1, lat2, lng2) {
    if (typeof Physics !== 'undefined' && Physics && typeof Physics.haversineDist === 'function') {
      return Physics.haversineDist(lat1, lng1, lat2, lng2);
    }
    var dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Pure revision predicate — exported for tests. Any missing or non-numeric
  // field in prev/next → false. Exact thresholds count (>=), with a tiny
  // epsilon so float noise never flips an exact-boundary result.
  function shouldReviseAutoSim(prev, next) {
    if (!prev || !next) return false;
    var pm = Number(prev.mag), nm = Number(next.mag);
    var plat = Number(prev.lat), plng = Number(prev.lng);
    var nlat = Number(next.lat), nlng = Number(next.lng);
    var pd = Number(prev.depth), nd = Number(next.depth);
    if (!isFinite(pm) || !isFinite(nm) || !isFinite(pd) || !isFinite(nd) ||
        !isFinite(plat) || !isFinite(plng) || !isFinite(nlat) || !isFinite(nlng)) return false;
    var eps = 1e-9;
    if (Math.abs(nm - pm) >= REVISE_MAG_DELTA - eps) return true;
    if (Math.abs(nd - pd) >= REVISE_DEPTH_KM - eps) return true;
    if (_surfaceDistKm(plat, plng, nlat, nlng) >= REVISE_DIST_KM - eps) return true;
    return false;
  }

  function _clearAutoSimTrack() {
    _autoSimEventId = null;
    _autoSimParams = null;
  }

  // Record tracking after a successful serial-1 auto-start. Multi-event /
  // chain runs are never tracked — one EEW report must not restart a whole
  // scripted chain (activeEvents is filled synchronously by startCountdown).
  function _trackAutoSim(eventId, item) {
    _clearAutoSimTrack(); // a fresh launch always supersedes any stale tracking
    if (typeof activeEvents !== 'undefined' && activeEvents && activeEvents.length > 1) return;
    _autoSimEventId = String(eventId || '');
    _autoSimParams = { mag: item.mag, lat: item.lat, lng: item.lng, depth: item.depth };
  }

  // Shared stop entry (btnReset.click → app.js resetSimulation). Safe
  // mid-countdown: resetSimulation clears the countdown interval too.
  function _stopTrackedSim() {
    if (typeof btnReset !== 'undefined' && btnReset && typeof btnReset.click === 'function') {
      btnReset.click();
      return true;
    }
    if (typeof resetSimulation === 'function') { resetSimulation(); return true; }
    return false;
  }

  // The tracked sim counts as "ours" only while it is running/counting AND
  // its live params still match what we launched — so a sim the user started
  // manually right after ours ended (or took over by moving the sliders) is
  // never treated as the auto-started one.
  function _trackedSimIsLive() {
    var running = (typeof isRunning !== 'undefined' && isRunning);
    var counting = (typeof isCountingDown !== 'undefined' && isCountingDown);
    if (!running && !counting) return false;
    if (!_autoSimParams) return false;
    if (typeof epicenter !== 'undefined' && epicenter &&
        _surfaceDistKm(epicenter.lat, epicenter.lng, _autoSimParams.lat, _autoSimParams.lng) > 5) return false;
    if (typeof _liveMag !== 'undefined' &&
        Math.abs(Number(_liveMag) - Number(_autoSimParams.mag)) > 0.05) return false;
    return true;
  }

  // Serial >= 2 frame for the tracked EventID: restart the sim with the
  // revised parameters when they moved past the revision thresholds.
  function maybeReviseAutoSim(eventId, item) {
    if (!_autoSimEventId || String(eventId) !== _autoSimEventId) return;
    if (!_trackedSimIsLive()) { _clearAutoSimTrack(); return; }
    var next = { mag: item.mag, lat: item.lat, lng: item.lng, depth: item.depth };
    if (!shouldReviseAutoSim(_autoSimParams, next)) return;
    var prev = _autoSimParams;
    if (!_stopTrackedSim()) { _clearAutoSimTrack(); return; }
    // autoStartFromEvent re-applies sliders/epicenter display and re-launches
    // via the same skipCountdown + startCountdown path; it also re-validates
    // the alert filters, so a revision that no longer qualifies simply
    // leaves the sim stopped.
    if (autoStartFromEvent(item)) {
      _autoSimParams = next;
      notify('📡 ' + tFb('realtime.autosim_revised', 'EEW続報によりシミュレーションを更新') +
        ': M' + Number(prev.mag).toFixed(1) + ' → M' + Number(next.mag).toFixed(1));
    } else {
      _clearAutoSimTrack();
    }
  }

  // isCancel frame for the tracked EventID: stop the sim this module started
  // (only while it is still running or counting down), then drop tracking.
  function cancelAutoSimFor(eventId) {
    if (!_autoSimEventId || String(eventId) !== _autoSimEventId) return;
    var live = _trackedSimIsLive();
    _clearAutoSimTrack();
    if (!live) return; // sim already ended on its own — nothing to stop
    if (_stopTrackedSim()) {
      notify('📡 ' + tFb('realtime.autosim_canceled', 'EEWが取り消されたためシミュレーションを停止しました'));
    }
  }

  // ================================================================
  //  RENDERING
  // ================================================================

  function statusBar() {
    var html = '';
    var now = Date.now();
    if (usgsLast > 0) {
      var age = Math.round((now - usgsLast) / 1000);
      html += '<span style="color:#888">USGS: ' + age + 's ago</span> ';
    }
    if (p2pSource) {
      var sseAge = lastSseFrameAt ? Math.round((now - lastSseFrameAt) / 1000) : 0;
      if (sseAge > 30) {
        // Stream object exists but nothing arrived — watchdog will reconnect;
        // flag it so a dead feed is visible instead of silently looking live
        html += '<span style="color:#e74c3c;font-weight:bold" title="last frame ' + sseAge + 's ago">● SSE ' + sseAge + 's</span> ';
      } else {
        html += '<span style="color:#2ecc71">● SSE</span> ';
      }
    } else {
      html += '<span style="color:#888">○ SSE</span> ';
    }
    if (replaying) {
      html += '<span style="color:#f5a623;font-weight:bold">▶ ' + t('realtime.replay') + '</span> ';
    }
    if (typeof RTKmoni !== 'undefined' && RTKmoni.isActive && RTKmoni.isActive()) {
      var kst = RTKmoni.getState ? RTKmoni.getState() : {};
      var kColor = kst.fallback ? '#f5a623' : '#00c8ff';
      var kTxt = kst.fallback ? t('realtime.kmoni_fallback') : '強震';
      html += '<span style="color:' + kColor + '" title="NIED kmoni' + (kst.lastDataTime ? ' · ' + kst.lastDataTime : '') + '">◉ ' + kTxt + '</span> ';
      // Period-max shindo (this shaking episode, resets after 60 s quiet)
      if (kst.periodMaxLevel >= 8 && RTKmoni.levelToShindo) {
        var pShindo = RTKmoni.levelToShindoFine ? RTKmoni.levelToShindoFine(kst.periodMaxLevel) : RTKmoni.levelToShindo(kst.periodMaxLevel);
        html += '<span style="color:' + (kst.periodMaxLevel >= 12 ? '#ff5900' : '#fde047') + ';font-weight:bold">' + t('realtime.period_max') + ' ' + pShindo + '</span> ';
      }
    }
    if (typeof RTTsunami !== 'undefined' && RTTsunami.isActive && RTTsunami.isActive()) {
      var tst = RTTsunami.getState ? RTTsunami.getState() : {};
      if (tst.areaCount > 0) {
        var tsColor = tst.maxGrade === 'MajorWarning' ? '#c0392b' : (tst.maxGrade === 'Warning' ? '#e74c3c' : '#f1c40f');
        html += '<span style="color:' + tsColor + ';font-weight:bold">⚠ 津波 ' + tst.areaCount + '</span> ';
      }
    }
    if (liveSources && liveSources.length > 0) {
      for (var si = 0; si < liveSources.length; si++) {
        var s = liveSources[si];
        var sc = SRC_COLORS[s] || '#888';
        html += '<span style="color:' + sc + '">' + s + '</span> ';
      }
    } else {
      html += '<span style="color:#666">' + t('realtime.no_sources') + '</span>';
    }
    return html;
  }

  // 'M/D HH:mm' in JST for the history list (item.time is UTC ISO).
  function fmtJstList(iso) {
    var ms = new Date(iso).getTime();
    if (!isFinite(ms)) return '';
    var j = new Date(ms + 9 * 3600000);
    return pad2(j.getUTCMonth() + 1) + '/' + pad2(j.getUTCDate()) + ' ' +
      pad2(j.getUTCHours()) + ':' + pad2(j.getUTCMinutes());
  }

  function shindoFillFor(sh) {
    if (typeof SHINDO_FILL !== 'undefined' && SHINDO_FILL && SHINDO_FILL[sh]) return SHINDO_FILL[sh];
    return '#888';
  }

  function renderList() {
    if (!mode) return;
    var listEl = document.getElementById('realtime-list');
    if (!listEl) return;
    var html = '<div style="font-size:11px;color:#888;margin-bottom:4px">' + statusBar() + '</div>';
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      var c = SRC_COLORS[item.source] || '#888';
      var esc = (typeof escapeHTML === 'function') ? escapeHTML : function(s) { return s; };
      html += '<div class="realtime-item" data-idx="' + i + '">';
      html += '<div class="rti-l1">';
      if (item.maxShindo) {
        html += '<span class="rti-shindo" style="background:' + shindoFillFor(item.maxShindo) + '">' +
          esc(tFb('realtime.list_shindo', '震度')) + esc(String(item.maxShindo)) + '</span>';
      }
      html += '<span class="rti-mag" style="color:' + c + '">M' + item.mag.toFixed(1) + '</span>';
      html += '<span class="rti-place">' + esc(item.place || '') + '</span>';
      html += '<span class="rti-src" style="color:' + c + '">' + esc(item.source || '') + '</span>';
      html += '</div>';
      html += '<div class="rti-l2">' + fmtJstList(item.time) +
        (item.depth ? ' · ' + Math.round(item.depth) + 'km' : '') + '</div>';
      html += '</div>';
    }
    if (html !== lastHTML) {
      lastHTML = html;
      listEl.innerHTML = html;
    }
  }

  function initDelegation() {
    if (delegated) return;
    delegated = true;
    var listEl = document.getElementById('realtime-list');
    if (!listEl) return;
    listEl.addEventListener('click', function(e) {
      var el = e.target.closest('.realtime-item');
      if (!el) return;
      var idx = parseInt(el.getAttribute('data-idx'));
      if (isNaN(idx) || idx >= data.length) return;
      var item = data[idx];
      if (typeof setEpicenter === 'function') setEpicenter(item.lat, item.lng);
      if (typeof map !== 'undefined') map.setView([item.lat, item.lng], 7);
      if (typeof updateEpicenterInfo === 'function') updateEpicenterInfo();
      if (typeof magSlider !== 'undefined') magSlider.value = item.mag;
      if (typeof magVal !== 'undefined') magVal.textContent = 'M' + item.mag.toFixed(1);
      if (typeof depthSlider !== 'undefined') depthSlider.value = Math.round(item.depth);
      if (typeof depthVal !== 'undefined') depthVal.textContent = Math.round(item.depth) + ' km';
    });
  }

  function updateMapMarkers() {
    var chk = document.getElementById('rt-map-enable');
    if (chk && !chk.checked) {
      if (mapLayer) { mapLayer.clearLayers(); mapMarkers = []; }
      return;
    }
    if (typeof map === 'undefined' || typeof L === 'undefined') return;
    if (!mapLayer) { mapLayer = L.layerGroup().addTo(map); }
    mapLayer.clearLayers();
    mapMarkers = [];
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      var age = Date.now() - new Date(item.time).getTime();
      var ageHours = age / 3600000;
      var opacity = Math.max(0.2, 1 - ageHours / 72);
      var mi = Math.min(7, Math.floor(item.mag));
      var color = MAG_COLORS[mi] || '#888';
      var radius = 3 + item.mag * 2;
      var marker = L.circleMarker([item.lat, item.lng], {
        radius: radius, color: color, fillColor: color,
        fillOpacity: opacity * 0.6, weight: 1.5, opacity: opacity
      });
      marker.bindTooltip('M' + item.mag.toFixed(1) + ' ' + (item.place || ''), {direction: 'top'});
      marker.on('click', function(itemRef) {
        return function() {
          if (typeof setEpicenter === 'function') setEpicenter(itemRef.lat, itemRef.lng);
          if (typeof map !== 'undefined') map.setView([itemRef.lat, itemRef.lng], 7);
          if (typeof updateEpicenterInfo === 'function') updateEpicenterInfo();
          if (typeof magSlider !== 'undefined') magSlider.value = itemRef.mag;
          if (typeof magVal !== 'undefined') magVal.textContent = 'M' + itemRef.mag.toFixed(1);
          if (typeof depthSlider !== 'undefined') depthSlider.value = Math.round(itemRef.depth);
          if (typeof depthVal !== 'undefined') depthVal.textContent = Math.round(itemRef.depth) + ' km';
        };
      }(item));
      marker.addTo(mapLayer);
      mapMarkers.push(marker);
    }
  }

  // ================================================================
  //  FETCH & SSE
  // ================================================================

  function fetchData() {
    if (fetching) return;
    fetching = true;
    fetch('/api/earthquakes').then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function(json) {
      fetching = false;
      usgsLast = Date.now();
      if (json.metadata && json.metadata.sources) liveSources = json.metadata.sources;
      if (json.features) {
        var chimeSrc = {};
        for (var i = 0; i < json.features.length; i++) {
          var item = normalizeUSGS(json.features[i]);
          if (!markSeen(item.id)) continue;
          upsert(item);
          // JMA entries arrive faster over the wolfx_eq SSE channel (which
          // chimes there) — here only the other agencies need a sound.
          if (item.source !== 'JMA' && isFreshBulletin(item, Date.now()) &&
              bulletinSoundFor(item.source) && (item.source === 'CENC' || isNearJapan(item))) {
            chimeSrc[item.source] = true;
          }
        }
        // one chime per agency per fetch, capped at two
        var chimeKeys = Object.keys(chimeSrc);
        for (var ci = 0; ci < chimeKeys.length && ci < 2; ci++) playBulletinChime(chimeKeys[ci]);
      }
      renderList();
      updateMapMarkers();
      var autoEl = document.getElementById('rt-auto-sim');
      if (autoEl && autoEl.checked && !replaying && data.length > 0) {
        var latest = data[0];
        autoStartFromEvent(latest);
      }
    }).catch(function(e) {
      fetching = false;
      console.warn('Realtime fetch failed:', e.message);
    });
  }

  // ================================================================
  //  FRAME ROUTING (shared by the live SSE stream and server replay)
  // ================================================================

  // Per-type handlers take the PARSED SSE envelope ({type,event}) — the
  // live stream feeds them raw, replay feeds them time-shifted copies.
  function handleP2pquake(evt) {
    try {
      p2pLast = Date.now();
      // Server already normalized this event — use it directly
      var item = (evt && evt.event) ? evt.event : evt;
      if (!item.id) return;
      // Junk filter: P2P 554 (EEW detection-point bulletin) has no earthquake
      // block, and any other hypocenter-less frame would render as a bogus
      // M0.0 @(0,0) list row / map marker. Bus forwarding to rt-quakeinfo /
      // rt-tsunami happens in wireStream and is unaffected by this drop.
      if (item.code === 554) return;
      if (!(item.mag > 0) && !item.lat && !item.lng) return;
      if (!item.source) { item.source = 'P2P'; item.sources = ['P2P']; }
      if (markSeen(item.id)) upsert(item);
      clearTimeout(renderTimer);
      renderTimer = setTimeout(renderList, 100);
    } catch(ex) { console.warn('P2P parse error:', ex); }
  }

  function handleWolfxEew(evt) {
    try {
      p2pLast = Date.now();
      // The raw Wolfx jma_eew object is nested under .event by the SSE relay
      var raw = (evt && evt.event) ? evt.event : evt;
      // A real EEW aborts the demo so live kmoni data resumes immediately —
      // but replayed history is not a real EEW and must not kill the RTDemo.
      if (raw && !raw.isTraining && !replaying && typeof RTDemo !== 'undefined' && RTDemo.isRunning && RTDemo.isRunning()) {
        try { RTDemo.stop(); } catch(e) {}
      }
      var item = normalizeWolfxEEW(raw);
      if (!item.id || item.id === 'wolfx_eew_') return;
      upsert(item);
      clearTimeout(renderTimer);
      renderTimer = setTimeout(renderList, 100);
      // EEW panel/rings lifecycle is owned by rt-eew.js (RTEew)
      var autoEl = document.getElementById('rt-auto-sim');
      if (raw && raw.isCancel && !raw.isTraining) {
        // EEW withdrawn — stop the sim only when THIS module auto-started it
        // from the same EventID. Never during replay: replayed frames must
        // not kill a live sim.
        if (!replaying) cancelAutoSimFor(raw.EventID);
      } else if (autoEl && autoEl.checked && !replaying && raw && !raw.isTraining) {
        if (raw.Serial === 1) {
          if (autoStartFromEvent(item)) _trackAutoSim(raw.EventID, item);
        } else if (Number(raw.Serial) >= 2) {
          // 続報 (later report) — revise the running auto-sim if the
          // parameters drifted past the revision thresholds.
          maybeReviseAutoSim(raw.EventID, item);
        }
      }
    } catch(ex) { console.warn('Wolfx EEW parse error:', ex); }
  }

  function handleWolfxEq(evt) {
    try {
      p2pLast = Date.now();
      var raw = (evt && evt.event) ? evt.event : evt;
      var item = normalizeWolfxEq(raw);
      if (markSeen(item.id)) {
        upsert(item);
        // brand-new official JMA listing → the JMA bulletin chime
        if (isFreshBulletin(item, Date.now())) playBulletinChime(item.source);
      }
      clearTimeout(renderTimer);
      renderTimer = setTimeout(renderList, 100);
    } catch(ex) { console.warn('Wolfx EQ parse error:', ex); }
  }

  function handleEmsc(evt) {
    try {
      p2pLast = Date.now();
      var data = (evt && evt.event) ? evt.event : evt;
      var item = normalizeEMSC(data);
      if (markSeen(item.id)) {
        upsert(item);
        if (isFreshBulletin(item, Date.now()) && isNearJapan(item)) playBulletinChime(item.source);
      }
      clearTimeout(renderTimer);
      renderTimer = setTimeout(renderList, 100);
    } catch(ex) { console.warn('EMSC parse error:', ex); }
  }

  function handleJmaFeed(evt) {
    try {
      p2pLast = Date.now();
      var entry = (evt && evt.event) ? evt.event : evt;
      var item = normalizeJMAFeed(entry);
      // JMA Atom titles often carry no magnitude (震源・震度情報 etc) — those
      // rows would render as "M0.0" and duplicate the Wolfx eqlist; skip them
      if (item.mag > 0 && markSeen(item.id)) upsert(item);
      clearTimeout(renderTimer);
      renderTimer = setTimeout(renderList, 100);
      var autoEl = document.getElementById('rt-auto-sim');
      if (autoEl && autoEl.checked && !replaying && data.length > 0) {
        autoStartFromEvent(data[0]);
      }
    } catch(ex) { console.warn('JMA feed parse error:', ex); }
  }

  function parseFrame(e) {
    try { return JSON.parse(e.data); } catch (ex) { return null; }
  }

  // --- replay time-shifting ---
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Rebuild 'YYYY/MM/DD HH:mm:ss' in JST from epoch ms (Wolfx time format).
  function fmtJstSlash(ms) {
    var d = new Date(ms + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '/' + pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  function shiftTimeValue(v, shiftMs) {
    if (typeof v === 'number' && v > 1e12 && v < 1e13) return v + shiftMs;
    if (typeof v !== 'string') return v;
    if (/^\d{13}$/.test(v)) return String(Number(v) + shiftMs);
    var m = v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) {
      // seconds are optional — P2P 552 first-wave arrival times are HH:mm
      var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0));
      return isNaN(t) ? v : fmtJstSlash(t + shiftMs);
    }
    var iso = v.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
    if (iso) {
      var base = Date.parse(v);
      if (isNaN(base)) return v;
      if (!iso[1] || iso[1] === 'Z') return new Date(base + shiftMs).toISOString();
      var tz = iso[1];
      var sign = tz[0] === '-' ? -1 : 1;
      var offMs = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60000;
      var d2 = new Date(base + shiftMs + offMs);
      return d2.getUTCFullYear() + '-' + pad2(d2.getUTCMonth() + 1) + '-' + pad2(d2.getUTCDate()) +
        'T' + pad2(d2.getUTCHours()) + ':' + pad2(d2.getUTCMinutes()) + ':' + pad2(d2.getUTCSeconds()) + tz;
    }
    return v;
  }

  // Time-shift one recorded event for replay: every top-level *time* field
  // (OriginTime/AnnouncedTime/dataTime/time/time_full/...) moves forward by
  // shiftMs so replayed frames behave like live ones (rings grow, countdowns
  // run). Unknown shapes pass through untouched; replayTs (the original
  // record time) is never shifted.
  function shiftEventTimes(type, evt, shiftMs) {
    if (!evt || typeof evt !== 'object' || !shiftMs) return evt;
    var clone = Object.assign({}, evt);
    for (var k in clone) {
      if (!/time/i.test(k) || k === 'replayTs') continue;
      clone[k] = shiftTimeValue(clone[k], shiftMs);
    }
    // P2P 552 nested first-wave arrival times (tsunamiAreas[].firstHeight
    // [.arrivalTime]) sit one level down — the top-level scan never reaches
    // them, but the tsunami ETA countdown keys off exactly these fields.
    if (Array.isArray(clone.tsunamiAreas)) {
      clone.tsunamiAreas = clone.tsunamiAreas.map(function(a) {
        if (!a || typeof a !== 'object') return a;
        var ac = Object.assign({}, a);
        if (ac.firstHeight && typeof ac.firstHeight === 'object') {
          var fh = Object.assign({}, ac.firstHeight);
          if (fh.arrivalTime) fh.arrivalTime = shiftTimeValue(fh.arrivalTime, shiftMs);
          ac.firstHeight = fh;
        } else if (typeof ac.firstHeight === 'string') {
          ac.firstHeight = shiftTimeValue(ac.firstHeight, shiftMs);
        }
        return ac;
      });
    }
    return clone;
  }

  function shiftEnvelope(evt, shiftMs) {
    if (!evt || !shiftMs) return evt;
    return { type: evt.type, event: shiftEventTimes(evt.type, evt.event, shiftMs) };
  }

  function shiftPayload(type, rawData, shiftMs) {
    if (!shiftMs) return rawData;
    try {
      return JSON.stringify(shiftEnvelope(JSON.parse(rawData), shiftMs));
    } catch (e) { return rawData; }
  }

  // ================================================================
  //  EVENT BUS (stable facade for satellite modules)
  //  rt-kmoni/rt-eew/rt-tsunami attach ONCE via getP2PSource(); frames fan
  //  out from whichever upstream is active (live SSE or replay) without
  //  re-attachment. Only e.data is consumed downstream, so a lightweight
  //  {data} object satisfies the listener contract.
  // ================================================================
  var BUS_TYPES = ['p2pquake', 'wolfx_eew', 'wolfx_eq', 'emsc', 'jma_feed', 'kmoni_rt'];
  var busListeners = {};
  var busFacade = {
    addEventListener: function(type, fn) {
      (busListeners[type] = busListeners[type] || []).push(fn);
    },
    removeEventListener: function(type, fn) {
      var l = busListeners[type];
      if (!l) return;
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
  };
  function busFanOut(type, payload) {
    var l = busListeners[type];
    if (!l) return;
    for (var i = 0; i < l.length; i++) {
      try { l[i].call(busFacade, { data: payload }); } catch (e) {}
    }
  }

  function wireStream(src, shiftMs) {
    src.addEventListener('p2pquake', function(e) { var v = parseFrame(e); if (v) handleP2pquake(shiftEnvelope(v, shiftMs)); });
    src.addEventListener('wolfx_eew', function(e) { var v = parseFrame(e); if (v) handleWolfxEew(shiftEnvelope(v, shiftMs)); });
    src.addEventListener('wolfx_eq', function(e) { var v = parseFrame(e); if (v) handleWolfxEq(shiftEnvelope(v, shiftMs)); });
    src.addEventListener('emsc', function(e) { var v = parseFrame(e); if (v) handleEmsc(shiftEnvelope(v, shiftMs)); });
    src.addEventListener('jma_feed', function(e) { var v = parseFrame(e); if (v) handleJmaFeed(shiftEnvelope(v, shiftMs)); });
    for (var i = 0; i < BUS_TYPES.length; i++) {
      (function(tp) {
        src.addEventListener(tp, function(e) {
          lastSseFrameAt = Date.now(); // watchdog heartbeat — any type counts
          busFanOut(tp, shiftPayload(tp, e.data, shiftMs));
        });
      })(BUS_TYPES[i]);
    }
  }

  function startP2PStream() {
    if (p2pSource || !mode || replaying) return;
    p2pSource = new EventSource('/api/p2pquake/stream');
    p2pRetries = 0;
    lastSseFrameAt = Date.now(); // silence watchdog measures from connect time
    wireStream(p2pSource, 0);
    // Server heartbeat: named 'ping' event ({"t": ms} every ~15 s). Keeps
    // lastSseFrameAt fresh through quiet periods so a healthy-but-idle feed
    // never trips the 30 s zombie-stream watchdog.
    p2pSource.addEventListener('ping', function() { lastSseFrameAt = Date.now(); });

    p2pSource.onerror = function() {
      stopP2PStream();
      p2pRetries = (p2pRetries || 0) + 1;
      var delay = Math.min(1000 * Math.pow(2, Math.min(p2pRetries, 6)), 60000);
      console.warn('SSE stream error, reconnecting in ' + (delay / 1000) + 's (attempt ' + p2pRetries + ')');
      // No retry cap: a monitoring session must recover no matter how long the
      // outage was (the old 20-attempt cap silently killed rings/kmoni for
      // long-lived tabs — the list kept updating via 30 s REST polling).
      p2pReconnectTimeout = setTimeout(startP2PStream, delay);
    };

    p2pSource.onopen = function() {
      p2pRetries = 0;
      lastSseFrameAt = Date.now();
    };
  }

  function stopP2PStream() {
    if (p2pSource) { try { p2pSource.close(); } catch(e) {} p2pSource = null; }
    if (p2pReconnectTimeout) { clearTimeout(p2pReconnectTimeout); p2pReconnectTimeout = null; }
  }

  // Silence watchdog: a proxied/EventSource connection can stay readyState=OPEN
  // while delivering nothing (half-dead proxy hop, laptop sleep, ...). With
  // kmoni_rt + jma_feed frames flowing every ~1-2 s, 30 s of silence means the
  // stream is zombie — force a reconnect. Also revives the stream if a
  // reconnect timer was somehow lost.
  function sseWatchdogStart() {
    if (sseWatchdogTimer) return;
    sseWatchdogTimer = setInterval(function() {
      if (!mode || replaying) return;
      if (!p2pSource) { startP2PStream(); return; }
      var silent = Date.now() - lastSseFrameAt;
      if (silent > SSE_SILENCE_MS) {
        console.warn('SSE silent for ' + Math.round(silent / 1000) + 's — forcing reconnect');
        stopP2PStream();
        p2pRetries = 0;
        startP2PStream();
      }
    }, 10000);
  }

  function sseWatchdogStop() {
    if (sseWatchdogTimer) { clearInterval(sseWatchdogTimer); sseWatchdogTimer = null; }
  }

  // ================================================================
  //  SERVER REPLAY (回放): recorded frames re-streamed through the same
  //  routing so every module (list, kmoni, EEW rings, tsunami, focus)
  //  relives the window. The live feed pauses for the duration; sounds and
  //  TTS are muted by the satellite modules via isReplaying().
  // ================================================================
  var replaySource = null;
  var replaying = false;
  // replay clock state (drives the timeline slider while streaming)
  var replayFromMs = 0;
  var replaySpeed = 5;
  var replayWallStart = 0;
  var replayClockTimer = null;

  function startReplay(fromMs, speed) {
    if (!mode || replaying) return false;
    if (typeof EventSource === 'undefined') return false;
    stopP2PStream(); // pause the live feed while replaying
    replaying = true;
    replayFromMs = Math.round(fromMs);
    replaySpeed = speed || 5;
    replayWallStart = Date.now();
    replayClockStart();
    replaySource = new EventSource('/api/replay/stream?from=' + Math.round(fromMs) + '&speed=' + (speed || 5));
    wireStream(replaySource, Date.now() - fromMs);
    replaySource.addEventListener('replay_end', function() { stopReplay(); });
    replaySource.onerror = function() { console.warn('replay stream error — resuming live'); stopReplay(); };
    updateReplayUi();
    return true;
  }

  function stopReplay() {
    if (replaySource) { try { replaySource.close(); } catch(e) {} replaySource = null; }
    replayClockStop();
    if (!replaying) return;
    replaying = false;
    timelineScrubbing = false;
    startP2PStream(); // resume live (no-op when realtime is off)
    updateReplayUi();
    fetchReplayTimeline(); // the window end moved on while replaying
  }

  // While streaming, the slider follows the replay clock
  // (from + wall-elapsed × speed), clamped to the recorded window.
  function computeReplayClock(fromMs, wallStartMs, speed, nowMs) {
    return fromMs + (nowMs - wallStartMs) * speed;
  }

  function replayClockStart() {
    replayClockStop();
    replayClockTimer = setInterval(function() {
      if (!replaying || timelineScrubbing) return;
      var slider = (typeof document !== 'undefined') ? document.getElementById('rt-replay-slider') : null;
      if (!slider || !slider.min) return;
      var v = computeReplayClock(replayFromMs, replayWallStart, replaySpeed, Date.now());
      v = Math.min(Math.max(v, Number(slider.min)), Number(slider.max));
      slider.value = v;
      slider.title = fmtJstHm(v);
    }, 500);
  }

  function replayClockStop() {
    if (replayClockTimer) { clearInterval(replayClockTimer); replayClockTimer = null; }
  }

  function updateReplayUi() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var btn = document.getElementById('rt-replay-btn');
    var w = document.getElementById('rt-replay-window');
    var s = document.getElementById('rt-replay-speed');
    if (btn) btn.textContent = replaying ? ('■ ' + t('realtime.replay_stop')) : ('▶ ' + t('realtime.replay_start'));
    if (w) w.disabled = replaying;
    if (s) s.disabled = replaying;
    renderList(); // status bar picks up the replay badge
  }

  function initReplayControls() {
    var btn = (typeof document !== 'undefined') ? document.getElementById('rt-replay-btn') : null;
    if (!btn) return;
    ensureReplayTimeline();
    fetchReplayTimeline();
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', function() {
      if (replaying) { stopReplay(); return; }
      var w = document.getElementById('rt-replay-window');
      var s = document.getElementById('rt-replay-speed');
      var winMs = (w ? Number(w.value) : 10800) * 1000;
      var speed = s ? Number(s.value) : 5;
      var fallback = function() {
        if (!startReplay(Date.now() - winMs, speed)) notify(t('realtime.replay_empty'));
      };
      fetch('/api/replay/info').then(function(r) { return r.json(); }).then(function(info) {
        refreshReplayTimeline(info);
        if (info && info.frames > 0 && info.latest) {
          var startMs = Math.max(info.latest - winMs, info.earliest || 0);
          // a dragged timeline slider wins over the window dropdown
          var slider = document.getElementById('rt-replay-slider');
          if (timelineTouched && slider) {
            startMs = Math.min(Math.max(Number(slider.value) || startMs, info.earliest || 0), info.latest);
          }
          startReplay(startMs, speed);
        } else {
          notify(t('realtime.replay_empty'));
        }
      }).catch(fallback);
    });
  }

  // ================================================================
  //  REPLAY TIMELINE (时间轴): recorded-window slider under the replay
  //  row. Ticks mark the /api/replay/info events index; the slider picks
  //  the replay start and follows the replay clock while streaming —
  //  dragging it mid-replay restarts the stream at the new position
  //  (poor-man's scrub; true streaming seek is not supported).
  // ================================================================
  var replayInfo = null;        // last /api/replay/info payload
  var timelineBuilt = false;
  var timelineTouched = false;  // user picked a start on the slider
  var timelineScrubbing = false;

  // i18n with a Japanese fallback until the keys land in i18n.js
  function tr(k, ja) { var v = t(k); return (v && v !== k) ? v : ja; }

  function fmtJstHm(ms) {
    var d = new Date(ms + 9 * 3600 * 1000);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  function ensureReplayTimeline() {
    if (timelineBuilt || typeof document === 'undefined' || !document.getElementById) return;
    var row = document.getElementById('rt-replay-row');
    if (!row) return;
    timelineBuilt = true;
    var wrap = document.createElement('div');
    wrap.id = 'rt-replay-timeline';
    wrap.style.display = 'none';
    wrap.innerHTML =
      '<div class="rt-opt-row rt-timeline-head">' +
        '<span class="rt-opt-label">' + tr('realtime.replay_timeline', 'タイムライン') + '</span>' +
        '<span id="rt-replay-t-start" class="rt-timeline-time">--:--</span>' +
        '<span class="rt-timeline-time">–</span>' +
        '<span id="rt-replay-t-end" class="rt-timeline-time">--:--</span>' +
        '<button id="rt-replay-export" class="realtime-btn rt-export-btn" type="button">' + tr('realtime.replay_export', 'エクスポート') + '</button>' +
      '</div>' +
      '<div class="rt-timeline-track">' +
        '<input type="range" id="rt-replay-slider" min="0" max="1" step="1000" value="0">' +
        '<div id="rt-replay-ticks" class="rt-timeline-ticks"></div>' +
      '</div>';
    row.appendChild(wrap);
    var slider = document.getElementById('rt-replay-slider');
    slider.addEventListener('input', function() {
      if (replaying) timelineScrubbing = true;
      else timelineTouched = true;
      slider.title = fmtJstHm(Number(slider.value));
    });
    slider.addEventListener('change', function() {
      if (!replaying) return;
      // scrub: restart the stream at the dropped position
      var from = Number(slider.value);
      timelineScrubbing = false;
      stopReplay();
      startReplay(from, replaySpeed);
    });
    document.getElementById('rt-replay-export').addEventListener('click', exportReplayWindow);
    var w = document.getElementById('rt-replay-window');
    if (w && !w._timelineWired) {
      w._timelineWired = true;
      w.addEventListener('change', function() {
        timelineTouched = false; // dropdown reclaims the start position
        if (replayInfo && replayInfo.latest) {
          slider.value = Math.max(replayInfo.latest - Number(w.value) * 1000, replayInfo.earliest || 0);
          slider.title = fmtJstHm(Number(slider.value));
        }
      });
    }
  }

  function refreshReplayTimeline(info) {
    if (typeof document === 'undefined' || !document.getElementById) return;
    ensureReplayTimeline();
    var wrap = document.getElementById('rt-replay-timeline');
    if (!wrap) return;
    if (info) replayInfo = info;
    var ok = replayInfo && replayInfo.frames > 0 && replayInfo.earliest && replayInfo.latest && replayInfo.latest > replayInfo.earliest;
    wrap.style.display = ok ? '' : 'none';
    if (!ok) return;
    var slider = document.getElementById('rt-replay-slider');
    slider.min = replayInfo.earliest;
    slider.max = replayInfo.latest;
    if (!timelineTouched && !replaying) {
      var w = document.getElementById('rt-replay-window');
      var winMs = (w ? Number(w.value) : 10800) * 1000;
      slider.value = Math.max(replayInfo.latest - winMs, replayInfo.earliest);
    } else {
      slider.value = Math.min(Math.max(Number(slider.value) || replayInfo.earliest, replayInfo.earliest), replayInfo.latest);
    }
    slider.title = fmtJstHm(Number(slider.value));
    document.getElementById('rt-replay-t-start').textContent = fmtJstHm(replayInfo.earliest);
    document.getElementById('rt-replay-t-end').textContent = fmtJstHm(replayInfo.latest);
    var span = replayInfo.latest - replayInfo.earliest;
    var html = '';
    var evts = replayInfo.events || [];
    for (var i = 0; i < evts.length; i++) {
      var ev = evts[i];
      if (!ev || ev.t < replayInfo.earliest || ev.t > replayInfo.latest) continue;
      var pct = ((ev.t - replayInfo.earliest) / span * 100).toFixed(2);
      html += '<i class="rt-tick rt-tick-' + (ev.type === 'eew' ? 'eew' : 'info') + '" style="left:' + pct + '%" title="' +
        fmtJstHm(ev.t) + ' ' + String(ev.label || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') + '"></i>';
    }
    document.getElementById('rt-replay-ticks').innerHTML = html;
  }

  function fetchReplayTimeline() {
    if (typeof document === 'undefined' || typeof fetch === 'undefined') return;
    if (!document.getElementById('rt-replay-row')) return;
    fetch('/api/replay/info').then(function(r) { return r.json(); }).then(function(info) {
      refreshReplayTimeline(info);
    }).catch(function() {});
  }

  // Export the window from the slider position to the latest recorded frame.
  function exportReplayWindow() {
    var btn = document.getElementById('rt-replay-export');
    if (!replayInfo || !(replayInfo.frames > 0) || !replayInfo.latest) {
      notify(tr('realtime.replay_export_empty', 'この範囲に録画データがありません'));
      return;
    }
    var slider = document.getElementById('rt-replay-slider');
    var from = slider ? Number(slider.value) : replayInfo.earliest;
    from = Math.min(Math.max(from || replayInfo.earliest, replayInfo.earliest), replayInfo.latest);
    var to = replayInfo.latest;
    if (btn) btn.disabled = true;
    fetch('/api/replay/export?from=' + Math.round(from) + '&to=' + Math.round(to))
      .then(function(r) {
        if (r.status === 204) { notify(tr('realtime.replay_export_empty', 'この範囲に録画データがありません')); return null; }
        if (!r.ok) throw new Error('export failed: ' + r.status);
        return r.blob().then(function(blob) { return { blob: blob, cd: r.headers.get('content-disposition') || '' }; });
      })
      .then(function(pack) {
        if (!pack) return;
        var m = /filename="?([^";]+)/.exec(pack.cd);
        var a = document.createElement('a');
        var objUrl = URL.createObjectURL(pack.blob);
        a.href = objUrl;
        a.download = m ? m[1] : 'quake-replay.jsonl';
        document.body.appendChild(a);
        a.click();
        setTimeout(function() { URL.revokeObjectURL(objUrl); a.remove(); }, 1000);
      })
      .catch(function() { notify(tr('realtime.replay_export_fail', 'エクスポートに失敗しました')); })
      .finally(function() { if (btn) btn.disabled = false; });
  }

  // ================================================================
  //  DATA-SOURCE HEALTH PANEL — /health polled every 30 s while realtime
  //  is on; a compact collapsible section appended into #realtime-bar.
  // ================================================================
  var HEALTH_POLL_MS = 30000;
  var healthTimer = null;
  var healthBuilt = false;
  var healthOpen = false;

  // Trilingual fallback: window.t(key) wins; otherwise pick by qs-lang.
  function _tr(key, ja, en, zh) {
    try {
      if (typeof window !== 'undefined' && typeof window.t === 'function') {
        var v = window.t(key);
        if (typeof v === 'string' && v && v !== key) return v;
      }
    } catch (e) {}
    var lang = '';
    try {
      if (typeof localStorage !== 'undefined') lang = localStorage.getItem('qs-lang') || '';
    } catch (e2) {}
    return (lang === 'zh') ? zh : (lang === 'en') ? en : ja;
  }

  function _healthSrcOk(v) {
    var s = (v && typeof v === 'object') ? v.state : v;
    return s === 'connected' || s === 'ok' || s === 'polling';
  }

  function ensureHealthPanel() {
    if (healthBuilt || typeof document === 'undefined' || !document.getElementById) return;
    var bar = document.getElementById('realtime-bar');
    if (!bar) return;
    healthBuilt = true;
    var st = document.createElement('style');
    st.textContent =
      '#rt-health{margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,.08);font-size:11px}' +
      '#rt-health-head{cursor:pointer;display:flex;justify-content:space-between;color:#aaa}' +
      '#rt-health-head:hover{color:#ddd}' +
      '#rt-health-body{display:none;margin-top:3px}' +
      '#rt-health.open #rt-health-body{display:block}' +
      '.rt-health-row{display:flex;align-items:center;gap:5px;padding:1px 0;color:#999}' +
      '.rt-health-dot{width:7px;height:7px;border-radius:50%;flex:none}' +
      '.rt-health-name{flex:1;color:#bbb}' +
      '.rt-health-sub{padding-left:12px;color:#888}';
    document.head.appendChild(st);
    var wrap = document.createElement('div');
    wrap.id = 'rt-health';
    wrap.style.display = 'none';
    wrap.innerHTML =
      '<div id="rt-health-head"><span>' + _tr('realtime.health.title', 'データソース状態', 'Data source status', '数据源状态') + '</span>' +
      '<span id="rt-health-caret">▸</span></div>' +
      '<div id="rt-health-body"></div>';
    bar.appendChild(wrap);
    document.getElementById('rt-health-head').addEventListener('click', function() {
      healthOpen = !healthOpen;
      wrap.className = healthOpen ? 'open' : '';
      document.getElementById('rt-health-caret').textContent = healthOpen ? '▾' : '▸';
      if (healthOpen) fetchHealth();
    });
  }

  function _healthRender(h) {
    var body = document.getElementById('rt-health-body');
    if (!body) return;
    var now = Date.now();
    var srcs = [['p2p', 'P2PQuake'], ['wolfxEew', 'Wolfx EEW'], ['wolfxEq', 'Wolfx Eq'],
                ['emsc', 'EMSC'], ['kmoni', '強震モニタ']];
    var html = '';
    for (var i = 0; i < srcs.length; i++) {
      var v = h[srcs[i][0]];
      var ok = _healthSrcOk(v);
      // last-event age only when the payload carries it (epoch ms)
      var lastEv = (v && typeof v === 'object' && typeof v.lastEvent === 'number') ? v.lastEvent : null;
      html += '<div class="rt-health-row">' +
        '<span class="rt-health-dot" style="background:' + (ok ? '#2ecc71' : '#e74c3c') + '"></span>' +
        '<span class="rt-health-name">' + srcs[i][1] + '</span>' +
        '<span>' + (ok ? _tr('realtime.health.ok', '接続中', 'connected', '已连接')
                       : _tr('realtime.health.down', '切断', 'down', '断开')) +
        (lastEv ? ' · ' + Math.max(0, Math.round((now - lastEv) / 1000)) + 's' : '') + '</span></div>';
    }
    // kmoni data lag from the local NIED layer state, when it is running
    if (typeof RTKmoni !== 'undefined' && RTKmoni.getState) {
      try {
        var kst = RTKmoni.getState() || {};
        var lag = kst.lastDataTime ? Math.round((now - Date.parse(kst.lastDataTime)) / 1000) : NaN;
        if (isFinite(lag) && lag >= 0) {
          html += '<div class="rt-health-row rt-health-sub">' +
            _tr('realtime.health.kmoni_lag', '強震データ遅延', 'kmoni data lag', '强震数据延迟') + ' ' + lag + 's</div>';
        }
      } catch (e) {}
    }
    var meta = [];
    if (typeof h.sseClients === 'number') meta.push('SSE ' + h.sseClients);
    // replay stats only matter while a replay is actually streaming
    if (replaying && h.replay && typeof h.replay.frames === 'number') {
      meta.push(_tr('realtime.health.replay', '録画', 'recorded', '录像') + ' ' + h.replay.frames);
    }
    if (meta.length) html += '<div class="rt-health-row rt-health-sub">' + meta.join(' · ') + '</div>';
    body.innerHTML = html;
  }

  function fetchHealth() {
    if (!mode || typeof fetch === 'undefined') return;
    fetch('/health').then(function(r) { return r.json(); }).then(function(h) {
      if (h && typeof h === 'object') _healthRender(h);
    }).catch(function() {});
  }

  function healthStart() {
    ensureHealthPanel();
    var wrap = (typeof document !== 'undefined') ? document.getElementById('rt-health') : null;
    if (wrap) wrap.style.display = '';
    fetchHealth();
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(fetchHealth, HEALTH_POLL_MS);
  }

  function healthStop() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    var wrap = (typeof document !== 'undefined') ? document.getElementById('rt-health') : null;
    if (wrap) wrap.style.display = 'none';
  }

  // ================================================================
  //  TOGGLE (called from app.js button handler)
  // ================================================================

  function toggle() {
    mode = !mode;
    var btn = document.getElementById('btn-realtime');
    if (mode) {
      if (btn) btn.textContent = '📡 ' + t('realtime.on');
      if (btn) btn.classList.add('active');
      document.getElementById('realtime-auto-lbl').style.display = 'flex';
      document.getElementById('rt-map-lbl').style.display = 'flex';
      var kmoniLbl = document.getElementById('rt-kmoni-lbl');
      if (kmoniLbl) kmoniLbl.style.display = 'flex';
      var kmoniOpts = document.getElementById('rt-kmoni-opts');
      if (kmoniOpts) kmoniOpts.style.display = 'flex';
      var demoBtn = document.getElementById('rt-eew-demo');
      if (demoBtn) demoBtn.style.display = 'block';
      var eewPageBtn = document.getElementById('btn-eew-page');
      if (eewPageBtn) eewPageBtn.style.display = 'block';
      var eewOpts = document.getElementById('rt-eew-opts');
      if (eewOpts) eewOpts.style.display = 'flex';
      syncUserLocRow();
      var replayRow = document.getElementById('rt-replay-row');
      if (replayRow) replayRow.style.display = 'flex';
      initReplayControls();
      document.getElementById('realtime-list').style.display = 'block';
      seen = {}; seenKeys = []; data = [];
      lastSseFrameAt = 0;
      fetchData();
      timer = setInterval(fetchData, 30000);
      startP2PStream();
      sseWatchdogStart();
      initDelegation();
      initSatelliteToggles();
      rtFocusStart();
      healthStart();
      // Give the EventSource a beat to open before satellites attach
      setTimeout(syncSatellites, 300);
    } else {
      if (btn) btn.textContent = '📡 ' + t('realtime.off');
      if (btn) btn.classList.remove('active');
      document.getElementById('realtime-auto-lbl').style.display = 'none';
      document.getElementById('rt-map-lbl').style.display = 'none';
      var kmoniLblOff = document.getElementById('rt-kmoni-lbl');
      if (kmoniLblOff) kmoniLblOff.style.display = 'none';
      var kmoniOptsOff = document.getElementById('rt-kmoni-opts');
      if (kmoniOptsOff) kmoniOptsOff.style.display = 'none';
      var demoBtnOff = document.getElementById('rt-eew-demo');
      if (demoBtnOff) demoBtnOff.style.display = 'none';
      var eewPageBtnOff = document.getElementById('btn-eew-page');
      if (eewPageBtnOff) eewPageBtnOff.style.display = 'none';
      if (typeof exitEewPage === 'function') { try { exitEewPage(); } catch(e) {} }
      var eewOptsOff = document.getElementById('rt-eew-opts');
      if (eewOptsOff) eewOptsOff.style.display = 'none';
      var replayRowOff = document.getElementById('rt-replay-row');
      if (replayRowOff) replayRowOff.style.display = 'none';
      stopReplay();
      document.getElementById('realtime-list').style.display = 'none';
      if (timer) { clearInterval(timer); timer = null; }
      stopP2PStream();
      sseWatchdogStop();
      rtFocusStop();
      healthStop();
      if (typeof RTDemo !== 'undefined' && RTDemo.stop) { try { RTDemo.stop(); } catch(e) {} }
      if (typeof RTKmoni !== 'undefined' && RTKmoni.stop) { try { RTKmoni.stop(); } catch(e) {} }
      if (typeof RTEew !== 'undefined' && RTEew.stop) { try { RTEew.stop(); } catch(e) {} }
      if (typeof RTTsunami !== 'undefined' && RTTsunami.stop) { try { RTTsunami.stop(); } catch(e) {} }
      if (typeof RTQuakeInfo !== 'undefined' && RTQuakeInfo.stop) { try { RTQuakeInfo.stop(); } catch(e) {} }
      if (mapLayer) { mapLayer.clearLayers(); mapMarkers = []; }
    }
    return mode;
  }

  // Satellite modules (rt-kmoni, rt-eew) — start/stop respecting their toggles
  function syncSatellites() {
    var kmoniChk = document.getElementById('rt-kmoni-enable');
    if (typeof RTKmoni !== 'undefined') {
      try {
        if (mode && kmoniChk && kmoniChk.checked) RTKmoni.start();
        else RTKmoni.stop();
      } catch(e) { console.warn('RTKmoni sync:', e); }
    }
    // EEW rings + tsunami overlays have no toggles (always on with realtime)
    if (typeof RTEew !== 'undefined') {
      try {
        if (mode) RTEew.start();
        else RTEew.stop();
      } catch(e) { console.warn('RTEew sync:', e); }
    }
    if (typeof RTTsunami !== 'undefined') {
      try {
        if (mode) RTTsunami.start();
        else RTTsunami.stop();
      } catch(e) { console.warn('RTTsunami sync:', e); }
    }
    if (typeof RTQuakeInfo !== 'undefined') {
      try {
        if (mode) RTQuakeInfo.start();
        else RTQuakeInfo.stop();
      } catch(e) { console.warn('RTQuakeInfo sync:', e); }
    }
  }

  // My-location row: current fix text + pick-button armed state. Change-guarded
  // so the 2 s rtFocusTick refresh never touches the DOM unnecessarily.
  var _userLocRowLast = '';
  function syncUserLocRow() {
    var val = document.getElementById('rt-userloc-val');
    var pick = document.getElementById('rt-userloc-pick');
    var loc = (typeof RTEew !== 'undefined' && RTEew.getUserLocation) ? RTEew.getUserLocation() : null;
    var armed = (typeof RTEew !== 'undefined' && RTEew.isUserLocPickArmed) ? RTEew.isUserLocPickArmed() : false;
    var txt = loc
      ? loc.lat.toFixed(3) + ', ' + loc.lng.toFixed(3) + (loc.manual ? '' : ' · ' + tFb('realtime.userloc_auto_tag', '自動'))
      : tFb('realtime.userloc_unset', '未設定（自動）');
    var sig = txt + '|' + (armed ? '1' : '0');
    if (sig === _userLocRowLast) return;
    _userLocRowLast = sig;
    if (val) val.textContent = txt;
    if (pick) pick.textContent = armed ? tFb('realtime.userloc_picking', '地図をクリック…') : tFb('realtime.userloc_pick', '📍 地図で選択');
  }

  var satellitesWired = false;
  function initSatelliteToggles() {
    if (satellitesWired) return;
    satellitesWired = true;
    var kmoniEnable = document.getElementById('rt-kmoni-enable');
    if (kmoniEnable) kmoniEnable.addEventListener('change', syncSatellites);
    var sens = document.getElementById('rt-kmoni-sensitivity');
    if (sens) sens.addEventListener('change', function() {
      if (typeof RTKmoni !== 'undefined' && RTKmoni.setSensitivity) { try { RTKmoni.setSensitivity(sens.value); } catch(e) {} }
    });
    var hnd = document.getElementById('rt-kmoni-hidenodata');
    if (hnd) hnd.addEventListener('change', function() {
      if (typeof RTKmoni !== 'undefined' && RTKmoni.setHideNoData) { try { RTKmoni.setHideNoData(hnd.checked); } catch(e) {} }
    });
    var sh0 = document.getElementById('rt-kmoni-shindo0');
    if (sh0) sh0.addEventListener('change', function() {
      if (typeof RTKmoni !== 'undefined' && RTKmoni.setShowShindo0) { try { RTKmoni.setShowShindo0(sh0.checked); } catch(e) {} }
    });
    // --- EEW options: manual user location, countdown warning, main view ---
    var uvSet = document.getElementById('rt-userloc-set');
    if (uvSet) uvSet.addEventListener('click', function() {
      var lat = parseFloat(document.getElementById('rt-userloc-lat').value);
      var lng = parseFloat(document.getElementById('rt-userloc-lng').value);
      var ok = (typeof RTEew !== 'undefined' && RTEew.setUserLocation) ? RTEew.setUserLocation(lat, lng) : false;
      if (!ok) { notify(tFb('realtime.userloc_invalid', '緯度・経度が不正です')); return; }
      syncUserLocRow();
    });
    var uvPick = document.getElementById('rt-userloc-pick');
    if (uvPick) uvPick.addEventListener('click', function() {
      if (typeof RTEew === 'undefined' || !RTEew.armUserLocPick) return;
      if (RTEew.isUserLocPickArmed && RTEew.isUserLocPickArmed()) RTEew.cancelUserLocPick();
      else RTEew.armUserLocPick();
      syncUserLocRow();
    });
    var uvAuto = document.getElementById('rt-userloc-auto');
    if (uvAuto) uvAuto.addEventListener('click', function() {
      if (typeof RTEew !== 'undefined' && RTEew.clearUserLocation) { try { RTEew.clearUserLocation(); } catch(e) {} }
      syncUserLocRow();
    });
    var cdSec = document.getElementById('rt-countdown-sec');
    if (cdSec) {
      try {
        var v0 = localStorage.getItem('qs-countdown-sec');
        if (v0 !== null && isFinite(Number(v0))) cdSec.value = v0;
      } catch(e) {}
      cdSec.addEventListener('change', function() {
        var v = Math.max(0, Math.min(300, Number(cdSec.value) || 0));
        cdSec.value = v;
        try { localStorage.setItem('qs-countdown-sec', String(v)); } catch(e) {}
      });
    }
    var mvChk = document.getElementById('rt-eew-mainview');
    if (mvChk) {
      try { mvChk.checked = (localStorage.getItem('qs-eew-mainview') !== '0'); } catch(e) {}
      mvChk.addEventListener('change', function() {
        if (typeof RTEew !== 'undefined' && RTEew.setMainviewEnabled) {
          try { RTEew.setMainviewEnabled(mvChk.checked); } catch(e) {}
        }
      });
    }
    var eewPageBtn = document.getElementById('btn-eew-page');
    if (eewPageBtn) eewPageBtn.addEventListener('click', function() {
      if (typeof toggleEewPage === 'function') { try { toggleEewPage(); } catch(e) {} }
    });
    var demo = document.getElementById('rt-eew-demo');
    if (demo) {
      // Button label follows the rehearsal state (start ↔ stop)
      if (typeof RTDemo !== 'undefined' && RTDemo.setStateListener) {
        try {
          RTDemo.setStateListener(function(on) {
            demo.textContent = on ? t('realtime.eew_demo_stop') : t('realtime.eew_demo');
          });
        } catch(e) {}
      }
      demo.addEventListener('click', function() {
        // While the rehearsal runs the button is the manual stop
        if (typeof RTDemo !== 'undefined' && RTDemo.isRunning && RTDemo.isRunning()) {
          try { RTDemo.stop(); } catch(e) {}
          return;
        }
        // Full rehearsal: simulated event through the realtime display language
        // (EEW rings + kmoni square station reactions). Falls back to the plain
        // EEW-ring demo when RTDemo is unavailable.
        if (typeof RTDemo !== 'undefined' && RTDemo.start) {
          try {
            if (RTDemo.start()) return;
          } catch(e) { console.warn('RTDemo start:', e); }
        }
        if (typeof RTEew !== 'undefined' && RTEew.demo) {
          try {
            var ok = RTEew.demo();
            if (!ok) notify('EEW demo: realtime mode required');
          } catch(e) { console.warn('EEW demo:', e); }
        }
      });
    }
  }

  // ================================================================
  //  REALTIME AUTO-FOCUS (kanameishi-style wave-ring framing)
  //  No events → whole-Japan view. Confirmed kmoni shaking (2-tick
  //  debounce) → hottest station at a fixed regional zoom. EEW event
  //  (active OR final — the rings keep growing after the last report) →
  //  flyToBounds framing the WHOLE current P/S wave circle with a 15%
  //  margin, re-fitting only on material growth (>12%) or a >20 km
  //  epicenter revision. Sticky per-event: no flip-flop between
  //  concurrent events, no drop-out when a report goes FINAL. Shares the
  //  sim's _autoFocus/_autoFocusMoving/_userInteracted globals, so the
  //  existing movestart/zoomstart disarm + FAB re-arm logic applies.
  // ================================================================

  var rtFocusTimer = null;
  var rtFocusQuietSince = 0;
  // Persisted camera frame — one record, reset on start/stop/refocus.
  // lat/lng/radiusKm describe the LAST FLOWN frame only (never silently
  // updated: the refly hysteresis must measure against what the camera
  // actually shows, or slow ring growth would accumulate unseen).
  var rtFocus = { key: '', lat: null, lng: null, radiusKm: null, kmoniCand: null, kmoniTicks: 0 };

  var JAPAN_BOUNDS = [[24.0, 122.5], [45.8, 146.5]];
  // Quiet-default home frame: main-islands fit (Wakkanai→Kagoshima). Measured
  // to land one Leaflet snap level closer than the old full-clamp frame
  // (zoom 6 vs 5 at 1064×900) — Japan now fills the map instead of floating
  // tiny in a wide ocean margin. fitBounds adapts smaller screens downward.
  var JAPAN_HOME_BOUNDS = [[30.0, 128.0], [45.3, 145.5]];
  var RT_QUIET_MS = 20000;            // quiet this long before zooming back out
  var RT_KMONI_ZOOM = 8;              // shaking fallback: fixed regional zoom
  var RT_FOCUS_MIN_RADIUS_KM = 60;    // early-report floor: tiny rings → ~zoom 9 frame
  var RT_FOCUS_MAX_RADIUS_KM = 1000;  // cap: never frame wider than whole Japan
  var RT_FOCUS_MARGIN = 1.15;         // visual margin around the wave ring
  var RT_FOCUS_REFLY_RADIUS_RATIO = 0.12; // re-fit when the ring changed >12% since the last flight
  var RT_FOCUS_REFLY_CENTER_KM = 20;    // ... or the epicenter moved >20 km
  var RT_FOCUS_KMONI_CONFIRM_TICKS = 2; // kmoni target must persist 2 ticks (~4 s)
  var KM_PER_DEG = 6371 * Math.PI / 180;  // ~111.195
  // INVARIANT: MARGIN > REFLY_RADIUS_RATIO. The flown frame covers 1.15×
  // the flown radius while the live ring reaches at most 1.12× before the
  // next re-fit — so the whole wave circle stays visible at ALL times,
  // not just right after a flight, with no per-tick camera jitter.

  function _rtFocusGuardStart() {
    if (typeof _autoFocusMoving !== 'undefined') _autoFocusMoving = true;
  }
  function _rtFocusGuardEnd(ms) {
    setTimeout(function() {
      if (typeof _autoFocusMoving !== 'undefined') _autoFocusMoving = false;
    }, ms);
  }

  // ---- pure decision helpers (exported for node tests) ----

  function rtFocusHaversineKm(lat1, lng1, lat2, lng2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Clamped, margined radius the camera frame is built from.
  function rtFocusEffectiveRadiusKm(radiusKm) {
    var r = Number(radiusKm);
    if (!isFinite(r) || r < RT_FOCUS_MIN_RADIUS_KM) r = RT_FOCUS_MIN_RADIUS_KM;
    if (r > RT_FOCUS_MAX_RADIUS_KM) r = RT_FOCUS_MAX_RADIUS_KM;
    return r * RT_FOCUS_MARGIN;
  }

  // Map bounds framing the wave ring: epicenter ± effective radius, clamped
  // to the whole-Japan frame. [[s, w], [n, e]]
  function rtFocusBounds(lat, lng, radiusKm) {
    var r = rtFocusEffectiveRadiusKm(radiusKm);
    var dLat = r / KM_PER_DEG;
    var cosLat = Math.cos(Math.abs(Number(lat) || 0) * Math.PI / 180);
    if (cosLat < 0.01) cosLat = 0.01;
    var dLng = dLat / cosLat;
    return [
      [Math.max(JAPAN_BOUNDS[0][0], lat - dLat), Math.max(JAPAN_BOUNDS[0][1], lng - dLng)],
      [Math.min(JAPAN_BOUNDS[1][0], lat + dLat), Math.min(JAPAN_BOUNDS[1][1], lng + dLng)]
    ];
  }

  // Sticky EEW target: keep the currently focused event while it remains
  // tracked in ANY non-canceled phase (active or final — the rings keep
  // growing after FINAL); only when it disappears (canceled/expired) fall
  // to the most recently announced remaining non-canceled event. This kills
  // the getActive() ordering flip-flop between concurrent events.
  function rtFocusPickEewEvent(events, currentKey) {
    if (!events || !events.length) return null;
    var wanted = (typeof currentKey === 'string' && currentKey.indexOf('eew:') === 0) ? currentKey.slice(4) : null;
    var sticky = null, newest = null, newestAt = -Infinity;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i] || {};
      if (ev.phase !== 'active' && ev.phase !== 'final') continue; // canceled: rings frozen, never a target
      var lt = ev.latest || {};
      if (!isFinite(lt.lat) || !isFinite(lt.lng) || (!lt.lat && !lt.lng)) continue;
      if (wanted !== null && String(ev.eventId) === wanted) sticky = ev;
      var at = (lt.announcedMs != null) ? lt.announcedMs : (ev.receivedAt || 0);
      if (at > newestAt) { newestAt = at; newest = ev; }
    }
    return sticky || newest;
  }

  // Re-fit hysteresis, measured against the LAST FLOWN frame: refly when
  // the effective radius changed >12% or the center moved >20 km.
  function rtFocusNeedsRefly(last, next) {
    if (!last || !isFinite(last.lat) || !isFinite(last.lng)) return true;
    var r0 = rtFocusEffectiveRadiusKm(last.radiusKm);
    var r1 = rtFocusEffectiveRadiusKm(next.radiusKm);
    if (Math.abs(r1 - r0) / r0 > RT_FOCUS_REFLY_RADIUS_RATIO) return true;
    return rtFocusHaversineKm(last.lat, last.lng, next.lat, next.lng) > RT_FOCUS_REFLY_CENTER_KM;
  }

  // One tick of target selection — pure. input:
  //   events   RTEew.getActive() snapshot ([] allowed)
  //   ringKmOf fn(ev) → current max(P,S) ring radius km (NaN → floor)
  //   kmoni    RTKmoni.getState()-shaped {activeCount, activeLat, activeLng} | null
  // st is the persisted rtFocus record; returns
  //   {st, hasTarget, fly: null | {kind:'eew'|'kmoni', key, lat, lng, radiusKm}}
  // At most ONE flight per call, ever.
  function rtFocusDecide(st, input) {
    st = st || {};
    input = input || {};
    var out = { key: st.key || '', lat: st.lat, lng: st.lng, radiusKm: st.radiusKm,
                kmoniCand: st.kmoniCand || null, kmoniTicks: st.kmoniTicks || 0 };
    var ringKmOf = (typeof input.ringKmOf === 'function') ? input.ringKmOf : function() { return NaN; };

    // priority 1: EEW wave-ring frame (sticky; active AND final both hold)
    var ev = rtFocusPickEewEvent(input.events, out.key);
    if (ev) {
      out.kmoniCand = null; out.kmoniTicks = 0;
      var lt = ev.latest || {};
      var key = 'eew:' + ev.eventId;
      var radiusKm = ringKmOf(ev);
      var fly = null;
      if (key !== out.key ||
          rtFocusNeedsRefly({ lat: out.lat, lng: out.lng, radiusKm: out.radiusKm },
                            { lat: lt.lat, lng: lt.lng, radiusKm: radiusKm })) {
        fly = { kind: 'eew', key: key, lat: lt.lat, lng: lt.lng, radiusKm: radiusKm };
        out.key = key; out.lat = lt.lat; out.lng = lt.lng; out.radiusKm = radiusKm;
      }
      return { st: out, fly: fly, hasTarget: true };
    }

    // priority 2: kmoni shaking — debounced, and never preempts an EEW focus
    var kmoni = input.kmoni || null;
    if (kmoni && kmoni.activeCount > 0 && isFinite(kmoni.activeLat) && isFinite(kmoni.activeLng)) {
      if (out.key === 'kmoni') {
        // already on the shaking cluster: follow only on a material jump
        if (rtFocusNeedsRefly({ lat: out.lat, lng: out.lng, radiusKm: out.radiusKm },
                              { lat: kmoni.activeLat, lng: kmoni.activeLng, radiusKm: 0 })) {
          out.lat = kmoni.activeLat; out.lng = kmoni.activeLng; out.radiusKm = 0;
          return { st: out, hasTarget: true,
                   fly: { kind: 'kmoni', key: 'kmoni', lat: kmoni.activeLat, lng: kmoni.activeLng, radiusKm: 0 } };
        }
        return { st: out, fly: null, hasTarget: true };
      }
      var sameCand = out.kmoniCand &&
        rtFocusHaversineKm(out.kmoniCand[0], out.kmoniCand[1], kmoni.activeLat, kmoni.activeLng) <= RT_FOCUS_REFLY_CENTER_KM;
      out.kmoniTicks = sameCand ? out.kmoniTicks + 1 : 1;
      out.kmoniCand = [kmoni.activeLat, kmoni.activeLng];
      if (out.kmoniTicks >= RT_FOCUS_KMONI_CONFIRM_TICKS) {
        out.key = 'kmoni'; out.lat = kmoni.activeLat; out.lng = kmoni.activeLng; out.radiusKm = 0;
        out.kmoniCand = null; out.kmoniTicks = 0;
        return { st: out, hasTarget: true,
                 fly: { kind: 'kmoni', key: 'kmoni', lat: kmoni.activeLat, lng: kmoni.activeLng, radiusKm: 0 } };
      }
      return { st: out, fly: null, hasTarget: true };
    }

    out.kmoniCand = null; out.kmoniTicks = 0;
    return { st: out, fly: null, hasTarget: false };
  }

  // ---- browser flight wrappers (camera guards shared with the sim) ----

  function rtFlyJapan() {
    if (typeof map === 'undefined' || !map) return;
    try {
      _rtFocusGuardStart();
      // NB: flyToBounds applies the padding on BOTH sides (topLeft + bottomRight),
      // so [4,4] costs only 8 px of frame — enough to hold the zoom-6 snap.
      if (map.flyToBounds) map.flyToBounds(JAPAN_HOME_BOUNDS, { duration: 1.0, padding: [4, 4] });
      else map.fitBounds(JAPAN_HOME_BOUNDS, { padding: [4, 4] });
      _rtFocusGuardEnd(1100);
    } catch(e) {}
  }

  function rtFlyEewRing(lat, lng, radiusKm) {
    if (typeof map === 'undefined' || !map) return;
    if (!isFinite(lat) || !isFinite(lng)) return; // never fly on an invalid target
    try {
      _rtFocusGuardStart();
      var b = rtFocusBounds(lat, lng, radiusKm);
      if (map.flyToBounds) map.flyToBounds(b, { duration: 0.8, padding: [20, 20] });
      else map.fitBounds(b, { padding: [20, 20] });
      _rtFocusGuardEnd(900);
    } catch(e) {}
  }

  function rtFlyKmoni(lat, lng) {
    if (typeof map === 'undefined' || !map) return;
    if (!isFinite(lat) || !isFinite(lng)) return; // never fly on an invalid target
    try {
      _rtFocusGuardStart();
      if (map.flyTo) map.flyTo([lat, lng], RT_KMONI_ZOOM, { duration: 0.8 });
      else map.setView([lat, lng], RT_KMONI_ZOOM);
      _rtFocusGuardEnd(900);
    } catch(e) {}
  }

  // Current wave-ring radius for a tracked EEW event: max(P, S) front km,
  // via the same clock/travel-time helpers the rings themselves use. NaN
  // when Physics/RTEew are unavailable (the decision then frames the floor).
  function _rtFocusRingKm(ev) {
    try {
      if (typeof Physics === 'undefined' || !Physics) return NaN;
      if (typeof RTEew === 'undefined' || !RTEew.waveRadiusKm || !RTEew.elapsedSec) return NaN;
      var lt = (ev && ev.latest) || {};
      var depth = (lt.depth != null && isFinite(lt.depth)) ? lt.depth : 10;
      var el = RTEew.elapsedSec(ev, Date.now());
      var pSpeed = (typeof cfgGet === 'function') ? Number(cfgGet('pWaveSpeed')) : NaN;
      var sSpeed = (typeof cfgGet === 'function') ? Number(cfgGet('sWaveSpeed')) : NaN;
      if (!isFinite(pSpeed) || pSpeed <= 0) pSpeed = 5.8;
      if (!isFinite(sSpeed) || sSpeed <= 0) sSpeed = 3.3;
      return Math.max(
        RTEew.waveRadiusKm(Physics.pTravelTime, depth, pSpeed, el, 2000),
        RTEew.waveRadiusKm(Physics.sTravelTime, depth, sSpeed, el, 2000));
    } catch(e) { return NaN; }
  }

  function _rtFocusReset() {
    rtFocus = { key: '', lat: null, lng: null, radiusKm: null, kmoniCand: null, kmoniTicks: 0 };
    rtFocusQuietSince = 0;
  }

  function rtFocusTick() {
    if (!mode) return;
    // Tracked auto-sim ended (natural end or user reset) → drop the tracking
    // so no later EEW report can act on a sim this module no longer owns.
    if (_autoSimEventId &&
        !(typeof isRunning !== 'undefined' && isRunning) &&
        !(typeof isCountingDown !== 'undefined' && isCountingDown)) {
      _clearAutoSimTrack();
    }
    var simRunning = (typeof isRunning !== 'undefined' && isRunning);
    // Re-assert the FAB: sim end/reset hides it, but realtime mode still
    // owns it — bring it back within one tick whatever hid it.
    if (!simRunning && typeof document !== 'undefined') {
      var bafEl = document.getElementById('btn-autofocus');
      var aflEl = document.getElementById('autofocus-label');
      if (bafEl && bafEl.style.display === 'none') bafEl.style.display = 'flex';
      if (aflEl && aflEl.style.display === 'none') aflEl.style.display = 'block';
      syncUserLocRow(); // geoIP fixes land async — pick up a late fix
    }
    if (simRunning) return;   // sim owns the camera
    if (typeof _autoFocus === 'undefined' || !_autoFocus) return; // user disarmed
    if (typeof map === 'undefined' || !map) return;

    var evs = [];
    if (typeof RTEew !== 'undefined' && RTEew.getActive) { try { evs = RTEew.getActive() || []; } catch(e) {} }
    var kst = null;
    if (typeof RTKmoni !== 'undefined' && RTKmoni.isActive && RTKmoni.getState) {
      try { if (RTKmoni.isActive()) kst = RTKmoni.getState(); } catch(e2) {}
    }
    var d = rtFocusDecide(rtFocus, { events: evs, ringKmOf: _rtFocusRingKm, kmoni: kst });
    rtFocus = d.st;
    if (d.fly) {
      rtFocusQuietSince = 0;
      if (d.fly.kind === 'eew') rtFlyEewRing(d.fly.lat, d.fly.lng, d.fly.radiusKm);
      else rtFlyKmoni(d.fly.lat, d.fly.lng);
    } else if (d.hasTarget) {
      rtFocusQuietSince = 0;
    } else {
      if (!rtFocusQuietSince) rtFocusQuietSince = Date.now();
      if (Date.now() - rtFocusQuietSince > RT_QUIET_MS && rtFocus.key !== 'japan') {
        rtFocus.key = 'japan';
        rtFocus.lat = null; rtFocus.lng = null; rtFocus.radiusKm = null;
        rtFlyJapan();
      }
    }
  }

  function rtFocusStart() {
    _rtFocusReset();
    rtFocusQuietSince = Date.now();
    if (rtFocusTimer) { clearInterval(rtFocusTimer); rtFocusTimer = null; }
    // show + arm the FAB (sim shows it on its own while running)
    var baf = document.getElementById('btn-autofocus');
    var afl = document.getElementById('autofocus-label');
    if (baf) { baf.style.display = 'flex'; baf.classList.add('active'); }
    if (afl) afl.style.display = 'block';
    if (typeof _autoFocus !== 'undefined') { _autoFocus = true; _userInteracted = false; }
    rtFocus.key = 'japan';
    rtFlyJapan();
    rtFocusTimer = setInterval(rtFocusTick, 2000);
  }

  function rtFocusStop() {
    if (rtFocusTimer) { clearInterval(rtFocusTimer); rtFocusTimer = null; }
    _rtFocusReset();
    // hide the FAB unless the sim is using it (no DOM under node tests)
    if (typeof document !== 'undefined' && !(typeof isRunning !== 'undefined' && isRunning)) {
      var baf = document.getElementById('btn-autofocus');
      var afl = document.getElementById('autofocus-label');
      if (baf) { baf.style.display = 'none'; baf.classList.remove('active'); }
      if (afl) afl.style.display = 'none';
    }
  }

  // FAB re-arm in realtime mode (called from the app.js click handler).
  // Recomputes the target and flies IMMEDIATELY through the same bounds
  // logic — an EEW event gets its wave-ring frame now; a quiet field
  // re-frames whole Japan now.
  function refocusNow() {
    _rtFocusReset();
    rtFocusTick(); // flies when an active target exists
    if (!rtFocus.key) {
      rtFocus.key = 'japan';
      rtFlyJapan();
    }
  }

  // --- state accessors ---
  function isActive() { return mode; }
  function getData() { return data; }
  function getSkipCountdown() { return skipCountdown; }
  function setSkipCountdown(v) { skipCountdown = v; }
  function getP2PLast() { return p2pLast; }
  function resetState() {
    if (timer) { clearInterval(timer); timer = null; }
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    sseWatchdogStop();
    mode = false; // before stopReplay so the live stream does not resume
    stopReplay();
    stopP2PStream();
    rtFocusStop();
    healthStop();
    if (typeof RTKmoni !== 'undefined' && RTKmoni.stop) { try { RTKmoni.stop(); } catch(e) {} }
    if (typeof RTEew !== 'undefined' && RTEew.stop) { try { RTEew.stop(); } catch(e) {} }
    if (typeof RTTsunami !== 'undefined' && RTTsunami.stop) { try { RTTsunami.stop(); } catch(e) {} }
    data = []; seen = {}; seenKeys = [];
    usgsLast = 0; p2pLast = 0; liveSources = null;
    skipCountdown = false; fetching = false;
    _clearAutoSimTrack();
    if (mapLayer) { mapLayer.clearLayers(); mapMarkers = []; }
    // Drop any toasts still queued mid-display so a fresh session starts clean.
    toastQueue.length = 0;
    toastBusy = false;
    try {
      var toastEl = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('rt-toast') : null;
      if (toastEl) {
        if (toastEl._timeout) { clearTimeout(toastEl._timeout); toastEl._timeout = null; }
        toastEl.style.opacity = '0';
      }
    } catch (e) {}
  }

  return {
    // core
    toggle: toggle,
    fetchData: fetchData,
    startP2PStream: startP2PStream,
    stopP2PStream: stopP2PStream,
    // event bus: stable facade so satellite modules (rt-kmoni, rt-eew,
    // rt-tsunami) attach named-event listeners once — frames fan out from
    // the live SSE stream or, during replay, from the replay stream
    getP2PSource: function() { return busFacade; },
    // server replay (回放)
    startReplay: startReplay,
    stopReplay: stopReplay,
    isReplaying: function() { return replaying; },
    initReplayControls: initReplayControls,
    // realtime auto-focus (FAB re-arm hook for app.js)
    refocusNow: refocusNow,
    rtFocusTick: rtFocusTick,
    // auto-focus decision helpers (pure — exported for tests)
    rtFocusDecide: rtFocusDecide,
    rtFocusPickEewEvent: rtFocusPickEewEvent,
    rtFocusNeedsRefly: rtFocusNeedsRefly,
    rtFocusBounds: rtFocusBounds,
    rtFocusEffectiveRadiusKm: rtFocusEffectiveRadiusKm,
    rtFocusHaversineKm: rtFocusHaversineKm,
    renderList: renderList,
    updateMapMarkers: updateMapMarkers,
    initDelegation: initDelegation,
    autoStartFromEvent: autoStartFromEvent,
    // EEW options row (user location / countdown / main view)
    syncUserLocRow: syncUserLocRow,
    // bulletin chimes (exported for tests)
    bulletinSoundFor: bulletinSoundFor,
    isFreshBulletin: isFreshBulletin,
    // EEW 続報 auto-sim revision (exported for tests)
    shouldReviseAutoSim: shouldReviseAutoSim,
    nearestJapanDistance: nearestJapanDistance,
    estimatedMaxShindo: estimatedMaxShindo,
    requestNotificationPermission: requestNotificationPermission,
    // Notification API wrapper + shared toast queue (satellite modules)
    notifySystem: notifySystem,
    toastQueued: toastQueued,
    toastQueuePush: toastQueuePush, // pure queue mutation — exported for tests
    // frame routing (exported for tests)
    handleP2pquake: handleP2pquake,
    // normalizers (exported for testing)
    normalizeUSGS: normalizeUSGS,
    normalizeP2P: normalizeP2P,
    // replay time-shifting (exported for tests)
    shiftEventTimes: shiftEventTimes,
    shiftTimeValue: shiftTimeValue,
    // replay timeline (时间轴) — exported for tests/probes
    computeReplayClock: computeReplayClock,
    fmtJstHm: fmtJstHm,
    refreshReplayTimeline: refreshReplayTimeline,
    fetchReplayTimeline: fetchReplayTimeline,
    // state accessors
    isActive: isActive,
    getData: getData,
    getSkipCountdown: getSkipCountdown,
    setSkipCountdown: setSkipCountdown,
    getP2PLast: getP2PLast,
    resetState: resetState,
    // snapshots for app.js compatibility
    getMode: function() { return mode; },
    getLiveSources: function() { return liveSources; },
    getSrcColors: function() { return SRC_COLORS; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTData;
