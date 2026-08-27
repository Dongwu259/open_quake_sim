'use strict';
// R7 external benchmark: classic 150-ft SHAKE-91 example deposit as the EERA
// manual worked example ("Diam @ 0.1 g") — the deferred 10-layer nonlinear
// case, now with the real DIAM.ACC input (Diamond Heights, Loma Prieta 1989;
// NISEE SHAKE-91 software download is login-gated, so the record came from
// the official free EERA distribution of the SHAKE lineage).
//
// Published anchors (frozen verbatim from the EERA manual workbook EERAM.xls):
//   surface (outcrop) peak acceleration 0.190411 g @ 11.28 s
//   converged per-sublayer strain / G/Gmax / damping (17-row final iteration)
//   fundamental period 0.478723 s (travel-time 4H/Vs_avg statistic)
// Pre-registered tolerance for our equivalent-linear run: surface peak within
// ±15% of the published value ([0.162, 0.219] g) — EQL code-to-code scatter
// at this input level; the linear FLAC↔SHAKE gap published for the companion
// case was 2.6% and nonlinear strain evaluation adds scatter. Measured
// 2026-08-27: 0.1803 g @ 11.30 s = -5.3%.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runCase, runCaseSpectral, CASE_PATH } = require('../tools/run-deepsoil-benchmark.js');

const CASE = JSON.parse(fs.readFileSync(CASE_PATH, 'utf8'));

test('deepsoil-benchmark-case.json: provenance and case integrity', () => {
  assert.equal(CASE.schema, 'quake-sim-deepsoil-benchmark-v1');
  assert.ok(CASE.source.workbook.indexOf('EERA') >= 0, 'EERA manual workbook provenance');
  assert.ok(CASE.source.record.indexOf('DIAM.ACC') >= 0, 'Diamond Heights record provenance');
  assert.ok(CASE.source.itasca.indexOf('itasca') >= 0, 'Itasca nonlinear verification page provenance');
  assert.equal(CASE.profile.length, 17, '16 sublayers + bedrock');
  assert.ok(Math.abs(CASE.profile.slice(0, 16).reduce((s, l) => s + l.thicknessM, 0) - 45.72) < 1e-6,
    'deposit is exactly 150 ft');
  assert.equal(CASE.profile[16].thicknessM, null, 'bedrock carries no thickness');
  // material-type sequence: sand cap (2), clay band (1) at 30-70 ft, sand below
  const types = CASE.profile.slice(0, 16).map(l => l.materialType).join('');
  assert.equal(types, '2222111122222222', `material sequence ${types}`);
  // curve tables verbatim from the workbook (spot anchors)
  const clay = CASE.curves['1'], sand = CASE.curves['2'];
  assert.equal(clay.ggmax[4], 0.941);
  assert.equal(sand.ggmax[6], 0.37);
  assert.equal(clay.dampingPct[clay.dampingPct.length - 1], 28);
  assert.ok(Math.abs(clay.dampingStrainPct[9] - 3.16) < 1e-9, 'damping keeps its own terminal strain grid');
  // motion: 2000 samples @ 0.02 s, raw peak 0.112895 g
  assert.equal(CASE.motion.points, 2000);
  assert.ok(Math.abs(CASE.motion.peakRawG - 0.112895) < 1e-6);
  assert.ok(Math.abs(CASE.motion.scaleFactor * CASE.motion.peakRawG - 0.1) < 1e-4, 'scaled to the case 0.1 g');
  // published outputs
  assert.ok(Math.abs(CASE.published.surfacePeakG - 0.190411) < 1e-5);
  assert.equal(CASE.published.converged.length, 17);
  assert.ok(Math.abs(CASE.published.converged[0].maxStrainPct - 0.001542) < 1e-6);
});

test('EERA 10-layer case: our EQL matches the published surface peak', () => {
  const r = runCase(CASE, 1);
  assert.ok(r.res.converged, `EQL must converge (iter ${r.res.iter})`);
  assert.ok(Math.abs(r.peakIn - 0.1) < 1e-4, 'input scaled to 0.1 g');
  assert.ok(r.peakOut >= 0.162 && r.peakOut <= 0.219,
    `surface peak ${r.peakOut.toFixed(4)} g outside the pre-registered ±15% band around published 0.190411 g`);
  assert.ok(Math.abs(r.tPeak - CASE.published.surfacePeakTimeSec) <= 0.5,
    `peak time ${r.tPeak.toFixed(2)} s vs published ${CASE.published.surfacePeakTimeSec} s`);
  // deep sublayers (9-16): strain proxy within factor 2 of the published
  // converged state (thin top sublayers are a documented proxy limitation)
  for (let i = 8; i < 16; i++) {
    const ours = r.res.strain[i] * 100;
    const pub = CASE.published.converged[i].maxStrainPct;
    assert.ok(ours / pub <= 2 && pub / ours <= 2,
      `sublayer ${i + 1} strain ${ours.toFixed(4)}% vs published ${pub.toFixed(4)}% beyond factor 2`);
  }
});

