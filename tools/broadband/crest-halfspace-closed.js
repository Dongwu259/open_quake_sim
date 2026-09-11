'use strict';
// crest-halfspace-closed.js — exact closed-form compliance of a
// HOMOGENEOUS halfspace with a buried traction jump: the ground truth for
// the FD BVP referee on HALF configs (no discretization, no chain
// transport). Unknowns: upgoing x, downgoing y (amplitudes at the source
// depth, above-source region), downgoing d (below-source region, radiates).
// Equations: free surface tau(0)=0, u continuity at zs, tau jump = J at zs.
// u(0) = surface displacement per unit jump = the compliance.
const core = require('./core.js');
const psv = require('./psv.js');
const { cmul, cscale, cabs, cdiv, cadd, csub } = core;

function inv2(A) {
  const det = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0]));
  return [[cdiv(A[1][1], det), cscale(cdiv(A[0][1], det), -1)], [cscale(cdiv(A[1][0], det), -1), cdiv(A[0][0], det)]];
}
function mul2(A, B) {
  return [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])), cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
          [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])), cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
}
function expI(nu, h, sgn) { // e^{sgn * i nu h}
  return [Math.exp(-sgn * nu[1] * h) * Math.cos(sgn * nu[0] * h), Math.exp(-sgn * nu[1] * h) * Math.sin(sgn * nu[0] * h)];
}

/** 2x2 compliance, true-traction units. lay: homogeneous layer; zsM metres. */
function halfspaceClosedCompliance(lay, omega, k, zsM, opts) {
  const E = psv.psvEigenvectors(lay, omega, k, opts);
  // columns: 0=P down(+i nuA), 1=P up, 2=SV down(+i nuB), 3=SV up
  const Eu = [[E[0][1], E[0][3]], [E[1][1], E[1][3]]];       // u of upgoing
  const Ed = [[E[0][0], E[0][2]], [E[1][0], E[1][2]]];       // u of downgoing
  const Tu = [[E[2][1], E[2][3]], [E[3][1], E[3][3]]];       // tau of upgoing
  const Td = [[E[2][0], E[2][2]], [E[3][0], E[3][2]]];       // tau of downgoing
  const nuA = psv.nuOf(lay.vpKmS, omega, k, opts && opts.qP);
  const nuB = psv.nuOf(lay.vsKmS, omega, k, opts && opts.qShear);
  // amplitude phase factors from zs to the surface
  const upTo0 = [expI(nuA, zsM, +1), expI(nuB, zsM, +1)];    // x(0) = x .* upTo0
  const dnTo0 = [expI(nuA, zsM, -1), expI(nuB, zsM, -1)];    // y(0) = y .* dnTo0
  const Td0 = [[cmul(Td[0][0], dnTo0[0]), cmul(Td[0][1], dnTo0[1])], [cmul(Td[1][0], dnTo0[0]), cmul(Td[1][1], dnTo0[1])]];
  const Tu0 = [[cmul(Tu[0][0], upTo0[0]), cmul(Tu[0][1], upTo0[1])], [cmul(Tu[1][0], upTo0[0]), cmul(Tu[1][1], upTo0[1])]];
  // unknown vector V = [x0, y0, d] (x0 = upgoing amplitude at zs referred
  // to... phases at zs cancel in the jump equations when all amplitudes are
  // taken AT zs with the surface phases only in the surface BC)
  const n = 6;
  const rows = [];
  const rhs = [];
  const eq = (r, b) => { rows.push(r); rhs.push(b); };
  const Z = [0, 0];
  const put = (r, i, v) => { r[i] = v; };
  // (1) surface: Tu0 x + Td0 y = 0  (2 eqs, unknowns 0..1, 2..3)
  for (let r = 0; r < 2; r++) {
    const row = new Array(n).fill(Z);
    put(row, 0, Tu0[r][0]); put(row, 1, Tu0[r][1]);
    put(row, 2, Td0[r][0]); put(row, 3, Td0[r][1]);
    eq(row, Z);
  }
  // (2) u continuity at zs: Eu x + Ed y - Ed d = 0  (unknowns 0..1, 2..3, 4..5)
  for (let r = 0; r < 2; r++) {
    const row = new Array(n).fill(Z);
    put(row, 0, Eu[r][0]); put(row, 1, Eu[r][1]);
    put(row, 2, Ed[r][0]); put(row, 3, Ed[r][1]);
    put(row, 4, cscale(Ed[r][0], -1)); put(row, 5, cscale(Ed[r][1], -1));
    eq(row, Z);
  }
  // (3) tau jump: Tu x + Td y - Td d = J  (J = rhs e_r, true traction units)
  for (let r = 0; r < 2; r++) {
    const row = new Array(n).fill(Z);
    put(row, 0, Tu[r][0]); put(row, 1, Tu[r][1]);
    put(row, 2, Td[r][0]); put(row, 3, Td[r][1]);
    put(row, 4, cscale(Td[r][0], -1)); put(row, 5, cscale(Td[r][1], -1));
    eq(row, Z);
  }
  // solve twice for the two unit jumps
  const out = [[Z, Z], [Z, Z]];
  for (let j = 0; j < 2; j++) {
    // Gaussian elimination on [rows | rhs with e_j in equations 4+r]
    const A = rows.map((r, i) => r.slice().concat([i >= 4 && i - 4 === j ? [1, 0] : Z]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r2 = col + 1; r2 < n; r2++) if (cabs(A[r2][col]) > cabs(A[piv][col])) piv = r2;
      if (cabs(A[piv][col]) < 1e-300) throw new Error('singular closed-form system');
      const t = A[col]; A[col] = A[piv]; A[piv] = t;
      const pv = A[col][col];
      for (let cc = col; cc <= n; cc++) A[col][cc] = cdiv(A[col][cc], pv);
      for (let r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        const f = A[r2][col];
        if (f[0] === 0 && f[1] === 0) continue;
        for (let cc = col; cc <= n; cc++) A[r2][cc] = csub(A[r2][cc], cmul(f, A[col][cc]));
      }
    }
    const x = A.map((r2) => r2[n]); // V = [x0', y0', d] at zs phases
    // surface displacement: u(0) = Eu (x .* upTo0) + Ed (y .* dnTo0)
    const xs = [cmul(x[0], upTo0[0]), cmul(x[1], upTo0[1])];
    const ys = [cmul(x[2], dnTo0[0]), cmul(x[3], dnTo0[1])];
    out[0][j] = cadd(cmul(Eu[0][0], xs[0]), cmul(Eu[0][1], xs[1]));
    {
      const acc = cadd(cmul(Eu[1][0], xs[0]), cmul(Eu[1][1], xs[1]));
      out[1][j] = cadd(acc, cadd(cmul(Ed[1][0], ys[0]), cmul(Ed[1][1], ys[1])));
    }
    out[0][j] = cadd(out[0][j], cadd(cmul(Ed[0][0], ys[0]), cmul(Ed[0][1], ys[1])));
  }
  return out;
}

