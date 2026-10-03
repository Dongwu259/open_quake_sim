'use strict';
// =====================================================================
//  v6.7 source-classification batch — regional tectonic-class correctness.
//
//  Before this batch the offshore->interplate prior was gated on the JAPAN
//  subduction polylines only (physics.js _JAPAN_SUBDUCTION_LINES, 140 km),
//  so it could never fire in the global-mode regions: every Chile megathrust
//  preset (Valdivia/Maule/Illapel/Iquique, depth 22-25 km) resolved
//  'crustal' via the depth heuristic and was routed to the Japan crustal
//  GMPE. The batch adds:
//   1. Physics.REGIONAL_SUBDUCTION_LINES — per-region trench polylines
//      (approximate priors; explicit sourceType always wins);
//   2. Physics.setActiveSubductionLines / nearestSubductionFront — the
//      active-region front set, Japan default byte-identical when unset;
//   3. sourceType on every region-pack preset (curated metadata, carried
//      through the ComCat refresh tool untouched);
//   4. app wiring: regionActivate/regionDeactivate swap the front set,
//      applyPresetSelection adopts preset.sourceType, the Japan-only PSHA
//      card is honest-absent in region mode (info.psha_region_note).
//  Run with:  node --test tests/region-sourcetype.test.js
// =====================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Physics = require(path.join(ROOT, 'public', 'physics.js'));
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
const fetchToolSrc = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-comcat-presets.js'), 'utf8');
const buildToolSrc = fs.readFileSync(path.join(ROOT, 'tools', 'build-region-packs.js'), 'utf8');

const REGIONS = ['california', 'chile', 'italy', 'taiwan', 'newzealand'];
function loadPack(rid) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-' + rid + '.json'), 'utf8'));
}

test('registry: four regions carry fronts, italy documents its absence', () => {
  const R = Physics.REGIONAL_SUBDUCTION_LINES;
  assert.ok(R && typeof R === 'object', 'registry exists');
  for (const rid of ['chile', 'taiwan', 'newzealand', 'california']) {
    assert.ok(Array.isArray(R[rid]) && R[rid].length, rid + ' has front lines');
  }
  assert.equal(R.italy, undefined, 'italy carries no front (Apennine crustal; slab via depth rule)');
});

test('legacy path byte-identical: no active region -> Japan-only prior', () => {
  Physics.setActiveSubductionLines(null);
  // Chile megathrust coordinates with NO region active: the Japan prior must
  // not fire (this was the pre-batch behavior everywhere outside Japan).
  assert.equal(Physics.resolveSourceTypeAt(-36.122, -72.898, 22.9, null, null, true), 'crustal');
  // Japan behavior untouched: Tohoku offshore still resolves interplate.
  assert.equal(Physics.resolveSourceTypeAt(38.297, 142.373, 25, null, null, true), 'interplate');
  // depth rule untouched everywhere
  assert.equal(Physics.resolveSourceTypeAt(-36.122, -72.898, 63, null, null, true), 'intraslab');
});

test('active region: offshore near the regional trench resolves interplate', () => {
  const R = Physics.REGIONAL_SUBDUCTION_LINES;
  try {
    Physics.setActiveSubductionLines(R.chile);
    assert.equal(Physics.resolveSourceTypeAt(-36.122, -72.898, 22.9, null, null, true), 'interplate', 'Maule offshore');
    assert.equal(Physics.resolveSourceTypeAt(-38.143, -73.407, 25, null, null, true), 'interplate', 'Valdivia offshore');
    // inland stations stay crustal
    assert.equal(Physics.resolveSourceTypeAt(-33.45, -70.67, 23, null, null, false), 'crustal', 'Santiago inland');
    Physics.setActiveSubductionLines(R.newzealand);
    assert.equal(Physics.resolveSourceTypeAt(-45.762, 166.562, 12, null, null, true), 'interplate', 'Dusky Fiordland');
    Physics.setActiveSubductionLines(R.taiwan);
    assert.equal(Physics.resolveSourceTypeAt(23.836, 121.598, 40, null, null, true), 'interplate', 'Hualien 2024 offshore');
  } finally {
    Physics.setActiveSubductionLines(null);
  }
  // deactivation restores the legacy behavior exactly
  assert.equal(Physics.resolveSourceTypeAt(-36.122, -72.898, 22.9, null, null, true), 'crustal');
});

