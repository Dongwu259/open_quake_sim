#!/usr/bin/env node
'use strict';
// ================================================================
//  Fetch + freeze observed strong-motion station peaks for REGIONAL events
//  (California / Italy / Chile / Taiwan / New Zealand) from USGS Shakemap
//  stationlists — the regional counterpart of tools/fetch-strong-motion-obs.js.
//
//  Pipeline per event: fdsnws time-window query -> closest-to-approx event id
//  -> detail geojson -> shakemap product -> download/stationlist.json.
//
//  PRODUCT FALLBACK: products are tried in preferredWeight order, but a
//  product whose stationlist carries ZERO instrumented stations (e.g. Maule
//  2010's preferred atlas product is DYFI/macroseismic-only) is skipped for
//  the next one, and the fallback is recorded in provenance. Macroseismic
//  pseudo-stations (network 'INTENSITY' / commType 'Intensity' — GMICE-derived
//  PGM, not instrument records) are always excluded.
//
//  PREDICTION LINK: events with a region-pack preset record `presetId` (the
//  scorecard predicts from the pack's curated hypocenter/mechanism — app
//  behavior). Events without a preset (ridgecrest2019, parkfield2004) get a
//  frozen `prediction` block here: ComCat hypocenter + mechanism resolved from
//  the moment-tensor AND focal-mechanism products (GCMT family preferred,
//  nodal-plane-1 picked — no pack plane to match against), same dual-product
//  rule as tools/fetch-comcat-presets.js.
//
//  Output: public/geojson/region-obs.json (schema quake-sim-region-obs-v1)
//  Usage: node tools/fetch-region-obs.js [--out=path] [--max-stations=N]
// ================================================================
const fs = require('fs');
const path = require('path');

const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const GAL_PER_G = 980.665;
const MIN_PGA_GAL = 2;
const MIN_INSTRUMENTED = 20;   // frozen-set quality floor per event
const DEFAULT_MAX_STATIONS = 600;

