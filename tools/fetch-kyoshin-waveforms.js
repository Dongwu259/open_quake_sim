#!/usr/bin/env node
'use strict';
// ================================================================
//  Fetch frozen K-NET/KiK-net strong-motion WAVEFORM packages from the
//  NIED Kyoshin portal (https://www.kyoshin.bosai.go.jp) into the bundled
//  research format consumed by public/strong-motion-waveforms.js.
//
//  Raw strong-motion downloads require a (free) registered NIED account:
//  the portal gates every download endpoint behind a token obtained from
//  POST /api/token/get {username,password}. This tool never stores
//  credentials; pass them via --user/--pass or KYOSHIN_USER/KYOSHIN_PASS.
//
//  Usage:
//    node tools/fetch-kyoshin-waveforms.js --event=20240101160813 \
//        --user=YOURID --pass=YOURPASS [--top=40] [--hz=20] \
//        [--datakind=1|2|] [--out=public/geojson/strong-motion-waveforms]
//
//    --event   Kyoshin eqid_id (the radio value from eqsearch results,
//              e.g. 20240101160813 for the 2024 Noto mainshock).
//    --top     stations kept per event, ranked by observed maxacc (default 40)
//    --hz      decimated sample rate of the frozen package (default 20)
//    --datakind '' both / 1 K-NET / 2 KiK-net
//
//  Output: <out>/<eventId>.json (quake-sim-waveform-package-v1) plus a
//  regenerated <out>/index.json listing every frozen event. The per-station
//  payloads inside are WaveformData v1 objects, so the research panel and
//  WaveformData.toObservedMotion() work unchanged.
//
//  Network endpoints verified 2026-08 against the live portal:
//    GET  /ja/eqdownload/                      (csrf + dl_kind DOM)
//    POST /ja/eqdownload/api/eqsearch/         {date_from,date_to,...}
//    POST /ja/eqdownload/api/eqreportsearch/   {eq,datakind}
//    POST /api/token/get                       {username,password} -> refresh
//    POST /ja/eqdownload/download/report/      {eq,select_site,dl_kind,...}
// ================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const BASE = 'https://www.kyoshin.bosai.go.jp';
const OUT_DEFAULT = path.resolve(__dirname, '..', 'public/geojson/strong-motion-waveforms');

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const EVENT_ID = arg('event');
const EVENTS_ALL = arg('events') === 'all';
const MAP_PATH = path.resolve(arg('map', path.join(__dirname, 'data/kyoshin-eqid-map.json')));
const FORCE = process.argv.slice(2).includes('--force');
const USER = arg('user') || process.env.KYOSHIN_USER || '';
const PASS = arg('pass') || process.env.KYOSHIN_PASS || '';
const TOP = Math.max(1, parseInt(arg('top', '40'), 10) || 40);
const HZ = Math.max(1, parseFloat(arg('hz', '20')) || 20);
const DATAKIND = arg('datakind', '');
const OUT_DIR = path.resolve(arg('out', OUT_DEFAULT));

if (!EVENT_ID && !EVENTS_ALL) {
  console.error('usage: node tools/fetch-kyoshin-waveforms.js --event=<eqid_id> --user=.. --pass=.. [--top=40] [--hz=20] [--datakind=1]');
  console.error('       node tools/fetch-kyoshin-waveforms.js --events=all --user=.. --pass=..   (frozen-event batch, resumable)');
  process.exit(1);
}

