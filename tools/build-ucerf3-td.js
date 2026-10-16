#!/usr/bin/env node
/**
 * UCERF3-TD batch A builder: freeze the date-of-last-event dataset at parent-section
 * granularity -> tools/data/ucerf3-td-sections-california.json (quake-sim-ucerf3-td-v1).
 *
 * Inputs:
 *   .cache/UCERF3_OpenIntervals_ver11.xls   (fetched from opensha/opensha-ucerf3 @ master,
 *                                            sha256 pinned below; auto-fetched when absent)
 *   tools/data/ucerf3-sections-california.json  (UCERF3 batch A frozen artifact)
 * Staging: tools/ucerf3-td-xls-staging.py (python+xlrd) -> .cache/ucerf3-td-staging.json
 *
 * Aggregation (documented in docs/UCERF3-TD-AVAILABILITY.md §6/§7): rows carry a parentId
 * that exists in exactly one fault model (alt-1 -> FM3.1, alt-2/Santa Fe Springs -> FM3.2),
 * so every row maps to exactly one FM — no ambiguity. Per parent: span-length-weighted mean
 * open interval (basis 2013-01-01, OpenSHA LastEventData.java); lastEventYear = 2013 - meanOI.
 * Official UCERF3-TD combines at rupture level over subsections (area-weighted) — our pack's
 * characteristic sources are parent-section aggregates, so the parent is the rupture unit.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const XLS = path.join(ROOT, '.cache', 'UCERF3_OpenIntervals_ver11.xls');
const XLS_SHA256 = '4cae78f96ad8839e9b3cab353d600806d80d79bd889512179fdc952c88aa6635';
const XLS_REPO_PATH = 'src/scratch/UCERF3/data/paleoRateData/UCERF3_OpenIntervals_ver11.xls';
const STAGING = path.join(ROOT, '.cache', 'ucerf3-td-staging.json');
const SECTIONS = path.join(ROOT, 'tools', 'data', 'ucerf3-sections-california.json');
const OUT = path.join(ROOT, 'tools', 'data', 'ucerf3-td-sections-california.json');
const OPEN_INTERVAL_BASIS_YEAR = 2013; // LastEventData.OPEN_INTERVAL_BASIS_YEAR

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function fetchXls() {
  return new Promise((resolve, reject) => {
    const token = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', shell: true })
      .toString().split('\n').find(l => l.startsWith('password=')).slice(9).trim();
    const req = https.request({
      host: '140.82.112.5', servername: 'api.github.com',
      path: '/repos/opensha/opensha-ucerf3/contents/' + XLS_REPO_PATH + '?ref=master',
      headers: { 'User-Agent': 'quake-sim-research', Host: 'api.github.com',
        Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json' }
    }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('fetch status ' + res.statusCode));
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(XLS, buf);
        resolve();
      });
    });
    req.on('error', reject); req.end();
  });
}

/** Great-circle distance (km) — same convention as Physics.haversineDist. */
function havKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

