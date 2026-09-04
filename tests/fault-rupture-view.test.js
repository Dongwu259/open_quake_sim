// ================================================================
//  Unit tests for the v6.2 fault-rupture physics upgrades + info-card
//  pure helpers:
//    - von Kármán slip heterogeneity (Mai & Beroza 2002 spectrum,
//      anisotropic correlation, Hurst 0.75) — determinism + analytic
//      field lock against an independent re-implementation
//    - shallow slip deficit knob (moment-conserving)
//    - Physics.faultRuptureStats (synthetic + imported patches)
//    - Physics.momentRateSeries (moment-fraction + slip-area proxy)
//  Run with:  node --test tests/fault-rupture-view.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');
const FM = require('../public/observed-fault-models.js');

// ----------------------------------------------------------------
//  Independent re-implementation of the von Kármán weight field
//  (same frozen constants + LCG seed derivation as genSubSources)
// ----------------------------------------------------------------
function reimplementRawWeights(la, ln, m, strikeDeg, dipDeg, opts) {
  const geo = Physics.buildFaultGeometry(la, ln, m, strikeDeg, dipDeg, 12, opts);
  const { nStrike, nDip } = geo;
  const aspPosS = 0.55, aspPosD = 0.6, aspSigIF = 0.35, aspSigJF = 0.4;
  const aspI = Math.floor(nStrike * aspPosS), aspJ = Math.floor(nDip * aspPosD);
  const aspSigmaI = nStrike * aspSigIF, aspSigmaJ = nDip * aspSigJF;
  const perturbation = opts.slipPerturbation != null ? Number(opts.slipPerturbation) : 0.4;
  let perturbSeed = (Math.floor((Math.abs(la) * 1000 + Math.abs(ln) * 100 + m * 1000 + strikeDeg * 7 + dipDeg * 11)) ^ ((Number(opts.randomSeed) || 0) >>> 0)) >>> 0;
  const rand = () => { perturbSeed = (1664525 * perturbSeed + 1013904223) >>> 0; return perturbSeed / 4294967296; };
  const VK_HURST = 0.75, VK_AX = 0.50, VK_AY = 0.22;
  const modes = []; let norm = 0;
  for (let kx = 0; kx <= 6; kx++) {
    for (let ky = 0; ky <= 6; ky++) {
      if (kx === 0 && ky === 0) continue;
      const den = 1 + (kx / VK_AX) ** 2 + (ky / VK_AY) ** 2;
      const amp = Math.pow(den, -(VK_HURST + 1) / 2);
      modes.push({ kx, ky, phase: 2 * Math.PI * rand(), amp });
      norm += amp;
    }
  }
  const perturb = (x, y) => modes.reduce((v, mo) => v + mo.amp * Math.cos(2 * Math.PI * (mo.kx * x + mo.ky * y) + mo.phase), 0) / norm;
  const taper = (i, j) => Math.pow(Math.max(0.001, Math.sin(Math.PI * (i + 0.5) / nStrike) * Math.sin(Math.PI * (j + 0.5) / nDip)), 0.55);
  const raw = [];
  for (let i = 0; i < nStrike; i++) {
    for (let j = 0; j < nDip; j++) {
      const di = (i - aspI) / aspSigmaI, dj = (j - aspJ) / aspSigmaJ;
      let w = 0.5 + 1.3 * Math.exp(-(di * di + dj * dj) / 2);
      w *= taper(i, j) * Math.exp(perturbation * perturb((i + 0.5) / nStrike, (j + 0.5) / nDip));
      raw.push(w);
    }
  }
  return { raw, nStrike, nDip };
}

// ================================================================
//  VON KÁRMÁN FIELD
// ================================================================
test('von Kármán slip field: determinism — identical inputs give identical weights', () => {
  const a = Physics.genSubSources(38.1, 142.8, 8.4, 190, 18, 24, 2.8, { sourceType: 'interplate', randomSeed: 7 });
  const b = Physics.genSubSources(38.1, 142.8, 8.4, 190, 18, 24, 2.8, { sourceType: 'interplate', randomSeed: 7 });
  assert.deepStrictEqual(a.subs.map(s => s.slipWeight), b.subs.map(s => s.slipWeight));
});

