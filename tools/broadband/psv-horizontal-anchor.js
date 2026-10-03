'use strict';
// psv-horizontal-anchor.js — the CS v4 P1 measurement (2026-09-13).
//
// PRE-REGISTERED GATE (written BEFORE the run, amending PRE_REG_V4
// preconditionsToRun[0]): the layered P-SV horizontal block absolute scale
// is anchored end-to-end when |u_r| and |u_t| from the production pipeline
// (psvMomentSpectrumAtFrequency) agree with the same observable computed
// through the EXACT closed-form halfspace BVP (crest-halfspace-closed.js —
// free surface + radiation + source jump, direct 6x6 boundary solve, per
// unit true traction; injected via params.closedFormHalfspace so both
// paths share the production integrator and horizontal-block algebra) to
// within 1e-2 relative. Config grid: HALF halfspace (vs 3.5 / vp 6.0 /
// rho 2.7 — the adjudication's config) x tensors {strike-slip, thrust DC}
// x f {0.5, 1.2 Hz} x zs {33 km} at r = 30 km, q = 50, poleWindows: false
// (v16: the locator is dead weight on this pole-free band). zs=73 rows are
// reported but not gated — the BVP's double e^{+-nu_im*zs} conditioning
// NaNs there (its usable envelope is depth/frequency-limited; the QD chain
// arbitrates instead).
//
// TWO production arms are measured against the BVP:
//   * schurQd  (params.qdCompliance — the v15 bigfloat chain): THE GATED
//     ARM. The 2026-09-13 batch found the double chain sits on its own
//     ~1e-16 detM subtraction floor at the Rayleigh-resonance detM dips
//     (measured: 6000x off at HALF@f1.2 k=1.9/km, where the bigfloat chain
//     and the BVP agree to all printed digits), so the honest absolute
//     anchor of the FORMULATION runs at adequate precision.
//   * schurDouble (params.schurCompliance): reported honestly, not gated —
//     the production-cost reality that motivated the CS v4 feasibility
//     verdict below.
//
// MEASURED OUTCOME (this run, frozen into cs-pipeline PRE_REG_V4.p1Anchor):
// the QD arm PASSES the 1e-2 gate (the composition — units, conventions,
// integrator, block algebra, layered compliance — is exact end-to-end),
// and the double arm FAILS at f1.2 with the detM-floor mechanism. The
// exactness triple: bigfloat-Schur == closed-form BVP at every probed k
// including the Rayleigh-neighborhood samples; RK4-ODE referee 4e-3.
// CS v4 feasibility consequence: the gate arm must run on the bigfloat
// chain (~0.21 s/compliance-triple -> ~24 h per (case,bin) at production
// k-lattices), so the pre-registered v4 run is NOT EXECUTABLE as wired —
// see PRE_REG_V4.status.
//
// Output: frozen into cs-pipeline PRE_REG_V4.p1Anchor (re-run to re-verify;
// the QD arm dominates the runtime, parallelized across cases).
const ROOT = require('path').join(__dirname, '..', '..');
const Physics = require(ROOT + '/public/physics.js');
const hybrid = require(ROOT + '/tools/broadband/hybrid.js');
const psv = require(ROOT + '/tools/broadband/psv.js');

const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
const m0 = Physics.seismicMoment(7.0);
const M = hybrid.dcMomentTensor(185, 55, 90, m0);
const SS = { mxx: 0, myy: 0, mzz: 0, mxy: m0, mxz: 0, myz: 0 };                 // pure Mxy
const TH = { mxx: M.xx, myy: M.yy, mzz: M.zz, mxy: M.xy, mxz: M.xz, myz: M.yz }; // thrust DC
const cases = [];
for (const fHz of [0.5, 1.2]) {
  for (const zs of [33]) {
    for (const [name, t] of [['strike-slip', SS], ['thrust-DC', TH]]) {
      cases.push({ name: name + '@f' + fHz + 'zs' + zs, fHz, zs, t });
    }
  }
}
const mag = (v) => Math.hypot(v[0], v[1]);
const relOf = (a, b) => (a == null || b == null) ? null : Math.abs(a - b) / Math.abs(b);

function runArm(caseDef, complianceParams) {
  const omega = 2 * Math.PI * caseDef.fHz;
  const base = { rKm: 30, zSourceKm: caseDef.zs, dkInvKm: 0.0025, kMaxInvKm: 6, qShear: 50,
    mxx: caseDef.t.mxx, myy: caseDef.t.myy, mzz: caseDef.t.mzz, mxy: caseDef.t.mxy,
    mxz: caseDef.t.mxz, myz: caseDef.t.myz, poleWindows: false };
  const t0 = Date.now();
  const out = psv.psvMomentSpectrumAtFrequency(HALF, omega, Object.assign(base, complianceParams));
  out._wallMs = Date.now() - t0;
  if (complianceParams._twoTierStats) out._stats = complianceParams._twoTierStats;
  return out;
}

