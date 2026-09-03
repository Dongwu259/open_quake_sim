'use strict';
// ================================================================
//  GMPE magnitude-binned intensity-bias calibration.
//
//  Replays recorded EEW events (server recordings) and compares Zhao-2006
//  GMPE intensity predictions computed with CATALOG truth parameters (not the
//  EEW reports, so EEW parameter error does not contaminate the GMPE bias)
//  against windowed kmoni period-max intensities. Per magnitude bin, the felt
//  subset bias becomes a bounded additive intensity correction written to
//  public/geojson/gmpe-calibration.json; the app applies it through
//  Physics.calibrateIntensity in forecast paths only (never in detection
//  inversion or observed-data processing).
//
//  Usage: node tools/calibrate-gmpe.js [recordings...] [--sitelist=path]
//                                     [--out=public/geojson/gmpe-calibration.json]
//         node tools/calibrate-gmpe.js --loeo [--loeo-out=tools/data/gmpe-loeo-report.json]
//
//  Bins with fewer than MIN_EVENTS events keep deltaI = 0 — the correction
//  grows into the table as the recorder accumulates more events.
//
//  --loeo runs the leave-one-event-out generalization report (R0-4): each
//  event is scored with a correction refitted from the remaining events
//  (gate re-applied per fold). Report-only; never touches the live file.
// ================================================================
const fs = require('fs');
const path = require('path');

const {
  readRecordingFile, collectEewEvents, collectCatalogEntries, findTruth,
  finalReportOf, stationPeakIntensities, gmpePredictions, intensityStats,
  loadSitelist
} = require('./scorecard-autosim.js');

const BINS = [
  { minM: 0,   maxM: 4.5 },
  { minM: 4.5, maxM: 5.5 },
  { minM: 5.5, maxM: 6.5 },
  { minM: 6.5, maxM: 99  }
];
const MIN_EVENTS = 2;          // below this a bin stays at deltaI = 0
const MAX_DOWN = -1.5, MAX_UP = 0.5; // clamp for the additive correction
const WINDOW_PRE_MS = 120000, WINDOW_POST_MS = 600000;

function binIndex(mag) {
  for (let i = 0; i < BINS.length; i++) {
    if (mag >= BINS[i].minM && mag < BINS[i].maxM) return i;
  }
  return -1;
}

// Collect per-station residuals (predicted - observed) for one event using
// catalog truth parameters. Returns null when the event cannot be scored.
function eventResiduals(ev, truth, kmoniFrames, stations) {
  if (!truth || truth.depth == null || !isFinite(truth.mag)) return null;
  const originMs = !isNaN(truth.originMs) ? truth.originMs : ev.reports[0].t;
  const t0 = Math.min(originMs, ev.reports[0].t) - WINDOW_PRE_MS;
  const t1 = Math.max(ev.reports[ev.reports.length - 1].t, originMs) + WINDOW_POST_MS;
  const { obs, framesUsed } = stationPeakIntensities(kmoniFrames, stations.length, t0, t1);
  if (!framesUsed) return null;
  const { pred, srcType } = gmpePredictions(stations, {
    lat: truth.lat, lng: truth.lng, mag: truth.mag, depthKm: truth.depth
  });
  return { pred, obs, srcType };
}

// Shared collection: per-event felt-subset residuals binned by magnitude.
// Used by both the deployed fit (buildCalibration) and the leave-one-out
// generalization report (buildLoeoReport) so the two can never diverge.
function collectBinnedResiduals(frames, stations) {
  const { events } = collectEewEvents(frames);
  const catalog = collectCatalogEntries(frames);
  const kmoniFrames = [];
  for (const f of frames) {
    if (f.type === 'kmoni_rt' && f.event && typeof f.event.intensity === 'string') {
      kmoniFrames.push({ t: f.t, intensity: f.event.intensity });
    }
  }
  const acc = BINS.map(() => ({ events: [] }));
  let skipped = 0;
  for (const ev of events) {
    if (ev.cancelled || !ev.validReports.length) { skipped++; continue; }
    const truth = findTruth(ev, catalog);
    // Only catalog-quality truth isolates the GMPE bias from EEW param error.
    if (!truth || truth.source === 'eew-final') { skipped++; continue; }
    const bi = binIndex(truth.mag);
    if (bi < 0) { skipped++; continue; }
    const r = eventResiduals(ev, truth, kmoniFrames, stations);
    if (!r) { skipped++; continue; }
    const stats = intensityStats(r.pred, r.obs);
    if (!stats.felt.n) { skipped++; continue; }
    const residuals = [];
    for (let i = 0; i < r.obs.length; i++) {
      if (isNaN(r.obs[i])) continue;
      if (r.obs[i] >= 0.5 || r.pred[i] >= 0.5) residuals.push(r.pred[i] - r.obs[i]);
    }
    acc[bi].events.push({ eventId: ev.eventId, mag: truth.mag, srcType: r.srcType, residuals, felt: stats.felt });
  }
  return { acc, skipped };
}

