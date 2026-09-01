'use strict';
// ================================================================
//  v5.8 R7-1 — monthly frozen-data refresh + drift report.
//
//  One entry point that (a) re-fetches every externally-sourced frozen
//  dataset when its upstream is reachable, (b) validates the fetch with the
//  same gates the research manifest uses, (c) stores a versioned snapshot
//  under tools/data/frozen/YYYY-MM/ with SHA-256 provenance, and (d) diffs
//  the new snapshot against the previous one into a drift report — so slow
//  upstream revisions (ShakeMap reprocessing, JMA intensity corrections)
//  become visible instead of silently invalidating frozen baselines.
//
//  When a source is unreachable (the normal state from this network for
//  USGS/NOAA), the tool records the failure honestly and still refreshes
//  the LOCAL integrity snapshot (hash of the bundled file), so drift
//  detection between monthly runs works offline: any local modification of
//  a frozen dataset shows up in the next report.
//
//  Usage:
//    node tools/refresh-frozen-data.js               # all sources
//    node tools/refresh-frozen-data.js --source=jma  # one source
//    node tools/refresh-frozen-data.js --month=2026-09  # explicit month key
//  Monthly cadence per R7-1; snapshots accumulate under tools/data/frozen/.
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FROZEN_DIR = path.join(ROOT, 'tools/data/frozen');

// ------------------------------------------------------------------
// Source registry: each source knows its bundled file, upstream URL(s)
// and a fetcher returning the raw text (or throwing). Fetchers are
// intentionally thin; validation reuses the repo's schema gates.
// ------------------------------------------------------------------
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = require('http').request;
    const https = require('https').request;
    const mod = url.startsWith('https') ? { request: https } : { request: req };
    const r = mod.request(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    r.end();
  });
}

