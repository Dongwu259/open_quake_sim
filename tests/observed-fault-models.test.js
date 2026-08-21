const test = require('node:test');
const assert = require('node:assert/strict');

const ObservedFaultModels = require('../public/observed-fault-models.js');
const FiniteFault = require('../public/finite-fault.js');
const Physics = require('../public/physics.js');
const CFG = require('../public/config.js').CFG_DEFAULTS;

const HEADER_MOMENT_NM = 4.7882953e22; // Hayes 2017 FSP header Mo

function parseTohoku() {
  const raw = ObservedFaultModels.get('tohoku');
  assert.ok(raw, 'tohoku model must be bundled');
  return FiniteFault.parse(raw);
}

test('bundle exposes the Tohoku 2011 observed finite-fault model', () => {
  assert.deepEqual(ObservedFaultModels.list(), ['tohoku', 'nankaiM9', 'kumamoto2016', 'noto2024', 'tokachi2003', 'fukushima2022', 'hyuganada2024']);
  const raw = ObservedFaultModels.get('tohoku');
  assert.equal(raw.schema, FiniteFault.SCHEMA);
  assert.equal(raw.event.sourceType, 'interplate');
  assert.ok(raw.provenance.source && raw.provenance.url && raw.provenance.license);
  assert.match(raw.provenance.url, /^https:\/\//);
});

// ---------------------------------------------------------------------------
//  USGS observed models: Kumamoto 2016 (Hayes 2018) and Noto 2024 (Goldberg)
// ---------------------------------------------------------------------------
for (const [id, expect] of [
  ['kumamoto2016', {patchMin: 100, patchMax: 250, mwMin: 6.9, mwMax: 7.2, lat: 32.75, lng: 130.76, strike: 224}],
  ['noto2024', {patchMin: 200, patchMax: 400, mwMin: 7.3, mwMax: 7.7, lat: 37.50, lng: 137.27, strike: 51}]
]) {
  test(`bundled USGS model ${id} parses research-ready and matches the published event`, () => {
    const raw = ObservedFaultModels.get(id);
    assert.ok(raw, `${id} must be bundled`);
    assert.equal(raw.schema, FiniteFault.SCHEMA);
    assert.match(raw.provenance.url, /^https:\/\/earthquake\.usgs\.gov\//);
    const model = FiniteFault.parse(raw);
    assert.ok(model.patches.length >= expect.patchMin && model.patches.length <= expect.patchMax,
      `${id} patch count ${model.patches.length}`);
    assert.ok(model.mw >= expect.mwMin && model.mw <= expect.mwMax, `${id} Mw ${model.mw}`);
    assert.equal(model.quality.researchReady, true);
    assert.deepEqual(model.quality.warnings, []);
    assert.ok(Math.abs(model.event.lat - expect.lat) < 0.3 && Math.abs(model.event.lng - expect.lng) < 0.3,
      `${id} epicenter ${model.event.lat},${model.event.lng}`);
    for (const p of model.patches) {
      assert.equal(p.corners.length, 4);
      assert.ok(p.slipM > 0, `${id} patch ${p.id} slip must be positive`);
      assert.ok(Math.abs(p.strikeDeg - expect.strike) < 3, `${id} patch ${p.id} strike`);
    }
  });
}

// ---------------------------------------------------------------------------
//  Second batch of USGS observed models: Tokachi-Oki 2003 (Hayes, NEIC 2014),
//  Fukushima-Oki 2022 (Goldberg 2022) and Hyuganada 2024 (Goldberg 2024)
// ---------------------------------------------------------------------------
for (const [id, expect] of [
  ['tokachi2003', {patches: 425, mwMin: 8.1, mwMax: 8.4, nominalMw: 8.2, lat: 41.81, lng: 143.91, strike: 240, sourceType: 'interplate'}],
  ['fukushima2022', {patches: 399, mwMin: 7.1, mwMax: 7.35, nominalMw: 7.3, lat: 37.70, lng: 141.59, strike: 184, sourceType: 'intraslab'}],
  ['hyuganada2024', {patches: 225, mwMin: 6.95, mwMax: 7.2, nominalMw: 7.1, lat: 31.72, lng: 131.53, strike: 203, sourceType: 'interplate'}]
]) {
  test(`bundled USGS model ${id} parses research-ready and matches the published event`, () => {
    const raw = ObservedFaultModels.get(id);
    assert.ok(raw, `${id} must be bundled`);
    assert.equal(raw.schema, FiniteFault.SCHEMA);
    assert.match(raw.provenance.url, /^https:\/\/earthquake\.usgs\.gov\//);
    assert.equal(raw.event.sourceType, expect.sourceType, `${id} sourceType`);
    const model = FiniteFault.parse(raw);
    assert.equal(model.patches.length, expect.patches, `${id} patch count`);
    assert.ok(model.mw >= expect.mwMin && model.mw <= expect.mwMax, `${id} Mw ${model.mw}`);
    // Moment self-check: synthetic (patch-summed) Mw must stay within 0.15
    // of the nominal catalog magnitude.
    assert.ok(Math.abs(model.mw - expect.nominalMw) < 0.15,
      `${id} synthetic Mw ${model.mw} vs nominal ${expect.nominalMw}`);
    assert.equal(model.quality.researchReady, true);
    assert.deepEqual(model.quality.warnings, []);
    assert.ok(Math.abs(model.event.lat - expect.lat) < 0.3 && Math.abs(model.event.lng - expect.lng) < 0.3,
      `${id} epicenter ${model.event.lat},${model.event.lng}`);
    for (const p of model.patches) {
      assert.equal(p.corners.length, 4);
      assert.ok(p.slipM > 0, `${id} patch ${p.id} slip must be positive`);
      assert.ok(Math.abs(p.strikeDeg - expect.strike) < 3, `${id} patch ${p.id} strike`);
    }
  });
}

test('model normalizes research-ready with grade A and no warnings', () => {
  const model = parseTohoku();
  assert.equal(model.patches.length, 325);
  assert.equal(model.quality.researchReady, true);
  assert.equal(model.quality.grade, 'A');
  assert.deepEqual(model.quality.warnings, []);
  assert.ok(Math.abs(model.totalMomentNm - HEADER_MOMENT_NM) / HEADER_MOMENT_NM <= 0.05,
    `total moment ${model.totalMomentNm} must stay within 5% of the FSP header`);
  assert.ok(model.mw >= 9.0 && model.mw <= 9.1, `Mw ${model.mw} must match the published 9.0-9.1`);
  assert.equal(model.geometry.kind, 'imported-finite-fault');
});

test('patch geometry and timing reproduce the Hayes 2017 rupture', () => {
  const model = parseTohoku();
  for (const p of model.patches) {
    assert.equal(p.corners.length, 4);
    assert.ok(p.slipM > 0, `patch ${p.id} slip must be positive`);
    assert.ok(p.riseTime >= 1, `patch ${p.id} rise time must satisfy the v1 contract`);
    assert.ok(p.ruptureTime >= 0 && p.ruptureTime <= 200, `patch ${p.id} rupture time in range`);
    assert.ok(Math.abs(p.strikeDeg - 198) < 0.5, `patch ${p.id} strike`);
    assert.ok([8, 15, 21].some(d => Math.abs(p.dipDeg - d) < 0.5), `patch ${p.id} dip`);
  }
  // Peak slip: 55 m near the trench off Miyagi, shallow, onset ~52 s.
  const peak = model.patches.reduce((a, b) => (a.slipM > b.slipM ? a : b));
  assert.ok(peak.slipM >= 50 && peak.slipM <= 60, `peak slip ${peak.slipM} m`);
  assert.ok(peak.depthKm < 15, 'peak slip must be shallow (near-trench)');
  assert.ok(peak.lng > 143, 'peak slip must sit at the trench, east of the hypocenter');
  assert.ok(peak.ruptureTime >= 40 && peak.ruptureTime <= 70, `peak onset ${peak.ruptureTime} s`);
  // The shallow near-trench segment dominates the moment release.
  const shallow = model.patches.filter(p => Math.abs(p.dipDeg - 8) < 0.5);
  const deep = model.patches.filter(p => Math.abs(p.dipDeg - 21) < 0.5);
  const mean = arr => arr.reduce((s, p) => s + p.slipM, 0) / arr.length;
  assert.ok(mean(shallow) > mean(deep), 'shallow segment must out-slip the deep extension');
  assert.equal(model.geometry.maxRuptureTime, 160);
  assert.ok(model.geometry.topDepth < 4, 'rupture must reach the trench');
  assert.ok(model.geometry.bottomDepth > 45, 'rupture must extend below 45 km');
});

test('ground-motion context accepts the imported geometry end to end', () => {
  const model = parseTohoku();
  const dflt = key => CFG[key].v;
  const context = Physics.createGroundMotionContext({
    lat: model.event.lat, lng: model.event.lng, mag: model.mw, mw: model.mw,
    depthKm: model.event.depthKm, strikeDeg: model.representativePlane.strikeDeg,
    dipDeg: model.representativePlane.dipDeg, sourceType: 'interplate'
  }, {
    gmpModel: 'auto', geometry: model.geometry, finiteFault: true, rupSpeed: dflt('rupSpeed'),
    attA: dflt('attA'), attB: dflt('attB'), attC: dflt('attC'), anelastic: dflt('anelastic'),
    siteModel: dflt('siteModel'), siteBase: dflt('siteBase'), siteSoftMax: dflt('siteSoftMax'),
    siteHardMin: dflt('siteHardMin'), siteNonlinear: dflt('siteNonlinear'), directivity: dflt('directivity')
  });
  // Sendai (observed JMA 6+ in 2011): the faithful Zhao (2006) composite
  // reads Sendai ~4.9-5.0 — a documented underprediction of the exceptional
  // 2011 near-trench maxima by the pre-2011 regression (frozen-package
  // iBias 0.000 overall, tohoku2011 -0.26 after the shipped distance-binned
  // correction; see tools/probe-zhao2006-faithful.js).
  const sendai = Physics.predictStationMotion(context, {lat: 38.27, lng: 140.87});
  assert.ok(sendai && isFinite(sendai.pga) && sendai.pga > 0);
  assert.ok(sendai.intensity >= 4.5 && sendai.intensity <= 7.5,
    `Sendai intensity ${sendai.intensity} must stay in the violent band`);
  // Far-field (Sapporo, ~500 km) must stay well below Sendai.
  const sapporo = Physics.predictStationMotion(context, {lat: 43.06, lng: 141.35});
  assert.ok(sapporo.intensity < sendai.intensity, 'intensity must decay with distance');
});

// ---------------------------------------------------------------------------
//  Nankai Trough Mw 9.0 synthetic scenario (Cabinet Office 2012 framework)
// ---------------------------------------------------------------------------
const NANKAI_TARGET_M0 = Math.pow(10, 1.5 * 9.0 + 9.1); // Mw 9.0

function parseNankai() {
  const raw = ObservedFaultModels.get('nankaiM9');
  assert.ok(raw, 'nankaiM9 scenario model must be bundled');
  return FiniteFault.parse(raw);
}

test('Nankai scenario normalizes research-ready at exactly Mw 9.0', () => {
  const model = parseNankai();
  assert.equal(model.patches.length, 217);
  assert.equal(model.quality.researchReady, true);
  assert.equal(model.quality.grade, 'A');
  assert.deepEqual(model.quality.warnings, []);
  assert.ok(Math.abs(model.totalMomentNm - NANKAI_TARGET_M0) / NANKAI_TARGET_M0 <= 0.01,
    `total moment ${model.totalMomentNm} must match the Mw 9.0 target`);
  assert.ok(model.mw >= 8.99 && model.mw <= 9.01, `Mw ${model.mw}`);
  assert.equal(model.event.sourceType, 'interplate');
  assert.match(model.provenance.source, /synthetic scenario/i);
});

test('Nankai scenario follows the official segment framework', () => {
  const model = parseNankai();
  const segments = {};
  for (const p of model.patches) {
    const seg = (p.sourceProperties || {}).segment;
    assert.ok(seg, `patch ${p.id} carries a segment tag`);
    (segments[seg] = segments[seg] || []).push(p);
  }
  assert.deepEqual(Object.keys(segments).sort(), ['hyuga', 'nankai', 'tokai', 'tonankai']);
  // Dip steepens toward Suruga Bay (Tokai) and shallows toward Hyuga-nada.
  assert.ok(segments.tokai.every(p => Math.abs(p.dipDeg - 18) < 0.5));
  assert.ok(segments.tonankai.every(p => Math.abs(p.dipDeg - 12) < 0.5));
  assert.ok(segments.nankai.every(p => Math.abs(p.dipDeg - 10) < 0.5));
  assert.ok(segments.hyuga.every(p => Math.abs(p.dipDeg - 9) < 0.5));
  // Strikes track the curved trough: N-S in Suruga Bay, rotating WSW along
  // Enshu-nada and staying ENE-WSW from Kumano-nada to Hyuga-nada.
  assert.ok(segments.tokai.every(p => p.strikeDeg >= 180 && p.strikeDeg <= 250));
  assert.ok(segments.tonankai.every(p => p.strikeDeg >= 235 && p.strikeDeg <= 260));
  assert.ok(segments.nankai.every(p => p.strikeDeg >= 240 && p.strikeDeg <= 255));
  assert.ok(segments.hyuga.every(p => p.strikeDeg >= 215 && p.strikeDeg <= 240));
  // Fault plane spans the trench (5 km) to the 35 km downdip limit.
  assert.ok(model.geometry.topDepth >= 4 && model.geometry.topDepth <= 6);
  assert.ok(model.geometry.bottomDepth >= 34 && model.geometry.bottomDepth <= 36);
});

test('Nankai scenario slip and rupture timing are physically consistent', () => {
  const model = parseNankai();
  // Canonical Cabinet Office levels: peak 40 m (超大すべり域), large 20 m.
  assert.ok(Math.abs(model.geometry.maxSlipM - 40) < 0.5, `max slip ${model.geometry.maxSlipM}`);
  const peak = model.patches.reduce((a, b) => (a.slipM > b.slipM ? a : b));
  assert.equal((peak.sourceProperties || {}).segment, 'tonankai',
    'the super-large-slip area sits in Kumano-nada (off the Kii Peninsula)');
  // Background slip must stay in the official-implied 3-9 m band.
  const bg = model.patches.filter(p => p.slipM < 15);
  const meanBg = bg.reduce((s, p) => s + p.slipM, 0) / bg.length;
  assert.ok(meanBg >= 3 && meanBg <= 9, `background slip ${meanBg} m`);
  // Nucleation south of the Kii Peninsula, then bilateral propagation:
  // the latest rupture is the far Hyuga end, well after the Tokai end.
  assert.ok(Math.abs(model.event.lat - 33.93) < 0.2 && Math.abs(model.event.lng - 136.41) < 0.2);
  assert.ok(model.event.depthKm >= 10 && model.event.depthKm <= 25);
  assert.equal(model.geometry.maxRuptureTime <= 350, true, `duration ${model.geometry.maxRuptureTime} s`);
  const segRt = {};
  for (const p of model.patches) {
    const seg = (p.sourceProperties || {}).segment;
    segRt[seg] = Math.max(segRt[seg] || 0, p.ruptureTime);
  }
  assert.ok(segRt.hyuga > segRt.tokai, 'bilateral: far Hyuga end ruptures last');
  assert.ok(segRt.hyuga > 150 && segRt.hyuga < 300, `Hyuga onset ${segRt.hyuga} s`);
});

test('Nankai scenario ground motion is violent at Osaka and decays outward', () => {
  const model = parseNankai();
  const dflt = key => CFG[key].v;
  const context = Physics.createGroundMotionContext({
    lat: model.event.lat, lng: model.event.lng, mag: model.mw, mw: model.mw,
    depthKm: model.event.depthKm, strikeDeg: model.representativePlane.strikeDeg,
    dipDeg: model.representativePlane.dipDeg, sourceType: 'interplate'
  }, {
    gmpModel: 'auto', geometry: model.geometry, finiteFault: true, rupSpeed: dflt('rupSpeed'),
    attA: dflt('attA'), attB: dflt('attB'), attC: dflt('attC'), anelastic: dflt('anelastic'),
    siteModel: dflt('siteModel'), siteBase: dflt('siteBase'), siteSoftMax: dflt('siteSoftMax'),
    siteHardMin: dflt('siteHardMin'), siteNonlinear: dflt('siteNonlinear'), directivity: dflt('directivity')
  });
  // Osaka sits above the downdip edge of the Nankai segment (official 想定:
  // 6強 class). The rock-site paper GMPE reads Osaka ~4.9 — the government
  // class additionally assumes basin amplification (absent until the v5.5
  // roadmap item on basin effects).
  const osaka = Physics.predictStationMotion(context, {lat: 34.69, lng: 135.50});
  assert.ok(osaka && isFinite(osaka.pga) && osaka.pga > 0);
  assert.ok(osaka.intensity >= 4.5 && osaka.intensity <= 7.0,
    `Osaka intensity ${osaka.intensity} must sit in the scenario class`);
  const sendai = Physics.predictStationMotion(context, {lat: 38.27, lng: 140.87});
  assert.ok(sendai.intensity < osaka.intensity, 'far-field Tohoku must stay below Osaka');
});
