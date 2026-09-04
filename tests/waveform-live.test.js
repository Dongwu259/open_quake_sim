// ================================================================
//  Unit + integration tests for the live-waveform proxy:
//    - server-side miniSEED v2.4 STEIM1/2 decoding (server.js
//      decodeMiniSEED, a faithful port of libmseed
//      msr_decode_steim1/2 — table verified sample-by-sample against
//      the libmseed Steim2-AllDifferences fixture + ObsPy and live
//      EarthScope NGF IU streams, 2026-09-03)
//    - GET /api/waveform/live route semantics: frozen-station
//      whitelist, windowSec quantisation, 30 s LRU cache,
//      204-no-data honesty, stale-if-error, rate limit
//  Run with:  node --test tests/waveform-live.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// ----------------------------------------------------------------
//  SYNTHETIC miniSEED BUILDER (test-side encoder)
// ----------------------------------------------------------------
// Builds a big-endian 512-byte STEIM record from a diff plan: an array
// of { mode, diffs } where mode ∈ {7x4, 6x5, 5x6, 4x8, 3x10, 2x15, 1x30}
// (STEIM2) or {4x8, 2x16, 1x32} (STEIM1). The FIRST diff of the WHOLE
// plan is the discarded "link" diff (libmseed semantics: the decoder
// drops the first difference of the record — it links to the previous
// record's last sample), so author plan[0] with a leading 0 and the
// expected samples are the cumsum of every diff AFTER that first one.
function se(v, bits) {
  const half = 1 << (bits - 1);
  return v >= half ? v - (1 << bits) : v;
}
function packWord(mode, diffs) {
  // returns {word, nibble} with diffs encoded big-endian per canonical table
  const put = (w, shift, bits, v) => w | ((v & ((1 << bits) - 1)) << shift);
  if (mode === '4x8') {
    let w = 0;
    for (let i = 0; i < 4; i++) w = put(w, 24 - i * 8, 8, diffs[i]);
    return { word: w, nibble: 1 };
  }
  if (mode === '2x16') {
    let w = 0;
    for (let i = 0; i < 2; i++) w = put(w, 16 - i * 16, 16, diffs[i]);
    return { word: w, nibble: 2 };
  }
  if (mode === '1x32') return { word: diffs[0] | 0, nibble: 3 };
  if (mode === '1x30') {
    let w = (1 << 30); // dnib = 01
    w = put(w, 0, 30, diffs[0]);
    return { word: w, nibble: 2 };
  }
  if (mode === '2x15') {
    let w = (2 << 30); // dnib = 10
    w = put(w, 15, 15, diffs[0]); w = put(w, 0, 15, diffs[1]);
    return { word: w, nibble: 2 };
  }
  if (mode === '3x10') {
    let w = (3 << 30); // dnib = 11
    w = put(w, 20, 10, diffs[0]); w = put(w, 10, 10, diffs[1]); w = put(w, 0, 10, diffs[2]);
    return { word: w, nibble: 2 };
  }
  if (mode === '5x6') {
    let w = (0 << 30); // dnib = 00
    for (let i = 0; i < 5; i++) w = put(w, 24 - i * 6, 6, diffs[i]);
    return { word: w, nibble: 3 };
  }
  if (mode === '6x5') {
    let w = (1 << 30); // dnib = 01
    for (let i = 0; i < 6; i++) w = put(w, 25 - i * 5, 5, diffs[i]);
    return { word: w, nibble: 3 };
  }
  if (mode === '7x4') {
    let w = (2 << 30); // dnib = 10
    for (let i = 0; i < 7; i++) w = put(w, 24 - i * 4, 4, diffs[i]);
    return { word: w, nibble: 3 };
  }
  throw new Error('unknown mode ' + mode);
}

