#!/usr/bin/env node
'use strict';
// tools/fetch-usgs-nshm.js — R8-2c: fetch official USGS NSHM 2023.R2 CONUS
// static hazard curves from the NSHM Hazard Tool web service for the
// preregistered California comparison (tools/scorecard-usgs-nshm.js).
//
// Data channel (2026-11-12): https://earthquake.usgs.gov/ws/nshmp/hazard/static
// (Angular toolbox at /nshmp/, service discovered via its /swagger). No API
// key required (public service). Param names per swagger: longitude, latitude,
// siteClass (NEHRP letter), imt (PGA|PGV|SA0P01..SA10P0). Model id from
// /ws/nshmp/hazard/static/nshms: STATIC_CONUS_2023_R2 -> /ws/nshmp/conus-2023.R2/static.
// siteClass BC = the NSHM reference rock boundary class (760 m/s); our side
// evaluates at vs30 760 for a like-for-like gate.
//
// Output: tools/data/usgsnshm/nshm-conus-2023r2-curves.json (raw + provenance).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'usgsnshm', 'nshm-conus-2023r2-curves.json');
const BASE = 'https://earthquake.usgs.gov/ws/nshmp/conus-2023.R2/static/hazard';

const SITES = [
  { code: 'LA', name: 'Los Angeles', lat: 34.05, lng: -118.24 },
  { code: 'SF', name: 'San Francisco', lat: 37.7749, lng: -122.4194 },
];
const IMTS = ['PGA', 'SA1P0'];
const SITE_CLASS = 'BC'; // 760 m/s boundary class — our side runs vs30 760

function fetchOnce(lat, lng, imt) {
  const url = BASE + '?longitude=' + lng + '&latitude=' + lat + '&siteClass=' + SITE_CLASS + '&imt=' + imt;
  return { url, body: execFileSync('curl', ['-s', '--max-time', '90', url], { encoding: 'utf8', timeout: 120000 }) };
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function main() {
  const curves = [];
  for (const s of SITES) {
    for (const imt of IMTS) {
      let doc = null, err = null;
      for (const attempt of [0, 5000, 20000]) {
        if (attempt) sleepSync(attempt);
        try {
          const { url, body } = fetchOnce(s.lat, s.lng, imt);
          const parsed = JSON.parse(body);
          if (parsed.status === 'success') { doc = parsed; doc.requestUrl = url; break; }
          err = parsed.response || 'status ' + parsed.status;
        } catch (e) { err = String(e).slice(0, 160); }
      }
      if (!doc) { console.error('FETCH FAILED', s.code, imt, err); process.exit(1); }
      curves.push({
        site: s.code, name: s.name, lat: s.lat, lng: s.lng, imt: imt, siteClass: SITE_CLASS,
        levelsG: doc.response.data.xs, rates: doc.response.data.ys,
      });
      sleepSync(1000);
    }
  }
  const out = {
    schema: 'quake-sim-usgs-nshm-curves-v1',
    fetchedAt: new Date().toISOString(),
    endpoint: BASE,
    edition: 'STATIC_CONUS_2023_R2 (2023.R2 Conterminous U.S. NSHM, static service)',
    siteClass: SITE_CLASS,
    siteClassNote: 'NEHRP BC boundary class = 760 m/s; our side evaluates the pack at vs30 760 for the same convention',
    sites: SITES,
    curves: curves,
    note: 'official mean (static = model-as-published) hazard curves; xs in g, ys annual exceedance rates; raw response fields verbatim',
  };
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote ' + OUT + ' sha256 ' + crypto.createHash('sha256').update(JSON.stringify(out, null, 1) + '\n').digest('hex').slice(0, 12));
  }
  console.log('curves:', curves.length, curves.map((c) => c.site + '/' + c.imt + ':' + c.levelsG.length).join(' '));
}

main();
