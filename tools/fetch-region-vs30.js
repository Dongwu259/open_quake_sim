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
//   node tools/fetch-region-vs30.js --global   # fetch the assembled global
//     hybrid product (Heath et al. 2020) from apps.usgs.gov (plain HTTPS,
//     ~610 MB, no pinned-IP workaround needed) into .cache/global_vs30.grd
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'California_Vs30_7p5c.grd');
const BLOB_SHA = '6b695455736cb690b78fea7488cc1febbcf3bf72'; // California/California_Vs30_7p5c.grd @ HEAD 938bc5a
const EXPECTED_SIZE = 5962306;

const GLOBAL_CACHE = path.join(ROOT, '.cache', 'global_vs30.grd');
const GLOBAL_URL = 'https://apps.usgs.gov/shakemap_geodata/vs30/global_vs30.grd';
const GLOBAL_MIN_SIZE = 600000000; // observed 610189275 (2026-09-25); range-GET verified HDF5 magic

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

function fetchGlobal() {
  return new Promise((resolve, reject) => {
    const req = https.request(GLOBAL_URL, {
      method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 quake-sim-tooling' }, timeout: 600000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' from apps.usgs.gov')); }
      const out = fs.createWriteStream(GLOBAL_CACHE);
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.pipe(out);
      out.on('finish', () => resolve(n));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  if (process.argv.includes('--global')) {
    if (process.argv.includes('--check')) {
      const ok = fs.existsSync(GLOBAL_CACHE) && fs.statSync(GLOBAL_CACHE).size >= GLOBAL_MIN_SIZE;
      console.log(ok ? 'CACHE-OK ' + GLOBAL_CACHE : 'CACHE-MISS ' + GLOBAL_CACHE);
      process.exit(ok ? 0 : 1);
    }
    const n = await fetchGlobal();
    if (n < GLOBAL_MIN_SIZE) throw new Error('global grid too small: ' + n);
    const fd = fs.openSync(GLOBAL_CACHE, 'r');
    const magic = Buffer.alloc(8);
    fs.readSync(fd, magic, 0, 8, 0);
    fs.closeSync(fd);
    if (!magic.toString('latin1').startsWith('\u0089HDF')) throw new Error('not an HDF5 file');
    console.log('wrote %s (%d bytes)', GLOBAL_CACHE, n);
    return;
  }
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
