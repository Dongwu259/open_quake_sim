'use strict';
// crest-fd-sh.js — SH-reduced FD-BVP referee (2026-09-11). The layered
// compliance adjudication crisis needs an independent verdict on LAYERED
// media; the SH (anti-plane) side of the same BVP formulation can be
// judged against core.js's shake91-anchored SH kernel (shUnitJumpResponse,
// 2x2 Thomson-Haskell). This module solves the IDENTICAL effective ODE
// core uses — s' = [[0,1/mu],[mu qT^2, 0]] s with mu real and damping via
// beta* = beta(1 - i/Q) inside qT (qT_radiation semantics) — by the box
// scheme on the graded, boundary-exact mesh, with the free-surface and
// radiation closures (tau = i qT mu u at the halfspace top) and the source
// traction jump (tau+ - tau- = J, u continuous). Independent NUMERICS,
// identical PHYSICS: agreement adjudicates the formulation; residual
// differences are pure discretization.
const core = require('./core.js');
const psv = require('./psv.js');
const { cadd, csub, cmul, cscale, cabs, cdiv } = core;

function qT(vsKmS, omega, kInvM, qShear) {
  const b = vsKmS * 1000;
  const b2 = qShear > 0 ? [b * b, -b * b / qShear] : [b * b, 0];
  const den = b2[0] * b2[0] + b2[1] * b2[1];
  const val = [omega * omega * b2[0] / den - kInvM * kInvM, -omega * omega * b2[1] / den];
  const r = Math.hypot(val[0], val[1]);
  return [Math.sqrt((r + val[0]) / 2), Math.sqrt(Math.max((r - val[0]) / 2, 0))];
}

/** Dense complex Gauss-Jordan with partial pivoting, single complex rhs. */
function solve1(M, rhs) {
  const n = M.length;
  // equilibration: the raw system mixes u/tr scales (kappa ~ 1e15) and
  // partial pivoting in double loses the small component — scale rows and
  // columns to O(1) first, solve, unscale (measured: the unequilibrated
  // solve returned u(0) violating its own u-equations by orders of
  // magnitude; the equilibrated one matches core to ~0.3%).
  const rowS = M.map((r) => 1 / Math.max(...r.map(cabs)));
  const colS = [];
  for (let j = 0; j < n; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, cabs(M[i][j]) * rowS[i]);
    colS.push(1 / (m || 1));
  }
  const A = M.map((r, i) => r.map((v, j) => cscale(cscale(v, rowS[i]), colS[j]))
    .concat([cscale(rhs[i], rowS[i])]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (cabs(A[r][col]) > cabs(A[piv][col])) piv = r;
    if (cabs(A[piv][col]) < 1e-300) throw new Error('singular SH FD system col ' + col);
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; }
    const pv = A[col][col];
    for (let j = col; j <= n; j++) A[col][j] = cdiv(A[col][j], pv);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f[0] === 0 && f[1] === 0) continue;
      for (let j = col; j <= n; j++) A[r][j] = csub(A[r][j], cmul(f, A[col][j]));
    }
  }
  return A.map((r, j) => cscale(r[n], colS[j]));
}

/** u(z=0) per unit tau_yz jump at zs — the same quantity as
 *  core.shUnitJumpResponse. mesh: { dz0Km, growth, dzMaxKm }. */
