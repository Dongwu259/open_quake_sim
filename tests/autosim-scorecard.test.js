// ================================================================
//  Unit tests for the replay-driven auto-sim scorecard
//  Run with:  node --test tests/autosim-scorecard.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const S = require('../tools/scorecard-autosim.js');

// ----------------------------------------------------------------
//  Synthetic fixture builders (all-ASCII; no locale issues)
// ----------------------------------------------------------------
const T0 = Date.UTC(2026, 0, 2, 3, 4, 0); // fixed base epoch ms

function jst(ms) { // epoch ms -> 'YYYY/MM/DD HH:mm:ss' in JST
  const d = new Date(ms + 9 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function eewFrame(t, serial, lat, lng, mag, depth, flags) {
  return {
    t: t, type: 'wolfx_eew',
    event: Object.assign({
      type: 'jma_eew', EventID: 'TEST20260102030400', Serial: serial,
      OriginTime: jst(T0), AnnouncedTime: jst(t),
      Hypocenter: 'Test Offshore', Latitude: lat, Longitude: lng,
      Magunitude: mag, Depth: depth,
      isSea: true, isTraining: false, isAssumption: false,
      isWarn: false, isFinal: false, isCancel: false
    }, flags || {})
  };
}

function catalogFrame(t, lat, lng, mag, depth, issueType) {
  return {
    t: t, type: 'p2pquake',
    event: {
      code: 551, type: 'earthquake_info', mag: mag, lat: lat, lng: lng,
      depth: depth, place: 'Test Offshore', originTime: jst(T0),
      issueType: issueType || 'DetailScale', points: []
    }
  };
}

function kmoniFrame(t, levels) { // levels: array of ints -> intensity string
  return {
    t: t, type: 'kmoni_rt',
    event: { dataTime: new Date(t).toISOString(), intensity: levels.map(l => String.fromCharCode(l + 100)).join('') }
  };
}

// Converging 3-report event: report 1 far off, final nearly on the catalog
// truth (M5.5, 35.10, 139.10, 20 km).
function convergingFrames() {
  return [
    eewFrame(T0 + 5000, 1, 35.60, 139.40, 5.0, 40),
    eewFrame(T0 + 15000, 2, 35.20, 139.20, 5.3, 25),
    eewFrame(T0 + 25000, 3, 35.12, 139.08, 5.4, 22, { isFinal: true, isWarn: true }),
    catalogFrame(T0 + 90000, 35.10, 139.10, 5.5, 20)
  ];
}

// ================================================================
//  PARSING / DECODING PRIMITIVES
// ================================================================

test('parseJstTime — JST wall clock to epoch', () => {
  assert.strictEqual(S.parseJstTime('2026/01/02 12:04:00'), T0);
  assert.strictEqual(S.parseJstTime('2026/01/02 12:04:00.500'), T0 + 500);
  assert.ok(Number.isNaN(S.parseJstTime('not a time')));
  assert.ok(Number.isNaN(S.parseJstTime('')));
});

test('decodeIntensityString + levelToIntensity — NIED 21-level contract', () => {
  const levels = S.decodeIntensityString(String.fromCharCode(100) + String.fromCharCode(108) + String.fromCharCode(96));
  assert.deepStrictEqual([...levels], [0, 8, -1]); // below 'd' clamps to -1 (no data)
  assert.strictEqual(S.levelToIntensity(6), 0);    // level 6 = I 0.0
  assert.strictEqual(S.levelToIntensity(8), 1);    // level 8 = shindo 1
  assert.strictEqual(S.levelToIntensity(16), 5);   // level 16 = 5-
});

test('parseFrames — skips blank and corrupt lines', () => {
  const frames = S.parseFrames('{"t":1,"type":"x","event":{}}\n\nnot json\n{"t":2,"type":"y","event":{}}\n');
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[1].type, 'y');
});

test('readRecordingFile — plain and gzip NDJSON round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autosim-scorecard-'));
  const body = '{"t":1,"type":"a","event":{}}\n{"t":2,"type":"b","event":{}}\n';
  const plain = path.join(dir, 'plain.jsonl');
  const gz = path.join(dir, 'gz.jsonl.gz');
  fs.writeFileSync(plain, body);
  fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(body)));
  assert.strictEqual(S.readRecordingFile(plain).length, 2);
  const fromGz = S.readRecordingFile(gz);
  assert.strictEqual(fromGz.length, 2);
  assert.strictEqual(fromGz[1].type, 'b');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ================================================================
//  CONVERGENCE SCORING
// ================================================================

test('collectEewEvents — groups by EventID, skips training, flags cancelled', () => {
  const frames = convergingFrames().concat([
    eewFrame(T0 + 60000, 1, 35, 139, 5, 10, { isTraining: true }), // training probe
    { t: T0 + 70000, type: 'wolfx_eew', event: {
      type: 'jma_eew', EventID: 'CANCELLED1', Serial: 1, Latitude: 30, Longitude: 130,
      Magunitude: 4.0, Depth: 10, OriginTime: jst(T0), isCancel: true } }
  ]);
  const { events, trainingReports } = S.collectEewEvents(frames);
  assert.strictEqual(trainingReports, 1);
  assert.strictEqual(events.length, 2);
  const cancelled = events.find(e => e.eventId === 'CANCELLED1');
  assert.ok(cancelled.cancelled, 'cancel-terminated event flagged');
  const main = events.find(e => e.eventId === 'TEST20260102030400');
  assert.strictEqual(main.reports.length, 3);
  assert.strictEqual(main.reports[0].serial, 1);
});

