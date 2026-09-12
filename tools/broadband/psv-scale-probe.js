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
//  SCHEMA v12 (det-subtract batch, 2026-09-11): the v11 registered cure
//  ("analytic det-based principal-value subtraction") SHIPPED as
//  psvPoleModelFit + params.detSubtract in psv.js — each modal pole is
//  fitted as A/(k-kp)+B per channel on REAL-AXIS samples (2-param
//  Nelder-Mead x both Im-kp signs, conjugated complex LS; complex-k Newton
//  on either chain determinant measured infeasible: the Schur up-leg step
//  det crosses zero AT the poles so evaluations null around every hunt
//  point, and the raw cascade det Newton was the registered v4 failure),
//  the fitted poles' gamma-windows are dropped, the smooth remainder rides
//  the production lattice, and the exact principal-branch complex-log
//  pole integrals are re-added. The machinery validates to 2.6e-5 on a
//  closed-form integrand whose plain trapezoid fails by 12-14%. On the
//  production tokyo config it does NOT rescue the dk series (measured
//  through this probe's own frozen protocol: fullTensor-subtracted
//  231.77/231.77/231.77/532.96/770.39/803.88 — monotone RISING below the
//  alias floor, below-floor spread 1.51, unconverged; deviatoric unmoved)
//  — because the FIT TABLE exposed the real
//  blocker: the MGS ridge-detector candidates do not locate the Schur
//  integrand's actual narrow resonances. Five candidates' ladders all slid
//  to the same 0.70-0.77/km thicket (|A| to 1e2, gamma ~1e-3), the
//  0.5264/0.5474 leaky-P candidates fit FAILED (rel 0.74-0.76), and the
//  production pole-model set kept only 7 distinct narrow models. The
//  frozen schur series (194.41/523.05/679.98/540.93) REPRODUCES at
//  committed code: an interim "stale freeze" suspicion raised by this
//  batch's side scripts was a reproducibility ARTIFACT — those scripts
//  passed the AZIMUTH-ROTATED tensor (psv.rotateFullTensor) while the
//  probe's frozen protocol keeps the UNROTATED full tensor; the
//  deviatoric channel, never rotated, matched bit-exactly all along, and
//  the rotated-tensor numbers exist only inside the
//  crest-det-subtract.js driver experiment.
//
//  SCHEMA v13 (pole-locator feasibility batch, 2026-09-12): the v12
//  registered "Schur-chain-native pole LOCATOR" was put to the test and the
//  answer is NEGATIVE and decisive — a locator cannot exist on the
//  chain-evaluated field. Method: a 1-ulp k-perturbation ladder (u =
//  2^floor(log2(k0m))-52 m; a real resonance of ANY width moves by
//  (ulp/gamma)^2 ~ 0, so O(1) swings = roundoff chaos, not structure).
//  Control k=0.40/km: the integrand AND the compliance are bit-stable
//  through 1e7 ulp (full stable digits). Crest band 0.70/0.73/0.76/0.80/km:
//  the integrand swings -89%..+1203% at ONE ulp (zero stable digits), the
//  compliance C itself 15-567%, at every source depth (73/30/surface) and
//  at every truncation-safe dh stencil (0.5/32 m). Mechanism: detM sits at
//  ~1e-16 of |M|^2 in the crest band (cond(M) ~ 1e16) so the 2x2
//  determinant subtraction noise IS the output scale — the Schur up-leg
//  recursion stays smooth (v11) but its output inherits the cancellation
//  floor. Consequences measured this batch: (1) the detM dip landscape
//  sinks into the same floor beyond k~0.65 (bucket minima -6.1 -> -39.5
//  log units, decorrelating at 0.002/km spacing, a -690 cancellation
//  needle at 0.900) — the v6 det(Rc) detector was structurally blind
//  there, which is the v12 "candidates mislocate" root cause; (2) the
//  frozen fit table's rel 0.02-0.03 fits are SINGLE-SAMPLE ANCHORED (the
//  cand-0.6173 ladder samples 0.18-1.50/km, one sample on the crest at
//  3.67e7 amid a 1e4-1e5 background); (3) the dk series values are
//  NOISE-INTEGRAL dominated: dh (the FD stencil = a pure noise-realization
//  knob; truncation ~4e-3 relative at 64 m) moves the fullTensor series
//  194/266/44.9/28.4/6.6 across dh 0.5/2/16/32/64 at dk0.02 — 30x, no
//  pinning, no dh converges (d32's monotone decline is broken by d64 and
//  by the dk0.00025 extension 16.61 -> 8.65). There is currently NO
//  series value on this config interpretable as signal. Registered cure:
//  compensated (double-double) arithmetic across the Schur compliance
//  path, gated by the 1-ulp discriminator flipping to bit-invariance.
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
  // v12 arm: pole-model subtraction (params.detSubtract) — fitted poles
  // lose their gamma-windows, the smooth remainder rides the plain
  // lattice, the exact complex-log pole integrals are re-added
  // (psv.js psvPoleModelFit / psvPoleModelSet; self-tested to 2.6e-5
  // against a closed-form A/(k-kp)+B integrand in crest-det-subtract.js).
  const detSubtractSeries = {};
  for (const [label, t] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
    detSubtractSeries[label] = {};
    for (const dk of seriesDks) {
      const p = Object.assign({ rKm, zSourceKm: zs, dkInvKm: dk, kMaxInvKm: 5, qShear: 50,
        mxx: t.mxx, myy: t.myy, mzz: t.mzz || 0, mxy: t.mxy || 0, mxz: t.mxz || 0, myz: t.myz || 0,
        schurCompliance: 1, detSubtract: 1 });
      detSubtractSeries[label]['dk' + dk] = +mag(psv.psvMomentSpectrumAtFrequency(stack, omega, p).ur).toExponential(4);
    }
  }
  // v12: the production pole-model set at the frozen config (what the
  // subtraction actually subtracts, and the candidate-mislocation record)
  const poleListFrozen = psv.psvModalPoles(stack, omega, 5, { zSourceKm: zs, qShear: 50 });
  const fitParams = Object.assign({ rKm, zSourceKm: zs, kMaxInvKm: 5, qShear: 50, schurCompliance: 1, detSubtract: 1 }, full);
  const gOfFrozen = (k) => psv.psvIntegrandAtK(stack, omega, k, fitParams);
  const modelSet = psv.psvPoleModelSet(stack, omega, poleListFrozen, fitParams, gOfFrozen);
  const poleModels = modelSet.map((m) => ({
    kpInvKm: +(m.kp[0] * 1000).toFixed(5), gammaInvKm: +(Math.abs(m.kp[1]) * 1000).toExponential(3),
    sign: m.kp[1] >= 0 ? '+' : '-', rel: +m.rel.toExponential(3), n: m.n,
    absA: { ur: +mag(m.A.ur).toExponential(3), uz: +mag(m.A.uz).toExponential(3), ut: +mag(m.A.ut).toExponential(3) },
    candKInvKm: +(m.cand.k).toFixed(4)
  }));
  // cap-dependence record (v7): the same series at subdivide cap 10 — the
  // subdominant-structure resolution probe (the subdivide cap bounds the
  // per-sublayer exponent the MGS inner products can separate; cap 30 loses
  // the leaky-P crest structure the dipole channels ride).
  const capSeries = {};
  for (const [label, t] of [['deviatoric', deviatoric], ['fullTensor', full]]) {
    capSeries[label] = {};
    for (const dk of [0.02, 0.001]) capSeries[label]['dk' + dk] = +psvU(t, dk, 10).toExponential(4);
  }
  // ---- v13 chaos diagnosis (pole-locator feasibility) --------------------
  // 1-ulp k-perturbation ladders: u = 2^floor(log2(k0m))-52, the double ulp
  // of the k sample in 1/m. A real resonance of ANY width gamma moves the
  // response by ~(ulp/gamma)^2 ~ 0 at these offsets (1 ulp of k is 15+
  // orders below every physical width), so O(1) relative swings are
  // roundoff chaos, not structure. Deterministic — re-measured every run.
  const chaos = (function () {
    const uOf = (k0m) => 2 ** (Math.floor(Math.log2(k0m)) - 52);
    const key = (kKm) => 'k' + kKm.toFixed(2).replace('.', 'p');
    const mag3 = (g) => g ? Math.max(Math.hypot(g.ur[0], g.ur[1]), Math.hypot(g.uz[0], g.uz[1]), Math.hypot(g.ut[0], g.ut[1])) : null;
    const fullP = { rKm, zSourceKm: zs, mxx: full.mxx, myy: full.myy, mzz: full.mzz, mxy: full.mxy, mxz: full.mxz, myz: full.myz, kMaxInvKm: 5, qShear: 50, schurCompliance: 1 };
    const gAt = (k0m, dh) => mag3(psv.psvIntegrandAtK(stack, omega, k0m, dh ? Object.assign({}, fullP, { dhM: dh }) : fullP));
    const cAt = (k0m) => {
      const r = psv.psvSchurCompliance(stack, omega, k0m, zs, { qShear: 50, qP: 50 });
      if (!r) return null;
      let m = 0;
      for (const row of r) for (const c of row) { const a = Math.hypot(c[0], c[1]); if (a > m) m = a; }
      return m;
    };
    function ladder(meas, kKm, mults) {
      const k0m = kKm / 1000, u = uOf(k0m), v0 = meas(k0m);
      return mults.map((n) => {
        const v = meas(k0m + n * u);
        return v == null || v0 == null ? 'null' : (100 * (v - v0) / v0).toFixed(3) + '%';
      }).join('/');
    }
    const mults7 = [1, 2, 4, 16, 256, 65536, 1e7];
    const mults6 = [1, 2, 4, 16, 256, 65536];
    const ulpInt = {}, ulpC = {}, ulpInt32 = {}, fdCollapse = {};
    for (const kKm of [0.40, 0.70, 0.73, 0.76, 0.80]) ulpInt[key(kKm)] = ladder(gAt, kKm, mults7);
    for (const kKm of [0.40, 0.73]) ulpC[key(kKm)] = ladder(cAt, kKm, mults6);
    for (const kKm of [0.40, 0.73, 0.76, 0.80]) ulpInt32[key(kKm)] = ladder((k) => gAt(k, 32), kKm, mults6);
    for (const kKm of [0.40, 0.73, 0.76, 0.80]) {
      fdCollapse[key(kKm)] = [0.5, 2, 8, 32].map((dh) => {
        const v = gAt(kKm / 1000, dh);
        return v == null ? 'null' : v.toExponential(3);
      }).join('/');
    }
    // detM landscape floor: bucket minima of log|detM(Schur, zs=73)| — the
    // det(Rc)-dip locator's scan object sinks into the determinant's own
    // 1e-16-absolute subtraction-noise floor beyond k ~ 0.65.
    const detMFloor = {};
    for (let b = 0.47; b <= 1.3201; b += 0.05) {
      let mn = Infinity, mk = null;
      for (let k = b; k < b + 0.05; k += 0.005) {
        const rr = psv.psvSchurCompliance(stack, omega, k / 1000, zs, { qShear: 50, qP: 50, _wantDet: 1 });
        if (!rr) continue;
        const lg = Math.log(Math.hypot(rr.detM[0], rr.detM[1]) + 1e-300);
        if (lg < mn) { mn = lg; mk = k; }
      }
      if (mk != null) detMFloor['b' + b.toFixed(2).replace('.', 'p')] = +mn.toFixed(1);
    }
    // integrand weight profile (0.01/km bucket maxima): where the weight
    // actually is, and whether the hypothesised 1.005/km trapped mode
    // carries any.
    const weightProfile = {};
    for (let b = 0.3; b <= 1.6001; b += 0.1) {
      let mx = 0;
      for (let k = b; k < b + 0.1; k += 0.01) {
        const v = gAt(k / 1000);
        if (v != null && v > mx) mx = v;
      }
      weightProfile['b' + b.toFixed(1).replace('.', 'p')] = mx > 0 ? +mx.toExponential(2) : 0;
    }
    // fit-sample diagnosis: the frozen top fit's ladder (cand 0.6173) —
    // where its samples land and which one anchors it.
    const fitSamples = [];
    {
      const k0 = 0.6173 / 1000, g0 = Math.max(0.11 / 1000, k0 / 100, 1e-9);
      for (const mi of [0.25, 0.5, 1, 2, 4, 8]) for (const si of [0, 1]) {
        const kj = k0 + (si ? 1 : -1) * mi * g0;
        const v = gAt(kj);
        fitSamples.push(+(kj * 1000).toFixed(4) + ':' + (v == null ? 'null' : v.toExponential(2)));
      }
    }
    return { ulpInt, ulpC, ulpInt32, fdCollapse, detMFloor, weightProfile, fitSamples };
  })();

  // ---- v14 DD arm (compensated-arithmetic chain, params.ddCompliance) ----
  // The v13 registered cure: the whole Schur path re-evaluated in
  // double-double arithmetic (psv-dd.js). Live-measured here: the 1-ulp
  // discriminator on the DD field (the acceptance gate), the DD-vs-double
  // control-band agreement, and the up-leg step-det cancellation budget.
  const ddArm = (function () {
    const psvdd = require('./psv-dd.js');
    const uOf = (k0m) => 2 ** (Math.floor(Math.log2(k0m)) - 52);
    const key = (kKm) => 'k' + kKm.toFixed(2).replace('.', 'p');
    const mag3 = (g) => g ? Math.max(Math.hypot(g.ur[0], g.ur[1]), Math.hypot(g.uz[0], g.uz[1]), Math.hypot(g.ut[0], g.ut[1])) : null;
    const fullDd = { rKm, zSourceKm: zs, mxx: full.mxx, myy: full.myy, mzz: full.mzz,
      mxy: full.mxy, mxz: full.mxz, myz: full.myz, kMaxInvKm: 5, qShear: 50,
      schurCompliance: 1, ddCompliance: 1 };
    const gAt = (k0m) => mag3(psv.psvIntegrandAtK(stack, omega, k0m, fullDd));
    const ulpLadder = {};
    for (const kKm of [0.40, 0.70, 0.73, 0.76, 0.80]) {
      const k0m = kKm / 1000, u = uOf(k0m), m0 = gAt(k0m);
      ulpLadder[key(kKm)] = [1, 2, 4, 16, 256, 65536, 1e7].map((n) => {
        const v = gAt(k0m + n * u);
        return v == null || m0 == null ? 'null' : (100 * (v - m0) / m0).toExponential(2) + '%';
      }).join('/');
    }
    const magC = (r) => Math.max(...r.flat().map((c) => Math.hypot(c[0], c[1])));
    const Cdd = psvdd.schurComplianceDD(stack, omega, 0.40 / 1000, zs, { qShear: 50, qP: 50 });
    const Cdbl = psv.psvSchurCompliance(stack, omega, 0.40 / 1000, zs, { qShear: 50, qP: 50 });
    const controlAgreementRel = Math.abs(magC(Cdd) - magC(Cdbl)) / magC(Cdbl);
    const stepCancel = {};
    for (const kKm of [0.40, 0.70, 0.73, 0.76, 0.80]) {
      const r = psvdd.upLegStepCancellation(stack, omega, kKm / 1000, zs, { qShear: 50, qP: 50 });
      stepCancel[key(kKm)] = r ? +r.worst.toExponential(3) : null;
    }
    return { ulpLadder: ulpLadder, controlAgreementRel: +controlAgreementRel.toExponential(3), stepCancel: stepCancel };
  })();

  // v13 arm: the dk series at FIXED depth-FD stencils. dh is a pure
  // noise-realization knob here (FD truncation at dh <= 64 m is
  // ~(dh/km)^2 ~ 4e-3 relative on this config): if any dh pinned the same
  // value across dks the series would have a signal-level reading.
  const seriesDh = {};
  for (const dh of [0.5, 2, 16, 32, 64]) {
    const arm = {};
    for (const dk of [0.02, 0.002, 0.001, 0.0005]) {
      const p = Object.assign({ rKm, zSourceKm: zs, dkInvKm: dk, kMaxInvKm: 5, qShear: 50,
        mxx: full.mxx, myy: full.myy, mzz: full.mzz, mxy: full.mxy, mxz: full.mxz, myz: full.myz,
        schurCompliance: 1, dhM: dh });
      arm['dk' + dk] = +mag(psv.psvMomentSpectrumAtFrequency(stack, omega, p).ur).toExponential(4);
    }
    seriesDh['dh' + String(dh).replace('.', 'p')] = arm;
  }
  const devDh32 = {};
  for (const dk of [0.02, 0.002, 0.001, 0.0005]) {
    const p = Object.assign({ rKm, zSourceKm: zs, dkInvKm: dk, kMaxInvKm: 5, qShear: 50,
      mxx: deviatoric.mxx, myy: deviatoric.myy, mzz: 0, mxy: deviatoric.mxy, mxz: 0, myz: 0,
      schurCompliance: 1, dhM: 32 });
    devDh32['dk' + dk] = +mag(psv.psvMomentSpectrumAtFrequency(stack, omega, p).ur).toExponential(4);
  }
  const seriesDh32Ext = (() => {
    const p = Object.assign({ rKm, zSourceKm: zs, dkInvKm: 0.00025, kMaxInvKm: 5, qShear: 50,
      mxx: full.mxx, myy: full.myy, mzz: full.mzz, mxy: full.mxy, mxz: full.mxz, myz: full.myz,
      schurCompliance: 1, dhM: 32 });
    return +mag(psv.psvMomentSpectrumAtFrequency(stack, omega, p).ur).toExponential(4);
  })();

  const layered = {
    machinerySeriesUrm: { deviatoric: series.deviatoric, fullTensor: series.fullTensor },
    dhRichardsonSeriesUrm: { deviatoric: dhSeries.deviatoric, fullTensor: dhSeries.fullTensor },
    schurSeriesUrm: { deviatoric: schurSeries.deviatoric, fullTensor: schurSeries.fullTensor },
    detSubtractSeriesUrm: {
      deviatoric: detSubtractSeries.deviatoric, fullTensor: detSubtractSeries.fullTensor
      // (an interim tail0p00025 literal was removed: it had been measured by
      // the side driver on the ROTATED tensor — not comparable with this
      // protocol's unrotated series; see tensorProtocolNote)
    },
    poleModelSet: poleModels,
    tensorProtocolNote: 'the frozen series protocol keeps the full tensor UNROTATED (source-frame M; line-level: full = {M.xx, M.yy, M.zz, M.xy, M.xz, M.yz}); the probe computes Mr = rotateFullTensor(...) but the series never consume it. A 2026-09-11 side-script batch (crest-det-subtract.js driver) measured the schur/detSubtract arms on the ROTATED tensor (129.18/582.3/711.6/552.3 plain-schur; 371/634/873/907 detSubtract) — those numbers are a DIFFERENT, rotated config, not the frozen series; an interim suspicion that the v11 freeze was stale (built on comparing rotated numbers against unrotated frozen values) is RETRACTED: the frozen 194.41/523.05/679.98/540.93 reproduces at committed code through this probe (v12 --write re-measured every arm live).',
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
        fdRefereeStatus: '2026-09-11 RETRACTED: the FD-BVP prototypes (crest-fd-referee/crest-fd-sh) turned out LAYER-BLIND above the source — u(0) invariant under any material change in the layers above zs (SH isolation: vs1 2.6->0.9 moves core-SH +46%, FD not at all; the P-SV contrast ladder showed the same flatness) — a shared assembly bug in my own probe code, NOT evidence against the chain family. After equilibration (kappa ~1e15 u/tr scale mix broke raw pivoting) the FD remains 30% off the chains at R11 with converged, invariant numbers; the layer-blindness mechanism is the registered debugging target. Until it is found the chains stand as the working representation (SH side is shake91-anchored), and det-based PV subtraction on the chain integrand is UNBLOCKED again',
      },
      tokyoBand_0p5Hz_zs73: {
        schurVsRk4Ref_smooth_k: '5.79e-3 at k = 0.30/km (2026-09-11 CORRECTION: re-measured with the FIXED crest-ode-referee — the original 7.6e-3 came from the unsorted-stops-broken referee; the in-band referee blowups were its evanescent-leg underflow blindness and are not verdicts either way)',
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
    chaosDiagnosis: {
      // v13 (pole-locator feasibility batch, 2026-09-12): all values
      // live-measured by this probe — deterministic, re-measured every run.
      method: '1-ulp k-perturbation ladder (u = 2^floor(log2(k0m))-52 m, the double ulp of the k sample): a real resonance of ANY width moves the response by ~(ulp/gamma)^2 ~ 0 at these offsets — 1 ulp of k sits 15+ orders below every physical width — so O(1) relative swings are roundoff chaos, not structure. Control = the smooth generic band; crest = the 0.70-0.80/km cluster where the integrand weight concentrates',
      ulpLadderIntegrandDh0p5: chaos.ulpInt,
      ulpLadderComplianceZs73: chaos.ulpC,
      ulpLadderIntegrandDh32: chaos.ulpInt32,
      fdCollapseIntegrand: chaos.fdCollapse,
      detMFloorBucketMinima: chaos.detMFloor,
      weightProfileBucketMaxima: chaos.weightProfile,
      fitLadderSamplesCand0p6173: chaos.fitSamples,
      reading: 'the chain has ZERO stable digits in the crest band: the integrand swings O(1) at 1 ulp of k at 0.70/0.73/0.76/0.80/km (control 0.40 bit-stable through 1e7 ulp), the compliance C itself 15-567%, at dh 0.5 AND 32 m and every source depth; the detM dip landscape (the v6 locator scan object) sinks below k~0.65 into the determinant subtraction-noise floor (bucket minima to -39.5, decorrelating at 0.002/km); the weight profile shows the band weight 1e4-1e5 generic [0.3,0.65], 1e7-1e8 crest [0.70,0.82], dead beyond 0.95 (the hypothesised 1.005/km trapped mode carries ~nothing here); the frozen top fit (cand 0.6173, gamma0 0.11/km) is single-sample anchored (one ladder sample on the crest at ~3.7e7 amid a 1e4-1e5 background) — rel 0.02-0.03 reflects that one sample, not local field cleanliness'
    },
    ddArithmeticArm: {
      // v14: all values live-measured by this probe (deterministic).
      method: 'the whole Schur chain re-evaluated in double-double arithmetic (tools/broadband/psv-dd.js — Dekker/Knuth primitives, no FMA; material products are exact two-products; the up-leg carries a per-layer propagator normalization, algebraically free since the admittance recursion is invariant under P -> alpha*P); params.ddCompliance opt-in, absent = byte-compatible double paths',
      ulpLadderIntegrandDd: ddArm.ulpLadder,
      controlAgreementRel: ddArm.controlAgreementRel,
      upLegStepCancellation: ddArm.stepCancel,
      reading: 'the DD gate PASSES at k = 0.80/km (1-ulp chaos -76% -> ~3e-5%) and the control band sits at DD-noise level (1e-13% at 1 ulp, cross-path agreement ~1e-11), but k = 0.70/0.73/0.76 stay chaotic (O(10-600%) at 1 ulp): the up-leg step det det(P22 - Y*P12) carries a STRUCTURAL cancellation of ~5e30-8e31 there (the recursion crosses the below-source subsystem near-resonance through the P-evanescent 190-km mantle layer, e^{+-114}) — the output chaos scales as eps x stepCancel x O(1-40), so DD (eps 1e-32) is consumed exactly. Registered cure: quad-double arithmetic (eps ~ 1e-64 -> step error ~8e-33 -> output noise ~1e-31, margin orders beyond the gate)'
    },
    seriesDhSensitivity: {
      // v13 arm: dh = the depth-FD stencil = a pure noise-realization knob
      // (FD truncation at dh <= 64 m is ~(dh/km)^2 ~ 4e-3 relative here).
      fullTensorUrm: seriesDh,
      deviatoricUrmDh32: devDh32,
      dh32Dk0p00025Extension: seriesDh32Ext,
      verdict: 'NO dh converges and no dh pins: dh0.5 (the frozen protocol) is non-monotone spread 3.5, dh2 spread 9.1, dh16 non-monotone 1.4, dh32 monotone-DECLINING (a coincidence broken by dh64 non-monotone and by the dk0.00025 extension 16.61 -> 8.65 still falling); the dh realization moves dk0.02 across 194/266/44.9/28.4/6.6 (30x). The series values are NOISE-INTEGRAL dominated at every truncation-safe dh — none is interpretable as signal; the depth-FD merely exposes the chain chaos with 1/(2dh) scaling and cannot suppress it below signal (dh is capped ~1e-1 of the km-scale compliance variation by truncation)'
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
    schema: 'quake-sim-psv-scale-diagnosis-v14',
    generatedAt: new Date().toISOString(),
    reMeasure: 'v14 (2026-09-12): the v13 registered double-double cure SHIPPED (psv-dd.js — the whole Schur chain in DD, params.ddCompliance opt-in) and the acceptance gate is PARTIAL: k = 0.80/km passes (1-ulp chaos -76% -> 3e-5%) with the control band at DD-noise level, but k = 0.70/0.73/0.76 stay chaotic — the NEW named blocker is the up-leg admittance STEP det cancellation ~5e30-8e31 (the recursion crosses the below-source near-resonance through the P-evanescent 190-km mantle layer), which consumes DD exactly; quad-double (eps 1e-64) is the registered cure with the amplification budget measured. v13 (2026-09-12): the v12 registered pole-locator question was answered NEGATIVELY and decisively — a locator cannot exist on the chain-evaluated field (1-ulp chaos, zero stable digits, chaosDiagnosis block). The dk series values were additionally shown to be NOISE-INTEGRAL dominated (the dh realization moves them 30x with no pinning — seriesDhSensitivity block), so no series number on this config is currently interpretable as signal. The registered cure moves to compensated (double-double) arithmetic across the Schur compliance path. v11 (2026-09-10): the compliance-representation adjudication. The deep-config validation gap (v10) was resolved by building THREE mutually-agreeing trusted references for the halfspace config (RK4-ODE referee with Richardson extrapolation, a balanced-eigendecomposition transport chain, and an exact closed-form halfspace BVP): they agree pairwise to 4e-3, expm4 was exonerated (7e-13), and the LEGACY A/W chain was measured O(1) off (3.4-7.8x across k, cap-sensitive) — Schur matched to 1e-11. psvSchurCompliance is now production-wired behind params.schurCompliance (complianceAt dispatcher). The Schur dk series was then measured: the fullTensor channel STILL does not converge (194/194/523/680/541) and the deviatoric control moves too (0.0178 -> 0.0083, 2x) — the v10 "deviatoric converged" reading was representation-relative, not physical. The blocker moves from compliance representation to the UNRESOLVED BAND STRUCTURE itself: pole-aware quadrature (modal subtraction / complex contour) is the registered cure',
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
      openItem: "fullTensor leaky-P band k-integration (tokyo 0.5 Hz): v13 measured the v12-registered pole locator INFEASIBLE — the chain-evaluated field has zero stable digits in the crest band (1-ulp k-perturbations move the integrand O(1), chaosDiagnosis), so no real-axis scan can separate poles from noise there; AND the dk series values are noise-integral dominated (the dh realization moves them 30x, seriesDhSensitivity — no truncation-safe dh converges or pins). The registered cure is compensated (double-double) arithmetic across the Schur compliance path, gated by the 1-ulp discriminator flipping to bit-invariance; the locator and series agendas re-open only on that resolvable field. The 3 isolated band nulls (0.555/0.585/0.620/km) remain. Production opts.psv stays BLOCKED",
    }),
    verdict: 'fullspace_anchored_layered_schur_validated_dd_landed_gate_partial_step_cancel_5e31_quad_double_registered',
    registeredNextStep: 'quad-double (eps ~ 1e-64) arithmetic for the Schur chain (psv-dd.js is the template — the per-layer up-leg normalization and the guard structure carry over): the measured up-leg step-det cancellation is ~5e30-8e31 at k = 0.70-0.76/km (the admittance recursion crossing the below-source subsystem near-resonance through the P-evanescent 190-km mantle layer, e^{+-114}) and the output chaos scales as eps x stepCancel x O(1-40) — DD (1e-32) is consumed exactly (measured: the 1-ulp gate passes at 0.80/km with step-cancel 2.8e26, fails O(1) at 0.70/0.73/0.76 with 5e30-8e31), while quad-double leaves a step error ~8e-33 and output noise far below the gate. Then the locator/series agenda re-opens on the resolvable field. Production opts.psv stays BLOCKED',
    context: 'v14 (2026-09-12, DD arithmetic batch): the v13 registered cure SHIPPED — tools/broadband/psv-dd.js re-evaluates the whole Schur chain in double-double arithmetic (Dekker/Knuth primitives without FMA; nuOf, the eigenvector halfspace admittance, the expm propagator with the mu* back-transform, the above-source jointly-scaled product, and C = -e^-sigma (Y*Q11 - Q21)^-1; material products are exact two-products; the up-leg adds a per-layer propagator normalization that is algebraically free — the admittance recursion is invariant under P -> alpha*P — and removes the e^{+-114} evanescent SCALE of the raw propagators). params.ddCompliance is opt-in; absent = byte-compatible double paths (the frozen series all reproduce). Gate verdict (ddArithmeticArm, live): PASS at k = 0.80/km (1-ulp chaos -76% -> 2.9e-5% on the integrand) and the control band at DD-noise level (1e-13%, cross-path agreement 1.2e-11 relative); FAIL at k = 0.70/0.73/0.76 (O(10-600%) at 1 ulp). The new named blocker is measured by the upLegStepCancellation diagnostic: the first up-leg step dets det(P22 - Y*P12) carry cancellation ~5e30-8e31 at 0.70-0.76/km (vs 1.7 at 0.40 and 2.8e26 at 0.80) — the admittance recursion crosses the below-source subsystem near-resonance while the P wave traverses the 190-km mantle layer EVANESCENTLY (k > omega/vp there: nu_A ~ i*6e-4/m over 190 km = e^{+-114} of dynamic range that the raw propagator carried and the per-layer normalization removed as SCALE but the structural near-singularity remains). The output chaos scales as eps x stepCancel x O(1-40): DD (1e-32) is consumed exactly; the registered cure is quad-double arithmetic (eps ~ 1e-64 -> step error ~8e-33, output noise far below the 1e-12 gate, margin orders). Batch engineering record: two real bugs caught by the cross-checks on the way — a cdd/dd primitive mix-up in the lamC imaginary part (nested-array NaN) and m4maxabsDD initialized at the COMPLEX zero (poisoning every ddToNumber comparison; the manual-loop cross-check that "validated" it was itself swallowing NaN — NaN comparisons are always false, the widest lesson of the batch). v13 (2026-09-12, pole-locator feasibility batch): the v12 registered "Schur-chain-native pole LOCATOR" was tested and measured INFEASIBLE, with the decisive discriminator upgraded from the v10 1e-5/km-offset continuity check (7 orders too coarse) to a 1-ULP ladder: a real resonance of any width moves by ~(ulp/gamma)^2 ~ 0 at ulp-scale k offsets, so O(1) swings are roundoff chaos. Measured (chaosDiagnosis, live): control k=0.40/km — integrand and compliance bit-stable through 1e7 ulp (full stable digits); crest k=0.70/0.73/0.76/0.80/km — integrand swings -89%..+1203% at ONE ulp, compliance C 15-567%, at dh 0.5 AND 32 m and every source depth (73/30/surface). Mechanism: detM sits at ~1e-16 of |M|^2 in the crest band (cond(M) ~ 1e16) — the 2x2 determinant cancellation noise IS the output scale; the Schur up-leg recursion stays smooth (v11) but its output inherits the floor, which also sinks the detM dip landscape below k~0.65 (bucket minima -6.1 -> -39.5 log units, decorrelating at 0.002/km, a -690 cancellation needle at 0.900) — the structural root cause of the v12 "candidates mislocate". The frozen fit table was further demoted: the top fit (cand 0.6173) is SINGLE-SAMPLE ANCHORED (gamma0 = 0.11/km garbage width spreads its 12 ladder samples over 0.18-1.50/km; one lands on the crest at 3.67e7 amid a 1e4-1e5 background — rel 0.02 reflects that sample, not local cleanliness), and the weight profile shows the band weight 1e4-1e5 generic [0.3,0.65], 1e7-1e8 crest [0.70,0.82], dead beyond 0.95 (the v4-era 1.005/km "basin-trapped fundamental" carries ~1e-8 here — nothing). Series consequence (seriesDhSensitivity, live): with dh (the FD stencil) as a pure noise-realization knob (truncation ~4e-3 relative at 64 m), the fullTensor series moves 194/266/44.9/28.4/6.6 across dh 0.5/2/16/32/64 at dk0.02 — 30x with NO pinning; no truncation-safe dh converges (dh0.5 non-monotone 3.5, dh2 9.1, dh16 1.4 non-monotone, dh32 monotone-declining broken by dh64 and by the dk0.00025 extension 16.61 -> 8.65) — every frozen series value on this config is noise-integral dominated and none is interpretable as signal. The registered cure moves to compensated (double-double) arithmetic across the Schur compliance path, acceptance-gated on the 1-ulp discriminator flipping to bit-invariance. v12 (2026-09-11, det-subtract batch): the v11 registered cure SHIPPED — psvPoleModelFit fits each modal pole as A/(k-kp)+B per channel on real-axis samples (2-param Nelder-Mead x both Im-kp signs over a +-8*gamma0 ladder, conjugated complex LS with one 4x-median outlier pass; complex-k Newton on either chain determinant measured infeasible: the Schur up-leg admittance step det crosses zero AT the modal poles so complex evaluations null around every hunt point, the raw cascade det Newton was the registered v4 failure), params.detSubtract drops the fitted poles windows, subtracts at sample time and re-adds the exact principal-branch complex-log integrals over the lattice interval; failed fits keep their windows; absent param byte-compatible (tripwired). Self-test: closed-form A/(k-kp)+B+C e^{-lam k} recovered to 1.7e-9 position, subtract-and-re-add integrates a deliberately under-resolved pole (0.77 samples per gamma width) to 2.6e-5 where the plain trapezoid fails 12-14%. Production verdict: NOT curative yet — fullTensor-subtracted 231.77/231.77/231.77/532.96/770.39/803.88 at dk 0.02->0.0005 (monotone RISING below the alias floor, below-floor spread 1.51, unconverged), deviatoric 1.65/2.29/1.29/1.20e-2 unmoved. (An interim "decelerating then crashed" reading and an interim "v11 freeze stale" claim both came from side scripts of this batch, which passed the AZIMUTH-ROTATED full tensor while the frozen protocol is UNROTATED — both retracted; the frozen schur series 194.41/523/680/541 reproduces at committed code through this probe.) The fit table is the batch real finding: the MGS ridge-detector candidates mislocate the resonances (0.1662 rel 0.61 fail; 0.5264/0.5474 rel 0.74-0.76 fail; 0.5943->0.701, 0.6173->0.732, 0.8025->0.755, 0.8286->0.770, 0.8720->0.804, 0.9139->0.876, 0.9363->0.865 — every successful fit slid into the 0.70-0.88 narrow thicket, |A| up to 1e2, gamma 8e-4..4.5e-3/km, 7 models kept after gate+dedupe). The per-candidate rel table came from the crest-det-subtract.js driver (rotated-tensor protocol); pole POSITIONS are tensor-robust - the probe frozen unrotated poleModelSet kept the same 0.70-0.88 thicket (7 models, frozen below). The frozen schur and legacy series were re-verified live at committed code this batch. v10 (2026-09-10, crest-noise batch) diagnosed the leaky-P crest band at SAMPLE level on the frozen v9 config and retired the whole in-chain FD cure family: (1) the legacy series reproduced the v9 freeze bit-exactly (28.092/28.092/44.3618) — the baseline is stable; (2) a continuity discriminator proved the band spikes are CHAIN NOISE, not physical resonances: controls at 0.44/0.46/km are continuous to 0.1% at k-offsets of 1e-5/km while crest samples swing 1.4-15x at the same offset — 500x NARROWER than the physical resonance-width floor k/(2Q) = 0.005/km at qP = 50; (3) the mechanism is the depth finite-difference: dC = (Cdn - Cup)/(2*dh) amplifies the near-degenerate band residual-direction noise by 1/(2*dh) — enlarging the stencil collapses the spikes monotonically (0.5295/km: 4.26e6 -> 4.7e-1 of itself across dh 0.5 -> 20 m) while controls are dh-invariant, and the compliance magnitude |C| stays smooth (4.7e-8) while the integrand spikes — the wild factor lives only in the depth-gradient channels; (4) cure gen-1 (adaptive-stencil agreement search, dhAdaptive) collapsed the spikes 5-120x and dropped the series from 28-55 to 2.6-12.3 but stayed non-convergent (spread 3.7; the two-consecutive-agreement exit is fooled by correlated noise); cure gen-2 (Richardson pair D(2h) - D(h), exact cancellation for arm-independent rounding) left the spikes untouched — proving the noise is a DETERMINISTIC (k, z, dh)-joint wild function of the chain, not additive rounding; (5) verdict: the in-chain FD cure family is retired; the degenerate band needs an independent representation (per-layer Schur admittance; the v6 prototype up-leg was stable, down-leg NaN is the named blocker). Production opts.psv stays BLOCKED. v9 (2026-09-09, R3 opening batch) re-measured the full series on the mu*-corrected halfspace admittance (R10 damped cross-check fixed psvEigenvectors traction rows at a measured 1.4% halfspace-convention error): the fullTensor below-floor series changed character from erratic non-monotone collapse (54.2/58.9/21.3/7.3 on the defective admittance) to a CLEAN MONOTONE DIVERGENCE (28.1 -> 44.4 -> 50.2 -> 54.6 at dk 0.002 -> 0.0005) while deviatoric stays converged (spread 1.055 < 1.1) — the crest-band OPEN is re-confirmed on a trustworthy baseline and the full-space anchor still passes (maxResidual 0.062 <= 0.08), so the residue/Schur-admittance cure remains the registered blocker for production opts.psv; v8 (cap-closure batch) executed the registered subdivide-cap study and measured it NEGATIVE (cross-cap fullTensor values disagree without monotone convergence at caps 2/4/6/10/30) - the blocker is the leaky-P crest representation itself, not discretization; v7 (delta-matrix batch) landed the MGS-orthonormalised chain and fixed two real bugs the batch cross-checks exposed: the first-cut triMul triangular product dropped the j > i cross terms (caught by the R2 RK4 anchor at 3.3e-2 BEFORE any freeze; the interim "fullTensor converges at 0.0077" measurement was this bug suppressing the dipole channels and is retracted), and the v6 propagator back-transform used the real muR where the complex mu* is required (undamped paths bit-identical); deviatoric series converge at the production cap at the v6 raw-chain scale; fullTensor stays OPEN on cap-dependent crest resolution; v6 (Rc-inversion batch) found the registered scale-invariant inversion inapplicable (det small by physics) and fixed the v4 expm layer-Q loss (complex moduli, nuOf-exact convention); detector on the surface-source det(Rc) dip scan; branch-point resolution rings; v5 froze qp-default + compliance-ridge detector + window-continuity fix; v1 froze blocked_pending_source_calibration (21.3x hot factor); v2 froze fullspace_anchored_layered_poles_open (source anchor fixed 3 missing/1 wrong-column dipole terms + traction/dipole -1 + razor band-nulling); v3 replaced residues with gamma-resolved windows and found the Bessel-aliasing root cause; v4 closed the root-tracking gap (expm propagator, joint-scalar chain, 2D Newton) but misattributed the remaining series drift to an integrable branch-tail cusp; v5 (branch-cusp batch) measured the actual mechanisms: bounded layered compliance (v4 cusp retired), true cusps only on the fullSpace path (analytic subtraction landed there, references moved to xi-substitution), undamped-P leaky poles on the real axis (qP <- qShear default), a dead det scanner replaced by the compliance-ridge detector, and a window-ring continuity bug fixed',
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
      v11verdict: 'fullspace_anchored_layered_compliance_adjudicated_schur_validated_band_quadrature_full_tensor_open',
      v12verdict: 'fullspace_anchored_layered_schur_validated_pole_subtraction_shipped_but_series_open_candidates_mislocate',
      v13verdict: 'fullspace_anchored_layered_schur_validated_locator_infeasible_zero_stable_digits_series_noise_dominated',
      v14verdict: 'fullspace_anchored_layered_schur_validated_dd_landed_gate_partial_step_cancel_5e31_quad_double_registered',
      v14note: 'DD machinery shipped opt-in (params.ddCompliance) and validated (control-band cross-path agreement 1.2e-11; timing ~5 ms/eval vs 1.5 ms double); the 1-ulp gate passes at 0.80/km and fails at 0.70/0.73/0.76 — the NEW named blocker is the up-leg step-det cancellation ~5e30-8e31 (P-evanescent mantle traversal + below-source near-resonance), registered cure = quad-double (eps 1e-64, step error ~8e-33). PITFALL RECORDED: a NaN-swallowing cross-check (NaN comparisons always false) briefly "validated" a broken m4maxabsDD — when a comparison-based check passes suspiciously easily, test it against a known-bad input first',
      v13note: 'the pole-locator agenda is CLOSED-NEGATIVE with a decisive discriminator (1-ulp chaos, zero stable digits at the crest band, all depths, all truncation-safe dh); the series values are noise-integral dominated (dh realization moves them 30x, no pinning) — no signal-level series reading exists on this config. Registered cure: double-double arithmetic across the Schur compliance path, gated on the 1-ulp discriminator flipping to bit-invariance; the v10 "in-chain FD cure family retired" conclusion extends to FIXED large-dh stencils (never series-tested before this batch)',
      v12note: 'subtraction machinery validated (2.6e-5 closed-form) and shipped opt-in (params.detSubtract, byte-compatible off); series unmoved; named blocker moved to the pole LOCATOR (psvModalPoles candidates mislocate the Schur integrand resonances 0.1-0.2/km). PITFALL RECORDED: the batch side-scripts measured the ROTATED full tensor and briefly misread the frozen series as stale — the probe protocol is UNROTATED; always replicate the freeze protocol exactly before claiming non-reproducibility',
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