module.exports = { halfspaceClosedCompliance };

if (require.main === module) {
  const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
  const fdmod = require('./crest-fd-referee.js');
  for (const [fHz, zs] of [[0.5, 15], [1.2, 73]]) {
    const omega = 2 * Math.PI * fHz;
    for (const kKm of [0.2, 0.3, 0.5]) {
      const k = kKm / 1000;
      const opts = { qShear: 50, qP: 50 };
      const Cc = halfspaceClosedCompliance(HALF[0], omega, k, zs * 1000, opts);
      const Cp = psv.psvSurfaceCompliance(HALF, omega, k, zs, opts);
      const Cf = fdmod.fdCompliance(HALF, omega, k, zs, opts, 1);
      const rel = (a, b) => {
        let num = 0, den = 0;
        for (let i = 0; i < 2; i++) for (let j2 = 0; j2 < 2; j2++) {
          num = Math.max(num, Math.hypot(a[i][j2][0] - b[i][j2][0], a[i][j2][1] - b[i][j2][1]));
          den = Math.max(den, Math.hypot(b[i][j2][0], b[i][j2][1]));
        }
        return den > 0 ? num / den : NaN;
      };
      console.log(fHz + 'Hz zs' + zs + ' k' + kKm,
        '| closed-vs-prod', rel(Cp, Cc).toExponential(2),
        '| closed-vs-fd', rel(Cf, Cc).toExponential(2),
        '| |C|', Math.max(...Cc.flat().map(cabs)).toExponential(3));
    }
  }
}
