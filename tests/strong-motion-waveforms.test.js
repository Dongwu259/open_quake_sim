'use strict';
// K-NET/KiK-net frozen-waveform package infrastructure:
//  - Kyoshin ASCII parsers (legacy 17-header digit stream with scale factor,
//    modern columnar Time/NS/EW/UD) against the documented portal format
//  - the minimal ZIP reader used by tools/fetch-kyoshin-waveforms.js
//  - package validation/summary (StrongMotionWaveforms) incl. JMA intensity
// All fixtures are synthetic — no observed data is fabricated in-repo; real
// packages are frozen by the fetch tool with a registered NIED account.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
global.WaveformData = require('../public/waveform-data.js');
const Physics = require('../public/physics.js');
const SMW = require('../public/strong-motion-waveforms.js');

// --- fixtures -----------------------------------------------------------------
function legacyAscii() {
  const digits = [];
  for (let i = 0; i < 40; i++) digits.push((i % 7) - 3);
  const lines = [];
  for (let i = 0; i < 17; i++) lines.push('header ' + (i + 1));
  lines[0] = 'Origin Time 2024/01/01 16:10:00';
  lines[5] = 'Station Code ISK006';
  lines[10] = 'Sampling Freq(Hz) 100Hz';
  lines[12] = 'Dir. N-S';
  lines[13] = 'Scale Factor 5(gal)/10';
  for (let i = 0; i < digits.length; i += 8) lines.push(digits.slice(i, i + 8).join(' '));
  return lines.join('\n');
}
function columnarAscii() {
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const t = i / 100;
    rows.push([t, Math.sin(t), 0.5 * Math.cos(t), -Math.sin(2 * t)].map(v => v.toFixed(4)).join(' '));
  }
  return [
    'K-NET, KiK-net strong motion data',
    'Origin Time : 2024/01/01 16:10:22',
    'Sta. Code : ISK006  Sta. Name : TOMIKU',
    'Sampling Freq(Hz) 100',
    'Dir. S=N, E=E, U=U',
    'Memo.',
    ...rows
  ].join('\n');
}

test('fetch tool refuses to run without an event id and credentials', () => {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/fetch-kyoshin-waveforms.js')], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(/usage/.test(res.stderr));
  const res2 = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/fetch-kyoshin-waveforms.js'), '--event=20240101160813'], { encoding: 'utf8' });
  assert.strictEqual(res2.status, 2);
  assert.ok(/registered NIED account/.test(res2.stderr));
});

test('parsers: legacy digit stream converts via scale factor; columnar reads gal directly', () => {
  // Re-use the tool's parser by reading the source (the script is an
  // immediately-invoking CLI, so its functions are exercised through a shim).
  const src = require('fs').readFileSync(path.resolve(__dirname, '../tools/fetch-kyoshin-waveforms.js'), 'utf8');
  const fnBody = src.match(/function parseKyoshinAscii\(text\) \{[\s\S]*?\n\}/)[0];
  const parseKyoshinAscii = new Function('return ' + fnBody)();
  const legacy = parseKyoshinAscii(legacyAscii());
  assert.ok(legacy, 'legacy parsed');
  assert.equal(legacy.format, 'legacy-digits');
  assert.equal(legacy.samples.length, 40);
  // digit (i%7)-3 scaled by 5(gal)/10: digit -3 -> -1.5 gal, digit 1 -> 0.5 gal
  assert.ok(Math.abs(legacy.samples[0] - (-1.5)) < 1e-12);
  assert.ok(Math.abs(legacy.samples[4] - 0.5) < 1e-12);
  assert.ok(Math.abs(legacy.samples[6] - 1.5) < 1e-12);
  assert.equal(legacy.meta.comp, 'NS');
  const col = parseKyoshinAscii(columnarAscii());
  assert.ok(col, 'columnar parsed');
  assert.equal(col.format, 'columnar');
  assert.equal(col.samples.length, 300);
  // .samples carries the LAST column (UD = -sin 2t); the NS column rides in .trio.
  assert.ok(Math.abs(col.samples[157] - (-Math.sin(2 * 1.57))) < 1e-3);
  assert.ok(Math.abs(col.trio.ns[157] - Math.sin(1.57)) < 1e-3);
  assert.deepEqual([col.trio.ns.length, col.trio.ew.length, col.trio.ud.length], [300, 300, 300]);
  assert.ok(Math.abs(col.sampleRateHz - 100) < 1.5);
});

test('minimal ZIP reader: stored and deflate round-trip via the tool source', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.resolve(__dirname, '../tools/fetch-kyoshin-waveforms.js'), 'utf8');
  const unzip = new Function('zlib', 'return ' + src.match(/function unzip\(buffer\) \{[\s\S]*?\n\}/)[0])(zlib);
  function crc32(buf) {
    let c, table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function mkzip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const { name, data, method } of entries) {
      const nameB = Buffer.from(name, 'latin1');
      const payload = method === 8 ? zlib.deflateRawSync(data) : data;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
      lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameB.length, 26);
      locals.push(lh, nameB, payload);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc32(data), 16);
      ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nameB);
      offset += 30 + nameB.length + payload.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }
  const a = Buffer.from('hello waveform');
  const b = Buffer.from(JSON.stringify({ x: [1, 2, 3] }));
  const files = unzip(mkzip([{ name: 'ISK006.NS', data: a, method: 0 }, { name: 'ISK006.EW', data: b, method: 8 }]));
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'ISK006.NS');
  assert.ok(files[0].data.equals(a));
  assert.ok(files[1].data.equals(b));
});

