#!/usr/bin/env node
'use strict';
// =====================================================================
//  psv-scale-probe.js — P-SV source-calibration report (v6.2 plan-A
//  closure -> source-anchor batch -> layered-poles batch -> layered-roots
//  batch -> branch-cusp batch, 2026-09-06). Deterministic; freezes to
//  tools/data/psv-scale-diagnosis.json.
//
//  SCHEMA v11 (compliance-adjudication batch, 2026-09-10): the deep-config
//  validation gap was CLOSED — three mutually-agreeing trusted references
//  were built for the halfspace config (RK4-ODE referee with Richardson
//  extrapolation, balanced-eigendecomposition transport, exact closed-form
//  halfspace BVP; pairwise 4e-3), expm4 was exonerated (7e-13), and the
//  LEGACY A/W chain was measured O(1) off (3.4-7.8x, cap-sensitive) while
//  Schur matches to 1e-11. psvSchurCompliance is production-wired behind
//  params.schurCompliance. The Schur dk series still does not converge
//  (fullTensor 194/194/523/680/541 non-monotone; deviatoric moves 2x — the
//  v10 "deviatoric converged" reading was representation-relative), so the
//  registered cure moves to pole-aware quadrature of the band: the blocker
//  is the unresolved near-pole structure of the k integral, not the
//  compliance representation.
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

  function psvU(t, dkInvKm, cap, dhAdaptive, schur) {
    const p = psv.psvMomentSpectrumAtFrequency(stack, omega, {
      rKm, zSourceKm: zs, mxx: t.mxx, myy: t.myy, mzz: t.mzz || 0, mxy: t.mxy || 0,
      mxz: t.mxz || 0, myz: t.myz || 0, dkInvKm: dkInvKm || 0.02, kMaxInvKm: 5, qShear: 50,
      _subCap: cap, dhAdaptive: dhAdaptive ? 1 : undefined, schurCompliance: schur ? 1 : undefined
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
  // v10 crest-cure arm: the Richardson-pair depth-FD (psv.js params.dhAdaptive,
  // off by default) on the same series — the measured attempt to cure the
  // leaky-P crest-band chain noise from inside the current chain.
  const dhSeries = {};
  for (const [label, t] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
    dhSeries[label] = {};
    for (const dk of seriesDks) {
      dhSeries[label]['dk' + dk] = +psvU(t, dk, undefined, true).toExponential(4);
    }
  }
  // v11 arm: the SAME series through the Schur admittance compliance
  // (params.schurCompliance, complianceAt dispatcher) — the representation
  // the 2026-09-10 adjudication validated against three trusted references.
  const schurSeries = {};
  for (const [label, t] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
    schurSeries[label] = {};
    for (const dk of seriesDks) {
      schurSeries[label]['dk' + dk] = +psvU(t, dk, undefined, false, true).toExponential(4);
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
    dhRichardsonSeriesUrm: { deviatoric: dhSeries.deviatoric, fullTensor: dhSeries.fullTensor },
    schurSeriesUrm: { deviatoric: schurSeries.deviatoric, fullTensor: schurSeries.fullTensor },
    complianceAdjudication: {
      // 2026-09-10 adjudication batch — all literals measured by the
      // committed probe scripts on these exact configs (see the scripts'
      // headers for the full tables)
      measured: '2026-09-10, crest-referee-deep-probe.js / crest-eig-vs-expm.js / crest-halfspace-closed.js / crest-band-adjudicate.js / crest-fd-referee.js',
      deepRepro_halfspace_1p2Hz_zs73_q50: {
        prodVsRefAcrossK: '3.4 / 4.6 / 3.6 / 2.9 / 2.4 / 4.4 / 7.8 x at k = 0.2..1.2/km (legacy A/W chain O(1) off the trusted pair everywhere)',
        prodCapSensitivity: '_subCap 15/45 move the legacy compliance 0.23-2.7 rel at the same ks',
        trustedPair: 'schur-vs-eig-transport 1.1e-11; eig-vs-RK4-referee-Richardson-extrapolation 4.2e-3; closed-form-BVP == -Schur exactly (jump-orientation sign), RK4-referee extrapolated == Schur 4.2e-3',
        expmExoneration: 'psvPropagator output == balanced-eigendecomposition exp(A_scaled h) to 7e-13 with clean semigroups — the matrix exponential is NOT the deep-config error source; the A/W + MGS residual bookkeeping is',
        fdRefereeStatus: 'box-scheme BVP referee (crest-fd-referee.js): matches the closed form to ~2% at the 0.5 Hz anchors but is under-resolved at 1.2 Hz (1 km grid vs 5 km vertical wavelengths) — OPEN, not used for the verdict'
      },
      tokyoBand_0p5Hz_zs73: {
        schurVsRk4Ref_smooth_k: '7.6e-3 at k = 0.30/km (2026-09-11 CORRECTION: the referee copy carried an UNSORTED stops regression — srcM pushed after halfTopM made the last segment integrate BACKWARD on every multi-layer config, invisible on single-layer HALF validations; fixed, the same point re-measures 5.79e-3 and the in-band referee blowups were its evanescent-leg underflow blindness, not a verdict either way',
        transportCollapse: 'the eigendecomposition transport chain (v9-chain algebra, validated propagator) goes non-finite/garbage-scale inside the crest band (k = 0.5112/0.5295/km: non-finite Cc; elsewhere |C| 1e-2..1e2 vs the true ~1e-7) — INDEPENDENT confirmation that every four-column transport representation is ill-posed in the band (the below-source mantle legs are evanescent at k > omega/vp: e^+-95 dynamic range)',
        schurStatus: 'the admittance up-leg recursion is the only representation that stays smooth and finite across the band; trusted by construction + smooth-k anchors + the halfspace adjudication, with no surviving independent ON-BAND referee'
      }
    },
    crestDiagnostics: {
      // all literals measured 2026-09-10 by tools/broadband/crest-*.js on
      // this exact config (see those scripts for the provenance tables)
      measured: '2026-09-10, crest-diagnose.js / crest-noise-probe.js / crest-dh-probe.js / crest-series-run.js',
      bandScan: '0.40-0.70/km at 2.5e-4/km: spike forest 0.506-0.542/km, |uz| 1e3 -> 4.8e5 -> 1e2; 126 guard-null samples blanket 0.525-0.70; band trapezoid ur ~399 vs whole-integral legacy 28 (the legacy fine zone samples only a fraction of the spikes)',
      continuityDiscriminator: {
        method: 'physical resonances have width >= k/(2Q) = 0.005/km at qP=qS=50, so |g(k +/- 1e-5/km)| must match to ~0.2%; chain noise decorrelates instead',
        control_0p44: 'ratios 1.000/1.000 at 1e-5 (physical, continuous)',
        control_0p46: 'ratios 1.000/1.000 at 1e-5',
        crest_0p5112: 'ratios 1.396/0.108 at 1e-5 — decorrelates 500x below the material width: CHAIN NOISE, not a resonance',
        crest_0p5242: 'ratios 1.565/2.945 at 1e-5'
      },
      dhCollapse: {
        method: 'depth-FD dC = (Cdn-Cup)/(2*dh): enlarge the stencil; noise amplified by 1/(2dh) collapses, true derivatives are dh-invariant',
        control_0p44: '6.270e3 invariant across dh 0.5/2/5/20 m',
        crest_0p5187: '1.84e6 -> 1.9e5 -> 6.7e4 -> 2.0e4 (dh 0.5/2/5/20 m)',
        crest_0p5295: '4.26e6 -> 6.3e5 -> 1.9e5 -> 4.7e4'
      },
      cureOutcomes: {
        gen1_agreementSearch: {
          spot: 'spikes collapse 5-120x, controls byte-identical',
          seriesFullTensorUrm: { dk0p02: 9.54486, dk0p002: 12.2814, dk0p001: 7.95338, dk0p0005: 2.6201 },
          verdict: 'non-convergent (spread 3.7) — the two-consecutive-agreement exit can be fooled by CORRELATED chain noise (the residual direction rotates slowly with dh)'
        },
        gen2_richardson: {
          construction: 'dC_R = D(2h) - D(h) through the (Cdn-Cup)/(2h) path; cancels an arm-independent rounding noise N exactly ((4hS + N) - (2hS + N) = 2hS)',
          spot: 'controls byte-identical, spikes UNTOUCHED (0.5187: 1.854e6 vs legacy 1.835e6)',
          verdict: 'the band noise is NOT an arm-independent additive term — the chain output in the degenerate band is a deterministic wild function of (k, z, dh) jointly; no stencil combination inside this chain representation can cure it'
        }
      }
    },
    cap10SeriesUrm: capSeries,
    // frozen cap-study measurement (tools/broadband/psv-cap-study.js, one-time
    // run 2026-09-09 post-triMul-fix; series = |u_r| at dk 0.02/0.002/0.001/0.0005)
    capStudy: {
      measured: '2026-09-09, qShear=qP=50, dk 0.02/0.002/0.001/0.0005, Tokyo column 0.5 Hz Mw7.7 r=198.5km',
      caveat: 'PRE-mu*-fix measurement (real-mu halfspace admittance, R10 batch) — retained as the div-40-era record; the v9 machinerySeriesUrm above is the post-fix baseline',
      caps: {
        cap30: { deviatoric: [0.014338, 0.014138, 0.014092, 0.014274], fullTensor: [54.196, 58.918, 21.315, 7.2916] },
        cap10: { deviatoric: [0.0383163, 0.0390925, 0.0386167, 0.0363516], fullTensor: [2687.32, 3756.68, 2059.53, 2245.35] },
        cap6: { deviatoric: [0.00807936, 0.00854269, 0.00829816, 0.00873302], fullTensor: [0.530931, 0.914052, 0.766251, 0.792511] },
        cap4: { deviatoric: [0.00982072, 0.0096433, 0.00963482, 0.00942886], fullTensor: [1.22695, 1.22604, 1.23049, 1.22504] },
        cap2: { deviatoric: [0.0268753, 0.0276159, 0.0272103, 0.0275186], fullTensor: [0.910701, 0.929117, 0.916003, 0.931776] }
      },
      belowFloorSpreads: {
        cap30: { deviatoric: 1.013, fullTensor: 8.08 },
        cap10: { deviatoric: 1.075, fullTensor: 1.824 },
        cap6: { deviatoric: 1.052, fullTensor: 1.193 },
        cap4: { deviatoric: 1.023, fullTensor: 1.0045 },
        cap2: { deviatoric: 1.015, fullTensor: 1.017 }
      },
      crossCapFullTensor: { cap10_vs_cap6_dk0005: 2833, cap6_vs_cap4_dk0005: 0.6469, cap2_vs_cap4_dk0005: 0.7423 }
    }
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
    schema: 'quake-sim-psv-scale-diagnosis-v11',
    generatedAt: new Date().toISOString(),
    reMeasure: 'v11 (2026-09-10): the compliance-representation adjudication. The deep-config validation gap (v10) was resolved by building THREE mutually-agreeing trusted references for the halfspace config (RK4-ODE referee with Richardson extrapolation, a balanced-eigendecomposition transport chain, and an exact closed-form halfspace BVP): they agree pairwise to 4e-3, expm4 was exonerated (7e-13), and the LEGACY A/W chain was measured O(1) off (3.4-7.8x across k, cap-sensitive) — Schur matched to 1e-11. psvSchurCompliance is now production-wired behind params.schurCompliance (complianceAt dispatcher). The Schur dk series was then measured: the fullTensor channel STILL does not converge (194/194/523/680/541) and the deviatoric control moves too (0.0178 -> 0.0083, 2x) — the v10 "deviatoric converged" reading was representation-relative, not physical. The blocker moves from compliance representation to the UNRESOLVED BAND STRUCTURE itself: pole-aware quadrature (modal subtraction / complex contour) is the registered cure',
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
      reading_v11: "v11 layered state (compliance-adjudication batch): (1) the deep-config validation gap was closed by building three mutually-agreeing trusted references on HALF@1.2Hz-zs73-q50 — an RK4-ODE referee (Richardson-extrapolated), a balanced-eigendecomposition transport chain, and an EXACT closed-form halfspace BVP (free surface + radiation + source jump, no chain at all); they agree pairwise to 4e-3 and the closed form equals -Schur EXACTLY; (2) expm4 was exonerated: psvPropagator's output matches the balanced eigendecomposition to 7e-13 with machine-clean semigroups — the O(1) legacy deviation lives in the A/W + MGS residual bookkeeping, and is cap-sensitive; (3) psvSchurCompliance is production-wired behind params.schurCompliance (complianceAt dispatcher; legacy default unchanged, R1-R11 anchors untouched); (4) on the tokyo band the eigendecomposition transport chain ITSELF collapses (non-finite Cc / garbage |C| inside 0.50-0.53/km) — independent confirmation that all four-column transport representations are ill-posed there (evanescent mantle legs, e^+-95) while the Schur up-leg recursion stays smooth; (5) the Schur dk series: fullTensor 194/194/523/680/541 NON-monotone, deviatoric 0.0178->0.0083 (2x) — the compliance representation is adjudicated but the series still does not converge, so the v10 'deviatoric converged' reading was representation-relative; the blocker moves to pole-aware quadrature of the band. Production opts.psv stays BLOCKED.",
      reading: "v8 layered state (cap-closure batch): the registered subdivide-cap study is EXECUTED and NEGATIVE. Every tightened cap produces an internally dk-converged series (below-floor spreads: cap30 dev 1.3%, cap4 dev 2.0%, cap4 fullTensor 0.45%, cap2 fullTensor 1.7%) while the CROSS-CAP values disagree without monotone convergence: deviatoric 0.0083 (cap6) / 0.0096 (cap4) / 0.0141 (cap30) / 0.027 (cap2); fullTensor 0.79 (cap6) / 1.23 (cap4) / 0.92 (cap2) / 2245 (cap10) / 7-59 (cap30). Conclusion: the subdivide exponent cap does NOT close the leaky-P crest-band representation problem - each cap pattern resolves a different fraction of the crest, and the dipole (depth-FD) channels inherit that pattern sensitivity directly. The v7 interim framing (fullTensor open on cap dependence) is confirmed and sharpened: no tested cap is the answer. Registered cure unchanged in kind but now evidence-backed: per-pole-physical crest representation (residue-based or per-layer Schur-admittance stepping) instead of discretization tightening. The deviatoric channel's per-cap convergence (1.3% at the production cap 30) stands as self-consistency only - its absolute value carries the same crest uncertainty. Production opts.psv stays BLOCKED.",
      reading_v7: "v7 layered state (delta-matrix batch): (1) the carried chain is now the MGS-orthonormalised delta-matrix factorisation S = Q*T (per-layer modified Gram-Schmidt with two reorthogonalisation passes, R bookkeeping, joint T rescaling; sigma = the above-source log exactly as the retired joint-scalar chain) - the raw chain's joint max-scaling preserved column RATIOS but not column INDEPENDENCE, and over the deep above-source leg the A pair collapsed float-parallel in the leaky-P crest band (the v6 det(Rc) = 0 nulls); (2) TWO propagator/chain bugs were fixed on the way, both caught by cross-checks: the first-cut triMul bounded the triangular product sum at l <= i (the DIAGONAL's index) dropping every j > i cross term - the R2 RK4 anchor failed 3.3e-2 and exposed it before any freeze; and the v6 propagator back-transform used the REAL mu* where the complex mu* is required (undamped paths bit-identical, damped paths mixed the state convention by |1 - i/q| per layer); (3) the DEVIATORIC series converges at the production cap (below-floor spread 1.3%) at the same absolute scale as the v6 raw chain (2.5%); (4) the FULL-TENSOR channel REMAINS OPEN: not the det-null collapse but the subdivide-cap dependence of the crest resolution.",
      reading_v6: "v6 layered state: (1) the matrix-exponential propagator lost every layer Q (real-moduli A; measured: the deviatoric response 3x too large, interior leaky poles pinned ON the real axis at any q) - fixed by complex moduli with the exact nuOf convention c*^2 = c^2(1-i/q), after which the DEVIATORIC series converges at the correct physical scale; (2) the pole detector scans the source-independent surface-source det(Rc) dip landscape (the buried-source |C| ridge sank under e^{-kz} once attenuation returned); (3) branch-point resolution rings sample the halvespace-branch kinks the coarse lattice undersampled; (4) the remaining fullTensor blocker is the Rc basis-degeneracy band: det(Rc) = exact 0 across k ~ 0.53-0.56/km (the two residual basis columns become float-exactly parallel above vs_half), so the compliance is unrepresentable there and the grid-dependent bridging shows up as the below-floor series spread. The registered scale-invariant Rc inversion was measured to be the wrong cure (entries O(1); the det is small by physics, not scaling).",
      reading_v5: 'v5 layered state: (1) the v4 "branch-tail cusp" attribution is RETIRED — the layered compliance is bounded at every branch point (Rc^-1 Rw cancels the 1/nu factors; interior branches are not singular under the expm propagator); (2) with qP defaulted to qShear the undamped-P leaky resonances leave the real axis and the DEVIATORIC series converges (below-floor spread ~1%); (3) the detector is the bounded compliance-ridge scan (the det-dip scanner sat on a e^-288 chain floor, stepped over the fundamental and refined nothing — its v4 table was noise); (4) the FULL-TENSOR channel remains open: its dipole (depth-FD) channels ride the leaky-P crest band 0.45-0.6/km, where 1e9 crests over ~1e-3/km are peppered with det(Rc) underflow nulls — the trapezoid bridges shift with the grid. qP100/qP200 series measured non-converged as well, so this is not damping tuning.',
      openItem: "fullTensor leaky-P band k-integration (tokyo 0.5 Hz, k ~ 0.50-0.55/km): v11 adjudicated the COMPLIANCE REPRESENTATION — the legacy chain is O(1) off trusted references at deep configs while Schur matches to 1e-11..4e-3 (production-wired as params.schurCompliance) — yet the fullTensor dk series through the VALIDATED Schur compliance still does not converge (194/194/523/680/541, non-monotone) and the deviatoric control now moves 2x as well: the residual blocker is the band's unresolved near-pole structure in the K INTEGRATION of the dipole (depth-FD) channels, not the compliance. Registered cure: pole-aware quadrature (modal-pole subtraction or complex-contour evaluation of the crest band). The 3 isolated band nulls (0.555/0.585/0.620/km) remain. Production opts.psv stays BLOCKED",
    }),
    verdict: 'fullspace_anchored_layered_compliance_adjudicated_schur_validated_band_quadrature_full_tensor_open',
    registeredNextStep: 'pole-aware quadrature of the leaky-P band for the dipole (depth-FD) channels — modal-pole subtraction or complex-contour evaluation — because the compliance representation is adjudicated (Schur validated 1e-11..4e-3 against three trusted references, legacy chain measured O(1) off and retired from deep-config use) while the dk series through the VALIDATED compliance still does not converge: the blocker is the unresolved near-pole structure of the k integral itself; P-SV-side aliasing-guard divisor ladder also still pending; CS-pipeline v4 stays user-gated behind opts.psv',
    context: 'v10 (2026-09-10, crest-noise batch) diagnosed the leaky-P crest band at SAMPLE level on the frozen v9 config and retired the whole in-chain FD cure family: (1) the legacy series reproduced the v9 freeze bit-exactly (28.092/28.092/44.3618) — the baseline is stable; (2) a continuity discriminator proved the band spikes are CHAIN NOISE, not physical resonances: controls at 0.44/0.46/km are continuous to 0.1% at k-offsets of 1e-5/km while crest samples swing 1.4-15x at the same offset — 500x NARROWER than the physical resonance-width floor k/(2Q) = 0.005/km at qP = 50; (3) the mechanism is the depth finite-difference: dC = (Cdn - Cup)/(2*dh) amplifies the near-degenerate band residual-direction noise by 1/(2*dh) — enlarging the stencil collapses the spikes monotonically (0.5295/km: 4.26e6 -> 4.7e-1 of itself across dh 0.5 -> 20 m) while controls are dh-invariant, and the compliance magnitude |C| stays smooth (4.7e-8) while the integrand spikes — the wild factor lives only in the depth-gradient channels; (4) cure gen-1 (adaptive-stencil agreement search, dhAdaptive) collapsed the spikes 5-120x and dropped the series from 28-55 to 2.6-12.3 but stayed non-convergent (spread 3.7; the two-consecutive-agreement exit is fooled by correlated noise); cure gen-2 (Richardson pair D(2h) - D(h), exact cancellation for arm-independent rounding) left the spikes untouched — proving the noise is a DETERMINISTIC (k, z, dh)-joint wild function of the chain, not additive rounding; (5) verdict: the in-chain FD cure family is retired; the degenerate band needs an independent representation (per-layer Schur admittance; the v6 prototype up-leg was stable, down-leg NaN is the named blocker). Production opts.psv stays BLOCKED. v9 (2026-09-09, R3 opening batch) re-measured the full series on the mu*-corrected halfspace admittance (R10 damped cross-check fixed psvEigenvectors traction rows at a measured 1.4% halfspace-convention error): the fullTensor below-floor series changed character from erratic non-monotone collapse (54.2/58.9/21.3/7.3 on the defective admittance) to a CLEAN MONOTONE DIVERGENCE (28.1 -> 44.4 -> 50.2 -> 54.6 at dk 0.002 -> 0.0005) while deviatoric stays converged (spread 1.055 < 1.1) — the crest-band OPEN is re-confirmed on a trustworthy baseline and the full-space anchor still passes (maxResidual 0.062 <= 0.08), so the residue/Schur-admittance cure remains the registered blocker for production opts.psv; v8 (cap-closure batch) executed the registered subdivide-cap study and measured it NEGATIVE (cross-cap fullTensor values disagree without monotone convergence at caps 2/4/6/10/30) - the blocker is the leaky-P crest representation itself, not discretization; v7 (delta-matrix batch) landed the MGS-orthonormalised chain and fixed two real bugs the batch cross-checks exposed: the first-cut triMul triangular product dropped the j > i cross terms (caught by the R2 RK4 anchor at 3.3e-2 BEFORE any freeze; the interim "fullTensor converges at 0.0077" measurement was this bug suppressing the dipole channels and is retracted), and the v6 propagator back-transform used the real muR where the complex mu* is required (undamped paths bit-identical); deviatoric series converge at the production cap at the v6 raw-chain scale; fullTensor stays OPEN on cap-dependent crest resolution; v6 (Rc-inversion batch) found the registered scale-invariant inversion inapplicable (det small by physics) and fixed the v4 expm layer-Q loss (complex moduli, nuOf-exact convention); detector on the surface-source det(Rc) dip scan; branch-point resolution rings; v5 froze qp-default + compliance-ridge detector + window-continuity fix; v1 froze blocked_pending_source_calibration (21.3x hot factor); v2 froze fullspace_anchored_layered_poles_open (source anchor fixed 3 missing/1 wrong-column dipole terms + traction/dipole -1 + razor band-nulling); v3 replaced residues with gamma-resolved windows and found the Bessel-aliasing root cause; v4 closed the root-tracking gap (expm propagator, joint-scalar chain, 2D Newton) but misattributed the remaining series drift to an integrable branch-tail cusp; v5 (branch-cusp batch) measured the actual mechanisms: bounded layered compliance (v4 cusp retired), true cusps only on the fullSpace path (analytic subtraction landed there, references moved to xi-substitution), undamped-P leaky poles on the real axis (qP <- qShear default), a dead det scanner replaced by the compliance-ridge detector, and a window-ring continuity bug fixed',
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
      v7verdict: 'fullspace_anchored_layered_mgs_chain_dev_converged_full_tensor_cap_open',
      v7openItem: 'subdivide-cap dependence of the crest resolution (closed NEGATIVE by the v8 cap study: the cap knob cannot converge the crest band)',
      v8verdict: 'fullspace_anchored_layered_mgs_chain_cap_study_negative_full_tensor_open',
      v8caveat: 'the v8 series and cap-study literals were measured on the real-mu halfspace admittance (pre-R10 fix) — kept as the pre-fix record; the v9 series above is the corrected-kernel baseline',
      v9verdict: 'fullspace_anchored_layered_mgs_chain_v9_rebased_full_tensor_monotone_open',
      v9note: 'the v10 batch reproduced the v9 legacy series bit-exactly (28.092/28.092/44.3618 at the clamped/below-floor dks) before measuring any cure — the corrected-kernel baseline is stable across days',
      v10verdict: 'fullspace_anchored_layered_crest_noise_proven_fd_cures_retired_full_tensor_open',
      v11adaptiveNote: 'adaptive midpoint refinement (params.adaptiveK tol 0.05 maxLevel 6, landed 2026-09-11) MEASURED on the Schur arm: fullTensor 1434.2/1434.2/794.9 at dk 0.02/0.005/0.002 — still non-converged; brute k-refinement reaches only gamma-scale resolution at prohibitive cost, so the registered cure sharpens to ANALYTIC det-based principal-value subtraction (fit D(k) linear across each compliance null, integrate P/D in closed form)',
      v10note: 'crest band diagnosed at sample level (continuity discriminator + dh collapse); the in-chain FD cure family (agreement search, Richardson pair) measured and retired; the series numbers 28.092/28.092/44.3618 were re-verified this batch before the Schur arm was measured',
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
