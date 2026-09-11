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
// v9 (2026-09-09, R3 opening batch) re-measured the series on the
// mu*-corrected halfspace admittance (R10 fixed psvEigenvectors traction
// rows): the fullTensor below-floor series changed from erratic
// non-monotone collapse to a CLEAN MONOTONE DIVERGENCE (28.1 -> 54.6 over
// dk 0.002 -> 0.0005, spread 1.95) while deviatoric stays converged
// (spread 1.055) — the crest-band OPEN is re-confirmed on a trustworthy
// baseline; residue/Schur-admittance remains the registered cure, and a
// P-SV-side guard-divisor ladder is newly registered (the P-SV kernel
// still clamps at (2*pi/r)/10 — the SH v3 ladder moved SH to 80).
// v10 (2026-09-10, crest-noise batch) diagnosed the band at SAMPLE level:
// the legacy series reproduced the v9 freeze bit-exactly; a continuity
// discriminator proved the band spikes are CHAIN CONDITIONING NOISE
// (controls continuous to 0.1% at 1e-5/km k-offsets, crest samples swing
// 1.4-15x — 500x below the k/(2Q) resonance-width floor); the mechanism is
// the depth-FD 1/(2*dh) amplification (spikes collapse monotonically under
// dh 0.5 -> 20 m while controls are dh-invariant; |C| stays smooth while
// the integrand spikes). Two in-chain FD cures were built and RETIRED with
// measurements: gen-1 agreement search (spikes -5..120x, series
// 9.5/12.3/8.0/2.6, spread 3.7, correlated-noise fooling) and gen-2
// Richardson pair (algebraically exact cancellation of arm-independent
// rounding — spikes untouched, series 28.7/44.0/66.7): the band noise is a
// deterministic (k,z,dh)-joint wild function of the chain, not additive
// rounding. Registered cure: an INDEPENDENT representation (per-layer
// Schur-admittance stepping; the v6 prototype down-leg NaN is the named
// blocker). Production opts.psv stays BLOCKED.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'tools', 'data', 'psv-scale-diagnosis.json');
const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

