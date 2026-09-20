// Fetch operational FDSN station metadata for a region bounding box and freeze
// a quake-sim-region-stations-v1 package (display-only "real stations" layer).
//
// Rationale (honesty): station coordinates/names come verbatim from the data
// centers' own FDSN station-text output; nothing is hand-invented. Each source
// records returned/operational/kept counts in provenance. Re-run to refresh.
//
// Sources for the California pilot:
//   - SCEDC       service.scedc.caltech.edu  (Caltech/USGS SCSN + CSMIP mirrors)
//   - NCEDC       service.ncedc.org          (USGS NCSN + BSL mirrors)
//   - EarthScope  service.earthscope.org     (global backbone IU/II/IC/US/IW)
//
// Operational filter per source (FDSN text format col 8 = EndTime):
//   blank end  = open epoch (SCEDC returns the current epoch set this way)
//   end >= '2500' = NCEDC encodes open epochs as 3000-01-01
// Dedupe key = network|station (priority: SCEDC > NCEDC > EarthScope).
//
// Usage: node tools/fetch-region-stations.js [--region california|italy|chile]
//   (writes public/geojson/region-stations-<region>.json)
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

// Per-region source sets. bbox = the region pack bounds; sources are tried in
// order and deduped by network|station (earlier source wins).
const esNets = 'IU,II,IC,US,IW';
const REGION_DEFS = {
  california: {
    bbox: { minlat: 32.3, maxlat: 42.2, minlon: -124.6, maxlon: -114.1 },
    sources: [
      { name: 'SCEDC (Caltech/USGS Southern California Seismic Network)', priority: 1, url: (b) => `https://service.scedc.caltech.edu/fdsnws/station/1/query?minlat=${b.minlat}&maxlat=${b.maxlat}&minlon=${b.minlon}&maxlon=${b.maxlon}&level=station&format=text` },
      { name: 'NCEDC (USGS Northern California Seismic System + UC Berkeley)', priority: 2, url: (b) => `https://service.ncedc.org/fdsnws/station/1/query?minlat=${b.minlat}&maxlat=${b.maxlat}&minlon=${b.minlon}&maxlon=${b.maxlon}&level=station&format=text` },
      { name: `EarthScope (global permanent backbone ${esNets})`, priority: 3, url: (b) => `https://service.earthscope.org/fdsnws/station/1/query?minlat=${b.minlat}&maxlat=${b.maxlat}&minlon=${b.minlon}&maxlon=${b.maxlon}&net=${esNets}&level=station&format=text` },
    ],
  },
  italy: {
    bbox: { minlat: 36.5, maxlat: 47.2, minlon: 6.5, maxlon: 18.6 },
    sources: [
      { name: 'INGV (Istituto Nazionale di Geofisica e Vulcanologia, Roma)', priority: 1, url: (b) => `https://webservices.ingv.it/fdsnws/station/1/query?minlat=${b.minlat}&maxlat=${b.maxlat}&minlon=${b.minlon}&maxlon=${b.maxlon}&level=station&format=text` },
      { name: `EarthScope (global permanent backbone ${esNets})`, priority: 2, url: (b) => `https://service.earthscope.org/fdsnws/station/1/query?minlat=${b.minlat}&maxlat=${b.maxlat}&minlon=${b.minlon}&maxlon=${b.maxlon}&net=${esNets}&level=station&format=text` },
    ],
  },
  chile: {
    bbox: { minlat: -56.0, maxlat: -17.0, minlon: -76.0, maxlon: -66.0 },
    sources: [
      { name: 'EarthScope (CSN national network C1 + backbone IU/II/IW)', priority: 1, url: (b) => `https://service.earthscope.org/fdsnws/station/1/query?minlat=${b.minlat}&maxlat=${b.maxlat}&minlon=${b.minlon}&maxlon=${b.maxlon}&net=C1,${esNets}&level=station&format=text` },
    ],
  },
};

const REGION = (process.argv[process.argv.indexOf('--region') + 1] || 'california');
const DEF = REGION_DEFS[REGION];
if (!DEF) { console.error('unknown region: ' + REGION + ' (known: ' + Object.keys(REGION_DEFS).join(', ') + ')'); process.exit(1); }
const BBOX = DEF.bbox;
const OUT = path.join(__dirname, '..', 'public', 'geojson', 'region-stations-' + REGION + '.json');
const SOURCES = DEF.sources.map((s) => ({ name: s.name, priority: s.priority, url: s.url(BBOX) }));

function get(url, redirects) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'quake-sim-region-stations/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), (redirects || 0) + 1));
      }
      if (res.statusCode === 204) { res.resume(); return resolve(''); } // FDSN no-data for this source
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> HTTP ' + res.statusCode)); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseStationText(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t || t.startsWith('#')) continue;
    const c = t.split('|');
    if (c.length < 8) continue;
    const end = (c[7] || '').trim();
    // operational only: open epoch (blank) or far-future sentinel (NCEDC 3000-01-01)
    if (end !== '' && end < '2500') continue;
    const lat = parseFloat(c[2]), lng = parseFloat(c[3]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    if (lat < BBOX.minlat || lat > BBOX.maxlat || lng < BBOX.minlon || lng > BBOX.maxlon) continue;
    rows.push({
      net: c[0].trim(), code: c[1].trim(),
      lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4,
      elev: Math.round(parseFloat(c[4]) || 0),
      site: (c[5] || '').trim() || (c[1].trim() + ' station')
    });
  }
  return rows;
}

(async () => {
  const byKey = new Map();
  const provenance = [];
  for (const src of SOURCES) {
    process.stdout.write('fetching ' + src.name + ' … ');
    const text = await get(src.url);
    const rows = parseStationText(text);
    let kept = 0;
    for (const r of rows) {
      const key = r.net + '|' + r.code;
      if (!byKey.has(key)) { byKey.set(key, r); kept++; }
    }
    provenance.push({ name: src.name, url: src.url, returned: text.split('\n').filter(l => l && !l.startsWith('#')).length, operational: rows.length, dedupedKept: kept });
    console.log(rows.length + ' operational, ' + kept + ' new');
  }
  const stations = [...byKey.values()].sort((a, b) => a.net.localeCompare(b.net) || a.code.localeCompare(b.code));
  const out = {
    schema: 'quake-sim-region-stations-v1',
    region: REGION,
    generated: new Date().toISOString().slice(0, 10),
    bbox: [BBOX.minlat, BBOX.minlon, BBOX.maxlat, BBOX.maxlon],
    note: 'Display-only real seismic station metadata (FDSN station service, operational epochs). Stations are NOT simulation receivers and carry no instrument response here.',
    sources: provenance,
    count: stations.length,
    stations
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('wrote ' + OUT + ' (' + stations.length + ' stations, ' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB)');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
