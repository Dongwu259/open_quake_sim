'use strict';
// ================================================================
//  Replay-driven auto-sim accuracy scorecard.
//
//  Replays the SSE recordings (recordings/YYYYMMDD.jsonl.gz, one JSON
//  frame per line: {"t":ms,"type":...,"event":{...}}) and scores what an
//  EEW-driven auto-sim would have been working with:
//
//    1. Report convergence — per EventID, every jma_eew report is scored
//       against the event "truth" (JMA catalog hypocenter from a P2P 551
//       bulletin or the Wolfx jma_eqlist when recorded; otherwise the EEW
//       final report): position error km, magnitude error, depth error km,
//       seconds since the first report.
//    2. Intensity accuracy — the FINAL report's hypocenter/magnitude feed
//       the Zhao 2006 GMPE at all 1725 Kmoni stations; predicted JMA
//       instrumental intensity is compared with the per-station peak
//       intensity decoded from kmoni_rt frames inside the event window.
//
//  Usage: node tools/scorecard-autosim.js [recordings...]
//           --sitelist=path   local sitelist JSON (skips the network fetch)
//           --out=path        report destination (default tools/data/autosim-scorecard-report.json)
//         With no file arguments every recordings/*.jsonl* file is read.
//         Quiet recordings (no scoreable EEW event) exit 0 with a notice.
// ================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'tools', 'data', 'autosim-scorecard-report.json');
const SITELIST_URLS = [
  'https://weather-kyoshin.east.edge.storage-yahoo.jp/SiteList/sitelist.json',
  'https://www.kyoshin.bosai.go.jp/kyoshin/SiteList/sitelist.json'
];

// Tuning knobs (documented in the report so runs stay comparable).
const TRUTH_TIME_TOL_MS = 300000;  // 551 bulletin origin time within ±5 min of the EEW origin
const TRUTH_DIST_TOL_KM = 200;     // ... and within 200 km, else the pairing is rejected
const WINDOW_PRE_MS = 120000;      // kmoni window: 2 min before the origin/first report
const WINDOW_POST_MS = 600000;     // ... through 10 min after the last report (shaking + coda)
const FELT_MIN_INTENSITY = 0.5;    // "felt" subset: max(obs, pred) >= shindo-1 threshold

// ----------------------------------------------------------------
//  Pure helpers (exported for tests)
// ----------------------------------------------------------------

// 'YYYY/MM/DD HH:mm:ss[.SSS]' in JST (UTC+9) -> epoch ms; NaN on failure.
// Same contract as rt-data.js parseJstTime.
function parseJstTime(s) {
  if (!s) return NaN;
  return Date.parse(String(s).replace(/\//g, '-').replace(' ', 'T') + '+09:00');
}

// NIED realtime-intensity string: level = charCodeAt - 100, clamped [-1, 20]
// (-1 = no data). Mirrors rt-kmoni.js decodeIntensity.
function decodeIntensityString(str) {
  const n = (typeof str === 'string') ? str.length : 0;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = str.charCodeAt(i) - 100;
    if (v < 0) v = -1;
    else if (v > 20) v = 20;
    out[i] = v;
  }
  return out;
}

// kmoni level -> JMA instrumental intensity. The level scale follows
// level = 2*I + 6 (see rt-demo.js peakLevelFor), so invert it.
function levelToIntensity(level) { return (level - 6) / 2; }

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Parse one recording body (NDJSON text) into frames; bad lines are skipped.
function parseFrames(text) {
  const frames = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const f = JSON.parse(line);
      if (f && typeof f.t === 'number' && f.event) frames.push(f);
    } catch (_) { /* corrupt line — skip */ }
  }
  return frames;
}

function readRecordingFile(file) {
  let buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return parseFrames(buf.toString('utf8'));
}

// ----------------------------------------------------------------
//  EEW event assembly
// ----------------------------------------------------------------

function isEewFrame(f) {
  if (f.type === 'wolfx_eew') return f.event && f.event.type === 'jma_eew';
  if (f.type === 'jma_eew') return true; // normalized passthrough, if ever recorded
  return false;
}

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