// ---- tiny cookie jar -------------------------------------------------------
const jar = new Map();
const FETCH_TIMEOUT_MS = 30000, REPORT_TIMEOUT_MS = 180000, DOWNLOAD_TIMEOUT_MS = 600000;
let BEARER = ''; // JWT access token — download endpoints want it as a Bearer header
let BEARER_AT = 0; // ms epoch of BEARER acquisition (access-token TTL is 300 s)
async function fetchT(url, opts, ms) {
  // Cross-border route to bosai.go.jp drops connections outright at times —
  // retry the request (idempotent session/report reads; downloads retry at
  // the chunk level, so a duplicate read here is harmless).
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const o = Object.assign({}, opts, { signal: AbortSignal.timeout(ms || FETCH_TIMEOUT_MS) });
      if (BEARER) o.headers = Object.assign({}, o.headers, { 'Authorization': 'Bearer ' + BEARER });
      return await fetch(url, o);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
  throw lastErr;
}
function absorbCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() { return Array.from(jar, ([k, v]) => k + '=' + v).join('; '); }

async function post(url, form, referer, timeoutMs) {
  const body = new URLSearchParams(form).toString();
  const res = await fetchT(url, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(), 'Referer': referer || BASE + '/ja/eqdownload/',
      'X-Requested-With': 'XMLHttpRequest',
      // streaming responses get cut mid-body when the keep-alive socket is
      // reused on this route — close after each exchange instead
      'Connection': 'close'
    }, body
  }, timeoutMs);
  absorbCookies(res);
  return res;
}
/** Compact curl failure: exit code + last stderr line — execFile's
 *  err.message embeds the whole argv, burying the real reason. */
function curlErr(err) {
  const last = (err.stderr || '').trim().split('\n').pop() || '';
  return 'curl(' + (err.code != null ? err.code : '?') + '): ' + (last || err.message).slice(0, 140);
}

/** POST form fields and save the binary response via a curl subprocess
 *  (streaming robustness — see fetchEvent). Resolves on HTTP 2xx. */
function curlPostZip(url, form, referer, outFile) {
  const { execFile } = require('child_process');
  const args = ['-s', '-S', '--max-time', String(Math.round(DOWNLOAD_TIMEOUT_MS / 1000)),
    '--speed-limit', '1024', '--speed-time', '90', // abort stalls so retries cycle fast
    '--compressed', // if the portal gzips the stream, wire size shrinks under the cut threshold
    '-X', 'POST', url,
    '-H', 'Referer: ' + (referer || BASE + '/ja/eqdownload/'),
    '-b', cookieHeader(),
    '-o', outFile, '-w', '%{http_code}'];
  if (BEARER) args.push('-H', 'Authorization: Bearer ' + BEARER);
  for (const [k, v] of Object.entries(form)) args.push('--data-urlencode', k + '=' + v);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(curlErr(err)));
      const code = String(stdout).trim().slice(-3);
      if (code !== '200') return reject(new Error('download HTTP ' + code));
      resolve();
    });
  });
}

/** Plain GET via curl returning the text body (undici fallback path). */
function curlGetText(url, referer, timeoutMs) {
  const { execFile } = require('child_process');
  const args = ['-s', '-S', '--max-time', String(Math.round((timeoutMs || 60000) / 1000)),
    url, '-H', 'Referer: ' + (referer || BASE + '/ja/'), '-b', cookieHeader()];
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error('curl: ' + (err.stderr || err.message).trim().slice(0, 140)));
      resolve(String(stdout));
    });
  });
}

/** POST form fields via curl and parse the JSON body. On this cross-border
 *  route undici bodies die above ~100 KB ("terminated") while curl survives
 *  every size, so JSON endpoints (eqreportsearch over 1000+ stations) use the
 *  same subprocess engine. Resolves with the parsed object. */
