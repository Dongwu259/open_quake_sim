'use strict';

// Import exact JMA Shindo Database station observations for the fixed
// independent validation events. The JMA catalog uses its own station codes,
// so it is kept separate from the NIED station list used by the simulator.
// Usage: node tools/import-jma-independent.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://www.data.jma.go.jp/eqdb/data/shindo/api/';
const SOURCE_BASE = 'https://www.data.jma.go.jp/eqdb/data/shindo/';
const EVENTS = [
  {id:'fukushima2021', jmaId:'20210213230750'},
  {id:'kushiro1993', jmaId:'19930115200607'},
  {id:'tonankai1944', jmaId:'19441207133540'},
  {id:'nankai1946', jmaId:'19461221041904'},
  {id:'niigata1964', jmaId:'19640616130140'}
];

function postForm(entries) {
  const body = new URLSearchParams(entries);
  return fetch(API, {method:'POST', body}).then(async response => {
    if (!response.ok) throw new Error(`JMA API HTTP ${response.status}`);
    const data = await response.json();
    if (!data.res || !Array.isArray(data.res.int)) {
      throw new Error(`JMA event ${entries.find(([key]) => key === 'id')?.[1] || ''} has no intensity records`);
    }
    return data.res;
  });
}

function normalizeIntensity(row) {
  const char = String(row.char || '').trim();
  if (char === 'A') return '5-';
  if (char === 'B') return '5+';
  if (char === 'C') return '6-';
  if (char === 'D') return '6+';
  if (/^[0-7]$/.test(char)) return char;
  const text = String(row.int || '');
  if (text.includes('5弱')) return '5-';
  if (text.includes('5強')) return '5+';
  if (text.includes('6弱')) return '6-';
  if (text.includes('6強')) return '6+';
  if (text.includes('震度7')) return '7';
  const match = text.match(/[0-7]/);
  return match ? match[0] : null;
}

async function main() {
  const observedPath = path.join(ROOT, 'public/geojson/observed.json');
  const catalogPath = path.join(ROOT, 'public/geojson/jma_stations.json');
  const observed = JSON.parse(fs.readFileSync(observedPath, 'utf8'));
  const jmaStations = Object.create(null);
  let imported = 0;

  for (const item of EVENTS) {
    const event = observed[item.id];
    if (!event) throw new Error(`Unknown observed event: ${item.id}`);
    const detail = await postForm([['mode','event'], ['id', item.jmaId]]);
    const source = `${SOURCE_BASE}#${item.jmaId}`;
    event.jmaEventId = item.jmaId;
    event.obs = event.obs || {};
    for (const row of detail.int) {
      const intensity = normalizeIntensity(row);
      const code = String(row.code || '').trim();
      const lat = Number(row.lat), lng = Number(row.lon);
      if (!code || !intensity || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const stationId = `jma:${code}`;
      jmaStations[stationId] = {
        id: stationId,
        jmaCode: code,
        name: String(row.name || code).replace(/[＊*]$/, ''),
        lat, lng,
        network: 'JMA',
        source: 'JMA Shindo Database',
        sourceUrl: source
      };
      event.obs[`JMA:${code}`] = {
        intensity,
        stationId,
        quality: 'direct',
        source,
        sourceRecord: item.jmaId
      };
      imported++;
    }
  }

  const catalog = {
    _schema: 'quake-sim-jma-station-catalog-v1',
    _source: SOURCE_BASE,
    _license: 'Source metadata from the JMA Shindo Database; retain attribution and verify current JMA terms before redistribution',
    stations: Object.values(jmaStations).sort((a, b) => a.id.localeCompare(b.id))
  };
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  fs.writeFileSync(observedPath, JSON.stringify(observed, null, 2) + '\n', 'utf8');
  console.log(`Imported ${imported} exact JMA observations across ${EVENTS.length} independent events`);
  console.log(`Wrote ${catalogPath}: ${catalog.stations.length} unique JMA stations`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
