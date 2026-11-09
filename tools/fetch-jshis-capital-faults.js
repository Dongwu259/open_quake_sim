#!/usr/bin/env node
'use strict';
// =====================================================================
//  J-SHIS capital-region fault geometry freeze (R-A batch, 2026-10-17)
//
//  R-A context: the bundled Japan PSHA model's `tokyoInland` scenario
//  (capital M7.3, ERC Sagami-trough 2nd ed. umbrella rate 70%/30y)
//  has carried NO geometry since v1 — the engine's point-scenario
//  fallback (s.lat ?? 0) parks it at Null Island, so the capital
//  characteristic source contributes ~zero hazard. R-A revives it as a
//  multi-geometry set spread over OFFICIAL J-SHIS fault shapes.
//
//  This tool freezes the geometry inventory (data acquisition only —
//  no hazard computation here; the pre-registered hypotheses/gates live
//  in tools/psha-capital-multigeo.js and are written before any
//  measurement run).
//
//  PRE-REGISTERED SELECTION RULE (verbatim; mechanical, no hand list):
//    1. Universe: every F-prefixed ltecode in the Y2024 ltecode list
//       (https://www.j-shis.bosai.go.jp/cgi-bin/JSHIS2/getLtecodeList.cgi
//       ?version=Y2024) — the ERC major-active-fault-zone evaluations.
//       Marine evaluation codes (non-F) are out of scope: the capital
//       M7.3 class is an inland/shallow source per the ERC definition.
//    2. Excluded: composite entries (trailing letter A-F suffixes =
//       multi-segment/multi-fault simultaneous-rupture combinations) —
//       the standalone segment entries already tile those surfaces;
//       including both would double-count geometry.
//    3. Selected iff any polygon vertex falls inside the southern-Kanto
//       M7-class domain box  lat ∈ [34.90, 36.25], lng ∈ [139.00, 140.45]
//       (operationalisation of the ERC "南関東直下" evaluation area:
//       Tokyo / Kanagawa / Saitama-south / Chiba + immediate border).
//    4. Sensitivity subset ("strict", reported, not used for primary
//       weights): vertices inside lat ∈ [35.00, 36.00], lng ∈ [139.20,
//       140.40] — drops the north/west borderline entrants.
//
//  All fetched F-code geometries are frozen (selected flag per entry)
//  so the selection is auditable and reproducible; nothing is silently
//  dropped. J-SHIS is NIED government open data (attribution carried).
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'data', 'jshis-capital-faults.json');
const LTELIST_URL = 'https://www.j-shis.bosai.go.jp/cgi-bin/JSHIS2/getLtecodeList.cgi?version=Y2024';
const FLTINFO_URL = 'https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/{CODE}/fltinfo.geojson?epsg=4326';
const PRIMARY_BOX = { latMin: 34.90, latMax: 36.25, lngMin: 139.00, lngMax: 140.45 };
const STRICT_BOX = { latMin: 35.00, latMax: 36.00, lngMin: 139.20, lngMax: 140.40 };
const SLEEP_MS = 700; // be polite; 403 = rate limit per the API doc

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curlJson(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', '60', '--compressed', url],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('curl failed: ' + (stderr || err.message)));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('bad JSON from ' + url + ': ' + stdout.slice(0, 120))); }
      });
  });
}

function inBox(poly, box) {
  return poly.some(([lng, lat]) => lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax);
}

