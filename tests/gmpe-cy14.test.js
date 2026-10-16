'use strict';
// ================================================================
//  GMPE numerical benchmarks — CY14 (Chiou & Youngs 2014, NGA-West2,
//  Earthquake Spectra 30(3) 1117-1153, DOI 10.1193/072813EQS219M)
//
//  Every fixture point is compared against values produced by
//  tools/gen-gmpe-fixtures-cy14.py, a scalar transcription of the OFFICIAL
//  openquake.hazardlib implementation (gem/oq-engine chiou_youngs_2014.py,
//  sha256 in the fixture). The two implementations were written
//  independently, so this locks BOTH the coefficient transcription and the
//  equation structure (hazardlib get_magnitude_scaling /
//  get_source_scaling_terms / get_geometric_spreading /
//  get_far_field_distance_scaling(CAL) / get_hanging_wall_term /
//  get_linear_site_term / get_nonlinear_site_term / get_tau / get_phi /
//  get_stddevs + the T<=0.3 s PGA floor).
//  Regenerate with: python tools/gen-gmpe-fixtures-cy14.py
// ================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics');

const FIXTURE_PATH = path.join(__dirname, '..', 'tools', 'data', 'gmpe-fixtures-cy14.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const F = fixture.pointFields;
const IX = {}; F.forEach((f, i) => { IX[f] = i; });

function geomOf(p) {
  return { rrup: p[IX.rrup], rjb: p[IX.rjb], rx: p[IX.rx], ry0: p[IX.ry0],
           ztor: p[IX.ztor], dip: p[IX.dip], rake: p[IX.rake], vs30: p[IX.vs30] };
}

// --- hand-transcribed spot cells (so a tampered fixture/generator cannot
// silently bless wrong coefficients — the full table is ALSO locked
// row-by-row against the fixture below) ------------------------------------
test('cy14 — coefficient table matches the hazardlib transcription', () => {
  assert.strictEqual(fixture.source.sha256,
    '8ca60bceafe62b4c42d8339efd2c0bbe713c56dd72ccf59a4758d67606a2b4eb',
    'fixture provenance sha256 (regenerate via tools/gen-gmpe-fixtures-cy14.py)');
  // whole-table lock against the frozen fixture (26 rows x 45 columns)
  assert.deepStrictEqual(Physics.CY2014_PAPER, fixture.table.rows, 'full 26-row table');
  // hand-transcribed spot cells from the frozen hazardlib source (pga row)
  const pga = Physics.CY2014_PAPER.pga;
  const spot = {
    c1: -1.5065, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255,
    cn: 16.0875, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5,
    crb: 50, c5: 6.4551, chm: 3.0956, c6: 0.4908, c7: 0.0352, c7b: 0.0462,
    c8: 0, c8a: 0.2695, c8b: 0.4833, c9: 0.9228, c9a: 0.1202, c9b: 6.8607,
    c11: 0, c11b: -0.4536, cg1: -0.007146, cg2: -0.006758, cg3: 4.2542,
    phi1: -0.521, phi2: -0.1417, phi3: -0.00701, phi4: 0.102151, phi5: 0,
    phi6: 300, gjpit: 1.5817, gwn: 0.7594, phi1jp: -0.6846, phi5jp: 0.459,
    phi6jp: 800, tau1: 0.4, tau2: 0.26, sig1: 0.4912, sig2: 0.3762,
    sig3: 0.8, sig2jp: 0.4528
  };
  for (const k of Object.keys(spot)) assert.strictEqual(pga[k], spot[k], 'pga.' + k);
  assert.deepStrictEqual(Physics.CY2014_CONSTS, { c2: 1.06, c4: -2.1, c4a: -0.5, crb: 50.0, c8a: 0.2695, c11: 0.0, phi6: 300.0, phi6jp: 800.0, refVs: 1130 });
});

test('cy14 — fixture grid covers the structural boundaries', () => {
  assert.strictEqual(fixture.points.length, 17856, 'frozen grid size');
  const dips = new Set(), rakes = new Set(), vs30 = new Set(), ztor = new Set(), imts = new Set(), grids = new Set();
  for (const p of fixture.points) {
    dips.add(p[IX.dip]); rakes.add(p[IX.rake]); vs30.add(p[IX.vs30]);
    ztor.add(p[IX.ztor]); imts.add(p[IX.imt]); grids.add(p[IX.grid]);
  }
  assert.ok(vs30.has(1130), 'REF_VS=1130 boundary pinned');
  assert.ok(dips.has(30) && dips.has(90), 'dip range');
  assert.ok(rakes.has(30) && rakes.has(150) && rakes.has(-30) && rakes.has(-150),
    'style-of-faulting boundary rakes pinned (CY14 windows are INCLUSIVE)');
  assert.strictEqual(imts.size, 26, 'all 26 IMT rows exercised');
  assert.deepStrictEqual([...grids].sort(), ['core', 'hw', 'rakeBnd', 'sa'], 'grid families');
});

test('cy14 — medians reproduce the hazardlib reference at every fixture point', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const lnA = Physics.cy2014Ln(p[IX.imt], p[IX.mag], geomOf(p));
    const d = Math.abs(lnA - p[IX.lnA]);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δln| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)} — ` +
    'physics.js drifted from the hazardlib reference (see tools/gen-gmpe-fixtures-cy14.py)');
});

test('cy14 — sigma/tau/phi reproduce hazardlib at every fixture point (ln units)', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const s = Physics.cy2014SigmaLn(p[IX.imt], p[IX.mag], geomOf(p));
    const d = Math.abs(s.sigma - p[IX.sigma]) + Math.abs(s.tau - p[IX.tau]) + Math.abs(s.phi - p[IX.phi]);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δ(sigma,tau,phi)| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)}`);
});