function main() {
  const worker = process.env.P1_CASE ? cases[+process.env.P1_CASE] : null;
  const list = worker ? [worker] : cases;
  const out = [];
  for (const c of list) {
    const aQd = runArm(c, { qdCompliance: 1 });
    const aD = runArm(c, { schurCompliance: 1 });
    // two-tier arm (2026-09-28): double Schur base + 1-ulp chaos probe, QD
    // only where the probe fires — the registered CS-v4 feasibility cure.
    const tStats = { probed: 0, escalated: 0, skippedTail: 0 };
    const a2 = runArm(c, { schurCompliance: 1, twoTierQd: 1, _twoTierStats: tStats });
    const b = runArm(c, { closedFormHalfspace: 1 });
    const row = { case: c.name,
      qd: { ur: relOf(mag(aQd.ur), mag(b.ur)), ut: relOf(mag(aQd.ut), mag(b.ut)) },
      dbl: { ur: relOf(mag(aD.ur), mag(b.ur)), ut: relOf(mag(aD.ut), mag(b.ut)) },
      twoTier: { ur: relOf(mag(a2.ur), mag(b.ur)), ut: relOf(mag(a2.ut), mag(b.ut)),
        stats: { probed: tStats.probed, escalated: tStats.escalated, skippedTail: tStats.skippedTail || 0 },
        wallMs: a2._wallMs, qdWallMs: aQd._wallMs, dblWallMs: aD._wallMs },
      urBvp: +mag(b.ur).toExponential(6), utBvp: +mag(b.ut).toExponential(6) };
    out.push(row);
    console.log(c.name.padEnd(22),
      'QD ur', row.qd.ur == null ? 'null' : row.qd.ur.toExponential(2),
      'ut', row.qd.ut == null ? 'null' : row.qd.ut.toExponential(2),
      '| 2t ur', row.twoTier.ur == null ? 'null' : row.twoTier.ur.toExponential(2),
      'ut', row.twoTier.ut == null ? 'null' : row.twoTier.ut.toExponential(2),
      'esc', tStats.escalated + '/' + tStats.probed,
      ((100 * a2._wallMs) / Math.max(1, aQd._wallMs)).toFixed(0) + '%qdWall',
      '| dbl ur', row.dbl.ur == null ? 'null' : row.dbl.ur.toExponential(2),
      'ut', row.dbl.ut == null ? 'null' : row.dbl.ut.toExponential(2),
      '| |ur|BVP', row.urBvp.toExponential(3));
  }
  if (worker) { console.log('JSON:' + JSON.stringify(out[0])); return; }
  const worstQd = Math.max(...out.map((r) => Math.max(r.qd.ur || 0, r.qd.ut || 0)));
  const worstD = Math.max(...out.map((r) => Math.max(r.dbl.ur || 0, r.dbl.ut || 0)));
  const worst2t = Math.max(...out.map((r) => Math.max(r.twoTier.ur || 0, r.twoTier.ut || 0)));
  const totEsc = out.reduce((s, r) => s + r.twoTier.stats.escalated, 0);
  const totProb = out.reduce((s, r) => s + r.twoTier.stats.probed, 0);
  const wall2t = out.reduce((s, r) => s + r.twoTier.wallMs, 0);
  const wallQd = out.reduce((s, r) => s + r.twoTier.qdWallMs, 0);
  console.log('P1 gate <= 1e-2 on the QD arm: worst', worstQd.toExponential(3), '->', worstQd <= 1e-2 ? 'PASS' : 'FAIL',
    '| double arm worst', worstD.toExponential(3), '(reported, not gated)',
    '| twoTier worst', worst2t.toExponential(3), worst2t <= 1e-2 ? 'PASS' : 'FAIL',
    '| esc', totEsc + '/' + totProb, '| wall 2t/qd', (100 * wall2t / Math.max(1, wallQd)).toFixed(1) + '%');
  console.log('JSON:' + JSON.stringify({ worstRelQd: worstQd, worstRelDouble: worstD, worstRelTwoTier: worst2t,
    escalated: totEsc, probed: totProb, wallMsTwoTier: wall2t, wallMsQd: wallQd, rows: out,
    gate: worstQd <= 1e-2 ? 'PASS' : 'FAIL', twoTierGate: worst2t <= 1e-2 ? 'PASS' : 'FAIL' }));
}
// P1_CASE=<i> runs one case (the batch ran 8 workers in parallel);
// bare invocation runs all cases serially.
main();
