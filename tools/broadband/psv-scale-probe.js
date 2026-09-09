#!/usr/bin/env node
'use strict';
// =====================================================================
//  psv-scale-probe.js — P-SV source-calibration report (v6.2 plan-A
//  closure -> source-anchor batch -> layered-poles batch -> layered-roots
//  batch -> branch-cusp batch, 2026-09-06). Deterministic; freezes to
//  tools/data/psv-scale-diagnosis.json.
//
//  SCHEMA v6 (Rc-inversion batch, 2026-09-09): the registered scale-invariant
//  Rc inversion turned out to be the wrong cure — measured, det(Rc) is small
//  by PHYSICS (an on-axis leaky pole), not by scaling; entries are O(1).
//  Digging exposed a much bigger defect: the 2026-09-06 matrix-exponential
//  propagator rewrite built A from REAL moduli and SILENTLY DROPPED EVERY
//  LAYER'S Q (damping then entered only through the halvespace admittance;
//  R8/R9 were blind — their stacks never run the propagator loop — and R2
//  was blind because it cross-checks the same system undamped). The fix
//  complexifies the moduli with nuOf's exact convention c*^2 = c^2(1-i/q):
//  the deviatoric tokyo series converges at the CORRECT physical scale (3x
//  smaller than the lossless wrong value), the det landscape loses its
//  e^-288 chain floor (now e^-24..e^-38), and the pole detector switched to
//  the source-independent surface-source det(Rc) dip scan (the buried-source
//  |C| ridge sank under the e^{-kz} background once attenuation was
//  restored). Remaining OPEN: the Rc basis-degeneracy band (tokyo 0.5 Hz,
//  k ~= 0.53-0.56/km, above-vs_half leaky P): det(Rc) = exact 0 over the
//  band (the two residual basis columns become float-exactly parallel), so
//  the compliance is unrepresentable in this formulation — the registered
//  cure is a delta-matrix (orthonormalization) stabilized solve; the naive
//  admittance-recursion prototype is stable on the up-leg and NaN on the
//  down-leg (kept in git history, 2026-09-09).
//
//  SCHEMA v5 (branch-cusp batch): the v4 verdict blamed the tokyo dk
//  series on an "integrable 1/sqrt branch-tail cusp". That mechanism is
//  RETIRED — measured, not assumed:
//   1. the LAYERED surface compliance is Rc^-1 Rw and BOTH residual
//      matrices carry the same 1/nu admittance factors: they cancel.
//      |g| plateaus toward every branch point (R8 halfspace: ~7e2 toward
//      the P branch, ~3.5e1 toward the S branch — no divergence), and
//      with the matrix-exponential propagator the INTERIOR layer branch
//      points are not singular points of the chain at all (the layer ODE
//      matrix A contains no nu; only the halvespace admittance does);
//   2. the only true 1/sqrt cusps live on the FULL-SPACE path (the Weyl
//      factors carry explicit 1/nu_c). That path now subtracts the
//      analytic singular factor A/sqrt(k* - k) per branch point (A fitted
//      just below Re k*, median over 4 offsets) and re-adds the model's
//      exact integral 2A(sqrt(k*) - sqrt(k* - kMax)); the independent
//      references (R8 midpoint brute, A3 momentBlockReference) integrate
//      the raw integrand through the sharp branch zones by the
//      xi = sqrt(|k - k_bp|) substitution — no shared fit code;
//   3. the REAL tokyo series killer was the P-wave damping default: with
//      qP unset (undamped P) the interior layers' LEAKY P resonances sit
//      ON the real axis — the 0.50-0.55/km band alternates exact
//      compliance nulls (det(Rc) through zero) with 1e8 spikes — a
//      PRINCIPAL-VALUE integral no quadrature can converge. The layered
//      path now defaults qP <- qShear (both entry points);
//   4. the det-dip pole scanner was replaced wholesale: on the tokyo
//      13-layer column the renormalised determinant sits at e^-288 (dip
//      depths comparable to chain noise, the 400-point scan steps over
//      the fundamental, Newton fails for every candidate — the v4 table
//      was 4/4 noise dips with ~1e-13 integrand support). The new
//      detector scans the BOUNDED surface-compliance ridge (log max|C_ij|,
//      2.5e-4/km step, linear-background prominence >= 0.75, halvespace-
//      only branch exclusion, golden refine, HWHM width walk);
//   5. window construction: the stepB ring started at 2*gamma leaving
//      (gamma/2, 2*gamma) unsampled (coarse lattices hid it; basin-trapped
//      modes with HWHM ~1.5e-3/km lost exactly their peak shoulders) —
//      now continuous from gamma/2.
//  With those, the DEVIATORIC tokyo dk series is CONVERGED (below-floor
//  spread ~1%). The FULL-TENSOR channel stays OPEN: its dipole channels
//  (depth-FD dC terms) ride the leaky-P crest band [0.45, 0.6]/km where
//  crest values reach 1e9 over ~1e-3/km widths and the det(Rc)
//  underflow nulls pepper the crest — registered: scale-invariant Rc
//  inversion (or pole-aware crest evaluation). Production use of
//  opts.psv stays BLOCKED behind that, not behind damping tuning: qP100
//  and qP200 series were measured and stay non-converged too.
// =====================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const hybrid = require('./hybrid.js');
const core = require('./core.js');
const psv = require('./psv.js');
const psvFs = require('./psv-fullspace.js');

