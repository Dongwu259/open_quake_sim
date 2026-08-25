#!/usr/bin/env node
'use strict';
// ================================================================
//  R2 site-term A/B/C scorecard: the frozen K-NET/KiK-net station-peak set
//  (public/geojson/strong-motion-obs.json — same data as
//  scorecard-strong-motion.js) predicted under three site conventions:
//    A 'vs30'     current default — external power-law Physics.vs30Amplification
//                 for reference-site models, native Vs30 classes for
//                 zhao2006/kanno2006 (app forecast default);
//    B 'ss14'     Seyhan & Stewart (2014) nonlinear scalar on the same base;
//    C 'eqlin-1d' Physics.siteResponse1D over a synthesized profile
//                 (J-SHIS Vs30 + JIVSM engineering-bedrock depth) — every
//                 model is evaluated on ITS reference rock (zhao 1200,
//                 kanno 800, si-mid 760-class) and the band-averaged
//                 transfer factors from Physics.eqlinSiteFactor replace the
//                 scalar term, so arm C is one uniform physical convention.
//
//  Report: tools/data/site-response-report.json — per-arm overall/per-event/
//  per-distance-bin log10 PGA/PGV bias+RMS and JMA-intensity residuals,
//  plus eqlin f0 statistics. Exit code is always 0 (report is the product);
//  `--summary` prints the headline table.
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const OBS_PATH = path.join(ROOT, 'public/geojson/strong-motion-obs.json');
const JIVSM_PATH = path.join(ROOT, 'public/geojson/jivsm-bedrock.json');
const OUT_PATH = path.join(ROOT, 'tools/data/site-response-report.json');

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

function newAcc() { return { n: 0, sum: 0, sumSq: 0 }; }
function accAdd(a, v) { a.n++; a.sum += v; a.sumSq += v * v; }
function accStats(a) {
  if (!a.n) return { n: 0 };
  const mean = a.sum / a.n;
  return { n: a.n, bias: mean, rms: Math.sqrt(a.sumSq / a.n) };
}

const DIST_EDGES = [0, 50, 100, 200, 400, Infinity];
const DIST_LABELS = ['<50km', '50-100km', '100-200km', '200-400km', '>400km'];
function distBin(r) {
  for (let i = 0; i < DIST_EDGES.length - 1; i++) if (r >= DIST_EDGES[i] && r < DIST_EDGES[i + 1]) return i;
  return DIST_LABELS.length - 1;
}

// Reference-rock Vs of each model's own base (mirrors scorecard-strong-motion)
function refRockVs(model) {
  if (model === 'zhao2006') return 1200;
  if (model === 'kanno2006') return 800;
  return 760;
}

function siteFactors(arm, model, st, jivsmDepth, rockPgaGal, realProfile) {
  // Returns {pga, pgv} multipliers to apply ON the model's reference-rock
  // prediction — EXCEPT arm 'native' where the station Vs30 went into the
  // GMPE itself (multipliers 1).
  if (arm === 'vs30') {
    if (model === 'zhao2006' || model === 'kanno2006') return null; // native
    if (!(st.vs30 > 0)) return { pga: 1, pgv: 1 };
    return { pga: Physics.vs30Amplification(st.vs30, 'pga'), pgv: Physics.vs30Amplification(st.vs30, 'pgv') };
  }
  if (arm === 'ss14') {
    if (model === 'zhao2006' || model === 'kanno2006') return null; // native (no rock base to scale)
    if (!(st.vs30 > 0)) return { pga: 1, pgv: 1 };
    return {
      pga: Physics.vs30AmplificationNL(st.vs30, 'pga', rockPgaGal),
      pgv: Physics.vs30AmplificationNL(st.vs30, 'pgv', rockPgaGal)
    };
  }
  // eqlin-1d: synthesized profile; stations without Vs30 stay at 1
  // eqlin-sb: same synth profile + the S/B ensemble blend (registry set in
  //           main() from the committed sb-spectral-ratio.json bins)
  if (!(st.vs30 > 0)) return { pga: 1, pgv: 1 };
  let prof;
  if (realProfile && arm !== 'eqlin-sb' && st.code) {
    const rows = realProfile(st.code);
    if (rows) prof = Physics.psLogToProfile(rows);
  }
  if (!prof) prof = Physics.synthSiteProfile(st.vs30, jivsmDepth);
  const f = prof && Physics.eqlinSiteFactor(prof, rockPgaGal);
  return f ? { pga: f.pga, pgv: f.pgv, f0: f.f0, sbApplied: f.sbApplied } : { pga: 1, pgv: 1 };
}