test('collectEewEvents — reconnect retransmissions are deduplicated', () => {
  // Wolfx resends identical serials after a reconnect (~10 min later here).
  const first = eewFrame(T0 + 5000, 1, 35.0, 139.0, 5.0, 30);
  const resend = eewFrame(T0 + 605000, 1, 35.0, 139.0, 5.0, 30);
  const corrected = eewFrame(T0 + 606000, 1, 35.1, 139.1, 5.2, 25); // same serial, new values
  const { events } = S.collectEewEvents([first, resend, corrected]);
  assert.strictEqual(events[0].reports.length, 2, 'identical resend dropped, correction kept');
  assert.strictEqual(events[0].retransmissions, 1);
  assert.strictEqual(events[0].reports[0].t, first.t, 'earliest arrival wins');
});

test('findTruth — 551 catalog wins over the EEW final report', () => {
  const frames = convergingFrames();
  const { events } = S.collectEewEvents(frames);
  const catalog = S.collectCatalogEntries(frames);
  const truth = S.findTruth(events[0], catalog);
  assert.strictEqual(truth.source, 'p2pquake-551');
  assert.strictEqual(truth.mag, 5.5);
  assert.strictEqual(truth.lat, 35.10);
});

test('findTruth — falls back to eew-final when no catalog matches', () => {
  const frames = convergingFrames().filter(f => f.type !== 'p2pquake');
  const { events } = S.collectEewEvents(frames);
  const truth = S.findTruth(events[0], S.collectCatalogEntries(frames));
  assert.strictEqual(truth.source, 'eew-final');
  assert.strictEqual(truth.mag, 5.4); // final report, not the catalog
});

test('findTruth — rejects a 551 bulletin outside the time/distance tolerance', () => {
  const frames = [
    eewFrame(T0 + 5000, 1, 35.0, 139.0, 5.0, 30, { isFinal: true }),
    catalogFrame(T0 + 400000, 43.0, 141.0, 6.0, 30) // Hokkaido, +6 min: unrelated
  ];
  const { events } = S.collectEewEvents(frames);
  const truth = S.findTruth(events[0], S.collectCatalogEntries(frames));
  assert.strictEqual(truth.source, 'eew-final');
});

test('scoreEventConvergence — per-report errors shrink toward the truth', () => {
  const frames = convergingFrames();
  const { events } = S.collectEewEvents(frames);
  const truth = S.findTruth(events[0], S.collectCatalogEntries(frames));
  const conv = S.scoreEventConvergence(events[0], truth);
  assert.strictEqual(conv.reportCount, 3);

  // Report timing offsets relative to the first report.
  assert.strictEqual(conv.reports[0].dtSinceFirstS, 0);
  assert.strictEqual(conv.reports[1].dtSinceFirstS, 10);
  assert.strictEqual(conv.reports[2].dtSinceFirstS, 20);

  // Position errors match a direct haversine against the catalog truth.
  for (const r of conv.reports) {
    const expect = S.haversineKm(r.lat, r.lng, 35.10, 139.10);
    assert.ok(Math.abs(r.posErrKm - expect) < 0.15, 'posErr within rounding of haversine');
  }
  // Errors decrease monotonically in this fixture.
  assert.ok(conv.first.posErrKm > conv.reports[1].posErrKm);
  assert.ok(conv.reports[1].posErrKm > conv.final.posErrKm);

  // Magnitude / depth errors are report minus truth.
  assert.strictEqual(conv.reports[0].magErr, -0.5);
  assert.strictEqual(conv.final.magErr, -0.1);
  assert.strictEqual(conv.reports[0].depthErrKm, 20);
  assert.strictEqual(conv.final.depthErrKm, 2);
});

// ================================================================
//  KMONI WINDOW ALIGNMENT & INTENSITY STATS
// ================================================================

test('stationPeakIntensities — window gates frames, per-station max wins', () => {
  const stations = 4;
  const raw = [
    kmoniFrame(T0 - 60000, [20, 20, 20, 20]),   // before window: must be ignored
    kmoniFrame(T0, [8, 10, -1, 6]),              // inside
    kmoniFrame(T0 + 30000, [12, 9, 14, 6]),      // inside
    kmoniFrame(T0 + 600000, [18, 18, 18, 18])    // after window: ignored
  ];
  // stationPeakIntensities takes the pre-filtered {t, intensity} ref shape.
  const frames = raw.map(f => ({ t: f.t, intensity: f.event.intensity }));
  const { obs, framesUsed } = S.stationPeakIntensities(frames, stations, T0 - 10000, T0 + 300000);
  assert.strictEqual(framesUsed, 2);
  assert.strictEqual(obs[0], 3);   // max level 12 -> (12-6)/2
  assert.strictEqual(obs[1], 2);   // max(10, 9) -> 2.0
  assert.strictEqual(obs[2], 4);   // level 14 despite an earlier no-data sample
  assert.strictEqual(obs[3], 0);   // quiet station stays 0, not NaN
});