const OUT = path.join(ROOT, 'tools', 'data', 'psv-scale-diagnosis.json');

function main() {
  const write = process.argv.includes('--write');
  Physics.setJivsmColumns(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'), 'utf8')));
  const col = Physics.jivsmColumnAt(35.6812, 139.7671);
  const stack = hybrid.buildJivsmIaspStack(col);

  // ---- layered production-config diagnostic (context column) ------------
  const fHz = 0.5, omega = 2 * Math.PI * fHz, mW = 7.7, zs = 73;
  const srcLat = 34.0, srcLng = 140.5, recLat = 35.6812, recLng = 139.7671;
  const rKm = Physics.haversineDist(srcLat, srcLng, recLat, recLng);
  const az = hybrid.azimuthDeg(srcLat, srcLng, recLat, recLng);
  const m0 = Physics.seismicMoment(mW);
  const M = hybrid.dcMomentTensor(185, 55, 90, m0);
  const Mr = psv.rotateFullTensor({ mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }, az);
  const mag = (c) => Math.hypot(c[0], c[1]);

  function psvU(t, dkInvKm, cap) {
    const p = psv.psvMomentSpectrumAtFrequency(stack, omega, {
      rKm, zSourceKm: zs, mxx: t.mxx, myy: t.myy, mzz: t.mzz || 0, mxy: t.mxy || 0,
      mxz: t.mxz || 0, myz: t.myz || 0, dkInvKm: dkInvKm || 0.02, kMaxInvKm: 5, qShear: 50,
      _subCap: cap
    });
    return mag(p.ur);
  }

  const deviatoric = { mxx: M.xx, myy: M.yy, mxy: M.xy };
  const full = { mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz };
  // dk series: 0.02/0.01/0.005 ride the (2*pi/r)/10 = 0.00316/km alias floor
  // on this 198.5 km path (clamp lock, by construction); 0.002/0.001/0.0005
  // are BELOW the floor — the real convergence measurement. qP is left
  // unset on purpose: the layered path defaults it to qShear = 50 (the
  // neutral choice; qP100/qP200 variants measured non-converged too, so
  // the frozen open item is not a damping-tuning matter).
  const seriesDks = [0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];
  const series = {};
  for (const [label, t] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
    series[label] = {};
    for (const dk of seriesDks) {
      series[label]['dk' + dk] = +psvU(t, dk).toExponential(4);
    }
  }
  // cap-dependence record (v7): the same series at subdivide cap 10 — the
  // subdominant-structure resolution probe (the subdivide cap bounds the
  // per-sublayer exponent the MGS inner products can separate; cap 30 loses
  // the leaky-P crest structure the dipole channels ride).
  const capSeries = {};
  for (const [label, t] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
    capSeries[label] = {};
    for (const dk of [0.02, 0.001]) capSeries[label]['dk' + dk] = +psvU(t, dk, 10).toExponential(4);
  }
  const layered = {
    machinerySeriesUrm: { deviatoric: series.deviatoric, fullTensor: series.fullTensor },
    cap10SeriesUrm: capSeries
  };

  // ---- modal root tables (compliance-ridge detector) ---------------------
  function rootTable(fHz0) {
    const om = 2 * Math.PI * fHz0;
    // qP left unset -> the detector defaults it to qShear (same as the series)
    const poles = psv.psvModalPoles(stack, om, 5, { zSourceKm: zs, qShear: 50 });
    return poles.map((p) => ({
      kInvKm: +p.k.toFixed(4), gammaKm: p.gammaKm.toExponential(3),
      refined: !!p.refined
    }));
  }
  const rootTables = { f0p5: rootTable(0.5), f1p2: rootTable(1.2) };

  // ---- full-space anchor measurement (acceptance metric) ----------------
  const cases = [
    ['Mzz', { mzz: 1e18 }],
    ['Mxz', { mxz: 1e18 }],
    ['Myz', { myz: 1e18 }],
    ['deviatoric', { mxx: 3e17, myy: -1e17, mxy: 2e17 }],
    ['thrust-DC', { mxx: 2.4e17, myy: -5.6e17, mzz: 3.2e17, mxz: 1.5e17, myz: -0.9e17, mxy: 0.4e17 }]
  ];
  const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
  const anchor = {};
  let maxResidual = 0;
  for (const [name, tensor] of cases) {
    const pp = Object.assign({ rKm: 30, zSourceKm: 15, dkInvKm: 0.0025, kMaxInvKm: 6, fullSpace: true,
      mxx: 0, myy: 0, mzz: 0, mxy: 0, mxz: 0, myz: 0, qShear: 50 }, tensor);
    const rp = Object.assign({ rM: 30000, zSourceKm: 15, dkInvKm: 0.001, kMaxInvKm: 6, alphaN: 2048, qShear: 50 }, tensor);
    const g = psv.psvMomentSpectrumAtFrequency(HALF, omega, pp);
    const r = psvFs.momentBlockReference(HALF[0], omega, rp);
    const per = {};
    const caseScale = Math.max(...['ur', 'ut', 'uz'].map((ch) => Math.hypot(r[ch][0], r[ch][1])));
    for (const ch of ['ur', 'ut', 'uz']) {
      const refAbs = Math.hypot(r[ch][0], r[ch][1]);
      if (refAbs < 1e-8 * caseScale) { per[ch] = 'structurally-zero-ok'; continue; }
      const resid = Math.hypot(g[ch][0] + r[ch][0], g[ch][1] + r[ch][1]) / refAbs;
      per[ch] = +resid.toExponential(3);
      if (resid > maxResidual) maxResidual = resid;
    }
    anchor[name] = per;
  }

  const report = {
    schema: 'quake-sim-psv-scale-diagnosis-v7',
    generatedAt: new Date().toISOString(),
    config: {
      stack: 'tokyo JIVSM column + IASP91 continuation (buildJivsmIaspStack)',
      fHz, mw: mW, sourceDepthKm: zs, rKm: +rKm.toFixed(1), azimuthDeg: +az.toFixed(1),
      psvParams: { dkInvKm: 0.02, kMaxInvKm: 5, qShear: 50, qP: 'unset -> layered path defaults to qShear (50)',
        aliasFloorInvKm: +(2 * Math.PI / (rKm * 1000) * 1000 / 10).toExponential(3) },
      anchorParams: { halfspace: 'vs 3.5 / vp 6.0 / rho 2.7', rKm: 30, zSourceKm: 15, fHz: 0.5,
        psv: { dkInvKm: 0.0025, kMaxInvKm: 6, qShear: 50, fullSpace: true },
        reference: { dkInvKm: 0.001, kMaxInvKm: 6, alphaN: 2048 } }
    },
    fullSpaceAnchor: {
      metric: 'complex residual |psv − (−reference)| / |reference| per (tensor, channel); reference = tools/broadband/psv-fullspace.js momentBlockReference (Kelvin-anchored closed form, branch-aware xi-substitution kappa scan since v5)',
      maxResidual: +maxResidual.toExponential(3),
      perCase: anchor,
      note: 'v5: the psv side subtracts the analytic 1/sqrt(k* - k) factor per branch point (true Weyl 1/nu cusps on this path) and the reference integrates the sharp branch zones by xi-substitution — both quadratures changed, so the residual is re-based (v4 froze 3.4e-2 with matched biases on both sides); the 0.08 gate is the acceptance, and the per-wavenumber integrands still agree exactly'
    },
    layeredContext: Object.assign({}, layered, {
      rootTables,
      reading: "v7 layered state (delta-matrix batch): (1) the carried chain is now the MGS-orthonormalised delta-matrix factorisation S = Q*T (per-layer modified Gram-Schmidt with two reorthogonalisation passes, R bookkeeping, joint T rescaling; sigma = the above-source log exactly as the retired joint-scalar chain) - the raw chain's joint max-scaling preserved column RATIOS but not column INDEPENDENCE, and over the deep above-source leg the A pair collapsed float-parallel in the leaky-P crest band (the v6 det(Rc) = 0 nulls); (2) TWO propagator/chain bugs were fixed on the way, both caught by cross-checks: the first-cut triMul bounded the triangular product sum at l <= i (the DIAGONAL's index) dropping every j > i cross term - the R2 RK4 anchor failed 3.3e-2 and exposed it before any freeze; and the v6 propagator back-transform used the REAL mu* where the complex mu* is required (undamped paths bit-identical, damped paths mixed the state convention by |1 - i/q| per layer); (3) the DEVIATORIC series converges at the production cap (below-floor spread 1.3%) at the same absolute scale as the v6 raw chain (2.5%); (4) the FULL-TENSOR channel REMAINS OPEN for a sharpened reason: not the det-null collapse (the band's scattered exact zeros are gone; 3 isolated nulls remain at 0.555/0.585/0.620/km) but the subdivide-cap dependence - the per-sublayer exponent cap bounds the dynamic range the MGS inner products can separate, and at the production cap 30 the leaky-P crest structure the dipole channels ride is under-resolved (cap30 vs cap10 pointwise spread up to 10x on the crest band; fullTensor cap30/cap10 series differ ~30x). The interim 'fullTensor converges at 0.0077' measurement of this batch was the triMul bug suppressing the dipole channels and is retracted.",
      reading_v6: "v6 layered state: (1) the matrix-exponential propagator lost every layer Q (real-moduli A; measured: the deviatoric response 3x too large, interior leaky poles pinned ON the real axis at any q) - fixed by complex moduli with the exact nuOf convention c*^2 = c^2(1-i/q), after which the DEVIATORIC series converges at the correct physical scale; (2) the pole detector scans the source-independent surface-source det(Rc) dip landscape (the buried-source |C| ridge sank under e^{-kz} once attenuation returned); (3) branch-point resolution rings sample the halvespace-branch kinks the coarse lattice undersampled; (4) the remaining fullTensor blocker is the Rc basis-degeneracy band: det(Rc) = exact 0 across k ~ 0.53-0.56/km (the two residual basis columns become float-exactly parallel above vs_half), so the compliance is unrepresentable there and the grid-dependent bridging shows up as the below-floor series spread. The registered scale-invariant Rc inversion was measured to be the wrong cure (entries O(1); the det is small by physics, not scaling).",
      reading_v5: 'v5 layered state: (1) the v4 "branch-tail cusp" attribution is RETIRED — the layered compliance is bounded at every branch point (Rc^-1 Rw cancels the 1/nu factors; interior branches are not singular under the expm propagator); (2) with qP defaulted to qShear the undamped-P leaky resonances leave the real axis and the DEVIATORIC series converges (below-floor spread ~1%); (3) the detector is the bounded compliance-ridge scan (the det-dip scanner sat on a e^-288 chain floor, stepped over the fundamental and refined nothing — its v4 table was noise); (4) the FULL-TENSOR channel remains open: its dipole (depth-FD) channels ride the leaky-P crest band 0.45-0.6/km, where 1e9 crests over ~1e-3/km are peppered with det(Rc) underflow nulls — the trapezoid bridges shift with the grid. qP100/qP200 series measured non-converged as well, so this is not damping tuning.',
      openItem: "fullTensor leaky-P crest band resolution (tokyo 0.5 Hz, k ~ 0.45-0.65/km): the delta-matrix chain removed the det-null collapse (isolated nulls: 3 at 0.555/0.585/0.620/km) but the series remains cap-dependent - the subdivide exponent cap (30) bounds the per-sublayer dynamic range the MGS inner products can separate, so the crest structure the dipole channels ride is under-resolved at the production cap (cap30 vs cap10 fullTensor series differ ~30x; pointwise cap10/cap4 agree to ~16% where cap30 is 10x off). Registered cures: tighten the production compliance-chain cap (cap 10 costs ~3x sublayers, series spread at cap10 still 2.5) or per-layer Schur-admittance stepping; until then the fullTensor series stays non-converged and production opts.psv stays BLOCKED",
    }),
    verdict: 'fullspace_anchored_layered_mgs_chain_dev_converged_full_tensor_cap_open',
    registeredNextStep: 'compliance-chain subdivide-cap study (cap 10/4 fullTensor series + runtime) or per-layer Schur-admittance stepping to resolve the leaky-P crest at production cost; the CS-pipeline v4 pre-registered gate run with opts.psv stays user-gated behind that',
    context: 'v7 (delta-matrix batch) landed the MGS-orthonormalised chain and fixed two real bugs the batch cross-checks exposed: the first-cut triMul triangular product dropped the j > i cross terms (caught by the R2 RK4 anchor at 3.3e-2 BEFORE any freeze; the interim "fullTensor converges at 0.0077" measurement was this bug suppressing the dipole channels and is retracted), and the v6 propagator back-transform used the real muR where the complex mu* is required (undamped paths bit-identical); deviatoric series converge at the production cap at the v6 raw-chain scale; fullTensor stays OPEN on cap-dependent crest resolution; v6 (Rc-inversion batch) found the registered scale-invariant inversion inapplicable (det small by physics) and fixed the v4 expm layer-Q loss (complex moduli, nuOf-exact convention); detector on the surface-source det(Rc) dip scan; branch-point resolution rings; v5 froze qp-default + compliance-ridge detector + window-continuity fix; v1 froze blocked_pending_source_calibration (21.3x hot factor); v2 froze fullspace_anchored_layered_poles_open (source anchor fixed 3 missing/1 wrong-column dipole terms + traction/dipole -1 + razor band-nulling); v3 replaced residues with gamma-resolved windows and found the Bessel-aliasing root cause; v4 closed the root-tracking gap (expm propagator, joint-scalar chain, 2D Newton) but misattributed the remaining series drift to an integrable branch-tail cusp; v5 (branch-cusp batch) measured the actual mechanisms: bounded layered compliance (v4 cusp retired), true cusps only on the fullSpace path (analytic subtraction landed there, references moved to xi-substitution), undamped-P leaky poles on the real axis (qP <- qShear default), a dead det scanner replaced by the compliance-ridge detector, and a window-ring continuity bug fixed',
    history: {
      v1measured: {
        tractionRatio: 0.908, dipoleRatioHotFactor: 21.3,
        psvDeviatoricUrm: 0.7454, shDeviatoricUtm: 0.821, psvFullUrm: 2304, shFullUtm: 0.821
      },
      v2verdict: 'fullspace_anchored_layered_poles_open',
      v3verdict: 'fullspace_anchored_layered_rootprecision_open',
      v4verdict: 'fullspace_anchored_layered_roots_tracked_branch_cusp_open',
      v5verdict: 'fullspace_anchored_layered_qp_defaulted_dev_converged_fullext_open',
      v5openItem: 'leaky-P crest handling (superseded by the v6 attenuation-regression fix + degenerate-band diagnosis)',
      v6verdict: 'fullspace_anchored_layered_attenuation_restored_dev_converged_degenerate_band_open',
      v6openItem: 'Rc basis-degeneracy band (registered delta-matrix cure delivered by v7; the band nulls are gone, the blocker moved to cap-dependent crest resolution)',
      v4bruteExhibits: { bruteUzStep1p58e_6: 56.53, bruteUzStep0p79e_6: 62.54 },
      note: 'v1/v2 layered numbers were produced by the global-median razor + an aliased grid + an unsound normalization heuristic; v3/v4 layered series ran with qP unset (undamped P -> principal-value leaky poles) and the v4 brute exhibits are plain sums that cannot converge on this config — kept for the record only'
    }
  };
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ anchorMaxResidual: report.fullSpaceAnchor.maxResidual, layered, rootTables }, null, 1));
  console.log('verdict:', report.verdict);
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
