// ================================================================
//  Integration tests for the public TTS synthesis API:
//  POST support, bounded LRU audio cache, keyed rate-limit tiers,
//  and the neuralVoices catalog. Uses a stub upstream TTS service.
//  Run with:  node --test tests/tts-api.test.js
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

const API_KEY = 'qs-test-tts-api-key';
process.env.PORT = '0';
process.env.QUAKE_API_KEY = API_KEY;

let BASE_URL = '';
let _upstream = null;
let upstreamHits = 0;
const FAKE_MP3 = Buffer.from('ID3 fake-mp3-frame');
// A non-loopback client IP so these tests get their own rate-limit bucket
// (the server trusts X-Forwarded-For from loopback peers, as behind nginx).
const XFF = { 'X-Forwarded-For': '10.250.250.7' };

// (teardown test at the bottom closes the servers and force-exits)

test('setup — stub upstream + server start', { concurrency: false }, async () => {
  _upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(FAKE_MP3);
  });
  await new Promise(resolve => _upstream.listen(0, '127.0.0.1', resolve));
  process.env.TTS_UPSTREAM_URL = 'http://127.0.0.1:' + _upstream.address().port + '/tts';

  delete require.cache[require.resolve('../server.js')];
  require('../server.js');
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
  assert.ok(BASE_URL.length > 0);
});

test('POST /api/tts/synthesize returns audio and caches it (MISS then HIT)', async () => {
  const body = JSON.stringify({ text: 'テスト音声です', voice: 'ja-JP-NanamiNeural' });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', ...XFF }, body };
  const first = await fetch(BASE_URL + '/api/tts/synthesize', opts);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'audio/mpeg');
  assert.equal(first.headers.get('x-tts-cache'), 'MISS');
  const buf1 = Buffer.from(await first.arrayBuffer());
  assert.deepEqual(buf1, FAKE_MP3);

  const second = await fetch(BASE_URL + '/api/tts/synthesize', opts);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-tts-cache'), 'HIT');
  assert.equal(upstreamHits, 1, 'cache hit must not call the upstream again');
});

test('GET /api/tts/synthesize keeps working alongside POST', async () => {
  const res = await fetch(BASE_URL + '/api/tts/synthesize?text=' + encodeURIComponent('GET確認'), { headers: XFF });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
});

test('POST /api/tts/synthesize validates input', async () => {
  const bad = await fetch(BASE_URL + '/api/tts/synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...XFF }, body: '{not json'
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_JSON');

  const missing = await fetch(BASE_URL + '/api/tts/synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...XFF }, body: '{}'
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'MISSING_PARAM');

  const voice = await fetch(BASE_URL + '/api/tts/synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...XFF },
    body: JSON.stringify({ text: 'x', voice: 'arbitrary-voice' })
  });
  assert.equal(voice.status, 400);
  assert.equal((await voice.json()).error.code, 'INVALID_PARAM');
});

test('GET /api/tts/voices lists the neural synthesis voices', async () => {
  const res = await fetch(BASE_URL + '/api/tts/voices', { headers: XFF });
  const data = await res.json();
  assert.ok(Array.isArray(data.voices) && data.voices.length === 3, 'fragment packs kept');
  assert.ok(Array.isArray(data.neuralVoices), 'neuralVoices added');
  assert.equal(data.neuralVoices.length, 11);
  assert.ok(data.neuralVoices.some(v => v.name === 'ja-JP-NanamiNeural' && v.lang === 'ja'));
  assert.ok(data.neuralVoices.some(v => v.name === 'ko-KR-SunHiNeural' && v.lang === 'ko'));
});

test('anonymous synthesis is capped at 60/min per IP, keyed calls get their own bucket', async () => {
  // Burn the anonymous per-IP bucket (cache HITs still count toward the limit).
  // A dedicated client IP keeps this test isolated from the ones above.
  const XFF_RATE = { 'X-Forwarded-For': '10.250.250.9' };
  const url = BASE_URL + '/api/tts/synthesize?text=' + encodeURIComponent('制限確認');
  let lastStatus = 0;
  for (let i = 0; i < 60; i++) {
    const res = await fetch(url, { headers: XFF_RATE });
    lastStatus = res.status;
    await res.arrayBuffer(); // drain
  }
  assert.equal(lastStatus, 200);
  const blocked = await fetch(url, { headers: XFF_RATE });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');

  // An API key gets its own 240/min bucket and still works from the same IP.
  const keyed = await fetch(url + '&key=' + API_KEY, { headers: XFF_RATE });
  assert.equal(keyed.status, 200);
  assert.equal(keyed.headers.get('content-type'), 'audio/mpeg');
});

test('teardown — close servers', { concurrency: false }, async () => {
  if (_server && _server.listening) {
    _server.closeAllConnections ? _server.closeAllConnections() : null;
    _server.close();
  }
  if (_upstream) _upstream.close();
  http.createServer = _origCreateServer;
  // Force exit to stop lingering WS reconnect timers
  setTimeout(() => process.exit(0), 500);
});
