'use strict';

// Build public/observed-fault-models.js — the bundled finite-fault models:
//
// 1. 'tohoku'   — observed model for the 2011-03-11 Mw 9.1 Tohoku-Oki
//     earthquake, converted from the USGS Hayes (2017) multisegment FSP file
//     (tools/data/tohoku2011_hayes2017.fsp). The runtime FSP parser handles
//     single-segment files only (last column header + one default strike/dip),
//     so the 3-segment Hayes file (dips 15/8/21 deg) is converted offline into
//     native quake-sim-finite-fault-v1 JSON with explicit per-patch corners.
//     Rigidity per patch comes from the FSP's own layered velocity-density
//     model (mu = rho * vs^2 at patch center depth), reproducing the FSP
//     SF_MOMENT column and the header total moment.
//
// 2. 'nankaiM9' — synthetic scenario model for a future Nankai Trough Mw 9.0
//     megathrust earthquake, built on the Cabinet Office (2012) framework:
//     strong-motion fault model Mw 9.0 rupturing Suruga Bay to Hyuga-nada in
//     one event; plate interface from ~5 km (trench) to 35 km depth; classic
//     Tokai/Tonankai/Nankai/Hyuga segmentation with dip steepening eastward;
//     background slip with 大すべり域 (~20 m) and one 超大すべり域 (~40 m);
//     nucleation south of the Kii Peninsula (the most common published
//     assumption), bilateral along-strike propagation at 0.72*Vs ~ 2.5 km/s.
//     Background slip is solved so total moment matches Mw 9.0 exactly.
//
// 3. 'kumamoto2016' — observed USGS NEIC model for the 2016-04-15 Mw 7.0
//     Kumamoto, Kyushu earthquake (tools/data/kumamoto2016_usgs.fsp,
//     event us20005iis): single segment, strike 224, dip 66, right-lateral
//     strike-slip (rake ~208), 18x9 subfaults of 5 x 2.9 km.
//
// 4. 'noto2024' — observed USGS NEIC model for the 2024-01-01 Mw 7.5 Noto
//     Peninsula earthquake (tools/data/noto2024_usgs.fsp, event us6000m0xl):
//     single segment, strike 51, dip 35, reverse-dominant (rake ~120),
//     35x9 subfaults of 5 x 5 km.
//
// 5. 'tokachi2003' — observed USGS NEIC model for the 2003-09-25 Mw 8.2
//     Tokachi-Oki, Hokkaido megathrust earthquake
//     (tools/data/tokachi2003_usgs.fsp, event usp000c8kv): single segment,
//     strike 240, dip 17, rake ~132, 17x25 subfaults of 16 x 9.1 km.
//
// 6. 'fukushima2022' — observed USGS NEIC model for the 2022-03-16 Mw 7.2
//     Fukushima-Oki intraslab earthquake (tools/data/fukushima2022_usgs.fsp,
//     event us6000h519): single segment, strike 184, dip 40, reverse
//     (rake ~80), 20x20 subfaults of 4 x 4 km.
//
// 7. 'hyuganada2024' — observed USGS NEIC model for the 2024-08-08 Mw 7.1
//     Hyuganada Sea earthquake (tools/data/hyuganada2024_usgs.fsp, event
//     us6000nith): single segment, strike 203, dip 19, reverse (rake ~72),
//     15x15 subfaults of 4 x 4 km.
//
// Usage: node tools/build-fault-models.js

const fs = require('node:fs');
const path = require('node:path');
const FiniteFault = require('../public/finite-fault.js');

const ROOT = path.resolve(__dirname, '..');
const FSP_PATH = path.join(__dirname, 'data', 'tohoku2011_hayes2017.fsp');
const KUMAMOTO_FSP_PATH = path.join(__dirname, 'data', 'kumamoto2016_usgs.fsp');
const NOTO_FSP_PATH = path.join(__dirname, 'data', 'noto2024_usgs.fsp');
const TOKACHI_FSP_PATH = path.join(__dirname, 'data', 'tokachi2003_usgs.fsp');
const FUKUSHIMA_FSP_PATH = path.join(__dirname, 'data', 'fukushima2022_usgs.fsp');
const HYUGANADA_FSP_PATH = path.join(__dirname, 'data', 'hyuganada2024_usgs.fsp');
const OUT_PATH = path.join(ROOT, 'public', 'observed-fault-models.js');