function curlPostJson(url, form, referer, timeoutMs) {
  const { execFile } = require('child_process');
  const outFile = path.join(require('os').tmpdir(), 'qs-kyoshin-json.tmp');
  const args = ['-s', '-S', '--max-time', String(Math.round((timeoutMs || 60000) / 1000)),
    '-X', 'POST', url,
    '-H', 'Referer: ' + (referer || BASE + '/ja/eqdownload/'),
    '-b', cookieHeader(),
    '-o', outFile, '-w', '%{http_code}'];
  if (BEARER) args.push('-H', 'Authorization: Bearer ' + BEARER);
  for (const [k, v] of Object.entries(form)) args.push('--data-urlencode', k + '=' + v);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      let body = '';
      try { body = fs.readFileSync(outFile, 'utf8'); fs.unlinkSync(outFile); } catch (e) {}
      if (err) return reject(new Error('curl: ' + err.message + (body ? ' | ' + body.slice(0, 120) : '')));
      const code = String(stdout).trim().slice(-3);
      if (code !== '200') return reject(new Error('HTTP ' + code + ' ' + body.slice(0, 120)));
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON: ' + body.slice(0, 120))); }
    });
  });
}

async function get(url) {
  const res = await fetchT(url, { redirect: 'manual', headers: { 'Cookie': cookieHeader() } });
  absorbCookies(res);
  return res;
}

// ---- minimal ZIP reader (stored + deflate) ---------------------------------
function unzip(buffer) {
  const b = Buffer.from(buffer);
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65536); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const count = b.readUInt16LE(eocd + 10);
  let ptr = b.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(ptr) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = b.readUInt16LE(ptr + 10);
    const compSize = b.readUInt32LE(ptr + 20);
    const nameLen = b.readUInt16LE(ptr + 28), extraLen = b.readUInt16LE(ptr + 30), commentLen = b.readUInt16LE(ptr + 32);
    const localOff = b.readUInt32LE(ptr + 42);
    const name = b.slice(ptr + 46, ptr + 46 + nameLen).toString('latin1');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (b.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip: bad local header for ' + name);
    const lhName = b.readUInt16LE(localOff + 26), lhExtra = b.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhName + lhExtra;
    const comp = b.slice(dataStart, dataStart + compSize);
    files.push({ name, data: method === 0 ? comp : zlib.inflateRawSync(comp) });
  }
  return files;
}

// ---- K-NET / KiK-net ASCII parsers ------------------------------------------
/**
 * Legacy format: 17 header lines then an 8-values-per-line digit stream;
 * physical gal = digit * scaleNum / scaleDen from the "Scale Factor" line.
 * Newer portal format: a header block ending at "Memo." followed by
 * columnar rows "Time(s) NS EW UD" (gal) — or per-component KiK-net files
 * with two columns (Time(s), gal). Both are handled; the component comes
 * from the "Dir." header when present, else from the file extension.
 */
