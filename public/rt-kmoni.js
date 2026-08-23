// ================================================================
//  Earthquake Simulator Pro v5.2 — NIED kmoni (強震モニタ) real-time layer
//  ~1 Hz per-station realtime intensity from the shared SSE stream
//  (named event "kmoni_rt"), Yahoo direct-origin polling fallback,
//  and chain-activation shaking detection with grid overlay + feedback.
//  Original implementation of the chain-activation concept; shares
//  only the public data contract (sitelist + 1725-char intensity
//  string, level = charCode - 100, -1 = no data).
//  Load after: rt-data.js   (shares its EventSource via RTData.getP2PSource)
//  Load before: app.js
//
//  Per-frame heavy compute (intensity decode, per-station time series,
//  chain-activation detection, period-max, top-N) lives in
//  rt-kmoni-worker.js as a UMD module and runs inside a classic Web
//  Worker (URL versioned by KMONI_WORKER_V below). This file keeps the
//  main-thread duties: SSE/polling transport, Leaflet marker rendering,
//  popups, panel DOM and settings. When Worker is unavailable the SAME
//  UMD core runs in-process (node always takes this path) — there is no
//  second copy of the logic.
// ================================================================

// Compute-core loading. Node: require the UMD directly. Browser: pull the
// worker file in as a plain script too (async=false, ordered) so the pure
// delegates below and the in-process fallback engine share the one
// implementation. It is tiny and same-origin; the worker itself fetches
// its own copy from the same URL (HTTP cache).
//
// Cache-bust version shared by BOTH rt-kmoni-worker.js URLs (the core
// script injection below and the Worker construction in ensureWorker) —
// bump it whenever rt-kmoni-worker.js changes so browsers pick up the new
// core on both paths.
var KMONI_WORKER_V = 'ca3f36';
var _rtKmoniCore = null;
if (typeof module !== 'undefined' && module.exports) {
  try { _rtKmoniCore = require('./rt-kmoni-worker.js'); } catch (e) { _rtKmoniCore = null; }
} else if (typeof document !== 'undefined') {
  try {
    var _rtKmoniCoreScript = document.createElement('script');
    _rtKmoniCoreScript.src = 'rt-kmoni-worker.js?v=' + KMONI_WORKER_V;
    _rtKmoniCoreScript.async = false;
    (document.head || document.documentElement).appendChild(_rtKmoniCoreScript);
  } catch (e) {}
}