function computeReport(obs, opts) {
  const arms = ['vs30', 'ss14', 'eqlin-1d', 'eqlin-real', 'eqlin-sb'];
  const result = { arms: {}, meta: {} };
  const f0s = [];
  const joined = { pga: {}, pgv: {}, intensity: {} }; // per-arm joined-subset accumulators
  for (const arm of arms) joined[arm] = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
  const realProfile = opts && opts.psLogs || null;
  // deterministic registry state: per-arm toggling below, null on exit so a
  // tool/test process never leaks the prior into later synthSiteProfile calls
  Physics.setSbEnsemble(null);
  const isJoined = opts && opts.joinedStation ? opts.joinedStation : (st => !!(realProfile && st.code && realProfile(st.code)));
  for (const arm of arms) {
    // per-arm registry: only 'eqlin-sb' runs under the S/B empirical prior
    Physics.setSbEnsemble(arm === 'eqlin-sb' ? (opts && opts.sbEnsemble) : null);
    const overall = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
    const dist = DIST_LABELS.map(() => ({ pga: newAcc(), pgv: newAcc(), intensity: newAcc() }));
    const byEvent = [];
    for (const ev0 of obs.events) {
      const ev = ev0.jmaHypo || ev0; // prediction hypocenter hook (kept simple: frozen metadata)
      const acc = { pga: newAcc(), pgv: newAcc(), intensity: newAcc() };
      for (const st of ev.stations) {
        if (!(st.pgaGal > 0) || !(st.pgvCms > 0)) continue;
        const rHypo = Physics.hypoDist(st.lat, st.lng, ev.lat, ev.lng, ev.depthKm);
        const model = Physics.resolveGmpModel('auto', ev.sourceType, ev.mw);
        const rockVs = refRockVs(model);
        const eqlinArm = arm === 'eqlin-1d' || arm === 'eqlin-real' || arm === 'eqlin-sb';
        // Reference-rock prediction
        let pga = Physics.calcPGA(ev.mw, rHypo, model, ev.depthKm, null, null, ev.sourceType,
          undefined, undefined, undefined, undefined, eqlinArm ? rockVs : undefined);
        let pgv = Physics.calcPGV(ev.mw, rHypo, model, ev.depthKm, null, null, ev.sourceType,
          undefined, eqlinArm ? rockVs : undefined);
        // Arm A/B native-vs30 models: re-predict with the station Vs30 inside
        if (!eqlinArm && (model === 'zhao2006' || model === 'kanno2006')) {
          const v = st.vs30 > 0 ? st.vs30 : 400;
          pga = Physics.calcPGA(ev.mw, rHypo, model, ev.depthKm, null, null, ev.sourceType,
            undefined, undefined, undefined, undefined, v);
          pgv = Physics.calcPGV(ev.mw, rHypo, model, ev.depthKm, null, null, ev.sourceType, undefined, v);
        } else {
          const f = siteFactors(arm === 'eqlin-real' ? 'eqlin-1d' : arm, model, st,
            Physics.lookupResearchGrid(opts.jivsm, st.lat, st.lng), pga,
            arm === 'eqlin-real' ? realProfile : null);
          if (f) {
            pga *= f.pga; pgv *= f.pgv;
            if (f.f0) f0s.push(f.f0);
          }
        }
        const intensity = Physics.calibrateIntensity(
          Physics.calcJmaIntensity(pga, pgv), ev.mw, { model: model, distKm: rHypo });
        const obsI = Physics.calcJmaIntensity(st.pgaGal, st.pgvCms);
        const rPga = Math.log10(pga / st.pgaGal), rPgv = Math.log10(pgv / st.pgvCms), rI = intensity - obsI;
        accAdd(acc.pga, rPga); accAdd(acc.pgv, rPgv); accAdd(acc.intensity, rI);
        const db = dist[distBin(rHypo)];
        accAdd(db.pga, rPga); accAdd(db.pgv, rPgv); accAdd(db.intensity, rI);
        accAdd(overall.pga, rPga); accAdd(overall.pgv, rPgv); accAdd(overall.intensity, rI);
        if (isJoined(st)) { accAdd(joined[arm].pga, rPga); accAdd(joined[arm].pgv, rPgv); accAdd(joined[arm].intensity, rI); }
      }
      byEvent.push({ eventId: ev.id || ev.eventId, stats: { pga: accStats(acc.pga), pgv: accStats(acc.pgv), intensity: accStats(acc.intensity) } });
    }
    result.arms[arm] = {
      overall: { pga: accStats(overall.pga), pgv: accStats(overall.pgv), intensity: accStats(overall.intensity) },
      byDistance: dist.map((d, i) => ({ bin: DIST_LABELS[i], pga: accStats(d.pga), pgv: accStats(d.pgv), intensity: accStats(d.intensity) })),
      byEvent
    };
  }
  result.joinedSubset = {};
  for (const arm of arms) result.joinedSubset[arm] = {
    note: 'stations with a KiK-net PS-log profile match (real stratigraphy where available)',
    pga: accStats(joined[arm].pga), pgv: accStats(joined[arm].pgv), intensity: accStats(joined[arm].intensity)
  };
  f0s.sort((a, b) => a - b);
  result.meta.eqlinF0Hz = f0s.length ? {
    n: f0s.length,
    median: f0s[Math.floor(f0s.length / 2)],
    p10: f0s[Math.floor(f0s.length * 0.1)],
    p90: f0s[Math.floor(f0s.length * 0.9)]
  } : null;
  result.meta.convention = 'log10(pred/obs); intensity = pred-obs (JMA both sides); calibration applied';
  Physics.setSbEnsemble(null);
  return result;
}