function shFdCompliance(stack, omega, k, zsKm, opts, mesh) {
  const st = psv.prepare(stack, zsKm);
  const layers = st.layers;
  const half = layers[st.halfIndex];
  const zMax = half.topKm > zsKm ? half.topKm : zsKm + 120;
  const zNodes = [0];
  let dz = mesh.dz0Km, z = 0;
  while (z < zMax - 1e-12 && zNodes.length < 20000) {
    dz = Math.min(dz * (mesh.growth || 1.1), mesh.dzMaxKm);
    z = Math.min(z + dz, zMax);
    zNodes.push(z);
  }
  const bounds = new Set(zNodes);
  for (const l of layers) {
    if (l.topKm > 1e-12 && l.topKm < zMax - 1e-12) bounds.add(l.topKm);
    if (isFinite(l.bottomKm) && l.bottomKm > 1e-12 && l.bottomKm < zMax - 1e-12) bounds.add(l.bottomKm);
  }
  if (zsKm > 1e-12 && zsKm < zMax - 1e-12) bounds.add(zsKm);
  const zAll = [...bounds].sort((a, b) => a - b);
  const zN = [zAll[0]];
  for (let i = 1; i < zAll.length; i++) if (zAll[i] - zN[zN.length - 1] > 1e-9) zN.push(zAll[i]);
  const N = zN.length - 1;
  let zsNode = 0;
  for (let i = 1; i <= N; i++) if (Math.abs(zN[i] - zsKm) < Math.abs(zN[zsNode] - zsKm)) zsNode = i;
  const matAt = (zk) => layers.find((l) => zk >= l.topKm - 1e-9 && zk < l.bottomKm - 1e-9) || half;
  const muOf = (l) => l.rhoGcm3 * 1000 * Math.pow(l.vsKmS * 1000, 2);
  const muH = muOf(half);
  const qs = (opts && opts.qShear) || 0;
  const qH = qT(half.vsKmS, omega, k, qs);
  const rad = cmul([0, 1], [muH * qH[0], muH * qH[1]]); // i qT mu
  // variables: s = [u, tr] per node (2 slots); the source node is split
  // into minus(above)/plus(below) blocks
  const ui = (node, plus) => {
    const base = node < zsNode ? node * 2 : (node === zsNode ? zsNode * 2 + (plus ? 2 : 0) : (node + 1) * 2);
    return base;
  };
  const ti = (node, plus) => ui(node, plus) + 1;
  const nVars = (N + 2) * 2;
  const M = [];
  const rhs = [];
  const zero = () => new Array(nVars).fill(null).map(() => [0, 0]);
  for (let i = 0; i < N; i++) {
    const dzi = zN[i + 1] - zN[i];
    const m = matAt(0.5 * (zN[i] + zN[i + 1]));
    const mu = muOf(m);
    const qm = qT(m.vsKmS, omega, k, qs);
    const muQ2 = mu * (qm[0] * qm[0] - qm[1] * qm[1]);
    const uL = ui(i, i === zsNode ? 1 : 0), tL = uL + 1;
    const uR = ui(i + 1, 0), tR = uR + 1;
    // u equation: u_R - u_L - (dz/2mu)(tr_L + tr_R) = 0
    {
      const row = zero();
      row[uL] = cadd(row[uL], [1, 0]);
      row[uR] = csub(row[uR], [1, 0]);
      const t = cscale(cdiv([1, 0], [mu, 0]), -dzi / 2);
      row[tL] = cadd(row[tL], t);
      row[tR] = cadd(row[tR], t);
      M.push(row); rhs.push([0, 0]);
    }
    // tr equation: tr_R - tr_L - (dz mu qT^2/2)(u_L + u_R) = 0
    {
      const row = zero();
      row[tL] = cadd(row[tL], [1, 0]);
      row[tR] = csub(row[tR], [1, 0]);
      const t = cscale([muQ2, 0], -dzi / 2);
      row[uL] = cadd(row[uL], t);
      row[uR] = cadd(row[uR], t);
      M.push(row); rhs.push([0, 0]);
    }
  }
  { const row = zero(); row[ti(0, 0)] = [1, 0]; M.push(row); rhs.push([0, 0]); } // tau(0)=0
  {
    const row = zero();
    row[ti(N, 0)] = cadd(row[ti(N, 0)], [1, 0]);
    row[ui(N, 0)] = csub(row[ui(N, 0)], rad);
    M.push(row); rhs.push([0, 0]);
  } // radiation: tau = i qT mu u
  { // u continuity across the source: u- - u+ = 0
    const row = zero();
    row[ui(zsNode, 0)] = [1, 0];
    row[ui(zsNode, 1)] = cscale([1, 0], -1);
    M.push(row); rhs.push([0, 0]);
  }
  { // tau jump: tau+ - tau- = 1
    const row = zero();
    row[ti(zsNode, 1)] = [1, 0];
    row[ti(zsNode, 0)] = cscale([1, 0], -1);
    M.push(row); rhs.push([1, 0]);
  }
  if (M.length !== nVars) throw new Error('eq count ' + M.length + ' != ' + nVars);
  const S = solve1(M, rhs);
  return { u0: S[ui(0, 0)], S, zNodes: zN, zsNode, ui, ti, nVars };
}

module.exports = { shFdCompliance };

if (require.main === module) {
  const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, rhoGcm3: 2.7 }];
  const omega = 2 * Math.PI * 0.5;
  console.log('== FD-SH vs core.shFullSpaceCompliance (exact) at HALF 0.5 Hz zs=15 ==');
  for (const kKm of [0.2, 0.3, 0.5]) {
    const k = kKm / 1000;
    const exact = core.shFullSpaceCompliance(HALF[0], omega, k, 15, 0, { qShear: 50 });
    const mine = shFdCompliance(HALF, omega, k, 15, { qShear: 50 }, { dz0Km: 0.005, growth: 1.1, dzMaxKm: 1 });
    const rel = Math.hypot(exact[0] - mine.u0[0], exact[1] - mine.u0[1]) / Math.hypot(exact[0], exact[1]);
    console.log('k', kKm, 'rel', rel.toExponential(2),
      '| exact', exact.map((v) => v.toExponential(3)).join(' '), '| fd', mine.u0.map((v) => v.toExponential(3)).join(' '));
  }
  console.log('== FD-SH vs core.shUnitJumpResponse at HALF (layered path) ==');
  for (const kKm of [0.2, 0.3, 0.5]) {
    const k = kKm / 1000;
    const ref = core.shUnitJumpResponse(HALF, omega, k, 15, 0, { qShear: 50 });
    const mine = shFdCompliance(HALF, omega, k, 15, { qShear: 50 }, { dz0Km: 0.005, growth: 1.1, dzMaxKm: 1 });
    const rel = Math.hypot(ref[0] - mine.u0[0], ref[1] - mine.u0[1]) / Math.hypot(ref[0], ref[1]);
    console.log('k', kKm, 'rel', rel.toExponential(2));
  }
}