// One report, tolerant of the raw Wolfx schema ('Magunitude' typo) and the
// normalized rt-data shape (mag/lat/lng/depth).
function reportFromFrame(f) {
  const e = f.event;
  const lat = num(e.Latitude != null ? e.Latitude : e.lat);
  const lng = num(e.Longitude != null ? e.Longitude : e.lng);
  const mag = num(e.Magunitude != null ? e.Magunitude : (e.Magnitude != null ? e.Magnitude : e.mag));
  const depth = num(e.Depth != null ? e.Depth : e.depth);
  return {
    serial: num(e.Serial) || 0,
    t: f.t,
    lat: lat, lng: lng, mag: mag, depth: depth,
    originMs: parseJstTime(e.OriginTime),
    isFinal: !!e.isFinal,
    isCancel: !!e.isCancel,
    isWarn: !!(e.isWarn || e.isWarning),
    isAssumption: !!e.isAssumption,
    isSea: !!e.isSea
  };
}

// Group jma_eew reports by EventID. Training/assumption-probe events are
// dropped; cancel-terminated events are reported but not scored.
function collectEewEvents(frames) {
  const byId = new Map();
  let training = 0;
  for (const f of frames) {
    if (!isEewFrame(f)) continue;
    const e = f.event;
    if (e.isTraining) { training++; continue; }
    const id = String(e.EventID || e.id || '');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(reportFromFrame(f));
  }
  const events = [];
  for (const [id, reports] of byId) {
    reports.sort((a, b) => (a.serial - b.serial) || (a.t - b.t));
    // Wolfx resends the full recent-EEW history on reconnect, so recordings
    // carry retransmitted copies of the same serial ~minutes apart. A resend
    // is not new information — drop identical-signature duplicates, keep the
    // earliest arrival. (A genuine correction with the same serial but new
    // values survives: the signature differs.)
    const seen = new Set();
    const deduped = reports.filter(r => {
      const key = [r.serial, r.lat, r.lng, r.mag, r.depth, r.isFinal, r.isCancel].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const last = deduped[deduped.length - 1];
    events.push({
      eventId: id,
      reports: deduped,
      retransmissions: reports.length - deduped.length,
      cancelled: last.isCancel,
      validReports: deduped.filter(r => r.lat != null && r.lng != null && r.mag != null)
    });
  }
  events.sort((a, b) => a.reports[0].t - b.reports[0].t);
  return { events: events, trainingReports: training };
}

// Final report = isFinal, else the highest serial.
function finalReportOf(event) {
  const valid = event.validReports;
  if (!valid.length) return null;
  for (let i = valid.length - 1; i >= 0; i--) if (valid[i].isFinal) return valid[i];
  return valid[valid.length - 1];
}

// ----------------------------------------------------------------
//  Catalog truth (JMA 551 via P2P, or the Wolfx jma_eqlist)
// ----------------------------------------------------------------

function collectCatalogEntries(frames) {
  const p2p = [], eqlist = [];
  for (const f of frames) {
    if (f.type === 'p2pquake' && f.event && f.event.code === 551) {
      const e = f.event;
      const lat = num(e.lat), lng = num(e.lng), mag = num(e.mag);
      const originMs = parseJstTime(e.originTime);
      if (lat == null || lng == null || mag == null || !mag || isNaN(originMs)) continue;
      if (e.cancelled) continue;
      p2p.push({
        source: 'p2pquake-551', lat: lat, lng: lng, mag: mag,
        depth: num(e.depth), originMs: originMs, t: f.t,
        issueType: e.issueType || '', place: e.place || ''
      });
    } else if (f.type === 'wolfx_eq' && f.event) {
      const e = f.event;
      const lat = num(e.latitude), lng = num(e.longitude), mag = num(e.magnitude);
      if (lat == null || lng == null || mag == null || !e.EventID) continue;
      eqlist.push({
        source: 'wolfx-eqlist', eventId: String(e.EventID), lat: lat, lng: lng, mag: mag,
        depth: num(String(e.depth || '').replace('km', '')),
        originMs: parseJstTime(e.time_full || e.time), t: f.t, place: e.location || ''
      });
    }
  }
  return { p2p: p2p, eqlist: eqlist };
}

// Truth precedence: exact eqlist EventID match, then the best 551 bulletin
// (DetailScale first, then closest in origin time) inside the tolerance
// window, else the EEW final report itself.
function findTruth(event, catalog) {
  const eq = catalog.eqlist.find(c => c.eventId === event.eventId);
  if (eq) return eq;
  const finalRep = finalReportOf(event);
  const refOriginMs = (finalRep && !isNaN(finalRep.originMs)) ? finalRep.originMs
    : (event.reports[0] ? event.reports[0].t : NaN);
  const refLat = finalRep && finalRep.lat, refLng = finalRep && finalRep.lng;
  if (!isNaN(refOriginMs) && refLat != null && refLng != null) {
    let best = null, bestKey = null;
    for (const c of catalog.p2p) {
      const dt = Math.abs(c.originMs - refOriginMs);
      if (dt > TRUTH_TIME_TOL_MS) continue;
      const dist = haversineKm(refLat, refLng, c.lat, c.lng);
      if (dist > TRUTH_DIST_TOL_KM) continue;
      // DetailScale carries the reviewed hypocenter; prefer it over earlier types.
      const key = [(c.issueType === 'DetailScale' ? 0 : 1), dt + dist * 1000];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = c; bestKey = key;
      }
    }
    if (best) return best;
  }
  if (finalRep) {
    return {
      source: 'eew-final', lat: finalRep.lat, lng: finalRep.lng, mag: finalRep.mag,
      depth: finalRep.depth, originMs: finalRep.originMs, t: finalRep.t, place: ''
    };
  }
  return null;
}

// ----------------------------------------------------------------
//  Convergence scoring
// ----------------------------------------------------------------

function scoreEventConvergence(event, truth) {
  const first = event.validReports[0];
  const rows = event.validReports.map(r => ({
    serial: r.serial,
    dtSinceFirstS: +(((r.t - first.t) / 1000).toFixed(1)),
    dtSinceOriginS: !isNaN(r.originMs) ? +(((r.t - r.originMs) / 1000).toFixed(1)) : null,
    lat: r.lat, lng: r.lng, mag: r.mag, depthKm: r.depth,
    posErrKm: +haversineKm(r.lat, r.lng, truth.lat, truth.lng).toFixed(1),
    magErr: +(r.mag - truth.mag).toFixed(2),
    depthErrKm: (r.depth != null && truth.depth != null) ? +(r.depth - truth.depth).toFixed(1) : null,
    isFinal: r.isFinal, isWarn: r.isWarn, isAssumption: r.isAssumption
  }));
  return {
    reports: rows,
    first: rows[0] || null,
    final: rows[rows.length - 1] || null,
    reportCount: rows.length
  };
}

// ----------------------------------------------------------------
//  Intensity scoring (final-report GMPE vs kmoni window max)
// ----------------------------------------------------------------

// Per-station peak intensity inside [t0, t1]. Returns NaN for stations with
// no in-window data. `kmoniFrames` = [{t, intensity}] pre-filtered refs.
function stationPeakIntensities(kmoniFrames, stationCount, t0, t1) {
  const maxLevel = new Int16Array(stationCount).fill(-1);
  let used = 0;
  for (const f of kmoniFrames) {
    if (f.t < t0 || f.t > t1) continue;
    const levels = decodeIntensityString(f.intensity);
    if (levels.length !== stationCount) continue; // sitelist/config mismatch
    used++;
    for (let i = 0; i < stationCount; i++) {
      if (levels[i] > maxLevel[i]) maxLevel[i] = levels[i];
    }
  }
  const out = new Float64Array(stationCount).fill(NaN);
  for (let i = 0; i < stationCount; i++) {
    if (maxLevel[i] >= 0) out[i] = Math.max(0, levelToIntensity(maxLevel[i]));
  }
  return { obs: out, framesUsed: used };
}

// Zhao 2006 prediction at every station for one source (final report).
// Mirrors rt-kmoni.js predictStationShindo: hypocentral distance, default
// site class (no Vs30), source type from depth + offshore flag.
function gmpePredictions(stations, params) {
  const src = Physics.resolveSourceTypeAt(params.lat, params.lng, params.depthKm, null, null, !!params.isSea);
  const pred = new Float64Array(stations.length);
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const lat = Array.isArray(st) ? st[0] : st.lat;
    const lng = Array.isArray(st) ? st[1] : st.lng;
    const surf = haversineKm(params.lat, params.lng, lat, lng);
    const rHyp = Math.sqrt(surf * surf + params.depthKm * params.depthKm);
    const pga = Physics.pgaZhao2006(params.mag, rHyp, params.depthKm, src);
    const pgv = Physics.pgvZhao2006(params.mag, rHyp, params.depthKm, src);
    pred[i] = Physics.calcJmaIntensity(pga, pgv);
  }
  return { pred: pred, srcType: src };
}

