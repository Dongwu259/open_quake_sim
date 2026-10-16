'use strict';
// ================================================================
//  GMPE numerical benchmarks — CB14 (Campbell & Bozorgnia 2014,
//  NGA-West2, Earthquake Spectra 30(3) 1087-1115)
//
//  Every fixture point is compared against values produced by
//  tools/gen-gmpe-fixtures-cb14.py, a scalar transcription of the OFFICIAL
//  openquake.hazardlib implementation (gem/oq-engine
//  campbell_bozorgnia_2014.py, sha256 in the fixture). The two
//  implementations were written independently, so this locks BOTH the
//  coefficient transcription and the equation structure (hazardlib
//  _get_magnitude_term / _get_geometric_attenuation_term /
//  _get_style_of_faulting_term / _get_hanging_wall_term /
//  _get_shallow_site_response_term (SJ=false) / _get_basin_term /
//  _get_hypocentral_depth_term / _get_fault_dip_term /
//  _get_anelastic_attenuation_term / compute_sigma + the T<0.25 s soil-PGA
//  floor + the Eq.39/35-37 width/hypo estimators at zbot = 20 km).
//  Regenerate with: python tools/gen-gmpe-fixtures-cb14.py
// ================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics');

const FIXTURE_PATH = path.join(__dirname, '..', 'tools', 'data', 'gmpe-fixtures-cb14.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const F = fixture.pointFields;
const IX = {}; F.forEach((f, i) => { IX[f] = i; });

function geomOf(p) {
  return { mw: p[IX.mag], rrup: p[IX.rrup], rjb: p[IX.rjb], rx: p[IX.rx], ry0: p[IX.ry0],
           ztor: p[IX.ztor], dip: p[IX.dip], rake: p[IX.rake], vs30: p[IX.vs30],
           widthKm: p[IX.widthKm] == null ? undefined : p[IX.widthKm],
           hypoDepthKm: p[IX.hypoDepthKm] == null ? undefined : p[IX.hypoDepthKm] };
}

// --- hand-transcribed spot cells (so a tampered fixture/generator cannot
// silently bless wrong coefficients — the full table is ALSO locked
// row-by-row against the fixture below) ------------------------------------
test('cb14 — coefficient table matches the hazardlib transcription', () => {
  assert.strictEqual(fixture.source.sha256,
    'c634814d0cd9582ab84ba3d52b71ce35a12da202f711646f943fa1e6000dd7fc',
    'fixture provenance sha256 (regenerate via tools/gen-gmpe-fixtures-cb14.py)');
  // whole-table lock against the frozen fixture (23 rows x 40 columns —
  // pga/pgv + 21 SA rows; the fixture table additionally carries the cav/ia
  // rows from the source, excluded from physics.js — compare per key)
  for (const k of Object.keys(Physics.CB2014_PAPER)) {
    assert.deepStrictEqual(Physics.CB2014_PAPER[k], fixture.table.rows[k], 'row ' + k);
  }
  assert.strictEqual(Object.keys(Physics.CB2014_PAPER).length, 23, 'cav/ia rows excluded');
  // hand-transcribed spot cells from the frozen hazardlib source (pga row)
  const pga = Physics.CB2014_PAPER.pga;
  const spot = {
    c0: -4.416, c1: 0.984, c2: 0.537, c3: -1.499, c4: -0.496, c5: -2.773,
    c6: 0.248, c7: 6.768, c8: 0, c9: -0.212, c10: 0.72, c11: 1.09,
    c12: 2.186, c13: 1.42, c14: -0.0064, c15: -0.202, c16: 0.393,
    c17: 0.0977, c18: 0.0333, c19: 0.00757, c20: -0.0055, Dc20: 0,
    a2: 0.167, h1: 0.241, h2: 1.474, h3: -0.715, h5: -0.337, h6: -0.27,
    k1: 865, k2: -1.186, k3: 1.839, phi1: 0.734, phi2: 0.492, tau1: 0.409,
    tau2: 0.322, rho1pga: 1, rho2pga: 1, philnAF: 0.3, phiC: 0.271, rholny: 1
  };
  for (const k of Object.keys(spot)) assert.strictEqual(pga[k], spot[k], 'pga.' + k);
  assert.deepStrictEqual(Physics.CB2014_CONSTS, { h4: 1.0, c: 1.88, n: 1.18, zbotKm: 20 });
});

test('cb14 — fixture grid covers the structural boundaries', () => {
  assert.strictEqual(fixture.points.length, 17532, 'frozen grid size');
  const dips = new Set(), rakes = new Set(), rrup = new Set(), ztor = new Set(), imts = new Set(), grids = new Set();
  for (const p of fixture.points) {
    dips.add(p[IX.dip]); rakes.add(p[IX.rake]); rrup.add(p[IX.rrup]);
    ztor.add(p[IX.ztor]); imts.add(p[IX.imt]); grids.add(p[IX.grid]);
  }
  assert.ok([...rrup].some((r) => r > 80), 'anelastic 80 km boundary crossed');
  assert.ok(ztor.has(20), 'ztor beyond the 16.66 hw clamp pinned');
  assert.ok(rakes.has(30) && rakes.has(150) && rakes.has(-30) && rakes.has(-150),
    'style-of-faulting boundary rakes pinned (CB14 windows are STRICT)');
  assert.strictEqual(imts.size, 23, 'all 23 carried IMT rows exercised');
  assert.deepStrictEqual([...grids].sort(), ['core', 'hw', 'rakeBnd', 'sa'], 'grid families');
});

test('cb14 — medians reproduce the hazardlib reference at every fixture point', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const lnA = Physics.cb2014Ln(p[IX.imt], geomOf(p));
    const d = Math.abs(lnA - p[IX.lnA]);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δln| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)} — ` +
    'physics.js drifted from the hazardlib reference (see tools/gen-gmpe-fixtures-cb14.py)');
});

test('cb14 — sigma/tau/phi reproduce hazardlib at every fixture point (ln units)', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const s = Physics.cb2014SigmaLn(p[IX.imt], geomOf(p));
    const d = Math.abs(s.sigma - p[IX.sigma]) + Math.abs(s.tau - p[IX.tau]) + Math.abs(s.phi - p[IX.phi]);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δ(sigma,tau,phi)| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)}`);
});

