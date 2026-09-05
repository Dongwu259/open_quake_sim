#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ResearchDataCatalog = require('../public/data-catalog.js');
const TsunamiValidation = require('../public/tsunami-validation.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
let checks = 0;
const failures = [];

function check(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

function hash6(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 6);
}

function walk(dir, extension, output) {
  output = output || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extension, output);
    else if (!extension || entry.name.endsWith(extension)) output.push(full);
  }
  return output;
}

function checkVersionedAssets() {
  const sources = ['public/index.html', 'public/app.js', 'public/i18n.js'];
  const seen = new Set();
  const pattern = /["']([A-Za-z0-9_./-]+\.(?:js|css|json))\?v=([^"'&#]+)["']/g;
  for (const source of sources) {
    const content = read(source);
    for (const match of content.matchAll(pattern)) {
      const relative = match[1].replace(/^\.\//, '');
      if (relative === 'sw.js') continue;
      const key = relative + '?' + match[2];
      if (seen.has(key)) continue;
      seen.add(key);
      const full = path.join(PUBLIC, relative);
      check(fs.existsSync(full), `${source}: versioned asset is missing: ${relative}`);
      if (fs.existsSync(full)) {
        check(match[2] === hash6(full), `${source}: stale hash for ${relative}: ${match[2]} != ${hash6(full)}`);
      }
    }
  }
  check(seen.size >= 15, `only ${seen.size} versioned assets were discovered`);
}

function checkPwa() {
  const sw = read('public/sw.js');
  const app = read('public/app.js');
  const index = read('public/index.html');
  const cacheMatch = sw.match(/CACHE_VERSION\s*=\s*['"]qs-cache-v(\d+)['"]/);
  const registration = app.match(/serviceWorker\.register\(['"]sw\.js\?v=(\d+)['"]\)/);
  const buildMarker = index.match(/data-sw=['"]sw\.js=v(\d+)['"]/);
  check(Boolean(cacheMatch), 'service worker CACHE_VERSION is missing');
  check(Boolean(registration), 'service worker registration version is missing');
  check(Boolean(buildMarker), 'index build marker service-worker version is missing');
  if (cacheMatch && registration) check(cacheMatch[1] === registration[1], 'service worker cache and registration versions differ');
  if (cacheMatch && buildMarker) check(cacheMatch[1] === buildMarker[1], 'service worker cache and build-marker versions differ');

  const precache = sw.match(/var PRECACHE_URLS\s*=\s*\[([\s\S]*?)\];/);
  check(Boolean(precache), 'service worker precache list is missing');
  if (precache) {
    const urls = Array.from(precache[1].matchAll(/['"]([^'"]+)['"]/g), match => match[1]);
    for (const url of urls) {
      const relative = url === './' ? 'index.html' : url.replace(/^\.\//, '');
      check(fs.existsSync(path.join(PUBLIC, relative)), `precache asset is missing: ${relative}`);
    }
    const protectedNames = ['counter.json', 'traffic.json', 'daily_visits.json', 'admin_password.txt'];
    for (const name of protectedNames) check(!urls.some(url => url.endsWith(name)), `runtime state is precached: ${name}`);
  }

  const manifest = json('public/manifest.json');
  check(manifest.name && manifest.short_name && manifest.start_url && manifest.scope, 'manifest is missing required identity fields');
  check(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest has no icons');
  for (const icon of manifest.icons || []) check(fs.existsSync(path.join(PUBLIC, icon.src)), `manifest icon is missing: ${icon.src}`);
}

function visitCoordinates(value, state) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    state.count++;
    if (!Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) state.invalid++;
    return;
  }
  for (const child of value) visitCoordinates(child, state);
}

function checkResearchData() {
  for (const file of walk(PUBLIC, '.json')) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { check(false, `${path.relative(ROOT, file)} is invalid JSON: ${error.message}`); }
  }

  const terrain = json('public/geojson/bathymetry.json');
  check(Number.isInteger(terrain.nx) && Number.isInteger(terrain.ny) && terrain.nx > 1 && terrain.ny > 1, 'terrain grid dimensions are invalid');
  check(Array.isArray(terrain.data) && terrain.data.length === terrain.nx * terrain.ny, 'terrain data length does not match dimensions');
  check(terrain.data.every(Number.isFinite), 'terrain contains non-finite cells');
  const land = terrain.data.filter(value => value >= 0).length;
  const water = terrain.data.length - land;
  check(land > 0 && water > 0, 'terrain must contain both land and water');
  check(terrain.meta && terrain.meta.schema && terrain.meta.dataset && terrain.meta.source && terrain.meta.license && terrain.meta.quality, 'terrain provenance metadata is incomplete');
  check(!terrain.meta || terrain.meta.landCells === land, 'terrain metadata land-cell count is stale');
  check(!terrain.meta || terrain.meta.waterCells === water, 'terrain metadata water-cell count is stale');

  const dataManifest = json('public/geojson/research_data_manifest.json');
  const manifestCheck = ResearchDataCatalog.validateManifest(dataManifest);
  check(manifestCheck.valid, `research data manifest is invalid: ${manifestCheck.errors.join(', ')}`);
  check(manifestCheck.researchReady === false, 'bundled demonstration fallbacks must not be research-certified');
  for (const resource of dataManifest.resources || []) {
    if (!resource.path || !resource.sha256) continue;
    const full = path.join(PUBLIC, resource.path);
    check(fs.existsSync(full), `manifest resource is missing: ${resource.path}`);
    if (fs.existsSync(full)) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      check(digest === resource.sha256, `manifest SHA-256 is stale: ${resource.path}`);
    }
  }
  const historicalTsunami = json('public/geojson/historical_tsunami_observations.json');
  const tsunamiObservationCheck = TsunamiValidation.validate(historicalTsunami);
  check(tsunamiObservationCheck.valid, `historical tsunami dataset is invalid: ${tsunamiObservationCheck.errors.join(', ')}`);
  check(tsunamiObservationCheck.eventCount >= 3 && tsunamiObservationCheck.observationCount >= 10 && tsunamiObservationCheck.areaCount >= 10,
    'historical tsunami validation coverage is below the v5.1 release minimum');
  check(tsunamiObservationCheck.researchReady === true,
    'historical tsunami observations must stay research-certified (direct curation v2, R5-6): researchReady regressed');
  check(tsunamiObservationCheck.directCount === tsunamiObservationCheck.observationCount + tsunamiObservationCheck.areaCount,
    'historical tsunami dataset carries non-direct records; every observation and area must cite its primary record');

  const areas = json('public/geojson/jma_tsunami_forecast_areas.json');
  check(areas.type === 'FeatureCollection' && areas.features.length === 66, `expected 66 JMA tsunami areas, got ${areas.features && areas.features.length}`);
  check(areas.metadata && areas.metadata.source && areas.metadata.sourceUrl && areas.metadata.release && areas.metadata.usageNote, 'JMA area provenance metadata is incomplete');
  const codes = new Set();
  let coordinateCount = 0;
  for (const feature of areas.features || []) {
    const code = feature.properties && String(feature.properties.code || '');
    check(/^\d+$/.test(code), 'JMA area has an invalid code');
    check(feature.properties && feature.properties.name, `JMA area ${code || '?'} has no name`);
    check(!codes.has(code), `duplicate JMA area code: ${code}`);
    codes.add(code);
    const state = { count: 0, invalid: 0 };
    visitCoordinates(feature.geometry && feature.geometry.coordinates, state);
    coordinateCount += state.count;
    check(state.count >= 2 && state.invalid === 0, `JMA area ${code || '?'} has invalid geometry coordinates`);
  }
  check(coordinateCount > 1000, `JMA area geometry is unexpectedly sparse: ${coordinateCount} points`);

  const stations = json('public/geojson/stations.json');
  const jmaCatalog = json('public/geojson/jma_stations.json');
  const seafloor = json('public/geojson/seafloor_stations.json');
  check(Array.isArray(stations) && stations.length === 1289, `expected 1289 land stations, got ${stations.length}`);
  check(Array.isArray(seafloor) && seafloor.length === 237, `expected 237 official seafloor stations, got ${seafloor.length}`);
  const names = new Set();
  const stationIds = new Set();
  for (const station of stations) {
    check(Number.isFinite(station.lat) && Number.isFinite(station.lng) && Number.isFinite(station.vs30) && station.vs30 > 0, `invalid land station: ${station.name || station.id}`);
    check(Boolean(station.name), `station ${station.id} has no name`);
    check(Number.isInteger(station.id) && !stationIds.has(station.id), `duplicate or invalid station id: ${station.id}`);
    stationIds.add(station.id);
    names.add(station.name);
  }
  const seafloorCodes = new Set();
  const seafloorCounts = { DONET1: 0, DONET2: 0, 'S-net': 0, 'N-net': 0 };
  for (const station of seafloor) {
    check(Number.isFinite(station.lat) && station.lat >= 30 && station.lat <= 45 &&
      Number.isFinite(station.lng) && station.lng >= 130 && station.lng <= 148,
    `invalid seafloor station coordinates: ${station.name || '?'}`);
    check(Number.isInteger(station.depth) && station.depth > 0 && station.depth < 9000,
      `invalid seafloor station depth: ${station.name || '?'}`);
    check(station.name === station.officialCode && /^[MN]\.[A-Z0-9]+$/.test(station.officialCode) &&
      !seafloorCodes.has(station.officialCode), `invalid or duplicate seafloor station code: ${station.name || '?'}`);
    check(Object.prototype.hasOwnProperty.call(seafloorCounts, station.network),
      `invalid seafloor station network: ${station.network || '?'}`);
    check(station.sourceUrl === 'https://www.seafloor.bosai.go.jp/st_info/' && /^\d{4}-\d{2}-\d{2}$/.test(station.sourceRetrieved),
      `seafloor station lacks official provenance: ${station.name || '?'}`);
    check(station.catalogStatus === 'listed' && station.operationalStatus === 'not-provided',
      `seafloor station status semantics are missing: ${station.name || '?'}`);
    seafloorCodes.add(station.officialCode);
    if (Object.prototype.hasOwnProperty.call(seafloorCounts, station.network)) seafloorCounts[station.network]++;
  }
  check(seafloorCounts.DONET1 === 22 && seafloorCounts.DONET2 === 29 && seafloorCounts['S-net'] === 150 && seafloorCounts['N-net'] === 36,
    `unexpected seafloor network counts: ${JSON.stringify(seafloorCounts)}`);
  const seafloorAnchors = new Map(seafloor.map(station => [station.officialCode, station]));
  check(seafloorAnchors.get('N.S1N01')?.lat === 35.8968 && seafloorAnchors.get('N.S1N01')?.lng === 141.0535,
    'S-net official coordinate anchor N.S1N01 does not match NIED');
  check(seafloorAnchors.get('N.S6N25')?.lat === 34.6696 && seafloorAnchors.get('N.S6N25')?.lng === 139.8167,
    'S-net official coordinate anchor N.S6N25 does not match NIED');
  check(seafloorAnchors.get('N.NAE01')?.lat === 32.7687 && seafloorAnchors.get('N.NBE18')?.lng === 131.7726,
    'N-net official coordinate anchors do not match NIED');
  check(!seafloorCodes.has('M.KMDB1'), 'obsolete non-catalog station M.KMDB1 is still bundled');
  check(jmaCatalog && jmaCatalog._schema === 'quake-sim-jma-station-catalog-v1' && Array.isArray(jmaCatalog.stations), 'JMA station catalog is missing');
  check(jmaCatalog.stations.length === 2396, `expected 2396 JMA stations, got ${jmaCatalog.stations.length}`);
  const jmaStationIds = new Set();
  for (const station of (jmaCatalog.stations || [])) {
    check(/^jma:\d+$/.test(String(station.id)) && !jmaStationIds.has(String(station.id)), `invalid or duplicate JMA station id: ${station.id}`);
    check(Number.isFinite(station.lat) && Number.isFinite(station.lng) && station.name === String(station.name), `invalid JMA station: ${station.id}`);
    check(typeof station.sourceUrl === 'string' && /^https?:\/\//.test(station.sourceUrl), `JMA station lacks source URL: ${station.id}`);
    jmaStationIds.add(String(station.id));
  }

  const observed = json('public/geojson/observed.json');
  const events = Object.entries(observed).filter(([key]) => !key.startsWith('_'));
  check(Array.isArray(observed._sources) && observed._sources.length > 0, 'observed-event source citations are missing');
  check(observed._dataset && observed._dataset.schema === 'quake-sim-observed-intensity-v2', 'observed dataset provenance schema is missing');
  check(observed._dataset && observed._dataset.coordinateBasis, 'observed dataset coordinate basis is missing');
  check(events.length >= 19, `observed validation set is too small: ${events.length} events`);
  const split = observed._validation;
  check(split && split.schema === 'quake-sim-validation-split-v1', 'observed validation split metadata is missing');
  const splitIds = split ? ['training','calibration','independent'].flatMap(name => Array.isArray(split[name]) ? split[name] : []) : [];
  check(new Set(splitIds).size === splitIds.length, 'an observed event appears in multiple validation splits');
  check(splitIds.length === events.length, 'validation splits do not cover every observed event exactly once');
  for (const [key] of events) check(splitIds.includes(key), `observed event ${key} is not assigned to a validation split`);
  const validIntensity = /^(?:[0-7]|5[+-]|6[+-])$/;
  const exactIndependentEvents = new Set();
  let exactIndependentRecords = 0;
  for (const [key, event] of events) {
    check(Number.isFinite(event.mw) && Number.isFinite(event.epi_lat) && Number.isFinite(event.epi_lng) && Number.isFinite(event.depth)
      && Number.isFinite(event.strike) && Number.isFinite(event.dip) && Number.isFinite(event.rake), `observed event ${key} has invalid source parameters`);
    check(event.obs && Object.keys(event.obs).length > 0, `observed event ${key} has no observations`);
    for (const [name, rawObservation] of Object.entries(event.obs || {})) {
      const observation = rawObservation && typeof rawObservation === 'object' ? rawObservation : {intensity:rawObservation};
      const intensity = observation.intensity;
      if (observation.stationId != null) {
        const stationId = String(observation.stationId);
        check(stationId.startsWith('jma:') ? jmaStationIds.has(stationId) : stationIds.has(Number(stationId)), `observed event ${key} references unknown stationId ${observation.stationId}`);
        check(typeof observation.source === 'string' && /^https?:\/\//.test(observation.source), `observed event ${key}/${name} exact station lacks source URL`);
        if (stationId.startsWith('jma:') && split.independent.includes(key) && observation.quality === 'direct') {
          exactIndependentEvents.add(key);
          exactIndependentRecords++;
        }
      } else {
        check(names.has(name), `observed event ${key} references unknown station ${name}`);
      }
      check(validIntensity.test(String(intensity)), `observed event ${key} has invalid intensity ${intensity}`);
      if (observation.quality != null) check(['direct','estimated','proxy'].includes(observation.quality), `observed event ${key}/${name} has invalid quality`);
    }
  }
  check(exactIndependentEvents.size >= 5, `expected at least 5 exact-JMA independent events, got ${exactIndependentEvents.size}`);
  check(exactIndependentRecords >= 2599, `expected at least 2599 exact-JMA independent records, got ${exactIndependentRecords}`);
}

function loadTranslations() {
  const context = { localStorage: { getItem: () => null, setItem: () => {} }, console };
  vm.createContext(context);
  vm.runInContext(read('public/i18n.js'), context, { filename: 'public/i18n.js' });
  vm.runInContext(read('public/i18n-help.js'), context, { filename: 'public/i18n-help.js' });
  return context;
}

function checkDocumentation() {
  const context = loadTranslations();
  for (const dictionaryName of ['I18N', 'I18N_HELP']) {
    const dictionary = context[dictionaryName];
    check(dictionary && dictionary.ja && dictionary.en && dictionary.zh, `${dictionaryName} does not contain all three languages`);
    const union = new Set(Object.values(dictionary || {}).flatMap(Object.keys));
    for (const language of ['ja', 'en', 'zh']) {
      const missing = Array.from(union).filter(key => !(key in dictionary[language]));
      check(missing.length === 0, `${dictionaryName}.${language} is missing ${missing.length} keys: ${missing.slice(0, 5).join(', ')}`);
    }
  }

  const html = read('public/index.html');
  const app = read('public/app.js');
  check(!html.includes('\uFFFD'), 'index.html contains Unicode replacement characters (encoding corruption)');
  check(!/\?\/(?:div|span|p|button|h[1-6]|a|code|small|li)>/i.test(html), 'index.html contains malformed closing tags');
  check(/TTSTextBuilder\.buildIntensitySurvey\(\)/.test(app), 'intensity survey is not connected to dynamic TTS');
  check(/id:'intensity-survey'[\s\S]{0,700}onComplete:[\s\S]{0,300}_dismissShindoReport\(\)/.test(app), 'intensity survey does not close after speech completion');
  check(/soundModeEl\.value !== 'jp'\) playEEWSound\('EEW2'\)/.test(app), 'legacy Japanese EEW voice is still enabled');
  check(/playEEWSound\('EEW_alert'\)/.test(app) && !/playEEWSound\('EEW1'\)/.test(app), 'dedicated EEW alert effect is not used exclusively');
  check(/playShindoAlert\(_globalMaxShindo\)/.test(app) && !/activateCircles[\s\S]{0,900}playShindoAlert\(/.test(app), 'Shindo alert is not limited to the final maximum');
  const audio = read('public/audio.js');
  check(/clearTimeout\(requestTimeoutId\)[\s\S]{0,500}source\.start\(0\)/.test(audio), 'remote TTS request timeout can still truncate playback');
  const referenced = new Set(Array.from(html.matchAll(/data-i18n(?:-html|-aria|-ph)?=['"]([^'"]+)['"]/g), match => match[1]));
  for (const key of referenced) {
    check(context.I18N.en[key] !== undefined || context.I18N_HELP.en[key] !== undefined, `HTML references unknown i18n key: ${key}`);
  }
  for (const language of ['ja', 'en', 'zh']) {
    const text = context.I18N[language]['formulas.tsunami_warning'] || '';
    check(/NLSWE|浅水|shallow-water/i.test(text), `${language} tsunami documentation does not describe the current solver`);
    const notice = context.I18N[language]['formulas.notice_text'] || '';
    check(notice.length > 20, `${language} scientific disclaimer is missing`);
  }
  check(/v6\.2/.test(json('public/manifest.json').description || ''), 'manifest version is not v6.2');
  check(json('package.json').version === '6.2.1', 'package version is not the 6.2.1 release');
  // v5.2 presenter (live/recording) mode wiring
  check(html.includes('id="presenter-mode"') && html.includes('id="presenter-panel"') && html.includes('id="btn-presenter-exit"'), 'presenter mode markup is missing');
  check(/function enterPresenterMode\(\)[\s\S]{0,300}updatePresenterPanel\(\)/.test(app) && /function exitPresenterMode\(\)/.test(app), 'presenter mode enter/exit is not wired in app.js');
}

function checkAccessibility() {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const quake3d = read('public/quake3d.js');
  const canvases = Array.from(html.matchAll(/<canvas\b[^>]*>/g), match => match[0]);
  check(canvases.length >= 15, `expected at least 15 user-facing canvases, got ${canvases.length}`);
  for (const canvas of canvases) {
    check(/role=['"]img['"]/.test(canvas), `canvas lacks role=img: ${canvas.slice(0, 100)}`);
    check(/data-i18n-aria=['"][^'"]+['"]/.test(canvas), `canvas lacks localized accessible name: ${canvas.slice(0, 100)}`);
  }
  check(/id=['"]map['"][^>]*tabindex=['"]0['"][^>]*aria-busy=['"]true['"]/.test(html), 'map lacks keyboard focus or loading state');
  check((html.match(/role=['"]menuitem['"]/g) || []).length === 3, 'map action menu must contain three semantic menu items');
  check(/e\.key === 'ContextMenu'/.test(app) && /e\.shiftKey && e\.key === 'F10'/.test(app), 'map menu lacks ContextMenu/Shift+F10 support');
  check(/refreshCanvasA11yDescriptions\(curMaxPga, curMaxSh\)/.test(app), 'dynamic canvas summaries are not connected to simulation updates');
  check(/prefers-reduced-motion: reduce/.test(quake3d) && /continuousAnimation/.test(quake3d), '3D reduced-motion diagnostics are missing');
  check(/if \(_reducedMotion\) \{ requestRender\(\); return; \}/.test(quake3d), '3D reduced-motion mode still starts the continuous animation loop');
}

checkVersionedAssets();
checkPwa();
checkResearchData();
checkDocumentation();
checkAccessibility();

if (failures.length) {
  console.error(`\nRelease validation failed: ${failures.length}/${checks} checks failed.`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release validation passed: ${checks} checks (assets, PWA, research data, i18n, accessibility).`);
}
