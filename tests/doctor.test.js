// ================================================================
//  Doctor resource-diagnostics module — server endpoint + client helpers
//  Server: GET /api/doctor returns the disk inventory (sounds / basemap /
//  packages / manifest sha256); hermetic tests point _doctorReport at a temp
//  tree via the _test hooks. Client: public/doctor.js pure helpers (probe
//  lists + summarize merge + refetch plan).
//  Run with:  node --test tests/doctor.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const Doctor = require('../public/doctor.js');

// Capture the server instance by patching http.createServer (same harness as
// tests/server.test.js — doctor.test.js runs in its own process in the chain).
let _server = null;
const _origCreateServer = http.createServer;
http.createServer = function(...args) {
  _server = _origCreateServer.apply(this, args);
  return _server;
};
process.env.PORT = '0';
process.env.TTS_UPSTREAM_URL = 'http://127.0.0.1:1/tts';
delete require.cache[require.resolve('../server.js')];
const serverModule = require('../server.js');

// ================================================================
//  Client-side pure helpers
// ================================================================

test('client fragment list: en excludes ph_hour/ph_min, jp/zh include them', () => {
  const en = Doctor.buildFragmentNames('en');
  const jp = Doctor.buildFragmentNames('jp');
  const zh = Doctor.buildFragmentNames('zh');
  assert.ok(!en.includes('ph_hour') && !en.includes('ph_min'));
  assert.ok(jp.includes('ph_hour') && jp.includes('ph_min'));
  assert.ok(zh.includes('ph_hour') && zh.includes('ph_min'));
  assert.equal(en.length, 177); // 100 num + 47 pref + 10 int + 10 ph + 10 shindo shorts
  assert.equal(jp.length, 179); // +ph_hour/ph_min
  assert.equal(zh.length, 179);
  // shape spot checks
  for (const n of ['num_00', 'num_99', 'pref_01', 'pref_47', 'int_5m', 'int_7', '5+', 'foreign']) {
    assert.ok(jp.includes(n), 'jp should include ' + n);
  }
});

test('client/server fragment catalogs agree (byte parity)', () => {
  const serverNames = serverModule._test.doctorFragmentNames('en');
  assert.deepEqual(serverNames, Doctor.buildFragmentNames('en'));
  assert.deepEqual(serverModule._test.doctorFragmentNames('zh'), Doctor.buildFragmentNames('zh'));
});

test('client audio probe list covers required + CSIS 12-level with URLs', () => {
  const list = Doctor.buildAudioProbeList('jp');
  assert.equal(list.filter((x) => x.kind === 'required').length, Doctor.REQUIRED_SOUNDS.length);
  assert.equal(list.filter((x) => x.kind === 'intensity12').length, 12);
  assert.ok(list.every((x) => x.url.startsWith('sounds/jp/')));
  assert.ok(list.some((x) => x.url.endsWith('/EEW_alert.wav')));
  assert.ok(list.some((x) => x.url.endsWith('/Intensity12.wav')));
});

test('summarize marks required-missing as failures and advisory extras as warnings', () => {
  const serverReport = {
    audio: {
      jp: { required: { total: 22, missing: ['EEW1.wav'] }, intensity12: { total: 12, missing: [] }, bulletinFragments: { total: 169, missing: [] } },
      en: { required: { total: 22, missing: [] }, intensity12: { total: 12, missing: ['Intensity7.wav'] }, bulletinFragments: { total: 167, missing: [] } },
      zh: { required: { total: 22, missing: [] }, intensity12: { total: 12, missing: [] }, bulletinFragments: { total: 169, missing: ['num_00.wav'] } },
    },
    map: { offlineVector: [{ file: 'coastline_10m.json', ok: true }], localTiles: { installed: false } },
    packages: { terrain: [{ file: 'bathymetry.json', ok: true }], regions: [{ region: 'california', pack: true, stations: true, areas: false, vs30: false }], faultModelIndex: true },
    manifest: { resources: [{ id: 'x', path: 'geojson/a.json', exists: true, sha256Ok: true }], checked: 1 },
  };
  const client = { lazy: [{ key: 'doctor', url: 'doctor.js?v=x', ok: true }], swCaches: ['qs-cache-v1-runtime'] };
  const summary = Doctor.summarize(serverReport, client);
  assert.equal(summary.status, 'degraded');
  const audio = summary.sections.find((s) => s.id === 'audio');
  assert.equal(audio.bad, 1); // EEW1 missing = real failure
  assert.ok(audio.items.some((i) => i.name.includes('Intensity7.wav') && i.advisory));
  // fully-trimmed fragments = the deliberate-absence note, not 169 rows
  const zhFrag = audio.items.filter((i) => i.name.includes('zh'));
  assert.ok(zhFrag.length <= 2, 'partial fragment missing should list items, got ' + zhFrag.length);
  const map = summary.sections.find((s) => s.id === 'map');
  assert.ok(map.items.some((i) => i.name === 'tiles/osm/*' && i.advisory)); // optional layer
  const pkg = summary.sections.find((s) => s.id === 'packages');
  assert.ok(pkg.items.some((i) => i.name === 'region-areas-california.json' && i.advisory));
  assert.ok(!pkg.items.some((i) => i.name === 'region-pack-california.json')); // present
});

