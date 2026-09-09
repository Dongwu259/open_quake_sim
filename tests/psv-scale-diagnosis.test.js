// psv-scale-diagnosis.test.js — tripwire for the frozen P-SV source-
// calibration report (tools/data/psv-scale-diagnosis.json, schema
// quake-sim-psv-scale-diagnosis-v5). History: v1 froze the 21.3x hot-factor
// blocker; v2 froze the full-space source anchor (A1-A3, residual <= 0.08);
// v3 replaced residues with gamma-resolved windows and found the Bessel
// aliasing root cause; v4 closed the root-tracking gap (matrix-exponential
// propagator, joint-scalar chain, 2D Newton) but misattributed the
// remaining tokyo series drift to an integrable branch-tail cusp;
// v5 (branch-cusp batch) measured the real mechanisms and corrected the
// record: bounded layered compliance, qP <- qShear default (undamped-P
// leaky poles = principal value), compliance-ridge detector, window-ring
// continuity fix. v6 (Rc-inversion batch, 2026-09-09) found the registered
// scale-invariant Rc inversion inapplicable (det(Rc) is small by physics —
// an on-axis leaky pole — not by scaling; entries are O(1)) and the REAL
// defect: the v4 matrix-exponential propagator built A from real moduli
// and SILENTLY DROPPED EVERY LAYER'S Q (damping entered only via the
// halvespace admittance; R8/R9 blind — no propagator loop; R2 blind —
// undamped cross-check). Fix: complex moduli, nuOf-exact c*^2 = c^2(1-i/q).
// v7 (delta-matrix batch, 2026-09-09) replaced the joint-scalar chain with
// the MGS-orthonormalised delta-matrix factorisation S = Q*T and fixed two
// real bugs the batch cross-checks exposed: the first-cut triMul triangular
// product bounded its sum at l <= i (the DIAGONAL's index), dropping every
// j > i cross term — the R2 RK4 anchor failed 3.3e-2 and caught it BEFORE
// any freeze (the interim "fullTensor converges at 0.0077" measurement was
// this bug suppressing the dipole channels, retracted); and the v6
// propagator back-transform used the real muR where the complex mu* is
// required (undamped paths bit-identical). Deviatoric series converge at
// the production cap (below-floor spread 1.3%) at the v6 raw-chain scale.
// Remaining OPEN: fullTensor leaky-P crest resolution — the subdivide
// exponent cap bounds the per-sublayer dynamic range the MGS inner
// products can separate (cap30 vs cap10 series differ ~30x; 3 isolated
// band nulls at 0.555/0.585/0.620/km), registered: compliance-chain cap
// study or per-layer Schur-admittance stepping.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'psv-scale-diagnosis.json');
const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('psv-scale-diagnosis — schema, verdict, config frozen', () => {
  assert.equal(r.schema, 'quake-sim-psv-scale-diagnosis-v7');
  assert.equal(r.verdict, 'fullspace_anchored_layered_mgs_chain_dev_converged_full_tensor_cap_open');
  assert.equal(r.config.fHz, 0.5);
  assert.equal(r.config.mw, 7.7);
  assert.equal(r.config.sourceDepthKm, 73);
  assert.equal(r.config.anchorParams.psv.dkInvKm, 0.0025);
  assert.ok(String(r.config.psvParams.qP).includes('defaults'), 'the qP default must be recorded');
  assert.ok(r.context.includes('dropped layer Q') || r.context.includes('layer-Q loss'), 'the attenuation-regression correction must be recorded');
  assert.ok(r.context.includes('triMul'), 'the triMul cross-term fix must be recorded');
  assert.ok(r.context.includes('retracted'), 'the retracted interim fullTensor convergence must be recorded');
  assert.equal(typeof r.generatedAt, 'string');
  assert.ok(r.context.includes('v1') && r.context.includes('aliasing'), 'context must record the blocker history');
  assert.ok(r.context.includes('bounded'), 'the bounded-compliance correction must be recorded');
  assert.ok(r.history.v1measured.dipoleRatioHotFactor === 21.3, 'v1 history must be preserved');
  assert.ok(r.history.v3verdict === 'fullspace_anchored_layered_rootprecision_open', 'v3 verdict must be preserved');
  assert.ok(r.history.v4verdict === 'fullspace_anchored_layered_roots_tracked_branch_cusp_open', 'v4 verdict must be preserved');
  assert.ok(r.history.v5verdict === 'fullspace_anchored_layered_qp_defaulted_dev_converged_fullext_open', 'v5 verdict must be preserved');
  assert.ok(r.history.v6verdict === 'fullspace_anchored_layered_attenuation_restored_dev_converged_degenerate_band_open', 'v6 verdict must be preserved');
  assert.ok(r.history.v4bruteExhibits && r.history.note.includes('cannot converge'), 'the retired v4 brute exhibits must stay on record with the correction note');
});