test('cb14 — hand anchor: crustal M7 Rjb=30 ztor=12 dip=60 reverse Vs30=400', () => {
  // frozen full-precision values from the fixture (core grid point,
  // estimators running: widthKm/hypoDepthKm null)
  const g = { mw: 7.0, rrup: Math.sqrt(30 * 30 + 12 * 12), rjb: 30, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 };
  const lnA = Physics.cb2014Ln('pga', g);
  assert.ok(Math.abs(lnA - (-1.7707219906311233)) < 1e-12, `lnA = ${lnA}`);
  const s = Physics.cb2014SigmaLn('pga', g);
  assert.ok(Math.abs(s.sigma - 0.5437772568115088) < 1e-12, 'sigma frozen');
  assert.ok(Math.abs(s.tau - 0.28877543656600635) < 1e-12, 'tau frozen');
  assert.ok(Math.abs(s.phi - 0.460762902436342) < 1e-12, 'phi frozen');
  const gal = Physics.pgaCb2014(g);
  const uncapped = Math.exp(lnA) * Physics.CB2014_G_TO_GAL;
  assert.ok(Math.abs(gal - Physics.GMPE_PGA_SOFT_CAP * Math.tanh(uncapped / Physics.GMPE_PGA_SOFT_CAP)) < 1e-9,
    'soft cap formula transparent');
  assert.ok(uncapped > 150 && uncapped < 190, `M7@30km PGA ${uncapped.toFixed(1)} gal (physical band)`);
});

