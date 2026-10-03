// ================================================================
//  v6.5 regional-tsunami ALERT batch — why Chile never warned and the fix.
//
//  Root cause (user report 2026-09-25): the JMA 66-area chain iterates
//  _tsuCheckPoints, whose offshore controls ALL sit in Japanese waters; a
//  Chile event is beyond the 1200 km forecast gate from every one of them,
//  so tsunamiCircles stayed empty — the wave ran on the standalone grid with
//  zero alert output (no panel, no chime, no TTS, no ETA list).
//
//  Fix: while a region with both an admin-areas package and a loaded regional
//  bathy grid is active, app.js swaps the forecast-area registry to that
//  region's own polygons snapped to its grid (area codes 'rNNN'); the JMA
//  chain, ETA panel, chimes and speech then run unchanged on regional codes.
//
//  These tests lock: (1) the physics no-op assumptions the regional chain
//  relies on, (2) an INDEPENDENT re-derivation of the registry build over the
//  real chile/italy/california areas+grids (every coastal area gets controls,
//  bounded per area, wet and positive-depth), and (3) the app.js/i18n wiring
//  anchors.  Run with:  node --test tests/region-tsunami-alert.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const I18N = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');

function loadGrid(id) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'grids', id + '.json'), 'utf8'));
}
function loadAreas(rid) {
  // packages wrap the FeatureCollection: {_schema, unit, areas: {...FC}}
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-areas-' + rid + '.json'), 'utf8'));
  assert.equal(pkg._schema, 'quake-sim-region-areas-v1', rid + ' areas package schema');
  return pkg.areas;
}

// ---------------------------------------------------------------- physics
test('jmaTsunamiBasinTransmission is identity for unknown (regional) codes', () => {
  // The regional chain reuses the JMA call sites verbatim; that is only sound
  // because unknown basins return 1 (physics.js line-locked assumption).
  assert.equal(Physics.jmaTsunamiBasinTransmission('r001', 'r002', 500), 1);
  assert.equal(Physics.jmaTsunamiBasinTransmission('r016', 'r001', 2500), 1);
  // and the mixed case (nearest-JMA source vs regional target) stays 1 too
  assert.equal(Physics.jmaTsunamiBasinTransmission('600', 'r003', 800), 1);
});

test('findNearestWetCell contract: wet snap, radius bound, dry-only null', () => {
  // 5x5 grid, water in the middle column (negative = water per the schema)
  const grid = { origin: [0, 0], res: 0.1, nx: 5, ny: 5,
    data: [1,1,1,1,1, 1,1,-5,1,1, 1,1,-8,1,1, 1,1,-6,1,1, 1,1,1,1,1] };
  const wet = Physics.findNearestWetCell(grid, 0.2, 0.05, 2);
  assert.ok(wet && wet.depth > 0, 'wet cell found, depth positive: ' + (wet && wet.depth));
  assert.equal(wet.index, 2 * 5 + 2, 'middle-column water cell');
  // a coastal vertex two cells away still snaps; beyond the radius it must not
  assert.ok(Physics.findNearestWetCell(grid, 0.2, 0.25, 2), 'within radius 2');
  const dry = { origin: [0, 0], res: 0.1, nx: 5, ny: 5, data: new Array(25).fill(2) };
  assert.equal(Physics.findNearestWetCell(dry, 0.2, 0.2, 4), null, 'dry-only grid -> null');
});

