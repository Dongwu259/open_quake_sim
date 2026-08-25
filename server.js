// Earthquake Simulator Server — production static file server
const http = require('http');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const net  = require('net');

function normalizeIp(value) {
  var ip = String(value || '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return net.isIP(ip) ? ip : '';
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

// Proxy-header trust can be disabled with QUAKE_TRUST_PROXY=0 when the
// process is NOT behind a same-host reverse proxy (a misconfigured proxy
// that forwards client-supplied headers would let callers choose their
// rate-limit identity).
var TRUST_PROXY_HEADERS = process.env.QUAKE_TRUST_PROXY !== '0';

// Proxy headers are authoritative only when the direct peer is this host's
// nginx. Direct clients cannot spoof rate-limit or audit identities.
function getClientIp(req) {
  var peer = normalizeIp(req && req.socket && req.socket.remoteAddress);
  if (TRUST_PROXY_HEADERS && isLoopbackIp(peer)) {
    var realIp = normalizeIp(req && req.headers && req.headers['x-real-ip']);
    if (realIp) return realIp;
    var forwarded = String(req && req.headers && req.headers['x-forwarded-for'] || '').split(',');
    // nginx appends the direct client to X-Forwarded-For; use the rightmost
    // valid address so a client-supplied leading value cannot choose its key.
    for (var i = forwarded.length - 1; i >= 0; i--) {
      var candidate = normalizeIp(forwarded[i]);
      if (candidate) return candidate;
    }
  }
  return peer || 'unknown';
}

function buildCatalogRequests(searchParams) {
  var fdsn = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  fdsn.searchParams.set('format', 'geojson');
  fdsn.searchParams.set('orderby', 'time');
  if (searchParams.has('starttime')) fdsn.searchParams.set('starttime', searchParams.get('starttime'));
  if (searchParams.has('endtime')) fdsn.searchParams.set('endtime', searchParams.get('endtime'));
  var minMag = Number(searchParams.get('minmag'));
  if (searchParams.has('minmag') && Number.isFinite(minMag)) fdsn.searchParams.set('minmagnitude', String(minMag));
  fdsn.searchParams.set('minlatitude', '22');
  fdsn.searchParams.set('maxlatitude', '48');
  fdsn.searchParams.set('minlongitude', '120');
  fdsn.searchParams.set('maxlongitude', '152');
  fdsn.searchParams.set('limit', '50');

  var live = new URL(LIVE_API_BASE + '/api/v1/earthquakes');
  live.searchParams.set('minMag', Number.isFinite(minMag) ? String(minMag) : '4');
  live.searchParams.set('hours', '720');
  live.searchParams.set('region', 'japan');
  live.searchParams.set('limit', '200');
  live.searchParams.set('order', 'desc');
  if (searchParams.has('starttime')) {
    var startMs = Date.parse(searchParams.get('starttime'));
    if (Number.isFinite(startMs)) live.searchParams.set('startTime', String(Math.floor(startMs / 1000)));
  }
  return { fdsnUrl: fdsn.toString(), liveUrl: live.toString() };
}

function buildWaveformArgs(searchParams) {
  var station = searchParams.get('station') || 'MAJO';
  var network = searchParams.get('network') || 'IU';
  var channel = searchParams.get('channel') || 'BHZ';
  var location = searchParams.has('location') ? searchParams.get('location') : '*';
  var hours = parseInt(searchParams.get('hours'), 10) || 1;
  var purpose = searchParams.get('purpose') || 'display';
  var components = searchParams.get('components') || '1';
  var duration = parseInt(searchParams.get('durationSeconds'), 10);
  var endtime = searchParams.get('endtime');
  if (!/^[A-Z0-9_]{1,5}$/.test(station) || !/^[A-Z0-9_]{1,2}$/.test(network)
      || !/^[A-Z0-9]{3}$/.test(channel) || !/^[A-Z0-9_*]{0,2}$/.test(location)
      || !/^(display|analysis)$/.test(purpose) || !/^(1|3)$/.test(components)) return null;
  if (endtime && !Number.isFinite(Date.parse(endtime))) return null;
  var args = ['--station', station, '--network', network, '--location', location || '*',
    '--channel', channel, '--hours', String(Math.min(24, Math.max(1, hours))), '--purpose', purpose];
  if (Number.isFinite(duration)) args.push('--duration-seconds', String(Math.min(3600, Math.max(60, duration))));
  if (endtime) args.push('--endtime', new Date(endtime).toISOString());
  if (components === '3') args.push('--three-component');
  return args;
}

// Security headers (manual since quake-sim uses http.createServer, not Express)
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

const PORT   = process.env.PORT || 3000;
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const SERVER_START = Date.now();
const PUBLIC = path.join(__dirname, 'public');
const SOUNDS = path.join(__dirname, 'sounds');
const TRAFFIC_FILE = path.join(__dirname, 'traffic.json');

// HTTP Keep-Alive agents for outbound connection reuse
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });
const _httpsAgent = new require('https').Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });
// TTS upstream resolution: TTS_UPSTREAM_URL env > settings.json (set from the
// in-app settings page, loopback only) > built-in default. Resolved per call so
// settings-page changes apply without a restart.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let localSettings = {};
try { localSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch(e) { localSettings = {}; }
function saveLocalSettings() { return queueJsonWrite(SETTINGS_FILE, localSettings, true); }
function currentTtsUpstream() {
  return process.env.TTS_UPSTREAM_URL || localSettings.ttsUpstreamUrl || 'http://127.0.0.1:7896/tts';
}
function ttsUpstreamSource() {
  return process.env.TTS_UPSTREAM_URL ? 'env' : (localSettings.ttsUpstreamUrl ? 'settings' : 'default');
}
// Public shape of the TTS settings — the API key is write-only and never echoed.
function ttsSettingsPayload() {
  return {
    upstream: currentTtsUpstream(),
    source: ttsUpstreamSource(),
    configurable: !process.env.TTS_UPSTREAM_URL,
    hasKey: !!localSettings.ttsApiKey,
    keyMode: localSettings.ttsApiKeyMode || 'query'
  };
}
// Base URL of the local multi-source earthquake collector proxied by
// /api/live-quakes, /api/earthquakes and /api/catalog.
const LIVE_API_BASE = process.env.LIVE_API_BASE || 'http://127.0.0.1:7891';
const TTS_MAX_TEXT_LENGTH = 300;
const TTS_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TTS_SYNTHESIS_RATE_LIMIT = 60;
const TTS_CACHE_MAX_ENTRIES = 200;
const TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TTS_CACHE_MAX_ITEM_BYTES = 2 * 1024 * 1024;
const TTS_VOICES = new Set([
  'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural', 'ja-JP-AoiNeural',
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural',
  'en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-JennyNeural',
  'ko-KR-SunHiNeural', 'ko-KR-InJoonNeural'
]);
// Serialize writes per file and replace atomically so concurrent requests or a
// process interruption cannot leave truncated JSON behind.
const _persistQueues = new Map();
function queueJsonWrite(filePath, value, pretty) {
  var serialized;
  try { serialized = JSON.stringify(value, null, pretty ? 2 : 0); }
  catch (e) { console.error('Persist serialization failed for ' + filePath + ':', e.message); return Promise.resolve(false); }
  var previous = _persistQueues.get(filePath) || Promise.resolve();
  var next = previous.catch(function() {}).then(async function() {
    var tempPath = filePath + '.' + process.pid + '.tmp';
    var handle;
    try {
      handle = await fs.promises.open(tempPath, 'w', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.promises.rename(tempPath, filePath);
      return true;
    } catch (e) {
      if (handle) { try { await handle.close(); } catch (closeErr) {} }
      try { await fs.promises.unlink(tempPath); } catch (unlinkErr) {}
      console.error('Persist write failed for ' + filePath + ':', e.message);
      return false;
    }
  });
  _persistQueues.set(filePath, next);
  next.finally(function() { if (_persistQueues.get(filePath) === next) _persistQueues.delete(filePath); });
  return next;
}
function flushPendingWrites() {
  return Promise.allSettled(Array.from(_persistQueues.values()));
}

// ---- In-memory error log (last 50 entries) ----
let errorLogs = []; // [{time, message, stack}]
function logError(message, stack) {
  errorLogs.push({ time: Date.now(), message: String(message), stack: String(stack || '').slice(0, 500) });
  if (errorLogs.length > 50) errorLogs.shift();
}

// ---- traffic stats (persisted to traffic.json) ----
let trafficStats = { bytesUp: 0, bytesDown: 0, requests: 0, uptimeSeconds: 0 };
let _uptimeCheckpoint = Date.now();
try {
  if (fs.existsSync(TRAFFIC_FILE)) {
    var ts = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
    trafficStats.bytesUp = ts.bytesUp || 0;
    trafficStats.bytesDown = ts.bytesDown || 0;
    trafficStats.requests = ts.requests || 0;
    trafficStats.uptimeSeconds = Number.isFinite(ts.uptimeSeconds) && ts.uptimeSeconds > 0 ? Math.floor(ts.uptimeSeconds) : 0;
  }
} catch(e) { logError('traffic.json load failed: ' + e.message); }
console.log('Traffic loaded: ' + (trafficStats.bytesDown/1024/1024).toFixed(1) + ' MB down, ' + trafficStats.requests + ' requests');

function saveTraffic() {
  return queueJsonWrite(TRAFFIC_FILE, trafficStats);
}
function checkpointUptime() {
  var now = Date.now();
  var elapsedSeconds = Math.floor((now - _uptimeCheckpoint) / 1000);
  if (elapsedSeconds > 0) {
    trafficStats.uptimeSeconds += elapsedSeconds;
    _uptimeCheckpoint += elapsedSeconds * 1000;
  }
  return trafficStats.uptimeSeconds;
}
function totalUptimeSeconds() {
  var accumulated = trafficStats.uptimeSeconds + Math.floor((Date.now() - _uptimeCheckpoint) / 1000);
  return Math.max(accumulated, Math.floor((Date.now() - SERVER_START) / 1000));
}
// Periodic save every 60s (traffic + rate limits)
var _trafficSaveTimer = setInterval(function() { checkpointUptime(); saveTraffic(); saveRateLimits(); }, 60000);

// Periodic cleanup: purge rate limit entries older than 1 hour
var _rateLimitCleanupTimer = setInterval(function() {
  var cutoff = Date.now() - 3600000;
  [ _ttsRateLimit, _ttsSynthesisRateLimit, _testRateLimit, _wfRateLimit, _exportRateLimit ].forEach(function(store) {
    if (!store) return;
    for (var ip in store) {
      if (Array.isArray(store[ip])) {
        store[ip] = store[ip].filter(function(t) { return t > cutoff; });
        if (store[ip].length === 0) delete store[ip];
      } else if (typeof store[ip] === 'number' && store[ip] < cutoff) {
        delete store[ip];
      }
    }
  });
}, 600000); // every 10 minutes

loadRateLimits(); // restore rate limit state from disk

var _ttsRateLimit = {};    // {ip: [timestamp, ...]} — rate limit state for TTS bulletin
var _ttsSynthesisRateLimit = {}; // independent limiter for dynamic neural TTS
var _ttsAudioCache = new Map();  // voice+'\n'+text -> Buffer, LRU via delete+set
var _ttsAudioCacheBytes = 0;
var _testRateLimit = {};   // {ip: [timestamp, ...]} — rate limit state for test endpoint
var _settingsRateLimit = null;
var _wfRateLimit = {};     // {ip: [timestamp, ...]} — rate limit state for waveform fetch
var _exportRateLimit = {}; // {ip: [timestamp, ...]} — rate limit state for replay export
var _rateLimitPersist = process.env.RATELIMIT_PERSIST !== 'false'; // default true (persist to disk)
var RATELIMIT_FILE = path.join(__dirname, 'ratelimit.json');

// ---- Rate limit persistence ----
function loadRateLimits() {
  if (!_rateLimitPersist) return;
  try {
    if (fs.existsSync(RATELIMIT_FILE)) {
      var data = JSON.parse(fs.readFileSync(RATELIMIT_FILE, 'utf8'));
      var now = Date.now();
      // Restore TTS rate limits, filtering expired entries
      if (data.tts) {
        for (var ip in data.tts) {
          var timestamps = (data.tts[ip] || []).filter(function(t) { return now - t < 60000; });
          if (timestamps.length > 0) _ttsRateLimit[ip] = timestamps;
        }
      }
    }
  } catch(e) { /* ignore corrupted file */ }
}

function saveRateLimits() {
  if (!_rateLimitPersist) return;
  try {
    // Only save if there's data to persist (avoid writing empty files)
    var ttsKeys = Object.keys(_ttsRateLimit);
    if (ttsKeys.length === 0) return;
    fs.writeFileSync(RATELIMIT_FILE, JSON.stringify({
      tts: _ttsRateLimit
    }));
  } catch(e) { /* ignore write errors */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.geojson': 'application/json; charset=utf-8',
};

// ---- cache policy by file type ----
function cacheHeader(ext) {
  if (ext === '.html') return 'no-cache, must-revalidate';
  if (ext === '.js' || ext === '.css') return 'public, max-age=31536000, immutable';  // ?v=hash guarantees uniqueness
  if (ext === '.json' || ext === '.geojson') return 'public, max-age=3600';
  return 'public, max-age=86400';  // images, audio, fonts
}

// ---- security headers ----
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cyberjapandata.gsi.go.jp; connect-src 'self' https://earthquake.usgs.gov wss://api.p2pquake.net https://weather-kyoshin.east.edge.storage-yahoo.jp; font-src 'self'; object-src 'none'; base-uri 'self'",
};
// HSTS: only on HTTPS (RFC 6797 §7.2 — HTTP must be ignored by UAs)
var _hstsHeader = 'max-age=31536000; includeSubDomains';

// ---- Standardized API error helper ----
// Error codes: INVALID_JSON, INVALID_PARAM, MISSING_PARAM, UNAUTHORIZED,
//   API_KEY_REQUIRED, FORBIDDEN, NOT_FOUND, PAYLOAD_TOO_LARGE,
//   RATE_LIMITED, INTERNAL_ERROR, UPSTREAM_ERROR, SERVICE_UNAVAILABLE
function sendError(res, code, errorCode, message, details) {
  var body = JSON.stringify({
    error: { code: errorCode, message: message, details: details || null }
  });
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

// ---- CORS support ----
var CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
function setCORS(res, req) {
  if (CORS_ORIGINS.length === 0) return; // CORS disabled by default
  var origin = req.headers.origin || '';
  if (CORS_ORIGINS[0] === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (CORS_ORIGINS.some(function(o) { return o === origin; })) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    return; // origin not allowed — don't add CORS headers
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ---- v4.2: gzip cache for static files (avoids re-compressing large JSON on every request) ----
var _gzipCache = new Map(); // filePath → {gzBuf, mtimeMs}
var _GZIP_CACHE_MAX = 20;   // max cached files (LRU eviction via Map insertion order)

function tryGzip(res, data, cacheKey, mtimeMs, fileSize) {
  return new Promise((resolve) => {
    // Check cache if cacheKey provided (static file path)
    if (cacheKey) {
      var cached = _gzipCache.get(cacheKey);
      if (cached && cached.mtimeMs === mtimeMs && cached.fileSize === fileSize) {
        _gzipCache.delete(cacheKey);
        _gzipCache.set(cacheKey, cached);
        return resolve({ body: cached.gzBuf, gzip: true });
      }
      if (cached) _gzipCache.delete(cacheKey);
    }
    const raw = Buffer.from(data);
    zlib.gzip(raw, (err, gz) => {
      if (err || !gz || gz.length >= raw.length * 0.9) return resolve({ body: raw, gzip: false });
      // Cache if key provided (static files only)
      if (cacheKey) {
        if (_gzipCache.size >= _GZIP_CACHE_MAX) {
          // Evict oldest entry (first inserted key)
          var firstKey = _gzipCache.keys().next().value;
          _gzipCache.delete(firstKey);
        }
        _gzipCache.set(cacheKey, { gzBuf: gz, mtimeMs: mtimeMs, fileSize: fileSize });
      }
      resolve({ body: gz, gzip: true });
    });
  });
}

// v4.2: Clear gzip cache (e.g. if file updated)
function clearGzipCache(filePath) {
  if (filePath) _gzipCache.delete(filePath);
  else _gzipCache.clear();
}

async function serveFile(req, res, filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) return false;
    const ext  = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    // manifest.json: spec-correct MIME; sw.js: no-cache so SW updates land fast.
    const isManifest = base === 'manifest.json';
    const isServiceWorker = base === 'sw.js';
    let finalMime = isManifest ? 'application/manifest+json; charset=utf-8' : mime;
    const finalCache = isServiceWorker ? 'no-cache, must-revalidate' : cacheHeader(ext);

    // Only compress text-based files > 2 KB
    const compressible = ['.html','.css','.js','.json','.geojson','.svg'].includes(ext);
    let body, gzip;
    const cached = compressible && stat.size > 2048 ? _gzipCache.get(filePath) : null;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.fileSize === stat.size) {
      // Avoid reading large static JSON/JS files again once their compressed
      // representation is cached. Refresh insertion order to keep true LRU.
      _gzipCache.delete(filePath);
      _gzipCache.set(filePath, cached);
      body = cached.gzBuf;
      gzip = true;
    } else {
      if (cached) _gzipCache.delete(filePath);
      const data = await fs.promises.readFile(filePath);
      const encoded = compressible && stat.size > 2048
        ? await tryGzip(res, data, filePath, stat.mtimeMs, stat.size)
        : { body: data, gzip: false };
      body = encoded.body;
      gzip = encoded.gzip;
    }

    // Several legacy assets contain MPEG frames despite their .wav suffix.
    // Sniffing keeps HTMLAudio fallbacks interoperable while the library is migrated.
    if (ext === '.wav' && body.length >= 2 && body[0] === 0xff && (body[1] & 0xe0) === 0xe0) {
      finalMime = 'audio/mpeg';
    }

    let statusCode = 200;
    let contentRange = null;
    if ((ext === '.wav' || ext === '.mp3') && req && req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
      let start = 0;
      let end = body.length - 1;
      if (match && (match[1] || match[2])) {
        if (!match[1]) {
          const suffixLength = Number(match[2]);
          start = Math.max(0, body.length - suffixLength);
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
      }
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}`, ...SECURITY_HEADERS });
        res.end();
        return true;
      }
      const totalLength = body.length;
      body = body.subarray(start, end + 1);
      statusCode = 206;
      contentRange = `bytes ${start}-${end}/${totalLength}`;
    }

    const headers = {
      'Content-Type':   finalMime,
      'Content-Length': body.length,
      'Cache-Control':  finalCache,
      ...SECURITY_HEADERS,
    };
    if (isServiceWorker) headers['Service-Worker-Allowed'] = '/';
    if (gzip) headers['Content-Encoding'] = 'gzip';
    if (ext === '.wav' || ext === '.mp3') headers['Accept-Ranges'] = 'bytes';
    if (contentRange) headers['Content-Range'] = contentRange;

    res.writeHead(statusCode, headers);
    res.end(body);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    console.error('serveFile error:', e.message);
    return false;
  }
}

// ---- USGS earthquake proxy (cached) ----
let usgsCache = null, usgsCacheTime = 0;
let _catalogCache = null; // {url, data, time}
// ---- Live earthquake API proxy (local eq-collector, cached) ----
let _liveQuakeCache = null, _liveQuakeCacheTime = 0;
const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';

// Shared HTTP GET helper with keep-alive + timeout
function _httpGet(url, cb, timeoutMs) {
  var isHttps = url.startsWith('https');
  var proto = isHttps ? require('https') : require('http');
  var agent = isHttps ? _httpsAgent : _httpAgent;
  var called = false;
  function guard(err, body, statusCode) {
    if (called) return;
    called = true;
    cb(err, body, statusCode);
  }
  var req = proto.get(url, { headers: { 'User-Agent': 'QuakeSim/5.6' }, agent: agent }, function(resp) {
    var body = '';
    resp.on('data', function(c) { body += c; if (body.length > 2097152) { req.destroy(); guard(new Error('Response too large')); } });
    resp.on('end', function() { req.setTimeout(0); guard(null, body, resp.statusCode); });
  });
  req.on('error', function(err) { guard(err); });
  req.setTimeout(timeoutMs || 10000, function() { req.destroy(); guard(new Error('Request timeout')); });
}

function serveUSGS(res) {
  var now = Date.now();
  if (usgsCache && now - usgsCacheTime < 30000) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(usgsCache);
  }

  var merged = { type: 'FeatureCollection', features: [], metadata: { sources: ['USGS'] } };
  var completed = 0;
  var seenIds = {}; // Dedup across sources

  function tryFinish() {
    completed++;
    if (completed < 2) return;
    if (!merged.features.length && usgsCache) {
      try { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(usgsCache); }
      catch(e) { /* fall through */ }
    }
    var result = JSON.stringify(merged);
    usgsCache = result; usgsCacheTime = now;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(result);
  }

  // Fetch USGS
  _httpGet(USGS_URL, function(err, data, statusCode) {
    if (!err && statusCode === 200) {
      try {
        var usgs = JSON.parse(data);
        if (usgs && usgs.features) {
          for (var i = 0; i < usgs.features.length; i++) {
            var f = usgs.features[i];
            var c = f.geometry && f.geometry.coordinates;
            if (!c) continue;
            // Generate a simple location+time key for dedup
            var key = Math.round(c[0]*100)/100 + '|' + Math.round(c[1]*100)/100 + '|' + Math.round((f.properties.time || 0)/60000);
            seenIds[key] = true;
            f.properties = f.properties || {};
            f.properties.source = 'USGS';
            merged.features.push(f);
          }
        }
      } catch(e) { /* parse error — continue */ }
    }
    tryFinish();
  }, 10000);

  // Fetch live multi-source API and inject non-USGS events
  var lqUrl = LIVE_API_BASE + '/api/v1/earthquakes?minMag=3&hours=72&region=japan&limit=100&order=desc';
  _httpGet(lqUrl, function(err, data, statusCode) {
    var hasLive = false;
    if (!err && statusCode === 200) {
      try {
        var lqData = JSON.parse(data);
        if (lqData && lqData.ok && lqData.data) {
          var allSources = {};
          for (var i = 0; i < lqData.data.length; i++) {
            var eq = lqData.data[i];
            var sources = (eq.sources || []).map(function(s){ return s.source; });
            // Collect all sources for metadata
            for (var k = 0; k < sources.length; k++) { allSources[sources[k]] = true; }
            // Skip USGS-covered events (source-based dedup)
            if (sources.indexOf('usgs') >= 0) continue;
            // Also dedup by location+time proximity
            var lqKey = Math.round(eq.lng*100)/100 + '|' + Math.round(eq.lat*100)/100 + '|' + Math.round((eq.time || 0)/60);
            if (seenIds[lqKey]) continue;
            seenIds[lqKey] = true;

            var feature = {
              type: 'Feature',
              id: 'live-' + eq.id,
              geometry: { type: 'Point', coordinates: [eq.lng, eq.lat, eq.depth || 30] },
              properties: {
                mag: eq.mag, place: eq.place || '', time: (eq.time || 0) * 1000,
                source: sources.length > 0 ? sources[0].toUpperCase() : 'Live',
                sources: sources, tsunami: eq.tsunami || 0, region: eq.region || '', depth: eq.depth || 30
              }
            };
            merged.features.push(feature);
            hasLive = true;
          }
          merged.metadata.sources = Object.keys(allSources);
        }
        // Share cache: refresh standalone live-quakes cache too
        if (hasLive && lqData && lqData.ok) {
          _liveQuakeCache = { url: 'catalog:share', body: JSON.stringify({ok:true, data:lqData.data, pagination:lqData.pagination}) };
          _liveQuakeCacheTime = now;
        }
      } catch(e) { /* parse error — continue with USGS */ }
    }
    tryFinish();
  }, 10000);
}

// ---- routes ----
const server = http.createServer((req, res) => {
  setSecurityHeaders(res);
  trafficStats.requests++;
  // Track request body bytes for upload stats
  req.on('data', function(chunk) { trafficStats.bytesUp += chunk.length; });
  var _reqIp = getClientIp(req);
  // Track bytes sent via wrapper on res.end
  // Defer writeHead so we can add Content-Encoding in res.end (gzip)
  var _origEnd = res.end;
  var _origWrite = res.write;
  var _origWriteHead = res.writeHead;
  var _resHeaders = {};
  var _resStatusCode = 200;
  var _headersFlushed = false;
  function _flushHeaders() {
    if (!_headersFlushed) {
      _headersFlushed = true;
      _origWriteHead.call(res, _resStatusCode, _resHeaders);
    }
  }
  res.writeHead = function(statusCode, headers) {
    _resStatusCode = statusCode;
    if (headers) for (var hk in headers) _resHeaders[hk.toLowerCase()] = headers[hk];
    // Defer — don't call _origWriteHead yet.  We need to decide on
    // Content-Encoding (gzip) in res.end, and that's too late if we
    // flush now.  SSE / streaming handlers trigger the deferred flush
    // on the first res.write.
    return res;
  };
  res.write = function(chunk) {
    _flushHeaders();
    if (chunk) trafficStats.bytesDown += (typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length);
    return _origWrite.apply(res, arguments);
  };
  res.end = function(chunk) {
    var data = chunk;
    // gzip compress API JSON responses > 1KB
    var ct = _resHeaders['content-type'] || '';
    var ce = _resHeaders['content-encoding'] || '';
    var isSSE = ct.indexOf('text/event-stream') >= 0;
    if (!isSSE && !ce && ct.indexOf('application/json') >= 0 && data && typeof data === 'string' && data.length > 1024) {
      var acceptEnc = (req.headers['accept-encoding'] || '').toLowerCase();
      if (acceptEnc.indexOf('gzip') >= 0) {
        try {
          var raw = Buffer.from(data, 'utf8');
          var gz = zlib.gzipSync(raw);
          if (gz.length < raw.length * 0.9) {
            _resHeaders['content-encoding'] = 'gzip';
            _flushHeaders();
            trafficStats.bytesDown += gz.length;
            return _origEnd.call(res, gz);
          }
        } catch(e) { /* fall through to uncompressed */ }
      }
    }
    // Uncompressed / fallthrough path
    if (data && typeof data === 'string') trafficStats.bytesDown += Buffer.byteLength(data);
    else if (data) trafficStats.bytesDown += data.length;
    _flushHeaders();
    return _origEnd.apply(res, arguments);
  };
  const url = new URL(req.url, 'http://localhost');
  // security: prevent directory traversal — check raw pathname BEFORE decode
  let rawPath = url.pathname;
  if (rawPath.includes('..') || /%2[eE]%2[eE]/i.test(rawPath)) {
    logError('Directory traversal blocked (raw): ' + _reqIp + ' ' + rawPath);
    sendError(res, 403, 'FORBIDDEN', 'Directory traversal blocked'); return;
  }
  let reqPath;
  try {
    reqPath = decodeURIComponent(rawPath);
  } catch(e) {
    sendError(res, 400, 'INVALID_PARAM', 'Malformed URL encoding'); return;
  }
  if (reqPath.includes('..')) { logError('Directory traversal blocked (decoded): ' + _reqIp + ' ' + reqPath); sendError(res, 403, 'FORBIDDEN', 'Directory traversal blocked'); return; }

  // ---- API version prefix normalization: /api/v1/xxx → /api/xxx ----
  if (reqPath.startsWith('/api/v1/')) {
    reqPath = '/api/' + reqPath.slice('/api/v1/'.length);
  }

  // ---- OPTIONS preflight (CORS) ----
  if (req.method === 'OPTIONS' && reqPath.startsWith('/api/')) {
    setCORS(res, req);
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- Add CORS headers to all API responses (when enabled) ----
  if (reqPath.startsWith('/api/')) {
    setCORS(res, req);
  }

  // route /sounds/ to sounds directory
  let filePath;
  if (reqPath.startsWith('/sounds/')) {
    filePath = path.join(SOUNDS, reqPath.slice('/sounds/'.length));
  } else {
    filePath = path.join(PUBLIC, reqPath === '/' ? 'index.html' : reqPath);
  }
  filePath = path.normalize(filePath);
  // defense-in-depth: verify normalized path stays within allowed dirs.
  // The separator matters — without it a sibling like <public>X would pass
  // a plain startsWith(PUBLIC) check.
  function _insideDir(fp, dir) { return fp === dir || fp.startsWith(dir + path.sep); }
  if (!_insideDir(filePath, PUBLIC) && !_insideDir(filePath, SOUNDS)) {
    logError('Path escape blocked: ' + _reqIp + ' ' + reqPath);
    sendError(res, 403, 'FORBIDDEN', 'Path escape blocked'); return;
  }

  // Test endpoint: inject fake earthquake for auto-sim testing
  if (reqPath === '/api/test/earthquake' && req.method === 'POST') {
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      sendError(res, 403, 'FORBIDDEN', 'Loopback only');
      return;
    }
    // Rate limit: 10 req/min per IP
    var testIp = _reqIp;
    if (!_testRateLimit) _testRateLimit = {};
    if (!_testRateLimit[testIp]) _testRateLimit[testIp] = [];
    var testNow = Date.now();
    _testRateLimit[testIp] = _testRateLimit[testIp].filter(function(t) { return testNow - t < 60000; });
    if (_testRateLimit[testIp].length >= 10) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Max 10 per minute.');
      return;
    }
    _testRateLimit[testIp].push(testNow);
    let body = '', bodyLen = 0;
    req.on('data', chunk => { bodyLen += chunk.length; if (bodyLen <= 65536) body += chunk; });
    req.on('end', () => {
      if (bodyLen > 65536) {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large (max 64KB)');
        return;
      }
      try {
        const evt = JSON.parse(body);
        // Validate numeric fields
        if (evt.mag !== undefined && (typeof evt.mag !== 'number' || evt.mag < -2 || evt.mag > 12)) throw new Error('Invalid mag');
        if (evt.lat !== undefined && (typeof evt.lat !== 'number' || evt.lat < -90 || evt.lat > 90)) throw new Error('Invalid lat');
        if (evt.lng !== undefined && (typeof evt.lng !== 'number' || evt.lng < -180 || evt.lng > 180)) throw new Error('Invalid lng');
        if (evt.depth !== undefined && (typeof evt.depth !== 'number' || evt.depth < 0 || evt.depth > 1000)) throw new Error('Invalid depth');
        broadcastSSE({ type: 'p2pquake', event: normalizeP2PEvent({
          code: evt.code || 5611,
          time: evt.time || new Date().toISOString(),
          earthquake: {
            hypocenter: { name: String(evt.place || 'Test').slice(0, 200), latitude: evt.lat || 35, longitude: evt.lng || 140, depth: evt.depth || 30 },
            magnitude: { value: evt.mag || 5.0, type: 'Mj' },
            intensity: { maxScale: evt.intensity || 40, maxInt: String(evt.shindo || '4').slice(0, 20) }
          },
          issue: { serial: evt.serial || 1 }
        }) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Event broadcast to ' + sseClients.length + ' clients' }));
      } catch(e) {
        sendError(res, 400, 'INVALID_PARAM', e.message);
      }
    });
    return;
  }

  // Test EEW injection: POST /api/test/eew — broadcasts a raw Wolfx-shaped
  // jma_eew frame so rt-eew.js can be exercised without a live EEW.
  if (reqPath === '/api/test/eew' && req.method === 'POST') {
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      sendError(res, 403, 'FORBIDDEN', 'Loopback only');
      return;
    }
    if (!_testRateLimit) _testRateLimit = {};
    if (!_testRateLimit[_reqIp]) _testRateLimit[_reqIp] = [];
    var eewNow = Date.now();
    _testRateLimit[_reqIp] = _testRateLimit[_reqIp].filter(function(t) { return eewNow - t < 60000; });
    if (_testRateLimit[_reqIp].length >= 10) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Max 10 per minute.');
      return;
    }
    _testRateLimit[_reqIp].push(eewNow);
    let eewBody = '', eewLen = 0;
    req.on('data', chunk => { eewLen += chunk.length; if (eewLen <= 65536) eewBody += chunk; });
    req.on('end', () => {
      if (eewLen > 65536) { sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large (max 64KB)'); return; }
      try {
        const p = JSON.parse(eewBody || '{}');
        if (p.lat !== undefined && (typeof p.lat !== 'number' || p.lat < -90 || p.lat > 90)) throw new Error('Invalid lat');
        if (p.lng !== undefined && (typeof p.lng !== 'number' || p.lng < -180 || p.lng > 180)) throw new Error('Invalid lng');
        if (p.mag !== undefined && (typeof p.mag !== 'number' || p.mag < -2 || p.mag > 12)) throw new Error('Invalid mag');
        const nowJst = new Date(Date.now() + 9 * 3600e3);
        const jst = nowJst.toISOString().slice(0, 23).replace('T', ' ').replace(/-/g, '/');
        const originJst = p.originTime || jst;
        const msg = {
          type: 'jma_eew',
          Title: p.isWarn ? '緊急地震速報（警報）' : '緊急地震速報（予報）',
          Issue: { Source: '気象庁', Status: '試験' },
          EventID: String(p.eventId || ('TEST' + Date.now())).slice(0, 40),
          Serial: p.serial || 1,
          AnnouncedTime: jst,
          OriginTime: originJst,
          Hypocenter: String(p.place || 'テスト震源地').slice(0, 100),
          Latitude: p.lat != null ? p.lat : 34.7,
          Longitude: p.lng != null ? p.lng : 139.5,
          Magunitude: p.mag != null ? p.mag : 6.5,
          Depth: p.depth != null ? p.depth : 20,
          MaxIntensity: { From: p.maxInt || '4', To: p.maxInt || '4' },
          Accuracy: { Epicenter: '試験', Depth: '試験', Magnitude: '試験' },
          MaxIntChange: { String: '', Reason: '0' },
          WarnArea: Array.isArray(p.warnAreas) ? p.warnAreas.slice(0, 50) : [],
          isSea: !!p.isSea,
          isTraining: p.isTraining !== false,
          isAssumption: !!p.isAssumption,
          isWarn: !!p.isWarn,
          isFinal: !!p.isFinal,
          isCancel: !!p.isCancel,
          OriginalText: ''
        };
        broadcastSSE({ type: 'wolfx_eew', event: msg });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'EEW broadcast to ' + sseClients.length + ' clients', eventId: msg.EventID, serial: msg.Serial }));
      } catch(e) {
        sendError(res, 400, 'INVALID_PARAM', e.message);
      }
    });
    return;
  }

  // USGS earthquake proxy (cached 30s)
  if (reqPath === '/api/earthquakes') {
    serveUSGS(res);
    return;
  }

  // USGS FDSN catalog query proxy (cached 60s)
  if (reqPath.startsWith('/api/catalog')) {
    var params = url.searchParams;
    var catalogRequests = buildCatalogRequests(params);
    var fdsnUrl = catalogRequests.fdsnUrl;
    var now2 = Date.now();
    if (_catalogCache && _catalogCache.url === fdsnUrl && (now2 - _catalogCache.time) < 60000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' });
      res.end(_catalogCache.data);
      return;
    }
    // v4.1: use shared _httpGet with Keep-Alive + timeout + merge with live API
    _httpGet(fdsnUrl, function(err, usgsBody, statusCode) {
      var merged = { type: 'FeatureCollection', features: [], metadata: { sources: ['USGS'] } };
      if (!err && statusCode === 200) {
        try {
          var usgs = JSON.parse(usgsBody);
          if (usgs && usgs.features) {
            for (var i = 0; i < usgs.features.length; i++) {
              var f = usgs.features[i];
              f.properties = f.properties || {};
              f.properties.source = 'USGS';
              merged.features.push(f);
            }
          }
        } catch(e) {}
      }
      // Merge live API data (historical coverage from multi-source API)
      var lqUrl = catalogRequests.liveUrl;
      _httpGet(lqUrl, function(err2, lqBody, lqCode) {
        if (!err2 && lqCode === 200) {
          try {
            var lqData = JSON.parse(lqBody);
            if (lqData && lqData.ok && lqData.data) {
              var allSources = {};
              for (var j = 0; j < lqData.data.length; j++) {
                var eq = lqData.data[j];
                var sources = (eq.sources || []).map(function(s){return s.source;});
                if (sources.indexOf('usgs') >= 0) continue;
                for (var k = 0; k < sources.length; k++) allSources[sources[k]] = true;
                merged.features.push({
                  type: 'Feature', id: 'live-' + eq.id,
                  geometry: { type: 'Point', coordinates: [eq.lng, eq.lat, eq.depth || 30] },
                  properties: { mag: eq.mag, place: eq.place || '', time: (eq.time||0)*1000,
                    source: sources.length > 0 ? sources[0].toUpperCase() : 'Live',
                    sources: sources, depth: eq.depth || 30 }
                });
              }
              merged.metadata.sources = Object.keys(allSources);
            }
          } catch(e) {}
        }
        var result = JSON.stringify(merged);
        _catalogCache = { url: fdsnUrl, data: result, time: now2 };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' });
        res.end(result);
      }, 10000);
    }, 10000);
    return;
  }

  // Waveform data from FDSN (via ObsPy Python script)
  if (reqPath.startsWith('/api/waveform')) {
    // Rate limit: 5 req/min per IP (spawns Python subprocess)
    var wfIp = _reqIp;
    if (!_wfRateLimit) _wfRateLimit = {};
    if (!_wfRateLimit[wfIp]) _wfRateLimit[wfIp] = [];
    var wfNow = Date.now();
    _wfRateLimit[wfIp] = _wfRateLimit[wfIp].filter(function(t) { return wfNow - t < 60000; });
    if (_wfRateLimit[wfIp].length >= 5) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many waveform requests. Max 5 per minute.');
      return;
    }
    _wfRateLimit[wfIp].push(wfNow);
    const args = buildWaveformArgs(url.searchParams);
    if (!args) {
      sendError(res, 400, 'INVALID_PARAM', 'Invalid station/network/channel parameters');
      return;
    }
    const { execFile } = require('child_process');
    const script = require('path').join(__dirname, 'tools', 'fetch_waveform.py');
    execFile(PYTHON_BIN, [script, ...args], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { sendError(res, 502, 'UPSTREAM_ERROR', 'Waveform fetch failed'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
        res.end(stdout.trim() || '{}');
      }
    );
    return;
  }

  // P2PQuake SSE stream
  if (reqPath === '/api/p2pquake/stream') {
    if (sseClients.length >= 200) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Too many SSE clients (max 200)'); return;
    }
    // Per-IP cap: one visitor may hold at most 6 live streams
    var sseIp = _reqIp;
    if ((_sseClientIps[sseIp] || 0) >= 6) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many connections' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Tell nginx/varnish not to buffer SSE — without this a proxy can hold
      // kmoni_rt/EEW frames for seconds or until the connection closes
      'X-Accel-Buffering': 'no'
    });
    sseClients.push(res);
    _sseClientIps[sseIp] = (_sseClientIps[sseIp] || 0) + 1;
    // res 'close' = connection teardown. (req 'close' fires as soon as the
    // request message is complete on Node >= 16 — far too early for SSE.)
    res.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx >= 0) sseClients.splice(idx, 1);
      _decIpCount(_sseClientIps, sseIp);
    });
    return;
  }

  // Replay info: recorder ring stats + on-disk recording size
  if (reqPath === '/api/replay/info') {
    // 10 s memo — the events scan walks the ~20k-frame ring plus gzip files
    var riNow = Date.now();
    if (!_replayInfoCache || riNow - _replayInfoCache.at >= 10000) {
      _replayInfoCache = { at: riNow, payload: JSON.stringify(_replayInfo()) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(_replayInfoCache.payload);
    return;
  }

  // Replay stream: per-client SSE replay of recorded frames. Replay frames go
  // straight to this response — never through broadcastSSE (the live hub).
  if (reqPath === '/api/replay/stream') {
    if (_replayClients.length >= REPLAY_MAX_CLIENTS) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Too many replay clients (max ' + REPLAY_MAX_CLIENTS + ')'); return;
    }
    // Per-IP cap: one visitor may hold at most 2 replay streams
    var replayIp = _reqIp;
    if ((_replayClientIps[replayIp] || 0) >= 2) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many connections' }));
      return;
    }
    var _rSpeed = parseFloat(url.searchParams.get('speed'));
    if (!Number.isFinite(_rSpeed)) _rSpeed = 5;
    _rSpeed = Math.min(120, Math.max(0.25, _rSpeed));
    var _rFrom = parseInt(url.searchParams.get('from'), 10);
    var _rFrames = _replaySnapshot();
    if (!Number.isFinite(_rFrom)) _rFrom = _rFrames.length ? _rFrames[0].t : 0;
    _rFrames = _rFrames.filter(function(f) { return f.t >= _rFrom; });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Same proxy anti-buffering hint as the live stream
      'X-Accel-Buffering': 'no'
    });
    _replayClients.push(res);
    _replayClientIps[replayIp] = (_replayClientIps[replayIp] || 0) + 1;
    res.on('close', () => {
      const idx = _replayClients.indexOf(res);
      if (idx >= 0) _replayClients.splice(idx, 1);
      _decIpCount(_replayClientIps, replayIp);
    });
    var _rIdx = 0;
    function emitReplayFrame() {
      if (res.destroyed || res.writableEnded) return;
      if (_rIdx >= _rFrames.length) {
        try { res.write('event: replay_end\ndata: {}\n\n'); } catch(e) {}
        try { res.end(); } catch(e) {}
        return;
      }
      var frame = _rFrames[_rIdx];
      var frameBody = JSON.stringify({ type: frame.type, event: frame.event, replayTs: frame.t });
      // Same named-event guard as the live hub: type must stay a single line
      var frameMsg = (typeof frame.type === 'string' && frame.type !== '' && frame.type.indexOf('\n') < 0 && frame.type.indexOf('\r') < 0)
        ? 'event: ' + frame.type + '\ndata: ' + frameBody + '\n\n'
        : 'data: ' + frameBody + '\n\n';
      // Backpressure: a slow client used to make res.write buffer the whole
      // replay window in memory — wait for drain before scheduling the next
      // frame (exactly one continuation is ever pending).
      var writable = true;
      try { writable = res.write(frameMsg); } catch(e) { try { res.end(); } catch(e2) {} return; }
      _rIdx++;
      var wait = 0;
      if (_rIdx < _rFrames.length) wait = Math.min(2000, Math.max(0, (_rFrames[_rIdx].t - frame.t) / _rSpeed));
      if (writable) {
        setTimeout(emitReplayFrame, wait);
      } else {
        res.once('drain', function() { setTimeout(emitReplayFrame, wait); });
      }
    }
    emitReplayFrame();
    return;
  }

  // Replay export: recorded frames for a time window as downloadable JSONL.
  // Sources: the live ring for the recent tail, daily gzip files for
  // anything older. Windows clamp to the available recording range; empty
  // windows answer 204; windows over 6 hours are rejected.
  if (reqPath === '/api/replay/export') {
    var eFromStr = url.searchParams.get('from');
    var eToStr = url.searchParams.get('to');
    var eFrom = (eFromStr == null || eFromStr === '') ? NaN : Number(eFromStr);
    var eTo = (eToStr == null || eToStr === '') ? NaN : Number(eToStr);
    if (!Number.isFinite(eFrom) || !Number.isFinite(eTo)) { sendError(res, 400, 'INVALID_PARAM', 'from and to (epoch ms) are required'); return; }
    eFrom = Math.floor(eFrom); eTo = Math.floor(eTo);
    if (eTo < eFrom) { sendError(res, 400, 'INVALID_PARAM', 'to must be >= from'); return; }
    if (eTo - eFrom > REPLAY_EXPORT_MAX_MS) { sendError(res, 400, 'INVALID_PARAM', 'window too large (max 6 hours)'); return; }
    // Rate limit: 10 req/min per IP — each export gunzips daily recording files
    if (!_exportRateLimit[_reqIp]) _exportRateLimit[_reqIp] = [];
    var exNow = Date.now();
    _exportRateLimit[_reqIp] = _exportRateLimit[_reqIp].filter(function(t) { return exNow - t < 60000; });
    if (_exportRateLimit[_reqIp].length >= 10) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Max 10 per minute.');
      return;
    }
    _exportRateLimit[_reqIp].push(exNow);
    var eAvail = _replayExportRange();
    if (!eAvail) { res.writeHead(204); res.end(); return; }
    var effFrom = Math.max(eFrom, eAvail.earliest);
    var effTo = Math.min(eTo, eAvail.latest);
    if (effTo < effFrom) { res.writeHead(204); res.end(); return; }
    // Single pass: stream batches as they are read (chunked — no pre-count,
    // no Content-Length). The 200 header goes out with the first batch, so a
    // window that turns out empty still answers 204.
    (async function() {
      try {
        var wrote = false, aborted = false;
        res.on('close', function() { aborted = true; });
        await _replayForEachExportBatch(effFrom, effTo, async function(batch) {
          if (aborted) return;
          if (!wrote) {
            wrote = true;
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson',
              'Content-Disposition': 'attachment; filename="quake-replay-' + effFrom + '-' + effTo + '.jsonl"',
              'Cache-Control': 'no-cache'
            });
          }
          if (!res.write(batch.join('\n') + '\n')) {
            // Resolve on drain OR disconnect — a closed client never drains
            // and the promise used to hang forever.
            await new Promise(function(resolve) {
              res.once('drain', resolve);
              res.once('close', resolve);
              res.once('error', resolve);
            });
          }
        });
        if (aborted) return;
        if (!wrote) { res.writeHead(204); res.end(); return; }
        res.end();
      } catch(e) { try { res.end(); } catch(e2) {} }
    })();
    return;
  }

  // NIED Kmoni sitelist proxy (強震モニタ station list, upstream cached 1h)
  if (reqPath === '/api/kmoni/sitelist') {
    var kmoniNow = Date.now();
    if (_kmoniSitelistCache && kmoniNow - _kmoniSitelistCache.fetchedAt < 3600000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
      res.end(_kmoniSitelistCache.body);
      return;
    }
    _kmoniSitelistPending.push(res);
    if (_kmoniSitelistFetching) return; // answered when the in-flight fetch settles
    _kmoniSitelistFetching = true;
    _kmoniFetchSitelist(function(err, body) {
      _kmoniSitelistFetching = false;
      if (!err && body && body.charAt(0) === '{') {
        _kmoniSitelistCache = { body: body, fetchedAt: Date.now() };
      }
      var waiters = _kmoniSitelistPending.splice(0, _kmoniSitelistPending.length);
      for (var wi = 0; wi < waiters.length; wi++) {
        var wr = waiters[wi];
        if (wr.destroyed) continue;
        if (_kmoniSitelistCache) {
          // Fresh on success, stale on upstream error — both better than nothing
          wr.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
          wr.end(_kmoniSitelistCache.body);
        } else {
          sendError(wr, 502, 'UPSTREAM_ERROR', 'Kmoni sitelist unavailable');
        }
      }
    });
    return;
  }

  // NIED official real-time intensity image (強震モニタ RealTimeImg underlay)
  if (reqPath === '/api/kmoni/image') {
    _kmoniImgHandle(req, res);
    return;
  }

  // Wolfx NTP proxy (client clock-offset calibration, cached 60 s)
  if (reqPath === '/api/ntp') {
    var ntpNow = Date.now();
    if (_ntpCache && ntpNow - _ntpCache.fetchedAt < 60000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(_ntpCache.body);
      return;
    }
    _upstreamGet('https://api.wolfx.jp/ntp.json', function(err, body) {
      if (!err && body && body.charAt(0) === '{') {
        _ntpCache = { body: body, fetchedAt: Date.now() };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(body);
      } else if (_ntpCache) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(_ntpCache.body);
      } else {
        sendError(res, 502, 'UPSTREAM_ERROR', 'NTP source unavailable');
      }
    });
    return;
  }

  // Wolfx geoIP proxy (approximate user location for EEW countdown reference)
  if (reqPath === '/api/geoip') {
    // Per-client-IP 60 s cache (same TTL + stale-if-error shape as /api/ntp):
    // the response describes the visitor, so it is keyed by the visitor's IP.
    var geoNow = Date.now();
    var geoCached = _geoipCache[_reqIp];
    if (geoCached && geoNow - geoCached.fetchedAt < 60000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' });
      res.end(geoCached.body);
      return;
    }
    // Forward the client IP so the lookup describes the visitor, not this server.
    // Private/loopback IPs get the server-side default (dev only) — the client
    // falls back to the map center when lat/lng come back null.
    var geoUrl = 'https://api.wolfx.jp/geoip.php';
    if (_reqIp && !isLoopbackIp(_reqIp)) geoUrl += '?ip=' + encodeURIComponent(_reqIp);
    _geoipFetchFn(geoUrl, function(err, body) {
      if (!err && body && body.charAt(0) === '{') {
        _geoipCachePut(_reqIp, body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' });
        res.end(body);
      } else if (geoCached) {
        // Fresh on success, stale on upstream error — both better than nothing
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' });
        res.end(geoCached.body);
      } else {
        sendError(res, 502, 'UPSTREAM_ERROR', 'GeoIP source unavailable');
      }
    });
    return;
  }

  // health check endpoint (includes P2P connection state + uptime)
  // ---- Local settings (settings page) ----
  // GET is public (no secrets: just the effective TTS upstream + its source);
  // POST is loopback-only so a remote visitor can never repoint the upstream
  // (SSRF guard) — this app is meant to be configured from its own machine.
  if (reqPath === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      ok: true,
      loopback: isLoopbackIp(req.socket.remoteAddress),
      tts: ttsSettingsPayload()
    }));
    return;
  }
  if (reqPath === '/api/settings' && req.method === 'POST') {
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      sendError(res, 403, 'FORBIDDEN', 'Settings can only be changed from the local machine.');
      return;
    }
    if (!_settingsRateLimit) _settingsRateLimit = {};
    var sip = _reqIp;
    var snow = Date.now();
    _settingsRateLimit[sip] = (_settingsRateLimit[sip] || []).filter(function(t) { return snow - t < 60000; });
    if (_settingsRateLimit[sip].length >= 10) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Max 10 per minute.');
      return;
    }
    _settingsRateLimit[sip].push(snow);
    var sBody = '';
    req.on('data', function(c) { if (sBody.length < 4096) sBody += c; });
    req.on('end', function() {
      var payload = {};
      try { payload = JSON.parse(sBody || '{}'); } catch(e) {
        sendError(res, 400, 'INVALID_JSON', 'Request body must be JSON.'); return;
      }
      var v = payload.ttsUpstreamUrl;
      if (v === '') {
        delete localSettings.ttsUpstreamUrl; // empty string resets to the default upstream
      } else if (typeof v === 'string' && v.length <= 200 && /^https?:\/\//i.test(v)) {
        localSettings.ttsUpstreamUrl = v;
      } else if (v !== undefined) {
        sendError(res, 400, 'INVALID_PARAM', 'ttsUpstreamUrl must be an http(s) URL (or an empty string to reset).');
        return;
      }
      var k = payload.ttsApiKey;
      if (k === '') {
        delete localSettings.ttsApiKey; // empty string clears the stored key
      } else if (typeof k === 'string' && k.length <= 200 && /^[\x20-\x7e]+$/.test(k)) {
        localSettings.ttsApiKey = k;
      } else if (k !== undefined) {
        sendError(res, 400, 'INVALID_PARAM', 'ttsApiKey must be printable ASCII (or an empty string to clear).');
        return;
      }
      var km = payload.ttsApiKeyMode;
      if (km !== undefined) {
        if (km === 'query' || km === 'bearer' || km === 'x-api-key') {
          localSettings.ttsApiKeyMode = km;
        } else {
          sendError(res, 400, 'INVALID_PARAM', 'ttsApiKeyMode must be query, bearer or x-api-key.');
          return;
        }
      }
      saveLocalSettings();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({
        ok: true,
        tts: ttsSettingsPayload()
      }));
    });
    return;
  }

  if (reqPath === '/health') {
    const p2pConnected = !!(p2pWs && p2pWs.readyState === 1);
    const wolfxEewOk = !!(wolfxEewWs && wolfxEewWs.readyState === 1);
    const wolfxEqOk = !!(wolfxEqWs && wolfxEqWs.readyState === 1);
    const emscOk = !!(emscWs && emscWs.readyState === 1);
    const uptimeSec = Math.floor((Date.now() - SERVER_START) / 1000);
    // 503 when all realtime feeds are down, 200 otherwise.
    const allOk = p2pConnected || wolfxEewOk || wolfxEqOk || emscOk;
    const code = allOk ? 200 : 503;
    // _replayInfo() may gunzip the day's recording file; the per-file
    // size/mtime cache misses constantly because the recorder appends every
    // few seconds. Memo the replay block (same TTL as /api/replay/info) so a
    // /health flood cannot block the event loop.
    if (!_healthReplayCache || Date.now() - _healthReplayCache.at >= 10000) {
      const _rh = _replayInfo();
      _healthReplayCache = { at: Date.now(), block: { frames: _rh.frames, earliest: _rh.earliest, latest: _rh.latest, diskBytes: _rh.diskBytes } };
    }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      status: allOk ? 'ok' : 'degraded',
      p2p: p2pConnected ? 'connected' : 'disconnected',
      wolfxEew: wolfxEewOk ? 'connected' : 'disconnected',
      wolfxEq: wolfxEqOk ? 'connected' : 'disconnected',
      emsc: emscOk ? 'connected' : 'disconnected',
      kmoni: sourceStatus.kmoni.state,
      uptime: uptimeSec,
      totalUptime: totalUptimeSeconds(),
      sseClients: sseClients.length,
      replay: { frames: _healthReplayCache.block.frames, earliest: _healthReplayCache.block.earliest, latest: _healthReplayCache.block.latest, diskBytes: _healthReplayCache.block.diskBytes, clients: _replayClients.length },
      time: new Date().toISOString()
    }));
    return;
  }

  // ================================================================
  //  LIVE EARTHQUAKE API — proxy to local eq-collector (port 7891)
  // ================================================================

  // GET /api/live-quakes — realtime earthquake list from multi-source API
  if (reqPath === '/api/live-quakes' && req.method === 'GET') {
    var lqNow = Date.now();
    var lqUrlObj = new URL(req.url, 'http://localhost');
    var eqUrl = LIVE_API_BASE + '/api/v1/earthquakes?minMag=' + encodeURIComponent(lqUrlObj.searchParams.get('minMag') || '3') +
      '&hours=' + encodeURIComponent(lqUrlObj.searchParams.get('hours') || '72') +
      '&region=' + encodeURIComponent(lqUrlObj.searchParams.get('region') || 'japan') +
      '&limit=' + encodeURIComponent(lqUrlObj.searchParams.get('limit') || '100') + '&order=desc';
    // The 30 s cache is keyed by the upstream URL — one global entry used to
    // let any request parameters overwrite whatever the last caller fetched.
    if (_liveQuakeCache && _liveQuakeCache.url === eqUrl && (lqNow - _liveQuakeCacheTime) < 30000) {
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-cache'});
      return res.end(_liveQuakeCache.body);
    }
    _httpGet(eqUrl, function(err, body, statusCode) {
      if (!err && statusCode === 200) {
        try {
          var data = JSON.parse(body);
          if (data && data.ok && data.data) {
            var items = data.data.map(function(eq) {
              return { id:'live-'+eq.id, lat:eq.lat, lng:eq.lng, mag:eq.mag, depth:eq.depth||30,
                place:eq.place||'', time:eq.time, region:eq.region||'', tsunami:eq.tsunami||0,
                sources:(eq.sources||[]).map(function(s){return s.source;}) };
            });
            var result = JSON.stringify({ok:true, data:items, pagination:data.pagination});
            _liveQuakeCache = { url: eqUrl, body: result }; _liveQuakeCacheTime = Date.now();
            res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-cache'}); res.end(result); return;
          }
        } catch(e) {}
      }
      if (_liveQuakeCache) { res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-cache'}); return res.end(_liveQuakeCache.body); }
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false, data:[], error:err ? err.message : 'Upstream unavailable'}));
    }, 10000);
    return;
  }

  // GET|POST /api/tts/synthesize — SREV-compatible dynamic neural TTS.
  // The upstream remains fixed at 127.0.0.1:7896 by default to prevent SSRF.
  if (reqPath === '/api/tts/synthesize' && (req.method === 'GET' || req.method === 'POST')) {
    var runSynthesize = function(rawText, rawVoice) {
      var synthText = (rawText || '').trim();
      var synthVoice = rawVoice || 'ja-JP-NanamiNeural';
      if (!synthText) {
        sendError(res, 400, 'MISSING_PARAM', 'Parameter "text" is required.');
        return;
      }
      if (synthText.length > TTS_MAX_TEXT_LENGTH) {
        sendError(res, 400, 'INVALID_PARAM', 'TTS text must be 300 characters or fewer.');
        return;
      }
      if (!TTS_VOICES.has(synthVoice)) {
        sendError(res, 400, 'INVALID_PARAM', 'Unsupported TTS voice.');
        return;
      }
      // Anonymous per-IP rate limit.
      var bucket = 'ip:' + _reqIp;
      var limit = TTS_SYNTHESIS_RATE_LIMIT;
      var synthNow = Date.now();
      if (!_ttsSynthesisRateLimit[bucket]) _ttsSynthesisRateLimit[bucket] = [];
      _ttsSynthesisRateLimit[bucket] = _ttsSynthesisRateLimit[bucket].filter(function(t) {
        return synthNow - t < 60000;
      });
      if (_ttsSynthesisRateLimit[bucket].length >= limit) {
        sendError(res, 429, 'RATE_LIMITED', 'Too many TTS synthesis requests. Max ' + limit + ' per minute.');
        return;
      }
      _ttsSynthesisRateLimit[bucket].push(synthNow);
      _proxyTtsSynthesis(req, res, synthText, synthVoice);
    };
    if (req.method === 'GET') {
      runSynthesize(url.searchParams.get('text'), url.searchParams.get('voice'));
      return;
    }
    var synthBody = '';
    req.on('data', function(c) { synthBody += c; if (synthBody.length > 4096) req.destroy(); });
    req.on('end', function() {
      var synthParams = {};
      if (synthBody.trim()) {
        try { synthParams = JSON.parse(synthBody); }
        catch(e) { sendError(res, 400, 'INVALID_JSON', 'Invalid JSON: ' + e.message); return; }
      }
      runSynthesize(synthParams.text, synthParams.voice);
    });
    return;
  }

  serveFile(req, res, filePath).then(found => {
    if (!found) {
      // API paths return JSON error; static files return plain text
      if (reqPath.startsWith('/api/')) {
        sendError(res, 404, 'NOT_FOUND', 'Endpoint not found: ' + reqPath);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
    }
  });
});

// Capture uncaught errors in the in-memory log
process.on('uncaughtException', function(err) {
  logError(err.message, err.stack);
  console.error('Uncaught:', err);
});
process.on('unhandledRejection', function(reason) {
  logError(String(reason));
});

server.on('error', function(e) {
  if (e && e.code === 'EADDRINUSE') {
    console.error('Error: port ' + PORT + ' is already in use — another server.js instance is probably still running. Stop it first, or start this one with a different port, e.g. PORT=3001 node server.js');
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`QuakeSim running on http://127.0.0.1:${PORT}`);
  console.log(`Public dir: ${PUBLIC}`);
});

// ---- P2PQuake WebSocket client (real-time Japan earthquake data) ----
let sseClients = [];
var _sseClientIps = {}; // live-stream per-IP connection counts (cap 6)
let p2pWs = null;

// Decrement a per-IP connection counter; empty keys are dropped
function _decIpCount(store, ip) {
  if (!store[ip]) return;
  store[ip]--;
  if (store[ip] <= 0) delete store[ip];
}
let p2pReconnectTimer = null;
let p2pReconnectAttempts = 0;

function broadcastSSE(data) {
  _replayRecord(data);
  const payload = JSON.stringify(data);
  // Named SSE event line so client addEventListener('<type>') handlers fire
  const msg = (typeof data.type === 'string' && data.type !== '' && data.type.indexOf('\n') < 0 && data.type.indexOf('\r') < 0)
    ? 'event: ' + data.type + '\ndata: ' + payload + '\n\n'
    : 'data: ' + payload + '\n\n';
  sseClients = sseClients.filter(c => {
    try { c.write(msg); return true; } catch(e) { return false; }
  });
}

// ---- Realtime stream recorder / replay (回放) ----
// Every broadcastSSE payload is appended to an in-memory ring and to daily
// gzip JSONL files under recordings/, so clients can replay missed history.
const REPLAY_RECORD = true;
const REPLAY_RETENTION_MS = 3 * 3600 * 1000;
const REPLAY_MAX_FRAMES = 20000;
const REPLAY_MAX_CLIENTS = 20;
const REPLAY_FLUSH_MS = 5000;
const REPLAY_DISK_KEEP_MS = 3 * 24 * 3600 * 1000;
const REPLAY_EVENTS_CAP = 200;            // timeline markers per /api/replay/info
const REPLAY_EXPORT_MAX_MS = 6 * 3600 * 1000; // /api/replay/export window cap
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

var _replayFrames = [];   // ring storage; live window is [_replayHead, length)
var _replayHead = 0;      // index of the oldest retained frame
var _replayByType = {};   // live per-type counts for /api/replay/info
var _replayClients = [];  // active /api/replay/stream connections
var _replayClientIps = {}; // replay-stream per-IP connection counts (cap 2)
var _replayDiskBuf = [];  // JSON lines awaiting the next gzip flush
var _replayInfoCache = null; // {at, payload} — 10 s memo for /api/replay/info
var _healthReplayCache = null; // {at, block} — 10 s memo for /health's replay block (gunzip DoS guard)

function _replayPushFrame(frame) {
  _replayFrames.push(frame);
  _replayByType[frame.type] = (_replayByType[frame.type] || 0) + 1;
  // Evict expired / overflowing frames from the head. Amortized O(1): the
  // head pointer just advances; the dead prefix is compacted in batches.
  var cutoff = Date.now() - REPLAY_RETENTION_MS;
  var count = _replayFrames.length - _replayHead;
  while (count > 0 && (_replayFrames[_replayHead].t < cutoff || count > REPLAY_MAX_FRAMES)) {
    var oldType = _replayFrames[_replayHead].type;
    _replayByType[oldType] = (_replayByType[oldType] || 1) - 1;
    if (_replayByType[oldType] <= 0) delete _replayByType[oldType];
    _replayHead++;
    count--;
  }
  if (_replayHead >= 4096 && _replayHead * 2 >= _replayFrames.length) {
    _replayFrames = _replayFrames.slice(_replayHead);
    _replayHead = 0;
  }
}

function _replayRecord(data) {
  if (!REPLAY_RECORD) return;
  try {
    var frame = { t: Date.now(), type: (data && typeof data.type === 'string') ? data.type : '', event: data ? data.event : undefined };
    _replayPushFrame(frame);
    _replayDiskBuf.push(JSON.stringify(frame) + '\n');
  } catch(e) {}
}

function _replaySnapshot() {
  return _replayFrames.slice(_replayHead);
}

function _replayDateStamp(ms) {
  var d = new Date(ms);
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
}

function _replayFilePath(ms) {
  return path.join(RECORDINGS_DIR, _replayDateStamp(ms) + '.jsonl.gz');
}

// Flush pending JSON lines as one gzip member onto today's daily file.
// Appending members yields a valid multi-member gzip stream; zlib reads the
// concatenation back whole. The date rolls at flush time.
function _replayFlushDisk() {
  if (_replayDiskBuf.length === 0) return;
  var lines = _replayDiskBuf;
  _replayDiskBuf = [];
  try {
    var gz = zlib.gzipSync(Buffer.from(lines.join(''), 'utf8'));
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    fs.appendFileSync(_replayFilePath(Date.now()), gz);
  } catch(e) { /* disk failure must never break serving */ }
}

function _replayDiskBytes() {
  try {
    var total = 0;
    var files = fs.readdirSync(RECORDINGS_DIR);
    for (var i = 0; i < files.length; i++) {
      if (!/^\d{8}\.jsonl\.gz$/.test(files[i])) continue;
      total += fs.statSync(path.join(RECORDINGS_DIR, files[i])).size;
    }
    return total;
  } catch(e) { return 0; }
}

function _replayInfo() {
  var count = _replayFrames.length - _replayHead;
  return {
    ok: true,
    earliest: count > 0 ? _replayFrames[_replayHead].t : null,
    latest: count > 0 ? _replayFrames[_replayFrames.length - 1].t : null,
    frames: count,
    byType: Object.assign({}, _replayByType),
    diskBytes: _replayDiskBytes(),
    events: _replayScanEvents()
  };
}

// ---- Replay event index (timeline markers) + export gathering ----
// One timeline event from a recorded frame, or null when the frame is not
// timeline material. EEW frames keep _id/_serial so the caller can hold one
// marker per EventID (Serial 1 wins, otherwise the first-seen report).
function _replayEventFromFrame(f) {
  var e = f && f.event;
  if (!e || typeof e !== 'object') return null;
  if (f.type === 'wolfx_eew' || f.type === 'jma_eew') {
    var mag = (typeof e.Magunitude === 'number') ? e.Magunitude : parseFloat(e.Magunitude);
    return {
      t: f.t, type: 'eew',
      label: 'EEW' + (isFinite(mag) ? ' M' + mag.toFixed(1) : '') + (e.Hypocenter ? ' ' + e.Hypocenter : ''),
      _id: e.EventID || '', _serial: e.Serial || 0
    };
  }
  if (f.type === 'p2pquake' && e.code === 551) {
    if (e.cancelled) return null;
    if (!(e.maxIntensity >= 30)) return null; // felt bulletins only (震度3+)
    var label = (e.mag > 0 ? 'M' + Number(e.mag).toFixed(1) + ' ' : '') + (e.place || '');
    if (!label) label = '震度速報' + (e.maxShindo ? ' 最大震度' + e.maxShindo : '');
    return { t: f.t, type: 'info', label: label, _id: '', _serial: 0 };
  }
  return null;
}

// Daily gzip files hold up to 3 days of frames, the ring only 3 hours. Scan
// files for events older than the ring so long sessions still get markers.
// Cached by size+mtime — unchanged files are never gunzipped twice.
var _replayEventFileCache = {};
function _replayScanFileEvents(olderThan) {
  var out = [];
  var files;
  try { files = fs.readdirSync(RECORDINGS_DIR); } catch(e) { return out; }
  files.sort();
  var seenFiles = {};
  for (var i = 0; i < files.length; i++) {
    if (!/^\d{8}\.jsonl\.gz$/.test(files[i])) continue;
    seenFiles[files[i]] = true;
    var fp = path.join(RECORDINGS_DIR, files[i]);
    var st = null;
    try { st = fs.statSync(fp); } catch(e) { continue; }
    var ent = _replayEventFileCache[files[i]];
    if (!ent || ent.size !== st.size || ent.mtimeMs !== st.mtimeMs) {
      ent = { size: st.size, mtimeMs: st.mtimeMs, events: [] };
      try {
        var lines = zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8').split('\n');
        for (var j = 0; j < lines.length; j++) {
          var line = lines[j];
          // cheap pre-filter: only EEW / 551 lines can produce an event
          if (line.indexOf('wolfx_eew') < 0 && line.indexOf('jma_eew') < 0 && line.indexOf('"code":551') < 0) continue;
          try {
            var f = JSON.parse(line);
            if (f && typeof f.t === 'number') {
              var ev = _replayEventFromFrame(f);
              if (ev) ent.events.push(ev);
            }
          } catch(e2) {}
        }
      } catch(e3) { continue; }
      _replayEventFileCache[files[i]] = ent;
    }
    for (var k = 0; k < ent.events.length; k++) {
      if (olderThan == null || ent.events[k].t < olderThan) out.push(ent.events[k]);
    }
  }
  for (var name in _replayEventFileCache) {
    if (!seenFiles[name]) delete _replayEventFileCache[name];
  }
  return out;
}

// Events index for /api/replay/info: one EEW marker per EventID + felt 551
// bulletins, time-ascending, capped (the newest entries win — they are the
// ones inside the replayable ring window).
function _replayScanEvents() {
  var count = _replayFrames.length - _replayHead;
  var ringEarliest = count > 0 ? _replayFrames[_replayHead].t : null;
  var all = _replayScanFileEvents(ringEarliest);
  for (var i = _replayHead; i < _replayFrames.length; i++) {
    var tp = _replayFrames[i].type;
    if (tp === 'wolfx_eew' || tp === 'jma_eew' || tp === 'p2pquake') {
      var ev = _replayEventFromFrame(_replayFrames[i]);
      if (ev) all.push(ev);
    }
  }
  var byId = {};
  for (var j = 0; j < all.length; j++) {
    var e = all[j];
    if (e.type !== 'eew' || !e._id) continue;
    if (!byId[e._id] || (e._serial === 1 && byId[e._id]._serial !== 1)) byId[e._id] = e;
  }
  var out = [];
  for (var k = 0; k < all.length; k++) {
    var e2 = all[k];
    if (e2.type === 'eew' && e2._id && byId[e2._id] !== e2) continue;
    out.push({ t: e2.t, type: e2.type, label: e2.label });
  }
  out.sort(function(a, b) { return a.t - b.t; });
  if (out.length > REPLAY_EVENTS_CAP) out = out.slice(out.length - REPLAY_EVENTS_CAP);
  return out;
}

// Available recording range for export clamping: oldest daily-file day
// (local midnight) through now / the newest ring frame.
function _replayExportRange() {
  var count = _replayFrames.length - _replayHead;
  var earliest = count > 0 ? _replayFrames[_replayHead].t : null;
  try {
    var files = fs.readdirSync(RECORDINGS_DIR);
    for (var i = 0; i < files.length; i++) {
      if (!/^\d{8}\.jsonl\.gz$/.test(files[i])) continue;
      var dayStart = new Date(+files[i].slice(0, 4), +files[i].slice(4, 6) - 1, +files[i].slice(6, 8)).getTime();
      if (earliest == null || dayStart < earliest) earliest = dayStart;
    }
  } catch(e) {}
  if (earliest == null) return null;
  var latest = Date.now();
  if (count > 0 && _replayFrames[_replayFrames.length - 1].t > latest) latest = _replayFrames[_replayFrames.length - 1].t;
  return { earliest: earliest, latest: latest };
}

// Visit export-window JSONL batches in time order: daily gzip files cover
// [fromMs, ringEarliest), the live ring covers the rest. Disk lines pass
// through verbatim (timestamp pulled by regex — no per-line re-encode);
// ring frames are re-stringified. cb may be async; iteration awaits it.
async function _replayForEachExportBatch(fromMs, toMs, cb) {
  var count = _replayFrames.length - _replayHead;
  var ringEarliest = count > 0 ? _replayFrames[_replayHead].t : null;
  var diskTo = ringEarliest == null ? toMs : Math.min(toMs, ringEarliest - 1);
  if (fromMs <= diskTo) {
    var files;
    try { files = fs.readdirSync(RECORDINGS_DIR); } catch(e) { files = []; }
    files.sort();
    for (var i = 0; i < files.length; i++) {
      if (!/^\d{8}\.jsonl\.gz$/.test(files[i])) continue;
      // skip days that cannot intersect the window
      var dayStart = new Date(+files[i].slice(0, 4), +files[i].slice(4, 6) - 1, +files[i].slice(6, 8)).getTime();
      if (dayStart > diskTo || dayStart + 86400000 - 1 < fromMs) continue;
      var lines;
      try { lines = zlib.gunzipSync(fs.readFileSync(path.join(RECORDINGS_DIR, files[i]))).toString('utf8').split('\n'); }
      catch(e) { continue; }
      var batch = [];
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (!line) continue;
        var m = /^\{"t":(\d+)/.exec(line);
        if (!m) continue;
        var t = +m[1];
        if (t < fromMs || t > diskTo) continue;
        batch.push(line);
        if (batch.length >= 512) { await cb(batch); batch = []; }
      }
      if (batch.length) await cb(batch);
    }
  }
  if (ringEarliest != null && toMs >= ringEarliest) {
    var rFrom = Math.max(fromMs, ringEarliest);
    var batch2 = [];
    for (var k = _replayHead; k < _replayFrames.length; k++) {
      var f = _replayFrames[k];
      if (f.t < rFrom || f.t > toMs) continue;
      batch2.push(JSON.stringify(f));
      if (batch2.length >= 512) { await cb(batch2); batch2 = []; }
    }
    if (batch2.length) await cb(batch2);
  }
}

// Startup: drop daily files older than 3 days, then reload today's file into
// the ring (retention/cap apply via _replayPushFrame; corrupt lines skip).
function _replayStartup() {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    var keepAfter = _replayDateStamp(Date.now() - REPLAY_DISK_KEEP_MS);
    var files = fs.readdirSync(RECORDINGS_DIR);
    for (var i = 0; i < files.length; i++) {
      var m = /^(\d{8})\.jsonl\.gz$/.exec(files[i]);
      if (!m) continue;
      if (m[1] < keepAfter) { try { fs.unlinkSync(path.join(RECORDINGS_DIR, files[i])); } catch(e) {} }
    }
    var todayFile = _replayFilePath(Date.now());
    if (fs.existsSync(todayFile)) {
      var raw = zlib.gunzipSync(fs.readFileSync(todayFile)).toString('utf8');
      var lines = raw.split('\n');
      for (var j = 0; j < lines.length; j++) {
        if (!lines[j]) continue;
        try {
          var f = JSON.parse(lines[j]);
          if (f && typeof f.t === 'number' && typeof f.type === 'string') {
            _replayPushFrame({ t: f.t, type: f.type, event: f.event });
          }
        } catch(e) {}
      }
    }
  } catch(e) {}
}

_replayStartup();
var _replayFlushTimer = setInterval(_replayFlushDisk, REPLAY_FLUSH_MS);

// SSE heartbeat: keep connections alive, clean up dead ones
_sseHeartbeatTimer = setInterval(function() {
  if (sseClients.length === 0) return;
  var before = sseClients.length;
  sseClients = sseClients.filter(function(c) {
    try { c.write(': heartbeat\n\n'); return true; } catch(e) { return false; }
  });
  if (before !== sseClients.length) console.log('SSE: cleaned ' + (before - sseClients.length) + ' dead clients');
}, 30000);

// SSE named ping (~15 s): comment heartbeats fire no client-side event, so a
// client's silence watchdog would force-reconnect during quiet periods. Emit a
// real named event on the live p2pquake stream only (never the replay stream).
const SSE_PING_MS = 15000;
function _ssePingStart(ms) {
  if (_ssePingTimer) clearInterval(_ssePingTimer);
  _ssePingTimer = setInterval(function() {
    if (sseClients.length === 0) return;
    var before = sseClients.length;
    var msg = 'event: ping\ndata: {"t":' + Date.now() + '}\n\n';
    sseClients = sseClients.filter(function(c) {
      try { c.write(msg); return true; } catch(e) { return false; }
    });
    if (before !== sseClients.length) console.log('SSE: cleaned ' + (before - sseClients.length) + ' dead clients');
  }, ms);
}
_ssePingStart(SSE_PING_MS);

function normalizeP2PEvent(msg) {
  const eq = msg.earthquake || {};
  const hypo = eq.hypocenter || {};
  const mag = eq.magnitude || {};
  const intens = eq.intensity || {};
  return {
    id: 'p2pq_' + (msg._id || Date.now()),
    code: msg.code,
    // P2PQuake codes: 551 = earthquake info, 552 = tsunami info, 554 = EEW
    type: msg.code === 551 ? 'earthquake_info' : msg.code === 552 ? 'tsunami' :
          msg.code === 554 ? 'eew' : 'earthquake',
    mag: mag.value || 0,
    lat: hypo.latitude || 0,
    lng: hypo.longitude || 0,
    depth: hypo.depth || 30,
    place: hypo.name || '',
    maxIntensity: intens.maxScale || 0,
    maxShindo: intens.maxInt || '',
    time: msg.time || '',
    serial: (msg.issue || {}).serial || 1,
    // 551 bulletin classification + payload for realtime quake-info TTS/toasts:
    // ScalePrompt 震度速報 / Destination 震源情報 / ScaleAndDestination
    // 震源・震度情報 / DetailScale 各地の震度 / Foreign 遠地地震
    issueType: (msg.issue || {}).type || '',
    originTime: eq.time || '',
    domesticTsunami: eq.domesticTsunami || '',
    points: msg.code === 551 && Array.isArray(msg.points) ? msg.points.slice(0, 300).map(function(p) {
      var pt = { pref: (p && p.pref) || '', addr: (p && p.addr) || '', scale: (p && p.scale) || 0, isArea: !!(p && p.isArea) };
      // Long-period ground motion (長周期地震動階級) fields — forwarded
      // verbatim on the rare bulletins where JMA/P2P include them.
      if (p && p.lgScale !== undefined) pt.lgScale = p.lgScale;
      if (p && p.lgInt !== undefined) pt.lgInt = p.lgInt;
      return pt;
    }) : undefined,
    cancelled: !!msg.cancelled,
    tsunamiAreas: msg.code === 552 ? (msg.areas || []) : undefined,
    intensityDetail: msg.code === 551 ? (intens || undefined) : undefined
  };
}

// Data source health tracking
let sourceStatus = {
  p2pquake:    { name: 'P2PQuake',        type: 'WebSocket', state: 'off', since: Date.now(), lastEvent: null },
  wolfx_eew:   { name: 'Wolfx JMA EEW',   type: 'WebSocket', state: 'off', since: Date.now(), lastEvent: null },
  wolfx_eq:    { name: 'Wolfx Earthquake List', type: 'WebSocket', state: 'off', since: Date.now(), lastEvent: null },
  emsc:        { name: 'EMSC',             type: 'WebSocket', state: 'off', since: Date.now(), lastEvent: null },
  jma_feed:    { name: 'JMA Atom Feed',    type: 'HTTP Poll',  state: 'disconnected', since: Date.now(), lastEvent: null },
  kmoni:       { name: 'NIED Kmoni RT',    type: 'HTTP Poll',  state: 'off', since: Date.now(), lastEvent: null },
};

function updateSourceStatus(key, state) {
  if (sourceStatus[key]) {
    sourceStatus[key].state = state;
    sourceStatus[key].since = Date.now();
  }
}

function updateSourceEvent(key) {
  if (sourceStatus[key]) {
    sourceStatus[key].lastEvent = Date.now();
  }
}

// Exponential backoff with jitter for WebSocket reconnects
function wsReconnect(connectFn, attempts, baseDelay, maxDelay) {
  if (_shuttingDown) return null;
  var delay = baseDelay * Math.pow(2, Math.min(attempts, 5)); // cap exponent at 5
  if (delay > maxDelay) delay = maxDelay;
  var jitter = delay * (0.75 + Math.random() * 0.5); // ±25% jitter
  console.log('Reconnecting in ' + Math.round(jitter / 1000) + 's (attempt ' + (attempts + 1) + ')...');
  return setTimeout(connectFn, Math.round(jitter));
}

function connectP2PQuake() {
  try {
    const WebSocket = require('ws');
    p2pWs = new WebSocket('wss://api.p2pquake.net/v2/ws');
    p2pWs.on('open', () => { console.log('P2PQuake: connected'); p2pReconnectAttempts = 0; updateSourceStatus('p2pquake', 'connected'); });
    p2pWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if ([551,552,554,5611].includes(msg.code)) {
          broadcastSSE({ type: 'p2pquake', event: normalizeP2PEvent(msg) });
          updateSourceEvent('p2pquake');
        }
      } catch(e) { console.error('P2PQuake: parse error —', e.message); }
    });
    p2pWs.on('close', () => {
      console.log('P2PQuake: disconnected');
      updateSourceStatus('p2pquake', 'disconnected');
      p2pReconnectTimer = wsReconnect(connectP2PQuake, p2pReconnectAttempts++, 10000, 300000);
    });
    p2pWs.on('error', (e) => {
      console.log('P2PQuake: error -', e.message);
    });
  } catch(e) {
    console.log('P2PQuake: ws not available, skipping');
  }
}

