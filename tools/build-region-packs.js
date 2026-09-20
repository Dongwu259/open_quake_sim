#!/usr/bin/env node
// v6.4 multi-region: builds region-<id>.json packs (quake-sim-region-pack-v1)
// for the global-mode pilot regions. Each pack carries the coarse seed
// stations (pre-real-station display/sim grid), historical-scenario presets
// and the activation bounds. Real station/area packages are fetched
// separately (fetch-region-stations.js / fetch-region-areas.js) and replace
// the seed grid at activation.
//
// Preset mechanisms: published USGS/gCMT W-phase values rounded to whole
// degrees where the event is instrumentally constrained; pre-instrumental
// events (1908 Messina, 1960 Valdivia) carry mechanismKnown:true with
// literature-typical thrust/normal values (documented approximations).
//
// Usage: node tools/build-region-packs.js [--write]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function seed(stations) {
  return stations.map(([name, lat, lng, vs30]) => ({ name, lat, lng, vs30 }));
}

// Vs30 seed values are coarse city-site estimates (rock hills ~600, plain
// ~250-400) — the real-station package replaces this grid at activation and
// region Vs30 grids may override again; the seed grid exists only so global
// mode renders before the FDSN package lands.
const REGIONS = {
  italy: {
    bounds: [[36.5, 6.5], [47.2, 18.6]],
    homeZoom: 6,
    tsunami: false, // regional bathymetry not bundled (Japan grids only) - honest off
    notes: 'Italy pilot region. Real stations: INGV FDSN (operational epochs). Areas: ISTAT provinces. No regional bathymetry - tsunami simulation stays off.',
    stations: seed([
      ['Roma', 41.90, 12.50, 450], ['Milano', 45.46, 9.19, 300], ['Napoli', 40.85, 14.27, 350],
      ['Torino', 45.07, 7.69, 320], ['Palermo', 38.12, 13.36, 400], ['Genova', 44.41, 8.93, 350],
      ['Bologna', 44.49, 11.34, 250], ['Firenze', 43.77, 11.26, 300], ['Venezia', 45.44, 12.33, 250],
      ['Bari', 41.13, 16.87, 300], ['Catania', 37.51, 15.09, 350], ['Messina', 38.19, 15.55, 350],
      ['Cagliari', 39.22, 9.12, 400], ['Trieste', 45.65, 13.78, 400], ['Perugia', 43.11, 12.39, 500],
      ["L'Aquila", 42.35, 13.40, 500], ['Padova', 45.41, 11.88, 300], ['Verona', 45.44, 10.99, 350],
      ['Trento', 46.07, 11.12, 500], ['Ancona', 43.62, 13.51, 400], ['Pescara', 42.46, 14.21, 300],
      ['Salerno', 40.68, 14.77, 350], ['Reggio Calabria', 38.11, 15.65, 350], ['Modena', 44.65, 10.93, 250],
      ['Parma', 44.80, 10.33, 250], ['La Spezia', 44.10, 9.83, 350], ['Sassari', 40.73, 8.56, 400],
      ['Cosenza', 39.30, 16.25, 400], ['Foggia', 41.46, 15.54, 300], ['Potenza', 40.64, 15.81, 450],
      ['Campobasso', 41.56, 14.66, 450], ['Caserta', 41.07, 14.33, 300], ['Viterbo', 42.42, 12.10, 400],
      ['Arezzo', 43.46, 11.88, 400], ['Udine', 46.07, 13.24, 350], ['Bergamo', 45.70, 9.67, 400],
    ]),
    presets: [
      { id: 'it-2016-norcia', label: '2016 Norcia M6.5 (IT)', lat: 42.842, lng: 13.109, mag: 6.5, depth: 9, strike: 155, dip: 52, rake: -90, mechanismKnown: true, time: '2016/10/30 06:40' },
      { id: 'it-2016-amatrice', label: '2016 Amatrice M6.2 (IT)', lat: 42.698, lng: 13.235, mag: 6.2, depth: 6, strike: 157, dip: 50, rake: -85, mechanismKnown: true, time: '2016/08/24 01:36' },
      { id: 'it-2009-laquila', label: "2009 L'Aquila M6.3 (IT)", lat: 42.342, lng: 13.380, mag: 6.3, depth: 9, strike: 133, dip: 44, rake: -83, mechanismKnown: true, time: '2009/04/06 01:32' },
      { id: 'it-1980-irpinia', label: '1980 Irpinia M6.9 (IT)', lat: 40.842, lng: 15.295, mag: 6.9, depth: 18, strike: 305, dip: 60, rake: -85, mechanismKnown: true, time: '1980/11/23 18:34' },
      { id: 'it-1908-messina', label: '1908 Messina M7.1 (IT)', lat: 38.15, lng: 15.68, mag: 7.1, depth: 10, strike: 250, dip: 50, rake: -70, mechanismKnown: true, time: '1908/12/28 04:20' },
    ],
  },
  chile: {
    bounds: [[-56.0, -76.0], [-17.0, -66.0]],
    homeZoom: 5,
    tsunami: false, // regional bathymetry not bundled (Japan grids only) - honest off
    notes: 'Chile pilot region. Real stations: CSN national network C1 via EarthScope FDSN (open data). Areas: Natural Earth 10m admin-1 regions. No regional bathymetry - tsunami simulation stays off.',
    stations: seed([
      ['Santiago', -33.45, -70.67, 350], ['Valparaíso', -33.05, -71.62, 300], ['Concepción', -36.83, -73.05, 300],
      ['Antofagasta', -23.65, -70.40, 400], ['Temuco', -38.74, -72.60, 300], ['La Serena', -29.90, -71.25, 300],
      ['Iquique', -20.21, -70.14, 350], ['Rancagua', -34.17, -70.74, 300], ['Talca', -35.43, -71.66, 300],
      ['Puerto Montt', -41.47, -72.94, 300], ['Coquimbo', -30.20, -71.34, 300], ['Copiapó', -27.37, -70.33, 400],
      ['Arica', -18.48, -70.32, 350], ['Osorno', -40.57, -73.14, 300], ['Punta Arenas', -53.16, -70.91, 350],
      ['Chillán', -36.61, -72.10, 300], ['Valdivia', -39.81, -73.25, 300], ['Calama', -22.46, -68.94, 400],
    ]),
    presets: [
      { id: 'cl-1960-valdivia', label: '1960 Valdivia M9.5 (CL)', lat: -38.143, lng: -73.407, mag: 9.5, depth: 25, strike: 5, dip: 14, rake: 100, mechanismKnown: true, time: '1960/05/22 15:11' },
      { id: 'cl-2010-maule', label: '2010 Maule M8.8 (CL)', lat: -36.122, lng: -72.898, mag: 8.8, depth: 22, strike: 16, dip: 18, rake: 112, mechanismKnown: true, time: '2010/02/27 03:34' },
      { id: 'cl-2015-illapel', label: '2015 Illapel M8.3 (CL)', lat: -31.571, lng: -71.658, mag: 8.3, depth: 25, strike: 5, dip: 23, rake: 101, mechanismKnown: true, time: '2015/09/16 22:54' },
      { id: 'cl-2014-iquique', label: '2014 Iquique M8.1 (CL)', lat: -19.610, lng: -70.769, mag: 8.1, depth: 25, strike: -8, dip: 13, rake: 105, mechanismKnown: true, time: '2014/04/01 23:46' },
    ],
  },
};

const california = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-california.json'), 'utf8'));

function build(id, def) {
  return {
    schema: 'quake-sim-region-pack-v1',
    id,
    test: california.test !== undefined ? california.test : true,
    bounds: def.bounds,
    homeZoom: def.homeZoom,
    tsunami: def.tsunami,
    notes: def.notes,
    stations: def.stations,
    presets: def.presets,
  };
}

const dry = !process.argv.includes('--write');
for (const [id, def] of Object.entries(REGIONS)) {
  const pack = build(id, def);
  const out = path.join(ROOT, 'public', 'geojson', 'region-' + id + '.json');
  if (dry) {
    console.log('[dry] %s: %d seed stations, %d presets', id, pack.stations.length, pack.presets.length);
  } else {
    fs.writeFileSync(out, JSON.stringify(pack));
    console.log('wrote %s (%d seed stations, %d presets, %.1f KB)', out, pack.stations.length, pack.presets.length, fs.statSync(out).size / 1024);
  }
}
