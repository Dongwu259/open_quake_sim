#!/usr/bin/env node
'use strict';
// =====================================================================
//  R5-6 — build the DIRECT-citation historical tsunami observations
//  dataset from the frozen primary-record extracts:
//
//    tools/data/tsunami-jma-monthly-records.json       (JMA 月報 tide
//        tables, parsed at char-coordinate level by
//        tools/fetch-tsunami-observations.py — 2011-03 / 2003-09 /
//        2024-01 / 2024-08)
//    tools/data/tsunami-station-coordinates.json       (JMA 潮位表
//        station positions, minute precision)
//    2011 runup points: the TTJT unified survey CSV
//        (ttjt_survey_29-Dec-2012_tidecorrected_web.csv) — frozen
//        literals below carry the CSV row IDs
//    1993 tide/runups: JMA Sapporo / Cabinet-Office lesson-DB pages
//        (frozen literals with quotes)
//    Forecast-area observed levels: JMA tide+survey maxima per area
//        (classification identical to Physics.jmaTsunamiForecast bands;
//        the one gauge-failure case — noto2024 能登 — carries the JMA
//        issued grade, flagged in quality.note)
//
//  Output: public/geojson/historical_tsunami_observations.json
//  Every observation/area row cites its source record; quality is
//  'direct' throughout (TsunamiValidation flips researchReady).
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/data/tsunami-jma-monthly-records.json'), 'utf8'));
const STATION_DOC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/data/tsunami-station-coordinates.json'), 'utf8'));
const AREAS = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/jma_tsunami_forecast_areas.json'), 'utf8'));
const TsunamiValidation = require(path.join(ROOT, 'public/tsunami-validation.js'));
const OUT = path.join(ROOT, 'public/geojson/historical_tsunami_observations.json');

// 潮位表 station name for each 津波観測点名 (tide-information naming)
const STATION_ALIAS = {
  八戸: '八戸港', 銚子: '銚子漁港', 石巻市鮎川: '鮎川', いわき市小名浜: '小名浜',
  館山市布良: '布良', 久慈港: '久慈', 串本町袋港: '串本', 苫小牧東港: '苫小牧東',
  八丈島八重根: '八丈島（八重根）', 父島二見: '父島', 浜中町霧多布港: '霧多布',
  須崎港: '須崎', 日南市油津: '油津', 柏崎市鯨波: '柏崎', 佐渡市鷲崎: '佐渡',
  境港市境: '境', 徳島由岐: '阿波由岐', 室戸市室戸岬: '室戸岬', 那智勝浦町浦神: '浦神',
  岩美町田後: '田後', 根室市花咲: '花咲', 霧多布: '霧多布'
};
const STATION_IX = {};
for (const s of STATION_DOC.stations) STATION_IX[s.name] = s;

function stationCoord(name) {
  const s = STATION_IX[STATION_ALIAS[name] || name];
  if (!s) throw new Error('no tide-table coordinate for station: ' + name);
  return { lat: +s.lat.toFixed(4), lng: +s.lng.toFixed(4) };
}

const DOC_IX = {};
for (const d of REC.docs) DOC_IX[d.id] = d;
function recordRow(docId, name) {
  const rows = (DOC_IX[docId].rows || []).filter(r => r.name === name && r.rest && r.rest.length);
  if (!rows.length) throw new Error('no parsed record row for ' + docId + ' / ' + name);
  // prefer the row with the most tokens (first-wave + max columns)
  rows.sort((a, b) => b.rest.length - a.rest.length);
  return rows[0];
}

