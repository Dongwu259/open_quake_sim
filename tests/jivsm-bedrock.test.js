'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const Physics = require('../public/physics.js');

const G = JSON.parse(fs.readFileSync('public/geojson/jivsm-bedrock.json', 'utf8'));

function at(arr, lat, lng) {
  const x = Math.floor((lng - G.origin[0]) / G.res), y = Math.floor((lat - G.origin[1]) / G.res);
  return arr[y * G.nx + x] || 0;
}

test('jivsm bedrock grid passes the raster schema with J-SHIS provenance', () => {
  assert.ok(Physics.validateResearchGrid(G, 'vs30').valid, 'kind-agnostic raster schema');
  assert.equal(G.meta.schema, 'quake-sim-jivsm-bedrock-v1');
  assert.match(G.meta.source, /j-shis\.bosai\.go\.jp/);
  assert.ok(G.meta.license.includes('J-SHIS'), 'attribution line');
  assert.ok(Array.isArray(G.meta.extraSeismicBedrock.data) && G.meta.extraSeismicBedrock.data.length === G.nx * G.ny);
  const s = G.meta.statistics;
  assert.ok(s.sourceRows > 3e6, 'national 1km rows, got ' + s.sourceRows);
  assert.ok(s.outputCellsWithData > 1e5, 'coverage');
});

test('jivsm anchors: Kanto/Osaka basins deep, mountains near-outcrop', () => {
  const eng = (la, ln) => at(G.data, la, ln);
  const sei = (la, ln) => at(G.meta.extraSeismicBedrock.data, la, ln);
  // Kanto basin lowland: engineering bedrock hundreds of metres (0.05° cell
  // averages the deepest 2.4 km column with basin flanks)
  assert.ok(eng(35.67, 139.83) > 80, 'Koto eng depth ' + eng(35.67, 139.83));
  assert.ok(sei(35.67, 139.83) > eng(35.67, 139.83), 'seismic below engineering');
  assert.ok(eng(34.70, 135.50) > 150, 'Osaka plain ' + eng(34.70, 135.50));
  // mountains: basement essentially at the surface
  assert.ok(eng(36.65, 138.18) < 60, 'Nagano mountains ' + eng(36.65, 138.18));
  assert.ok(eng(36.21, 140.10) < 60, 'Mt Tsukuba ' + eng(36.21, 140.10));
  assert.ok(eng(35.47, 139.15) < 60, 'Tanzawa ' + eng(35.47, 139.15));
  // outside the national grid = no data (JIVSM covers ocean cells too, so
  // the transparent point must be off-coverage)
  assert.equal(eng(19.5, 140.0), 0);
});

test('jivsm layer semantics: PYS ladder and the saturation fallback are documented', () => {
  // The decode (standard 8-digit 1km mesh, D_i = bottom of PYS layer i+1,
  // equal columns = zero thickness, saturated tails = basement halfspace) was
  // verified value-for-value against the official dstrct V3.2 API for mesh
  // 53394606 (tn0..tn30 == D0..D30: 85.5/90.2/228.5/462.6/1276.1/2402.8).
  // This test pins the PYS Vs ladder so any drift of the embedded constants
  // is caught.
  const src = fs.readFileSync('tools/build-jivsm-grid.js', 'utf8');
  const m = src.match(/const PYS_VS = \[([\d,\s]+)\]/);
  assert.ok(m, 'PYS_VS embedded');
  const ladder = m[1].split(',').map(Number);
  assert.equal(ladder.length, 32);
  assert.equal(ladder[0], 350);
  assert.equal(ladder[6], 650);
  assert.equal(ladder[7], 700);   // engineering-bedrock threshold layer
  assert.equal(ladder[26], 2700); // seismic-bedrock threshold layer
  assert.equal(ladder[31], 3200);
});