test('explicit sourceType and override always beat the front prior', () => {
  const R = Physics.REGIONAL_SUBDUCTION_LINES;
  try {
    Physics.setActiveSubductionLines(R.chile);
    assert.equal(Physics.resolveSourceTypeAt(-36.122, -72.898, 22.9, 'crustal', null, true), 'crustal', 'eventSource wins');
    assert.equal(Physics.resolveSourceTypeAt(-36.122, -72.898, 22.9, null, 'crustal', true), 'crustal', 'override wins');
  } finally {
    Physics.setActiveSubductionLines(null);
  }
});

test('every megathrust-preset epicenter sits inside its region front gate', () => {
  const R = Physics.REGIONAL_SUBDUCTION_LINES;
  const cases = [
    ['chile', 'cl-1960-valdivia'], ['chile', 'cl-2010-maule'], ['chile', 'cl-2015-illapel'], ['chile', 'cl-2014-iquique'],
    ['newzealand', 'nz-2009-dusky'], ['taiwan', 'tw-2024-hualien']
  ];
  for (const [rid, pid] of cases) {
    const p = loadPack(rid).presets.find((x) => x.id === pid);
    Physics.setActiveSubductionLines(R[rid]);
    const d = Physics.nearestSubductionFront(p.lat, p.lng).distanceKm;
    assert.ok(d <= 140, pid + ' front distance ' + d.toFixed(1) + ' km <= 140');
  }
  Physics.setActiveSubductionLines(null);
});

test('selectFaultPlane uses the active regional front strike as prior', () => {
  const R = Physics.REGIONAL_SUBDUCTION_LINES;
  try {
    Physics.setActiveSubductionLines(R.chile);
    const front = Physics.nearestSubductionFront(-36.122, -72.898);
    const sel = Physics.selectFaultPlane(
      { plane1: { strikeDeg: 16, dipDeg: 18, rakeDeg: 112 }, plane2: { strikeDeg: 180, dipDeg: 72, rakeDeg: 88 } },
      { sourceType: 'interplate', lat: -36.122, lng: -72.898 });
    assert.equal(sel.method, 'subduction-front-prior');
    // strikes are bidirectional: compare with the undirected difference
    var dStrike = Math.abs(((sel.plane.strikeDeg - front.strikeDeg) % 180 + 180) % 180);
    if (dStrike > 90) dStrike = 180 - dStrike;
    assert.ok(dStrike < 30, 'picked plane near trench strike (undirected ' + dStrike.toFixed(1) + ' deg)');
  } finally {
    Physics.setActiveSubductionLines(null);
  }
});

test('all 21 region presets carry a curated sourceType (packs)', () => {
  const expected = {
    'cl-1960-valdivia': 'interplate', 'cl-2010-maule': 'interplate', 'cl-2015-illapel': 'interplate', 'cl-2014-iquique': 'interplate',
    'tw-2024-hualien': 'interplate', 'nz-2009-dusky': 'interplate'
  };
  let n = 0;
  for (const rid of REGIONS) {
    for (const p of loadPack(rid).presets) {
      assert.ok(['crustal', 'interplate', 'intraslab'].includes(p.sourceType), p.id + ' sourceType declared, got ' + p.sourceType);
      if (expected[p.id]) assert.equal(p.sourceType, expected[p.id], p.id + ' classification');
      n++;
    }
  }
  assert.equal(n, 21, '21 region presets tagged');
  // california is all-crustal (San Andreas system), italy all-crustal (Apennine)
  for (const p of loadPack('california').presets) assert.equal(p.sourceType, 'crustal', p.id);
  for (const p of loadPack('italy').presets) assert.equal(p.sourceType, 'crustal', p.id);
});