test('cb14 — estimators: Eq.39 width (zbot cap) + Eqs.35-37 hypocentral depth', () => {
  // width: sqrt(10^((M-4.07)/0.98)) capped by (zbot-ztor)/sin(dip)
  const wUncapped = Math.sqrt(Math.pow(10, (6.0 - 4.07) / 0.98));
  assert.ok(Math.abs(Physics.cb2014EstWidthKm(6.0, 90, 5) - wUncapped) < 1e-12, 'vertical fault: no cap');
  const wCap = Physics.cb2014EstWidthKm(7.0, 60, 2);
  assert.ok(Math.abs(wCap - (20 - 2) / Math.sin(Math.PI / 3)) < 1e-9, 'zbot cap binds: ' + wCap);
  // hypo: M>=6.75 -> fdz_m = 2.325; dip 60 -> fdz_d = 0; dz = exp(min(2.325, ln(0.9*(zbor-ztor))))
  const w7 = Physics.cb2014EstWidthKm(7.0, 60, 2);
  const zbor = 2 + w7 * Math.sin(Math.PI / 3);
  const dz = Math.exp(Math.min(2.325, Math.log(0.9 * (zbor - 2))));
  assert.ok(Math.abs(Physics.cb2014EstHypoDepthKm(7.0, 60, 2, w7) - (2 + dz)) < 1e-9, 'hypo estimate');
  // M<6.75 leg
  const dz5 = Math.exp(Math.min(-4.317 + 0.984 * 6.0, Math.log(0.9 * (zbor - 2))));
  assert.ok(Math.abs(Physics.cb2014EstHypoDepthKm(6.0, 60, 2, w7) - (2 + dz5)) < 1e-9, 'hypo estimate M6');
});

test('cb14 — SA: exact rows, soil-PGA floor at T<0.25 s (strict), interpolation, honest no-coverage', () => {
  const g = { mw: 7.0, rrup: Math.sqrt(30 * 30 + 12 * 12), rjb: 30, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 };
  // hazardlib compute(): SA(T<0.25) raised to the SOIL PGA when lower ->
  // invariant SA(T<0.25) >= PGA(soil); the 0.25 row itself is NOT floored
  for (const T of ['0.05', '0.1', '0.2']) {
    assert.ok(Physics.cb2014Ln(T, g) >= Physics.cb2014Ln('pga', g) - 1e-15, `soil-PGA floor invariant at T=${T}`);
  }
  const lo = Physics.cb2014Ln('1', g), hi = Physics.cb2014Ln('1.5', g);
  const mid = Physics.cb2014Ln('1.25', g);
  const w = (Math.log(1.25) - Math.log(1)) / (Math.log(1.5) - Math.log(1));
  assert.ok(Math.abs(mid - (lo + w * (hi - lo))) < 1e-12, 'log-period interpolation formula');
  assert.strictEqual(Physics.cb2014Ln('15', g), null);
  assert.strictEqual(Physics.cb2014Ln('0.001', g), null);
  assert.strictEqual(Physics.saCb2014Gal('15', g), null);
  // frozen SA anchor (sa grid: 1.0 s, M7.5, Rjb 30, ztor 12, Vs30 760, rev)
  const g2 = { mw: 7.5, rrup: Math.sqrt(30 * 30 + 12 * 12), rjb: 30, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 760 };
  assert.ok(Math.abs(Physics.cb2014Ln('1', g2) - (-2.0403962865775336)) < 1e-12, 'SA 1s anchor');
});