test('psv-scale-diagnosis — schema, verdict, config frozen', () => {
  assert.equal(r.schema, 'quake-sim-psv-scale-diagnosis-v13');
  assert.equal(r.verdict, 'fullspace_anchored_layered_schur_validated_locator_infeasible_zero_stable_digits_series_noise_dominated');
  assert.ok(String(r.reMeasure).includes('adjudication'), 'the v11 compliance adjudication must be recorded');
  assert.ok(String(r.reMeasure).includes('pole-aware'), 'the registered pole-aware quadrature cure must be recorded');
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
  assert.ok(r.history.v7verdict === 'fullspace_anchored_layered_mgs_chain_dev_converged_full_tensor_cap_open', 'v7 verdict must be preserved');
  assert.ok(r.history.v8verdict === 'fullspace_anchored_layered_mgs_chain_cap_study_negative_full_tensor_open', 'v8 verdict must be preserved');
  assert.ok(r.history.v8caveat.includes('PRE-mu*-fix') || r.history.v8caveat.includes('real-mu'), 'the v8 pre-fix caveat must be preserved');
  assert.ok(r.history.v9verdict === 'fullspace_anchored_layered_mgs_chain_v9_rebased_full_tensor_monotone_open', 'the v9 verdict must be preserved');
  assert.ok(r.history.v10verdict === 'fullspace_anchored_layered_crest_noise_proven_fd_cures_retired_full_tensor_open', 'the v10 verdict must be preserved');
  assert.ok(r.history.v11verdict === 'fullspace_anchored_layered_compliance_adjudicated_schur_validated_band_quadrature_full_tensor_open', 'the v11 verdict must be preserved');
  assert.ok(r.history.v12verdict === 'fullspace_anchored_layered_schur_validated_pole_subtraction_shipped_but_series_open_candidates_mislocate', 'the v12 verdict must be preserved');
  assert.ok(r.history.v13verdict === 'fullspace_anchored_layered_schur_validated_locator_infeasible_zero_stable_digits_series_noise_dominated', 'the v13 verdict must be preserved');
  assert.ok(r.history.v13note.includes('CLOSED-NEGATIVE'), 'the v13 locator closure must stay on record');
  assert.ok(r.layeredContext.detSubtractSeriesUrm, 'the v12 det-subtract arm must be measured');
  assert.ok(Array.isArray(r.layeredContext.poleModelSet) && r.layeredContext.poleModelSet.length >= 1,
    'the production pole-model set (candidate-mislocation record) must be frozen');
  assert.ok(String(r.layeredContext.tensorProtocolNote).includes('UNROTATED'),
    'the tensor-protocol pitfall (rotated side-scripts vs unrotated frozen series) must stay on record');
  assert.ok(r.layeredContext.complianceAdjudication, 'the v11 adjudication block must be present');
  assert.ok(r.layeredContext.complianceAdjudication.deepRepro_halfspace_1p2Hz_zs73_q50.expmExoneration.includes('7e-13'),
    'the expm exoneration measurement must stay on record');
  assert.ok(r.layeredContext.complianceAdjudication.tokyoBand_0p5Hz_zs73.transportCollapse.includes('ill-posed'),
    'the transport-collapse confirmation must stay on record');
  assert.ok(r.layeredContext.capStudy.caveat.includes('PRE-mu*-fix'), 'the cap-study literal must carry the pre-fix caveat');
  assert.ok(r.context.includes('NEGATIVE') || r.context.includes('negative'), 'the cap-study negative outcome must be recorded');
  // the cap-study freeze: every tightened cap is internally dk-converged ...
  const cs = r.layeredContext.capStudy;
  assert.ok(cs.belowFloorSpreads.cap4.fullTensor < 1.05, 'cap4 fullTensor internal spread must stay locked');
  assert.ok(cs.belowFloorSpreads.cap2.fullTensor < 1.05, 'cap2 fullTensor internal spread must stay locked');
  // ... while cross-cap values disagree without monotone convergence (the NEGATIVE)
  assert.ok(cs.crossCapFullTensor.cap6_vs_cap4_dk0005 < 0.95 || cs.crossCapFullTensor.cap6_vs_cap4_dk0005 > 1.05,
    'cap6/cap4 disagreement is the measured negative — it must stay on record');
  assert.ok(cs.belowFloorSpreads.cap30.fullTensor > 3, 'production-cap fullTensor must stay non-converged on record');
  assert.ok(r.history.v4bruteExhibits && r.history.note.includes('cannot converge'), 'the retired v4 brute exhibits must stay on record with the correction note');
});

