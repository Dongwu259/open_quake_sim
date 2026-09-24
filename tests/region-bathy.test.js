// ================================================================
//  v6.4 regional-tsunami batch — non-Japan REGIONAL_BATHY terrain grids
//  (cl-megathrust 0.05°, it-messina 0.025°; GEBCO 2025 via CEDA OPeNDAP,
//  3x3 water-mean, tools/build-bathymetry-regions.py --one) plus the app.js
//  wiring that lets ocean epicenters in an active region run the nonlinear
//  SWE solver on the regional grid:
//    - _getDepth consults the active region's grid before the Japan-box
//      global grid (_regionalDepthGridFor, gated on REGION_STATE)
//    - nesting only when the coarse global grid COVERS the fine grid
//      (_bathyCoarseCovers) and Japan checkpoints ride only with nesting
//    - regionActivate warms the region's grids (_regionPrefetchBathy)
//  Run with:  node --test tests/region-bathy.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

const GRIDS = {
  chile: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'grids', 'cl-megathrust.json'), 'utf8')),
  italy: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'grids', 'it-messina.json'), 'utf8')),
};
const PACKS = {
  chile: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-chile.json'), 'utf8')),
  italy: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-italy.json'), 'utf8')),
};

function regionBathyEntries() {
  const m = APP.match(/var REGIONAL_BATHY = \[([\s\S]*?)\];/);
  assert.ok(m, 'REGIONAL_BATHY present');
  return [...m[1].matchAll(/\{[^}]*\}/g)].map(r => r[0]);
}

test('terrain grids validate + meta contract (data honesty)', () => {
  for (const rid of ['chile', 'italy']) {
    const g = GRIDS[rid];
    const check = Physics.validateResearchGrid(g, 'terrain');
    assert.ok(check.valid, rid + ' valid: ' + check.errors.join(','));
    assert.ok(check.landCells > 0 && check.waterCells > 0, rid + ' land+water mix');
    const meta = g.meta;
    assert.equal(meta.schema, 'quake-sim-terrain-grid-v1');
    assert.match(meta.dataset, /GEBCO 2025/);
    assert.match(meta.source, /CEDA OPeNDAP/);
    assert.match(meta.source, /10\.5285\/37c52e96/);
    assert.match(meta.license, /Public domain/);
    assert.equal(meta.resolutionDegrees, g.res);
    assert.equal(meta.landCells, check.landCells);
    assert.equal(meta.waterCells, check.waterCells);
    assert.match(meta.notSuitableFor.join(','), /operational warning/);
  }
});