// ---- Wolfx JMA EEW WebSocket (real-time 緊急地震速報) ----
let wolfxEewWs = null, wolfxEewTimer = null;
let wolfxEewAttempts = 0;

function connectWolfxEEW() {
  try {
    const WebSocket = require('ws');
    wolfxEewWs = new WebSocket('wss://ws-api.wolfx.jp/jma_eew');
    wolfxEewWs.on('open', () => { console.log('Wolfx EEW: connected'); wolfxEewAttempts = 0; updateSourceStatus('wolfx_eew', 'connected'); });
    wolfxEewWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Skip heartbeat messages (type=heartbeat, no earthquake data)
        if (msg.type === 'heartbeat') return;
        // Raw jma_eew carries top-level fields ("Magunitude" typo is upstream's)
        if (msg.type !== 'jma_eew' || !msg.EventID) return;
        if (typeof msg.Magunitude !== 'number' || msg.Magunitude <= 0) return;
        broadcastSSE({ type: 'wolfx_eew', event: msg });
        updateSourceEvent('wolfx_eew');
      } catch(e) {}
    });
    wolfxEewWs.on('close', () => {
      console.log('Wolfx EEW: disconnected');
      updateSourceStatus('wolfx_eew', 'disconnected');
      wolfxEewTimer = wsReconnect(connectWolfxEEW, wolfxEewAttempts++, 15000, 300000);
    });
    wolfxEewWs.on('error', (e) => console.log('Wolfx EEW: error -', e.message));
  } catch(e) { console.log('Wolfx EEW: ws not available'); }
}

