'use strict';
// ================================================================
//  GMPE numerical benchmarks (R0-3, 2026-08-24)
//
//  zhao2006: every fixture point is compared against values produced by
//  tools/gen-gmpe-fixtures.py, a scalar transcription of the OFFICIAL
//  openquake.hazardlib implementation (gem/oq-engine zhao_2006.py, sha256 in
//  the fixture). The two implementations were written independently, so this
//  locks BOTH the coefficient transcription and the equation structure.
//  Regenerate with: python tools/gen-gmpe-fixtures.py
//
//  kanno2006: no open-source independent implementation exists, so these are
//  frozen regression-lock values (regenerate by recomputing and re-freezing
//  when the Kanno path is deliberately changed).
// ================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics');

const FIXTURE_PATH = path.join(__dirname, '..', 'tools', 'data', 'gmpe-fixtures-zhao2006.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// --- hazardlib-transcribed coefficients (kept inline so a tampered fixture
// file cannot silently bless wrong coefficients) ---------------------------
const OQ_ASC = {
  pga: { a: 1.101, b: -0.00564, c: 0.0055, d: 1.080, e: 0.01412, fr: 0.251,
         site: [0.293, 1.111, 1.344, 1.355, 1.420], qc: 0.0, wc: 0.0, tau: 0.303, sigma: 0.604 },
  sa1: { a: 1.479, b: -0.00220, c: 0.0020, d: 1.115, e: 0.01005, fr: 0.211,
         site: [-2.451, -2.152, -1.776, -1.523, -1.084], qc: -0.0899, wc: 0.0440, tau: 0.338, sigma: 0.657 }
};
const OQ_SINTER = {
  pga: { si: 0.000, qi: 0.0, wi: 0.0, tau: 0.308 },
  sa1: { si: -0.239, qi: -0.0917, wi: 0.0721, tau: 0.328 }
};
const OQ_SSLAB = {
  pga: { ss: 2.607, ssl: -0.528, ps: 0.1392, qs: 0.1584, ws: -0.0529, tau: 0.321 },
  sa1: { ss: 2.233, ssl: -0.509, ps: 0.1060, qs: 0.0314, ws: 0.0498, tau: 0.286 }
};

test('zhao2006 — coefficient tables match the openquake.hazardlib transcription', () => {
  for (const imt of ['pga', 'sa1']) {
    const P = Physics.ZHAO2006_PAPER[imt];
    const A = OQ_ASC[imt], I = OQ_SINTER[imt], S = OQ_SSLAB[imt];
    assert.deepStrictEqual([P.a, P.b, P.c, P.d, P.e, P.fr],
      [A.a, A.b, A.c, A.d, A.e, A.fr], `${imt} ASC scalar coefficients`);
    assert.deepStrictEqual(P.site, A.site, `${imt} site-class terms [CH,C1,C2,C3,C4]`);
    assert.strictEqual(P.asc.qc, A.qc, `${imt} crustal QC`);
    assert.strictEqual(P.asc.wc, A.wc, `${imt} crustal WC`);
    assert.strictEqual(P.tau, A.tau, `${imt} crustal tauC`);
    assert.strictEqual(P.sigma, A.sigma, `${imt} shared sigma`);
    assert.strictEqual(P.inter.si, I.si, `${imt} interface SI`);
    assert.strictEqual(P.inter.qi, I.qi, `${imt} interface QI`);
    assert.strictEqual(P.inter.wi, I.wi, `${imt} interface WI`);
    assert.strictEqual(P.inter.tau, I.tau, `${imt} interface tauI`);
    assert.strictEqual(P.slab.ss, S.ss, `${imt} slab SS`);
    assert.strictEqual(P.slab.ssl, S.ssl, `${imt} slab SSL`);
    assert.strictEqual(P.slab.ps, S.ps, `${imt} slab PS`);
    assert.strictEqual(P.slab.qs, S.qs, `${imt} slab QS`);
    assert.strictEqual(P.slab.ws, S.ws, `${imt} slab WS`);
    assert.strictEqual(P.slab.tau, S.tau, `${imt} slab tauS`);
  }
  // The fixture file itself must carry the same transcription.
  assert.strictEqual(fixture.source.sha256,
    '3322dd09d4064d917fce9c9b5ec11b571b0fd94f1a068a8982d6ccea5ac88ec9',
    'fixture provenance sha256 (regenerate via tools/gen-gmpe-fixtures.py)');
});

// --- v6.1 P2 (2026-09-01): the full 20-period SA extension -------------------
// Periods 0.05-5.00 s transcribed from the SAME frozen hazardlib source; the
// point-wise fixture test above already locks every period's equation output.
// These assertions lock the table SHAPE plus hand-inline anchor rows so a
// tampered fixture cannot bless a wrong table.
const ALL_PERIODS = ['0.05', '0.10', '0.15', '0.20', '0.25', '0.30', '0.40', '0.50', '0.60',
  '0.70', '0.80', '0.90', '1.00', '1.25', '1.50', '2.00', '2.50', '3.00', '4.00', '5.00'];

test('zhao2006 — full SA period table present with hand-verified anchor rows', () => {
  assert.strictEqual(Physics.ZHAO2006_PAPER.sa1, Physics.ZHAO2006_PAPER['1.00'], 'sa1 alias');
  for (const p of ALL_PERIODS) assert.ok(Physics.ZHAO2006_PAPER[p], `row ${p}`);
  const anchors = {
    '0.05': { a: 1.076, sigma: 0.64, tau: 0.326, site0: 0.939, si: 0.0, qi: 0.0, wi: 0.0, tauI: 0.343, ss: 2.764, ssl: -0.551, ps: 0.1636, qs: 0.1932, ws: -0.0841, tauS: 0.378 },
    '0.50': { a: 1.25, sigma: 0.653, tau: 0.338, site0: -0.207, si: -0.053, qi: -0.0632, wi: 0.0562, tauI: 0.277, ss: 2.629, ssl: -0.554, ps: 0.1381, qs: 0.1078, ws: -0.0008, tauS: 0.272 },
    '5.00': { a: 1.825, sigma: 0.643, tau: 0.275, site0: -6.752, si: -0.498, qi: -0.1578, wi: 0.109, tauI: 0.272, ss: 0.225, ssl: -0.12, ps: -0.0117, qs: 0.0246, ws: -0.0268, tauS: 0.296 }
  };
  for (const p of Object.keys(anchors)) {
    const A = anchors[p], P = Physics.ZHAO2006_PAPER[p];
    assert.strictEqual(P.a, A.a, `${p} a`);
    assert.strictEqual(P.sigma, A.sigma, `${p} sigma`);
    assert.strictEqual(P.tau, A.tau, `${p} tauC`);
    assert.strictEqual(P.site[0], A.site0, `${p} CH`);
    assert.strictEqual(P.inter.si, A.si, `${p} SI`);
    assert.strictEqual(P.inter.qi, A.qi, `${p} QI`);
    assert.strictEqual(P.inter.wi, A.wi, `${p} WI`);
    assert.strictEqual(P.inter.tau, A.tauI, `${p} tauI`);
    assert.strictEqual(P.slab.ss, A.ss, `${p} SS`);
    assert.strictEqual(P.slab.ssl, A.ssl, `${p} SSL`);
    assert.strictEqual(P.slab.ps, A.ps, `${p} PS`);
    assert.strictEqual(P.slab.qs, A.qs, `${p} QS`);
    assert.strictEqual(P.slab.ws, A.ws, `${p} WS`);
    assert.strictEqual(P.slab.tau, A.tauS, `${p} tauS`);
  }
});

test('zhao2006 — fixture covers every period; period-aware sigma matches hazardlib stddevs', () => {
  const imts = new Set(fixture.points.map(p => p.imt));
  assert.ok(imts.has('pga') && imts.has('sa1'));
  // '1.00' is emitted under the legacy label 'sa1' (full 1,200-point grid)
  for (const p of ALL_PERIODS) {
    if (p === '1.00') continue;
    assert.ok(imts.has(p), `fixture imt ${p} missing`);
  }
  // per-period points: full 1,200 grid for pga/sa1, >=96 stratified for the rest
  const byImt = {};
  for (const p of fixture.points) byImt[p.imt] = (byImt[p.imt] || 0) + 1;
  assert.strictEqual(byImt.pga, 1200);
  assert.strictEqual(byImt.sa1, 1200);
  for (const p of ALL_PERIODS) {
    if (p === '1.00') continue;
    assert.ok(byImt[p] >= 96, `${p}: ${byImt[p]}`);
  }
  // zhao2006Sigma: tau per class + phi = row sigma, in ln units in fixtures
  for (const p of ['0.05', '0.50', '2.00', '5.00']) {
    for (const cls of ['crustal', 'interplate', 'intraslab']) {
      const sd = fixture.stddevs_ln[`${p}.${cls}`];
      assert.ok(sd, `stddevs ${p}.${cls}`);
      const s = Physics.zhao2006Sigma(p, cls);
      assert.ok(Math.abs(s.phi * Math.LN10 - sd.phi_ln) < 1e-12, `${p}.${cls} phi`);
      assert.ok(Math.abs(s.tau * Math.LN10 - sd.tau_ln) < 1e-12, `${p}.${cls} tau`);
    }
  }
  // pga stays byte-identical to the class-constant table; pgv now pairs the
  // sa1-derived medians with the sa1-row sigma (v6.1 P2 fix: P1 had used the
  // PGA-row class sigma with sa1 medians — period-consistent now)
  for (const cls of ['crustal', 'interplate', 'intraslab']) {
    assert.strictEqual(Physics.zhao2006Sigma('pga', cls).sigmaT, Physics.ZHAO2006_SIGMA[cls].sigmaT);
    const s = Physics.zhao2006Sigma('pgv', cls);
    const sd = fixture.stddevs_ln[`sa1.${cls}`];
    assert.ok(Math.abs(s.phi * Math.LN10 - sd.phi_ln) < 1e-12, `pgv ${cls} phi`);
    assert.ok(Math.abs(s.tau * Math.LN10 - sd.tau_ln) < 1e-12, `pgv ${cls} tau`);
  }
});

test('zhao2006 — medians reproduce the hazardlib reference at every fixture point', () => {
  assert.ok(fixture.points.length >= 2000, 'fixture grid unexpectedly small');
  let worst = 0, worstPoint = null;
  for (const p of fixture.points) {
    const lnA = Physics.zhao2006LnA(p.imt, p.srcType, p.mw, p.rrupKm, p.depthKm, p.vs30, p.rake);
    const d = Math.abs(lnA - p.lnA);
    if (d > worst) { worst = d; worstPoint = p; }
  }
  assert.ok(worst < 1e-9,
    `max |ΔlnA| ${worst.toExponential(3)} at ${JSON.stringify(worstPoint)} — `
    + 'physics.js drifted from the hazardlib reference (see tools/gen-gmpe-fixtures.py)');
});

test('zhao2006 — stddevs match hazardlib (phi=sigma shared, tau per tectonic class)', () => {
  const LN10 = Math.log(10);
  const expected = {
    crustal: [0.303, 0.604], interplate: [0.308, 0.604], intraslab: [0.321, 0.604]
  };
  for (const cls of Object.keys(expected)) {
    const [tau, phi] = expected[cls];
    const s = Physics.ZHAO2006_SIGMA[cls];
    assert.ok(Math.abs(s.tau * LN10 - tau) < 1e-12, `${cls} tau`);
    assert.ok(Math.abs(s.phi * LN10 - phi) < 1e-12, `${cls} phi`);
    assert.ok(Math.abs(s.sigmaT * LN10 - Math.sqrt(tau * tau + phi * phi)) < 1e-12, `${cls} total`);
  }
  // Fixture stddevs (PGA row) agree with the table above.
  assert.ok(Math.abs(fixture.stddevs_ln['pga.crustal'].phi_ln - 0.604) < 1e-15);
  assert.ok(Math.abs(fixture.stddevs_ln['pga.intraslab'].tau_ln - 0.321) < 1e-15);
});

// kanno2006: frozen regression lock (values computed 2026-08-24; refresh
// deliberately when the Kanno path changes, documenting why).
test('kanno2006 — frozen regression lock', () => {
  const frozen = [
    ['pgaKannoShallow', 6.5, 30, 250, 286.6499486999711],
    ['pgaKannoShallow', 7.5, 80, 400, 200.4493794718541],
    ['pgaKannoDeep', 7.0, 120, 400, 73.52020232816925],
    ['pgaKannoDeep', 8.2, 250, 600, 52.318009295918436],
    ['pgvKannoShallow', 6.5, 30, 250, 27.043439546763842],
    ['pgvKannoShallow', 7.5, 80, 400, 32.26210692851302],
    ['pgvKannoDeep', 7.0, 120, 400, 10.145083406782906],
    ['pgvKannoDeep', 8.2, 250, 600, 19.29208904316057]
  ];
  for (const [fn, mw, r, vs30, expected] of frozen) {
    const got = Physics[fn](mw, r, vs30);
    assert.ok(Math.abs(got - expected) < 1e-9 * Math.max(1, Math.abs(expected)),
      `${fn}(${mw},${r},${vs30}) = ${got} drifted from frozen ${expected}`);
  }
});

// R1 (2026-08-24): fitted sigma components must mirror the frozen report.
test('sigma components — si-midorikawa/kanno2006 fitted decomposition matches the frozen fit', () => {
  const rep = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'data', 'sigma-components-report.json'), 'utf8'));
  const LN10 = Math.log(10);
  for (const model of ['si-midorikawa', 'kanno2006']) {
    const fitted = rep.models[model];
    assert.ok(fitted && fitted.lnPga && fitted.lnPga.events >= 2, model + ' fit present');
    const c = Physics.GMPE_SIGMA_COMPONENTS[model];
    assert.ok(Math.abs(c.tau * LN10 - fitted.lnPga.tau) < 5e-4, model + ' tau');
    assert.ok(Math.abs(c.phi * LN10 - fitted.lnPga.phi) < 5e-4, model + ' phi');
    assert.ok(Math.abs(c.sigmaT * LN10 - fitted.lnPga.sigmaT) < 5e-4, model + ' total');
    const via = Physics.getGmpSigmaComponents(model, 'crustal');
    assert.equal(via.model, model);
    assert.ok(Math.abs(via.tau - c.tau) < 1e-12, model + ' accessor tau');
  }
  // zhao keeps the paper values; the accessor still routes there.
  const z = Physics.getGmpSigmaComponents('zhao2006', 'intraslab');
  assert.ok(Math.abs(z.tau * LN10 - 0.321) < 1e-12);
  assert.equal(Physics.getGmpSigmaComponents('log', 'crustal').tau, null, 'log model stays total-only');
});

