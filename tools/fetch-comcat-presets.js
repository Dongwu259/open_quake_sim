#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.6.0 — ComCat-sourced historical presets for the global-mode region
//  packs. Replaces the hand-filled preset parameters with USGS ComCat
//  authoritative values (hypocenter, preferred magnitude, origin time) and
//  moment-tensor nodal planes (GCMT-family products), frozen into per-region
//  snapshots that tools/data/experiment-manifest.json registers.
//
//  Data honesty rules (HANDOVER 6.6.0 decision points):
//   - Snapshots are frozen inputs; packs never fetch ComCat at runtime.
//   - Preset ids/labels stay stable (URL shares and scenario migration
//     depend on them); only parameter VALUES are refreshed.
//   - Events without a ComCat moment tensor (pre-instrumental: 1906 San
//     Francisco, 1908 Messina, 1960 Valdivia) keep the pack's documented
//     literature-typical mechanism — mechanism:null in the snapshot, never
//     an invented one.
//   - Epicenters are the PUBLISHED ComCat values; they are never nudged for
//     tsunami convenience (the Valdivia/Messina land-grid notes stay as-is).
//
//  Usage:
//    node tools/fetch-comcat-presets.js            # refresh snapshots only, print diffs
//    node tools/fetch-comcat-presets.js --write    # + rewrite pack presets arrays
//    node tools/fetch-comcat-presets.js --region=chile --write
//
//  Snapshots: tools/data/comcat-presets-<region>.json (committed, frozen)
//  Raw ComCat responses: .cache/comcat-presets/ (never committed)
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'comcat-presets');
const REGIONS = ['california', 'chile', 'italy', 'taiwan', 'newzealand'];

// Epicenter keep-list (HANDOVER 6.6.0 decision 3): the pipeline must never
// flush a documented honesty note by "correcting" parameters. The pack's
// Messina 1908 epicenter is the documented literature value that lands on a
// land cell; the ISC-GEM/ComCat epicenter sits IN the strait — adopting it
// would silently enable a point-source tsunami sim for an event whose 1908
// tsunami was slump-driven (beyond any point source). The pack epicenter
// stays; the snapshot records ComCat's value with the reason.
const KEEP_EPICENTER = {
  'it-1908-messina': 'pack keeps the documented land-cell epicenter; the ISC-GEM epicenter is in-strait water and the 1908 tsunami was submarine-slump driven — see region pack notes'
};

function httpsGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(urlStr, { timeout: timeoutMs || 25000, headers: { 'User-Agent': 'quake-sim-research/6.6' } }, (res) => {
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
  const file = path.join(CACHE, tag.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = await httpsGet(urlStr);
  fs.writeFileSync(file, body);
  return JSON.parse(body);
}

// Preset pack times are legacy local wall clocks ('YYYY/MM/DD HH:MM', no zone).
// Read the wall clock as UTC and open a wide +/-30 h window — that absorbs any
// regional zone offset (Chile/Italy/California) without a timezone table.
function parsePresetTime(str) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})/.exec(str || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function fmtIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, '');
}

// Undirected angular distance between strikes (fault planes are bidirectional)
// plus dip difference — used to keep the pack's current nodal-plane CHOICE
// stable when ComCat supplies both planes of a double couple.
function planeDistance(s1, d1, s2, d2) {
  const ds = Math.abs(((s1 - s2) % 360 + 540) % 360 - 180);
  const dsU = Math.min(ds, 180 - ds);
  return dsU + Math.abs(d1 - d2);
}

function canonRake(rk) {
  return ((rk + 180) % 360 + 360) % 360 - 180;
}

async function resolvePreset(preset) {
  const t0 = parsePresetTime(preset.time);
  if (t0 == null) return { resolved: false, reason: 'unparseable preset time: ' + preset.time };
  const dLat = 1.2;
  const dLng = 1.2 / Math.max(0.2, Math.cos(preset.lat * Math.PI / 180));
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson'
    + '&starttime=' + fmtIso(t0 - 30 * 3600e3) + '&endtime=' + fmtIso(t0 + 30 * 3600e3)
    + '&minlatitude=' + (preset.lat - dLat).toFixed(3) + '&maxlatitude=' + (preset.lat + dLat).toFixed(3)
    + '&minlongitude=' + (preset.lng - dLng).toFixed(3) + '&maxlongitude=' + (preset.lng + dLng).toFixed(3)
    + '&minmagnitude=' + (preset.mag - 1.5).toFixed(1) + '&orderby=time';
  const coll = await fetchJsonCached(url, 'search-' + preset.id);
  if (!coll.features || !coll.features.length) return { resolved: false, reason: 'no ComCat event in window/box', queryUrl: url };
  let best = null, bestScore = Infinity;
  for (const f of coll.features) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c) continue;
    const dtH = Math.abs(new Date(f.properties.time).getTime() - t0) / 3600e3;
    const dist = Math.hypot((c[1] - preset.lat), (c[0] - preset.lng) * Math.cos(preset.lat * Math.PI / 180)) * 111.32;
    const dMag = Math.abs(Number(f.properties.mag) - preset.mag);
    const score = dtH + dist / 50 + dMag * 2;
    if (score < bestScore) { bestScore = score; best = { f, dtH, dist, dMag }; }
  }
  if (!best || best.dtH > 36 || best.dist > 250 || best.dMag > 1.5) {
    return { resolved: false, reason: 'nearest candidate outside match guards', queryUrl: url };
  }
  return { resolved: true, feature: best.f, queryUrl: url, match: { dtHours: +best.dtH.toFixed(2), distKm: +best.dist.toFixed(1), dMag: +best.dMag.toFixed(2) } };
}

