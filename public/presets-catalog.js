// ================================================================
//  presets-catalog.js — the static Japan scenario preset catalog.
//  Extracted verbatim from app.js (2026-11-17, CLI batch) so the web
//  app and cli/simulate.js consume the same source of truth. Region
//  presets live in the region packs (app.js merges them at runtime);
//  this file holds ONLY the static catalog below.
// ================================================================
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PRESET_CATALOG = api;
}(typeof self !== 'undefined' ? self : this, function() {
  return {
  // 2011 Tohoku-Oki: bundled observed finite-fault model (USGS Hayes 2017,
  // 3-segment 625 km rupture, 325 patches) replaces the earlier synthetic
  // 4-subsource approximation — four overlapping Strasser-scaled planes
  // (226-582 km each) smeared the shaking footprint and tsunami source.
  tohoku:  {lat:38.10,lng:142.86,mag:9.1,depth:24,strike:193,time:'2011/03/11 14:46',faultModel:'tohoku'},
  // Hypothetical future Nankai Trough megathrust scenario (Cabinet Office
  // 2012 Mw 9.0 framework): bundled synthetic 4-segment finite-fault model
  // (Tokai/Tonankai/Nankai/Hyuga, 217 patches, 大すべり域 20 m / 超大すべり域
  // 40 m, nucleation south of the Kii Peninsula). No `time`: bulletins use
  // the current clock because the event has not occurred.
  nankaiM9: {lat:33.93,lng:136.41,mag:9.0,depth:16,strike:247,faultModel:'nankaiM9'},
  tokyoInland: {lat:35.62,lng:139.75,mag:7.3,depth:17,strike:135,dip:60,rake:120,mechanismKnown:true}, // hypothetical Tokyo-inland (都心南部直下-class) M7.3 scenario
  // Hypothetical "Japan Sinks" (日本沈没) chain: the 2011 Tohoku-Oki earthquake
  // followed by every earthquake with JMA maximum Shindo 6-/6+/7 of the last ten
  // years (2016-2026), striking in chronological sequence, then two hypothetical
  // megathrust scenarios appended after the catalog: a Nankai Trough M9.0
  // (Cabinet Office 2012 framework, bundled 4-segment model) and a
  // Kuril-trench Hokkaido-east-offshore M8.4. Foreshock sequences
  // are collapsed to their mainshock, so the 2016 Kumamoto M6.5/M6.4 foreshocks
  // are dropped and only the M7.3 mainshock stays. `mag` 9.27 is the combined
  // moment magnitude of the 19 sub-events, so the multi-segment moment rescale
  // factor stays ~1.0 and each event keeps its own magnitude. `time` offsets
  // are sim-seconds with random compressed intervals of 25-75 s (mulberry32
  // seed 20260804, gap = 25 + round(50*r)), frozen here so runs and shared URLs
  // remain reproducible. Mechanisms follow F-net/JMA where published; the
  // 2025-2026 events use provisional plate-boundary/crustal estimates pending
  // official CMT solutions, and the two hypothetical events use assumed
  // interplate mechanisms. Tohoku, Kumamoto 2016, Noto 2024, Fukushima-oki
  // 2022, Hyuga-nada 2024 and the Nankai scenario run on their bundled
  // finite-fault models (Hayes 2017, USGS Hayes 2018, USGS Goldberg 2024,
  // USGS Goldberg 2022, USGS Goldberg 2024, and the synthetic 4-segment
  // model); the remaining catalog events use synthetic Strasser-scaled planes.
  japanSinks: {lat:38.10,lng:142.86,mag:9.27,depth:24,strike:193,subEvents:[
    {lat:38.10,lng:142.86,mag:9.1,depth:24,strike:193,dip:15,rake:90,mechanismKnown:true,time:0,faultModel:'tohoku'},    // 2011-03-11 Tohoku-Oki M9.1 (Shindo 7) — Hayes 2017 observed slip model
    {lat:32.75,lng:130.76,mag:7.3,depth:12,strike:226,dip:65,rake:-140,mechanismKnown:true,time:43,faultModel:'kumamoto2016'},  // 2016-04-16 Kumamoto M7.3 (Shindo 7) — USGS Hayes 2018 observed slip model
    {lat:41.90,lng:141.00,mag:5.3,depth:11,strike:150,dip:80,rake:0,mechanismKnown:true,time:82},    // 2016-06-16 Uchiura Bay M5.3 (6-)
    {lat:35.38,lng:133.86,mag:6.6,depth:11,strike:160,dip:80,rake:0,mechanismKnown:true,time:109},   // 2016-10-21 Tottori Chubu M6.6 (6-)
    {lat:34.85,lng:135.62,mag:6.1,depth:13,strike:130,dip:60,rake:90,mechanismKnown:true,time:178},  // 2018-06-18 Northern Osaka M6.1 (6-)
    {lat:42.69,lng:142.01,mag:6.7,depth:37,strike:0,dip:70,rake:90,mechanismKnown:true,time:208},    // 2018-09-06 Eastern Iburi M6.7 (Shindo 7)
    {lat:38.61,lng:139.53,mag:6.7,depth:14,strike:30,dip:55,rake:90,mechanismKnown:true,time:247},   // 2019-06-18 Yamagata-oki M6.7 (6+)
    {lat:37.73,lng:141.70,mag:7.3,depth:55,strike:25,dip:55,rake:90,mechanismKnown:true,time:275},   // 2021-02-13 Fukushima-oki M7.3 (6+)
    {lat:37.70,lng:141.60,mag:7.4,depth:57,strike:30,dip:55,rake:90,mechanismKnown:true,time:325,faultModel:'fukushima2022'},   // 2022-03-16 Fukushima-oki M7.4 (6+) — USGS Goldberg 2022 observed slip model
    {lat:37.54,lng:137.31,mag:6.5,depth:12,strike:55,dip:50,rake:90,mechanismKnown:true,time:386},   // 2023-05-05 Noto M6.5 (6+)
    {lat:37.50,lng:137.27,mag:7.6,depth:16,strike:45,dip:45,rake:90,mechanismKnown:true,time:431,faultModel:'noto2024'},   // 2024-01-01 Noto Hanto-oki M7.6 (Shindo 7) — USGS Goldberg 2024 observed slip model
    {lat:33.20,lng:132.40,mag:6.6,depth:39,strike:150,dip:80,rake:0,mechanismKnown:true,time:456},   // 2024-04-17 Bungo Channel M6.6 (6-)
    {lat:31.75,lng:131.70,mag:7.1,depth:30,strike:200,dip:15,rake:90,mechanismKnown:true,time:508,faultModel:'hyuganada2024'},  // 2024-08-08 Hyuga-nada M7.1 (6-) — USGS Goldberg 2024 observed slip model
    {lat:41.00,lng:142.50,mag:7.5,depth:54,strike:200,dip:20,rake:90,mechanismKnown:true,time:578},  // 2025-12-08 Aomori-oki M7.5 (6+)
    {lat:39.85,lng:142.30,mag:6.9,depth:50,strike:195,dip:20,rake:90,mechanismKnown:true,time:636},  // 2026-06-25 Iwate-oki M6.9 (6+)
    {lat:35.52,lng:138.78,mag:5.6,depth:20,strike:150,dip:70,rake:0,mechanismKnown:true,time:697},   // 2026-06-26 Yamanashi Fuji Five Lakes M5.6 (6-)
    {lat:32.58,lng:130.68,mag:7.1,depth:10,strike:205,dip:65,rake:-135,mechanismKnown:true,time:734}, // 2026-07-28 Kumamoto M7.1 (Shindo 7)
    {lat:33.93,lng:136.41,mag:9.0,depth:16,strike:247,dip:15,rake:90,mechanismKnown:true,time:797,faultModel:'nankaiM9'},   // Hypothetical Nankai Trough M9.0 (Cabinet Office 2012 framework) — bundled 4-segment scenario model
    {lat:43.00,lng:147.30,mag:8.4,depth:25,strike:225,dip:20,rake:90,mechanismKnown:true,time:865}    // Hypothetical Hokkaido-east-offshore (Kuril trench) M8.4
  ]},
  kobe:    {lat:34.58,lng:135.02,mag:7.3,depth:16,strike:233,time:'1995/01/17 05:46'},
  kumamoto:{lat:32.75,lng:130.76,mag:7.0,depth:12,strike:226,time:'2016/04/16 01:25',faultModel:'kumamoto2016'},
  kanto:   {lat:35.33,lng:139.14,mag:7.9,depth:23,strike:290,time:'1923/09/01 11:58'},
  chuetsu: {lat:37.29,lng:138.87,mag:6.8,depth:13,strike:36,time:'2004/10/23 17:56'},
  iburihigashi: {lat:42.69,lng:142.01,mag:6.7,depth:37,strike:0,time:'2018/09/06 03:08'},
  noto2024:     {lat:37.50,lng:137.27,mag:7.6,depth:16,strike:45,time:'2024/01/01 16:10',faultModel:'noto2024'},
  tokachi2003:  {lat:41.81,lng:143.91,mag:8.3,depth:27,strike:240,time:'2003/09/26 04:50',faultModel:'tokachi2003'}, // USGS Hayes 2014 observed slip model (425 patches)
  fukushima2022:{lat:37.70,lng:141.59,mag:7.2,depth:63,strike:184,time:'2022/03/16 23:36',faultModel:'fukushima2022'}, // USGS Goldberg 2022 observed slip model (399 patches, intraslab)
  hyuganada2024:{lat:31.72,lng:131.53,mag:7.1,depth:25,strike:203,time:'2024/08/08 16:43',faultModel:'hyuganada2024'}, // USGS Goldberg 2024 observed slip model (225 patches)
  iwate2008:   {lat:39.03,lng:140.88,mag:7.2,depth:8,strike:198,time:'2008/06/14 08:43'},
  noto2007:    {lat:37.22,lng:136.69,mag:6.9,depth:11,strike:40,time:'2007/03/25 09:42'},
  fukuoka2005: {lat:33.74,lng:130.18,mag:7.0,depth:9,strike:300,time:'2005/03/20 10:53'},
  fukushima2011:{lat:36.95,lng:140.67,mag:7.0,depth:6,strike:150,time:'2011/04/11 17:16'},
  tottori2016: {lat:35.38,lng:133.86,mag:6.6,depth:11,strike:160,time:'2016/10/21 14:07'},
  yamagata2019:{lat:38.61,lng:139.53,mag:6.7,depth:14,strike:30,time:'2019/06/18 22:22'},
  fukushima2021:{lat:37.73,lng:141.70,mag:7.3,depth:55,strike:25,time:'2021/02/13 23:07'},
  kushiro1993:{lat:42.92,lng:144.35,mag:7.5,depth:103,strike:133,time:'1993/01/15 20:06'},
  tonankai1944:{lat:33.57,lng:136.18,mag:7.9,depth:30,strike:225,time:'1944/12/07 13:35'},
  nankai1946:{lat:32.93,lng:135.85,mag:8.0,depth:24,strike:225,time:'1946/12/21 04:19'},
  niigata1964:{lat:38.37,lng:139.22,mag:7.5,depth:34,strike:30,time:'1964/06/16 13:01'}

  };
}));
