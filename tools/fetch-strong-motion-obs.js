#!/usr/bin/env node
'use strict';
// ================================================================
//  Fetch + freeze observed strong-motion station peaks for six Japanese
//  earthquakes from the USGS Shakemap stationlists. For Japan the USGS
//  stationlists ARE the NIED K-NET/KiK-net contributions (network codes
//  KNET/KIK), so this is our observed strong-motion source (bosai.go.jp
//  is unreachable from the build environment).
//
//  Pipeline per event: fdsnws time-window query -> event id -> detail
//  geojson -> shakemap product -> download/stationlist.json.
//
//  UNIT TRAP: stationlist PGA amplitudes are in %g (percent of gravity),
//  PGV in cm/s. The units are read from the per-channel amplitude entries
//  of the actual JSON (never assumed) and converted to gal (cm/s^2) with
//  1 g = 980.665 gal. Sanity gate: Tohoku near-field max must land in
//  500..4000 gal (observed 2011 maxima are ~2000-3000 gal).
//
//  Output: public/geojson/strong-motion-obs.json
//    schema quake-sim-strong-motion-obs-v1
//
//  Usage: node tools/fetch-strong-motion-obs.js [--out=path] [--max-stations=N]
// ================================================================
const fs = require('fs');
const path = require('path');

const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const GAL_PER_G = 980.665;
const MIN_PGA_GAL = 2;       // keep stations with observed PGA >= 2 gal
const DEFAULT_MAX_STATIONS = 600;

// sourceType matches the app's classification (public/geojson/observed.json
// src fields, preset comments and Physics.resolveSourceTypeAt semantics):
// offshore subduction-zone events -> interplate, deep slab event -> intraslab,
// shallow inland events -> crustal. fukushima2022 is the Goldberg 2022
// intraslab model in-app (preset depth 63 km -> intraslab band).
// R1 expansion (2026-08-24): +7 crustal events with JMA hypocenters already
// frozen in observed.json (kobe1995 had only 20 instrumented stations and
// tottori2016 only 2 — both below the 100-station quality gate and stay out;
// kushiro1993 has no shakemap stationlist at all).
const EVENTS = [
  { key: 'tohoku2011',    name: '2011 Great Tohoku Earthquake (M9.1)',
    start: '2011-03-11T05:40:00Z', end: '2011-03-11T06:00:00Z', minMag: 8.5,
    approx: [38.30, 142.37], sourceType: 'interplate' },
  { key: 'kumamoto2016',  name: '2016 Kumamoto mainshock (M7.0)',
    start: '2016-04-15T16:20:00Z', end: '2016-04-15T16:35:00Z', minMag: 6.8,
    approx: [32.75, 130.76], sourceType: 'crustal' },
  { key: 'tokachi2003',   name: '2003 Tokachi-oki (M8.3)',
    start: '2003-09-25T19:45:00Z', end: '2003-09-25T20:05:00Z', minMag: 8.0,
    approx: [41.81, 143.91], sourceType: 'interplate' },
  { key: 'fukushima2022', name: '2022 Fukushima-oki (M7.3)',
    // 2022-03-16 23:36 JST = 14:36 UTC (an M6.0 foreshock 2 min earlier is
    // excluded by minMag + the closest-to-approx pick).
    start: '2022-03-16T14:30:00Z', end: '2022-03-16T14:50:00Z', minMag: 7.0,
    approx: [37.70, 141.59], sourceType: 'intraslab' },
  { key: 'noto2024',      name: '2024 Noto Peninsula (M7.5)',
    start: '2024-01-01T07:05:00Z', end: '2024-01-01T07:25:00Z', minMag: 7.3,
    approx: [37.50, 137.27], sourceType: 'crustal' },
  { key: 'hyuganada2024', name: '2024 Hyuganada (M7.1)',
    start: '2024-08-08T07:38:00Z', end: '2024-08-08T07:58:00Z', minMag: 6.8,
    approx: [31.72, 131.53], sourceType: 'interplate' },
  // --- R1 expansion: crustal events, JMA hypocenters in observed.json ---
  { key: 'chuetsu2004',   name: '2004 Niigata Chuetsu (M6.8)',
    start: '2004-10-23T08:50:00Z', end: '2004-10-23T09:10:00Z', minMag: 6.0,
    approx: [37.29, 138.87], sourceType: 'crustal' },
  { key: 'iwate2008',     name: '2008 Iwate-Miyagi Nairiku (M7.2)',
    start: '2008-06-13T23:35:00Z', end: '2008-06-14T00:00:00Z', minMag: 6.4,
    approx: [39.03, 140.88], sourceType: 'crustal' },
  { key: 'fukuoka2005',   name: '2005 Fukuoka-oki Genkai (M7.0)',
    start: '2005-03-20T01:45:00Z', end: '2005-03-20T02:05:00Z', minMag: 6.0,
    approx: [33.74, 130.18], sourceType: 'crustal' },
  { key: 'noto2007',      name: '2007 Noto-oki (M6.9)',
    start: '2007-03-25T00:35:00Z', end: '2007-03-25T00:55:00Z', minMag: 6.0,
    approx: [37.22, 136.69], sourceType: 'crustal' },
  { key: 'fukushima2011', name: '2011 Fukushima Hamadori (M7.0)',
    start: '2011-04-11T08:10:00Z', end: '2011-04-11T08:30:00Z', minMag: 6.2,
    approx: [36.95, 140.67], sourceType: 'crustal' },
  { key: 'yamagata2019',  name: '2019 Yamagata-oki (M6.7)',
    start: '2019-06-18T13:15:00Z', end: '2019-06-18T13:35:00Z', minMag: 6.0,
    approx: [38.61, 139.53], sourceType: 'crustal' },
  { key: 'iburihigashi2018', name: '2018 Hokkaido Iburi East (M6.7)',
    start: '2018-09-05T18:00:00Z', end: '2018-09-05T18:25:00Z', minMag: 6.0,
    approx: [42.69, 142.01], sourceType: 'crustal' }
];

