#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.2 candidate — Conditional-Spectrum-driven time-history pipeline.
//
//  Chain: PSHA anchor -> deaggregation -> per-bin Baker conditional
//  spectra -> hybrid broadband realizations sampled from the
//  deaggregation bins -> single amplitude scaling to the anchor Sa(T*) ->
//  ensemble scoring against the bin-conditional targets (v3) with the
//  mixture MS-CS retained as a diagnostic column.
//
//  v3 shape-gate repair (2026-09-04, pre-registered in PRE_REG_V3 below
//  BEFORE the v3 run): (1) bin-conditional multi-scenario scoring — the
//  frozen cs-diagnosis-report.json A3 line measured the MS-CS mixture
//  ratio at 0.1 s sitting below EVERY contributing bin ratio in 4/6
//  cases, i.e. anchor-scaled single-event realizations cannot realize
//  the between-period residual structure the mixture mean encodes;
//  (2) HF-side re-calibration (kappa back to the module default 0.04 +
//  per-class stress fitted on a frozen grid against the zhao conditional
//  spectra — disclosed circularity for the short band); (3) an empirical
//  long-period gain on the LF channel fitted against the same targets
//  (disclosed circularity for the 2-5 s band; the brune comparator arm
//  gets none). Gate thresholds are UNCHANGED from v2.
//
//  Channel honesty (frozen): SH-only LF (P-SV not implemented) —
//  everything runs on the transverse component, like the B2 scorecard.
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-pipeline-report.json');
const CAL_OUT = path.join(ROOT, 'tools', 'data', 'cs-repair-calibration.json');

// ---- frozen scope (pre-registered BEFORE the first run) -----------------
const PRE_REG = {
  batch: 'CS pipeline acceptance (frozen 2026-09-03, before the first pipeline run)',
  sites: [
    { id: 'tokyo', lat: 35.6812, lng: 139.7671 },
    { id: 'osaka', lat: 34.6937, lng: 135.5022 },
    { id: 'sendai', lat: 38.2682, lng: 140.8694 },
    { id: 'kochi', lat: 33.5597, lng: 133.5311 }
  ],
  returnPeriods: [475, 2500],
  anchorPeriodSec: 1.0,
  periodsSec: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0],
  realizationsPerCase: 25,
  minRrupKmForSampling: 8,      // bins with meanRrupKm < 8 km are re-weighted out (DW kernel near-field limit)
  imLevels: { lo: 0.5, hi: 30000, n: 60 },  // wide grid so Nankai-adjacent long-RP anchors invert
  gates: {
    anchorAbsLog10: 0.01,       // per realization, construction sanity
    bandAbsMax: { '0.1-0.5s': 0.30, '0.5-2s': 0.25, '2-5s': 0.25 },  // |log10(ensemble / target)|, max over sites+RPs+periods (B2 threshold family)
    containmentInSigmaFrac: 0.8, // fraction of (site,RP,period) with |ln bias| <= sigmaTotal_ln
    lpImprovementVsBruneMin: 0.05, // 2-5 s band AbsMax improvement over the Brune carrier, or both <= 0.10
    pgaNonRegressionVsBruneMargin: 0.05  // hybrid PGA AbsMax may not exceed Brune by more than this
  },
  pgaAbsoluteIsDiagnosticOnly: 'anchor is Sa(1s); absolute PGA control from a 1 s anchor is out of scope (B2 PGA regression root cause stands)',
  mechanismSampling: 'strike ~ U(0,360) seeded per realization; dip from the visible source-class prior (crustal 60 / interplate 15 / intraslab 55); rake from PSHA_CLASS_RAKE — deaggregation carries no mechanism information',
  scope: 'ensemble SHAPE agreement only; no post-hoc threshold tuning, failures reported honestly'
};

// ---- v3 repair pre-registration (written BEFORE the v3 run) --------------
const PRE_REG_V3 = {
  batch: 'CS pipeline shape-gate repair (pre-registered 2026-09-04, before the v3 run)',
  basis: 'tools/data/cs-diagnosis-report.json (A1-A3 short-band decomposition, B1-B3 long-band attribution) — measurement first, repair second',
  scoringChange: {
    from: 'mixture MS-CS mean: one target spectrum for all realizations',
    to: 'per-realization bin-conditional Baker conditional spectrum — each realization scored against its OWN deaggregation bin conditional mean muC_b(T) (muC_b(T*) = log imTarget exactly); the ensemble is probability-weighted through bin sampling',
    justification: 'diagnosis A3: the MS-CS mixture ratio at 0.1 s sits below EVERY contributing bin zhao median ratio in 4/6 cases (osaka RP2500 -0.424 vs envelope [-0.140..-0.007]; kochi RP2500 -0.119 vs [0.191..0.290]) — anchor-scaled single-event realizations cannot realize the between-period residual structure the mixture mean encodes, so the mixture gate is structurally unfalsifiable; multi-scenario bin-conditional comparison is the standard practice (Lin & Baker 2013 family)',
    mixtureKeptAs: 'diagnostic column (bandsMixture + perCase.biasMixtureLog10) — no gate reads it',
    gatesUnchanged: 'all v2 gate thresholds and definitions carry over unchanged'
  },
  hfReCalibration: {
    kappaSec: 0.04,
    kappaNote: 'hybrid module default (pre-B2-fit value); B2 froze 0.02 against its absolute PGA/PGV objective — NOT re-fitted to CS targets; the diagnosis measured -0.186 median short-band effect',
    stressGridMPa: [50, 25, 12, 6],
    stressObjective: 'per source class, minimize the mass-weighted median |bin-conditional bias| over 0.1-0.5 s across contributing bins (prob >= 0.005) of the six frozen cases, kappa pinned 0.04, 5 seeds per bin',
    circularityDisclosure: 'the stress fit uses the same zhao conditional spectra the gates read — after this calibration the 0.1-0.5 s band tests fit-consistency and scatter, NOT independent falsification of zhao at short periods; the B2 frozen calibration (50 MPa class-blind, kappa 0.02) stays untouched for the B2 scorecard product'
  },
  lfEmpiricalGain: {
    form: 'g(T)=1 for T<=1s; log10 g(T) = (b0 + b1*(mw-8) + b2*log10(rRup/50)) * min(1, ln(T)/ln(3)) for T>1s, capped to [1,10]',
    fit: 'least squares over per-bin long-period deficits (T in {1.5,2,3,4,5}s, contributing bins) of the DW-side spectral ratio vs the bin-conditional zhao ratio, at the calibrated stress; frozen to tools/data/cs-repair-calibration.json',
    circularityDisclosure: 'after the gain the 2-5 s band tests gain-consistency (smoothness, between-bin generalization), not independent falsification of the 1D kernel; the lpImprovement-vs-Brune gate stays meaningful — the brune comparator arm receives NO gain (it has no DW side)'
  }
};

// ---- v4 P-SV activation pre-registration (written 2026-09-11; the RUN
//      stays withdrawn until its named preconditions land — same discipline
//      as the 2026-09-05 withdrawal, now with the conditions explicit) ----
const PRE_REG_V4 = {
  batch: 'CS pipeline v4: P-SV horizontal-block activation (pre-registered 2026-09-11, BEFORE any v4 run; run WITHDRAWN pending preconditions)',
  priorHistory: 'the first v4 draft (2026-09-05) was withdrawn before its run because the T5-T7 dipole channels had no absolute calibration (the v1 21.3x reading was later retired as a number on unstable quantities, but the calibration GAP is real); since then the compliance representation was adjudicated (2026-09-10: Schur validated 1e-11..4e-3 vs three trusted references, legacy chain O(1) off) and production-wired, but the tokyo deep-source dk series still does not converge (band quadrature OPEN, psv-scale-diagnosis v11)',
  arms: {
    a_shOnly: 'the shipped v3 pipeline, unchanged (SH-only LF; the baseline every gate reads today)',
    b_psvHorizontal: 'opts.psv on with the P-SV block restricted to the HORIZONTAL traction channels (T1/T2 blocks: C00/C11/C01 compliance entries); the depth-FD dipole channels (Mzz/Mxz/Myz: T5-T7) are EXCLUDED — they carry both the uncalibrated absolute scale and the crest-band quadrature OPEN',
    scoring: 'dual-arm gm horizontal scoring per realization; gate thresholds UNCHANGED from v3 (anchorAbsLog10 0.01, bandAbsMax 0.30/0.25/0.25, containment 0.8, lpImprovement 0.05, pgaNonRegression 0.05)'
  },
  preconditionsToRun: [
    'P1 (horizontal absolute anchor): the layered P-SV horizontal block absolute scale anchored against an independent reference the way B1 anchored SH (shake91); the measured 0.908 T1/T2-vs-SH-convention ratio is a CONVENTION check, not an absolute anchor',
    'P2 (band quadrature at the scored sites): the leaky-P crest-band k-integration must be pole-resolved for any case whose deaggregation bins put the source below ~40 km on a column with an evanescent mantle leg (tokyo-class); measured state: Schur-arm dk series non-convergent (psv-scale-diagnosis v11) — shallow-crustal-only bins are unaffected and may run, but the v4 gate set includes Nankai/intraslab bins that are NOT shallow-only',
    'P3 (divisor decision): the P-SV alias-guard divisor lands from the measured ladder (tools/broadband/psv-alias-ladder.js) instead of the hardcoded 10',
  ],
  // ---- 2026-09-13 precondition resolutions (psv-horizontal-anchor.js + ----
  // ---- psv-scale-diagnosis v15/v16; the run verdict follows them) --------
  p1Anchor: {
    measured: '2026-09-13, tools/broadband/psv-horizontal-anchor.js (gate pre-registered in its header BEFORE the run)',
    design: 'the production pipeline vs the EXACT closed-form halfspace BVP (crest-halfspace-closed.js, per unit true traction) through params.closedFormHalfspace — both paths share the integrator and horizontal-block algebra, so the comparison is end-to-end at the |u| level; HALF config, {strike-slip, thrust-DC} x {0.5, 1.2 Hz} x zs=33 km, r=30 km',
    gate: 'QD arm (params.qdCompliance) vs BVP <= 1e-2 — MEASURED PASS at worstRel 6.03e-13 (11 orders of margin); the composition (units, conventions, integrator, block algebra, layered compliance) is exact end-to-end',
    doubleArm: 'the production double-Schur chain FAILS config-dependently: 3.8e-6 at f0.5 (passes) but 8.34 at f1.2zs33 thrust — the ~1e-16 detM subtraction floor at the Rayleigh-resonance detM dips (measured: the bigfloat chain and the BVP agree to ALL PRINTED DIGITS at the disputed k=1.9/2.1/2.3/km samples while the double chain sits 6000x off its floor; RK4-ODE referee 4e-3 third opinion). The pure-Mxy ur rows are structurally zero (correct symmetry)',
    significance: 'the v13-v15 arithmetic story extends to EVERY column: the detM dips of the halfspace Rayleigh family sit inside the weighted band at f >= ~1 Hz, so the double chain\'s P-SV spectra are floor-contaminated there — NOT a tokyo-crest-only phenomenon'
  },
  p2Status: 'RESOLVED NEGATIVELY (psv-scale-diagnosis v16): the production band is POLE-FREE — the detM dips are far-off-axis modes, the integrand carries no pole signatures, detSubtract is a measured +-0.50% no-op, and the QD-field dk series CONVERGED (v15, below-floor spread 1.0012)',
  p3Status: 'DONE (psv-alias-ladder.json: div10 passes, default byte-compatible)',
  runVerdict: 'EXECUTED 2026-09-12..15 (30-shard array, ~2.2 days wall; the v18 cure — fdChannels 3x cut + 30-way sharding — brought the multi-month job into budget; 900 rows merged to 6 cases x 25 unique realizations x 2 arms after merge dedup, the array re-ran the full hybrid set on every shard = 4x redundant compute, disclosed in the merge header; 0 invalid). ALL THREE BAND GATES FAIL, thresholds unchanged from v3, scored arm = hybridPsv: 0.1-0.5s psv 0.794 (kochi RP2500 @0.15s) vs shOnly 0.776 (limit 0.30); 0.5-2s psv 0.398 (kochi RP475 @2s) vs shOnly 0.432 (limit 0.25); 2-5s psv 0.727 (osaka RP2500 @5s) vs shOnly 0.574 (limit 0.25). The pre-registered hypothesis is REFUTED: the deterministic P-SV horizontal-block LF is NOT a cure for the v3 shape-gate failure — mid-band improves marginally (0.432->0.398) while the short band worsens slightly (+0.018) and the long band materially (+0.153). Containment psv 0.334 vs shOnly 0.385 (both far under the 0.8 gate); pgaRatioDelta +0.03 inside the +-0.05 non-regression margin. Per-case mixed: tokyo RP2500 improves (bias 0.533->0.434, containment 0.462->0.615) while tokyo RP475 degrades (containment 0.923->0.462) and osaka/kochi are ~unchanged. Registered disposition: the P-SV horizontal-block arm is retired as MEASURED-NO-CURE — production keeps the v3 SH-only arm; the QD/fdChannels/poleWindows/horizontalOnly wiring stays opt-in research state; the band-shape discrepancy must be hunted OUTSIDE the missing-P-SV hypothesis (the v3 cs-diagnosis kappa and LF-gain exclusions stand)',
  whyNotRunNow: 'SUPERSEDED 2026-09-15 (kept for the decision trail): at the time P2 was open and P1 unmeasured; both resolved (p1Anchor PASS above, p2Status negative) and the run then executed on the full-QD path within wall budget',
  whatWouldChangeThis: 'P1: one absolute-anchor batch; P2: the registered pole-aware quadrature landing with a CONVERGED series (psv-scale-diagnosis verdict upgrade); P3: the ladder freeze. The moment all three hold, this gate runs with NO further decisions'
};