// ------------------------------------------------ v6.5.1 inland-water exemption
// The regional forecast-area snap must not treat enclosed below-sea-level
// basins as ocean: the Salton Sea reads as water in the GEBCO grid (its bed
// is below sea level) but no tsunami can reach it. Eligibility = wet AND at
// least 10 m deep AND connected to a majority-deep grid edge through water at
// least that deep (the alert chain's own 10 m shoaling contour).
test('oceanConnectedMask: enclosed deep lake excluded, deep-channel bay kept, edge vote', () => {
  // 10x8 grid (rows y=0 south .. 7 north): open ocean on the west column
  // (x=0, -200 m), a deep channel (y=3..4, x=1..5, -50 m) feeding a bay
  // (x=6..7, y=3..4, -30 m), an enclosed deep "lake" fully interior
  // (x=7..8, y=1..2, -80 m), everything else land (+5). Only the west edge
  // is majority-deep.
  const data = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
    let v = 5;
    if (x === 0) v = -200;                                        // open ocean
    if (x >= 1 && x <= 5 && (y === 3 || y === 4)) v = -50;        // deep channel
    if ((x === 6 || x === 7) && (y === 3 || y === 4)) v = -30;    // bay (connected)
    if ((x === 7 || x === 8) && (y === 0 || y === 1)) v = -80;    // enclosed lake
    data.push(v);
  }
  const grid = { origin: [0, 0], res: 0.1, nx: 10, ny: 8, data };
  const mask = Physics.oceanConnectedMask(grid);
  assert.ok(mask instanceof Uint8Array, 'mask built');
  assert.equal(mask[5 * 10 + 0], 1, 'open ocean eligible');
  assert.equal(mask[3 * 10 + 3], 1, 'deep channel eligible');
  assert.equal(mask[4 * 10 + 6], 1, 'bay eligible (deep-connected through the channel)');
  assert.equal(mask[1 * 10 + 7], 0, 'enclosed deep lake NOT eligible');
  assert.equal(mask[0 * 10 + 8], 0, 'lake cell on the land-dominated south edge not seeded');
  // shallow-but-connected cells are not eligible (depth gate): cutting the
  // channel (both rows) drops the bay behind it
  const shallow = data.slice(); shallow[3 * 10 + 3] = -5; shallow[4 * 10 + 3] = -5;
  const mask2 = Physics.oceanConnectedMask({ origin: [0, 0], res: 0.1, nx: 10, ny: 8, data: shallow });
  assert.equal(mask2[3 * 10 + 3], 0, 'shallow (<10 m) channel cell excluded');
  assert.equal(mask2[4 * 10 + 6], 0, 'bay beyond the broken deep channel excluded');
  // no majority-deep edge -> null (caller keeps unmasked behaviour)
  const landlockedData = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
    landlockedData.push((x >= 1 && x <= 2 && y >= 1 && y <= 2) ? -20 : 1);
  const landlocked = Physics.oceanConnectedMask({ origin: [0, 0], res: 0.1, nx: 4, ny: 4, data: landlockedData });
  assert.equal(landlocked, null, 'no deep edge cell -> null');
});

test('findNearestWetCell honours the optional mask (4-arg calls byte-identical)', () => {
  const grid = { origin: [0, 0], res: 0.1, nx: 5, ny: 5,
    data: [1,1,1,1,1, 1,1,-5,1,1, 1,1,-8,1,1, 1,1,-6,1,1, 1,1,1,1,1] };
  const unmasked = Physics.findNearestWetCell(grid, 0.2, 0.05, 2);
  assert.ok(unmasked, 'unmasked finds the water');
  const mask = new Uint8Array(25); // nothing eligible
  assert.equal(Physics.findNearestWetCell(grid, 0.2, 0.05, 2, mask), null, 'fully masked -> null');
  const mask2 = new Uint8Array(25); mask2[2 * 5 + 2] = 1;
  const masked = Physics.findNearestWetCell(grid, 0.2, 0.05, 2, mask2);
  assert.equal(masked && masked.index, 2 * 5 + 2, 'mask passes the eligible cell through');
});

