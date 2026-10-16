'use strict';
// ================================================================
//  GMPE numerical benchmarks — ASK14 (Abrahamson, Silva & Kamai 2014,
//  NGA-West2, Earthquake Spectra 30(3) 1025-1055)
//
//  Every fixture point is compared against values produced by
//  tools/gen-gmpe-fixtures-ask14.py, a scalar transcription of the OFFICIAL
//  openquake.hazardlib implementation (gem/oq-engine abrahamson_2014.py,
//  sha256 in the fixture). The two implementations were written
//  independently, so this locks BOTH the coefficient transcription and the
//  equation structure (hazardlib _get_basic_term / _get_faulting_style_term
//  / _get_hanging_wall_term (tapers 1-5) / _get_top_of_rupture_depth_term /
//  _get_site_response_term / _get_basin_term (unmeasured -> 0) /
//  _get_regional_term (None -> 0) / _get_stddevs).
//  Regenerate with: python tools/gen-gmpe-fixtures-ask14.py
// ================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics');

const FIXTURE_PATH = path.join(__dirname, '..', 'tools', 'data', 'gmpe-fixtures-ask14.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const F = fixture.pointFields;
const IX = {}; F.forEach((f, i) => { IX[f] = i; });

function geomOf(p) {
  return { mw: p[IX.mag], rrup: p[IX.rrup], rjb: p[IX.rjb], rx: p[IX.rx], ry0: p[IX.ry0],
           ztor: p[IX.ztor], dip: p[IX.dip], rake: p[IX.rake], vs30: p[IX.vs30],
           widthKm: p[IX.widthKm] == null ? undefined : p[IX.widthKm] };
}

// --- hand-transcribed spot cells (so a tampered fixture/generator cannot
// silently bless wrong coefficients — the full table is ALSO locked
// row-by-row against the fixture below) ------------------------------------
test('ask14 — coefficient table matches the hazardlib transcription', () => {
  assert.strictEqual(fixture.source.sha256,
    '386e496e65f3ad228df618bc2c399275686018ed432c7ba30a083ed2ef0f8f8c',
    'fixture provenance sha256 (regenerate via tools/gen-gmpe-fixtures-ask14.py)');
  // whole-table lock against the frozen fixture (24 rows x 43 columns)
  assert.deepStrictEqual(Physics.ASK2014_PAPER, fixture.table.rows, 'full 24-row table');
  // hand-transcribed spot cells from the frozen hazardlib source (pga row)
  const pga = Physics.ASK2014_PAPER.pga;
  const spot = {
    m1: 6.75, vlin: 660, b: -1.47, c: 2.4, c4: 4.5, a1: 0.587, a2: -0.79,
    a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.154, a7: 0.0, a8: -0.015,
    a10: 1.735, a11: 0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1,
    a17: -0.0072, a43: 0.1, a44: 0.05, a45: 0, a46: -0.05, a25: -0.0015,
    a28: 0.0025, a29: -0.0034, a31: -0.1503, a36: 0.265, a37: 0.337,
    a38: 0.188, a39: 0, a40: 0.088, a41: -0.196, a42: 0.044,
    s1e: 0.754, s2e: 0.52, s3: 0.47, s4: 0.36, s1m: 0.741, s2m: 0.501,
    s5: 0.54, s6: 0.6300
  };
  for (const k of Object.keys(spot)) assert.strictEqual(pga[k], spot[k], 'pga.' + k);
  assert.deepStrictEqual(Physics.ASK2014_CONSTS, { n: 1.5, m2: 5.0, h1: 0.25, h2: 1.5, h3: -0.75, refVs: 1180 });
});

test('ask14 — fixture grid covers the structural boundaries', () => {
  assert.strictEqual(fixture.points.length, 17800, 'frozen grid size');
  const dips = new Set(), rakes = new Set(), vs30 = new Set(), imts = new Set(), grids = new Set(), ry0 = new Set();
  for (const p of fixture.points) {
    dips.add(p[IX.dip]); rakes.add(p[IX.rake]); vs30.add(p[IX.vs30]);
    imts.add(p[IX.imt]); grids.add(p[IX.grid]); ry0.add(p[IX.ry0]);
  }
  assert.ok(vs30.has(1130) && vs30.has(1500), 'vlin/v1 site boundaries bracketed');
  assert.ok(dips.has(30) && dips.has(90), 'dip range (T1 <=30 branch + dip==90 Fhw=0)');
  assert.ok(rakes.has(30) && rakes.has(150) && rakes.has(-30) && rakes.has(-150),
    'style-of-faulting boundary rakes pinned (STRICT windows)');
  assert.ok(ry0.has(3) && ry0.has(8), 'T5 along-strike taper pinned');
  assert.strictEqual(imts.size, 24, 'all 24 IMT rows exercised');
  assert.deepStrictEqual([...grids].sort(), ['core', 'hw', 'rakeBnd', 'sa'], 'grid families');
});

test('ask14 — medians reproduce the hazardlib reference at every fixture point', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const lnA = Physics.ask2014Ln(p[IX.imt], geomOf(p));
    const d = Math.abs(lnA - p[IX.lnA]);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δln| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)} — ` +
    'physics.js drifted from the hazardlib reference (see tools/gen-gmpe-fixtures-ask14.py)');
});

test('ask14 — sigma/tau/phi reproduce hazardlib at every fixture point (ln units)', () => {
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const s = Physics.ask2014SigmaLn(p[IX.imt], geomOf(p));
    const d = Math.abs(s.sigma - p[IX.sigma]) + Math.abs(s.tau - p[IX.tau]) + Math.abs(s.phi - p[IX.phi]);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-12,
    `max |Δ(sigma,tau,phi)| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)}`);
});

test('ask14 — hand anchor: crustal M7 Rjb=30 ztor=12 dip=60 reverse Vs30=400', () => {
  // frozen full-precision values from the fixture (core grid point, W&C
  // default width)
  const g = { mw: 7.0, rrup: Math.sqrt(30 * 30 + 12 * 12), rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 };
  const lnA = Physics.ask2014Ln('pga', g);
  assert.ok(Math.abs(lnA - (-1.4928655699581332)) < 1e-12, `lnA = ${lnA}`);
  const s = Physics.ask2014SigmaLn('pga', g);
  assert.ok(Math.abs(s.sigma - 0.6008962077108051) < 1e-12, 'sigma frozen');
  assert.ok(Math.abs(s.tau - 0.3295165797319804) < 1e-12, 'tau frozen');
  assert.ok(Math.abs(s.phi - 0.5024888815913885) < 1e-12, 'phi frozen');
  const gal = Physics.pgaAsk2014(g);
  const uncapped = Math.exp(lnA) * Physics.ASK2014_G_TO_GAL;
  assert.ok(Math.abs(gal - Physics.GMPE_PGA_SOFT_CAP * Math.tanh(uncapped / Physics.GMPE_PGA_SOFT_CAP)) < 1e-9,
    'soft cap formula transparent');
  assert.ok(uncapped > 200 && uncapped < 240, `M7@30km PGA ${uncapped.toFixed(1)} gal (physical band)`);
});

test('ask14 — SA: exact rows, interpolation, honest no-coverage (NO PGA floor in this model)', () => {
  const g = { mw: 7.0, rrup: Math.sqrt(30 * 30 + 12 * 12), rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 };
  const lo = Physics.ask2014Ln('1', g), hi = Physics.ask2014Ln('1.5', g);
  const mid = Physics.ask2014Ln('1.25', g);
  const w = (Math.log(1.25) - Math.log(1)) / (Math.log(1.5) - Math.log(1));
  assert.ok(Math.abs(mid - (lo + w * (hi - lo))) < 1e-12, 'log-period interpolation formula');
  assert.strictEqual(Physics.ask2014Ln('15', g), null);
  assert.strictEqual(Physics.ask2014Ln('0.001', g), null);
  assert.strictEqual(Physics.saAsk2014Gal('15', g), null);
  // frozen SA anchor (sa grid: 1.0 s, M7.5, Rjb 30, ztor 12, Vs30 760, rev)
  const g2 = { mw: 7.5, rrup: Math.sqrt(30 * 30 + 12 * 12), rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 760 };
  assert.ok(Math.abs(Physics.ask2014Ln('1', g2) - (-1.9401681853601)) < 1e-12, 'SA 1s anchor');
  const gal = Physics.saAsk2014Gal('0.5', g2);
  assert.ok(gal > 0 && isFinite(gal), 'sa gal wrapper');
});

test('ask14 — structural terms: hw tapers, vlin site branch, W&C default width, basin identity', () => {
  const mk = (over) => Object.assign({ mw: 7.0, rrup: Math.sqrt(30 * 30 + 25), rx: 5, ry0: 0, ztor: 5, dip: 60, rake: 90, vs30: 760, widthKm: 15 }, over);
  // dip==90 kills the hanging wall outright
  const hw60 = Physics.ask2014Ln('pga', mk({}));
  const hw90 = Physics.ask2014Ln('pga', mk({ dip: 90, rrup: Math.sqrt(30 * 30 + 25) }));
  assert.ok(hw60 > hw90, 'dip 60 hw active > dip 90 (hw killed)');
  // T5 taper: ry0 beyond the rx*tan(20)+5 band zeroes the taper factor
  const near = Physics.ask2014Ln('pga', mk({ ry0: 0 }));
  const midRy = Physics.ask2014Ln('pga', mk({ ry0: 5 * Math.tan(20 * Math.PI / 180) + 2.5 }));
  const far = Physics.ask2014Ln('pga', mk({ ry0: 5 * Math.tan(20 * Math.PI / 180) + 5.5 }));
  assert.ok(near > midRy && midRy > far, 'T5 strictly decays across the taper band (hw on at ry0=0)');
  // vs30 >= vlin: the site term is (a10 + b*n)*ln(vs30star/vlin) — the pga
  // row has vlin 660, so 760 is above it and 400 below it
  const above = Physics.ask2014Ln('pga', mk({ vs30: 760 }));
  const below = Physics.ask2014Ln('pga', mk({ vs30: 400 }));
  assert.ok(below > above, 'softer site amplifies');
  // W&C default width: explicit widthKm == computed default gives identical results
  const wcW = Math.min(80, Math.max(8, Math.pow(10, -1.01 + 0.32 * 7.0)));
  const implicit = Physics.ask2014Ln('pga', { mw: 7.0, rrup: 31.6, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400 });
  const explicit = Physics.ask2014Ln('pga', { mw: 7.0, rrup: 31.6, rx: 30, ry0: 0, ztor: 12, dip: 60, rake: 90, vs30: 400, widthKm: wcW });
  assert.ok(Math.abs(implicit - explicit) < 1e-15, 'W&C default width == explicit');
  // basin identity: unmeasured z1pt0 -> factor 0 (the helper is structural 0)
  const soft2 = Physics.ask2014Ln('pga', mk({ vs30: 270 }));
  assert.ok(isFinite(soft2), 'basin identity finite at soft site');
});

test('ask14 — point-source convention + production wrappers', () => {
  const pga = Physics.calcPGA(7.0, 30, 'ask14', 10, null, null, 'crustal', 0, 0, 0, 0, 400, 90, 60);
  const direct = Physics.pgaAsk2014(Physics.nw2PointGeom(7.0, 30, 10, 400, 90, 60));
  assert.ok(Math.abs(pga - direct) < 1e-9, 'calcPGA ask14 == direct');
  const pgv = Physics.calcPGV(7.0, 30, 'ask14', 10, null, null, 'crustal', 0, 400, 90, 60);
  assert.ok(pgv > 5 && pgv < 60, `pgv ${pgv.toFixed(1)} cm/s (physical band)`);
  const mo = Physics._pshaBranchMotion('ask14', 'pga', 'crustal', 7.0, 30, 10, 400, 90, null);
  assert.ok(mo.median > 0 && mo.sigmaLog10 > 0.1 && mo.sigmaLog10 < 0.5, 'branch motion pga');
  const saMo = Physics._pshaBranchMotion('ask14', 'sa:0.50', 'crustal', 7.0, 30, 10, 400, 90, null);
  assert.ok(saMo && saMo.median > 0, 'branch motion sa');
  assert.strictEqual(Physics._pshaBranchMotion('ask14', 'sa:15.00', 'crustal', 7, 30, 10, 400, 90, null), null, 'SA no-coverage null');
  const sc = Physics.getGmpSigmaComponents('ask14', 'crustal', 'pga', 7.0);
  assert.ok(sc.model === 'ask14' && sc.sigmaT > 0.1 && sc.sigmaT < 0.5, 'sigma components');
});
