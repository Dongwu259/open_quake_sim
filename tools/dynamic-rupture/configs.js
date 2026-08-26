// Experiment configurations for the offline dynamic-rupture suite (R6-2).
// Units: SI (m, s, Pa) unless noted. SCEC TPV5 parameters are transcribed
// from the official description (TPV5_forwebsite.pdf, fetched 2026-08-26
// from strike.scec.org/cvws, archived in .cache; provenance recorded in the
// frozen report). The 2D anti-plane reduction ("TPV5-AP") keeps the official
// friction/stress values but expands DOWN-DIP only — the along-strike
// heterogeneity (TPV5's ±7.5 km stress patches) is not representable in the
// (fault-normal, depth) plane and is honestly excluded.
'use strict';
const { makeShSolver, makePsvSolver, rayleighSpeed } = require('./core.js');

const TPV5 = {
  vp: 6000, vs: 3464, rho: 2670,
  sigmaNMPa: 120, muS: 0.677, muD: 0.525, d0: 0.40,
  tauP: 0.677 * 120e6,          // 81.24 MPa
  tauD: 0.525 * 120e6,          // 63.0 MPa
  tau0bg: 70e6, tau0nuc: 81.6e6,
  faultHalfLenM: 15000, nucHalfM: 1500, nucCenterDepthM: 7500
};

// Anti-plane TPV5-AP: fault line = depth 0..15 km (+ mirror for halfspace).
// Coordinates: solver x = fault-normal, solver z = depth (mirrored to ±).
function makeTpv5Ap(opts) {
  opts = opts || {};
  const half = TPV5.faultHalfLenM;               // ±15 km in mirrored z
  const dx = opts.dx || 100;
  const halfSpace = opts.halfSpace !== false;    // default: halfspace (mirror)
  const mediumHalf = opts.mediumHalf || 24000;   // fault-normal half-extent
  const nz = Math.round(2 * half / dx) + 1;
  const nx = Math.round(2 * mediumHalf / dx) + 1;
  return makeShSolver({
    vp: TPV5.vs, vs: TPV5.vs, rho: TPV5.rho,     // SH: waves at cs only
    nx, nz, dx, dz: dx, xFaultIndex: Math.floor(nx / 2),
    zFaultLo: -half, zFaultHi: half,
    // whole-space variant: fault only on z>0 (no mirror)
    tau0Field: z => {
      const depth = halfSpace ? Math.abs(z) : z;
      if (depth < 0) return TPV5.tau0bg;
      const nucLo = TPV5.nucCenterDepthM - TPV5.nucHalfM;
      const nucHi = TPV5.nucCenterDepthM + TPV5.nucHalfM;
      return (depth >= nucLo && depth <= nucHi) ? TPV5.tau0nuc : TPV5.tau0bg;
    },
    friction: z => {
      const depth = halfSpace ? Math.abs(z) : z;
      return (depth >= 0 && depth <= half)
        ? { tauP: TPV5.tauP, tauD: TPV5.tauD, dc: TPV5.d0 }
        : { tauP: 1e12, tauD: 1e12, dc: 1 };     // strength barrier
    },
    spongeBand: opts.spongeBand || 25,
    cfl: opts.cfl || 0.35
  });
}

// Generic whole-space spontaneous rupture (SH), matched pair of resolutions.
// S = (tauP-tau0)/(tau0-tauD) with the SCEC-like magnitudes tauP=81,tau0=70,
// tauD=63 MPa, dc=0.25, overstressed nucleation patch.
function makeShSpont(opts) {
  opts = opts || {};
  const dx = opts.dx || 100;
  const a = opts.halfLen || 3000;
  const tauP = 81e6, tau0 = 70e6, tauD = 63e6, dc = 0.25;
  const nz = Math.round(2 * (opts.zHalf || 16000) / dx) + 1;
  const nx = Math.round(2 * (opts.xHalf || 12000) / dx) + 1;
  return makeShSolver({
    vp: 3464, vs: 3464, rho: 2670, nx, nz, dx, dz: dx,
    xFaultIndex: Math.floor(nx / 2),
    zFaultLo: -a, zFaultHi: a,
    tau0Field: z => (Math.abs(z) <= (opts.nucHalf || 800)) ? 82e6 : tau0,
    friction: z => (Math.abs(z) <= a)
      ? { tauP, tauD, dc } : { tauP: 1e12, tauD: 1e12, dc: 1 },
    spongeBand: opts.spongeBand || 20, cfl: opts.cfl || 0.35
  });
}

// Generic whole-space spontaneous rupture (PSV, mode II). S is the standard
// seismic ratio S=(tauP-tau0)/(tau0-tauD) with tau0=70, tauD=63 fixed.
function makePsvSpont(opts) {
  opts = opts || {};
  const dx = opts.dx || 100;
  const a = opts.halfLen || 6000;
  const S = opts.S || 2.0;
  const tau0 = 70e6, tauD = 63e6, tauP = tau0 + S * 7e6, dc = 0.25;
  const nz = Math.round(2 * (opts.zHalf || 16000) / dx) + 1;
  const nx = Math.round(2 * (opts.xHalf || 12000) / dx) + 1;
  return makePsvSolver({
    vp: 6000, vs: 3464, rho: 2670, nx, nz, dx, dz: dx,
    xFaultIndex: Math.floor(nx / 2),
    zFaultLo: -a, zFaultHi: a,
    tau0Field: z => (Math.abs(z) <= (opts.nucHalf || 1200)) ? tauP + 1.5e6 : tau0,
    friction: z => (Math.abs(z) <= a)
      ? { tauP, tauD, dc } : { tauP: 1e12, tauD: 1e12, dc: 1 },
    spongeBand: opts.spongeBand || 20, cfl: opts.cfl || 0.35
  });
}

module.exports = { TPV5, makeTpv5Ap, makeShSpont, makePsvSpont, rayleighSpeed };
