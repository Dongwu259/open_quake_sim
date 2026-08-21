'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('StationXML-derived catalog validator accepts cited metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quake-station-'));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify({
    _schema: 'quake-sim-station-catalog-v1',
    _source: 'inventory.xml',
    _sourceUrl: 'https://example.org/inventory.xml',
    _sourceSha256: 'a'.repeat(64),
    stations: [{
      id: 'IU.MAJO', network: 'IU', station: 'MAJO', lat: 35.6764, lng: 139.744,
      channels: [{code: 'BHZ', sampleRateHz: 40, hasResponse: true}],
    }],
  }));
  const output = execFileSync(process.execPath, ['tools/validate-station-catalog.js', file], { encoding: 'utf8' });
  assert.match(output, /1 stations, 1 channels, 1 with response metadata/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('station validator accepts the deployed flat simulator catalog by default', () => {
  const output = execFileSync(process.execPath, ['tools/validate-station-catalog.js'], { encoding: 'utf8' });
  assert.match(output, /1289 stations \(flat simulator catalog\)/);
});
