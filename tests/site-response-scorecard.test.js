'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { computeReport } = require('../tools/scorecard-site-response.js');
const Physics = require('../public/physics.js');

test('scorecard-site-response: four arms over a reduced frozen set, structure + sanity', () => {
  const obs = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../public/geojson/strong-motion-obs.json'), 'utf8'));
  // reduced slice keeps the test fast: first event, stations with full peaks
  const ev = obs.events[0];
  const small = { events: [{ ...ev, stations: ev.stations.filter(s => s.pgaGal > 0 && s.pgvCms > 0).slice(0, 60) }] };
  assert.ok(small.events[0].stations.length >= 30, 'fixture slice unexpectedly small');

  const report = computeReport(small, { jivsm: null });
  for (const arm of ['vs30', 'ss14', 'eqlin-1d', 'eqlin-real', 'eqlin-sb']) {
    assert.ok(report.arms[arm], 'arm missing: ' + arm);
    const o = report.arms[arm].overall;
    assert.ok(o.pga.n >= 30, arm + ' pga n=' + o.pga.n);
    assert.ok(isFinite(o.pga.bias) && isFinite(o.pga.rms));
    assert.ok(Math.abs(o.pga.bias) < 2, arm + ' bias implausible: ' + o.pga.bias);
    assert.ok(report.arms[arm].byDistance.length === 5);
    assert.ok(report.arms[arm].byEvent.length === 1);
  }
  assert.ok(report.joinedSubset && report.joinedSubset['eqlin-1d']);
  assert.ok(report.meta.convention && report.meta.convention.indexOf('log10(pred/obs)') === 0);
});

test('scorecard-site-response: eqlin arm changes the prediction (not a passthrough)', () => {
  const obs = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../public/geojson/strong-motion-obs.json'), 'utf8'));
  const ev = obs.events[0];
  const st = ev.stations.find(s => s.pgaGal > 0 && s.pgvCms > 0 && s.vs30 > 0 && s.vs30 < 400);
  assert.ok(st, 'no soft station in fixture');
  const a = computeReport({ events: [{ ...ev, stations: [st] }] }, { jivsm: null });
  const pVs30 = a.arms['vs30'].overall.pga.bias, pEq = a.arms['eqlin-1d'].overall.pga.bias;
  // single-station bias = log10(pred/obs): arms must diverge on a soft site
  assert.ok(Math.abs(pEq - pVs30) > 0.02,
    'eqlin and vs30 arms produced identical predictions (' + pVs30 + ' vs ' + pEq + ')');
});

test('scorecard-site-response: S/B prior arm diverges from the legacy eqlin arm', () => {
  const obs = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../public/geojson/strong-motion-obs.json'), 'utf8'));
  const ens = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../public/geojson/sb-spectral-ratio.json'), 'utf8')).ensemble;
  assert.ok(ens.f0Vs30Fit, 'committed ensemble carries the f0(Vs30) fit');
  const ev = obs.events[0];
  const st = ev.stations.find(s => s.pgaGal > 0 && s.pgvCms > 0 && s.vs30 > 0 && s.vs30 < 400);
  const a = computeReport({ events: [{ ...ev, stations: [st] }] }, { jivsm: null, sbEnsemble: ens });
  const pLegacy = a.arms['eqlin-1d'].overall.pga.bias, pSb = a.arms['eqlin-sb'].overall.pga.bias;
  assert.ok(Math.abs(pSb - pLegacy) > 0.02,
    'two-scale column must change the soft-site prediction (' + pLegacy + ' vs ' + pSb + ')');
  assert.equal(Physics.SB_F0_FIT, null, 'computeReport must not leak the registry');
});

test('physics: synthSiteProfile and psLogToProfile contracts', () => {
  const prof = Physics.synthSiteProfile(250, 120);
  assert.ok(prof && prof.length === 3);
  assert.equal(prof[0].vs, 250); assert.equal(prof[0].thickness, 120);
  assert.equal(prof[1].vs, 1400); assert.ok(prof[2].vs >= 3000 && !prof[2].thickness);
  // deep basin capped, shallow floored, invalid rejected
  assert.equal(Physics.synthSiteProfile(250, 5000)[0].thickness, 600);
  assert.equal(Physics.synthSiteProfile(250, 0)[0].thickness, 5);
  assert.equal(Physics.synthSiteProfile(0, 100), null);
  const log = Physics.psLogToProfile([{ from: 0, to: 3, vs: 120 }, { from: 3, to: 30, vs: 480 }, { from: 30, to: 100, vs: 800 }]);
  assert.equal(log.length, 4); // 3 layers + halfspace
  assert.ok(log[3].vs >= 1500 && !log[3].thickness);
  assert.equal(Physics.psLogToProfile([]), null);
  // eqlinSiteFactor: bounded factors, soft site amplifies PGA band at low input
  const f = Physics.eqlinSiteFactor(prof, 10);
  assert.ok(f.pga >= 0.25 && f.pga <= 6 && f.pgv >= 0.25 && f.pgv <= 6);
  const fSoft = Physics.eqlinSiteFactor(Physics.synthSiteProfile(150, 60), 10);
  const fStrong = Physics.eqlinSiteFactor(Physics.synthSiteProfile(150, 60), 500);
  assert.ok(fSoft.pga > fStrong.pga, 'soft-site amplification must deamplify under strong input');
  assert.equal(Physics.eqlinSiteFactor(null, 10), null);
});
