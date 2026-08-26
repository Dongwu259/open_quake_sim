#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.7 tail: ensemble Worker-hosting decision benchmark.
//  The v5.6 re-scope pre-registered: "migrate ensembleIntensityField to a
//  Worker only when >=200 members measurably jank the main thread". This
//  tool measures the deployed configurations (forecast refresh =
//  97 subdivision centroids; heavy research use = 200 stations) at 40 /
//  200 / 500 members and prints the decision inputs.
//
//  Usage: node tools/bench-ensemble.js
// ================================================================
const path = require('path');
const fs = require('fs');
const Physics = require(path.join(__dirname, '..', 'public', 'physics.js'));

function makeContext() {
  return {
    source: { lat: 35.7, lng: 140.3, mw: 7.4, depthKm: 30, strikeDeg: 195, dipDeg: 20, rakeDeg: 90, sourceType: 'interplate' },
    geometry: { lat: 35.7, lng: 140.3, L: 160, W: 80, depth: 30, strikeDeg: 195, dipDeg: 20, hypocenterFrac: 0.4 },
    gmpModel: 'logic-tree',
    options: { siteModel: 'vs30' }
  };
}

function makeStations(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ang = i * 2.399963; // golden-angle spread around the source
    const r = 12 + 220 * ((i * 0.61803398875) % 1);
    out.push({
      lat: 35.7 + r * Math.cos(ang) / 110.57,
      lng: 140.3 + r * Math.sin(ang) / (111.32 * Math.cos(35.7 * Math.PI / 180)),
      vs30: 200 + 600 * ((i * 0.7548776662) % 1)
    });
  }
  return out;
}

function bench(nStations, members, reps) {
  const ctx = makeContext();
  const stations = makeStations(nStations);
  // warm-up JIT with one small run
  Physics.ensembleIntensityField(ctx, stations.slice(0, 8), { members: 4, seed: 1 });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) Physics.ensembleIntensityField(ctx, stations, { members, seed: i + 1 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
  return ms;
}

console.log('config'.padEnd(30), 'ms/run (median of reps)');
for (const [ns, mem, reps] of [[97, 40, 3], [97, 200, 2], [200, 200, 2], [200, 500, 1], [1289, 200, 1]]) {
  const ms = bench(ns, mem, reps);
  console.log((ns + ' stations x ' + mem + ' members').padEnd(30), ms.toFixed(0) + ' ms');
}
console.log('\nDecision rule (pre-registered): migrate to a Worker only if the deployed');
console.log('config (97 centroids) exceeds ~150 ms at the research member count (200).');
console.log('Ensemble runs are one-shot per forecast refresh (param-keyed cache), never per frame.');
