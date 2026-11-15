#!/usr/bin/env node
'use strict';
// tools/fetch-nz-nshm-quantiles.js — R8-2e (epistemic-width validation):
// fetch the official NZ NSHM v1.0.4 EPISTEMIC FRACTILE curves (aggs
// [mean, 0.1, 0.9]) for the same six preregistered sites as the R8-2b gate.
// Same channel/key/conventions as tools/fetch-nz-nshm.js (public viewer key).
//
// Output: tools/data/nshmnz/nshm-v104-quantiles.json (18 curves + provenance).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-quantiles.json');
const ENDPOINT = 'https://nshm-api.gns.cri.nz/kororaa-app-api/graphql';
const VIEWER_KEY = 'YZtCPe39or4XpsH4RkQvi6NeHJPE2aesahnY1EUc'; // public Kororaa viewer key (SPA bundle)

const SITES = [
  { code: 'WLG', name: 'Wellington' },
  { code: 'AKL', name: 'Auckland' },
  { code: 'CHC', name: 'Christchurch' },
  { code: 'NSN', name: 'Nelson' },
  { code: 'ZQN', name: 'Queenstown' },
  { code: 'IVC', name: 'Invercargill' },
];
const IMTS = ['PGA', 'SA(1.0)'];
const AGGS = ['mean', '0.1', '0.9'];
const VS30 = 600;
const MODEL = 'NSHM_v1.0.4';
const RESOLUTION = 0.1;

const QUERY = `query FetchNzQuantiles($hazard_model: String $vs30s: [Int] $imts: [String] $locs: [String] $aggs: [String] $resolution: Float) {
  hazard_curves: HAZARD_hazard_curves(hazard_model: $hazard_model, vs30s: $vs30s, imts: $imts, locs: $locs, aggs: $aggs, resolution: $resolution) {
    ok
    locations { lat lon resolution code name key }
    curves { hazard_model imt loc agg vs30 curve { levels values } }
  }
}`;

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function main() {
  const body = JSON.stringify({ query: QUERY, variables: {
    hazard_model: MODEL, vs30s: [VS30], imts: IMTS, locs: SITES.map((s) => s.code),
    aggs: AGGS, resolution: RESOLUTION,
  } });
  const tmp = path.join(ROOT, '.cache', 'nshmnz-quantiles-query.json');
  fs.writeFileSync(tmp, body);
  let raw = null, err = null;
  for (const wait of [0, 5000, 20000]) {
    if (wait) sleepSync(wait);
    try {
      raw = execFileSync('curl', ['-s', '--max-time', '90', '-X', 'POST', ENDPOINT,
        '-H', 'Content-Type: application/json',
        '-H', 'X-API-KEY: ' + VIEWER_KEY,
        '--data', '@' + tmp], { encoding: 'utf8', timeout: 120000 });
      if (raw.includes('"ok":true')) { err = null; break; }
      err = raw.slice(0, 200);
    } catch (e) { err = String(e).slice(0, 200); }
  }
  if (err && (!raw || !raw.includes('"ok":true'))) { console.error('FETCH FAILED:', err); process.exit(1); }
  const doc = JSON.parse(raw);
  const res = doc.data.hazard_curves;
  const want = SITES.length * IMTS.length * AGGS.length;
  if (res.curves.length !== want) { console.error('UNEXPECTED CURVE COUNT:', res.curves.length, 'want', want); process.exit(1); }
  const out = {
    schema: 'quake-sim-nz-nshm-quantiles-v1',
    fetchedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    viewerKeySha256_12: crypto.createHash('sha256').update(VIEWER_KEY).digest('hex').slice(0, 12),
    hazardModel: MODEL,
    aggregates: AGGS,
    vs30: VS30,
    resolution: RESOLUTION,
    requestedSites: SITES,
    locations: res.locations,
    curves: res.curves,
    note: 'official mean + 0.1/0.9 epistemic fractile curves; raw response curves verbatim',
  };
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote ' + OUT + ' sha256 ' + crypto.createHash('sha256').update(JSON.stringify(out, null, 1) + '\n').digest('hex').slice(0, 12));
  }
  console.log('curves:', res.curves.length, 'locations:', res.locations.map((l) => l.code).join(' '));
}

main();
