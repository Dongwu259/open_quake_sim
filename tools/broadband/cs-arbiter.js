#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.2 candidate — short-period ARBITER for the CS shape-gate repair.
//
//  Question (registered BEFORE the measurement, 2026-09-04): the frozen
//  v3 CS report shows the hybrid arm +0.2..+0.78 log10 above the zhao
//  bin-conditional targets at 0.1-0.5 s. Two mutually exclusive readings:
//    (a) the synthesis HF is genuinely too rich (zhao shape stands) ->
//        repair = synthesis side, anchored on OBSERVED kappa/shape;
//    (b) the zhao target itself under-predicts short-period T/1s ratios
//        for near-field large events (observations richer than zhao) ->
//        repair = target side (empirical short-period hybrid target).
//  This tool decides WHICH, from the 13 frozen Kyoshin waveform packages
//  (independent of both the v3 synthesis AND the zhao target fit).
//
//  PRE-REGISTERED decision rule (fixed before the run):
//    Per station, PAIRED shape residual at period T:
//      D_s(T) = log10( Sa_gm,obs(T)/Sa_gm,obs(1s) ) - log10( zhao(T)/zhao(1s) )
//    with Sa_gm = geometric-mean horizontal PSA (zhao horizontal
//    convention), zhao evaluated at the station epicentral distance,
//    package event magnitude/class/depth (frozen table below), vs30=600
//    reference (the PSHA basis; site terms largely cancel in the paired
//    ratio). D_event(T) = station median. Aggregate
//    DBAR = ( D(0.2s) + D(0.3s) ) / 2 over the 13 events (station-weighted
//    equally per event). Verdict:
//      DBAR < -0.10  -> 'synthesis-side'  (zhao shape stands)
//      DBAR > +0.10  -> 'target-side'     (observations richer than zhao)
//      else          -> 'inconclusive' (no repair justified on this evidence)
//    0.1 s is REPORTED but excluded from the decision: the packages are
//    delivered at 20 Hz (Nyquist 10 Hz = the 0.1 s period), so the 0.1 s
//    PSA column is sampling-limited. This is a measurement-only tool; it
//    changes no synthesis parameter by itself.
//
//  SECONDARY (pre-registered) measurements feeding the same verdict:
//    * apparent kappa: per-station full-record smoothed FAS log-slope over
//      3-9 Hz of the observed gm horizontal; the synthetic comparator runs
//      the module bruneBaselineSynthesis at the event median-station
//      distance (stress 50 MPa, kappa 0.04, vs30 600 — the CS pipeline
//      conventions) and its FAS slope is measured IDENTICALLY. The median
//      observed-minus-synth slope over events, divided by -pi, is the
//      observation-anchored kappa ADJUSTMENT candidate dKappa.
//    * AMENDED pre-registration (same day, still before any repair was
//      chosen or any synthesis change made): DIRECT synth-vs-obs paired
//      shape residual
//        Ds_s(T) = log10( psa_synth(T)/psa_synth(1s) ) - log10( Sa_gm,obs(T)/Sa_gm,obs(1s) )
//      per station (one bruneBaselineSynthesis per station at its own
//      distance, identical conventions), aggregated as the station-median
//      per event and then the median over events, SPLIT by magnitude class
//      (Mj < 7.5 vs >= 7.5). Rationale: the first rule can only clear or
//      implicate the zhao TARGET; Ds implicates the SYNTHESIS itself,
//      and its M-dependence separates a source-shape (two-corner) cause
//      from a uniform attenuation cause. This column is diagnostic for the
//      repair choice; the registered verdict above remains as first
//      written (the run was executed twice only to ADD this column).
//      AMENDED AGAIN before the final freeze: the first Ds pass ran the
//      synth arms at the packages' 20 Hz delivery rate, whose 9 Hz fMax
//      truncation contaminates the 0.1-0.3 s synth PSA; the synth arms
//      now run at 50 Hz (fMax 20 Hz). The obs side keeps the 20 Hz
//      delivery (real-instrument content; 0.1 s stays advisory), and the
//      registered D_gm verdict (obs-vs-zhao, synth-free) is untouched by
//      this amendment.
//    * component split at long periods: per-station
//      C_s(T) = log10( Sa_gm(T)/Sa_transverse(T) ) at 1.5-5 s — how much a
//      geometric-mean horizontal metric rises above the transverse channel
//      the v3 pipeline scored (informs the P-SV / 3-component re-scoring).
//    * paired long-period residuals D(T) at 2-5 s — whether OBSERVED
//      gm horizontals sit at/below zhao there (zhao embeds basin response)
//      while the 1D kernel sits lower (kernel-side deficit).
//
//  Frozen event table (JMA catalogue Mj/depth; class = repo sourceType
//  where a fault model exists, else the tectonic class of the JMA
//  catalogue region; recorded per row with its provenance basis).
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');

