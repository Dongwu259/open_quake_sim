// v6.0 platform: experiment-manifest immutability gate.
// Every frozen experiment/report artifact carries a content-hash identity;
// if a report changes without re-freezing the manifest, this fails.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

test('experiment manifest is fresh (content-hash IDs match artifacts)', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'tools', 'build-experiment-manifest.js'), '--check'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /manifest fresh: \d+ entries/);
});

test('manifest covers the v6.0 dynamic-rupture experiment with a stable ID', () => {
  const manifest = require('../tools/data/experiment-manifest.json');
  assert.strictEqual(manifest.schema, 'quake-sim-experiment-manifest-v1');
  const dr = manifest.entries.find(e => e.name === 'dynamic-rupture-report.json');
  assert.ok(dr, 'dynamic-rupture-report listed');
  assert.match(dr.id, /^qsx1-[0-9a-f]{16}$/);
  assert.strictEqual(dr.track, 'R6');
  // provenance chain: the report must name the SCEC source it transcribed
  const report = require('../tools/data/dynamic-rupture-report.json');
  assert.match(report.provenance.tpv5, /TPV5_forwebsite\.pdf/);
  assert.match(report.provenance.tpv5, /strike\.scec\.org/);
});
