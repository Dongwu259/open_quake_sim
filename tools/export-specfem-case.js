#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.7 R3-4: SPECFEM3D crosscheck case exporter
//  (see tools/specfem3d-crosscheck/README.md — OFFLINE comparison asset,
//  nothing here runs in the browser or in CI).
//
//  Exports a self-contained case:
//    CMTSOLUTION  — strike/dip/rake + Mw -> moment-tensor components
//                   (Aki & Richards DC decomposition, r/t/p up-south-east,
//                   self-checked: zero trace, |M|/M0 within 1% of 1)
//    STATIONS     — lat/lng/burial table from the frozen Kumamoto package
//    model_1d.txt — the SAME 1-D model our travel engine uses: JIVSM V4
//                   column at the source region + IASP91 continuation
//                   (depth_km Vp Vs rho)
//    expected.json— our P/S travel times at each station (IASP91 and JIVSM
//                   composed) + the frozen observed S-P picks for reference
//
//  Usage: node tools/export-specfem-case.js [--out=DIR]
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require(path.join(__dirname, '..', 'public', 'physics.js'));

const ROOT = path.resolve(__dirname, '..');
const argOf = pre => {
  const a = process.argv.slice(2).find(x => x.startsWith(pre));
  return a ? a.slice(pre.length) : null;
};
const OUT = argOf('--out=') ? path.join(ROOT, argOf('--out=')) : path.join(ROOT, 'tools/specfem3d-crosscheck/case-kumamoto2016');

// Kumamoto 2016-04-16 M7.3 (JMA/USGS mechanism, same frozen event as the
// strong-motion scorecard and travel-time picks)
const SOURCE = { lat: 32.753, lng: 130.762, mw: 7.3, depthKm: 12, strike: 226, dip: 65, rake: -10 };
const EQID = '20160416012405';

function deg(d) { return d * Math.PI / 180; }

// Aki & Richards double-couple components (x north, y east, z down)
function dcMomentTensor(strike, dip, rake, m0) {
  const f = deg(strike), d = deg(dip), l = deg(rake);
  const sd = Math.sin(d), cd = Math.cos(d), s2d = Math.sin(2 * d), c2d = Math.cos(2 * d);
  const sf = Math.sin(f), cf = Math.cos(f), s2f = Math.sin(2 * f), c2f = Math.cos(2 * f);
  const sl = Math.sin(l), cl = Math.cos(l);
  const Mxx = -m0 * (sd * cl * s2f + s2d * sl * sf * sf);
  const Myy = m0 * (sd * cl * s2f - s2d * sl * cf * cf);
  const Mzz = m0 * s2d * sl;
  const Mxy = m0 * (sd * cl * c2f + 0.5 * s2d * sl * s2f);
  const Mxz = -m0 * (cd * cl * cf + c2d * sl * sf);
  const Myz = -m0 * (cd * cl * sf - c2d * sl * cf);
  // to r (up) / t (south) / p (east): r=-z, t=-x, p=y
  const M = {
    Mrr: Mzz, Mtt: Mxx, Mpp: Myy,
    Mrt: Mxz, Mrp: -Myz, Mtp: -Mxy
  };
  // self-checks: zero trace + double-couple norm
  const trace = M.Mrr + M.Mtt + M.Mpp;
  const norm = Math.sqrt(M.Mrr * M.Mrr + M.Mtt * M.Mtt + M.Mpp * M.Mpp +
    2 * (M.Mrt * M.Mrt + M.Mrp * M.Mrp + M.Mtp * M.Mtp));
  if (Math.abs(trace) > 1e-6 * m0) throw new Error('non-zero trace ' + trace);
  if (Math.abs(norm - Math.SQRT2 * m0) > 0.01 * Math.SQRT2 * m0) {
    throw new Error('DC norm check failed: |M|=' + norm + ' expected ' + Math.SQRT2 * m0);
  }
  return M;
}