// R1 (2026-08-24): logic-tree weights mirror the frozen LLH report and the
// aggregation math is exact.
test('logic tree — frozen LLH weights embedded in physics match the report', () => {
  const rep = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'data', 'logic-tree-weights.json'), 'utf8'));
  for (const cls of Object.keys(Physics.GMPE_LOGIC_TREE)) {
    const fitted = rep.classes[cls];
    assert.ok(fitted, cls + ' fitted');
    const sorted = fitted.branches.slice().sort((a, b) => a.model < b.model ? -1 : 1);
    const embedded = Physics.GMPE_LOGIC_TREE[cls].slice().sort((a, b) => a.model < b.model ? -1 : 1);
    assert.equal(embedded.length, sorted.length, cls + ' branch count');
    for (let i = 0; i < sorted.length; i++) {
      assert.equal(embedded[i].model, sorted[i].model);
      assert.ok(Math.abs(embedded[i].weight - sorted[i].weight) < 5e-4, cls + '/' + sorted[i].model);
    }
    // weights sum to ~1
    const sum = Physics.GMPE_LOGIC_TREE[cls].reduce((s, b) => s + b.weight, 0);
    assert.ok(Math.abs(sum - 1) < 5e-3, cls + ' weight sum ' + sum);
  }
  // accessor normalizes and falls back for unknown classes
  const b = Physics.logicTreeBranches('crustal');
  assert.ok(Math.abs(b.reduce((s, x) => s + x.weight, 0) - 1) < 1e-9);
  assert.equal(Physics.logicTreeBranches('unknown-class')[0].weight, 1);
});

