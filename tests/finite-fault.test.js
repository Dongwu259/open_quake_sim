const test = require('node:test');
const assert = require('node:assert/strict');

const FiniteFault = require('../public/finite-fault.js');
const Physics = require('../public/physics.js');

function patch(id, lat, lng, depthKm, momentNm, overrides = {}) {
  const strikeDeg = overrides.strikeDeg == null ? 20 : overrides.strikeDeg;
  const dipDeg = overrides.dipDeg == null ? 35 : overrides.dipDeg;
  return Object.assign({
    id,
    corners: FiniteFault.cornersFromCenter({lat, lng, depthKm}, strikeDeg, dipDeg, 8, 6),
    strikeDeg,
    dipDeg,
    rakeDeg: overrides.rakeDeg == null ? 90 : overrides.rakeDeg,
    momentNm,
    ruptureTimeS: overrides.ruptureTimeS == null ? 0 : overrides.ruptureTimeS,
    riseTimeS: overrides.riseTimeS == null ? 2 : overrides.riseTimeS
  }, overrides);
}

function nativeModel(extra = {}) {
  const patches = [
    patch('p1', 35.0, 140.0, 10, 1.2e18, {strikeDeg: 15, dipDeg: 30, rakeDeg: 85}),
    patch('p2', 35.05, 140.08, 13, 1.8e18, {strikeDeg: 25, dipDeg: 40, rakeDeg: 95, ruptureTimeS: 3.5, riseTimeS: 2.5})
  ];
  return Object.assign({
    schema: FiniteFault.SCHEMA,
    id: 'fixture-event',
    event: {id: 'fixture-event', lat: 35.0, lng: 140.0, depthKm: 10, momentNm: 3e18},
    units: {depth: 'km', slip: 'm', moment: 'Nm'},
    provenance: {source: 'fixture', url: 'https://example.test/model', license: 'CC-BY-4.0'},
    patches
  }, extra);
}

test('native v1 model normalizes and conserves exact patch moment', () => {
  const model = FiniteFault.parse(nativeModel());
  assert.equal(model.schema, FiniteFault.SCHEMA);
  assert.equal(model.totalMomentNm, 3e18);
  assert.equal(model.patches.reduce((sum, p) => sum + p.momentNm, 0), model.totalMomentNm);
  assert.equal(model.quality.researchReady, true);
  assert.equal(model.geometry.kind, 'imported-finite-fault');
});

test('independent patch mechanisms and rupture timing are preserved', () => {
  const model = FiniteFault.parse(nativeModel());
  assert.deepEqual(model.patches.map(p => [p.strikeDeg, p.dipDeg, p.rakeDeg]), [[15, 30, 85], [25, 40, 95]]);
  assert.equal(model.patches[1].ruptureTime, 3.5);
  assert.equal(model.patches[1].riseTime, 2.5);
});

test('visualization weight follows physical slip rather than patch moment share', () => {
  const raw = nativeModel();
  raw.patches[0].areaKm2 = 20;
  raw.patches[1].areaKm2 = 80;
  const model = FiniteFault.parse(raw);
  assert.ok(model.patches[0].slipM > model.patches[1].slipM);
  assert.ok(model.patches[0].slipWeight > model.patches[1].slipWeight);
  assert.ok(model.patches[0].momentFraction < model.patches[1].momentFraction);
});

test('GeoJSON polygon import uses feature depth when coordinates are 2-D', () => {
  const doc = {
    type: 'FeatureCollection',
    properties: {event: {id: 'geo', lat: 35, lng: 140, depthKm: 12}, source: 'USGS', url: 'https://example.test/geo', license: 'public-domain'},
    features: [{
      type: 'Feature', id: 'g1',
      properties: {depthKm: 12, strike: 0, dip: 45, rake: 90, momentNm: 1e18, riseTime: 2},
      geometry: {type: 'Polygon', coordinates: [[[139.95, 34.98], [140.05, 34.98], [140.05, 35.02], [139.95, 35.02], [139.95, 34.98]]]}
    }]
  };
  const model = FiniteFault.parse(doc);
  assert.equal(model.patches.length, 1);
  assert.ok(model.patches[0].corners.every(c => c.depthKm === 12));
  assert.equal(model.provenance.format, 'GeoJSON');
});

