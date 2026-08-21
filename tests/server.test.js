// ================================================================
//  Integration tests for Earthquake Simulator — Server HTTP
//  Run with:  node --test tests/server.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Capture the server instance by patching http.createServer
let _server = null;
let _serverModule = null;
const _origCreateServer = http.createServer;
http.createServer = function(...args) {
  _server = _origCreateServer.apply(this, args);
  return _server;
};

// Force random port
process.env.PORT = '0';
process.env.TTS_UPSTREAM_URL = 'http://127.0.0.1:1/tts';
// Clear any cached require
delete require.cache[require.resolve('../server.js')];

let BASE_URL = '';

// ================================================================
//  SETUP — wait for server to be ready
// ================================================================

test('setup — server starts and listens', { concurrency: false }, async () => {
  // server.js calls http.createServer and server.listen(PORT) at module level
  _serverModule = require('../server.js');

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

  assert.ok(BASE_URL.length > 0, 'Server should have a URL');
});

test('catalog query parameters reach both upstream requests', () => {
  const params = new URLSearchParams({
    starttime: '2026-01-02T03:04:05Z',
    endtime: '2026-01-03T04:05:06Z',
    minmag: '5.4'
  });
  const requests = _serverModule._test.buildCatalogRequests(params);
  const fdsn = new URL(requests.fdsnUrl);
  const live = new URL(requests.liveUrl);
  assert.strictEqual(fdsn.searchParams.get('starttime'), '2026-01-02T03:04:05Z');
  assert.strictEqual(fdsn.searchParams.get('endtime'), '2026-01-03T04:05:06Z');
  assert.strictEqual(fdsn.searchParams.get('minmagnitude'), '5.4');
  assert.strictEqual(live.searchParams.get('minMag'), '5.4');
  assert.strictEqual(live.searchParams.get('startTime'), String(Date.parse('2026-01-02T03:04:05Z') / 1000));
});

test('waveform selections reach the Python command arguments', () => {
  const args = _serverModule._test.buildWaveformArgs(new URLSearchParams({
    station: 'MAJO', network: 'IU', location: '00', channel: 'HHZ', hours: '7',
    purpose: 'analysis', components: '3', durationSeconds: '900', endtime: '2026-01-02T03:04:05Z'
  }));
  assert.deepStrictEqual(args, [
    '--station', 'MAJO', '--network', 'IU', '--location', '00', '--channel', 'HHZ', '--hours', '7',
    '--purpose', 'analysis', '--duration-seconds', '900', '--endtime', '2026-01-02T03:04:05.000Z',
    '--three-component'
  ]);
});

test('waveform arguments reject unsafe or invalid research selections', () => {
  assert.equal(_serverModule._test.buildWaveformArgs(new URLSearchParams({station:'../x'})), null);
  assert.equal(_serverModule._test.buildWaveformArgs(new URLSearchParams({purpose:'raw'})), null);
  assert.equal(_serverModule._test.buildWaveformArgs(new URLSearchParams({endtime:'not-a-date'})), null);
});

test('client IP trusts validated proxy headers only from loopback peers', () => {
  const getIp = _serverModule._test.getClientIp;
  assert.strictEqual(getIp({socket:{remoteAddress:'127.0.0.1'},headers:{'x-real-ip':'203.0.113.8'}}), '203.0.113.8');
  assert.strictEqual(getIp({socket:{remoteAddress:'::ffff:127.0.0.1'},headers:{'x-real-ip':'invalid','x-forwarded-for':'192.0.2.99, 198.51.100.4'}}), '198.51.100.4');
  assert.strictEqual(getIp({socket:{remoteAddress:'192.0.2.10'},headers:{'x-real-ip':'203.0.113.9'}}), '192.0.2.10');
});

// ================================================================
//  HEALTH & STATIC
// ================================================================

test('GET /health returns valid JSON (200 or 503 depending on WS state)', async () => {
  const res = await fetch(BASE_URL + '/health');
  assert.ok([200, 503].includes(res.status), `Expected 200 or 503, got ${res.status}`);
  const data = await res.json();
  assert.ok(typeof data.uptime === 'number', 'should include uptime');
  assert.ok(typeof data.totalUptime === 'number', 'should include persistent total uptime');
  assert.ok(data.totalUptime >= data.uptime, 'total uptime should include the current process uptime');
  // status is 'ok' when at least one data source is connected
  assert.ok(data.status === 'ok' || data.status === 'degraded',
    `status should be ok or degraded, got "${data.status}"`);
});

