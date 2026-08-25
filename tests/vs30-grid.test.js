'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const Physics = require('../public/physics.js');

const G = JSON.parse(fs.readFileSync('public/geojson/vs30.json', 'utf8'));

test('vs30 research grid passes the shared raster schema and carries provenance', () => {
  const check = Physics.validateResearchGrid(G, 'vs30');
  assert.ok(check.valid, 'schema: ' + check.errors.join(','));
  assert.equal(G.meta.schema, 'quake-sim-vs30-grid-v1');
  assert.match(G.meta.source, /j-shis\.bosai\.go\.jp/);
  assert.ok(G.meta.license && G.meta.license.includes('J-SHIS'), 'license/attribution string present');
  assert.ok(G.meta.statistics.outputCellsWithData > 15000, 'national land coverage');
});

test('vs30 anchors: plains soft, mountains stiff, ocean transparent', () => {
  const v = (lat, lng) => Physics.lookupResearchGrid(G, lat, lng) || 0;
  assert.ok(v(35.68, 139.78) < 250, 'Tokyo lowland alluvium, got ' + v(35.68, 139.78));
  assert.ok(v(34.70, 135.50) < 250, 'Osaka plain, got ' + v(34.70, 135.50));
  assert.ok(v(36.65, 138.18) > 400, 'Nagano mountains, got ' + v(36.65, 138.18));
  assert.equal(v(30.0, 140.0), 0, 'open ocean must be a no-data (0) cell');
  // bilinear transparency: a 0 cell must not leak positive values far offshore
  assert.equal(v(28.0, 142.0), 0, 'Philippine Sea cell');
});

test('vs30 grid statistics are self-consistent', () => {
  const s = G.meta.statistics;
  assert.ok(s.meanVs30 > 350 && s.meanVs30 < 650, 'plausible national mean, got ' + s.meanVs30);
  assert.ok(s.minVs30 >= 100 && s.maxVs30 <= 900, 'plausible extremes ' + s.minVs30 + '..' + s.maxVs30);
  let cells = 0, sum = 0;
  for (const d of G.data) { if (d > 0) { cells++; sum += d; } }
  assert.equal(cells, s.outputCellsWithData, 'cell count matches statistics block');
  assert.ok(Math.abs(sum / cells - s.meanVs30) < 0.2, 'mean matches data');
});