/** F1 (2011/2003): "*n 26 05 06 (+) 102 cm 26 09 03 118 cm" -> iso fields. */
function parseF1(rest) {
  let s = rest.join(' ');
  // order matters: 'cm以上' contains 'm以上' as a substring
  s = s.replace(/cm以上/g, ' cm_above').replace(/m以上/g, ' m_above');
  s = s.replace(/\(\+\)/g, ' +').replace(/\(\-\)/g, ' -');
  const toks = s.split(/\s+/).filter(Boolean);
  const out = { first: null, max: null, heightCm: null, overScale: false };
  // normalize: fused sign/unit tokens ('+90cm', '8.5m', '-1.2m') split open;
  // footnote flags ('*1', '*3') are dropped — their digits are NOT data
  const nums = [];
  for (const t0 of toks) {
    if (/^\*[\d*]*$/.test(t0)) continue;
    for (const piece of t0.match(/[+-]?[\d.]+|cm_above|m_above|cm|-/g) || []) {
      if (piece === 'm_above') { nums.push('m'); out.overScale = true; }
      else if (piece === 'cm_above') { nums.push('cm'); out.overScale = true; }
      else if (piece === '-' || piece === 'cm') nums.push(piece);
      else if (/^[+-]?[\d.]+$/.test(piece)) {
        if (piece.length > 1 && (piece[0] === '+' || piece[0] === '-')) { nums.push(piece[0]); nums.push(piece.slice(1)); }
        else nums.push(piece);
      }
    }
  }
  // first triple
  let i = 0;
  while (i + 2 < nums.length && !(/^\d{1,2}$/.test(nums[i]) && /^\d{1,2}$/.test(nums[i + 1]) && (/^\d{1,2}$/.test(nums[i + 2]) || nums[i + 2] === '-'))) i++;
  if (i + 2 < nums.length) {
    if (nums[i + 2] !== '-') out.first = [nums[i], nums[i + 1], nums[i + 2]];
    let j = i + 3;
    // skip H1 (sign? value unit?) — the value itself may be '-' (missing);
    // never consume the next DD HH MM triple's day as the H1 value
    const isTriple = (k) => /^\d{1,2}$/.test(nums[k]) && /^\d{1,2}$/.test(nums[k + 1]) && /^\d{1,2}$/.test(nums[k + 2]);
    if ((nums[j] === '+' || nums[j] === '-') && !isTriple(j + 1)) j++;
    if (!isTriple(j) && /^[\d.]+$/.test(nums[j] || '')) j++;
    if (nums[j] === 'cm' || nums[j] === 'm') j++;
    // second triple (max): skip anything that is not a DD HH MM run
    while (j + 2 < nums.length && !(/^\d{1,2}$/.test(nums[j]) && /^\d{1,2}$/.test(nums[j + 1]) && /^\d{1,2}$/.test(nums[j + 2]))) j++;
    if (j + 2 < nums.length) {
      out.max = [nums[j], nums[j + 1], nums[j + 2]];
      const k0 = j + 3;
      if (/^[\d.]+$/.test(nums[k0] || '')) {
        const h = parseFloat(nums[k0]);
        const unit = (nums[k0 + 1] === 'cm' || nums[k0 + 1] === 'm') ? nums[k0 + 1] : null;
        if (!isFinite(h)) throw new Error('bad height in row: ' + rest.join(' '));
        out.heightCm = unit === 'm' ? h * 100 : h;
        // unit-less decimals (e.g. 8.0) are metres; unit-less integers are cm
        if (!unit && !Number.isInteger(h)) out.heightCm = h * 100;
      }
    }
  }
  return out;
}

/** F2 (2024): "気象庁 1 日 17:25 1 日 19:45 31" (height cm; '0.8m' = 80cm). */
function parseF2(rest) {
  const s = rest.join(' ');
  const times = [...s.matchAll(/(\d{1,2})\s*日\s*(\d{2}):(\d{2}|-{2})/g)].map(m => [m[1], m[2], m[3]]);
  let heightCm = null;
  const hm = s.match(/(\d+(?:\.\d+)?)\s*m(?:\s|$)/);
  const hcm = s.match(/(\d+(?:\.\d+)?)(?:\s|$)/g);
  if (hm) heightCm = parseFloat(hm[1]) * 100;
  else if (hcm) {
    // last standalone number = the height column
    const vals = hcm.map(x => parseFloat(x)).filter(v => isFinite(v));
    if (vals.length) heightCm = vals[vals.length - 1];
  }
  return { first: times[0] && times[0][2] !== '--' ? times[0] : null, max: times[1] || null, heightCm, overScale: false };
}

