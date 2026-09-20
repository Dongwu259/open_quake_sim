#!/usr/bin/env node
// v6.4 region areas: California county boundaries for the live shindo
// coloring layer + area forecast table (the JMA prefecture/subdivision
// equivalents for region mode).
//
// Source: US Census Bureau cartographic county boundaries (cb_2018, 1:20m,
// public domain), consumed via the plotly/datasets mirror GeoJSON
// (geojson-counties-fips.json). raw.githubusercontent is unreachable from
// this network — download goes through the api.github.com blob API with the
// pinned-IP + explicit-Host workaround (same recipe as fetch-region-vs30.js).
//
// Output: public/geojson/region-counties-california.json
//   schema quake-sim-region-areas-v1 — FeatureCollection of the 58 CA counties,
//   properties {name, fips}; loaded by regionActivate and used as the third
//   (region-priority) source of the live area coloring layer.
//
// Usage:
//   node tools/fetch-region-counties.js            # download + write the pack (region-areas-california.json)
//   node tools/fetch-region-counties.js --check    # exit 0 if the pack exists
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'geojson', 'region-areas-california.json');
const BLOB_SHA = 'c8dbfc0dc4920aae2c3ba1dae290ab986a6b44fd';
const EXPECTED_BLOB_SIZE = 3216816;
const CA_STATE_FIPS = '06';

const IP = '140.82.112.5';
const HOST = 'api.github.com';

function get(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: IP, port: 443, path: apiPath, method: 'GET',
      servername: HOST,
      headers: { 'Host': HOST, 'User-Agent': 'quake-sim-tooling', 'Accept': 'application/vnd.github+json' },
      timeout: 180000,
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
  if (process.argv.includes('--check')) {
    const ok = fs.existsSync(OUT);
    console.log(ok ? 'PACK-OK ' + OUT : 'PACK-MISS ' + OUT);
    process.exit(ok ? 0 : 1);
  }
  const res = await get('/repos/plotly/datasets/git/blobs/' + BLOB_SHA);
  if (res.status !== 200) throw new Error('HTTP ' + res.status + ' from blob API');
  const meta = JSON.parse(res.body.toString('utf8'));
  const buf = Buffer.from(meta.content, 'base64');
  if (buf.length !== EXPECTED_BLOB_SIZE) throw new Error('size mismatch: got ' + buf.length + ', expected ' + EXPECTED_BLOB_SIZE);
  const national = JSON.parse(buf.toString('utf8'));
  if (!national.features || !national.features.length) throw new Error('no features in source');

  const features = national.features
    .filter((f) => {
      const st = (f.properties && f.properties.STATE) || String(f.id || '').slice(0, 2);
      return st === CA_STATE_FIPS;
    })
    .map((f) => ({
      type: 'Feature',
      properties: {
        name: String(f.properties.NAME || f.properties.NAMELSAD || f.id),
        fips: String(f.id || (CA_STATE_FIPS + f.properties.COUNTY)),
      },
      geometry: f.geometry,
    }))
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  if (features.length !== 58) throw new Error('expected 58 California counties, got ' + features.length);

  const pack = {
    _schema: 'quake-sim-region-areas-v1',
    region: 'california',
    unit: 'county',
    areas: { type: 'FeatureCollection', features },
    provenance: {
      label: 'US Census CA counties (cb_2018 20m)',
      source: 'U.S. Census Bureau cartographic county boundaries (cb_2018, 1:20m)',
      license: 'public domain (US Census)',
      url: 'https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html',
      via: 'plotly/datasets geojson-counties-fips.json @ ' + BLOB_SHA.slice(0, 7),
      builder: 'tools/fetch-region-counties.js',
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(pack));
  console.log('wrote %s (%d counties, %.1f KB)', OUT, features.length, fs.statSync(OUT).size / 1024);
}

main().catch((e) => { console.error('fetch failed:', e.message); process.exit(1); });
