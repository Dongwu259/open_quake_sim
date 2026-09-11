'use strict';
// crest-fd-referee.js — fully independent boundary-value referee for the
// layered P-SV compliance. Box-scheme finite differences of the first-order
// system s' = A(z) s over [0, halfTop], free surface tau(0) = 0, halfspace
// radiation tau = Y u at depth, source traction jump J at z_s (u continuous,
// tau^+ - tau^- = J). Dense complex Gaussian elimination, both unit-jump
// right-hand sides in ONE factorization. Shares NO propagator/algebra with
// the chains — the only shared ingredients are the layer ODE matrix A
// (validated) and the halfspace admittance Y (validated 1e-15). Grid 2 km:
// second-order FD, few-% accuracy — plenty to adjudicate the O(1) chain
// disagreements in the crest band.
// State convention: TRUE traction (layerA's scaled rows are conjugated back
// by S = diag(1,1,mu*,mu*)) so the BCs and the jump carry physical units.
const core = require('./core.js');
const psv = require('./psv.js');
const { layerA } = require('./crest-probe-lib.js');
const cadd = core.cadd, csub = core.csub, cmul = core.cmul, cscale = core.cscale, cabs = core.cabs, cdiv = core.cdiv;

/** Dense complex solve with multiple right-hand sides (partial pivoting).
 *  M: n x n, B: n x R. Returns n x R. */
function solveDense(M, B) {
  const n = M.length, R = B[0].length;
  const A = M.map((r, i) => r.slice().concat(B[i].slice()));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (cabs(A[r][col]) > cabs(A[piv][col])) piv = r;
    if (cabs(A[piv][col]) < 1e-300) throw new Error('singular FD system at col ' + col);
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; }
    const pv = A[col][col];
    for (let j = col; j < n + R; j++) A[col][j] = cdiv(A[col][j], pv);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f[0] === 0 && f[1] === 0) continue;
      for (let j = col; j < n + R; j++) A[r][j] = csub(A[r][j], cmul(f, A[col][j]));
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(A[i].slice(n));
  return out;
}

/** A in the TRUE-traction state convention. */
function layerATrue(layer, omega, k, opts) {
  const A = layerA(layer, omega, k, opts);
  const rho = layer.rhoGcm3 * 1000;
  const muR = rho * Math.pow(layer.vsKmS * 1000, 2);
  const qs = (opts && opts.qShear) || 0;
  const muC = qs > 0 ? [muR, -muR / qs] : [muR, 0];
  const iMu = cdiv([1, 0], muC);
  return A.map((row, i) => row.map((v, j) => {
    let o = v;
    if (i >= 2) o = cmul(o, muC);
    if (j >= 2) o = cmul(o, iMu);
    return o;
  }));
}

/** Compliance via the FD BVP. Returns the 2x2 surface compliance
 *  (u(0) per unit traction jump at zs), true-traction units — the same
 *  convention as psvSurfaceCompliance. hKm: uniform grid step, OR pass
 *  opts2 = { graded: { dz0Km, growth, dzMaxKm } } for a surface-graded
 *  mesh (resolves thin soft sediment layers the uniform grid cannot). */
