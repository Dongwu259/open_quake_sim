#!/usr/bin/env node
'use strict';
// tools/fetch-nz-nshm-disagg.js — fetch the official NZ NSHM 2022
// (NSHM_v1.0.4) disaggregation reports for the preregistered mode-bin
// comparison (tools/scorecard-nz-deagg-mode.js).
//
// Channel (2026-11-16 probe): the Kororaa GraphQL query
// KORORAA_disaggregation_reports lists 5194 static report pages
// (nshm-static-reports.gns.cri.nz/openquake/DATA/NSHM_v1.0.4/<slug>-<vs30>-<imt>-<poe>),
// one per site/IMT/POE/Vs30. The report HTML carries MACHINE-READABLE TEXT
// for the ground-motion level, mean source and the (mag dist) / (mag dist eps)
// mode bins; the tectonic-region-type (TRT) contribution exists ONLY as a
// raster PNG (sibling .json probes 403) — a full source-class decomposition
// therefore stays NOT-OPENED on this channel; only mode-level numbers are
// extracted here. The shipped vs30 grid for these reports is
// [200, 275, 300, 400, 750] — no 600 — so this measurement runs at 750 on
// BOTH sides (declared deviation from the v7.1 curve gate, which used 600
// on both sides; the comparison convention is unchanged).
//
// Output: tools/data/nshmnz/nshm-v104-disagg-modes.json (extracted values +
// provenance). The report HTML itself is not archived — every extracted
// number is verbatim regex output and re-running --write re-derives them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-disagg-modes.json');
const ENDPOINT = 'https://nshm-api.gns.cri.nz/kororaa-app-api/graphql';
// relUrl from GraphQL ALREADY carries the host — the base is just the scheme
const REPORT_BASE = 'https://';
// Public Kororaa viewer key (embedded in the public SPA bundle) — documented
// on fetch-nz-nshm.js; not a private credential.
const VIEWER_KEY = 'YZtCPe39or4XpsH4RkQvi6NeHJPE2aesahnY1EUc';

const MODEL = 'NSHM_v1.0.4';
const IMT = 'PGA';
const VS30 = 750;
const POES = [0.1, 0.02]; // 10% in 50y = RP475; 2% in 50y = RP2475
const CITIES = ['wlg', 'akl', 'chc', 'nsn', 'zqn', 'ivc'];

const QUERY = `query FetchNzDisagg {
  disaggs: KORORAA_disaggregation_reports {
    ok
    reports { imt poe vs30 inv_time report_url location { lat lon name } }
  }
}`;

function gqlOnce() {
  // node:https POST (the tmp-file + curl channel worked in probes, but the
  // static-report host rate-limits the combined pattern; node:https avoids
  // the extra subprocess and keeps the request single-shot)
  const body = JSON.stringify({ query: QUERY });
  return new Promise((resolve, reject) => {
    const req = require('https').request(ENDPOINT, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-API-KEY': VIEWER_KEY,
      'Content-Length': Buffer.byteLength(body),
    } }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve(b)); });
    req.on('error', reject);
    req.setTimeout(150000, () => { req.destroy(new Error('gql timeout')); });
    req.write(body); req.end();
  });
}