function round(value, digits) {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

// ================================================================
//  1. Tohoku 2011 — Hayes (2017) FSP conversion
// ================================================================
function buildTohoku() {
  const DX_KM = 25, DZ_KM = 16.6, MIN_RISE_S = 1;
  const text = fs.readFileSync(FSP_PATH, 'utf8');

  function headerNumber(patterns) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m && isFinite(Number(m[1]))) return Number(m[1]);
    }
    throw new Error('FSP header field missing: ' + patterns[0]);
  }
  const eventLat = headerNumber([/\bLoc\s*:\s*LAT\s*=\s*([\d.eE+-]+)/i]);
  const eventLng = headerNumber([/\bLON\s*=\s*([\d.eE+-]+)/i]);
  const eventDepth = headerNumber([/\bDEP\s*=\s*([\d.eE+-]+)/i]);
  const headerMw = headerNumber([/\bMw\s*=\s*([\d.eE+-]+)/i]);
  const headerMo = headerNumber([/\bMo\s*=\s*([\d.eE+-]+)\s*Nm/i]);

  const layers = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^%\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const topKm = Number(m[1]), vp = Number(m[2]), vs = Number(m[3]), dens = Number(m[4]);
    if (vp > 3 && vs > 0.5) layers.push({topKm, muGPa: dens * vs * vs});
  }
  if (!layers.length) throw new Error('FSP velocity model not found');
  function rigidityAt(depthKm) {
    let mu = layers[0].muGPa;
    for (const layer of layers) if (depthKm >= layer.topKm) mu = layer.muGPa;
    return mu;
  }

  const segmentBlocks = text.split(/(?=%\s*SEGMENT\s+#)/i).filter(block => /%\s*SEGMENT\s+#/i.test(block));
  if (!segmentBlocks.length) throw new Error('FSP segments not found');

  const patches = [];
  for (const block of segmentBlocks) {
    const segHead = block.match(/SEGMENT\s+#\s*(\d+)\s*:\s*STRIKE\s*=\s*([\d.]+)\s*deg\s*DIP\s*=\s*([\d.]+)\s*deg/i);
    if (!segHead) throw new Error('Segment header unparsable');
    const strike = Number(segHead[2]), dip = Number(segHead[3]);
    const lines = block.split(/\r?\n/);
    let colHeader = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*%?\s*LAT\s+LON\s+/i.test(lines[i])) { colHeader = i; break; }
    }
    if (colHeader < 0) throw new Error('Segment column header missing');
    for (let i = colHeader + 1; i < lines.length; i++) {
      const clean = lines[i].trim();
      if (!clean || clean.startsWith('%')) continue;
      const v = clean.split(/\s+/).map(Number);
      if (v.length < 10 || v.some(x => !isFinite(x))) continue;
      const [lat, lng, , , z, slip, rake, trup, rise, sfMoment] = v;
      const center = {lat, lng, depthKm: z};
      const corners = FiniteFault.cornersFromCenter(center, strike, dip, DX_KM, DZ_KM)
        .map(c => ({lat: round(c.lat, 5), lng: round(c.lng, 5), depthKm: round(c.depthKm, 3)}));
      patches.push({
        id: 'p' + String(patches.length + 1).padStart(3, '0'),
        corners,
        strikeDeg: round(strike, 1), dipDeg: round(dip, 1), rakeDeg: round(rake, 1),
        slipM: round(slip, 4), rigidityGPa: round(rigidityAt(z), 2),
        ruptureTimeS: round(trup, 1), riseTimeS: round(Math.max(rise, MIN_RISE_S), 1),
        _sfMoment: sfMoment
      });
    }
  }
  if (!patches.length) throw new Error('No subfault rows parsed');

  let totalMoment = 0, sfMomentSum = 0, maxSlip = 0, maxSlipPatch = null;
  for (const p of patches) {
    const areaM2 = FiniteFault.quadArea(p.corners) * 1e6;
    totalMoment += p.rigidityGPa * 1e9 * areaM2 * p.slipM;
    sfMomentSum += p._sfMoment;
    if (p.slipM > maxSlip) { maxSlip = p.slipM; maxSlipPatch = p; }
    delete p._sfMoment;
  }
  const mw = (Math.log10(totalMoment) - 9.1) / 1.5;
  const residualVsHeader = (totalMoment - headerMo) / headerMo;
  console.log(`[tohoku] patches=${patches.length} Mw=${mw.toFixed(3)} M0=${totalMoment.toExponential(4)}`);
  console.log(`[tohoku] header Mo=${headerMo.toExponential(4)} residual=${(residualVsHeader * 100).toFixed(2)}% SF_MOMENT check=${((totalMoment / sfMomentSum - 1) * 100).toFixed(2)}%`);
  console.log(`[tohoku] peak slip=${maxSlip} m at ${maxSlipPatch.corners[0].lat},${maxSlipPatch.corners[0].lng} (${maxSlipPatch.id})`);
  if (Math.abs(residualVsHeader) > 0.05) throw new Error('Moment residual vs FSP header exceeds 5% — rigidity model wrong');

  return {
    schema: 'quake-sim-finite-fault-v1',
    id: 'tohoku-2011-hayes2017',
    event: {
      id: 'usp000hvnu', lat: eventLat, lng: eventLng, depthKm: eventDepth,
      sourceType: 'interplate', mw: headerMw, momentNm: headerMo
    },
    units: {depth: 'km', slip: 'm', time: 's', moment: 'Nm'},
    rigidityGPa: 40,
    provenance: {
      source: 'USGS NEIC finite fault, Hayes 2017 (EventTAG p000hvnuHAYES)',
      eventId: 'usp000hvnu',
      url: 'https://earthquake.usgs.gov/product/finite-fault/usp000hvnu/us/1539808472261/complete_inversion.fsp',
      license: 'USGS public domain',
      retrievedAt: '2026-08-04T00:00:00Z'
    },
    patches,
    _stats: {mw, patchCount: patches.length, maxSlip}
  };
}

