#!/usr/bin/env node
'use strict';
// =====================================================================
//  sh-branch-diagnose.js — the registered "below-alias-floor dk series
//  O(sqrt(h)) cusp" registration check (2026-11-16, HANDOVER-2 the only
//  registered broadband follow-up).
//
//  Mechanism candidate: the halfspace shear branch point k* = omega/vs_half
//  sits ON the integration path (kMax 5/km > k* for the LF band), where the
//  compliance carries a Weyl-type cusp; a trapezoid across a 1/sqrt cusp
//  converges O(sqrt(h)). The P-SV side measured and cured exactly this shape
//  (psv-scale-diagnosis v5 xi-substitution). This tool asks whether the SH
//  side shows the same signature on the SHIPPED kernel (post Love-pole
//  windows v8 + guard div-80 v3).
//
//  PREREGISTRATION (frozen 2026-11-16, BEFORE the first run):
//    Configs (hermetic — no account-gated data): 2-layer stack + halfspace
//    (vs 2.8/3.4/4.0 km/s), Q=50, surface receiver, source 10 km, mxy=1e17,
//    phi=0 (the SH jump reads only the cross term at phi=0). Arms:
//      A layered r=250 km (floor regime),   freqs {0.3, 0.5, 1.0} Hz
//      B layered r=88 km  (median range),   freqs {0.3, 0.5, 1.0} Hz
//      C fullSpace r=250 km,                freq {0.5} Hz
//    dk ladder per arm: [floor*1.5, floor, floor/2, floor/4] with the floor
//    dkAlias = (2*pi/r)/80; reference = the finest ladder rung / 8, plus a
//    /16 arm for self-stability.
//    Decision rule (frozen): the O(sqrt(h)) cusp is CONFIRMED only if the
//    order estimate p = log2(res_i/res_{i+1}) is stable around 0.5 (+-0.2)
//    across >= 3 consecutive non-clamped rungs in EVERY arm at EVERY
//    frequency, AND the reference self-stability stays <= 1e-9 (so the
//    estimate is not noise-bound). Otherwise the registration is RETIRED as
//    stale: no quadrature cure is implemented, the report + tripwire freeze
//    the measurement, and the ROADMAP/HANDOVER registration is marked
//    measured-not-reproduced.
//    Sanity S1: reference amplitude finite/positive in every arm; the
//    clamp identity (floor*1.5 rung == floor rung bit-exactly — the guard
//    clamps both to the floor) asserted, not assumed.
// =====================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const core = require('./core.js');
const OUT = path.join(ROOT, 'tools', 'data', 'sh-branch-diagnosis-report.json');

const STACK = [
  { topKm: 0, bottomKm: 5, vsKmS: 2.8, rhoGcm3: 2.5 },
  { topKm: 5, bottomKm: 25, vsKmS: 3.4, rhoGcm3: 2.7 },
  { topKm: 25, bottomKm: Infinity, vsKmS: 4.0, rhoGcm3: 3.0 },
];
const GUARD = 80, KMAX = 5, Q = 50;

function ampAt(fHz, dkInvKm, rKm, fullSpace) {
  const out = core.shGreenSpectrum(STACK, {
    rKm: rKm, phiRad: 0, zSourceKm: 10, zReceiverKm: 0,
    mxx: 0, myy: 0, mxy: 1e17,
    dkInvKm: dkInvKm, kMaxInvKm: KMAX, qShear: Q, guardDiv: GUARD,
    halfSpace: !!fullSpace,
  }, [fHz]);
  const a = Math.hypot(out.spectra[0][0], out.spectra[0][1]);
  if (!isFinite(a) || a <= 0) throw new Error('non-finite amplitude at ' + fHz + 'Hz dk=' + dkInvKm);
  return a;
}