test('stationPeakIntensities — sitelist-length mismatch frames are dropped', () => {
  const raw = kmoniFrame(T0, [10, 10, 10]); // 3 stations vs expected 4
  const frames = [{ t: raw.t, intensity: raw.event.intensity }];
  const { obs, framesUsed } = S.stationPeakIntensities(frames, 4, T0 - 1000, T0 + 1000);
  assert.strictEqual(framesUsed, 0);
  assert.ok(Number.isNaN(obs[0]));
});

test('intensityStats — felt subset excludes the quiet background', () => {
  // Residuals are exactly ±0.5 in binary (2.5-2.0), so the ±0.5 gate is hit.
  const pred = new Float64Array([2.0, 2.5, 0.1, 0.0]);
  const obs = new Float64Array([2.5, 2.0, 0.0, NaN]);
  const st = S.intensityStats(pred, obs);
  assert.strictEqual(st.all.n, 3);           // NaN station excluded
  assert.strictEqual(st.felt.n, 2);          // only the two shaking stations
  assert.ok(Math.abs(st.felt.bias - 0) < 1e-9);  // (-0.5 + +0.5) / 2
  assert.ok(Math.abs(st.felt.rms - 0.5) < 1e-9); // sqrt((0.25+0.25)/2)
  assert.strictEqual(st.felt.within05Pct, 100);  // both residuals exactly ±0.5
  assert.strictEqual(st.maxObs, 2.5);
});

test('gmpePredictions — near station shakes harder than far station', () => {
  const stations = [[35.0, 139.0], [38.0, 142.0]];
  const { pred, srcType } = S.gmpePredictions(stations, { lat: 35.02, lng: 139.01, mag: 6.0, depthKm: 20, isSea: false });
  assert.strictEqual(srcType, 'crustal'); // inland shallow event
  assert.ok(pred[0] > 3, 'near-field intensity high, got ' + pred[0]);
  assert.ok(pred[0] > pred[1], 'intensity decays with distance');
});

// ================================================================
//  FULL REPORT (buildReport)
// ================================================================

test('buildReport — convergence + intensity sections populated', () => {
  const stations = [[35.10, 139.10], [35.50, 139.50], [40.0, 141.0]];
  const frames = convergingFrames().concat([
    kmoniFrame(T0 + 20000, [14, 12, 8]),
    kmoniFrame(T0 + 40000, [15, 12, 8]),
    kmoniFrame(T0 + 3000000, [20, 20, 20]) // outside every window
  ]);
  const report = S.buildReport(frames, { stations: stations });
  assert.strictEqual(report.noEvents, false);
  assert.strictEqual(report.events.length, 1);

  const ev = report.events[0];
  assert.strictEqual(ev.truthSource, 'p2pquake-551');
  assert.strictEqual(ev.convergence.reportCount, 3);
  assert.ok(ev.intensity.available, 'intensity scored');
  assert.strictEqual(ev.intensity.kmoniFrames, 2); // the far-future frame is outside
  assert.strictEqual(ev.intensity.maxObs, 4.5);    // level 15 -> (15-6)/2
  assert.strictEqual(ev.intensity.srcType, 'interplate'); // offshore shallow
  assert.ok(ev.intensity.all.n === 3 && ev.intensity.felt.n >= 1);
  assert.ok(ev.intensity.felt.rms != null);
});

test('buildReport — quiet recording yields an empty report, not an error', () => {
  const frames = [
    kmoniFrame(T0, [6, 6, 6]),
    { t: T0 + 1000, type: 'jma_feed', event: { title: 'news' } },
    eewFrame(T0 + 2000, 1, 35, 139, 5, 10, { isTraining: true })
  ];
  const report = S.buildReport(frames, { stations: [[35, 139]] });
  assert.strictEqual(report.noEvents, true);
  assert.strictEqual(report.events.length, 0);
  assert.strictEqual(report.trainingReportsSkipped, 1);
});

test('buildReport — cancelled event excluded from scoring', () => {
  const frames = [
    { t: T0 + 5000, type: 'wolfx_eew', event: {
      type: 'jma_eew', EventID: 'CANCELME', Serial: 1, Latitude: 30, Longitude: 130,
      Magunitude: 4.0, Depth: 10, OriginTime: jst(T0) } },
    { t: T0 + 9000, type: 'wolfx_eew', event: {
      type: 'jma_eew', EventID: 'CANCELME', Serial: 2, isCancel: true, OriginTime: jst(T0) } }
  ];
  const report = S.buildReport(frames, { stations: [[35, 139]] });
  assert.strictEqual(report.noEvents, true);
  assert.deepStrictEqual(report.cancelledEvents, ['CANCELME']);
});
