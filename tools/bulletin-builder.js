// ================================================================
//  Bulletin Builder — TTS audio fragment playlist construction
//  Shared module: usable from Node.js (require) and browser (window)
//  Pure functions. No DOM, no Web Audio, no side effects.
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.BulletinBuilder = factory(); }
}(typeof self !== 'undefined' ? self : this, function() {

var B = {};

// ---- Shindo helpers (self-contained, no Physics dependency) ----

var SHINDO_SCORE = {0:0,1:1,2:2,3:3,4:4,'5-':4.75,'5+':5.25,'6-':5.75,'6+':6.25,7:6.75};

function shindoScore(s) {
  if (SHINDO_SCORE.hasOwnProperty(s)) return SHINDO_SCORE[s];
  var n = Number(s);
  return isNaN(n) ? 0 : n;
}

function shindoNum(s) {
  if (typeof s === 'number') return Math.floor(s);
  var m = String(s).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---- Intensity fragment name mapping ----

function intensityFragment(shindo) {
  if (shindo === '7' || shindo === 7) return 'int_7';
  if (shindo === '6+' || shindo === 6.5) return 'int_6p';
  if (shindo === '6-' || shindo === '6') return 'int_6m';  // note: numeric 6 → int_6m for prefecture
  if (shindo === '5+' || shindo === 5.5) return 'int_5p';
  if (shindo === '5-' || shindo === 5) return 'int_5m';
  if (shindo === 4 || shindo === '4') return 'int_4';
  if (shindo === 3 || shindo === '3') return 'int_3';
  return 'int_0';
}

// Different mapping for max-shindo announcement (numeric 5/6 treated as strong)
function maxIntensityFragment(smax) {
  if (smax === '7' || smax === 7) return 'int_7';
  if (smax === '6+' || smax === 6.5) return 'int_6p';
  if (smax === '6-') return 'int_6m';
  if (smax === '5+' || smax === 5.5) return 'int_5p';
  if (smax === '5-') return 'int_5m';
  if (smax === 6) return 'int_6p';     // numeric 6 → 6+
  if (smax === 5) return 'int_5p';     // numeric 5 → 5+
  if (smax === 4 || smax === '4') return 'int_4';
  if (smax === 3 || smax === '3') return 'int_3';
  return 'int_0';
}

// ---- Number fragment helpers ----

function numFragment(n) {
  return 'num_' + String(n).padStart(2, '0');
}

function digitsFragments(num) {
  var s = String(Math.round(num));
  var frags = [];
  for (var i = 0; i < s.length; i++) {
    frags.push('num_0' + s[i]);
  }
  return frags;
}

// ---- Text transcript mappings (Phase 2: populate fragment text field) ----

var PREFECTURE_NAMES = {
  jp: {'01':'北海道','02':'青森県','03':'岩手県','04':'宮城県','05':'秋田県','06':'山形県','07':'福島県','08':'茨城県','09':'栃木県','10':'群馬県','11':'埼玉県','12':'千葉県','13':'東京都','14':'神奈川県','15':'新潟県','16':'富山県','17':'石川県','18':'福井県','19':'山梨県','20':'長野県','21':'岐阜県','22':'静岡県','23':'愛知県','24':'三重県','25':'滋賀県','26':'京都府','27':'大阪府','28':'兵庫県','29':'奈良県','30':'和歌山県','31':'鳥取県','32':'島根県','33':'岡山県','34':'広島県','35':'山口県','36':'徳島県','37':'香川県','38':'愛媛県','39':'高知県','40':'福岡県','41':'佐賀県','42':'長崎県','43':'熊本県','44':'大分県','45':'宮崎県','46':'鹿児島県','47':'沖縄県'},
  en: {'01':'Hokkaido','02':'Aomori Prefecture','03':'Iwate Prefecture','04':'Miyagi Prefecture','05':'Akita Prefecture','06':'Yamagata Prefecture','07':'Fukushima Prefecture','08':'Ibaraki Prefecture','09':'Tochigi Prefecture','10':'Gunma Prefecture','11':'Saitama Prefecture','12':'Chiba Prefecture','13':'Tokyo Metropolis','14':'Kanagawa Prefecture','15':'Niigata Prefecture','16':'Toyama Prefecture','17':'Ishikawa Prefecture','18':'Fukui Prefecture','19':'Yamanashi Prefecture','20':'Nagano Prefecture','21':'Gifu Prefecture','22':'Shizuoka Prefecture','23':'Aichi Prefecture','24':'Mie Prefecture','25':'Shiga Prefecture','26':'Kyoto Prefecture','27':'Osaka Prefecture','28':'Hyogo Prefecture','29':'Nara Prefecture','30':'Wakayama Prefecture','31':'Tottori Prefecture','32':'Shimane Prefecture','33':'Okayama Prefecture','34':'Hiroshima Prefecture','35':'Yamaguchi Prefecture','36':'Tokushima Prefecture','37':'Kagawa Prefecture','38':'Ehime Prefecture','39':'Kochi Prefecture','40':'Fukuoka Prefecture','41':'Saga Prefecture','42':'Nagasaki Prefecture','43':'Kumamoto Prefecture','44':'Oita Prefecture','45':'Miyazaki Prefecture','46':'Kagoshima Prefecture','47':'Okinawa Prefecture'},
  zh: {'01':'北海道','02':'青森县','03':'岩手县','04':'宫城县','05':'秋田县','06':'山形县','07':'福岛县','08':'茨城县','09':'栃木县','10':'群马县','11':'埼玉县','12':'千叶县','13':'东京都','14':'神奈川县','15':'新潟县','16':'富山县','17':'石川县','18':'福井县','19':'山梨县','20':'长野县','21':'岐阜县','22':'静冈县','23':'爱知县','24':'三重县','25':'滋贺县','26':'京都府','27':'大阪府','28':'兵库县','29':'奈良县','30':'和歌山县','31':'鸟取县','32':'岛根县','33':'冈山县','34':'广岛县','35':'山口县','36':'德岛县','37':'香川县','38':'爱媛县','39':'高知县','40':'福冈县','41':'佐贺县','42':'长崎县','43':'熊本县','44':'大分县','45':'宫崎县','46':'鹿儿岛县','47':'冲绳县'}
};

var PHRASE_TEXT = {
  jp: {ph_hour:'時', ph_min:'分', ph_intro1:'震度速報', ph_intro2:'が発表されました', ph_mag:'マグニチュード', ph_depth:'深さ', ph_km:'キロメートル', ph_decimal:'点', ph_tsu_major:'大津波警報', ph_tsu_warning:'津波警報', ph_tsu_advisory:'津波注意報', ph_affected:'震度が観測された地域は'},
  en: {ph_intro1:'Seismic Intensity Report', ph_intro2:'has been issued', ph_mag:'Magnitude', ph_depth:'Depth', ph_km:'kilometers', ph_decimal:'point', ph_tsu_major:'Major tsunami warning', ph_tsu_warning:'Tsunami warning', ph_tsu_advisory:'Tsunami advisory', ph_affected:'Areas with observed intensity'},
  zh: {ph_hour:'时', ph_min:'分', ph_intro1:'震度速报', ph_intro2:'已发布', ph_mag:'震级', ph_depth:'深度', ph_km:'公里', ph_decimal:'点', ph_tsu_major:'大海啸警报', ph_tsu_warning:'海啸警报', ph_tsu_advisory:'海啸注意报', ph_affected:'观测到震度的地区如下'}
};

var INTENSITY_TEXT = {
  jp: {int_0:'震度0', int_1:'震度1', int_2:'震度2', int_3:'震度3', int_4:'震度4', int_5m:'震度5弱', int_5p:'震度5強', int_6m:'震度6弱', int_6p:'震度6強', int_7:'震度7'},
  en: {int_0:'Intensity 0', int_1:'Intensity 1', int_2:'Intensity 2', int_3:'Intensity 3', int_4:'Intensity 4', int_5m:'Intensity 5-', int_5p:'Intensity 5+', int_6m:'Intensity 6-', int_6p:'Intensity 6+', int_7:'Intensity 7'},
  zh: {int_0:'震度0', int_1:'震度1', int_2:'震度2', int_3:'震度3', int_4:'震度4', int_5m:'震度5弱', int_5p:'震度5强', int_6m:'震度6弱', int_6p:'震度6强', int_7:'震度7'}
};

/**
 * Look up human-readable transcript text for a fragment name and language.
 * @param {string} name - Fragment name (e.g. "num_14", "pref_13", "ph_intro1")
 * @param {string} lang - Language code (jp/en/zh)
 * @returns {string} Human-readable text in the requested language, or empty string
 */
function fragmentText(name, lang) {
  // Number fragments: "num_14" → "14"
  if (name.indexOf('num_') === 0) {
    return String(parseInt(name.slice(4), 10));
  }
  // Prefecture fragments: "pref_13" → "東京都"
  if (name.indexOf('pref_') === 0) {
    var pid = name.slice(5);
    return (PREFECTURE_NAMES[lang] && PREFECTURE_NAMES[lang][pid]) || '';
  }
  // Intensity short fragments: "int_6p" → "震度6強"
  if (name.indexOf('int_') === 0 && INTENSITY_TEXT[lang] && INTENSITY_TEXT[lang][name]) {
    return INTENSITY_TEXT[lang][name];
  }
  // Fixed phrase fragments: "ph_intro1" → "震度速報"
  if (name.indexOf('ph_') === 0 && PHRASE_TEXT[lang] && PHRASE_TEXT[lang][name]) {
    return PHRASE_TEXT[lang][name];
  }
  return '';
}

// ---- Time parsing ----

/**
 * Build time announcement fragments.
 * @param {Date|string|null} time - Date object or ISO string, null = skip
 * @param {string} lang - jp | en | zh
 * @param {function} push - callback(fragmentName, volume) to collect fragments
 */
function buildTimeFragments(time, lang, push) {
  if (!time) return;
  var bt = (typeof time === 'string') ? new Date(time) : time;
  if (isNaN(bt.getTime())) return;

  var hh = bt.getHours(), mm = bt.getMinutes();
  push(numFragment(hh));
  if (lang === 'jp' || lang === 'zh') push('ph_hour');

  if (mm > 0) {
    push(numFragment(mm));
    if (lang === 'jp' || lang === 'zh') push('ph_min');
  } else if (lang === 'jp' || lang === 'zh') {
    push('num_00'); push('ph_min');
  }
}

// ---- Supported languages ----

B.LANGUAGES = ['jp', 'en', 'zh'];

// ---- Prefecture IDs (1-47, matching generate_tts.py order) ----

B.PREFECTURE_IDS = [];
for (var i = 1; i <= 47; i++) B.PREFECTURE_IDS.push(i);

// ---- Main bulletin builder ----

/**
 * Build a TTS bulletin fragment playlist for an earthquake event.
 *
 * @param {object} opts
 * @param {string} opts.lang - Language code: jp | en | zh
 * @param {number} opts.mag - Magnitude (Mw)
 * @param {number} opts.depth - Focal depth in km
 * @param {number|string} opts.maxShindo - Maximum observed Shindo (0-7, 5-, 5+, 6-, 6+)
 * @param {number} [opts.tsunamiLevel] - 0=none, 1=advisory, 2=warning, 3=major
 * @param {Date|string|null} [opts.time] - Origin time (Date or ISO string); null = skip time
 * @param {Array<{id:number,shindo:number|string}>} [opts.affected] - Affected prefectures
 *        If omitted, uses opts.affectedByShindo map: { prefectureId: shindoValue, ... }
 * @param {object} [opts.affectedByShindo] - Alternative: { "13": "6+", "14": "5+", ... }
 * @param {string} [opts.urlBase] - Base URL for audio files (e.g. "https://quake.example.com")
 *        If omitted, paths are relative (e.g. "sounds/jp/info/female/num_07.wav")
 * @returns {object} { fragments: [{name,path,vol,type,text}], summary: {lang,totalFragments,urlBase} }
 */
B.buildBulletin = function(opts) {
  opts = opts || {};
  var lang = opts.lang || 'jp';
  if (B.LANGUAGES.indexOf(lang) === -1) lang = 'jp';

  var urlBase = opts.urlBase || '';
  if (urlBase && urlBase.charAt(urlBase.length - 1) === '/') {
    urlBase = urlBase.slice(0, -1);
  }

  var fragments = [];
  var _includeText = opts.includeText !== false; // default true — populate text field

  function push(name, vol, type) {
    var path = 'sounds/' + lang + '/info/female/' + name + '.wav';
    fragments.push({
      name: name,
      path: urlBase ? urlBase + '/' + path : path,
      vol: vol || 1,
      type: type || 'phrase',
      text: _includeText ? (fragmentText(name, lang) || null) : null
    });
  }

  // 1. Time
  if (opts.time) {
    buildTimeFragments(opts.time, lang, function(name, vol) {
      push(name, vol, 'time');
    });
  }

  // 2. Intensity intro
  push('ph_intro1', 1, 'intro');
  push(maxIntensityFragment(opts.maxShindo || 0), 1, 'shindo');
  push('ph_intro2', 1, 'intro');

  // 3. Magnitude (clamped to valid range)
  var mag = Math.max(0, Math.min(12, opts.mag || 0));
  push('ph_mag', 1, 'mag');
  var magInt = Math.floor(mag);
  var magDec = Math.round((mag - magInt) * 10);
  push(numFragment(magInt), 1, 'mag');
  if (magDec > 0) {
    push('ph_decimal', 1, 'mag');
    push(numFragment(magDec), 1, 'mag');
  }

  // 4. Depth (clamped to geophysically plausible range)
  var dep = Math.max(0, Math.min(700, Math.round(opts.depth || 0)));
  push('ph_depth', 1, 'depth');
  if (dep < 100) {
    push(numFragment(dep), 1, 'depth');
  } else {
    digitsFragments(dep).forEach(function(f) { push(f, 1, 'depth'); });
  }
  push('ph_km', 1, 'depth');

  // 5. Tsunami (clamped to 0-3)
  var tsu = Math.max(0, Math.min(3, opts.tsunamiLevel || 0));
  if (tsu >= 3) push('ph_tsu_major', 1, 'tsunami');
  else if (tsu >= 2) push('ph_tsu_warning', 1, 'tsunami');
  else if (tsu >= 1) push('ph_tsu_advisory', 1, 'tsunami');

  // 6. Affected prefectures
  var prefs = [];

  // Accept both array format and map format
  if (opts.affected && Array.isArray(opts.affected)) {
    prefs = opts.affected.map(function(p) {
      var sh = p.shindo || 0;
      return { id: p.id || p.prefId || 0, shindo: sh, score: shindoScore(sh) };
    });
  } else if (opts.affectedByShindo && typeof opts.affectedByShindo === 'object') {
    for (var pid = 1; pid <= 47; pid++) {
      var sh = opts.affectedByShindo[pid] || opts.affectedByShindo[String(pid)] || 0;
      if (shindoNum(sh) >= 3) prefs.push({ id: pid, shindo: sh, score: shindoScore(sh) });
    }
  }

  // Sort by shindoScore descending
  prefs.sort(function(a, b) { return b.score - a.score; });

  if (prefs.length > 0) {
    push('ph_affected', 1, 'affected');
    for (var i = 0; i < prefs.length; i++) {
      var p = prefs[i];
      push('pref_' + String(p.id).padStart(2, '0'), 1, 'pref');
      push(intensityFragment(p.shindo), 0.85, 'pref_int');
    }
  }

  return {
    fragments: fragments,
    summary: {
      lang: lang,
      totalFragments: fragments.length,
      urlBase: urlBase || null
    }
  };
};

// ---- Fragment catalog (for API discovery) ----

/**
 * Return metadata about all available TTS fragment types.
 * @returns {object} Categories and fragment counts per language
 */
B.getFragmentCatalog = function() {
  return {
    numbers:     { count: 100, pattern: 'num_00..num_99' },
    prefectures: { count: 47,  pattern: 'pref_01..pref_47' },
    fixedPhrases: {
      count: 12,
      keysJP: ['ph_hour','ph_min','ph_intro1','ph_intro2','ph_mag','ph_depth','ph_km','ph_decimal',
               'ph_tsu_major','ph_tsu_warning','ph_tsu_advisory','ph_affected'],
      keysEN: ['ph_intro1','ph_intro2','ph_mag','ph_depth','ph_km','ph_decimal',
               'ph_tsu_major','ph_tsu_warning','ph_tsu_advisory','ph_affected'],
      keysZH: ['ph_hour','ph_min','ph_intro1','ph_intro2','ph_mag','ph_depth','ph_km','ph_decimal',
               'ph_tsu_major','ph_tsu_warning','ph_tsu_advisory','ph_affected'],
      note: 'English lacks ph_hour and ph_min (plain numerals used for time)'
    },
    intensityShorts: { count: 10, keys: ['int_0','int_1','int_2','int_3','int_4','int_5m','int_5p','int_6m','int_6p','int_7'] },
    languages: B.LANGUAGES,
    soundBase: 'sounds/{lang}/info/female/'
  };
};

return B;

}));