test('cb14 — structural terms: anelastic 80 km, k1 site branch, hypodepth clamps', () => {
  // anelastic term is exactly 0 below 80 km and (c20+Dc20)*(rrup-80) beyond;
  // base table Dc20 = 0. Footwall (rx=-1) kills the hw term; vs30 = 1100 sits
  // above the pga row k1 (865), so the site term takes the linear branch and
  // does NOT depend on pga1100 — only the geometric and anelastic legs
  // differ between the two ranges.
  const C = Physics.CB2014_PAPER.pga;
  const mkR = (rjb) => ({ mw: 7.0, rjb, rx: -1, ry0: 0, ztor: 0.5, rrup: Math.sqrt(rjb * rjb + 0.25), dip: 60, rake: 0, vs30: 1100, widthKm: 12, hypoDepthKm: 8 });
  const r1 = mkR(70), r2 = mkR(90);
  const d70 = Physics.cb2014Ln('pga', r1), d90 = Physics.cb2014Ln('pga', r2);
  const geomOnly = (C.c5 + C.c6 * 7) * Math.log(Math.sqrt(r1.rrup * r1.rrup + C.c7 * C.c7) / Math.sqrt(r2.rrup * r2.rrup + C.c7 * C.c7));
  assert.ok(Math.abs((d70 - d90) - (geomOnly - C.c20 * (r2.rrup - 80))) < 1e-9, 'anelastic term slope beyond 80 km');
  // k1 site branch: at vs30 == k1 the linear branch boundary — above k1 the
  // k2*n*ln(vs30/k1) leg, below it the nonlinear pga1100-driven leg
  const mk = (rjb) => ({ mw: 7.0, rjb, rx: rjb, ry0: 0, ztor: 5, rrup: Math.sqrt(rjb * rjb + 25), dip: 60, rake: 0, vs30: 760 });
  const soft = Physics.cb2014Ln('pga', { ...mk(30), vs30: 270 });
  const rock = Physics.cb2014Ln('pga', { ...mk(30), vs30: 1100 });
  assert.ok(soft > rock, 'soft site amplifies (nonlinear site term active)');
  // hypocentral depth clamps: fhyp_h pinned to [0,13]
  const h10 = Physics.cb2014Ln('pga', { ...mk(30), hypoDepthKm: 10 });
  const h25 = Physics.cb2014Ln('pga', { ...mk(30), hypoDepthKm: 25 });
  const h40 = Physics.cb2014Ln('pga', { ...mk(30), hypoDepthKm: 40 });
  assert.ok(Math.abs(h40 - h25) < 1e-15, 'fhyp_h clamps at 13 (25 == 40 km)');
  assert.ok(h10 !== h25, 'below the clamp the term varies');
  // fault-dip term: only M<=5.5; isolate it (rx=-1 kills hw, explicit
  // width/hypo keep the estimators out, and vs30 = 1100 sits above the pga
  // row k1 = 865 so the site term takes the linear branch and does NOT
  // couple dip through pga1100)
  const iso = { rjb: 30, rx: -1, ry0: 0, ztor: 5, rrup: Math.sqrt(925), rake: 0, vs30: 1100, widthKm: 12, hypoDepthKm: 8 };
  const m5 = Physics.cb2014Ln('pga', { ...iso, mw: 5.2, dip: 60 });
  const m5v = Physics.cb2014Ln('pga', { ...iso, mw: 5.2, dip: 90 });
  assert.ok(Math.abs((m5v - m5) - C.c19 * (5.5 - 5.2) * 30) < 1e-9, 'fault-dip term slope');
});

test('cb14 — hanging wall + point-source convention + production wrappers', () => {
  // hw magnitude taper: 0 below M5.5
  const mk = (mw) => ({ mw, rjb: 5, rx: 2, ry0: 0, ztor: 2, rrup: Math.sqrt(29), dip: 60, rake: 90, vs30: 760, widthKm: 12 });
  const a = Physics.cb2014Ln('pga', mk(5.2));
  const b = Physics.cb2014Ln('pga', mk(6.2));
  assert.ok(b > a, 'hw term lifts M6.2 over M5.2 (all else equal)');
  // point convention via nw2PointGeom + calcPGA wrapper identity
  const pga = Physics.calcPGA(7.0, 30, 'cb14', 10, null, null, 'crustal', 0, 0, 0, 0, 400, 90, 60);
  const direct = Physics.pgaCb2014(Physics.nw2PointGeom(7.0, 30, 10, 400, 90, 60));
  assert.ok(Math.abs(pga - direct) < 1e-9, 'calcPGA cb14 == direct');
  const pgv = Physics.calcPGV(7.0, 30, 'cb14', 10, null, null, 'crustal', 0, 400, 90, 60);
  assert.ok(pgv > 5 && pgv < 60, `pgv ${pgv.toFixed(1)} cm/s (physical band)`);
  const mo = Physics._pshaBranchMotion('cb14', 'pga', 'crustal', 7.0, 30, 10, 400, 90, null);
  assert.ok(mo.median > 0 && mo.sigmaLog10 > 0.1 && mo.sigmaLog10 < 0.5, 'branch motion pga');
  const saMo = Physics._pshaBranchMotion('cb14', 'sa:0.50', 'crustal', 7.0, 30, 10, 400, 90, null);
  assert.ok(saMo && saMo.median > 0, 'branch motion sa');
  assert.strictEqual(Physics._pshaBranchMotion('cb14', 'sa:15.00', 'crustal', 7, 30, 10, 400, 90, null), null, 'SA no-coverage null');
  const sc = Physics.getGmpSigmaComponents('cb14', 'crustal', 'pga', 7.0);
  assert.ok(sc.model === 'cb14' && sc.sigmaT > 0.1 && sc.sigmaT < 0.5, 'sigma components');
});
