// =====================================================================
// RTWave — live multi-station seismogram panel (realtime monitoring suite)
//
// Four open GSN stations ringing Japan (IU MAJO/YSS/INCN/TATO, location 00,
// BHZ), streamed through the same-origin /api/waveform/live proxy (server
// decodes miniSEED STEIM1/2; EarthScope NGF open data, anonymous, verified
// 2026-09-03). Traces are RAW INSTRUMENT COUNTS — no calibration applied,
// never presented as intensity or physical units.
//
// While a real EEW event is tracked, predicted P/S arrival times are drawn
// on each trace (Physics travel-time model + great-circle distance).
//
// Module pattern: browser global `RTWave`; module.exports for node tests
// (no DOM/fetch required — start() is a safe no-op like rt-kmoni).
// =====================================================================
var RTWave = (function () {
  'use strict';

  // Frozen client mirror of the server whitelist (server re-validates — the
  // client list only decides what rows are rendered)
  var STATIONS = [
    { sta: 'MAJO', lat: 36.54567, lng: 138.20406, nameKey: 'realtime.wave.sta_majo' },
    { sta: 'YSS',  lat: 46.9587,  lng: 142.7604,  nameKey: 'realtime.wave.sta_yss' },
    { sta: 'INCN', lat: 37.47768, lng: 126.62436, nameKey: 'realtime.wave.sta_incn' },
    { sta: 'TATO', lat: 24.9735,  lng: 121.4971,  nameKey: 'realtime.wave.sta_tato' }
  ];
  var WINDOWS = [300, 600, 1200];
  var REFRESH_MS = 30000; // aligned with the server-side 30 s response cache
  var STORE_KEY = 'qs-live-wave';
  var ROW_W = 236, ROW_H = 54;

  var active = false;
  var timer = null;
  var fetching = false;
  var win = { windowSec: 600, collapsed: false };
  var rows = {}; // sta -> {canvas, ctx, statusEl, payload, lastOkMs}

  function tt(key, fallback) {
    if (typeof window !== 'undefined' && typeof window.t === 'function') {
      try {
        var v = window.t(key);
        if (v && v !== key) return v;
      } catch (e) {}
    }
    return fallback;
  }
  function dom(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
  function fmtTime(ms) {
    var d = new Date(ms);
    function p2(v) { return (v < 10 ? '0' : '') + v; }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  // ------------------------------------------------------------------
  //  PURE HELPERS (exported for node tests)
  // ------------------------------------------------------------------

  // Min/max envelope decimation of segments into fixed pixel buckets — the
  // standard loss-free way to render long traces on a narrow canvas.
  // Returns { buckets: [[min,max]|null, ...], coverage } or null when no data.
  function minMaxEnvelope(segments, t0Ms, t1Ms, bucketCount) {
    if (!Array.isArray(segments) || !segments.length || !(t1Ms > t0Ms) || !(bucketCount > 0)) return null;
    var buckets = new Array(bucketCount).fill(null);
    var span = t1Ms - t0Ms;
    var covered = 0;
    for (var si = 0; si < segments.length; si++) {
      var seg = segments[si];
      if (!seg || !seg.counts || !seg.counts.length || !(seg.sps > 0)) continue;
      var step = 1000 / seg.sps;
      for (var i = 0; i < seg.counts.length; i++) {
        var t = seg.startMs + i * step;
        if (t < t0Ms || t > t1Ms) continue;
        var b = Math.min(bucketCount - 1, Math.floor((t - t0Ms) / span * bucketCount));
        var v = seg.counts[i];
        if (!buckets[b]) { buckets[b] = [v, v]; covered++; }
        else {
          if (v < buckets[b][0]) buckets[b][0] = v;
          if (v > buckets[b][1]) buckets[b][1] = v;
        }
      }
    }
    if (!covered) return null;
    return { buckets: buckets, coverage: covered / bucketCount };
  }

  // Predicted P/S arrival ticks for one station from tracked EEW events.
  // events: [{originMs, lat, lng, depthKm, isCancel?}] — canceled events and
  // entries without a hypocenter are skipped. Returns [{ms, kind}] sorted.
  function eewTicks(events, station, t0Ms, t1Ms, physics) {
    var P = physics || (typeof Physics !== 'undefined' ? Physics : null);
    if (!Array.isArray(events) || !P || !P.pTravelTime || !P.sTravelTime || !P.haversineDist) return [];
    var out = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev || ev.isCancel || ev.originMs == null || ev.lat == null || ev.lng == null) continue;
      var distKm = P.haversineDist(ev.lat, ev.lng, station.lat, station.lng);
      var depth = (ev.depthKm != null && isFinite(ev.depthKm)) ? ev.depthKm : 10;
      var tp, ts;
      try { tp = P.pTravelTime(distKm, depth); ts = P.sTravelTime(distKm, depth); } catch (e) { continue; }
      if (!(tp > 0) || !(ts > 0)) continue;
      var pMs = ev.originMs + tp * 1000, sMs = ev.originMs + ts * 1000;
      if (pMs >= t0Ms && pMs <= t1Ms) out.push({ ms: pMs, kind: 'P' });
      if (sMs >= t0Ms && sMs <= t1Ms) out.push({ ms: sMs, kind: 'S' });
    }
    out.sort(function (a, b) { return a.ms - b.ms; });
    return out;
  }

  // End of the newest data segment vs wall clock — the panel's staleness cue
  function dataAgeMs(payload, nowMs) {
    if (!payload || !Array.isArray(payload.segments) || !payload.segments.length) return null;
    var end = payload.segments[payload.segments.length - 1].startMs +
      (payload.segments[payload.segments.length - 1].counts.length - 1) * 1000 / payload.segments[payload.segments.length - 1].sps;
    return nowMs - end;
  }

  // localStorage settings with hard clamps (bad/legacy values fall back)
  function parseSettings(raw) {
    var out = { windowSec: 600, collapsed: false };
    if (!raw) return out;
    var o = raw;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return out; } }
    if (o && typeof o === 'object') {
      if (o.windowSec === 300 || o.windowSec === 600 || o.windowSec === 1200) out.windowSec = o.windowSec;
      if (typeof o.collapsed === 'boolean') out.collapsed = o.collapsed;
    }
    return out;
  }
  function loadSettings() {
    var raw = null;
    try { raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(STORE_KEY) : null; } catch (e) {}
    win = parseSettings(raw);
  }
  function saveSettings() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(win)); } catch (e) {}
  }

  // ------------------------------------------------------------------
  //  DOM + RENDERING
  // ------------------------------------------------------------------
  function ensurePanel() {
    if (dom('rt-wave-box')) return true;
    var host = dom('realtime-bar');
    if (!host) return false;
    var box = document.createElement('div');
    box.id = 'rt-wave-box';
    box.className = 'rt-wave-box';
    box.style.display = 'none';
    box.innerHTML =
      '<div class="rt-wave-head" id="rt-wave-head">' +
        '<span class="rt-opt-label" id="rt-wave-title"></span>' +
        '<span class="rt-wave-controls">' +
          '<select id="rt-wave-window" class="rt-select" aria-label="window">' +
            '<option value="300"></option><option value="600"></option><option value="1200"></option>' +
          '</select>' +
          '<span class="rt-kmoni-top-caret" id="rt-wave-caret">▾</span>' +
        '</span>' +
      '</div>' +
      '<div id="rt-wave-rows" class="rt-wave-rows"></div>' +
      '<div class="rt-wave-note" id="rt-wave-note"></div>';
    host.appendChild(box);
    document.getElementById('rt-wave-title').textContent = tt('realtime.wave.title', 'ライブ波形（GSN）');
    document.getElementById('rt-wave-note').textContent = tt('realtime.wave.note', '計器生カウント（較正なし）・EarthScope NGF オープンデータ');
    var sel = document.getElementById('rt-wave-window');
    for (var i = 0; i < sel.options.length; i++) {
      var v = sel.options[i].value;
      sel.options[i].textContent = tt('realtime.wave.win_' + v, (v / 60) + 'min');
      if (parseInt(v, 10) === win.windowSec) sel.selectedIndex = i;
    }
    sel.addEventListener('change', function () {
      win.windowSec = parseInt(sel.value, 10) || 600;
      saveSettings();
      refresh(true);
    });
    document.getElementById('rt-wave-head').addEventListener('click', function (e) {
      if (e.target === sel) return;
      win.collapsed = !win.collapsed;
      saveSettings();
      applyCollapsed();
    });
    var rowsHost = document.getElementById('rt-wave-rows');
    for (var s = 0; s < STATIONS.length; s++) {
      rows[STATIONS[s].sta] = buildRow(rowsHost, STATIONS[s]);
    }
    applyCollapsed();
    return true;
  }

  function buildRow(host, meta) {
    var wrap = document.createElement('div');
    wrap.className = 'rt-wave-row';
    var label = document.createElement('div');
    label.className = 'rt-wave-label';
    label.textContent = tt(meta.nameKey, meta.sta);
    var canvas = document.createElement('canvas');
    canvas.className = 'rt-wave-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', meta.sta + ' BHZ');
    var status = document.createElement('div');
    status.className = 'rt-wave-status';
    status.textContent = tt('realtime.wave.loading', '…');
    wrap.appendChild(label);
    wrap.appendChild(canvas);
    wrap.appendChild(status);
    host.appendChild(wrap);
    return { canvas: canvas, ctx: canvas.getContext ? canvas.getContext('2d') : null, statusEl: status, payload: null, lastOkMs: 0, meta: meta };
  }

  function applyCollapsed() {
    var rowsEl = dom('rt-wave-rows'), caret = dom('rt-wave-caret'), note = dom('rt-wave-note');
    if (!rowsEl) return;
    rowsEl.style.display = win.collapsed ? 'none' : '';
    if (note) note.style.display = win.collapsed ? 'none' : '';
    if (caret) caret.textContent = win.collapsed ? '▸' : '▾';
  }

  function drawRow(row) {
    var canvas = row.canvas, ctx = row.ctx;
    if (!canvas || !ctx) return;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    var cssW = canvas.clientWidth || ROW_W, cssH = ROW_H;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    var nowMs = Date.now();
    var t1 = nowMs - 30000; // align with the server's telemetry latency margin
    var t0 = t1 - win.windowSec * 1000;
    var p = row.payload;
    var env = (p && !p.nodata) ? minMaxEnvelope(p.segments, t0, t1, Math.max(24, Math.floor(cssW / 2))) : null;
    var hasDark = false;
    try { hasDark = document.body.classList.contains('dark-mode'); } catch (e) {}
    var traceColor = hasDark ? '#7ec9ff' : '#1a5fa8';
    var gridColor = hasDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)';
    // zero line
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    if (!env) {
      row.statusEl.textContent = (p && p.nodata) ? tt('realtime.wave.nodata', 'データなし') : tt('realtime.wave.loading', '…');
      return;
    }
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < env.buckets.length; i++) {
      if (env.buckets[i]) {
        if (env.buckets[i][0] < lo) lo = env.buckets[i][0];
        if (env.buckets[i][1] > hi) hi = env.buckets[i][1];
      }
    }
    if (!(hi > lo)) { hi = lo + 1; }
    var pad = (hi - lo) * 0.12 + 1;
    lo -= pad; hi += pad;
    var y = function (v) { return H - (v - lo) / (hi - lo) * H; };
    ctx.strokeStyle = traceColor;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    var started = false;
    var bw = W / env.buckets.length;
    for (i = 0; i < env.buckets.length; i++) {
      var b = env.buckets[i];
      if (!b) { started = false; continue; }
      var x0 = i * bw, x1 = (i + 1) * bw;
      ctx.moveTo(x0 + bw * 0.5, y(b[1]));
      ctx.lineTo(x0 + bw * 0.5, y(b[0]));
      started = true;
    }
    if (started) ctx.stroke();
    // EEW P/S arrival ticks
    var events = (typeof RTEew !== 'undefined' && RTEew.getActiveEvents) ? RTEew.getActiveEvents() : [];
    var ticks = eewTicks(events, row.meta, t0, t1);
    for (i = 0; i < ticks.length; i++) {
      var x = (ticks[i].ms - t0) / (t1 - t0) * W;
      ctx.strokeStyle = ticks[i].kind === 'P' ? 'rgba(80,160,255,0.9)' : 'rgba(255,80,80,0.9)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ticks[i].kind === 'P' ? 'rgba(80,160,255,1)' : 'rgba(255,80,80,1)';
      ctx.font = Math.round(9 * dpr) + 'px sans-serif';
      ctx.fillText(ticks[i].kind, x + 2, 10 * dpr);
    }
    // status: updated time + optional age + gaps
    var bits = [];
    if (p && p.fetchedAt) bits.push(tt('realtime.wave.refreshed', '更新') + ' ' + fmtTime(nowMs));
    var age = dataAgeMs(p, nowMs);
    if (age != null && age > 120000) bits.push(tt('realtime.wave.stale', '遅延') + ' ' + Math.round(age / 1000) + 's');
    if (p && p.gaps > 0) bits.push(tt('realtime.wave.gaps', '欠測') + ' ' + p.gaps);
    row.statusEl.textContent = bits.join(' · ');
  }

  // ------------------------------------------------------------------
  //  FETCH LOOP
  // ------------------------------------------------------------------
  function fetchStation(meta) {
    return fetch('/api/waveform/live?sta=' + encodeURIComponent(meta.sta) + '&windowSec=' + win.windowSec, {
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) {
      var row = rows[meta.sta];
      if (row) { row.payload = j; row.lastOkMs = Date.now(); }
    }).catch(function () {
      // keep the previous payload; drawRow flags it stale by its timestamps
    });
  }

  function refresh(force) {
    if (!active || fetching) return;
    if (typeof document !== 'undefined' && document.hidden) return; // pause in background tabs
    fetching = true;
    var chain = Promise.resolve();
    STATIONS.forEach(function (meta) {
      chain = chain.then(function () {
        return fetchStation(meta);
      }).then(function () {
        var row = rows[meta.sta];
        if (row && (!win.collapsed || force)) drawRow(row);
      }).catch(function () {});
    });
    chain.then(function () { fetching = false; });
  }

  function onVisibility() {
    if (active && typeof document !== 'undefined' && !document.hidden) refresh();
  }

  // ------------------------------------------------------------------
  //  LIFECYCLE
  // ------------------------------------------------------------------
  function start() {
    if (typeof document === 'undefined' || typeof fetch !== 'function') return false;
    if (!ensurePanel()) return false;
    loadSettings();
    var sel = dom('rt-wave-window');
    if (sel) sel.value = String(win.windowSec);
    active = true;
    dom('rt-wave-box').style.display = '';
    refresh(true);
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return true;
  }

  function stop() {
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    var box = dom('rt-wave-box');
    if (box) box.style.display = 'none';
  }

  function isActive() { return active; }
  function getWindowSec() { return win.windowSec; }

  return {
    start: start,
    stop: stop,
    isActive: isActive,
    getWindowSec: getWindowSec,
    refresh: refresh,
    stations: function () { return STATIONS.slice(); },
    // pure helpers (exported for node tests)
    minMaxEnvelope: minMaxEnvelope,
    eewTicks: eewTicks,
    dataAgeMs: dataAgeMs,
    parseSettings: parseSettings
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTWave;