test('psv-scale-diagnosis — v13 chaos diagnosis frozen (1-ulp discriminator + series dh sensitivity)', () => {
  // the v13 decisive measurements: the chain has ZERO stable digits in the
  // crest band (locator infeasible) and the series values are
  // noise-integral dominated (dh realization moves them ~30x, no pinning).
  const cd = r.layeredContext.chaosDiagnosis;
  assert.ok(cd, 'chaosDiagnosis block missing');
  assert.ok(String(cd.method).includes('ulp'), 'the discriminator method must be recorded');
  // control: bit-stable through the ladder (a '-0.000%' signed-zero format
  // is the same measurement — compare numerically)
  assert.ok(cd.ulpLadderIntegrandDh0p5.k0p40.split('/').every((s) => Math.abs(parseFloat(s)) < 0.001),
    'the control band must be bit-stable through the ulp ladder (got ' + cd.ulpLadderIntegrandDh0p5.k0p40 + ')');
  // crest: O(1) swings at 1 ulp — the zero-stable-digits verdict
  for (const k of ['k0p70', 'k0p73', 'k0p76', 'k0p80']) {
    const first = parseFloat(cd.ulpLadderIntegrandDh0p5[k].split('/')[0]);
    assert.ok(Math.abs(first) > 5, 'crest ' + k + ' must stay chaotic at 1 ulp (got ' + first + '%)');
  }
  // the compliance itself is chaotic (not just the depth-FD channels)
  const cFirst = parseFloat(cd.ulpLadderComplianceZs73.k0p73.split('/')[0]);
  assert.ok(Math.abs(cFirst) > 5, 'C(zs) must stay chaotic at 1 ulp (got ' + cFirst + '%)');
  // large dh does NOT clean the field (v10 conclusion extended to fixed stencils)
  const first32 = parseFloat(cd.ulpLadderIntegrandDh32.k0p73.split('/')[0]);
  assert.ok(Math.abs(first32) > 5, 'the dh=32 field must stay chaotic at 1 ulp (got ' + first32 + '%)');
  // dh sensitivity: no pinning across realizations at dk0.02 (spread > 20x)
  const sd = r.layeredContext.seriesDhSensitivity;
  assert.ok(sd, 'seriesDhSensitivity block missing');
  const dh02 = ['dh0p5', 'dh2', 'dh16', 'dh32', 'dh64'].map((k) => sd.fullTensorUrm[k]['dk0.02']);
  const spread02 = Math.max(...dh02) / Math.min(...dh02);
  assert.ok(spread02 > 20, 'the dh realization must keep moving the series >20x (got ' + spread02.toFixed(1) + ')');
  // no dh converges across the below-floor dks (every dh spread > 1.25;
  // the frozen protocol arm sits at 1.30)
  for (const dh of ['dh0p5', 'dh2', 'dh16', 'dh32', 'dh64']) {
    const arm = sd.fullTensorUrm[dh];
    const vals = ['dk0.002', 'dk0.001', 'dk0.0005'].map((k) => arm[k]);
    const sp = Math.max(...vals) / Math.min(...vals);
    assert.ok(sp > 1.25, dh + ' series must stay non-convergent on record (spread ' + sp.toFixed(2) + ')');
  }
  // the dh32 fine extension keeps falling (16.61 -> 8.65) — the monotone
  // decline is a noise-realization coincidence, not convergence
  assert.ok(sd.dh32Dk0p00025Extension < sd.fullTensorUrm.dh32['dk0.0005'] * 0.75,
    'the dk0.00025 extension must stay on the falling side (got ' + sd.dh32Dk0p00025Extension + ')');
  // the deviatoric control also wanders at dh32 (representation-relative
  // reading extends to the dh axis)
  const dv = sd.deviatoricUrmDh32;
  const dspread = Math.max(dv['dk0.02'], dv['dk0.002'], dv['dk0.001'], dv['dk0.0005']) /
                  Math.min(dv['dk0.02'], dv['dk0.002'], dv['dk0.001'], dv['dk0.0005']);
  assert.ok(dspread > 1.3, 'deviatoric at dh32 must stay wandering (spread ' + dspread.toFixed(2) + ')');
  // detM floor: the locator scan object sinks into the subtraction-noise floor
  const dm = cd.detMFloorBucketMinima;
  assert.ok(dm.b0p47 > -10 && dm.b0p82 < -35,
    'the detM bucket minima must descend into the noise floor (got ' + dm.b0p47 + ' -> ' + dm.b0p82 + ')');
  // the weight profile: crest cluster [0.70,0.82] >= 100x the generic band,
  // and the hypothesised 1.005/km trapped mode carries nothing here
  const wp = cd.weightProfileBucketMaxima;
  assert.ok(wp.b0p7 > 100 * wp.b0p4, 'the crest cluster must stay >=100x the generic band');
  assert.ok(wp.b1p0 < wp.b0p7 * 1e-4, 'the 1.005/km mode must stay weightless on this config');
  // the frozen top fit is single-sample anchored (the demotion must stay on record)
  const fs2 = cd.fitLadderSamplesCand0p6173;
  assert.ok(fs2.length >= 10, 'the fit ladder sample dump must be present');
  assert.ok(/single-sample/i.test(String(r.layeredContext.chaosDiagnosis.reading)),
    'the single-sample-anchored fit demotion must be recorded');
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
  // chaos) must not come back. v9 re-measure on the corrected kernel:
  // spread 1.055.
  const sd = r.layeredContext.machinerySeriesUrm.deviatoric;
  const a = sd['dk0.002'], b = sd['dk0.001'], c = sd['dk0.0005'];
  assert.ok(a > 0 && b > 0 && c > 0, 'below-floor series values must be present and positive');
  const spread = Math.max(a, b, c) / Math.min(a, b, c);
  assert.ok(spread < 1.1, 'deviatoric below-floor series regressed (spread ' + spread.toFixed(3) + ') — re-freeze');
});