function parseKyoshinAscii(text) {
  const lines = text.split(/\r?\n/);
  const meta = { comp: null, scale: null, sampleRateHz: null, startTime: null };
  let headerEnd = 0, sawMemo = false;
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const L = lines[i];
    if (/^K-NET, KiK-net/i.test(L)) meta.modern = true;
    const mDir = L.match(/^Dir\.\s*\(?.*?\)?\s*:?\s*([NSEWUD\-]{1,3})/i) || L.match(/^Dir\.\s*:?\s*(\S+)/i);
    if (/^Dir\./i.test(L) && !meta.comp) {
      const d = (mDir && mDir[1] || '').toUpperCase();
      meta.comp = d.includes('N') && d.includes('S') ? 'NS' : d.includes('E') && d.includes('W') ? 'EW' : d.includes('U') && d.includes('D') ? 'UD' : null;
    }
    const mScale = L.match(/Scale Factor\s*:?\s*([\d.]+)\s*\(gal\)\s*\/\s*(\d+)/i);
    if (mScale) meta.scale = { num: parseFloat(mScale[1]), den: parseInt(mScale[2], 10) };
    const mFreq = L.match(/Sampling Freq(?:uency)?\(Hz\)\s*:?\s*([\d.]+)/i);
    if (mFreq) meta.sampleRateHz = parseFloat(mFreq[1]);
    const mTime = L.match(/(?:Record Time|Sta\. Time|Start Time)\s*:?\s*(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/);
    if (mTime) meta.startTime = mTime[1];
    if (/^Memo\.?\s*$/i.test(L.trim()) || /^Memo\./i.test(L)) { sawMemo = true; headerEnd = i + 1; break; }
    // Legacy: 17 fixed header lines, no Memo marker.
    if (!meta.modern && i === 16) { headerEnd = 17; break; }
  }
  if (!sawMemo && !headerEnd) headerEnd = 17;
  const rows = [];
  for (let i = headerEnd; i < lines.length; i++) {
    const vals = lines[i].trim().split(/\s+/).map(Number);
    if (!vals.length || vals.some(v => !isFinite(v))) continue;
    rows.push(vals);
  }
  if (!rows.length) return null;
  // Columnar (modern) files: first column is time.
  if (meta.modern || (rows[0].length >= 2 && rows[rows.length - 1].length === rows[0].length && rows[0][0] === 0)) {
    const cols = rows[0].length;
    const out = [];
    for (const r of rows) out.push(r[r.length - 1]);
    // A 4-column row set carries all three components.
    const trio = cols >= 4 ? { ns: rows.map(r => r[1]), ew: rows.map(r => r[2]), ud: rows.map(r => r[3]) } : null;
    const step = rows.length > 1 ? (rows[rows.length - 1][0] - rows[0][0]) / (rows.length - 1) : 0;
    return { meta, format: 'columnar', sampleRateHz: meta.sampleRateHz || (step > 0 ? 1 / step : null), samples: out, trio };
  }
  // Legacy digit stream (8 per line, one component per file).
  const digits = [];
  for (const r of rows) for (const v of r) digits.push(v);
  if (!meta.scale) return null;
  const gal = digits.map(d => d * meta.scale.num / meta.scale.den);
  return { meta, format: 'legacy-digits', sampleRateHz: meta.sampleRateHz, samples: gal, trio: null };
}

// ---- decimation with true-peak bookkeeping ---------------------------------
function decimate(samples, srcHz, dstHz) {
  const factor = Math.max(1, Math.floor(srcHz / dstHz));
  if (factor === 1) return { samples, truePeak: Math.max(...samples.map(Math.abs)) };
  const out = [], truePeak = 0;
  for (let i = 0; i < samples.length; i += factor) {
    let pick = samples[i], peak = Math.abs(samples[i]);
    for (let k = 1; k < factor && i + k < samples.length; k++) {
      const a = Math.abs(samples[i + k]);
      if (a > peak) { peak = a; pick = samples[i + k]; }
      if (a > truePeak) truePeak = a;
    }
    out.push(pick);
  }
  return { samples: out, truePeak };
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }
function sha256(arr) {
  return crypto.createHash('sha256').update(Buffer.from(new Float64Array(arr).buffer)).digest('hex');
}