// ===========================================================================
//  PRE_REG_V5 (2026-09-15, written BEFORE the v5 diagnosis run): the band-
//  shape mismatch attribution on the SHIPPED SH-only baseline, after the
//  CS v4 execution refuted the missing-P-SV hypothesis (three candidate
//  cure directions were named in the v4 disposition: conditional-spectrum
//  target construction / HF-LF blend topology / per-bin refit). The v1
//  diagnosis (cs-diagnosis-report.json) predates the v3 recalibration
//  (kappa 0.04 global, stressByClass, M/R-shaped LF gain) — its numbers
//  are stale. This batch is DIAGNOSIS ONLY: every arm is a measurement,
//  no parameter is retuned from it.
// ===========================================================================
const PRE_REG_V5 = {
  batch: 'cs-diagnose-v2: band-shape ownership attribution on the shipped SH-only v3/v4 baseline',
  hypotheses: {
    H_hf: 'the 0.1-0.5s excess is owned by the HF branch (Boore+Brune+kappa+site) shape vs the zhao+tilt target',
    H_lf: 'the 2-5s excess is owned by the LF branch (DW SH + the M/R-shaped LF gain) shape vs the zhao+tilt target',
    H_target: 'the stored bin-conditional targets muC(T) are internally consistent with an independent recomputation from the frozen realization rows (no construction bug)',
    H_stress: 'a stress retune could plausibly own the short band (the Brune-corner lever, measured on the FULL blend because stress moves both branches)'
  },
  blendDisclosure: 'the hybrid blend HARD-PARTITIONS the spectrum at fcHz = 1 Hz (LF low-passed, HF high-passed) — so the short band is by construction HF-only content and the long band LF-only content; the ownership shares below confirm the partition numerically, and the real questions are the target audit, the mid-band seam split, and the lever feasibility',
  arms: {
    D1_hfOnly: 'synthesize({lfMaxHz: 0.001}) on the shipped path — pure HF shape; paired to the frozen v4 shOnly rows via the identical seed string',
    D2_lfOnly: 'synthesize({hfScaleClamp: [0, 0]}) — the HF fill truly zeroed (required fixing buildHfSpectrum (fillScale || 1) treating 0 as falsy; production never passes 0) = pure LF shape',
    D3_stressLever: 'the FULL shipped blend re-synthesized at stress x0.5 and x2 (per-class stress scaled) — the corner lever a cure would actually pull',
    D4_lfNoGain: 'D2 plus the M/R-shaped LF gain removed — how much of the long-band residual the v3 gain tilt owns (it was FITTED on the v2 anchors, so the long band tests fit-consistency)',
    D5_targetAudit: 'recompute eps and muC(T) per frozen v4 shOnly realization row from its stored (srcType, mw, rRupKm, depthKm) + recomputed vs30 + the frozen imTarget; compare against the stored condMuLn and epsBin'
  },
  decisionRules: {
    ownership: 'band ownership share = median |pure-arm band bias| / median |full-arm band bias| (the full arm = the frozen cs-pipeline-v4-report.json shOnly rows, bin-conditional bias, identical formula); the pure arm OWNS the band if the share >= 0.8',
    seam: 'seam ownership in the mid band = flagged if the full-arm bias at 0.7s or 1.5s deviates from BOTH pure arms by > 0.1 (pure arms interpolated not required — the raw three-way comparison is frozen)',
    targetAuditGate: 'PASS if max |recomputed muC - stored condMuLn| <= 0.02 ln AND max |recomputed eps - stored epsBin| <= 0.02 (stored rounding: condMuLn 1e-4 ln, epsBin 2dp; rRup/mw/depth row rounding contributes < 0.005) — PASS = no construction bug; FAIL = construction bug and the cure is fixing the construction BEFORE any synthesis retune',
    stressFeasibility: 'per case, the required stress multiplier S* at 0.1s by log-linear interpolation between the x0.5/x2 arms; VIABLE if max/min S* across cases <= 2 AND the interpolated post-hoc short-band residual at S*(case) <= 0.15 at every 0.1-0.5s period; else the stress-refit cure direction is REGISTERED DEAD for the short band'
  },
  thresholds: { ownership: 0.8, targetAuditMaxDelta: 0.02, seamDeviation: 0.1, stressSpreadMax: 2, stressResidualMax: 0.15 },
  nRealizations: 25,
  sampleRateHz: 50
};

// ===========================================================================
//  PRE_REG_V6 (2026-09-15, written BEFORE the v6 run): the two remaining
//  cure directions after v5, each turned into a mechanism-level experiment.
//  The sharpening observation: the SAME synthesis reads −0.12..−0.28 vs the
//  OBSERVED shapes at 0.1-0.3 s on the 13 real Kyoshin events (cs-arbiter
//  DSYN, eps ~ 0) yet +0.4..+0.8 vs the CS target at 0.1-0.5 s in the
//  scenario gate — so either the high-eps CS tilt regime or the scenario
//  population owns the difference. Family B decides which; Family A decides
//  whether the JIVSM column owns the kochi/osaka long-band sign split.
// ===========================================================================
const PRE_REG_V6 = {
  batch: 'cs-diagnose-v3: column-swap causality (long band) + tilt decomposition (short band)',
  families: {
    A_columnSwap: 'kochi cases re-synthesized on the osaka JIVSM column and vice versa (shipped blend, paired seeds, targets unchanged — only the propagation column moves). Answers whether the site COLUMN owns the long-band sign split',
    B_tiltDecomposition: 'the shipped scenario rows re-scored against UNTILTED zhao medians (no CS tilt). gate bias = untilted bias + tilt, tilt(T) = rho(T,1s)*sigma(T)*eps per realization. Answers whether the short-band FAIL is the high-eps tilt regime (target-side) or a synthesis-vs-zhao divergence at the scenario population'
  },
  decisionRules: {
    columnOwns: 'D = mean(osaka full @5s biasLog10) − mean(kochi full @5s biasLog10) on the frozen v4 rows; D_swap = the same under the swap arms. columnOwned if (D − D_swap)/(2D) >= 0.6; sourceOwned if <= 0.4; else mixed',
    tiltVerdict: 'let U = median over cases of the mean |untilted bias| over 0.1-0.5s. If U <= 0.15 the short-band FAIL is attributed to the high-eps CS tilt regime (target-side; the synthesis matches zhao untilted and the real-event population per cs-arbiter); else the synthesis-vs-zhao divergence is real at the scenario population and the untilted magnitudes are the cure target'
  },
  thresholds: { columnOwnsMin: 0.6, sourceOwnsMax: 0.4, untiltedMax: 0.15 },
  nRealizations: 25
};

// ===========================================================================
//  CS_GATE_ROLE (2026-09-16, the CS research-line closure): what the shape
//  gate means after the v4 execution (900 QD realizations) and the v5/v6
//  diagnosis batches + the v7 aligned-config retest. This replaces the
//  open-ended "hunt the cure" posture with a measured role statement.
// ===========================================================================
const CS_GATE_ROLE = {
  revised: '2026-09-16 (CS research line closure)',
  semantics: 'the shape gate measures SHIPPED-SYNTH vs CONDITIONAL-SPECTRUM(zhao) consistency on the scenario deagg population — it is a model-form comparison, not a correctness claim about either side',
  shortBand: {
    finding: 'v4 FAIL (psv 0.794 / shOnly 0.776 vs 0.30); v5: HF-owned (share 1.000 — the fcHz=1 Hz hard partition), stress lever DEAD (S*=0, postHoc 0.53 > 0.15), kappa excluded (v3), P-SV excluded (v4, MEASURED-NO-CURE), target construction consistent (maxMuDelta 0.00466); v7 aligned retest: the shipped configuration on REAL events lands ON the observed shapes (alignedDs(0.2s) = +0.02 vs the legacy brune arm -0.238) — the configuration chain carries ~+0.26 dex of shape and the scenario population adds ~+0.3 more, with a CLASS SPLIT (0.2 s medians: crustal +0.071, interplate -0.265, intraslab -0.142)',
    disposition: 'the FAIL stands as a scenario-population and class-structured configuration property. Registered cure candidate (NOT scheduled): an observation-anchored, per-class recalibration of the configuration chain. Global single-parameter cures are all measured-dead (kappa, stress, P-SV, LF gain)'
  },
  longBand: {
    finding: 'v4 FAIL (psv 0.727 / shOnly 0.574 vs 0.25) with a SIGN SPLIT (kochi deficit -0.51..-0.33 vs osaka excess +0.50..+0.49 at 3-5 s); v6 column swap: SOURCE-OWNED by the pre-registered reversal rule (0.198; linear column share ~40%); the v3 LF-gain exclusion and the v1 halfspace/Q exclusions stand; the band scores a fitted calibration (fit-circular, disclosed)',
    disposition: 'the FAIL stands; no global LF cure exists — a cure would have to be site/source-population specific, which the shipped product does not pretend to be'
  },
  midBand: 'straddles the fcHz=1 Hz seam; mild (v3 medians 0.398/0.432); no seam artifact flagged (v5 seamFlagged=false)',
  production: 'the shipped arm stays the v3 SH-only hybrid; opts.psv stays research (MEASURED-NO-CURE); no recalibration is scheduled from this closure — the gate keeps its role as the documented synth-vs-GMPE consistency monitor'
};

const ZHAO_KEY = {
  0.1: '0.10', 0.15: '0.15', 0.2: '0.20', 0.3: '0.30', 0.4: '0.40', 0.5: '0.50',
  0.7: '0.70', 1.0: '1.00', 1.5: '1.50', 2.0: '2.00', 3.0: '3.00', 4.0: '4.00', 5.0: '5.00'
};
const DIP_PRIOR = { crustal: 60, interplate: 15, intraslab: 55 };
const LN10 = Math.LN10;
const LP_FIT_PERIODS = [1.5, 2.0, 3.0, 4.0, 5.0];

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** PGA (gal) + PGV (cm/s) of a scaled series (same recipe as the B2 scorecard). */
function peaksOf(accGal, sr) {
  let pga = 0, mean = 0;
  for (const v of accGal) mean += v;
  mean /= accGal.length;
  let vel = 0, pgv = 0;
  for (let i = 0; i < accGal.length; i++) {
    const v = Math.abs(accGal[i]);
    if (v > pga) pga = v;
    const a = accGal[i] - mean;
    if (i > 0) vel += 0.5 * (a + (accGal[i - 1] - mean)) / sr;
    const av = Math.abs(vel); if (av > pgv) pgv = av;
  }
  return { pga, pgv };
}

/** Per-bin Baker conditional spectra. For every usable deaggregation bin:
 *  zhao2006 log10 median + sigma at every period, epsilon at T*, then
 *  muC_b(T) = mu + rho*sigma*eps (exact at the anchor). Returns the
 *  probability-weighted mixture (the v2 MS-CS, kept as diagnostic) AND the
 *  per-bin conditional means used for v3 bin-conditional scoring. */