test('von Kármán slip field: locked against an independent re-implementation (mode set + order + seed)', () => {
  const OPTS = { sourceType: 'interplate', randomSeed: 12345, slipPerturbation: 0.4 };
  const ff = Physics.genSubSources(38.1, 142.8, 8.4, 190, 18, 24, 2.8, OPTS);
  const { raw } = reimplementRawWeights(38.1, 142.8, 8.4, 190, 18, OPTS);
  const wSum = raw.reduce((a, b) => a + b, 0);
  const n = ff.subs.length;
  assert.strictEqual(raw.length, n, 'same patch count');
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 40))) {
    const expected = raw[i] / wSum * n; // slipWeight = momentFraction × totalSubs
    assert.ok(Math.abs(ff.subs[i].slipWeight - expected) < 1e-9,
      'patch ' + i + ': ' + ff.subs[i].slipWeight + ' vs ' + expected);
  }
  // moment conservation through the new field
  const momSum = ff.subs.reduce((a, s) => a + s.moment, 0);
  assert.ok(Math.abs(momSum - ff.totalMoment) / ff.totalMoment < 1e-12);
});

test('von Kármán field heterogeneity: sensible spread, no salt-and-pepper (neighbour correlation high)', () => {
  const ff = Physics.genSubSources(38.1, 142.8, 8.4, 190, 18, 24, 2.8, { sourceType: 'interplate', randomSeed: 3 });
  const w = ff.subs.map(s => s.slipWeight);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, v) => a + (v - mean) ** 2, 0) / w.length);
  assert.ok(sd / mean > 0.15 && sd / mean < 1.2, 'coefficient of variation: ' + sd / mean);
  // adjacent along-strike patches should be strongly correlated (smooth field)
  const nDip = ff.nDip;
  let pairs = 0, close = 0;
  for (let i = 0; i + 1 < ff.nStrike; i++) {
    for (let j = 0; j < nDip; j++) {
      pairs++;
      const a = ff.subs[i * nDip + j].slipWeight, b = ff.subs[(i + 1) * nDip + j].slipWeight;
      if (Math.abs(a - b) < 0.35 * Math.max(a, b)) close++;
    }
  }
  assert.ok(close / pairs > 0.8, 'neighbour agreement: ' + (close / pairs));
});

// ================================================================
//  SHALLOW SLIP DEFICIT
// ================================================================
test('shallowSlipDeficit: top-row slip reduced, deep rows untouched, moment conserved', () => {
  const base = Physics.genSubSources(38.1, 142.8, 8.8, 190, 14, 24, 2.8, { sourceType: 'interplate', randomSeed: 9 });
  const ssd = Physics.genSubSources(38.1, 142.8, 8.8, 190, 14, 24, 2.8, { sourceType: 'interplate', randomSeed: 9, shallowSlipDeficit: 0.6 });
  const rowMean = (ff, j) => {
    const rows = ff.subs.filter(s => s.dipIndex === j);
    return rows.reduce((a, s) => a + s.slipWeight, 0) / rows.length;
  };
  const top0 = rowMean(base, 0), top1 = rowMean(ssd, 0);
  assert.ok(top1 < top0 * 0.65, 'top row reduced: ' + top0 + ' -> ' + top1);
  // moment conservation renormalises the surviving rows UP (the deficit's
  // moment redistributes) — the deepest row may rise, but only by the
  // renormalisation factor, i.e. bounded and far below the top-row cut
  const lastJ = ssd.nDip - 1;
  const deepA = rowMean(base, lastJ), deepB = rowMean(ssd, lastJ);
  assert.ok(deepB > deepA && deepB / deepA < 1.3, 'deepest row renormalised up modestly: ' + deepA + ' -> ' + deepB);
  assert.ok(top1 / top0 < deepB / deepA, 'deficit concentrates at the top, not the bottom');
  const momA = base.subs.reduce((a, s) => a + s.moment, 0);
  const momB = ssd.subs.reduce((a, s) => a + s.moment, 0);
  assert.ok(Math.abs(momA - momB) / momA < 1e-12, 'moment conserved');
});

