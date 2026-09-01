#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.1 B2-beta — fetch per-event hypocenter + moment tensor (USGS
//  ComCat) for the frozen Kyoshin waveform packages, so the hybrid
//  scorecard uses REAL mechanisms instead of invented ones.
//
//  Data honesty: mechanisms come from the USGS ComCat moment-tensor
//  products (GCMT preferred, US otherwise) — public domain / open
//  data, provenance recorded per event. Events the API cannot resolve
//  are recorded as unresolved (no fallback guess); the scorecard then
//  skips them rather than synthesizing a fake focal mechanism.
//
//  Output: tools/data/broadband-event-mechanisms.json
//  Raw responses: .cache/comcat-mt/ (never committed)
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const OUT = path.join(ROOT, 'tools', 'data', 'broadband-event-mechanisms.json');
const CACHE = path.join(ROOT, '.cache', 'comcat-mt');

function httpsGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(urlStr, { timeout: timeoutMs || 20000, headers: { 'User-Agent': 'quake-sim-research/6.1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + urlStr)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchJsonCached(urlStr, tag) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, tag + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = await httpsGet(urlStr);
  fs.writeFileSync(file, body);
  return JSON.parse(body);
}

async function resolveEvent(ev) {
  // Kyoshin package origintimes are JST (local Japan wall clock) without a
  // zone marker; ComCat queries are UTC. Read the wall clock AS UTC (append
  // 'Z' — Node would otherwise apply the host's local zone), then subtract
  // the 9 h JST offset to get the true UTC epoch.
  const wall = ev.origintime;
  const utcStr = /[Zz]$|[+-]\d\d:?\d\d$/.test(wall) ? wall : wall + 'Z';
  const t0 = new Date(new Date(utcStr).getTime() - 9 * 3600 * 1000);
  const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
  // Package origintimes are minute-rounded (often rounded UP), so the true
  // origin can precede the nominal time — open the window 2 min early.
  const tStart = new Date(t0.getTime() - 2 * 60 * 1000);
  const fmt = (d) => d.toISOString().replace(/\.\d+Z$/, '');
  const queries = [
    { dm: 0.5, r: 100 }, { dm: 0.8, r: 150 }, { dm: 1.2, r: 250 }
  ];
  for (const q of queries) {
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson'
      + '&starttime=' + fmt(tStart) + '&endtime=' + fmt(t1)
      + '&minmagnitude=' + Math.max(4.5, ev.mag - q.dm) + '&maxmagnitude=' + (ev.mag + q.dm)
      + '&latitude=' + ev.lat + '&longitude=' + ev.lng + '&maxradiuskm=' + q.r;
    let coll;
    try { coll = await fetchJsonCached(url, 'ev-' + ev.id + '-dm' + q.dm + '-r' + q.r); }
    catch (e) { console.error('  query fail dm=' + q.dm + ': ' + e.message); continue; }
    if (!coll.features || !coll.features.length) continue;
    // closest in time to the package origintime
    let best = null, bestDt = Infinity;
    for (const f of coll.features) {
      const dt = Math.abs(new Date(f.properties.time) - t0);
      if (dt < bestDt) { bestDt = dt; best = f; }
    }
    if (best && bestDt < 6 * 60 * 1000) return { feature: best, t0 };
  }
  return null;
}

async function fetchMomentTensor(eventId) {
  // The dedicated /eventpage/<id>/moment-tensor/query endpoint now serves the
  // SPA shell; the detail geojson carries the same products inline.
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=' + eventId;
  try {
    const doc = await fetchJsonCached(url, 'detail-' + eventId);
    const mts = (doc.properties.products || {})['moment-tensor'] || [];
    if (!mts.length) return null;
    // prefer an independent GCMT solution, then the highest preferred weight
    const sorted = mts.slice().sort((a, b) => {
      const sa = a.source === 'gcmt' ? 0 : 1, sb = b.source === 'gcmt' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return (b.preferredWeight || 0) - (a.preferredWeight || 0);
    });
    for (const mt of sorted) {
      const p = mt.properties || {};
      const st = parseFloat(p['nodal-plane-1-strike']);
      const dp = parseFloat(p['nodal-plane-1-dip']);
      const rk = parseFloat(p['nodal-plane-1-rake']);
      if (isFinite(st) && isFinite(dp) && isFinite(rk)) {
        // ComCat rakes may come in [0,360); canonicalize to (-180,180]
        let rkC = ((rk + 180) % 360 + 360) % 360 - 180;
        return {
          source: (mt.source || 'unknown') + '/' + mt.code,
          strike: +st.toFixed(1), dip: +dp.toFixed(1), rake: +rkC.toFixed(1),
          mwwMag: parseFloat(p['derived-magnitude']) || null
        };
      }
    }
    return null;
  } catch (e) { return null; }
}

async function main() {
  const idx = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'index.json'), 'utf8'));
  const out = {
    schema: 'quake-sim-broadband-event-mechanisms-v1',
    generatedAt: new Date().toISOString(),
    provenance: 'USGS ComCat FDSN + eventpage moment-tensor products (GCMT preferred); public domain',
    events: []
  };
  for (const ev of idx.events) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, ev.file), 'utf8'));
    const meta = pkg.event || {};
    const target = {
      id: ev.id,
      origintime: meta.origintime || ev.origintime,
      lat: meta.lat != null ? meta.lat : ev.lat,
      lng: meta.lng != null ? meta.lng : ev.lng,
      mag: meta.mag != null ? meta.mag : ev.mag
    };
    process.stdout.write(target.id + ' M' + target.mag + ' ... ');
    const hit = await resolveEvent(target);
    if (!hit) {
      console.log('UNRESOLVED');
      out.events.push({ id: target.id, resolved: false, reason: 'no ComCat match within -2/+5 min, mag +/-1.2, 250 km' });
      continue;
    }
    const f = hit.feature;
    const p = f.properties;
    const mt = await fetchMomentTensor(f.id);
    const rec = {
      id: target.id, resolved: true,
      comcatId: f.id,
      comcatMag: p.mag, comcatMagType: p.magType,
      depthKm: (f.geometry && f.geometry.coordinates && f.geometry.coordinates.length > 2) ? f.geometry.coordinates[2] : null,
      pkgMag: target.mag,
      mechanism: mt,
      matchTimeDiffSec: +((new Date(p.time) - hit.t0) / 1000).toFixed(1)
    };
    console.log((f.id) + ' M' + p.mag + ' depth=' + rec.depthKm + 'km ' + (mt ? ('MT ' + mt.strike + '/' + mt.dip + '/' + mt.rake + ' (' + mt.source + ')') : 'NO MT'));
    out.events.push(rec);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const nOk = out.events.filter((e) => e.resolved && e.mechanism).length;
  console.log('wrote ' + OUT + ' — ' + nOk + '/' + out.events.length + ' events with mechanism');
}

main().catch((e) => { console.error(e); process.exit(1); });
