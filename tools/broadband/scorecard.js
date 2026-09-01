#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.1 B2-beta — hybrid broadband scorecard over the 13 frozen Kyoshin
//  waveform packages (LOCAL, gitignored, never committed — only the
//  aggregated report below enters the repo).
//
//  Arms compared per station (transverse component — the SH-only LF side
//  is the physically grounded channel):
//    hybrid  = B1 SH DW low frequency + Boore-calibrated stochastic HF
//              (tools/broadband/hybrid.js, calibration frozen in
//              tools/data/broadband-hybrid-calibration.json)
//    brune   = full-band absolute stochastic baseline (no LF side)
//    gmpe    = zhao2006 median (context arm; SA rows where transcribed)
//
//  Metrics (definitions frozen here, matching the pre-registered gates in
//  tools/data/psha-source-model-report.json preRegisteredB2):
//    per-event station median of log10(syn/obs) per period -> the gated
//    quantity is AbsMax: max |per-event median| over events AND periods
//    inside each band (0.1-0.5 s / 0.5-2 s / 2-10 s), same for PGA/PGV.
//    Improvement/regression gates compare the same AbsMax between arms.
//    JMA instrumental intensity: N/A — P-SV (radial/vertical LF) is not
//    implemented, so an honest 3-component JMA value cannot be formed.
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');

const ROOT = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'public', 'geojson', 'strong-motion-waveforms');
const OUT = path.join(ROOT, 'tools', 'data', 'broadband-scorecard.json');
const BANDS = {
  '0.1-0.5s': [0.1, 0.15, 0.2, 0.3, 0.4, 0.5],
  '0.5-2s': [0.7, 1.0, 1.5, 2.0],
  '2-10s': [3.0, 4.0, 5.0, 7.0, 10.0]
};
const ZHAO_KEY = {
  0.1: '0.10', 0.15: '0.15', 0.2: '0.20', 0.3: '0.30', 0.4: '0.40', 0.5: '0.50',
  0.7: '0.70', 1.0: '1.00', 1.5: '1.50', 2.0: '2.00', 3.0: '3.00', 4.0: '4.00', 5.0: '5.00'
};
const ALL_PERIODS = Object.keys(BANDS).flatMap((k) => BANDS[k]);

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
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

/** PGA (gal) + PGV (cm/s, trapezoid integration after mean removal). */
function peaksOf(accGal, sr) {
  let pga = 0, mean = 0;
  for (const v of accGal) mean += v;
  mean /= accGal.length;
  let vel = 0, pgv = 0;
  for (let i = 0; i < accGal.length; i++) {
    const v = Math.abs(accGal[i] - 0); // PGA on raw
    if (v > pga) pga = v;
    const a = accGal[i] - mean;
    if (i > 0) { vel += 0.5 * (a + (accGal[i - 1] - mean)) / sr; }
    const av = Math.abs(vel); if (av > pgv) pgv = av;
  }
  return { pga, pgv };
}

function psaOf(accGal, sr) {
  const r = Physics.sdofResponseSpectrum(accGal, sr, ALL_PERIODS, 0.05);
  const out = {};
  r.forEach((row) => { out[+row.period.toFixed(2)] = row.psaGal; });
  return out;
}