function fdCompliance(stack, omega, k, zsKm, opts, hKm, opts2) {
  const st = psv.prepare(stack, zsKm);
  const layers = st.layers;
  const half = layers[st.halfIndex];
  // domain: the true halfspace top; when the source itself sits inside the
  // halfspace (halfspace top above the source), the admittance is
  // depth-independent there — truncate at zs + margin instead of prepare()'s
  // 1e6 km sentinel.
  const zMax = half.topKm > zsKm ? half.topKm : zsKm + 120;
  // node depths. Uniform (hKm) or surface-graded geometric growth.
  const zNodes = [0];
  if (opts2 && opts2.graded) {
    const gr = opts2.graded;
    let dz = gr.dz0Km, z = 0;
    while (z < zMax - 1e-12 && zNodes.length < 20000) {
      dz = Math.min(dz * (gr.growth || 1.15), gr.dzMaxKm || hKm);
      z = Math.min(z + dz, zMax);
      zNodes.push(z);
    }
  } else {
    const N = Math.round(zMax / hKm);
    const dz = zMax / N;
    for (let i = 1; i <= N; i++) zNodes.push(i * dz);
  }
  const N0 = zNodes.length - 1;
  // layer boundaries MUST be grid nodes: the box scheme takes one material
  // per interval (at its midpoint) — an interval straddling an interface
  // smears the discontinuity (measured: O(30%) compliance error on the R11
  // 3-layer stack before this fix; grid "convergence" in dzMax alone never
  // saw it because the surface grading was held fixed).
  const bounds = new Set(zNodes);
  for (const l of layers) {
    if (l.topKm > 1e-12 && l.topKm < zMax - 1e-12) bounds.add(l.topKm);
    if (isFinite(l.bottomKm) && l.bottomKm > 1e-12 && l.bottomKm < zMax - 1e-12) bounds.add(l.bottomKm);
  }
  if (zsKm > 1e-12 && zsKm < zMax - 1e-12) bounds.add(zsKm);
  const zAll = [...bounds].sort((a, b) => a - b);
  // drop nodes closer than 1e-9 km together
  const zNodes2 = [zAll[0]];
  for (let i = 1; i < zAll.length; i++) if (zAll[i] - zNodes2[zNodes2.length - 1] > 1e-9) zNodes2.push(zAll[i]);
  zNodes.length = 0;
  for (const z of zNodes2) zNodes.push(z);
  const N = zNodes.length - 1;
  void N0;
  const zOf = (i) => zNodes[i];
  // source snapped to the nearest node
  let zsNode = 0;
  for (let i = 1; i <= N; i++) if (Math.abs(zNodes[i] - zsKm) < Math.abs(zNodes[zsNode] - zsKm)) zsNode = i;
  const matAt = (zKm) => layers.find((l) => zKm >= l.topKm - 1e-9 && zKm < l.bottomKm - 1e-9) || half;
  const Y = psv.psvHalfspaceAdmittance(half, omega, k, opts);
  if (!Y) return null;
  // unknowns: s_0..s_{zs-1}, s_zs^-, s_zs^+, s_{zs+1}..s_N  -> (N+2)*4
  const idx = (node, comp, plus) => {
    const base = node < zsNode ? node * 4 : (node === zsNode ? zsNode * 4 + (plus ? 4 : 0) : (node + 1) * 4);
    return base + comp;
  };
  const nVars = (N + 2) * 4;
  const zero = () => new Array(nVars).fill(null).map(() => [0, 0]);
  const M = [];
  const B = [];
  const eq = (row, r0, r1) => { M.push(row); B.push([r0 || [0, 0], r1 || [0, 0]]); };
  // box scheme on every interval (variable dz)
  for (let i = 0; i < N; i++) {
    const dzi = zOf(i + 1) - zOf(i);
    const zm = 0.5 * (zOf(i) + zOf(i + 1));
    const A = layerATrue(matAt(zm), omega, k, opts);
    const usePlusL = (i === zsNode);      // left node is the split node
    const useMinusR = (i + 1 === zsNode); // right node is the split node
    for (let c = 0; c < 4; c++) {
      const row = zero();
      row[idx(i, c, usePlusL ? 1 : 0)] = cadd(row[idx(i, c, usePlusL ? 1 : 0)], [1, 0]);
      row[idx(i + 1, c, 0)] = csub(row[idx(i + 1, c, 0)], [1, 0]);
      for (let l2 = 0; l2 < 4; l2++) {
        const term = cscale(A[c][l2], -dzi / 2);
        const li = idx(i, l2, usePlusL ? 1 : 0);
        const ri = idx(i + 1, l2, 0);
        row[li] = cadd(row[li], term);
        row[ri] = cadd(row[ri], term);
      }
      eq(row);
    }
  }
  // free surface: tau(0) = 0
  for (const c of [2, 3]) {
    const row = zero();
    row[idx(0, c, 0)] = [1, 0];
    eq(row);
  }
  // radiation at z_N: tau = Y u
  for (let r = 0; r < 2; r++) {
    const row = zero();
    for (let c = 0; c < 2; c++) row[idx(N, c, 0)] = csub(row[idx(N, c, 0)], Y[r][c]);
    row[idx(N, 2 + r, 0)] = cadd(row[idx(N, 2 + r, 0)], [1, 0]);
    eq(row);
  }
  // source: u continuity (minus = plus), tau jump (plus - minus = J_rhs)
  for (const c of [0, 1]) {
    const row = zero();
    row[idx(zsNode, c, 0)] = [1, 0];
    row[idx(zsNode, c, 1)] = cscale([1, 0], -1);
    eq(row);
  }
  for (const c of [2, 3]) {
    const row = zero();
    row[idx(zsNode, c, 1)] = [1, 0];
    row[idx(zsNode, c, 0)] = cscale([1, 0], -1);
    eq(row, c === 2 ? [1, 0] : [0, 0], c === 3 ? [1, 0] : [0, 0]);
  }
  if (M.length !== nVars) throw new Error('equation count ' + M.length + ' != vars ' + nVars);
  const S = solveDense(M, B);
  if (opts2 && opts2.wantProfile) {
    // full nodal state (both rhs) — adjudication diagnostics
    return { C: [[S[idx(0, 0, 0)][0], S[idx(0, 0, 0)][1]], [S[idx(0, 1, 0)][0], S[idx(0, 1, 0)][1]]],
      zNodes: zNodes.slice(), S };
  }
  // compliance = u(0) per unit jump: column j of C is u_0 for rhs j
  const ur0 = S[idx(0, 0, 0)], uz0 = S[idx(0, 1, 0)];
  return [[ur0[0], ur0[1]], [uz0[0], uz0[1]]];
}

module.exports = { fdCompliance: fdCompliance, layerATrue: layerATrue };

if (require.main === module) {
  const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
  const omega = 2 * Math.PI * 0.5, zs = 15;
  for (const kKm of [0.2, 0.5]) {
    const k = kKm / 1000;
    const a = psv.psvSurfaceCompliance(HALF, omega, k, zs, { qShear: 50, qP: 50 });
    const b = fdCompliance(HALF, omega, k, zs, { qShear: 50, qP: 50 }, 1);
    let num = 0, den = 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      num = Math.max(num, Math.hypot(a[i][j][0] - b[i][j][0], a[i][j][1] - b[i][j][1]));
      den = Math.max(den, Math.hypot(b[i][j][0], b[i][j][1]));
    }
    console.log('HALF 0.5Hz zs15 k', kKm, 'fd-vs-prod rel', (num / den).toExponential(2));
  }
}
