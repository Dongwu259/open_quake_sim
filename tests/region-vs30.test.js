// ================================================================
//  v6.4 region Vs30 — California Vs30 package + Physics.regionVs30Sample
//  Source: Yong et al. (2014) BSSA 104(5) grid (7.5 arc-sec, water=0),
//  resampled to 0.025° by tools/build-region-vs30.py. The sampler is
//  bilinear with nodata-corner renormalization; out-of-grid/all-nodata
//  returns null (caller keeps the 500 m/s default-estimate).
//  Run with:  node --test tests/region-vs30.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-california.json'), 'utf8'));
const stationsPack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-california.json'), 'utf8'));

test('package schema + provenance (data honesty contract)', () => {
  assert.equal(pack._schema, 'quake-sim-region-vs30-v1');
  assert.equal(pack.region, 'california');
  assert.equal(pack.res, 0.025);
  assert.equal(pack.nodata, 0);
  assert.equal(pack.data.length, pack.nx * pack.ny);
  const p = pack.provenance;
  for (const key of ['label', 'source', 'sourceToken', 'doi', 'license', 'url', 'nativeResolution', 'downsample', 'builder']) {
    assert.ok(p[key], 'provenance.' + key + ' present');
  }
  assert.equal(p.builder, 'tools/build-region-vs30.py');
  assert.match(p.doi, /10\.1785\/0120130312/);
});

test('grid covers the station bbox; values are physical m/s', () => {
  const [lng0, lat0] = pack.origin;
  const lat1 = lat0 + (pack.ny - 1) * pack.res;
  const lng1 = lng0 + (pack.nx - 1) * pack.res;
  // A handful of SCEDC stations sit south of the source map's own edge
  // (Yong grid starts at 32.5°N; e.g. lat 32.31 near the border) — those
  // honestly fall back to the estimate; >=98% must be covered.
  let inside = 0;
  for (const s of stationsPack.stations) {
    if (s.lat >= lat0 - pack.res && s.lat <= lat1 + pack.res &&
        s.lng >= lng0 - pack.res && s.lng <= lng1 + pack.res) inside++;
  }
  const frac = inside / stationsPack.stations.length;
  assert.ok(frac >= 0.98, 'bbox coverage ' + (frac * 100).toFixed(1) + '%');
  const valid = pack.data.filter(v => v > 0);
  assert.ok(valid.length > 50000, 'California land coverage (' + valid.length + ' cells)');
  for (const v of valid) {
    assert.ok(v >= 100 && v <= 2000, 'vs30 ' + v + ' in physical range');
    assert.ok(Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, 'one-decimal values');
  }
});

test('sampler anchors: LA basin / SF / Sierra, water + off-grid honest nulls', () => {
  // Anchors measured from the source grid at native resolution (build probe):
  // LA downtown ~352, SF ~356, Sierra east of Fresno ~710, Bakersfield ~228.
  const la = Physics.regionVs30Sample(pack, 34.05, -118.25);
  assert.ok(la > 200 && la < 450, 'LA basin Vs30 ' + la);
  const sf = Physics.regionVs30Sample(pack, 37.77, -122.42);
  assert.ok(sf > 200 && sf < 480, 'SF Vs30 ' + sf);
  const sierra = Physics.regionVs30Sample(pack, 37.5, -119.3);
  assert.ok(sierra > 550, 'Sierra Vs30 ' + sierra + ' (stiff bedrock)');
  // offshore point (Pacific, well inside the grid) — all-nodata footprint
  assert.equal(Physics.regionVs30Sample(pack, 33.0, -119.6), null);
  // out of grid
  assert.equal(Physics.regionVs30Sample(pack, 45.0, -122.0), null);
  assert.equal(Physics.regionVs30Sample(pack, 35.0, -110.0), null);
  // degenerate inputs
  assert.equal(Physics.regionVs30Sample(null, 35, -118), null);
  assert.equal(Physics.regionVs30Sample({ _schema: 'nope' }, 35, -118), null);
  assert.equal(Physics.regionVs30Sample(pack, NaN, -118), null);
});

test('bilinear interpolation continuity + nodata renormalization', () => {
  // build a tiny 3x3 pack with one nodata corner: weights must renormalize
  const tiny = {
    _schema: 'quake-sim-region-vs30-v1', region: 'x',
    origin: [0, 0], res: 1, nx: 3, ny: 3, nodata: 0,
    data: [100, 100, 100, 100, 100, 100, 100, 100, 0],
  };
  // interior of a uniform 300 block reads exactly 300
  const uni = { ...tiny, data: new Array(9).fill(300) };
  assert.equal(Physics.regionVs30Sample(uni, 1.5, 1.5), 300);
  // at the exact nodata cell itself: all-nodata footprint -> null; blended
  // interior edges renormalize to the valid-corner weighted mean (uniform
  // 100 valid corners + one nodata corner still reads exactly 100)
  assert.equal(Physics.regionVs30Sample(tiny, 2.0, 2.0), null);
  assert.equal(Physics.regionVs30Sample(tiny, 1.5, 1.5), 100);
  // determinism
  const la1 = Physics.regionVs30Sample(pack, 34.05, -118.25);
  const la2 = Physics.regionVs30Sample(pack, 34.05, -118.25);
  assert.equal(la1, la2);
});