// ================================================================
//  2. Nankai Trough Mw 9.0 — synthetic scenario model
// ================================================================
function buildNankai() {
  const TARGET_MW = 9.0;
  const TARGET_M0 = Math.pow(10, 1.5 * TARGET_MW + 9.1); // 3.981e22 Nm
  const RIGIDITY_GPA = 40;
  const TOP_DEPTH_KM = 5;      // plate interface at the trench axis
  const BOTTOM_DEPTH_KM = 35;  // official downdip limit (deep tremor band)
  const DX_KM = 25;            // along-strike patch size
  const RUPTURE_SPEED_KMS = 2.5; // 0.72 * Vs, Cabinet Office 2012 convention
  const RISE_S = 10;
  const RAKE_DEG = 90;

  // Trough-axis polyline east->west (shallow top edge of the fault plane).
  // Suruga Bay -> Enshu-nada -> Kumano-nada -> off Muroto -> off Ashizuri ->
  // off Sukumo -> Hyuga-nada -> off Cape Toi.
  const NODES = [
    [34.75, 138.50], [34.10, 138.15], [33.75, 137.30], [33.40, 136.30],
    [33.05, 135.05], [32.70, 133.90], [32.30, 132.85], [31.80, 132.05], [31.40, 131.60]
  ];
  // Segment along-strike ranges [km from east end] + dip, following the
  // classic 2013 HERP domains; dip steepens toward Suruga Bay.
  const SEGMENTS = [
    {name: 'tokai', from: 0, to: 168, dip: 18},
    {name: 'tonankai', from: 168, to: 392, dip: 12},
    {name: 'nankai', from: 392, to: 614, dip: 10},
    {name: 'hyuga', from: 614, to: Infinity, dip: 9}
  ];
  // Slip zones: [sFrom, sTo, maxRow] at canonical Cabinet Office levels —
  // super-large ~40 m (Kumano-nada core), large ~20 m (Kumano flanks,
  // off Muroto, Hyuga-nada). Background slip is solved for the M0 target.
  const SUPER_SLIP_M = 40, LARGE_SLIP_M = 20;
  const SLIP_ZONES = [
    {from: 240, to: 290, maxRow: 3, slip: SUPER_SLIP_M},   // Kumano core (super-large)
    {from: 190, to: 240, maxRow: 3, slip: LARGE_SLIP_M},   // Kumano flank (large)
    {from: 290, to: 340, maxRow: 3, slip: LARGE_SLIP_M},   // Kumano flank (large)
    {from: 400, to: 460, maxRow: 3, slip: LARGE_SLIP_M},   // off Muroto (large)
    {from: 640, to: 690, maxRow: 3, slip: LARGE_SLIP_M}    // Hyuga-nada (large)
  ];
  const EDGE_TAPER_KM = 25, EDGE_TAPER_FACTOR = 0.35;
  // Nucleation south of the Kii Peninsula (most common published assumption).
  const NUCLEATION = {sKm: 235, row: 2};

  const KM_PER_DEG_LAT = 111.32;
  function kmEast(nodeA, nodeB) {
    const cosLat = Math.cos((nodeA[0] + nodeB[0]) / 2 * Math.PI / 180);
    return (nodeB[1] - nodeA[1]) * KM_PER_DEG_LAT * cosLat;
  }
  // Polyline with cumulative along-strike distance and per-leg azimuth.
  const legs = [];
  let totalKm = 0;
  for (let i = 0; i < NODES.length - 1; i++) {
    const dNorth = (NODES[i + 1][0] - NODES[i][0]) * KM_PER_DEG_LAT;
    const dEast = kmEast(NODES[i], NODES[i + 1]);
    const lenKm = Math.hypot(dNorth, dEast);
    // Azimuth of the east->west leg == fault strike; the plane dips NW
    // (strike + 90 deg points at the overriding plate).
    const azimuth = (Math.atan2(dEast, dNorth) * 180 / Math.PI + 360) % 360;
    legs.push({from: totalKm, to: totalKm + lenKm, nodeA: NODES[i], nodeB: NODES[i + 1], lenKm, azimuth});
    totalKm += lenKm;
  }
  function polylineAt(sKm) {
    const leg = legs.find(l => sKm <= l.to) || legs[legs.length - 1];
    const f = Math.max(0, Math.min(1, (sKm - leg.from) / leg.lenKm));
    return {
      lat: leg.nodeA[0] + (leg.nodeB[0] - leg.nodeA[0]) * f,
      lng: leg.nodeA[1] + (leg.nodeB[1] - leg.nodeA[1]) * f,
      azimuth: leg.azimuth
    };
  }
  function segmentAt(sKm) {
    return SEGMENTS.find(seg => sKm >= seg.from && sKm < seg.to) || SEGMENTS[SEGMENTS.length - 1];
  }
  // Same local-frame math as finite-fault.js offsetPoint (kept in sync).
  function offsetPoint(center, strikeDeg, dipDeg, alongKm, downDipKm) {
    const strike = strikeDeg * Math.PI / 180, dip = dipDeg * Math.PI / 180, dipDir = strike + Math.PI / 2;
    const north = alongKm * Math.cos(strike) + downDipKm * Math.cos(dip) * Math.cos(dipDir);
    const east = alongKm * Math.sin(strike) + downDipKm * Math.cos(dip) * Math.sin(dipDir);
    return {
      lat: center.lat + north / KM_PER_DEG_LAT,
      lng: center.lng + east / (KM_PER_DEG_LAT * Math.max(0.1, Math.cos(center.lat * Math.PI / 180))),
      depthKm: center.depthKm + downDipKm * Math.sin(dip)
    };
  }

  const nCols = Math.max(1, Math.round(totalKm / DX_KM));
  const dxKm = totalKm / nCols;
  console.log(`[nankaiM9] trough polyline ${totalKm.toFixed(0)} km, ${nCols} columns x ${dxKm.toFixed(1)} km`);

  // Column grid: per-segment row counts sized so the deepest row lands on the
  // 35 km downdip limit.
  const columns = [];
  for (let i = 0; i < nCols; i++) {
    const sKm = (i + 0.5) * dxKm;
    const seg = segmentAt(sKm);
    const widthKm = (BOTTOM_DEPTH_KM - TOP_DEPTH_KM) / Math.sin(seg.dip * Math.PI / 180);
    const nRows = Math.max(2, Math.round(widthKm / 22));
    const dzKm = widthKm / nRows;
    columns.push({sKm, seg, nRows, dzKm, point: polylineAt(sKm)});
  }

  // First pass: zone slips at canonical levels, background marked for solving.
  function zoneSlip(col, row) {
    for (const zone of SLIP_ZONES) {
      if (col.sKm >= zone.from && col.sKm < zone.to && row <= zone.maxRow) return zone.slip;
    }
    return null; // background
  }
  let zoneAD = 0, bgAreaM2 = 0, taperAreaM2 = 0;
  const grid = [];
  for (const col of columns) {
    const topEdge = {lat: col.point.lat, lng: col.point.lng, depthKm: TOP_DEPTH_KM};
    for (let row = 0; row < col.nRows; row++) {
      const corners = [
        offsetPoint(topEdge, col.point.azimuth, col.seg.dip, -dxKm / 2, row * col.dzKm),
        offsetPoint(topEdge, col.point.azimuth, col.seg.dip, dxKm / 2, row * col.dzKm),
        offsetPoint(topEdge, col.point.azimuth, col.seg.dip, dxKm / 2, (row + 1) * col.dzKm),
        offsetPoint(topEdge, col.point.azimuth, col.seg.dip, -dxKm / 2, (row + 1) * col.dzKm)
      ].map(c => ({lat: round(c.lat, 5), lng: round(c.lng, 5), depthKm: round(c.depthKm, 3)}));
      const areaM2 = FiniteFault.quadArea(corners) * 1e6;
      const slip = zoneSlip(col, row);
      const taper = Math.min(col.sKm, totalKm - col.sKm) < EDGE_TAPER_KM;
      if (slip != null) zoneAD += areaM2 * slip;
      else if (taper) taperAreaM2 += areaM2;
      else bgAreaM2 += areaM2;
      grid.push({col, row, corners, areaM2, zoneSlipM: slip, taper});
    }
  }
  const targetAD = TARGET_M0 / (RIGIDITY_GPA * 1e9);
  const bgSlipM = (targetAD - zoneAD) / (bgAreaM2 + EDGE_TAPER_FACTOR * taperAreaM2);
  console.log(`[nankaiM9] background slip solved: ${bgSlipM.toFixed(2)} m (zones keep canonical ${LARGE_SLIP_M}/${SUPER_SLIP_M} m)`);
  if (!(bgSlipM >= 3 && bgSlipM <= 9)) throw new Error('Background slip outside the plausible 3-9 m band: ' + bgSlipM);

  // Rupture timing: planar distance from the nucleation patch at 2.5 km/s.
  const nucCol = columns.reduce((a, b) => Math.abs(b.sKm - NUCLEATION.sKm) < Math.abs(a.sKm - NUCLEATION.sKm) ? b : a);
  const nucDownDipKm = (NUCLEATION.row + 0.5) * nucCol.dzKm;
  const nucPoint = offsetPoint(
    {lat: nucCol.point.lat, lng: nucCol.point.lng, depthKm: TOP_DEPTH_KM},
    nucCol.point.azimuth, nucCol.seg.dip, 0, nucDownDipKm);

  const patches = [];
  let totalMoment = 0, maxSlip = 0, maxRT = 0;
  const slipShares = {super: 0, large: 0, bg: 0, taper: 0};
  for (const cell of grid) {
    const downDipKm = (cell.row + 0.5) * cell.col.dzKm;
    const rt = Math.hypot(cell.col.sKm - nucCol.sKm, downDipKm - nucDownDipKm) / RUPTURE_SPEED_KMS;
    const slip = cell.zoneSlipM != null ? cell.zoneSlipM : bgSlipM * (cell.taper ? EDGE_TAPER_FACTOR : 1);
    const moment = RIGIDITY_GPA * 1e9 * cell.areaM2 * slip;
    totalMoment += moment;
    maxSlip = Math.max(maxSlip, slip);
    maxRT = Math.max(maxRT, rt);
    slipShares[cell.zoneSlipM === SUPER_SLIP_M ? 'super' : cell.zoneSlipM === LARGE_SLIP_M ? 'large' : cell.taper ? 'taper' : 'bg'] += cell.areaM2;
    patches.push({
      id: 'n' + String(patches.length + 1).padStart(3, '0'),
      corners: cell.corners,
      strikeDeg: round(cell.col.point.azimuth, 1), dipDeg: cell.col.seg.dip, rakeDeg: RAKE_DEG,
      slipM: round(slip, 4), rigidityGPa: RIGIDITY_GPA,
      ruptureTimeS: round(rt, 1), riseTimeS: RISE_S,
      properties: {segment: cell.col.seg.name}
    });
  }
  const mw = (Math.log10(totalMoment) - 9.1) / 1.5;
  const totalAreaKm2 = grid.reduce((s, c) => s + c.areaM2, 0) / 1e6;
  console.log(`[nankaiM9] patches=${patches.length} area=${(totalAreaKm2 / 1000).toFixed(0)}k km2 Mw=${mw.toFixed(3)} M0=${totalMoment.toExponential(4)}`);
  console.log(`[nankaiM9] maxSlip=${maxSlip} m, duration=${maxRT.toFixed(0)} s, nucleation=${nucPoint.lat.toFixed(3)},${nucPoint.lng.toFixed(3)} @ ${nucPoint.depthKm.toFixed(1)} km`);
  console.log(`[nankaiM9] area shares: super ${(slipShares.super / totalAreaKm2 / 1e4).toFixed(1)}%, large ${(slipShares.large / totalAreaKm2 / 1e4).toFixed(1)}%, background ${((slipShares.bg + slipShares.taper) / totalAreaKm2 / 1e4).toFixed(1)}%`);
  if (Math.abs(mw - TARGET_MW) > 0.01) throw new Error('Scenario moment misses Mw 9.0 target');

  return {
    schema: 'quake-sim-finite-fault-v1',
    id: 'nankai-trough-m9-scenario',
    event: {
      id: 'nankai-trough-m9-scenario',
      lat: round(nucPoint.lat, 3), lng: round(nucPoint.lng, 3), depthKm: round(nucPoint.depthKm, 1),
      sourceType: 'interplate', mw: TARGET_MW, momentNm: TARGET_M0
    },
    units: {depth: 'km', slip: 'm', time: 's', moment: 'Nm'},
    rigidityGPa: RIGIDITY_GPA,
    provenance: {
      source: 'QuakeSim synthetic scenario — Cabinet Office (2012) Nankai Trough Mw 9.0 strong-motion fault framework (Suruga Bay to Hyuga-nada, 大すべり域 20 m / 超大すべり域 40 m)',
      eventId: 'nankai-trough-m9-scenario',
      url: 'https://www.zisin.jp/publications/pdf/monograph6.pdf',
      license: 'CC0-1.0 (original synthesis)',
      retrievedAt: '2026-08-04T00:00:00Z'
    },
    patches,
    _stats: {mw, patchCount: patches.length, maxSlip, maxRT, totalKm}
  };
}