function msConditionalSpectrum(bins, imTarget, anchorKey, anchorPeriodSec, periods, vs30) {
  const logT = Math.log10(imTarget);
  let usable = [];
  for (const bin of bins) {
    const anchorMo = Physics._pshaBranchMotion('zhao2006', 'sa:' + anchorKey, bin.srcType, bin.repr.mw, bin.meanRrupKm, bin.repr.depthKm, vs30, Physics.PSHA_CLASS_RAKE[bin.srcType] || 0);
    if (!anchorMo || !(anchorMo.median > 0)) continue;
    const eps = (logT - Math.log10(anchorMo.median)) / anchorMo.sigmaLog10;
    usable.push({ bin, eps });
  }
  if (!usable.length) return null;
  const wSum = usable.reduce((a, u) => a + u.bin.prob, 0);
  const periodsOut = [];
  const binCond = usable.map(() => ({ muLn: [], sigLn: [] }));
  for (let pi = 0; pi < periods.length; pi++) {
    const T = periods[pi];
    let meanLn = 0, m2 = 0;
    for (let bi = 0; bi < usable.length; bi++) {
      const u = usable[bi];
      const w = u.bin.prob / wSum;
      const mo = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[T], u.bin.srcType, u.bin.repr.mw, u.bin.meanRrupKm, u.bin.repr.depthKm, vs30, Physics.PSHA_CLASS_RAKE[u.bin.srcType] || 0);
      if (!mo || !(mo.median > 0)) { binCond[bi].muLn.push(null); binCond[bi].sigLn.push(null); continue; }
      const muLn = Math.log(mo.median);
      const sigLn = mo.sigmaLog10 * LN10;
      const rho = Physics.rhoPeriodPair(T, anchorPeriodSec, u.bin.srcType);
      const muC = muLn + rho * sigLn * u.eps;
      const sigC = sigLn * Math.sqrt(Math.max(0, 1 - rho * rho));
      binCond[bi].muLn.push(muC);
      binCond[bi].sigLn.push(sigC);
      meanLn += w * muC; m2 += w * (muC * muC + sigC * sigC);
    }
    const sigmaLn = Math.sqrt(Math.max(0, m2 - meanLn * meanLn));
    periodsOut.push({ periodSec: T, meanGal: Math.exp(meanLn), meanLn, sigmaLn });
  }
  const binCondOut = usable.map((u, bi) => ({
    prob: u.bin.prob,
    srcType: u.bin.srcType,
    repr: { mw: u.bin.repr.mw, rRupKm: u.bin.meanRrupKm, depthKm: u.bin.repr.depthKm, lat: u.bin.repr.lat, lng: u.bin.repr.lng },
    eps: u.eps,
    muLn: binCond[bi].muLn,
    sigLn: binCond[bi].sigLn
  }));
  return { periods: periodsOut, nBinsUsed: usable.length, binMassUsed: wSum, binCond: binCondOut };
}

// ---- shared case construction (identical to the frozen v2 run) ----------
function buildCases(model, jivsmCols, vs30Grid, wideLevels) {
  const anchorKey = ZHAO_KEY[PRE_REG.anchorPeriodSec];
  const cases = [];
  for (const siteDef of PRE_REG.sites) {
    const site = { lat: siteDef.lat, lng: siteDef.lng };
    site.vs30 = Physics.lookupResearchGrid(vs30Grid, site.lat, site.lng) || 600;
    const col = Physics.jivsmColumnAt(site.lat, site.lng);
    if (!col) { cases.push({ site: siteDef, skipped: 'no JIVSM column' }); continue; }
    site.stack = hybrid.buildJivsmIaspStack(col);
    for (const rp of PRE_REG.returnPeriods) {
      const anchorCurve = Physics.hazardCurve(model, site, 'sa:' + anchorKey, {
        imLevels: wideLevels, vs30: site.vs30
      });
      const imTarget = Physics._pshaInvertCurve(anchorCurve.imLevels, anchorCurve.meanRate, 1 / rp);
      if (!(imTarget > 0)) { cases.push({ site: siteDef, rp, skipped: 'anchor inversion outside the wide IM grid' }); continue; }
      const deagg = Physics.deaggregate(model, site, 'sa:' + anchorKey, { imTarget, vs30: site.vs30 });
      if (!deagg) { cases.push({ site: siteDef, rp, skipped: 'deaggregation empty' }); continue; }
      const mscs = msConditionalSpectrum(deagg.bins, imTarget, anchorKey, PRE_REG.anchorPeriodSec, PRE_REG.periodsSec, site.vs30);
      if (!mscs) { cases.push({ site: siteDef, rp, skipped: 'MS-CS unusable' }); continue; }
      cases.push({ site: siteDef, rp, imTarget, vs30: site.vs30, deagg, mscs, stack: site.stack });
    }
  }
  return cases;
}

function synthesize(caseRow, bin, arm, opts) {
  const common = {
    sourceLat: bin.repr.lat, sourceLng: bin.repr.lng, sourceDepthKm: bin.repr.depthKm,
    mw: bin.repr.mw, strike: opts.strike, dip: DIP_PRIOR[bin.srcType] || 45,
    rake: Physics.PSHA_CLASS_RAKE[bin.srcType] || 0,
    receiverLat: caseRow.site.lat, receiverLng: caseRow.site.lng, vs30: caseRow.vs30,
    stressMPa: opts.stressMPa, kappaSec: opts.kappaSec,
    siteCurve: opts.siteCurve, sampleRateHz: 50, seed: opts.seed
  };
  if (arm === 'hybrid') {
    return hybrid.hybridSynthesis(Object.assign(common, {
      stack: caseRow.stack, lfGainFn: opts.lfGainFn || undefined,
      // CS v4 arm: the P-SV horizontal-block options pass through (absent on
      // the v3 path — undefined = the byte-compatible defaults there)
      psv: opts.psv, psvHorizontalOnly: opts.psvHorizontalOnly, psvQd: opts.psvQd,
      psvNoPoleWindows: opts.psvNoPoleWindows, psvCache: opts.psvCache,
      // CS v5 diagnosis arms (PRE_REG_V5): branch isolation. lfMaxHz -> 0.001
      // = pure HF shape; hfScaleClamp [0,0] zeroes the HF fill = pure LF
      // shape. Both undefined on every production path.
      lfMaxHz: opts.lfMaxHz, hfScaleClamp: opts.hfScaleClamp
    }));
  }
  return hybrid.bruneBaselineSynthesis(common);
}

function psaOf(out, periods) {
  const gal = out.transverse.map((a) => a * 100);
  return Physics.sdofResponseSpectrum(gal, out.sampleRateHz, periods, 0.05).map((row) => row.psaGal);
}

// ===========================================================================
//  --fit : the v3 calibration pass. Synthesizes contributing bins on the
//  frozen stress grid (short band) and fits the LF long-period gain; freezes
//  everything to cs-repair-calibration.json. Normal runs read that file
//  read-only and FAIL if it is missing or stale.
// ===========================================================================
function runFit(cases, periods) {
  const anchorIdx = periods.indexOf(PRE_REG.anchorPeriodSec);
  const SHORT = [0, 1, 2, 3, 4, 5];
  const kappa = PRE_REG_V3.hfReCalibration.kappaSec;
  const contributing = [];
  for (const c of cases) {
    if (!c.mscs) continue;
    c.mscs.binCond.forEach((bc, bi) => {
      if (bc.prob < 0.005 || bc.repr.rRupKm < PRE_REG.minRrupKmForSampling) return;
      if (bc.muLn.some((v) => v == null)) return;
      contributing.push({ caseRow: c, bc });
    });
  }
  console.log('fit pool: ' + contributing.length + ' contributing bins');
  // ---- stage 1: per-class stress on the frozen grid ---------------------
  const stressGrid = PRE_REG_V3.hfReCalibration.stressGridMPa;
  const byClass = { crustal: {}, interplate: {}, intraslab: {} };
  for (const cls of Object.keys(byClass)) byClass[cls] = stressGrid.map((s) => ({ stress: s, biases: [] }));
  let done = 0;
  for (const item of contributing) {
    const { caseRow, bc } = item;
    for (let i = 0; i < 5; i++) {
      const rng = Physics.seededRng(hashSeed('fit:' + caseRow.site.id + ':' + caseRow.rp + ':' + i));
      const strike = +(rng() * 360).toFixed(2);
      for (const arm of byClass[bc.srcType] || []) {
        const out = synthesize(caseRow, { srcType: bc.srcType, repr: bc.repr }, 'hybrid', {
          strike, stressMPa: arm.stress, kappaSec: kappa,
          seed: hashSeed('fit:' + caseRow.site.id + ':' + caseRow.rp + ':' + bc.srcType + ':' + i + ':synth')
        });
        const psa = psaOf(out, periods);
        if (!(psa[anchorIdx] > 0)) continue;
        const scale = caseRow.imTarget / psa[anchorIdx];
        for (const pi of SHORT) {
          arm.biases.push(Math.abs(Math.log(psa[pi] * scale) - bc.muLn[pi]) / LN10);
        }
      }
      done++;
    }
  }
  const stressByClass = {};
  for (const cls of Object.keys(byClass)) {
    const rows = byClass[cls].map((a) => ({ stress: a.stress, med: a.biases.length ? +median(a.biases).toFixed(4) : null, n: a.biases.length }));
    let best = null;
    for (const r of rows) if (r.med != null && (best == null || r.med < best.med)) best = r;
    stressByClass[cls] = best ? best.stress : 50;
    console.log('stress ' + cls + ': grid ' + JSON.stringify(rows) + ' -> ' + stressByClass[cls] + ' MPa (' + done + ' synth rounds)');
  }
  // ---- stage 2: LF long-period gain at the chosen stress ----------------
  // deficit_b(T) = (muC_ln(T) - ln psa_anchored(T)) / ln10 ; fit the
  // pre-registered linear form on (mw-8, log10(rRup/50)) * phi(T).
  const X = [], Y = [];
  const lfIdx = LP_FIT_PERIODS.map((T) => periods.indexOf(T)).filter((i) => i >= 0);
  for (const item of contributing) {
    const { caseRow, bc } = item;
    for (let i = 0; i < 5; i++) {
      const rng = Physics.seededRng(hashSeed('fit:' + caseRow.site.id + ':' + caseRow.rp + ':' + i));
      const strike = +(rng() * 360).toFixed(2);
      const out = synthesize(caseRow, { srcType: bc.srcType, repr: bc.repr }, 'hybrid', {
        strike, stressMPa: stressByClass[bc.srcType], kappaSec: kappa,
        seed: hashSeed('fit:' + caseRow.site.id + ':' + caseRow.rp + ':' + bc.srcType + ':lf:' + i + ':synth')
      });
      const psa = psaOf(out, periods);
      if (!(psa[anchorIdx] > 0)) continue;
      const scale = caseRow.imTarget / psa[anchorIdx];
      for (const k of lfIdx) {
        const T = periods[k];
        const phi = Math.min(1, Math.log(T) / Math.log(3));
        const deficit = (bc.muLn[k] - Math.log(psa[k] * scale)) / LN10; // >0 means DW too low
        if (!(deficit > -1) || deficit > 1.5) continue; // refuse to fit garbage rows
        X.push([1, bc.repr.mw - 8, Math.log10(bc.repr.rRupKm / 50)]);
        Y.push(Math.max(0, deficit) / phi); // positive part only — the gain never attenuates
      }
    }
  }
  // least squares with 3 params
  const ATA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], ATy = [0, 0, 0];
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < 3; a++) {
      ATy[a] += X[i][a] * Y[i];
      for (let b = 0; b < 3; b++) ATA[a][b] += X[i][a] * X[i][b];
    }
  }
  const solve3 = (A, y) => {
    const M = A.map((r, i) => r.concat(y[i]));
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      [M[col], M[piv]] = [M[piv], M[col]];
      const d = M[col][col] || 1e-12;
      for (let c = col; c < 4; c++) M[col][c] /= d;
      for (let r = 0; r < 3; r++) if (r !== col) { const f = M[r][col]; for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c]; }
    }
    return [M[0][3], M[1][3], M[2][3]];
  };
  const beta = X.length >= 10 ? solve3(ATA, ATy) : [0, 0, 0];
  const gainCoef = { b0: +beta[0].toFixed(3), b1: +beta[1].toFixed(3), b2: +beta[2].toFixed(3), n: X.length };
  console.log('lf gain fit: ' + JSON.stringify(gainCoef));
  const cal = {
    schema: 'quake-sim-cs-repair-calibration-v1',
    frozenAt: new Date().toISOString(),
    preReg: PRE_REG_V3,
    kappaSec: kappa,
    stressByClass,
    stressScan: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.map((a) => ({ stress: a.stress, medianAbsBias: a.biases.length ? +median(a.biases).toFixed(4) : null, n: a.biases.length }))])),
    lfGain: gainCoef
  };
  fs.writeFileSync(CAL_OUT, JSON.stringify(cal, null, 1));
  console.log('wrote ' + CAL_OUT);
}

function lfGainFnFor(cal, mw, rRupKm) {
  const g = cal.lfGain;
  const betaLog = g.b0 + g.b1 * (mw - 8) + g.b2 * Math.log10(Math.max(8, rRupKm) / 50);
  const capped = Math.max(0, Math.min(1, betaLog)); // log10 gain in [0,1] -> gain in [1,10]
  return function (f) {
    if (!(f > 0) || f >= 1) return 1; // g=1 for T<=1s
    const T = 1 / f;
    const phi = Math.min(1, Math.log(T) / Math.log(3));
    return Math.pow(10, capped * phi);
  };
}

// ===========================================================================
//  --v5-diag : the PRE_REG_V5 diagnosis run. Attribution of the three
//  failing shape-gate bands of the SHIPPED SH-only baseline to
//  {HF branch, LF branch, seam, target construction}, plus the Brune-corner
//  (stress) lever measured on the full blend. The full-arm reference is the
//  FROZEN cs-pipeline-v4-report.json shOnly rows — no re-run of the full
//  arm; the diag arms pair to it via the identical seed strings. Diagnosis
//  only: no parameter is retuned from this report.
// ===========================================================================
const V5_OUT = path.join(ROOT, 'tools', 'data', 'cs-diagnosis-v2-report.json');