test('buildRefetchPlan only plans non-advisory missing items', () => {
  const summary = {
    sections: [{ id: 'audio', items: [
      { name: 'a', ok: false, advisory: false, refetch: 'sounds/jp/EEW1.wav' },
      { name: 'b', ok: false, advisory: true, refetch: 'sounds/jp/Intensity7.wav' },
      { name: 'c', ok: true, refetch: null },
    ] }],
  };
  assert.deepEqual(Doctor.buildRefetchPlan(summary, 'audio'), ['sounds/jp/EEW1.wav']);
  assert.deepEqual(Doctor.buildRefetchPlan(summary, 'nope'), []);
});

// ================================================================
//  Hermetic server inventory (temp tree via _test hooks)
// ================================================================

function writeTree(root) {
  const geo = path.join(root.public, 'geojson');
  for (const lang of ['jp', 'en', 'zh']) {
    const dir = path.join(root.sounds, lang);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of serverModule._test.doctorLists().required) {
      fs.writeFileSync(path.join(dir, n + '.wav'), 'RIFF dummy ' + n);
    }
    if (lang === 'jp') {
      for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(dir, 'Intensity' + i + '.wav'), 'RIFF i12 ' + i); // 2 missing on purpose
    }
    const fdir = path.join(dir, 'info', 'female');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'num_00.wav'), 'RIFF frag'); // exactly one fragment present
  }
  fs.mkdirSync(geo, { recursive: true });
  for (const f of serverModule._test.doctorLists().basemap.concat(serverModule._test.doctorLists().terrain)) {
    fs.writeFileSync(path.join(geo, f), '{"x":1}');
  }
  for (const rid of serverModule._test.doctorLists().regions) {
    fs.writeFileSync(path.join(geo, 'region-' + rid + '.json'), '{}');
    fs.writeFileSync(path.join(geo, 'region-stations-' + rid + '.json'), '{}');
  }
  fs.mkdirSync(path.join(geo, 'fault-models'), { recursive: true });
  fs.writeFileSync(path.join(geo, 'fault-models', 'index.json'), '[]');
  // manifest: one resource with the correct sha, one stale
  fs.writeFileSync(path.join(geo, 'r-ok.json'), 'correct-content');
  fs.writeFileSync(path.join(geo, 'r-stale.json'), 'actual-content');
  const okSha = crypto.createHash('sha256').update('correct-content').digest('hex');
  const manifest = {
    _schema: 'quake-sim-research-data-manifest-v1',
    snapshotDate: '2026-11-08',
    resources: [
      { id: 'ok-resource', role: 'terrain', state: 'ready', path: 'geojson/r-ok.json', sha256: okSha },
      { id: 'stale-resource', role: 'vs30', state: 'ready', path: 'geojson/r-stale.json', sha256: 'deadbeef'.repeat(8) },
    ],
  };
  fs.writeFileSync(path.join(geo, 'research_data_manifest.json'), JSON.stringify(manifest));
}

function doctorReport(roots) {
  return new Promise((resolve, reject) => {
    serverModule._test.doctorReport(roots, (r) => resolve(r));
  });
}