test('REGIONAL_BATHY entries: region-tagged, bbox matches the grid extent', () => {
  const entries = regionBathyEntries();
  for (const rid of ['cl-megathrust', 'it-messina']) {
    const entry = entries.find(e => e.includes("id:'" + rid + "'"));
    assert.ok(entry, rid + ' entry present');
    const region = entry.match(/region:'([a-z]+)'/);
    assert.ok(region, rid + ' declares its region');
    const [w, s, e, n] = entry.match(/bbox:\[([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]/).slice(1, 5).map(Number);
    const g = GRIDS[region[1]];
    assert.equal(g.res > 0, true);
    assert.equal(g.origin[0], w, rid + ' origin lng = bbox west');
    assert.equal(g.origin[1], s, rid + ' origin lat = bbox south');
    const gx1 = g.origin[0] + (g.nx - 1) * g.res, gy1 = g.origin[1] + (g.ny - 1) * g.res;
    assert.ok(Math.abs(gx1 - e) <= g.res + 1e-9, rid + ' east edge within one cell');
    assert.ok(Math.abs(gy1 - n) <= g.res + 1e-9, rid + ' north edge within one cell');
  }
});

test('chile strip covers the megathrust: trench depths + Andes elevations', () => {
  const g = GRIDS.chile;
  assert.equal(g.res, 0.05, 'chile strip is 0.05° (country-scale; integer nested ratio 3)');
  assert.ok(g.minDepth < -6000, 'Peru-Chile trench in grid: ' + g.minDepth);
  assert.ok(g.maxDepth > 3000, 'Andes in grid: ' + g.maxDepth);
  assert.ok(g.ny * g.nx > 50000 && g.ny * g.nx < 200000, 'cell count in solver-cost band: ' + g.nx * g.ny);
  // sample the trench axis south of Valdivia
  const o = g.origin;
  const ix = Math.floor((-74.0 - o[0]) / g.res), iy = Math.floor((-40.0 - o[1]) / g.res);
  assert.ok(g.data[iy * g.nx + ix] < -500, 'trench water south of 1960 rupture');
});

test('messina box: strait water between Sicily and Calabria', () => {
  const g = GRIDS.italy;
  assert.equal(g.res, 0.025);
  const strait = Physics.lookupResearchGrid(g, 38.24, 15.62);
  assert.ok(strait < -30, 'strait mid is water: ' + strait);
  const ionian = Physics.lookupResearchGrid(g, 37.9, 15.9);
  assert.ok(ionian < -150, 'Ionian offshore is deep water: ' + ionian);
});

test('region packs flip tsunami:true with honest boundary notes', () => {
  for (const rid of ['chile', 'italy']) {
    assert.equal(PACKS[rid].tsunami, true, rid + ' tsunami enabled');
    const notes = PACKS[rid].notes;
    assert.match(notes, /GEBCO 2025/, rid + ' names the terrain dataset');
    assert.match(notes, /standalone/, rid + ' documents no-coarse-nesting');
    assert.match(notes, /Heath et al\. 2020/, rid + ' names the vs30 source');
  }
  // published-parameter honesty: the 1960/1908 preset epicenters sit on land
  // cells at grid resolution — the notes must say so instead of moving them
  assert.match(PACKS.chile.notes, /Valdivia preset\s+sit on a land cell|land cell/);
  assert.match(PACKS.italy.notes, /land cell/);
  // california keeps its honest off note
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-california.json'), 'utf8'));
  assert.equal(cal.tsunami, false, 'california still tsunami-off');
  assert.match(cal.notes.tsunami, /No regional bathymetry package/);
});

test('app.js wiring: regional depth branch, coverage gate, checkpoint gate, warm fetch', () => {
  // _getDepth consults the active region's grid before the Japan global box
  assert.match(APP, /function _regionalDepthGridFor/, 'helper exists');
  const gd = APP.match(/function _getDepth\(lat, lng\) \{[\s\S]*?var rg = _regionalDepthGridFor\(lat, lng\);/);
  assert.ok(gd, '_getDepth consults the regional grid first');
  // region gate + active check (jp entries have no tag -> global path untouched)
  const helper = APP.match(/function _regionalDepthGridFor[\s\S]*?\n\}/)[0];
  assert.match(helper, /R\.region/, 'region tag required');
  assert.match(helper, /REGION_STATE\.active !== R\.region/, 'gated to the ACTIVE region');
  // nesting only under coarse coverage
  assert.match(APP, /function _bathyCoarseCovers/, 'coverage helper exists');
  assert.match(APP, /grid!==_bathyGrid&&_bathyCoarseCovers\(grid\)/, 'coarse gate wired into solver');
  // Japan checkpoints ride only with a covering coarse grid
  assert.match(APP, /checkpoints:_coarse\?\(_tsuCheckPoints\|\|\[\]\):\[\]/, 'checkpoint gate');
  // activation warms the region grids + clears the ocean-point memo
  assert.match(APP, /_regionPrefetchBathy\(pack\);/, 'activation prefetch');
  assert.match(APP, /function regionActivate\(pack\) \{[\s\S]*?_oceanPointCache = \{\};/, 'activate clears memo');
  assert.match(APP, /REGION_STATE\.active = null; REGION_STATE\.pack = null;[\s\S]*?_oceanPointCache = \{\};/, 'deactivate clears memo');
  // prefetch lands -> memo cleared + epicenter re-evaluated (mid-load race)
  const pf = APP.match(/function _prefetchRegionalBathy[\s\S]*?\n\}/)[0];
  assert.match(pf, /_oceanPointCache = \{\};/, 'prefetch clears memo');
  assert.match(pf, /isOceanEpicenter = nowOcean/, 'epicenter re-evaluated after grid lands');
});

test('vs30 + terrain provenance cross-agree on source tokens', () => {
  for (const rid of ['italy', 'chile']) {
    const vs30 = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-' + rid + '.json'), 'utf8'));
    assert.equal(vs30.provenance.sourceToken, 'usgs-global-heath2020');
    assert.match(GRIDS[rid].meta.source, /GEBCO Compilation Group/);
  }
});
