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
// Usage: node tools/fetch-comcat-japan.js
// Exit codes: 0 ok, 1 network/validation failure (no partial write).
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools/data/psha/comcat-japan.json');
const RAW = path.join(ROOT, '.cache/psha/comcat-japan-raw.json');

const QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
  + '?format=geojson&eventtype=earthquake'
  + '&starttime=1923-01-01'
  + '&minlatitude=24&maxlatitude=46'
  + '&minlongitude=125&maxlongitude=150'
  + '&minmagnitude=5.0&orderby=time-asc&limit=20000';

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
  if (events.length < 1000) throw new Error(`suspiciously small catalog (${events.length} events) — refusing to freeze`);
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.writeFileSync(RAW, JSON.stringify(doc));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const frozen = {
    schema: 'quake-sim-comcat-japan-v1',
    generatedAt: new Date().toISOString(),
    query: QUERY,
    count: events.length,
    bbox: { minLat: 24, maxLat: 46, minLng: 125, maxLng: 150, minMag: 5.0, start: '1923-01-01' },
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