// ================================================================
//  3-7. USGS observed models — generic FSP conversion
// ================================================================
// Same numerics as buildTohoku (per-patch rigidity from the FSP's own
// layered velocity-density model, corners from the header Dx/Dz grid,
// moment cross-checked against the header Mo), but handles the standard
// single-segment USGS products too: no "% SEGMENT #" blocks, one subfault
// table after the column header, geometry from the header Mech plane.
function buildUsgsFsp(opts) {
  const MIN_RISE_S = 1;
  const text = fs.readFileSync(opts.fspPath, 'utf8');

  function headerNumber(patterns) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m && isFinite(Number(m[1]))) return Number(m[1]);
    }
    throw new Error('FSP header field missing: ' + patterns[0]);
  }
  const eventLat = headerNumber([/\bLoc\s*:\s*LAT\s*=\s*([\d.eE+-]+)/i]);
  const eventLng = headerNumber([/\bLON\s*=\s*([\d.eE+-]+)/i]);
  const eventDepth = headerNumber([/\bDEP\s*=\s*([\d.eE+-]+)/i]);
  const headerMw = headerNumber([/\bMw\s*=\s*([\d.eE+-]+)/i]);
  const headerMo = headerNumber([/\bMo\s*=\s*([\d.eE+-]+)\s*Nm/i]);
  const headerStrike = headerNumber([/\bMech\s*:\s*STRK\s*=\s*([\d.eE+-]+)/i]);
  const headerDip = headerNumber([/\bMech\s*:.*?DIP\s*=\s*([\d.eE+-]+)/i]);
  const DX_KM = headerNumber([/\bInvs\s*:\s*Dx\s*=\s*([\d.]+)\s*km/i]);
  const DZ_KM = headerNumber([/\bInvs\s*:.*?Dz\s*=\s*([\d.]+)\s*km/i]);

  const layers = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^%\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/);
    if (!m) continue;
    const topKm = Number(m[1]), vp = Number(m[2]), vs = Number(m[3]), dens = Number(m[4]);
    if (vp > 3 && vs > 0.5) layers.push({topKm, muGPa: dens * vs * vs});
  }
  if (!layers.length) throw new Error('FSP velocity model not found');
  function rigidityAt(depthKm) {
    let mu = layers[0].muGPa;
    for (const layer of layers) if (depthKm >= layer.topKm) mu = layer.muGPa;
    return mu;
  }

  let segmentBlocks = text.split(/(?=%\s*SEGMENT\s+#)/i).filter(block => /%\s*SEGMENT\s+#/i.test(block));
  if (!segmentBlocks.length) segmentBlocks = [text]; // single-segment product

  let droppedZeroSlip = 0;
  const patches = [];
  for (const block of segmentBlocks) {
    let strike = headerStrike, dip = headerDip;
    const segHead = block.match(/SEGMENT\s+#\s*(\d+)\s*:\s*STRIKE\s*=\s*([\d.]+)\s*deg\s*DIP\s*=\s*([\d.]+)\s*deg/i);
    if (segHead) { strike = Number(segHead[2]); dip = Number(segHead[3]); }
    const lines = block.split(/\r?\n/);
    let colHeader = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*%?\s*LAT\s+LON\s+/i.test(lines[i])) { colHeader = i; break; }
    }
    if (colHeader < 0) throw new Error('Segment column header missing');
    for (let i = colHeader + 1; i < lines.length; i++) {
      const clean = lines[i].trim();
      if (!clean || clean.startsWith('%')) continue;
      const v = clean.split(/\s+/).map(Number);
      if (v.length < 10 || v.some(x => !isFinite(x))) continue;
      const [lat, lng, , , z, slip, rake, trup, rise, sfMoment] = v;
      // Zero-slip padding subfaults carry no moment and violate the v1
      // contract (positive slip or moment per patch) — drop them.
      if (!(slip > 0)) { droppedZeroSlip++; continue; }
      const center = {lat, lng, depthKm: z};
      const corners = FiniteFault.cornersFromCenter(center, strike, dip, DX_KM, DZ_KM)
        .map(c => ({lat: round(c.lat, 5), lng: round(c.lng, 5), depthKm: round(c.depthKm, 3)}));
      patches.push({
        id: opts.idPrefix + String(patches.length + 1).padStart(3, '0'),
        corners,
        strikeDeg: round(strike, 1), dipDeg: round(dip, 1), rakeDeg: round(rake, 1),
        slipM: round(slip, 4), rigidityGPa: round(rigidityAt(z), 2),
        ruptureTimeS: round(trup, 1), riseTimeS: round(Math.max(rise, MIN_RISE_S), 1),
        _sfMoment: sfMoment
      });
    }
  }
  if (!patches.length) throw new Error('No subfault rows parsed');
  if (droppedZeroSlip) console.log(`[${opts.tag}] dropped ${droppedZeroSlip} zero-slip padding subfault(s)`);

  let totalMoment = 0, sfMomentSum = 0, maxSlip = 0, maxSlipPatch = null;
  for (const p of patches) {
    const areaM2 = FiniteFault.quadArea(p.corners) * 1e6;
    totalMoment += p.rigidityGPa * 1e9 * areaM2 * p.slipM;
    sfMomentSum += p._sfMoment;
    if (p.slipM > maxSlip) { maxSlip = p.slipM; maxSlipPatch = p; }
    delete p._sfMoment;
  }
  const mw = (Math.log10(totalMoment) - 9.1) / 1.5;
  const residualVsHeader = (totalMoment - headerMo) / headerMo;
  console.log(`[${opts.tag}] patches=${patches.length} Mw=${mw.toFixed(3)} M0=${totalMoment.toExponential(4)}`);
  console.log(`[${opts.tag}] header Mo=${headerMo.toExponential(4)} residual=${(residualVsHeader * 100).toFixed(2)}% SF_MOMENT check=${((totalMoment / sfMomentSum - 1) * 100).toFixed(2)}%`);
  console.log(`[${opts.tag}] peak slip=${maxSlip} m at ${maxSlipPatch.corners[0].lat},${maxSlipPatch.corners[0].lng} (${maxSlipPatch.id})`);
  if (Math.abs(residualVsHeader) > 0.05) throw new Error('Moment residual vs FSP header exceeds 5% — rigidity model wrong');

  return {
    schema: 'quake-sim-finite-fault-v1',
    id: opts.modelId,
    event: {
      id: opts.eventId, lat: eventLat, lng: eventLng, depthKm: eventDepth,
      sourceType: opts.sourceType, mw: headerMw, momentNm: headerMo
    },
    units: {depth: 'km', slip: 'm', time: 's', moment: 'Nm'},
    rigidityGPa: 40,
    provenance: {
      source: opts.provenanceSource,
      eventId: opts.eventId,
      url: opts.fspUrl,
      license: 'USGS public domain',
      retrievedAt: opts.retrievedAt || '2026-08-06T00:00:00Z'
    },
    patches,
    _stats: {mw, patchCount: patches.length, maxSlip}
  };
}