async function fetchMechanism(eventId, currentStrike, currentDip) {
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=' + encodeURIComponent(eventId);
  const doc = await fetchJsonCached(url, 'detail-' + eventId);
  const products = (doc.properties && doc.properties.products) || {};
  // ComCat carries nodal planes under BOTH 'moment-tensor' (with moment
  // magnitude) and 'focal-mechanism' (e.g. California events: Loma Prieta /
  // Northridge have GCMT solutions only as focal-mechanism products).
  const mts = (products['moment-tensor'] || []).map(m => ({ m, ptype: 'moment-tensor' }))
    .concat((products['focal-mechanism'] || []).map(m => ({ m, ptype: 'focal-mechanism' })));
  if (!mts.length) return { mechanism: null, detailUrl: url, note: 'no ComCat moment-tensor/focal-mechanism product' };
  const gcmtish = (e) => e.m.source === 'gcmt' || /gcmt/i.test(e.m.code || '') ||
    (e.m.properties && /gcmt/i.test(e.m.properties.eventsource || ''));
  const sorted = mts.slice().sort((a, b) => {
    const ga = gcmtish(a) ? 0 : 1, gb = gcmtish(b) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const pw = (b.m.preferredWeight || 0) - (a.m.preferredWeight || 0);
    if (pw) return pw;
    return (a.ptype === 'moment-tensor' ? 0 : 1) - (b.ptype === 'moment-tensor' ? 0 : 1);
  });
  for (const { m: mt, ptype } of sorted) {
    const p = mt.properties || {};
    const s1 = parseFloat(p['nodal-plane-1-strike']), d1 = parseFloat(p['nodal-plane-1-dip']), r1 = parseFloat(p['nodal-plane-1-rake']);
    const s2 = parseFloat(p['nodal-plane-2-strike']), d2 = parseFloat(p['nodal-plane-2-dip']), r2 = parseFloat(p['nodal-plane-2-rake']);
    if (![s1, d1, r1, s2, d2, r2].every(isFinite)) continue;
    // Keep the pack's current plane choice stable: pick the nodal plane
    // angularly closer to the preset's current strike/dip.
    const pickFirst = planeDistance(s1, d1, currentStrike, currentDip) <= planeDistance(s2, d2, currentStrike, currentDip);
    const pick = pickFirst ? { s: s1, d: d1, r: r1 } : { s: s2, d: d2, r: r2 };
    const alt = pickFirst ? { s: s2, d: d2, r: r2 } : { s: s1, d: d1, r: r1 };
    return {
      mechanism: {
        source: (mt.source || 'unknown') + '/' + (mt.code || ''),
        productType: ptype,
        strikeDeg: +pick.s.toFixed(1), dipDeg: +pick.d.toFixed(1), rakeDeg: +canonRake(pick.r).toFixed(1),
        alternatePlane: { strikeDeg: +alt.s.toFixed(1), dipDeg: +alt.d.toFixed(1), rakeDeg: +canonRake(alt.r).toFixed(1) },
        selection: 'nearest-current-preset-plane',
        derivedMagnitude: parseFloat(p['derived-magnitude']) || null,
        derivedDepthKm: parseFloat(p['derived-depth']) || null
      },
      detailUrl: url
    };
  }
  return { mechanism: null, detailUrl: url, note: 'moment-tensor/focal-mechanism products missing nodal planes' };
}