function fetchReport(relUrl) {
  let last = '';
  for (const wait of [0, 30000, 120000]) {
    if (wait) sleepSync(wait);
    last = execFileSync('curl', ['-s', '--max-time', '90', REPORT_BASE + relUrl + '/'],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    if (last.includes('Mean Source')) return last;
  }
  throw new Error('report fetch failed (len ' + last.length + '): ' + last.slice(0, 120));
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function num(re, html, label) {
  const m = html.match(re);
  if (!m) throw new Error('extraction failed: ' + label);
  return +m[1];
}

function extract(html) {
  // verbatim text-layer extraction (report structure frozen at fetch time)
  const gm = html.match(/Ground Motion: ([0-9.]+) x 10<sup>([+-]?\d+)<\/sup>g/);
  const mean = html.match(/<h2>Mean Source<\/h2>\s*<p><strong>Distance:<\/strong> ([0-9.]+) km<br \/>\s*<strong>Magnitude:<\/strong> ([0-9.]+)<br \/>\s*<strong>Epsilon:<\/strong> ([0-9.]+) &sigma;/);
  const mode = html.match(/<h2>Mode \(mag dist\)<\/h2>\s*<p><strong>Magnitude:<\/strong> ([0-9.]+)<br \/>\s*<strong>Distance:<\/strong> ([0-9.]+)<br \/>\s*<strong>Contribution:<\/strong> ([0-9.]+)%/);
  const modeEps = html.match(/<h2>Mode \(mag dist eps\)<\/h2>\s*<p><strong>Magnitude:<\/strong> ([0-9.]+)<br \/>\s*<strong>Distance:<\/strong> ([0-9.]+)<br \/>\s*<strong>Epsilon:<\/strong> ([0-9.]+)<br \/>\s*<strong>Contribution:<\/strong> ([0-9.]+)%/);
  if (!gm || !mean || !mode || !modeEps) throw new Error('report text-layer missing an expected block');
  return {
    groundMotionG: +(parseFloat(gm[1]) * Math.pow(10, +gm[2])).toPrecision(6),
    meanSource: { distKm: +mean[1], mag: +mean[2], eps: +mean[3] },
    modeMagDist: { mag: +mode[1], distKm: +mode[2], contribPct: +mode[3] },
    modeMagDistEps: { mag: +modeEps[1], distKm: +modeEps[2], eps: +modeEps[3], contribPct: +modeEps[4] },
  };
}

// TWO-PHASE DISCIPLINE (measured 2026-11-16): a GraphQL call to
// nshm-api.gns.cri.nz POISONS the following report GETs on
// nshm-static-reports.gns.cri.nz for minutes (S3 AccessDenied pages, retried
// up to 120 s) even though every report URL answers 200 standalone. The tool
// therefore runs in two invocations:
//   node tools/fetch-nz-nshm-disagg.js --list    # phase 1: GraphQL -> .cache list
//   node tools/fetch-nz-nshm-disagg.js --write   # phase 2: reports -> freeze
// Phase 1 caches ONLY the filtered 12-report list to
// .cache/nshmnz-disagg-list.json (intermediate, not shipped); phase 2 never
// touches the GraphQL host.
async function main() {
  const LIST_TMP = path.join(ROOT, '.cache', 'nshmnz-disagg-list.json');
  if (process.argv.includes('--list')) {
    let raw = null, err = null;
    for (const wait of [0, 5000, 20000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try { raw = await gqlOnce(); if (raw.includes('"ok":true')) { err = null; break; } err = raw.slice(0, 200); }
      catch (e) { err = String(e).slice(0, 200); }
    }
    if (!raw || !raw.includes('"ok":true')) { console.error('FETCH FAILED:', err); process.exit(1); }
    const doc = JSON.parse(raw);
    const reports = doc.data.disaggs.reports.filter((r) =>
      r.imt === IMT && r.vs30 === VS30 && POES.includes(r.poe) &&
      CITIES.includes(r.report_url.split('/').pop().split('-')[0]));
    if (reports.length !== CITIES.length * POES.length) {
      console.error('UNEXPECTED REPORT COUNT:', reports.length, 'want', CITIES.length * POES.length);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(LIST_TMP), { recursive: true });
    fs.writeFileSync(LIST_TMP, JSON.stringify(reports, null, 1));
    console.log('list cached:', reports.length, 'reports ->', LIST_TMP);
    return;
  }
  if (!fs.existsSync(LIST_TMP)) {
    console.error('no cached list — run `node tools/fetch-nz-nshm-disagg.js --list` first (two-phase discipline, see header)');
    process.exit(1);
  }
  const reports = JSON.parse(fs.readFileSync(LIST_TMP, 'utf8'));
  if (reports.length !== CITIES.length * POES.length) {
    console.error('CACHED LIST SHAPE CHANGED:', reports.length);
    process.exit(1);
  }
  const sites = {};
  for (const r of reports) {
    const slug = r.report_url.split('/').pop().split('-')[0];
    sleepSync(4000); // courtesy spacing (fetch-nz-nshm.js convention; the report host rate-limits bursts)
    const html = fetchReport(r.report_url);
    let extracted = null;
    try { extracted = extract(html); } catch (e) {
      console.error('EXTRACT FAILED', r.report_url, String(e).slice(0, 120)); process.exit(1);
    }
    if (!sites[slug]) sites[slug] = { code: slug.toUpperCase(), name: r.location.name, lat: r.location.lat, lng: r.location.lon, byPoe: {} };
    sites[slug].byPoe[String(r.poe)] = {
      invTimeYears: r.inv_time, returnPeriod: Math.round(-r.inv_time / Math.log(1 - r.poe)), // POE is a 50-y probability, not an annual rate
      reportUrl: REPORT_BASE + r.report_url + '/',
      extracted: extracted,
    };
  }
  const out = {
    schema: 'quake-sim-nz-nshm-disagg-modes-v1',
    fetchedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    reportBase: REPORT_BASE,
    model: MODEL, imt: IMT, vs30: VS30, poes: POES,
    vs30Note: 'reports ship only for [200,275,300,400,750]; 750 chosen and applied on BOTH sides (scorecard) — declared deviation from the v7.1 curve gate (600/600)',
    extractionNote: 'regex extraction of the report HTML text layer (ground motion / mean source / mode mag-dist / mode mag-dist-eps); TRT contributions are raster-only — full source-class decomposition stays NOT-OPENED on this channel',
    sites: sites,
  };
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('wrote ' + OUT + ' sha256 ' + crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0, 12));
  }
  console.log('reports:', Object.keys(sites).length, 'cities x', POES.length, 'poes');
  for (const [slug, s] of Object.entries(sites)) {
    console.log(slug, 'poe0.1 mode M' + s.byPoe['0.1'].extracted.modeMagDist.mag + '@' + s.byPoe['0.1'].extracted.modeMagDist.distKm + 'km',
      'poe0.02 mode M' + s.byPoe['0.02'].extracted.modeMagDist.mag + '@' + s.byPoe['0.02'].extracted.modeMagDist.distKm + 'km');
  }
}

main();
