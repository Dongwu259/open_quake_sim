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
//
//  Bins with fewer than MIN_EVENTS events keep deltaI = 0 — the correction
//  grows into the table as the recorder accumulates more events.
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

function buildCalibration(frames, stations) {
  const { events } = collectEewEvents(frames);
  const catalog = collectCatalogEntries(frames);
  const kmoniFrames = [];
  for (const f of frames) {
    if (f.type === 'kmoni_rt' && f.event && typeof f.event.intensity === 'string') {
      kmoniFrames.push({ t: f.t, intensity: f.event.intensity });
    }
  }
  const acc = BINS.map(() => ({ residuals: [], obs: [], events: [] }));
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
    // felt-subset residual collection: rebuild per-station pairs for the bin
    for (let i = 0; i < r.obs.length; i++) {
      if (isNaN(r.obs[i])) continue;
      if (r.obs[i] >= 0.5 || r.pred[i] >= 0.5) {
        acc[bi].residuals.push(r.pred[i] - r.obs[i]);
        acc[bi].obs.push(r.obs[i]);
      }
    }
    acc[bi].events.push({ eventId: ev.eventId, mag: truth.mag, srcType: r.srcType, felt: stats.felt });
  }

  const bins = BINS.map((b, i) => {
    const a = acc[i];
    const n = a.residuals.length;
    const bias = n ? a.residuals.reduce((x, y) => x + y, 0) / n : 0;
    const rmsBefore = n ? Math.sqrt(a.residuals.reduce((x, y) => x + y * y, 0) / n) : null;
    let deltaI = 0;
    if (a.events.length >= MIN_EVENTS && n > 0) {
      deltaI = Math.max(MAX_DOWN, Math.min(MAX_UP, -bias));
    }
    const rmsAfter = n ? Math.sqrt(a.residuals.reduce((x, y) => x + (y + deltaI) * (y + deltaI), 0) / n) : null;
    return {
      minM: b.minM, maxM: b.maxM,
      deltaI: +deltaI.toFixed(3),
      events: a.events.length,
      stations: n,
      bias: n ? +bias.toFixed(3) : null,
      rmsBefore: rmsBefore == null ? null : +rmsBefore.toFixed(3),
      rmsAfter: rmsAfter == null ? null : +rmsAfter.toFixed(3),
      eventIds: a.events.map(e => e.eventId)
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
  const outPath = outArg ? outArg.split('=')[1] : 'public/geojson/gmpe-calibration.json';

  const dir = path.join(__dirname, '..', 'recordings');
  const targets = files.length ? files
    : fs.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/.test(f)).map(f => path.join(dir, f));
  if (!targets.length) {
    console.log('no recordings found; writing identity calibration');
  }
  const frames = [];
  for (const f of targets) frames.push(...readRecordingFile(f));
  console.log('loaded', frames.length, 'frames from', targets.length, 'file(s)');

  const sl = await loadSitelist(sitelistArg ? sitelistArg.split('=')[1] : null);
  const stations = sl.items.map(it => Array.isArray(it) ? it : [it.lat, it.lng ?? it.lon]);
  console.log('stations:', stations.length, 'from', sl.source);

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

module.exports = { buildCalibration, binIndex, BINS, preserveForeignBlocks };
