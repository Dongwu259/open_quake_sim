#!/usr/bin/env node
'use strict';
// tools/fetch-nz-nshm.js — fetch official NZ NSHM 2022 (model id NSHM_v1.0.4)
// mean hazard curves from the public Kororaa viewer GraphQL API for the
// preregistered comparison set (tools/scorecard-nz-nshm.js).
//
// Data channel (2026-11-10): https://nshm-api.gns.cri.nz/kororaa-app-api/graphql
// requires an X-API-KEY; the key below is the PUBLIC viewer key shipped inside
// the Kororaa SPA bundle (nshm.gns.cri.nz/assets/*.js, VITE_GRAPHQL_API_KEY) —
// it is what every site visitor's browser sends. Not a private credential.
// Read-only public data; courtesy 2 s spacing, single batched query.
//
// Output: tools/data/nshmnz/nshm-v104-curves.json (raw curves + provenance).
// Re-running overwrites the frozen file only via --write.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-curves.json');
const ENDPOINT = 'https://nshm-api.gns.cri.nz/kororaa-app-api/graphql';
// Public Kororaa viewer key (embedded in the public SPA bundle).
const VIEWER_KEY = 'YZtCPe39or4XpsH4RkQvi6NeHJPE2aesahnY1EUc';

// Preregistered site set (spans the model: megathrust+crown fault capital,
// background-dominated north, crustal south-island, Alpine-fault west,
// low-hazard south). Codes from the official Kororaa location table.
const SITES = [
  { code: 'WLG', name: 'Wellington' },
  { code: 'AKL', name: 'Auckland' },
  { code: 'CHC', name: 'Christchurch' },
  { code: 'NSN', name: 'Nelson' },
  { code: 'ZQN', name: 'Queenstown' },
  { code: 'IVC', name: 'Invercargill' },
];
const IMTS = ['PGA', 'SA(1.0)'];
const VS30 = 600;
const AGG = 'mean';
const MODEL = 'NSHM_v1.0.4';
const RESOLUTION = 0.1;

const QUERY = `query FetchNzNshm($hazard_model: String $vs30s: [Int] $imts: [String] $locs: [String] $aggs: [String] $resolution: Float) {
  hazard_curves: HAZARD_hazard_curves(hazard_model: $hazard_model, vs30s: $vs30s, imts: $imts, locs: $locs, aggs: $aggs, resolution: $resolution) {
    ok
    locations { lat lon resolution code name key }
    curves { hazard_model imt loc agg vs30 curve { levels values } }
  }
}`;

function fetchOnce() {
  const body = JSON.stringify({ query: QUERY, variables: {
    hazard_model: MODEL, vs30s: [VS30], imts: IMTS, locs: SITES.map((s) => s.code),
    aggs: [AGG], resolution: RESOLUTION,
  } });
  // curl subprocess (fetch-jshis-comparison.js convention): keeps TLS in curl,
  // avoids node:https quirks; body via stdin file to survive quoting.
  const tmp = path.join(ROOT, '.cache', 'nshmnz-query.json');
  fs.writeFileSync(tmp, body);
  return execFileSync('curl', ['-s', '--max-time', '90', '-X', 'POST', ENDPOINT,
    '-H', 'Content-Type: application/json',
    '-H', 'X-API-KEY: ' + VIEWER_KEY,
    '--data', '@' + tmp], { encoding: 'utf8', timeout: 120000 });
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function main() {
  const retries = [0, 5000, 20000];
  let raw = null, err = null;
  for (const wait of retries) {
    if (wait) sleepSync(wait);
    try { raw = fetchOnce(); if (raw.includes('"ok":true')) { err = null; break; } err = raw.slice(0, 200); }
    catch (e) { err = String(e).slice(0, 200); }
  }
  if (err && (!raw || !raw.includes('"ok":true'))) {
    console.error('FETCH FAILED:', err);
    process.exit(1);
  }
  const doc = JSON.parse(raw);
  const res = doc.data.hazard_curves;
  if (!res.ok || res.curves.length !== SITES.length * IMTS.length) {
    console.error('UNEXPECTED CURVE COUNT:', res.curves.length, 'want', SITES.length * IMTS.length);
    process.exit(1);
  }
  const locByKey = {};
  for (const l of res.locations) locByKey[l.code] = l;
  const out = {
    schema: 'quake-sim-nz-nshm-curves-v1',
    fetchedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    viewerKeySha256_12: crypto.createHash('sha256').update(VIEWER_KEY).digest('hex').slice(0, 12),
    hazardModel: MODEL,
    aggregate: AGG,
    vs30: VS30,
    resolution: RESOLUTION,
    requestedSites: SITES,
    locations: res.locations,
    curves: res.curves,
    note: 'official mean hazard curves, Kororaa public viewer API; raw response curves verbatim',
  };
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote', OUT, 'sha256', crypto.createHash('sha256').update(JSON.stringify(out, null, 1) + '\n').digest('hex').slice(0, 12));
  }
  console.log('curves:', res.curves.length, 'locations:', res.locations.map((l) => l.code).join(' '));
}

main();
