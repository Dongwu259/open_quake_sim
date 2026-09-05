'use strict';
// cs-arbiter.test.js — tripwire for the frozen short-period arbiter
// (tools/data/cs-arbiter-report.json). Locks the registered decision rule,
// the frozen verdict and the key measured columns so silent drift turns the
// suite red, and re-derives one event's paired residual from the waveform
// package. This is a measurement record, NOT a calibration input.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-arbiter-report.json'), 'utf8'));

test('arbiter — schema and pre-registered rule frozen', () => {
  assert.equal(r.schema, 'quake-sim-cs-arbiter-v1');
  assert.equal(r.preRegistered.fixedBeforeRun, true);
  assert.ok(r.preRegistered.decisionRule.includes('0.2s') && r.preRegistered.decisionRule.includes('0.3s'));
  assert.deepEqual(r.preRegistered.excludedFromDecision.includes('0.1'), true, '0.1 s must stay excluded (20 Hz Nyquist)');
  assert.deepEqual(r.aggregate.decisionPeriods, [0.2, 0.3]);
  assert.equal(r.aggregate.decisionBand, 0.1);
});

test('arbiter — frozen verdict: inconclusive on the target side', () => {
  assert.equal(r.aggregate.verdict, 'inconclusive');
  assert.deepEqual(r.aggregate.DBAR, { '0.2': -0.038, '0.3': -0.023 });
  assert.equal(r.aggregate.dbarMean, -0.03);
  assert.equal(r.events.filter((e) => !e.skipped).length, 13);
  assert.ok(r.events.every((e) => e.nStations >= 40), 'every event must keep >=40 usable stations');
});

test('arbiter — measured columns locked (kappa, component split, synth-vs-obs)', () => {
  // kappa: observed and synth apparent FAS slopes agree within 0.02 s — the
  // kappa lever is refuted as the short-band repair
  assert.equal(r.aggregate.dKappaMedian, -0.0078);
  assert.ok(Math.abs(r.aggregate.dKappaMedian) < 0.02);
  // component split: gm-horizontal does not lift above transverse at long
  // periods in real data (geomean scoring is honest but not a closure lever)
  assert.ok(Math.abs(r.aggregate.C_long['2']) < 0.05);
  assert.ok(Math.abs(r.aggregate.C_long['4']) < 0.05);
  // synth-vs-obs paired shape residual (50 Hz synth arms): the synthesis
  // carries 0.12-0.28 log10 MORE 0.5-0.1 s content than observed, growing
  // with frequency — the shape defect lives at 1.4-10 Hz, below the 3-9 Hz
  // kappa band for its 1.4-3.3 Hz part
  const ds = r.aggregate.DSYN.all;
  assert.equal(ds['0.2'], -0.238);
  assert.equal(ds['0.3'], -0.216);
  assert.equal(ds['0.5'], -0.123);
  assert.ok(ds['0.2'] < -0.15 && ds['0.5'] > -0.18);
  // magnitude independence across the three Mj bands at 0.2 s (rules out a
  // two-corner/stress M-dependence as the sole cause)
  const bands = r.aggregate.DSYN.bands;
  for (const b of Object.keys(bands)) assert.ok(bands[b]['D0.2'] < -0.1, 'band ' + b + ' must confirm the synth-side excess');
});

test('arbiter — one event re-derived from the package (tokachi 2003, paired D at 0.2 s)', () => {
  const Physics = require(path.join(ROOT, 'public', 'physics.js'));
  const hybrid = require(path.join(ROOT, 'tools', 'broadband', 'hybrid.js'));
  const ev = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms', '20030926045007.json'), 'utf8'));
  const meta = { mj: 8.0, depthKm: 42, srcType: 'interplate' };
  const PERIODS = [0.1, 0.2, 1.0];
  const st = ev.stations[0];
  const sr = st.sampleRateHz || 20;
  const az = hybrid.azimuthDeg(ev.event.lat, ev.event.lng, st.station.lat, st.station.lng);
  const rot = hybrid.rotateNE(st.components.n.samples, st.components.e.samples, az);
  const psas = [st.components.n.samples, st.components.e.samples, rot.transverse].map((acc) =>
    Physics.sdofResponseSpectrum(acc, sr, PERIODS, 0.05).map((row) => row.psaGal));
  const gm = PERIODS.map((_, i) => Math.sqrt(psas[0][i] * psas[1][i]));
  const repi = Physics.haversineDist(ev.event.lat, ev.event.lng, st.station.lat, st.station.lng);
  const rake = Physics.PSHA_CLASS_RAKE[meta.srcType] || 0;
  const z = PERIODS.map((T) => Physics._pshaBranchMotion('zhao2006', 'sa:' + (T === 1 ? '1.00' : T.toFixed(2)), meta.srcType, meta.mj, repi, meta.depthKm, 600, rake));
  const dStation = Math.log10(gm[1] / gm[2]) - Math.log10(z[1].median / z[2].median);
  const row = r.events.find((e) => e.id === '20030926045007');
  // the frozen per-event number is the station MEDIAN; this single station
  // must sit within the observed inter-station spread (no exact match)
  assert.ok(Math.abs(dStation - row.D_gm['0.2']) < 0.75,
    'station residual ' + dStation.toFixed(2) + ' too far from the frozen event median ' + row.D_gm['0.2']);
  assert.equal(row.mj, 8.0);
  assert.equal(row.srcType, 'interplate');
});
