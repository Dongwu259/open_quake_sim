// ================================================================
//  rt-quakeinfo.js — realtime JMA earthquake-information bulletins (P2P 551)
//  Announces 震度速報 / 震源情報 / 震源・震度情報 / 各地の震度 / 遠地地震 as
//  they arrive on the shared SSE bus: JP TTS (SREV speech FIFO) + toast +
//  shindo sound cue. Complements rt-eew (EEW) and rt-tsunami (552 display):
//  this module owns the post-quake JMA bulletin speech. DetailScale
//  bulletins additionally feed a collapsible 各地の震度 sidebar list
//  (15-min TTL, cleared on cancel), and max-shindo >= 4 bulletins raise a
//  system notification via RTData.notifySystem.
//  Silent during server replay (like the other realtime modules).
//  Load after: rt-data.js.  Browser global `RTQuakeInfo`; module.exports
//  for node tests (pure helpers only touch no DOM).
// ================================================================
var RTQuakeInfo = (function() {

  var EXPIRE_SEEN_MS = 3600000;  // id dedup memory horizon
  var CONTENT_SEEN_MS = 60000;   // content-key dedup window (P2P reconnect resends)
  var PANEL_ROW_CAP = 30;        // max rows in the DetailScale sidebar panel

  var active = false;
  var source = null;
  var attachTimer = null;
  var seen = {};                 // dedup key -> first-seen epoch ms
  var seenQueue = [];
  var seenContent = {};          // content dedup key -> first-seen epoch ms
  var seenContentQueue = [];

  // ================================================================
  //  PURE HELPERS (node-testable)
  // ================================================================

  // P2P integer scale -> JMA shindo string. 0/-1 = 不明 (scale not fixed yet)
  function scaleToShindo(scale) {
    switch (Number(scale)) {
      case 10: return '1';
      case 20: return '2';
      case 30: return '3';
      case 40: return '4';
      case 45: return '5-';
      case 50: return '5+';
      case 55: return '6-';
      case 60: return '6+';
      case 70: return '7';
      default: return '';
    }
  }

  // JP rendering for TTS: 5- -> 5弱, 5+ -> 5強, ...
  function shindoJp(sh) {
    return String(sh).replace('-', '弱').replace('+', '強');
  }

  // Coarse number for the sound cue (5-/5+ -> 5, 6-/6+ -> 6)
  function shindoCoarseNum(sh) {
    var m = String(sh).match(/^[0-7]/);
    return m ? Number(m[0]) : 0;
  }

  // Total-order shindo rank: coarse digit * 10 plus 5 for the '+' variants
  // ('5+' > '5-' > '4', '6+' < '7').
  function shindoRank(sh) {
    return shindoCoarseNum(sh) * 10 + (String(sh).slice(-1) === '+' ? 5 : 0);
  }

  // Per-prefecture max scale, sorted by scale desc. [{pref, shindo}]
  function prefMaxPoints(points, cap) {
    var byPref = {};
    var order = [];
    if (!Array.isArray(points)) return [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i] || {};
      var pref = p.pref || '';
      var sh = scaleToShindo(p.scale);
      if (!pref || !sh) continue;
      if (!(pref in byPref)) { byPref[pref] = sh; order.push(pref); }
      else if (shindoCoarseNum(sh) * 10 + (sh.slice(-1) === '+' ? 5 : 0) >
               shindoCoarseNum(byPref[pref]) * 10 + (byPref[pref].slice(-1) === '+' ? 5 : 0)) {
        byPref[pref] = sh;
      }
    }
    order.sort(function(a, b) {
      var ra = shindoCoarseNum(byPref[a]) * 10 + (byPref[a].slice(-1) === '+' ? 5 : 0);
      var rb = shindoCoarseNum(byPref[b]) * 10 + (byPref[b].slice(-1) === '+' ? 5 : 0);
      return rb - ra;
    });
    var out = [];
    for (var j = 0; j < order.length && out.length < (cap || 5); j++) {
      out.push({ pref: order[j], shindo: byPref[order[j]] });
    }
    return out;
  }

  // Coordinate passthrough for feed points: number or null.
  function coordOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // DetailScale observation rows for the sidebar 各地の震度 panel: area
  // entries only (isArea), per-area max shindo, sorted desc, capped.
  // [{pref, name, shindo, lat, lng}] — lat/lng null unless the feed carries
  // per-point coordinates (the normalized 551 shape usually does not).
  function detailScalePoints(evt, cap) {
    var out = [];
    if (!evt || evt.issueType !== 'DetailScale' || !Array.isArray(evt.points)) return out;
    var byArea = {};
    var order = [];
    for (var i = 0; i < evt.points.length; i++) {
      var p = evt.points[i] || {};
      if (p.isArea !== true) continue;
      var name = String(p.addr || '').trim();
      var sh = scaleToShindo(p.scale);
      if (!name || !sh) continue;
      var key = normAreaName(name);
      if (!(key in byArea)) {
        byArea[key] = { pref: p.pref || '', name: name, shindo: sh,
          lat: coordOrNull(p.lat), lng: coordOrNull(p.lng) };
        order.push(key);
      } else if (shindoRank(sh) > shindoRank(byArea[key].shindo)) {
        byArea[key].shindo = sh;
      }
    }
    order.sort(function(a, b) { return shindoRank(byArea[b].shindo) - shindoRank(byArea[a].shindo); });
    for (var j = 0; j < order.length && out.length < (cap || PANEL_ROW_CAP); j++) out.push(byArea[order[j]]);
    return out;
  }

  // 'HH:MM' for the panel header from a P2P bulletin timestamp; raw fallback.
  function bulletinTimeLabel(t) {
    var m = String(t || '').match(/(\d{1,2}:\d{2})/);
    return m ? m[1] : String(t || '');
  }

  function tsunamiJp(domesticTsunami) {
    switch (domesticTsunami) {
      case 'None': return '津波の心配はありません。';
      case 'NonEffective': return '若干の海面変動が予想されますが、津波被害の心配はありません。';
      case 'Checking': return '津波の有無について調査中です。';
      case 'Watch': return '津波注意報が発表されています。';
      case 'Warning': return '津波警報が発表されています。';
      default: return '';
    }
  }

  function depthJp(depth) {
    var d = Number(depth);
    if (!isFinite(d) || d < 0) return '深さ不明';
    if (d === 0) return '深さはごく浅い';
    return '深さ約' + Math.round(d) + 'キロメートル';
  }

  // Japanese TTS lines per bulletin type. Returns [] when nothing to say.
  // Brevity rules (2026-08-20 user feedback): prefecture names are capped at
  // 3 (+他N), and the combined 震源・震度 bulletin no longer repeats the
  // prefecture list / depth — those were already spoken by the ScalePrompt
  // and Destination bulletins of the same event minutes earlier.
  var TTS_PREF_CAP = 3;
  function buildTtsMessages(evt) {
    var maxSh = scaleToShindo(evt && evt.maxIntensity);
    var prefs = prefMaxPoints(evt && evt.points, 50);
    var ttsPrefs = prefs.slice(0, TTS_PREF_CAP);
    var topPrefs = ttsPrefs.map(function(p) { return p.pref; }).join('、') +
      (prefs.length > ttsPrefs.length ? ' 他' + (prefs.length - ttsPrefs.length) : '');
    switch (evt && evt.issueType) {
      case 'ScalePrompt': {
        if (!maxSh) return [];
        var where = topPrefs ? topPrefs + 'で' : '';
        return ['震度速報。' + where + '最大震度' + shindoJp(maxSh) + 'を観測しました。'];
      }
      case 'Destination': {
        if (!evt.place) return [];
        var m1 = '震源情報。震源地は、' + evt.place + '。';
        if (Number(evt.mag) > 0) m1 += 'マグニチュード' + Number(evt.mag).toFixed(1) + '、';
        m1 += depthJp(evt.depth) + '。';
        var ts1 = tsunamiJp(evt.domesticTsunami);
        return ts1 ? [m1, ts1] : [m1];
      }
      case 'ScaleAndDestination': {
        var m2 = '震源・震度情報。';
        if (maxSh) m2 += '最大震度' + shindoJp(maxSh) + 'を観測。';
        if (evt.place) {
          m2 += '震源地は、' + evt.place + '。';
          if (Number(evt.mag) > 0) m2 += 'マグニチュード' + Number(evt.mag).toFixed(1) + '。';
        }
        var ts2 = tsunamiJp(evt.domesticTsunami);
        return ts2 ? [m2, ts2] : [m2];
      }
      case 'DetailScale': {
        if (!maxSh) return [];
        return ['各地の震度情報が発表されました。最大震度は' + shindoJp(maxSh) + 'です。'];
      }
      case 'Foreign': {
        var m3 = '遠地地震の情報。';
        if (evt.place) m3 += evt.place + 'で';
        if (Number(evt.mag) > 0) m3 += 'マグニチュード' + Number(evt.mag).toFixed(1);
        m3 += 'の地震。';
        return [m3];
      }
      default:
        return [];
    }
  }

  // Dedup key: content-addressed so a P2P reconnect resend never re-announces.
  function dedupKey(evt) {
    return [evt.issueType || '', evt.originTime || '', evt.place || '',
      evt.maxIntensity || 0, evt.serial || 1].join('|');
  }

  // Observed-shindo fill map from a 551 bulletin:
  // scope 'pref' (ScalePrompt / ScaleAndDestination — points keyed by
  // prefecture) or 'area' (DetailScale — isArea entries keyed by the JMA
  // 細分区域 name in addr). Values are shindo strings ('4', '5-', ...).
  function observedFills(evt, scope) {
    var out = {};
    if (!evt || !Array.isArray(evt.points)) return out;
    for (var i = 0; i < evt.points.length; i++) {
      var p = evt.points[i] || {};
      var sh = scaleToShindo(p.scale);
      if (!sh) continue;
      if (scope === 'area') {
        if (p.isArea !== true) continue;
        var an = normAreaName(p.addr);
        if (!an) continue;
        if (!(an in out) || shindoCoarseNum(sh) * 10 + (sh.slice(-1) === '+' ? 5 : 0) >
            shindoCoarseNum(out[an]) * 10 + (out[an].slice(-1) === '+' ? 5 : 0)) out[an] = sh;
      } else {
        var pn = (p.pref || '').trim();
        if (!pn) continue;
        if (!(pn in out) || shindoCoarseNum(sh) * 10 + (sh.slice(-1) === '+' ? 5 : 0) >
            shindoCoarseNum(out[pn]) * 10 + (out[pn].slice(-1) === '+' ? 5 : 0)) out[pn] = sh;
      }
    }
    return out;
  }

  // Whitespace/variant normalization so P2P area names match the JMA
  // subdivision geometry properties
  function normAreaName(s) {
    return String(s || '').replace(/[\s　]+/g, '');
  }

  // Scope a bulletin belongs to for map coloring ('pref' | 'area' | null)
  function fillScope(evt) {
    if (!evt) return null;
    if (evt.issueType === 'ScalePrompt' || evt.issueType === 'ScaleAndDestination') return 'pref';
    if (evt.issueType === 'DetailScale') return 'area';
    return null;
  }

  // Long-period ground motion class (長周期地震動階級 1-4) from a 551 bulletin
  // when the feed carries it: intensityDetail.maxLgInt / .lgInt / .maxLgScale,
  // or a per-point lgScale/lgInt. null when absent (the common case — neither
  // Wolfx nor P2P forwards VXSE62, so this activates only on LPCM-bearing
  // payloads).
  function lpcmClass(evt) {
    if (!evt) return null;
    function norm(v) {
      if (v === undefined || v === null || v === '') return 0;
      var n = Number(v);
      if (isFinite(n) && n >= 1) return Math.min(4, Math.round(n));
      var m = String(v).match(/[1-4]/);
      return m ? Number(m[0]) : 0;
    }
    var d = evt.intensityDetail;
    if (d && typeof d === 'object') {
      var top = norm(d.maxLgInt !== undefined ? d.maxLgInt : (d.lgInt !== undefined ? d.lgInt : d.maxLgScale));
      if (top >= 1) return top;
    }
    if (Array.isArray(evt.points)) {
      var best = 0;
      for (var i = 0; i < evt.points.length; i++) {
        var p = evt.points[i];
        if (!p) continue;
        var pv = norm(p.lgScale !== undefined ? p.lgScale : p.lgInt);
        if (pv > best) best = pv;
      }
      if (best >= 1) return best;
    }
    return null;
  }

  // ================================================================
  //  BROWSER RUNTIME (lazy DOM; never touched from node)
  // ================================================================

  function isReplayingFeed() {
    return typeof RTData !== 'undefined' && typeof RTData.isReplaying === 'function' && RTData.isReplaying();
  }

  function speak(messages) {
    if (typeof window === 'undefined' || typeof window._enqueueSrevSpeech !== 'function') return;
    if (!messages || !messages.length) return;
    if (isReplayingFeed()) return;
    try { window._enqueueSrevSpeech(messages, { id: 'rt-quakeinfo', replace: true }); } catch (e) {}
  }

  // Thin wrapper over the shared RTData toast queue; falls back to a local
  // fixed toast so the module also works standalone (and in node tests).
  function toast(msg) {
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.toastQueued === 'function') {
        RTData.toastQueued(msg);
        return;
      }
    } catch (e) {}
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

  // Trilingual UI text: window.t(key) wins when present and not echoing the
  // key back; otherwise pick by qs-lang (ja default). Same contract as the
  // rt-tsunami tr() shim, extended with an English string.
  function tr(key, ja, en, zh) {
    try {
      if (typeof window !== 'undefined' && typeof window.t === 'function') {
        var v = window.t(key);
        if (typeof v === 'string' && v && v !== key) return v;
      }
    } catch (e) {}
    var lang = '';
    try {
      if (typeof localStorage !== 'undefined') lang = localStorage.getItem('qs-lang') || '';
    } catch (e) {}
    return lang === 'zh' ? zh : (lang === 'en' ? en : ja);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // System notification for strong bulletins (max shindo >= 4), routed
  // through RTData.notifySystem when available. Muted during server replay.
  function notify551(evt, maxSh, prefs) {
    if (!maxSh || shindoCoarseNum(maxSh) < 4) return;
    if (isReplayingFeed()) return;
    if (typeof RTData === 'undefined' || !RTData || typeof RTData.notifySystem !== 'function') return;
    var where = prefs && prefs.length ? prefs.map(function(p) { return p.pref; }).join('・') : (evt.place || '');
    var body = tr('realtime.quakeinfo.maxshindo', '最大震度', 'Max shindo ', '最大震度') + maxSh + (where ? ' ' + where : '');
    try { RTData.notifySystem(tr('realtime.quakeinfo.notify_title', '地震情報', 'Earthquake info', '地震信息'), body, 'rt-quakeinfo-551-' + (evt.id || '')); } catch (e) {}
  }

  function playShindoSound(shindo) {
    if (isReplayingFeed()) return;
    var n = shindoCoarseNum(shindo);
    if (n < 1) return;
    try {
      if (typeof window !== 'undefined' && typeof window.playEEWSound === 'function') {
        window.playEEWSound('Shindo' + n);
      }
    } catch (e) {}
  }

  function markSeen(key) {
    var now = Date.now();
    while (seenQueue.length && now - seen[seenQueue[0]] > EXPIRE_SEEN_MS) {
      delete seen[seenQueue.shift()];
    }
    if (seen[key]) return false;
    seen[key] = now;
    seenQueue.push(key);
    return true;
  }

  // Content-key dedup with a short window: a P2P reconnect resends the last
  // bulletin immediately, but a genuinely new bulletin (new id) carrying the
  // same content is a legitimate revision once the window has passed.
  function markSeenContent(key) {
    var now = Date.now();
    while (seenContentQueue.length && now - seenContent[seenContentQueue[0]] > CONTENT_SEEN_MS) {
      delete seenContent[seenContentQueue.shift()];
    }
    if (seenContent[key]) return false;
    seenContent[key] = now;
    seenContentQueue.push(key);
    return true;
  }

  // ================================================================
  //  OBSERVED-SHINDO MAP COLORING (551 fills)
  //  ScalePrompt / ScaleAndDestination color prefectures; DetailScale colors
  //  JMA 細分区域. A newer bulletin scope supersedes the other; colors age
  //  out after 15 min without a new bulletin.
  // ================================================================
  var OBS_FILL = {
    '1': '#a0d2f0', '2': '#6cb4ee', '3': '#2ecc71', '4': '#f1c40f',
    '5-': '#e67e22', '5+': '#e74c3c', '6-': '#c0392b', '6+': '#8e44ad', '7': '#6c0f1f'
  };
  var OBS_TTL_MS = 15 * 60000;
  var prefObs = { layer: null, loading: false, failedAt: 0, fills: {}, geo: null, prop: 'nam_ja', url: '/geojson/japan_prefectures.geojson' };
  var areaObs = { layer: null, loading: false, failedAt: 0, fills: {}, geo: null, prop: 'name', url: '/geojson/jma_subareas.json' };
  var obsClearTimer = null;

  function obsFill(sh) {
    try {
      if (typeof SHINDO_FILL !== 'undefined' && SHINDO_FILL[sh]) return SHINDO_FILL[sh];
    } catch (e) {}
    return OBS_FILL[sh] || '#888';
  }

  function getMap() {
    return (typeof window !== 'undefined' && window.map) ? window.map : null;
  }

  function obsStyleFn(slot) {
    return function(feature) {
      var nm = normAreaName(feature && feature.properties ? feature.properties[slot.prop] : '');
      var sh = slot.fills[nm];
      if (sh) {
        return { color: '#fff', weight: 0.8, opacity: 0.9,
          fill: true, fillColor: obsFill(sh), fillOpacity: 0.5 };
      }
      return { color: '#999', weight: 0.5, opacity: 0.35, fill: false };
    };
  }

  function restyleObs(slot) {
    if (!slot.layer) return;
    var fn = obsStyleFn(slot);
    slot.layer.eachLayer(function(ly) {
      try { ly.setStyle(fn(ly.feature)); } catch (e) {}
    });
  }

  function ensureObsLayer(slot) {
    if (slot.layer || slot.loading) return;
    var map = getMap();
    if (!map || typeof L === 'undefined' || typeof fetch !== 'function') return;
    var now = Date.now();
    if (slot.failedAt && now - slot.failedAt < 60000) return; // 1 min retry backoff
    slot.loading = true;
    fetch(slot.url).then(function(res) {
      if (!res || !res.ok) throw new Error('geojson http ' + (res && res.status));
      return res.json();
    }).then(function(geo) {
      slot.loading = false;
      if (!active) return;
      if (!geo || !geo.features || !geo.features.length) return;
      slot.geo = geo; // raw features double as the panel flyTo centroid lookup
      slot.layer = L.geoJSON(geo, {
        style: obsStyleFn(slot),
        interactive: false
      });
      slot.layer.addTo(map);
      restyleObs(slot);
    }).catch(function() { slot.loading = false; slot.failedAt = Date.now(); });
  }

  function clearObserved() {
    prefObs.fills = {};
    areaObs.fills = {};
    restyleObs(prefObs);
    restyleObs(areaObs);
  }

  function applyObserved(evt) {
    var scope = fillScope(evt);
    if (!scope) return;
    if (typeof L === 'undefined' || !getMap()) return;
    var fills = observedFills(evt, scope);
    var has = false;
    for (var k in fills) { has = true; break; }
    if (!has) return;
    var slot = (scope === 'pref') ? prefObs : areaObs;
    var other = (scope === 'pref') ? areaObs : prefObs;
    slot.fills = fills;
    other.fills = {}; // newer bulletin scope supersedes the coarser one
    ensureObsLayer(slot);
    restyleObs(slot);
    restyleObs(other);
    if (obsClearTimer) clearTimeout(obsClearTimer);
    obsClearTimer = setTimeout(clearObserved, OBS_TTL_MS);
  }

  function removeObsLayer(slot) {
    if (slot.layer) {
      try { slot.layer.remove(); } catch (e) {}
      slot.layer = null;
    }
    slot.fills = {};
  }

  // ================================================================
  //  各地の震度 PANEL (DetailScale sidebar list, collapsible)
  //  The whole panel is built from JS (scoped <style> + DOM appended into
  //  the realtime sidebar) so index.html / style.css stay untouched. The
  //  previous bulletin stays visible until a newer DetailScale replaces it;
  //  after the same 15-min TTL as the map fills it falls back to a quiet
  //  placeholder. Cancel clears it. Rows fly to the area on click — point
  //  coordinates when the bulletin carries them, else the subdivision
  //  geometry center already loaded for the map fills.
  // ================================================================
  var panelCollapsed = false;
  var panelBulletin = null;  // {timeLabel, maxSh, rows:[{pref,name,shindo,lat,lng}]}
  var panelClearTimer = null;

  var PANEL_CSS =
    '#rt-qinfo-panel{margin-top:4px;padding:6px;background:var(--input-bg);border-radius:6px}' +
    '.rt-qinfo-head{cursor:pointer;user-select:none;justify-content:space-between;flex-wrap:nowrap}' +
    '.rt-qinfo-caret{font-size:10px;color:var(--text-secondary);flex:0 0 auto}' +
    '.rt-qinfo-meta{font-size:11px;color:var(--text-secondary);padding:0 4px 2px}' +
    '#rt-qinfo-list{margin-top:4px;max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}' +
    '.rt-qinfo-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text);padding:2px 4px;border-radius:4px;cursor:pointer;transition:background .15s}' +
    '.rt-qinfo-row:hover{background:rgba(233,69,96,.1)}' +
    '.rt-qinfo-chip{flex:0 0 auto;min-width:26px;text-align:center;padding:1px 3px;border-radius:3px;font-weight:700;font-size:10px}' +
    '.rt-qinfo-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.rt-qinfo-quiet{font-size:11px;color:var(--text-secondary);padding:2px 4px}' +
    '@media (max-width:768px){#rt-qinfo-list{max-height:150px}}';

  function chipTextColor(sh) {
    return shindoCoarseNum(sh) >= 5 ? '#fff' : '#1a2634';
  }

  // Create + wire the panel once (header collapse, row-click flyTo). The
  // container is never removed afterwards, so the listeners survive
  // start/stop cycles.
  function ensurePanel() {
    if (typeof document === 'undefined' || !document.body || !document.createElement) return null;
    var box = document.getElementById('rt-qinfo-panel');
    if (box) return box;
    var host = document.getElementById('realtime-bar');
    if (!host) return null;
    if (!document.getElementById('rt-qinfo-style')) {
      var st = document.createElement('style');
      st.id = 'rt-qinfo-style';
      st.textContent = PANEL_CSS;
      (document.head || document.body).appendChild(st);
    }
    box = document.createElement('div');
    box.id = 'rt-qinfo-panel';
    box.style.display = 'none';
    box.innerHTML =
      '<div class="rt-opt-row rt-qinfo-head" id="rt-qinfo-head">' +
      '<span class="rt-opt-label" id="rt-qinfo-title"></span>' +
      '<span class="rt-qinfo-caret" id="rt-qinfo-caret">▾</span></div>' +
      '<div class="rt-qinfo-meta" id="rt-qinfo-meta" style="display:none"></div>' +
      '<div id="rt-qinfo-list"></div>';
    host.appendChild(box);
    var head = document.getElementById('rt-qinfo-head');
    if (head) head.addEventListener('click', function() {
      panelCollapsed = !panelCollapsed;
      renderDetailPanel();
    });
    var list = document.getElementById('rt-qinfo-list');
    if (list) list.addEventListener('click', function(ev) {
      var row = ev.target;
      while (row && row !== list && !(row.getAttribute && row.getAttribute('data-idx') != null)) row = row.parentNode;
      if (!row || row === list) return;
      flyToPanelRow(parseInt(row.getAttribute('data-idx'), 10));
    });
    return box;
  }

  function renderDetailPanel() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var box = document.getElementById('rt-qinfo-panel');
    if (!box) return;
    if (!active) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    var title = document.getElementById('rt-qinfo-title');
    if (title) title.textContent = tr('realtime.quakeinfo.panel_title', '各地の震度', 'Area shindo', '各地震度');
    var caret = document.getElementById('rt-qinfo-caret');
    if (caret) caret.textContent = panelCollapsed ? '▸' : '▾';
    var b = panelBulletin;
    var meta = document.getElementById('rt-qinfo-meta');
    if (meta) {
      meta.style.display = b ? 'block' : 'none';
      if (b) meta.textContent = (b.timeLabel ? b.timeLabel + '　' : '') +
        tr('realtime.quakeinfo.maxshindo', '最大震度', 'Max shindo ', '最大震度') + b.maxSh;
    }
    var list = document.getElementById('rt-qinfo-list');
    if (!list) return;
    if (panelCollapsed) { list.style.display = 'none'; return; }
    list.style.display = 'block';
    if (!b || !b.rows.length) {
      list.innerHTML = '<div class="rt-qinfo-quiet">' +
        esc(tr('realtime.quakeinfo.panel_quiet', '各地の震度情報はまだありません', 'No area-intensity bulletin yet', '暂无各地震度信息')) + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < b.rows.length; i++) {
      var r = b.rows[i];
      html += '<div class="rt-qinfo-row" data-idx="' + i + '">' +
        '<span class="rt-qinfo-chip" style="background:' + obsFill(r.shindo) + ';color:' + chipTextColor(r.shindo) + '">' + esc(r.shindo) + '</span>' +
        '<span class="rt-qinfo-name">' + esc(r.name) + '</span></div>';
    }
    list.innerHTML = html;
  }

  function updateDetailPanel(evt) {
    if (!active || typeof document === 'undefined') return;
    var rows = detailScalePoints(evt, PANEL_ROW_CAP);
    panelBulletin = {
      timeLabel: bulletinTimeLabel(evt.time),
      maxSh: scaleToShindo(evt.maxIntensity) || (rows.length ? rows[0].shindo : ''),
      rows: rows
    };
    if (panelClearTimer) clearTimeout(panelClearTimer);
    panelClearTimer = setTimeout(function() {
      panelBulletin = null;
      renderDetailPanel(); // TTL expired -> quiet placeholder
    }, OBS_TTL_MS);
    if (!ensurePanel()) return;
    renderDetailPanel();
  }

  function clearDetailPanel() {
    panelBulletin = null;
    if (panelClearTimer) { clearTimeout(panelClearTimer); panelClearTimer = null; }
    renderDetailPanel();
  }

  // Bounding-box center of a geojson geometry (subdivisions are small, so a
  // centroid refinement is unnecessary for a flyTo target).
  function featureCenter(f) {
    var g = f && f.geometry;
    if (!g || !g.coordinates) return null;
    var minLa = 90, maxLa = -90, minLn = 180, maxLn = -180, n = 0;
    (function walk(c) {
      if (typeof c[0] === 'number') {
        if (c[1] < minLa) minLa = c[1];
        if (c[1] > maxLa) maxLa = c[1];
        if (c[0] < minLn) minLn = c[0];
        if (c[0] > maxLn) maxLn = c[0];
        n++;
        return;
      }
      for (var i = 0; i < c.length; i++) walk(c[i]);
    })(g.coordinates);
    return n ? [(minLa + maxLa) / 2, (minLn + maxLn) / 2] : null;
  }

  function areaCenterByName(name) {
    var geo = areaObs.geo;
    if (!geo || !geo.features) return null;
    var key = normAreaName(name);
    for (var i = 0; i < geo.features.length; i++) {
      var f = geo.features[i];
      if (normAreaName(f && f.properties ? f.properties[areaObs.prop] : '') === key) {
        return featureCenter(f);
      }
    }
    return null;
  }

  function flyToPanelRow(idx) {
    var b = panelBulletin;
    var r = b && b.rows[idx];
    var map = getMap();
    if (!r || !map || !map.flyTo) return;
    var c = (typeof r.lat === 'number' && typeof r.lng === 'number' && isFinite(r.lat) && isFinite(r.lng))
      ? [r.lat, r.lng] : areaCenterByName(r.name);
    if (!c) return;
    try { map.flyTo(c, Math.max(map.getZoom ? map.getZoom() : 8, 8)); } catch (e) {}
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

  function bulletinTitle(issueType) {
    var key = 'realtime.quakeinfo.' + (issueType || 'other');
    var fallback = {
      ScalePrompt: '震度速報', Destination: '震源情報',
      ScaleAndDestination: '震源・震度情報', DetailScale: '各地の震度情報',
      Foreign: '遠地地震情報'
    }[issueType] || '地震情報';
    return tt(key, fallback);
  }

  function handle551(evt) {
    if (evt.cancelled) {
      toast(bulletinTitle(evt.issueType) + ' — ' + (typeof window !== 'undefined' && window.t ? window.t('realtime.eew_cancel') : '取消'));
      clearObserved();
      clearDetailPanel();
      return true;
    }
    var key = evt.id ? String(evt.id) : dedupKey(evt);
    // P2P resends the last message on reconnect — the id covers that for an
    // hour; the content key only dedups immediate re-deliveries, so a later
    // bulletin (new id) with identical content still announces as a revision
    if (!markSeen(key)) return false;
    if (!markSeenContent(dedupKey(evt))) return false;

    var msgs = buildTtsMessages(evt);
    var maxSh = scaleToShindo(evt.maxIntensity);
    var prefs = prefMaxPoints(evt.points, 3);
    var summary = bulletinTitle(evt.issueType);
    if (maxSh) summary += '　' + tt('realtime.quakeinfo.maxshindo', '最大震度') + maxSh;
    if (prefs.length) summary += '（' + prefs.map(function(p) { return p.pref; }).join('・') + '）';
    else if (evt.place) summary += '　' + evt.place + (Number(evt.mag) > 0 ? ' M' + Number(evt.mag).toFixed(1) : '');
    var lpcm = lpcmClass(evt);
    if (lpcm) {
      summary += '　' + tt('realtime.quakeinfo.lpcm', '長周期階級') + lpcm;
      msgs = msgs.concat(['長周期地震動階級' + lpcm + 'を観測しました。']);
    }
    toast('📢 ' + summary);
    notify551(evt, maxSh, prefs); // system notification at max shindo >= 4

    if (evt.issueType === 'ScalePrompt' && maxSh) playShindoSound(maxSh);
    speak(msgs);
    applyObserved(evt); // prefecture / subdivision shindo fills
    if (evt.issueType === 'DetailScale') updateDetailPanel(evt); // sidebar area list
    return true;
  }

  function handleEvent(evt) {
    if (!evt || typeof evt !== 'object') return false;
    // tolerate the SSE wrapper ({type:'p2pquake', event:<normalized>}) too
    if (evt.code === undefined && evt.event && typeof evt.event === 'object') evt = evt.event;
    if (Number(evt.code) !== 551) return false;
    return handle551(evt);
  }

  function onP2P(e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (ex) { return; }
    if (!msg) return;
    try { handleEvent(msg); } catch (ex) {
      if (typeof console !== 'undefined') console.warn('RTQuakeInfo onP2P:', ex);
    }
  }

  function attach() {
    if (!active || source) return;
    var src = null;
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.getP2PSource === 'function') {
        src = RTData.getP2PSource();
      }
    } catch (e) {}
    if (!src) { attachTimer = setTimeout(attach, 2000); return; }
    source = src;
    try { source.addEventListener('p2pquake', onP2P); } catch (e) { source = null; }
  }

  function start() {
    if (active) return false;
    active = true;
    attach();
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    if (attachTimer) { clearTimeout(attachTimer); attachTimer = null; }
    if (source) {
      try { source.removeEventListener('p2pquake', onP2P); } catch (e) {}
      source = null;
    }
    if (obsClearTimer) { clearTimeout(obsClearTimer); obsClearTimer = null; }
    removeObsLayer(prefObs);
    removeObsLayer(areaObs);
    panelBulletin = null;
    if (panelClearTimer) { clearTimeout(panelClearTimer); panelClearTimer = null; }
    if (typeof document !== 'undefined' && document.getElementById) {
      var box = document.getElementById('rt-qinfo-panel');
      if (box) box.style.display = 'none';
    }
  }

  return {
    start: start,
    stop: stop,
    isActive: function() { return active; },
    handleEvent: handleEvent,
    clearObserved: clearObserved,
    // pure helpers (exported for node tests)
    scaleToShindo: scaleToShindo,
    shindoJp: shindoJp,
    shindoCoarseNum: shindoCoarseNum,
    prefMaxPoints: prefMaxPoints,
    tsunamiJp: tsunamiJp,
    depthJp: depthJp,
    buildTtsMessages: buildTtsMessages,
    dedupKey: dedupKey,
    observedFills: observedFills,
    fillScope: fillScope,
    lpcmClass: lpcmClass,
    normAreaName: normAreaName,
    detailScalePoints: detailScalePoints
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTQuakeInfo;