function buildKumamoto2016() {
  return buildUsgsFsp({
    fspPath: KUMAMOTO_FSP_PATH,
    tag: 'kumamoto2016',
    idPrefix: 'k',
    modelId: 'kumamoto-2016-usgs',
    eventId: 'us20005iis',
    sourceType: 'crustal',
    provenanceSource: 'USGS NEIC finite fault, Hayes 2018 (EventTAG 20005iisHAYES)',
    fspUrl: 'https://earthquake.usgs.gov/product/finite-fault/us20005iis/us/1539812954400/complete_inversion.fsp'
  });
}

function buildNoto2024() {
  return buildUsgsFsp({
    fspPath: NOTO_FSP_PATH,
    tag: 'noto2024',
    idPrefix: 'x',
    modelId: 'noto-2024-usgs',
    eventId: 'us6000m0xl',
    sourceType: 'crustal',
    provenanceSource: 'USGS NEIC finite fault, Goldberg 2024 (EventTAG 2024-01-01T07:10:09)',
    fspUrl: 'https://earthquake.usgs.gov/product/finite-fault/us6000m0xl_1/us/1704922177476/complete_inversion.fsp'
  });
}

function buildTokachi2003() {
  return buildUsgsFsp({
    fspPath: TOKACHI_FSP_PATH,
    tag: 'tokachi2003',
    idPrefix: 't',
    modelId: 'tokachi-2003-usgs',
    eventId: 'usp000c8kv',
    sourceType: 'interplate',
    provenanceSource: 'USGS NEIC finite fault, Hayes (NEIC, 2014) (EventTAG p000c8kvHAYES)',
    fspUrl: 'https://earthquake.usgs.gov/product/finite-fault/usp000c8kv/us/1539805562044/complete_inversion.fsp',
    retrievedAt: '2026-08-12T00:00:00Z'
  });
}

