#!/usr/bin/env node
'use strict';
// ================================================================
//  Fetch + parse the NIED KiK-net boring/PS-logging (地盤調査データ) bundle
//  for 1D site-response work (R2), and freeze a per-station velocity-
//  profile JSON for Physics.shTransferFunction.
//
//  Login-gated like the waveform downloads (same free NIED account):
//    POST /api/token/get {username,password}  -> refresh token cookie
//    POST /ja/stationlist/download/soildata/  (datakind=2 -> KiK-net)
//  The response is a ZIP of per-station log files (mixed encodings).
//
//  OUTPUT IS LOCAL-ONLY (.cache/kiknet-logs/): the NIED terms prohibit
//  redistribution of the raw downloads, and the resampled profiles stay
//  conservative (they are near-verbatim derivatives). Consumers read
//    .cache/kiknet-logs/kiknet-ps-logs.json
//    {schema, stations:[{code, name?, rows:[{from,to,vp,vs}], source}], ...}
//
//  Usage:
//    node tools/fetch-kiknet-logs.js --user=.. --pass=.. [--parse-only]
//  --parse-only re-parses an already-downloaded bundle (no network).
// ================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = 'https://www.kyoshin.bosai.go.jp';
const OUT_DIR = path.resolve('.cache/kiknet-logs');

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const USER = arg('user') || process.env.KYOSHIN_USER || '';
const PASS = arg('pass') || process.env.KYOSHIN_PASS || '';

// ---- cookie jar (same pattern as fetch-kyoshin-waveforms.js) ---------------
const jar = new Map();
const FETCH_TIMEOUT_MS = 30000;
function fetchT(url, opts) {
  return fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
}
function absorbCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function postForm(url, form, referer) {
  const body = new URLSearchParams(form).toString();
  const res = await fetchT(url, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': Array.from(jar, ([k, v]) => k + '=' + v).join('; '),
      'Referer': referer || BASE + '/ja/stationlist/',
      'X-Requested-With': 'XMLHttpRequest'
    }, body
  });
  absorbCookies(res);
  return res;
}
async function get(url) {
  const res = await fetchT(url, { redirect: 'manual', headers: { 'Cookie': Array.from(jar, ([k, v]) => k + '=' + v).join('; ') } });
  absorbCookies(res);
  return res;
}

// ---- curl engine (streaming robustness) -------------------------------------
// On the flaky cross-border route to bosai.go.jp, undici bodies die above
// ~100 KB ("terminated") while curl subprocesses survive multi-MB transfers
// — the same lesson as tools/fetch-kyoshin-waveforms.js.
const { execFile } = require('child_process');
function cookieHeader() { return Array.from(jar, ([k, v]) => k + '=' + v).join('; '); }
function curlErr(err) {
  const last = (err.stderr || '').trim().split('\n').pop() || '';
  return 'curl(' + (err.code != null ? err.code : '?') + '): ' + (last || err.message).slice(0, 140);
}
function curlRun(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('curl', args.concat(['-s', '-S', '--max-time', String(Math.round(timeoutMs / 1000)),
      '-b', cookieHeader()]), { maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(curlErr(err)));
      resolve(String(stdout));
    });
  });
}
async function getPage(url) {
  try {
    const res = await get(url);
    if (res.ok) return await res.text();
    throw new Error('HTTP ' + res.status);
  } catch (e) {
    // curl fallback: page HTML is ~100 KB — right at the undici death zone
    const body = await curlRun([url, '-H', 'Referer: ' + BASE + '/ja/'], 60000);
    if (!body || !/<html/i.test(body)) throw new Error('stationlist page fetch failed (' + e.message + ')');
    return body;
  }
}
async function curlPostZip(url, form, referer, outFile, timeoutMs) {
  const args = ['-X', 'POST', url, '-H', 'Referer: ' + referer,
    '--speed-limit', '1024', '--speed-time', '90',
    '-o', outFile, '-w', '%{http_code}'];
  for (const [k, v] of Object.entries(form)) args.push('--data-urlencode', k + '=' + v);
  const code = (await curlRun(args, timeoutMs)).trim().slice(-3);
  if (code !== '200') throw new Error('download HTTP ' + code);
}

