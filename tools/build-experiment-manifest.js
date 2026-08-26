#!/usr/bin/env node
// v6.0 platform: machine-readable experiment manifest with immutable IDs.
// Every frozen report/experiment artifact under tools/data/ (and the
// benchmark inputs it depends on) gets a content-hash identity
// (sha256[:16] of the file bytes). Re-running with --write is idempotent
// while the artifacts are unchanged; tests/experiment-manifest.test.js
// gates freshness, so ANY experiment result change must re-freeze the
// manifest consciously.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tools/data');

// Human-facing classification of each frozen artifact (role in the
// verification architecture; the manifest itself stays mechanical).
const ROLES = {
  'dynamic-rupture-report.json': { kind: 'experiment', track: 'R6', gate: 'tests/dynamic-rupture-report.test.js A10' },
  'strong-motion-report.json': { kind: 'scorecard', track: 'GMPE', gate: 'tests/scientific-tripwires.test.js' },
  'gmpe-fixtures-zhao2006.json': { kind: 'fixture', track: 'R0-3', gate: 'tests/gmpe-benchmarks.test.js' },
  'shake91-benchmark-case.json': { kind: 'fixture', track: 'v5.7 tail', gate: 'tests/shake91-benchmark.test.js' },
  'travel-time-picks.json': { kind: 'observed-picks', track: 'R3-2', gate: 'tests/jivsm-columns.test.js' },
  'f0-jivsm-reeval.json': { kind: 'experiment', track: 'v5.7 tail', gate: null },
  'version-report.json': { kind: 'envelope', track: 'R7-5', gate: 'tuning-read audit' },
  'experiment-manifest.json': { kind: 'manifest', track: 'v6.0', gate: 'self' }
};

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

function build() {
  const entries = [];
  for (const name of fs.readdirSync(DATA).sort()) {
    if (!name.endsWith('.json') || name === 'experiment-manifest.json') continue;
    const file = path.join(DATA, name);
    const stat = fs.statSync(file);
    if (stat.size > 12e6) continue;              // huge prediction dumps stay unlisted
    const role = ROLES[name] || { kind: 'report', track: null, gate: null };
    entries.push({
      id: 'qsx1-' + sha(file),                   // immutable content identity
      name, bytes: stat.size,
      kind: role.kind, track: role.track, gate: role.gate,
      mtime: stat.mtime.toISOString()
    });
  }
  return {
    schema: 'quake-sim-experiment-manifest-v1',
    generated: new Date().toISOString(),
    identityRule: 'qsx1-<sha256[:16] of file bytes>; manifest excluded from its own listing',
    entries
  };
}

function main() {
  const args = process.argv.slice(2);
  const out = path.join(DATA, 'experiment-manifest.json');
  const manifest = build();
  if (args.includes('--write')) {
    fs.writeFileSync(out, JSON.stringify(manifest, null, 1) + '\n');
    console.log('experiment-manifest.json written:', manifest.entries.length, 'entries');
  } else if (args.includes('--check')) {
    const stored = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    if (!stored) { console.error('no manifest — run --write'); process.exit(1); }
    const key = e => e.name + ':' + e.id;
    const a = new Set(stored.entries.map(key));
    const b = new Set(manifest.entries.map(key));
    const stale = [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
    if (stale.length) {
      console.error('STALE manifest (changed/new/removed artifacts):');
      for (const s of stale) console.error('  ' + s);
      process.exit(1);
    }
    console.log('manifest fresh:', manifest.entries.length, 'entries');
  } else {
    console.log(JSON.stringify(manifest, null, 1));
  }
}

if (require.main === module) main();
module.exports = { build };