// ---- session / per-event pipeline -------------------------------------------
async function openSession() {
  let page;
  try {
    const res = await get(BASE + '/ja/eqdownload/');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    page = await res.text();
  } catch (e) {
    // curl fallback — undici connects die whenever the route flaps
    page = await curlGetText(BASE + '/ja/eqdownload/');
    if (!page || page.indexOf('csrfmiddlewaretoken') < 0) throw new Error('eqdownload page fetch failed (' + e.message + ')');
  }
  const csrf = (page.match(/csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error('csrf token not found on eqdownload page');
  // dl_kind maps to the DOM order of #dls .check_downloads checkboxes;
  // keep the K-NET ASCII one (name dls_ascii / value 1). The attribute
  // order in the served HTML is name-first, so match the whole tag.
  const dlOrder = [...page.matchAll(/<input[^>]*check_downloads[^>]*>/g)]
    .map(m => (m[0].match(/name="(dls_[a-z]+)"/) || [])[1]).filter(Boolean);
  let asciiKind = dlOrder.indexOf('dls_ascii');
  if (asciiKind < 0) {
    // Fallback: index of the first checkbox whose label mentions ASCII.
    const idx = page.indexOf('ASCII');
    if (idx < 0) throw new Error('K-NET ASCII download option not found on page');
    const before = page.slice(0, idx);
    asciiKind = (before.match(/class="check_downloads"/g) || []).length - 1;
  }
  console.log('[1] session + csrf (dl checkboxes:', dlOrder.join(','), '-> ascii index', asciiKind + ')');
  return { csrf, asciiKind };
}

async function login() {
  console.log('[2] login');
  let tok = null;
  try {
    const tokRes = await post(BASE + '/api/token/get', { username: USER, password: PASS }, BASE + '/ja/eqdownload/');
    if (!tokRes.ok) throw new Error('login HTTP ' + tokRes.status);
    tok = await tokRes.json();
  } catch (e) {
    // curl fallback — undici connects die whenever the route flaps
    tok = await curlPostJson(BASE + '/api/token/get',
      { username: USER, password: PASS }, BASE + '/ja/eqdownload/', 30000);
    if (!tok || !tok.access) throw new Error('login failed: ' + e.message + ' / ' + JSON.stringify(tok).slice(0, 120));
  }
  if (!tok || !tok.access) throw new Error('login returned no token: ' + JSON.stringify(tok).slice(0, 200));
  jar.set('token', tok.refresh);
  BEARER = tok.access;
  BEARER_AT = Date.now();
  console.log('    token acquired');
}

async function ensureToken() {
  // The access JWT lives 300 s; long batches outlive it, so refresh well
  // before expiry (login only mints a new token — csrf/cookies stay valid).
  if (BEARER && Date.now() - BEARER_AT < 240000) return;
  await login();
}

async function fetchEvent(sess, eqid, topN) {
  console.log('--- event', eqid);
  // eqreportsearch via the curl engine — undici bodies die on this route
  // ("terminated") for the big multi-hundred-KB JSON of 1000+ station events.
  // Great-event reports over BOTH networks (tohoku ~1050+1050 stations) can
  // also be genuinely slow server-side; K-NET-only still yields the 40
  // strongest picks for the frozen package.
  let report = null;
  for (const datakind of [DATAKIND, '1']) {
    // 3 attempts per datakind: the route also truncates JSON bodies mid-
    // stream (clean early close — curl exit 0, JSON.parse dies), which is
    // very retryable at these sizes.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        report = await curlPostJson(BASE + '/ja/eqdownload/api/eqreportsearch/',
          { csrfmiddlewaretoken: sess.csrf, eq: eqid, datakind }, null, REPORT_TIMEOUT_MS);
        if (report && report.results && report.results.length) break;
        throw new Error('no stations: ' + JSON.stringify(report).slice(0, 200));
      } catch (e) {
        report = null;
        if (attempt < 3) {
          console.log('    report retry', attempt, '(' + e.message.slice(0, 100) + ')');
          await new Promise(r => setTimeout(r, 5000 * attempt));
        } else {
          console.log('    report failed (' + e.message.slice(0, 100) + ')' + (datakind === DATAKIND ? ' — retrying K-NET only' : ''));
        }
      }
    }
    if (report) break;
  }
  if (!report || !report.results || !report.results.length) {
    throw new Error('eqreportsearch exhausted both datakinds');
  }
  const stations = report.results
    .map(s => ({ accdat: s.accdat_id, code: s.sitecode, name: s.sitename, net: s.site_type_name, lat: s.lat, lng: s.lon,
      eqid: s.eqid, maxacc: parseFloat(s.maxacc) || 0 }))
    .sort((a, b) => b.maxacc - a.maxacc)
    .slice(0, topN);
  console.log('    report total', report.total, '-> keeping', stations.length, 'stations; top PGA', stations[0].maxacc, 'gal');

  // select_site entries are "{catalog eqid}_{network}_{sitecode}" — the row's
  // hidden eqid column, NOT accdat_id (which repeats the search eqid on every
  // row and yields a silently empty archive). Downloads go in 10-station
  // chunks: the server streams the ZIP and long transfers drop mid-read
  // ("terminated" / truncated EOCD) far more often than short ones.
  // Downloads run through a curl subprocess: on this route undici's
  // streaming bodies die above ~100 KB ("terminated"/truncated EOCD) while
  // curl (used for every successful multi-MB transfer today) survives.
  console.log('    download ASCII archive (curl engine, adaptive chunks)');
  // Chunk size halves on transport-level failures (reset / truncated ZIP /
  // stall): the cross-border route to bosai.go.jp kills long streaming
  // responses far more often than short ones, so a 10-station tohoku chunk
  // (tens of MB) degrades to single-station archives until one survives.
  // Slicing [c0, c0+size) and advancing by the same size means no station is
  // ever skipped when the shrink happens mid-chunk.
  let chunkSize = 10;
  let files = [];
  const dlTmp = path.join(require('os').tmpdir(), 'qs-kyoshin-chunk.zip');
  for (let c0 = 0; c0 < stations.length; c0 += chunkSize) {
    let chunkFiles = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await ensureToken();
      const chunk = stations.slice(c0, c0 + chunkSize);
      const selectSite = chunk.map(s => s.eqid + '_' + s.net + '_' + s.code).join(',');
      try {
        await curlPostZip(BASE + '/ja/eqdownload/download/report/', {
          csrfmiddlewaretoken: sess.csrf, datakind: DATAKIND,
          eq: eqid, select_site: selectSite, dl_kind: String(sess.asciiKind)
        }, BASE + '/ja/eqdownload/' + eqid + '/', dlTmp);
        const zipBuf = fs.readFileSync(dlTmp);
        if (zipBuf.slice(0, 2).toString('latin1') !== 'PK') {
          throw new Error('not a ZIP (got ' + zipBuf.slice(0, 60).toString('latin1').replace(/\s+/g, ' ') + ')');
        }
        chunkFiles = unzip(zipBuf); // throws on truncated EOCD
        break;
      } catch (e) {
        if (attempt === 6) throw new Error('chunk ' + chunk[0].code + '..: ' + e.message);
        // Halve on every failure except client errors (smaller requests can't
        // fix auth/CSRF) — transport failures here are size-correlated.
        if (chunkSize > 1 && !/HTTP 4\d\d/.test(e.message)) chunkSize = Math.max(1, chunkSize >> 1);
        console.log('    chunk retry', attempt, '(size ' + chunkSize + ') (' + e.message + ')');
        await new Promise(r => setTimeout(r, 8000 * attempt));
      }
    }
    if (chunkFiles && chunkFiles.length) files = files.concat(chunkFiles);
    if (c0 + chunkSize < stations.length) await new Promise(r => setTimeout(r, 1500));
  }
  try { fs.unlinkSync(dlTmp); } catch (e) {}
  console.log('    zip entries:', files.length);

  const byStation = new Map();
  for (const f of files) {
    // K-NET/KiK-net entry names: <code><yymmddhhmm>.<COMP>[<bore-digit>]
    // with COMP in NS/EW/UD; the trailing digit (when present) marks the
    // borehole sensor of a KiK-net pair ('2'; surface may carry '1').
    if (!/\.(NS|EW|UD)\d?$/i.test(f.name) && !/[\d](NS|EW|UD)\d?$/.test(f.name.replace(/\.[^.]*$/, ''))) {
      // still try textual entries — naming varies across portal generations
      if (!/\.(NS|EW|UD)\d?$/i.test(path.extname(f.name).slice(1).toUpperCase()) && !/\.(txt|dat|ascii)$/i.test(f.name)) continue;
    }
    const text = f.data.toString('utf8');
    let parsed = null;
    try { parsed = parseKyoshinAscii(text); } catch (e) { console.warn('      parse failed:', f.name, e.message); }
    if (!parsed) { console.warn('      unparsed:', f.name); continue; }
    // K-NET codes are 3 letters + 3 digits (MYG004); KiK-net codes are
    // 4 letters + 2 digits (FKSH10). The old 3+3-only pattern funneled every
    // KiK-net file into one 'UNK' slot, silently dropping all of them.
    const codeMatch = f.name.match(/([A-Z]{4}\d{2}|[A-Z]{3}\d{3})/);
    const compMatch = f.name.match(/\.(NS|EW|UD)(\d?)$/i) || [];
    let comp = (compMatch[1] || parsed.meta.comp || '').toUpperCase();
    const boreDigit = compMatch[2] || '';
    const station = codeMatch ? codeMatch[1] : 'UNK';
    if (!byStation.has(station)) byStation.set(station, { files: 0, comps: {} });
    const slot = byStation.get(station);
    slot.files++;
    const series = parsed.samples;
    // KiK-net sensor numbering: '1' = downhole, '2' = surface (and K-NET
    // files carry no digit). Verified empirically on the 2026-08-25 frozen
    // set: 258/272 pairs show the digit-'2' records with the larger PGA —
    // unphysical for a borehole, which sits in km/s rock under softer soil.
    if (comp && boreDigit === '1') {
      slot.comps[comp + 'B'] = series; // downhole — separate key for S/B pairs
    } else if (comp) {
      slot.comps[comp] = series;      // '' or '2' — surface
    }
    if (parsed.trio) { slot.comps.NS = parsed.trio.ns; slot.comps.EW = parsed.trio.ew; slot.comps.UD = parsed.trio.ud; }
    slot.srcHz = parsed.sampleRateHz;
  }
  console.log('    stations parsed:', byStation.size);

  const eventInfo = report.results[0];
  const payloads = [];
  for (const s of stations) {
    const slot = byStation.get(s.code);
    if (!slot || !slot.comps.NS || !slot.comps.EW || !slot.comps.UD) continue;
    const srcHz = slot.srcHz || 100;
    if (!(srcHz >= 10)) continue;
    const comp = {};
    for (const [k, series] of Object.entries({ z: slot.comps.UD, n: slot.comps.NS, e: slot.comps.EW })) {
      const dec = decimate(series, srcHz, HZ);
      comp[k] = { samples: dec.samples.map(round6), sha256: sha256(dec.samples) };
      comp[k].truePeakGal = round6(dec.truePeak);
    }
    // KiK-net pairs: freeze the borehole trio alongside the surface one —
    // surface/borehole spectral ratios are the R2 site-response calibration
    // input. Optional field; K-NET-only packages stay byte-compatible.
    let bore = null;
    if (slot.comps.NSB && slot.comps.EWB && slot.comps.UDB) {
      bore = {};
      for (const [k, series] of Object.entries({ z: slot.comps.UDB, n: slot.comps.NSB, e: slot.comps.EWB })) {
        const dec = decimate(series, srcHz, HZ);
        bore[k] = { samples: dec.samples.map(round6), sha256: sha256(dec.samples) };
        bore[k].truePeakGal = round6(dec.truePeak);
      }
    }
    payloads.push({
      _schema: 'quake-sim-waveform-v1', units: 'gal', sampleRateHz: round6(Math.min(srcHz, HZ)),
      startTime: null,
      station: { id: s.code, name: s.name, network: /KiK/i.test(s.net) ? 'KiK-net' : 'K-NET', lat: s.lat, lng: s.lng },
      components: comp,
      borehole: bore,
      provenance: {
        provider: 'NIED K-NET/KiK-net (Kyoshin)', sourceUrl: BASE + '/ja/eqdownload/' + eqid + '/',
        retrievedAt: new Date().toISOString(), eventId: eqid, observedMaxAccGal: s.maxacc
      },
      quality: { researchReady: true, responseRemoved: true, deliveryResampled: srcHz > HZ, sourceGapCount: 0 }
    });
  }
  if (!payloads.length) throw new Error('no complete three-component stations survived parsing');
  const pkg = {
    schema: 'quake-sim-waveform-package-v1', eventId: eqid,
    event: {
      origintime: eventInfo.origintime, lat: eventInfo.org_lat, lng: eventInfo.org_lon,
      depthKm: parseFloat(eventInfo.org_depth != null ? eventInfo.org_depth : eventInfo.depth) || null,
      mag: parseFloat(eventInfo.mag) || null
    },
    sourceSampleRateHz: 'mixed', sampleRateHz: payloads[0].sampleRateHz,
    stations: payloads,
    provenance: { provider: 'NIED K-NET/KiK-net (Kyoshin)', portal: BASE, retrievedAt: new Date().toISOString(), fetchTool: 'tools/fetch-kyoshin-waveforms.js' }
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, eqid + '.json');
  fs.writeFileSync(outFile, JSON.stringify(pkg));
  regenerateIndex();
  return { eqid, stations: payloads.length, file: outFile };
}