async function main() {
  const write = process.argv.includes('--write');
  const listDoc = await curlJson(LTELIST_URL);
  if (!listDoc || listDoc.success !== 'true' || !Array.isArray(listDoc.ltelist)) {
    throw new Error('ltecode list fetch failed: ' + JSON.stringify(listDoc).slice(0, 200));
  }
  // universe: standalone F-codes (drop A-F composite suffixes)
  const universe = listDoc.ltelist.filter((e) => /^F\d{6}$/.test(e.ltecode));
  console.log('ltecode list: ' + listDoc.ltelist.length + ' entries, ' + universe.length + ' standalone F-codes to fetch');

  const faults = [];
  let failures = [];
  for (let i = 0; i < universe.length; i++) {
    const e = universe[i];
    const url = FLTINFO_URL.replace('{CODE}', e.ltecode);
    let doc = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { doc = await curlJson(url); break; }
      catch (err) {
        if (attempt === 3) { failures.push({ code: e.ltecode, error: err.message.slice(0, 100) }); break; }
        console.log(e.ltecode + ' attempt ' + attempt + ' failed (' + err.message.slice(0, 60) + '), retry');
        await sleep(4000);
      }
    }
    await sleep(SLEEP_MS);
    if (!doc || doc.status !== 'Success' || !doc.features || !doc.features.length) {
      if (doc && doc.status !== 'Success') failures.push({ code: e.ltecode, error: 'status ' + doc.status });
      continue;
    }
    for (const f of doc.features) {
      const p = f.properties || {};
      const poly = (f.geometry && f.geometry.coordinates && f.geometry.coordinates[0]) || [];
      faults.push({
        code: e.ltecode, name: e.ltename, flt_id: p.flt_id,
        lenKm: +p.len, widKm: +p.wid, strikeDeg: +p.str, dipDeg: +p.dip, topDepthKm: +p.dep,
        topCenter: { lat: +p.lat, lng: +p.lon },
        polygonLngLatDep: poly.map((c) => [+c[0], +c[1], +c[2]])
      });
    }
    if ((i + 1) % 25 === 0) console.log('  ' + (i + 1) + '/' + universe.length + ' fetched...');
  }
  if (failures.length) console.log('fetch failures (' + failures.length + '): ' + JSON.stringify(failures));
  for (const f of faults) {
    f.selected = inBox(f.polygonLngLatDep, PRIMARY_BOX);
    f.selectedStrict = inBox(f.polygonLngLatDep, STRICT_BOX);
  }
  const sel = faults.filter((f) => f.selected);
  const selStrict = faults.filter((f) => f.selectedStrict);
  const totalLen = sel.reduce((a, f) => a + f.lenKm, 0);

  const report = {
    schema: 'quake-sim-jshis-capital-faults-v1',
    generatedAt: new Date().toISOString(),
    provenance: {
      lteListUrl: LTELIST_URL,
      fltinfoUrl: FLTINFO_URL,
      version: 'Y2024', case: 'AVR', epsg: 4326,
      license: 'NIED J-SHIS (防災科研 地震ハザードステーション) — government open data',
      note: 'rectangle fault-plane geometry (top-center + strike/dip/len/wid/topDepth + 3D corner polygon, [lng,lat,depthKm]) per ERC major-active-fault evaluation; the capital M7-class umbrella rate itself is NOT published per-fault by J-SHIS — this freeze carries GEOMETRY only'
    },
    selectionRule: {
      universe: 'every standalone F-code (regex ^F\\d{6}$) in the Y2024 ltecode list; composite A-F suffix entries excluded (standalone segments tile the same surfaces; including both would double-count)',
      primary: 'any polygon vertex inside lat [' + PRIMARY_BOX.latMin + ',' + PRIMARY_BOX.latMax + '] x lng [' + PRIMARY_BOX.lngMin + ',' + PRIMARY_BOX.lngMax + '] (southern-Kanto M7-class domain operationalisation)',
      strict: 'any polygon vertex inside lat [' + STRICT_BOX.latMin + ',' + STRICT_BOX.latMax + '] x lng [' + STRICT_BOX.lngMin + ',' + STRICT_BOX.lngMax + '] (borderline-drop sensitivity subset)',
      weights: 'primary rate split = trace-length share (lenKm); equal split is the sensitivity arm (psha-capital-multigeo.js W2)'
    },
    stats: {
      nLtecodeEntries: listDoc.ltelist.length,
      nFetchedFcodes: universe.length,
      nFaultPlanes: faults.length,
      nFetchFailures: failures.length,
      fetchFailures: failures,
      nSelected: sel.length,
      nSelectedStrict: selStrict.length,
      selectedTotalLenKm: +totalLen.toFixed(1)
    },
    selected: sel.map((f) => ({ code: f.code, name: f.name, lenKm: f.lenKm, widKm: f.widKm, dipDeg: f.dipDeg, strikeDeg: f.strikeDeg, topDepthKm: f.topDepthKm, strict: f.selectedStrict })),
    faults
  };
  console.log('\nselected ' + sel.length + ' planes (strict ' + selStrict.length + '), total trace ' + totalLen.toFixed(1) + ' km:');
  for (const f of sel) console.log('  ' + f.code + ' ' + f.name + ' len ' + f.lenKm + ' wid ' + f.widKm + ' dip ' + f.dipDeg + ' top ' + f.topDepthKm + (f.selectedStrict ? '' : '  (borderline: strict-box out)'));
  if (write) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log('wrote ' + OUT);
  } else {
    console.log('(dry run — pass --write to freeze)');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