// ================================================================
//  FAULT RUPTURE STATS
// ================================================================
test('faultRuptureStats: synthetic geometry — statistics and exact moment check', () => {
  const ff = Physics.genSubSources(38.1, 142.8, 9.0, 193, 12, 24, 2.8, { sourceType: 'interplate' });
  const st = Physics.faultRuptureStats(ff.subs, ff);
  assert.strictEqual(st.patches, ff.subs.length);
  assert.ok(Math.abs(st.maxSlipM - ff.maxSlipM) < 1e-9);
  const slips = ff.subs.map(s => s.slipM);
  const mean = slips.reduce((a, b) => a + b, 0) / slips.length;
  assert.ok(Math.abs(st.meanSlipM - mean) < 1e-9);
  assert.ok(st.asperityAreaFraction > 0 && st.asperityAreaFraction < 0.6, 'asperity share: ' + st.asperityAreaFraction);
  assert.ok(st.momentRelErr != null && st.momentRelErr < 1e-12, 'moment rel err ' + st.momentRelErr);
  assert.ok(st.ruptureDurationS > 10 && st.ruptureDurationS < 200);
  assert.ok(st.ruptureVelKmS, 'velocity stats present');
  assert.ok(st.ruptureVelKmS.min <= st.ruptureVelKmS.mean && st.ruptureVelKmS.mean <= st.ruptureVelKmS.max);
  assert.ok(st.maxSlipAt && st.maxSlipAt.alongStrikeKm !== null);
});

test('faultRuptureStats: imported observed patches (ruptureTimeS/riseTimeS naming)', () => {
  const model = FM.get('nankaiM9');
  const st = Physics.faultRuptureStats(model.patches, null);
  assert.ok(st, 'stats computable from imported patches');
  assert.strictEqual(st.patches, model.patches.length);
  assert.ok(st.maxSlipM > 30, 'Nankai M9 peak slip >30 m: ' + st.maxSlipM);
  assert.ok(st.ruptureDurationS > 60, 'multi-segment rupture duration: ' + st.ruptureDurationS);
  assert.ok(st.momentRelErr == null, 'no synthetic totalMoment to check against — honest null');
});

// ================================================================
//  MOMENT RATE SERIES
// ================================================================
test('momentRateSeries: synthetic — cumulative reaches 1, monotone, peak inside the window', () => {
  const ff = Physics.genSubSources(38.1, 142.8, 9.0, 193, 12, 24, 2.8, { sourceType: 'interplate' });
  const mr = Physics.momentRateSeries(ff.subs, null, 0.5);
  assert.strictEqual(mr.weightUnits, 'moment-fraction');
  assert.ok(Math.abs(mr.finalCum - 1) < 1e-9, 'final cum: ' + mr.finalCum);
  for (let i = 1; i < mr.cum.length; i++) assert.ok(mr.cum[i] >= mr.cum[i - 1] - 1e-12, 'monotone');
  assert.ok(mr.peakRate > 0 && mr.peakRateAt > 0 && mr.peakRateAt < mr.endTime);
  assert.ok(mr.rate.every(v => v >= 0));
});

test('momentRateSeries: imported patches — slip-area proxy units, still normalised', () => {
  const model = FM.get('kumamoto2016');
  const mr = Physics.momentRateSeries(model.patches, null, 0.5);
  assert.ok(mr, 'series computable');
  assert.strictEqual(mr.weightUnits, 'slip-area-proxy');
  assert.ok(Math.abs(mr.finalCum - 1) < 1e-9);
  assert.ok(mr.peakRate > 0);
});

test('momentRateSeries: rejects empty input honestly', () => {
  assert.strictEqual(Physics.momentRateSeries([], null, 0.5), null);
  assert.strictEqual(Physics.momentRateSeries(null, null, 0.5), null);
});