const EVENTS = [
  // ---- California (NGA-West2 shallow-crustal home turf) ----
  { region: 'california', key: 'northridge1994', presetId: 'cal-1994-northridge', name: '1994 Northridge (M6.7)',
    start: '1994-01-17T12:25:00Z', end: '1994-01-17T12:40:00Z', minMag: 6.4, approx: [34.21, -118.54] },
  { region: 'california', key: 'lomaprieta1989', presetId: 'cal-1989-lomaprieta', name: '1989 Loma Prieta (M6.9)',
    start: '1989-10-18T00:00:00Z', end: '1989-10-18T00:15:00Z', minMag: 6.5, approx: [37.04, -121.88] },
  { region: 'california', key: 'ridgecrest2019', presetId: null, sourceType: 'crustal', name: '2019 Ridgecrest sequence mainshock (M7.1)',
    start: '2019-07-06T03:15:00Z', end: '2019-07-06T03:30:00Z', minMag: 6.8, approx: [35.77, -117.60] },
  { region: 'california', key: 'parkfield2004', presetId: null, sourceType: 'crustal', name: '2004 Parkfield (M6.0)',
    start: '2004-09-28T17:10:00Z', end: '2004-09-28T17:25:00Z', minMag: 5.8, approx: [35.82, -120.37] },
  // ---- Italy ----
  { region: 'italy', key: 'laquila2009', presetId: 'it-2009-laquila', name: "2009 L'Aquila (M6.3)",
    start: '2009-04-06T01:30:00Z', end: '2009-04-06T01:45:00Z', minMag: 6.0, approx: [42.35, 13.38] },
  { region: 'italy', key: 'amatrice2016', presetId: 'it-2016-amatrice', name: '2016 Amatrice (M6.2)',
    start: '2016-08-24T01:35:00Z', end: '2016-08-24T01:45:00Z', minMag: 5.9, approx: [42.70, 13.23] },
  { region: 'italy', key: 'norcia2016', presetId: 'it-2016-norcia', name: '2016 Norcia (M6.6)',
    start: '2016-10-30T06:35:00Z', end: '2016-10-30T06:50:00Z', minMag: 6.2, approx: [42.83, 13.11] },
  // ---- Chile ----
  { region: 'chile', key: 'maule2010', presetId: 'cl-2010-maule', name: '2010 Maule (M8.8)',
    start: '2010-02-27T06:30:00Z', end: '2010-02-27T06:45:00Z', minMag: 8.4, approx: [-36.12, -72.90] },
  { region: 'chile', key: 'illapel2015', presetId: 'cl-2015-illapel', name: '2015 Illapel (M8.3)',
    start: '2015-09-16T22:50:00Z', end: '2015-09-16T23:05:00Z', minMag: 7.9, approx: [-31.57, -71.67] },
  { region: 'chile', key: 'iquique2014', presetId: 'cl-2014-iquique', name: '2014 Iquique (M8.2)',
    start: '2014-04-01T23:40:00Z', end: '2014-04-01T23:55:00Z', minMag: 7.8, approx: [-19.61, -70.77] },
  // ---- Taiwan ----
  { region: 'taiwan', key: 'chichi1999', presetId: 'tw-1999-chichi', name: '1999 Chi-Chi (M7.7)',
    start: '1999-09-20T17:40:00Z', end: '1999-09-20T17:55:00Z', minMag: 7.3, approx: [23.85, 120.82] },
  { region: 'taiwan', key: 'hualien2024', presetId: 'tw-2024-hualien', name: '2024 Hualien (M7.4)',
    start: '2024-04-02T23:55:00Z', end: '2024-04-03T00:10:00Z', minMag: 7.0, approx: [23.77, 121.67] },
  // ---- New Zealand ----
  { region: 'newzealand', key: 'darfield2010', presetId: 'nz-2010-darfield', name: '2010 Darfield (M7.0)',
    start: '2010-09-03T16:30:00Z', end: '2010-09-03T16:45:00Z', minMag: 6.7, approx: [-43.53, 172.12] },
  { region: 'newzealand', key: 'christchurch2011', presetId: 'nz-2011-christchurch', name: '2011 Christchurch (M6.1)',
    start: '2011-02-21T23:45:00Z', end: '2011-02-22T00:00:00Z', minMag: 5.9, approx: [-43.58, 172.70] },
  { region: 'newzealand', key: 'kaikoura2016', presetId: 'nz-2016-kaikoura', name: '2016 Kaikoura (M7.8)',
    start: '2016-11-13T11:00:00Z', end: '2016-11-13T11:15:00Z', minMag: 7.4, approx: [-42.69, 173.05] },
];