// ---- Wolfx JMA Earthquake List WebSocket (latest 50 quakes) ----
let wolfxEqWs = null, wolfxEqTimer = null;
let wolfxEqAttempts = 0;

function connectWolfxEqList() {
  try {
    const WebSocket = require('ws');
    wolfxEqWs = new WebSocket('wss://ws-api.wolfx.jp/jma_eqlist');
    wolfxEqWs.on('open', () => { console.log('Wolfx EqList: connected'); wolfxEqAttempts = 0; updateSourceStatus('wolfx_eq', 'connected'); });
    wolfxEqWs.on('message', (data) => {
      try {
        const list = JSON.parse(data.toString());
        // Skip heartbeat messages
        if (list && list.type === 'heartbeat') return;
        // Wolfx jma_eqlist payload: {No1:{...}, No2:{...}, ..., md5} — entries
        // carry string fields (magnitude '3.4', latitude '34.1', depth '60km').
        var entries = [];
        if (Array.isArray(list)) entries = list;
        else if (list && typeof list === 'object') {
          Object.keys(list).forEach(function(k) {
            if (/^No\d+$/.test(k) && list[k] && typeof list[k] === 'object') entries.push(list[k]);
          });
          // Defensive: a bare single-entry object without NoN keys
          if (!entries.length && (list.magnitude || list.mag)) entries = [list];
        }
        entries.forEach(function(eq) {
          if (!eq || eq.type === 'heartbeat') return;
          var mag = (eq.magnitude && typeof eq.magnitude === 'object') ? (eq.magnitude.value || 0)
                  : parseFloat(eq.magnitude || eq.mag || 0);
          if (!mag || mag <= 0 || isNaN(mag)) return;
          broadcastSSE({ type: 'wolfx_eq', event: eq });
          updateSourceEvent('wolfx_eq');
        });
      } catch(e) {}
    });
    wolfxEqWs.on('close', () => {
      console.log('Wolfx EqList: disconnected');
      updateSourceStatus('wolfx_eq', 'disconnected');
      wolfxEqTimer = wsReconnect(connectWolfxEqList, wolfxEqAttempts++, 30000, 300000);
    });
    wolfxEqWs.on('error', (e) => console.log('Wolfx EqList: error -', e.message));
  } catch(e) { console.log('Wolfx EqList: ws not available'); }
}

