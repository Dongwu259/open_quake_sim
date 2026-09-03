#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.2 — frozen DEMO snapshot for the experience report page
//  (public/report.html). Computes the same view-model the app-side
//  _captureReportSnapshot() produces, but offline through the Physics
//  engine for the default tokyoInland preset (capital-inland M7.3):
//  per-prefecture GMPE forecast on the prefecture centroids + top
//  station peaks over the bundled 1,289-station catalog.
//
//  Honest positioning: this is a STATIC FORECAST snapshot (no time
//  simulation, point-source equal-area Rrup proxy, zhao2006 + shipped
//  modelBias), clearly labeled 示例/sample in the report UI. The
//  spectrum section uses Physics.synthesizeWaveform3C at the strongest
//  station — same synthesizer the app's waveform panel uses.
// =====================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'geojson', 'report-demo.json');

// tokyoInland preset (public/app.js PRESETS), frozen verbatim
const EV = { lat: 35.62, lng: 139.75, mag: 7.3, depth: 17, strike: 135, dip: 60, rake: 120 };

function centroidOf(feature) {
  // area-weighted polygon centroid over outer rings (holes ignored — fine at
  // prefecture scale for a demo forecast)
  let A = 0, cx = 0, cy = 0;
  const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const poly of polys) {
    const ring = poly[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const cr = x0 * y1 - x1 * y0;
      A += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
    }
  }
  if (Math.abs(A) < 1e-12) return { lat: ring0y(feature), lng: ring0x(feature) };
  return { lng: cx / (3 * A), lat: cy / (3 * A) };
}
function ring0x(f) { const p = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]; return p[0][0]; }
function ring0y(f) { const p = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]; return p[0][1]; }

