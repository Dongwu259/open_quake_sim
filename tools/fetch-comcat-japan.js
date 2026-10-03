'use strict';
// =====================================================================
// v6.1 P1 — freeze the USGS ComCat Japan-region catalog for PSHA.
//
// Fetches all natural earthquakes (eventtype=earthquake) with M>=5.0 in
// the Japan analysis bbox (125-150E / 24-46N) since 1923-01-01 from the
// ComCat FDSN web service and freezes the reduced event list into
// tools/data/psha/comcat-japan.json. USGS ComCat data is U.S. public
// domain, so the frozen copy is committable (unlike NIED products —
// see HANDOVER "永不入库" list; this dataset is not in it).
//
// The raw service response is kept under .cache/psha/ (not committed)
// for byte-level reproducibility; the frozen file keeps only the fields
// the source-model builder needs, plus per-event ids so the reduction
// is auditable against the raw response.
//
// Usage: node tools/fetch-comcat-japan.js [--region=<id>]
//   default (no flag) freezes the Japan catalog exactly as before
//   (tools/data/psha/comcat-japan.json, schema quake-sim-comcat-japan-v1).
//   --region=<california|italy|chile|taiwan|newzealand> freezes that
//   region's catalog to tools/data/psha/comcat-<id>.json (schema
//   quake-sim-comcat-region-v1) for the regional PSHA source models (v6.7 D).
// Exit codes: 0 ok, 1 network/validation failure (no partial write).
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Regional query windows (v6.7 D): bbox = the region pack's bounds widened
// by ~2 deg so boundary smoothing cells see events outside the pack frame.
// minCount is the freeze-refusal floor (Japan keeps its historical 1000).
const REGION_QUERIES = {
  japan:      { minLat: 24,   maxLat: 46,   minLng: 125, maxLng: 150,   minMag: 5.0, start: '1923-01-01', minCount: 1000 },
  california: { minLat: 30,   maxLat: 44,   minLng: -128, maxLng: -112, minMag: 5.0, start: '1923-01-01', minCount: 300 },
  italy:      { minLat: 34,   maxLat: 49,   minLng: 4,   maxLng: 21,    minMag: 5.0, start: '1923-01-01', minCount: 200 },
  chile:      { minLat: -57,  maxLat: -16,  minLng: -78, maxLng: -64,   minMag: 5.0, start: '1923-01-01', minCount: 1000 },
  taiwan:     { minLat: 20,   maxLat: 27.5, minLng: 117, maxLng: 125,   minMag: 5.0, start: '1923-01-01', minCount: 200 },
  newzealand: { minLat: -50,  maxLat: -32,  minLng: 160, maxLng: 180,   minMag: 5.0, start: '1923-01-01', minCount: 300 }
};

const REGION = (process.argv.find(a => a.startsWith('--region=')) || '').slice('--region='.length) || 'japan';
if (!REGION_QUERIES[REGION]) {
  console.error('unknown --region=' + REGION + ' (known: ' + Object.keys(REGION_QUERIES).join(', ') + ')');
  process.exit(1);
}
const RQ = REGION_QUERIES[REGION];
const IS_JAPAN = REGION === 'japan';

const OUT = path.join(ROOT, 'tools/data/psha/comcat-' + REGION + '.json');
const RAW = path.join(ROOT, '.cache/psha/comcat-' + REGION + '-raw.json');

const QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
  + '?format=geojson&eventtype=earthquake'
  + '&starttime=' + RQ.start
  + '&minlatitude=' + RQ.minLat + '&maxlatitude=' + RQ.maxLat
  + '&minlongitude=' + RQ.minLng + '&maxlongitude=' + RQ.maxLng
  + '&minmagnitude=' + RQ.minMag + '&orderby=time-asc&limit=20000';

function httpsGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithRetry(url, attempts) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try { return await httpsGetJson(url, 60000); }
    catch (err) { lastErr = err; console.error(`attempt ${i + 1}/${attempts} failed: ${err.message}`); }
    await new Promise(r => setTimeout(r, 3000 * (i + 1)));
  }
  throw lastErr;
}

function reduceEvents(doc) {
  const events = [];
  for (const f of doc.features || []) {
    const [lng, lat, depthKm] = f.geometry.coordinates;
    const p = f.properties || {};
    if (typeof p.mag !== 'number' || !isFinite(p.mag)) continue; // a few mag=null rows
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    events.push({
      id: f.id,
      time: new Date(p.time).toISOString(),
      tsMs: p.time,
      lat, lng,
      depthKm: isFinite(depthKm) ? depthKm : 10,
      mag: p.mag,
      magType: p.magType || null,
      place: p.place || null
    });
  }
  events.sort((a, b) => a.tsMs - b.tsMs);
  return events;
}

async function main() {
  console.log('fetching', QUERY);
  const doc = await fetchWithRetry(QUERY, 3);
  const events = reduceEvents(doc);
  if (events.length < RQ.minCount) throw new Error(`suspiciously small catalog (${events.length} events) — refusing to freeze`);
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.writeFileSync(RAW, JSON.stringify(doc));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const frozen = {
    schema: IS_JAPAN ? 'quake-sim-comcat-japan-v1' : 'quake-sim-comcat-region-v1',
    region: REGION,
    generatedAt: new Date().toISOString(),
    query: QUERY,
    count: events.length,
    bbox: { minLat: RQ.minLat, maxLat: RQ.maxLat, minLng: RQ.minLng, maxLng: RQ.maxLng, minMag: RQ.minMag, start: RQ.start },
    license: 'USGS public domain (ComCat); frozen verbatim-derived event list',
    events
  };
  fs.writeFileSync(OUT, JSON.stringify(frozen));
  const byDecade = {};
  for (const e of events) { const d = e.time.slice(0, 3) + '0s'; byDecade[d] = (byDecade[d] || 0) + 1; }
  console.log(`froze ${events.length} events to ${path.relative(ROOT, OUT)}`);
  console.log('per-decade counts:', JSON.stringify(byDecade));
}

if (require.main === module) {
  main().catch(err => { console.error(String(err && err.message || err)); process.exit(1); });
}
module.exports = { reduceEvents };