test('psv-scale-diagnosis — fullTensor series MONOTONE NON-CONVERGENT on the corrected kernel (v9 legacy arm)', () => {
  // the v9 re-baseline, bit-exactly reproduced by the v10 run: the erratic
  // pre-fix collapse became a clean monotone divergence — the crest-band
  // OPEN is real, not an admittance artifact.
  const s = r.layeredContext.machinerySeriesUrm.fullTensor;
  const a = s['dk0.002'], b = s['dk0.001'], c = s['dk0.0005'];
  assert.ok(a > 0 && b > a && c > b, 'fullTensor below-floor series must stay monotone increasing (' + a + ' -> ' + b + ' -> ' + c + ')');
  const spread = c / a;
  assert.ok(spread > 1.15, 'fullTensor series unexpectedly converged (spread ' + spread.toFixed(3) + ') — re-examine the OPEN verdict if real');
  assert.ok(r.registeredNextStep.includes('Schur'), 'the Schur-admittance independent representation must stay registered');
  // the P-SV guard-divisor ladder was RESOLVED in its own freeze (div10
  // passes, default kept byte-compatible — tools/data/psv-alias-ladder.json);
  // the remaining user-gate clause that must stay registered is CS v4.
  assert.ok(r.registeredNextStep.includes('opts.psv'), 'the CS-v4 user gate behind opts.psv must stay registered');
});

test('psv-scale-diagnosis — v10 crest-noise diagnosis frozen (discriminator + dh collapse + cure outcomes)', () => {
  const cd = r.layeredContext.crestDiagnostics;
  assert.ok(cd, 'crestDiagnostics block missing');
  assert.ok(cd.continuityDiscriminator.crest_0p5112.includes('CHAIN NOISE'), 'the discriminator verdict must be on record');
  assert.ok(cd.dhCollapse.crest_0p5187.includes('2.0e4'), 'the dh-collapse ladder must stay frozen');
  // gen-1 (agreement search): spikes collapsed, series non-convergent
  const g1 = cd.cureOutcomes.gen1_agreementSearch.seriesFullTensorUrm;
  assert.equal(g1.dk0p02, 9.54486, 'gen-1 clamped-grid value must stay frozen');
  assert.equal(g1.dk0p0005, 2.6201, 'gen-1 fine-grid value must stay frozen');
  assert.ok(g1.dk0p0005 / g1.dk0p001 < 1 && g1.dk0p001 / g1.dk0p02 < 2,
    'gen-1 series must stay in its measured non-monotone band');
  // gen-2 (Richardson): cancellation exact for arm-independent noise, spikes untouched
  assert.ok(cd.cureOutcomes.gen2_richardson.verdict.includes('deterministic'), 'the non-additive noise conclusion must be on record');
  // the Richardson arm series: non-convergent, and WORSE at the finest grid
  const s = r.layeredContext.dhRichardsonSeriesUrm.fullTensor;
  const a = s['dk0.002'], c = s['dk0.0005'];
  assert.ok(a > 0 && c > a, 'Richardson fullTensor series must stay non-convergent on record');
  assert.ok(c / a > 1.5, 'Richardson spread must stay locked (re-freeze if the kernel changes)');
  const sd = r.layeredContext.dhRichardsonSeriesUrm.deviatoric;
  const dspread = Math.max(sd['dk0.002'], sd['dk0.001'], sd['dk0.0005']) / Math.min(sd['dk0.002'], sd['dk0.001'], sd['dk0.0005']);
  assert.ok(dspread < 1.1, 'Richardson deviatoric control must stay converged (spread ' + dspread.toFixed(3) + ')');
});

test('psv-scale-diagnosis — v12 Schur arm re-verified: series must stay NON-converged', () => {
  const s = r.layeredContext.schurSeriesUrm;
  assert.ok(s, 'schurSeriesUrm missing — the Schur arm must stay measured');
  // fullTensor through the VALIDATED Schur compliance: RE-MEASURED live by
  // the v12 --write and equal to the v11 freeze (the interim "stale freeze"
  // suspicion was a rotated-tensor artifact of the side scripts — see
  // tensorProtocolNote). The OPEN is the band quadrature / pole locator,
  // NOT the compliance representation.
  const f = s.fullTensor;
  const a = f['dk0.002'], b = f['dk0.001'], c = f['dk0.0005'];
  assert.ok(a > 0 && b > 0 && c > 0, 'Schur fullTensor below-floor values must be present');
  const spread = Math.max(a, b, c) / Math.min(a, b, c);
  assert.ok(spread > 1.15, 'Schur fullTensor series unexpectedly converged (spread ' + spread.toFixed(3) + ') — re-examine the OPEN verdict if real');
  assert.ok(Math.abs(f['dk0.02'] - 194.41) < 0.01,
    'Schur fullTensor dk0.02 must equal the committed-code reproduction 194.41 (got ' + f['dk0.02'] + ') — re-freeze');
  // deviatoric control: the representation-relative 2x shift must stay on
  // record (0.0178 -> 0.0083): "convergence" readings are representation-
  // relative until the band quadrature lands.
  const d = s.deviatoric;
  const dshift = d['dk0.005'] / d['dk0.001'];
  assert.ok(dshift > 1.5, 'the deviatoric representation-relative shift must stay visible (got ' + dshift.toFixed(2) + ')');
});

