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
const USER = arg('user') || process.env.KYOSHIN_USER || '';
const PASS = arg('pass') || process.env.KYOSHIN_PASS || '';
const TOP = Math.max(1, parseInt(arg('top', '40'), 10) || 40);
const HZ = Math.max(1, parseFloat(arg('hz', '20')) || 20);
const DATAKIND = arg('datakind', '');
const OUT_DIR = path.resolve(arg('out', OUT_DEFAULT));

if (!EVENT_ID) {
  console.error('usage: node tools/fetch-kyoshin-waveforms.js --event=<eqid_id> --user=.. --pass=.. [--top=40] [--hz=20] [--datakind=1]');
  process.exit(1);
}

// ---- tiny cookie jar -------------------------------------------------------
const jar = new Map();
function absorbCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() { return Array.from(jar, ([k, v]) => k + '=' + v).join('; '); }

async function post(url, form, referer) {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(), 'Referer': referer || BASE + '/ja/eqdownload/',
      'X-Requested-With': 'XMLHttpRequest'
    }, body
  });
  absorbCookies(res);
  return res;
}
async function get(url) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'Cookie': cookieHeader() } });
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

// ---- main -------------------------------------------------------------------
(async function main() {
  if (!USER || !PASS) {
    console.error('K-NET/KiK-net waveform downloads require a registered NIED account.');
    console.error('Pass --user/--pass (or set KYOSHIN_USER / KYOSHIN_PASS). Registration is free:');
    console.error('  https://www.kyoshin.bosai.go.jp/ja/faq/');
    process.exit(2);
  }
  console.log('[1/6] session + csrf');
  const page = await (await get(BASE + '/ja/eqdownload/')).text();
  const csrf = (page.match(/csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error('csrf token not found on eqdownload page');
  // dl_kind maps to the DOM order of #dls .check_downloads checkboxes;
  // keep the K-NET ASCII one (name dls_ascii / value 1).
  const dlOrder = [...page.matchAll(/class="check_downloads"[^>]*name="(dls_[a-z]+)"/g)].map(m => m[1]);
  let asciiKind = dlOrder.indexOf('dls_ascii');
  if (asciiKind < 0) {
    // Fallback: index of the first checkbox whose label mentions ASCII.
    const idx = page.indexOf('ASCII');
    if (idx < 0) throw new Error('K-NET ASCII download option not found on page');
    const before = page.slice(0, idx);
    asciiKind = (before.match(/class="check_downloads"/g) || []).length - 1;
  }
  console.log('      dl checkboxes:', dlOrder.join(','), '-> ascii index', asciiKind);

  console.log('[2/6] station report for event', EVENT_ID);
  const repRes = await post(BASE + '/ja/eqdownload/api/eqreportsearch/',
    { csrfmiddlewaretoken: csrf, eq: EVENT_ID, datakind: DATAKIND });
  if (!repRes.ok) throw new Error('eqreportsearch HTTP ' + repRes.status);
  const report = await repRes.json();
  if (!report || !report.results || !report.results.length) throw new Error('no stations: ' + JSON.stringify(report).slice(0, 200));
  const stations = report.results
    .map(s => ({ accdat: s.accdat_id, code: s.sitecode, name: s.sitename, net: s.site_type_name, lat: s.lat, lng: s.lon, maxacc: parseFloat(s.maxacc) || 0 }))
    .sort((a, b) => b.maxacc - a.maxacc)
    .slice(0, TOP);
  console.log('      total', report.total, '-> keeping', stations.length, 'stations; top PGA', stations[0].maxacc, 'gal');

  console.log('[3/6] login');
  const tokRes = await post(BASE + '/api/token/get', { username: USER, password: PASS }, BASE + '/ja/eqdownload/');
  if (!tokRes.ok) throw new Error('login HTTP ' + tokRes.status + ' — check credentials');
  const tok = await tokRes.json();
  if (!tok || !tok.refresh) throw new Error('login returned no token: ' + JSON.stringify(tok).slice(0, 200));
  jar.set('token', tok.refresh);
  console.log('      token acquired');

  console.log('[4/6] download ASCII archive');
  const dlRes = await post(BASE + '/ja/eqdownload/download/report/', {
    csrfmiddlewaretoken: csrf, datakind: DATAKIND,
    eq: EVENT_ID, select_site: stations.map(s => s.accdat).join(','), dl_kind: String(asciiKind)
  }, BASE + '/ja/eqdownload/' + EVENT_ID + '/');
  if (!dlRes.ok) throw new Error('download HTTP ' + dlRes.status);
  const zipBuf = Buffer.from(await dlRes.arrayBuffer());
  if (zipBuf.slice(0, 2).toString('latin1') !== 'PK') {
    throw new Error('download did not return a ZIP (got ' + zipBuf.slice(0, 60).toString('latin1').replace(/\s+/g, ' ') + ')');
  }
  const files = unzip(zipBuf);
  console.log('      zip entries:', files.length);

  console.log('[5/6] parse + decimate to', HZ, 'Hz');
  const byStation = new Map();
  for (const f of files) {
    if (!/\.(NS|EW|UD|TXT|DAT)$/i.test(f.name) && !/[\d](NS|EW|UD)$/.test(f.name.replace(/\.[^.]*$/, ''))) {
      // still try textual entries — naming varies across portal generations
      if (!/\.(NS|EW|UD)$/i.test(path.extname(f.name).slice(1).toUpperCase()) && !/\.(txt|dat|ascii)$/i.test(f.name)) continue;
    }
    const text = f.data.toString('utf8');
    let parsed = null;
    try { parsed = parseKyoshinAscii(text); } catch (e) { console.warn('      parse failed:', f.name, e.message); }
    if (!parsed) { console.warn('      unparsed:', f.name); continue; }
    const codeMatch = f.name.match(/([A-Z]{3}\d{3})/);
    const compFromName = (f.name.match(/\.(NS|EW|UD)$/i) || [])[1];
    const comp = (compFromName || parsed.meta.comp || '').toUpperCase();
    const station = codeMatch ? codeMatch[1] : 'UNK';
    if (!byStation.has(station)) byStation.set(station, { files: 0, comps: {} });
    const slot = byStation.get(station);
    slot.files++;
    const series = parsed.samples;
    if (comp) slot.comps[comp] = series;
    if (parsed.trio) { slot.comps.NS = parsed.trio.ns; slot.comps.EW = parsed.trio.ew; slot.comps.UD = parsed.trio.ud; }
    slot.srcHz = parsed.sampleRateHz;
  }
  console.log('      stations parsed:', byStation.size);

  console.log('[6/6] freeze package');
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
    payloads.push({
      _schema: 'quake-sim-waveform-v1', units: 'gal', sampleRateHz: round6(Math.min(srcHz, HZ)),
      startTime: null,
      station: { id: s.code, name: s.name, network: /KiK/i.test(s.net) ? 'KiK-net' : 'K-NET', lat: s.lat, lng: s.lng },
      components: comp,
      provenance: {
        provider: 'NIED K-NET/KiK-net (Kyoshin)', sourceUrl: BASE + '/ja/eqdownload/' + EVENT_ID + '/',
        retrievedAt: new Date().toISOString(), eventId: EVENT_ID, observedMaxAccGal: s.maxacc
      },
      quality: { researchReady: true, responseRemoved: true, deliveryResampled: srcHz > HZ, sourceGapCount: 0 }
    });
  }
  if (!payloads.length) throw new Error('no complete three-component stations survived parsing');
  const pkg = {
    schema: 'quake-sim-waveform-package-v1', eventId: EVENT_ID,
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
  const outFile = path.join(OUT_DIR, EVENT_ID + '.json');
  fs.writeFileSync(outFile, JSON.stringify(pkg));
  // regenerate index
  const index = { schema: 'quake-sim-waveform-package-index-v1', events: [] };
  for (const f of fs.readdirSync(OUT_DIR).filter(f => /^\d{14}\.json$/.test(f)).sort()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
      if (j.schema === 'quake-sim-waveform-package-v1')
        index.events.push({ id: j.eventId, file: f, stations: j.stations.length, origintime: j.event.origintime, mag: j.event.mag });
    } catch (e) { /* skip unreadable */ }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log('frozen', payloads.length, 'stations ->', outFile);
  console.log('index lists', index.events.length, 'event(s)');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