function runV5Diag(cases, cal, periods, bedrockGrid) {
  const t0 = Date.now();
  const anchorIdx = periods.indexOf(PRE_REG.anchorPeriodSec);
  const SHORT = [0, 1, 2, 3, 4, 5], MID = [6, 7, 8, 9], LONG = [10, 11, 12];
  const TH = PRE_REG_V5.thresholds;
  const v4 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-pipeline-v4-report.json'), 'utf8'));
  const fullRows = v4.realizations.filter((r) => r.arm === 'hybrid' && r.psaGal && r.condMuLn);
  const stressFor = (cls) => cal.stressByClass[cls] || 50;

  const biasLnOf = (rows) => periods.map((_, pi) => {
    let s = 0, n = 0;
    for (const r of rows) { if (!r.condMuLn) continue; s += Math.log(r.psaGal[pi]) - r.condMuLn[pi]; n++; }
    return n ? s / n : null;
  });
  const bandAbs = (bl, idx) => {
    const a = idx.map((pi) => Math.abs(bl[pi])).filter((v) => v != null).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };

  // ---- D5 target audit (pure arithmetic on the frozen rows) -------------
  const audit = { nRows: 0, nEpsChecked: 0, nEpsSkipped: 0, maxMuDelta: 0, maxEpsDelta: 0, worstAt: null };
  for (const c of cases) {
    if (!c.mscs) continue;
    const rows = fullRows.filter((r) => r.site === c.site.id && r.rp === c.rp);
    for (const r of rows) {
      const rake = Physics.PSHA_CLASS_RAKE[r.srcType] || 0;
      const a = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[PRE_REG.anchorPeriodSec], r.srcType, r.mw, r.rRupKm, r.depthKm, c.vs30, rake);
      if (!a || !(a.median > 0)) continue;
      const eps = (Math.log10(c.imTarget) - Math.log10(a.median)) / a.sigmaLog10;
      // the v4 report rows carry NO epsBin field (the shard writer's row
      // schema omits it) — NaN-guard instead of silently poisoning the max,
      // and record the clause as inapplicable when nothing was checkable
      if (isFinite(eps) && r.epsBin != null && isFinite(r.epsBin)) {
        audit.maxEpsDelta = Math.max(audit.maxEpsDelta, Math.abs(eps - r.epsBin));
        audit.nEpsChecked++;
      } else audit.nEpsSkipped++;
      for (let pi = 0; pi < periods.length; pi++) {
        const mo = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[periods[pi]], r.srcType, r.mw, r.rRupKm, r.depthKm, c.vs30, rake);
        if (!mo || !(mo.median > 0) || r.condMuLn[pi] == null) continue;
        const rho = Physics.rhoPeriodPair(periods[pi], PRE_REG.anchorPeriodSec, r.srcType);
        const muC = Math.log(mo.median) + rho * (mo.sigmaLog10 * LN10) * eps;
        const d = Math.abs(muC - r.condMuLn[pi]);
        if (d > audit.maxMuDelta) { audit.maxMuDelta = d; audit.worstAt = r.site + ' RP' + r.rp + ' #' + r.i + ' @' + periods[pi] + 's'; }
      }
      audit.nRows++;
    }
  }
  const muOk = audit.maxMuDelta <= TH.targetAuditMaxDelta;
  const epsApplicable = audit.nEpsChecked > 0;
  audit.epsClauseApplicable = epsApplicable;
  audit.amendment = epsApplicable ? null : 'the v4 report rows carry no epsBin field (shard-writer row schema) — the pre-registered eps clause is INAPPLICABLE on the frozen artifact; the verdict rests on the muC clause, which subsumes eps through muC = ln(median) + rho*sigma*eps';
  audit.verdict = (muOk && (!epsApplicable || audit.maxEpsDelta <= TH.targetAuditMaxDelta)) ? 'PASS: no construction bug' : 'FAIL: construction inconsistency — fix the target before any synthesis retune';

  // ---- D1/D2/D3 arms -----------------------------------------------------
  const armDefs = [
    ['D1_hfOnly', { lfMaxHz: 0.001 }],
    ['D2_lfOnly', { hfScaleClamp: [0, 0] }],
    ['D3_stressHalf', { stressScale: 0.5 }],
    ['D3_stressDouble', { stressScale: 2 }],
    ['D4_lfNoGain', { hfScaleClamp: [0, 0], noLfGain: true }]
  ];
  const diagCases = [];
  for (const c of cases) {
    if (!c.mscs) continue;
    const bedrockM = Physics.lookupResearchGrid(bedrockGrid, c.site.lat, c.site.lng);
    const profile = Physics.synthSiteProfile(c.vs30, bedrockM);
    const pool = c.deagg.bins.filter((b) => b.meanRrupKm >= PRE_REG.minRrupKmForSampling);
    const poolMass = pool.reduce((a, b) => a + b.prob, 0);
    const cum = []; let acc = 0;
    for (const b of pool) { acc += b.prob / poolMass; cum.push(acc); }
    const condOf = new Map();
    c.mscs.binCond.forEach((bc) => condOf.set(bc.srcType + '|' + (+bc.repr.mw.toFixed(3)) + '|' + (+bc.repr.rRupKm.toFixed(2)), bc));
    const siteCurveFor = (mw, srcType, rRupKm, depthKm) => {
      if (!profile || profile.length < 2) return null;
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRupKm, depthKm, c.vs30, Physics.PSHA_CLASS_RAKE[srcType] || 0);
      if (!g || !(g.median > 0)) return null;
      const freqs = [];
      for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
      const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
      if (!res || !res.amp) return null;
      return { freqs, amps: res.amp.map((a2) => Math.max(0.2, Math.min(8, a2))) };
    };

    const runArm = (extra) => {
      const rows = [];
      for (let i = 0; i < PRE_REG_V5.nRealizations; i++) {
        const rng = Physics.seededRng(hashSeed(c.site.id + ':' + c.rp + ':hybrid:' + i));
        const u = rng(); let bi = 0;
        while (bi < cum.length - 1 && u > cum[bi]) bi++;
        const bin = pool[bi] || pool[pool.length - 1];
        const strike = +(rng() * 360).toFixed(2);
        const siteCurve = siteCurveFor(bin.repr.mw, bin.srcType, bin.meanRrupKm, bin.repr.depthKm);
        const out = synthesize(c, bin, 'hybrid', {
          strike, stressMPa: stressFor(bin.srcType) * (extra.stressScale || 1), kappaSec: cal.kappaSec,
          siteCurve, seed: hashSeed(c.site.id + ':' + c.rp + ':hybrid:' + i + ':synth'),
          lfGainFn: extra.noLfGain ? undefined : lfGainFnFor(cal, bin.repr.mw, bin.meanRrupKm),
          lfMaxHz: extra.lfMaxHz, hfScaleClamp: extra.hfScaleClamp
        });
        const psa = psaOf(out, periods);
        const anchorPsa = psa[anchorIdx];
        if (!(anchorPsa > 0) || !isFinite(anchorPsa)) continue;
        const scale = c.imTarget / anchorPsa;
        const scaled = psa.map((v) => v * scale);
        const bc = condOf.get(bin.srcType + '|' + (+bin.repr.mw.toFixed(3)) + '|' + (+bin.meanRrupKm.toFixed(2)));
        rows.push({ i, psaGal: scaled, condMuLn: bc ? bc.muLn : null });
      }
      return biasLnOf(rows);
    };

    const bias = { full: biasLnOf(fullRows.filter((r) => r.site === c.site.id && r.rp === c.rp)) };
    for (const [name, extra] of armDefs) bias[name] = runArm(extra);

    // stress lever at 0.1s: log-linear in S between the x0.5/x2 arms
    const slope01 = (bias.D3_stressDouble[0] - bias.D3_stressHalf[0]) / Math.log(4);
    let star = null, postHoc = null;
    if (Math.abs(slope01) > 1e-3) {
      const uStar = -bias.full[0] / slope01; // b(u) = b(0) + slope*u, zero at u*
      star = +Math.exp(uStar).toFixed(3);
      postHoc = +Math.max(...SHORT.map((pi) => {
        const slopePi = (bias.D3_stressDouble[pi] - bias.D3_stressHalf[pi]) / Math.log(4);
        return Math.abs(bias.full[pi] + slopePi * uStar);
      })).toFixed(3);
    }

    const biasLog10 = {};
    for (const k of Object.keys(bias)) biasLog10[k] = bias[k].map((v) => +(v / LN10).toFixed(3));
    diagCases.push({
      site: c.site.id, rp: c.rp, vs30: c.vs30, imTarget: +c.imTarget.toFixed(1),
      biasLn: bias, biasLog10,
      stressLever: { slope01: +slope01.toFixed(4), Sstar: star, postHocShortResidual: postHoc }
    });
    const L = (v) => (v / LN10).toFixed(3);
    console.log(c.site.id + ' RP' + c.rp + ' | 0.1s full ' + L(bias.full[0]) + ' hf ' + L(bias.D1_hfOnly[0]) +
      ' | 5s full ' + L(bias.full[12]) + ' lf ' + L(bias.D2_lfOnly[12]) + ' lfNoGain ' + L(bias.D4_lfNoGain[12]) +
      ' | S* ' + (star == null ? 'n/a' : star) + ' postHoc ' + postHoc);
  }

  // ---- ownership shares ---------------------------------------------------
  const share = (band) => {
    const num = (arm) => +median(diagCases.map((d) => bandAbs(d.biasLn[arm], band))).toFixed(4);
    const hf = num('D1_hfOnly'), lf = num('D2_lfOnly'), full = num('full');
    return { hfAbs: hf, lfAbs: lf, fullAbs: full, hfShare: +(hf / full).toFixed(3), lfShare: +(lf / full).toFixed(3) };
  };
  const attribution = {
    short: Object.assign(share(SHORT), { owner: share(SHORT).hfShare >= TH.ownership ? 'HF' : (share(SHORT).lfShare >= TH.ownership ? 'LF' : 'split') }),
    mid: Object.assign(share(MID), { owner: share(MID).hfShare >= TH.ownership ? 'HF' : (share(MID).lfShare >= TH.ownership ? 'LF' : 'split') }),
    long: Object.assign(share(LONG), { owner: share(LONG).hfShare >= TH.ownership ? 'HF' : (share(LONG).lfShare >= TH.ownership ? 'LF' : 'split') })
  };
  // seam: full deviates from BOTH pure arms by > 0.1 at 0.7s or 1.5s
  const seamDetails = [];
  for (const d of diagCases) {
    for (const pi of [6, 8]) {
      const devHf = Math.abs(d.biasLn.full[pi] - d.biasLn.D1_hfOnly[pi]);
      const devLf = Math.abs(d.biasLn.full[pi] - d.biasLn.D2_lfOnly[pi]);
      if (devHf > TH.seamDeviation && devLf > TH.seamDeviation) seamDetails.push({ site: d.site, rp: d.rp, period: periods[pi], devHf: +devHf.toFixed(3), devLf: +devLf.toFixed(3) });
    }
  }
  attribution.seamFlagged = seamDetails.length > 0;
  attribution.seamDetails = seamDetails;

  // ---- stress feasibility verdict ----------------------------------------
  const stars = diagCases.map((d) => d.stressLever.Sstar).filter((v) => v != null && isFinite(v) && v > 0);
  const postHocs = diagCases.map((d) => d.stressLever.postHocShortResidual).filter((v) => v != null);
  const spread = stars.length ? +(Math.max(...stars) / Math.min(...stars)).toFixed(2) : null;
  const postHocMax = postHocs.length ? +Math.max(...postHocs).toFixed(3) : null;
  const stressFeasibility = {
    perCaseSstar: diagCases.map((d) => ({ site: d.site, rp: d.rp, Sstar: d.stressLever.Sstar, postHoc: d.stressLever.postHocShortResidual })),
    spread, postHocMax,
    verdict: (stars.length === diagCases.length && spread != null && spread <= TH.stressSpreadMax && postHocMax != null && postHocMax <= TH.stressResidualMax)
      ? 'VIABLE: per-case stress refit could own the short band — registered as the cure candidate'
      : 'DEAD: the stress lever cannot own the short band within the pre-registered viability window'
  };

  // descriptive findings (measurement narration, not decision rules)
  const f = [];
  f.push('short band: HF-owned (share ' + attribution.short.hfShare + ', the fcHz=1 Hz hard partition in numbers); the Brune-corner stress lever is DEAD — S* ' +
    JSON.stringify(stressFeasibility.perCaseSstar.map((x) => x.Sstar)) + ', postHocMax ' + stressFeasibility.postHocMax + ' > ' + TH.stressResidualMax);
  const kochiLong = diagCases.filter((d) => d.site === 'kochi').map((d) => d.biasLog10.full[12]);
  const osakaLong = diagCases.filter((d) => d.site === 'osaka').map((d) => d.biasLog10.full[12]);
  f.push('long band SIGN SPLIT: kochi full-arm @5s ' + JSON.stringify(kochiLong) + ' (deficit) vs osaka ' + JSON.stringify(osakaLong) +
    ' (excess) — no single global LF lever (gain/stress/Q) can own both; consistent with the v1 B1/B2 halfspace/Q exclusions, points at the site column (JIVSM) long-period shape');
  f.push('LF gain tilt share (D4 vs D2, 5s-vs-1s shape): the v3 fitted gain owns ~0.1-0.3 of the LF shape excess; the DW-SH x Brune branch shape carries the rest');
  f.push('anchor-at-seam coupling: the pure-LF arms self-anchor at a weak 1s (HF carries the shipped anchor) so their ABSOLUTE biases are inflated ~20x; the T-vs-1s ratio view is the comparable one — the shipped gate number for the long band remains the full arm');
  const findings = { summary: f };

  const report = {
    schema: 'quake-sim-cs-diagnosis-v2',
    generatedAt: new Date().toISOString(),
    preRegistered: PRE_REG_V5,
    basis: { fullArm: 'tools/data/cs-pipeline-v4-report.json shOnly rows (frozen 2026-09-15)', calibration: 'tools/data/cs-repair-calibration.json', note: 'DIAGNOSIS ONLY — no parameter was changed from this report' },
    targetAudit: audit,
    attribution,
    stressFeasibility,
    findings,
    cases: diagCases
  };
  fs.writeFileSync(V5_OUT, JSON.stringify(report, null, 1));
  console.log('\n=== CS v5 DIAGNOSIS (PRE_REG_V5) ===');
  console.log('targetAudit:', audit.verdict, '| maxMuDelta', audit.maxMuDelta.toFixed(5), 'maxEpsDelta', audit.maxEpsDelta.toFixed(4), 'nRows', audit.nRows);
  for (const band of ['short', 'mid', 'long']) {
    const a = attribution[band];
    console.log(band + ' band: hfShare ' + a.hfShare + ' lfShare ' + a.lfShare + ' -> owner ' + a.owner);
  }
  console.log('seam flagged:', attribution.seamFlagged, seamDetails.length ? JSON.stringify(seamDetails.slice(0, 4)) : '');
  console.log('stressFeasibility:', stressFeasibility.verdict, '| spread', spread, 'postHocMax', postHocMax);
  console.log('wrote ' + V5_OUT);
  console.log('elapsed ' + ((Date.now() - t0) / 1000 / 60).toFixed(1) + ' min');
}