function stationPayload(id, opts) {
  opts = opts || {};
  const n = opts.n || 512;
  const mk = phase => Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 8 + phase) * 40 * 1000) / 1000);
  return {
    _schema: 'quake-sim-waveform-v1', units: 'gal', sampleRateHz: opts.hz || 20,
    station: { id, name: opts.name || ('ST-' + id), network: opts.net || 'K-NET', lat: opts.lat || 37.1, lng: opts.lng || 136.7 },
    components: {
      z: { samples: mk(0), sha256: crypto.createHash('sha256').update(Buffer.from(new Float64Array(mk(0)).buffer)).digest('hex'), truePeakGal: 40 },
      n: { samples: mk(1), sha256: crypto.createHash('sha256').update(Buffer.from(new Float64Array(mk(1)).buffer)).digest('hex'), truePeakGal: 40 },
      e: { samples: mk(2), sha256: crypto.createHash('sha256').update(Buffer.from(new Float64Array(mk(2)).buffer)).digest('hex'), truePeakGal: 40 }
    },
    provenance: { provider: 'test', sourceUrl: 'https://example.test/x', retrievedAt: '2026-08-17T00:00:00Z' },
    quality: { researchReady: true, responseRemoved: true, sourceGapCount: 0 }
  };
}
function samplePackage() {
  return {
    schema: SMW.SCHEMA, eventId: '20240101160813',
    event: { origintime: '2024/01/01 16:10:22', lat: 37.495, lng: 137.27, depthKm: 16, mag: 7.6 },
    sampleRateHz: 20,
    stations: [stationPayload('ISK006', { lat: 37.16, lng: 136.69 }), stationPayload('ISKH03', { name: 'Wajima', net: 'KiK-net', lat: 37.4, lng: 136.9 })],
    provenance: { provider: 'test' }
  };
}

test('package validation: structural errors and per-station WaveformData delegation', () => {
  const good = SMW.validatePackage(samplePackage());
  assert.equal(good.valid, true, JSON.stringify(good.errors));
  assert.equal(good.stationCount, 2);
  assert.ok(good.certifiedStations >= 1);
  const badSchema = SMW.validatePackage({ schema: 'nope', event: {}, stations: [] });
  assert.equal(badSchema.valid, false);
  assert.ok(badSchema.errors.includes('unsupported-schema'));
  const noStations = SMW.validatePackage({ schema: SMW.SCHEMA, event: { origintime: 'x', lat: 1, lng: 2 }, stations: [] });
  assert.equal(noStations.valid, false);
  assert.ok(noStations.errors.includes('no-stations'));
  const brokenStation = samplePackage();
  brokenStation.stations[0].components.z.samples = 'corrupt';
  const broken = SMW.validatePackage(brokenStation);
  assert.equal(broken.valid, false);
});

test('packageSummary ranks by PGA and computes official-filter JMA intensity', () => {
  const pkg = samplePackage();
  pkg.stations[1].components.z.truePeakGal = 300; // heavier vector PGA on the 2nd station
  const rows = SMW.packageSummary(pkg, { Physics });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'ISKH03');
  assert.ok(rows[0].pga3cGal > rows[1].pga3cGal);
  assert.ok(isFinite(rows[0].intensity) && rows[0].intensity >= 0);
  // ~40 gal sinusoids at 20 Hz sit far above the JMA band: intensity stays modest.
  assert.ok(rows[0].intensity < 5, 'band-limited intensity should stay small, got ' + rows[0].intensity);
});

test('compareWithForecast pairs observed peaks with a GMPE-style forecast fn', () => {
  const rows = SMW.compareWithForecast(samplePackage(), (lat) => 10 + lat);
  assert.equal(rows.length, 2);
  // stations stay in package order (no ranking here): ISK006 (37.16) first.
  assert.ok(Math.abs(rows[0].predicted - (10 + 37.16)) < 1e-9);
  assert.ok(rows.every(r => isFinite(r.pga3cGal)));
});

test('no bundled packages directory is committed — packages are fetched by the owner', () => {
  // tools/fetch-kyoshin-waveforms.js output is account-gated and intentionally
  // NOT part of the repo. The guarantee is "nothing tracked by git": the
  // owner's own machine legitimately holds fetched packages in the working
  // tree (gitignored), so directory existence alone is not a violation.
  const { execFileSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '..');
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', '--', 'public/geojson/strong-motion-waveforms'],
      { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  } catch (e) { /* git unavailable — cannot verify tracking here */ }
  assert.ok(!tracked.trim(),
    'unexpected committed waveform packages — data provenance must stay fetch-tool generated');
});