async function processRegion(rid, write) {
  const packFile = path.join(ROOT, 'public', 'geojson', 'region-' + rid + '.json');
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  const snapFile = path.join(ROOT, 'tools', 'data', 'comcat-presets-' + rid + '.json');
  const snap = {
    schema: 'quake-sim-comcat-presets-v1',
    region: rid,
    generatedAt: new Date().toISOString(),
    provenance: 'USGS ComCat fdsnws event API + moment-tensor products (GCMT family preferred by source/preferredWeight); public domain',
    presets: []
  };
  const newPresets = [];
  for (const preset of pack.presets) {
    process.stdout.write('  ' + preset.id + ' ... ');
    const rec = { id: preset.id, label: preset.label, sourceType: preset.sourceType || null, previous: { lat: preset.lat, lng: preset.lng, mag: preset.mag, depth: preset.depth, strike: preset.strike, dip: preset.dip, rake: preset.rake } };
    // sourceType (v6.7) is curated tectonic metadata, not a ComCat field:
    // carry it through unchanged so a refresh never strips the classification.
    let out = { id: preset.id, label: preset.label, lat: preset.lat, lng: preset.lng, mag: preset.mag, depth: preset.depth, strike: preset.strike, dip: preset.dip, rake: preset.rake, mechanismKnown: preset.mechanismKnown, time: preset.time, sourceType: preset.sourceType };
    try {
      const hit = await resolvePreset(preset);
      if (!hit.resolved) {
        rec.resolved = false; rec.reason = hit.reason; rec.queryUrl = hit.queryUrl;
        console.log('UNRESOLVED (' + hit.reason + ') — pack values kept');
      } else {
        const f = hit.feature, p = f.properties, c = f.geometry.coordinates;
        const mechRes = await fetchMechanism(f.id, preset.strike, preset.dip);
        rec.resolved = true;
        rec.comcatId = f.id;
        rec.eventUrl = 'https://earthquake.usgs.gov/earthquakes/eventpage/' + f.id;
        rec.queryUrl = hit.queryUrl; rec.detailUrl = mechRes.detailUrl;
        rec.match = hit.match;
        rec.comcat = {
          mag: p.mag, magType: p.magType,
          lat: +c[1].toFixed(4), lng: +c[0].toFixed(4),
          depthKm: +c[2].toFixed(2),
          originTimeUtc: new Date(p.time).toISOString()
        };
        rec.mechanism = mechRes.mechanism;
        if (mechRes.note) rec.mechanismNote = mechRes.note;
        // refresh parameter VALUES from ComCat; id/label/time stay stable
        if (KEEP_EPICENTER[preset.id]) {
          rec.epicenterKept = KEEP_EPICENTER[preset.id];
          rec.comcatEpicenter = { lat: +c[1].toFixed(4), lng: +c[0].toFixed(4) };
        } else {
          out.lat = +c[1].toFixed(3); out.lng = +c[0].toFixed(3);
        }
        out.mag = +Number(p.mag).toFixed(1);
        out.depth = Math.max(0, +Number(c[2]).toFixed(1));
        if (mechRes.mechanism) {
          out.strike = mechRes.mechanism.strikeDeg; out.dip = mechRes.mechanism.dipDeg; out.rake = mechRes.mechanism.rakeDeg;
        } else {
          rec.keptMechanism = 'no ComCat moment tensor — documented pack mechanism kept';
        }
        // keep the label honest if the magnitude moved
        const labelMag = /M(\d+(?:\.\d+)?)/.exec(out.label);
        if (labelMag && Math.abs(Number(labelMag[1]) - out.mag) > 0.05) {
          out.label = out.label.replace(/M\d+(?:\.\d+)?/, 'M' + out.mag);
          rec.labelUpdated = true;
        }
        console.log(f.id + ' M' + p.mag + ' ' + rec.comcat.lat + ',' + rec.comcat.lng + ' d=' + rec.comcat.depthKm + 'km' +
          (rec.mechanism ? ' MT ' + rec.mechanism.strikeDeg + '/' + rec.mechanism.dipDeg + '/' + rec.mechanism.rakeDeg + ' (' + rec.mechanism.source + ')' : ' NO-MT(kept)'));
      }
    } catch (e) {
      rec.resolved = false; rec.reason = 'fetch error: ' + e.message;
      console.log('ERROR ' + e.message + ' — pack values kept');
    }
    snap.presets.push(rec);
    newPresets.push(out);
  }
  fs.mkdirSync(path.dirname(snapFile), { recursive: true });
  fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2) + '\n');
  console.log('snapshot ' + path.relative(ROOT, snapFile) + ' — ' + snap.presets.filter(p => p.resolved).length + '/' + snap.presets.length + ' resolved');
  if (write) {
    const nResolved = snap.presets.filter(p => p.resolved).length;
    if (nResolved === 0) {
      console.log('  SKIP pack rewrite: zero resolved presets (never hollow out the pack)');
    } else {
      pack.presets = newPresets;
      fs.writeFileSync(packFile, JSON.stringify(pack));
      console.log('  pack presets rewritten: ' + path.relative(ROOT, packFile) + ' (' + newPresets.length + ' presets)');
    }
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const regionArg = (process.argv.find(a => a.startsWith('--region=')) || '').split('=')[1];
  const regions = regionArg ? [regionArg] : REGIONS;
  for (const rid of regions) {
    if (REGIONS.indexOf(rid) < 0) { console.error('unknown region: ' + rid); process.exit(1); }
    console.log('region ' + rid + ':');
    await processRegion(rid, write);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