test('GET / returns index.html (200, text/html)', async () => {
  const res = await fetch(BASE_URL + '/');
  assert.strictEqual(res.status, 200);
  const ct = res.headers.get('content-type') || '';
  assert.ok(ct.includes('text/html'), `Expected text/html, got ${ct}`);
  const body = await res.text();
  assert.ok(body.includes('Earthquake Simulator'), 'should contain app title');
});

test('GET /nonexistent_file_xyz returns 404', async () => {
  const res = await fetch(BASE_URL + '/nonexistent_file_xyz.abc');
  assert.strictEqual(res.status, 404);
});

test('Directory traversal (/../) returns 403', async () => {
  const res = await fetch(BASE_URL + '/../server.js');
  assert.notStrictEqual(res.status, 200, 'should not serve file via traversal');
  assert.ok(res.status === 403 || res.status === 404,
    `Expected 403 or 404, got ${res.status}`);
});

// ================================================================
//  DYNAMIC TTS PROXY
// ================================================================

test('GET /api/tts/synthesize rejects a missing text parameter', async () => {
  const res = await fetch(BASE_URL + '/api/tts/synthesize');
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error.code, 'MISSING_PARAM');
});

test('GET /api/tts/synthesize rejects unsupported voices', async () => {
  const res = await fetch(BASE_URL + '/api/tts/synthesize?text=test&voice=arbitrary-voice');
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error.code, 'INVALID_PARAM');
});

test('GET /api/tts/synthesize enforces the 300-character limit', async () => {
  const text = encodeURIComponent('あ'.repeat(301));
  const res = await fetch(BASE_URL + '/api/tts/synthesize?text=' + text);
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error.code, 'INVALID_PARAM');
});

test('GET /api/tts/synthesize fails closed when the local service is unavailable', async () => {
  const res = await fetch(BASE_URL + '/api/v1/tts/synthesize?text=' + encodeURIComponent('地震情報'));
  assert.strictEqual(res.status, 502);
  const data = await res.json();
  assert.strictEqual(data.error.code, 'UPSTREAM_ERROR');
});

// ================================================================
//  SECURITY HEADERS
// ================================================================

test('CSP header present on HTML responses', async () => {
  const res = await fetch(BASE_URL + '/');
  const csp = res.headers.get('content-security-policy') || '';
  assert.ok(csp.length > 0, 'CSP header must be present');
});

test('X-Frame-Options header present', async () => {
  const res = await fetch(BASE_URL + '/');
  const xfo = res.headers.get('x-frame-options') || '';
  assert.ok(xfo.length > 0, 'X-Frame-Options must be present');
});

test('Cache-Control set for static assets', async () => {
  const res = await fetch(BASE_URL + '/app.js');
  const cc = res.headers.get('cache-control') || '';
  assert.ok(cc.length > 0, `Cache-Control should be set, got "${cc}"`);
});

test('generated alert sounds are served as real WAV audio', async () => {
  const res = await fetch(BASE_URL + '/sounds/jp/Shindo5m_alert.wav');
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('audio/wav'));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(bytes.toString('ascii', 8, 12), 'WAVE');
});

test('legacy MPEG-in-WAV assets are served with their real MIME type', async () => {
  const res = await fetch(BASE_URL + '/sounds/zh/EEW1.wav');
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('audio/mpeg'));
});

test('audio byte ranges return 206 and Content-Range', async () => {
  const res = await fetch(BASE_URL + '/sounds/jp/Shindo5m_alert.wav', {
    headers: { Range: 'bytes=0-1023' }
  });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('content-length'), '1024');
  assert.match(res.headers.get('content-range') || '', /^bytes 0-1023\/\d+$/);
  assert.strictEqual((await res.arrayBuffer()).byteLength, 1024);
});

