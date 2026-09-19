#!/usr/bin/env node
// v6.4 region Vs30: fetch the Yong et al. (2014) California Vs30 grid from the
// USGS global-vs30 assembly repo. The file is a GMT netCDF-4 (HDF5) raster —
// decoded by tools/build-region-vs30.py (h5py), this tool only downloads it.
//
// GitHub API access from this network needs the pinned-IP + explicit-Host
// workaround (api.github.com resolves elsewhere / node sets Host to the IP —
// the same recipe as .cache/open-push-master-v2.js). The blob API returns the
// file base64-in-JSON (~8 MB for the 5.96 MB grid).
//
// Usage:
//   node tools/fetch-region-vs30.js            # download to .cache/
//   node tools/fetch-region-vs30.js --check    # exit 0 if the cache is present
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'California_Vs30_7p5c.grd');
const BLOB_SHA = '6b695455736cb690b78fea7488cc1febbcf3bf72'; // California/California_Vs30_7p5c.grd @ HEAD 938bc5a
const EXPECTED_SIZE = 5962306;

const IP = '140.82.112.5';
const HOST = 'api.github.com';

function get(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: IP, port: 443, path: apiPath, method: 'GET',
      servername: HOST,
      headers: { 'Host': HOST, 'User-Agent': 'quake-sim-tooling', 'Accept': 'application/vnd.github+json' },
      timeout: 120000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return reject(new Error('unexpected redirect ' + res.statusCode + ' — blob SHA stale?'));
      }
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
    const ok = fs.existsSync(CACHE) && fs.statSync(CACHE).size === EXPECTED_SIZE;
    console.log(ok ? 'CACHE-OK ' + CACHE : 'CACHE-MISS ' + CACHE);
    process.exit(ok ? 0 : 1);
  }
  const res = await get('/repos/usgs/earthquake-global_vs30/git/blobs/' + BLOB_SHA);
  if (res.status !== 200) throw new Error('HTTP ' + res.status + ' from blob API');
  const meta = JSON.parse(res.body.toString('utf8'));
  const buf = Buffer.from(meta.content, 'base64');
  if (buf.length !== EXPECTED_SIZE) throw new Error('size mismatch: got ' + buf.length + ', expected ' + EXPECTED_SIZE);
  if (!buf.slice(0, 8).toString('latin1').startsWith('\u0089HDF')) throw new Error('not an HDF5 file (magic ' + buf.slice(0, 4).toString('hex') + ')');
  fs.writeFileSync(CACHE, buf);
  console.log('wrote %s (%d bytes)', CACHE, buf.length);
}

main().catch((e) => { console.error('fetch failed:', e.message); process.exit(1); });