const PGA_TO_GAL = { '%g': GAL_PER_G / 100, 'g': GAL_PER_G, 'cm/s^2': 1, 'cm/s/s': 1, 'gal': 1 };
const PGV_TO_CMS = { 'cm/s': 1, 'cm/sec': 1, 'in/s': 2.54, 'm/s': 100 };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'quake-sim-region-obs-fetch/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function round(v, d) {
  if (v == null || !isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function amplitudeUnits(stationFeatures) {
  const pgaUnits = new Set(), pgvUnits = new Set();
  for (const f of stationFeatures) {
    const chans = (f.properties && f.properties.channels) || [];
    for (const ch of chans) {
      for (const a of (ch.amplitudes || [])) {
        if (a.name === 'pga' && a.units) pgaUnits.add(a.units);
        if (a.name === 'pgv' && a.units) pgvUnits.add(a.units);
      }
    }
  }
  if (pgaUnits.size !== 1 || !PGA_TO_GAL[pgaUnits.values().next().value]) {
    throw new Error('unexpected/absent pga units: ' + [...pgaUnits].join(','));
  }
  if (pgvUnits.size !== 1 || !PGV_TO_CMS[pgvUnits.values().next().value]) {
    throw new Error('unexpected/absent pgv units: ' + [...pgvUnits].join(','));
  }
  return {
    pgaUnits: [...pgaUnits][0], pgvUnits: [...pgvUnits][0],
    pgaToGal: PGA_TO_GAL[[...pgaUnits][0]], pgvToCms: PGV_TO_CMS[[...pgvUnits][0]]
  };
}

// Instrumented records only. Macroseismic entries (DYFI grids or curated
// intensity points converted to PGM via GMICE) are NOT ground-motion records:
// they are excluded by station_type when present, and by the network/commType
// markers used in the atlas products when station_type is absent (the Maule
// 2010 lower-weight product carries no station_type field at all).
function isInstrumented(p) {
  if (p.station_type && p.station_type !== 'seismic') return false;
  if (String(p.network || '').toUpperCase() === 'INTENSITY') return false;
  if (String(p.commType || '').toLowerCase() === 'intensity') return false;
  return true;
}

function instrumentedStations(stationlist, units, maxStations) {
  const stations = [];
  for (const f of (stationlist.features || [])) {
    const p = f.properties || {};
    if (!isInstrumented(p)) continue;
    const pgaRaw = p.pga, pgvRaw = p.pgv;
    if (typeof pgaRaw !== 'number' || typeof pgvRaw !== 'number') continue;
    if (!(pgaRaw > 0) || !(pgvRaw > 0)) continue;
    const coords = (f.geometry && f.geometry.coordinates) || [];
    if (!isFinite(coords[0]) || !isFinite(coords[1])) continue;
    stations.push({
      code: String(p.code || f.id || ''),
      network: String(p.network || ''),
      lat: round(coords[1], 4),
      lng: round(coords[0], 4),
      vs30: (typeof p.vs30 === 'number' && p.vs30 > 0) ? round(p.vs30, 0) : null,
      pgaGal: round(pgaRaw * units.pgaToGal, 2),
      pgvCms: round(pgvRaw * units.pgvToCms, 3),
      intensity: (typeof p.intensity === 'number') ? round(p.intensity, 2) : null,
      intensityType: 'MMI'
    });
  }
  stations.sort((a, b) => b.pgaGal - a.pgaGal);
  return stations.filter(s => s.pgaGal >= MIN_PGA_GAL).slice(0, maxStations);
}

async function resolveEventId(spec) {
  const url = FDSN + '?format=geojson&starttime=' + encodeURIComponent(spec.start)
    + '&endtime=' + encodeURIComponent(spec.end) + '&minmagnitude=' + spec.minMag;
  const fc = await fetchJson(url);
  const feats = (fc.features || []).slice();
  if (!feats.length) throw new Error('no USGS event in window for ' + spec.key);
  feats.sort((a, b) => {
    const ca = a.geometry.coordinates, cb = b.geometry.coordinates;
    const da = (ca[1] - spec.approx[0]) ** 2 + (ca[0] - spec.approx[1]) ** 2;
    const db = (cb[1] - spec.approx[0]) ** 2 + (cb[0] - spec.approx[1]) ** 2;
    return da - db;
  });
  return { id: feats[0].id, queryUrl: url };
}

// Pick the shakemap product with the most preferred weight that still carries
// >= MIN_INSTRUMENTED instrumented stations; remember every skipped product.
async function pickStationlist(detail, maxStations) {
  const shakemaps = ((detail.properties.products && detail.properties.products.shakemap) || [])
    .slice().sort((a, b) => (b.preferredWeight || 0) - (a.preferredWeight || 0));
  if (!shakemaps.length) throw new Error('no shakemap product for ' + detail.id);
  const skipped = [];
  let best = null;
  for (const sm of shakemaps) {
    const content = sm.contents && sm.contents['download/stationlist.json'];
    if (!content || !content.url) continue;
    const stationlist = await fetchJson(content.url);
    const units = amplitudeUnits(stationlist.features || []);
    const stations = instrumentedStations(stationlist, units, maxStations);
    const rec = { productCode: sm.code || '', source: sm.source || 'unknown', url: content.url, stations, units };
    if (stations.length >= MIN_INSTRUMENTED) {
      return { picked: rec, skipped };
    }
    skipped.push({ productCode: rec.productCode, source: rec.source, instrumented: stations.length });
    if (!best || stations.length > best.stations.length) best = rec;
  }
  if (best && best.stations.length >= 1) {
    // No product reaches the floor: keep the best one but fail the event below
    // (kept explicit so a silent thin set can never slip in).
    const err = new Error('no shakemap product reaches the ' + MIN_INSTRUMENTED + '-station floor for '
      + detail.id + ' (best: ' + best.productCode + ' instrumented=' + best.stations.length + ')');
    err.skipped = skipped;
    throw err;
  }
  throw new Error('no usable shakemap stationlist for ' + detail.id);
}

function canonRake(r) {
  let x = Number(r);
  while (x > 180) x -= 360;
  while (x <= -180) x += 360;
  return x;
}

// Mechanism from the dual moment-tensor/focal-mechanism product set (same
// rule as tools/fetch-comcat-presets.js; nodal-plane-1 picked because there
// is no pack preset plane to match against — documented in provenance).
function mechanismFromProducts(detail) {
  const products = (detail.properties && detail.properties.products) || {};
  const mts = (products['moment-tensor'] || []).map(m => ({ m, ptype: 'moment-tensor' }))
    .concat((products['focal-mechanism'] || []).map(m => ({ m, ptype: 'focal-mechanism' })));
  if (!mts.length) return null;
  const gcmtish = (e) => e.m.source === 'gcmt' || /gcmt/i.test(e.m.code || '') ||
    (e.m.properties && /gcmt/i.test(e.m.properties.eventsource || ''));
  const sorted = mts.slice().sort((a, b) => {
    const ga = gcmtish(a) ? 0 : 1, gb = gcmtish(b) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const pw = (b.m.preferredWeight || 0) - (a.m.preferredWeight || 0);
    if (pw) return pw;
    return (a.ptype === 'moment-tensor' ? 0 : 1) - (b.ptype === 'moment-tensor' ? 0 : 1);
  });
  for (const { m: mt, ptype } of sorted) {
    const p = mt.properties || {};
    const s1 = parseFloat(p['nodal-plane-1-strike']), d1 = parseFloat(p['nodal-plane-1-dip']), r1 = parseFloat(p['nodal-plane-1-rake']);
    if (![s1, d1, r1].every(isFinite)) continue;
    return {
      strikeDeg: +s1.toFixed(1), dipDeg: +d1.toFixed(1), rakeDeg: +canonRake(r1).toFixed(1),
      source: (mt.source || 'unknown') + '/' + (mt.code || ''),
      productType: ptype,
      planeChoice: 'nodal-plane-1 (no pack preset plane to match; alternate plane is the complementary solution)'
    };
  }
  return null;
}

async function fetchEvent(spec, maxStations, retrievedAt) {
  const { id, queryUrl } = await resolveEventId(spec);
  const detail = await fetchJson(FDSN + '?eventid=' + encodeURIComponent(id) + '&format=geojson');
  const { picked, skipped } = await pickStationlist(detail, maxStations);
  const stations = picked.stations;
  if (stations.length < MIN_INSTRUMENTED) {
    throw new Error(spec.key + ': only ' + stations.length + ' instrumented stations (floor ' + MIN_INSTRUMENTED + ')');
  }

  const gc = detail.geometry.coordinates;
  const maxPga = stations[0].pgaGal;
  if (!(maxPga >= 10 && maxPga <= 3500)) {
    throw new Error(spec.key + ': max PGA sanity gate failed (' + maxPga + ' gal outside 10..3500 — unit trap check)');
  }

  // Prediction-side link: pack preset id, or a frozen ComCat prediction block.
  let prediction = null;
  if (!spec.presetId) {
    const mech = mechanismFromProducts(detail);
    prediction = {
      lat: round(gc[1], 4), lng: round(gc[0], 4), depthKm: round(gc[2], 1),
      mw: detail.properties.mag,
      sourceType: spec.sourceType,
      strikeDeg: mech ? mech.strikeDeg : null,
      dipDeg: mech ? mech.dipDeg : null,
      rakeDeg: mech ? mech.rakeDeg : null,
      mechanism: mech,
      provenance: 'ComCat event detail (fdsnws eventid query) + dual moment-tensor/focal-mechanism products; '
        + 'hypocenter and magnitude are the USGS preferred origin values (no region-pack preset exists for this event)'
    };
  }

  const ev = {
    eventId: spec.key,
    region: spec.region,
    presetId: spec.presetId || null,
    predictionSource: spec.presetId ? 'pack-preset' : 'comcat-frozen',
    usgsId: detail.id,
    name: spec.name,
    time: new Date(detail.properties.time).toISOString(),
    lat: round(gc[1], 4), lng: round(gc[0], 4), depthKm: round(gc[2], 1),
    mw: detail.properties.mag, magType: detail.properties.magType || null,
    provenance: {
      provider: 'USGS Shakemap (station data as contributed to the Atlas/event products)',
      queryUrl,
      shakemapSource: picked.source,
      productCode: picked.productCode,
      sourceUrl: picked.url,
      retrievedAt,
      license: 'USGS public domain; contributed station data per contributing network terms of use',
      amplitudeUnits: { pga: picked.units.pgaUnits + ' (converted to gal, 1 g = 980.665 gal)', pgv: picked.units.pgvUnits },
      instrumentedRule: "station_type 'seismic' (or absent) AND network != 'INTENSITY' AND commType != 'Intensity' AND numeric pga>0 & pgv>0",
      productFallback: skipped.length ? skipped : undefined
    },
    stationCount: stations.length,
    maxObservedPgaGal: round(maxPga, 2),
    stations
  };
  if (prediction) ev.prediction = prediction;
  return ev;
}

async function main() {
  const args = process.argv.slice(2);
  const outArg = args.find(a => a.startsWith('--out='));
  const maxArg = args.find(a => a.startsWith('--max-stations='));
  const outPath = outArg ? outArg.split('=')[1] : 'public/geojson/region-obs.json';
  const maxStations = maxArg ? parseInt(maxArg.split('=')[1], 10) : DEFAULT_MAX_STATIONS;
  const retrievedAt = new Date().toISOString();

  const events = [];
  for (const spec of EVENTS) {
    process.stdout.write('fetching ' + spec.region + '/' + spec.key + ' ... ');
    const ev = await fetchEvent(spec, maxStations, retrievedAt);
    console.log(ev.usgsId + ' product=' + ev.provenance.productCode + ' stations=' + ev.stationCount
      + ' maxPgaGal=' + ev.maxObservedPgaGal
      + (ev.provenance.productFallback ? ' FALLBACK=' + JSON.stringify(ev.provenance.productFallback) : ''));
    events.push(ev);
  }

  const payload = {
    schema: 'quake-sim-region-obs-v1',
    generatedAt: retrievedAt,
    note: 'Frozen observed strong-motion station peaks for the five bundled regions (USGS Shakemap stationlists; '
      + 'instrumented stations only — macroseismic INTENSITY/DYFI pseudo-PGM excluded). pgaGal/pgvCms are the '
      + 'shakemap aggregate peak (larger horizontal component), converted from the units recorded in each event '
      + 'provenance. intensity is shakemap instrumental MMI (GMICE-converted), NOT JMA intensity — do not mix '
      + 'scales; derive observed JMA intensity from pgaGal/pgvCms instead. Station vs30 is the stationlist value '
      + 'or null (Maule 2010 lower-weight product carries none — the scorecard falls back to the region Vs30 '
      + 'grid). Prediction side: events with presetId are predicted from the region-pack preset (app behavior); '
      + 'the others carry a frozen ComCat `prediction` block here.',
    events
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let out = '{\n  "schema": ' + JSON.stringify(payload.schema) + ',\n  "generatedAt": '
    + JSON.stringify(payload.generatedAt) + ',\n  "note": ' + JSON.stringify(payload.note) + ',\n  "events": [\n';
  out += events.map(ev => {
    const head = { ...ev }; delete head.stations;
    const headJson = JSON.stringify(head, null, 2).replace(/\n/g, '\n    ').replace(/\s+}$/, '');
    return '    ' + headJson
      + ',\n    "stations": [\n'
      + ev.stations.map(s => '      ' + JSON.stringify(s)).join(',\n')
      + '\n    ]}';
  }).join(',\n') + '\n  ]\n}\n';
  fs.writeFileSync(outPath, out);
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log('wrote ' + outPath + ' (' + kb + ' KB, ' + events.reduce((n, e) => n + e.stationCount, 0) + ' stations)');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { EVENTS, MIN_INSTRUMENTED, isInstrumented, instrumentedStations, canonRake, mechanismFromProducts };