var RTKmoni = (function() {
  // --- constants ---
  var SITE_API = '/api/kmoni/sitelist';
  var SITE_DIRECT = 'https://weather-kyoshin.east.edge.storage-yahoo.jp/SiteList/sitelist.json';
  var RT_DIRECT = 'https://weather-kyoshin.east.edge.storage-yahoo.jp/RealTimeData/';
  var SITELIST_RETRY_MS = [5000, 15000, 60000]; // backoff ladder after a failed sitelist load

  // Official NIED rendered intensity map (RealTimeImg jma_s), proxied
  // same-origin through the server and underlaid beneath the station squares.
  // OFFICIAL_IMG_BOUNDS is the geographic extent of the image's
  // equirectangular grid, calibrated against 1122 mainland stations' official
  // pixel coordinates (352x400 base grid, RMS 0.68 px; Okinawa/Ogasawara
  // inset boxes sit off-grid over the ocean, as in the official render).
  var OFFICIAL_IMG_API = '/api/kmoni/image';
  var OFFICIAL_IMG_BOUNDS = [[29.9598, 128.6037], [46.2600, 145.8958]];
  var OFFICIAL_IMG_OPACITY = 0.5;
  var OFFICIAL_IMG_ZINDEX = 1;     // overlayPane — markerPane (stations) stays above
  var OFFICIAL_IMG_REFRESH_MS = 10000;
  // Source failover: the same-origin proxy is tried first (server cache,
  // works whenever the server can reach NIED); when it 503s the overlay
  // falls back to loading NIED's render directly in the browser — <img>
  // display needs no CORS, so networks where only the SERVER is blocked
  // from bosai.go.jp still get the official map. nied-old is the
  // long-stable path, nied-new the post-2023 site. A source that loads
  // sticks; only sustained failure across every source auto-disables.
  var OFFICIAL_IMG_DIRECT = [
    { name: 'nied-new', base: 'https://www.kmoni.bosai.go.jp/new/data/map_img/RealTimeImg/jma_s/' },
    { name: 'nied-old', base: 'https://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_s/' }
  ];
  var OFFICIAL_IMG_DIRECT_DELAY_MS = 10000; // rendered frames publish behind the JSON feed
  var OFFICIAL_IMG_FAIL_MAX_TOTAL = 6;      // consecutive failures across all sources -> auto-off

  // 21-step color ramp indexed by level 0..20 — the NIED 強震モニタ
  // official scale: blue/cyan while quiet, through green and yellow, to
  // orange/red as measured intensity rises (levelToShindo bands: 0-7
  // shindo 0, 8-9 shindo 1, ... 20 shindo 7). Quiet-period micro-variation
  // (levels 0-5) is visually distinct, like the official monitor.
  var RAMP = [
    '#0003cf','#0014da','#0037f0','#006cdc','#00b3a2','#12dc72',
    '#31f049','#64fb2a','#9dfe17','#ccff09','#ebff03',
    '#fff500','#ffe500','#ffca00','#ffa600','#ff7e00',
    '#ff5900','#fd3500','#f81100','#e50000','#bd0000'
  ];
  var NO_DATA_COLOR = '#cfcfcf';

  var FALLBACK_AFTER_MS = 8000;  // switch to direct polling after this SSE gap
  var SSE_RESUME_FRAMES = 2;     // consecutive SSE frames that switch back from fallback
  var SSE_RESUME_MAX_GAP_MS = 4000; // a wider gap between frames resets the count
  var ICON_MIN_ZOOM = 4;         // shindo-number icons at/above this zoom
  var ICON_MIN_LEVEL = 8;        // icons from shindo 1 (level 8) ...
  var ICON_MIN_LEVEL_ZERO = 6;   // ... or from level 6 (shindo 0) when enabled
  var DELAY_MIN = 1500, DELAY_MAX = 3000; // fallback adaptive delay bounds
  var TOP_QUIET_LEVEL = 8;   // network-wide max below shindo 1 -> quiet placeholder
  var TOP_FLYTO_ZOOM = 9;    // row-click flyTo minimum zoom

  // --- state ---
  var active = false;
  var stations = [];          // render mirror: {lat,lng,level,_idx,...} (no history rings — see popup state below)
  var siteConfigId = null;
  var refetchId = null;       // siteConfigId we already refetched for (once per episode)
  var layer = null;
  var markers = [];
  var rects = {};             // grid cell key -> {rect, color}
  var flashOn = false;        // blink phase for detected grid cells
  var flashTimer = null;      // 500 ms blink driver (independent of frame flow)
  var source = null;
  var sseRetryTimer = null;
  var watchdog = null;
  var zoomBound = false;
  var lastFrameAt = 0;
  var lastDataTime = null;
  var fallbackActive = false;
  var fallbackTimer = null;
  var fallbackDelay = DELAY_MIN;
  var sseResumeStreak = 0;    // consecutive SSE frames seen while the fallback runs
  var sseResumeLastAt = 0;    // last such frame time (a wide gap resets the streak)
  var sitelistRetries = 0;    // failed sitelist loads so far (backoff ladder index)
  var sitelistRetryTimer = null;
  var periodMax = 0;          // mirror of the engine's period.max (getState)
  var latestTop = [];         // latest frame's strongest-stations list
  // Station-popup sparkline state: ONE shared raw-level ring (newest first,
  // cap 30) for the station whose popup is open — only one popup is open at
  // a time. The engine's per-station 30-frame detection history used to be
  // mirrored here per station (1725 rings for a popup that is rarely open);
  // now the ring fills live from each frame while the popup is open.
  var popupStationIdx = -1;   // stations[] index of the open popup (-1 = none)
  var popupRing = [];         // shared sparkline history for that station
  var popupRef = null;        // the open Leaflet popup (for live refresh)
  var lastActiveCount = 0;
  var lastActiveLat = NaN;    // hottest active station (realtime auto-focus target)
  var lastActiveLng = NaN;
  var worker = null;          // classic Worker running rt-kmoni-worker.js
  var workerFailed = false;   // construction/runtime failure -> in-process engine
  var syncEngine = null;      // in-process RTKmoniCore engine (fallback path)
  var sensMode = null;         // '1'|'2'|'3' once set (setter/localStorage); DOM select wins when present
  var hideNoDataState = false; // setter/localStorage state; DOM checkbox wins when present
  var showShindo0State = true; // shindo-0 icons (level >= 6) default on; DOM checkbox wins when present
  var demoMode = false;        // RTDemo drives synthetic frames; live feed paused
  var demoAbortHandler = null; // called when real shaking appears mid-demo
  var topCollapsed = false;    // strongest-stations panel collapse state
  var topWired = false;        // panel click delegation bound once per page
  var officialImgState = false; // official-image underlay; DOM checkbox wins when present
  var officialImgOverlay = null;
  var officialImgTimer = null;
  var officialImgFails = 0;      // consecutive load failures, total across sources
  var officialImgSrcIdx = 0;     // 0 = same-origin proxy, 1..N = OFFICIAL_IMG_DIRECT
  var officialImgWired = false;  // DOM change listener bound once per page

  // ================================================================
  //  PURE HELPERS (exported for tests)
  //  The compute implementations live in rt-kmoni-worker.js (UMD core);
  //  these are thin delegates so this module, the worker and the
  //  in-process fallback all share ONE implementation. core() is null
  //  only in the brief browser window before the core script lands.
  // ================================================================

  function core() {
    if (_rtKmoniCore) return _rtKmoniCore;
    if (typeof window !== 'undefined' && window.RTKmoniCore) {
      _rtKmoniCore = window.RTKmoniCore;
    }
    return _rtKmoniCore;
  }

  // Decode the per-station intensity string: level = charCodeAt - 100,
  // clamped to [-1, 20] (-1 = no data; rare other negatives collapse to -1).
  function decodeIntensity(str) {
    var c = core();
    return c ? c.decodeIntensity(str) : new Int16Array(0);
  }

  // kanameishi-style level bands -> JMA shindo number ('0'..'7')
  function levelToShindo(level) {
    var c = core();
    return c ? c.levelToShindo(level) : '0';
  }

  // Display label with the 5-/5+/6-/6+ sub-bands. Same band edges as
  // levelToShindo, split one level each at the top end (16=5-, 17=5+,
  // 18=6-, 19=6+, 20=7) — detection/coloring stays on the coarse bands.
  function levelToShindoFine(level) {
    if (level <= 15) return levelToShindo(level);
    if (level === 16) return '5-';
    if (level === 17) return '5+';
    if (level === 18) return '6-';
    if (level === 19) return '6+';
    return '7';
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var c = core();
    return c ? c.haversineKm(lat1, lng1, lat2, lng2) : 0;
  }

  function itemLat(it) { return Array.isArray(it) ? it[0] : it.lat; }
  function itemLng(it) { return Array.isArray(it) ? it[1] : it.lng; }

  // For every station: indices of the nearest maxN stations within maxKm,
  // sorted by ascending distance. One-shot O(n^2). Island stations with at
  // most one neighbor inside maxKm additionally get their nearest station
  // within 40 km appended (kanameishi parity — otherwise they can never
  // form a detection quorum). Core implementation; the worker engine uses
  // it at init, this delegate stays exported for tests.
  function buildAdjacency(items, maxKm, maxN) {
    var c = core();
    return c ? c.buildAdjacency(items, maxKm, maxN) : [];
  }

  // Per-station activity score from current level, recent ascend and
  // whether the station is already in the active set. Matches the
  // kanameishi/NIED-style gating: a station only scores when it is rising
  // (ascend > 0) or already active, and the ascend contribution counts
  // even at low levels — this is what lets a broad halo of slightly
  // elevated stations light up during weak shaking. Core implementation.
  function computeActivity(level, ascend, isActive) {
    var c = core();
    return c ? c.computeActivity(level, ascend, isActive) : 0;
  }

  // Detection-sensitivity presets (kanameishi parity). mode '3' (high):
  // half the data-bearing neighbors as quorum and a -2 activity bar;
  // mode '1' (low): fixed 3-neighbor quorum and a +2 activity bar;
  // anything else: medium. Core implementation.
  function sensitivityThresholds(mode) {
    var c = core();
    return c ? c.sensitivityThresholds(mode)
      : { numThres: function() { return Infinity; }, actOffset: 0 };
  }

  // Chain-activation detection (kanameishi parity), exported for tests.
  // The worker engine runs the same core function per frame; this wrapper
  // only preserves the legacy default of reading the live UI sensitivity
  // when mode is omitted.
  function detectActive(sts, adj, mode) {
    var c = core();
    if (!c) return [];
    return c.detectActive(sts, adj, mode || currentSensitivity());
  }

  // Period max-level tracker (pure, exported for tests). Core implements;
  // the live period state itself is tracked inside the worker/fallback
  // engine and mirrored here as `periodMax`.
  function freshPeriod() {
    var c = core();
    return c ? c.freshPeriod() : { max: 0, lastActiveMs: 0, band: 0, notify: -1 };
  }

  function nextPeriodState(prev, activeMaxLevel, activeCount, nowMs) {
    var c = core();
    return c ? c.nextPeriodState(prev, activeMaxLevel, activeCount, nowMs) : prev;
  }

  // Strongest-stations ranking (pure, exported for tests). The live panel
  // renders `latestTop` from the engine's frame results; this delegate
  // keeps the helper available for tests and external callers.
  function topStations(states, n) {
    var c = core();
    return c ? c.topStations(states, n) : [];
  }

  // Simulation-running context for the popup sim-vs-obs row, or null when no
  // simulation with a valid epicenter is running. Reads app.js globals
  // defensively (all typeof-guarded; node-safe): isRunning + epicenter gate
  // the row, magnitude falls back from eventMw to the mag slider, depth comes
  // from the depth slider, source class from epicenterSrc (else 'crustal').
  function simRunGlobals() {
    try {
      if (typeof isRunning === 'undefined' || !isRunning) return null;
      var epi = (typeof epicenter !== 'undefined') ? epicenter : null;
      if (!epi || typeof epi.lat !== 'number' || typeof epi.lng !== 'number') return null;
      var mw = (typeof eventMw !== 'undefined' && typeof eventMw === 'number' && isFinite(eventMw))
        ? eventMw
        : ((typeof magSlider !== 'undefined' && magSlider) ? parseFloat(magSlider.value) : NaN);
      var dep = (typeof depthSlider !== 'undefined' && depthSlider) ? parseFloat(depthSlider.value) : NaN;
      if (!isFinite(mw) || !isFinite(dep)) return null;
      var src = (typeof epicenterSrc !== 'undefined' && epicenterSrc) ? epicenterSrc : 'crustal';
      return { mw: mw, depth: dep, src: src };
    } catch (e) { return null; }
  }

  // GMPE-predicted JMA intensity at a station for the running simulation:
  // Zhao 2006 PGA/PGV at the hypocentral distance (haversine surface range
  // composed with the focal depth) -> calcJmaIntensity -> intensityToShindo.
  // The epicenter comes from the app.js global. Returns
  // {rKm, intensity, shindo} or null when Physics, the epicenter or the
  // numeric inputs are unusable (the popup row stays hidden then).
  function predictStationShindo(lat, lng, mw, depthKm, src) {
    if (typeof Physics === 'undefined' || !Physics) return null;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    if (!(mw > 0) || !(depthKm >= 0)) return null;
    var epi = (typeof epicenter !== 'undefined') ? epicenter : null;
    if (!epi || typeof epi.lat !== 'number' || typeof epi.lng !== 'number') return null;
    var s = src || 'crustal';
    var surf = haversineKm(lat, lng, epi.lat, epi.lng);
    var rHyp = Math.sqrt(surf * surf + depthKm * depthKm);
    var pga = Physics.pgaZhao2006(mw, rHyp, depthKm, s);
    var pgv = Physics.pgvZhao2006(mw, rHyp, depthKm, s);
    var inten = Physics.calcJmaIntensity(pga, pgv);
    return { rKm: rHyp, intensity: inten, shindo: Physics.intensityToShindo(inten) };
  }

  // Popup row comparing the GMPE prediction with the current observation:
  // "予測 3.2 (3) · 実測 2.8 (2) · 差 +0.4". pred is a predictStationShindo
  // result; obsLevel is the kmoni level (-1 = no data -> obs shown as '—'
  // and the diff omitted). The diff (predicted - observed intensity) is
  // colored: red when the prediction overestimates, blue when it
  // underestimates, gray within ±0.5. Returns '' when pred is invalid.
  function simVsObsRow(pred, obsLevel) {
    if (!pred || typeof pred.intensity !== 'number' || !isFinite(pred.intensity)) return '';
    var hasObs = (typeof obsLevel === 'number') && isFinite(obsLevel) && obsLevel >= 0;
    var obsI = hasObs ? obsLevel / 10 : null;
    var diffHtml = '';
    if (hasObs) {
      var d = pred.intensity - obsI;
      var col = Math.abs(d) < 0.5 ? '#888' : (d > 0 ? '#c0392b' : '#2e7fdb');
      diffHtml = ' · ' + tt('realtime.kmoni.popup_sim_diff', '差') +
        ' <b style="color:' + col + '">' + (d >= 0 ? '+' : '') + d.toFixed(1) + '</b>';
    }
    return '<div class="rt-kmoni-simobs" style="margin-top:4px;padding-top:4px;border-top:1px solid #ddd;color:#555">' +
      tt('realtime.kmoni.popup_sim_pred', '予測') + ' <b>' + pred.intensity.toFixed(1) + '</b> (' + pred.shindo + ') · ' +
      tt('realtime.kmoni.popup_sim_obs', '実測') + ' <b>' + (hasObs ? obsI.toFixed(1) : '—') + '</b> (' +
      (hasObs ? levelToShindoFine(obsLevel) : '—') + ')' + diffHtml + '</div>';
  }

  // ================================================================
  //  ENVIRONMENT GUARDS (all DOM/Leaflet access is lazy)
  // ================================================================

  function getMap() {
    return (typeof window !== 'undefined' && window.map) ? window.map : null;
  }
  function hasL() { return typeof L !== 'undefined'; }

  function zoomScale() {
    var map = getMap();
    var z = (map && map.getZoom) ? map.getZoom() : 6;
    var c = Math.max(4, Math.min(10, z));
    return Math.pow(2, c / 2 - 3);
  }

  function currentZoom() {
    var map = getMap();
    return (map && map.getZoom) ? map.getZoom() : 6;
  }

  // Optional DOM control lookup — always null under node.
  function domEl(id) {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function lsGet(k) {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k);
    } catch (e) {}
    return null;
  }

  function lsSet(k, v) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
    } catch (e) {}
  }

  // i18n lookup with Japanese fallback (same contract as rt-eew tt):
  // window.t wins when present and not echoing the key back.
  function tt(key, fallback) {
    if (typeof window !== 'undefined' && typeof window.t === 'function') {
      try {
        var v = window.t(key);
        if (v && v !== key) return v;
      } catch (e) {}
    }
    return fallback;
  }

  // Live sensitivity mode: the DOM select (read each detection pass, so user
  // changes apply without wiring) wins; else the setter/restored value;
  // else '2' (medium).
  function currentSensitivity() {
    var el = domEl('rt-kmoni-sensitivity');
    var v = el ? el.value : null;
    if (v === '1' || v === '2' || v === '3') return v;
    if (sensMode) return sensMode;
    return '2';
  }

  // Live hide-no-data flag: DOM checkbox when present, else setter state.
  function currentHideNoData() {
    var el = domEl('rt-kmoni-hidenodata');
    if (el) return !!el.checked;
    return hideNoDataState;
  }

  // Live shindo-0 icon flag: DOM checkbox when present, else setter state.
  function currentShowShindo0() {
    var el = domEl('rt-kmoni-shindo0');
    if (el) return !!el.checked;
    return showShindo0State;
  }

  // Live official-image flag: DOM checkbox when present, else setter state.
  function currentOfficialImg() {
    var el = domEl('rt-kmoni-official-img');
    if (el) return !!el.checked;
    return officialImgState;
  }

  // ================================================================
  //  OFFICIAL IMAGE UNDERLAY (NIED RealTimeImg via /api/kmoni/image)
  // ================================================================

  // Cache-bust URL for the current proxied frame (pure, exported for tests)
  function officialImgUrl(now) {
    if (officialImgSrcIdx > 0) return officialImgDirectUrl(officialImgSrcIdx - 1, now);
    return OFFICIAL_IMG_API + '?t=' + (now || Date.now());
  }
  // JST (UTC+9) wall clock via UTC getters so the browser TZ does not matter
  function officialImgJstStrings(ms) {
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var d = new Date(ms + 9 * 3600e3);
    var date = '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
    return { date: date, time: date + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) };
  }
  function officialImgDirectUrl(idx, now) {
    var ts = officialImgJstStrings((now || Date.now()) - OFFICIAL_IMG_DIRECT_DELAY_MS);
    return OFFICIAL_IMG_DIRECT[idx].base + ts.date + '/' + ts.time + '.jma_s.gif';
  }

  // Failure threshold for auto-disabling the toggle (pure, exported for tests)
  function officialImgShouldDisable(failsTotal) {
    return failsTotal >= OFFICIAL_IMG_FAIL_MAX_TOTAL;
  }

  // Defensive copy of the calibrated image bounds (pure, exported for tests)
  function officialImgBounds() {
    return [[OFFICIAL_IMG_BOUNDS[0][0], OFFICIAL_IMG_BOUNDS[0][1]],
      [OFFICIAL_IMG_BOUNDS[1][0], OFFICIAL_IMG_BOUNDS[1][1]]];
  }

  function removeOfficialImgOverlay() {
    if (officialImgTimer) { clearInterval(officialImgTimer); officialImgTimer = null; }
    if (officialImgOverlay) { try { officialImgOverlay.remove(); } catch (e) {} officialImgOverlay = null; }
    officialImgFails = 0;
    officialImgSrcIdx = 0;
  }

  function officialImgFailed() {
    officialImgFails++;
    if (officialImgShouldDisable(officialImgFails)) {
      setOfficialImg(false);
      toast(tt('realtime.kmoni.official_img_fail',
        '公式強震画像を読み込めません — スイッチをオフにしました'));
      return;
    }
    // Fail over to the next candidate source and retry right away —
    // proxy -> nied-new -> nied-old -> proxy ..., so every source gets
    // two attempts before the toggle gives up.
    officialImgSrcIdx = (officialImgSrcIdx + 1) % (1 + OFFICIAL_IMG_DIRECT.length);
    if (officialImgOverlay) { try { officialImgOverlay.setUrl(officialImgUrl()); } catch (e) {} }
  }

  function officialImgRefresh() {
    if (!active || !currentOfficialImg()) { applyOfficialImg(); return; }
    if (!officialImgOverlay) return;
    try { officialImgOverlay.setUrl(officialImgUrl()); } catch (e) {}
  }

  function applyOfficialImg() {
    if (!active || !currentOfficialImg()) { removeOfficialImgOverlay(); return; }
    if (!hasL()) return;
    var map = getMap();
    if (!map) return;
    if (!officialImgOverlay) {
      officialImgFails = 0;
      officialImgOverlay = L.imageOverlay(officialImgUrl(), officialImgBounds(), {
        opacity: OFFICIAL_IMG_OPACITY,
        zIndex: OFFICIAL_IMG_ZINDEX,
        interactive: false
      });
      officialImgOverlay.on('load', function() { officialImgFails = 0; });
      officialImgOverlay.on('error', officialImgFailed);
      officialImgOverlay.addTo(map);
    }
    if (!officialImgTimer) {
      officialImgTimer = setInterval(officialImgRefresh, OFFICIAL_IMG_REFRESH_MS);
    }
  }

  function setOfficialImg(v) {
    officialImgState = !!v;
    lsSet('qs-kmoni-official-img', String(officialImgState));
    var el = domEl('rt-kmoni-official-img');
    if (el) el.checked = officialImgState;
    applyOfficialImg();
  }

  function wireOfficialImgToggle() {
    if (officialImgWired) return;
    var el = domEl('rt-kmoni-official-img');
    if (!el) return;
    officialImgWired = true;
    el.addEventListener('change', function() { setOfficialImg(el.checked); });
    // No data-i18n on the label span until the key lands in i18n.js —
    // translate opportunistically through the shared tt() fallback instead.
    var lbl = el.parentNode ? el.parentNode.querySelector('span') : null;
    if (lbl) lbl.textContent = tt('realtime.kmoni.official_img', '公式強震画像');
  }

  // ================================================================
  //  SITELIST & STATION RECORDS
  // ================================================================

  function fetchJSON(url) {
    return fetch(url).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    });
  }

  // Backoff wait before retry attempt N of a failed sitelist load (pure,
  // exported for tests): 5 s / 15 s / 60 s, then null once the bounded
  // ladder is exhausted — a still-missing list is re-attempted fresh by
  // the next start().
  function sitelistRetryDelay(attempt) {
    return (attempt >= 0 && attempt < SITELIST_RETRY_MS.length) ? SITELIST_RETRY_MS[attempt] : null;
  }

  function scheduleSitelistRetry() {
    if (!active || sitelistRetryTimer) return;
    var wait = sitelistRetryDelay(sitelistRetries);
    if (wait === null) return;
    sitelistRetries++;
    sitelistRetryTimer = setTimeout(function() {
      sitelistRetryTimer = null;
      loadSitelist();
    }, wait);
  }

  function loadSitelist() {
    return fetchJSON(SITE_API).catch(function() {
      return fetchJSON(SITE_DIRECT);
    }).then(function(json) {
      // A stop() may have landed while the fetch was in flight — rebuilding
      // the 1725-station layer here would resurrect a terminated engine.
      if (!active) return;
      var items = Array.isArray(json) ? json : ((json && json.items) || []);
      siteConfigId = (json && json.siteConfigId) || null;
      sitelistRetries = 0; // success clears the backoff ladder ...
      if (sitelistRetryTimer) { clearTimeout(sitelistRetryTimer); sitelistRetryTimer = null; } // ... and any pending retry
      buildStations(items);
      // positions/config may have changed — rebuild the marker layer
      if (layer) { try { layer.remove(); } catch (e) {} layer = null; markers = []; rects = {}; }
      ensureLayer();
    }).catch(function(e) {
      if (typeof console !== 'undefined') console.warn('RTKmoni sitelist failed:', e && e.message);
      scheduleSitelistRetry(); // bounded retries — a failed load used to be a session-wide outage
    });
  }

  function buildStations(items) {
    stations = new Array(items.length);
    var positions = new Array(items.length);
    for (var i = 0; i < items.length; i++) {
      // render mirror only — the per-station detection state (ascend,
      // activity, activeUntil, expireS, recentLevel history, ...) lives in
      // the worker/fallback engine; we mirror level from each frame result
      stations[i] = {
        lat: itemLat(items[i]), lng: itemLng(items[i]),
        level: -1,
        _idx: i, _rl: -999, _rr: -1
      };
      positions[i] = [stations[i].lat, stations[i].lng];
    }
    latestTop = [];
    // a sitelist swap invalidates any open popup's station binding (the
    // popup itself stays open with frozen content, same as before)
    popupStationIdx = -1; popupRing = []; popupRef = null;
    initEngine(positions);
  }

  // ================================================================
  //  COMPUTE BACKEND (worker with in-process fallback, one engine impl)
  // ================================================================

  function stationPositions() {
    var p = new Array(stations.length);
    for (var i = 0; i < stations.length; i++) p[i] = [stations[i].lat, stations[i].lng];
    return p;
  }

  function ensureWorker() {
    if (worker) return worker;
    if (workerFailed) return null;
    if (typeof Worker !== 'function') return null;
    try {
      var w = new Worker('rt-kmoni-worker.js?v=' + KMONI_WORKER_V);
      w.onmessage = function(e) { onWorkerResult(e && e.data); };
      w.onerror = function() { handleWorkerDead(); };
      worker = w;
    } catch (e) {
      handleWorkerDead();
    }
    return worker;
  }

  // Worker construction/runtime failure: drop to the in-process engine and
  // rebuild the current sitelist state there (detection history is lost,
  // the next frames rebuild it — this path should never run in practice).
  function handleWorkerDead() {
    workerFailed = true;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    if (stations.length) initEngine(stationPositions());
  }

  function initEngine(positions) {
    if (ensureWorker()) {
      try {
        worker.postMessage({ type: 'init', stations: positions, sensitivity: currentSensitivity() });
        return;
      } catch (e) { handleWorkerDead(); }
    }
    var c = core();
    if (!c) return; // core script not landed yet — first frames drop, then it heals
    if (!syncEngine) syncEngine = c.createEngine();
    syncEngine.init(positions, currentSensitivity());
  }

  function onWorkerResult(msg) {
    if (msg && msg.type === 'frame') applyFrameResult(msg);
  }

  // ================================================================
  //  MARKER LAYER
  // ================================================================

  function markerStyle(lv, radius, hidden) {
    if (lv < 0) {
      if (hidden) {
        return { radius: radius, color: NO_DATA_COLOR, weight: 1,
          opacity: 0, fillColor: NO_DATA_COLOR, fillOpacity: 0 };
      }
      return { radius: radius, color: NO_DATA_COLOR, weight: 1,
        opacity: 0.4, fillColor: NO_DATA_COLOR, fillOpacity: 0.4 };
    }
    // solid squares like the official monitor — at ~4 px a translucent fill
    // washes the ramp colors out against the basemap
    var c = RAMP[lv];
    return { radius: radius, color: c, weight: 0,
      opacity: 1, fillColor: c, fillOpacity: 1 };
  }

  function baseRadius(lv) { return (lv <= 5) ? 2 : 2.5; }

  // kanameishi-style shindo-number icons take over from the plain dot at
  // modest zoom when the station reads shindo 1+ (level >= 8), or shindo 0
  // (level >= 6) when the shindo-0 display is enabled
  function markerKindFor(zoom, level, showShindo0) {
    var minLv = (showShindo0 === undefined ? currentShowShindo0() : showShindo0)
      ? ICON_MIN_LEVEL_ZERO : ICON_MIN_LEVEL;
    return (zoom >= ICON_MIN_ZOOM && level >= minLv) ? 'icon' : 'dot';
  }

  // kanameishi curve: 16 px at zoom 6, x1.5 per two zooms, zoom clamped 6..10
  function iconSizeForZoom(zoom) {
    var z = Math.max(6, Math.min(10, zoom));
    return Math.round(16 * Math.pow(1.5, z / 2 - 3));
  }

  // Plain station marker: a filled SQUARE (NIED-monitor style). Realtime
  // stations are deliberately square so they cannot be confused with the
  // simulation's round station circles when both layers are on screen.
  // Colors/opacity come from markerStyle (single source of truth).
  // The icon box is 6 px larger than the visible square (3 px transparent
  // margin) so ~4 px dots stay clickable.
  function dotIconHtml(level, px, hidden) {
    var st = markerStyle(level, px / 2, hidden);
    return '<div style="margin:3px;width:' + px + 'px;height:' + px + 'px;box-sizing:border-box;' +
      'background:' + st.fillColor + ';opacity:' + st.fillOpacity + ';"></div>';
  }

  function makeDotIcon(level, px, hidden) {
    var hit = px + 6;
    return L.divIcon({
      className: '',
      iconSize: [hit, hit],
      iconAnchor: [Math.round(hit / 2), Math.round(hit / 2)],
      html: dotIconHtml(level, px, hidden)
    });
  }

  // Icon color is the station's ramp color (single source of truth), text is
  // the fine shindo label (5-/5+/6-/6+ included). Two-character labels get a
  // smaller font so they fit the square. Inline styles only — no CSS dependency.
  function shindoIconHtml(level, size, hidden) {
    var c = RAMP[level] || NO_DATA_COLOR;
    var label = levelToShindoFine(level);
    var fs = Math.round(size * (label.length > 1 ? 0.42 : 0.6));
    return '<div style="width:' + size + 'px;height:' + size + 'px;' +
      'background:' + c + ';border:2px solid #fff;box-sizing:border-box;' +
      'border-radius:3px;color:#fff;font-weight:bold;font-family:sans-serif;' +
      'font-size:' + fs + 'px;line-height:1;' +
      'display:flex;align-items:center;justify-content:center;' +
      (hidden ? 'opacity:0;' : '') + '">' + label + '</div>';
  }

  function makeShindoIcon(level, size, hidden) {
    return L.divIcon({
      className: '',
      iconSize: [size, size],
      iconAnchor: [Math.round(size / 2), Math.round(size / 2)],
      html: shindoIconHtml(level, size, hidden)
    });
  }

  function createMarker(st, kind, radius, size, hidden) {
    var m;
    if (kind === 'icon') {
      m = L.marker([st.lat, st.lng], {
        interactive: true, keyboard: false,
        icon: makeShindoIcon(st.level, size, hidden)
      });
    } else {
      // dot: square divIcon; radius -> pixel side (min 3 px to stay visible)
      var px = Math.max(3, Math.round(radius * 2));
      m = L.marker([st.lat, st.lng], {
        interactive: true, keyboard: false,
        icon: makeDotIcon(st.level, px, hidden)
      });
    }
    m.on('click', function() { openStationPopup(st); });
    return m;
  }

  // --- station detail popup (click any square) ---
  // Station index, coordinates, current fine shindo + realtime intensity and
  // a 30 s sparkline of recent levels. The Yahoo sitelist carries coordinates
  // only (no station codes), so the index is the identity we can show.
  function stationPopupHtml(st, idx) {
    var lv = st.level;
    var has = lv >= 0;
    var sh = has ? levelToShindoFine(lv) : '—';
    var rt = has ? (lv / 10).toFixed(1) : '—';
    var color = has ? RAMP[lv] : NO_DATA_COLOR;
    var hist = st.recentLevel || [];
    var n = Math.min(hist.length, 30);
    var spark = '';
    if (n > 1) {
      var pts = [];
      for (var i = 0; i < n; i++) {
        var v = hist[n - 1 - i]; // newest-first -> draw oldest-to-newest
        if (v < 0) v = 0;
        var x = 2 + (i / Math.max(n - 1, 1)) * 176;
        var y = 36 - (Math.min(v, 20) / 20) * 32;
        pts.push(x.toFixed(1) + ',' + y.toFixed(1));
      }
      spark = '<svg width="180" height="40" style="display:block;background:#f4f6f8;border:1px solid #ddd;border-radius:4px;margin-top:4px">' +
        '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#2e7fdb" stroke-width="1.5"/></svg>';
    }
    // sim-vs-obs comparison row (task G): only while a simulation with a
    // valid epicenter runs and Physics is available; hidden otherwise
    var sg = simRunGlobals();
    var simRow = sg ? simVsObsRow(predictStationShindo(st.lat, st.lng, sg.mw, sg.depth, sg.src), lv) : '';
    return '<div style="font:12px/1.5 sans-serif;min-width:180px">' +
      '<div style="font-weight:700">' + tt('realtime.kmoni.popup_station', '強震モニタ 観測点') + ' #' + (idx + 1) + '</div>' +
      '<div style="color:#666">' + st.lat.toFixed(3) + ', ' + st.lng.toFixed(3) + '</div>' +
      '<div style="margin:4px 0;display:flex;align-items:center;gap:6px">' +
        '<span style="display:inline-block;min-width:34px;text-align:center;padding:2px 4px;border-radius:3px;background:' + color + ';color:#fff;font-weight:700">' + sh + '</span>' +
        '<span>' + tt('realtime.kmoni.popup_rt', 'リアルタイム震度') + ' ' + rt + '</span></div>' +
      spark +
      (spark ? '<div style="color:#888;font-size:10px;margin-top:2px">' + tt('realtime.kmoni.popup_recent', '直近{n}秒').replace('{n}', n) + '</div>' : '') +
      simRow +
    '</div>';
  }

  // View state handed to stationPopupHtml on live refreshes: the station
  // mirror plus the shared sparkline ring (stationPopupHtml reads
  // st.recentLevel — tests pass their own history objects).
  function popupViewState(st) {
    return { lat: st.lat, lng: st.lng, level: st.level, recentLevel: popupRing };
  }

  function openStationPopup(st) {
    if (typeof L === 'undefined') return;
    var map = getMap();
    if (!map || !st) return;
    try {
      var idx = (typeof st._idx === 'number') ? st._idx : -1;
      // seed the sparkline with the latest level; the ring then grows one
      // entry per frame while the popup stays open
      var ring = st.level >= 0 ? [st.level] : [];
      var p = L.popup({ maxWidth: 220 })
        .setLatLng([st.lat, st.lng])
        .setContent(stationPopupHtml({ lat: st.lat, lng: st.lng, level: st.level, recentLevel: ring }, st._idx || 0))
        .openOn(map);
      // Assign AFTER openOn: opening auto-closes any previous popup, whose
      // 'remove' handler clears this shared state — it must not clobber ours.
      popupStationIdx = idx;
      popupRing = ring;
      popupRef = p;
      if (p && p.on) {
        p.on('remove', function() {
          if (popupRef === p) { popupRef = null; popupStationIdx = -1; popupRing = []; }
        });
      }
    } catch (e) {}
  }

  function ensureLayer() {
    if (layer || !stations.length) return;
    if (!hasL()) return;
    var map = getMap();
    if (!map) return;
    var scale = zoomScale();
    var zoom = currentZoom();
    var hnd = currentHideNoData();
    layer = L.layerGroup();
    markers = new Array(stations.length);
    for (var i = 0; i < stations.length; i++) {
      var st = stations[i];
      var kind = markerKindFor(zoom, st.level);
      var hidden = hnd && st.level < 0;
      var r = baseRadius(st.level) * scale;
      var size = (kind === 'icon') ? iconSizeForZoom(zoom) : 0;
      var m = createMarker(st, kind, r, size, hidden);
      m.addTo(layer);
      markers[i] = m;
      st._rl = st.level; st._rr = r; st._rs = size; st._rh = hidden; st._kind = kind;
    }
    layer.addTo(map);
    if (!zoomBound && map.on) {
      map.on('zoomend', onZoomEnd);
      zoomBound = true;
    }
  }

  function onZoomEnd() {
    if (!layer) return;
    for (var i = 0; i < stations.length; i++) {
      stations[i]._rr = -1; // force radius restyle
      stations[i]._rs = -1; // force icon resize / kind re-eval
    }
    restyleMarkers();
  }

  // Only touches markers whose kind, level, zoom-scaled size or hidden state
  // changed; swaps the layer instance when the marker kind flips (dot <->
  // icon), else setStyle/setIcon in place.
  function restyleMarkers() {
    if (!layer || !markers.length) return;
    var scale = zoomScale();
    var zoom = currentZoom();
    var hnd = currentHideNoData();
    for (var i = 0; i < stations.length; i++) {
      var st = stations[i];
      var kind = markerKindFor(zoom, st.level);
      var hidden = hnd && st.level < 0;
      var r = baseRadius(st.level) * scale;
      var size = (kind === 'icon') ? iconSizeForZoom(zoom) : 0;
      if (st._kind === kind && st._rl === st.level && st._rr === r &&
          st._rs === size && st._rh === hidden) continue;
      if (st._kind !== kind || !markers[i]) {
        var old = markers[i];
        var m = createMarker(st, kind, r, size, hidden);
        m.addTo(layer);
        if (old) { try { layer.removeLayer(old); } catch (e) {} }
        markers[i] = m;
      } else if (kind === 'icon') {
        markers[i].setIcon(makeShindoIcon(st.level, size, hidden));
      } else {
        // dot and icon are both L.marker now — square divIcon restyle
        markers[i].setIcon(makeDotIcon(st.level, Math.max(3, Math.round(r * 2)), hidden));
      }
      st._kind = kind; st._rl = st.level; st._rr = r; st._rs = size; st._rh = hidden;
    }
  }

  // ================================================================
  //  GRID OVERLAY (1°x1° cells over the active set, reused by key)
  // ================================================================

  function updateGridRects(activeIdx) {
    if (!layer || !hasL()) return;
    var cells = {};
    for (var i = 0; i < activeIdx.length; i++) {
      var st = stations[activeIdx[i]];
      var key = Math.round(st.lat) + '_' + Math.round(st.lng);
      if (st.level > (cells[key] === undefined ? -1 : cells[key])) cells[key] = st.level;
    }
    var key, entry;
    for (key in rects) {
      if (!(key in cells)) {
        layer.removeLayer(rects[key].rect);
        delete rects[key];
      }
    }
    for (key in cells) {
      var col = cells[key] <= 7 ? '#2ecc71' : (cells[key] <= 13 ? '#f1c40f' : '#e74c3c');
      entry = rects[key];
      if (entry) {
        if (entry.color !== col) {
          entry.color = col;
          entry.rect.setStyle({ color: col });
        }
        continue;
      }
      var parts = key.split('_');
      var la = Number(parts[0]), ln = Number(parts[1]);
      var rect = L.rectangle([[la - 0.5, ln - 0.5], [la + 0.5, ln + 0.5]], {
        color: col, weight: flashOn ? 2.5 : 1, opacity: flashOn ? 1 : 0.2,
        fill: col, fillOpacity: flashOn ? 0.12 : 0.03, interactive: false
      });
      rect.addTo(layer);
      rects[key] = { rect: rect, color: col };
    }
  }

  // 500 ms blink driver for detected cells — runs on its own timer so the
  // flash keeps pulsing during the 10.5 s activity hold even if a frame is late
  function blinkTick() {
    if (!active || !layer) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    flashOn = !flashOn;
    for (var key in rects) {
      rects[key].rect.setStyle({
        opacity: flashOn ? 1 : 0.2,
        weight: flashOn ? 2.5 : 1,
        fillOpacity: flashOn ? 0.12 : 0.03
      });
    }
  }

  // ================================================================
  //  FRAME PROCESSING (shared by SSE handler and fallback poller)
  //  Transport + mirror/render stay here; the heavy compute (decode,
  //  per-station time series, chain activation, period max, top-N) runs
  //  in the worker — or synchronously in the in-process engine when
  //  Worker is unavailable. Both backends run rt-kmoni-worker.js's engine.
  // ================================================================

  function processFrame(ev) {
    if (!ev || typeof ev.intensity !== 'string' || !stations.length) return;
    if (siteConfigId && ev.siteConfigId && ev.siteConfigId !== siteConfigId) {
      if (refetchId !== ev.siteConfigId) {
        refetchId = ev.siteConfigId;
        loadSitelist(); // once per mismatch episode
      }
      return;
    }
    // same length contract as the decoded levels array (charCodeAt per unit)
    if (ev.intensity.length !== stations.length) return;
    var now = Date.now();
    lastFrameAt = now;
    lastDataTime = ev.dataTime || null;

    if (ensureWorker()) {
      // async path: results land in onWorkerResult -> applyFrameResult
      try {
        worker.postMessage({ type: 'frame', now: now, intensity: ev.intensity,
          sensitivity: currentSensitivity() });
        return;
      } catch (e) { handleWorkerDead(); }
    }
    // in-process fallback path (node, legacy browsers, dead worker)
    var c = core();
    if (!c) return; // core script not landed yet — drop the frame, it heals
    if (!syncEngine) {
      syncEngine = c.createEngine();
      syncEngine.init(stationPositions(), currentSensitivity());
    }
    applyFrameResult(syncEngine.frame(now, ev.intensity, currentSensitivity()));
  }

  // One frame's computed state -> render mirror + side effects. Runs on the
  // main thread for both backends (worker message handler or direct call).
  function applyFrameResult(res) {
    if (!res || !res.ok) return;
    // stale result guard: stop() or a sitelist swap changed the table
    if (!stations.length || !res.levels || res.levels.length !== stations.length) return;
    var raw = res.raw, levels = res.levels;
    for (var i = 0; i < stations.length; i++) {
      stations[i].level = levels[i];
    }
    // sparkline history (raw, -1 kept) — only the open popup's station
    if (popupStationIdx >= 0 && popupStationIdx < raw.length) {
      popupRing.unshift(raw[popupStationIdx]);
      if (popupRing.length > 30) popupRing.pop();
    }
    var _prevActiveCount = lastActiveCount;
    lastActiveCount = res.activeCount;
    lastActiveLat = res.hotIdx >= 0 ? stations[res.hotIdx].lat : NaN;
    lastActiveLng = res.hotIdx >= 0 ? stations[res.hotIdx].lng : NaN;
    periodMax = res.periodMax;
    latestTop = res.top || [];

    if (res.notify > 0) feedback(res.notify);
    // quiet→active transition cue for sub-band-1 shaking (30 s cooldown)
    var _actName = activationSoundName(_prevActiveCount, res.activeCount, res.notify,
      lastActivationSoundAt, Date.now());
    if (_actName) {
      lastActivationSoundAt = Date.now();
      activationFeedback();
    }

    if (typeof document !== 'undefined' && document.hidden) return; // skip rendering
    ensureLayer();
    restyleMarkers();
    updateGridRects(res.active || []);
    // live-refresh the open station popup (level + sparkline) once per frame
    if (popupRef && popupStationIdx >= 0 && popupStationIdx < stations.length) {
      try {
        popupRef.setContent(stationPopupHtml(popupViewState(stations[popupStationIdx]), popupStationIdx));
      } catch (e) {}
    }
  }

  function onFrame(e) {
    if (fallbackActive) {
      // The Yahoo fallback is reversible: while polling, keep watching the
      // SSE stream — SSE_RESUME_FRAMES consecutive frames (no wide gap)
      // stop the polling and hand the frame flow back to SSE. Until then
      // the frames are only counted (polling keeps rendering), so a single
      // stray frame cannot flip-flop the transport.
      var rnow = Date.now();
      sseResumeStreak = sseResumeNext(sseResumeStreak, sseResumeLastAt, rnow);
      sseResumeLastAt = rnow;
      if (!sseShouldResume(sseResumeStreak)) return;
      stopFallback();
    }
    if (demoMode) {
      // RTDemo owns the display — live frames are not rendered, but they are
      // still watched: real shaking aborts the demo and shows immediately.
      var dmsg;
      try { dmsg = JSON.parse(e.data); } catch (ex) { return; }
      var dev = dmsg && dmsg.event ? dmsg.event : dmsg;
      if (evHasRealActivity(dev) && demoAbortHandler) {
        try { demoAbortHandler(); } catch (e2) {} // RTDemo.stop -> demoMode off
        processFrame(dev); // do not lose the real frame
      }
      return;
    }
    var msg;
    try { msg = JSON.parse(e.data); } catch (ex) { return; }
    processFrame(msg && msg.event ? msg.event : msg);
  }

  // Lightweight real-shaking check used while a demo suppresses the live
  // display: any station at shindo-2 band (level >= 11), or a network-wide
  // rise (>= 5 stations at shindo-1 band). Single-station level-8 blips occur
  // in the quiet feed and must not abort. Core implementation.
  function realActivityInLevels(levels) {
    var c = core();
    return c ? c.realActivityInLevels(levels) : false;
  }

  function evHasRealActivity(ev) {
    if (!ev || typeof ev.intensity !== 'string' || !stations.length) return false;
    var levels = decodeIntensity(ev.intensity);
    if (levels.length !== stations.length) return false;
    return realActivityInLevels(levels);
  }

  // Demo entry point: synthetic kmoni_rt-shaped frames from RTDemo take the
  // same processing path (detection, grid flash, toasts, focus) as live ones.
  function injectDemoFrame(ev) { processFrame(ev); }
  function setDemoMode(on) { demoMode = !!on; }
  function isDemoMode() { return demoMode; }
  // RTDemo registers its stop() here: real shaking during the demo aborts it
  function setDemoAbortHandler(fn) { demoAbortHandler = (typeof fn === 'function') ? fn : null; }

  // ================================================================
  //  FEEDBACK (toast + sound, never throws)
  // ================================================================

  // Toast display: the shared queued toaster from rt-data.js wins when it
  // is loaded (single visible toast, FIFO across the realtime modules);
  // the local implementation below stays as the standalone fallback (and
  // the only path when rt-data.js is absent — e.g. under node/tests).
  function toast(msg, opts) {
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.toastQueued === 'function') {
        RTData.toastQueued(msg, opts);
        return;
      }
    } catch (e) {}
    localToast(msg);
  }

  function localToast(msg) {
    if (typeof document === 'undefined' || !document.body) return;
    var el = document.getElementById('rt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rt-toast';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,0,0,.85);color:#fff;padding:10px 18px;border-radius:8px;z-index:10000;font-size:14px;max-width:360px;pointer-events:none;transition:opacity .5s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._timeout);
    el._timeout = setTimeout(function() { el.style.opacity = '0'; }, 4000);
  }

  function feedback(band) {
    var msg = '揺れ検出';
    try {
      if (typeof window !== 'undefined' && typeof window.t === 'function') {
        var tr = window.t('realtime.shake_detected');
        if (tr) msg = tr;
      }
    } catch (e) {}
    // toast + sounds belong to the live feed — server replay stays silent
    try {
      if (typeof RTData !== 'undefined' && RTData.isReplaying && RTData.isReplaying()) return;
    } catch (e) {}
    toast(msg + ' — Shindo ' + band);
    try {
      if (typeof window !== 'undefined' && typeof window.playEEWSound === 'function') {
        window.playEEWSound('Shindo' + Math.min(Math.max(band, 1), 7));
      }
    } catch (e) {}
  }

  // Slight-shaking detection cue (kanameishi/SREV parity): the band-cross
  // feedback above only fires once the period max reaches shindo band 1, so
  // micro-shaking below that used to stay completely silent. A quiet→active
  // chain-activation transition now plays the subtle Shindo0 cue instead.
  // Pure decision helper (exported for tests): null unless this frame is the
  // transition, the band-cross feedback isn't covering it, and the 30 s
  // cooldown has passed.
  var ACTIVATION_COOLDOWN_MS = 30000;
  var lastActivationSoundAt = 0;
  function activationSoundName(prevCount, nextCount, notifyBand, lastAt, now) {
    if (!(prevCount === 0 && nextCount > 0)) return null;
    if (notifyBand > 0) return null; // the louder band-cross cue owns this frame
    if (now - lastAt < ACTIVATION_COOLDOWN_MS) return null;
    return 'Shindo0';
  }

  function activationFeedback() {
    var msg = '揺れ検出';
    try {
      if (typeof window !== 'undefined' && typeof window.t === 'function') {
        var tr = window.t('realtime.shake_detected');
        if (tr) msg = tr;
      }
    } catch (e) {}
    try {
      if (typeof RTData !== 'undefined' && RTData.isReplaying && RTData.isReplaying()) return;
    } catch (e2) {}
    toast(msg);
    try {
      if (typeof window !== 'undefined' && typeof window.playEEWSound === 'function') {
        window.playEEWSound('Shindo0');
      }
    } catch (e) {}
  }

  // ================================================================
  //  SSE ATTACH & FALLBACK POLLING
  // ================================================================

  // Fallback -> SSE resume streak (pure, exported for tests): each SSE
  // frame increments the streak, but a frame arriving more than
  // SSE_RESUME_MAX_GAP_MS after the previous one restarts it at 1 — only a
  // genuinely live stream reaches SSE_RESUME_FRAMES.
  function sseResumeNext(streak, lastAt, now) {
    return (lastAt > 0 && now - lastAt <= SSE_RESUME_MAX_GAP_MS) ? streak + 1 : 1;
  }
  function sseShouldResume(streak) { return streak >= SSE_RESUME_FRAMES; }

  function attachSSE() {
    if (!active || source) return;
    var src = null;
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.getP2PSource === 'function') {
        src = RTData.getP2PSource();
      }
    } catch (e) {}
    if (!src) {
      sseRetryTimer = setTimeout(attachSSE, 2000); // retry until the shared source exists
      return;
    }
    source = src;
    source.addEventListener('kmoni_rt', onFrame);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // JST wall clock minus the adaptive delay -> {day: yyyymmdd, full: yyyymmddhhmmss}
  function jstStamps(delayMs) {
    var d = new Date(Date.now() - delayMs + 9 * 3600 * 1000);
    var day = '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
    var full = day + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
    return { day: day, full: full };
  }

  function startFallback() {
    if (fallbackActive || !active) return;
    fallbackActive = true;
    fallbackDelay = DELAY_MIN;
    sseResumeStreak = 0;  // the resume streak counts only this episode's SSE frames
    sseResumeLastAt = 0;
    pollFallback();
    fallbackTimer = setInterval(pollFallback, 1000);
  }

  // SSE recovered (SSE_RESUME_FRAMES consecutive frames): stop the Yahoo
  // polling. lastFrameAt is refreshed so the watchdog only re-arms the
  // fallback after another full silent window.
  function stopFallback() {
    if (!fallbackActive) return;
    fallbackActive = false;
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    sseResumeStreak = 0;
    sseResumeLastAt = 0;
    lastFrameAt = Date.now();
  }

  function pollFallback() {
    if (!active || !fallbackActive) return;
    var st = jstStamps(fallbackDelay);
    var url = RT_DIRECT + st.day + '/' + st.full + '.json';
    fetch(url).then(function(resp) {
      if (resp.status === 400 || resp.status === 404) {
        fallbackDelay = Math.min(DELAY_MAX, fallbackDelay + 100); // data not published yet
        return null;
      }
      if (!resp.ok) return null;
      return resp.json();
    }).then(function(json) {
      if (!json) return;
      fallbackDelay = Math.max(DELAY_MIN, fallbackDelay - 20);
      var ev = json.realTimeData || json;
      processFrame(ev);
    }).catch(function() {});
  }

  function tick() {
    if (!fallbackActive && stations.length && Date.now() - lastFrameAt > FALLBACK_AFTER_MS) {
      startFallback();
    }
    renderTopPanel(); // 1 Hz strongest-stations refresh while active
  }

  // ================================================================
  //  STRONGEST-STATIONS PANEL (sidebar, collapsible, rendered at 1 Hz)
  // ================================================================

  // One-shot wiring: header click collapses/expands; row clicks delegate to
  // a map.flyTo on the station. The container lives in index.html and is
  // never removed, so the listeners survive start/stop cycles.
  function wireTopPanel() {
    if (topWired) return;
    var box = domEl('rt-kmoni-top');
    if (!box) return;
    topWired = true;
    var head = domEl('rt-kmoni-top-head');
    if (head) head.addEventListener('click', function() {
      topCollapsed = !topCollapsed;
      renderTopPanel();
    });
    var list = domEl('rt-kmoni-top-list');
    if (list) list.addEventListener('click', function(ev) {
      var row = ev.target;
      while (row && row !== list && !(row.getAttribute && row.getAttribute('data-idx') != null)) row = row.parentNode;
      if (!row || row === list) return;
      var idx = parseInt(row.getAttribute('data-idx'), 10);
      var st = stations[idx];
      var map = getMap();
      if (!st || !map || !map.flyTo) return;
      try { map.flyTo([st.lat, st.lng], Math.max(currentZoom(), TOP_FLYTO_ZOOM)); } catch (e) {}
    });
  }

  // Panel visibility follows the module lifecycle: shown while start()ed
  // (even before the sitelist lands — quiet placeholder), hidden on stop()
  // and whenever realtime is off. Rows list the 8 highest-level stations
  // (from the latest frame's engine-computed top list); when the
  // network-wide max is below shindo 1 a quiet placeholder shows instead.
  function renderTopPanel() {
    var box = domEl('rt-kmoni-top');
    if (!box) return;
    if (!active) { box.style.display = 'none'; return; }
    if (typeof document !== 'undefined' && document.hidden) return;
    box.style.display = 'block';
    var title = domEl('rt-kmoni-top-title');
    if (title) title.textContent = tt('realtime.kmoni.top_title', '最も揺れている観測点');
    var caret = domEl('rt-kmoni-top-caret');
    if (caret) caret.textContent = topCollapsed ? '▸' : '▾';
    var list = domEl('rt-kmoni-top-list');
    if (!list) return;
    if (topCollapsed) { list.style.display = 'none'; return; }
    list.style.display = 'block';
    var top = latestTop; // last frame's engine-computed ranking
    if (!top.length || top[0].level < TOP_QUIET_LEVEL) {
      list.innerHTML = '<div class="rt-kmoni-top-quiet">' +
        tt('realtime.kmoni.top_quiet', '現在、顕著な揺れは観測されていません') + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < top.length; i++) {
      var e = top[i];
      html += '<div class="rt-kmoni-top-row" data-idx="' + e.idx + '" title="' +
        e.lat.toFixed(3) + ', ' + e.lng.toFixed(3) + '">' +
        '<span class="rt-kmoni-top-chip" style="background:' + RAMP[e.level] + '">' + levelToShindoFine(e.level) + '</span>' +
        '<span class="rt-kmoni-top-name">#' + (e.idx + 1) + '</span>' +
        '<span class="rt-kmoni-top-val">' + (e.level / 10).toFixed(1) + '</span></div>';
    }
    list.innerHTML = html;
  }

  // ================================================================
  //  SETTINGS (sensitivity + hide-no-data; DOM controls optional)
  // ================================================================

  function setSensitivity(v) {
    var s = String(v);
    if (s !== '1' && s !== '2' && s !== '3') return;
    sensMode = s;
    lsSet('qs-kmoni-sens', s);
    var el = domEl('rt-kmoni-sensitivity');
    if (el) el.value = s;
    // keep the engine's persisted mode in sync (frames also carry the live
    // value, so this only matters for a hypothetical frame that omits it)
    if (worker) { try { worker.postMessage({ type: 'config', sensitivity: s }); } catch (e) {} }
    if (syncEngine) { try { syncEngine.config({ sensitivity: s }); } catch (e) {} }
  }

  function setHideNoData(v) {
    hideNoDataState = !!v;
    lsSet('qs-kmoni-hnd', String(hideNoDataState));
    var el = domEl('rt-kmoni-hidenodata');
    if (el) el.checked = hideNoDataState;
    restyleMarkers(); // apply immediately when a layer is live (no-op otherwise)
  }

  function setShowShindo0(v) {
    showShindo0State = !!v;
    lsSet('qs-kmoni-shindo0', String(showShindo0State));
    var el = domEl('rt-kmoni-shindo0');
    if (el) el.checked = showShindo0State;
    restyleMarkers(); // kind flips dot <-> icon at levels 6-7
  }

  // On start: restore persisted settings into state and the DOM controls.
  function restoreSettings() {
    var s = lsGet('qs-kmoni-sens');
    if (s === '1' || s === '2' || s === '3') {
      sensMode = s;
      var el = domEl('rt-kmoni-sensitivity');
      if (el) el.value = s;
    }
    var h = lsGet('qs-kmoni-hnd');
    if (h === 'true' || h === 'false') {
      hideNoDataState = (h === 'true');
      var el2 = domEl('rt-kmoni-hidenodata');
      if (el2) el2.checked = hideNoDataState;
    }
    var z = lsGet('qs-kmoni-shindo0');
    if (z === 'true' || z === 'false') {
      showShindo0State = (z === 'true');
      var el3 = domEl('rt-kmoni-shindo0');
      if (el3) el3.checked = showShindo0State;
    }
    var oi = lsGet('qs-kmoni-official-img');
    if (oi === 'true' || oi === 'false') {
      officialImgState = (oi === 'true');
      var el4 = domEl('rt-kmoni-official-img');
      if (el4) el4.checked = officialImgState;
    }
  }

  // ================================================================
  //  PUBLIC API
  // ================================================================

  function start() {
    if (active) return false;
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return false; // node safety
    active = true;
    lastFrameAt = Date.now();
    workerFailed = false;   // allow a fresh worker attempt each session
    ensureWorker();
    restoreSettings();
    loadSitelist().then(function() {
      if (!active) return;
      attachSSE();
    });
    watchdog = setInterval(tick, 1000);
    if (!flashTimer) flashTimer = setInterval(blinkTick, 500);
    wireTopPanel();
    wireOfficialImgToggle();
    applyOfficialImg(); // re-arm the underlay when the toggle persisted on
    renderTopPanel(); // show immediately (quiet placeholder until data lands)
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    var topBox = domEl('rt-kmoni-top');
    if (topBox) topBox.style.display = 'none';
    if (source) {
      try { source.removeEventListener('kmoni_rt', onFrame); } catch (e) {}
      source = null;
    }
    if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    if (sitelistRetryTimer) { clearTimeout(sitelistRetryTimer); sitelistRetryTimer = null; }
    sitelistRetries = 0; // the next start() re-attempts with a fresh backoff ladder
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    flashOn = false;
    fallbackActive = false;
    fallbackDelay = DELAY_MIN;
    sseResumeStreak = 0;
    sseResumeLastAt = 0;
    demoMode = false; // a demo must never suppress the live feed after stop()
    demoAbortHandler = null;
    var map = getMap();
    if (map && zoomBound && map.off) {
      try { map.off('zoomend', onZoomEnd); } catch (e) {}
    }
    zoomBound = false;
    if (layer) { try { layer.remove(); } catch (e) {} layer = null; }
    removeOfficialImgOverlay();
    markers = [];
    rects = {};
    stations = [];
    siteConfigId = null;
    refetchId = null;
    popupStationIdx = -1; popupRing = []; popupRef = null;
    lastFrameAt = 0;
    lastDataTime = null;
    lastActiveCount = 0;
    lastActiveLat = NaN;
    lastActiveLng = NaN;
    periodMax = 0;
    latestTop = [];
    if (worker) {
      try { worker.postMessage({ type: 'reset' }); worker.terminate(); } catch (e) {}
      worker = null;
    }
    if (syncEngine) { try { syncEngine.reset(); } catch (e) {} syncEngine = null; }
  }

  function isActive() { return active; }

  function getState() {
    return {
      stationCount: stations.length,
      lastDataTime: lastDataTime,
      fallback: fallbackActive,
      periodMaxLevel: periodMax,
      activeCount: lastActiveCount,
      activeLat: lastActiveLat,
      activeLng: lastActiveLng,
      top: latestTop,
      sensitivity: currentSensitivity(),
      hideNoData: currentHideNoData(),
      showShindo0: currentShowShindo0(),
      officialImg: currentOfficialImg()
    };
  }

  return {
    start: start,
    stop: stop,
    isActive: isActive,
    getState: getState,
    setSensitivity: setSensitivity,
    setHideNoData: setHideNoData,
    setShowShindo0: setShowShindo0,
    setOfficialImg: setOfficialImg,
    // RTDemo injection (synthetic frames, live feed paused while on)
    setDemoMode: setDemoMode,
    injectDemoFrame: injectDemoFrame,
    isDemoMode: isDemoMode,
    setDemoAbortHandler: setDemoAbortHandler,
    realActivityInLevels: realActivityInLevels,
    // pure helpers (exported for tests)
    decodeIntensity: decodeIntensity,
    levelToShindo: levelToShindo,
    levelToShindoFine: levelToShindoFine,
    stationPopupHtml: stationPopupHtml,
    buildAdjacency: buildAdjacency,
    computeActivity: computeActivity,
    detectActive: detectActive,
    sensitivityThresholds: sensitivityThresholds,
    markerStyle: markerStyle,
    markerKindFor: markerKindFor,
    iconSizeForZoom: iconSizeForZoom,
    nextPeriodState: nextPeriodState,
    freshPeriod: freshPeriod,
    haversineKm: haversineKm,
    topStations: topStations,
    predictStationShindo: predictStationShindo,
    simVsObsRow: simVsObsRow,
    officialImgUrl: officialImgUrl,
    officialImgJstStrings: officialImgJstStrings,
    officialImgDirectUrl: officialImgDirectUrl,
    officialImgBounds: officialImgBounds,
    officialImgShouldDisable: officialImgShouldDisable,
    // slight-shaking activation cue (exported for tests)
    activationSoundName: activationSoundName,
    // transport resilience (exported for tests)
    sseResumeNext: sseResumeNext,
    sseShouldResume: sseShouldResume,
    sitelistRetryDelay: sitelistRetryDelay,
    toast: toast,
    KMONI_WORKER_V: KMONI_WORKER_V
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTKmoni;