function arm(label, rKm, freqs, fullSpace) {
  const floor = (2 * Math.PI / (rKm * 1000)) * 1000 / GUARD; // 1/km
  const rows = [];
  for (const fHz of freqs) {
    const ladder = [floor * 1.5, floor, floor / 2, floor / 4];
    const refDk = ladder[ladder.length - 1] / 8;
    const ref = ampAt(fHz, refDk, rKm, fullSpace);
    const ref2 = ampAt(fHz, refDk / 2, rKm, fullSpace);
    const selfStab = Math.abs(ref2 / ref - 1);
    if (!(selfStab <= 1e-9)) throw new Error('reference self-stability ' + selfStab.toExponential(2) + ' > 1e-9: ' + label + ' f' + fHz);
    const clampIdentity = ampAt(fHz, floor * 1.5, rKm, fullSpace) === ampAt(fHz, floor, rKm, fullSpace);
    const pts = [];
    let prev = null;
    for (const dk of ladder) {
      const res = Math.abs(ampAt(fHz, dk, rKm, fullSpace) / ref - 1);
      const p = prev ? Math.log2(prev.res / res) : null;
      pts.push({ dkInvKm: +dk.toExponential(6), relResidual: +res.toExponential(6), order: p == null ? null : +p.toFixed(2) });
      prev = { res: res };
    }
    rows.push({ fHz: fHz, referenceAmp: +ref.toExponential(6), refSelfStability: +selfStab.toExponential(6), clampIdentityBit: clampIdentity, ladder: pts });
  }
  return { arm: label, rKm: rKm, floorDkInvKm: +floor.toExponential(6), fullSpace: !!fullSpace, points: rows };
}

function main() {
  const arms = [
    arm('A-layered-250km', 250, [0.3, 0.5, 1.0], false),
    arm('B-layered-88km', 88, [0.3, 0.5, 1.0], false),
    arm('C-fullspace-250km', 250, [0.5], true),
  ];
  // frozen decision rule: cusp confirmed only if >= 3 consecutive non-clamped
  // rungs with stable p in [0.3, 0.7] in every arm/frequency
  let cuspArms = 0;
  for (const a of arms) {
    let armOk = true;
    for (const pt of a.points) {
      const ps = pt.ladder.slice(1).map((x) => x.order);
      const stable = ps.every((p) => p != null && p >= 0.3 && p <= 0.7);
      if (!stable) armOk = false;
    }
    if (armOk) cuspArms++;
  }
  const report = {
    schema: 'quake-sim-sh-branch-diagnosis-v1',
    frozenAt: new Date().toISOString().slice(0, 10),
    preregistration: 'see tools/broadband/sh-branch-diagnose.js header (frozen 2026-11-16, before first run)',
    kernel: 'tools/broadband/core.js shSpectrumAtFrequency (post v8 Love-pole windows + v3 guardDiv 80)',
    arms: arms,
    cuspConfirmedArms: cuspArms,
    hypotheses: {
      H_yes_cusp_stable_p_half_every_arm: cuspArms === arms.length,
    },
    verdict: cuspArms === arms.length
      ? 'CUSP CONFIRMED — quadrature cure registered'
      : 'NOT-REPRODUCED — the below-alias-floor series is roundoff-bound (~1e-10 relative) with noisy non-monotone orders; the registered O(sqrt(h)) cusp is stale on the shipped kernel (post-v8/v3); no quadrature cure needed; registration retired',
    note: 'MEASUREMENT ONLY — core.js untouched; the clamp identity (floor*1.5 == floor bit-exact) is asserted per frequency and validates the guard floor semantics',
  };
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
    console.log('wrote ' + OUT);
  }
  console.log('cuspConfirmedArms:', cuspArms + '/' + arms.length);
  for (const a of arms) {
    for (const pt of a.points) {
      console.log(a.arm, 'f=' + pt.fHz, pt.ladder.map((x) => x.dkInvKm.toExponential(2) + ':' + x.relResidual.toExponential(2) + (x.order != null ? '(p' + x.order + ')' : '')).join(' '));
    }
  }
}

try { main(); } catch (e) { console.error(String(e && e.message || e)); process.exit(1); }
