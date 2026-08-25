#!/usr/bin/env node
'use strict';
// ================================================================
//  Map the frozen strong-motion events (public/geojson/
//  strong-motion-obs.json) to Kyoshin portal eqid_ids so the batch
//  waveform fetch can run the moment the NIED account approval lands.
//
//  Uses the eqsearch API which — unlike the waveform download — needs
//  no login (verified 2026-08-24). For each event we search a +/-2 day
//  JST window around the origin time with a loose magnitude gate, then
//  pick the result closest to the catalog hypocenter (haversine) with
//  |dmag| <= 0.7; nothing is written for unmatched events.
//
//  Output: tools/data/kyoshin-eqid-map.json
//    [{ eventId, usgsId, eqid, origintimeJst, lat, lng, mag,
//       distKm, dMag, sitenum, retrievedAt }]
//
//  Usage: node tools/find-kyoshin-eqids.js [--obs=path] [--out=path]
//         [--refresh]   re-query events already present in the map
// ================================================================
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.kyoshin.bosai.go.jp';
const OBS_DEFAULT = 'public/geojson/strong-motion-obs.json';
const OUT_DEFAULT = 'tools/data/kyoshin-eqid-map.json';
const WINDOW_DAYS = 2;
const MAX_DIST_KM = 120;
const MAX_DMAG = 0.7;
// Origin-time gate: the eqsearch window is crowded with aftershocks of the
// same sequence (the fukushima2011 first run matched a +3.4 h M5.9
// aftershock 21 km away). Catalog origin vs NIED origintime should agree
// within a few minutes, so anything beyond this is a different event.
const MAX_DT_SEC = 600;

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

// ---- cookie jar (mirrors fetch-kyoshin-waveforms.js) ------------------------
const jar = new Map();
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
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': Array.from(jar, ([k, v]) => k + '=' + v).join('; '),
      'Referer': referer || BASE + '/ja/eqdownload/',
      'X-Requested-With': 'XMLHttpRequest'
    }, body
  });
  absorbCookies(res);
  return res;
}

function havKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function jstDatesAround(isoUtc) {
  const t = new Date(isoUtc).getTime() + 9 * 3600e3; // JST
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '/');
  return { from: fmt(new Date(t - WINDOW_DAYS * 86400e3)), to: fmt(new Date(t + WINDOW_DAYS * 86400e3)) };
}
function jstSeconds(isoUtc) { return new Date(isoUtc).getTime() + 9 * 3600e3; }
function parseOrigintimeJst(s) {
  // "2024/01/01 16:10:00" (JST) -> epoch ms
  const m = s && s.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

(async function main() {
  const obsPath = arg('obs', OBS_DEFAULT);
  const outPath = arg('out', OUT_DEFAULT);
  const refresh = process.argv.slice(2).includes('--refresh');
  const obs = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
  let existing = {};
  if (!refresh && fs.existsSync(outPath)) {
    for (const row of JSON.parse(fs.readFileSync(outPath, 'utf8'))) existing[row.eventId] = row;
  }

  const pageRes = await fetch(BASE + '/ja/eqdownload/');
  absorbCookies(pageRes);
  const page = await pageRes.text();
  const csrf = (page.match(/csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error('csrf token not found on eqdownload page');

  const out = [];
  const retrievedAt = new Date().toISOString().slice(0, 10);
  for (const ev of obs.events) {
    if (existing[ev.eventId]) { out.push(existing[ev.eventId]); continue; }
    const { from, to } = jstDatesAround(ev.time);
    const res = await postForm(BASE + '/ja/eqdownload/api/eqsearch/', {
      csrfmiddlewaretoken: csrf, date_from: from, date_to: to,
      mag1: (ev.mw - 1.2).toFixed(1), mag2: (ev.mw + 1.2).toFixed(1)
    });
    if (!res.ok) { console.warn('  search HTTP', res.status, 'for', ev.eventId); out.push({ eventId: ev.eventId, usgsId: ev.usgsId, eqid: null, error: 'http ' + res.status }); continue; }
    const data = await res.json();
    const originMs = jstSeconds(ev.time);
    const cands = (data.results || []).map(r => ({
      eqid: r.eqid_id__eqid_id, origintimeJst: r.origintime, lat: parseFloat(r.lat), lng: parseFloat(r.lon),
      mag: parseFloat(r.mag), sitenum: r.sitenum,
      distKm: havKm(ev.lat, ev.lng, parseFloat(r.lat), parseFloat(r.lon)),
      dMag: Math.abs(parseFloat(r.mag) - ev.mw),
      dtSec: Math.abs((parseOrigintimeJst(r.origintime) - originMs) / 1000)
    })).filter(c => c.eqid && c.distKm <= MAX_DIST_KM && c.dMag <= MAX_DMAG && isFinite(c.dtSec) && c.dtSec <= MAX_DT_SEC)
      .sort((a, b) => (a.distKm + a.dtSec / 50) - (b.distKm + b.dtSec / 50));
    const hit = cands[0] || null;
    if (!hit) console.warn('  NO MATCH:', ev.eventId, '(' + from + '..' + to + ', total ' + (data.total || 0) + ')');
    out.push(Object.assign({ eventId: ev.eventId, usgsId: ev.usgsId, eqid: null }, hit, { retrievedAt }));
    console.log(ev.eventId.padEnd(16), hit ? hit.eqid + '  M' + hit.mag.toFixed(1) + '  ' + hit.distKm.toFixed(1) + ' km  dt' + Math.round(hit.dtSec) + 's' : 'no match');
    await new Promise(r => setTimeout(r, 800));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  const found = out.filter(r => r.eqid).length;
  console.log('\nwrote', outPath, '- ' + found + '/' + out.length + ' events mapped');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