// The deployed correction rule: negative felt-subset bias, clamped, gated on
// a minimum number of events (below the gate the bin stays at zero).
function fitDeltaI(residuals, eventCount) {
  const n = residuals.length;
  if (eventCount < MIN_EVENTS || n === 0) return 0;
  const bias = residuals.reduce((x, y) => x + y, 0) / n;
  return Math.max(MAX_DOWN, Math.min(MAX_UP, -bias));
}

function rmsOf(residuals) {
  if (!residuals.length) return null;
  return Math.sqrt(residuals.reduce((x, y) => x + y * y, 0) / residuals.length);
}

function buildCalibration(frames, stations) {
  const { acc, skipped } = collectBinnedResiduals(frames, stations);

  const bins = BINS.map((b, i) => {
    const events = acc[i].events;
    const residuals = events.flatMap(e => e.residuals);
    const n = residuals.length;
    const bias = n ? residuals.reduce((x, y) => x + y, 0) / n : 0;
    const rmsBefore = rmsOf(residuals);
    const deltaI = fitDeltaI(residuals, events.length);
    const rmsAfter = rmsOf(residuals.map(r => r + deltaI));
    return {
      minM: b.minM, maxM: b.maxM,
      deltaI: +deltaI.toFixed(3),
      events: events.length,
      stations: n,
      bias: n ? +bias.toFixed(3) : null,
      rmsBefore: rmsBefore == null ? null : +rmsBefore.toFixed(3),
      rmsAfter: rmsAfter == null ? null : +rmsAfter.toFixed(3),
      eventIds: events.map(e => e.eventId)
    };
  });

  return {
    schema: 'quake-sim-gmpe-calibration-v1',
    generatedAt: new Date().toISOString(),
    model: 'zhao2006',
    method: 'felt-subset bias of catalog-truth GMPE predictions vs windowed kmoni period-max; '
      + 'additive intensity correction, clamped [' + MAX_DOWN + ',' + MAX_UP + '], min ' + MIN_EVENTS + ' events per bin',
    minEvents: MIN_EVENTS,
    eventsSkipped: skipped,
    bins
  };
}

// Leave-one-event-out generalization report (R0-4): for every event in a bin,
// refit the bin's deltaI from the REMAINING events (the MIN_EVENTS gate is
// re-applied, so a bin that only just clears the gate refits to zero) and
// score the held-out event's residuals with that refit correction. If the
// calibration generalizes, held-out RMS should not exceed the uncorrected
// RMS; if it does, the deployed correction is fitting event-specific noise.
function buildLoeoReport(frames, stations) {
  const { acc, skipped } = collectBinnedResiduals(frames, stations);

  const bins = BINS.map((b, i) => {
    const events = acc[i].events;
    const all = events.flatMap(e => e.residuals);
    const deltaIDeployed = fitDeltaI(all, events.length);
    const heldOutCorrected = [];  // residual + LOO-refit correction, concatenated
    const loeo = events.map(ev => {
      const rest = events.filter(e2 => e2 !== ev);
      const refit = fitDeltaI(rest.flatMap(e2 => e2.residuals), rest.length);
      const corrected = ev.residuals.map(r => r + refit);
      heldOutCorrected.push(...corrected);
      const round3 = v => v == null ? null : +v.toFixed(3);
      return {
        eventId: ev.eventId, mag: +ev.mag.toFixed(2), stations: ev.residuals.length,
        deltaIRefit: round3(refit),
        rmsUncorrected: round3(rmsOf(ev.residuals)),
        rmsHeldOutRefit: round3(rmsOf(corrected)),
        rmsDeployed: round3(rmsOf(ev.residuals.map(r => r + deltaIDeployed)))
      };
    });
    const heldRms = rmsOf(heldOutCorrected);
    const uncorrRms = rmsOf(all);
    const round3 = v => v == null ? null : +v.toFixed(3);
    return {
      minM: b.minM, maxM: b.maxM, events: events.length, stations: all.length,
      deltaIDeployed: round3(deltaIDeployed),
      rmsUncorrected: round3(uncorrRms),
      rmsHeldOutLOO: round3(heldRms),
      rmsInSampleDeployed: round3(rmsOf(all.map(r => r + deltaIDeployed))),
      heldOutWorseThanUncorrected: heldRms != null && uncorrRms != null && heldRms > uncorrRms + 1e-9,
      events_detail: loeo
    };
  });

  const active = bins.filter(b => b.events > 0);
  const anyWorse = active.some(b => b.heldOutWorseThanUncorrected);
  return {
    schema: 'quake-sim-gmpe-loeo-v1',
    generatedAt: new Date().toISOString(),
    model: 'zhao2006',
    method: 'leave-one-event-out refit of the magnitude-binned deltaI (MIN_EVENTS gate re-applied '
      + 'per fold); held-out event residuals scored with the fold correction',
    minEvents: MIN_EVENTS,
    eventsSkipped: skipped,
    bins,
    conclusion: active.length === 0
      ? 'no scored events — nothing to test'
      : (anyWorse
        ? 'held-out RMS exceeds uncorrected RMS in at least one bin: the deployed correction does not generalize to unseen events and should be re-examined'
        : 'held-out RMS does not exceed uncorrected RMS in any bin: no leave-one-out evidence of overfitting')
  };
}