test('station coverage: >=90% of the 6232 real stations get a grid Vs30', () => {
  let applied = 0;
  for (const s of stationsPack.stations) {
    if (Physics.regionVs30Sample(pack, s.lat, s.lng) != null) applied++;
  }
  const frac = applied / stationsPack.stations.length;
  assert.ok(frac >= 0.9, 'coverage ' + (frac * 100).toFixed(1) + '% (' + applied + '/' + stationsPack.stations.length + ')');
});

test('i18n: region.st_note_vs30 present in all three languages', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  const n = (src.match(/"region\.st_note_vs30":"[^"]+"/g) || []).length;
  assert.equal(n, 3, 'exactly 3 language entries, got ' + n);
  for (const token of ['{n}', '{src}', '{m}']) {
    assert.ok(src.indexOf(token, src.indexOf('region.st_note_vs30')) !== -1, 'placeholder ' + token);
  }
});

// ================================================================
//  v6.4 regional-tsunami batch — italy/chile packs from the assembled
//  global hybrid product (Heath et al. 2020, Earthquake Spectra 36(3),
//  doi 10.1177/8755293020911137 — Crossref-verified). Far-field ocean in
//  the product is a CONSTANT fill (600.0 m/s exact); only exact-fill cells
//  confirmed water by a GEBCO mask are zeroed to nodata, so coastal
//  stations keep legitimate near-shore product values.
// ================================================================
const globalPacks = {
  italy: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-italy.json'), 'utf8')),
  chile: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-chile.json'), 'utf8')),
  taiwan: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-taiwan.json'), 'utf8')),
  newzealand: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-vs30-newzealand.json'), 'utf8')),
};
const regionStations = {
  italy: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-italy.json'), 'utf8')),
  chile: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-chile.json'), 'utf8')),
  taiwan: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-taiwan.json'), 'utf8')),
  newzealand: JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'region-stations-newzealand.json'), 'utf8')),
};
const GLOBAL_RIDS = ['italy', 'chile', 'taiwan', 'newzealand'];

test('global-hybrid packs: schema + provenance (Heath et al. 2020, Crossref-verified DOI)', () => {
  for (const rid of GLOBAL_RIDS) {
    const p = globalPacks[rid];
    assert.equal(p._schema, 'quake-sim-region-vs30-v1');
    assert.equal(p.region, rid);
    assert.equal(p.res, 0.025);
    assert.equal(p.data.length, p.nx * p.ny);
    const pr = p.provenance;
    for (const key of ['label', 'source', 'sourceToken', 'doi', 'license', 'url', 'nativeResolution', 'downsample', 'builder']) {
      assert.ok(pr[key], rid + ' provenance.' + key);
    }
    assert.equal(pr.sourceToken, 'usgs-global-heath2020');
    assert.equal(pr.doi, '10.1177/8755293020911137');
    assert.match(pr.source, /Heath, D\.C\., Wald, D\.J\./);
    assert.match(pr.source, /Earthquake Spectra 36\(3\)/);
    assert.match(pr.note, /constant fill/);
  }
});

test('global-hybrid packs: station coverage (italy >=95%, chile >=90%, taiwan/newzealand >=90%)', () => {
  for (const rid of GLOBAL_RIDS) {
    const p = globalPacks[rid];
    const stations = regionStations[rid].stations;
    let applied = 0;
    for (const s of stations) {
      if (Physics.regionVs30Sample(p, s.lat, s.lng) != null) applied++;
    }
    const frac = applied / stations.length;
    // italy 692/697 (99.3%): five small-island/sea-cell FDSN stations miss the
    // grid or sit on fill-masked cells — they keep the labelled estimate.
    // v6.7: taiwan 16/16 = 100%, newzealand 560/563 = 99.5% (3 misses are
    // offshore-island sites outside the grid window — honest fallback).
    const floor = rid === 'italy' ? 0.95 : 0.9;
    assert.ok(frac >= floor, rid + ' coverage ' + (frac * 100).toFixed(1) + '% (' + applied + '/' + stations.length + ')');
  }
});