// ---- EMSC WebSocket (global real-time earthquake push) ----
let emscWs = null, emscTimer = null;
let emscAttempts = 0;

function connectEMSC() {
  try {
    const WebSocket = require('ws');
    emscWs = new WebSocket('wss://www.seismicportal.eu/standing_order/websocket');
    emscWs.on('open', () => { console.log('EMSC: connected'); emscAttempts = 0; updateSourceStatus('emsc', 'connected'); });
    emscWs.on('message', (data) => {
      try {
        var msg = JSON.parse(data.toString());
        if (msg.action === 'create' || msg.action === 'update') {
          broadcastSSE({ type: 'emsc', event: msg.data });
          updateSourceEvent('emsc');
        }
      } catch(e) {}
    });
    emscWs.on('close', () => {
      console.log('EMSC: disconnected');
      updateSourceStatus('emsc', 'disconnected');
      emscTimer = wsReconnect(connectEMSC, emscAttempts++, 30000, 300000);
    });
    emscWs.on('error', (e) => console.log('EMSC: error -', e.message));
  } catch(e) { console.log('EMSC: ws not available'); }
}

// ---- JMA Atom Feed polling (official 気象庁 XML) ----
var jmaFeedTimer = null;

function pollJMAFeed() {
  var mod = (typeof require === 'function') ? require('https') : null;
  if (!mod) return;
  updateSourceStatus('jma_feed', 'polling');
  // Bounded fetch: 15 s timeout and a 2 MB body cap so a hung/huge upstream
  // response can no longer accumulate unbounded memory.
  var jmaReq = mod.get('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', function(res) {
    var body = '';
    var tooBig = false;
    res.on('data', function(chunk) {
      if (tooBig) return;
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        tooBig = true;
        updateSourceStatus('jma_feed', 'error');
        try { jmaReq.destroy(); } catch (e0) {}
      }
    });
    res.on('end', function() {
      if (tooBig) return;
      updateSourceStatus('jma_feed', 'ok');
      try {
        var entries = body.match(/<entry>[\s\S]*?<\/entry>/g) || [];
        entries.forEach(function(entry) {
          var title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
          var link = (entry.match(/<link[^>]*href="([^"]*)"/) || [])[1] || '';
          var updated = (entry.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '';
          if (title && updated) {
            broadcastSSE({ type: 'jma_feed', event: { title: title, link: link, updated: updated } });
            updateSourceEvent('jma_feed');
          }
        });
      } catch(e) { updateSourceStatus('jma_feed', 'error'); }
    });
  }).on('error', function(e) {
    updateSourceStatus('jma_feed', 'error');
    console.log('JMA Feed: fetch error -', e.message);
  });
  try { jmaReq.setTimeout(15000, function() { jmaReq.destroy(new Error('timeout')); }); } catch (e1) {}
}