// ------------------------------------------- independent re-derivation
// Same algorithm as buildRegionalTsunamiForecastAreas, re-implemented here so
// a regression in app.js cannot silently hollow out the registry (the app
// script itself is browser-only and cannot be required from node).
function deriveRegionalAreas(areasFC, grid, opts) {
  const useMask = !opts || opts.mask !== false; // mirrors the production builder
  const mask = useMask ? Physics.oceanConnectedMask(grid) : null;
  const out = [];
  for (const f of areasFC.features) {
    const geom = f.geometry || {};
    let rings = [];
    if (geom.type === 'Polygon') rings = geom.coordinates || [];
    else if (geom.type === 'MultiPolygon') for (const p of geom.coordinates) rings = rings.concat(p);
    const seen = new Set();
    let controls = 0, lines = 0;
    for (const ring of rings) {
      let coast = 0;
      for (const c of ring) {
        const wet = Physics.findNearestWetCell(grid, c[1], c[0], 2, mask);
        if (!wet) { if (coast > 1) lines++; coast = 0; continue; }
        coast++;
        if (!seen.has(wet.index)) { seen.add(wet.index); controls++; }
      }
      if (coast > 1) lines++;
    }
    if (controls > 0) out.push({ name: f.properties.name, controls: Math.min(controls, 80), lines });
  }
  return out;
}

test('chile registry: coastal regions get bounded wet controls + drawable coast lines', () => {
  const areas = deriveRegionalAreas(loadAreas('chile'), loadGrid('cl-megathrust'));
  // Chile's admin regions are coastal strips except Santiago Metropolitan;
  // every coastal one must yield controls.
  assert.ok(areas.length >= 14 && areas.length <= 16, 'coastal chile regions with controls: ' + areas.length);
  assert.ok(!areas.some(a => /metropolitan|santiago/i.test(a.name)), 'inland Santiago region correctly control-less');
  for (const a of areas) {
    assert.ok(a.controls > 0 && a.controls <= 80, a.name + ' bounded controls: ' + a.controls);
    assert.ok(a.lines > 0, a.name + ' has drawable coastal lines');
  }
  const total = areas.reduce((s, a) => s + a.controls, 0);
  assert.ok(total >= 150, 'chile control mass: ' + total);
});

test('italy registry: coastal provinces covered (Mediterranean basins)', () => {
  const areas = deriveRegionalAreas(loadAreas('italy'), loadGrid('it-messina'));
  // the messina strip is regional-scale; provinces inside it are coastal
  assert.ok(areas.length >= 1, 'messina-strip provinces with controls: ' + areas.length);
});

test('california registry: coastal counties covered on the new strip', () => {
  const areas = deriveRegionalAreas(loadAreas('california'), loadGrid('us-california'));
  assert.ok(areas.length >= 10, 'coastal CA counties with controls: ' + areas.length);
  for (const a of areas) {
    assert.ok(a.controls > 0 && a.controls <= 80, a.name + ' bounded controls: ' + a.controls);
  }
});

// v6.5.1 inland-water exemption on the REAL packages (numbers frozen from the
// production rule measured on the committed grids):
test('california registry: Salton Sea / inland counties excluded by the ocean mask', () => {
  const grid = loadGrid('us-california');
  const mask = Physics.oceanConnectedMask(grid);
  assert.ok(mask, 'mask built for the CA strip');
  // Salton Sea west-shore cells are wet but landlocked — ineligible
  const saltonIdx = Math.round((33.35 - grid.origin[1]) / grid.res) * grid.nx + Math.round((-116.05 - grid.origin[0]) / grid.res);
  assert.ok(Number(grid.data[saltonIdx]) < 0, 'salton shore cell is wet in the grid');
  assert.equal(mask[saltonIdx], 0, 'salton shore cell NOT ocean-eligible');
  // San Francisco Bay IS ocean-connected through the deep Golden Gate channel
  const sfIdx = Math.round((37.75 - grid.origin[1]) / grid.res) * grid.nx + Math.round((-122.42 - grid.origin[0]) / grid.res);
  assert.equal(mask[sfIdx], 1, 'SF Bay eligible (deep-connected)');
  const areas = deriveRegionalAreas(loadAreas('california'), grid);
  const names = areas.map(a => a.name);
  assert.equal(areas.length, 17, 'masked CA registry area count: ' + areas.length);
  for (const inland of ['Imperial', 'Riverside', 'Sacramento', 'San Joaquin', 'Yolo', 'Solano', 'San Benito', 'Napa', 'Santa Clara'])
    assert.ok(!names.includes(inland), inland + ' (inland/unresolvable water only) dropped from the tsunami registry');
  const total = areas.reduce((s, a) => s + a.controls, 0);
  assert.equal(total, 350, 'masked CA control total: ' + total);
  // the unmasked registry still contains Imperial — the exemption is the mask
  const unmasked = deriveRegionalAreas(loadAreas('california'), grid, { mask: false });
  assert.ok(unmasked.some(a => a.name === 'Imperial'), 'pre-mask Imperial had Salton controls (regression anchor)');
});