const ROOT = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-arbiter-report.json');

const PERIODS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
const ANCHOR = 1.0;
const DECISION_T = [0.2, 0.3];      // primary decision periods (20 Hz-safe)
const DECISION_BAND = 0.10;         // |DBAR| below this = inconclusive
const KAPPA_BAND_HZ = [3, 9];

const EVENTS = {
  '20030926045007': { name: 'tokachi2003',   mj: 8.0, depthKm: 42, srcType: 'interplate', basis: 'JMA catalogue; class = repo fault model (Hayes 2014)' },
  '20041023180730': { name: 'chuetsu2004',   mj: 6.8, depthKm: 13, srcType: 'crustal',    basis: 'JMA catalogue / USGS depth' },
  '20050320105319': { name: 'fukuoka2005',   mj: 7.0, depthKm: 10, srcType: 'crustal',    basis: 'JMA catalogue' },
  '20070325094145': { name: 'noto2007',      mj: 6.9, depthKm: 11, srcType: 'crustal',    basis: 'JMA catalogue' },
  '20080614084331': { name: 'iwate2008',     mj: 7.2, depthKm: 8,  srcType: 'crustal',    basis: 'JMA catalogue' },
  '20110311144626': { name: 'tohoku2011',    mj: 9.0, depthKm: 24, srcType: 'interplate', basis: 'JMA catalogue; class = repo fault model (Hayes 2017)' },
  '20110411171556': { name: 'fukushima2011', mj: 7.0, depthKm: 10, srcType: 'crustal',    basis: 'JMA catalogue' },
  '20160416012405': { name: 'kumamoto2016',  mj: 7.3, depthKm: 10, srcType: 'crustal',    basis: 'JMA catalogue; class = repo fault model (Hayes 2018)' },
  '20180906030750': { name: 'iburi2018',     mj: 6.7, depthKm: 37, srcType: 'intraslab',  basis: 'JMA catalogue (deep event, in-slab)' },
  '20190618222207': { name: 'yamagata2019',  mj: 6.7, depthKm: 14, srcType: 'crustal',    basis: 'JMA catalogue' },
  '20220316233630': { name: 'fukushima2022', mj: 7.3, depthKm: 60, srcType: 'intraslab',  basis: 'JMA catalogue; class = repo fault model (Goldberg 2022)' },
  '20240101160813': { name: 'noto2024',      mj: 7.6, depthKm: 16, srcType: 'crustal',    basis: 'JMA catalogue; class = repo fault model (Goldberg 2024)' },
  '20240808164247': { name: 'hyuganada2024', mj: 7.1, depthKm: 30, srcType: 'interplate', basis: 'JMA catalogue; class = repo fault model (Goldberg 2024)' }
};

const ZHAO_KEY = {
  0.1: '0.10', 0.15: '0.15', 0.2: '0.20', 0.3: '0.30', 0.4: '0.40', 0.5: '0.50',
  0.7: '0.70', 1.0: '1.00', 1.5: '1.50', 2.0: '2.00', 3.0: '3.00', 4.0: '4.00', 5.0: '5.00'
};

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Geometric-mean PSA (gal) of the two horizontal components + the
 *  transverse channel PSA (rotated by the source->station azimuth). */
function stationPsa(st, evLat, evLng) {
  const z = { n: st.components.n, e: st.components.e };
  if (!z.n || !z.e || !z.n.samples || !z.e.samples) return null;
  const sr = st.sampleRateHz || 20;
  const az = hybrid.azimuthDeg(evLat, evLng, st.station.lat, st.station.lng);
  const rot = hybrid.rotateNE(z.n.samples, z.e.samples, az);
  const t = [z.n.samples, z.e.samples, rot.transverse];
  const psas = t.map((acc) => {
    const r = Physics.sdofResponseSpectrum(acc, sr, PERIODS, 0.05);
    return r.map((row) => row.psaGal);
  });
  const gm = PERIODS.map((_, i) => Math.sqrt(Math.max(psas[0][i], 0) * Math.max(psas[1][i], 0)));
  return { gm, transverse: psas[2], sr };
}