// Residual statistics (predicted - observed). `felt` restricts to stations
// where either side reaches shindo 1 so 1700 quiet stations don't swamp RMS.
function intensityStats(pred, obs) {
  const all = { n: 0, sum: 0, sq: 0, abs: 0, within05: 0, within10: 0 };
  const felt = { n: 0, sum: 0, sq: 0, abs: 0, within05: 0, within10: 0 };
  let maxObs = -Infinity, maxPred = -Infinity;
  for (let i = 0; i < obs.length; i++) {
    if (isNaN(obs[i])) continue;
    const d = pred[i] - obs[i];
    if (obs[i] > maxObs) maxObs = obs[i];
    if (pred[i] > maxPred) maxPred = pred[i];
    const acc = [all];
    if (obs[i] >= FELT_MIN_INTENSITY || pred[i] >= FELT_MIN_INTENSITY) acc.push(felt);
    for (const a of acc) {
      a.n++; a.sum += d; a.sq += d * d; a.abs += Math.abs(d);
      if (Math.abs(d) <= 0.5) a.within05++;
      if (Math.abs(d) <= 1.0) a.within10++;
    }
  }
  const fin = a => a.n ? {
    n: a.n,
    rms: +Math.sqrt(a.sq / a.n).toFixed(3),
    bias: +(a.sum / a.n).toFixed(3),
    meanAbs: +(a.abs / a.n).toFixed(3),
    within05Pct: +(100 * a.within05 / a.n).toFixed(1),
    within10Pct: +(100 * a.within10 / a.n).toFixed(1)
  } : { n: 0, rms: null, bias: null, meanAbs: null, within05Pct: null, within10Pct: null };
  return {
    all: fin(all), felt: fin(felt),
    maxObs: maxObs === -Infinity ? null : +maxObs.toFixed(2),
    maxPred: maxPred === -Infinity ? null : +maxPred.toFixed(2)
  };
}