// ---- minimal ZIP reader (stored + deflate) ---------------------------------
function unzip(buffer) {
  const b = Buffer.from(buffer);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65536); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const count = b.readUInt16LE(eocd + 10);
  let ptr = b.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(ptr + 10);
    const compSize = b.readUInt32LE(ptr + 20);
    const nameLen = b.readUInt16LE(ptr + 28), extraLen = b.readUInt16LE(ptr + 30), commentLen = b.readUInt16LE(ptr + 32);
    const localOff = b.readUInt32LE(ptr + 42);
    const name = b.slice(ptr + 46, ptr + 46 + nameLen).toString('latin1');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lhName = b.readUInt16LE(localOff + 26), lhExtra = b.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhName + lhExtra;
    const comp = b.slice(dataStart, dataStart + compSize);
    files.push({ name, data: method === 0 ? comp : zlib.inflateRawSync(comp) });
  }
  return files;
}

// ---- PS-log text parser ------------------------------------------------------
// The KiK-net soil-data bundle serves one "<code>_soil_image.txt" per station
// in a strict 5-column comma format (verified against raw samples 2026-08-25):
//     No   Thickness   Depth    Vp      Vs
//     (m)      (m)      (m)    (m/s)   (m/s)
//   1,    2.00,    2.00,  480.00,  180.00
//   ...
//   5, -------, -------, 3120.00, 1870.00    <- halfspace row (Vp/Vs only)
// The strict pass runs first; the legacy tolerant heuristic (below) survives
// only as a fallback. Its 2026-08-25 failure mode: the "No" layer counter is
// monotonic 0..3000 so the depth-column heuristic picked IT, producing
// "depths" of 1..N metres and N-values masquerading as Vs (median log-vs30
// 0.14x observed — caught by the scorecard's vs30 sanity gate).
function parsePsLog(text, fileName) {
  const lines = String(text).split(/\r?\n/);
  // strict pass: 5 comma columns, '-------' allowed in thickness/depth
  const strictRows = [];
  let halfspace = null;
  for (const line of lines) {
    const m = line.match(/^\s*\d+\s*,\s*(-------|-|[\d.]+)\s*,\s*(-------|-|[\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
    if (!m) continue;
    const vp = parseFloat(m[3]), vs = parseFloat(m[4]);
    if (!(vp > 0 && vs > 0)) continue;
    if (m[1].indexOf('-') >= 0 || m[2].indexOf('-') >= 0) { halfspace = { vp, vs }; continue; }
    strictRows.push({ to: parseFloat(m[2]), thickness: parseFloat(m[1]), vp, vs });
  }
  if (strictRows.length >= 2) {
    // unit normalization: a handful of files are in km/s despite the (m/s)
    // header (NGNH07 sample: Vp 5.31) — max Vp < 10 is physically impossible
    // in m/s, so scale the whole file (incl. halfspace) to m/s
    const maxVp = Math.max(...strictRows.map(r => r.vp), halfspace ? halfspace.vp : 0);
    if (maxVp < 10) {
      for (const r of strictRows) { r.vp *= 1000; r.vs *= 1000; }
      if (halfspace) { halfspace.vp *= 1000; halfspace.vs *= 1000; }
    }
    strictRows.sort((a, b) => a.to - b.to);
    const out = [];
    let prev = 0;
    for (const r of strictRows) {
      if (!(r.to > prev)) continue; // dedupe/repeat depths
      out.push({ from: prev, to: r.to, vp: r.vp, vs: r.vs });
      prev = r.to;
    }
    if (out.length >= 2) return { rows: out, anomalies: 0, fileName, halfspace };
  }
  // legacy tolerant fallback (kept for unexpected future variants)
  const numericRows = [];
  for (const line of lines) {
    if (!line || /^[#*"'\-]/.test(line.trim())) continue;
    const cols = line.trim().split(/[\s,;]+/).filter(Boolean);
    if (cols.length < 2) continue;
    const nums = cols.map(c => Number(c));
    if (nums.some(n => !isFinite(n))) continue;
    numericRows.push(nums);
  }
  if (numericRows.length < 3) return null;
  const width = Math.min(...numericRows.map(r => r.length));
  // choose the depth column: best monotonic non-decreasing score within range
  let bestCol = -1, bestScore = -1;
  for (let c = 0; c < width; c++) {
    let mono = 0, ok = true;
    for (let i = 1; i < numericRows.length; i++) {
      const prev = numericRows[i - 1][c], cur = numericRows[i][c];
      if (!(prev >= 0 && prev <= 3000 && cur >= 0 && cur <= 3000)) { ok = false; break; }
      if (cur >= prev) mono++;
    }
    if (!ok) continue;
    const score = mono / (numericRows.length - 1);
    if (score > bestScore) { bestScore = score; bestCol = c; }
  }
  if (bestCol < 0 || bestScore < 0.9) return null;
  const rows = [];
  let anomalies = 0;
  for (const nums of numericRows) {
    const depth = nums[bestCol];
    const velCols = nums.filter((_, i) => i !== bestCol).filter(v => v >= 30 && v <= 9000);
    if (!velCols.length) continue;
    const vp = Math.max(...velCols), vs = Math.min(...velCols);
    if (vs > vp) { anomalies++; continue; }
    rows.push({ from: depth, vp, vs });
  }
  if (rows.length < 3) return null;
  rows.sort((a, b) => a.from - b.from);
  // build intervals + dedupe identical depths
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const to = i + 1 < rows.length ? rows[i + 1].from : rows[i].from + 2;
    if (out.length && Math.abs(out[out.length - 1].from - rows[i].from) < 1e-9) continue;
    out.push({ from: rows[i].from, to, vp: rows[i].vp, vs: rows[i].vs });
  }
  return { rows: out, anomalies, fileName };
}

// ---- main -------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const parsedOut = path.join(OUT_DIR, 'kiknet-ps-logs.json');

  if (!process.argv.includes('--parse-only') && !process.argv.some(a => a.startsWith('--parse-dir='))) {
    if (!USER || !PASS) {
      console.error('KiK-net soil data requires the registered NIED account (--user/--pass or KYOSHIN_USER/KYOSHIN_PASS).');
      process.exit(2);
    }
    const page = await getPage(BASE + '/ja/stationlist/');
    const csrf = (page.match(/csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
    if (!csrf) throw new Error('csrf token not found on stationlist page');
    let tok = null;
    try {
      const tokRes = await postForm(BASE + '/api/token/get', { username: USER, password: PASS }, BASE + '/ja/stationlist/');
      if (!tokRes.ok) throw new Error('login HTTP ' + tokRes.status);
      tok = await tokRes.json();
    } catch (e) {
      // curl fallback — undici connects die whenever the route flaps
      const body = await curlRun(['-X', 'POST', BASE + '/api/token/get',
        '-H', 'Referer: ' + BASE + '/ja/stationlist/',
        '--data-urlencode', 'username=' + USER, '--data-urlencode', 'password=' + PASS], 30000);
      try { tok = JSON.parse(body); } catch (e2) { throw new Error('login failed: ' + e.message + ' / ' + body.slice(0, 120)); }
    }
    if (!tok || !tok.refresh) throw new Error('login returned no refresh token — check credentials / approval status');
    jar.set('token', tok.refresh);
    console.log('[1/3] logged in, requesting KiK-net soil data (datakind=2)');
    // The bundle ZIP runs multi-MB — curl engine with retries (undici dies on
    // this route for large bodies; see fetch-kyoshin-waveforms.js).
    const zipPath = path.join(OUT_DIR, 'soildata-kiknet.zip');
    let ok = false, lastErr = null;
    for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
      try {
        await curlPostZip(BASE + '/ja/stationlist/download/soildata/', {
          csrfmiddlewaretoken: csrf, datakind: '2'
        }, BASE + '/ja/stationlist/', zipPath, 900000);
        const zipBuf = fs.readFileSync(zipPath);
        if (zipBuf.slice(0, 2).toString('latin1') !== 'PK')
          throw new Error('not a ZIP: ' + zipBuf.slice(0, 80).toString('latin1').replace(/\s+/g, ' '));
        if (unzip(zipBuf).length < 10) throw new Error('suspiciously few zip entries');
        ok = true;
        console.log('[2/3] saved', (zipBuf.length / 1048576).toFixed(1) + ' MB ->', zipPath);
      } catch (e) {
        lastErr = e;
        if (attempt < 5) { console.log('    retry', attempt, '(' + e.message + ')'); await new Promise(r => setTimeout(r, 10000 * attempt)); }
      }
    }
    if (!ok) throw new Error('soildata download failed: ' + (lastErr && lastErr.message));
  }

  console.log('[3/3] parsing');
  // --parse-dir walks an extracted soil_data tree (soil_data_KiK-net/kik/
  // <CODE>/<CODE>_soil_image.txt) instead of the local ZIP — used when the
  // raw text files arrive by relay
  const parseDir = arg('parse-dir', '');
  let files;
  if (parseDir) {
    const root = path.resolve(parseDir);
    files = [];
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/_soil_image\.txt$/i.test(e.name)) files.push({ name: e.name, data: fs.readFileSync(p) });
      }
    };
    if (!fs.existsSync(root)) throw new Error('parse-dir not found: ' + root);
    walk(root);
    if (!files.length) throw new Error('no *_soil_image.txt under ' + root);
  } else {
    const zipPath = path.join(OUT_DIR, 'soildata-kiknet.zip');
    if (!fs.existsSync(zipPath)) throw new Error('no bundle — run without --parse-only first (or use --parse-dir)');
    files = unzip(fs.readFileSync(zipPath));
  }
  const stations = [];
  for (const f of files) {
    // encodings vary (UTF-8 / Shift-JIS); velocity tables are ASCII either way
    let text = f.data.toString('utf8');
    const codeMatch = f.name.match(/([A-Z]{2,3}[A-Z0-9]\d{2,3})/);
    const code = codeMatch ? codeMatch[1] : path.basename(f.name, path.extname(f.name));
    const parsed = parsePsLog(text, f.name);
    if (!parsed) {
      // retry as Shift-JIS before giving up
      try { text = new TextDecoder('shift-jis').decode(f.data); } catch (e) { /* keep utf8 */ }
      const retry = parsePsLog(text, f.name);
      if (!retry) continue;
      stations.push({ code, ...retry });
    } else {
      stations.push({ code, ...parsed });
    }
  }
  const doc = {
    schema: 'quake-sim-kiknet-ps-logs-v1',
    provenance: {
      provider: 'NIED KiK-net 地盤調査データ (boring / PS logging)',
      sourceUrl: BASE + '/ja/stationlist/download/soildata/ (datakind=2)',
      retrievedAt: new Date().toISOString(),
      license: 'NIED terms — no redistribution; LOCAL-ONLY file, never commit',
      fetchTool: 'tools/fetch-kiknet-logs.js'
    },
    stations
  };
  fs.writeFileSync(parsedOut, JSON.stringify(doc));
  const withRows = stations.filter(s => s.rows.length >= 3).length;
  console.log('parsed', withRows, 'of', files.length, 'files ->', parsedOut);
  console.log('per-station interval counts: min/median/max',
    Math.min(...stations.map(s => s.rows.length)),
    stations.map(s => s.rows.length).sort((a, b) => a - b)[Math.floor(stations.length / 2)],
    Math.max(...stations.map(s => s.rows.length)));
}

if (require.main === module) {
  main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}

// Exported for tests (require('./tools/fetch-kiknet-logs.js').parsePsLog).
if (typeof module !== 'undefined' && module.exports) module.exports = { parsePsLog, unzip };