// Blocks this tool does not own (e.g. modelBias fitted by
// scorecard-strong-motion.js) survive a regeneration of the live file.
function preserveForeignBlocks(prev, next) {
  if (!prev || typeof prev !== 'object') return next;
  for (const k of Object.keys(prev)) if (!(k in next)) next[k] = prev[k];
  return next;
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--'));
  const sitelistArg = args.find(a => a.startsWith('--sitelist='));
  const outArg = args.find(a => a.startsWith('--out='));
  const loeo = args.includes('--loeo');
  // 2026-09-03: --loeo refresh note — the report is only meaningful over
  // recordings that contain scored events; a recordings rotation with no
  // qualifying events produces a vacuous 'no scored events' report. The
  // frozen 2026-08-23 report stays until event-rich recordings exist.
  const loeoOutArg = args.find(a => a.startsWith('--loeo-out='));
  const outPath = outArg ? outArg.split('=')[1] : 'public/geojson/gmpe-calibration.json';

  const dir = path.join(__dirname, '..', 'recordings');
  const targets = files.length ? files
    : fs.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/.test(f)).map(f => path.join(dir, f));
  if (!targets.length) {
    console.log('no recordings found; writing identity calibration');
  }
  const frames = [];
  for (const f of targets) { const fr = readRecordingFile(f); for (let i = 0; i < fr.length; i++) frames.push(fr[i]); }
  console.log('loaded', frames.length, 'frames from', targets.length, 'file(s)');

  const sl = await loadSitelist(sitelistArg ? sitelistArg.split('=')[1] : null);
  const stations = sl.items.map(it => Array.isArray(it) ? it : [it.lat, it.lng ?? it.lon]);
  console.log('stations:', stations.length, 'from', sl.source);

  if (loeo) {
    // Report-only mode: the deployed calibration file is left untouched.
    const report = buildLoeoReport(frames, stations);
    report.recordings = targets.map(t => path.basename(t));
    const loeoPath = loeoOutArg ? loeoOutArg.split('=')[1] : 'tools/data/gmpe-loeo-report.json';
    fs.mkdirSync(path.dirname(loeoPath), { recursive: true });
    fs.writeFileSync(loeoPath, JSON.stringify(report, null, 2) + '\n');
    for (const b of report.bins) {
      if (!b.events) continue;
      console.log(`M[${b.minM}-${b.maxM}) events=${b.events} deltaI=${b.deltaIDeployed} `
        + `LOO held-out RMS ${b.rmsHeldOutLOO} vs uncorrected ${b.rmsUncorrected}`);
    }
    console.log(report.conclusion);
    console.log('wrote', loeoPath);
    return;
  }

  const table = buildCalibration(frames, stations);
  if (fs.existsSync(outPath)) {
    try {
      preserveForeignBlocks(JSON.parse(fs.readFileSync(outPath, 'utf8')), table);
    } catch (e) { console.warn('existing calibration unreadable; extra blocks not preserved:', e.message); }
  }
  fs.writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n');
  for (const b of table.bins) {
    console.log(`M[${b.minM}-${b.maxM}) events=${b.events} stations=${b.stations} `
      + `bias=${b.bias} deltaI=${b.deltaI} rms ${b.rmsBefore} -> ${b.rmsAfter}`);
  }
  console.log('wrote', outPath);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { buildCalibration, buildLoeoReport, binIndex, BINS, preserveForeignBlocks };
