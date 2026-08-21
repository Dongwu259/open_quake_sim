// ================================================================
//  Integration tests — replay events index + JSONL export endpoints
//    GET /api/replay/info    → events[] timeline markers
//    GET /api/replay/export  → application/x-ndjson download
//  Run with:  node --test tests/replay-export.test.js
//  Boots its own in-process server (random port); frames are injected
//  through the _test recorder hooks, so assertions tolerate whatever
//  real frames arrive from the live upstreams meanwhile.
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let _server = null;
const _origCreateServer = http.createServer;
http.createServer = function(...args) {
  _server = _origCreateServer.apply(this, args);
  return _server;
};

process.env.PORT = '0';
process.env.TTS_UPSTREAM_URL = 'http://127.0.0.1:1/tts';
delete require.cache[require.resolve('../server.js')];

let BASE_URL = '';
let SRV = null;
let T0 = 0; // injection base time (1 min before the inject test runs)

function eewFrame(eventId, serial, t, place, mag) {
  return { t: t, type: 'wolfx_eew', event: {
    type: 'jma_eew', EventID: eventId, Serial: serial,
    Hypocenter: place, Magunitude: mag, Latitude: 32.3, Longitude: 130.5,
    Depth: 10, MaxIntensity: { From: '3', To: '3' }, isFinal: false, isCancel: false
  } };
}
function p2p551(t, opts) {
  return { t: t, type: 'p2pquake', event: Object.assign({
    id: 'p2pq_' + t, code: 551, type: 'earthquake_info',
    mag: 0, lat: 32.5, lng: 130.7, depth: 10, place: '',
    maxIntensity: 0, maxShindo: '', time: '', serial: 1,
    issueType: 'DetailScale', cancelled: false
  }, opts) };
}

test('setup — server starts and listens', { concurrency: false }, async () => {
  SRV = require('../server.js');
  await new Promise((resolve, reject) => {
    if (_server && _server.listening) {
      BASE_URL = 'http://localhost:' + _server.address().port;
      return resolve();
    }
    _server.on('listening', () => {
      BASE_URL = 'http://localhost:' + _server.address().port;
      resolve();
    });
    setTimeout(() => reject(new Error('Server did not start within 5s')), 5000);
  });
  assert.ok(SRV._test && typeof SRV._test.replayPushFrame === 'function', 'recorder test hooks exposed');
});

test('inject a deterministic frame set into the recorder', () => {
  SRV._test.replayReset();
  T0 = Date.now() - 60000;
  // EEW event 1: Serial 1 + a later report — one marker expected
  SRV._test.replayPushFrame(eewFrame('EXT-T1', 1, T0, 'EXTテスト熊本', 5.9));
  SRV._test.replayPushFrame(eewFrame('EXT-T1', 2, T0 + 5000, 'EXTテスト熊本', 6.1));
  // EEW event 2: first seen at Serial 3 (Serial 1 missed) — fallback marker
  SRV._test.replayPushFrame(eewFrame('EXT-T2', 3, T0 + 10000, 'EXTテスト天草', 3.4));
  // felt 551 bulletin — one "info" marker
  SRV._test.replayPushFrame(p2p551(T0 + 20000, { mag: 4.3, place: 'EXTテスト地方', maxIntensity: 40, maxShindo: '4' }));
  // weak 551 (maxIntensity < 30) — exported but NOT a timeline event
  SRV._test.replayPushFrame(p2p551(T0 + 25000, { mag: 2.1, place: 'EXT除外低震度', maxIntensity: 10 }));
  // cancelled 551 — exported but NOT a timeline event
  SRV._test.replayPushFrame(p2p551(T0 + 30000, { mag: 4.5, place: 'EXT除外取消', maxIntensity: 50, cancelled: true }));
  // filler of an unrelated type
  SRV._test.replayPushFrame({ t: T0 + 40000, type: 'kmoni_rt', event: { dataTime: 'x', intensity: 'ddd' } });
});

test('GET /api/replay/info exposes the events index', async () => {
  const res = await fetch(BASE_URL + '/api/replay/info');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.events), 'events array present');
  for (const e of data.events) {
    assert.ok(typeof e.t === 'number' && (e.type === 'eew' || e.type === 'info') && typeof e.label === 'string',
      'event shape {t, type, label}: ' + JSON.stringify(e));
  }
  for (let i = 1; i < data.events.length; i++) {
    assert.ok(data.events[i].t >= data.events[i - 1].t, 'events are time-ascending');
  }
  const labels = data.events.map(e => e.label);
  assert.strictEqual(labels.filter(l => l.includes('EXTテスト熊本')).length, 1,
    'Serial 1 + later report collapse into one EEW marker');
  const eew1 = data.events.find(e => e.label.includes('EXTテスト熊本'));
  assert.strictEqual(eew1.type, 'eew');
  assert.strictEqual(eew1.t, T0, 'the Serial 1 report provides the marker');
  assert.ok(/^EEW M5\.9 EXTテスト熊本$/.test(eew1.label), 'EEW label: ' + eew1.label);
  assert.strictEqual(labels.filter(l => l.includes('EXTテスト天草')).length, 1,
    'first-seen report marks an EEW whose Serial 1 was never recorded');
  const info1 = data.events.find(e => e.label.includes('EXTテスト地方'));
  assert.ok(info1 && info1.type === 'info' && info1.t === T0 + 20000, 'felt 551 bulletin marked');
  assert.ok(/^M4\.3 EXTテスト地方$/.test(info1.label), '551 label: ' + info1.label);
  assert.ok(!labels.some(l => l.includes('EXT除外低震度')), 'maxIntensity < 30 excluded');
  assert.ok(!labels.some(l => l.includes('EXT除外取消')), 'cancelled bulletin excluded');
  assert.ok(data.events.length <= 200, 'cap respected');
});