// ----------------------------------------------------------------
//  Whole-run report
// ----------------------------------------------------------------

function buildReport(frames, opts) {
  opts = opts || {};
  const stations = opts.stations || null; // [[lat,lng],...] or null
  const { events, trainingReports } = collectEewEvents(frames);
  const catalog = collectCatalogEntries(frames);
  const kmoniFrames = [];
  for (const f of frames) {
    if (f.type === 'kmoni_rt' && f.event && typeof f.event.intensity === 'string') {
      kmoniFrames.push({ t: f.t, intensity: f.event.intensity });
    }
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    thresholds: {
      truthTimeTolMs: TRUTH_TIME_TOL_MS, truthDistTolKm: TRUTH_DIST_TOL_KM,
      windowPreMs: WINDOW_PRE_MS, windowPostMs: WINDOW_POST_MS,
      feltMinIntensity: FELT_MIN_INTENSITY
    },
    trainingReportsSkipped: trainingReports,
    events: [],
    cancelledEvents: [],
    noEvents: false
  };

  for (const ev of events) {
    if (ev.cancelled) { report.cancelledEvents.push(ev.eventId); continue; }
    if (!ev.validReports.length) continue;
    const truth = findTruth(ev, catalog);
    if (!truth) continue;
    const conv = scoreEventConvergence(ev, truth);

    let intensity = { available: false, reason: 'no sitelist' };
    const fin = finalReportOf(ev);
    if (stations && fin && fin.depth != null) {
      const originMs = !isNaN(fin.originMs) ? fin.originMs : ev.reports[0].t;
      const t0 = Math.min(originMs, ev.reports[0].t) - WINDOW_PRE_MS;
      const t1 = Math.max(ev.reports[ev.reports.length - 1].t, originMs) + WINDOW_POST_MS;
      const { obs, framesUsed } = stationPeakIntensities(kmoniFrames, stations.length, t0, t1);
      if (!framesUsed) {
        intensity = { available: false, reason: 'no kmoni frames in window', windowStart: t0, windowEnd: t1 };
      } else {
        const { pred, srcType } = gmpePredictions(stations, {
          lat: fin.lat, lng: fin.lng, mag: fin.mag, depthKm: fin.depth, isSea: fin.isSea
        });
        intensity = Object.assign({
          available: true, srcType: srcType,
          windowStart: new Date(t0).toISOString(), windowEnd: new Date(t1).toISOString(),
          kmoniFrames: framesUsed,
          input: { lat: fin.lat, lng: fin.lng, mag: fin.mag, depthKm: fin.depth, source: 'eew-final' }
        }, intensityStats(pred, obs));
      }
    }

    report.events.push({
      eventId: ev.eventId,
      truthSource: truth.source,
      retransmissionsDropped: ev.retransmissions,
      truth: {
        lat: truth.lat, lng: truth.lng, mag: truth.mag,
        depthKm: truth.depth != null ? truth.depth : null,
        originTime: !isNaN(truth.originMs) ? new Date(truth.originMs).toISOString() : null,
        place: truth.place || ''
      },
      convergence: conv,
      intensity: intensity
    });
  }
  report.noEvents = report.events.length === 0;
  return report;
}