test('SRCMOD FSP imports cm slip and dyne-cm subfault moment units', () => {
  const fsp = `% EventTAG: unit_fixture
% Loc : LAT = 35.0 LON = 140.0 DEP = 10
% Size : LEN = 2 km WID = 2 km Mw = 5.32
% Mech : STRK = 90 DIP = 45 RAKE = 90
% Invs : Nx = 1 Nz = 1 Dx = 2 Dz = 2
% LAT LON Z SLIP RAKE TRUP RISE SF_MOM
% deg deg km cm deg s s dyne-cm
35.0 140.0 10 100 90 0 2 1.2e24`;
  const model = FiniteFault.parse(fsp, {provenance: {url: 'https://example.test/fsp', license: 'CC-BY-4.0'}});
  assert.equal(model.patches.length, 1);
  assert.equal(model.patches[0].slipM, 1);
  assert.ok(Math.abs(model.patches[0].momentNm - 1.2e17) < 1e8);
  assert.equal(model.provenance.format, 'SRCMOD FSP');
});

test('missing provenance is explicitly degraded', () => {
  const raw = nativeModel();
  delete raw.provenance;
  const model = FiniteFault.parse(raw);
  assert.equal(model.quality.researchReady, false);
  assert.ok(model.quality.warnings.includes('source_url_missing'));
  assert.ok(model.quality.warnings.includes('license_missing'));
});

test('inconsistent supplied patch moment and slip is degraded', () => {
  const raw = nativeModel();
  raw.patches[0].slipM = 100;
  const model = FiniteFault.parse(raw);
  assert.equal(model.quality.researchReady, false);
  assert.ok(model.quality.warnings.some(w => /moment_slip_mismatch$/.test(w)));
});

test('malformed schema, coordinates, and timing are rejected', () => {
  assert.throws(() => FiniteFault.parse(Object.assign(nativeModel(), {schema: 'other-v1'})), /Unsupported/);
  const badCoordinate = nativeModel();
  badCoordinate.patches[0].corners[0].lat = 95;
  assert.throws(() => FiniteFault.parse(badCoordinate), /coordinate/);
  const badTiming = nativeModel();
  badTiming.patches[0].ruptureTimeS = -1;
  assert.throws(() => FiniteFault.parse(badTiming), /timing/);
});

test('serialize and parse round-trip retains moment and geometry', () => {
  const first = FiniteFault.parse(nativeModel());
  const second = FiniteFault.parse(FiniteFault.serialize(first));
  assert.equal(second.totalMomentNm, first.totalMomentNm);
  assert.equal(second.patches.length, first.patches.length);
  assert.deepEqual(second.patches[1].corners, first.patches[1].corners);
});

test('imported geometry cell adapter exposes exact patch corners', () => {
  const model = FiniteFault.parse(nativeModel());
  const expected = model.patches[1].corners[2];
  const actual = model.geometry.cellPoint(1, 0, 1, 1);
  assert.ok(Math.abs(actual.lat - expected.lat) < 1e-12);
  assert.ok(Math.abs(actual.lng - expected.lng) < 1e-12);
  assert.ok(Math.abs(actual.depthKm - expected.depthKm) < 1e-12);
});

test('Rrup uses distance to imported quadrilateral surface', () => {
  const corners = [
    {lat: 34.99, lng: 139.99, depthKm: 10}, {lat: 35.01, lng: 139.99, depthKm: 10},
    {lat: 35.01, lng: 140.01, depthKm: 10}, {lat: 34.99, lng: 140.01, depthKm: 10}
  ];
  const model = FiniteFault.parse({
    event: {lat: 35, lng: 140, depthKm: 10},
    provenance: {source: 'fixture', url: 'https://example.test/rrup', license: 'CC0'},
    patches: [{corners, strikeDeg: 0, dipDeg: 0.1, rakeDeg: 0, momentNm: 1e18, riseTime: 1}]
  });
  const rrup = Physics.rrupDistance(35, 140, model.geometry);
  assert.ok(Math.abs(rrup - 10) < 0.03, `expected approximately 10 km, got ${rrup}`);
});

test('canonical source uses imported Mw, M0, hypocenter, and geometry without regeneration', () => {
  const model = FiniteFault.parse(nativeModel());
  const source = Physics.createSourceModel({lat: 0, lng: 0, mw: 4, depthKm: 1, finiteFault: model, generateSubSources: true});
  assert.equal(source.momentNm, model.totalMomentNm);
  assert.equal(source.mw, model.mw);
  assert.equal(source.lat, model.event.lat);
  assert.equal(source.depthKm, model.event.depthKm);
  assert.equal(source.geometry, model.geometry);
  assert.equal(source.magnitudeType, 'observed-finite-fault');
  assert.equal(source.faultModelProvenance.source, 'fixture');
});
