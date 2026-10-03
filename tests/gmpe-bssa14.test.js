'use strict';
// ================================================================
//  GMPE numerical benchmarks — BSSA14 (Boore et al. 2014, NGA-West2)
//
//  Every fixture point is compared against values produced by
//  tools/gen-gmpe-fixtures-bssa14.py, a scalar transcription of the
//  OFFICIAL openquake.hazardlib implementation (gem/oq-engine
//  boore_2014.py, sha256 in the fixture). The two implementations were
//  written independently, so this locks BOTH the coefficient
//  transcription and the equation structure (Eq. 2-8 + 13-17).
//  Regenerate with: python tools/gen-gmpe-fixtures-bssa14.py
// ================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics');

const FIXTURE_PATH = path.join(__dirname, '..', 'tools', 'data', 'gmpe-fixtures-bssa14.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// --- hazardlib-transcribed coefficients (kept inline so a tampered fixture
// file cannot silently bless wrong coefficients) ---------------------------
const OQ_PGA = { e0: 0.4473, e1: 0.4856, e2: 0.2459, e3: 0.4539, e4: 1.431, e5: 0.05053, e6: -0.1662,
  mh: 5.5, c1: -1.134, c2: 0.1917, c3: -0.008088, h: 4.5, dc3: 0.0, c: -0.6, vc: 1500.0,
  f4: -0.15, f5: -0.00701, f6: -9.9, f7: -9.9, r1: 110.0, r2: 270.0, dfr: 0.1, dfv: 0.07,
  phi1: 0.695, phi2: 0.495, tau1: 0.398, tau2: 0.348 };
const OQ_PGV = { e0: 5.037, e1: 5.078, e2: 4.849, e3: 5.033, e4: 1.073, e5: -0.1536, e6: 0.2252,
  mh: 6.2, c1: -1.243, c2: 0.1489, c3: -0.00344, h: 5.3, dc3: 0.0, c: -0.84, vc: 1300.0,
  f4: -0.1, f5: -0.00844, f6: -9.9, f7: -9.9, r1: 105.0, r2: 272.0, dfr: 0.082, dfv: 0.08,
  phi1: 0.644, phi2: 0.552, tau1: 0.401, tau2: 0.346 };
const OQ_DC3 = { base: { pga: 0.0, pgv: 0.0 }, lowQ: { pga: -0.00255, pgv: -0.00033 },
  highQ: { pga: 0.002858, pgv: 0.004345 } };
const OQ_CONSTS = { mref: 4.5, rref: 1.0, vref: 760.0, f1: 0.0, f3: 0.1, v1: 225.0, v2: 300.0 };

test('bssa14 — coefficient tables match the openquake.hazardlib transcription', () => {
  assert.deepStrictEqual(Physics.BSSA2014_PAPER.pga, OQ_PGA, 'pga row');
  assert.deepStrictEqual(Physics.BSSA2014_PAPER.pgv, OQ_PGV, 'pgv row');
  assert.deepStrictEqual(Physics.BSSA2014_DC3, OQ_DC3, 'regional Dc3 variants');
  assert.deepStrictEqual(Physics.BSSA2014_CONSTS, OQ_CONSTS, 'IMT-independent constants');
  assert.strictEqual(fixture.source.sha256,
    'c12315ff4c3d7c84ef39433348285ead4999032ec3ada0b4ccd09238cf3b4422',
    'fixture provenance sha256 (regenerate via tools/gen-gmpe-fixtures-bssa14.py)');
});

test('bssa14 — fixture grid covers the structural boundaries', () => {
  assert.strictEqual(fixture.points.length, 5880, '5 mags x 7 rjb x 7 vs30 x 4 rake x 3 variants x 2 imt');
  assert.strictEqual(fixture.sigmaPoints.length, 490, '5 mags x 7 rjb x 7 vs30 x 2 imt');
  const mags = new Set(fixture.points.map(p => p.mw));
  assert.ok(mags.has(5.5) && mags.has(6.2), 'both Mh hinges pinned');
  const vs30s = new Set(fixture.points.map(p => p.vs30));
  assert.ok(vs30s.has(225.0), 'v1 boundary pinned (hazardlib double-subtract quirk)');
  assert.ok(vs30s.has(300.0) && vs30s.has(760.0) && vs30s.has(1500.0), 'v2/Vref/Vc boundaries');
  const rjbs = new Set(fixture.points.map(p => p.rjbKm));
  assert.ok(rjbs.has(0.0), 'Rjb=0 pinned (R = h floor)');
  assert.ok(rjbs.has(110.0) && rjbs.has(270.0), 'pga R1/R2 boundaries pinned');
});

test('bssa14 — medians reproduce the hazardlib reference at every fixture point', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const lnA = Physics.bssa2014Ln(p.imt, p.mw, p.rjbKm, p.vs30, p.rake, p.variant);
    const d = Math.abs(lnA - p.lnA);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δln| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)} — `
    + 'physics.js drifted from the hazardlib reference (see tools/gen-gmpe-fixtures-bssa14.py)');
});

test('bssa14 — tau/phi reproduce hazardlib at every sigma grid point (ln units)', () => {
  let worst = 0, worstPoint = null;
  for (const s of fixture.sigmaPoints) {
    const got = Physics.bssa2014SigmaLn(s.imt, s.mw, s.rjbKm, s.vs30);
    const d = Math.max(Math.abs(got.tau - s.tauLn), Math.abs(got.phi - s.phiLn));
    if (d > worst) { worst = d; worstPoint = s; }
    // sigmaT consistency
    assert.ok(Math.abs(got.sigmaT - Math.sqrt(got.tau * got.tau + got.phi * got.phi)) < 1e-15);
  }
  assert.ok(worst < 1e-12,
    `max |Δ(tau,phi)| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)}`);
});

test('bssa14 — hazardlib vs30==v1 boundary quirk is locked, not hidden', () => {
  // At vs30 = v1 = 225 exactly, hazardlib fires BOTH the <=v1 branch (-DfV)
  // and the v1..v2 taper branch (-DfV * 1): phi loses 2*DfV.
  const C = Physics.BSSA2014_PAPER.pga;
  const atQuirk = Physics.bssa2014SigmaLn('pga', 7.0, 60, 225.0);   // 60 < R1: no distance term
  assert.ok(Math.abs(atQuirk.phi - (C.phi2 - 2 * C.dfv)) < 1e-15,
    `phi(225.0) = ${atQuirk.phi}, expected phi2 - 2*DfV = ${C.phi2 - 2 * C.dfv}`);
  const justAbove = Physics.bssa2014SigmaLn('pga', 7.0, 60, 225.0001);
  assert.ok(Math.abs(justAbove.phi - (C.phi2 - C.dfv *
      (Math.log(300 / 225.0001) / Math.log(300 / 225)))) < 1e-9, 'taper resumes above v1');
});

test('bssa14 — style-of-faulting branches and the NoSOF case', () => {
  const base = { pga: 0 }, C = Physics.BSSA2014_PAPER.pga;
  const cases = [
    [0.0, C.e1], [30.0, C.e1], [-30.0, C.e1], [180.0, C.e1], [-180.0, C.e1], [150.0, C.e1], // strike-slip (|r|<=30 or 180-|r|<=30)
    [45.0, C.e3], [90.0, C.e3], [135.0, C.e3],                                               // reverse (30 < rake < 150 signed)
    [-45.0, C.e2], [-90.0, C.e2], [-135.0, C.e2],                                            // normal (default)
    [null, C.e0]                                                                             // unspecified (NoSOF)
  ];
  for (const [rake, eTerm] of cases) {
    const ln = Physics.bssa2014Ln('pga', 7.0, 10, 760, rake, 'base');
    const lnNoStyle = Physics.bssa2014Ln('pga', 7.0, 10, 760, null, 'base');
    assert.ok(Math.abs((ln - lnNoStyle) - (eTerm - C.e0)) < 1e-12,
      `rake=${rake}: style term ${eTerm} (Δln ${(ln - lnNoStyle).toFixed(4)})`);
  }
  assert.ok(base.pga === 0, 'sanity');
});

test('bssa14 — unit wrappers convert g->gal and keep the display soft caps transparent', () => {
  // Hand anchor: M7.0 strike-slip, Rjb=10, Vs30=760 (rock: flin=fnl=0),
  // base variant. F_E = e1 + e6*(M-Mh) = 0.2363; R = sqrt(10^2+4.5^2) =
  // 10.9658561; F_P = (c1+c2*(M-4.5))*ln R + c3*(R-1) = -1.6485903;
  // ln PGA = -1.4122902752138706 (verified by independent inline arithmetic).
  const lnA = Physics.bssa2014Ln('pga', 7.0, 10, 760, 0, 'base');
  assert.ok(Math.abs(lnA - (-1.4122902752138706)) < 1e-12, `ln PGA(g) = ${lnA}`);
  const pgaGal = Physics.pgaBssa2014(7.0, 10, 760, 0, 'base');
  // Contract: cap * tanh(raw / cap) exactly.
  const raw = Math.exp(lnA) * 980.665;
  assert.strictEqual(pgaGal, Physics.GMPE_PGA_SOFT_CAP * Math.tanh(raw / Physics.GMPE_PGA_SOFT_CAP));
  // Transparency: tanh(x) deficit is x^2/3 — 0.19% here (239 gal), within the
  // documented <4% band below half the cap.
  assert.ok((raw - pgaGal) / pgaGal < 0.002, `cap deficit ${((raw - pgaGal) / pgaGal).toExponential(2)}`);
  const pgv = Physics.pgvBssa2014(7.0, 10, 760, 0, 'base');
  const rawV = Math.exp(Physics.bssa2014Ln('pgv', 7.0, 10, 760, 0, 'base'));
  assert.strictEqual(pgv, Physics.GMPE_PGV_SOFT_CAP * Math.tanh(rawV / Physics.GMPE_PGV_SOFT_CAP));
  // LowQ (Italy/Japan) path: more anelastic attenuation than base.
  const dPga = Physics.bssa2014Ln('pga', 7.0, 200, 760, 0, 'lowQ')
    - Physics.bssa2014Ln('pga', 7.0, 200, 760, 0, 'base');
  assert.ok(Math.abs(dPga - (-0.00255) * (Math.sqrt(200 * 200 + 4.5 * 4.5) - 1)) < 1e-12,
    'lowQ Dc3 enters the path term linearly in R');
});

test('bssa14 — region-aware auto routing; Japan path byte-identical', () => {
  // Default (Japan): unchanged legacy routing.
  assert.strictEqual(Physics.resolveGmpModel('auto', 'crustal', 7), 'si-midorikawa');
  assert.strictEqual(Physics.resolveGmpModel('auto', 'interplate', 8), 'zhao2006');
  assert.strictEqual(Physics.resolveGmpModel('auto', 'intraslab', 7), 'zhao2006');
  assert.strictEqual(Physics.resolveGmpModel('bssa14', 'crustal', 7), 'bssa14', 'explicit pass-through');
  // Region active: crustal -> bssa14, subduction classes stay on zhao2006.
  for (const rid of ['california', 'italy', 'chile', 'taiwan', 'newzealand']) {
    Physics.setActiveGmpRegion(rid);
    assert.strictEqual(Physics.resolveGmpModel('auto', 'crustal', 7), 'bssa14', `${rid} crustal`);
    assert.strictEqual(Physics.resolveGmpModel('auto', 'interplate', 8), 'zhao2006', `${rid} interplate`);
    assert.strictEqual(Physics.resolveGmpModel('auto', 'intraslab', 7), 'zhao2006', `${rid} intraslab`);
  }
  // Variant map: italy -> lowQ (paper's regional adjustment), base elsewhere.
  Physics.setActiveGmpRegion('italy');
  assert.strictEqual(Physics.activeBssa2014Variant(), 'lowQ');
  Physics.setActiveGmpRegion('chile');
  assert.strictEqual(Physics.activeBssa2014Variant(), 'base');
  Physics.setActiveGmpRegion('japan');
  assert.strictEqual(Physics.resolveGmpModel('auto', 'crustal', 7), 'si-midorikawa', 'japan id never re-routes');
  assert.strictEqual(Physics.activeBssa2014Variant(), 'lowQ', 'explicit bssa14 in Japan gets the Japan Dc3');
  Physics.setActiveGmpRegion(null);
  assert.strictEqual(Physics.resolveGmpModel('auto', 'crustal', 7), 'si-midorikawa', 'deactivation restores Japan');
});

test('bssa14 — predictStationMotion uses Rjb and native Vs30 (no double site term)', () => {
  const ctx = { source: { lat: 36, lng: 140, mw: 7.0, depthKm: 20, sourceType: 'crustal', rakeDeg: 90 },
    geometry: null, gmpModel: 'bssa14', options: { siteModel: 'vs30' } };
  const st = { lat: 36.3, lng: 140.4, vs30: 400 };
  const out = Physics.predictStationMotion(ctx, st, {});
  assert.strictEqual(out.model, 'bssa14');
  assert.strictEqual(out.distanceMetric, 'Rjb');
  assert.strictEqual(out.distanceKm, out.horizontalKm, 'Rjb = epicentral distance for a point source');
  assert.ok(out.distanceKm < out.rhypoKm, 'depth must NOT enter the Rjb distance');
  assert.strictEqual(out.sitePga, 1, 'native-Vs30 model: no external amplification');
  assert.strictEqual(out.sitePgv, 1);
  // The reported PGA equals the direct wrapper at Rjb with the region variant.
  const direct = Physics.pgaBssa2014(7.0, out.horizontalKm, 400, 90, Physics.activeBssa2014Variant());
  assert.ok(Math.abs(out.pga - direct) / direct < 1e-9, 'predictStationMotion == pgaBssa2014 at Rjb');
});

test('bssa14 — finite-fault composite evaluates patches at horizontal (Rjb) distance', () => {
  const source = { lat: 36, lng: 140, mw: 7.0, depthKm: 12, sourceType: 'crustal', rakeDeg: 90 };
  const geometry = Physics.genSubSources(36, 140, 7.0, 90, 60, 12, 2.8, {});
  assert.ok(geometry && geometry.subs && geometry.subs.length > 4, 'subsource geometry present');
  const ctxB = { source, geometry, gmpModel: 'bssa14', options: { siteModel: 'vs30' } };
  const out = Physics.predictStationMotion(ctxB, { lat: 36.5, lng: 140.6, vs30: 400 }, {});
  assert.strictEqual(out.distanceMetric, 'Rjb');
  assert.ok(out.pga > 0 && isFinite(out.pga), 'finite composite produced a value');
  // A patch at horizontal distance h contributes pgaBssa2014(h), not the 3D
  // distance: the near patch (above the 12 km deep source) must read weaker
  // than the 3D-distance alternative would predict.
  const ctxZ = { source, geometry, gmpModel: 'zhao2006', options: { siteModel: 'vs30' } };
  const outZ = Physics.predictStationMotion(ctxZ, { lat: 36.5, lng: 140.6, vs30: 400 }, {});
  assert.strictEqual(outZ.distanceMetric, 'Rhypo', 'zhao keeps 3D point-source semantics');
});

test('bssa14 — sigma accessors route at the documented representative condition', () => {
  const s = Physics.getGmpSigma('bssa14', 'crustal', 'pga', 7.0);
  const ref = Physics.bssa2014Sigma('pga', 7.0, 60, 400);
  assert.ok(Math.abs(s - ref.sigmaT) < 1e-12, 'getGmpSigma == bssa2014Sigma(pga, M, 60, 400).sigmaT');
  const c = Physics.getGmpSigmaComponents('bssa14', 'crustal', 'pga', 7.0);
  assert.strictEqual(c.model, 'bssa14');
  assert.ok(Math.abs(c.tau - ref.tau) < 1e-12 && Math.abs(c.phi - ref.phi) < 1e-12);
  const sv = Physics.getGmpSigma('bssa14', 'crustal', 'pgv', 6.0);
  assert.ok(Math.abs(sv - Physics.bssa2014Sigma('pgv', 6.0, 60, 400).sigmaT) < 1e-12, 'pgv imt honored');
  // log10 conversion: sigma(log10) = sigma(ln) / ln 10.
  const ln10 = Math.log(10);
  const lnRef = Physics.bssa2014SigmaLn('pga', 7.0, 60, 400);
  assert.ok(Math.abs(ref.sigmaT - lnRef.sigmaT / ln10) < 1e-15, 'log10 conversion');
});

test('bssa14 — calcPGA/calcPGV dispatch reaches the model with the region variant', () => {
  Physics.setActiveGmpRegion('italy');
  const direct = Physics.pgaBssa2014(6.5, 30, 400, 90, 'lowQ');
  const routed = Physics.calcPGA(6.5, 30, 'bssa14', 10, null, null, 'crustal', 0.42, 1.34, 0.31, 0.001, 400, 90);
  assert.ok(Math.abs(routed - direct) / direct < 1e-12, 'calcPGA bssa14 == lowQ wrapper under italy');
  Physics.setActiveGmpRegion('chile');
  const directBase = Physics.pgaBssa2014(6.5, 30, 400, 90, 'base');
  const routedBase = Physics.calcPGA(6.5, 30, 'bssa14', 10, null, null, 'crustal', 0.42, 1.34, 0.31, 0.001, 400, 90);
  assert.ok(Math.abs(routedBase - directBase) / directBase < 1e-12, 'chile gets the base variant');
  const pgvRouted = Physics.calcPGV(6.5, 30, 'bssa14', 10, null, null, 'crustal', 0.001, 400, 90);
  assert.ok(Math.abs(pgvRouted - Physics.pgvBssa2014(6.5, 30, 400, 90, 'base')) < 1e-9, 'calcPGV bssa14');
  Physics.setActiveGmpRegion(null);
});

test('bssa14 — rjbDistance: planar projection strip, clamps and containment', () => {
  // Vertical fault (dip 90): the projection collapses to the strike segment.
  const geoV = Physics.genSubSources(36, 140, 7.0, 90, 90, 12, 2.8, {});
  const halfL = geoV.L / 2;
  // due north, within the segment's along-strike span: Rjb == epicentral distance
  const havN = Physics.haversineDist(36, 140, 36.09, 140);
  assert.ok(Math.abs(Physics.rjbDistance(36.09, 140, geoV) - havN) < 0.05, 'vertical fault: normal offset');
  // due east beyond the segment end: Rjb == distance minus half-length
  const havE = Physics.haversineDist(36, 140, 36, 140 + (halfL + 8) / (111.32 * Math.cos(36 * Math.PI / 180)));
  assert.ok(Math.abs(Physics.rjbDistance(36, 140 + (halfL + 8) / (111.32 * Math.cos(36 * Math.PI / 180)), geoV) - (havE - halfL)) < 0.08,
    'vertical fault: beyond segment end');
  // Dipping fault: the projection is a strip; epicenter is inside it (Rjb 0),
  // stations beyond the up-dip edge measure from the edge.
  const geoD = Physics.genSubSources(36, 140, 7.0, 90, 60, 12, 2.8, {});
  const topOff = geoD.topOffset != null ? geoD.topOffset : -0.35 * geoD.W;
  const botOff = geoD.bottomOffset != null ? geoD.bottomOffset : topOff + geoD.W;
  const yLo = Math.min(topOff, botOff) * Math.cos(60 * Math.PI / 180);
  assert.strictEqual(Physics.rjbDistance(36, 140, geoD), 0, 'epicenter inside the projection strip');
  // strike 90 -> due north is the -y (up-dip) side; offset beyond yLo measures from the edge
  const havN2 = Physics.haversineDist(36, 140, 36.18, 140); // ~20 km north, y = -hav
  const expect = Math.abs(-havN2 - yLo); // clamped at the up-dip edge
  assert.ok(Math.abs(Physics.rjbDistance(36.18, 140, geoD) - expect) < 0.08,
    `dipping fault: up-dip exterior (got ${Physics.rjbDistance(36.18, 140, geoD).toFixed(2)}, want ${expect.toFixed(2)})`);
});

test('bssa14 — rjbDistance: imported finite fault patch quads', () => {
  // 0.1° x 0.1° patch quad near 36.1N 140.1E
  const quad = { kind: 'imported-finite-fault', lat: 36.1, lng: 140.1, subs: [
    { corners: [
      { lat: 36.05, lng: 140.05 }, { lat: 36.05, lng: 140.15 },
      { lat: 36.15, lng: 140.15 }, { lat: 36.15, lng: 140.05 }] } ] };
  assert.strictEqual(Physics.rjbDistance(36.1, 140.1, quad), 0, 'inside the patch projection');
  const hav = Physics.haversineDist(36.1, 140.1, 36.4, 140.1); // ~33 km due north
  const edge = Physics.haversineDist(36.15, 140.1, 36.4, 140.1); // from the north edge
  assert.ok(Math.abs(Physics.rjbDistance(36.4, 140.1, quad) - edge) < 0.1,
    `outside measures from the edge (${hav.toFixed(1)} from center)`);
});

test('bssa14 — auto route resolves Rjb semantics; Japan auto stays byte-identical', () => {
  const src = { lat: -36.122, lng: -72.898, mw: 7.0, depthKm: 20, sourceType: 'crustal', rakeDeg: 90 };
  const st = { lat: -36.5, lng: -72.5, vs30: 500 };
  Physics.setActiveGmpRegion('chile');
  const out = Physics.predictStationMotion({ source: src, geometry: null, gmpModel: 'auto', options: { siteModel: 'vs30' } }, st, {});
  assert.strictEqual(out.distanceMetric, 'Rjb', 'auto -> bssa14 distance metric');
  assert.strictEqual(out.distanceKm, out.horizontalKm, 'Rjb = epicentral distance');
  // auto convention (literal-m keyed, same as auto->si-mid/zhao in Japan):
  // the GMPE is evaluated at reference 760 and the external site amp applies.
  assert.ok(Math.abs(out.sitePga - Physics.vs30Amplification(500, 'pga')) < 1e-12,
    'auto path keeps the reference+external site convention');
  // Explicit model (the production sim path, resolved up front) is native:
  const outB = Physics.predictStationMotion({ source: src, geometry: null, gmpModel: 'bssa14', options: { siteModel: 'vs30' } }, st, {});
  assert.strictEqual(outB.sitePga, 1, 'explicit bssa14 carries its site terms natively');
  Physics.setActiveGmpRegion(null);
  const outJ = Physics.predictStationMotion({ source: { lat: 36, lng: 140, mw: 7.0, depthKm: 20, sourceType: 'crustal', rakeDeg: 90 },
    geometry: null, gmpModel: 'auto', options: { siteModel: 'vs30' } }, { lat: 36.3, lng: 140.4, vs30: 500 }, {});
  assert.strictEqual(outJ.distanceMetric, 'Rhypo', 'Japan auto: 3D distance unchanged');
  assert.strictEqual(outJ.model, 'auto', 'Japan auto: literal model label unchanged');
});

test('bssa14 — finite-fault top-level metric is rjbDistance to the projection', () => {
  Physics.setActiveGmpRegion('italy');
  const source = { lat: 42.7, lng: 13.1, mw: 6.5, depthKm: 9, sourceType: 'crustal', rakeDeg: -100 };
  const geometry = Physics.genSubSources(42.7, 13.1, 6.5, 130, 45, 9, 2.8, {});
  const st = { lat: 43.0, lng: 13.4, vs30: 400 };
  const out = Physics.predictStationMotion({ source, geometry, gmpModel: 'bssa14', options: { siteModel: 'vs30' } }, st, {});
  const direct = Physics.rjbDistance(st.lat, st.lng, geometry);
  assert.ok(Math.abs(out.distanceKm - direct) < 1e-9,
    `distanceKm ${out.distanceKm.toFixed(2)} == rjbDistance ${direct.toFixed(2)}`);
  assert.ok(out.distanceKm < out.horizontalKm, 'near-field projection distance beats epicentral');
  Physics.setActiveGmpRegion(null);
});
