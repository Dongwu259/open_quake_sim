'use strict';
// v5.6 R1-5: cross-period epsilon correlation (Jayaram et al. 2011 Japan
// tables, frozen by tools/parse-jayaram2011-tables.js) and the conditional
// spectrum. Glyph anchors below were hand-checked against the archived
// paper text (.cache/papers/jayaram2011.txt — local-only, never a test dep).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const DOC = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'public', 'geojson', 'jayaram2011-rho.json'), 'utf8'));

test('jayaram2011-rho.json: schema, completeness, matrix validity', () => {
  assert.equal(DOC.schema, 'quake-sim-jayaram2011-rho-v1');
  assert.ok(DOC.meta.source.indexOf('Earthquakes and Structures, 2(4), 357-376') >= 0, 'citation required');
  assert.deepEqual(DOC.periods.slice(0, 4), [0.05, 0.08, 0.10, 0.15]);
  assert.equal(DOC.periods.length, 16);
  for (const cls of ['crustal', 'interface']) {
    const m = DOC.classes[cls].rho;
    assert.equal(m.length, 16);
    let sumDiag = 0;
    for (let i = 0; i < 16; i++) {
      sumDiag += m[i][i];
      for (let j = 0; j < 16; j++) {
        assert.ok(Math.abs(m[i][j]) <= 1, cls + ' |rho|>1 at ' + i + ',' + j);
        assert.ok(Math.abs(m[i][j] - m[j][i]) < 1e-9, cls + ' asymmetric at ' + i + ',' + j);
      }
    }
    assert.ok(Math.abs(sumDiag - 16) < 1e-9, cls + ' diagonal must be all 1.00');
  }
  // glyph anchors (hand-checked from the paper tables)
  const c = DOC.classes.crustal.rho, i = DOC.classes.interface.rho;
  assert.equal(c[0][1], 0.96);   // rho(0.05, 0.08)
  assert.equal(c[0][15], 0.02);  // rho(0.05, 5.0)
  assert.equal(c[11][13], 0.81); // rho(2.0, 3.0)
  assert.equal(i[0][15], 0.03);
  assert.equal(i[11][13], 0.88);
});

test('rhoPeriodPair: node-exact values, interpolation, clamping, routing', () => {
  assert.ok(Physics.setJayaram2011Rho(DOC));
  try {
    // exact table node
    assert.ok(Math.abs(Physics.rhoPeriodPair(0.05, 0.08, 'crustal') - 0.96) < 1e-9);
    assert.equal(Physics.rhoPeriodPair(1, 1, 'crustal'), 1);
    // between-node interpolation stays inside the bracketing node values
    const r = Physics.rhoPeriodPair(0.06, 5, 'crustal');
    const lo = DOC.classes.crustal.rho[0][15], hi = DOC.classes.crustal.rho[1][15];
    assert.ok(r >= Math.min(lo, hi) - 1e-9 && r <= Math.max(lo, hi) + 1e-9,
      'interp ' + r + ' outside [' + lo + ',' + hi + ']');
    // clamping beyond the table range keeps the edge value
    assert.ok(Math.abs(Physics.rhoPeriodPair(0.01, 0.05, 'crustal') - 1) < 1e-9);
    // slab routes to the interface table (Table 5 not yet transcribed)
    assert.equal(Physics.rhoPeriodPair(0.05, 5, 'slab'), Physics.rhoPeriodPair(0.05, 5, 'interface'));
    // negative correlation cells survive interpolation bounds
    assert.ok(Physics.rhoPeriodPair(0.05, 3.5, 'crustal') < 0.1);
  } finally { Physics.setJayaram2011Rho(null); }
  // null registry: Eq.(6) orthogonal-component fallback (0.96 below 0.1 s)
  assert.ok(Math.abs(Physics.rhoPeriodPair(0.05, 0.08) - 0.96) < 1e-9);
});

test('conditionalSpectrum: anchor collapse, far-period spread, math', () => {
  Physics.setJayaram2011Rho(DOC);
  try {
    const Ts = [0.05, 0.2, 0.5, 1, 2, 5];
    const mu = Ts.map(() => Math.log(100));
    const sig = Ts.map(() => 0.7);
    const cs = Physics.conditionalSpectrum(Ts, mu, sig, 0.05, 1.5, 'crustal');
    assert.ok(cs, 'result produced');
    // anchor period (exact node): mean absorbs the full epsilon, sigma -> 0
    assert.ok(Math.abs(cs.meanLnSa[0] - (Math.log(100) + 1.5 * 0.7)) < 1e-9);
    assert.ok(cs.sigmaLnSa[0] < 1e-6);
    // far periods stay closer to the marginal: sigma < 0.7 (rho>0 strictly
    // in the tables) and the mean shift follows the table's rho sign
    // (short-vs-long crustal pairs carry small negative cells)
    for (let k = 1; k < Ts.length; k++) {
      assert.ok(cs.sigmaLnSa[k] > 0 && cs.sigmaLnSa[k] < 0.7, 'conditional sigma must shrink');
      const shift = cs.meanLnSa[k] - mu[k];
      const rho = Physics.rhoPeriodPair(Ts[k], 0.05, 'crustal');
      assert.ok(Math.abs(Math.abs(shift) - Math.abs(rho) * 0.7 * 1.5) < 1e-9, 'shift = rho·sigma·eps');
      assert.ok(shift * rho >= 0, 'shift sign follows rho');
    }
    // epsStar = 0 keeps the median with a narrowed band
    const cs0 = Physics.conditionalSpectrum(Ts, mu, sig, 0.05, 0, 'crustal');
    for (let k = 0; k < Ts.length; k++) assert.ok(Math.abs(cs0.meanLnSa[k] - mu[k]) < 1e-12);
    assert.equal(Physics.conditionalSpectrum(Ts, mu, sig, -1, 0), null, 'bad anchor rejected');
    assert.equal(Physics.conditionalSpectrum([1], [0], [0.5], 1, 0).sigmaLnSa[0], 0);
  } finally { Physics.setJayaram2011Rho(null); }
});