function buildFukushima2022() {
  return buildUsgsFsp({
    fspPath: FUKUSHIMA_FSP_PATH,
    tag: 'fukushima2022',
    idPrefix: 'f',
    modelId: 'fukushima-2022-usgs',
    eventId: 'us6000h519',
    sourceType: 'intraslab',
    provenanceSource: 'USGS NEIC finite fault, Goldberg 2022 (EventTAG 2022-03-16T14:36:33)',
    fspUrl: 'https://earthquake.usgs.gov/product/finite-fault/us6000h519_1/us/1647458780456/complete_inversion.fsp',
    retrievedAt: '2026-08-12T00:00:00Z'
  });
}

function buildHyuganada2024() {
  return buildUsgsFsp({
    fspPath: HYUGANADA_FSP_PATH,
    tag: 'hyuganada2024',
    idPrefix: 'h',
    modelId: 'hyuganada-2024-usgs',
    eventId: 'us6000nith',
    sourceType: 'interplate',
    provenanceSource: 'USGS NEIC finite fault, Goldberg 2024 (EventTAG 2024-08-08T07:42:55)',
    fspUrl: 'https://earthquake.usgs.gov/product/finite-fault/us6000nith_1/us/1723749629539/complete_inversion.fsp',
    retrievedAt: '2026-08-12T00:00:00Z'
  });
}