test('chile/italy masked registries: near-stable control totals', () => {
  const cl = deriveRegionalAreas(loadAreas('chile'), loadGrid('cl-megathrust'));
  assert.equal(cl.length, 14, 'chile areas: ' + cl.length);
  assert.equal(cl.reduce((s, a) => s + a.controls, 0), 622, 'chile controls');
  const it = deriveRegionalAreas(loadAreas('italy'), loadGrid('it-messina'));
  assert.equal(it.length, 3, 'italy areas: ' + it.length);
  assert.equal(it.reduce((s, a) => s + a.controls, 0), 136, 'italy controls');
});

// v6.7 regions: the same registry derivation frozen on the real packages
test('taiwan/newzealand masked registries: coastal units + bounded controls', () => {
  const tw = deriveRegionalAreas(loadAreas('taiwan'), loadGrid('tw-taiwan'));
  assert.equal(tw.length, 18, 'taiwan coastal counties: ' + tw.length);
  assert.equal(tw.reduce((s, a) => s + a.controls, 0), 203, 'taiwan controls');
  const twNames = tw.map(a => a.name);
  // Nantou is Taiwan's only landlocked county, Chiayi City an inland enclave,
  // Kinmen sits west of the grid window (118.4°E < 118.5°E) — all three
  // correctly absent
  for (const absent of ['Nantou', 'Chiayi City', 'Kinmen'])
    assert.ok(!twNames.includes(absent), absent + ' correctly control-less');
  assert.ok(tw.some(a => a.name === 'Hualien' && a.controls >= 20), 'Hualien east-coast control mass: ' + (tw.find(a => a.name === 'Hualien') || {}).controls);

  const nz = deriveRegionalAreas(loadAreas('newzealand'), loadGrid('nz-aotearoa'));
  assert.equal(nz.length, 18, 'newzealand coastal regions: ' + nz.length);
  assert.equal(nz.reduce((s, a) => s + a.controls, 0), 921, 'newzealand controls');
  const nzNames = nz.map(a => a.name);
  assert.ok(!nzNames.includes('Chatham Islands Territory'), 'Chatham outside the grid window, correctly absent');
  for (const a of nz) {
    assert.ok(a.controls > 0 && a.controls <= 80, a.name + ' bounded controls: ' + a.controls);
    assert.ok(a.lines > 0, a.name + ' has drawable coastal lines');
  }
});