function main() {
  const write = process.argv.includes('--write');
  const idx = loadJson(path.join(PKG_DIR, 'index.json'));
  const mechs = loadJson(path.join(ROOT, 'tools', 'data', 'broadband-event-mechanisms.json'));
  const cal = loadJson(path.join(ROOT, 'tools', 'data', 'broadband-hybrid-calibration.json'));
  const preReg = loadJson(path.join(ROOT, 'tools', 'data', 'psha-source-model-report.json')).preRegisteredB2;
  const jivsmCols = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'));
  const vs30Grid = loadJson(path.join(ROOT, 'public', 'geojson', 'vs30.json'));
  const bedrockGrid = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-bedrock.json'));
  Physics.setJivsmColumns(jivsmCols);
  const stressMPa = cal.chosenStressMPa, kappaSec = cal.chosenKappaSec;

  const perEvent = [];
  const t0 = Date.now();
  for (const ev of idx.events) {
    const pkg = loadJson(path.join(PKG_DIR, ev.file));
    const e = pkg.event;
    const mech = mechs.events.find((m) => m.id === ev.id);
    if (!mech || !mech.mechanism) { perEvent.push({ id: ev.id, skipped: 'no ComCat mechanism' }); continue; }
    const mw = mech.comcatMag, depth = mech.depthKm || 10, m = mech.mechanism;
    const offshore = !Physics.lookupResearchGrid(vs30Grid, e.lat, e.lng);
    const srcType = Physics.resolveSourceTypeAt(e.lat, e.lng, depth, null, null, offshore);

    const acc = { hybrid: [], brune: [], gmpe: [] }; // rows: {distKm, pga, pgv, psa{}}
    for (const rec of pkg.stations) {
      const st = rec.station;
      if (!rec.components || !rec.components.n || !rec.components.e || !rec.components.n.samples) continue;
      const distKm = Physics.haversineDist(e.lat, e.lng, st.lat, st.lng);
      if (distKm < 5 || distKm > 250) continue;
      const vs30 = Physics.lookupResearchGrid(vs30Grid, st.lat, st.lng) || 600;
      const bedrockM = Physics.lookupResearchGrid(bedrockGrid, st.lat, st.lng);
      const az = hybrid.azimuthDeg(e.lat, e.lng, st.lat, st.lng);
      const rt = hybrid.rotateNE(rec.components.n.samples, rec.components.e.samples, az);
      const obsGal = rt.transverse;
      const obsPk = peaksOf(obsGal, rec.sampleRateHz);
      const obsPsa = psaOf(obsGal, rec.sampleRateHz);

      // GMPE reference
      const rRup = Physics._pshaPointRrup(distKm, mw, srcType);
      const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRup, depth, vs30, m.rake);
      const gv = Physics._pshaBranchMotion('zhao2006', 'pgv', srcType, mw, rRup, depth, vs30, m.rake);
      const gmpeRow = { distKm, pga: g ? g.median : null, pgv: gv ? gv.median : null, psa: {} };
      for (const T of ALL_PERIODS) {
        if (ZHAO_KEY[T]) {
          const gs = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[T], srcType, mw, rRup, depth, vs30, m.rake);
          if (gs) gmpeRow.psa[T] = gs.median;
        }
      }

      // site curve for the HF side (same strain anchor as calibration)
      const profile = Physics.synthSiteProfile(vs30, bedrockM);
      let siteCurve = null;
      if (profile && profile.length >= 2 && g && g.median > 0) {
        const freqs = [];
        for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
        const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
        if (res && res.amp) siteCurve = { freqs, amps: res.amp.map((a) => Math.max(0.2, Math.min(8, a))) };
      }

      const common = {
        sourceLat: e.lat, sourceLng: e.lng, sourceDepthKm: depth, mw,
        strike: m.strike, dip: m.dip, rake: m.rake,
        receiverLat: st.lat, receiverLng: st.lng, vs30,
        stressMPa, kappaSec, siteCurve, sampleRateHz: 50,
        seed: hashSeed(ev.id + ':' + st.id)
      };
      const col = Physics.jivsmColumnAt(st.lat, st.lng);
      let hybRow = null, bruRow = null;
      if (col) {
        const stack = hybrid.buildJivsmIaspStack(col);
        const hy = hybrid.hybridSynthesis(Object.assign({}, common, { stack }));
        const gal = hy.transverse.map((a) => a * 100);
        hybRow = Object.assign({ distKm }, peaksOf(gal, hy.sampleRateHz), { psa: psaOf(gal, hy.sampleRateHz), hfScale: hy.meta.hfScale });
        const br = hybrid.bruneBaselineSynthesis(common);
        const bgal = br.transverse.map((a) => a * 100);
        bruRow = Object.assign({ distKm }, peaksOf(bgal, br.sampleRateHz), { psa: psaOf(bgal, br.sampleRateHz) });
      }
      acc.hybrid.push({ obs: obsPk, obsPsa, syn: hybRow });
      acc.brune.push({ obs: obsPk, obsPsa, syn: bruRow });
      acc.gmpe.push({ obs: obsPk, obsPsa, syn: gmpeRow });
    }
    // per-event station medians of log10(syn/obs)
    function eventMed(rows, key) {
      const logs = rows.filter((r) => r.syn && r.syn[key] > 0 && r.obs[key] > 0)
        .map((r) => Math.log10(r.syn[key] / r.obs[key]));
      return logs.length >= 5 ? +median(logs).toFixed(3) : null;
    }
    function eventMedPsa(rows) {
      const out = {};
      for (const T of ALL_PERIODS) {
        const logs = rows.filter((r) => r.syn && r.syn.psa && r.syn.psa[T] > 0 && r.obsPsa[T] > 0)
          .map((r) => Math.log10(r.syn.psa[T] / r.obsPsa[T]));
        out[T] = logs.length >= 5 ? +median(logs).toFixed(3) : null;
      }
      return out;
    }
    perEvent.push({
      id: ev.id, mw, depthKm: depth, srcType, stations: acc.hybrid.length,
      mechanism: { strike: m.strike, dip: m.dip, rake: m.rake },
      hybrid: { pga: eventMed(acc.hybrid, 'pga'), pgv: eventMed(acc.hybrid, 'pgv'), psa: eventMedPsa(acc.hybrid) },
      brune: { pga: eventMed(acc.brune, 'pga'), pgv: eventMed(acc.brune, 'pgv'), psa: eventMedPsa(acc.brune) },
      gmpe: { pga: eventMed(acc.gmpe, 'pga'), pgv: eventMed(acc.gmpe, 'pgv'), psa: eventMedPsa(acc.gmpe) }
    });
    console.log(ev.id + ' M' + mw + ' (' + srcType + ', ' + acc.hybrid.length + ' st): hybrid pga bias '
      + perEvent[perEvent.length - 1].hybrid.pga + ' psa2s ' + perEvent[perEvent.length - 1].hybrid.psa[2]);
  }
  console.log('elapsed', ((Date.now() - t0) / 1000 / 60).toFixed(1), 'min');

  // ---- band aggregation + gates -----------------------------------------
  function bandAbsMax(arm, band) {
    let worst = 0, worstAt = null;
    for (const ev of perEvent) {
      if (!ev[arm]) continue;
      for (const T of BANDS[band]) {
        const b = ev[arm].psa[T];
        if (b != null && Math.abs(b) > worst) { worst = Math.abs(b); worstAt = ev.id + '@' + T + 's'; }
      }
    }
    return { absMax: +worst.toFixed(3), worstAt };
  }
  function scalarAbsMax(arm, key) {
    let worst = 0, worstAt = null;
    for (const ev of perEvent) {
      if (!ev[arm]) continue;
      const b = ev[arm][key];
      if (b != null && Math.abs(b) > worst) { worst = Math.abs(b); worstAt = ev.id; }
    }
    return { absMax: +worst.toFixed(3), worstAt };
  }
  const bands = {};
  for (const band of Object.keys(BANDS)) {
    bands[band] = {
      hybrid: bandAbsMax('hybrid', band), brune: bandAbsMax('brune', band), gmpe: bandAbsMax('gmpe', band)
    };
  }
  const scalars = {
    pga: { hybrid: scalarAbsMax('hybrid', 'pga'), brune: scalarAbsMax('brune', 'pga'), gmpe: scalarAbsMax('gmpe', 'pga') },
    pgv: { hybrid: scalarAbsMax('hybrid', 'pgv'), brune: scalarAbsMax('brune', 'pgv'), gmpe: scalarAbsMax('gmpe', 'pgv') }
  };
  const gates = {
    psaLog10BiasAbsMax: Object.fromEntries(Object.keys(BANDS).map((b) => [b, {
      limit: preReg.metrics.psaLog10BiasAbsMax[b],
      hybridAbsMax: bands[b].hybrid.absMax,
      pass: bands[b].hybrid.absMax <= preReg.metrics.psaLog10BiasAbsMax[b]
    }])),
    pgaLog10BiasAbsMax: { limit: preReg.metrics.pgaLog10BiasAbsMax, hybridAbsMax: scalars.pga.hybrid.absMax, pass: scalars.pga.hybrid.absMax <= preReg.metrics.pgaLog10BiasAbsMax },
    pgvLog10BiasAbsMax: { limit: preReg.metrics.pgvLog10BiasAbsMax, hybridAbsMax: scalars.pgv.hybrid.absMax, pass: scalars.pgv.hybrid.absMax <= preReg.metrics.pgvLog10BiasAbsMax },
    jmaIntensityBiasAbsMax: { status: 'N/A', reason: 'P-SV (radial/vertical LF) not implemented — an honest 3-component JMA intensity cannot be formed from the SH-only hybrid' },
    longPeriodImprovementVsBrune: {
      hybridAbsMax: bands['2-10s'].hybrid.absMax, bruneAbsMax: bands['2-10s'].brune.absMax,
      improvement: +(bands['2-10s'].brune.absMax - bands['2-10s'].hybrid.absMax).toFixed(3),
      pass: (bands['2-10s'].brune.absMax - bands['2-10s'].hybrid.absMax) >= 0.05
        || (bands['2-10s'].hybrid.absMax <= 0.10 && bands['2-10s'].brune.absMax <= 0.10)
    },
    pgaNonRegressionVsBrune: {
      hybridAbsMax: scalars.pga.hybrid.absMax, bruneAbsMax: scalars.pga.brune.absMax,
      pass: scalars.pga.hybrid.absMax <= scalars.pga.brune.absMax + 0.05
    }
  };
  const report = {
    schema: 'quake-sim-broadband-scorecard-v1',
    generatedAt: new Date().toISOString(),
    stressMPa, kappaSec,
    arms: {
      hybrid: 'B1 SH DW LF (<1 Hz, JIVSM+IASP91 stack per station) + absolute Boore HF (calibrated stress/kappa/site)',
      brune: 'full-band absolute stochastic baseline, same calibration, no LF side',
      gmpe: 'zhao2006 median (context only — NOT a gate)'
    },
    definitions: {
      perEventBias: 'median over stations of log10(syn/obs) on the transverse component',
      bandMetric: 'AbsMax = max |per-event median| over events AND periods inside the band',
      improvement: 'brune AbsMax - hybrid AbsMax in the 2-10 s band (>=0.05 required, or both <=0.10)',
      observedWindow: 'full package record (event-scoped), gal, rotated N/E -> transverse by great-circle azimuth'
    },
    bands, scalars, gates, perEvent,
    findings: {
      absoluteGates: 'ALL FAIL — the hybrid underpredicts by 0.4-2.2 log10 across events/bands. Two structural causes are separable in the arms: (1) the zhao2006 GMPE reference arm ITSELF scores -0.54 (PGA) to -1.14 (PGV) on these same gates — the Kyoshin packages are intensity-selected top-station sets and the comparison uses the event-specific transverse component vs a geometric-mean-horizontal GMM, so an absolute-bias floor around -0.5 exists for ANY calibrated model on this set; (2) the stochastic/hybrid arms carry a further ~0.3-0.7 (single-corner point source, envelope peak factor, simplified site columns).',
      longPeriod: 'PASS — the DW low-frequency side improves the 2-10 s band over the Brune baseline (AbsMax 2.228 vs 2.371, improvement +0.143 >= 0.05), the pre-registered purpose of the hybrid.',
      pgaRegression: 'FAIL — hybrid PGA AbsMax 1.344 vs baseline 0.902: the 1 Hz high-pass removes PGA-band energy the full-band baseline keeps; the remaining deficit is shared between arms.',
      jma: 'N/A — P-SV not implemented; no honest 3-component JMA intensity exists for the SH-only hybrid.'
    }
  };
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\n=== BANDS (AbsMax |log10 bias| vs observed) ===');
  for (const b of Object.keys(BANDS)) {
    console.log(b + ': hybrid ' + bands[b].hybrid.absMax + ' (' + bands[b].hybrid.worstAt + ')  brune '
      + bands[b].brune.absMax + '  gmpe ' + bands[b].gmpe.absMax + '  [limit ' + preReg.metrics.psaLog10BiasAbsMax[b] + ']');
  }
  console.log('PGA: hybrid ' + scalars.pga.hybrid.absMax + ' brune ' + scalars.pga.brune.absMax + ' gmpe ' + scalars.pga.gmpe.absMax + ' [limit ' + preReg.metrics.pgaLog10BiasAbsMax + ']');
  console.log('PGV: hybrid ' + scalars.pgv.hybrid.absMax + ' brune ' + scalars.pgv.brune.absMax + ' gmpe ' + scalars.pgv.gmpe.absMax + ' [limit ' + preReg.metrics.pgvLog10BiasAbsMax + ']');
  console.log('\n=== GATES ===');
  for (const g of Object.keys(gates)) {
    const it = gates[g];
    if (g === 'psaLog10BiasAbsMax') {
      console.log(g + ': ' + Object.keys(it).map((b) => b + '=' + (it[b].pass ? 'PASS' : 'FAIL') + '(' + it[b].hybridAbsMax + ')').join(' '));
    } else {
      console.log(g + ': ' + (it.pass === undefined ? it.status : (it.pass ? 'PASS' : 'FAIL')));
    }
  }
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