(async () => {
  // --- 1. XLS present + sha256 pinned ---
  if (!fs.existsSync(XLS)) {
    console.log('xls absent — fetching via GitHub pinned-IP channel...');
    await fetchXls();
  }
  const sha = sha256File(XLS);
  if (sha !== XLS_SHA256) throw new Error('xls sha256 mismatch: ' + sha + ' (expected ' + XLS_SHA256 + ')');

  // --- 2. staging (python xlrd) ---
  const py = spawnSync('python', [path.join(ROOT, 'tools', 'ucerf3-td-xls-staging.py')], { cwd: ROOT, encoding: 'utf8' });
  if (py.status !== 0) throw new Error('staging failed: ' + py.stderr);
  process.stderr.write(py.stderr);
  const staging = JSON.parse(fs.readFileSync(STAGING, 'utf8'));
  if (staging.rows.length !== 391) throw new Error('staging row count ' + staging.rows.length + ' != 391 (frozen anchor)');

  // --- 3. per-FM parent aggregation ---
  const sections = JSON.parse(fs.readFileSync(SECTIONS, 'utf8'));
  const modelsOut = {};
  for (const fmName of ['FM3.1', 'FM3.2']) {
    const fm = sections.models[fmName];
    const parentsById = new Map(fm.parents.map(p => [p.parentId, p]));
    const rowsByParent = new Map();
    let mapped = 0;
    for (const r of staging.rows) {
      if (!parentsById.has(r.parentId)) continue; // belongs to the other FM (alt geometry variants)
      mapped++;
      if (!rowsByParent.has(r.parentId)) rowsByParent.set(r.parentId, []);
      rowsByParent.get(r.parentId).push(r);
    }
    const parents = [];
    for (const [pid, rows] of rowsByParent) {
      // span-length-weighted mean open interval
      let wSum = 0, oiSum = 0;
      const detail = [];
      for (const r of rows) {
        const w = Math.max(havKm(r.span[0], r.span[1], r.span[2], r.span[3]), 0.1);
        wSum += w; oiSum += r.openInterval * w;
        detail.push({ oi: r.openInterval, spanKm: +w.toFixed(2), offM: r.offsetM,
          span: r.span.map(v => +v.toFixed(5)), sheet: r.sheet });
      }
      const meanOi = oiSum / wSum;
      parents.push({
        parentId: pid,
        name: parentsById.get(pid).name,
        nRows: rows.length,
        spanKmTotal: +wSum.toFixed(2),
        meanOpenIntervalYears: +meanOi.toFixed(3),
        lastEventYear: +(OPEN_INTERVAL_BASIS_YEAR - meanOi).toFixed(3),
        rows: detail
      });
    }
    parents.sort((a, b) => a.parentId - b.parentId);
    modelsOut[fmName] = { faultModel: fmName, rowsMapped: mapped, parentsWithData: parents.length, parents };
    console.log(fmName + ': rows mapped ' + mapped + ', parents with data ' + parents.length);
  }

  // --- 4. frozen anchors (fail loudly rather than freeze a drift) ---
  const p31 = modelsOut['FM3.1'].parents.find(p => p.name === 'San Andreas (Parkfield)');
  if (!p31 || Math.abs(p31.meanOpenIntervalYears - 9.0) > 0.01)
    throw new Error('Parkfield anchor drift: ' + JSON.stringify(p31));
  if (modelsOut['FM3.1'].rowsMapped !== 386 || modelsOut['FM3.2'].rowsMapped !== 385)
    throw new Error('row mapping counts drifted');
  // every staging row maps to exactly one FM (union = 391, intersection = 380)
  if (modelsOut['FM3.1'].rowsMapped + modelsOut['FM3.2'].rowsMapped - 391 !== 380)
    throw new Error('row union/intersection mismatch');

  const doc = {
    schema: 'quake-sim-ucerf3-td-v1',
    generatedAt: new Date().toISOString(),
    provenance: {
      sourceFile: 'opensha/opensha-ucerf3 @ master:' + XLS_REPO_PATH,
      sha256: XLS_SHA256,
      bytes: fs.statSync(XLS).size,
      openIntervalBasisYear: OPEN_INTERVAL_BASIS_YEAR,
      method: 'span-length-weighted mean open interval per parent section (docs/UCERF3-TD-AVAILABILITY.md §3/§6)',
      fetchedVia: 'GitHub contents API, pinned IP 140.82.112.5 + SNI api.github.com'
    },
    notes: [
      'Rows carry a parentId that exists in exactly one fault model (alt-1 parents are FM3.1-only, alt-2/Santa Fe Springs FM3.2-only); every row maps to exactly one FM.',
      'lastEventYear = 2013 - meanOpenIntervalYears; runtime elapsed = currentYear - lastEventYear (rolling, same convention as the Nankai BPT channel).',
      'Parents absent here have no date-of-last-event constraint: UCERF3-TD treats them with the historic open interval (T_H = currentYear - 1875).'
    ],
    models: modelsOut
  };
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + fs.statSync(OUT).size + ' bytes)');
})().catch(e => { console.error(e.message); process.exit(1); });
