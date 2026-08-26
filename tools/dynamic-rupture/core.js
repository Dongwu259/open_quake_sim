// ================================================================
//  Dynamic rupture solver core (R6-2, v6.0)
//  2D velocity-stress staggered-grid FD with traction-at-split-node
//  (TSN) linear slip-weakening spontaneous rupture.
//
//  Modes:
//    'sh'   anti-plane (mode III) — slip along y, grid in (x, z).
//           A vertical strike-slip fault reduces to this plane; a
//           horizontal free surface is represented EXACTLY by mirroring
//           the whole problem across z=0 (uy even, σzy odd).
//    'psv'  in-plane (mode II) — slip in z on the vertical fault x=0,
//           whole-space only (no free-surface trick exists for P-SV;
//           dipping faults would need an immersed or curvilinear fault).
//
//  Grid (SH):   uy[i][j]      at (x_i, z_j)
//               sxy[i][j]     at (x_i+dx/2, z_j)
//               szy[i][j]     at (x_i, z_j+dz/2)
//  Grid (PSV):  vz[i][j]      at (x_i, z_j+dz/2)   (split on the fault)
//               vx[i][j]      at (x_i+dx/2, z_j)
//               sxx,szz[i][j] at (x_i, z_j)
//               sxz[i][j]     at (x_i+dx/2, z_j+dz/2)
//  Fault column i=ic is at x=0 in both modes; the split variable is
//  uy (SH) / vz (PSV). Flanking fault-plane stresses σ± live at ±dx/2.
//
//  TSN fault update (both modes, identical structure):
//    locked:  V=0, T=(σ⁺+σ⁻)/2, u̇=(σ⁺−σ⁻)/(ρ·dx)
//    sliding: T=sign(T)·τ_str(d), u± advanced with half-cell impedance
//             ρ·dx/2, slip d += V·dt (total-distance, SCEC convention)
//  Radiation damping limit: uniform slip rate V on the fault changes
//  the traction by −μ/(2·cs)·V exactly (whole space) — the discrete
//  coefficient converges to this as dx→0 (see tests).
//
//  Verification anchors (frozen in tests/dynamic-rupture.test.js and
//  tools/data/dynamic-rupture-report.json):
//    A1 radiation damping Z(dx) → μ/(2cs)
//    A2 static crack profile: D(z) = 2Δτ√(a²−z²)/μ (mode III),
//       D(z) = 2(1−ν)Δτ√(a²−z²)/μ (mode II plane strain)
//    A3 discrete energy closure (no-fault drift < 1e-6; fault runs
//       monotone outgoing-flux residual)
//    A4 mode II S-ratio behavior (Zheng & Rice 1998): S≥2 stays
//       sub-Rayleigh, S≤1 transitions to supershear on a long fault
//  Official SCEC references (TPV5 station series) are login-gated on
//  the CVWS viewer — the honest gap and the user-action runbook live
//  in docs/CVWS-UPLOAD.md.
// ================================================================
'use strict';

// Rayleigh speed c_R for P/S velocity ratio (mode II steady-speed gate).
// Solves (2-r²)² = 4√(1-r²)·√(1-r²/κ²), r = cR/cs, κ = cp/cs.
function rayleighSpeed(cp, cs) {
  const kappa = cp / cs;
  const f = r => {
    const r2 = r * r;
    return (2 - r2) * (2 - r2) -
      4 * Math.sqrt((1 - r2) * Math.max(0, 1 - r2 / (kappa * kappa)));
  };
  let lo = 0.01, hi = 0.999;
  const flo = f(lo), fhi = f(hi);
  if (!(flo > 0) || !(fhi < 0)) return 0.92 * cs;
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi) * cs;
}