// ---- NIED Kmoni real-time polling (強震モニタ via Yahoo mirror) ----
var KMONI_BASE = 'https://weather-kyoshin.east.edge.storage-yahoo.jp';
var _kmoniSitelistCache = null;    // { body, fetchedAt }
var _kmoniSitelistFetching = false;
var _kmoniSitelistPending = [];
var _kmoniPollTimer = null;
var _kmoniDelayMs = 1500;          // adaptive upstream publication delay
var _kmoniFails = 0;
var _kmoniSuccesses = 0;
var _kmoniBackoffUntil = 0;
var _kmoniInFlight = false;
var _kmoniLastDataTime = '';

function _kmoniPad(n) { return (n < 10 ? '0' : '') + n; }

// JST (UTC+9) wall clock via UTC getters so the process TZ does not matter
function _kmoniJstStrings(ms) {
  var d = new Date(ms + 9 * 3600e3);
  var date = '' + d.getUTCFullYear() + _kmoniPad(d.getUTCMonth() + 1) + _kmoniPad(d.getUTCDate());
  return { date: date, time: date + _kmoniPad(d.getUTCHours()) + _kmoniPad(d.getUTCMinutes()) + _kmoniPad(d.getUTCSeconds()) };
}

// Yahoo edge answers gzip regardless of Accept-Encoding: identity — inflate when detected
function _kmoniDecodeBody(chunks, bodyLen) {
  try {
    var buf = Buffer.concat(chunks, bodyLen);
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf.toString('utf8');
  } catch(e) { return null; }
}