test('EERA 10-layer case: nonlinear deamplification trend and frozen-result tripwire', () => {
  const r = runCase(CASE, 1);
  const r1g = runCase(CASE, 10);
  assert.ok(r1g.amplification < r.amplification,
    `1 g amplification ${r1g.amplification.toFixed(3)} must fall below the 0.1 g value ${r.amplification.toFixed(3)}`);
  assert.ok(CASE.ourResult && CASE.ourResult.surfacePeakG > 0, 'ourResult block frozen');
  // engine-drift tripwire: the live computation must reproduce the frozen
  // first-run result (any physics.js change that shifts the benchmark trips)
  assert.ok(Math.abs(r.peakOut - CASE.ourResult.surfacePeakG) / CASE.ourResult.surfacePeakG < 0.005,
    `live surface peak ${r.peakOut.toFixed(6)} drifted from frozen ${CASE.ourResult.surfacePeakG}`);
});

test('EERA 10-layer case: spectral (full frequency-domain) strain path', () => {
  const rs = runCaseSpectral(CASE, 0.1);
  assert.ok(rs.res.converged, `spectral EQL must converge (iter ${rs.res.iter})`);
  // pre-registered ±10%: full frequency-domain strain; the published 0.1904 g
  // sits between the proxy (-5.3%) and this path (+5.3%)
  assert.ok(rs.peakOut >= 0.171 && rs.peakOut <= 0.209,
    `spectral surface peak ${rs.peakOut.toFixed(4)} g outside ±10% of published 0.190411 g`);
  assert.ok(Math.abs(rs.tPeak - CASE.published.surfacePeakTimeSec) <= 0.1,
    `spectral peak time ${rs.tPeak.toFixed(2)} s vs published ${CASE.published.surfacePeakTimeSec} s`);
  // converged modulus degradation matches the published final iteration on
  // every sublayer (the proxy's documented top-sublayer 25x strain overshoot
  // surfaced as G/Gmax deviations up to 0.39; the spectral path closes it)
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(rs.res.ggmax[i] - CASE.published.converged[i].ggmax) <= 0.05,
      `sublayer ${i + 1} spectral G/Gmax ${rs.res.ggmax[i].toFixed(3)} vs published ${CASE.published.converged[i].ggmax.toFixed(3)}`);
  }
  // drift tripwire on the frozen spectral result
  assert.ok(CASE.ourResultSpectral && CASE.ourResultSpectral.surfacePeakG > 0, 'ourResultSpectral frozen');
  assert.ok(Math.abs(rs.peakOut - CASE.ourResultSpectral.surfacePeakG) / CASE.ourResultSpectral.surfacePeakG < 0.005,
    `live spectral peak ${rs.peakOut.toFixed(6)} drifted from frozen ${CASE.ourResultSpectral.surfacePeakG}`);
});

test('EERA 10-layer case: Itasca 9-level scaling ladder', () => {
  const ladder = CASE.ladder;
  assert.equal(ladder.length, 9, 'nine frozen ladder levels');
  // amplification must not increase with input level (nonlinear deamplifying
  // deposit) in EITHER strain mode; 1e-3 tolerance for numerical wiggle
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i].ampProxy <= ladder[i - 1].ampProxy + 1e-3,
      `proxy amp rose ${ladder[i - 1].ampProxy} → ${ladder[i].ampProxy} at ${ladder[i].inputG} g`);
    assert.ok(ladder[i].ampSpectral <= ladder[i - 1].ampSpectral + 1e-3,
      `spectral amp rose ${ladder[i - 1].ampSpectral} → ${ladder[i].ampSpectral} at ${ladder[i].inputG} g`);
  }
  // linear limit: 0.0001 g sits within 5% of the 0.001 g value (still linear)
  assert.ok(Math.abs(ladder[0].ampSpectral - ladder[2].ampSpectral) / ladder[2].ampSpectral < 0.05,
    'linear-limit amplification inconsistent');
  // the two strain modes converge at strong input (softening dominates the
  // strain-estimate difference)
  assert.ok(Math.abs(ladder[7].ampProxy - ladder[7].ampSpectral) < 0.05 && Math.abs(ladder[8].ampProxy - ladder[8].ampSpectral) < 0.05,
    `modes failed to converge at strong input: 0.5 g ${ladder[7].ampProxy}/${ladder[7].ampSpectral}, 1 g ${ladder[8].ampProxy}/${ladder[8].ampSpectral}`);
  // published-level bracket: EERA 1.904 amplification sits between the modes
  const pubAmp = CASE.published.surfacePeakG / 0.1;
  assert.ok(ladder[6].ampProxy <= pubAmp + 1e-3 && ladder[6].ampSpectral >= pubAmp - 1e-3,
    `published amplification ${pubAmp.toFixed(3)} not bracketed by [${ladder[6].ampProxy}, ${ladder[6].ampSpectral}]`);
});