test('cy14 — hand anchor: crustal M7 Rjb=30 ztor=12 dip=60 reverse Vs30=400', () => {
  // frozen full-precision values from the fixture (core grid point)
  const g = { rrup: Math.sqrt(30 * 30 + 12 * 12), rjb: 30, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 };
  const lnA = Physics.cy2014Ln('pga', 7.0, g);
  assert.ok(Math.abs(lnA - (-1.573582216531751)) < 1e-12, `lnA = ${lnA}`);
  const s = Physics.cy2014SigmaLn('pga', 7.0, g);
  assert.ok(Math.abs(s.sigma - 0.5459173298892238) < 1e-12, 'sigma frozen');
  assert.ok(Math.abs(s.tau - 0.24441352788447365) < 1e-12, 'tau frozen');
  assert.ok(Math.abs(s.phi - 0.48814727128239205) < 1e-12, 'phi frozen');
  // unit wrapper: gal + display soft cap (transparent formula)
  const gal = Physics.pgaCy2014(7.0, g);
  const uncapped = Math.exp(lnA) * Physics.CY2014_G_TO_GAL;
  assert.ok(Math.abs(gal - Physics.GMPE_PGA_SOFT_CAP * Math.tanh(uncapped / Physics.GMPE_PGA_SOFT_CAP)) < 1e-9,
    'soft cap formula transparent');
  assert.ok(uncapped > 190 && uncapped < 220, `M7@30km PGA ${uncapped.toFixed(1)} gal (physical band)`);
});

test('cy14 — SA: exact rows, PGA floor at T<=0.3 s, log-period interpolation, honest no-coverage', () => {
  const g = { rrup: Math.sqrt(30 * 30 + 12 * 12), rjb: 30, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 };
  // the 0.01 row is coefficient-identical to the pga row in the source table
  assert.ok(Math.abs(Physics.cy2014Ln('0.01', 7.0, g) - Physics.cy2014Ln('pga', 7.0, g)) < 1e-15, '0.01 row == pga row');
  // hazardlib compute(): SA(T<=0.3) raised to the PGA mean when lower ->
  // the invariant SA(T<=0.3) >= PGA holds universally
  for (const T of ['0.05', '0.1', '0.2', '0.3']) {
    assert.ok(Physics.cy2014Ln(T, 7.0, g) >= Physics.cy2014Ln('pga', 7.0, g) - 1e-15,
      `PGA floor invariant at T=${T}`);
  }
  // interpolation between the 1 s and 1.5 s rows
  const lo = Physics.cy2014Ln('1', 7.0, g), hi = Physics.cy2014Ln('1.5', 7.0, g);
  const mid = Physics.cy2014Ln('1.25', 7.0, g);
  const w = (Math.log(1.25) - Math.log(1)) / (Math.log(1.5) - Math.log(1));
  assert.ok(Math.abs(mid - (lo + w * (hi - lo))) < 1e-12, 'log-period interpolation formula');
  // outside [0.01,10] s is honest no-coverage
  assert.strictEqual(Physics.cy2014Ln('15', 7.0, g), null);
  assert.strictEqual(Physics.cy2014Ln('0.001', 7.0, g), null);
  assert.strictEqual(Physics.saCy2014Gal('15', 7.0, g), null);
  // frozen SA anchor (sa grid point: 1.0 s, M7.5, Rjb 30, ztor 12, Vs30 760, rev)
  const g2 = { rrup: Math.sqrt(30 * 30 + 12 * 12), rjb: 30, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 760 };
  assert.ok(Math.abs(Physics.cy2014Ln('1', 7.5, g2) - (-1.8831644477561562)) < 1e-12, 'SA 1s anchor');
  const gal = Physics.saCy2014Gal('0.5', 7.5, g2);
  assert.ok(gal > 0 && isFinite(gal), 'sa gal wrapper');
});