test('global-hybrid packs: physical values + geology anchors', () => {
  for (const rid of GLOBAL_RIDS) {
    const valid = globalPacks[rid].data.filter(v => v > 0);
    // taiwan is a small island in its window (6,164 land cells), newzealand
    // 48,252 — italy/chile keep their original >=50,000 floor untouched
    const floor = { italy: 50000, chile: 50000, taiwan: 5000, newzealand: 40000 }[rid];
    assert.ok(valid.length > floor, rid + ' land coverage (' + valid.length + ' cells)');
    for (const v of valid) {
      assert.ok(v >= 100 && v <= 2000, 'vs30 ' + v + ' in physical range');
      assert.ok(Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, 'one-decimal values');
    }
  }
  const it = globalPacks.italy, cl = globalPacks.chile;
  // Po plain soft alluvium (Milano) vs Alpine stiff (Trento)
  const milano = Physics.regionVs30Sample(it, 45.46, 9.19);
  const trento = Physics.regionVs30Sample(it, 46.07, 11.12);
  assert.ok(milano > 150 && milano < 350, 'Milano Po-plain soft: ' + milano);
  assert.ok(trento > 550, 'Trento Alpine stiff: ' + trento);
  assert.ok(trento > milano + 200, 'Alpine/Po contrast');
  // Santiago basin soft vs coastal Valparaiso stiffer
  const santiago = Physics.regionVs30Sample(cl, -33.45, -70.67);
  const valpo = Physics.regionVs30Sample(cl, -33.05, -71.62);
  assert.ok(santiago > 200 && santiago < 400, 'Santiago basin: ' + santiago);
  assert.ok(valpo > 450, 'Valparaiso coastal: ' + valpo);
  // v6.7 taiwan: western alluvial plain (Chiayi 315) vs Central Range (547)
  const tw = globalPacks.taiwan, nzPk = globalPacks.newzealand;
  const chiayi = Physics.regionVs30Sample(tw, 23.48, 120.45);
  const centralRange = Physics.regionVs30Sample(tw, 23.91, 121.30);
  assert.ok(chiayi > 200 && chiayi < 400, 'Chiayi plain soft: ' + chiayi);
  assert.ok(centralRange > chiayi + 150, 'Central Range stiffer than plain: ' + centralRange);
  const taipei = Physics.regionVs30Sample(tw, 25.03, 121.57);
  assert.ok(taipei > 200 && taipei < 450, 'Taipei basin: ' + taipei);
  // v6.7 newzealand: Christchurch Canterbury-plain soft (222) vs Southern
  // Alps (832) — the strongest contrast of the four regions
  const chch = Physics.regionVs30Sample(nzPk, -43.53, 172.64);
  const alps = Physics.regionVs30Sample(nzPk, -43.0, 171.0);
  assert.ok(chch > 150 && chch < 350, 'Christchurch plain soft: ' + chch);
  assert.ok(alps > 700, 'Southern Alps stiff: ' + alps);
});

test('fill-fingerprint masking: far-field ocean reads null, no fill leak', () => {
  const it = globalPacks.italy, cl = globalPacks.chile;
  // far-field fill cells (600.0 exact, GEBCO water) must be nodata
  assert.equal(Physics.regionVs30Sample(it, 39.0, 12.0), null, 'Tyrrhenian fill');
  assert.equal(Physics.regionVs30Sample(cl, -30.0, -74.5), null, 'SE Pacific fill');
  // Antofagasta's own cell is a product ocean cell (600.0 fill @ -53 m mask)
  // -> zeroed; the sampler's documented nodata renormalization then blends its
  // LAND neighbours, so the station reads a real near-shore value instead of
  // the ocean fill (measured 617.1) — never the raw 600 fingerprint.
  const antofagasta = Physics.regionVs30Sample(cl, -23.65, -70.4);
  assert.ok(antofagasta !== null && antofagasta !== 600, 'Antofagasta reads neighbours, not fill: ' + antofagasta);
  assert.ok(antofagasta > 150 && antofagasta < 800, 'physical range: ' + antofagasta);
  // coastal land stations keep legitimate near-shore product values
  const venezia = Physics.regionVs30Sample(it, 45.44, 12.33);
  assert.ok(venezia > 150 && venezia < 450, 'Venezia lagoon-margin value kept: ' + venezia);
  const valpo = Physics.regionVs30Sample(cl, -33.05, -71.62);
  assert.ok(valpo > 450, 'Valparaiso near-shore value kept: ' + valpo);
  // v6.7 packs: Taiwan Strait / east Pacific / Tasman Sea / NZ Pacific all
  // read null (fill-fingerprint cells confirmed water by the GEBCO masks)
  assert.equal(Physics.regionVs30Sample(globalPacks.taiwan, 24.5, 119.5), null, 'Taiwan Strait fill');
  assert.equal(Physics.regionVs30Sample(globalPacks.taiwan, 23.5, 122.4), null, 'Taiwan east Pacific fill');
  assert.equal(Physics.regionVs30Sample(globalPacks.newzealand, -40.0, 167.0), null, 'Tasman Sea fill');
  assert.equal(Physics.regionVs30Sample(globalPacks.newzealand, -42.0, 179.5), null, 'NZ Pacific fill');
});