function main() {
  const obs = JSON.parse(fs.readFileSync(OBS_PATH, 'utf8'));
  let jivsm = null;
  try { jivsm = JSON.parse(fs.readFileSync(JIVSM_PATH, 'utf8')); } catch (e) { /* eqlin falls back to 30 m */ }
  // Local-only KiK-net PS logs (NIED no-redistribution; never committed).
  // Missing file = 'eqlin-real' arm silently equals 'eqlin-1d' (synth only).
  // Validity gate: the parsed logs' travel-time Vs30 must track the observed
  // station Vs30 (median ratio >= 0.5) — the 2026-08-25 parse read the
  // shallow soil-layer table (N-values as "Vs"), failing this gate, and is
  // excluded rather than silently poisoning the arm.
  let psLogs = null, psLogsNote = 'not present';
  const logsPath = path.join(ROOT, '.cache/kiknet-logs/kiknet-ps-logs.json');
  let byCodeSet = null;
  if (fs.existsSync(logsPath)) {
    const doc = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
    const byCode = new Map(doc.stations.map(s => [s.code, s.rows]));
    byCodeSet = new Set(byCode.keys());
    const ratios = [];
    for (const ev of obs.events) for (const st of ev.stations) {
      if (!(st.vs30 > 0)) continue;
      const rows = byCode.get(st.code);
      if (!rows) continue;
      let tt = 0, H = 0;
      for (const r of rows) { tt += (r.to - r.from) / r.vs; H += (r.to - r.from); }
      if (H > 0 && tt > 0) ratios.push((H / tt) / st.vs30);
    }
    ratios.sort((a, b) => a - b);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
    if (med >= 0.5) {
      psLogs = code => byCode.get(code) || null;
      psLogsNote = 'valid (median log-vs30/obs-vs30 = ' + med.toFixed(2) + ')';
    } else {
      psLogsNote = 'EXCLUDED — parsed logs fail the vs30 sanity gate (median ratio ' +
        med.toFixed(2) + '; parsePsLog is reading the wrong table in the raw files)';
    }
  }
  // joined-subset membership is independent of the validity gate: the same
  // stations are compared across arms either way
  const joinedStation = st => st.code && byCodeSet ? byCodeSet.has(st.code) : false;
  // S/B empirical prior for the 'eqlin-sb' arm — committed ensemble block
  // (f0(Vs30) fit drives the two-scale synth column). The registry toggles
  // per arm inside computeReport: 'eqlin-sb' on, every other arm off, so
  // 'eqlin-1d' keeps the legacy uniform-column convention.
  let sbEnsemble = null, sbNote = 'not present';
  try {
    const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/sb-spectral-ratio.json'), 'utf8'));
    sbEnsemble = cal.ensemble || null;
    sbNote = sbEnsemble && sbEnsemble.f0Vs30Fit
      ? 'f0(Vs30) prior n=' + sbEnsemble.f0Vs30Fit.n + ' (a=' + sbEnsemble.f0Vs30Fit.a + ', b=' + sbEnsemble.f0Vs30Fit.b + ')'
      : 'no f0 fit in file';
  } catch (e) { sbNote = 'file missing'; }
  const report = computeReport(obs, { jivsm, psLogs, joinedStation, sbEnsemble });
  report.meta.generatedBy = 'tools/scorecard-site-response.js';
  report.meta.obsFile = 'public/geojson/strong-motion-obs.json';
  report.meta.stations = obs.events.reduce((s, e) => s + e.stations.filter(st => st.pgaGal > 0 && st.pgvCms > 0).length, 0);
  report.meta.psLogs = psLogsNote;
  report.meta.sbEnsemble = sbNote;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 1));
  if (process.argv.includes('--summary') || arg('summary')) {
    for (const arm of Object.keys(report.arms)) {
      const o = report.arms[arm].overall;
      console.log(arm.padEnd(11),
        'PGA bias', (o.pga.bias || 0).toFixed(3), 'rms', (o.pga.rms || 0).toFixed(3),
        '| PGV bias', (o.pgv.bias || 0).toFixed(3), 'rms', (o.pgv.rms || 0).toFixed(3),
        '| I bias', (o.intensity.bias || 0).toFixed(3), 'rms', (o.intensity.rms || 0).toFixed(3),
        '(n=' + (o.pga.n || 0) + ')');
    }
    for (const arm of Object.keys(report.joinedSubset)) {
      const o = report.joinedSubset[arm];
      console.log('joined/' + arm.padEnd(11),
        'PGA bias', (o.pga.bias || 0).toFixed(3), 'rms', (o.pga.rms || 0).toFixed(3),
        '| I bias', (o.intensity.bias || 0).toFixed(3), 'rms', (o.intensity.rms || 0).toFixed(3),
        '(n=' + (o.pga.n || 0) + ')');
    }
    console.log('eqlin f0:', JSON.stringify(report.meta.eqlinF0Hz));
  }
  console.log('report ->', OUT_PATH);
}

if (require.main === module) main();
module.exports = { computeReport };