test('gzip cache invalidates when a deployed file changes in place', async () => {
  const name = '__gzip_cache_test__.js';
  const file = path.join(__dirname, '..', 'public', name);
  try {
    fs.writeFileSync(file, 'A'.repeat(4096));
    const first = await fetch(BASE_URL + '/' + name + '?v=first', {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.strictEqual(await first.text(), 'A'.repeat(4096));

    fs.writeFileSync(file, 'B'.repeat(4096));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    const second = await fetch(BASE_URL + '/' + name + '?v=second', {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.strictEqual(await second.text(), 'B'.repeat(4096));
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

test('web manifest references only existing local icons', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(publicDir, icon.src)), `missing manifest icon: ${icon.src}`);
  }
});

// ================================================================
//  REPLAY (回放) — SSE stream recorder + replay endpoints
// ================================================================

// Timestamp captured just before the EEW injection, so the replay-stream
// test can bound its selection window and stay fast on a warm recordings dir.
let _replayTestT0 = 0;

test('POST /api/test/eew is captured by the recorder', async () => {
  _replayTestT0 = Date.now();
  const res = await fetch(BASE_URL + '/api/test/eew', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'REPLAYTEST', mag: 5.5, lat: 35.0, lng: 140.0 })
  });
  assert.strictEqual(res.status, 200);
  // Race-free assertion: with the always-on kmoni poller, every recorded push
  // also evicts ring frames older than 3h, so absolute /info counts can SHRINK
  // between two fetches (before -> after). Verify the injected frame itself is
  // retrievable from the recording instead of comparing absolute counts.
  const info = await (await fetch(BASE_URL + '/api/replay/info')).json();
  assert.strictEqual(info.ok, true);
  assert.ok(typeof info.frames === 'number' && info.frames > 0);
  assert.ok(info.earliest <= info.latest, 'earliest should be <= latest');
  const ex = await fetch(BASE_URL + '/api/replay/export?from=' + (_replayTestT0 - 10000) + '&to=' + Date.now());
  assert.strictEqual(ex.status, 200);
  const body = await ex.text();
  assert.ok(body.indexOf('"REPLAYTEST"') >= 0, 'injected frame present in the recording');
  assert.ok(body.indexOf('wolfx_eew') >= 0, 'frame typed wolfx_eew');
});

test('GET /api/replay/info exposes the recorder shape', async () => {
  const res = await fetch(BASE_URL + '/api/replay/info');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.ok(typeof data.frames === 'number' && data.frames >= 0);
  assert.ok(data.earliest === null || typeof data.earliest === 'number');
  assert.ok(data.latest === null || typeof data.latest === 'number');
  assert.ok(data.byType && typeof data.byType === 'object');
  assert.ok(typeof data.diskBytes === 'number');
  const health = await (await fetch(BASE_URL + '/health')).json();
  assert.ok(health.replay && typeof health.replay.frames === 'number', '/health should expose replay stats');
  assert.ok(typeof health.replay.clients === 'number');
});

test('GET /api/replay/stream replays the injected frame before replay_end', async () => {
  const res = await fetch(BASE_URL + '/api/replay/stream?speed=120&from=' + _replayTestT0);
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
  const body = await res.text();
  const eewIdx = body.indexOf('event: wolfx_eew');
  const endIdx = body.indexOf('event: replay_end');
  assert.ok(eewIdx >= 0, 'expected the injected wolfx_eew frame in the replay');
  assert.ok(endIdx > eewIdx, 'replay_end must come after the wolfx_eew frame');
  assert.ok(body.includes('"replayTs"'), 'replay frames should carry the original record time');
});

// ================================================================
//  SSE PER-IP CONNECTION CAPS + NAMED PING
// ================================================================

// Hold an SSE connection open; the caller destroys res when done.
// Pinned to 127.0.0.1 so every connection keys to the same per-IP bucket
// (localhost can flip between ::1 and 127.0.0.1 per socket).
function openStream(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE_URL.replace('localhost', '127.0.0.1') + path, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}
function readBody(res) {
  return new Promise((resolve, reject) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => resolve(buf));
    res.on('error', reject);
  });
}

test('GET /api/p2pquake/stream enforces the per-IP cap (6 per IP)', async () => {
  // The deferred writeHead flushes on the first stream write — a fast ping
  // interval answers each connection promptly instead of waiting on a frame.
  _serverModule._test.ssePingSetMs(100);
  const held = [];
  try {
    for (let i = 0; i < 6; i++) {
      const h = await openStream('/api/p2pquake/stream');
      assert.strictEqual(h.res.statusCode, 200, 'connection ' + (i + 1) + ' accepted');
      h.res.resume(); // drain pings/heartbeats
      held.push(h);
    }
    const over = await openStream('/api/p2pquake/stream');
    assert.strictEqual(over.res.statusCode, 429, '7th connection from the same IP rejected');
    const body = JSON.parse(await readBody(over.res));
    assert.strictEqual(body.error, 'too many connections');
  } finally {
    for (const h of held) h.res.destroy();
    _serverModule._test.ssePingSetMs(15000);
    // let the server-side close handlers run before later tests open streams
    await new Promise(r => setTimeout(r, 300));
  }
});