// Generic upstream GET (gzip-tolerant, 8 s timeout, 1 MB cap) for small proxies
var _ntpCache = null;
var _geoipCache = {}; // client IP -> {body, fetchedAt} (60 s TTL, stale-if-error)
var GEOIP_CACHE_MAX = 1024; // hard cap — unique-IP growth must stay bounded
// Insert one entry, then evict the oldest-fetchedAt entries while over
// capacity. A full sweep per excess entry is fine at this size; expired
// entries are the oldest by construction, so they go first.
function _geoipCachePut(ip, body) {
  _geoipCache[ip] = { body: body, fetchedAt: Date.now() };
  var excess = Object.keys(_geoipCache).length - GEOIP_CACHE_MAX;
  while (excess-- > 0) {
    var oldestKey = null, oldestAt = Infinity;
    for (var k in _geoipCache) {
      var at = _geoipCache[k].fetchedAt;
      if (at < oldestAt) { oldestAt = at; oldestKey = k; }
    }
    if (oldestKey === null) break;
    delete _geoipCache[oldestKey];
  }
}
function _upstreamGet(url, cb) {
  var https = require('https');
  var settled = false;
  function done(err, body) {
    if (settled) return;
    settled = true;
    cb(err, body);
  }
  var req = https.get(url, {
    agent: _httpsAgent,
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'QuakeSim/5.6 Upstream Proxy' }
  }, function(r) {
    var chunks = [], bodyLen = 0;
    if (r.statusCode !== 200) { r.resume(); done(new Error('upstream ' + r.statusCode)); return; }
    r.on('data', function(c) { bodyLen += c.length; if (bodyLen <= 1048576) chunks.push(c); });
    r.on('end', function() {
      if (bodyLen > 1048576) { done(new Error('upstream too large')); return; }
      done(null, _kmoniDecodeBody(chunks, bodyLen));
    });
    r.on('error', function(e) { done(e); });
  });
  req.on('error', function(e) { done(e); });
  req.setTimeout(8000, function() { req.destroy(new Error('upstream timeout')); });
}
// Injectable for tests (same shape as _kmoniImgFetchFn)
var _geoipFetchFn = _upstreamGet;

