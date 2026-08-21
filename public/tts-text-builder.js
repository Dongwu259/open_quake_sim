// SREV-compatible Japanese announcement text builder.
// Pure UMD module: usable in the browser and in Node.js unit tests.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TTSTextBuilder = factory();
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var T = {};
  T.DEFAULT_VOICE = 'ja-JP-NanamiNeural';
  T.MAX_TEXT_LENGTH = 300;
  T.SREV_CHUNK_LENGTH = 128;

  var EPICENTER_NAMES = {
    tohoku: '三陸沖',
    nankaiM9: '紀伊半島沖',
    kobe: '淡路島北部',
    kumamoto: '熊本県熊本地方',
    kanto: '相模湾北西部',
    chuetsu: '新潟県中越地方',
    iburihigashi: '胆振地方中東部',
    noto2024: '石川県能登地方',
    tokachi2003: '十勝沖',
    iwate2008: '岩手県内陸南部',
    noto2007: '能登半島沖',
    fukuoka2005: '福岡県西方沖',
    fukushima2011: '福島県浜通り',
    tottori2016: '鳥取県中部',
    yamagata2019: '山形県沖',
    fukushima2021: '福島県沖',
    kushiro1993: '釧路沖',
    tonankai1944: '熊野灘',
    nankai1946: '和歌山県南方沖',
    niigata1964: '新潟県下越沖'
  };

  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function uniqueNames(values, limit) {
    var out = [];
    var seen = Object.create(null);
    values = Array.isArray(values) ? values : [];
    for (var i = 0; i < values.length && out.length < limit; i++) {
      var value = clean(values[i]);
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
  }

  T.shindoText = function(shindo) {
    var key = String(shindo == null ? '0' : shindo);
    var labels = {
      '0':'0', '1':'1', '2':'2', '3':'3', '4':'4',
      '5-':'5弱', '5+':'5強', '5.5':'5強',
      '6-':'6弱', '6+':'6強', '6.5':'6強', '7':'7'
    };
    if (labels[key]) return labels[key];
    var numeric = Number(shindo);
    if (!Number.isFinite(numeric)) return '不明';
    if (numeric >= 7) return '7';
    if (numeric >= 6.5) return '6強';
    if (numeric >= 6) return '6弱';
    if (numeric >= 5.5) return '5強';
    if (numeric >= 5) return '5弱';
    return String(Math.max(0, Math.round(numeric)));
  };

  T.formatJstTime = function(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (!date || !Number.isFinite(date.getTime())) return '';
    var jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    var hour24 = jst.getUTCHours();
    var minute = jst.getUTCMinutes();
    var period = hour24 < 12 ? '午前' : '午後';
    var hour12 = hour24 % 12 || 12;
    return period + hour12 + '時' + minute + '分' + (minute === 0 ? '' : 'ごろ');
  };

  T.getEpicenterName = function(presetId, ocean) {
    return EPICENTER_NAMES[presetId] || (ocean ? '日本近海' : '日本付近');
  };

  T.EEW_AREA_LIMIT = 5;

  T.buildEEW = function(options) {
    options = options || {};
    // JMA-style brevity: only the handful of hardest-hit names are spoken;
    // a longer predicted list collapses to "X、Y、Zなど".
    var allAreas = uniqueNames(options.areas, 20);
    var areas = allAreas.slice(0, T.EEW_AREA_LIMIT);
    var areaText = areas.length
      ? areas.join('、') + (allAreas.length > areas.length ? 'など' : '')
      : '対象地域';
    var text = '緊急地震速報。' + areaText + 'では、強い揺れに警戒してください！';
    if (text.length > T.MAX_TEXT_LENGTH) {
      text = '緊急地震速報。対象地域では、強い揺れに警戒してください！';
    }
    return text;
  };

  T.buildEEWCancellation = function() {
    return '先ほどの緊急地震速報は、キャンセルされました。';
  };

  T.buildEstimatedIntensity = function(options) {
    options = options || {};
    var location = clean(options.location) || '観測点';
    var first = options.update ? location + 'で地震。' : location + 'で地震を検知。';
    var estimated = options.maxShindo == null
      ? '震度推定なし。'
      : '推定最大震度' + T.shindoText(options.maxShindo) + '。';
    return first + estimated;
  };

  T.buildIntensitySurvey = function() {
    return '各地の震度を調査しています。詳しい情報が分かり次第、お伝えします。';
  };

  function observedText(options) {
    var shindo = T.shindoText(options.maxShindo);
    var areas = uniqueNames(options.maxAreas || options.maxPrefectures, 16);
    return areas.length
      ? '最大震度' + shindo + 'を' + areas.join('、') + 'で観測しました。'
      : '最大震度' + shindo + 'を観測しました。';
  }

  function sourceText(options) {
    var depth = options.depth == null || options.depth === '' ? NaN : Number(options.depth);
    var depthText;
    if (!Number.isFinite(depth)) depthText = '震源の深さは不明。';
    else if (options.veryShallow === true || depth <= 0) depthText = '震源の深さはごく浅い。';
    else depthText = '震源の深さは' + Math.max(0, Math.round(depth)) + 'キロ。';
    var magnitude = options.magnitude == null || options.magnitude === '' ? NaN : Number(options.magnitude);
    var magnitudeText;
    if (!Number.isFinite(magnitude)) magnitudeText = '地震の規模を示すマグニチュードは、不明です。';
    else if (magnitude > 8) magnitudeText = '地震の規模は、マグニチュード8を超える、巨大地震と推定されています。';
    else magnitudeText = '地震の規模を示すマグニチュードは、' + magnitude.toFixed(1) + 'と推定されています。';
    // The epicenter is not repeated here: callers already announce
    // "Xを震源とする地震がありました" in the same product.
    return depthText + magnitudeText;
  }

  T.tsunamiText = function(status) {
    if (status === 'active') return '現在、津波予報等を発表中です。';
    if (status === 'seaLevel') return 'この地震により、日本の沿岸では、若干の海面変動があるかもしれませんが、被害の心配はありません。';
    if (status === 'investigating') return '今後の情報に注意してください。';
    return 'この地震による、津波の心配はありません。';
  };

  T.buildIntensityBulletin = function(options) {
    options = options || {};
    var time = T.formatJstTime(options.time);
    return '震度速報。' + (time ? time + '、' : '') + observedText(options);
  };

  T.buildHypocenterBulletin = function(options) {
    options = options || {};
    var time = T.formatJstTime(options.time);
    var epicenter = clean(options.epicenter) || '日本付近';
    return '震源情報。' + (time ? time + '、' : '') + epicenter + 'を震源とする地震がありました。' +
      sourceText(options) + T.tsunamiText(options.tsunamiStatus);
  };

  T.buildCombinedBulletin = function(options) {
    options = options || {};
    var time = T.formatJstTime(options.time);
    var epicenter = clean(options.epicenter) || '日本付近';
    return '地震情報。' + (time ? time + '、' : '') + epicenter + 'を震源とする地震がありました。' +
      observedText(options) + sourceText(options) + T.tsunamiText(options.tsunamiStatus);
  };

  T.buildInformationCancellation = function(type) {
    var labels = {
      intensity:'震度速報', hypocenter:'震源情報', combined:'地震情報',
      distant:'遠地地震に関する情報', eruption:'遠地噴火に関する情報',
      significant:'震源更新情報', longPeriod:'長周期地震動に関する観測情報'
    };
    return '先ほどの' + (labels[type] || '地震情報') + 'は、キャンセルされました。';
  };

  T.buildSourceRevision = function(options) {
    return '震源が更新されました。' + T.buildHypocenterBulletin(options).replace(/^震源情報。/, '');
  };

  T.buildTsunamiForecast = function(options) {
    options = options || {};
    var labels = {major:'大津波警報',warn:'津波警報',adv:'津波注意報'};
    var label = labels[options.level] || '津波予報';
    var areas = uniqueNames(options.areas, 20);
    var areaText = areas.length ? areas.join('、') : '対象地域';
    var height = clean(options.height);
    // First issuance announces the warning; later signature changes are updates.
    var opener = options.updated === false
      ? label + 'が発表されました。' + areaText + 'に発表されています。'
      : label + 'の内容が、更新されました。' + label + 'が、次の地域に発表されています。' + areaText + '。';
    // First-wave arrival estimate rides only on the first issuance, like the
    // real bulletin (大波の到達予想時刻).
    var eta = '';
    if (options.updated === false && Number.isFinite(options.etaMin)) {
      eta = options.etaMin <= 0.5
        ? '第一波は、まもなく到達します。'
        : '第一波は、早いところで、約' + Math.max(1, Math.round(options.etaMin)) + '分後に到達すると予想されます。';
    }
    return opener + (height ? '予想される津波の高さは、' + height + 'です。' : '') + eta;
  };

  T.buildTsunamiObservation = function(options) {
    options = options || {};
    var areas = uniqueNames(options.areas, 20);
    var areaText = areas.length ? areas.join('、') : '沿岸';
    var height = clean(options.height);
    return '津波観測に関する情報。' + areaText + '。現在、' +
      (options.updated ? '新たに観測された、' : '') + '津波の最大波の観測値をお知らせします。' +
      (height ? '最大波は、' + height + 'です。' : '');
  };

  T.buildEarthquake = function(options) {
    options = options || {};
    var time = T.formatJstTime(options.time);
    var epicenter = clean(options.epicenter) || '日本付近';
    var shindo = T.shindoText(options.maxShindo);
    var prefs = uniqueNames(options.maxPrefectures, 8);
    var observed = prefs.length
      ? '最大震度' + shindo + 'を' + prefs.join('、') + 'で観測しました。'
      : '最大震度' + shindo + 'を観測しました。';
    var depth = Number(options.depth);
    var depthText = Number.isFinite(depth) && depth >= 0 && depth < 10
      ? '深さはごく浅い。'
      : '深さ' + Math.max(0, Math.round(Number.isFinite(depth) ? depth : 0)) + 'キロメートル。';
    var magnitude = Number(options.magnitude);
    var magText = Number.isFinite(magnitude) ? magnitude.toFixed(1) : '不明';
    var tsunami = Number(options.tsunamiLevel) > 0
      ? '現在、津波予報等を発表中です。'
      : 'この地震による、津波の心配はありません。';
    var prefix = '地震情報。' + (time ? time + '、' : '');
    // The epicenter appears once, in the opening sentence.
    var suffix = depthText + 'マグニチュード' + magText + '。' + tsunami;
    var text = prefix + epicenter + 'を震源とする地震がありました。' + observed + suffix;

    // Preserve complete sentences when a long prefecture list would exceed
    // the upstream limit. The generic observed sentence is still SREV-compatible.
    if (text.length > T.MAX_TEXT_LENGTH && prefs.length) {
      observed = '最大震度' + shindo + 'を観測しました。';
      text = prefix + epicenter + 'を震源とする地震がありました。' + observed + suffix;
    }
    return text.slice(0, T.MAX_TEXT_LENGTH);
  };

  return T;
}));