test('logic tree — predictStationMotion aggregation is the weighted geometric mean', () => {
  const ctx = function (m) {
    return { source: { lat: 36, lng: 140, mw: 7.5, depthKm: 20, sourceType: 'crustal' },
      geometry: null, gmpModel: m, options: { siteModel: 'vs30' } };
  };
  const st = { lat: 36.3, lng: 140.4, vs30: 400 };
  const lt = Physics.predictStationMotion(ctx('logic-tree'), st, {});
  assert.ok(lt.logicTree && lt.logicTree.branches.length === 3);
  let expected = 0, wsum = 0;
  for (const b of lt.logicTree.branches) {
    const single = Physics.predictStationMotion(ctx(b.model), st, {});
    assert.ok(Math.abs(single.pga - b.pga) < 1e-9, b.model + ' branch equals single-model run');
    expected += b.weight * Math.log(single.pga); wsum += b.weight;
  }
  assert.ok(Math.abs(Math.exp(expected / wsum) - lt.pga) < 1e-6, 'weighted geometric mean');
  assert.ok(lt.logicTree.sigmaEpistemicPga > 0, 'epistemic spread present');
});

// R1 (2026-08-24): Jayaram & Baker (2009) spatial correlation.
test('spatial correlation — JB2009 paper formula values', () => {
  assert.strictEqual(Physics.JB2009.rangeKm(0, false), 8.5);
  assert.strictEqual(Physics.JB2009.rangeKm(0, true), 40.7);
  assert.strictEqual(Physics.JB2009.rangeKm(0.5, false), 8.5 + 17.2 * 0.5);
  assert.strictEqual(Physics.JB2009.rangeKm(0.5, true), 40.7 - 15.0 * 0.5);
  // long-period branch ignores clustering: T>=1
  assert.strictEqual(Physics.JB2009.rangeKm(2, false), 22.0 + 3.7 * 2);
  assert.strictEqual(Physics.JB2009.rangeKm(2, true), Physics.JB2009.rangeKm(2, false));
  assert.ok(Math.abs(Physics.JB2009.rho(0, 0, false) - 1) < 1e-12);
  assert.ok(Math.abs(Physics.JB2009.rho(10, 0, false) - Math.exp(-30 / 8.5)) < 1e-12);
});

test('spatial correlation — fitted system ranges mirror the frozen semivariogram fit', () => {
  const rep = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'data', 'spatial-correlation-report.json'), 'utf8'));
  for (const metric of ['lnPga', 'intensity']) {
    const fitted = rep.metrics[metric].rangeKm;
    assert.ok(fitted && fitted > 3 && fitted < 120, metric + ' fitted range plausible');
    assert.ok(Math.abs(Physics.SPATIAL_CORRELATION[metric].rangeKm - fitted) < 0.51,
      metric + ' embedded range ' + Physics.SPATIAL_CORRELATION[metric].rangeKm + ' vs fitted ' + fitted);
  }
  // monotone decay + exact exp form for the system metric
  const rho5 = Physics.spatialCorrelation(5, 'intensity');
  const rho50 = Physics.spatialCorrelation(50, 'intensity');
  assert.ok(rho5 > rho50 && rho5 < 1 && rho50 > 0);
  assert.ok(Math.abs(rho5 - Math.exp(-15 / Physics.SPATIAL_CORRELATION.intensity.rangeKm)) < 1e-12);
  assert.strictEqual(Physics.spatialCorrelation(10, 'unknown-metric'), 0);
});