// ------------------------------------------------------------- wiring
test('app.js: regional registry builder + swap/restore lifecycle wired', () => {
  assert.match(APP, /function buildRegionalTsunamiForecastAreas/, 'builder exists');
  assert.match(APP, /function _ensureRegionalTsuAreas/, 'ensure helper exists');
  assert.match(APP, /function _restoreJmaTsuAreas/, 'restore helper exists');
  // swap inputs: region areas package + a loaded regional grid only
  const builder = APP.match(/function buildRegionalTsunamiForecastAreas[\s\S]*?\n\}/)[0];
  assert.match(builder, /REGION_STATE\.active/, 'gated to an active region');
  assert.match(builder, /REGION_STATE\.areas/, 'needs the areas package');
  assert.match(builder, /_regionalBathy\[/, 'needs the loaded regional grid');
  assert.match(builder, /'r' \+ String/, "area codes are the 'rNNN' namespace");
  assert.match(builder, /controls\.length > 80/, 'per-area control cap identical to JMA');
  assert.match(builder, /findNearestWetCell/, 'controls snapped to wet cells');
  // load hooks: both async inputs try the swap on landing
  assert.match(APP, /_ensureRegionalTsuAreas\(\);\n  \}\)\.catch/, 'areas-load hook');
  assert.match(APP, /if \(R\.region && REGION_STATE\.active === R\.region\) _ensureRegionalTsuAreas\(\);/, 'grid-load hook');
  // lifecycle: activate must not inherit the previous region's registry,
  // deactivate restores JMA
  const activate = APP.match(/function regionActivate\(pack\) \{[\s\S]*?\n\}/)[0];
  assert.match(activate, /_restoreJmaTsuAreas\(\);/, 'activate clears stale regional registry');
  const deactivate = APP.match(/function regionDeactivate\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(deactivate, /_restoreJmaTsuAreas\(\);/, 'deactivate restores JMA');
  // terrain swap must not stomp a live regional registry
  assert.match(APP, /if \(!REGION_STATE\.active\) buildJmaTsunamiForecastAreas\(\);/, 'terrain-swap guard');
  // registry source flag scales the forecast distance gate (Chile ~3100 km)
  assert.match(APP, /directDistance > \(_tsuAreasRegional \? 3500 : 1200\)/, 'regional distance gate');
  // the standalone regional solver must be created WITH the regional controls:
  // the worker builds its per-checkpoint peak cache from the creation list, so
  // a checkpoint-less creation makes every samplePeak (the "arrived" alert
  // path) answer 0 forever
  assert.match(APP, /var _cps=\(_coarse\|\|_tsuAreasRegional\)\?\(_tsuCheckPoints\|\|\[\]\):\[\];/, 'regional solver created with regional checkpoints');
  // the source-area display uses the regional namespace for regional events
  assert.match(APP, /function _sourceAreaCodeForEvent/, 'source-area router exists');
  assert.match(APP, /if \(_tsuAreasRegional\) return _regionalSourceAreaCodeFor\(ev\);/, 'routed to the regional nearest control');
  // v6.5.1 inland-water exemption: the builder masks the snap with the
  // open-ocean eligibility mask and the JMA builder stays unmasked
  assert.match(builder, /oceanConnectedMask/, 'builder computes the ocean mask');
  assert.match(builder, /findNearestWetCell\(grid, coord\[1\], coord\[0\], 2, oceanMask\)/, 'snap passes the mask');
  const jmaBuilder = APP.match(/function buildJmaTsunamiForecastAreas[\s\S]*?\n\}/)[0];
  assert.ok(!/oceanConnectedMask/.test(jmaBuilder), 'JMA builder unmasked (Japan path byte-identical)');
});

test('i18n + panel: regional ETA note wired at 3-language parity', () => {
  const panel = APP.match(/function _updateTsunamiEtaPanel[\s\S]*?\n\}/)[0];
  assert.match(panel, /tsunami\.eta\.regional_note/, 'ETA panel renders the note');
  assert.match(panel, /_tsuAreasRegional/, 'gated on the regional registry');
  assert.equal((I18N.match(/"tsunami\.eta\.regional_note"/g) || []).length, 3, 'note key x3');
});

test('i18n: regional method label + unknown basin keys at 3-language parity', () => {
  assert.match(APP, /t\('info\.tsunami_method_regional'\)/, 'info panel uses the key');
  assert.equal((I18N.match(/"info\.tsunami_method_regional"/g) || []).length, 3, 'key x3');
  assert.equal((I18N.match(/"tsunami\.basin\.unknown"/g) || []).length, 3, 'basin.unknown x3 (regional areas display through it)');
});