function buildRecord(x0, plan, opts) {
  const o = Object.assign({ encoding: 11, sps: 40, seq: 1 }, opts || {});
  // expected samples: X0 plus the cumsum of every diff AFTER the first
  // (the first diff of the record is the discarded link)
  const samples = [x0];
  let isLink = true;
  for (const p of plan) {
    for (const d of p.diffs) {
      if (isLink) { isLink = false; continue; }
      samples.push(samples[samples.length - 1] + d);
    }
  }
  // distribute words across frames (frame 0 has 13 data slots W3..W15)
  const words = [];
  for (const p of plan) words.push(packWord(p.mode, p.diffs));
  const frames = [];
  let wi = 0;
  let nFrames = Math.ceil((words.length + 3 + 3) / 15) + 1; // upper bound; fixed below
  nFrames = Math.max(1, Math.ceil((words.length) / 13) + (words.length <= 13 ? 1 : 1));
  while (frames.length < nFrames && wi < words.length) {
    const f = new Array(16).fill(0);
    let w0 = 0;
    const start = frames.length === 0 ? 3 : 1;
    for (let w = start; w <= 15 && wi < words.length; w++) {
      const { word, nibble } = words[wi++];
      f[w] = word >>> 0;
      w0 |= (nibble & 3) << (30 - 2 * w);
    }
    f[0] = w0 >>> 0;
    frames.push(f);
  }
  // frame 0 specials
  if (frames.length) {
    frames[0][1] = x0 | 0;
    frames[0][2] = samples[samples.length - 1] | 0;
    const w0 = frames[0][0] >>> 0;
    frames[0][0] = ((w0 & ~(3 << 28) & ~(3 << 26)) | (0 << 28) | (0 << 26)) >>> 0;
  }
  // pad to complete final frame
  while (frames.length === 0 || (frames.length * 15 < words.length + 0)) break;
  const rec = Buffer.alloc(512);
  rec.write('00000' + String(o.seq % 10) + 'D', 0, 7, 'ascii');
  rec.write('TEST ', 8, 5, 'ascii');
  rec.write('00', 13, 2, 'ascii');
  rec.write('BHZ', 15, 3, 'ascii');
  rec.write('XX', 18, 2, 'ascii');
  rec.writeUInt16BE(2026, 20);
  rec.writeUInt16BE(246, 22); // day of year
  rec.writeUInt16BE(samples.length, 30);
  rec.writeInt16BE(o.sps, 32); // rateF = sps, rateM = 1
  rec.writeInt16BE(1, 34);
  rec[39] = 1; // numblockettes
  rec.writeUInt16BE(64, 44);   // data offset
  rec.writeUInt16BE(48, 46);   // blockette offset
  // blockette 1000 @48: type, next, encoding, word order (BE), reclen 2^9, reserved
  rec.writeUInt16BE(1000, 48);
  rec.writeUInt16BE(0, 50);
  rec[52] = o.encoding;
  rec[53] = 1;
  rec[54] = 9;
  let off = 64;
  for (const f of frames) {
    for (let i = 0; i < 16; i++) { rec.writeUInt32BE(f[i] >>> 0, off); off += 4; }
  }
  return { record: rec, samples };
}

// ----------------------------------------------------------------
//  SERVER MODULE (patched createServer like tests/server.test.js)
// ----------------------------------------------------------------
let _server = null;
let S = null;
const _origCreateServer = http.createServer;
http.createServer = function (...args) {
  _server = _origCreateServer.apply(this, args);
  return _server;
};
process.env.PORT = '0';
delete require.cache[require.resolve('../server.js')];

let BASE_URL = '';

test('setup — server starts', { concurrency: false }, async () => {
  S = require('../server.js');
  await new Promise((resolve) => {
    if (_server && _server.listening) return resolve();
    _server.on('listening', () => resolve());
  });
  BASE_URL = 'http://localhost:' + _server.address().port;
  assert.ok(BASE_URL.length > 0);
});

// ----------------------------------------------------------------
//  DECODER — STEIM2 all-modes round trip
// ----------------------------------------------------------------
test('decodeMiniSEED: synthetic STEIM2 record exercising all 7 modes round-trips exactly', () => {
  const plan = [
    { mode: '4x8', diffs: [0, 0, 0, 0] }, // leading 0 = link diff (discarded by the decoder); the rest are real flat-line diffs
    { mode: '7x4', diffs: [1, -2, 3, -4, 5, -6, 7] },
    { mode: '7x4', diffs: [-7, 6, -5, 4, -3, 2, -1] },
    { mode: '6x5', diffs: [15, -15, 14, -14, 7, -7] },
    { mode: '5x6', diffs: [31, -31, 30, -30, 1] },
    { mode: '4x8', diffs: [127, -127, 100, -100] },
    { mode: '3x10', diffs: [511, -511, 500] },
    { mode: '2x15', diffs: [16383, -16383] },
    { mode: '1x30', diffs: [536870911 - 1000] },
    { mode: '1x30', diffs: [-(536870911 - 1000)] },
    { mode: '7x4', diffs: [0, 0, 0, 0, 0, 0, 0] },
    { mode: '4x8', diffs: [1, 2, 3, 4] },
    { mode: '7x4', diffs: [-8, 7, -8, 7, -8, 7, -8] }, // sign boundary of 4-bit
    { mode: '6x5', diffs: [-16, 15, -16, 15, -16, 15] }, // sign boundary of 5-bit
    { mode: '5x6', diffs: [-32, 31, -32, 31, -32] }, // sign boundary of 6-bit
    { mode: '3x10', diffs: [-512, 511, -512] } // sign boundary of 10-bit
  ];
  const { record, samples } = buildRecord(12345, plan);
  const d = S._test.decodeMiniSEED(record);
  assert.strictEqual(d.droppedRecords, 0, 'no records dropped: ' + JSON.stringify(d.dropReasons));
  assert.strictEqual(d.segments.length, 1);
  assert.strictEqual(d.xnMismatches, 0, 'Xn integrity check passes');
  assert.deepStrictEqual(d.segments[0].counts, samples, 'sample-exact round trip');
  assert.strictEqual(d.segments[0].sps, 40);
});