// ----------------------------------------------------------------
//  Sitelist loading (network, gzip-aware; or --sitelist=path)
// ----------------------------------------------------------------

function fetchBuffer(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'QuakeSim/5.3 AutosimScorecard' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(fetchBuffer(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try {
          if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
          resolve(buf);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function loadSitelist(localPath) {
  if (localPath) {
    const json = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const items = Array.isArray(json) ? json : json.items;
    return { items: items, source: localPath };
  }
  let lastErr = null;
  for (const url of SITELIST_URLS) {
    try {
      const buf = await fetchBuffer(url, 2);
      const json = JSON.parse(buf.toString('utf8'));
      const items = Array.isArray(json) ? json : json.items;
      if (Array.isArray(items) && items.length) return { items: items, source: url };
      lastErr = new Error(url + ' -> empty sitelist');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('sitelist unavailable');
}

// ----------------------------------------------------------------
//  CLI
// ----------------------------------------------------------------

function fmtSigned(v, digits) {
  if (v == null) return '  —  ';
  const s = v.toFixed(digits == null ? 1 : digits);
  return (v >= 0 ? '+' : '') + s;
}

function printReport(report) {
  if (report.noEvents) {
    console.log('No scoreable EEW events in the given recordings (quiet period).');
    if (report.trainingReportsSkipped) {
      console.log('(' + report.trainingReportsSkipped + ' training/test EEW reports skipped.)');
    }
    if (report.cancelledEvents.length) {
      console.log('Cancelled events excluded: ' + report.cancelledEvents.join(', '));
    }
    return;
  }
  for (const ev of report.events) {
    const tr = ev.truth;
    console.log('='.repeat(78));
    console.log('EEW event ' + ev.eventId + '  truth[' + ev.truthSource + ']: ' +
      'M' + tr.mag + ' ' + tr.lat.toFixed(3) + ',' + tr.lng.toFixed(3) +
      ' ' + (tr.depthKm != null ? tr.depthKm + 'km' : '?') +
      (tr.place ? '  ' + tr.place : ''));
    console.log('-'.repeat(78));
    console.log(' serial  dt_1st(s)  dt_org(s)  posErr(km)   magErr  depthErr(km)  flags');
    for (const r of ev.convergence.reports) {
      const flags = [r.isFinal ? 'final' : '', r.isWarn ? 'warn' : '', r.isAssumption ? 'assumed' : '']
        .filter(Boolean).join(',');
      console.log(
        String(r.serial).padStart(7) +
        String(r.dtSinceFirstS.toFixed(1)).padStart(11) +
        (r.dtSinceOriginS == null ? '      —' : r.dtSinceOriginS.toFixed(1).padStart(11)) +
        r.posErrKm.toFixed(1).padStart(12) +
        fmtSigned(r.magErr, 2).padStart(9) +
        (r.depthErrKm == null ? '        —' : fmtSigned(r.depthErrKm, 1).padStart(14)) +
        (flags ? '  ' + flags : ''));
    }
    const c = ev.convergence;
    if (c.first && c.final && c.reportCount > 1) {
      console.log(' convergence: posErr ' + c.first.posErrKm + 'km -> ' + c.final.posErrKm +
        'km over ' + c.reportCount + ' reports / ' + c.final.dtSinceFirstS + 's');
    }
    const it = ev.intensity;
    if (it && it.available) {
      console.log(' intensity (final report, Zhao2006/' + it.srcType + ', ' + it.kmoniFrames + ' kmoni frames):');
      console.log('   maxObs=' + it.maxObs + ' maxPred=' + it.maxPred +
        '  felt(n=' + it.felt.n + '): rms=' + it.felt.rms + ' bias=' + fmtSigned(it.felt.bias, 3) +
        ' within±0.5=' + it.felt.within05Pct + '% within±1.0=' + it.felt.within10Pct + '%');
      console.log('   all-stations(n=' + it.all.n + '): rms=' + it.all.rms + ' bias=' + fmtSigned(it.all.bias, 3) +
        ' within±0.5=' + it.all.within05Pct + '%');
    } else {
      console.log(' intensity: unavailable (' + (it && it.reason) + ')');
    }
  }
  console.log('='.repeat(78));
  // Aggregate across events.
  const finals = report.events.map(e => e.convergence.final).filter(Boolean);
  const firsts = report.events.map(e => e.convergence.first).filter(Boolean);
  const mean = arr => arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2) : null;
  console.log('AGGREGATE  events=' + report.events.length +
    '  mean first posErr=' + mean(firsts.map(r => r.posErrKm)) + 'km' +
    '  mean final posErr=' + mean(finals.map(r => r.posErrKm)) + 'km' +
    '  mean final magErr=' + fmtSigned(mean(finals.map(r => r.magErr)), 2) +
    '  mean final depthErr=' + fmtSigned(mean(finals.map(r => r.depthErrKm).filter(v => v != null)), 1) + 'km');
  const scored = report.events.filter(e => e.intensity && e.intensity.available);
  if (scored.length) {
    console.log('AGGREGATE intensity  scoredEvents=' + scored.length +
      '  mean felt rms=' + mean(scored.map(e => e.intensity.felt.rms)) +
      '  mean felt bias=' + fmtSigned(mean(scored.map(e => e.intensity.felt.bias)), 3) +
      '  mean felt within±0.5=' + mean(scored.map(e => e.intensity.felt.within05Pct)) + '%');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--'));
  const sitelistArg = args.find(a => a.startsWith('--sitelist='));
  const outArg = args.find(a => a.startsWith('--out='));
  const outPath = outArg ? path.resolve(outArg.split('=')[1]) : DEFAULT_OUT;

  let inputs = files;
  if (!inputs.length) {
    const dir = path.join(ROOT, 'recordings');
    inputs = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/.test(f)).sort().map(f => path.join(dir, f))
      : [];
  }
  if (!inputs.length) {
    console.log('No recording files found.');
    process.exit(0);
  }

  const frames = [];
  for (const file of inputs) {
    const before = frames.length;
    try {
      for (const f of readRecordingFile(file)) frames.push(f);
    } catch (e) {
      console.error('Failed to read ' + file + ': ' + e.message);
      process.exit(1);
    }
    console.error('read ' + path.basename(file) + ': ' + (frames.length - before) + ' frames');
  }
  frames.sort((a, b) => a.t - b.t);

  let stations = null, sitelistSource = null;
  try {
    const sl = await loadSitelist(sitelistArg && sitelistArg.split('=')[1]);
    stations = sl.items; sitelistSource = sl.source;
    console.error('sitelist: ' + stations.length + ' stations from ' + sitelistSource);
  } catch (e) {
    console.error('sitelist unavailable (' + e.message + ') — intensity section will be skipped');
  }

  const report = buildReport(frames, { stations: stations });
  report.files = inputs.map(f => path.relative(ROOT, f));
  report.sitelist = sitelistSource ? { source: sitelistSource, stations: stations.length } : null;

  printReport(report);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error('report written to ' + path.relative(ROOT, outPath));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  parseJstTime: parseJstTime,
  decodeIntensityString: decodeIntensityString,
  levelToIntensity: levelToIntensity,
  haversineKm: haversineKm,
  parseFrames: parseFrames,
  readRecordingFile: readRecordingFile,
  collectEewEvents: collectEewEvents,
  finalReportOf: finalReportOf,
  collectCatalogEntries: collectCatalogEntries,
  findTruth: findTruth,
  scoreEventConvergence: scoreEventConvergence,
  stationPeakIntensities: stationPeakIntensities,
  gmpePredictions: gmpePredictions,
  intensityStats: intensityStats,
  loadSitelist: loadSitelist,
  buildReport: buildReport
};
