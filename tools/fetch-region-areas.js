#!/usr/bin/env node
// v6.4 region areas: per-region administrative boundaries for the live shindo
// coloring layer + area forecast table (region mode's prefecture/county
// equivalent). Same quake-sim-region-areas-v1 package as California.
//
//   italy  — ISTAT provinces (107) via the openpolis/geojson-italy mirror
//            (CC-BY 4.0, ISTAT-derived). raw.githubusercontent unreachable
//            from this network: download via api.github.com blob API with the
//            pinned-IP + explicit-Host workaround.
//   chile  — Natural Earth 10m admin-1 regions filtered to Chile (public
//            domain, nvkelso/natural-earth-vector), bbox-clipped to the
//            region pack bounds.
//
// Usage: node tools/fetch-region-areas.js [--region italy|chile]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const IP = '140.82.112.5';
const HOST = 'api.github.com';

// pack bounds (lat/lon), mirrors region-<id>.json
const REGIONS = {
  italy: {
    unit: 'province',
    bbox: { minlat: 36.5, maxlat: 47.2, minlon: 6.5, maxlon: 18.6 },
    blob: { sha: '28cabb082a8e927767c551bca2a33563e899cbf6', size: 5420163, repoApi: '/repositories/199606334', repo: 'openpolis/geojson-italy (ISTAT provinces, CC-BY 4.0)' },
    nameOf: (p) => p.prov_name || p.name,
    extraProps: (p) => ({ region: p.reg_name || '' }),
    provenance: {
      label: 'ISTAT provinces via openpolis/geojson-italy',
      source: 'ISTAT administrative boundaries (provinces), processed by openpolis/geojson-italy',
      license: 'CC-BY 4.0 (openpolis / ISTAT)',
      url: 'https://github.com/openpolis/geojson-italy',
      builder: 'tools/fetch-region-areas.js',
    },
  },
  chile: {
    unit: 'region',
    bbox: { minlat: -56.0, maxlat: -17.0, minlon: -76.0, maxlon: -66.0 },
    blob: { sha: '4a8438f98ac7dfec7dc1739b1eaf91398ad33f22', size: 40726851, repoApi: '/repos/nvkelso/natural-earth-vector', repo: 'nvkelso/natural-earth-vector (NE 10m admin-1, public domain)' },
    nameOf: (p) => p.name,
    extraProps: (p) => ({ iso: p.iso_3166_2 || '' }),
    provenance: {
      label: 'Natural Earth 10m admin-1 (Chile regions)',
      source: 'Natural Earth 10m admin-1 states/provinces, admin = Chile',
      license: 'public domain (Natural Earth)',
      url: 'https://github.com/nvkelso/natural-earth-vector',
      builder: 'tools/fetch-region-areas.js',
    },
  },
};

function get(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: IP, port: 443, path: apiPath, method: 'GET',
      servername: HOST,
      headers: { 'Host': HOST, 'User-Agent': 'quake-sim-tooling', 'Accept': 'application/vnd.github+json' },
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  const REGION = (process.argv[process.argv.indexOf('--region') + 1] || '');
  const DEF = REGIONS[REGION];
  if (!DEF) { console.error('usage: node tools/fetch-region-areas.js --region italy|chile'); process.exit(1); }
  const OUT = path.join(ROOT, 'public', 'geojson', 'region-areas-' + REGION + '.json');

  process.stdout.write('downloading ' + DEF.blob.repo + ' … ');
  const res = await get(DEF.blob.repoApi + '/git/blobs/' + DEF.blob.sha);
  if (res.status !== 200) throw new Error('HTTP ' + res.status + ' from blob API');
  const meta = JSON.parse(res.body.toString('utf8'));
  const buf = Buffer.from(meta.content, 'base64');
  if (buf.length !== DEF.blob.size) throw new Error('size mismatch: ' + buf.length + ' vs ' + DEF.blob.size);
  console.log(buf.length + ' bytes');

  const national = JSON.parse(buf.toString('utf8'));
  let features = national.features.map((f) => ({
    type: 'Feature',
    _admin: String((f.properties || {}).admin || ''),
    properties: Object.assign(
      { name: String(DEF.nameOf(f.properties || {}) || ''), },
      DEF.extraProps(f.properties || {})
    ),
    geometry: f.geometry,
  })).filter((f) => f.properties.name);

  if (REGION === 'chile') {
    // country filter + bbox clip: NE admin-1 is a worldwide layer, and Chile's
    // Magallanes region carries far-south claimed territory
    features = features.filter((f) => f.properties.name && f._admin === 'Chile').map((f) => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }));
    features = features.filter((f) => {
      let y0 = 90, y1 = -90;
      const walk = (c) => {
        if (typeof c[0] === 'number') { if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
        else c.forEach(walk);
      };
      walk(f.geometry.coordinates);
      return y1 >= DEF.bbox.minlat - 0.5 && y0 <= DEF.bbox.maxlat + 0.5;
    });
  }

  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  if (!features.length) throw new Error('no features for ' + REGION);

  const pack = {
    _schema: 'quake-sim-region-areas-v1',
    region: REGION,
    unit: DEF.unit,
    areas: { type: 'FeatureCollection', features },
    provenance: DEF.provenance,
  };
  fs.writeFileSync(OUT, JSON.stringify(pack));
  console.log('wrote %s (%d %ss, %.1f KB)', OUT, features.length, DEF.unit, fs.statSync(OUT).size / 1024);
}

main().catch((e) => { console.error('fetch failed:', e.message); process.exit(1); });