test('cy14 — hanging wall: rx<0 (footwall) zeroes the term; centered ztor sign', () => {
  const base = { rrup: Math.sqrt(30 * 30 + 5 * 5), rjb: 30, ztor: 5, dip: 60, rake: 90, vs30: 760 };
  const hw = Physics.cy2014Ln('pga', 7.0, { ...base, rx: 30, ry0: 0 });
  const fw = Physics.cy2014Ln('pga', 7.0, { ...base, rx: -1, ry0: 0 });
  assert.ok(hw > fw, 'hanging-wall side exceeds footwall at same Rjb');
  // rx=0 keeps the c9a-only fraction of the term (tanh(0)=0)
  const at0 = Physics.cy2014Ln('pga', 7.0, { ...base, rx: 0, ry0: 0 });
  assert.ok(hw > at0 && at0 > fw, 'rx=0 between footwall and full hw');
  // centered ztor: the c7/c7b term vanishes at the paper's mean ztor
  // (reverse M7: max(2.704-1.226*(7-5.849),0)^2 = 1.672 km)
  const meanZ = Math.pow(Math.max(2.704 - 1.226 * Math.max(7 - 5.849, 0), 0), 2);
  const C = Physics.CY2014_PAPER.pga;
  const coshm = Math.cosh(2 * Math.max(7 - 4.5, 0));
  const zc = { rrup: Math.sqrt(30 * 30 + meanZ * meanZ), rjb: 30, rx: 30, ry0: 0, ztor: meanZ, dip: 60, rake: 90, vs30: 760 };
  const zdeep = { ...zc, ztor: meanZ + 3, rrup: Math.sqrt(30 * 30 + (meanZ + 3) * (meanZ + 3)) };
  const diff = Physics.cy2014Ln('pga', 7.0, zdeep) - Physics.cy2014Ln('pga', 7.0, zc);
  const expectDz = (C.c7 + C.c7b / coshm) * 3; // c7>0: deeper-than-mean ztor raises the mean
  assert.ok(Math.abs(diff - expectDz) < 0.02, `centered-ztor leg ${diff.toFixed(4)} vs ${expectDz.toFixed(4)} (rrup leg included)`);
});

test('cy14 — point-source convention + production wrappers', () => {
  // nw2PointGeom: Rjb read, Rrup derived from depth, Rx = Rjb, Ry0 = 0,
  // dip default = crustal prior 60
  const g = Physics.nw2PointGeom(7.0, 30, 10, 400, 90, null);
  assert.ok(Math.abs(g.rrup - Math.sqrt(30 * 30 + 10 * 10)) < 1e-12, 'rrup derived');
  assert.strictEqual(g.rjb, 30); assert.strictEqual(g.rx, 30); assert.strictEqual(g.ry0, 0);
  assert.strictEqual(g.dip, 60, 'crustal dip prior');
  // calcPGA/calcPGV explicit model branches (Rkm reads as Rjb)
  const pga = Physics.calcPGA(7.0, 30, 'cy14', 10, null, null, 'crustal', 0, 0, 0, 0, 400, 90, 60);
  const direct = Physics.pgaCy2014(7.0, Physics.nw2PointGeom(7.0, 30, 10, 400, 90, 60));
  assert.ok(Math.abs(pga - direct) < 1e-9, 'calcPGA cy14 == direct');
  const pgv = Physics.calcPGV(7.0, 30, 'cy14', 10, null, null, 'crustal', 0, 400, 90, 60);
  assert.ok(pgv > 5 && pgv < 60, `pgv ${pgv.toFixed(1)} cm/s (physical band)`);
  // PSHA branch motion (pga + sa), sigma components
  const mo = Physics._pshaBranchMotion('cy14', 'pga', 'crustal', 7.0, 30, 10, 400, 90, null);
  assert.ok(mo.median > 0 && mo.sigmaLog10 > 0.1 && mo.sigmaLog10 < 0.5, 'branch motion pga');
  const saMo = Physics._pshaBranchMotion('cy14', 'sa:0.50', 'crustal', 7.0, 30, 10, 400, 90, null);
  assert.ok(saMo && saMo.median > 0, 'branch motion sa');
  assert.strictEqual(Physics._pshaBranchMotion('cy14', 'sa:15.00', 'crustal', 7, 30, 10, 400, 90, null), null, 'SA no-coverage null');
  const sc = Physics.getGmpSigmaComponents('cy14', 'crustal', 'pga', 7.0);
  assert.ok(sc.model === 'cy14' && sc.sigmaT > 0.1 && sc.sigmaT < 0.5, 'sigma components');
});