test('doctor inventory on a complete temp tree: ok status, stale sha flagged', async () => {
  const root = { sounds: fs.mkdtempSync(path.join(os.tmpdir(), 'doc-snd-')), public: fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pub-')) };
  writeTree(root);
  try {
    const r = await doctorReport(root);
    // everything present except: 2 jp intensity12 (advisory), most fragments
    // (advisory), region areas/vs30 (advisory), local tiles (optional), and
    // the stale manifest sha (real failure)
    assert.equal(r.status, 'degraded');
    assert.deepEqual(r.audio.jp.required, { total: 22, missing: [] });
    assert.deepEqual(r.audio.en.required, { total: 22, missing: [] });
    assert.deepEqual(r.audio.zh.required, { total: 22, missing: [] });
    assert.equal(r.audio.jp.intensity12.missing.length, 2); // Intensity11/12 not written
    assert.equal(r.audio.en.intensity12.missing.length, 12); // advisory-only list
    assert.equal(r.audio.jp.bulletinFragments.total, 179);
    assert.equal(r.audio.jp.bulletinFragments.missing.length, 178);
    assert.equal(r.map.offlineVector.filter((f) => f.ok).length, 5);
    assert.equal(r.map.localTiles.installed, false);
    assert.equal(r.packages.terrain.filter((f) => f.ok).length, 9);
    assert.equal(r.packages.regions.filter((x) => x.region === 'california')[0].pack, true);
    assert.equal(r.packages.regions.every((x) => x.areas === false), true);
    assert.equal(r.packages.faultModelIndex, true);
    assert.equal(r.manifest.checked, 2);
    const okRes = r.manifest.resources.find((x) => x.id === 'ok-resource');
    const staleRes = r.manifest.resources.find((x) => x.id === 'stale-resource');
    assert.equal(okRes.sha256Ok, true);
    assert.equal(staleRes.sha256Ok, false);
  } finally {
    serverModule._test.doctorReset();
    fs.rmSync(root.sounds, { recursive: true, force: true });
    fs.rmSync(root.public, { recursive: true, force: true });
  }
});

test('doctor inventory on an empty tree: every category degrades honestly', async () => {
  const root = { sounds: fs.mkdtempSync(path.join(os.tmpdir(), 'doc-emp-s-')), public: fs.mkdtempSync(path.join(os.tmpdir(), 'doc-emp-p-')) };
  try {
    const r = await doctorReport(root);
    assert.equal(r.status, 'degraded');
    for (const lang of ['jp', 'en', 'zh']) {
      assert.equal(r.audio[lang].required.missing.length, 22);
      assert.equal(r.audio[lang].bulletinFragments.missing.length, r.audio[lang].bulletinFragments.total);
    }
    assert.equal(r.map.offlineVector.every((f) => !f.ok), true);
    assert.equal(r.packages.faultModelIndex, false);
    assert.equal(r.manifest.checked, 0); // no manifest file
  } finally {
    serverModule._test.doctorReset();
    fs.rmSync(root.sounds, { recursive: true, force: true });
    fs.rmSync(root.public, { recursive: true, force: true });
  }
});

// ================================================================
//  Live endpoint smoke (real repo tree)
// ================================================================

test('GET /api/doctor reports the shipped deployment as healthy', async () => {
  await new Promise((resolve, reject) => {
    if (_server && _server.listening) return resolve();
    _server.on('listening', resolve);
    setTimeout(() => reject(new Error('Server did not start within 5s')), 5000);
  });
  const base = 'http://localhost:' + _server.address().port;
  const res = await new Promise((resolve, reject) => {
    http.get(base + '/api/doctor', (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ code: r.statusCode, headers: r.headers, body: JSON.parse(b) }));
    }).on('error', reject);
  });
  assert.equal(res.code, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
  const r = res.body;
  assert.equal(r.status, 'ok');
  for (const lang of ['jp', 'en', 'zh']) {
    assert.deepEqual(r.audio[lang].required.missing, [], lang + ' required sounds');
    assert.deepEqual(r.audio[lang].intensity12.missing, [], lang + ' intensity12');
    assert.deepEqual(r.audio[lang].bulletinFragments.missing, [], lang + ' fragments');
  }
  assert.equal(r.map.offlineVector.every((f) => f.ok), true);
  assert.equal(r.packages.terrain.every((f) => f.ok), true);
  assert.equal(r.packages.regions.length, 6);
  assert.equal(r.packages.regions.every((x) => x.pack && x.stations), true);
  assert.equal(r.packages.faultModelIndex, true);
  assert.equal(r.manifest.checked, 18);
  assert.equal(r.manifest.resources.every((x) => x.sha256Ok), true);
});

// ================================================================
//  CLEANUP (same as tests/server.test.js: WS reconnect timers keep the
//  event loop alive — force exit after close)
// ================================================================

test('teardown — close server', { concurrency: false }, async () => {
  if (_server && _server.listening) {
    _server.closeAllConnections ? _server.closeAllConnections() : null;
    _server.close();
  }
  http.createServer = _origCreateServer;
  setTimeout(() => process.exit(0), 500);
});