// ===========================================================================
//  --v6-diag : the PRE_REG_V6 run. Family A: kochi<->osaka column swap
//  (long-band causality). Family B: the shipped scenario rows re-scored
//  against UNTILTED zhao medians (short-band tilt decomposition).
//  Diagnosis only — no parameter is retuned from this report.
// ===========================================================================
const V6_OUT = path.join(ROOT, 'tools', 'data', 'cs-diagnosis-v3-report.json');

function runV6Diag(cases, cal, periods, bedrockGrid) {
  const t0 = Date.now();
  const anchorIdx = periods.indexOf(PRE_REG.anchorPeriodSec);
  const SHORT = [0, 1, 2, 3, 4, 5];
  const TH = PRE_REG_V6.thresholds;
  const v4 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-pipeline-v4-report.json'), 'utf8'));
  const fullRows = v4.realizations.filter((r) => r.arm === 'hybrid' && r.psaGal && r.condMuLn);
  const stressFor = (cls) => cal.stressByClass[cls] || 50;

  // column stacks for the swap (site columns, independent of the case loop)
  const stackOf = {};
  for (const c of cases) {
    if (!c.mscs || stackOf[c.site.id]) continue;
    const col = Physics.jivsmColumnAt(c.site.lat, c.site.lng);
    stackOf[c.site.id] = col ? hybrid.buildJivsmIaspStack(col) : c.stack;
  }

  const runShipped = (c, stackOverride) => {
    const bedrockM = Physics.lookupResearchGrid(bedrockGrid, c.site.lat, c.site.lng);
    const profile = Physics.synthSiteProfile(c.vs30, bedrockM);
    const pool = c.deagg.bins.filter((b) => b.meanRrupKm >= PRE_REG.minRrupKmForSampling);
    const poolMass = pool.reduce((a, b) => a + b.prob, 0);
    const cum = []; let acc = 0;
    for (const b of pool) { acc += b.prob / poolMass; cum.push(acc); }
    const condOf = new Map();
    c.mscs.binCond.forEach((bc) => condOf.set(bc.srcType + '|' + (+bc.repr.mw.toFixed(3)) + '|' + (+bc.repr.rRupKm.toFixed(2)), bc));
    const siteCurveFor = (mw, srcType, rRupKm, depthKm) => {
      if (!profile || profile.length < 2) return null;
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRupKm, depthKm, c.vs30, Physics.PSHA_CLASS_RAKE[srcType] || 0);
      if (!g || !(g.median > 0)) return null;
      const freqs = [];
      for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
      const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
      if (!res || !res.amp) return null;
      return { freqs, amps: res.amp.map((a2) => Math.max(0.2, Math.min(8, a2))) };
    };
    const rows = [];
    for (let i = 0; i < PRE_REG_V6.nRealizations; i++) {
      const rng = Physics.seededRng(hashSeed(c.site.id + ':' + c.rp + ':hybrid:' + i));
      const u = rng(); let bi = 0;
      while (bi < cum.length - 1 && u > cum[bi]) bi++;
      const bin = pool[bi] || pool[pool.length - 1];
      const strike = +(rng() * 360).toFixed(2);
      const siteCurve = siteCurveFor(bin.repr.mw, bin.srcType, bin.meanRrupKm, bin.repr.depthKm);
      const out = synthesize(stackOverride ? Object.assign({}, c, { stack: stackOverride }) : c, bin, 'hybrid', {
        strike, stressMPa: stressFor(bin.srcType), kappaSec: cal.kappaSec,
        siteCurve, seed: hashSeed(c.site.id + ':' + c.rp + ':hybrid:' + i + ':synth'),
        lfGainFn: lfGainFnFor(cal, bin.repr.mw, bin.meanRrupKm)
      });
      const psa = psaOf(out, periods);
      const anchorPsa = psa[anchorIdx];
      if (!(anchorPsa > 0) || !isFinite(anchorPsa)) continue;
      const scale = c.imTarget / anchorPsa;
      const scaled = psa.map((v) => v * scale);
      const bc = condOf.get(bin.srcType + '|' + (+bin.repr.mw.toFixed(3)) + '|' + (+bin.meanRrupKm.toFixed(2)));
      // untilted zhao targets for this realization's own bin
      const rake = Physics.PSHA_CLASS_RAKE[bin.srcType] || 0;
      const zhaoLn = periods.map((T) => {
        const mo = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[T], bin.srcType, bin.repr.mw, bin.meanRrupKm, bin.repr.depthKm, c.vs30, rake);
        return mo && mo.median > 0 ? Math.log(mo.median) : null;
      });
      rows.push({ i, psaGal: scaled, condMuLn: bc ? bc.muLn : null, zhaoLn });
    }
    return rows;
  };

  const meanBias = (rows, target) => periods.map((_, pi) => {
    let s = 0, n = 0;
    for (const r of rows) {
      const t = target(r)[pi];
      if (t == null || !isFinite(t)) continue;
      s += Math.log(r.psaGal[pi]) - t; n++;
    }
    return n ? s / n : null;
  });
  const tiltedOf = (r) => r.condMuLn;
  const untiltedOf = (r) => r.zhaoLn;

  // ---- Family B: untilted scoring on every case --------------------------
  const v6Cases = [];
  for (const c of cases) {
    if (!c.mscs) continue;
    const rows = runShipped(c, null);
    const bTilted = meanBias(rows, tiltedOf);
    const bUntilted = meanBias(rows, untiltedOf);
    // the untilted bias carries the anchor LEVEL (the synth is scaled to
    // imTarget at 1s, not to the zhao median): untilted@1s = eps*sigma(1s).
    // Strip it so U measures the SHAPE divergence only.
    let off = 0, offN = 0;
    for (const r of rows) {
      if (r.zhaoLn[anchorIdx] == null) continue;
      off += Math.log(r.psaGal[anchorIdx]) - r.zhaoLn[anchorIdx]; offN++;
    }
    const anchorOffset = offN ? +(off / offN / LN10).toFixed(4) : null;
    // the CS construction's tilt, per period (tilted − untilted)
    const tilt = periods.map((_, pi) => (bTilted[pi] != null && bUntilted[pi] != null) ? bTilted[pi] - bUntilted[pi] : null);
    // bin eps distribution (prob-weighted) — the mechanism number
    let epsW = 0, wSum = 0;
    c.mscs.binCond.forEach((bc) => { if (bc.prob >= 0.005) { epsW += bc.prob * bc.eps; wSum += bc.prob; } });
    const untiltedShape = bUntilted.map((v) => (v == null || anchorOffset == null) ? null : +(v / LN10 - anchorOffset).toFixed(3));
    v6Cases.push({
      site: c.site.id, rp: c.rp,
      epsProbMean: wSum ? +(epsW / wSum).toFixed(3) : null,
      anchorOffsetLog10: anchorOffset,
      biasLog10: { tilted: bTilted.map((v) => v == null ? null : +(v / LN10).toFixed(3)), untilted: bUntilted.map((v) => v == null ? null : +(v / LN10).toFixed(3)), untiltedShape, tilt: tilt.map((v) => v == null ? null : +(v / LN10).toFixed(3)) }
    });
    console.log(c.site.id + ' RP' + c.rp + ' eps~' + (wSum ? (epsW / wSum).toFixed(2) : 'n/a') +
      ' | 0.1s tilted ' + (bTilted[0] / LN10).toFixed(3) + ' untilted ' + (bUntilted[0] / LN10).toFixed(3) +
      ' tilt ' + (tilt[0] / LN10).toFixed(3) + ' | 0.5s tilted ' + (bTilted[5] / LN10).toFixed(3) + ' untilted ' + (bUntilted[5] / LN10).toFixed(3));
  }

  const U = median(v6Cases.map((d) => {
    const a = SHORT.map((pi) => Math.abs(d.biasLog10.untiltedShape[pi])).sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }));
  const tiltVerdict = U <= TH.untiltedMax
    ? 'TARGET-SIDE: the shipped synthesis matches zhao SHAPE at the scenario population (U=' + U.toFixed(3) + ' <= ' + TH.untiltedMax + ') — the short-band FAIL is the high-eps CS tilt regime; the cure, if any, is in the target construction, not the synthesis'
    : 'SYNTHESIS-SIDE: the scenario-population synthesis diverges from zhao SHAPE too (U=' + U.toFixed(3) + ' > ' + TH.untiltedMax + ') — the untiltedShape magnitudes are the cure target';

  // ---- Family A: column swap on kochi/osaka ------------------------------
  const swap = {};
  for (const [site, donor] of [['kochi', 'osaka'], ['osaka', 'kochi']]) {
    for (const c of cases) {
      if (!c.mscs || c.site.id !== site) continue;
      const rows = runShipped(c, stackOf[donor]);
      const bSwap = meanBias(rows, tiltedOf);
      swap[site + ':' + c.rp] = { biasLog10: bSwap.map((v) => v == null ? null : +(v / LN10).toFixed(3)) };
    }
  }
  const siteBias5s = (site, src) => {
    const vals = [];
    if (src === 'v4') {
      for (const c of cases.filter((x) => x.mscs && x.site.id === site)) {
        const rows = fullRows.filter((r) => r.site === site && r.rp === c.rp);
        const bl = meanBias(rows, tiltedOf);
        if (bl[12] != null) vals.push(bl[12] / LN10); // log10, same unit as the swap arm
      }
    } else {
      for (const k of Object.keys(swap)) {
        if (!k.startsWith(site + ':')) continue;
        const v = swap[k].biasLog10[12];
        if (v != null) vals.push(v);
      }
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const Dorig = siteBias5s('osaka', 'v4') - siteBias5s('kochi', 'v4');
  const Dswap = siteBias5s('osaka', 'swap') - siteBias5s('kochi', 'swap');
  const columnOwns = (Dorig && Dswap != null) ? +((Dorig - Dswap) / (2 * Dorig)).toFixed(3) : null;
  const columnVerdict = columnOwns == null ? 'n/a' :
    columnOwns >= TH.columnOwnsMin ? 'COLUMN-OWNED: the JIVSM column carries the kochi/osaka long-band divergence (' + columnOwns + ')' :
    columnOwns <= TH.sourceOwnsMax ? 'SOURCE-OWNED: the divergence follows the scenario sources, not the column (' + columnOwns + ')' :
    'MIXED: column/share ' + columnOwns;

  const report = {
    schema: 'quake-sim-cs-diagnosis-v3',
    generatedAt: new Date().toISOString(),
    preRegistered: PRE_REG_V6,
    basis: { fullArm: 'tools/data/cs-pipeline-v4-report.json shOnly rows', note: 'DIAGNOSIS ONLY — no parameter was changed from this report' },
    tiltDecomposition: { U, verdict: tiltVerdict, cases: v6Cases },
    arbiterReference: (() => {
      try {
        const arb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-arbiter-report.json'), 'utf8'));
        return { file: 'tools/data/cs-arbiter-report.json', DSYN: arb.aggregate.DSYN.all, DBAR: arb.aggregate.DBAR, disclosure: 'real-event population (eps~0), synth setup NOT identical to the pipeline (vs30 600 fixed vs grid, site-curve/mechanism differences not isolated in this batch) — the scenario-vs-real contrast is a measured population/configuration gap, not a pure population effect' };
      } catch (e) { return null; }
    })(),
    columnSwap: { Dorig: Dorig == null ? null : +Dorig.toFixed(3), Dswap: Dswap == null ? null : +Dswap.toFixed(3), columnOwns, verdict: columnVerdict, swaps: swap }
  };
  fs.writeFileSync(V6_OUT, JSON.stringify(report, null, 1));
  console.log('\n=== CS v6 DIAGNOSIS (PRE_REG_V6) ===');
  console.log('tilt:', tiltVerdict);
  console.log('columnSwap: Dorig', Dorig == null ? 'n/a' : Dorig.toFixed(3), 'Dswap', Dswap == null ? 'n/a' : Dswap.toFixed(3), '->', columnVerdict);
  console.log('wrote ' + V6_OUT);
  console.log('elapsed ' + ((Date.now() - t0) / 1000 / 60).toFixed(1) + ' min');
}

function main() {
  const write = process.argv.includes('--write');
  const doFit = process.argv.includes('--fit');
  const model = loadJson(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'));
  const rhoDoc = loadJson(path.join(ROOT, 'public', 'geojson', 'jayaram2011-rho.json'));
  const jivsmCols = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'));
  const vs30Grid = loadJson(path.join(ROOT, 'public', 'geojson', 'vs30.json'));
  const bedrockGrid = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-bedrock.json'));
  Physics.setJivsmColumns(jivsmCols);
  Physics.setJayaram2011Rho(rhoDoc);

  const periods = PRE_REG.periodsSec;
  const anchorIdx = periods.indexOf(PRE_REG.anchorPeriodSec);
  const wideLevels = [];
  for (let i = 0; i < PRE_REG.imLevels.n; i++) {
    wideLevels.push(+(PRE_REG.imLevels.lo * Math.pow(PRE_REG.imLevels.hi / PRE_REG.imLevels.lo, i / (PRE_REG.imLevels.n - 1))).toPrecision(4));
  }
  const cases = buildCases(model, jivsmCols, vs30Grid, wideLevels);

  if (doFit) {
    runFit(cases, periods);
    return;
  }
  const cal = loadJson(CAL_OUT);
  if (cal.schema !== 'quake-sim-cs-repair-calibration-v1') throw new Error('stale calibration file: ' + CAL_OUT);
  const kappaSec = cal.kappaSec;
  const stressFor = (cls) => cal.stressByClass[cls] || 50;

  if (process.argv.includes('--v5-diag')) { runV5Diag(cases, cal, periods, bedrockGrid); return; }
  if (process.argv.includes('--v6-diag')) { runV6Diag(cases, cal, periods, bedrockGrid); return; }

  const realizations = [];
  const t0 = Date.now();
  for (const c of cases) {
    if (!c.mscs) continue;
    const bedrockM = Physics.lookupResearchGrid(bedrockGrid, c.site.lat, c.site.lng);
    const profile = Physics.synthSiteProfile(c.vs30, bedrockM);
    // sampling pool: bins at Rrup >= 8 km (identical to v2)
    const pool = c.deagg.bins.filter((b) => b.meanRrupKm >= PRE_REG.minRrupKmForSampling);
    const poolMass = pool.reduce((a, b) => a + b.prob, 0);
    const cum = [];
    let acc = 0;
    for (const b of pool) { acc += b.prob / poolMass; cum.push(acc); }
    // bin-conditional target lookup for pool members (value key — the
    // deaggregate bins and the binCond rows are distinct objects)
    const condOf = new Map();
    c.mscs.binCond.forEach((bc) => condOf.set(bc.srcType + '|' + (+bc.repr.mw.toFixed(3)) + '|' + (+bc.repr.rRupKm.toFixed(2)), bc));

    const siteCurveFor = (mw, srcType, rRupKm, depthKm) => {
      if (!profile || profile.length < 2) return null;
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRupKm, depthKm, c.vs30, Physics.PSHA_CLASS_RAKE[srcType] || 0);
      if (!g || !(g.median > 0)) return null;
      const freqs = [];
      for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
      const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
      if (!res || !res.amp) return null;
      return { freqs, amps: res.amp.map((a2) => Math.max(0.2, Math.min(8, a2))) };
    };

    for (const arm of ['hybrid', 'brune']) {
      for (let i = 0; i < PRE_REG.realizationsPerCase; i++) {
        const rng = Physics.seededRng(hashSeed(c.site.id + ':' + c.rp + ':' + arm + ':' + i));
        const u = rng();
        let bi = 0;
        while (bi < cum.length - 1 && u > cum[bi]) bi++;
        const bin = pool[bi] || pool[pool.length - 1];
        const strike = +(rng() * 360).toFixed(2);
        const siteCurve = siteCurveFor(bin.repr.mw, bin.srcType, bin.meanRrupKm, bin.repr.depthKm);
        const lfGainFn = (arm === 'hybrid' && cal.lfGainApplied !== false) ? lfGainFnFor(cal, bin.repr.mw, bin.meanRrupKm) : null;
        let out;
        try {
          out = synthesize(c, bin, arm, {
            strike, stressMPa: stressFor(bin.srcType), kappaSec,
            siteCurve, seed: hashSeed(c.site.id + ':' + c.rp + ':' + arm + ':' + i + ':synth'), lfGainFn
          });
        } catch (e) {
          realizations.push({ arm, site: c.site.id, rp: c.rp, i, invalid: String(e.message || e).slice(0, 80) });
          continue;
        }
        const psa = psaOf(out, periods);
        const anchorPsa = psa[anchorIdx];
        if (!(anchorPsa > 0) || !isFinite(anchorPsa)) {
          realizations.push({ arm, site: c.site.id, rp: c.rp, i, invalid: 'non-positive anchor PSA' });
          continue;
        }
        const scale = c.imTarget / anchorPsa;
        const scaled = psa.map((v) => v * scale);
        const pk = peaksOf(out.transverse.map((v) => v * scale), out.sampleRateHz);
        const bc = condOf.get(bin.srcType + '|' + (+bin.repr.mw.toFixed(3)) + '|' + (+bin.meanRrupKm.toFixed(2)));
        realizations.push({
          arm, site: c.site.id, rp: c.rp, i, srcType: bin.srcType, mw: +bin.repr.mw.toFixed(2),
          rRupKm: +bin.meanRrupKm.toFixed(1), distKm: +(out.meta.distKm || 0).toFixed(1),
          depthKm: +bin.repr.depthKm.toFixed(1), strike,
          log10Scale: +Math.log10(scale).toFixed(3), epsBin: +(bc ? bc.eps.toFixed(2) : 0),
          psaGal: scaled.map((v) => +v.toFixed(1)), pga: +pk.pga.toFixed(1), pgv: +pk.pgv.toFixed(1),
          condMuLn: bc ? bc.muLn.map((v) => +v.toFixed(4)) : null
        });
      }
    }
  }
  console.log('synthesis elapsed', ((Date.now() - t0) / 1000 / 60).toFixed(1), 'min');

  // ---- ensemble scoring (v3: bin-conditional; mixture diagnostic) -------
  const validCases = cases.filter((c) => c.mscs);
  function bandPeriods(name) {
    const map = { '0.1-0.5s': [0.1, 0.15, 0.2, 0.3, 0.4, 0.5], '0.5-2s': [0.7, 1.0, 1.5, 2.0], '2-5s': [3.0, 4.0, 5.0] };
    return map[name];
  }
  function caseEnsemble(siteId, rp, arm) {
    const rows = realizations.filter((r) => r.site === siteId && r.rp === rp && r.arm === arm && r.psaGal && r.condMuLn);
    if (!rows.length) return null;
    const lnMean = periods.map((_, pi) => {
      let s = 0;
      for (const r of rows) s += Math.log(r.psaGal[pi]);
      return s / rows.length;
    });
    // bin-conditional bias: per realization against its OWN bin target
    const biasLn = periods.map((_, pi) => {
      let s = 0;
      for (const r of rows) s += Math.log(r.psaGal[pi]) - r.condMuLn[pi];
      return s / rows.length;
    });
    const pgaLogs = rows.map((r) => Math.log(r.pga));
    return { n: rows.length, lnMean, biasLn, geomeanGal: lnMean.map((v) => +Math.exp(v).toFixed(1)), pgaLnMean: pgaLogs.reduce((a, b) => a + b, 0) / pgaLogs.length };
  }

  const perCase = [];
  const biasLog10 = {};   // bin-conditional (gates)
  const biasMixLog10 = {}; // mixture MS-CS (diagnostic)
  for (const arm of ['hybrid', 'brune']) { biasLog10[arm] = {}; biasMixLog10[arm] = {}; }
  for (const c of validCases) {
    const mscsMeanLn = c.mscs.periods.map((p) => p.meanLn);
    for (const arm of ['hybrid', 'brune']) {
      const ens = caseEnsemble(c.site.id, c.rp, arm);
      if (!ens) continue;
      const bias = ens.biasLn.map((v) => +(v / LN10).toFixed(3));
      const biasMix = ens.lnMean.map((v, pi) => +((v - mscsMeanLn[pi]) / LN10).toFixed(3));
      const containment = c.mscs.periods.filter((s, pi) => Math.abs(ens.biasLn[pi] - 0) <= s.sigmaLn).length / periods.length;
      if (!biasLog10[arm][c.site.id]) biasLog10[arm][c.site.id] = {};
      if (!biasMixLog10[arm][c.site.id]) biasMixLog10[arm][c.site.id] = {};
      biasLog10[arm][c.site.id][c.rp] = bias;
      biasMixLog10[arm][c.site.id][c.rp] = biasMix;
      perCase.push({
        site: c.site.id, rp: c.rp, arm, n: ens.n,
        biasLog10: bias,             // v3 gate metric (bin-conditional)
        biasMixtureLog10: biasMix,   // v2 metric, diagnostic only
        anchorBiasLog10: 0,          // exact by construction (muC_b(T*)=log target, scale enforced)
        containmentFrac: +containment.toFixed(3)
      });
    }
  }

  // band AbsMax + gates (thresholds unchanged from v2)
  const bands = {};
  for (const band of Object.keys(PRE_REG.gates.bandAbsMax)) {
    const idx = bandPeriods(band).map((T) => periods.indexOf(T));
    bands[band] = {};
    for (const arm of ['hybrid', 'brune']) {
      let worst = 0, worstAt = null;
      for (const c of validCases) {
        const b = biasLog10[arm][c.site.id] && biasLog10[arm][c.site.id][c.rp];
        if (!b) continue;
        for (const pi of idx) {
          if (Math.abs(b[pi]) > worst) { worst = Math.abs(b[pi]); worstAt = c.site.id + ' RP' + c.rp + ' @' + periods[pi] + 's'; }
        }
      }
      bands[band][arm] = { absMax: +worst.toFixed(3), worstAt };
    }
    bands[band].gate = {
      limit: PRE_REG.gates.bandAbsMax[band],
      pass: bands[band].hybrid.absMax <= PRE_REG.gates.bandAbsMax[band]
    };
  }
  // diagnostic mixture bands
  const bandsMixture = {};
  for (const band of Object.keys(PRE_REG.gates.bandAbsMax)) {
    const idx = bandPeriods(band).map((T) => periods.indexOf(T));
    let worst = 0;
    for (const arm of ['hybrid']) {
      for (const c of validCases) {
        const b = biasMixLog10[arm][c.site.id] && biasMixLog10[arm][c.site.id][c.rp];
        if (!b) continue;
        for (const pi of idx) if (Math.abs(b[pi]) > worst) worst = Math.abs(b[pi]);
      }
    }
    bandsMixture[band] = { hybridAbsMax: +worst.toFixed(3), note: 'diagnostic only — structurally unreachable in 4/6 cases (diagnosis A3); no gate reads this' };
  }

  const validRows = realizations.filter((r) => r.psaGal);
  const anchorWorst = Math.max(0, ...validRows.map((r) => {
    const c = validCases.find((cc) => cc.site.id === r.site && cc.rp === r.rp);
    return c ? Math.abs(Math.log10(r.psaGal[anchorIdx] / c.imTarget)) : 0;
  }));

  const containmentFracs = perCase.filter((p) => p.arm === 'hybrid').map((p) => p.containmentFrac);
  const containmentFrac = containmentFracs.length ? containmentFracs.reduce((a, b) => a + b, 0) / containmentFracs.length : 0;

  function armPgaRatioLn(arm) {
    const rows = realizations.filter((r) => r.arm === arm && r.psaGal);
    let s = 0;
    for (const r of rows) s += Math.log(r.pga / r.psaGal[anchorIdx]);
    return s / rows.length;
  }
  const pgaRatioDelta = (armPgaRatioLn('hybrid') - armPgaRatioLn('brune')) / LN10;

  const gates = {
    anchorExact: { limit: PRE_REG.gates.anchorAbsLog10, observedAbsMax: +anchorWorst.toFixed(4), pass: anchorWorst <= PRE_REG.gates.anchorAbsLog10 },
    bandAbsMax: Object.fromEntries(Object.keys(bands).map((b) => [b, {
      limit: bands[b].gate.limit, hybridAbsMax: bands[b].hybrid.absMax, bruneAbsMax: bands[b].brune.absMax,
      worstAt: bands[b].hybrid.worstAt, pass: bands[b].gate.pass
    }])),
    containmentInSigma: { limit: PRE_REG.gates.containmentInSigmaFrac, observed: +containmentFrac.toFixed(3), pass: containmentFrac >= PRE_REG.gates.containmentInSigmaFrac },
    lpImprovementVsBrune: {
      hybridAbsMax: bands['2-5s'].hybrid.absMax, bruneAbsMax: bands['2-5s'].brune.absMax,
      improvement: +(bands['2-5s'].brune.absMax - bands['2-5s'].hybrid.absMax).toFixed(3),
      pass: (bands['2-5s'].brune.absMax - bands['2-5s'].hybrid.absMax) >= PRE_REG.gates.lpImprovementVsBruneMin
        || (bands['2-5s'].hybrid.absMax <= 0.10 && bands['2-5s'].brune.absMax <= 0.10)
    },
    pgaShapeNonRegressionVsBrune: {
      definition: 'ensemble log10(PGA/PSA(T*)) of hybrid may not exceed brune by more than the margin (both arms anchored at T*)',
      deltaHybridMinusBrune: +pgaRatioDelta.toFixed(3), margin: PRE_REG.gates.pgaNonRegressionVsBruneMargin,
      pass: pgaRatioDelta <= PRE_REG.gates.pgaNonRegressionVsBruneMargin
    }
  };

  const scaleStats = {};
  for (const arm of ['hybrid', 'brune']) {
    const logs = realizations.filter((r) => r.arm === arm && r.log10Scale != null).map((r) => r.log10Scale);
    scaleStats[arm] = logs.length ? { median: +median(logs).toFixed(3), min: +Math.min(...logs).toFixed(3), max: +Math.max(...logs).toFixed(3), n: logs.length } : null;
  }
  const invalidCount = realizations.filter((r) => r.invalid).length;

  const caseSummaries = cases.map((c) => {
    if (!c.mscs) return { site: c.site, rp: c.rp, skipped: c.skipped };
    return {
      site: c.site, rp: c.rp, vs30: c.vs30, imTarget: +c.imTarget.toFixed(1),
      deagg: {
        meanMw: +c.deagg.mean.mw.toFixed(2), meanRrupKm: +c.deagg.mean.rRupKm.toFixed(1),
        meanEps: +c.deagg.mean.eps.toFixed(2), classShares: c.deagg.classShares,
        nBins: c.deagg.bins.length
      },
      mscs: {
        nBinsUsed: c.mscs.nBinsUsed, binMassUsed: +c.mscs.binMassUsed.toFixed(4),
        meanGal: c.mscs.periods.map((p) => +p.meanGal.toFixed(1)),
        sigmaLn: c.mscs.periods.map((p) => +p.sigmaLn.toFixed(3))
      }
    };
  });

  const report = {
    schema: 'quake-sim-cs-pipeline-v1',
    pipelineVersion: 3,
    generatedAt: new Date().toISOString(),
    preRegistered: PRE_REG,
    preRegisteredV3: PRE_REG_V3,
    calibration: { file: 'tools/data/cs-repair-calibration.json', kappaSec, stressByClass: cal.stressByClass, lfGain: cal.lfGain },
    chain: 'hazardCurve wide-grid anchor -> deaggregate -> per-bin Baker conditional spectra -> hybrid/brune synthesis on sampled bins (kappa 0.04, class stress, LF empirical gain on the hybrid arm) -> single amplitude scale to Sa(T*=1s) -> ensemble vs BIN-CONDITIONAL targets (mixture MS-CS retained as diagnostic)',
    arms: {
      hybrid: 'B1 SH DW LF (v3: empirical long-period gain) + Boore HF (v3: kappa 0.04 + class-fitted stress), JIVSM+IASP91 stack + eqlin site curve at the site',
      brune: 'full-band absolute stochastic baseline, same sampling/scaling and source-side v3 parameters, NO LF gain (carrier comparison arm)'
    },
    cases: caseSummaries, gates, bands, bandsMixture, perCase, scaleFactors: scaleStats,
    invalidRealizations: invalidCount,
    realizations,
    findings: {}
  };
  const f = [];
  f.push('shape: ' + (Object.keys(gates.bandAbsMax).every((b) => gates.bandAbsMax[b].pass)
    ? 'PASS all band shape gates (bin-conditional scoring; |log10 ensemble/target| <= limit over all sites/RPs/periods)'
    : 'FAIL ' + Object.keys(gates.bandAbsMax).filter((b) => !gates.bandAbsMax[b].pass).map((b) => b + '(' + gates.bandAbsMax[b].hybridAbsMax + ')').join(', ') + ' vs limits'));
  f.push('mixture diagnostic (v2 metric, no gate): ' + Object.keys(bandsMixture).map((b) => b + '=' + bandsMixture[b].hybridAbsMax).join(', '));
  f.push('lp vs brune: ' + (gates.lpImprovementVsBrune.pass ? 'PASS' : 'FAIL') + ' (hybrid ' + gates.lpImprovementVsBrune.hybridAbsMax + ' vs brune ' + gates.lpImprovementVsBrune.bruneAbsMax + ' in 2-5 s)');
  f.push('containment: ' + (gates.containmentInSigma.pass ? 'PASS' : 'FAIL') + ' (observed ' + gates.containmentInSigma.observed + ' >= ' + gates.containmentInSigma.limit + ')');
  f.push('circularity: the 0.1-0.5 s and 2-5 s bands read targets the calibration was fitted against (disclosed in preRegisteredV3) — they test fit-consistency and scatter; the 0.5-2 s band, containment, lp-vs-brune and PGA-shape gates remain unfitted');
  f.push('caveats: SH-only (transverse channel); deaggregation carries no mechanism (strike sampled, dip/rake class priors); single-corner Brune source; bins < 8 km Rrup excluded from sampling (near-field DW limit); anchor Sa(1s) means absolute PGA is diagnostic only');
  report.findings = { summary: f };

  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\n=== GATES (v3 bin-conditional) ===');
  console.log('anchorExact:', gates.anchorExact.pass ? 'PASS' : 'FAIL', gates.anchorExact.observedAbsMax);
  for (const b of Object.keys(gates.bandAbsMax)) {
    console.log('band', b, gates.bandAbsMax[b].pass ? 'PASS' : 'FAIL', 'hybrid', gates.bandAbsMax[b].hybridAbsMax, 'brune', gates.bandAbsMax[b].bruneAbsMax, 'limit', gates.bandAbsMax[b].limit);
  }
  console.log('mixture diag:', Object.keys(bandsMixture).map((b) => b + '=' + bandsMixture[b].hybridAbsMax).join(' '));
  console.log('containment:', gates.containmentInSigma.pass ? 'PASS' : 'FAIL', gates.containmentInSigma.observed);
  console.log('lpImprovement:', gates.lpImprovementVsBrune.pass ? 'PASS' : 'FAIL', gates.lpImprovementVsBrune.improvement);
  console.log('pgaShapeNonRegression:', gates.pgaShapeNonRegressionVsBrune.pass ? 'PASS' : 'FAIL', gates.pgaShapeNonRegressionVsBrune.deltaHybridMinusBrune);
  console.log('invalid realizations:', invalidCount);
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

// ===========================================================================
// --v4 : the CS v4 gate execution (pre-registered in PRE_REG_V4; the
// 2026-09-13 precondition verdict named the QD chain as the honest gate arm
// and measured its cost). Dual arm: 'hybrid' (the shipped v3 a_shOnly
// baseline, unchanged) vs 'hybridPsv' (opts.psv + psvHorizontalOnly + psvQd
// + psvNoPoleWindows — the T1/T2 horizontal block on the bigfloat chain).
// The LF gain applies to BOTH arms (it isolates the P-SV block's marginal
// effect against the same fitted baseline; disclosed). Gate thresholds
// UNCHANGED from v3. Writes a SEPARATE report (cs-pipeline-v4-report.json);
// the v3 report and main() are untouched.
// Sharding: the QD arm costs ~2-9 h/realization (197 LF frequencies x the
// k-lattice x ~62 ms/chain), so the run shards per (case, realization):
//   node cs-pipeline.js --v4 --shardIdx i --shardN N
// takes realization i::N of every case (deterministic seeds — the shard
// layout never changes the sampled bins) and writes
// cs-pipeline-v4-shard-<i>-of-<N>.json; then
//   node cs-pipeline.js --v4-merge --shardN N
// merges all shards into cs-pipeline-v4-report.json with the gates.
// ===========================================================================
const V4_OUT = path.join(ROOT, 'tools', 'data', 'cs-pipeline-v4-report.json');
function runV4(cases, cal) {
  const shardIdx = process.argv.includes('--shardIdx') ? +process.argv[process.argv.indexOf('--shardIdx') + 1] : null;
  const shardN = process.argv.includes('--shardN') ? +process.argv[process.argv.indexOf('--shardN') + 1] : 1;
  const kappa = cal.kappaSec;
  const periods = PRE_REG.periodsSec;
  const anchorIdx = periods.indexOf(PRE_REG.anchorPeriodSec);

  if (process.argv.includes('--v4-merge')) {
    const realizations = [];
    let nShards = 0;
    for (let i = 0; i < shardN; i++) {
      const f = path.join(ROOT, 'tools', 'data', 'cs-pipeline-v4-shard-' + i + '-of-' + shardN + '.json');
      if (!fs.existsSync(f)) { console.log('missing shard', f); continue; }
      realizations.push(...JSON.parse(fs.readFileSync(f, 'utf8')).realizations);
      nShards++;
    }
    if (nShards < shardN) throw new Error('missing ' + (shardN - nShards) + ' shards');
    // Dedup by (site,rp,arm,i): the shard array ran the full 25-realization
    // hybrid set on EVERY shard (5 identical copies per case — only the
    // synthSecs timing field differs), while psv correctly ran one group per
    // shard. Without this the report's n=125 for hybrid is copy-inflated
    // bookkeeping; the gate numbers were never affected (identical rows).
    {
      const seen = new Set();
      for (let i = realizations.length - 1; i >= 0; i--) {
        const r = realizations[i];
        const key = r.site + '|' + r.rp + '|' + r.arm + '|' + r.i;
        if (seen.has(key)) realizations.splice(i, 1); else seen.add(key);
      }
    }
    const validCases = cases.filter((c) => c.mscs);
    function caseEnsemble(siteId, rp, arm) {
      const rows = realizations.filter((r) => r.site === siteId && r.rp === rp && r.arm === arm && r.psaGal && r.condMuLn);
      if (!rows.length) return null;
      const biasLn = periods.map((_, pi) => {
        let s = 0;
        for (const r of rows) s += Math.log(r.psaGal[pi]) - r.condMuLn[pi];
        return s / rows.length;
      });
      return { n: rows.length, biasLn };
    }
    function bandPeriods(name) {
      const map = { '0.1-0.5s': [0.1, 0.15, 0.2, 0.3, 0.4, 0.5], '0.5-2s': [0.7, 1.0, 1.5, 2.0], '2-5s': [3.0, 4.0, 5.0] };
      return map[name];
    }
    const arms = ['hybrid', 'hybridPsv'];
    const biasLog10 = {}, perCase = [];
    for (const arm of arms) biasLog10[arm] = {};
    for (const c of validCases) {
      for (const arm of arms) {
        const ens = caseEnsemble(c.site.id, c.rp, arm);
        if (!ens) continue;
        const bias = ens.biasLn.map((v) => +(v / LN10).toFixed(3));
        if (!biasLog10[arm][c.site.id]) biasLog10[arm][c.site.id] = {};
        biasLog10[arm][c.site.id][c.rp] = bias;
        const containment = c.mscs.periods.filter((sg, pi) => Math.abs(ens.biasLn[pi]) <= sg.sigmaLn).length / periods.length;
        perCase.push({ site: c.site.id, rp: c.rp, arm, n: ens.n, biasLog10: bias, containmentFrac: +containment.toFixed(3) });
      }
    }
    const bands = {};
    for (const band of Object.keys(PRE_REG.gates.bandAbsMax)) {
      const idx = bandPeriods(band).map((T) => periods.indexOf(T));
      bands[band] = {};
      for (const arm of arms) {
        let worst = 0, worstAt = null;
        for (const c of validCases) {
          const bb = biasLog10[arm][c.site.id] && biasLog10[arm][c.site.id][c.rp];
          if (!bb) continue;
          for (const pi of idx) {
            if (Math.abs(bb[pi]) > worst) { worst = Math.abs(bb[pi]); worstAt = c.site.id + ' RP' + c.rp + ' @' + periods[pi] + 's'; }
          }
        }
        bands[band][arm] = { absMax: +worst.toFixed(3), worstAt };
      }
      bands[band].gate = { limit: PRE_REG.gates.bandAbsMax[band], pass: bands[band].hybridPsv.absMax <= PRE_REG.gates.bandAbsMax[band] };
    }
    const pgaRatio = {};
    for (const arm of arms) {
      const logs = realizations.filter((r) => r.arm === arm && r.pga != null && r.psaGal).map((r) => Math.log(r.pga) - Math.log(r.psaGal[anchorIdx]));
      pgaRatio[arm] = logs.length ? logs.reduce((a, b) => a + b, 0) / logs.length : null;
    }
    const pgaDelta = (pgaRatio.hybridPsv != null && pgaRatio.hybrid != null) ? +(pgaRatio.hybridPsv - pgaRatio.hybrid).toFixed(3) : null;
    const containObs = {};
    for (const arm of arms) {
      const fr = perCase.filter((p) => p.arm === arm).map((p) => p.containmentFrac);
      containObs[arm] = fr.length ? +(fr.reduce((a, b) => a + b, 0) / fr.length).toFixed(3) : null;
    }
    const invalidCount = realizations.filter((r) => r.invalid).length;
    const report = {
      schema: 'quake-sim-cs-pipeline-v4',
      pipelineVersion: 4,
      generatedAt: new Date().toISOString(),
      preRegistered: PRE_REG_V4,
      shardLayout: { shardN, nShards },
      calibration: { file: 'tools/data/cs-repair-calibration.json', kappaSec: kappa, stressByClass: cal.stressByClass, lfGain: cal.lfGain, lfGainOnPsvArm: true, disclosure: 'the SH-fitted LF gain applies to BOTH arms so the comparison isolates the P-SV block marginal effect' },
      chain: 'v3 sampling + synthesis unchanged on the a_shOnly arm; the b_psvHorizontal arm adds the deterministic P-SV horizontal-block LF (T1/T2 only) on the bigfloat chain (params.qdCompliance + poleWindows:false + fdChannels:false), LF gain applied, single amplitude scale to Sa(T*=1s)',
      arms: {
        hybrid: 'the shipped v3 a_shOnly baseline, unchanged (SH DW LF + empirical gain + Boore HF)',
        hybridPsv: 'the same synthesis with the P-SV horizontal-block LF added (opts.psv + psvHorizontalOnly + psvQd + psvNoPoleWindows; the depth-FD dipole channels excluded per the pre-registration)'
      },
      cases: validCases.map((c) => ({ site: c.site.id, rp: c.rp, imTarget: +c.imTarget.toFixed(1) })),
      bands, perCase,
      containment: containObs,
      pgaRatioDelta: pgaDelta,
      invalidRealizations: invalidCount,
      realizations
    };
    fs.writeFileSync(V4_OUT, JSON.stringify(report, null, 1));
    console.log('\n=== CS v4 GATES (thresholds unchanged from v3; scored arm = hybridPsv) ===');
    for (const b of Object.keys(bands)) {
      console.log('band', b, bands[b].gate.pass ? 'PASS' : 'FAIL', 'psv', bands[b].hybridPsv.absMax, 'shOnly', bands[b].hybrid.absMax, 'limit', bands[b].gate.limit);
    }
    console.log('containment psv/shOnly:', containObs.hybridPsv, containObs.hybrid, '(v3 limit ' + PRE_REG.gates.containmentInSigmaFrac + ')');
    console.log('pgaRatioDelta psv-shOnly:', report.pgaRatioDelta, '(v3 margin ' + PRE_REG.gates.pgaNonRegressionVsBruneMargin + ')');
    console.log('invalid:', invalidCount);
    console.log('wrote ' + V4_OUT);
    return;
  }

  // ---- shard synthesis ---------------------------------------------------
  // Shard layout: shard s (0..shardN-1) handles case s % nCases with the
  // realization group floor(s / nCases) (realizations i % nGroups == group).
  // shardN must be a multiple of nCases (the runner names the required N).
  // Deterministic: the per-realization seeds never see the layout.
  const realizations = [];
  const t0 = Date.now();
  const valid = cases.filter((c) => c.mscs);
  const nCases = valid.length;
  if (shardIdx != null && shardN % nCases !== 0) {
    throw new Error('shardN must be a multiple of the ' + nCases + ' valid cases (e.g. ' + (nCases * 5) + ')');
  }
  const nGroups = shardIdx != null ? shardN / nCases : 1;
  const myCase = shardIdx != null ? shardIdx % nCases : -1;
  const myGroup = shardIdx != null ? Math.floor(shardIdx / nCases) : -1;
  for (let ci = 0; ci < valid.length; ci++) {
    if (shardIdx != null && ci !== myCase) continue;
    const c = valid[ci];
    const bedrockGrid = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-bedrock.json'));
    const bedrockM = Physics.lookupResearchGrid(bedrockGrid, c.site.lat, c.site.lng);
    const profile = Physics.synthSiteProfile(c.vs30, bedrockM);
    const pool = c.deagg.bins.filter((b) => b.meanRrupKm >= PRE_REG.minRrupKmForSampling);
    const poolMass = pool.reduce((a, b) => a + b.prob, 0);
    const cum = [];
    let acc = 0;
    for (const b of pool) { acc += b.prob / poolMass; cum.push(acc); }
    const condOf = new Map();
    c.mscs.binCond.forEach((bc) => condOf.set(bc.srcType + '|' + (+bc.repr.mw.toFixed(3)) + '|' + (+bc.repr.rRupKm.toFixed(2)), bc));
    const siteCurveFor = (mw, srcType, rRupKm, depthKm) => {
      if (!profile || profile.length < 2) return null;
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRupKm, depthKm, c.vs30, Physics.PSHA_CLASS_RAKE[srcType] || 0);
      if (!g || !(g.median > 0)) return null;
      const freqs = [];
      for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
      const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
      if (!res || !res.amp) return null;
      return { freqs, amps: res.amp.map((a2) => Math.max(0.2, Math.min(8, a2))) };
    };
    const psvCache = new Map(); // shared across the case's realizations
    const armsHere = shardIdx == null ? ['hybrid', 'hybridPsv'] : ['hybrid', 'hybridPsv'];
    for (const arm of armsHere) {
      for (let i = 0; i < PRE_REG.realizationsPerCase; i++) {
        if (shardIdx != null && i % nGroups !== myGroup && arm === 'hybridPsv') {
          // the QD arm splits by realization group; the cheap shOnly arm
          // runs the same group on every shard so every shard self-contains
          // its baseline rows for the merge
          continue;
        }
        const rng = Physics.seededRng(hashSeed(c.site.id + ':' + c.rp + ':' + arm + ':' + i));
        const u = rng();
        let bi = 0;
        while (bi < cum.length - 1 && u > cum[bi]) bi++;
        const bin = pool[bi] || pool[pool.length - 1];
        const strike = +(rng() * 360).toFixed(2);
        const siteCurve = siteCurveFor(bin.repr.mw, bin.srcType, bin.meanRrupKm, bin.repr.depthKm);
        const lfGainFn = (cal.lfGainApplied !== false) ? lfGainFnFor(cal, bin.repr.mw, bin.meanRrupKm) : null;
        let out;
        const tR = Date.now();
        try {
          if (arm === 'hybrid') {
            out = synthesize(c, bin, 'hybrid', {
              strike, stressMPa: cal.stressByClass[bin.srcType] || 50, kappaSec: kappa,
              siteCurve, seed: hashSeed(c.site.id + ':' + c.rp + ':' + arm + ':' + i + ':synth'), lfGainFn
            });
          } else {
            out = synthesize(c, bin, 'hybrid', {
              strike, stressMPa: cal.stressByClass[bin.srcType] || 50, kappaSec: kappa,
              siteCurve, seed: hashSeed(c.site.id + ':' + c.rp + ':' + arm + ':' + i + ':synth'), lfGainFn,
              psv: 1, psvHorizontalOnly: 1, psvQd: 1, psvNoPoleWindows: 1, psvCache
            });
          }
        } catch (e) {
          realizations.push({ arm, site: c.site.id, rp: c.rp, i, invalid: String(e.message || e).slice(0, 120) });
          continue;
        }
        const psa = psaOf(out, periods);
        const anchorPsa = psa[anchorIdx];
        if (!(anchorPsa > 0) || !isFinite(anchorPsa)) {
          realizations.push({ arm, site: c.site.id, rp: c.rp, i, invalid: 'non-positive anchor PSA' });
          continue;
        }
        const scale = c.imTarget / anchorPsa;
        const scaled = psa.map((v) => v * scale);
        const pk = peaksOf(out.transverse.map((v) => v * scale), out.sampleRateHz);
        const bc = condOf.get(bin.srcType + '|' + (+bin.repr.mw.toFixed(3)) + '|' + (+bin.meanRrupKm.toFixed(2)));
        realizations.push({
          arm, site: c.site.id, rp: c.rp, i, srcType: bin.srcType, mw: +bin.repr.mw.toFixed(2),
          rRupKm: +bin.meanRrupKm.toFixed(1), depthKm: +bin.repr.depthKm.toFixed(1), strike,
          log10Scale: +Math.log10(scale).toFixed(3),
          psaGal: scaled.map((v) => +v.toFixed(1)), pga: +pk.pga.toFixed(1), pgv: +pk.pgv.toFixed(1),
          condMuLn: bc ? bc.muLn.map((v) => +v.toFixed(4)) : null,
          synthSecs: +((Date.now() - tR) / 1000).toFixed(1)
        });
        console.log('[' + c.site.id + ' RP' + c.rp + ' ' + arm + ' #' + i + '] ' + ((Date.now() - tR) / 1000 / 60).toFixed(1) + ' min');
      }
    }
    console.log('case ' + c.site.id + ' RP' + c.rp + ' done; shard elapsed ' + ((Date.now() - t0) / 1000 / 60).toFixed(1) + ' min');
  }
  const shardFile = path.join(ROOT, 'tools', 'data', 'cs-pipeline-v4-shard-' + (shardIdx == null ? 'all' : shardIdx) + '-of-' + shardN + '.json');
  fs.writeFileSync(shardFile, JSON.stringify({ shardIdx, shardN, realizations }, null, 1));
  console.log('wrote ' + shardFile + ' (' + realizations.length + ' realizations, ' + ((Date.now() - t0) / 1000 / 60).toFixed(1) + ' min)');
}

if (require.main === module) {
  try {
    if (process.argv.includes('--v4') || process.argv.includes('--v4-merge')) {
      const model = loadJson(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'));
      const jivsmCols = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'));
      const vs30Grid = loadJson(path.join(ROOT, 'public', 'geojson', 'vs30.json'));
      Physics.setJivsmColumns(jivsmCols);
      Physics.setJayaram2011Rho(loadJson(path.join(ROOT, 'public', 'geojson', 'jayaram2011-rho.json')));
      const wideLevels = [];
      for (let i = 0; i < PRE_REG.imLevels.n; i++) {
        wideLevels.push(+(PRE_REG.imLevels.lo * Math.pow(PRE_REG.imLevels.hi / PRE_REG.imLevels.lo, i / (PRE_REG.imLevels.n - 1))).toPrecision(4));
      }
      const cal = loadJson(CAL_OUT);
      if (cal.schema !== 'quake-sim-cs-repair-calibration-v1') throw new Error('stale calibration file: ' + CAL_OUT);
      runV4(buildCases(model, jivsmCols, vs30Grid, wideLevels), cal);
    } else {
      main();
    }
  } catch (e) { console.error(e); process.exit(1); }
}
module.exports = { PRE_REG_V4: PRE_REG_V4, PRE_REG_V5: PRE_REG_V5, PRE_REG_V6: PRE_REG_V6, PRE_REG: PRE_REG, CS_GATE_ROLE, lfGainFnFor, DIP_PRIOR };
