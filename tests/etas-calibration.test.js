'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Calibrate = require('../tools/calibrate-etas.js');

test('fitBValue — Aki MLE on a synthetic Gutenberg-Richter sample', () => {
  // b=1.0, Mmin=4: draw magnitudes analytically from the GR distribution.
  const bTrue = 1.0, mags = [];
  let seed = 7;
  for (let i = 0; i < 20000; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const u = seed / 4294967296;
    mags.push(4 - Math.log10(1 - u) / bTrue * 0 + 4 /*placeholder*/ );
  }
  // simpler: exponential in magnitude units -> M = Mmin - ln(1-u)/(b ln10)
  seed = 7; mags.length = 0;
  for (let i = 0; i < 20000; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const u = seed / 4294967296;
    mags.push(4 - Math.log(1 - u) / (bTrue * Math.LN10));
  }
  const fit = Calibrate.fitBValue(mags, 4);
  assert.ok(Math.abs(fit.b - bTrue) < 0.02, `Aki MLE recovered b=${fit.b.toFixed(3)} vs true 1.0`);
});

test('fitOmoriUtsuAt — recovers (c, p) from a synthetic Omori-Utsu process', () => {
  // Inverse-sample t = ( (1-u) * ((T+c)^(1-p)) + u * c^(1-p) )^(1/(1-p)) - c
  const cT = 0.05, pT = 1.2, T = 90, N = 4000, times = [];
  let seed = 11;
  for (let i = 0; i < N; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const u = seed / 4294967296;
    const F = (t) => (((t + cT) ** (1 - pT)) - cT ** (1 - pT)) / ((T + cT) ** (1 - pT) - cT ** (1 - pT));
    void F;
    times.push((( (1-u) * cT**(1-pT) + u * (T+cT)**(1-pT) )) ** (1/(1-pT)) - cT);
  }
  const fit = Calibrate.fitOmoriUtsuAt(times, 0);
  assert.ok(fit, 'fit produced a result');
  assert.ok(Math.abs(fit.p - pT) < 0.08, `recovered p=${fit.p.toFixed(3)} vs true 1.2`);
  assert.ok(Math.abs(Math.log10(fit.c) - Math.log10(cT)) < 0.4, `recovered c=${fit.c.toFixed(4)} vs true 0.05`);
});

test('shipped ETAS calibration report covers the three frozen sequences', () => {
  const p = path.join(ROOT, 'tools/data/etas-calibration-report.json');
  assert.ok(fs.existsSync(p), 'tools/data/etas-calibration-report.json must be committed');
  const report = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(report.schema, 'quake-sim-etas-calibration-v1');
  assert.equal(report.sequences.length, 3);
  for (const s of report.sequences) {
    assert.ok(s.observedN90 >= 20, `${s.id}: enough events for a fit`);
    assert.ok(s.b > 0.5 && s.b < 1.6, `${s.id}: b=${s.b} in the physical range`);
    assert.ok(s.omoriP > 0.8 && s.omoriP <= 1.5, `${s.id}: p=${s.omoriP} in the JMA-literature range`);
    assert.ok(s.omoriC > 0 && s.omoriC <= 1.05, `${s.id}: c=${s.omoriC} d at the 1-day fit-window floor (structural)`);
  }
  // The productivity slope is calibrated INTO the simulator law now: the LSQ
  // fit line must track observations closely and the uncapped default law
  // must no longer under-count large-event productivity (it used to read
  // 342 vs 2266 for Tohoku).
  const tohoku = report.sequences.find(s => s.id === 'tohoku2011');
  assert.ok(Math.abs(tohoku.fittedN90 - tohoku.observedN90) / tohoku.observedN90 < 0.15,
    `fitted line tracks Tohoku productivity: ${tohoku.fittedN90} vs ${tohoku.observedN90}`);
  assert.ok(tohoku.simulatorDefaultN90 >= tohoku.observedN90,
    'uncapped default law no longer under-counts M9 productivity');
  assert.strictEqual(tohoku.simulatorDisplayedN90, 200,
    'visualized catalog stays budget-capped at the default catalogCap');
});