function _kmoniFetchSitelist(cb) {
  var https = require('https');
  var settled = false;
  function done(err, body) {
    if (settled) return;
    settled = true;
    cb(err, body);
  }
  var req = https.get(KMONI_BASE + '/SiteList/sitelist.json', {
    agent: _httpsAgent,
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'QuakeSim/5.6 Kmoni Proxy' }
  }, function(r) {
    var chunks = [], bodyLen = 0;
    if (r.statusCode !== 200) { r.resume(); done(new Error('sitelist upstream ' + r.statusCode)); return; }
    r.on('data', function(c) { bodyLen += c.length; if (bodyLen <= 2097152) chunks.push(c); });
    r.on('end', function() {
      if (bodyLen > 2097152) { done(new Error('sitelist too large')); return; }
      done(null, _kmoniDecodeBody(chunks, bodyLen));
    });
    r.on('error', function(e) { done(e); });
  });
  req.on('error', function(e) { done(e); });
  req.setTimeout(8000, function() { req.destroy(new Error('sitelist timeout')); });
}

function _kmoniOnFailure(reason) {
  _kmoniFails++;
  if (_kmoniFails >= 10) {
    updateSourceStatus('kmoni', 'error');
    _kmoniBackoffUntil = Date.now() + 10000; // slow to a 10s cadence until a success
    console.log('Kmoni: ' + _kmoniFails + ' consecutive failures (' + reason + ') — backing off');
  }
}

function _kmoniOnSuccess(body) {
  _kmoniFails = 0;
  _kmoniBackoffUntil = 0;
  var rtd = null;
  try { rtd = (JSON.parse(body) || {}).realTimeData; } catch(e) {}
  if (!rtd || !rtd.siteConfigId || !rtd.intensity) {
    _kmoniOnFailure('bad payload');
    return;
  }
  if (rtd.dataTime !== _kmoniLastDataTime) {
    _kmoniLastDataTime = rtd.dataTime;
    broadcastSSE({ type: 'kmoni_rt', event: {
      dataTime: rtd.dataTime,
      siteConfigId: rtd.siteConfigId,
      intensity: rtd.intensity
    } });
    updateSourceEvent('kmoni');
  }
  updateSourceStatus('kmoni', 'connected');
  // Sustained success decays the adaptive delay back toward 1500ms
  _kmoniSuccesses++;
  if (_kmoniSuccesses >= 10) {
    _kmoniSuccesses = 0;
    _kmoniDelayMs = Math.max(1500, _kmoniDelayMs - 20);
  }
}

// Supervisor tick: polls upstream while SSE clients are attached — and always
// while the replay recorder is on, so recordings keep filling with zero clients
function _kmoniPollTick() {
  if (_shuttingDown) return;
  if (sseClients.length === 0 && !REPLAY_RECORD) {
    if (sourceStatus.kmoni.state !== 'idle') updateSourceStatus('kmoni', 'idle');
    _kmoniFails = 0;
    _kmoniBackoffUntil = 0;
    return;
  }
  if (_kmoniInFlight || Date.now() < _kmoniBackoffUntil) return;
  _kmoniInFlight = true;
  var ts = _kmoniJstStrings(Date.now() - _kmoniDelayMs);
  var settled = false;
  function done(err, statusCode, body) {
    if (settled) return;
    settled = true;
    _kmoniInFlight = false;
    if (err) { _kmoniOnFailure(err.message || String(err)); return; }
    if (statusCode === 200) { _kmoniOnSuccess(body); return; }
    if (statusCode === 400 || statusCode === 404) {
      // Frame not published yet — nudge the adaptive delay up (max 3s)
      _kmoniDelayMs = Math.min(3000, _kmoniDelayMs + 100);
      return;
    }
    _kmoniOnFailure('upstream ' + statusCode);
  }
  var https = require('https');
  var req = https.get(KMONI_BASE + '/RealTimeData/' + ts.date + '/' + ts.time + '.json', {
    agent: _httpsAgent,
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'QuakeSim/5.6 Kmoni Proxy' }
  }, function(r) {
    var chunks = [], bodyLen = 0;
    r.on('data', function(c) { bodyLen += c.length; if (bodyLen <= 1048576) chunks.push(c); });
    r.on('end', function() { done(null, r.statusCode, _kmoniDecodeBody(chunks, bodyLen)); });
    r.on('error', function(e) { done(e); });
  });
  req.on('error', function(e) { done(e); });
  req.setTimeout(8000, function() { req.destroy(new Error('kmoni timeout')); });
}

// ---- NIED official real-time intensity image (/api/kmoni/image) ----
// Pre-rendered 強震モニタ map frames for the client underlay. NIED is
// unreachable from some networks, so candidate sources are probed in order
// and the first working one is reused for 60 s; the image body is cached 5 s;
// when every source fails the endpoint 503s and backs off for 60 s.
var KMONI_IMG_SOURCES = [
  { name: 'nied-new', build: function(ts) { return 'https://www.kmoni.bosai.go.jp/new/data/map_img/RealTimeImg/jma_s/' + ts.date + '/' + ts.time + '.jma_s.gif'; } },
  { name: 'nied-old', build: function(ts) { return 'https://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_s/' + ts.date + '/' + ts.time + '.jma_s.gif'; } },
  { name: 'yahoo', build: function(ts) { return KMONI_BASE + '/RealTimeImg/jma_s/' + ts.date + '/' + ts.time + '.jma_s.gif'; } }
];
var KMONI_IMG_CACHE_MS = 5000;
var KMONI_IMG_STICKY_MS = 60000;
var KMONI_IMG_BACKOFF_MS = 60000;
var _kmoniImgCache = null;         // { body, contentType, dataTime, source, fetchedAt }
var _kmoniImgPending = [];
var _kmoniImgFetching = false;
var _kmoniImgStickyIdx = -1;       // last working source, reused while fresh
var _kmoniImgStickyUntil = 0;
var _kmoniImgBackoffUntil = 0;
var _kmoniImgDelayMs = 8000;       // rendered frames publish slower than the JSON feed