function main() {
  const columns = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/jivsm-columns.json'), 'utf8'));
  Physics.setJivsmColumns(columns);
  const m0 = Physics.seismicMoment(SOURCE.mw);
  const M = dcMomentTensor(SOURCE.strike, SOURCE.dip, SOURCE.rake, m0);

  // --- CMTSOLUTION (SPECFEM3D convention) ---
  const o = new Date('2016-04-16T01:25:00+09:00');
  const pad = (n, w) => n.toFixed(4).padStart(w + 1, '0');
  const cmt = [
    ' ' + o.getUTCFullYear() + ' ' + String(o.getUTCMonth() + 1).padStart(2, '0') + ' ' +
      String(o.getUTCDate()).padStart(2, '0') + ' ' + String(o.getUTCHours()).padStart(2, '0') + ' ' +
      String(o.getUTCMinutes()).padStart(2, '0') + ' ' + String(o.getUTCSeconds()).padStart(2, '0'),
    ' event name:  kumamoto2016 (quake_sim crosscheck case)',
    ' time shift:      0.00',
    ' half duration:  ' + (0.5 / Physics.cornerFrequency(SOURCE.mw, 10)).toFixed(2), // Brune corner (s)
    ' latitude:       ' + SOURCE.lat.toFixed(4),
    ' longitude:      ' + SOURCE.lng.toFixed(4),
    ' depth(km):      ' + SOURCE.depthKm.toFixed(1),
    ' Mrr:       ' + (M.Mrr * 1e7).toExponential(16), // Nm -> dyne-cm (SPECFEM unit)
    ' Mtt:       ' + (M.Mtt * 1e7).toExponential(16),
    ' Mpp:       ' + (M.Mpp * 1e7).toExponential(16),
    ' Mrt:       ' + (M.Mrt * 1e7).toExponential(16),
    ' Mrp:       ' + (M.Mrp * 1e7).toExponential(16),
    ' Mtp:       ' + (M.Mtp * 1e7).toExponential(16)
  ].join('\n') + '\n';

  // --- STATIONS + expected travel times ---
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/strong-motion-waveforms/' + EQID + '.json'), 'utf8'));
  const picksByStation = {};
  try {
    const picks = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/data/travel-time-picks.json'), 'utf8'));
    for (const p of picks.picks || []) if (p.eqid === EQID) picksByStation[p.station] = p;
  } catch (e) { /* picks file optional */ }

  const stations = [];
  const expected = [];
  for (const st of pkg.stations) {
    const meta = st.station;
    if (meta.lat == null || meta.lng == null) continue;
    const dist = Physics.haversineDist(SOURCE.lat, SOURCE.lng, meta.lat, meta.lng);
    Physics.JIVSM_TRAVEL_ON = false;
    const tP91 = Physics.pTravelTime(dist, SOURCE.depthKm), tS91 = Physics.sTravelTime(dist, SOURCE.depthKm);
    Physics.JIVSM_TRAVEL_ON = true;
    const tPjm = Physics.pTravelTime(dist, SOURCE.depthKm, undefined, meta.lat, meta.lng);
    const tSjm = Physics.sTravelTime(dist, SOURCE.depthKm, undefined, meta.lat, meta.lng);
    Physics.JIVSM_TRAVEL_ON = null;
    stations.push({ id: meta.id, name: meta.name, network: meta.network, lat: meta.lat, lng: meta.lng });
    expected.push({
      id: meta.id, distKm: +dist.toFixed(2),
      pIasp91S: +tP91.toFixed(3), sIasp91S: +tS91.toFixed(3),
      pJivsmS: +tPjm.toFixed(3), sJivsmS: +tSjm.toFixed(3),
      observedSpSec: picksByStation[meta.id] ? picksByStation[meta.id].spObs : null
    });
  }

  const stationsFile = ['NETWORK STATION LATITUDE LONGITUDE ELEVATION BURIAL',
    ...stations.map(s => `XX ${s.id} ${s.lat.toFixed(4)} ${s.lng.toFixed(4)} 0.0 0.0`)].join('\n') + '\n';

  // --- 1-D model: JIVSM column at the source region + IASP91 continuation ---
  const col = Physics.jivsmColumnAt(SOURCE.lat, SOURCE.lng) || [];
  const lines = [
    '# depth_km Vp_km/s Vs_km/s rho_kg_m3  (JIVSM V4 column at ' + SOURCE.lat.toFixed(3) + ',' + SOURCE.lng.toFixed(3) + ' + IASP91 continuation)',
    '# built by tools/export-specfem-case.js — same composition rule as Physics.composedTravelSegments'
  ];
  let top = 0;
  const rawRows = [];
  for (const l of col) {
    if ((l.bottomM - top) / 1000 <= 0) continue;
    rawRows.push([top / 1000, l.bottomM / 1000, l.vp / 1000, l.vs / 1000, l.rho]);
    top = l.bottomM;
  }
  // merge sub-50 m layers (block-mean thin steps) with travel-time-weighted
  // velocities so the card has no near-zero-thickness interfaces: keep
  // accumulating while the buffered layer is thinner than the floor, tail
  // folds into the previous emitted layer
  const MIN_H = 0.05;
  const rows = [];
  let acc = null;
  const mergeInto = (a, t, b, vp, vs, rho) => {
    const H0 = a.b - a.t, h = b - t;
    a.vp = (a.vp * H0 + vp * h) / (H0 + h);
    a.vs = (a.vs * H0 + vs * h) / (H0 + h);
    a.rho = (a.rho * H0 + rho * h) / (H0 + h);
    a.b = b;
  };
  for (const [t, b, vp, vs, rho] of rawRows) {
    if (acc && (acc.b - acc.t) < MIN_H) mergeInto(acc, t, b, vp, vs, rho);
    else {
      if (acc) rows.push([acc.t, acc.vp, acc.vs, acc.rho]);
      acc = { t, b, vp, vs, rho };
    }
  }
  if (acc) {
    if ((acc.b - acc.t) < MIN_H && rows.length) {
      const last = rows[rows.length - 1];
      const H0 = 0.05, h = acc.b - acc.t; // previous emitted layer ≈ floor thickness
      last[1] = (last[1] * H0 + acc.vp * h) / (H0 + h);
      last[2] = (last[2] * H0 + acc.vs * h) / (H0 + h);
      last[3] = (last[3] * H0 + acc.rho * h) / (H0 + h);
    } else rows.push([acc.t, acc.vp, acc.vs, acc.rho]);
  }
  // IASP91 continuation rows take depth = interface top
  const cont = [];
  for (let r = 0; r < Physics.IASP91.length; r++) {
    const rTop = Physics.IASP91[r][0];
    const rBot = r + 1 < Physics.IASP91.length ? Physics.IASP91[r + 1][0] : 100;
    if (rBot <= top / 1000) continue;
    const segTop = Math.max(rTop, top / 1000);
    cont.push([segTop, Physics.IASP91[r][1], Physics.IASP91[r][2], 2700 + 100 * r]);
  }
  for (const row of cont) rows.push(row);
  for (const [d, vp, vs, rho] of rows) lines.push(d.toFixed(2) + ' ' + vp.toFixed(3) + ' ' + vs.toFixed(3) + ' ' + rho.toFixed(0));
  // --- write the case ---
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'CMTSOLUTION'), cmt);
  fs.writeFileSync(path.join(OUT, 'STATIONS'), stationsFile);
  fs.writeFileSync(path.join(OUT, 'model_1d.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify({
    schema: 'quake-sim-specfem-crosscheck-v1',
    source: SOURCE, momentTensorNm: { ...M, M0: m0 },
    note: 'compare offline SPECFEM3D synthetics: (1) P/S arrival times vs pIasp91S/pJivsmS (bandpassed onset), (2) observed S-P from frozen Kyoshin picks where present. NOTHING here is a browser/CI artefact.',
    stations: expected,
    provenance: {
      waveforms: 'NIED K-NET/KiK-net station coordinates from the frozen package (DOI 10.17598/NIED.0004)',
      jivsm: 'J-SHIS JIVSM V4 (public/geojson/jivsm-columns.json derived grid)'
    }
  }, null, 1));
  console.log('exported', OUT, '| stations:', stations.length,
    '| model rows:', rows.length, '| Mrr/Mtt/Mpp (Nm):', M.Mrr.toExponential(2), M.Mtt.toExponential(2), M.Mpp.toExponential(2));
}
main();