// Unit conversion tables, keyed by the exact units strings shakemap emits.
const PGA_TO_GAL = { '%g': GAL_PER_G / 100, 'g': GAL_PER_G, 'cm/s^2': 1, 'cm/s/s': 1, 'gal': 1 };
const PGV_TO_CMS = { 'cm/s': 1, 'cm/sec': 1, 'in/s': 2.54, 'm/s': 100 };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'quake-sim-strong-motion-fetch/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function round(v, d) {
  if (v == null || !isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// Read the per-channel amplitude units from the actual JSON; refuse to guess.
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

async function resolveEventId(spec) {
  const url = FDSN + '?format=geojson&starttime=' + encodeURIComponent(spec.start)
    + '&endtime=' + encodeURIComponent(spec.end) + '&minmagnitude=' + spec.minMag;
  const fc = await fetchJson(url);
  const feats = fc.features || [];
  if (!feats.length) throw new Error('no USGS event in window for ' + spec.key);
  // Pick the feature closest to the expected epicenter (guards against
  // aftershocks/foreshocks sharing the window).
  feats.sort((a, b) => {
    const ca = a.geometry.coordinates, cb = b.geometry.coordinates;
    const da = (ca[1] - spec.approx[0]) ** 2 + (ca[0] - spec.approx[1]) ** 2;
    const db = (cb[1] - spec.approx[0]) ** 2 + (cb[0] - spec.approx[1]) ** 2;
    return da - db;
  });
  return { id: feats[0].id, detailUrl: feats[0].properties.detail };
}

function pickShakemapStationlist(detail) {
  const shakemaps = (detail.properties.products && detail.properties.products.shakemap) || [];
  for (const sm of shakemaps) { // products are ordered by preferred weight
    const content = sm.contents && sm.contents['download/stationlist.json'];
    if (content && content.url) return { url: content.url, source: sm.source || 'unknown' };
  }
  throw new Error('no shakemap stationlist.json for ' + detail.id);
}

async function fetchEvent(spec, maxStations, retrievedAt) {
  const { id } = await resolveEventId(spec);
  const detail = await fetchJson(FDSN + '?eventid=' + encodeURIComponent(id) + '&format=geojson');
  const sm = pickShakemapStationlist(detail);
  const stationlist = await fetchJson(sm.url);
  const features = stationlist.features || [];
  const units = amplitudeUnits(features);

  const stations = [];
  for (const f of features) {
    const p = f.properties || {};
    // Instrumented records only: macroseismic (DYFI) grid points carry
    // GMICE-derived pseudo-PGA/PGV, not observed ground motion.
    if (p.station_type && p.station_type !== 'seismic') continue;
    const pgaRaw = p.pga, pgvRaw = p.pgv;
    // DYFI/macroseismic entries carry the string 'null' — instrumented only.
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
      // Shakemap stationlist intensity for seismic stations is instrumental
      // MMI (PGM converted via GMICE), NOT JMA instrumental intensity.
      intensity: (typeof p.intensity === 'number') ? round(p.intensity, 2) : null,
      intensityType: 'MMI'
    });
  }
  stations.sort((a, b) => b.pgaGal - a.pgaGal);
  const kept = stations.filter(s => s.pgaGal >= MIN_PGA_GAL).slice(0, maxStations);

  const gc = detail.geometry.coordinates;
  const maxPga = kept.length ? kept[0].pgaGal : 0;
  return {
    eventId: spec.key,
    usgsId: detail.id,
    name: spec.name,
    time: new Date(detail.properties.time).toISOString(),
    lat: round(gc[1], 4), lng: round(gc[0], 4), depthKm: round(gc[2], 1),
    mw: detail.properties.mag, magType: detail.properties.magType || null,
    sourceType: spec.sourceType,
    provenance: {
      provider: 'USGS Shakemap (station data contributed by NIED K-NET/KiK-net)',
      shakemapSource: sm.source,
      sourceUrl: sm.url,
      retrievedAt,
      license: 'USGS public domain; NIED K-NET/KiK-net strong-motion data per NIED terms of use',
      amplitudeUnits: { pga: units.pgaUnits + ' (converted to gal, 1 g = 980.665 gal)', pgv: units.pgvUnits }
    },
    stationCount: kept.length,
    maxObservedPgaGal: round(maxPga, 2),
    stations: kept
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outArg = args.find(a => a.startsWith('--out='));
  const maxArg = args.find(a => a.startsWith('--max-stations='));
  const outPath = outArg ? outArg.split('=')[1] : 'public/geojson/strong-motion-obs.json';
  const maxStations = maxArg ? parseInt(maxArg.split('=')[1], 10) : DEFAULT_MAX_STATIONS;
  const retrievedAt = new Date().toISOString();

  const events = [];
  for (const spec of EVENTS) {
    process.stdout.write('fetching ' + spec.key + ' ... ');
    const ev = await fetchEvent(spec, maxStations, retrievedAt);
    console.log(ev.usgsId + ' stations=' + ev.stationCount + ' maxPgaGal=' + ev.maxObservedPgaGal);
    events.push(ev);
  }

  // Sanity gate: Tohoku near-field max must be ~1000-3000 gal (unit trap check).
  const tohoku = events.find(e => e.eventId === 'tohoku2011');
  if (!tohoku || !(tohoku.maxObservedPgaGal > 500 && tohoku.maxObservedPgaGal < 4000)) {
    throw new Error('Tohoku max PGA sanity check failed: ' + (tohoku && tohoku.maxObservedPgaGal)
      + ' gal (expected 500..4000; a ~1-3 value means the %g->gal conversion was dropped)');
  }

  const payload = {
    schema: 'quake-sim-strong-motion-obs-v1',
    generatedAt: retrievedAt,
    note: 'Frozen observed strong-motion station peaks (USGS Shakemap stationlists; NIED K-NET/KiK-net contributions). '
      + 'pgaGal/pgvCms are the shakemap aggregate peak (larger horizontal component), converted from the units '
      + 'recorded in each event provenance. intensity is shakemap instrumental MMI (GMICE-converted), NOT JMA '
      + 'intensity — do not mix scales; derive observed JMA intensity from pgaGal/pgvCms instead.',
    events
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Event envelope pretty-printed; station objects compact one-per-line.
  let out = '{\n  "schema": ' + JSON.stringify(payload.schema) + ',\n  "generatedAt": '
    + JSON.stringify(payload.generatedAt) + ',\n  "note": ' + JSON.stringify(payload.note) + ',\n  "events": [\n';
  out += events.map(ev => {
    const head = { ...ev }; delete head.stations;
    // Strip the head object's closing brace, then append the stations array.
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

module.exports = { EVENTS, PGA_TO_GAL, PGV_TO_CMS, amplitudeUnits };