// ================================================================
//  Emit
// ================================================================
const tohoku = buildTohoku();
const nankai = buildNankai();
const kumamoto2016 = buildKumamoto2016();
const noto2024 = buildNoto2024();
const tokachi2003 = buildTokachi2003();
const fukushima2022 = buildFukushima2022();
const hyuganada2024 = buildHyuganada2024();
const stats = {
  tohoku: tohoku._stats, nankaiM9: nankai._stats,
  kumamoto2016: kumamoto2016._stats, noto2024: noto2024._stats,
  tokachi2003: tokachi2003._stats, fukushima2022: fukushima2022._stats,
  hyuganada2024: hyuganada2024._stats
};
delete tohoku._stats;
delete nankai._stats;
delete kumamoto2016._stats;
delete noto2024._stats;
delete tokachi2003._stats;
delete fukushima2022._stats;
delete hyuganada2024._stats;

const banner = `// Finite-fault models bundled with the simulator. DO NOT EDIT BY HAND.
// Generated by tools/build-fault-models.js.
//   tohoku   — USGS Hayes 2017 observed model (tools/data/tohoku2011_hayes2017.fsp),
//              3 segments, strike 198, dips 15/8/21 deg, ${stats.tohoku.patchCount} patches,
//              Mw ${stats.tohoku.mw.toFixed(2)}, peak slip ${stats.tohoku.maxSlip} m.
//   nankaiM9 — synthetic Nankai Trough Mw 9.0 scenario (Cabinet Office 2012 framework),
//              ${stats.nankaiM9.totalKm.toFixed(0)} km Suruga Bay to Hyuga-nada, 4 segments,
//              ${stats.nankaiM9.patchCount} patches, Mw ${stats.nankaiM9.mw.toFixed(2)},
//              peak slip ${stats.nankaiM9.maxSlip} m, rupture ${stats.nankaiM9.maxRT.toFixed(0)} s.
//   kumamoto2016 — USGS observed model, 2016-04-15 Mw 7.0 Kumamoto
//              (tools/data/kumamoto2016_usgs.fsp), single segment, strike 224,
//              dip 66, ${stats.kumamoto2016.patchCount} patches, Mw ${stats.kumamoto2016.mw.toFixed(2)},
//              peak slip ${stats.kumamoto2016.maxSlip} m.
//   noto2024 — USGS observed model, 2024-01-01 Mw 7.5 Noto Peninsula
//              (tools/data/noto2024_usgs.fsp), single segment, strike 51, dip 35,
//              ${stats.noto2024.patchCount} patches, Mw ${stats.noto2024.mw.toFixed(2)},
//              peak slip ${stats.noto2024.maxSlip} m.
//   tokachi2003 — USGS observed model, 2003-09-25 Mw 8.2 Tokachi-Oki
//              (tools/data/tokachi2003_usgs.fsp), single segment, strike 240,
//              dip 17, ${stats.tokachi2003.patchCount} patches, Mw ${stats.tokachi2003.mw.toFixed(2)},
//              peak slip ${stats.tokachi2003.maxSlip} m.
//   fukushima2022 — USGS observed model, 2022-03-16 Mw 7.2 Fukushima-Oki
//              (tools/data/fukushima2022_usgs.fsp), single segment, strike 184,
//              dip 40, ${stats.fukushima2022.patchCount} patches, Mw ${stats.fukushima2022.mw.toFixed(2)},
//              peak slip ${stats.fukushima2022.maxSlip} m.
//   hyuganada2024 — USGS observed model, 2024-08-08 Mw 7.1 Hyuganada Sea
//              (tools/data/hyuganada2024_usgs.fsp), single segment, strike 203,
//              dip 19, ${stats.hyuganada2024.patchCount} patches, Mw ${stats.hyuganada2024.mw.toFixed(2)},
//              peak slip ${stats.hyuganada2024.maxSlip} m.
// Map keys match PRESETS keys in app.js.
`;
const body = `(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ObservedFaultModels = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';
  var MODELS = {
    tohoku: ${JSON.stringify(tohoku)},
    nankaiM9: ${JSON.stringify(nankai)},
    kumamoto2016: ${JSON.stringify(kumamoto2016)},
    noto2024: ${JSON.stringify(noto2024)},
    tokachi2003: ${JSON.stringify(tokachi2003)},
    fukushima2022: ${JSON.stringify(fukushima2022)},
    hyuganada2024: ${JSON.stringify(hyuganada2024)}
  };
  return {
    get: function(id) { return MODELS[id] || null; },
    list: function() { return Object.keys(MODELS); }
  };
});
`;
fs.writeFileSync(OUT_PATH, banner + body);
console.log('wrote ' + OUT_PATH + ' (' + Math.round((banner + body).length / 1024) + ' KB)');
