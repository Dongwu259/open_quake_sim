'use strict';

// Merge cited, exact-station intensity records into a new observed dataset.
// Usage: node tools/import-observed-intensity.js manifest.json output.json
// Manifest: {"schema":"quake-sim-observation-import-v1","records":[...]}

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error('Usage: node tools/import-observed-intensity.js manifest.json output.json');
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

const manifest = readJson(inputArg);
if (manifest.schema !== 'quake-sim-observation-import-v1' || !Array.isArray(manifest.records)) {
  throw new Error('Manifest must use quake-sim-observation-import-v1 with a records array');
}
const observed = readJson(path.join(ROOT, 'public/geojson/observed.json'));
const stations = readJson(path.join(ROOT, 'public/geojson/stations.json'));
const stationsById = new Map(stations.map(station => [String(station.id), station]));
const jmaCatalogPath = path.join(ROOT, 'public/geojson/jma_stations.json');
const jmaCatalog = fs.existsSync(jmaCatalogPath) ? readJson(jmaCatalogPath) : {stations:[]};
for (const station of (jmaCatalog.stations || [])) stationsById.set(String(station.id), station);
const validIntensity = /^(?:[0-7]|5[+-]|6[+-])$/;
let imported = 0;

for (const record of manifest.records) {
  const eventId = String(record.event || '');
  const stationId = String(record.stationId == null ? '' : record.stationId);
  const event = observed[eventId];
  const station = stationsById.get(stationId);
  if (!event || eventId.startsWith('_')) throw new Error(`Unknown event: ${eventId}`);
  if (!station) throw new Error(`Unknown stationId: ${stationId}`);
  if (!validIntensity.test(String(record.intensity))) throw new Error(`Invalid intensity for ${eventId}/${stationId}`);
  if (!record.source || !/^https?:\/\//.test(String(record.source))) {
    throw new Error(`A source URL is required for ${eventId}/${stationId}`);
  }
  const label = String(record.label || station.name || stationId);
  event.obs[label] = {
    intensity:record.intensity,stationId:station.id,quality:record.quality || 'direct',
    source:String(record.source)
  };
  if (record.sourceRecord != null) event.obs[label].sourceRecord = String(record.sourceRecord);
  if (event.obs[label].quality !== 'direct') throw new Error(`Imported exact observations must use quality=direct: ${eventId}/${stationId}`);
  imported++;
}

const output = path.resolve(outputArg);
fs.writeFileSync(output, JSON.stringify(observed, null, 2) + '\n', 'utf8');
console.log(`Wrote ${output}: ${imported} cited exact-station observations`);