// Cerjan-style sponge weights: 1 in the interior, decaying in the band.
// The solvers apply these to the PERTURBATION (field − ambient) so the
// static/ambient state is not artificially relaxed at the edges.
function spongeWeights(nx, nz, band) {
  const w = new Float64Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const dEdge = Math.min(i, nx - 1 - i, j, nz - 1 - j);
      let f = 1;
      if (dEdge < band) {
        const q = (band - dEdge) / band;           // 1 at outer ring
        f = Math.exp(-0.02 * q * q * band);         // Cerjan 1996 α=0.02
      }
      w[i * nz + j] = f;
    }
  }
  return w;
}
function spongeRelax(field, ambient, w, n) {
  for (let k = 0; k < n; k++) {
    if (w[k] !== 1) field[k] = ambient[k] + w[k] * (field[k] - ambient[k]);
  }
}

// Linear slip-weakening strength (total-distance convention).
// fr = { tauP, tauD, dc, cohesion? } with tauP/tauD absolute stresses.
function lwStrength(fr, dAbs) {
  if (!(dAbs > 0)) return fr.tauP;
  if (dAbs >= fr.dc) return fr.tauD;
  return fr.tauD + (fr.tauP - fr.tauD) * (1 - dAbs / fr.dc);
}

// ---------------------------------------------------------------
//  SH (anti-plane) solver
// ---------------------------------------------------------------
// opts: { vp, vs, rho, dx, dz, nx, nz, xFaultIndex, zFaultLo, zFaultHi,
//         dt (optional), cfl (default 0.35), spongeBand (default 25),
//         tau0Field(j,i->Pa or fn), friction(j)->{tauP,tauD,dc} }
// Coordinates: x_i = (i - ic)·dx with ic = xFaultIndex; z_j = (j - nz/2)·dz.
// The FAULT is the column x=0 over z∈[zFaultLo, zFaultHi] (meters);
// outside that window the fault column is welded (V=0 forced).
function makeShSolver(opts) {
  const nx = opts.nx, nz = opts.nz, dx = opts.dx, dz = opts.dz || opts.dx;
  const ic = opts.xFaultIndex;
  const rho = opts.rho, vs = opts.vs, mu = rho * vs * vs;
  const dt = opts.dt || (opts.cfl == null ? 0.35 : opts.cfl) * 0.7071 * Math.min(dx, dz) / Math.max(vs, opts.vp || vs);
  const band = opts.spongeBand == null ? 25 : opts.spongeBand;
  const sponge = spongeWeights(nx, nz, band);

  const N = nx * nz;
  const uy = new Float64Array(N);
  const sxy = new Float64Array(N);   // at (x+dx/2, z)
  const szy = new Float64Array(N);   // at (x, z+dz/2)
  const zOf = j => (j - (nz - 1) / 2) * dz;
  const xOf = i => (i - ic) * dx;

  // Fault-node state (indexed by j).
  const fl = new Int32Array(nz), fh = new Int32Array(nz);
  for (let j = 0; j < nz; j++) {
    const z = zOf(j);
    fl[j] = z >= opts.zFaultLo - dz / 2 && z <= opts.zFaultHi + dz / 2 ? 1 : 0;
    fh[j] = fl[j];
  }
  const uPlus = new Float64Array(nz), uMinus = new Float64Array(nz);
  const slip = new Float64Array(nz), slipRate = new Float64Array(nz);
  const trac = new Float64Array(nz), rupTime = new Float64Array(nz).fill(-1);
  const sliding = new Int8Array(nz);    // 0 locked, ±1 slip direction
  const fric = new Array(nz);
  const tau0 = new Float64Array(nz);
  for (let j = 0; j < nz; j++) {
    fric[j] = opts.friction ? opts.friction(zOf(j)) : { tauP: 1e9, tauD: 1e9, dc: 1 };
    tau0[j] = opts.tau0Field ? opts.tau0Field(zOf(j)) : 0;
    if (fl[j]) trac[j] = tau0[j];
  }
  // Ambient shear pre-stress everywhere: σxy = τ0(z) (equilibrium, uy=0).
  const ambUy = new Float64Array(N), ambSzy = new Float64Array(N);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++)
      sxy[i * nz + j] = fl[j] ? tau0[j] : (opts.tau0OffFault != null ? opts.tau0OffFault : tau0[j]);
  const ambSxy = Float64Array.from(sxy);

  // advance one leapfrog step
  function step(t) {
    // -- velocities (fault column handled after) --
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < nz - 1; j++) {
        if (i === ic) continue;
        uy[i * nz + j] += dt / rho * (
          (sxy[i * nz + j] - sxy[(i - 1) * nz + j]) / dx +
          (szy[i * nz + j] - szy[i * nz + j - 1]) / dz);
      }
    }
    // -- fault column TSN --
    for (let j = 1; j < nz - 1; j++) {
      if (!fl[j]) { // welded: regular update with u+ = u-
        const g = dt / rho * (
          (sxy[ic * nz + j] - sxy[(ic - 1) * nz + j]) / dx +
          (szy[ic * nz + j] - szy[ic * nz + j - 1]) / dz);
        uPlus[j] += g; uMinus[j] += g; slipRate[j] = 0;
        continue;
      }
      const sp = sxy[ic * nz + j], sm = sxy[(ic - 1) * nz + j];
      if (opts.prescribedV) {
        const V = opts.prescribedV(t + dt, zOf(j), j);
        uPlus[j] += 0.5 * V * dt; uMinus[j] -= 0.5 * V * dt;
        slipRate[j] = V; slip[j] += V * dt;
        trac[j] = 0.5 * (sp + sm);
        if (rupTime[j] < 0 && Math.abs(V) > 1e-3) rupTime[j] = t + dt;
        continue;
      }
      const dAbs = Math.abs(slip[j]);
      const Tlock = 0.5 * (sp + sm);
      // Yield test only promotes locked -> sliding. A sliding node STAYS
      // sliding until its slip rate kinematically crosses zero — re-locking
      // on a transient |Tlock| < strength dips zeroed V mid-slide and caused
      // dx-dependent stop-go chatter (found 2026-08-26, see tests).
      if (!sliding[j] && Math.abs(Tlock) > lwStrength(fric[j], dAbs))
        sliding[j] = Tlock >= 0 ? 1 : -1;
      if (!sliding[j]) {
        // locked: V=0, both sides move together
        const g = (dt / rho) * (sp - sm) / dx;
        uPlus[j] += g; uMinus[j] += g;
        slipRate[j] = 0;
        trac[j] = Tlock;
      } else {
        const s = sliding[j];
        const T = s * lwStrength(fric[j], dAbs);
        uPlus[j] += (2 * dt / (rho * dx)) * (sp - T);
        uMinus[j] += (2 * dt / (rho * dx)) * (T - sm);
        let V = uPlus[j] - uMinus[j];
        if (V * s <= 0) {
          // kinematic arrest: project to the mean and re-lock
          const um = 0.5 * (uPlus[j] + uMinus[j]);
          uPlus[j] = um; uMinus[j] = um;
          V = 0; sliding[j] = 0;
        } else {
          slip[j] += V * dt;   // SCEC total-distance convention (V keeps sign)
        }
        slipRate[j] = V;
        trac[j] = T;
        if (rupTime[j] < 0 && Math.abs(V) > 1e-3) rupTime[j] = t + dt;
      }
    }
    // -- stresses (split values at the fault column) --
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nz; j++) {
        let uR, uL;
        if (i === ic) { uL = uPlus[j]; uR = uy[(ic + 1) * nz + j]; }
        else if (i === ic - 1) { uL = uy[(ic - 1) * nz + j]; uR = uMinus[j]; }
        else { uL = uy[i * nz + j]; uR = uy[(i + 1) * nz + j]; }
        sxy[i * nz + j] += dt * mu * (uR - uL) / dx;
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz - 1; j++) {
        const uB = (i === ic) ? 0.5 * (uPlus[j] + uMinus[j]) : uy[i * nz + j];
        const uT = (i === ic) ? 0.5 * (uPlus[j + 1] + uMinus[j + 1]) : uy[i * nz + j + 1];
        szy[i * nz + j] += dt * mu * (uT - uB) / dz;
      }
    }
    // -- sponge (perturbation-relaxing; ambient preserved) --
    spongeRelax(uy, ambUy, sponge, N);
    spongeRelax(sxy, ambSxy, sponge, N);
    spongeRelax(szy, ambSzy, sponge, N);
    for (let j = 0; j < nz; j++) { // split pair follows the same z-band damping
      const wa = 0.5 * (sponge[ic * nz + j] + sponge[(ic + 1) * nz + j]);
      if (wa !== 1) { uPlus[j] *= wa; uMinus[j] *= wa; }
    }
    return t + dt;
  }

  // total (strain + kinetic) energy minus the t=0 baseline; frictional work
  function energies() {
    let strain = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++)
        strain += (sxy[i * nz + j] * sxy[i * nz + j] + szy[i * nz + j] * szy[i * nz + j]) / (2 * mu);
    let kin = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++)
        kin += 0.5 * rho * uy[i * nz + j] * uy[i * nz + j];
    // fault column velocity replaced by the split pair
    kin += 0; // split-column contribution is O(1/nz), tracked in uPlus/uMinus below
    for (let j = 0; j < nz; j++)
      kin += 0.5 * rho * (uPlus[j] * uPlus[j] + uMinus[j] * uMinus[j] - 2 * uy[ic * nz + j] * uy[ic * nz + j]);
    let work = 0;
    for (let j = 0; j < nz; j++) work += trac[j] * slipRate[j] * dz;
    return { strain: strain * dx * dz, kinetic: kin * dx * dz, frictionPower: work };
  }

  function state() {
    return {
      nx, nz, dx, dz, dt, ic, mu, vs, vp: opts.vp || opts.vs, rho,
      zOf, xOf, uy, sxy, szy, uPlus, uMinus, slip, slipRate, trac,
      rupTime, tau0, fl, step, energies,
      // shear traction sampling on the fault at depth z (nearest j)
      sample: z => {
        let j = Math.round(z / dz + (nz - 1) / 2);
        j = Math.max(0, Math.min(nz - 1, j));
        return { slip: slip[j], slipRate: slipRate[j], trac: trac[j], rupTime: rupTime[j], j };
      }
    };
  }
  return state();
}