const JST_H = 9;
function isoFromJst(originDateJst, trip) {
  // originDateJst = [Y,M,D] of the event (JST calendar day of origin);
  // trip = [D,HH,MM] with D the JST day-of-month
  if (!trip) return null;
  const [Y, M, D0] = originDateJst;
  let day = parseInt(trip[0], 10), hour = parseInt(trip[1], 10), min = parseInt(trip[2], 10);
  const utcMs = Date.UTC(Y, M - 1, day, hour - JST_H, min);
  if (!isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

// ---- curated tide picks ------------------------------------------------
// tide: [doc, station, format, note?]
const TIDE = {
  tohoku2011: { doc: 'monthly-201103', fmt: 'F1', originJst: [2011, 3, 11],
    stations: ['大船渡', '宮古', '釜石', '八戸', '石巻市鮎川', '相馬', 'いわき市小名浜', '大洗', '銚子', '釧路', '浜中町霧多布港', '浦河', '函館', '父島二見', '八丈島八重根'] },
  tokachi2003: { doc: 'monthly-200309', fmt: 'F1', originJst: [2003, 9, 26],
    stations: ['釧路', '根室市花咲', '霧多布', '浦河', '宮古', '大船渡', '釜石', '八戸', 'いわき市小名浜'] },
  noto2024: { doc: 'monthly-202401', fmt: 'F2', originJst: [2024, 1, 1],
    stations: ['富山', '酒田', '柏崎市鯨波', '佐渡市鷲崎', '深浦', '秋田', '境港市境', '岩美町田後'] },
  hyuganada2024: { doc: 'monthly-202408', fmt: 'F2', originJst: [2024, 8, 8],
    stations: ['日南市油津', '土佐清水', '室戸市室戸岬', '串本町袋港', '徳島由岐', '宇和島', '那智勝浦町浦神', '館山市布良', '父島二見'] }
};

function buildTideRows(eventId) {
  const cfg = TIDE[eventId];
  const out = [];
  for (const name of cfg.stations) {
    const row = recordRow(cfg.doc, name);
    const parsed = cfg.fmt === 'F1' ? parseF1(row.rest) : parseF2(row.rest);
    if (!(parsed.heightCm > 0)) throw new Error(eventId + '/' + name + ': no max height parsed: ' + row.rest.join(' '));
    const c = stationCoord(name);
    const arrival = isoFromJst(cfg.originJst, parsed.first);
    const obs = {
      id: eventId + '-' + name,
      name,
      type: 'tide-gauge',
      lat: c.lat, lng: c.lng,
      peakHeightM: +(parsed.heightCm / 100).toFixed(2),
      verticalDatum: 'JMA tide-station datum (潮位表基準面, station-specific); tsunami amplitude above still water, not corrected to TP',
      sourceId: 'jma-monthly-' + cfg.doc.slice(8),
      quality: 'direct',
      record: { doc: cfg.doc, page: row.page, table: '津波観測値' }
    };
    if (parsed.overScale) obs.record.overScale = true;
    if (arrival) obs.arrivalTime = arrival;
    if (parsed.max) obs.maxWaveTime = isoFromJst(cfg.originJst, parsed.max) || undefined;
    out.push(obs);
  }
  return out;
}

// ---- 2011 runup literals (TTJT unified CSV, reliability A) -------------
const RUNUP_2011 = [
  { id: 'tohoku-ryori-miyako', name: '宮古市重茂姉吉 (TTJT UTMS-0116)', lat: 39.533, lng: 142.0468, peakHeightM: 38.67, csvId: 'UTMS-0116' },
  { id: 'tohoku-onagawa', name: '宮城県女川町 (TTJT THKE-0221)', lat: 38.4419, lng: 141.4415, peakHeightM: 35.01, csvId: 'THKE-0221' },
  { id: 'tohoku-yamada', name: '山田町小谷鳥 (TTJT UTMS-0033)', lat: 39.4357, lng: 142.0094, peakHeightM: 26.2, csvId: 'UTMS-0033' },
  { id: 'tohoku-ishinomaki', name: '石巻市谷川浜川原 (TTJT MLIT-0347)', lat: 38.3585, lng: 141.4842, peakHeightM: 26.3, csvId: 'MLIT-0347' },
  { id: 'tohoku-ofunato', name: '大船渡市三陸町綾里大久保 (TTJT NDAC-0034)', lat: 39.0583, lng: 141.811, peakHeightM: 21.94, csvId: 'NDAC-0034' },
  { id: 'tohoku-rikuzentakata', name: '陸前高田市米崎町樋ノ口 (TTJT UTMS-0083)', lat: 39.0139, lng: 141.6688, peakHeightM: 21.39, csvId: 'UTMS-0083' },
  { id: 'tohoku-sendai', name: '仙台市宮城野区蒲生 (TTJT MYGP-0536)', lat: 38.2592, lng: 141.0048, peakHeightM: 10.56, csvId: 'MYGP-0536' }
];

// ---- 1993 literals (JMA Sapporo page + Cabinet Office lesson DB) --------
const TIDE_1993 = [
  { id: 'hokkaido1993-esashi', name: '江差', lat: 41.8667, lng: 140.1333, peakHeightM: 1.75, overScale: true,
    arrivalOffsetMin: 7, quote: '最も早く津波が到達したのは江差港で、地震発生から約７分後に第１波が到達し、その後、津波の高さは175cm以上（測定範囲上限を超過）に達した' },
  { id: 'hokkaido1993-iwanai', name: '岩内', lat: 42.9833, lng: 140.5, peakHeightM: 1.42,
    quote: 'このほか岩内港で142cm' },
  { id: 'hokkaido1993-matsumae', name: '松前', lat: 41.4167, lng: 140.1, peakHeightM: 1.06,
    quote: '松前港で106cm' }
];
const RUNUP_1993 = [
  // JMA field-survey district heights (Cabinet-Office lesson DB, hnj030101_07)
  { id: 'okushiri-monai', name: '奥尻島藻内', lat: 42.181, lng: 139.404, peakHeightM: 31.7,
    source: 'coast-office-kyokun', quote: '津波の遡上高(打ち上げ高)は、局所的であるが藻内で31.7mであった（沢の奥の値；沢の入口付近の崖では23m前後）' },
  { id: 'okushiri-hatsumatsu', name: '奥尻島初松前', lat: 42.106, lng: 139.439, peakHeightM: 11,
    source: 'coast-office-db', quote: '気象庁で調査した結果、奥尻島藻内地区で21m、青苗地区で5～10m、初松前で11m、ホヤ石付近で11m、稲穂地区で8m' },
  { id: 'okushiri-inaho', name: '奥尻島稲穂', lat: 42.199, lng: 139.444, peakHeightM: 8, source: 'coast-office-db', quote: '稲穂地区で8m' },
  { id: 'hokkaido-sakei', name: '北海道本島栄磯', lat: 42.102, lng: 140.056, peakHeightM: 7.5, source: 'coast-office-db', quote: '北海道本島の栄磯地区で7.5m、大成町及び江差で2m～4m' }
];

// ---- forecast areas ------------------------------------------------------
// observedLevel rule: classify the area max DIRECT observation (tide + JMA
// survey rows in hand), same bands as Physics.jmaTsunamiForecast
// (advisory <1m / warning 1-3m / major >3m). Area names resolve against the
// bundled 66-zone geometry; the curation fails loudly on unknown names.
function areaCodeFor(nameHint) {
  const feats = AREAS.features.filter(f => (f.properties && f.properties.name || '') === nameHint ||
    (f.properties && f.properties.name || '').includes(nameHint));
  if (feats.length !== 1) throw new Error('area name ambiguous/unknown: ' + nameHint + ' -> ' + feats.map(f => f.properties.code + ':' + f.properties.name).join(','));
  return { code: String(feats[0].properties.code), name: feats[0].properties.name };
}
function areaRow(nameHint, level, maxObsM, sourceId, evidence) {
  const a = areaCodeFor(nameHint);
  return { code: a.code, name: a.name, observedLevel: level, maxObservedM: maxObsM, sourceId, quality: 'direct', evidence };
}
const AREA_SETS = {
  tohoku2011: [
    areaRow('岩手県', 'major', 8.5, 'jma-monthly-201103', 'tide 宮古 8.5m以上 (over scale)'),
    areaRow('宮城県', 'major', 8.6, 'jma-monthly-201103', 'tide 石巻市鮎川 8.6m以上 (over scale)'),
    areaRow('福島県', 'major', 3.33, 'jma-monthly-201103', 'tide いわき市小名浜 333cm'),
    areaRow('青森県太平洋沿岸', 'major', 4.2, 'jma-monthly-201103', 'tide 八戸 4.2m以上 (over scale)'),
    areaRow('茨城県', 'major', 4.0, 'jma-monthly-201103', 'tide 大洗 4.0m以上 (over scale)'),
    areaRow('千葉県九十九里・外房', 'warning', 2.5, 'jma-monthly-201103', 'tide 銚子 2.5m'),
    areaRow('北海道太平洋沿岸東部', 'warning', 2.08, 'jma-monthly-201103', 'tide 釧路 208cm'),
    areaRow('伊豆諸島', 'warning', 1.82, 'jma-monthly-201103', 'tide 父島二見 182cm')
  ],
  tokachi2003: [
    areaRow('北海道太平洋沿岸東部', 'major', 4.0, 'jma-monthly-200309-survey', '現地調査 えりも町百人浜 4.0m（遡上高）= JMA survey p.42'),
    areaRow('北海道太平洋沿岸中部', 'warning', 1.29, 'jma-monthly-200309', 'tide 浦河 129cm (十勝港 254cm は開発局観測)'),
    areaRow('北海道太平洋沿岸西部', 'advisory', 0.64, 'jma-monthly-200309', 'tide 白老 64cm'),
    areaRow('岩手県', 'advisory', 0.57, 'jma-monthly-200309', 'tide 宮古 57cm'),
    areaRow('青森県太平洋沿岸', 'advisory', 0.99, 'jma-monthly-200309', 'tide 八戸 99cm')
  ],
  hokkaido1993: [
    areaRow('北海道日本海沿岸南部', 'major', 31.7, 'coast-office-kyokun', 'survey 藻内 31.7m（沢奥; 入口23m）; JMA調査値 藻内21m'),
    areaRow('北海道日本海沿岸北部', 'warning', 1.42, 'jma-sapporo', 'tide 岩内 142cm'),
    areaRow('青森県日本海沿岸', 'warning', 1.06, 'jma-sapporo', 'tide 松前 106cm')
  ],
  noto2024: [
    areaRow('石川県能登', 'major', null, 'jma-monthly-202401-overview', 'issued 大津波警報 (16:22); 輪島検潮所未取得 — gauge-failure exception, grade from JMA issuance'),
    areaRow('新潟県上中下越', 'advisory', 0.37, 'jma-monthly-202401', 'tide 柏崎市鯨波 37cm'),
    areaRow('富山県', 'advisory', 0.79, 'jma-monthly-202401', 'tide 富山 79cm'),
    areaRow('山形県', 'advisory', 0.8, 'jma-monthly-202401', 'tide 酒田 0.8m (巨大津波観測計)'),
    areaRow('北海道日本海沿岸南部', 'advisory', 0.54, 'jma-monthly-202401', 'tide 瀬棚港 54cm')
  ],
  hyuganada2024: [
    areaRow('宮崎県', 'advisory', 0.51, 'jma-monthly-202408', 'tide 宮崎港 51cm (港湾局; issued 津波注意報)'),
    areaRow('高知県', 'advisory', 0.25, 'jma-monthly-202408', 'tide 土佐清水 25cm'),
    areaRow('愛媛県宇和海沿岸', 'advisory', 0.07, 'jma-monthly-202408', 'tide 宇和島 7cm'),
    areaRow('大分県豊後水道沿岸', 'advisory', 0.05, 'jma-monthly-202408', 'tide 佐伯市松浦 5cm')
  ]
};


// ---- events ---------------------------------------------------------------
function monthlySource(docId) {
  const d = DOC_IX[docId];
  return { id: 'jma-monthly-' + docId.slice(8), url: d.url, citation: d.label + ' — 「津波観測値」表 (p.' + d.pages.join(',') + '), 気象庁' };
}
const EVENTS = [
  {
    id: 'tohoku2011', originTime: '2011-03-11T05:46:18Z', mw: 9.1, lat: 38.1, lng: 142.86, depthKm: 24,
    sourceUrl: 'https://www.data.jma.go.jp/eqev/data/2011_03_11_tohoku/',
    sources: [
      monthlySource('monthly-201103'),
      { id: 'ttjt-csv', url: 'https://www.coastal.jp/ttjt/index.php?%E7%8F%BE%E5%9C%B0%E8%AA%BF%E6%9F%BB%E7%B5%90%E6%9E%9C', citation: '2011 Tohoku Earthquake Tsunami Joint Survey (TTJT) — 統一調査データ ttjt_survey_29-Dec-2012_tidecorrected_web.csv (reliability-A per-town maxima; row IDs in each record)' },
      { id: 'jma-portal', url: 'https://www.data.jma.go.jp/eqev/data/2011_03_11_tohoku/', citation: 'JMA, The 2011 off the Pacific coast of Tohoku Earthquake portal' }
    ],
    observations: buildTideRows('tohoku2011').concat(RUNUP_2011.map(r => ({
      id: r.id, name: r.name, type: 'runup', lat: r.lat, lng: r.lng, peakHeightM: r.peakHeightM,
      sourceId: 'ttjt-csv', quality: 'direct', record: { csvRowId: r.csvId, field: 'height corrected by ttjt [m]', reliability: 'A' }
    }))),
    forecastAreas: AREA_SETS.tohoku2011
  },
  {
    id: 'hokkaido1993', originTime: '1993-07-12T13:17:12Z', mw: 7.8, lat: 42.78, lng: 139.18, depthKm: 35,
    sourceUrl: 'https://www.jma-net.go.jp/sapporo/jishin/nanseioki.html',
    sources: [
      { id: 'jma-sapporo', url: 'https://www.jma-net.go.jp/sapporo/jishin/nanseioki.html', citation: '気象庁札幌管区気象台「平成5年（1993年）北海道南西沖地震」— 検潮記録（江差・岩内・松前）と現地調査' },
      { id: 'coast-office-db', url: 'https://www.bousai.go.jp/kyoiku/kyokun/hokkaidonaiseioki/dbindex/database/03/01/01/hnj030101_07.htm', citation: '内閣府防災情報 教訓情報資料集 — 気象庁現地調査による地区別津波の高さ' },
      { id: 'coast-office-kyokun', url: 'https://www.bousai.go.jp/kyoiku/kyokun/hokkaidonaiseioki/oline.htm', citation: '内閣府 教訓情報 — 藻内の遡上高31.7m（石山祐二ら調査）' }
    ],
    observations: TIDE_1993.map(r => {
      const o = {
        id: r.id, name: r.name, type: 'tide-gauge', lat: r.lat, lng: r.lng, peakHeightM: r.peakHeightM,
        verticalDatum: 'JMA tide-station datum; quoted value is the tide-gauge tsunami amplitude (江差 over scale)',
        sourceId: 'jma-sapporo', quality: 'direct', record: { quote: r.quote }
      };
      if (r.overScale) o.record.overScale = true;
      if (r.arrivalOffsetMin) o.arrivalTime = new Date(Date.parse('1993-07-12T13:17:12Z') + r.arrivalOffsetMin * 60000).toISOString();
      return o;
    }).concat(RUNUP_1993.map(r => ({
      id: r.id, name: r.name, type: 'runup', lat: r.lat, lng: r.lng, peakHeightM: r.peakHeightM,
      sourceId: r.source, quality: 'direct', record: { quote: r.quote }
    }))),
    forecastAreas: AREA_SETS.hokkaido1993
  },
  {
    id: 'tokachi2003', originTime: '2003-09-25T19:50:08Z', mw: 8.0, lat: 41.78, lng: 144.08, depthKm: 42,
    sourceUrl: 'https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/200309/monthly200309.pdf',
    sources: [
      monthlySource('monthly-200309'),
      { id: 'jma-monthly-200309-survey', url: 'https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/200309/monthly200309.pdf', citation: 'JMA 月報(防災編) 2003-09 特集 p.42「十勝港の2.5m…現地調査ではえりも町百人浜で4.0m（遡上高）」' }
    ],
    observations: buildTideRows('tokachi2003'),
    forecastAreas: AREA_SETS.tokachi2003
  },
  {
    id: 'noto2024', originTime: '2024-01-01T07:10:09Z', mw: 7.6, lat: 37.5, lng: 137.27, depthKm: 10,
    sourceUrl: 'https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202401/202401monthly.pdf',
    sources: [
      monthlySource('monthly-202401'),
      { id: 'jma-monthly-202401-overview', url: 'https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202401/202401monthly.pdf', citation: 'JMA 月報(防災編) 2024-01 概況 p.6「大津波警報を石川県能登に発表」（輪島検潮所未取得）' }
    ],
    observations: buildTideRows('noto2024'),
    forecastAreas: AREA_SETS.noto2024
  },
  {
    id: 'hyuganada2024', originTime: '2024-08-08T07:42:14Z', mw: 7.1, lat: 31.8, lng: 131.6, depthKm: 30,
    sourceUrl: 'https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/202408/202408monthly.pdf',
    sources: [monthlySource('monthly-202408')],
    observations: buildTideRows('hyuganada2024'),
    forecastAreas: AREA_SETS.hyuganada2024
  }
];

const dataset = {
  _schema: 'quake-sim-tsunami-observations-v1',
  version: '2026-09-04-direct',
  quality: {
    frozen: true,
    researchReady: true,
    note: 'Direct curation v2 (R5-6): every value record-level verified against the cited primary record — JMA monthly-report tide tables (char-coordinate parse frozen in tools/data/tsunami-jma-monthly-records.json), the TTJT unified 2011 survey CSV (reliability-A points, row IDs retained), JMA Sapporo / Cabinet-Office pages for 1993, and the JMA tide-table station list for coordinates. forecastAreas observedLevel = classification of the area-max direct observation (advisory <1m / warning 1-3m / major >3m); the single exception (noto2024 石川県能登, major) uses the JMA issued 大津波警報 because the Wajima gauge failed — flagged in the row sourceId. overScale records are lower bounds. 1960 Chile / 2010 Chile far-field events are out of the solver domain (Japan-region grid) and not curated.'
  },
  events: EVENTS
};

const check = TsunamiValidation.validate(dataset);
console.log(JSON.stringify(check, null, 1));
if (!check.valid) { console.error('DATASET INVALID'); process.exit(1); }
fs.writeFileSync(OUT, JSON.stringify(dataset, null, 1) + '\n');
console.log('wrote', OUT, '— events', check.eventCount, 'obs', check.observationCount, 'areas', check.areaCount,
  'researchReady', check.researchReady);