/** Full-record smoothed FAS log-slope (per ln Hz) over KAPPA_BAND_HZ. */
function fasSlope(accGal, sr) {
  const n = 1 << Math.ceil(Math.log2(accGal.length));
  const re = new Array(n).fill(0), im = new Array(n).fill(0);
  let mean = 0;
  for (const v of accGal) mean += v;
  mean /= accGal.length;
  for (let i = 0; i < accGal.length; i++) { re[i] = accGal[i] - mean; }
  hybrid.fftInPlace(re, im);
  const df = sr / n;
  const mags = new Array(n / 2).fill(0);
  for (let i = 1; i < n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  // moving geometric mean, +/-3 bins
  const sm = new Array(n / 2).fill(0);
  for (let i = 1; i < n / 2; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(1, i - 3); j <= Math.min(n / 2 - 1, i + 3); j++) {
      if (mags[j] > 0) { s += Math.log(mags[j]); c++; }
    }
    sm[i] = c ? s / c : NaN;
  }
  // LSQ slope of ln|X| vs f over the band
  const f0 = KAPPA_BAND_HZ[0], f1 = KAPPA_BAND_HZ[1];
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
  for (let i = Math.ceil(f0 / df); i <= Math.floor(f1 / df) && i < n / 2; i++) {
    if (!isFinite(sm[i])) continue;
    const f = i * df;
    sx += f; sy += sm[i]; sxx += f * f; sxy += f * sm[i]; cnt++;
  }
  if (cnt < 8) return null;
  return (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
}

function main() {
  const write = process.argv.includes('--write');
  const perEvent = [];
  for (const id of Object.keys(EVENTS)) {
    const meta = EVENTS[id];
    const ev = JSON.parse(fs.readFileSync(path.join(PKG_DIR, id + '.json'), 'utf8'));
    const eLat = ev.event.lat, eLng = ev.event.lng;
    const stations = [];
    let skipped = 0;
    for (const st of ev.stations) {
      const psa = stationPsa(st, eLat, eLng);
      if (!psa) { skipped++; continue; }
      const repi = Physics.haversineDist(eLat, eLng, st.station.lat, st.station.lng);
      const rake = Physics.PSHA_CLASS_RAKE[meta.srcType] || 0;
      const z = {};
      let ok = true;
      for (const T of PERIODS) {
        const mo = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[T], meta.srcType, meta.mj, repi, meta.depthKm, 600, rake);
        if (!mo || !(mo.median > 0)) { ok = false; break; }
        z[T] = mo;
      }
      if (!ok) { skipped++; continue; }
      stations.push({ st, psa, repi, z });
    }
    if (stations.length < 5) {
      perEvent.push({ id, name: meta.name, skipped: true, nStations: stations.length, reason: 'too few usable stations' });
      continue;
    }

    // paired shape residuals D_s(T), Ds_s(T) (synth-vs-obs) and component split C_s(T)
    const D = {}, C = {}, Dtrans = {}, Ds = {};
    for (const T of PERIODS) { D[T] = []; C[T] = []; Dtrans[T] = []; Ds[T] = []; }
    const kappaObs = [];
    for (const s of stations) {
      const iA = PERIODS.indexOf(ANCHOR);
      for (let pi = 0; pi < PERIODS.length; pi++) {
        const T = PERIODS[pi];
        if (!(s.psa.gm[iA] > 0) || !(s.psa.transverse[iA] > 0) || !(s.z[T].median > 0) || !(s.z[ANCHOR].median > 0)) continue;
        D[T].push(Math.log10(s.psa.gm[pi] / s.psa.gm[iA]) - Math.log10(s.z[T].median / s.z[ANCHOR].median));
        Dtrans[T].push(Math.log10(s.psa.transverse[pi] / s.psa.transverse[iA]) - Math.log10(s.z[T].median / s.z[ANCHOR].median));
        if (s.psa.transverse[pi] > 0) C[T].push(Math.log10(s.psa.gm[pi] / s.psa.transverse[pi]));
      }
      // synth-vs-obs paired shape residual at this station (brune arm, identical conventions)
      try {
        const out = hybrid.bruneBaselineSynthesis({
          sourceLat: eLat, sourceLng: eLng, sourceDepthKm: meta.depthKm,
          mw: meta.mj, strike: 0, dip: 45, rake: Physics.PSHA_CLASS_RAKE[meta.srcType] || 0,
          receiverLat: s.st.station.lat, receiverLng: s.st.station.lng,
          vs30: 600, stressMPa: 50, kappaSec: 0.04,
          sampleRateHz: 50, durationS: 300, seed: hashSeed('arbiter:' + id + ':' + s.st.station.id)
        });
        const r = Physics.sdofResponseSpectrum(out.transverse, out.sampleRateHz, PERIODS, 0.05).map((row2) => row2.psaGal);
        if (r[iA] > 0) {
          for (let pi = 0; pi < PERIODS.length; pi++) {
            if (!(s.psa.gm[iA] > 0) || !(r[pi] > 0)) continue;
            Ds[PERIODS[pi]].push(Math.log10(r[pi] / r[iA]) - Math.log10(s.psa.gm[pi] / s.psa.gm[iA]));
          }
        }
      } catch (e2) { /* synth optional per station */ }
      // apparent kappa from both horizontals (gm of FAS slopes via gm series proxy: n then e)
      const sN = fasSlope(s.st.components.n.samples, s.psa.sr);
      const sE = fasSlope(s.st.components.e.samples, s.psa.sr);
      if (sN != null && sE != null) kappaObs.push(-((sN + sE) / 2) / Math.PI);
    }

    // synthetic comparator arm for kappa: one brune synthesis at the
    // median-station distance, identical full-record slope convention
    const repiMed = median(stations.map((s) => s.repi));
    let kappaSyn = null, dKappa = null;
    try {
      const out = hybrid.bruneBaselineSynthesis({
        sourceLat: eLat, sourceLng: eLng, sourceDepthKm: meta.depthKm,
        mw: meta.mj, strike: 0, dip: 45, rake: Physics.PSHA_CLASS_RAKE[meta.srcType] || 0,
        receiverLat: eLat + repiMed / 111, receiverLng: eLng,
        vs30: 600, stressMPa: 50, kappaSec: 0.04,
        sampleRateHz: 50, durationS: 300, seed: hashSeed('arbiter:' + id)
      });
      const sSyn = fasSlope(out.transverse, out.sampleRateHz);
      kappaSyn = sSyn != null ? -sSyn / Math.PI : null;
      const ko = median(kappaObs);
      if (kappaSyn != null && ko != null) dKappa = ko - kappaSyn;
    } catch (e) { /* comparator optional */ }

    const row = {
      id, name: meta.name, mj: meta.mj, depthKm: meta.depthKm, srcType: meta.srcType,
      nStations: stations.length, skippedStations: skipped, repiMedianKm: +repiMed.toFixed(1),
      D_gm: {}, D_transverse: {}, C_gmOverTrans: {}, D_syn_gm: {},
      kappaAppObsMedian: kappaObs.length ? +median(kappaObs).toFixed(4) : null,
      kappaAppSyn: kappaSyn != null ? +kappaSyn.toFixed(4) : null,
      dKappaObsMinusSyn: dKappa != null ? +dKappa.toFixed(4) : null,
      eventMetaBasis: meta.basis
    };
    for (const T of PERIODS) {
      row.D_gm[T] = D[T].length ? +median(D[T]).toFixed(3) : null;
      row.D_transverse[T] = Dtrans[T].length ? +median(Dtrans[T]).toFixed(3) : null;
      row.C_gmOverTrans[T] = C[T].length ? +median(C[T]).toFixed(3) : null;
      row.D_syn_gm[T] = Ds[T].length ? +median(Ds[T]).toFixed(3) : null;
    }
    perEvent.push(row);
  }

  const usable = perEvent.filter((r) => !r.skipped);
  const agg = { decisionBand: DECISION_BAND, decisionPeriods: DECISION_T, DBAR: {}, dKappaMedian: null, C_long: {}, DSYN: {} };
  for (const T of DECISION_T) {
    const vals = usable.map((r) => r.D_gm[T]).filter((v) => v != null);
    agg.DBAR[T] = vals.length ? +median(vals).toFixed(3) : null;
  }
  const dBars = DECISION_T.map((T) => agg.DBAR[T]).filter((v) => v != null);
  const dbarMean = dBars.length ? dBars.reduce((a, b) => a + b, 0) / dBars.length : null;
  const dks = usable.map((r) => r.dKappaObsMinusSyn).filter((v) => v != null);
  agg.dKappaMedian = dks.length ? +median(dks).toFixed(4) : null;
  for (const T of [1.5, 2.0, 3.0, 4.0, 5.0]) {
    const vals = usable.map((r) => r.C_gmOverTrans[T]).filter((v) => v != null);
    agg.C_long[T] = vals.length ? +median(vals).toFixed(3) : null;
  }
  // synth-vs-obs diagnostic, all periods + magnitude-band splits (0.2/0.3 s)
  const DSYN_AT = [0.1, 0.2, 0.3, 0.5, 1.5, 2.0, 3.0, 4.0, 5.0];
  agg.DSYN.all = {};
  for (const T of DSYN_AT) {
    const vals = usable.map((r) => r.D_syn_gm[T]).filter((v) => v != null);
    agg.DSYN.all[T] = vals.length ? +median(vals).toFixed(3) : null;
  }
  agg.DSYN.bands = {};
  const mBands = [{ id: 'Mj>=7.5', lo: 7.5, hi: 99 }, { id: '7.0-7.5', lo: 7.0, hi: 7.5 }, { id: '<7.0', lo: 0, hi: 7.0 }];
  for (const b of mBands) {
    const rowsB = usable.filter((r) => r.mj >= b.lo && r.mj < b.hi);
    agg.DSYN.bands[b.id] = { nEvents: rowsB.length };
    for (const T of [0.2, 0.3, 2.0, 3.0, 4.0]) {
      const vals = rowsB.map((r) => r.D_syn_gm[T]).filter((v) => v != null);
      agg.DSYN.bands[b.id]['D' + T] = vals.length ? +median(vals).toFixed(3) : null;
    }
  }
  let verdict = 'inconclusive';
  if (dbarMean != null) {
    if (dbarMean > DECISION_BAND) verdict = 'target-side';
    else if (dbarMean < -DECISION_BAND) verdict = 'synthesis-side';
  }
  agg.dbarMean = dbarMean != null ? +dbarMean.toFixed(3) : null;
  agg.verdict = verdict;

  const report = {
    schema: 'quake-sim-cs-arbiter-v1',
    generatedAt: new Date().toISOString(),
    preRegistered: {
      decisionRule: 'DBAR=(D(0.2s)+D(0.3s))/2 over 13 events (station-median paired shape residuals, gm-horizontal convention); > +0.10 target-side, < -0.10 synthesis-side, else inconclusive',
      fixedBeforeRun: true,
      fixedAt: '2026-09-04 (this file header, before the first run)',
      excludedFromDecision: '0.1 s (20 Hz packages: Nyquist = 10 Hz = the 0.1 s period; reported as advisory only)',
      confounds: [
        'epicentral distance used as the Rrup proxy for the zhao medians',
        'vs30=600 reference (no per-station Vs30 in the packages); site terms only partially cancel in the paired ratio',
        'full-record FAS slope convention applied identically to both arms (includes coda; NOT a site-kappa decomposition)',
        'class/depth/magnitude frozen per event from the JMA catalogue + repo fault-model sourceType (table in source)'
      ]
    },
    aggregate: agg,
    events: perEvent
  };
  console.log('=== ARBITER VERDICT:', verdict.toUpperCase(), '===');
  console.log('DBAR:', JSON.stringify(agg.DBAR), 'mean', agg.dbarMean, 'band +/-' + DECISION_BAND);
  console.log('dKappa obs-syn median:', agg.dKappaMedian);
  console.log('C gm/trans long:', JSON.stringify(agg.C_long));
  console.log('Ds synth-obs all:', JSON.stringify(agg.DSYN.all));
  console.log('Ds bands:', JSON.stringify(agg.DSYN.bands));
  for (const r of usable) {
    console.log(r.name.padEnd(15), 'n=' + String(r.nStations).padStart(2), 'D(0.2)=' + r.D_gm['0.2'], 'D(0.3)=' + r.D_gm['0.3'], 'D(0.1)=' + r.D_gm['0.1'], 'D(3s)=' + r.D_gm['3'], 'D(4s)=' + r.D_gm['4'], 'Ds(0.2)=' + r.D_syn_gm['0.2'], 'Ds(0.3)=' + r.D_syn_gm['0.3'], 'Ds(3s)=' + r.D_syn_gm['3'], 'Ds(4s)=' + r.D_syn_gm['4'], 'kobs=' + r.kappaAppObsMedian);
  }
  if (write) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log('wrote ' + OUT); }
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
