'use strict';
// v5.7 R4: near-fault directivity — Shahi & Baker (2013/15 PEER 2013/15)
// pulse probability/period/orientation equations (verbatim transcribed,
// archived .cache/papers/) + the Mavroeidis & Papageorgiou (2003) analytic
// pulse and its injection into the 3C stochastic carrier.
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

test('pulseProbability: frozen logistic values (report eqs 2.6/2.7)', () => {
  // strike-slip P = 1/(1+exp(0.642 + 0.167r - 0.075s))
  const near = Physics.pulseProbability({ rKm: 5, sKm: 40 });
  assert.ok(Math.abs(near - 1 / (1 + Math.exp(0.642 + 0.167 * 5 - 0.075 * 40))) < 1e-12);
  assert.ok(near > 0.8, 'forward-directivity near site: ' + near.toFixed(3));
  const far = Physics.pulseProbability({ rKm: 100, sKm: 10 });
  assert.ok(far < 0.1, 'far off-track: ' + far.toFixed(3));
  // non-strike-slip P = 1/(1+exp(0.128 + 0.055r - 0.061d + 0.036θ))
  const dip = Physics.pulseProbability({ rKm: 10, dKm: 20, thetaDeg: 30 });
  assert.ok(Math.abs(dip - 1 / (1 + Math.exp(0.128 + 0.55 - 1.22 + 1.08))) < 1e-12);
  // missing parameters -> 0
  assert.equal(Physics.pulseProbability({ rKm: 10 }), 0);
  assert.equal(Physics.pulseProbability(null), 0);
});

test('pulsePeriodSec / pulseOrientationProb: magnitude scaling and orientation', () => {
  assert.ok(Math.abs(Physics.pulsePeriodSec(7) - Math.exp(1.2)) < 1e-12); // lnTp = -5.73+0.99M
  assert.ok(Physics.pulsePeriodSec(6.5) > 1.9 && Physics.pulsePeriodSec(6.5) < 2.1);
  // orientation: max at fault-normal (alpha=90), lower along strike
  assert.ok(Math.abs(Physics.pulseOrientationProb(90, true) - 0.67) < 1e-12);
  assert.ok(Math.abs(Physics.pulseOrientationProb(0, true) - (0.67 - 0.0041 * 77.5)) < 1e-12);
  assert.ok(Math.abs(Physics.pulseOrientationProb(90, false) - 0.53) < 1e-12);
  assert.ok(Physics.pulseOrientationProb(90, true) > Physics.pulseOrientationProb(0, true));
});

test('mavroeidisPulse: analytic shape, peak bound, derivative consistency', () => {
  const Vp = 80, Tp = 3;
  const p = Physics.mavroeidisPulse(Vp, Tp, 1.5, Math.PI / 2, 50);
  assert.equal(p.v.length, p.a.length);
  assert.ok(Math.abs(p.durationSec - 1.5 * Tp) < 0.05);
  let vPeak = 0;
  for (const v of p.v) vPeak = Math.max(vPeak, Math.abs(v));
  assert.ok(vPeak > 0.4 * Vp && vPeak < Vp, 'peak velocity bounded by Vp, got ' + vPeak.toFixed(1));
  // acceleration is the exact derivative: trapezoid integral of a = v(end)-v(0) = 0
  let integ = 0;
  for (let i = 1; i < p.a.length; i++) integ += (p.a[i] + p.a[i - 1]) / 2 / 50;
  assert.ok(Math.abs(integ) < 0.5, 'velocity-consistent acceleration, integral ' + integ.toFixed(3));
});

test('injectDirectivityPulse: threshold, Tp floor, fault-normal orientation', () => {
  const mk = () => Physics.synthesizeWaveform3C(7, 30, 10, 1, 20, 50, 42);
  const lowP = mk();
  const same = Physics.injectDirectivityPulse(lowP, { prob: 0.4, mw: 7, pgvCms: 60 });
  assert.equal(same.pulse, undefined, 'P < 0.5 does not inject');
  const target = mk();
  const injected = Physics.injectDirectivityPulse(target, { prob: 0.9, mw: 7, pgvCms: 60, faultNormalAzRad: Math.PI / 2 });
  assert.ok(injected.pulse, 'pulse descriptor present');
  assert.ok(Math.abs(injected.pulse.probability - 0.9) < 1e-9);
  assert.ok(Math.abs(injected.pulse.tpSec - Physics.pulsePeriodSec(7)) < 0.05);
  // fault-normal azimuth pi/2 (east): all pulse energy on x (east), none on y
  assert.ok(Math.abs(injected.pulse.faultNormalAzRad - Math.PI / 2) < 1e-9);
  // Tp < 0.6 s events (small M) do not pulse (report 2.3.3)
  const small = mk();
  assert.equal(Physics.injectDirectivityPulse(small, { prob: 0.99, mw: 5, pgvCms: 30 }).pulse, undefined);
  // zero PGV guard
  const noPgv = mk();
  assert.equal(Physics.injectDirectivityPulse(noPgv, { prob: 0.99, mw: 7, pgvCms: 0 }).pulse, undefined);
});

test('directivity pulse + full-model integration: predictStationMotion carries both factors', () => {
  const ctx = {
    source: { lat: 35.0, lng: 140.0, mw: 7.5, depthKm: 10, strikeDeg: 0, rakeDeg: 180, sourceType: 'crustal' },
    geometry: { lat: 35.0, lng: 140.0, L: 120, W: 25, depth: 10, strikeDeg: 0, dipDeg: 90, hypocenterFrac: 0.5 },
    gmpModel: 'zhao2006',
    options: { directivity: 'somerville1997', siteModel: 'none' }
  };
  // site 15 km along strike, 5 km off-axis: forward-directivity geometry
  const r = Physics.predictStationMotion(ctx, { lat: 35.12, lng: 140.05 }, {});
  assert.equal(r.directivityFactor, 1);   // PGA row zero by calibration
  assert.ok(r.pgvDirectivityFactor > 0.9 && r.pgvDirectivityFactor < 1.3);
  // Shahi-Baker probability at the same site is high (near, long s)
  const geo = Physics.baylessSomervilleGeometry(ctx.source, ctx.geometry, 35.12, 140.05);
  const pp = Physics.pulseProbability({ rKm: geo.rrupKm, sKm: geo.sKm });
  assert.ok(pp > 0.5, 'forward-directivity site should pulse, P=' + pp.toFixed(3));
});
