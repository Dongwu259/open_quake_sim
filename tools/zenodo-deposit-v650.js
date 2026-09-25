'use strict';
// One-off Zenodo deposit for v6.5.0, run from GitHub Actions (the /api/deposit
// write path is WAF-blocked for Chinese network classes; GitHub egress is the
// one known-good route). Reads ZN_TOKEN from the workflow env (repository
// secret, deleted right after this run) and the source zip path from ZIP_PATH.
const fs = require('node:fs');
const https = require('node:https');

const DEP_ID = 22862886; // v6.4.0 deposit (is_last of concept 22828696)
const VERSION = '6.5.0';
const ZIP = process.env.ZIP_PATH;
const zenTok = process.env.ZN_TOKEN;
if (!zenTok) throw new Error('ZN_TOKEN missing');
if (!ZIP || !fs.existsSync(ZIP)) throw new Error('ZIP_PATH missing: ' + ZIP);

function req(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body || null;
    const rq = https.request({
      host: u.host, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: Object.assign({}, opts.headers || {},
        payload ? { 'Content-Length': payload.length } : {}),
      timeout: opts.timeout || 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(opts.method + ' ' + u.pathname + ' -> ' + res.statusCode + ' ' + buf.toString('utf8').slice(0, 400)));
        } else resolve(buf);
      });
    });
    rq.on('error', reject);
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    if (payload) rq.write(payload);
    rq.end();
  });
}
(async () => {
  const H = { 'Authorization': 'Bearer ' + zenTok, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const parent = JSON.parse((await req('https://zenodo.org/api/deposit/depositions/' + DEP_ID, { method: 'GET', headers: H })).toString('utf8'));
  let draft;
  if (parent.links.latest_draft) {
    draft = JSON.parse((await req(parent.links.latest_draft, { method: 'GET', headers: H })).toString('utf8'));
    console.log('reusing existing draft:', draft.id, '| state:', draft.state);
  } else {
    await req('https://zenodo.org/api/deposit/depositions/' + DEP_ID + '/actions/newversion', { method: 'POST', headers: H, timeout: 180000 });
    await sleep(3000);
    const parent2 = JSON.parse((await req('https://zenodo.org/api/deposit/depositions/' + DEP_ID, { method: 'GET', headers: H })).toString('utf8'));
    if (!parent2.links.latest_draft) throw new Error('no latest_draft link - newversion failed?');
    draft = JSON.parse((await req(parent2.links.latest_draft, { method: 'GET', headers: H })).toString('utf8'));
    console.log('new draft:', draft.id, '| state:', draft.state);
  }
  await sleep(3000);

  for (const f of draft.files) {
    const delUrl = f.links && (f.links.self || ('https://zenodo.org/api/deposit/depositions/' + draft.id + '/files/' + encodeURIComponent(f.filename)));
    await req(delUrl, { method: 'DELETE', headers: H });
    console.log('deleted copied file:', f.filename);
    await sleep(2000);
  }

  const zip = fs.readFileSync(ZIP);
  const fname = encodeURIComponent('Dongwu259/open_quake_sim-' + VERSION + '.zip');
  await req(draft.links.bucket + '?filename=' + fname, {
    method: 'PUT', timeout: 600000,
    headers: { 'Authorization': 'Bearer ' + zenTok, 'Content-Type': 'application/zip' },
  }, zip);
  console.log('uploaded zip bytes:', zip.length);
  await sleep(3000);

  const md = draft.metadata;
  md.version = VERSION;
  md.publication_date = '2026-09-25';
  md.related_identifiers = [{
    identifier: 'https://github.com/Dongwu259/open_quake_sim/tree/v' + VERSION,
    relation: 'isSupplementTo', resource_type: 'software', scheme: 'url',
  }];
  const base = md.description || '';
  const platform = base.slice(0, base.indexOf('</p>') + 4);
  const bundled = base.slice(base.lastIndexOf('<p>'));
  md.description = platform +
    '<p>v6.5 brings regional tsunami to full parity: the JMA-grade alert chain now runs on regional forecast-area registries (the active region\u2019s own admin polygons snapped to its GEBCO 2025 bathymetry grid), so Chile / Italy / California ocean epicenters raise graded alerts with first-wave ETA countdowns, alert chimes and speech; a worker peak-cache fix repaired the physical-arrival path for standalone grids (verified live: Maule 13.4 m at 393 s, \u00d1uble 17.9 m at 142 s).</p>' +
    '<p>All three pilot regions bundle GEBCO 2025 bathymetry strips (Chile megathrust margin, Strait of Messina, California offshore incl. the southern Cascadia margin) and run the nonlinear SWE solver standalone; Italy/Chile use real Vs30 from the assembled USGS global hybrid (Heath et al. 2020, Earthquake Spectra 36(3), doi:10.1177/8755293020911137). Honest boundaries are documented in-package: JMA-semantics thresholds (not SHOA/CAT/NOAA products), land-cell preset epicenters keep tsunami off, and the nearshore water-cell artifact of the 1906 San Francisco preset is recorded, not tuned.</p>' +
    bundled;
  await req('https://zenodo.org/api/deposit/depositions/' + draft.id, {
    method: 'PUT', headers: H,
  }, Buffer.from(JSON.stringify({ metadata: md })));
  console.log('metadata patched:', VERSION);
  await sleep(3000);

  const pub = JSON.parse((await req('https://zenodo.org/api/deposit/depositions/' + draft.id + '/actions/publish', { method: 'POST', headers: H, timeout: 300000 })).toString('utf8'));
  console.log('PUBLISHED:', pub.doi, '| record', pub.id, '| latest:', pub.links && pub.links.latest_html);
})().catch((e) => { console.error('DEPOSIT FAILED:', e.message); process.exit(1); });