test('decodeMiniSEED: STEIM1 record round-trips (4x8 / 2x16 / 1x32)', () => {
  const plan = [
    { mode: '4x8', diffs: [0, 0, 0, 0] }, // link diff first, then flat-line diffs
    { mode: '4x8', diffs: [10, -10, 100, -100] },
    { mode: '2x16', diffs: [30000, -30000] },
    { mode: '1x32', diffs: [-2000000000] },
    { mode: '2x16', diffs: [1, -1] },
    { mode: '4x8', diffs: [127, -128, 0, 5] }
  ];
  const { record, samples } = buildRecord(-999, plan, { encoding: 10 });
  const d = S._test.decodeMiniSEED(record);
  assert.strictEqual(d.droppedRecords, 0, JSON.stringify(d.dropReasons));
  assert.deepStrictEqual(d.segments[0].counts, samples);
});

test('decodeMiniSEED: undefined Steim2 code (nib3+dn3) drops the record, never guesses', () => {
  const plan = [{ mode: '7x4', diffs: [1, 1, 1, 1, 1, 1, 1] }];
  const { record } = buildRecord(0, plan);
  // corrupt W3 (first data word): nibble 3 + dnib 3 is undefined in Steim2
  record.writeUInt32BE(((3 << 30) | 0x12345678) >>> 0, 64 + 12);
  const d = S._test.decodeMiniSEED(record);
  assert.strictEqual(d.droppedRecords, 1);
  assert.ok(d.dropReasons.includes('steim'));
  assert.strictEqual(d.segments.length, 0);
});

test('decodeMiniSEED: Xn mismatch is served with a diagnostic count (libmseed parity)', () => {
  const plan = [{ mode: '7x4', diffs: [1, 1, 1, 1, 1, 1, 1] }];
  const { record } = buildRecord(0, plan);
  record.writeInt32BE(424242, 64 + 8); // frame 0 W2 = Xn, deliberately wrong
  const d = S._test.decodeMiniSEED(record);
  assert.strictEqual(d.droppedRecords, 0);
  assert.strictEqual(d.xnMismatches, 1);
});

test('decodeMiniSEED: frozen live-truth anchor (EarthScope NGF IU.MAJO.00.BHZ 2026-09-02T12:00Z window)', () => {
  // Drift guard for future decoder edits. The full 6-record/2400-sample window
  // decoded bit-identically against ObsPy 2026-09-03 (0 mismatches, 0 dropped,
  // 0 Xn mismatches); these anchors freeze the head of the stream.
  const FROZEN = {
    first32: [899, 894, 874, 867, 858, 850, 851, 845, 837, 825, 813, 803, 803, 799,
      783, 779, 769, 757, 750, 733, 728, 722, 694, 680, 673, 644, 634, 639, 622, 611, 606, 580],
    startMs: 1788350400000.036, sps: 40
  };
  const d = S._test.decodeMiniSEED(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'waveform-majo-anchor.mseed')));
  assert.strictEqual(d.droppedRecords, 0, JSON.stringify(d.dropReasons));
  assert.strictEqual(d.xnMismatches, 0);
  const seg = d.segments[0];
  assert.strictEqual(seg.sps, FROZEN.sps);
  assert.strictEqual(seg.startMs, FROZEN.startMs);
  assert.deepStrictEqual(seg.counts.slice(0, 32), FROZEN.first32);
});