test('GET /api/replay/stream enforces the per-IP cap (2 per IP)', async () => {
  // Seed a handful of frames so the replay streams stay open at speed 0.25
  // (2 s/frame pacing cap) while the extra connection is attempted.
  const t0 = Date.now() - 60000;
  for (let i = 0; i < 5; i++) {
    _serverModule._test.replayPushFrame({ t: t0 + i * 10000, type: 'kmoni_rt', event: { tag: 'cap-hold' } });
  }
  const held = [];
  try {
    for (let i = 0; i < 2; i++) {
      const h = await openStream('/api/replay/stream?speed=0.25&from=' + t0);
      assert.strictEqual(h.res.statusCode, 200, 'replay connection ' + (i + 1) + ' accepted');
      h.res.resume(); // drain replayed frames
      held.push(h);
    }
    const over = await openStream('/api/replay/stream?speed=0.25&from=' + t0);
    assert.strictEqual(over.res.statusCode, 429, '3rd replay connection from the same IP rejected');
    const body = JSON.parse(await readBody(over.res));
    assert.strictEqual(body.error, 'too many connections');
  } finally {
    for (const h of held) h.res.destroy();
    await new Promise(r => setTimeout(r, 300));
  }
});

test('GET /api/geoip serves a per-IP 60 s cache (stale on upstream error)', async () => {
  const T = _serverModule._test;
  let calls = 0;
  T.geoipReset();
  T.geoipSetFetcher(function(url, cb) { calls++; cb(null, '{"lat":35.6,"lng":139.7}'); });
  try {
    const r1 = await fetch(BASE_URL + '/api/geoip');
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(await r1.json(), { lat: 35.6, lng: 139.7 });
    assert.strictEqual(calls, 1, 'first response fetched upstream');
    const r2 = await fetch(BASE_URL + '/api/geoip');
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(calls, 1, 'second response served from the per-IP cache');
    // stale-if-error: backdate the entry past the TTL, then fail upstream
    const keys = Object.keys(T.geoipCache());
    assert.strictEqual(keys.length, 1, 'cached under exactly one client IP');
    T.geoipCache()[keys[0]].fetchedAt = 0;
    T.geoipSetFetcher(function(url, cb) { calls++; cb(new Error('geoip down')); });
    const r3 = await fetch(BASE_URL + '/api/geoip');
    assert.strictEqual(r3.status, 200);
    assert.deepStrictEqual(await r3.json(), { lat: 35.6, lng: 139.7 }, 'stale cached body beats a 502');
  } finally {
    T.geoipSetFetcher(null);
    T.geoipReset();
  }
});

test('GET /api/geoip cache is hard-capped: oldest fetchedAt evicted past 1024', async () => {
  const T = _serverModule._test;
  T.geoipReset();
  T.geoipSetFetcher(function(url, cb) { cb(null, '{"lat":35.6,"lng":139.7}'); });
  try {
    // seed the cache at capacity with distinct, ancient timestamps
    const cache = T.geoipCache();
    for (let i = 0; i < 1024; i++) {
      cache['10.' + ((i >> 16) & 255) + '.' + ((i >> 8) & 255) + '.' + (i & 255)] =
        { body: '{}', fetchedAt: 1000 + i };
    }
    assert.strictEqual(Object.keys(T.geoipCache()).length, 1024);
    // one real request inserts the loopback IP and trips the cap sweep
    const r = await fetch(BASE_URL + '/api/geoip');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { lat: 35.6, lng: 139.7 });
    const after = T.geoipCache();
    const keys = Object.keys(after);
    assert.strictEqual(keys.length, 1024, 'back at capacity after the eviction sweep');
    assert.ok(!('10.0.0.0' in after), 'the oldest entry was evicted');
    assert.ok(('10.0.3.255' in after), 'the newest seeded entry survived');
    const fresh = keys.filter(k => k.indexOf('10.') !== 0);
    assert.strictEqual(fresh.length, 1, 'exactly one non-seeded (loopback) entry');
    assert.ok(after[fresh[0]].fetchedAt > 1000 + 1023, 'the fresh insert was not evicted');
  } finally {
    T.geoipSetFetcher(null);
    T.geoipReset();
  }
});