test('sourceType survives the ComCat refresh chain (tool + snapshots)', () => {
  // The fetch tool rebuilds preset objects field-by-field; a missing carry
  // would silently strip the classification on the next --write run.
  assert.ok(/sourceType: preset\.sourceType/.test(fetchToolSrc), 'fetch tool carries sourceType into rewritten presets');
  // The fallback tables in the pack builder must match the committed packs.
  for (const [id, st] of [['cl-2010-maule', 'interplate'], ['tw-2024-hualien', 'interplate'], ['nz-2009-dusky', 'interplate'], ['it-2009-laquila', 'crustal']]) {
    const re = new RegExp("id: '" + id + "'[^\\n]*sourceType: '" + st + "'");
    assert.ok(re.test(buildToolSrc), 'build-region-packs fallback ' + id + ' = ' + st);
  }
  // Frozen snapshots record the classification per preset.
  for (const rid of REGIONS) {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'comcat-presets-' + rid + '.json'), 'utf8'));
    for (const p of snap.presets) {
      assert.ok(['crustal', 'interplate', 'intraslab'].includes(p.sourceType), rid + '/' + p.id + ' snapshot sourceType');
    }
  }
});

test('app wiring: activation swaps fronts, presets adopt sourceType', () => {
  assert.ok(/p\.src \|\| p\.sourceType \|\| null/.test(appSrc), 'applyPresetSelection adopts preset.sourceType');
  const actIdx = appSrc.indexOf('function regionActivate');
  const deactIdx = appSrc.indexOf('function regionDeactivate');
  assert.ok(actIdx > 0 && deactIdx > actIdx, 'region hooks present');
  assert.ok(appSrc.slice(actIdx, actIdx + 3000).includes('setActiveSubductionLines((Physics.REGIONAL_SUBDUCTION_LINES'),
    'activate installs the region front set');
  assert.ok(appSrc.slice(deactIdx, deactIdx + 3000).includes('setActiveSubductionLines(null)'),
    'deactivate restores the Japan default');
});

test('PSHA card in region mode: regional pack computes; note only when the pack is missing (v6.7 D)', () => {
  // v6.7 D landed per-region source models — the gate semantics changed from
  // "any active region" to "region active AND its pack confirmed missing".
  assert.ok(/function _pshaRegionActive\(\)/.test(appSrc), 'scope helper exists');
  const gi = appSrc.indexOf('function _pshaRegionGated');
  assert.ok(gi > 0, 'gate helper exists');
  const gbody = appSrc.slice(gi, gi + 300);
  assert.ok(gbody.includes('_pshaRegionActive()'), 'gate reads the active-region scope');
  assert.ok(gbody.includes('_pshaSourceModel === false'), 'gate fires only when the regional pack is confirmed missing');
  // all three draw functions still paint the note when gated
  for (const fn of ['drawPshaHazard', 'drawPshaUhs', 'drawPshaDeagg']) {
    const i = appSrc.indexOf('function ' + fn);
    assert.ok(i > 0, fn + ' exists');
    assert.ok(appSrc.slice(i, i + 800).includes("_pshaRegionGated()"), fn + ' gated');
    assert.ok(appSrc.slice(i, i + 800).includes("t('info.psha_region_note')"), fn + ' paints the note');
  }
  assert.ok(appSrc.includes('function _pshaClearForRegionSwitch'), 'cache/timer cleared on region switch');
  assert.ok(appSrc.includes('_pshaSourceModel = null;'), 'region switch forces a pack reload');
  const n = (i18nSrc.match(/"info\.psha_region_note":"[^"]+"/g) || []).length;
  assert.equal(n, 3, 'info.psha_region_note i18n x3, got ' + n);
});