test('psv-scale-diagnosis — v12 det-subtract arm: machinery shipped, series still open', () => {
  const s = r.layeredContext.detSubtractSeriesUrm;
  assert.ok(s, 'detSubtractSeriesUrm missing — the shipped subtraction arm must stay measured');
  // measured 231.77/231.77/231.77/532.96/770.39/803.88 — monotone RISING
  // below the alias floor (same shape as the legacy monotone divergence),
  // below-floor spread 1.51, NOT converged at dk 0.0005
  const f = s.fullTensor;
  const a = f['dk0.002'], b = f['dk0.001'], c = f['dk0.0005'];
  const spread = Math.max(a, b, c) / Math.min(a, b, c);
  assert.ok(spread > 1.15, 'det-subtract fullTensor unexpectedly converged (spread ' + spread.toFixed(3) + ') — re-examine the verdict if real');
  assert.ok(Math.abs(f['dk0.02'] - 231.77) < 0.01 || Math.abs(f['dk0.02'] - 231.8) < 0.5,
    'det-subtract fullTensor dk0.02 must equal the frozen 231.77 (got ' + f['dk0.02'] + ') — re-freeze');
  // v13 consciously updated: the v12 registered cure ("pole LOCATOR") was
  // measured INFEASIBLE by the 1-ulp discriminator — the registered cure is
  // now the compensated-arithmetic chain, and the locator closure must stay
  // on record in the context.
  assert.ok(r.registeredNextStep.includes('double-double'), 'the registered cure must name the compensated-arithmetic chain');
  assert.ok(r.context.includes('1-ULP ladder') || r.context.includes('1-ulp ladder'), 'the locator infeasibility measurement must be recorded in the context');
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

test('psv-scale-diagnosis — fullTensor open item locked (crest noise proven, FD cures retired)', () => {
  // the honest record of the remaining open item: the dipole channels ride
  // the leaky-P crest band, the band spikes are proven chain noise (v10),
  // and both in-chain FD cures are measured non-convergent. When a Schur
  // (independent-representation) cure resolves the crest and the series
  // converges, this fails CONSCIOUSLY and the verdict upgrades.
  const s = r.layeredContext.machinerySeriesUrm.fullTensor;
  const a = s['dk0.002'], b = s['dk0.0005'];
  assert.ok(a > 0 && b > 0, 'below-floor series values must be present and positive');
  const spread = Math.max(a, b) / Math.min(a, b);
  assert.ok(spread > 1.03, 'fullTensor below-floor series unexpectedly converged (spread ' + spread.toFixed(3) + ') — upgrade the verdict and re-freeze');
  assert.ok(r.layeredContext.reading.includes('NEGATIVE'), 'the cap-study negative must stay on record (reading block)');
  assert.ok(r.layeredContext.openItem.includes('Schur'), 'openItem must name the adjudicated representation');
  assert.ok(r.layeredContext.reading.includes('CHAIN CONDITIONING NOISE') ||
    r.layeredContext.crestDiagnostics.continuityDiscriminator.crest_0p5112.includes('CHAIN NOISE'),
    'openItem/record must carry the v10 noise verdict');
  // the cap-dependence measurement itself is part of the freeze
  const c10 = r.layeredContext.cap10SeriesUrm.fullTensor;
  assert.ok(c10['dk0.02'] > 0 && c10['dk0.001'] > 0, 'cap10 series record missing');
  assert.ok(c10['dk0.001'] > s['dk0.001'], 'cap10 record must sit above the production-cap value (the under-resolution direction)');
});