test('GET /api/replay/export rejects bad windows (400)', async () => {
  assert.strictEqual((await fetch(BASE_URL + '/api/replay/export')).status, 400, 'missing params');
  assert.strictEqual((await fetch(BASE_URL + '/api/replay/export?from=abc&to=123')).status, 400, 'non-numeric from');
  assert.strictEqual((await fetch(BASE_URL + '/api/replay/export?from=200&to=100')).status, 400, 'to < from');
  const now = Date.now();
  const tooWide = await fetch(BASE_URL + '/api/replay/export?from=' + (now - 6 * 3600e3 - 1) + '&to=' + now);
  assert.strictEqual(tooWide.status, 400, 'window over 6 hours rejected');
  const err = await tooWide.json();
  assert.strictEqual(err.error.code, 'INVALID_PARAM');
});

test('GET /api/replay/export answers 204 for an empty (future) window', async () => {
  const now = Date.now();
  const res = await fetch(BASE_URL + '/api/replay/export?from=' + (now + 3600e3) + '&to=' + (now + 5400e3));
  assert.strictEqual(res.status, 204);
  assert.strictEqual(await res.text(), '');
});

test('GET /api/replay/export streams the window as NDJSON', async () => {
  const from = T0 - 1000, to = T0 + 45000;
  const res = await fetch(BASE_URL + '/api/replay/export?from=' + from + '&to=' + to);
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('application/x-ndjson'), 'ndjson content type');
  assert.strictEqual(res.headers.get('content-length'), null,
    'single-pass streaming: no pre-counted Content-Length (chunked)');
  const cd = res.headers.get('content-disposition') || '';
  const m = /attachment; filename="quake-replay-(\d+)-(\d+)\.jsonl"/.exec(cd);
  assert.ok(m, 'content-disposition filename: ' + cd);
  assert.strictEqual(Number(m[1]), from, 'filename carries the effective (clamped) from');
  assert.ok(Number(m[2]) <= to, 'effective to is clamped to the recording range');
  const lines = (await res.text()).split('\n').filter(Boolean);
  assert.ok(lines.length >= 7, 'at least the 7 injected frames: got ' + lines.length);
  let eewT1 = 0, eewT2 = 0, info = 0, weak = 0, cancelled = 0, kmoni = 0;
  for (const line of lines) {
    const f = JSON.parse(line);
    assert.ok(typeof f.t === 'number' && typeof f.type === 'string', 'frame shape');
    assert.ok(f.t >= from && f.t <= to, 'every frame inside the window');
    const ev = f.event || {};
    if (ev.EventID === 'EXT-T1') eewT1++;
    if (ev.EventID === 'EXT-T2') eewT2++;
    if (ev.place === 'EXTテスト地方') info++;
    if (ev.place === 'EXT除外低震度') weak++;
    if (ev.place === 'EXT除外取消') cancelled++;
    if (f.type === 'kmoni_rt' && ev.intensity === 'ddd') kmoni++;
  }
  assert.strictEqual(eewT1, 2, 'both Serial reports are exported (only the index dedupes)');
  assert.strictEqual(eewT2, 1);
  assert.strictEqual(info, 1);
  assert.strictEqual(weak, 1, 'weak bulletins stay in the export');
  assert.strictEqual(cancelled, 1, 'cancelled bulletins stay in the export');
  assert.strictEqual(kmoni, 1);
});

test('GET /api/replay/export is rate limited to 10 req/min per IP', async () => {
  SRV._test.exportRateLimitReset();
  const now = Date.now();
  // future windows answer 204 cheaply — only quota consumption is under test
  for (let i = 0; i < 10; i++) {
    const res = await fetch(BASE_URL + '/api/replay/export?from=' + (now + 3600e3) + '&to=' + (now + 5400e3));
    assert.strictEqual(res.status, 204, 'request ' + (i + 1) + ' within quota');
    await res.text();
  }
  const over = await fetch(BASE_URL + '/api/replay/export?from=' + (now + 3600e3) + '&to=' + (now + 5400e3));
  assert.strictEqual(over.status, 429, '11th request in the minute rejected');
  const err = await over.json();
  assert.strictEqual(err.error.code, 'RATE_LIMITED');
  SRV._test.exportRateLimitReset();
});

test('events index is capped at 200, newest entries win', () => {
  SRV._test.replayReset();
  const base = Date.now() - 300000;
  for (let i = 0; i < 205; i++) {
    SRV._test.replayPushFrame(p2p551(base + i * 1000, { mag: 3.0, place: 'EXT CAP ' + i, maxIntensity: 30 }));
  }
  const events = SRV._test.replayScanEvents();
  assert.strictEqual(events.length, 200);
  assert.strictEqual(events[0].t, base + 5000, 'oldest entries are dropped first');
  assert.strictEqual(events[199].t, base + 204000, 'newest entry kept');
  assert.ok(events[0].label.includes('EXT CAP 5'));
  SRV._test.replayReset();
});

test('teardown — close server', { concurrency: false }, async () => {
  if (_server && _server.listening) {
    _server.closeAllConnections ? _server.closeAllConnections() : null;
    _server.close();
  }
  http.createServer = _origCreateServer;
  setTimeout(() => process.exit(0), 500);
});
