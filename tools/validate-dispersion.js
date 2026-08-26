'use strict';
// ================================================================
//  v5.8 R5-2 — dispersion validation harness (offline; NOT in npm test).
//
//  Three cases:
//   A. Synthetic flat-bed far field with an EXACT linear reference
//      (Fourier synthesis over c² = g·tanh(kh)/k). A Gaussian wave packet
//      from rest propagates 1000 km; the dispersive arm must track the
//      analytic envelope (oscillating Airy-like tail) better than the SWE
//      arm — the honest "far-field error reduction" measurement that needs
//      no observed data.
//   B. 1960 Chile trans-oceanic case on real GEBCO bathymetry (wrapped
//      longitude frame 135..292.5 = 135E..67.5W, tools/data/grids/
//      pacific-1960.json, built by tools/build-bathymetry-pacific.py).
//      Probes: Chile coast / mid-Pacific / Hawaii / Ofunato. A/B arrival,
//      dominant period and near-field peak change.
//   C. 2011 Tohoku near-field guard on the bundled jp-sanriku 0.025° grid
//      nested over the global grid: coastal peaks must stay within 10%
//      (the pre-registered R5 acceptance).
//
//  Usage:
//    node tools/validate-dispersion.js [--case=a|b|c|all] [--write]
//  --write persists tools/data/dispersion-validation.json (frozen report
//  asserted structurally by tests/tsunami-dispersion.test.js).
// ================================================================
const fs = require('fs');
const path = require('path');

const Physics = require('../public/physics.js');
const DC3D = require('../public/dc3d.js');
global.DC3D = global.DC3D || DC3D;

const ROOT = path.resolve(__dirname, '..');
const G = 9.80665;
const WRITE = process.argv.includes('--write');
const CASE = (process.argv.find(a => a.startsWith('--case=')) || '--case=all').split('=')[1];

