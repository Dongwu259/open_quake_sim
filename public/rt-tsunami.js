// ================================================================
//  Earthquake Simulator Pro v5.2 — JMA tsunami-information layer
//  Realtime 津波予報/注意報/警報/大津波警報 display driven by the
//  shared P2PQuake SSE feed (named event "p2pquake", code 552) with
//  JMA forecast-area coastline coloring (Warning/MajorWarning segments
//  blink) with a per-area first-wave ETA table, plus code-551
//  震源・震度情報 per-prefecture detail popups.
//  Load after: rt-data.js   (shares its EventSource via RTData.getP2PSource)
//  Load before: app.js
// ================================================================
var RTTsunami = (function() {
  // --- constants ---
  var GEOJSON_URL = '/geojson/jma_tsunami_forecast_areas.json';

  var GRADE_COLORS = { Watch: '#f1c40f', Warning: '#e74c3c', MajorWarning: '#8b0000' };
  var GRADE_SOUND = { Watch: 'Tsunami_1', Warning: 'Tsunami_2', MajorWarning: 'Tsunami_3' };
  var GRADE_ORDER = ['MajorWarning', 'Warning', 'Watch'];
  var BASE_STYLE = { color: '#888', weight: 0.5, opacity: 0.15 };

  var ATTACH_RETRY_MS = 2000;   // SSE attach retry / RTData liveness poll
  var DETAIL_HIDE_MS = 30000;   // 551 detail popup auto-hide
  var DEMO_CANCEL_MS = 15000;   // demo() schedules a cancel this much later
  var MAX_ROWS = 12;            // panel area-row cap before 他N
  var MAX_ETA_ROWS = 8;         // forecast-table row cap before 他N
  var MAX_DETAIL_PREFS = 8;     // 551 popup prefecture cap before 他N
  var MAX_SEEN_551 = 100;
  var FLASH_MS = 500;           // Warning/MajorWarning coastline blink cadence
  var PANEL_TICK_MS = 30000;    // panel countdown re-render cadence

  // --- state ---
  var active = false;
  var source = null;            // attached shared EventSource
  var sseRetryTimer = null;
  var watchdog = null;
  var areas = [];               // authoritative current warning areas
  var issuedAt = null;          // ms epoch of the current issuance
  var areasGeo = null;          // fetched forecast-area GeoJSON (66 features)
  var geoFetching = false;
  var layer = null;             // single L.geoJSON layer, restyled per update
  var panel = null;
  var detailBox = null;
  var detailTimer = null;
  var demoTimer = null;
  var flashOn = false;          // coastline blink phase (read by featureStyle)
  var flashTimer = null;
  var panelTimer = null;
  var seen551 = {};
  var seen551Keys = [];
  var demoActive = false;       // demo() owns the current warning state
  var unknownGradesSeen = {};   // normalizeGrade logs each unknown value once

  // ================================================================
  //  PURE HELPERS (exported for tests)
  // ================================================================

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 'YYYY/MM/DD HH:mm[:ss]' in JST (UTC+9) -> epoch ms; NaN on failure.
  // Built from Date.UTC so the result is independent of the local timezone.
  // JMA firstHeight arrival times may also be clock-only 'HH:mm': that is
  // today in JST, rolled to tomorrow when already >12 h in the past.
  function parseJstMs(str) {
    if (typeof str !== 'string') return NaN;
    var m = str.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\D+(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0));
    var hm = str.match(/^\s*(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?\s*$/);
    if (!hm) return NaN;
    var now = Date.now();
    var jstNow = new Date(now + 9 * 3600 * 1000);
    var ms = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(),
      +hm[1] - 9, +hm[2], +(hm[3] || 0));
    if (now - ms > 12 * 3600 * 1000) ms += 24 * 3600 * 1000;
    return ms;
  }

  // P2P grade strings vary in case; 'MajorWarning' contains 'warning', so
  // the 'major' test must run first. Unrecognized grades stay 'Unknown'
  // (rank 0): never silently re-graded, skipped for coloring and alerts,
  // and logged once per distinct value.
  function normalizeGrade(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase();
    if (s.indexOf('major') !== -1) return 'MajorWarning';
    if (s.indexOf('warning') !== -1) return 'Warning';
    if (s.indexOf('watch') !== -1) return 'Watch';
    if (typeof console !== 'undefined' && !unknownGradesSeen[s]) {
      unknownGradesSeen[s] = true;
      console.warn('RTTsunami: unrecognized grade "' + raw + '" left ungraded');
    }
    return 'Unknown';
  }

  function gradeRank(grade) {
    if (grade === 'Watch') return 1;
    if (grade === 'Warning') return 2;
    if (grade === 'MajorWarning') return 3;
    return 0;
  }

  // Raw P2P 552 area list -> normalized list. Fields may be absent; the
  // area list of a new bulletin is authoritative (replaces, never merges).
  function parseTsunamiAreas(rawAreas) {
    var out = [];
    if (!Array.isArray(rawAreas)) return out;
    for (var i = 0; i < rawAreas.length; i++) {
      var a = rawAreas[i];
      if (!a || typeof a !== 'object') continue;
      var name = (typeof a.name === 'string') ? a.name : '';
      if (!name) continue;
      var arrMs = NaN;
      var fh = a.firstHeight;
      if (fh && typeof fh === 'object') arrMs = parseJstMs(fh.arrivalTime);
      else if (typeof fh === 'string') arrMs = parseJstMs(fh);
      var mh = (a.maxHeight && typeof a.maxHeight === 'object') ? a.maxHeight : null;
      var desc = (mh && typeof mh.description === 'string') ? mh.description.trim() : '';
      var hgt = (mh && typeof mh.height === 'string') ? mh.height.trim() : '';
      var mhText = desc;
      if (hgt && desc.indexOf(hgt) === -1) mhText = desc ? desc + ' (' + hgt + ')' : hgt;
      out.push({
        name: name,
        grade: normalizeGrade(a.grade),
        firstArrivalMs: isNaN(arrMs) ? null : arrMs,
        maxHeightText: mhText
      });
    }
    return out;
  }

  // JMA shindo ordering for sorting observed intensities.
  function shindoRank(s) {
    var str = String(s == null ? '' : s).trim();
    var map = { '1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9 };
    if (map[str] !== undefined) return map[str];
    var n = parseFloat(str);
    return isNaN(n) ? 0 : n;
  }

  // Raw 551 intensityDetail -> [{name, int}] sorted by rank descending.
  // Entries may carry the intensity under 'int' or 'scale'.
  function summarize551(detail) {
    var out = [];
    if (!detail || typeof detail !== 'object') return out;
    var prefs = Array.isArray(detail.prefectures) ? detail.prefectures : [];
    for (var i = 0; i < prefs.length; i++) {
      var p = prefs[i];
      if (!p || typeof p !== 'object') continue;
      var inten = (p.int !== undefined && p.int !== null) ? p.int : p.scale;
      if (inten === undefined || inten === null) continue;
      out.push({ name: (typeof p.name === 'string') ? p.name : '', int: String(inten) });
    }
    out.sort(function(a, b) { return shindoRank(b.int) - shindoRank(a.int); });
    return out;
  }

  // ================================================================
  //  ENVIRONMENT GUARDS (all DOM/Leaflet access is lazy)
  // ================================================================

  function getMap() {
    return (typeof window !== 'undefined' && window.map) ? window.map : null;
  }
  function hasL() { return typeof L !== 'undefined'; }
  function docHidden() {
    return (typeof document !== 'undefined' && document.hidden === true);
  }
  function mapContainer() {
    var m = getMap();
    if (m && m.getContainer) {
      try { return m.getContainer(); } catch (e) {}
    }
    if (typeof document !== 'undefined' && document.getElementById) {
      return document.getElementById('map');
    }
    return null;
  }

  // i18n: window.t(key) wins when present and not echoing the key back;
  // otherwise fall back to Japanese, or Chinese when qs-lang is 'zh'.
  function tr(key, ja, zh) {
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
    return (lang === 'zh') ? zh : ja;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // setTimeout that never pins the node event loop (browser ids are numbers)
  function later(fn, ms) {
    var id = setTimeout(fn, ms);
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  }

  // setInterval that never pins the node event loop (browser ids are numbers)
  function every(fn, ms) {
    var id = setInterval(fn, ms);
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  }

  // ================================================================
  //  FEEDBACK (toast + sound, never throws)
  // ================================================================

  // Shared toast FIFO (rt-data) when available; the module-local div stays
  // as the standalone/test fallback.
  function toast(msg, opts) {
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.toastQueued === 'function') {
        RTData.toastQueued(msg, opts);
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
    el._timeout = later(function() { el.style.opacity = '0'; }, 4000);
  }

  function playSound(name) {
    // sounds belong to the live feed — server replay stays silent
    try {
      if (typeof RTData !== 'undefined' && RTData.isReplaying && RTData.isReplaying()) return;
      if (typeof window !== 'undefined' && typeof window.playEEWSound === 'function') {
        window.playEEWSound(name);
        return;
      }
      if (typeof playEEWSound !== 'undefined' && typeof playEEWSound === 'function') {
        playEEWSound(name);
      }
    } catch (e) {}
  }

  // JP voice announcement via the app's SREV speech FIFO (self-gates on the
  // sound mode + TTS checkbox). Silent during server replay.
  function speakTts(messages) {
    if (typeof window === 'undefined' || typeof window._enqueueSrevSpeech !== 'function') return;
    if (!messages || !messages.length) return;
    try {
      if (typeof RTData !== 'undefined' && RTData.isReplaying && RTData.isReplaying()) return;
      window._enqueueSrevSpeech(messages, { id: 'rt-tsunami', replace: true });
    } catch (e) {}
  }

  // Earliest parseable first-wave ETA across the graded (warned) areas.
  function earliestArrivalMs(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (gradeRank(list[i].grade) <= 0) continue;
      var ms = list[i].firstArrivalMs;
      if (ms != null && (best == null || ms < best)) best = ms;
    }
    return best;
  }

  // Absolute-time ETA sentence, JMA bulletin style (cf. the relative
  // 早いところで line in TTSTextBuilder.buildTsunamiForecast).
  function etaSpeechText(arrivalMs) {
    var d = new Date(arrivalMs + 9 * 3600 * 1000);
    var h = d.getUTCHours(), m = d.getUTCMinutes();
    return '第一波の到達予想時刻は、早いところで、' + h + '時' + (m > 0 ? m + '分' : '') + 'です。';
  }

  // First-issuance / upgrade speech: grade line + up to 3 area names (+他N —
  // brevity per 2026-08-20 user feedback). The first issuance (opts.withEta)
  // also speaks the earliest first-wave ETA.
  var TTS_AREA_CAP = 3;
  function ttsIssuedMessages(grade, list, opts) {
    var head = grade === 'MajorWarning' ? '大津波警報が発表されました。' :
      grade === 'Warning' ? '津波警報が発表されました。' : '津波注意報が発表されました。';
    var pool = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].grade === grade && gradeRank(list[i].grade) > 0 && list[i].name) pool.push(list[i].name);
    }
    if (!pool.length) for (var j = 0; j < list.length; j++) {
      if (list[j].name && gradeRank(list[j].grade) > 0) pool.push(list[j].name);
    }
    var names = pool.slice(0, TTS_AREA_CAP);
    var rest = pool.length - names.length;
    var msgs = names.length ? [head, '対象地域： ' + names.join('、') + (rest > 0 ? ' 他' + rest : '') + '。'] : [head];
    if (opts && opts.withEta) {
      var eta = earliestArrivalMs(list);
      if (eta != null) msgs.push(etaSpeechText(eta));
    }
    return msgs;
  }

  function issuedText(grade) {
    if (grade === 'MajorWarning') {
      return tr('realtime.tsunami.issued_major', '大津波警報が発表されました', '大海啸警报已发布');
    }
    if (grade === 'Warning') {
      return tr('realtime.tsunami.issued_warning', '津波警報が発表されました', '海啸警报已发布');
    }
    return tr('realtime.tsunami.issued_watch', '津波注意報が発表されました', '海啸注意报已发布');
  }

  // Downgrade notice (quiet, no sound/TTS): '{from}が{to}に切り替わりました'
  // when the max grade drops; a partial-lift line when warned areas were
  // removed while the max grade stands (or became ungradeable).
  function downgradeText(prevGrade, newGrade) {
    if (prevGrade && newGrade) {
      var tpl = tr('realtime.tsunami.downgraded', '{from}が{to}に切り替わりました', '{from}已切换为{to}');
      if (tpl.indexOf('{from}') === -1) return tpl; // static override wins as-is
      return tpl.replace('{from}', gradeLabel(prevGrade)).replace('{to}', gradeLabel(newGrade));
    }
    return tr('realtime.tsunami.lifted_partial',
      '一部地域の津波警報・注意報が解除されました', '部分地区的海啸警报・注意报已解除');
  }

  // ================================================================
  //  WARNING STATE
  // ================================================================

  function maxGradeOf(list) {
    var best = null, bestRank = 0;
    for (var i = 0; i < list.length; i++) {
      var r = gradeRank(list[i].grade);
      if (r > bestRank) { bestRank = r; best = list[i].grade; }
    }
    return best;
  }

  function clearWarning() {
    areas = [];
    issuedAt = null;
  }

  // Per-area downgrade between the previous and next authoritative lists:
  // a warned area's grade drops, or a warned area vanishes, without a full
  // cancel. 'Unknown' entries rank 0 — never treated as warned.
  function detectDowngrade(prevList, nextList) {
    if (!Array.isArray(prevList) || !prevList.length) return false;
    if (!Array.isArray(nextList) || !nextList.length) return false;
    var nextByName = {};
    for (var i = 0; i < nextList.length; i++) nextByName[normName(nextList[i].name)] = nextList[i];
    for (var j = 0; j < prevList.length; j++) {
      var prev = prevList[j];
      if (!prev || gradeRank(prev.grade) <= 0) continue;
      var next = nextByName[normName(prev.name)];
      if (!next || gradeRank(next.grade) < gradeRank(prev.grade)) return true;
    }
    return false;
  }

  // ================================================================
  //  COASTLINE COLORING (one restyled L.geoJSON layer, never rebuilt)
  // ================================================================

  function normName(n) {
    return String(n == null ? '' : n).replace(/〜/g, '～').replace(/\s+/g, '');
  }

  function gradeForName(name) {
    var n = normName(name);
    for (var i = 0; i < areas.length; i++) {
      if (normName(areas[i].name) === n) return areas[i].grade;
    }
    return null;
  }

  // Warning/MajorWarning blink with the module flash phase; Watch is solid.
  function featureStyle(feature) {
    var g = gradeForName(feature && feature.properties ? feature.properties.name : '');
    if (g === 'Warning' || g === 'MajorWarning') {
      return { color: GRADE_COLORS[g], weight: flashOn ? 4 : 2.5, opacity: flashOn ? 0.95 : 0.25 };
    }
    if (g && GRADE_COLORS[g]) { // 'Unknown' grades keep the base style
      return { color: GRADE_COLORS[g], weight: 4, opacity: 0.95 };
    }
    return { color: BASE_STYLE.color, weight: BASE_STYLE.weight, opacity: BASE_STYLE.opacity };
  }

  function ensureAreasGeo() {
    if (areasGeo || geoFetching || typeof fetch === 'undefined') return;
    geoFetching = true;
    fetch(GEOJSON_URL).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function(json) {
      geoFetching = false;
      areasGeo = json;
      if (docHidden()) return;
      ensureLayer();
      restyleLayer();
    }).catch(function(e) {
      geoFetching = false;
      if (typeof console !== 'undefined') console.warn('RTTsunami areas geojson failed:', e && e.message);
    });
  }

  function ensureLayer() {
    if (layer || !areasGeo || !hasL()) return;
    var m = getMap();
    if (!m) return;
    try {
      layer = L.geoJSON(areasGeo, { style: featureStyle, interactive: false });
      layer.addTo(m);
    } catch (e) { layer = null; }
  }

  function restyleLayer() {
    if (!layer) return;
    try { layer.setStyle(featureStyle); } catch (e) {}
  }

  // Blink tick — flips the phase and restyles ONLY the warned segments.
  // The phase still advances while hidden; the restyle is skipped.
  function flashTick() {
    flashOn = !flashOn;
    if (docHidden() || !layer) return;
    try {
      if (!layer.eachLayer) { restyleLayer(); return; }
      layer.eachLayer(function(l) {
        var f = l && l.feature;
        var g = gradeForName(f && f.properties ? f.properties.name : '');
        if ((g === 'Warning' || g === 'MajorWarning') && l.setStyle) {
          l.setStyle(featureStyle(f));
        }
      });
    } catch (e) {}
  }

  // ================================================================
  //  PANEL (#rt-tsunami-panel, bottom-left dark glass card)
  // ================================================================

  function fmtJstHm(ms) {
    if (ms == null || isNaN(ms)) return '--:--';
    var d = new Date(ms + 9 * 3600 * 1000);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  function ensurePanel(container) {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'rt-tsunami-panel';
    panel.style.cssText = 'position:absolute;left:10px;bottom:10px;z-index:800;background:rgba(0,0,0,.78);color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;max-width:300px;border:2px solid #888;display:none';
    container.appendChild(panel);
    return panel;
  }

  function gradeLabel(g) {
    if (g === 'MajorWarning') return tr('realtime.tsunami.grade_major', '大津波警報', '大海啸警报');
    if (g === 'Warning') return tr('realtime.tsunami.grade_warning', '津波警報', '海啸警报');
    return tr('realtime.tsunami.grade_watch', '津波注意報', '海啸注意报');
  }

  // Live countdown to the first wave: 'あと X時間Y分' / 'あと X分' / '到達'.
  // The i18n value (and the fallbacks) are '{time}' templates.
  function countdownText(targetMs, nowMs) {
    var diff = targetMs - nowMs;
    if (diff <= 0) return tr('realtime.tsunami.arrived', '到達', '已到达');
    var mins = Math.max(1, Math.ceil(diff / 60000));
    var h = Math.floor(mins / 60), m = mins % 60;
    var ja = h > 0 ? h + '時間' + (m > 0 ? m + '分' : '') : mins + '分';
    var zh = h > 0 ? h + '小时' + (m > 0 ? m + '分' : '') : mins + '分钟';
    var tpl = tr('realtime.tsunami.eta_in', 'あと {time}', '还有 {time}');
    if (tpl.indexOf('{time}') === -1) return tpl; // static override wins as-is
    var lang = '';
    try {
      if (typeof localStorage !== 'undefined') lang = localStorage.getItem('qs-lang') || '';
    } catch (e) {}
    return tpl.replace('{time}', lang === 'zh' ? zh : ja);
  }

  // Areas with a first-wave ETA, sorted by grade rank desc then arrival asc.
  function etaSortedAreas() {
    var list = [];
    for (var i = 0; i < areas.length; i++) {
      if (areas[i].firstArrivalMs != null && gradeRank(areas[i].grade) > 0) list.push(areas[i]);
    }
    list.sort(function(a, b) {
      var d = gradeRank(b.grade) - gradeRank(a.grade);
      return d !== 0 ? d : a.firstArrivalMs - b.firstArrivalMs;
    });
    return list;
  }

  function panelHTML() {
    var html = '<div style="font-weight:700;margin-bottom:2px">' +
      tr('realtime.tsunami.title', '津波情報', '海啸信息') +
      ' <span style="color:#bbb;font-weight:400">' + fmtJstHm(issuedAt) + '</span></div>';
    var capLeft = MAX_ROWS, hidden = 0;
    for (var gi = 0; gi < GRADE_ORDER.length; gi++) {
      var g = GRADE_ORDER[gi];
      var list = [];
      for (var i = 0; i < areas.length; i++) if (areas[i].grade === g) list.push(areas[i]);
      if (!list.length) continue;
      var take = list.slice(0, Math.max(capLeft, 0));
      hidden += list.length - take.length;
      capLeft -= take.length;
      if (!take.length) continue;
      var names = [];
      for (var j = 0; j < take.length; j++) names.push(esc(take[j].name));
      html += '<div style="margin-top:2px"><span style="color:' + GRADE_COLORS[g] +
        ';font-weight:700">' + gradeLabel(g) + '</span> ' + names.join('、') + '</div>';
    }
    // per-area first-wave forecast table (ETA + live countdown + height)
    var rows = etaSortedAreas();
    if (rows.length) {
      var now = Date.now();
      var shown = rows.slice(0, MAX_ETA_ROWS);
      html += '<table style="margin-top:4px;border-collapse:collapse;font-size:11px;color:#ddd">';
      for (var k = 0; k < shown.length; k++) {
        var a = shown[k];
        html += '<tr>' +
          '<td style="padding:1px 4px 1px 0"><span style="display:inline-block;width:8px;height:8px;background:' +
            GRADE_COLORS[a.grade] + '"></span></td>' +
          '<td style="padding:1px 6px 1px 0;white-space:nowrap">' + esc(a.name) + '</td>' +
          '<td style="padding:1px 6px 1px 0;white-space:nowrap">' + fmtJstHm(a.firstArrivalMs) + '</td>' +
          '<td style="padding:1px 6px 1px 0;white-space:nowrap;color:#fff">' + countdownText(a.firstArrivalMs, now) + '</td>' +
          '<td style="padding:1px 0;white-space:nowrap;color:#bbb">' +
            (a.maxHeightText ? tr('realtime.tsunami.height', '予想高さ', '预计高度') + ' ' + esc(a.maxHeightText) : '') +
          '</td>' +
          '</tr>';
      }
      html += '</table>';
      if (rows.length > shown.length) {
        html += '<div style="color:#aaa">' + tr('realtime.tsunami.others', '他', '其他') + (rows.length - shown.length) + '</div>';
      }
    }
    if (hidden > 0) {
      html += '<div style="color:#aaa">' + tr('realtime.tsunami.others', '他', '其他') + hidden + '</div>';
    }
    return html;
  }

  function updatePanel() {
    if (typeof document === 'undefined' || !document.createElement) return;
    if (!areas.length) {
      if (panel) panel.style.display = 'none';
      return;
    }
    var container = mapContainer();
    if (!container) return;
    var p = ensurePanel(container);
    p.style.border = '2px solid ' + (GRADE_COLORS[maxGradeOf(areas)] || '#888');
    p.innerHTML = panelHTML();
    p.style.display = 'block';
  }

  // 30 s countdown re-render; updatePanel() no-ops when there are no areas.
  function panelTick() {
    if (docHidden()) return;
    updatePanel();
  }

  // ================================================================
  //  551 DETAIL POPUP (#rt-eq-detail, top-right transient card)
  // ================================================================

  function detailTop(container) {
    // sit below the legend when it occupies the top-right corner
    try {
      if (typeof document !== 'undefined' && document.getElementById) {
        var lg = document.getElementById('legend');
        if (lg && lg.getBoundingClientRect && container.getBoundingClientRect) {
          var lr = lg.getBoundingClientRect();
          if (lr.height > 0) {
            var t = Math.round(lr.bottom - container.getBoundingClientRect().top + 6);
            if (t > 0 && t < container.getBoundingClientRect().height - 40) return t;
          }
        }
      }
    } catch (e) {}
    return 10;
  }

  function mark551(id) {
    if (seen551[id]) return false;
    seen551[id] = true;
    seen551Keys.push(id);
    if (seen551Keys.length > MAX_SEEN_551) delete seen551[seen551Keys.shift()];
    return true;
  }

  function showDetail(evt, detail) {
    if (typeof document === 'undefined' || !document.createElement) return;
    var container = mapContainer();
    if (!container) return;
    if (!detailBox) {
      detailBox = document.createElement('div');
      detailBox.id = 'rt-eq-detail';
      detailBox.style.cssText = 'position:absolute;top:10px;right:10px;z-index:800;background:rgba(0,0,0,.78);color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;max-width:300px;border:2px solid rgba(255,180,0,.7);display:none';
      container.appendChild(detailBox);
    }
    var maxSh = evt.maxShindo || detail.maxInt || '?';
    var html = '<div style="font-weight:700;margin-bottom:3px">' +
      'M' + (evt.mag != null ? evt.mag : '?') + ' ' + esc(evt.place || '') + ' ' +
      tr('realtime.tsunami.depth', '深さ', '深度') + (evt.depth != null ? evt.depth : '?') + 'km ' +
      tr('realtime.tsunami.max_shindo', '最大震度', '最大烈度') + esc(String(maxSh)) + '</div>';
    var prefs = summarize551(detail);
    var top = prefs.slice(0, MAX_DETAIL_PREFS);
    var parts = [];
    for (var i = 0; i < top.length; i++) parts.push(esc(top[i].name) + ' ' + esc(top[i].int));
    if (parts.length) {
      html += '<div style="color:#ddd">' + parts.join('、') +
        (prefs.length > MAX_DETAIL_PREFS ? ' ' + tr('realtime.tsunami.others', '他', '其他') + (prefs.length - MAX_DETAIL_PREFS) : '') +
        '</div>';
    }
    detailBox.innerHTML = html;
    detailBox.style.top = detailTop(container) + 'px';
    detailBox.style.display = 'block';
    if (detailTimer) clearTimeout(detailTimer);
    detailTimer = later(function() {
      if (detailBox) detailBox.style.display = 'none';
      detailTimer = null;
    }, DETAIL_HIDE_MS);
  }

  // ================================================================
  //  EVENT HANDLING
  // ================================================================

  function issueMs(evt) {
    var ms = Date.parse(evt.time || '');
    return isNaN(ms) ? Date.now() : ms;
  }

  function handle552(evt) {
    var parsed = parseTsunamiAreas(evt.tsunamiAreas);
    var typeStr = String(evt.type || '');
    var isCancel = (evt.cancelled === true) ||
      (parsed.length === 0 && typeStr.indexOf('取消') !== -1);
    if (isCancel) {
      if (isDemoEvent(evt)) demoActive = false; // the demo's own cancel landed
      clearWarning();
      toast(tr('realtime.tsunami.cancelled', '津波情報は取り消されました', '海啸信息已取消'));
      playSound('Tsunami_lifted');
      speakTts(['津波情報は取り消されました。']);
      if (!docHidden()) {
        restyleLayer();
        updatePanel();
      }
      refreshStatusBar();
      return true;
    }
    if (!parsed.length) return false; // nothing authoritative to apply
    var prevMax = maxGradeOf(areas);
    var prevRank = gradeRank(prevMax);
    var hadAreas = areas.length > 0;
    var downgraded = hadAreas && detectDowngrade(areas, parsed);
    areas = parsed;
    issuedAt = issueMs(evt);
    var newMax = maxGradeOf(areas);
    var newRank = gradeRank(newMax);
    if (!hadAreas || newRank > prevRank) {
      // first issuance / upgrade: toast + sound + TTS (ETA on first issuance)
      if (newMax) {
        toast(issuedText(newMax));
        playSound(GRADE_SOUND[newMax]);
        speakTts(ttsIssuedMessages(newMax, areas, { withEta: !hadAreas }));
      }
    } else if (downgraded) {
      // downgrade / silent area removal: quiet toast, no sound/TTS
      toast(newRank > 0 && newRank < prevRank
        ? downgradeText(prevMax, newMax)
        : downgradeText(null, null));
    }
    ensureAreasGeo();
    if (!docHidden()) {
      ensureLayer();
      restyleLayer();
      updatePanel();
    }
    refreshStatusBar();
    return true;
  }

  // rt-data owns the status bar — nudge it to re-render so the 津波 count
  // appears immediately instead of waiting for the next list event
  function refreshStatusBar() {
    try {
      if (typeof RTData !== 'undefined' && typeof RTData.renderList === 'function') RTData.renderList();
    } catch (e) {}
  }

  function handle551(evt) {
    var detail = evt.intensityDetail;
    if (!detail || typeof detail !== 'object') return false;
    var id = (evt.id !== undefined && evt.id !== null) ? String(evt.id) : '';
    if (id && !mark551(id)) return false; // same event already shown
    if (docHidden()) return true;
    showDetail(evt, detail);
    return true;
  }

  function handleEvent(evt) {
    if (!evt || typeof evt !== 'object') return false;
    // tolerate the SSE wrapper ({type:'p2pquake', event:<normalized>}) too
    if (evt.code === undefined && evt.event && typeof evt.event === 'object') evt = evt.event;
    if (demoActive && !isDemoEvent(evt)) abortDemo(); // real feed data wins
    var code = Number(evt.code);
    if (code === 552) return handle552(evt);
    if (code === 551) return handle551(evt);
    return false;
  }

  // ================================================================
  //  SSE ATTACH (shared EventSource owned by RTData)
  // ================================================================

  function onP2P(e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (ex) { return; }
    if (!msg) return;
    var evt = (msg.event && typeof msg.event === 'object') ? msg.event : msg;
    try { handleEvent(evt); } catch (ex) {
      if (typeof console !== 'undefined') console.warn('RTTsunami handleEvent:', ex);
    }
  }

  function attachSSE() {
    if (!active || source) return;
    var src = null;
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.getP2PSource === 'function') {
        src = RTData.getP2PSource();
      }
    } catch (e) {}
    if (!src) {
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
      sseRetryTimer = later(attachSSE, ATTACH_RETRY_MS); // retry until the shared source exists
      return;
    }
    source = src;
    try { source.addEventListener('p2pquake', onP2P); } catch (e) { source = null; }
  }

  function watchTick() {
    if (!active) return;
    var rtOn = true;
    try {
      if (typeof RTData !== 'undefined' && RTData && typeof RTData.isActive === 'function') {
        rtOn = !!RTData.isActive();
      }
    } catch (e) {}
    if (!rtOn) { stop(); return; }   // realtime mode off -> full teardown
    if (!source) attachSSE();
  }

  // ================================================================
  //  DEMO
  // ================================================================

  function jstStamp(ms) {
    var d = new Date(ms + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '/' + pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  function isDemoEvent(evt) {
    return String(evt && evt.id != null ? evt.id : '').indexOf('demo_tsunami') === 0;
  }

  // Real data mid-demo: disarm the pending auto-cancel (it must never clear
  // real warning state) and drop the demo's fake state. While demoActive is
  // set the only warning state on screen is the demo's own, so clearing is
  // safe; a real 552 in the same tick replaces it right after.
  function abortDemo() {
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    if (!demoActive) return;
    demoActive = false;
    clearWarning();
    if (!docHidden()) {
      restyleLayer();
      updatePanel();
    }
    refreshStatusBar();
  }

  function demo() {
    var rtOn = false;
    try {
      rtOn = (typeof RTData !== 'undefined' && RTData &&
        typeof RTData.isActive === 'function' && !!RTData.isActive());
    } catch (e) {}
    if (!rtOn) return false;
    if (areas.length && !demoActive) return false; // never stomp a live warning
    var now = Date.now();
    demoActive = true;
    // Area names are real entries from geojson/jma_tsunami_forecast_areas.json
    handleEvent({
      id: 'demo_tsunami_' + now,
      code: 552,
      type: '津波情報',
      mag: 8.4, lat: 39.6, lng: 144.0, depth: 25, place: '三陸沖',
      time: new Date(now).toISOString(),
      serial: 1,
      tsunamiAreas: [
        { name: '岩手県', grade: 'MajorWarning',
          firstHeight: { arrivalTime: jstStamp(now + 20 * 60000) },
          maxHeight: { description: '巨大' } },
        { name: '宮城県', grade: 'Warning',
          firstHeight: { arrivalTime: jstStamp(now + 30 * 60000) },
          maxHeight: { description: '高い', height: '3m' } },
        { name: '福島県', grade: 'Watch',
          firstHeight: { arrivalTime: jstStamp(now + 40 * 60000) },
          maxHeight: { height: '1m' } }
      ]
    });
    if (demoTimer) clearTimeout(demoTimer);
    demoTimer = later(function() {
      demoTimer = null;
      if (!demoActive) return; // aborted by real data — leave real state alone
      demoActive = false;
      handleEvent({
        id: 'demo_tsunami_cancel_' + Date.now(),
        code: 552,
        type: '津波情報取消',
        cancelled: true,
        serial: 2,
        time: new Date().toISOString()
      });
    }, DEMO_CANCEL_MS);
    return true;
  }

  // ================================================================
  //  PUBLIC API
  // ================================================================

  function start() {
    if (active) return false;
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return false; // node safety
    active = true;
    attachSSE();
    ensureAreasGeo();
    watchdog = setInterval(watchTick, ATTACH_RETRY_MS);
    flashTimer = every(flashTick, FLASH_MS);
    panelTimer = every(panelTick, PANEL_TICK_MS);
    return true;
  }

  function stop() {
    active = false;
    if (source) {
      try { source.removeEventListener('p2pquake', onP2P); } catch (e) {}
      source = null;
    }
    if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
    flashOn = false;
    if (detailTimer) { clearTimeout(detailTimer); detailTimer = null; }
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    demoActive = false;
    if (layer) { try { layer.remove(); } catch (e) {} layer = null; }
    if (panel) { try { panel.remove(); } catch (e) {} panel = null; }
    if (detailBox) { try { detailBox.remove(); } catch (e) {} detailBox = null; }
    clearWarning();
    areasGeo = null;
    geoFetching = false;
    seen551 = {};
    seen551Keys = [];
    unknownGradesSeen = {};
    return true;
  }

  function isActive() { return active; }

  // Test hook — forces the coastline blink phase (cf. rt-eew _setClockOffsetMs).
  function _setFlashPhaseForTest(v) { flashOn = !!v; }

  function getState() {
    return {
      active: active,
      demoActive: demoActive,
      areaCount: areas.length,
      maxGrade: areas.length ? maxGradeOf(areas) : null,
      issuedAt: issuedAt
    };
  }

  return {
    start: start,
    stop: stop,
    isActive: isActive,
    getState: getState,
    handleEvent: handleEvent,
    demo: demo,
    // pure helpers (exported for tests)
    parseTsunamiAreas: parseTsunamiAreas,
    normalizeGrade: normalizeGrade,
    detectDowngrade: detectDowngrade,
    gradeRank: gradeRank,
    parseJstMs: parseJstMs,
    summarize551: summarize551,
    featureStyle: featureStyle,
    panelHTML: panelHTML,
    countdownText: countdownText,
    ttsIssuedMessages: ttsIssuedMessages,
    _setFlashPhaseForTest: _setFlashPhaseForTest
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTTsunami;