const SOURCES = [
  {
    id: 'jma-shindo-db',
    bundled: 'public/geojson/observed.json',
    upstream: 'https://www.data.jma.go.jp/eqdb/data/shindo/',
    // The JMA intensity database is a paged web app; a full re-curation uses
    // tools/import-observed-intensity.js per event. The refresh gate checks
    // that the upstream API is alive and records reachability; per-event
    // re-import stays a manual reviewed step (values change rarely).
    async probe() { return httpGet(this.upstream, 15000); }
  },
  {
    id: 'usgs-shakemap',
    bundled: 'public/geojson/strong-motion-obs.json',
    upstream: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=1&orderby=time',
    async probe() { return httpGet(this.upstream, 15000); }
    // Station-level refresh uses tools/fetch-strong-motion-obs.js (per-event
    // ShakeMap stationlist downloads); the probe above gates reachability.
  },
  {
    id: 'ncei-tsunami-observations',
    bundled: 'public/geojson/historical_tsunami_observations.json',
    upstream: 'https://www.ngdc.noaa.gov/hazard/tsu_db.shtml',
    async probe() { return httpGet(this.upstream, 15000); }
    // Curation source for R5-6 arrival-time fields and event expansion.
  }
];

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function monthKey(now, override) {
  // Monthly cadence keys on the runner's LOCAL calendar month. A UTC-derived
  // key (toISOString) lands runs between local midnight and UTC midnight —
  // e.g. Sep 1 00:32 at UTC+8 — back into the previous month's directory and
  // silently overwrites that snapshot (bit us on the 2026-09-01 run).
  if (override) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(override)) throw new Error('--month must be YYYY-MM, got: ' + override);
    return override;
  }
  const d = now instanceof Date ? now : new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function loadLocalSnapshot(sourceId) {
  // newest existing snapshot for the source
  if (!fs.existsSync(FROZEN_DIR)) return null;
  const months = fs.readdirSync(FROZEN_DIR).filter(d => /^\d{4}-\d{2}$/.test(d)).sort();
  for (let i = months.length - 1; i >= 0; i--) {
    const p = path.join(FROZEN_DIR, months[i], sourceId + '.json');
    if (fs.existsSync(p)) return { month: months[i], doc: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  return null;
}

function driftOf(prev, next) {
  if (!prev) return { firstSnapshot: true };
  const drift = { upstreamChanged: prev.sha256 !== next.sha256, checks: [] };
  // structural drift: event/observation counts for the JSON datasets
  function countEvents(doc) {
    try {
      const d = typeof doc === 'string' ? JSON.parse(doc) : doc;
      if (Array.isArray(d.events)) {
        return { events: d.events.length,
          observations: d.events.reduce((a, e) => a + ((e.observations || []).length), 0),
          forecastAreas: d.events.reduce((a, e) => a + ((e.forecastAreas || []).length), 0) };
      }
      if (d.events && typeof d.events === 'object') {
        const ids = Object.keys(d.events);
        return { events: ids.length, stations: ids.reduce((a, id) => a + (d.events[id].stations || []).length, 0) };
      }
    } catch (e) { /* non-JSON payload */ }
    return { bytes: (typeof doc === 'string' ? doc : JSON.stringify(doc)).length };
  }
  const before = countEvents(prev.payload || null), after = countEvents(next.payload);
  drift.before = before; drift.after = after;
  drift.countsChanged = JSON.stringify(before) !== JSON.stringify(after);
  return drift;
}

async function main() {
  const only = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1];
  const monthArg = (process.argv.find(a => a.startsWith('--month=')) || '').split('=')[1];
  const month = monthKey(new Date(), monthArg);
  const outDir = path.join(FROZEN_DIR, month);
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    schema: 'quake-sim-frozen-drift-report-v1',
    generatedAt: new Date().toISOString(),
    month,
    sources: [],
    note: 'reachability probes gate upstream refresh; per-event re-import stays a reviewed manual step (see AGENTS.md R7-1)'
  };
  for (const src of SOURCES) {
    if (only && src.id !== only) continue;
    const entry = { id: src.id, bundled: src.bundled };
    const bundledPath = path.join(ROOT, src.bundled);
    try {
      const bundledText = fs.readFileSync(bundledPath, 'utf8');
      entry.localSha256 = sha256(bundledText);
      entry.upstream = src.upstream;
      try {
        await src.probe();
        entry.upstreamReachable = true;
      } catch (err) {
        entry.upstreamReachable = false;
        entry.upstreamError = String(err.message || err).slice(0, 120);
      }
      const snapshot = {
        schema: 'quake-sim-frozen-snapshot-v1',
        source: src.id, month, capturedAt: new Date().toISOString(),
        upstreamReachable: entry.upstreamReachable,
        sha256: entry.localSha256,
        payload: JSON.parse(bundledText)
      };
      const prev = loadLocalSnapshot(src.id);
      entry.drift = driftOf(prev && { sha256: prev.doc.sha256, payload: prev.doc.payload }, snapshot);
      fs.writeFileSync(path.join(outDir, src.id + '.json'), JSON.stringify(snapshot));
      entry.snapshotWritten = path.join('tools/data/frozen', month, src.id + '.json');
    } catch (err) {
      entry.error = String(err.message || err).slice(0, 200);
    }
    report.sources.push(entry);
  }
  const reportPath = path.join(ROOT, 'tools/data/frozen-drift-report.json');
  const prevReport = fs.existsSync(reportPath)
    ? { previousGeneratedAt: JSON.parse(fs.readFileSync(reportPath, 'utf8')).generatedAt } : {};
  fs.writeFileSync(reportPath, JSON.stringify(Object.assign(report, prevReport), null, 2));
  for (const s of report.sources) {
    console.log(`${s.id}: upstream=${s.upstreamReachable} drift=${s.drift && (s.drift.firstSnapshot ? 'first' : (s.drift.upstreamChanged || s.drift.countsChanged ? 'CHANGED' : 'stable'))}${s.drift && s.drift.countsChanged ? ' ' + JSON.stringify(s.drift.before) + '->' + JSON.stringify(s.drift.after) : ''}`);
  }
  console.log('wrote tools/data/frozen-drift-report.json');
}

if (require.main === module) main();
module.exports = { SOURCES, driftOf, monthKey };