// GIF87a/89a or PNG magic — anything else (error pages, XML) is not a frame
function _kmoniImgContentType(buf) {
  if (!buf || buf.length < 32) return null;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

// Binary upstream GET (gzip-tolerant, 5 s timeout, 4 MB cap)
function _kmoniImgFetchHttp(url, cb) {
  var https = require('https');
  var settled = false;
  function done(err, buf) {
    if (settled) return;
    settled = true;
    cb(err, buf);
  }
  // req.setTimeout only arms once the socket is connected — the guard below
  // bounds the connect phase as well, so one attempt never exceeds 5 s total
  var guard = setTimeout(function() { req.destroy(new Error('image timeout')); }, 5000);
  function done2(err, buf) { clearTimeout(guard); done(err, buf); }
  var req = https.get(url, {
    agent: _httpsAgent,
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'QuakeSim/5.6 Kmoni Image Proxy' }
  }, function(r) {
    var chunks = [], bodyLen = 0;
    if (r.statusCode !== 200) { r.resume(); done2(new Error('image upstream ' + r.statusCode)); return; }
    r.on('data', function(c) { bodyLen += c.length; if (bodyLen <= 4194304) chunks.push(c); });
    r.on('end', function() {
      if (bodyLen > 4194304) { done2(new Error('image too large')); return; }
      var buf = Buffer.concat(chunks, bodyLen);
      try {
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      } catch(e) { done2(new Error('image inflate failed')); return; }
      done2(null, buf);
    });
    r.on('error', function(e) { done2(e); });
  });
  req.on('error', function(e) { done2(e); });
  req.setTimeout(5000, function() { req.destroy(new Error('image timeout')); });
}
var _kmoniImgFetchFn = _kmoniImgFetchHttp;

function _kmoniImgTrySources(order, cb) {
  if (!order.length) { cb(new Error('all kmoni image sources failed')); return; }
  var idx = order[0];
  var ts = _kmoniJstStrings(Date.now() - _kmoniImgDelayMs);
  _kmoniImgFetchFn(KMONI_IMG_SOURCES[idx].build(ts), function(err, buf) {
    var ctype = err ? null : _kmoniImgContentType(buf);
    if (!ctype) { _kmoniImgTrySources(order.slice(1), cb); return; }
    cb(null, idx, buf, ctype, ts.time);
  });
}

function _kmoniImgServe(res) {
  res.writeHead(200, {
    'Content-Type': _kmoniImgCache.contentType,
    'Cache-Control': 'no-cache',
    'X-Kmoni-Image-Time': _kmoniImgCache.dataTime,
    'X-Kmoni-Image-Source': _kmoniImgCache.source
  });
  res.end(_kmoniImgCache.body);
}

function _kmoniImgUnavailable(res) {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '60' });
  res.end(JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'Kmoni official image unavailable', details: null } }));
}

function _kmoniImgHandle(req, res) {
  var now = Date.now();
  if (_kmoniImgCache && now - _kmoniImgCache.fetchedAt < KMONI_IMG_CACHE_MS) {
    _kmoniImgServe(res);
    return;
  }
  if (now < _kmoniImgBackoffUntil) {
    // Between probe rounds — a stale frame is still better than none
    if (_kmoniImgCache) { _kmoniImgServe(res); return; }
    _kmoniImgUnavailable(res);
    return;
  }
  _kmoniImgPending.push(res);
  if (_kmoniImgFetching) return; // answered when the in-flight probe settles
  _kmoniImgFetching = true;
  var order = [];
  if (_kmoniImgStickyIdx >= 0 && now < _kmoniImgStickyUntil) order.push(_kmoniImgStickyIdx);
  for (var i = 0; i < KMONI_IMG_SOURCES.length; i++) {
    if (order.indexOf(i) < 0) order.push(i);
  }
  _kmoniImgTrySources(order, function(err, idx, buf, ctype, dataTime) {
    _kmoniImgFetching = false;
    if (!err) {
      _kmoniImgCache = { body: buf, contentType: ctype, dataTime: dataTime, source: KMONI_IMG_SOURCES[idx].name, fetchedAt: Date.now() };
      _kmoniImgStickyIdx = idx;
      _kmoniImgStickyUntil = Date.now() + KMONI_IMG_STICKY_MS;
      // success decays the publication-delay estimate back toward 8 s
      _kmoniImgDelayMs = Math.max(8000, _kmoniImgDelayMs - 1000);
    } else {
      _kmoniImgStickyIdx = -1;
      _kmoniImgBackoffUntil = Date.now() + KMONI_IMG_BACKOFF_MS;
      // frames may simply publish later than usual — look further back next round
      _kmoniImgDelayMs = Math.min(30000, _kmoniImgDelayMs + 2000);
    }
    var waiters = _kmoniImgPending.splice(0, _kmoniImgPending.length);
    for (var w = 0; w < waiters.length; w++) {
      var wr = waiters[w];
      if (wr.destroyed) continue;
      if (_kmoniImgCache) _kmoniImgServe(wr); // fresh on success, stale on error
      else _kmoniImgUnavailable(wr);
    }
  });
}

// Start P2PQuake after server is ready
server.on('listening', () => {
  setTimeout(connectP2PQuake, 2000);
  setTimeout(connectWolfxEEW, 3000);
  setTimeout(connectWolfxEqList, 4000);
  setTimeout(connectEMSC, 5000);
  // JMA Feed: initial fetch + every 60s
  pollJMAFeed();
  jmaFeedTimer = setInterval(pollJMAFeed, 60000);
  // Kmoni RT: 1s supervisor tick; fetches only while SSE clients are attached
  _kmoniPollTimer = setInterval(_kmoniPollTick, 1000);
});

// graceful shutdown
var _shuttingDown = false;
var _sseHeartbeatTimer = null;
var _ssePingTimer = null;

function cleanupConnections() {
  _shuttingDown = true;
  saveRateLimits();

  // Disconnect WebSocket onclose handlers to prevent reconnect races during shutdown
  if (p2pWs) { try { p2pWs.removeAllListeners('close'); p2pWs.close(); } catch(e) {} }
  if (p2pReconnectTimer) clearTimeout(p2pReconnectTimer);
  if (wolfxEewWs) { try { wolfxEewWs.removeAllListeners('close'); wolfxEewWs.close(); } catch(e) {} }
  if (wolfxEewTimer) clearTimeout(wolfxEewTimer);
  if (wolfxEqWs) { try { wolfxEqWs.removeAllListeners('close'); wolfxEqWs.close(); } catch(e) {} }
  if (wolfxEqTimer) clearTimeout(wolfxEqTimer);
  if (emscWs) { try { emscWs.removeAllListeners('close'); emscWs.close(); } catch(e) {} }
  if (emscTimer) clearTimeout(emscTimer);
  if (jmaFeedTimer) clearInterval(jmaFeedTimer);
  if (_kmoniPollTimer) { clearInterval(_kmoniPollTimer); _kmoniPollTimer = null; }
  if (_sseHeartbeatTimer) { clearInterval(_sseHeartbeatTimer); _sseHeartbeatTimer = null; }
  if (_ssePingTimer) { clearInterval(_ssePingTimer); _ssePingTimer = null; }
  if (_replayFlushTimer) { clearInterval(_replayFlushTimer); _replayFlushTimer = null; }
  _replayFlushDisk();
  // Destroy keep-alive agents
  try { _httpAgent.destroy(); } catch(e) {}
  try { _httpsAgent.destroy(); } catch(e) {}
  // Clear periodic save timers
  if (_trafficSaveTimer) { clearInterval(_trafficSaveTimer); _trafficSaveTimer = null; }
  if (_rateLimitCleanupTimer) { clearInterval(_rateLimitCleanupTimer); _rateLimitCleanupTimer = null; }
}

function gracefulShutdown() {
  if (_shuttingDown) return;
  console.log('Shutting down...');
  cleanupConnections();
  checkpointUptime();
  saveTraffic();
  // Force-exit after 10s if keep-alive connections don't close
  var forceExit = setTimeout(function() { process.exit(0); }, 10000);
  server.close(function() {
    flushPendingWrites().finally(function() {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

// Proxy dynamic TTS through a fixed, operator-controlled local service. The
// caller can choose text and a whitelisted voice, but never the upstream URL.
function _proxyTtsSynthesis(clientReq, res, text, voice) {
  var cacheKey = voice + '\n' + text;
  var cached = _ttsAudioCache.get(cacheKey);
  if (cached) {
    _ttsAudioCache.delete(cacheKey); _ttsAudioCache.set(cacheKey, cached); // LRU refresh
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(cached.length),
      'Cache-Control': 'public, max-age=86400',
      'X-TTS-Cache': 'HIT'
    });
    res.end(cached);
    return;
  }
  var target;
  try {
    target = new URL(currentTtsUpstream());
  } catch (error) {
    sendError(res, 502, 'UPSTREAM_ERROR', 'TTS service is not configured correctly.');
    return;
  }

  target.searchParams.set('text', text);
  target.searchParams.set('voice', voice);

  // Optional cloud-TTS credential from the settings page (server-side only,
  // never exposed via /api/settings GET). Three common key placements.
  var keyHeaders = {};
  if (localSettings.ttsApiKey) {
    var keyMode = localSettings.ttsApiKeyMode || 'query';
    if (keyMode === 'bearer') keyHeaders['Authorization'] = 'Bearer ' + localSettings.ttsApiKey;
    else if (keyMode === 'x-api-key') keyHeaders['X-API-Key'] = localSettings.ttsApiKey;
    else target.searchParams.set('key', localSettings.ttsApiKey);
  }

  var settled = false;
  var upstreamReq = http.get(target, {
    agent: _httpAgent,
    headers: Object.assign({ 'User-Agent': 'QuakeSim/5.6 TTS Proxy', 'Accept': 'audio/mpeg' }, keyHeaders)
  }, function(upstreamRes) {
    var chunks = [];
    var total = 0;
    upstreamRes.on('data', function(chunk) {
      if (settled) return;
      total += chunk.length;
      if (total > TTS_MAX_AUDIO_BYTES) {
        settled = true;
        upstreamReq.destroy();
        if (!res.destroyed) sendError(res, 502, 'UPSTREAM_ERROR', 'TTS response exceeded the size limit.');
        return;
      }
      chunks.push(chunk);
    });
    upstreamRes.on('end', function() {
      if (settled) return;
      settled = true;
      if (upstreamRes.statusCode !== 200) {
        if (!res.destroyed) sendError(res, 502, 'UPSTREAM_ERROR', 'TTS synthesis service returned an error.');
        return;
      }
      var audio = Buffer.concat(chunks, total);
      // Bounded LRU cache: EEW phrasing repeats heavily, so identical texts
      // should not re-hit the neural upstream. Oversized items skip the cache.
      if (audio.length <= TTS_CACHE_MAX_ITEM_BYTES) {
        _ttsAudioCache.set(cacheKey, audio); _ttsAudioCacheBytes += audio.length;
        while (_ttsAudioCache.size > TTS_CACHE_MAX_ENTRIES || _ttsAudioCacheBytes > TTS_CACHE_MAX_BYTES) {
          var oldestKey = _ttsAudioCache.keys().next().value;
          _ttsAudioCacheBytes -= _ttsAudioCache.get(oldestKey).length;
          _ttsAudioCache.delete(oldestKey);
        }
      }
      var headers = {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.length),
        'Cache-Control': upstreamRes.headers['cache-control'] || 'public, max-age=86400',
        'X-TTS-Cache': 'MISS'
      };
      if (!res.destroyed) {
        res.writeHead(200, headers);
        res.end(audio);
      }
    });
  });
  upstreamReq.on('error', function() {
    if (settled) return;
    settled = true;
    if (!res.destroyed) sendError(res, 502, 'UPSTREAM_ERROR', 'TTS synthesis service is unavailable.');
  });
  upstreamReq.setTimeout(9000, function() {
    if (settled) return;
    upstreamReq.destroy(new Error('TTS upstream timeout'));
  });
  clientReq.once('aborted', function() {
    settled = true;
    upstreamReq.destroy();
  });
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports._test = {
  normalizeIp: normalizeIp,
  getClientIp: getClientIp,
  buildCatalogRequests: buildCatalogRequests,
  buildWaveformArgs: buildWaveformArgs,
  // replay test hooks: inject/reset recorder frames without hitting the wire
  replayPushFrame: function(f) { _replayPushFrame(f); },
  replayReset: function() { _replayFrames = []; _replayHead = 0; _replayByType = {}; },
  replayScanEvents: _replayScanEvents,
  // kmoni image proxy test hooks: stub the wire and reset all caches
  kmoniImageSetFetcher: function(fn) { _kmoniImgFetchFn = (typeof fn === 'function') ? fn : _kmoniImgFetchHttp; },
  kmoniImageReset: function() {
    _kmoniImgCache = null; _kmoniImgPending = []; _kmoniImgFetching = false;
    _kmoniImgStickyIdx = -1; _kmoniImgStickyUntil = 0; _kmoniImgBackoffUntil = 0;
    _kmoniImgDelayMs = 8000;
  },
  kmoniImageContentType: _kmoniImgContentType,
  kmoniImageSources: KMONI_IMG_SOURCES,
  // SSE ping / geoip / export-limit test hooks: shrink the ping interval,
  // stub the geoip upstream, and reset mutable state between tests
  ssePingSetMs: function(ms) { _ssePingStart(ms); },
  geoipSetFetcher: function(fn) { _geoipFetchFn = (typeof fn === 'function') ? fn : _upstreamGet; },
  geoipCache: function() { return _geoipCache; },
  geoipReset: function() { _geoipCache = {}; },
  exportRateLimitReset: function() { _exportRateLimit = {}; }
};