test('psv-scale-diagnosis — full-space anchor residuals locked (<= 0.08)', () => {
  assert.ok(r.fullSpaceAnchor.maxResidual <= 0.08,
    'full-space anchor residual drifted: ' + r.fullSpaceAnchor.maxResidual);
  for (const name of ['Mzz', 'Mxz', 'Myz', 'deviatoric', 'thrust-DC']) {
    assert.ok(r.fullSpaceAnchor.perCase[name], 'anchor case missing: ' + name);
  }
});

test('psv-scale-diagnosis — aliasing-guard clamp locked above the floor', () => {
  // requested dk 0.02/0.01/0.005 all ride the (2*pi/r)/10 floor on the
  // 198.5 km production path: identical results by construction.
  for (const label of ['deviatoric', 'fullTensor']) {
    const s = r.layeredContext.machinerySeriesUrm[label];
    assert.equal(s['dk0.02'], s['dk0.01'], label + ' clamp lock broken (0.02 vs 0.01)');
    assert.equal(s['dk0.01'], s['dk0.005'], label + ' clamp lock broken (0.01 vs 0.005)');
    assert.ok(s['dk0.02'] > 0, label + ' clamped value must be positive');
  }
});

test('psv-scale-diagnosis — deviatoric series CONVERGED below the alias floor', () => {
  // the v5 gate: with qP defaulted off the real axis, the deviatoric
  // channel converges — the v4 series spread of ~1.05 (and the v4-era
  // chaos) must not come back.
  const sd = r.layeredContext.machinerySeriesUrm.deviatoric;
  const a = sd['dk0.002'], b = sd['dk0.001'], c = sd['dk0.0005'];
  assert.ok(a > 0 && b > 0 && c > 0, 'below-floor series values must be present and positive');
  const spread = Math.max(a, b, c) / Math.min(a, b, c);
  assert.ok(spread < 1.1, 'deviatoric below-floor series regressed (spread ' + spread.toFixed(3) + ') — re-freeze');
});

test('psv-scale-diagnosis — root tables recorded from the compliance-ridge detector', () => {
  // the v5 detector entries are all refined (position + width measured on
  // the bounded ridge); the v4 det-scanner gates (no poles near 1.68,
  // k > kBetaHalf) encoded the dead mechanism and are retired — leaky
  // resonances below the halvespace shear wavenumber are real integrand
  // structure and legitimately appear.
  for (const key of ['f0p5', 'f1p2']) {
    const table = r.layeredContext.rootTables[key];
    assert.ok(Array.isArray(table) && table.length >= 1, key + ' root table missing');
    for (const p of table) {
      assert.equal(p.refined, true, key + ' unrefined pole: ' + JSON.stringify(p));
      assert.ok(p.kInvKm > 0.02 && p.kInvKm <= 5, key + ' pole out of band: ' + p.kInvKm);
      assert.ok(parseFloat(p.gammaKm) > 0, key + ' non-positive gamma');
    }
  }
});

test('psv-scale-diagnosis — fullTensor open item locked (crest cap-resolution recorded)', () => {
  // the honest record of the remaining open item: the dipole channels ride
  // the leaky-P crest band and the subdivide exponent cap bounds the
  // dynamic range the MGS inner products can separate — the series is
  // cap-dependent (cap30 vs cap10 ~30x) and non-converged at the production
  // cap. The v6 "degenerate band" framing is retired (the det-null collapse
  // is gone; 3 isolated nulls remain); when a cap study or Schur-admittance
  // stepping resolves the crest and the series converges, this fails
  // CONSCIOUSLY and the verdict upgrades.
  const s = r.layeredContext.machinerySeriesUrm.fullTensor;
  const a = s['dk0.002'], b = s['dk0.0005'];
  assert.ok(a > 0 && b > 0, 'below-floor series values must be present and positive');
  const spread = Math.max(a, b) / Math.min(a, b);
  // 8.1 at the v7 freeze (the corrected chain exposes the true crest
  // sensitivity the corrupted-triMul interim run suppressed): still fully
  // non-converged — the lock holds at 1.03 until the crest resolution lands.
  assert.ok(spread > 1.03, 'fullTensor below-floor series unexpectedly converged (spread ' + spread.toFixed(3) + ') — upgrade the verdict and re-freeze');
  assert.ok(r.layeredContext.openItem.includes('cap'), 'openItem must name the cap dependence');
  assert.ok(r.layeredContext.openItem.includes('Schur') || r.layeredContext.openItem.includes('cap study'), 'openItem must name a registered cure');
  // the cap-dependence measurement itself is part of the freeze
  const c10 = r.layeredContext.cap10SeriesUrm.fullTensor;
  assert.ok(c10['dk0.02'] > 0 && c10['dk0.001'] > 0, 'cap10 series record missing');
  assert.ok(c10['dk0.001'] > s['dk0.001'], 'cap10 record must sit above the production-cap value (the under-resolution direction)');
});