function main() {
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'gmpe-calibration.json'), 'utf8'));
  Physics.setGmpeCalibration(cal);
  const vs30Grid = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'vs30.json'), 'utf8'));
  const prefsGeo = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'japan_prefectures.geojson'), 'utf8'));
  const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'stations.json'), 'utf8'));

  const srcType = 'crustal';
  const vs30At = (lat, lng) => Physics.lookupResearchGrid(vs30Grid, lat, lng) || 400;

  function forecastAt(lat, lng) {
    const hd = Physics.haversineDist(EV.lat, EV.lng, lat, lng);
    const hyp = Math.sqrt(hd * hd + EV.depth * EV.depth);
    const rRup = Physics._pshaPointRrup(hyp, EV.mag, srcType);
    const vs30 = vs30At(lat, lng);
    const pga = Physics.pgaZhao2006(EV.mag, rRup, EV.depth, srcType, vs30, EV.rake);
    const pgv = Physics.pgvZhao2006(EV.mag, rRup, EV.depth, srcType, vs30, EV.rake);
    const rawI = Physics.calcJmaIntensity(pga, pgv);
    const calI = Physics.calibrateIntensity(rawI, EV.mag, { model: 'zhao2006', distKm: rRup });
    return { i: calI, shindo: String(Physics.shindoLabel(calI)), pga, pgv, rRup, vs30 };
  }

  // prefectures: forecast at centroids, ±1σ via the zhao total sigma
  const prefs = [];
  for (const f of prefsGeo.features) {
    const c = centroidOf(f);
    const fc = forecastAt(c.lat, c.lng);
    prefs.push({ name: f.properties.nam_ja || f.properties.nam, shindo: fc.shindo, score: Physics.shindoScore(fc.shindo), i: fc.i });
  }
  prefs.sort((a, b) => b.score - a.score);
  for (const p of prefs) {
    const ur = Physics.shindoUncertaintyRange(p.i);
    p.range = ur ? ur.lowLabel + '~' + ur.highLabel : '';
    p.lpgm = 0; // long-period class needs the anchored-spectrum path — omitted in the demo
    delete p.i; delete p.score;
  }

  // stations: top 12 by forecast PGA
  const stList = Array.isArray(stations) ? stations : (stations.stations || stations.features || []);
  const rows = [];
  for (const s of stList) {
    const lat = s.lat != null ? s.lat : (s.geometry && s.geometry.coordinates[1]);
    const lng = s.lng != null ? s.lng : (s.geometry && s.geometry.coordinates[0]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const name = s.name || s.nam || s.code || String(s.id || '');
    const fc = forecastAt(lat, lng);
    rows.push({ name, shindo: fc.shindo, score: Physics.shindoScore(fc.shindo), pga: fc.pga, pgv: fc.pgv, lat, lng, rRup: fc.rRup });
  }
  rows.sort((a, b) => b.pga - a.pga);
  const top12 = rows.slice(0, 12).map((r) => ({ name: r.name, shindo: r.shindo, pga: +r.pga.toFixed(1), pgv: +r.pgv.toFixed(2) }));

  // summary from the full station field (report the forecast maximum)
  const maxRow = rows[0] || null;
  const maxI = prefs.length ? Math.max(...prefs.map((p) => 0)) : 0; // prefecture top row carries the label
  const summary = {
    durationS: 0,
    maxShindo: prefs.length ? prefs[0].shindo : '—',
    maxShindoLabel: prefs.length ? prefs[0].shindo : '—',
    maxPgaGal: maxRow ? +maxRow.pga.toFixed(1) : null,
    maxPgvCms: maxRow ? +maxRow.pgv.toFixed(2) : null,
    maxTsunamiM: null, // inland scenario — no tsunami
    stationCount: rows.length
  };

  // spectrum at the strongest station: zhao2006 median PSA per period
  // (model spectrum — labeled as such; live snapshots carry the app's
  // synthesized-station spectrum via _lastSpectrumExport instead)
  let spectrum = null;
  if (maxRow) {
    const vs30 = vs30At(maxRow.lat, maxRow.lng);
    const periods = [];
    for (let i = 0; i < 30; i++) periods.push(+(0.1 * Math.pow(10 / 0.1, i / 29)).toFixed(3));
    const psa = periods.map((T) => Physics.GMPE_PGA_SOFT_CAP * Math.tanh(
      Math.exp(Physics.zhao2006LnA(T.toFixed(2), srcType, EV.mag, maxRow.rRup, EV.depth, vs30, EV.rake)) / Physics.GMPE_PGA_SOFT_CAP));
    spectrum = {
      station: maxRow.name + ' (zhao2006 median PSA)',
      periods, psaGal: psa.map((v) => +v.toFixed(2))
    };
  }

  const snap = {
    schema: 'quake-sim-report-snapshot-v1',
    kind: 'demo',
    capturedAt: new Date().toISOString(),
    event: {
      preset: 'tokyoInland', presetName: 'Tokyo Inland M7.3 (default preset)',
      mag: EV.mag, sliderMag: EV.mag, depthKm: EV.depth,
      lat: EV.lat, lng: EV.lng, sourceClass: srcType,
      faultModel: null, chainCount: null
    },
    summary, prefectures: prefs.slice(0, 15), stations: top12,
    tsunami: null, aftershocks: null, spectrum,
    provenance: {
      builder: 'tools/build-report-demo.js',
      model: 'zhao2006 + shipped modelBias, point-source equal-area Rrup proxy — static forecast, no time simulation',
      inputs: 'japan_prefectures.geojson centroids / stations.json / vs30.json',
      note: 'demo snapshot for the report page; regenerated deterministically (no RNG)'
    }
  };
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
  console.log('wrote ' + OUT);
  console.log('top pref: ' + prefs[0].name + ' ' + prefs[0].shindo + ' | max PGA ' + summary.maxPgaGal + ' gal at ' + (maxRow && maxRow.name));
  console.log('stations scored: ' + rows.length + (spectrum ? ' | spectrum @ ' + spectrum.station : ' | no spectrum'));
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