// ----------------------------------------------------------------
//  ROUTE — /api/waveform/live
// ----------------------------------------------------------------
test('route: station whitelist enforced (403), windowSec quantised to 60 s steps', async () => {
  S._test.waveformReset();
  let called = 0;
  S._test.waveformSetFetcher((url, cb) => {
    called++;
    cb(null, 200, buildRecord(1, [{ mode: '4x8', diffs: [0, 0, 0, 0] }, { mode: '7x4', diffs: [1, 1, 1, 1, 1, 1, 1] }]).record);
  });
  const r403 = await fetch(BASE_URL + '/api/waveform/live?sta=INJECTED&windowSec=600');
  assert.strictEqual(r403.status, 403);
  const r = await fetch(BASE_URL + '/api/waveform/live?sta=MAJO&windowSec=599');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.station, 'MAJO');
  assert.strictEqual(j.windowSec, 600, 'windowSec quantised to the 60 s grid');
  assert.strictEqual(j.net, 'IU');
  assert.ok(Array.isArray(j.segments) && j.segments.length === 1);
  assert.ok(j.nsamples >= 8);
  assert.ok(j.source.indexOf('earthscope') >= 0);
  S._test.waveformSetFetcher(null);
});

test('route: 30 s cache — two hits, one upstream call; upstream 204 → honest nodata wins over cache', async () => {
  S._test.waveformReset();
  let calls = 0;
  S._test.waveformSetFetcher((url, cb) => {
    calls++;
    if (calls <= 1) cb(null, 200, buildRecord(7, [{ mode: '4x8', diffs: [0, 0, 0, 0] }, { mode: '7x4', diffs: [1, -1, 1, -1, 1, -1, 1] }]).record);
    else cb(null, 204, null);
  });
  const r1 = await fetch(BASE_URL + '/api/waveform/live?sta=YSS&windowSec=600');
  const j1 = await r1.json();
  assert.strictEqual(j1.nodata, false);
  const r2 = await fetch(BASE_URL + '/api/waveform/live?sta=YSS&windowSec=600');
  const j2 = await r2.json();
  assert.strictEqual(calls, 1, 'second request served from the 30 s cache');
  assert.deepStrictEqual(j2.segments, j1.segments);
  // TTL expiry → new upstream call → 204 no-data is the CURRENT truth and wins
  S._test.waveformCache()['YSS|600'].fetchedAt = Date.now() - 31000;
  const r3 = await fetch(BASE_URL + '/api/waveform/live?sta=YSS&windowSec=600');
  const j3 = await r3.json();
  assert.strictEqual(calls, 2);
  assert.strictEqual(j3.nodata, true, '204 replaces stale cached traces — never fabricate');
  assert.strictEqual(j3.segments.length, 0);
  S._test.waveformSetFetcher(null);
});

test('route: upstream failure → stale-if-error within 10 min, 502 after', async () => {
  S._test.waveformReset();
  let calls = 0;
  S._test.waveformSetFetcher((url, cb) => {
    calls++;
    if (calls === 1) cb(null, 200, buildRecord(3, [{ mode: '4x8', diffs: [0, 0, 0, 0] }, { mode: '7x4', diffs: [2, -2, 2, -2, 2, -2, 2] }]).record);
    else cb(new Error('upstream down'), 0, null);
  });
  await fetch(BASE_URL + '/api/waveform/live?sta=TATO&windowSec=300');
  S._test.waveformCache()['TATO|300'].fetchedAt = Date.now() - 31000;
  const r2 = await fetch(BASE_URL + '/api/waveform/live?sta=TATO&windowSec=300');
  const j2 = await r2.json();
  assert.strictEqual(r2.status, 200, 'stale body served within the 10 min window');
  assert.strictEqual(j2.nodata, false);
  S._test.waveformCache()['TATO|300'].fetchedAt = Date.now() - 601000;
  const r3 = await fetch(BASE_URL + '/api/waveform/live?sta=TATO&windowSec=300');
  assert.strictEqual(r3.status, 502, 'beyond 10 min the stale body is dropped');
  S._test.waveformSetFetcher(null);
});

test('route: per-IP token bucket (20/min) throttles a varied-window sweep', async () => {
  S._test.waveformReset();
  S._test.waveformSetFetcher((url, cb) => cb(null, 204, null));
  let codes = [];
  for (let i = 0; i < 24; i++) {
    const r = await fetch(BASE_URL + '/api/waveform/live?sta=INCN&windowSec=' + (60 + i * 60));
    codes.push(r.status);
  }
  assert.strictEqual(codes[0], 200);
  assert.ok(codes.includes(429), 'rate limit engages within the sweep: ' + codes.join(','));
  S._test.waveformSetFetcher(null);
  S._test.waveformReset();
});

test('teardown', { concurrency: false }, async () => {
  await new Promise((resolve) => {
    _server.closeAllConnections ? _server.closeAllConnections() : null;
    _server.close(resolve);
  });
  // server.js keeps SSE-reconnect/kmoni timers alive past close() — force exit
  // (same pattern as tests/server.test.js teardown)
  setTimeout(() => process.exit(0), 500);
});