function regenerateIndex() {
  const index = { schema: 'quake-sim-waveform-package-index-v1', events: [] };
  for (const f of fs.readdirSync(OUT_DIR).filter(f => /^\d{14}\.json$/.test(f)).sort()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
      if (j.schema === 'quake-sim-waveform-package-v1')
        index.events.push({ id: j.eventId, file: f, stations: j.stations.length, origintime: j.event.origintime, mag: j.event.mag });
    } catch (e) { /* skip unreadable */ }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log('    index lists', index.events.length, 'event(s)');
}

// ---- main -------------------------------------------------------------------
(async function main() {
  if (!USER || !PASS) {
    console.error('K-NET/KiK-net waveform downloads require a registered NIED account.');
    console.error('Pass --user/--pass (or set KYOSHIN_USER / KYOSHIN_PASS). Registration is free:');
    console.error('  https://www.kyoshin.bosai.go.jp/ja/faq/');
    process.exit(2);
  }
  const sess = await openSession();
  await login();

  if (EVENTS_ALL) {
    // Batch mode: walk the frozen-event -> eqid map (tools/find-kyoshin-eqids.js),
    // skipping events whose package already exists so the run is resumable.
    const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    const rows = map.filter(r => r.eqid);
    if (!rows.length) throw new Error('no mapped events in ' + MAP_PATH + ' — run tools/find-kyoshin-eqids.js first');
    console.log('batch:', rows.length, 'mapped events ->', OUT_DIR);
    let ok = 0, skip = 0, fail = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log('[' + (i + 1) + '/' + rows.length + ']', row.eventId);
      const outFile = path.join(OUT_DIR, row.eqid + '.json');
      if (fs.existsSync(outFile) && !FORCE) {
        console.log('    already frozen — skip (--force to refetch)');
        skip++; continue;
      }
      try {
        const summary = await fetchEvent(sess, row.eqid, TOP);
        console.log('    frozen', summary.stations, 'stations ->', summary.file);
        ok++;
      } catch (e) {
        console.error('    event failed:', e.message);
        fail++;
      }
      if (i < rows.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
    console.log('\nbatch done: ' + ok + ' fetched, ' + skip + ' skipped, ' + fail + ' failed');
  } else {
    if (!EVENT_ID) {
      console.error('usage: node tools/fetch-kyoshin-waveforms.js --event=<eqid_id> --user=.. --pass=..');
      console.error('       node tools/fetch-kyoshin-waveforms.js --events=all --user=.. --pass=..   (batch via tools/data/kyoshin-eqid-map.json)');
      process.exit(1);
    }
    const summary = await fetchEvent(sess, EVENT_ID, TOP);
    console.log('frozen', summary.stations, 'stations ->', summary.file);
  }
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
