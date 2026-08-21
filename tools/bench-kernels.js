'use strict';
// ================================================================
//  Kernel benchmark: measures the CPU cost of the three hottest physics
//  paths on the PRODUCTION grid, as the quantitative baseline for any
//  future WASM/GPU backend. reference-backend.js tolerances are the
//  numerical acceptance gate a ported backend must meet; this tool answers
//  the other question — how much wall-clock there is to win.
//
//  Usage: node tools/bench-kernels.js
// ================================================================
const Physics = require('../public/physics.js');
global.DC3D = require('../public/dc3d.js');
const FiniteFault = require('../public/finite-fault.js');
const ObservedFaultModels = require('../public/observed-fault-models.js');
const grid = require('../public/geojson/bathymetry.json');
const CFG = require('../public/config.js').CFG_DEFAULTS;
const dflt = k => CFG[k].v;

function timeIt(label, fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms, out };
}

function main() {
  console.log(`grid: ${grid.nx}x${grid.ny} = ${grid.nx * grid.ny} cells (production bathymetry)\n`);

  // --- 1. NLSWE solver: the dominant tsunami cost ---
  const model = FiniteFault.parse(ObservedFaultModels.get('tohoku'));
  const source = {
    lat: 38.10, lng: 142.86, depthKm: 24, mag: 9.1, mw: 9.1,
    strikeDeg: 193, dipDeg: 15, rakeDeg: 90,
    averageSlipM: model.geometry.averageSlipM, geometry: model.geometry
  };
  const mkSolver = () => Physics.createNonlinearTsunamiSolver(grid, source, {
    manning: dflt('tsunamiManning'), dryTolerance: dflt('tsunamiDryTolerance'),
    arrivalThreshold: dflt('tsunamiArrivalThreshold'), coriolis: true, boundary: 'radiation'
  });
  let solver = mkSolver();
  const init = timeIt('NLSWE init (Okada deformation + setup)', () => mkSolver());
  solver = init.out;
  const adv = timeIt('NLSWE advanceTo(600s)', () => { solver.advanceTo(600); });
  const diag = solver.getDiagnostics ? solver.getDiagnostics() : {};
  const steps = diag.stepCount || diag.steps || null;
  console.log(`${init.label}: ${init.ms.toFixed(0)} ms`);
  console.log(`${adv.label}: ${adv.ms.toFixed(0)} ms` + (steps ? ` (${steps} steps, ${(steps * grid.nx * grid.ny / (adv.ms / 1000) / 1e6).toFixed(1)} Mcell·steps/s)` : ''));

  // --- 2. Tsunami travel-time field build (per ocean event) ---
  const field = timeIt('travel-time field build', () =>
    Physics.buildTsunamiTravelTimeField(grid, 38.10, 142.86, 200));
  console.log(`${field.label}: ${field.ms.toFixed(0)} ms`);

  // --- 3. Station ground-motion predictions (PGA/PGV per station) ---
  const stations = require('../public/geojson/stations.json');
  const pts = (stations.features || stations).slice(0, 1511).map(f => f.geometry ? { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] } : f);
  const ctx = Physics.createGroundMotionContext({
    lat: 38.10, lng: 142.86, mag: 9.1, mw: 9.1, depthKm: 24, strikeDeg: 193, dipDeg: 15, sourceType: 'interplate'
  }, {
    gmpModel: 'auto', geometry: model.geometry, finiteFault: true, rupSpeed: dflt('rupSpeed'),
    attA: dflt('attA'), attB: dflt('attB'), attC: dflt('attC'), anelastic: dflt('anelastic'),
    siteModel: dflt('siteModel'), siteBase: dflt('siteBase'), siteSoftMax: dflt('siteSoftMax'),
    siteHardMin: dflt('siteHardMin'), siteNonlinear: dflt('siteNonlinear'), directivity: dflt('directivity')
  });
  const pga = timeIt(`predictStationMotion x ${pts.length} stations (finite-fault)`, () => {
    let acc = 0;
    for (const p of pts) { const r = Physics.predictStationMotion(ctx, p); acc += r.pga; }
    return acc;
  });
  console.log(`${pga.label}: ${pga.ms.toFixed(0)} ms  (${(pga.ms / pts.length * 1000).toFixed(1)} µs/station)`);

  console.log(`
Interpretation guide (not a port plan — the port gate is reference-backend.js):
- NLSWE advance dominates long tsunami runs; a WASM f32/f64 port of the row
  solver typically buys 2-4x, a WebGPU compute port 10x+ at this grid size,
  at the cost of a WGSL rewrite of the MUSCL/wetting-drying path.
- Travel-time field build is a one-shot per-event cost — not worth porting.
- Station predictions scale with the finite-fault patch count; batching these
  in WASM is the cheapest meaningful win if profiled hot in the app.`);
}

main();