test('live SSE stream emits named ping frames (event: ping)', async () => {
  const T = _serverModule._test;
  T.ssePingSetMs(100); // shrink the 15 s interval for the test
  let h = null;
  try {
    h = await openStream('/api/p2pquake/stream');
    assert.strictEqual(h.res.statusCode, 200);
    const buf = await new Promise((resolve, reject) => {
      let data = '';
      const to = setTimeout(() => reject(new Error('no ping frame within 3 s')), 3000);
      h.res.on('data', (c) => {
        data += c.toString();
        if (data.indexOf('event: ping') >= 0) { clearTimeout(to); resolve(data); }
      });
      h.res.on('error', reject);
    });
    assert.ok(/event: ping\ndata: \{"t":\d+\}/.test(buf),
      'named ping frame carries epoch ms, got: ' + JSON.stringify(buf.slice(0, 80)));
  } finally {
    if (h) h.res.destroy();
    T.ssePingSetMs(15000);
    await new Promise(r => setTimeout(r, 300));
  }
});

// ================================================================
//  KMONI OFFICIAL IMAGE PROXY (/api/kmoni/image)
// ================================================================

test('GET /api/kmoni/image — 200 shape, source failover and body cache', async () => {
  const T = _serverModule._test;
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64, 1)]);
  const seen = [];
  T.kmoniImageReset();
  T.kmoniImageSetFetcher(function(url, cb) {
    seen.push(url);
    if (url.indexOf('/new/') >= 0) return cb(new Error('nied-new down'));
    cb(null, gif);
  });
  try {
    const res = await fetch(BASE_URL + '/api/kmoni/image');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/gif');
    assert.strictEqual(res.headers.get('x-kmoni-image-source'), 'nied-old',
      'falls over to the second candidate when the first fails');
    assert.ok(/^\d{14}$/.test(res.headers.get('x-kmoni-image-time') || ''), 'frame timestamp header');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(gif), 'serves the upstream bytes verbatim');
    assert.strictEqual(seen.length, 2, 'probed nied-new then nied-old');
    assert.ok(seen.every(u => /RealTimeImg\/jma_s\/\d{8}\/\d{14}\.jma_s\.gif$/.test(u)), 'upstream URL shape');
    // body cache (~5 s): an immediate repeat must not re-probe upstream
    const res2 = await fetch(BASE_URL + '/api/kmoni/image');
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(seen.length, 2, 'served from the 5 s body cache');
  } finally {
    T.kmoniImageSetFetcher(null);
    T.kmoniImageReset();
  }
});

test('GET /api/kmoni/image — all sources down: 503 shape and 60 s backoff', async () => {
  const T = _serverModule._test;
  let calls = 0;
  T.kmoniImageReset();
  T.kmoniImageSetFetcher(function(url, cb) { calls++; cb(new Error('boom')); });
  try {
    const res = await fetch(BASE_URL + '/api/kmoni/image');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers.get('retry-after'), '60');
    const data = await res.json();
    assert.strictEqual(data.error.code, 'UPSTREAM_ERROR');
    assert.strictEqual(calls, T.kmoniImageSources.length, 'every candidate probed once');
    const res2 = await fetch(BASE_URL + '/api/kmoni/image');
    assert.strictEqual(res2.status, 503);
    assert.strictEqual(calls, T.kmoniImageSources.length, 'backoff blocks re-probing');
  } finally {
    T.kmoniImageSetFetcher(null);
    T.kmoniImageReset();
  }
});

test('kmoni image frame validator accepts GIF/PNG magic only', () => {
  const T = _serverModule._test;
  assert.strictEqual(T.kmoniImageContentType(Buffer.from('GIF89a' + '0'.repeat(40))), 'image/gif');
  assert.strictEqual(T.kmoniImageContentType(Buffer.from('GIF87a' + '0'.repeat(40))), 'image/gif');
  assert.strictEqual(T.kmoniImageContentType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)])), 'image/png');
  assert.strictEqual(T.kmoniImageContentType(Buffer.from('<?xml version="1.0"?><Error/>' + '0'.repeat(20))), null);
  assert.strictEqual(T.kmoniImageContentType(Buffer.alloc(10)), null, 'too short');
  assert.strictEqual(T.kmoniImageContentType(null), null);
});

// ================================================================
//  CLEANUP
// ================================================================

test('teardown — close server', { concurrency: false }, async () => {
  if (_server && _server.listening) {
    // Close all connections and stop listening
    _server.closeAllConnections ? _server.closeAllConnections() : null;
    _server.close();
  }
  // Restore original createServer
  http.createServer = _origCreateServer;
  // Force exit to stop lingering WS reconnect timers
  setTimeout(() => process.exit(0), 500);
});