// ---------------------------------------------------------------
//  P-SV (in-plane) solver — whole-space, fault slip in z at x=0
// ---------------------------------------------------------------
// opts additionally: { lambda } optional (defaults from vp/vs/rho)
function makePsvSolver(opts) {
  const nx = opts.nx, nz = opts.nz, dx = opts.dx, dz = opts.dz || opts.dx;
  const ic = opts.xFaultIndex;
  const rho = opts.rho, vs = opts.vs, vp = opts.vp;
  const mu = rho * vs * vs, lambda = opts.lambda != null ? opts.lambda : rho * (vp * vp - 2 * vs * vs);
  const dt = opts.dt || 0.35 * 0.7071 * Math.min(dx, dz) / vp;
  const band = opts.spongeBand == null ? 25 : opts.spongeBand;
  const sponge = spongeWeights(nx, nz, band);

  const N = nx * nz;
  const vx = new Float64Array(N);   // at (x+dx/2, z)
  const vz = new Float64Array(N);   // at (x, z+dz/2) — split on the fault column
  const sxx = new Float64Array(N);  // at (x, z) — nodes
  const szz = new Float64Array(N);
  const sxz = new Float64Array(N);  // at (x+dx/2, z+dz/2)
  const zOf = j => (j - (nz - 1) / 2) * dz;
  const xOf = i => (i - ic) * dx;

  const fl = new Int32Array(nz);
  for (let j = 0; j < nz; j++) {
    const z = zOf(j);
    fl[j] = z >= opts.zFaultLo - dz / 2 && z <= opts.zFaultHi + dz / 2 ? 1 : 0;
  }
  const uPlus = new Float64Array(nz), uMinus = new Float64Array(nz); // vz split
  const slip = new Float64Array(nz), slipRate = new Float64Array(nz);
  const trac = new Float64Array(nz), rupTime = new Float64Array(nz).fill(-1);
  const sliding = new Int8Array(nz);    // 0 locked, ±1 slip direction
  const fric = new Array(nz), tau0 = new Float64Array(nz);
  for (let j = 0; j < nz; j++) {
    fric[j] = opts.friction ? opts.friction(zOf(j)) : { tauP: 1e9, tauD: 1e9, dc: 1 };
    tau0[j] = opts.tau0Field ? opts.tau0Field(zOf(j)) : 0;
    if (fl[j]) trac[j] = tau0[j];
  }
  // ambient shear prestress σxz everywhere (equilibrium with v=0)
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++)
      sxz[i * nz + j] = fl[j] ? tau0[j] : (opts.tau0OffFault != null ? opts.tau0OffFault : tau0[j]);
  const ambSxz = Float64Array.from(sxz);
  const ambV = new Float64Array(N);

  function step(t) {
    // -- vx (skip fault column? vx is at (x+dx/2, z) — never ON x=0; regular everywhere) --
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 1; j < nz - 1; j++) {
        vx[i * nz + j] += dt / rho * (
          (sxx[(i + 1) * nz + j] - sxx[i * nz + j]) / dx +
          (sxz[i * nz + j] - sxz[i * nz + j - 1]) / dz);
      }
    }
    // -- vz (fault column split) --
    for (let i = 1; i < nx - 1; i++) {
      if (i === ic) continue;
      for (let j = 0; j < nz - 1; j++) {
        vz[i * nz + j] += dt / rho * (
          (szz[i * nz + j + 1] - szz[i * nz + j]) / dz +
          (sxz[i * nz + j] - sxz[(i - 1) * nz + j]) / dx);
      }
    }
    // -- fault column TSN (vz split, slip in z) --
    for (let j = 0; j < nz - 1; j++) {
      const sp = sxz[ic * nz + j], sm = sxz[(ic - 1) * nz + j];
      const dszzdz = (szz[ic * nz + j + 1] - szz[ic * nz + j]) / dz;
      if (opts.prescribedV) {
        const V = opts.prescribedV(t + dt, zOf(j), j);
        uPlus[j] += 0.5 * V * dt; uMinus[j] -= 0.5 * V * dt;
        slipRate[j] = V; slip[j] += V * dt;
        trac[j] = 0.5 * (sp + sm);
        if (rupTime[j] < 0 && Math.abs(V) > 1e-3) rupTime[j] = t + dt;
        continue;
      }
      if (!fl[j]) {
        // welded region: regular single-node update
        const g = dt / rho * (dszzdz + (sp - sm) / dx);
        uPlus[j] += g; uMinus[j] += g; slipRate[j] = 0;
        continue;
      }
      const dAbs = Math.abs(slip[j]);
      const Tlock = 0.5 * (sp + sm);
      // same kinematic state machine as the SH solver (yield only promotes
      // locked->sliding; arrest only when V crosses zero)
      if (!sliding[j] && Math.abs(Tlock) > lwStrength(fric[j], dAbs))
        sliding[j] = Tlock >= 0 ? 1 : -1;
      if (!sliding[j]) {
        const g = dt / rho * (dszzdz + (sp - sm) / dx);
        uPlus[j] += g; uMinus[j] += g; slipRate[j] = 0; trac[j] = Tlock;
      } else {
        const s = sliding[j];
        const T = s * lwStrength(fric[j], dAbs);
        uPlus[j] += (dt / rho) * dszzdz + (2 * dt / (rho * dx)) * (sp - T);
        uMinus[j] += (dt / rho) * dszzdz + (2 * dt / (rho * dx)) * (T - sm);
        let V = uPlus[j] - uMinus[j];
        if (V * s <= 0) {
          const um = 0.5 * (uPlus[j] + uMinus[j]);
          uPlus[j] = um; uMinus[j] = um;
          V = 0; sliding[j] = 0;
        } else {
          slip[j] += V * dt;
        }
        slipRate[j] = V; trac[j] = T;
        if (rupTime[j] < 0 && Math.abs(V) > 1e-3) rupTime[j] = t + dt;
      }
    }
    // -- stresses --
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        let vxL, vxR;   // vx at (x±dx/2 around node x_i) — vx[i-1][j] and vx[i][j]
        vxR = vx[i * nz + j];
        vxL = i > 0 ? vx[(i - 1) * nz + j] : 0;
        let vzB, vzT;   // vz at (x_i, z∓dz/2) — vz[i][j-1], vz[i][j]
        vzT = vz[i * nz + j];
        vzB = j > 0 ? vz[i * nz + j - 1] : 0;
        if (i === ic) { vzT = 0.5 * (uPlus[j] + uMinus[j]); vzB = j > 0 ? 0.5 * (uPlus[j - 1] + uMinus[j - 1]) : 0; }
        sxx[i * nz + j] += dt * ((lambda + 2 * mu) * (vxR - vxL) / dx + lambda * (vzT - vzB) / dz);
        szz[i * nz + j] += dt * (lambda * (vxR - vxL) / dx + (lambda + 2 * mu) * (vzT - vzB) / dz);
      }
    }
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nz - 1; j++) {
        let vzM, vzP;   // vz at (x_i, z+dz/2) and (x_{i+1}, z+dz/2)
        vzM = (i === ic) ? uPlus[j] : vz[i * nz + j];
        vzP = (i === ic - 1) ? uMinus[j] : vz[(i + 1) * nz + j];
        const vxB = vx[i * nz + j + 1];            // vx at (x+dx/2, z_j+1)
        const vxT = vx[i * nz + j];                // vx at (x+dx/2, z_j)
        sxz[i * nz + j] += dt * mu * ((vxB - vxT) / dz + (vzP - vzM) / dx);
      }
    }
    // -- sponge (perturbation-relaxing; ambient preserved) --
    spongeRelax(vx, ambV, sponge, N);
    spongeRelax(vz, ambV, sponge, N);
    spongeRelax(sxx, ambV, sponge, N);
    spongeRelax(szz, ambV, sponge, N);
    spongeRelax(sxz, ambSxz, sponge, N);
    for (let j = 0; j < nz; j++) {
      const wa = 0.5 * (sponge[ic * nz + j] + sponge[(ic + 1) * nz + j]);
      if (wa !== 1) { uPlus[j] *= wa; uMinus[j] *= wa; }
    }
    // fault split nodes also sit in sponge rows near z edges (kept simple)
    return t + dt;
  }

  function energies() {
    let strain = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        const s = sxz[i * nz + j];
        const p = (sxx[i * nz + j] + szz[i * nz + j]) * 0.5;
        const q = (sxx[i * nz + j] - szz[i * nz + j]) * 0.5;
        // plane-strain density: W = p²/(2(λ+μ)) + q²/(2μ) + σxz²/(2μ)
        strain += s * s / (2 * mu) + q * q / (2 * mu) + p * p / (2 * (lambda + mu));
      }
    let kin = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++)
        kin += 0.5 * rho * (vx[i * nz + j] * vx[i * nz + j] + vz[i * nz + j] * vz[i * nz + j]);
    for (let j = 0; j < nz; j++)
      kin += 0.5 * rho * (uPlus[j] * uPlus[j] + uMinus[j] * uMinus[j] - 2 * vz[ic * nz + j] * vz[ic * nz + j]);
    let work = 0;
    for (let j = 0; j < nz; j++) work += trac[j] * slipRate[j] * dz;
    return { strain: strain * dx * dz, kinetic: kin * dx * dz, frictionPower: work };
  }

  return {
    nx, nz, dx, dz, dt, ic, mu, lambda, vs, vp, rho, zOf, xOf,
    vx, vz, sxx, szz, sxz, uPlus, uMinus, slip, slipRate, trac,
    rupTime, tau0, fl, step, energies,
    sample: z => {
      let j = Math.round(z / dz + (nz - 1) / 2);
      j = Math.max(0, Math.min(nz - 2, j));
      return { slip: slip[j], slipRate: slipRate[j], trac: trac[j], rupTime: rupTime[j], j };
    }
  };
}

module.exports = { makeShSolver, makePsvSolver, rayleighSpeed, lwStrength, spongeWeights };