function rmse(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

// ------------------------------------------------------------------
// Case A — synthetic flat bed, exact linear reference
// ------------------------------------------------------------------
function caseA() {
  const resDeg = 0.01, nx = 1200, ny = 5, depth = 4000;
  const res = resDeg * 111320;
  const x0 = 150000;                 // packet centre (m from domain origin)
  const sigma = 8000;                // compact packet: kh spectral content to ~1
  const travel = 1000000;            // probe is 1000 km downstream
  const data = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
    data.push(y === 0 || y === ny - 1 ? 1 : -depth);
  const grid = { origin: [0, 0], res: resDeg, nx, ny, data, meta: { quality: 'verification' } };
  const eta0 = x => 0.5 * Math.exp(-Math.pow((x - x0) / sigma, 2));
  const run = dispersion => {
    const solver = Physics.createNonlinearTsunamiSolver(grid, null, {
      manning: 0, coriolis: false, dispersion, boundary: 'radiation',
      initialState: cell => ({ eta: eta0(cell.lng * 111320) })
    });
    const probeLng = (x0 + travel) / 111320;
    // the from-rest packet splits in two; the radiation boundary lets the
    // left-going half exit, so the probe sees only the right-going wave
    // (window ends before the right boundary reflection returns)
    const tEnd = 6200, dt = 40;
    const series = [];
    let nearPeak = 0;
    for (let t = 0; t <= tEnd; t += dt) {
      solver.advanceTo(t);
      series.push(solver.sampleState(2 * resDeg, probeLng).eta);
      if (t < 2500) {
        // near-field envelope peak: max |eta| around the source position
        let m = 0;
        const srcLng = x0 / 111320;
        for (let dx = -14; dx <= 14; dx++) {
          const v = Math.abs(solver.sampleState(2 * resDeg, srcLng + dx * resDeg).eta);
          if (v > m) m = v;
        }
        nearPeak = Math.max(nearPeak, m);
      }
    }
    return { series, nearPeak, dt, tEnd };
  };
  // exact linear reference at the probe: RIGHT-GOING half of the from-rest
  // packet, eta_R = (1/pi)·Re ∫ Â(k) e^{i(kΔx − ω(k)t)} dk with Â the FT of
  // the full initial Gaussian divided by 2, ω² = g·k·tanh(kh).
  const Ahat = k => 0.25 * sigma * Math.sqrt(Math.PI) * Math.exp(-k * k * sigma * sigma / 4);
  const omega = k => Math.sqrt(G * k * Math.tanh(k * depth));
  function reference(dx, t) {
    // trapezoid over k ∈ [0, kmax], cosine pair (real, even spectrum)
    const kmax = 8 / sigma, n = 4000;
    let sum = 0;
    const dk = kmax / n;
    for (let i = 1; i < n; i++) {
      const k = i * dk;
      sum += Ahat(k) * Math.cos(k * dx - omega(k) * t);
    }
    sum += 0.5 * (Ahat(0) * Math.cos(-omega(1e-9) * t) + Ahat(kmax) * Math.cos(kmax * dx - omega(kmax) * t));
    return (2 * sum * dk) / Math.PI;
  }
  const off = run('off'), on = run('boussinesq');
  const dt = off.dt;
  const analytic = off.series.map((_, i) => reference(travel, i * dt));
  let maxA = 0; for (const v of analytic) maxA = Math.max(maxA, Math.abs(v));
  const errOff = rmse(off.series, analytic) / maxA;
  const errOn = rmse(on.series, analytic) / maxA;
  const nearChange = Math.abs(on.nearPeak - off.nearPeak) / off.nearPeak;
  return {
    case: 'A-synthetic-flat-4000m',
    probeKm: travel / 1000, khContentMax: (8 / sigma) * depth,
    rmseVsExactNormalized: { swe: +errOff.toFixed(4), boussinesq: +errOn.toFixed(4) },
    errorReductionRatio: +(errOff / errOn).toFixed(2),
    nearFieldPeak: { swe: +off.nearPeak.toFixed(3), boussinesq: +on.nearPeak.toFixed(3), change: +nearChange.toFixed(4) },
    pass: errOn < errOff * 0.85 && nearChange < 0.10
  };
}

// ------------------------------------------------------------------
// Case B — 1960 Chile trans-oceanic on real bathymetry
// ------------------------------------------------------------------
function caseB() {
  const gridPath = path.join(ROOT, 'tools/data/grids/pacific-1960.json');
  if (!fs.existsSync(gridPath)) return { case: 'B-1960-chile', skipped: 'grid not built (run tools/build-bathymetry-pacific.py)' };
  const grid = require(gridPath);
  // wrapped-lng helpers: probe lngs >180 given as lng+360
  const P = (lat, lng) => ({ lat, lng });
  const probes = [
    { id: 'chile-coast', at: P(-36.0, 287.0), near: true },
    { id: 'mid-pacific', at: P(-5.0, 210.0), near: false },
    { id: 'hawaii', at: P(21.2, 202.4), near: false },
    { id: 'ofunato', at: P(39.07, 141.72), near: false }
  ];
  // 1960-05-22 19:11 UTC Valdivia M9.5 (assumed reverse mechanism, noted in
  // the frozen report; no bundled finite-fault model for this event)
  const source = {
    lat: -38.5, lng: 286.5, depthKm: 25, mag: 9.5, mw: 9.5,
    strikeDeg: 10, dipDeg: 20, rakeDeg: 90
  };
  source.geometry = Physics.genSubSources(source.lat, source.lng, 9.5, 10, 20, 25, 2.5, {});
  const horizon = 26 * 3600;
  const run = dispersion => {
    const solver = Physics.createNonlinearTsunamiSolver(grid, source, {
      manning: 0.025, dispersion, coriolis: true, boundary: 'radiation'
    });
    if (!solver) throw new Error('solver construction failed');
    const state = probes.map(() => ({ first: null, peak: 0, peakT: 0, series: [] }));
    const dtSample = 120;
    for (let t = 0; t <= horizon; t += dtSample) {
      solver.advanceTo(t);
      probes.forEach((p, i) => {
        // nearest WET cell: land cells legally report eta = bed elevation,
        // which would fake instant 40 m "arrivals" at coastal probes
        const e = solver.sample(p.at.lat, p.at.lng);
        if (state[i].first === null && Math.abs(e) > 0.05 && t > 600) state[i].first = t;
        if (Math.abs(e) > state[i].peak) { state[i].peak = Math.abs(e); state[i].peakT = t; }
        state[i].series.push(e);
      });
    }
    // dominant period from mean zero-crossing spacing over the last 10 h
    state.forEach(s => {
      const tail = s.series.slice(Math.floor(s.series.length * 0.55));
      let up = 0;
      for (let i = 1; i < tail.length; i++) if (tail[i - 1] < 0 && tail[i] >= 0) up++;
      s.dominantPeriodSec = up > 2 ? (2 * (tail.length - 1) * dtSample / up) : null;
    });
    return { state, diag: solver.getDiagnostics() };
  };
  const t0 = Date.now();
  const off = run('off'), on = run('boussinesq');
  const seconds = +((Date.now() - t0) / 1000).toFixed(0);
  const out = probes.map((p, i) => ({
    id: p.id,
    arrivalS: { swe: off.state[i].first, boussinesq: on.state[i].first },
    arrivalShiftMin: off.state[i].first != null && on.state[i].first != null
      ? +(((on.state[i].first - off.state[i].first) / 60).toFixed(1)) : null,
    peakM: { swe: +off.state[i].peak.toFixed(3), boussinesq: +on.state[i].peak.toFixed(3) },
    peakChange: +(Math.abs(on.state[i].peak - off.state[i].peak) / off.state[i].peak).toFixed(4),
    dominantPeriodMin: {
      swe: off.state[i].dominantPeriodSec ? +(off.state[i].dominantPeriodSec / 60).toFixed(2) : null,
      boussinesq: on.state[i].dominantPeriodSec ? +(on.state[i].dominantPeriodSec / 60).toFixed(2) : null
    }
  }));
  const chile = out.find(o => o.id === 'chile-coast');
  return {
    case: 'B-1960-chile-transoceanic',
    grid: 'tools/data/grids/pacific-1960.json (GEBCO 2025, 0.25°, wrapped lng 135..292.5)',
    source: 'synthetic M9.5 Valdivia (assumed mechanism strike10/dip20/rake90 — no bundled finite-fault model)',
    horizonS: horizon, solverSeconds: seconds,
    probes: out,
    massResidualFraction: { swe: off.diag.massResidualFraction, boussinesq: on.diag.massResidualFraction },
    nearFieldPeakChange: chile.peakChange,
    pass: chile.peakChange < 0.10 && Math.abs(off.diag.massResidualFraction) < 5e-3 && Math.abs(on.diag.massResidualFraction) < 5e-3
  };
}

// ------------------------------------------------------------------
// Case C — 2011 Tohoku near-field guard (bundled regional grid, nested)
// ------------------------------------------------------------------
function caseC() {
  const global = require(path.join(ROOT, 'public/geojson/bathymetry.json'));
  const fine = require(path.join(ROOT, 'public/geojson/grids/jp-sanriku.json'));
  const FiniteFault = require('../public/finite-fault.js');
  const ObservedFaultModels = require('../public/observed-fault-models.js');
  const model = FiniteFault.parse(ObservedFaultModels.get('tohoku'));
  const source = {
    lat: 38.3, lng: 142.37, depthKm: 24, mag: 9.1, mw: 9.1,
    strikeDeg: model.representativePlane.strikeDeg, dipDeg: model.representativePlane.dipDeg,
    rakeDeg: model.representativePlane.rakeDeg, averageSlipM: model.geometry.averageSlipM,
    geometry: model.geometry
  };
  const coastal = [
    { id: 'ofunato', lat: 39.07, lng: 141.72 },
    { id: 'kamaishi', lat: 39.27, lng: 141.77 },
    { id: 'sendai', lat: 38.27, lng: 140.87 }
  ];
  const trench = { id: 'trench-39N-144E', lat: 39.0, lng: 144.0 };
  const run = dispersion => {
    const solver = Physics.createNestedTsunamiSolver(global, fine, source, {
      manning: 0.025, dispersion, coriolis: true, boundary: 'radiation'
    });
    if (!solver) throw new Error('nested solver construction failed');
    solver.advanceTo(3600);
    const peaks = {};
    for (const c of coastal) peaks[c.id] = Math.abs(Physics.tsunamiCoastalHeight(solver, c.lat, c.lng, 10, 5));
    const s = solver.sampleState(trench.lat, trench.lng);
    return { peaks, trench: s ? s.eta : 0, diag: solver.getDiagnostics() };
  };
  const off = run('off'), on = run('boussinesq');
  const coastalOut = coastal.map(c => ({
    id: c.id,
    peakM: { swe: +off.peaks[c.id].toFixed(3), boussinesq: +on.peaks[c.id].toFixed(3) },
    change: +(Math.abs(on.peaks[c.id] - off.peaks[c.id]) / off.peaks[c.id]).toFixed(4)
  }));
  const worst = Math.max(...coastalOut.map(c => c.change));
  return {
    case: 'C-2011-tohoku-nested-nearfield',
    coastalPeaks: coastalOut,
    worstCoastalPeakChange: worst,
    pass: worst < 0.10
  };
}

function main() {
  const report = { schema: 'quake-sim-dispersion-validation-v1', generatedAt: new Date().toISOString(), cases: [] };
  if (CASE === 'a' || CASE === 'all') { console.log('case A: synthetic flat-bed far field...'); const r = caseA(); report.cases.push(r); console.log(JSON.stringify(r, null, 1)); }
  if (CASE === 'b' || CASE === 'all') { console.log('case B: 1960 Chile trans-oceanic (this takes several minutes per arm)...'); const r = caseB(); report.cases.push(r); console.log(JSON.stringify(r, null, 1)); }
  if (CASE === 'c' || CASE === 'all') { console.log('case C: 2011 Tohoku nested near-field...'); const r = caseC(); report.cases.push(r); console.log(JSON.stringify(r, null, 1)); }
  report.allPass = report.cases.every(c => c.pass);
  if (WRITE) {
    // merge with an existing frozen report so single-case re-runs keep the
    // other cases (case B takes ~an hour; A/C re-freeze quickly)
    const outPath = path.join(ROOT, 'tools/data/dispersion-validation.json');
    if (fs.existsSync(outPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        for (const c of prev.cases || []) {
          if (!report.cases.some(x => x.case === c.case)) report.cases.push(c);
        }
        report.allPass = report.cases.every(c => c.pass);
      } catch (e) { /* corrupt file: full rewrite */ }
    }
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log('wrote tools/data/dispersion-validation.json');
  }
  console.log(report.allPass ? 'ALL CASES PASS' : 'SOME CASES FAILED');
  process.exitCode = report.allPass ? 0 : 1;
}

if (require.main === module) main();
module.exports = { caseA, caseB, caseC };
