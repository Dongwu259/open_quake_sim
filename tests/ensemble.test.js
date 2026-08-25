'use strict';
// R1 (2026-08-24): Monte Carlo ensemble engine acceptance.
//  - determinism (same seed -> identical percentiles)
//  - the correlated field reproduces its target correlation
//  - PRE-REGISTERED R1 acceptance on the frozen 13-event set: pooled 68%
//    (P16-P84) and 80% (P10-P90) interval coverage of observed JMA
//    intensity within +/-5pp of nominal (ROADMAP R1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics');

test('ensemble — deterministic percentiles and healthy spread', () => {
  const ctx = { source: { lat: 36, lng: 140, mw: 7.3, depthKm: 15, sourceType: 'crustal' },
    geometry: null, gmpModel: 'logic-tree', options: {} };
  const rng = Physics.seededRng('st');
  const sts = [];
  for (let i = 0; i < 120; i++) sts.push({ lat: 35.6 + rng() * 0.8, lng: 139.6 + rng() * 0.8, vs30: 400 });
  const a = Physics.ensembleIntensityField(ctx, sts, { members: 60, seed: 'det' });
  const b = Physics.ensembleIntensityField(ctx, sts, { members: 60, seed: 'det' });
  for (let i = 0; i < sts.length; i++) {
    for (const k of ['p10', 'p16', 'p50', 'p84', 'p90']) {
      assert.strictEqual(a.perStation[i][k], b.perStation[i][k], `station ${i} ${k} must be byte-stable`);
    }
    assert.ok(a.perStation[i].p10 <= a.perStation[i].p16 && a.perStation[i].p16 <= a.perStation[i].p50
      && a.perStation[i].p50 <= a.perStation[i].p84 && a.perStation[i].p84 <= a.perStation[i].p90,
      'quantile ordering');
    const spread = a.perStation[i].p84 - a.perStation[i].p16;
    assert.ok(spread > 0.3 && spread < 4, `68% band ${spread} plausible`);
  }
});

test('ensemble — correlated field matches rho(h)=exp(-3h/range)', () => {
  const rng = Physics.seededRng('field-test');
  const xs = [], ys = [];
  for (let i = 0; i < 400; i++) { xs.push(rng() * 120 - 60); ys.push(rng() * 120 - 60); }
  const range = 20;
  const f = Physics.correlatedGaussianField2D(xs, ys, range, rng);
  const pairs = { near: [], far: [] };
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    const h = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
    if (h < 10) pairs.near.push([f[i], f[j]]);
    else if (h >= 40 && h < 60) pairs.far.push([f[i], f[j]]);
  }
  function corr(ps) {
    const n = ps.length, ma = ps.reduce((s, p) => s + p[0], 0) / n, mb = ps.reduce((s, p) => s + p[1], 0) / n;
    let c = 0, va = 0, vb = 0;
    for (const [a, b] of ps) { c += (a - ma) * (b - mb); va += (a - ma) ** 2; vb += (b - mb) ** 2; }
    return c / Math.sqrt(va * vb);
  }
  const nearTarget = Math.exp(-3 * 5 / range); // bin center 5 km
  const nearGot = corr(pairs.near);
  assert.ok(Math.abs(nearGot - nearTarget) < 0.12, `near correlation ${nearGot.toFixed(3)} vs target ${nearTarget.toFixed(3)}`);
  assert.ok(Math.abs(corr(pairs.far)) < 0.05, 'far correlation ~ 0');
});

test('ensemble — R1 acceptance: 68%/80% coverage on the frozen 13-event set (+/-5pp)', () => {
  const Scorecard = require('../tools/scorecard-strong-motion.js');
  const OBS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'strong-motion-obs.json'), 'utf8'));
  const CAL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'gmpe-calibration.json'), 'utf8'));
  const hypos = Scorecard.loadJmaHypocenters();
  Physics.setGmpeCalibration(CAL);
  try {
    let in68 = 0, in80 = 0, n = 0;
    for (const ev0 of OBS.events) {
      const h = hypos[ev0.eventId];
      const ev = { source: { lat: h.lat, lng: h.lng, mw: h.mw, depthKm: h.depthKm, sourceType: ev0.sourceType },
        geometry: null, gmpModel: 'logic-tree', options: {} };
      const sts = ev0.stations.filter((s, i) => i % 3 === 0)
        .map(s => ({ lat: s.lat, lng: s.lng, vs30: s.vs30 || 400, observedIntensity: Physics.calcJmaIntensity(s.pgaGal, s.pgvCms) }));
      const r = Physics.ensembleIntensityField(ev, sts, { members: 120, seed: 'acc-' + ev0.eventId });
      for (const row of r.perStation) { if (row.inside68) in68++; if (row.inside80) in80++; n++; }
    }
    const c68 = in68 / n, c80 = in80 / n;
    assert.ok(Math.abs(c68 - 0.68) <= 0.05, `68% band coverage ${c68.toFixed(3)} (n=${n})`);
    assert.ok(Math.abs(c80 - 0.80) <= 0.05, `80% band coverage ${c80.toFixed(3)} (n=${n})`);
  } finally {
    Physics.setGmpeCalibration(null);
  }
});

test('ensemble — exceedance cross-check: analytic lognormal CCDF vs member fractions (v5.6 R1-3)', () => {
  // jitter OFF + one fixed model: a member's PGA multiplier is exactly
  // lognormal(0, sqrt(tau^2+phi^2)) in ln space — the same distribution the
  // analytic exceedanceProbability encodes. Empirical member fractions must
  // track the CCDF within the binomial MC band (full-frozen-set evidence:
  // tools/data/exceedance-crosscheck-report.json, mean |dP| 0.016).
  const ctx = { source: { lat: 36.2, lng: 140.1, mw: 7.1, depthKm: 12, sourceType: 'crustal' },
    geometry: null, gmpModel: 'si-midorikawa', options: {} };
  const rng = Physics.seededRng('xcheck-st');
  const sts = [];
  for (let i = 0; i < 40; i++) sts.push({ lat: 35.7 + rng() * 0.9, lng: 139.6 + rng() * 0.9, vs30: 200 + Math.floor(rng() * 500) });
  const res = Physics.ensembleIntensityField(ctx, sts, { members: 400, seed: 'xcheck-fix', jitter: false, keepPga: true });
  const comp = Physics.getGmpSigmaComponents('si-midorikawa', 'crustal');
  assert.ok(comp.sigmaT > 0.2 && comp.sigmaT < 0.5, 'sigmaT plausible: ' + comp.sigmaT);
  let sumAbs = 0, n = 0, maxAbs = 0;
  for (const row of res.perStation) {
    const vals = row.pgaMembers;
    assert.ok(vals && vals.length === 400, 'keepPga must retain all members');
    const med = vals[200];
    for (const thr of [med * 0.5, med, med * 2, 80, 250]) {
      if (!(thr > 0)) continue;
      const emp = vals.filter(v => v >= thr).length / 400;
      const ana = Physics.exceedanceProbability(med, comp.sigmaT, thr);
      const d = Math.abs(emp - ana);
      sumAbs += d; n++; if (d > maxAbs) maxAbs = d;
    }
  }
  const meanAbs = sumAbs / n;
  assert.ok(meanAbs < 0.05, `mean |dP| ${meanAbs.toFixed(4)} exceeds the MC band`);
  assert.ok(maxAbs < 0.15, `worst |dP| ${maxAbs.toFixed(4)} implausible`);
});
