// ================================================================
//  rt-eew.js — Kanameishi-style JMA EEW (緊急地震速報) live overlay
//  Expanding P/S wave rings from the epicenter with a per-report
//  lifecycle (update / warning upgrade / cancel / final), driven by
//  the Wolfx jma_eew feed on the shared P2P SSE stream.
//  Extras: NTP-corrected clock (/api/ntp, RTT-compensated), geoIP S-wave
//  countdown (/api/geoip, retried until a fix), hypocenter-precision badge,
//  first-report system notification, WarnArea prefecture coloring, WarnArea
//  detail lines, JP voice announcements and a client-side demo (RTEew.demo()).
//  Pure overlay: never drives the simulation, never moves the map.
//  Load after: rt-data.js (reuses its EventSource via RTData.getP2PSource)
//  Module pattern: browser global `RTEew`; module.exports for node tests.
//  All DOM/Leaflet access is lazy and typeof-guarded.
// ================================================================
var RTEew = (function() {

  // --- constants ---
  var P_COLOR = '#2e7fdb';          // P-wave ring
  var S_COLOR_WARN = '#e8452c';     // S-wave ring, warning (警報)
  var S_COLOR_FORECAST = '#f5a623'; // S-wave ring, forecast (予報)
  var BORDER_ALERT = 'rgba(255,60,30,.9)';
  var BORDER_FORECAST = 'rgba(255,180,0,.7)';
  var BORDER_CANCEL = 'rgba(120,120,120,.8)';
  var TICK_MS = 250;                // shared ring-growth timer
  var MANAGE_MS = 2000;             // attach/retry/expiry/panel sweep timer
  var EXPIRE_MS = 120000;           // drop event after 120 s without a frame
  var CANCEL_GRACE_MS = 10000;      // panel keeps '取消' styling this long
  var FINAL_GRACE_MS = 30000;       // frozen rings / panel kept this long
  var MAX_RADIUS_KM = 2000;
  var DEFAULT_DEPTH_KM = 10;
  var NTP_REFRESH_MS = 1800000;       // re-sync the clock every 30 min while active
  var NTP_RETRY_MIN_MS = 30000;       // first retry after a failed initial sync (doubles, capped at NTP_REFRESH_MS)
  var GEOIP_RETRY_MS = 300000;        // geoIP retry cadence until a fix lands
  var DEMO_EVENT_ID = 'RTEEW-DEMO';

  // Local fallback mirror of app.js SHINDO_FILL (keys '1'..'7','5-','5+','6-','6+').
  var LOCAL_FILL = {
    1: '#a0d2f0', 2: '#6cb4ee', 3: '#2ecc71', 4: '#f1c40f',
    '5-': '#e67e22', '5+': '#e74c3c', '6-': '#c0392b', '6+': '#8e44ad', 7: '#6c0f1f'
  };

  // ================================================================
  //  PURE HELPERS (no DOM / no Leaflet — unit-tested)
  // ================================================================

  // Parse 'YYYY/MM/DD HH:mm:ss.SSS' as JST (UTC+9) -> epoch ms. Tolerates
  // missing fractional seconds and 1-2 digit fractions. null when invalid.
  function parseJstMs(str) {
    if (typeof str !== 'string') return null;
    var m = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?/);
    if (!m) return null;
    var ms = m[7] ? parseInt((m[7] + '00').slice(0, 3), 10) : 0;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +m[6], ms);
    return isNaN(t) ? null : t;
  }

  function numOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // Wolfx Accuracy block: levels may arrive as numbers (test feeds) or as JMA
  // label strings ("IPF 法（5 点以上）", "防災科研システム", "試験"). null when
  // the block is absent or carries no usable value.
  function parseAccuracy(raw) {
    if (!raw || typeof raw !== 'object') return null;
    function accVal(v) {
      if (v === undefined || v === null || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : String(v);
    }
    var out = {
      epicenter: accVal(raw.Epicenter),
      depth: accVal(raw.Depth),
      magnitude: accVal(raw.Magnitude),
      numberOfMagnitude: numOrNull(raw.NumberOfMagnitude !== undefined ? raw.NumberOfMagnitude : raw.numberOfMagnitude)
    };
    if (out.epicenter === null && out.depth === null &&
        out.magnitude === null && out.numberOfMagnitude === null) return null;
    return out;
  }

  // Trilingual shim for the module's few JS-built UI strings: language pref is
  // localStorage 'qs-lang' (ja/en/zh), default ja (matches rt-tsunami.js).
  function currentLang() {
    try {
      if (typeof localStorage !== 'undefined') {
        var l = localStorage.getItem('qs-lang') || '';
        if (l === 'en' || l === 'zh') return l;
      }
    } catch (e) {}
    return 'ja';
  }

  function _tr(ja, en, zh) {
    var l = currentLang();
    return l === 'en' ? en : (l === 'zh' ? zh : ja);
  }

  // One-line accuracy summary for the EEW box ('' when nothing to show).
  // Numeric levels render as 'Lv<n>'; Wolfx label strings pass through with
  // whitespace stripped and a 12-char cap. lang is 'ja'/'en'/'zh'.
  function formatAccuracy(acc, lang) {
    if (!acc || typeof acc !== 'object') return '';
    function fmt(v) {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number' && isFinite(v)) return 'Lv' + v;
      var s = String(v).replace(/\s+/g, '');
      return s.length > 12 ? s.slice(0, 12) + '…' : s;
    }
    var L = (lang === 'en')
      ? { epi: 'Epicenter', dep: 'Depth', mag: 'M' }
      : { epi: '震源精度', dep: '深度精度', mag: 'M精度' };
    var parts = [];
    var e = fmt(acc.epicenter), d = fmt(acc.depth), m = fmt(acc.magnitude);
    if (e) parts.push(L.epi + ' ' + e);
    if (d) parts.push(L.dep + ' ' + d);
    if (m) parts.push(L.mag + ' ' + m);
    var n = numOrNull(acc.numberOfMagnitude);
    if (n !== null) {
      parts.push(lang === 'en' ? (n + (n === 1 ? ' station' : ' stations'))
        : (lang === 'zh' ? '使用台站 ' : '使用站数 ') + n);
    }
    return parts.join(' · ');
  }

  // Low-precision heuristic for the badge flag: numeric level <= 2 (IPF 1-2
  // points), a '試験' test label, or an 'N 点' label with N <= 2.
  function accValLow(v) {
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'number' && isFinite(v)) return v <= 2;
    var s = String(v);
    return s.indexOf('試験') >= 0 || /(^|[^0-9])[12]\s*点/.test(s);
  }

  function accuracyIsLow(acc) {
    if (!acc) return false;
    return accValLow(acc.epicenter) || accValLow(acc.depth) || accValLow(acc.magnitude);
  }

  // Normalize a raw Wolfx jma_eew report (note upstream 'Magunitude' typo).
  // Returns null when there is no EventID or no valid magnitude.
  function parseWolfx(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var eventId = raw.EventID;
    if (eventId === undefined || eventId === null || eventId === '') return null;
    var mag = Number(raw.Magunitude);
    if (!isFinite(mag) || mag <= 0) return null;

    var maxInt = '';
    var mi = raw.MaxIntensity;
    if (mi && typeof mi === 'object') maxInt = mi.To || mi.From || '';
    else if (mi !== undefined && mi !== null) maxInt = String(mi);

    var warnAreas = [];
    if (raw.WarnArea && raw.WarnArea.length) {
      for (var i = 0; i < raw.WarnArea.length; i++) {
        var a = raw.WarnArea[i] || {};
        warnAreas.push({
          name: a.Chiiki || '',
          shindo1: (a.Shindo1 !== undefined && a.Shindo1 !== null) ? String(a.Shindo1) : '',
          shindo2: (a.Shindo2 !== undefined && a.Shindo2 !== null) ? String(a.Shindo2) : '',
          type: a.Type || '',
          arrive: (a.Arrive !== undefined) ? a.Arrive : null
        });
      }
    }

    var serial = Number(raw.Serial);
    return {
      eventId: String(eventId),
      serial: (isFinite(serial) && serial > 0) ? serial : 1,
      originMs: parseJstMs(raw.OriginTime),
      announcedMs: parseJstMs(raw.AnnouncedTime),
      lat: numOrNull(raw.Latitude),
      lng: numOrNull(raw.Longitude),
      depth: numOrNull(raw.Depth),
      mag: mag,
      place: raw.Hypocenter || '',
      maxInt: maxInt,
      isWarn: !!raw.isWarn,
      isFinal: !!raw.isFinal,
      isCancel: !!raw.isCancel,
      isTraining: !!raw.isTraining,
      isAssumption: !!raw.isAssumption,
      isSea: !!raw.isSea,
      accuracy: parseAccuracy(raw.Accuracy),
      warnAreas: warnAreas
    };
  }

  // Distance at which a one-way wave travel time equals elapsedSec.
  // travelTimeFn(horizontalKm, depthKm, speedKmS) is monotonic in distance,
  // so bisection on [0, maxKm] converges. 0 before the first arrival.
  function waveRadiusKm(travelTimeFn, depthKm, speedKmS, elapsedSec, maxKm) {
    if (typeof travelTimeFn !== 'function') return 0;
    if (!isFinite(elapsedSec) || elapsedSec <= 0) return 0;
    if (maxKm === undefined || maxKm === null) maxKm = MAX_RADIUS_KM;
    if (!isFinite(depthKm) || depthKm === null) depthKm = 0;
    var t0, tHi, tm;
    try { t0 = travelTimeFn(0, depthKm, speedKmS); } catch (e) { return 0; }
    if (!isFinite(t0) || t0 > elapsedSec) return 0; // wave has not reached the surface yet
    try { tHi = travelTimeFn(maxKm, depthKm, speedKmS); } catch (e2) { return 0; }
    if (!isFinite(tHi)) return 0;
    if (tHi <= elapsedSec) return maxKm;
    var lo = 0, hi = maxKm;
    for (var i = 0; i < 30; i++) {
      var mid = (lo + hi) / 2;
      try { tm = travelTimeFn(mid, depthKm, speedKmS); } catch (e3) { break; }
      if (!isFinite(tm)) break;
      if (tm <= elapsedSec) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Clamp the per-event clock offset estimate to [-5000, +60000] ms.
  function clampOffsetMs(ms) {
    if (!isFinite(ms)) return 0;
    if (ms < -5000) return -5000;
    if (ms > 60000) return 60000;
    return ms;
  }

  // --- NTP clock offset state (module-level; read by elapsedSec) ---
  // Server-vs-local clock offset in ms, refreshed from /api/ntp while active.
  // Stays 0 until the first successful fetch, which keeps the per-event
  // fallback to the plain local clock.
  var clockOffsetMs = 0;

  // --- WarnArea Chiiki -> prefecture matching (fullwidth-digit tolerant) ---
  var CHIIKI_ALIASES = {
    '伊豆諸島': '東京都',
    '小笠原諸島': '東京都'
  };

  // '２３' -> '23' (JMA WarnArea Chiiki uses fullwidth digits, e.g. '東京都２３区').
  function normalizeFullwidthDigits(s) {
    return String(s).replace(/[０-９]/g, function(ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
  }

  // 0-based index of the prefecture whose nam_ja prefixes the (normalized)
  // Chiiki string; longest prefix wins. null when nothing matches.
  function matchChiikiIndex(chiiki, prefNamJaList) {
    if (!chiiki || !prefNamJaList || !prefNamJaList.length) return null;
    var target = normalizeFullwidthDigits(chiiki);
    if (CHIIKI_ALIASES[target]) target = CHIIKI_ALIASES[target];
    var best = -1;
    for (var i = 0; i < prefNamJaList.length; i++) {
      var nam = prefNamJaList[i];
      if (!nam) continue;
      if (target.indexOf(nam) === 0 && (best < 0 || nam.length > prefNamJaList[best].length)) best = i;
    }
    return best >= 0 ? best : null;
  }

  // {chiiki: prefId-or-null}. prefNamJaList is ordered by properties.id,
  // so the 1-based position in the list IS the prefecture id (1..47).
  function matchWarnPrefectures(chiikiList, prefNamJaList) {
    var out = {};
    if (!chiikiList) return out;
    for (var i = 0; i < chiikiList.length; i++) {
      var idx = matchChiikiIndex(chiikiList[i], prefNamJaList);
      out[chiikiList[i]] = (idx === null) ? null : idx + 1;
    }
    return out;
  }

  // Numeric rank for '1'..'7' with +/- bands ('5+' > '5-'). Unknown -> 0.
  function shindoRank(s) {
    switch (s) {
      case '1': return 1; case '2': return 2; case '3': return 3; case '4': return 4;
      case '5-': return 5; case '5+': return 6;
      case '6-': return 7; case '6+': return 8;
      case '7': return 9;
      default: return 0;
    }
  }

  // Worst-case shindo for a warn area (Shindo2 = upper bound, Shindo1 = lower).
  function warnAreaShindo(a) {
    if (!a) return '';
    return a.shindo2 || a.shindo1 || '';
  }

  // '和歌山県南部 6+、三重県南部 5-、奈良県 4 他3' — top maxN by shindo rank.
  function formatWarnAreas(warnAreas, maxN) {
    if (!warnAreas || !warnAreas.length) return '';
    if (maxN === undefined || maxN === null || maxN < 1) maxN = 3;
    var sorted = warnAreas.slice().sort(function(a, b) {
      return shindoRank(warnAreaShindo(b)) - shindoRank(warnAreaShindo(a));
    });
    var parts = [];
    for (var i = 0; i < sorted.length && i < maxN; i++) {
      var sh = warnAreaShindo(sorted[i]);
      parts.push(sorted[i].name + (sh ? ' ' + sh : ''));
    }
    var rest = sorted.length - parts.length;
    return parts.join('、') + (rest > 0 ? ' 他' + rest : '');
  }

  // TTS band wording: '6+' -> '6強'. Plain bands pass through, '' -> '不明'.
  function shindoToJp(s) {
    if (s === undefined || s === null || s === '') return '不明';
    switch (String(s)) {
      case '5-': return '5弱';
      case '5+': return '5強';
      case '6-': return '6弱';
      case '6+': return '6強';
      default: return String(s);
    }
  }

  function ttsForecastText(p) {
    var mag = (p && isFinite(p.mag)) ? p.mag.toFixed(1) : '不明';
    return '緊急地震速報。' + ((p && p.place) || '不明') +
      'で地震、マグニチュード' + mag + '、最大震度' + shindoToJp(p && p.maxInt) + 'の予想。';
  }

  function ttsWarnText(p) {
    var head = '緊急地震速報（警報）です。';
    var areas = (p && p.warnAreas ? p.warnAreas : []).slice().sort(function(a, b) {
      return shindoRank(warnAreaShindo(b)) - shindoRank(warnAreaShindo(a));
    });
    var names = [];
    for (var i = 0; i < areas.length && i < 2; i++) if (areas[i].name) names.push(areas[i].name);
    return names.length ? head + names.join('、') + 'では強い揺れに警戒してください。' : head;
  }

  var TTS_CANCEL_TEXT = '緊急地震速報は取り消されました。';

  // Great-circle distance in km (haversine, R = 6371).
  function haversineKm(lat1, lng1, lat2, lng2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Seconds until the S wave reaches the reference point (negative = arrived).
  function countdownRemainSec(travelTimeFn, distKm, depthKm, speedKmS, elapsed) {
    if (typeof travelTimeFn !== 'function') return null;
    var t;
    try { t = travelTimeFn(distKm, depthKm, speedKmS); } catch (e) { return null; }
    if (!isFinite(t)) return null;
    return t - (elapsed || 0);
  }

  // 'YYYY/MM/DD HH:mm:ss.SSS' in JST — inverse of parseJstMs (for the demo feed).
  function jstString(ms) {
    var d = new Date(ms + 9 * 3600 * 1000); // shift to JST, then read UTC fields
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '/' + p2(d.getUTCMonth() + 1) + '/' + p2(d.getUTCDate()) +
      ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) +
      '.' + ('00' + d.getUTCMilliseconds()).slice(-3);
  }

  // --- lifecycle reducer: pure state transition + side-effect descriptors ---
  // State: {eventId, serial, latest, receivedAt, offsetMs,
  //         phase:'active'|'final'|'canceled', cancelAt, finalAt, isTraining}
  // Effects executed by the browser layer: [{type:'sound', name}] and
  // [{type:'tts', messages:[jp-text]}] (speech is skipped for training events
  // unless the caller opts in — the demo does).
  function reduceEvent(prev, parsed, receivedAtMs) {
    var effects = [];
    var isNew = !prev;
    var st = prev ? {
      eventId: prev.eventId, serial: prev.serial, latest: prev.latest,
      receivedAt: prev.receivedAt, offsetMs: prev.offsetMs, phase: prev.phase,
      cancelAt: prev.cancelAt, finalAt: prev.finalAt, isTraining: prev.isTraining
    } : {
      eventId: parsed.eventId, serial: 0, latest: null,
      receivedAt: 0, offsetMs: 0, phase: 'active',
      cancelAt: null, finalAt: null, isTraining: false
    };

    if (isNew) {
      // Per-event offset estimate is kept for diagnostics only; the radius
      // clock uses the shared NTP offset (clockOffsetMs) — see elapsedSec.
      st.offsetMs = clampOffsetMs(receivedAtMs - (parsed.announcedMs != null ? parsed.announcedMs : receivedAtMs));
      if (parsed.serial === 1) {
        effects.push({ type: 'sound', name: 'EEW1' });
        effects.push({ type: 'tts', messages: [ttsForecastText(parsed)] });
      }
    }

    var wasWarn = !!(st.latest && st.latest.isWarn);
    var wasPhase = st.phase;
    if (parsed.serial >= st.serial) {
      st.serial = parsed.serial;
      st.latest = parsed;
      st.isTraining = !!parsed.isTraining;
      // Refresh the liveness clock only on a report that actually advanced —
      // out-of-order/duplicate serials used to keep stamping receivedAt so
      // the 120 s expiry sweep never retired the event.
      st.receivedAt = receivedAtMs;
    }

    if (!wasWarn && parsed.isWarn) {
      effects.push({ type: 'sound', name: 'EEW_alert' });
      effects.push({ type: 'tts', messages: [ttsWarnText(parsed)] });
    }
    if (parsed.isCancel && wasPhase !== 'canceled') {
      st.phase = 'canceled';
      st.cancelAt = receivedAtMs;
      effects.push({ type: 'sound', name: 'EEW_canceled' });
      effects.push({ type: 'tts', messages: [TTS_CANCEL_TEXT] });
    } else if (parsed.isFinal && wasPhase === 'active') {
      st.phase = 'final';
      st.finalAt = receivedAtMs;
      // Distinct final-report chime (EEW1 = first report, EEW_alert = warning
      // upgrade, EEW2 = final, EEW_canceled = cancel — kanameishi parity).
      effects.push({ type: 'sound', name: 'EEW2' });
    }
    return { state: st, effects: effects, isNew: isNew };
  }

  // In-memory multi-event tracker (pure; mirrors the browser-side registry).
  function createTracker() { return { events: {} }; }

  function trackReport(tracker, parsed, receivedAtMs) {
    if (!tracker || !parsed || !parsed.eventId) return null;
    var res = reduceEvent(tracker.events[parsed.eventId] || null, parsed, receivedAtMs);
    tracker.events[parsed.eventId] = res.state;
    return res;
  }

  // Elapsed real seconds since origin on the NTP-corrected clock (clamped >= 0).
  // clockOffsetMs is 0 until /api/ntp responds, which preserves the original
  // per-event fallback to the plain local clock.
  function elapsedSec(state, nowMs) {
    if (!state || !state.latest || state.latest.originMs == null) return 0;
    var s = (nowMs + clockOffsetMs - state.latest.originMs) / 1000;
    return s > 0 ? s : 0;
  }

  // ================================================================
  //  BROWSER RUNTIME (lazy DOM / Leaflet; never touched from node)
  // ================================================================

  var running = false;
  var tracker = createTracker();
  var runtime = {};            // eventId -> {group, marker, pRing, sRing, pShown, sShown, finalTimer}
  var mgrTimer = null;
  var tickTimer = null;
  var attachedSource = null;
  var wasActive = false;
  var panelEventId = null;     // set while THIS module owns the EEW panel
  var containerShown = false;  // we flipped #eew-container from none -> flex
  var ntpFetchedAtMs = 0;      // last /api/ntp attempt (success or failure)
  var ntpSynced = false;       // true after the first successful /api/ntp fetch
  var ntpRetryMs = NTP_RETRY_MIN_MS; // pre-sync failure backoff (doubles to the 30-min cap)
  var geoipFetchedAtMs = 0;    // last /api/geoip attempt; retried while no fix
  var userLoc = null;          // {lat, lng, manual} — geoIP fix or persisted manual pin
  var userMarker = null;       // blue-dot marker at userLoc
  var userLocPickArmed = false; // one-shot map pick for the user's own location
  var USER_LOC_KEY = 'qs-user-loc'; // localStorage slot for the manual pin
  var MAINVIEW_KEY = 'qs-eew-mainview'; // localStorage slot for the EEW main-view toggle
  var cdWarn = { eventId: null, fired: false, lastTickSec: -1 }; // countdown-warning state
  var prefLayer = null;        // L.geoJSON prefecture WarnArea overlay
  var prefNamJaList = [];      // nam_ja ordered by properties.id (id = index + 1)
  var prefLoading = false;
  var prefFailedAt = 0;        // retry backoff after a failed geojson fetch
  var demoTimers = [];         // pending client-side demo frames
  var demoPinned = false;      // RTDemo keeps the demo event's rings/panel for
                               // the whole rehearsal (no final-grace fade, no
                               // 120 s expiry); clearDemo() removes it on stop

  function isRtActive() {
    return typeof RTData !== 'undefined' && typeof RTData.isActive === 'function' && RTData.isActive();
  }

  // During server replay the module still draws, but sounds and TTS belong
  // to the live feed only.
  function isReplayingFeed() {
    return typeof RTData !== 'undefined' && typeof RTData.isReplaying === 'function' && RTData.isReplaying();
  }

  function safeSound(name) {
    if (typeof playEEWSound !== 'function') return;
    if (isReplayingFeed()) return;
    try { playEEWSound(name); } catch (e) {}
  }

  // JP voice announcement via the app's SREV speech FIFO. The announcer
  // self-gates on sound mode (jp) + TTS checkbox, so calling is always safe.
  function speakTts(messages, eventId) {
    if (typeof window === 'undefined' || typeof window._enqueueSrevSpeech !== 'function') return;
    if (!messages || !messages.length) return;
    if (isReplayingFeed()) return;
    try { window._enqueueSrevSpeech(messages, { id: 'rt-eew-' + eventId, replace: true }); } catch (e) {}
  }

  // OS-level notification for a first report via the shared RTData facade
  // (guarded: older rt-data.js builds may not expose notifySystem yet).
  // Sound/TTS rules apply here too — silent during server replay.
  function notifySystemEew(parsed) {
    if (typeof RTData === 'undefined' || typeof RTData.notifySystem !== 'function') return;
    if (isReplayingFeed()) return;
    var title = _tr('緊急地震速報', 'Earthquake Early Warning', '紧急地震速报') +
      (parsed.isWarn ? _tr('（警報）', ' (Warning)', '（警报）') : '');
    var body = (parsed.place || '?') + '  M' + parsed.mag.toFixed(1) +
      (parsed.maxInt ? '  ' + _tr('最大震度', 'Max intensity', '最大震度') + ' ' + parsed.maxInt : '');
    try { RTData.notifySystem(title, body, 'rt-eew-' + parsed.eventId); } catch (e) {}
  }

  function tt(key, fallback) {
    if (typeof window !== 'undefined' && typeof window.t === 'function') {
      try {
        var v = window.t(key);
        if (v && v !== key) return v;
      } catch (e) {}
    }
    return fallback;
  }
  // tt() with {placeholder} vars (falls back with the raw serial baked in)
  function ttv(key, fallback, vars) {
    if (typeof window !== 'undefined' && typeof window.t === 'function') {
      try {
        var v = window.t(key, vars);
        if (v && v !== key && !/\{[a-z]+\}/.test(v)) return v;
      } catch (e) {}
    }
    return fallback;
  }

  function shindoFill(sh) {
    if (sh === undefined || sh === null || sh === '') return '#888';
    if (typeof SHINDO_FILL !== 'undefined' && SHINDO_FILL[sh]) return SHINDO_FILL[sh];
    return LOCAL_FILL[sh] || '#888';
  }

  function speedOf(key, dflt) {
    var v = (typeof cfgGet === 'function') ? cfgGet(key) : dflt;
    v = Number(v);
    return (isFinite(v) && v > 0) ? v : dflt;
  }

  // --- NTP clock sync ---
  // Midpoint estimate with RTT compensation: the server timestamp applies to
  // halfway through the round trip, so offset = serverMs + RTT/2 - t1.
  function fetchNtpOffset() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    var t0 = Date.now();
    ntpFetchedAtMs = t0;
    try {
      return fetch('/api/ntp').then(function(res) {
        return (res && res.ok) ? res.json() : null;
      }).then(function(j) {
        if (!j || !isFinite(Number(j.timestamp))) { ntpNoteFailure(); return null; }
        // Wolfx ntp.json timestamp is ALREADY milliseconds (13 digits) despite
        // the unix-seconds name — accept either by magnitude
        var ts = Number(j.timestamp);
        if (ts < 1e12) ts *= 1000;
        var t1 = Date.now();
        clockOffsetMs = ts + (t1 - t0) / 2 - t1;
        ntpSynced = true;
        ntpRetryMs = NTP_RETRY_MIN_MS;
        return clockOffsetMs;
      }).catch(function() { ntpNoteFailure(); return null; });
    } catch (e) { ntpNoteFailure(); return Promise.resolve(null); }
  }

  // Failed initial sync: back off 30 s -> 60 s -> ... capped at the normal
  // 30-min resync cadence. Once a sync lands, ntpSynced flips and manage()
  // returns to the flat 30-min refresh.
  function ntpNoteFailure() {
    if (!ntpSynced) ntpRetryMs = Math.min(ntpRetryMs * 2, NTP_REFRESH_MS);
  }

  function getClockOffsetMs() { return clockOffsetMs; }

  // Test hook: set the clock offset without a fetch.
  function _setClockOffsetMs(ms) { clockOffsetMs = isFinite(ms) ? ms : 0; }

  // --- geoIP reference point (S-wave countdown) ---

  // Self-throttled: one attempt per GEOIP_RETRY_MS until a fix lands, then
  // never again. The map-center fallback stays in effect while userLoc is null.
  function fetchGeoip() {
    if (userLoc || typeof fetch !== 'function') return;
    var now = Date.now();
    if (geoipFetchedAtMs && now - geoipFetchedAtMs < GEOIP_RETRY_MS) return;
    geoipFetchedAtMs = now;
    try {
      fetch('/api/geoip').then(function(res) { return (res && res.ok) ? res.json() : null; })
        .then(function(j) {
          if (!j) return;
          var lat = Number(j.latitude), lng = Number(j.longitude);
          if (!isFinite(lat) || !isFinite(lng)) return; // null geoIP -> map-center fallback
          userLoc = { lat: lat, lng: lng };
          ensureUserMarker();
        }).catch(function() {});
    } catch (e) {}
  }

  function ensureUserMarker() {
    if (!userLoc) return;
    if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
    if (userMarker) {
      // keep the pin in sync after a manual re-set / persisted restore
      var cur = userMarker.getLatLng();
      if (Math.abs(cur.lat - userLoc.lat) > 1e-9 || Math.abs(cur.lng - userLoc.lng) > 1e-9) {
        userMarker.setLatLng([userLoc.lat, userLoc.lng]);
      }
      updateUserMarkerTooltip();
      return;
    }
    userMarker = L.marker([userLoc.lat, userLoc.lng], {
      icon: L.divIcon({
        className: 'rt-eew-userloc',
        html: '<div style="width:12px;height:12px;border-radius:50%;background:#2e7fdb;' +
          'border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.6)"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      }),
      interactive: true, keyboard: false, zIndexOffset: 800, draggable: true
    });
    updateUserMarkerTooltip();
    // Dragging the pin is a third way to set the location manually.
    userMarker.on('dragend', function() {
      var ll = userMarker.getLatLng();
      setUserLocation(ll.lat, ll.lng);
    });
    userMarker.addTo(map);
  }

  function updateUserMarkerTooltip() {
    if (!userMarker) return;
    try {
      var txt = (userLoc && userLoc.manual)
        ? tt('realtime.eew_userloc_manual', '現在地（設定済）')
        : tt('realtime.eew_userloc', '現在地(推定)');
      if (userMarker.getTooltip && userMarker.getTooltip()) userMarker.setTooltipContent(txt);
      else userMarker.bindTooltip(txt);
    } catch (e) {}
  }

  function removeUserMarker() {
    if (!userMarker) return;
    try { if (typeof map !== 'undefined' && map) map.removeLayer(userMarker); } catch (e) {}
    userMarker = null;
  }

  // --- manual user-location pin (persisted across sessions) ---

  function validateUserLatLng(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    return isFinite(lat) && isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0);
  }

  function persistUserLoc() {
    try {
      if (typeof localStorage === 'undefined') return;
      if (userLoc && userLoc.manual) {
        localStorage.setItem(USER_LOC_KEY, JSON.stringify({ lat: userLoc.lat, lng: userLoc.lng }));
      } else {
        localStorage.removeItem(USER_LOC_KEY);
      }
    } catch (e) {}
  }

  // Restore the persisted manual pin before geoIP runs — a saved pin wins
  // over the auto fix and suppresses the geoIP fetch entirely.
  function loadPersistedUserLoc() {
    if (userLoc) return;
    try {
      if (typeof localStorage === 'undefined') return;
      var raw = localStorage.getItem(USER_LOC_KEY);
      if (!raw) return;
      var j = JSON.parse(raw);
      if (j && validateUserLatLng(j.lat, j.lng)) {
        userLoc = { lat: Number(j.lat), lng: Number(j.lng), manual: true };
      }
    } catch (e) {}
  }

  function setUserLocation(lat, lng) {
    if (!validateUserLatLng(lat, lng)) return false;
    userLoc = { lat: Number(lat), lng: Number(lng), manual: true };
    persistUserLoc();
    ensureUserMarker();
    return true;
  }

  function clearUserLocation() {
    userLoc = null;
    persistUserLoc();
    removeUserMarker();
    geoipFetchedAtMs = 0; // allow an immediate auto re-fix
    fetchGeoip();
  }

  function getUserLocation() {
    return userLoc ? { lat: userLoc.lat, lng: userLoc.lng, manual: !!userLoc.manual } : null;
  }

  // One-shot map pick — the app.js map click handler checks isUserLocPickArmed
  // first and routes the click here (same pattern as the manual-aftershock pick).
  function armUserLocPick() { userLocPickArmed = true; }
  function cancelUserLocPick() { userLocPickArmed = false; }
  function isUserLocPickArmed() { return userLocPickArmed; }
  function completeUserLocPick(lat, lng) {
    userLocPickArmed = false;
    return setUserLocation(lat, lng);
  }

  // Countdown reference: the geoIP location, else the live map center.
  function referenceLatLng() {
    if (userLoc) return userLoc;
    if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') {
      try {
        var c = map.getCenter();
        if (c && isFinite(c.lat) && isFinite(c.lng)) return { lat: c.lat, lng: c.lng };
      } catch (e) {}
    }
    return null;
  }

  // --- SSE attach (shared EventSource owned by rt-data.js) ---

  function attach(src) {
    detach();
    attachedSource = src;
    try { src.addEventListener('wolfx_eew', onSseFrame); }
    catch (e) { attachedSource = null; }
  }

  function detach() {
    if (!attachedSource) return;
    try { attachedSource.removeEventListener('wolfx_eew', onSseFrame); } catch (e) {}
    attachedSource = null;
  }

  function onSseFrame(e) {
    var payload;
    try { payload = JSON.parse(e.data); } catch (ex) { return; }
    var raw = (payload && payload.event) ? payload.event : payload;
    ingestRaw(raw, Date.now(), null);
  }

  // Shared frame pipeline: raw Wolfx report -> parse -> track -> side effects.
  // The SSE listener and the client-side demo both feed through here.
  function ingestRaw(raw, nowMs, opts) {
    var parsed = parseWolfx(raw);
    if (!parsed) return null;
    handleReport(parsed, nowMs, opts);
    return parsed;
  }

  function handleReport(parsed, nowMs, opts) {
    var res = trackReport(tracker, parsed, nowMs);
    if (!res) return;
    var st = res.state;
    for (var i = 0; i < res.effects.length; i++) {
      var eff = res.effects[i];
      if (eff.type === 'sound') {
        safeSound(eff.name);
      } else if (eff.type === 'tts') {
        // Training reports stay silent on the live feed; the demo opts in.
        if (st.isTraining && !(opts && opts.allowTrainingTts)) continue;
        speakTts(eff.messages, st.eventId);
      }
    }
    // System notification for a brand-new first report (mirrors the EEW1
    // sound gate: serial 1 only, never for training/cancel, live feed only).
    if (res.isNew && parsed.serial === 1 && !st.isTraining && !parsed.isCancel) {
      notifySystemEew(parsed);
    }
    if (st.phase === 'canceled') {
      removeOverlay(st.eventId); // rings + marker off immediately
    } else {
      ensureOverlay(st);
      if (st.phase === 'final') scheduleFinalRemoval(st);
    }
    refreshPanel();
  }

  // --- Leaflet overlays ---

  function hypoIcon(isAssumption, isWarn) {
    var glyph = isAssumption ? '○' : '✕';
    var color = isWarn ? S_COLOR_WARN : S_COLOR_FORECAST;
    return L.divIcon({
      className: 'rt-eew-hypo',
      html: '<div style="width:24px;height:24px;line-height:24px;text-align:center;' +
        'font-size:22px;font-weight:900;color:' + color + ';' +
        'text-shadow:0 0 4px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.9);pointer-events:none">' +
        glyph + '</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  function ensureOverlay(st) {
    if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
    var latest = st.latest;
    if (!latest || latest.lat == null || latest.lng == null) return;
    var rt = runtime[st.eventId];
    var ll = [latest.lat, latest.lng];
    if (!rt) {
      var group = L.layerGroup();
      var marker = L.marker(ll, {
        icon: hypoIcon(latest.isAssumption, latest.isWarn),
        interactive: false, keyboard: false, zIndexOffset: 900
      });
      var pRing = L.circle(ll, {
        radius: 0, color: P_COLOR, weight: 2, opacity: 0, fillOpacity: 0, interactive: false
      });
      var sRing = L.circle(ll, {
        radius: 0, color: (latest.isWarn ? S_COLOR_WARN : S_COLOR_FORECAST),
        weight: 2.5, opacity: 0, fillOpacity: 0, interactive: false
      });
      group.addLayer(marker);
      group.addLayer(pRing);
      group.addLayer(sRing);
      group.addTo(map);
      runtime[st.eventId] = {
        group: group, marker: marker, pRing: pRing, sRing: sRing,
        pShown: false, sShown: false, finalTimer: null
      };
    } else {
      rt.marker.setLatLng(ll);
      rt.pRing.setLatLng(ll);
      rt.sRing.setLatLng(ll);
      rt.marker.setIcon(hypoIcon(latest.isAssumption, latest.isWarn));
      rt.sRing.setStyle({ color: (latest.isWarn ? S_COLOR_WARN : S_COLOR_FORECAST) });
    }
  }

  function scheduleFinalRemoval(st) {
    if (st.eventId === DEMO_EVENT_ID && demoPinned) return; // RTDemo owns it
    var rt = runtime[st.eventId];
    if (!rt || rt.finalTimer) return;
    rt.finalTimer = setTimeout(function() {
      rt.finalTimer = null;
      removeOverlay(st.eventId);
      refreshPanel();
    }, FINAL_GRACE_MS);
  }

  function removeOverlay(eventId) {
    var rt = runtime[eventId];
    if (!rt) return;
    if (rt.finalTimer) { clearTimeout(rt.finalTimer); rt.finalTimer = null; }
    try { if (typeof map !== 'undefined' && map && rt.group) map.removeLayer(rt.group); } catch (e) {}
    delete runtime[eventId];
  }

  function removeAllOverlays() {
    for (var id in runtime) removeOverlay(id);
  }

  // The static WarnArea layers (47-prefecture fallback + 188 EEW areas) used
  // to survive stop() on the map — a realtime on/off cycle left them stacked.
  function removeStaticOverlays() {
    try { if (prefLayer && typeof map !== 'undefined' && map) map.removeLayer(prefLayer); } catch (e) {}
    prefLayer = null;
    prefNamJaList = null;
    try { if (eewArea.layer && typeof map !== 'undefined' && map) map.removeLayer(eewArea.layer); } catch (e) {}
    eewArea.layer = null;
    eewArea.centroids = {};
  }

  function applyRadius(rt, ringKey, shownKey, km) {
    var ring = rt[ringKey];
    if (!ring) return;
    if (km > 0) {
      ring.setRadius(km * 1000);
      if (!rt[shownKey]) { ring.setStyle({ opacity: 0.9, fillOpacity: 0.05 }); rt[shownKey] = true; }
    } else if (rt[shownKey]) {
      ring.setStyle({ opacity: 0, fillOpacity: 0 });
      rt[shownKey] = false;
    }
  }

  // Shared ~250 ms ring-growth timer. Final events keep growing — the waves
  // are still propagating after the last report (kanameishi parity); only
  // canceled events freeze in place, and the grace timer / expiry sweep
  // handles removal.
  function tick() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (typeof Physics === 'undefined') return;
    var now = Date.now();
    var pSpeed = speedOf('pWaveSpeed', 5.8);
    var sSpeed = speedOf('sWaveSpeed', 3.3);
    for (var id in runtime) {
      var st = tracker.events[id];
      if (!st || !st.latest || (st.phase !== 'active' && st.phase !== 'final')) continue;
      var depth = (st.latest.depth != null) ? st.latest.depth : DEFAULT_DEPTH_KM;
      var el = elapsedSec(st, now);
      var rt = runtime[id];
      applyRadius(rt, 'pRing', 'pShown', waveRadiusKm(Physics.pTravelTime, depth, pSpeed, el, MAX_RADIUS_KM));
      applyRadius(rt, 'sRing', 'sShown', waveRadiusKm(Physics.sTravelTime, depth, sSpeed, el, MAX_RADIUS_KM));
    }
    updateCountdown(now);
  }

  // --- S-wave countdown in the EEW box (panel-displayed event only) ---

  // The countdown div lives inside the box's .eew-detail; created on demand.
  function countdownDiv(create) {
    var box = document.getElementById('eew-info-box');
    if (!box) return null;
    var detail = box.querySelector('.eew-detail');
    if (!detail) return null;
    var div = detail.querySelector('#eew-countdown');
    if (!div && create) {
      div = document.createElement('div');
      div.id = 'eew-countdown';
      detail.insertBefore(div, detail.querySelector('#eew-accuracy')); // keep the accuracy badge last
    }
    return div;
  }

  function hideCountdown() {
    var div = countdownDiv(false);
    if (div) div.style.display = 'none';
    cdWarn.eventId = null; // re-arm the countdown warning for the next event
  }

  // Countdown-warning threshold in seconds (0 = off), persisted in localStorage.
  function countdownWarnThresholdSec() {
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem('qs-countdown-sec');
        if (raw !== null) {
          var v = Number(raw);
          if (isFinite(v)) return Math.max(0, Math.min(300, v));
        }
      }
    } catch (e) {}
    return 30;
  }

  // Per-tick countdown warning for the panel event: one attention alert
  // (sound + JP speech) when the S wave at the reference point crosses the
  // configured threshold, then a short tick every second for the last
  // min(threshold, 10) seconds. Gated on the GMPE forecast at the reference
  // actually reaching shindo 1, so distant weak events never beep.
  function countdownWarnTick(st, remain, ref) {
    if (!st || st.eventId !== cdWarn.eventId) {
      cdWarn = { eventId: st ? st.eventId : null, fired: false, lastTickSec: -1 };
    }
    var thr = countdownWarnThresholdSec();
    if (!st || !ref || thr <= 0 || remain == null || remain <= 0 || remain > thr) return;
    var pred = forecastShindoAt(st.latest, ref.lat, ref.lng);
    if (!pred || shindoRank(pred) < shindoRank('1')) return;
    if (!cdWarn.fired) {
      cdWarn.fired = true;
      safeSound('PGA2');
      speakTts(['S波まで あと' + Math.ceil(remain) + '秒'], st.eventId);
    }
    var sec = Math.ceil(remain);
    if (sec <= Math.min(thr, 10) && sec !== cdWarn.lastTickSec) {
      cdWarn.lastTickSec = sec;
      safeSound('PGA1');
    }
  }

  // Scoped styles for the JS-built accuracy badge (no style.css edits).
  function ensureAccuracyStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('rt-eew-accuracy-style')) return;
    var st = document.createElement('style');
    st.id = 'rt-eew-accuracy-style';
    st.textContent =
      '#eew-accuracy{font-size:.68em;line-height:1.25;opacity:.7;margin-top:1px}' +
      '#eew-accuracy.low{color:#f5a623;opacity:1}';
    document.head.appendChild(st);
  }

  // Hypocenter-precision badge inside the box's .eew-detail; created on
  // demand, kept as the detail's last line (below the countdown).
  function accuracyDiv(create) {
    var box = document.getElementById('eew-info-box');
    if (!box) return null;
    var detail = box.querySelector('.eew-detail');
    if (!detail) return null;
    var div = detail.querySelector('#eew-accuracy');
    if (!div && create) {
      ensureAccuracyStyle();
      div = document.createElement('div');
      div.id = 'eew-accuracy';
      detail.appendChild(div);
    }
    return div;
  }

  function hideAccuracy() {
    var div = accuracyDiv(false);
    if (div) div.style.display = 'none';
  }

  function updateCountdown(nowMs) {
    if (typeof document === 'undefined') return;
    var st = (panelEventId && tracker.events[panelEventId]) || null;
    if (!st || st.phase !== 'active' || !st.latest || st.latest.lat == null || st.latest.lng == null) {
      hideCountdown();
      hideMainview();
      return;
    }
    var ref = referenceLatLng();
    if (!ref) { hideCountdown(); hideMainview(); return; }
    var depth = (st.latest.depth != null) ? st.latest.depth : DEFAULT_DEPTH_KM;
    var remain = countdownRemainSec(Physics.sTravelTime,
      haversineKm(ref.lat, ref.lng, st.latest.lat, st.latest.lng),
      depth, speedOf('sWaveSpeed', 3.3), elapsedSec(st, nowMs));
    if (remain === null) { hideCountdown(); hideMainview(); return; }
    countdownWarnTick(st, remain, ref);
    renderMainview(st, remain);
    var div = countdownDiv(true);
    if (!div) return;
    if (remain > 0) {
      div.textContent = tt('realtime.eew_s_countdown', 'S波まで あと ' + Math.ceil(remain) + '秒');
    } else {
      div.textContent = tt('realtime.eew_s_arrived', 'S波 到達') + ' +' + Math.floor(-remain) + '秒';
    }
    var urgent = remain < 10;
    div.style.color = urgent ? '#ff5147' : '';
    div.style.fontWeight = urgent ? 'bold' : '';
    div.style.display = '';
  }

  // --- EEW main view (dedicated large overlay while an event is active) ---

  function mainviewEnabled() {
    try {
      if (typeof localStorage !== 'undefined') {
        var v = localStorage.getItem(MAINVIEW_KEY);
        if (v !== null) return v === '1';
      }
    } catch (e) {}
    return true; // default on
  }

  function setMainviewEnabled(on) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(MAINVIEW_KEY, on ? '1' : '0');
    } catch (e) {}
    if (!on) hideMainview();
  }

  function mainviewEl() {
    return (typeof document !== 'undefined') ? document.getElementById('eew-mainview') : null;
  }

  function hideMainview() {
    var el = mainviewEl();
    if (el) el.style.display = 'none';
  }

  // Large map-top card: max predicted shindo, title/hypocenter, warn areas
  // and the big S-wave countdown at the reference point. Re-rendered every
  // tick from updateCountdown; visible only for the active panel event.
  function renderMainview(st, remain) {
    var el = mainviewEl();
    if (!el) return;
    if (!mainviewEnabled()) { hideMainview(); return; }
    // the dedicated EEW page shows its own large view — no double cards
    if (typeof document !== 'undefined' && document.body &&
        document.body.classList && document.body.classList.contains('eew-page-mode')) {
      hideMainview(); return;
    }
    // Upstream feed strings go through innerHTML here — escape them (the
    // panel path uses textContent; this card used to interpolate raw).
    var esc = (typeof SimUtils !== 'undefined' && SimUtils.escapeHTML) ? SimUtils.escapeHTML : function(s) {
      return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    };
    var latest = st.latest;
    var isWarn = !!latest.isWarn;
    var sh = latest.maxInt || '?';
    var html = '<div class="mv-shindo" style="background:' + shindoFill(sh) + '">' +
      '<span class="mv-shindo-cap">' + tt('realtime.mv_max', '最大震度') + '</span>' +
      '<span class="mv-shindo-val">' + esc(sh) + '</span></div>';
    html += '<div class="mv-mid">' +
      '<div class="mv-title">' + (isWarn ? tt('realtime.eew_warn', 'EEW警報') : tt('realtime.eew_forecast', 'EEW予報')) +
        ' ' + ttv('realtime.eew_report_n', '第' + st.serial + '報', { n: st.serial }) + (st.isTraining ? ' (' + tt('realtime.eew_training', '訓練') + ')' : '') + '</div>' +
      '<div class="mv-hypo">' + esc(latest.place || '?') + '  M' + Number(latest.mag).toFixed(1) +
        '  ' + tt('realtime.mv_depth', '深さ') + ' ' + ((latest.depth != null) ? latest.depth : '?') + 'km</div>';
    if (latest.warnAreas && latest.warnAreas.length) {
      var names = [];
      for (var i = 0; i < latest.warnAreas.length && names.length < 8; i++) {
        if (latest.warnAreas[i] && latest.warnAreas[i].name) names.push(esc(latest.warnAreas[i].name));
      }
      if (names.length) {
        if (latest.warnAreas.length > names.length) names.push('…');
        html += '<div class="mv-areas">' + names.join('・') + '</div>';
      }
    }
    html += '</div>';
    if (remain !== null && remain > 0) {
      html += '<div class="mv-count"><div class="mv-count-cap">' + tt('realtime.mv_s_until', 'S波まで') + '</div>' +
        '<div class="mv-count-num">' + Math.ceil(remain) + '<span class="mv-count-unit">' + tt('realtime.mv_sec', '秒') + '</span></div></div>';
    } else if (remain !== null) {
      html += '<div class="mv-count"><div class="mv-count-num mv-arrived">' + tt('realtime.mv_s_arrived', 'S波到達') + '</div></div>';
    }
    el.innerHTML = html;
    el.className = isWarn ? 'mv-warn' : '';
    el.style.display = 'flex';
  }

  // --- EEW info box panel ---

  function panelUntil(st) {
    if (st.phase === 'canceled') return (st.cancelAt || st.receivedAt) + CANCEL_GRACE_MS;
    if (st.phase === 'final') return (st.finalAt || st.receivedAt) + FINAL_GRACE_MS;
    return Infinity;
  }

  function orderKey(st) {
    return (st.latest && st.latest.announcedMs != null) ? st.latest.announcedMs : st.receivedAt;
  }

  // Most recent ACTIVE event wins (by announcedMs); canceled/final events
  // only show inside their grace windows when nothing active remains.
  function refreshPanel() {
    var now = Date.now();
    var best = null, bestGrace = null;
    for (var id in tracker.events) {
      var st = tracker.events[id];
      if (!st.latest) continue;
      if (st.phase === 'active') {
        if (!best || orderKey(st) > orderKey(best)) best = st;
      } else if (now < panelUntil(st)) {
        if (!bestGrace || orderKey(st) > orderKey(bestGrace)) bestGrace = st;
      }
    }
    var chosen = best || bestGrace;
    if (!chosen) { hidePanel(); restylePrefOverlay(); return; }
    renderPanel(chosen);
    restylePrefOverlay();
  }

  function renderPanel(st) {
    if (typeof document === 'undefined') return;
    var box = document.getElementById('eew-info-box');
    if (!box) return;
    panelEventId = st.eventId;
    var container = document.getElementById('eew-container');
    if (container && container.style.display !== 'flex') {
      container.style.display = 'flex';
      containerShown = true;
    }
    var latest = st.latest;
    var canceled = st.phase === 'canceled';
    var isWarn = latest.isWarn && !canceled;

    box.style.display = 'flex';
    box.style.borderColor = canceled ? BORDER_CANCEL : (isWarn ? BORDER_ALERT : BORDER_FORECAST);
    box.style.animation = isWarn ? 'eew-flash 0.5s infinite alternate' : 'none';

    var shVal = document.getElementById('eew-shindo-val');
    if (shVal) shVal.textContent = canceled ? '—' : (latest.maxInt || '?');
    var shBox = document.getElementById('eew-shindo-box');
    if (shBox) shBox.style.background = canceled ? '#444' : shindoFill(latest.maxInt);
    var bul = document.getElementById('eew-bulletin-text');
    if (bul) {
      if (canceled) {
        bul.textContent = tt('realtime.eew_cancel', 'EEW取消') + ' #' + st.serial;
      } else {
        bul.textContent = (isWarn ? tt('realtime.eew_warn', 'EEW警報') : tt('realtime.eew_forecast', 'EEW予報'))
          + ' #' + st.serial
          + (latest.isFinal ? ' ' + tt('realtime.eew_final', '最終報') : '')
          + (st.isTraining ? '(訓練)' : '');
      }
    }
    var magEl = document.getElementById('eew-mag-text');
    if (magEl) magEl.textContent = 'M' + latest.mag.toFixed(1);
    var depEl = document.getElementById('eew-depth-text');
    if (depEl) depEl.textContent = (latest.depth != null ? latest.depth : '?') + 'km';
    var timEl = document.getElementById('eew-time-text');
    if (timEl) timEl.textContent = latest.place || '?';
    var predEl = document.getElementById('eew-pred-text');
    if (predEl) {
      if (canceled) {
        setPredLines(predEl, '', '');
      } else {
        setPredLines(predEl,
          tt('realtime.eew_pred_max', '最大') + ' ' + (latest.maxInt || '?') + ' · ' +
            latest.warnAreas.length + tt('realtime.eew_pred_areas', '区域'),
          formatWarnAreas(latest.warnAreas, 3));
      }
    }
    // Hypocenter-precision badge: dim one-liner, amber when precision is low.
    var accEl = accuracyDiv(true);
    if (accEl) {
      if (!canceled && latest.accuracy) {
        accEl.textContent = formatAccuracy(latest.accuracy, currentLang());
        accEl.className = accuracyIsLow(latest.accuracy) ? 'low' : '';
        accEl.style.display = '';
      } else {
        accEl.style.display = 'none';
      }
    }
  }

  // Two-line prediction summary inside #eew-pred-text: '最大 6+ · 6区域' plus
  // the top warn areas. textContent only — area names come from the feed.
  function setPredLines(predEl, line1, line2) {
    var l1 = predEl.querySelector('.eew-pred-max');
    if (!l1) {
      l1 = document.createElement('div');
      l1.className = 'eew-pred-max';
      predEl.appendChild(l1);
    }
    l1.textContent = line1;
    var l2 = predEl.querySelector('.eew-warn-areas');
    if (!l2) {
      l2 = document.createElement('div');
      l2.className = 'eew-warn-areas';
      predEl.appendChild(l2);
    }
    l2.textContent = line2;
    l2.style.display = line2 ? '' : 'none';
  }

  // Hand the shared EEW box back in its default state so the sim's own
  // class-based styling keeps working (inline styles would otherwise win).
  function hidePanel() {
    if (!panelEventId && !containerShown) return; // only hide what we own
    panelEventId = null;
    if (typeof document === 'undefined') return;
    var box = document.getElementById('eew-info-box');
    if (box) {
      box.style.display = '';
      box.style.animation = '';
      box.style.borderColor = '';
    }
    hideAccuracy(); // no stale badge when the sim reuses the shared box
    if (containerShown) {
      var container = document.getElementById('eew-container');
      if (container) container.style.display = 'none';
      containerShown = false;
    }
  }

  // --- WarnArea map coloring ---
  // Preferred layer: JMA 緊急地震速報／府県予報区 polygons (~188 areas,
  // /geojson/jma_eew_areas.json). Areas named by the panel-displayed ACTIVE
  // event's WarnArea get their official predicted-shindo fill (Shindo2 worst
  // case, strong opacity); every other area gets a lighter GMPE model
  // forecast fill (Zhao 2006 at the area centroid) so the map shows the full
  // predicted shaking field, not just the warned subset. Fallback: the
  // legacy 47-prefecture fill when the granular geojson cannot be loaded.
  // Restyled on each panel refresh, so event end/cancel/expiry or a
  // displayed-event change clears it.

  var EEW_AREA_URL = '/geojson/jma_eew_areas.json';
  var STYLE_HIDDEN = { stroke: false, fill: false };
  var FORECAST_MIN_RANK = 3; // only paint model forecasts of predicted 震度3+

  var eewArea = { layer: null, loading: false, failedAt: 0, centroids: {} };

  function normChiikiName(s) {
    return normalizeFullwidthDigits(String(s || '')).replace(/[\s　]+/g, '');
  }

  function ensureEewAreaOverlay() {
    if (eewArea.layer || eewArea.loading) return;
    if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
    if (typeof fetch !== 'function') return;
    var now = Date.now();
    if (eewArea.failedAt && now - eewArea.failedAt < 60000) return; // 1 min retry backoff
    eewArea.loading = true;
    try {
      fetch(EEW_AREA_URL).then(function(res) {
        if (!res || !res.ok) throw new Error('eew area geojson http ' + (res && res.status));
        return res.json();
      }).then(function(geo) {
        eewArea.loading = false;
        if (!running) return; // stop() landed mid-fetch — do not rebuild
        try {
          buildEewAreaLayer(geo);
          restylePrefOverlay();
        } catch (e) { eewArea.failedAt = Date.now(); }
      }).catch(function() { eewArea.loading = false; eewArea.failedAt = Date.now(); });
    } catch (e) { eewArea.loading = false; eewArea.failedAt = now; }
  }

  function buildEewAreaLayer(geo) {
    if (eewArea.layer || !geo || !geo.features || !geo.features.length) return;
    eewArea.layer = L.geoJSON(geo, {
      interactive: false,
      style: function() { return { stroke: false, fill: false }; }
    });
    eewArea.centroids = {};
    eewArea.layer.eachLayer(function(ly) {
      var nm = normChiikiName(ly.feature && ly.feature.properties && ly.feature.properties.name);
      if (!nm) return;
      var c = featureCentroidLatLng(ly.feature);
      if (c) eewArea.centroids[nm] = c;
    });
    eewArea.layer.addTo(map);
  }

  // Area centroid for the GMPE forecast: turf.centroid when available, else
  // the polygon bbox center (accurate enough at sub-prefecture scale).
  function featureCentroidLatLng(f) {
    try {
      if (typeof turf !== 'undefined' && turf && typeof turf.centroid === 'function') {
        var c = turf.centroid(f);
        var co = c && c.geometry && c.geometry.coordinates;
        if (co && isFinite(co[0]) && isFinite(co[1])) return { lat: co[1], lng: co[0] };
      }
    } catch (e) {}
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, seen = false;
    (function walk(coords) {
      if (!coords) return;
      for (var i = 0; i < coords.length; i++) {
        var pt = coords[i];
        if (typeof pt[0] === 'number') {
          seen = true;
          if (pt[1] < minLat) minLat = pt[1];
          if (pt[1] > maxLat) maxLat = pt[1];
          if (pt[0] < minLng) minLng = pt[0];
          if (pt[0] > maxLng) maxLng = pt[0];
        } else walk(pt);
      }
    })(f && f.geometry && f.geometry.coordinates);
    return seen ? { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 } : null;
  }

  // GMPE model forecast at a point for the panel-displayed event: Zhao 2006
  // PGA/PGV at hypocentral range -> JMA instrumental intensity -> shindo
  // band string. '' when Physics or usable hypocenter parameters are missing.
  function forecastShindoAt(latest, lat, lng) {
    if (!latest || latest.lat == null || latest.lng == null) return '';
    if (typeof Physics === 'undefined' || !Physics.pgaZhao2006 || !Physics.calcJmaIntensity) return '';
    var mag = Number(latest.mag);
    if (!isFinite(mag) || mag <= 0) return '';
    var depth = (latest.depth != null && Number(latest.depth) > 0) ? Number(latest.depth) : DEFAULT_DEPTH_KM;
    var dKm = haversineKm(Number(latest.lat), Number(latest.lng), lat, lng);
    var rKm = Math.sqrt(dKm * dKm + depth * depth);
    var src = latest.isSea ? 'interplate' : (depth > 50 ? 'intraslab' : 'crustal');
    var pga = Physics.pgaZhao2006(mag, rKm, depth, src);
    var pgv = Physics.pgvZhao2006(mag, rKm, depth, src);
    if (!isFinite(pga) || !isFinite(pgv)) return '';
    var fI = Physics.calcJmaIntensity(pga, pgv);
    if (Physics.calibrateIntensity) fI = Physics.calibrateIntensity(fI, mag, {model: 'zhao2006', distKm: rKm});
    return String(Physics.intensityToShindo(fI));
  }

  function ensurePrefOverlay() {
    if (prefLayer || prefLoading) return;
    if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
    if (typeof fetch !== 'function') return;
    var now = Date.now();
    if (prefFailedAt && now - prefFailedAt < 60000) return; // 1 min retry backoff
    prefLoading = true;
    try {
      fetch('/geojson/japan_prefectures.geojson').then(function(res) {
        if (!res || !res.ok) throw new Error('pref geojson http ' + (res && res.status));
        return res.json();
      }).then(function(geo) {
        prefLoading = false;
        if (!running) return; // stop() landed mid-fetch — do not rebuild
        try {
          buildPrefLayer(geo);
          restylePrefOverlay();
        } catch (e) { prefFailedAt = Date.now(); }
      }).catch(function() { prefLoading = false; prefFailedAt = Date.now(); });
    } catch (e) { prefLoading = false; prefFailedAt = now; }
  }

  function buildPrefLayer(geo) {
    if (prefLayer || !geo || !geo.features || !geo.features.length) return;
    var feats = geo.features.slice().sort(function(a, b) {
      return ((a.properties && a.properties.id) || 0) - ((b.properties && b.properties.id) || 0);
    });
    prefNamJaList = feats.map(function(f) { return (f.properties && f.properties.nam_ja) || ''; });
    prefLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      interactive: false,
      style: function() { return { stroke: false, fill: false }; }
    });
    prefLayer.addTo(map);
  }

  function restylePrefOverlay() {
    var st = (panelEventId && tracker.events[panelEventId]) || null;
    var latest = (st && st.phase === 'active') ? st.latest : null;
    var areas = (latest && latest.warnAreas) || [];

    // Granular EEW-area layer (preferred): official WarnArea fills win; the
    // remaining areas get the GMPE model forecast field at lighter opacity.
    if (eewArea.layer) {
      var official = {}; // normalized area name -> worst official shindo
      for (var i = 0; i < areas.length; i++) {
        var nm0 = normChiikiName(areas[i].name);
        if (!nm0) continue;
        var sh0 = warnAreaShindo(areas[i]);
        if (!official[nm0] || shindoRank(sh0) > shindoRank(official[nm0])) official[nm0] = sh0;
      }
      var canForecast = !!(latest && Number(latest.mag) > 0);
      eewArea.layer.eachLayer(function(ly) {
        var nm = normChiikiName(ly.feature && ly.feature.properties && ly.feature.properties.name);
        var osh = nm && official[nm];
        if (osh) {
          ly.setStyle({
            stroke: true, color: '#fff3', weight: 0.8, opacity: 1,
            fill: true, fillColor: shindoFill(osh), fillOpacity: 0.5
          });
          return;
        }
        if (canForecast && nm) {
          var c = eewArea.centroids[nm];
          var fsh = c ? forecastShindoAt(latest, c.lat, c.lng) : '';
          if (fsh && shindoRank(fsh) >= FORECAST_MIN_RANK) {
            ly.setStyle({ stroke: false, fill: true, fillColor: shindoFill(fsh), fillOpacity: 0.22 });
            return;
          }
        }
        ly.setStyle(STYLE_HIDDEN);
      });
      // The prefecture fallback stays transparent while the granular layer paints.
      if (prefLayer) prefLayer.eachLayer(function(ly) { ly.setStyle(STYLE_HIDDEN); });
      return;
    }

    // Prefecture fallback path; also kicks off the granular load.
    if (areas.length) ensureEewAreaOverlay();
    if (!prefLayer) {
      if (areas.length) ensurePrefOverlay(); // async; restyles itself on load
      return;
    }
    var colorById = {};
    if (areas.length) {
      var names = [];
      var i, a;
      for (i = 0; i < areas.length; i++) names.push(areas[i].name);
      var matched = matchWarnPrefectures(names, prefNamJaList);
      for (i = 0; i < areas.length; i++) {
        a = areas[i];
        var id = matched[a.name];
        if (!id) continue;
        var sh = warnAreaShindo(a);
        // Several Chiiki can map to one prefecture — keep the worst rank.
        if (!colorById[id] || shindoRank(sh) > shindoRank(colorById[id].sh)) {
          colorById[id] = { sh: sh, color: shindoFill(sh) };
        }
      }
    }
    prefLayer.eachLayer(function(ly) {
      var props = ly.feature && ly.feature.properties;
      var entry = props && colorById[props.id];
      if (entry) {
        ly.setStyle({
          stroke: true, color: '#fff3', weight: 0.8, opacity: 1,
          fill: true, fillColor: entry.color, fillOpacity: 0.45
        });
      } else {
        ly.setStyle({ stroke: false, fill: false });
      }
    });
  }

  // --- 2 s manager: attach/retry, realtime-mode gate, 120 s expiry ---

  function sweepExpiry() {
    var now = Date.now();
    var changed = false;
    for (var id in tracker.events) {
      if (demoPinned && id === DEMO_EVENT_ID) continue; // RTDemo owns it
      var st = tracker.events[id];
      if (now - st.receivedAt > EXPIRE_MS) {
        removeOverlay(id);
        delete tracker.events[id];
        changed = true;
      }
    }
    if (changed) refreshPanel();
  }

  function manage() {
    if (!isRtActive()) {
      if (wasActive || attachedSource) {
        detach();
        removeAllOverlays();
        tracker = createTracker();
        hidePanel();
        restylePrefOverlay();
      }
      wasActive = false;
      return;
    }
    wasActive = true;
    var ntpDue = ntpSynced ? NTP_REFRESH_MS : ntpRetryMs; // 30 s backoff doubling until the first sync lands
    if (Date.now() - ntpFetchedAtMs > ntpDue) fetchNtpOffset();
    fetchGeoip(); // self-throttled to one attempt per 5 min until a fix lands
    var src = (typeof RTData !== 'undefined' && typeof RTData.getP2PSource === 'function')
      ? RTData.getP2PSource() : null;
    if (src !== attachedSource) {
      if (src) attach(src); else detach();
    }
    sweepExpiry();
    refreshPanel();
  }

  // --- public lifecycle ---

  function start() {
    if (running) return;
    running = true;
    loadPersistedUserLoc();            // a saved manual pin beats geoIP
    if (!ntpFetchedAtMs) fetchNtpOffset(); // immediate sync; 30-min refresh in manage()
    fetchGeoip();                          // session-cached; no-op once a fix/pin exists
    ensureUserMarker();                    // redraw from cache after a stop/start cycle
    manage();
    mgrTimer = setInterval(manage, MANAGE_MS);
    tickTimer = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (!running) return;
    running = false;
    demoPinned = false;
    userLocPickArmed = false;
    if (mgrTimer) { clearInterval(mgrTimer); mgrTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    clearDemoTimers();
    detach();
    removeAllOverlays();
    removeStaticOverlays();
    tracker = createTracker();
    hidePanel();
    hideMainview();
    restylePrefOverlay();
    removeUserMarker();
    wasActive = false;
    // Session caches (NTP offset, geoIP fix, prefecture geojson) are kept
    // so a restart reuses them without refetching.
  }

  // --- client-side demo (training-flagged, feeds the real pipeline) ---

  function clearDemoTimers() {
    for (var i = 0; i < demoTimers.length; i++) clearTimeout(demoTimers[i]);
    demoTimers = [];
  }

  // Synthesize a 3-report Wolfx-shaped sequence (serial 1 forecast -> serial 2
  // warning -> serial 3 final) through the SAME ingest pipeline as live frames.
  // No-op returning false unless realtime mode is active. TTS is allowed: the
  // demo IS the demo. originBaseMs optionally pins the shared origin time so
  // RTDemo's station-reaction driver stays in sync with the rings.
  function demo(originBaseMs) {
    if (!isRtActive()) return false;
    start(); // make sure tick/manage timers run (idempotent)
    clearDemoTimers();
    // replay cleanly on repeated clicks: drop the previous demo event first
    if (tracker.events[DEMO_EVENT_ID]) {
      removeOverlay(DEMO_EVENT_ID);
      delete tracker.events[DEMO_EVENT_ID];
      refreshPanel();
    }
    var now = Date.now();
    var originMs = (typeof originBaseMs === 'number' && isFinite(originBaseMs)) ? originBaseMs : (now - 6000);
    var origin = jstString(originMs); // constant origin across all reports
    var mk = function(extra) {
      return Object.assign({
        type: 'jma_eew',
        Title: '緊急地震速報（予報）',
        EventID: DEMO_EVENT_ID,
        OriginTime: origin,
        Hypocenter: '紀伊半島沖',
        Latitude: 33.0, Longitude: 136.0, Depth: 20,
        isSea: true, isTraining: true, isAssumption: false,
        isWarn: false, isFinal: false, isCancel: false
      }, extra);
    };
    var report1 = mk({
      Serial: 1, Magunitude: 6.9, AnnouncedTime: jstString(now),
      MaxIntensity: { From: '4', To: '5-' },
      WarnArea: [
        { Chiiki: '和歌山県南部', Shindo1: '5-', Shindo2: '5-', Type: 'Warning', Arrive: false },
        { Chiiki: '三重県南部', Shindo1: '4', Shindo2: '5-', Type: 'Warning', Arrive: false },
        { Chiiki: '奈良県', Shindo1: '4', Shindo2: '4', Type: 'Warning', Arrive: false }
      ]
    });
    var warnAreas2 = [
      { Chiiki: '和歌山県南部', Shindo1: '6+', Shindo2: '6+', Type: 'Warning', Arrive: false },
      { Chiiki: '三重県南部', Shindo1: '5-', Shindo2: '5-', Type: 'Warning', Arrive: false },
      { Chiiki: '奈良県', Shindo1: '4', Shindo2: '4', Type: 'Warning', Arrive: false },
      { Chiiki: '大阪府南部', Shindo1: '5+', Shindo2: '5+', Type: 'Warning', Arrive: false },
      { Chiiki: '徳島県北部', Shindo1: '5-', Shindo2: '5-', Type: 'Warning', Arrive: false },
      { Chiiki: '香川県東部', Shindo1: '4', Shindo2: '4', Type: 'Warning', Arrive: false }
    ];
    var report2 = mk({
      Serial: 2, Magunitude: 7.1, AnnouncedTime: jstString(now + 4000),
      Title: '緊急地震速報（警報）', isWarn: true,
      MaxIntensity: { From: '5+', To: '6+' },
      WarnArea: warnAreas2
    });
    var report3 = mk({
      Serial: 3, Magunitude: 7.1, AnnouncedTime: jstString(now + 8000),
      Title: '緊急地震速報（警報）', isWarn: true, isFinal: true,
      MaxIntensity: { From: '5+', To: '6+' },
      WarnArea: warnAreas2
    });
    var opts = { allowTrainingTts: true };
    ingestRaw(report1, now, opts);
    demoTimers.push(setTimeout(function() {
      if (isRtActive()) ingestRaw(report2, Date.now(), opts);
    }, 4000));
    demoTimers.push(setTimeout(function() {
      if (isRtActive()) ingestRaw(report3, Date.now(), opts);
    }, 8000));
    return true;
  }

  // RTDemo coordination: pin the demo event (rings stay for the whole
  // rehearsal) and remove it on demand so everything closes together.
  function setDemoPinned(on) { demoPinned = !!on; }
  function clearDemo() {
    clearDemoTimers();
    if (tracker.events[DEMO_EVENT_ID]) {
      removeOverlay(DEMO_EVENT_ID);
      delete tracker.events[DEMO_EVENT_ID];
      refreshPanel();
    }
  }

  // Diagnostic snapshot of every tracked event (active/final/canceled).
  function getActive() {
    var out = [];
    for (var id in tracker.events) {
      var st = tracker.events[id];
      out.push({
        eventId: st.eventId,
        serial: st.serial,
        phase: st.phase,
        offsetMs: st.offsetMs,
        receivedAt: st.receivedAt,
        isTraining: st.isTraining,
        latest: st.latest
      });
    }
    out.sort(function(a, b) { return orderKey(b) - orderKey(a); });
    return out;
  }

  return {
    // lifecycle
    start: start,
    stop: stop,
    getActive: getActive,
    demo: demo,
    setDemoPinned: setDemoPinned,
    clearDemo: clearDemo,
    // diagnostics
    getClockOffsetMs: getClockOffsetMs,
    refreshNtp: fetchNtpOffset,
    // user location (manual pin / map pick) + countdown warning + main view
    setUserLocation: setUserLocation,
    clearUserLocation: clearUserLocation,
    getUserLocation: getUserLocation,
    validateUserLatLng: validateUserLatLng,
    armUserLocPick: armUserLocPick,
    cancelUserLocPick: cancelUserLocPick,
    isUserLocPickArmed: isUserLocPickArmed,
    completeUserLocPick: completeUserLocPick,
    countdownWarnThresholdSec: countdownWarnThresholdSec,
    mainviewEnabled: mainviewEnabled,
    setMainviewEnabled: setMainviewEnabled,
    // pure helpers (exported for node tests)
    parseWolfx: parseWolfx,
    parseJstMs: parseJstMs,
    formatAccuracy: formatAccuracy,
    accuracyIsLow: accuracyIsLow,
    waveRadiusKm: waveRadiusKm,
    createTracker: createTracker,
    trackReport: trackReport,
    reduceEvent: reduceEvent,
    elapsedSec: elapsedSec,
    clampOffsetMs: clampOffsetMs,
    shindoToJp: shindoToJp,
    shindoRank: shindoRank,
    formatWarnAreas: formatWarnAreas,
    matchWarnPrefectures: matchWarnPrefectures,
    normChiikiName: normChiikiName,
    forecastShindoAt: forecastShindoAt,
    featureCentroidLatLng: featureCentroidLatLng,
    // Diagnostics for probes/tests: granular-layer state + currently painted fills.
    _eewAreaDebug: function() {
      var out = { loaded: !!eewArea.layer, features: 0, fills: [] };
      if (eewArea.layer) eewArea.layer.eachLayer(function(ly) {
        out.features++;
        var o = ly.options || {};
        if (o.fill) out.fills.push({
          name: ly.feature && ly.feature.properties && ly.feature.properties.name,
          fillColor: o.fillColor, fillOpacity: o.fillOpacity, stroke: !!o.stroke
        });
      });
      return out;
    },
    haversineKm: haversineKm,
    countdownRemainSec: countdownRemainSec,
    jstString: jstString,
    _setClockOffsetMs: _setClockOffsetMs
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RTEew;
