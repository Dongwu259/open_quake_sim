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

// ------------------------------------------- independent re-derivation
// Same algorithm as buildRegionalTsunamiForecastAreas, re-implemented here so
// a regression in app.js cannot silently hollow out the registry (the app
// script itself is browser-only and cannot be required from node).
function deriveRegionalAreas(areasFC, grid) {
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
        const wet = Physics.findNearestWetCell(grid, c[1], c[0], 2);
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
});

test('i18n: regional method label + unknown basin keys at 3-language parity', () => {
  assert.match(APP, /t\('info\.tsunami_method_regional'\)/, 'info panel uses the key');
  assert.equal((I18N.match(/"info\.tsunami_method_regional"/g) || []).length, 3, 'key x3');
  assert.equal((I18N.match(/"tsunami\.basin\.unknown"/g) || []).length, 3, 'basin.unknown x3 (regional areas display through it)');
});
