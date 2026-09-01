'use strict';
// =====================================================================
// v6.1 P1 — build the PSHA source model from the frozen ComCat catalog.
//
// Pipeline (every stage's parameters are frozen into the report):
//   1. Tectonic classification per event (trench distance + depth):
//      interplate = within 150 km of a subduction line (plates.json) and
//      depth <= 60 km; crustal = depth < 32 km (others); intraslab = rest.
//      Classes align with the GMPE logic tree (crustal/interplate/intraslab).
//   2. Declustering with PROJECT-DEFINED magnitude-scaled windows (NOT a
//      published algorithm — documented limitation, sensitivity untested):
//        T(M) days = min(720, 60*10^(0.5*(M-5))),  R(M) km = min(150, 20+25*(M-5))
//      An event is an aftershock of any STRICTLY EARLIER event with mag >= its
//      own inside that event's window. No chain extension.
//   3. Completeness scan on the DECLUSTERED catalog: candidates (Mc, start)
//      scored by decade-rate CV; selection rule pre-registered below.
//   4. Regional b per class (Aki 1965 MLE) on in-window declustered events;
//      per-cell a-value from adaptive top-hat smoothing (radii 25/50/100 km,
//      smallest radius with >= 10 events), rate renormalised per cell area.
//   5. Scenario sources (rates from published Earthquake Research Committee
//      30-year probabilities, converted as lambda = -ln(1-P30)/30):
//        nankaiM9    P30 = 0.75 (midpoint of the published 70-80% range)
//        tokyoInland P30 = 0.70 (published 70% for capital-region M7)
//   6. GR truncated at class Mmax (7.2 crustal / 7.8 interface & slab),
//      NOT renormalised; the Japan-trench M9 tail is not carried by any
//      scenario in v1 (documented hazard underestimate along Sanriku).
//
// Outputs:
//   public/geojson/psha-source-model.json  (schema quake-sim-psha-source-v1)
//   tools/data/psha-source-model-report.json
//
// Usage: node tools/build-psha-source-model.js
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'tools/data/psha/comcat-japan.json');
const PLATES = path.join(ROOT, 'public/geojson/plates.json');
const OUT_MODEL = path.join(ROOT, 'public/geojson/psha-source-model.json');
const OUT_REPORT = path.join(ROOT, 'tools/data/psha-source-model-report.json');

// --- frozen parameters -------------------------------------------------
const GRID_DEG = 0.25;
const BBOX = { minLat: 24, maxLat: 46, minLng: 125, maxLng: 150 };
const INTERPLATE_TRENCH_DIST_KM = 150;
const INTERPLATE_MAX_DEPTH_KM = 60;
const CRUSTAL_MAX_DEPTH_KM = 32;
const SMOOTH_RADII_KM = [25, 50, 100];
const SMOOTH_MIN_EVENTS = 10;
const MMIN = 5.0;
const MMAX_BY_CLASS = { crustal: 7.2, interplate: 7.8, intraslab: 7.8 };
// Pre-registered completeness rule (frozen 2026-09-01, before applying):
//   among candidates with decade-rate CV <= 0.25 pick the largest in-window
//   declustered count; if none passes, pick the smallest CV among candidates
//   with count >= 500.
const COMPLETENESS_CV_MAX = 0.25;
const COMPLETENESS_FALLBACK_MIN_COUNT = 500;
const DEG_KM = 111.195; // matches Physics haversine R=6371

function haversineKm(lat1, lng1, lat2, lng2) {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Point to trench-polyline distance (km), flat-spherical segment approx.
function trenchDistanceKm(lat, lng, plateFeatures) {
  const toR = Math.PI / 180;
  let best = Infinity;
  for (const f of plateFeatures) {
    const line = f.geometry.coordinates;
    for (let i = 0; i < line.length - 1; i++) {
      const [lngA, latA] = line[i], [lngB, latB] = line[i + 1];
      const x1 = lngA * toR, y1 = latA * toR, x2 = lngB * toR, y2 = latB * toR;
      const x0 = lng * toR, y0 = lat * toR;
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((x0 - x1) * dx + (y0 - y1) * dy) / (dx * dx + dy * dy || 1e-12)));
      const gx = x1 + t * dx - x0, gy = y1 + t * dy - y0;
      best = Math.min(best, 6371 * Math.sqrt(gx * gx + gy * gy));
    }
  }
  return best;
}

function classifyEvent(e, trenchDistKm) {
  if (trenchDistKm < INTERPLATE_TRENCH_DIST_KM && e.depthKm <= INTERPLATE_MAX_DEPTH_KM) return 'interplate';
  if (e.depthKm < CRUSTAL_MAX_DEPTH_KM) return 'crustal';
  return 'intraslab';
}

function declusterWindowDays(mag) { return Math.min(720, 60 * Math.pow(10, 0.5 * (mag - 5))); }
function declusterRadiusKm(mag) { return Math.min(150, 20 + 25 * (mag - 5)); }

function decluster(events) {
  const sorted = events.slice().sort((a, b) => a.tsMs - b.tsMs);
  const isAftershock = new Array(sorted.length).fill(false);
  for (let i = 1; i < sorted.length; i++) {
    const e = sorted[i];
    for (let j = i - 1; j >= 0; j--) {
      const m = sorted[j];
      if (m.mag <= e.mag) continue;            // only a STRICTLY larger earlier mainshock claims aftershocks (magnitude-tie convention: both stay)
      const dtDays = (e.tsMs - m.tsMs) / 86400000;
      if (dtDays > declusterWindowDays(m.mag)) break; // chronological order => no earlier hit possible
      if (isAftershock[j]) continue;               // windows extend only from mainshocks (no chaining)
      if (haversineKm(e.lat, e.lng, m.lat, m.lng) <= declusterRadiusKm(m.mag)) { isAftershock[i] = true; break; }
    }
  }
  return { mainshocks: sorted.filter((_, i) => !isAftershock[i]), nAftershocks: isAftershock.filter(Boolean).length };
}

function decadeRateCV(events, minMag, startYear) {
  const counts = {};
  for (const e of events) {
    if (e.mag < minMag) continue;
    const y = +e.time.slice(0, 4);
    if (y < startYear) continue;
    const d = Math.floor(y / 10) * 10;
    counts[d] = (counts[d] || 0) + 1;
  }
  const endYear = 2026;
  const rates = Object.keys(counts).map(Number)
    .filter(d => d >= Math.ceil(startYear / 10) * 10 && d + 9 <= endYear) // complete decades only
    .map(d => counts[d] / 10);
  if (rates.length < 2) return { cv: Infinity, rates: [] };
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const cv = Math.sqrt(rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length) / mean;
  return { cv, rates: rates.map(r => +r.toFixed(2)) };
}

function selectCompleteness(mainshocks) {
  const candidates = [];
  for (const mc of [5.0, 5.5, 6.0]) {
    for (const start of [1923, 1940, 1960, 1980, 1990, 2000]) {
      const n = mainshocks.filter(e => e.mag >= mc && +e.time.slice(0, 4) >= start).length;
      const { cv, rates } = decadeRateCV(mainshocks, mc, start);
      candidates.push({ mc, start, count: n, cv, decadeRates: rates, passes: cv <= COMPLETENESS_CV_MAX });
    }
  }
  const passing = candidates.filter(c => c.passes);
  let chosen;
  if (passing.length) chosen = passing.reduce((a, b) => (b.count > a.count ? b : a));
  else {
    const eligible = candidates.filter(c => c.count >= COMPLETENESS_FALLBACK_MIN_COUNT);
    chosen = (eligible.length ? eligible : candidates).reduce((a, b) => (b.cv < a.cv ? b : a));
  }
  return { candidates, chosen, rule: `pre-registered: max in-window count among CV<=${COMPLETENESS_CV_MAX}; else min CV among count>=${COMPLETENESS_FALLBACK_MIN_COUNT}` };
}

function akiB(mags, mc) {
  const ms = mags.filter(m => m >= mc);
  if (ms.length < 10) return null;
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const d = mean - mc;
  if (d <= 0.05) return null;
  return Math.log10(Math.E) / d; // Aki (1965) MLE
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const plates = JSON.parse(fs.readFileSync(PLATES, 'utf8'));
  const events = catalog.events;
  const generatedAt = new Date().toISOString();

  // 1. classify
  for (const e of events) e.srcType = classifyEvent(e, trenchDistanceKm(e.lat, e.lng, plates.features));
  const classCounts = {};
  for (const e of events) classCounts[e.srcType] = (classCounts[e.srcType] || 0) + 1;

  // 2. decluster
  const dec = decluster(events);
  const mains = dec.mainshocks;

  // 3. completeness
  const comp = selectCompleteness(mains);
  const { mc, start } = comp.chosen;
  const inWindow = mains.filter(e => e.mag >= mc && +e.time.slice(0, 4) >= start);
  const endYear = +events[events.length - 1].time.slice(0, 4) + (+events[events.length - 1].time.slice(5, 7) - 1) / 12;
  const Tyears = endYear - start;

  // 4. per-class b + cells
  const bValues = {}, classStats = {};
  for (const cls of ['crustal', 'interplate', 'intraslab']) {
    const clsEvents = inWindow.filter(e => e.srcType === cls);
    bValues[cls] = akiB(clsEvents.map(e => e.mag), mc);
    classStats[cls] = { nWindow: clsEvents.length, b: bValues[cls] };
  }
  const bGlobal = akiB(inWindow.map(e => e.mag), mc);
  for (const cls of Object.keys(bValues)) if (bValues[cls] == null) bValues[cls] = bGlobal; // thin-class fallback

  const cells = [];
  const cellAreaKm2 = lat => (GRID_DEG * DEG_KM * Math.cos(lat * Math.PI / 180)) * (GRID_DEG * DEG_KM);
  const maxR = SMOOTH_RADII_KM[SMOOTH_RADII_KM.length - 1];
  const classWindowEvents = {};
  for (const cls of ['crustal', 'interplate', 'intraslab']) classWindowEvents[cls] = inWindow.filter(e => e.srcType === cls);
  for (let latC = BBOX.minLat + GRID_DEG / 2; latC < BBOX.maxLat; latC += GRID_DEG) {
    for (let lngC = BBOX.minLng + GRID_DEG / 2; lngC < BBOX.maxLng; lngC += GRID_DEG) {
      // bbox prefilter window for the largest smoothing radius (~0.95 deg lat, widened for lng)
      const latPad = maxR / DEG_KM + GRID_DEG;
      const lngPad = latPad / Math.max(0.25, Math.cos(latC * Math.PI / 180));
      for (const cls of ['crustal', 'interplate', 'intraslab']) {
        const near = [];
        for (const e of classWindowEvents[cls]) {
          if (Math.abs(e.lat - latC) > latPad || Math.abs(e.lng - lngC) > lngPad) continue;
          const d = haversineKm(latC, lngC, e.lat, e.lng);
          if (d <= maxR) near.push({ d, depth: e.depthKm });
        }
        if (near.length === 0) continue;
        near.sort((a, b) => a.d - b.d);
        let radius = maxR, nUse = near.length;
        for (const r of SMOOTH_RADII_KM) {
          const n = near.findIndex(x => x.d > r);
          const cnt = n === -1 ? near.length : n;
          if (cnt >= SMOOTH_MIN_EVENTS) { radius = r; nUse = cnt; break; }
        }
        if (nUse === 0) continue;
        const rateMc = nUse / (Math.PI * radius * radius * Tyears) * cellAreaKm2(latC);
        if (rateMc < 1e-6) continue;
        let depth = 0;
        for (let i = 0; i < nUse; i++) depth += near[i].depth;
        depth /= nUse;
        cells.push({ lat: +latC.toFixed(4), lng: +lngC.toFixed(4), srcType: cls, rateMc: +rateMc.toPrecision(4), depthKm: +Math.min(depth, 250).toFixed(1) });
      }
    }
  }

  // 5. scenario sources
  const faultModels = require('../public/observed-fault-models.js');
  const nankai = faultModels.get('nankaiM9');
  const nankaiPatches = nankai.patches.map(p => {
    const cs = p.corners;
    const lat = cs.reduce((a, c) => a + c.lat, 0) / cs.length;
    const lng = cs.reduce((a, c) => a + c.lng, 0) / cs.length;
    const depthKm = cs.reduce((a, c) => a + c.depthKm, 0) / cs.length;
    return [+lat.toFixed(3), +lng.toFixed(3), +depthKm.toFixed(1)];
  });
  const scenarios = [
    {
      id: 'nankaiM9', mw: 9.0, ratePerYear: +(-Math.log(1 - 0.75) / 30).toPrecision(4),
      sourceType: 'interplate', depthKm: nankai.event.depthKm,
      patches: nankaiPatches,
      provenance: {
        geometry: 'bundled observed-fault-models nankaiM9 (Cabinet Office 2012 framework, 217 patches)',
        rate: 'Earthquake Research Committee long-term evaluation: 70-80% probability of M8-9 within 30 years; lambda=-ln(1-0.75)/30',
        sourceUrl: 'https://www.jishin.go.jp/main/choukihyoka/nankai/',
        accessed: 'figure is public record; page reachable via proxy only from this network (2026-09-01)'
      }
    },
    {
      id: 'tokyoInland', mw: 7.3, ratePerYear: +(-Math.log(1 - 0.70) / 30).toPrecision(4),
      sourceType: 'crustal', depthKm: 17,
      strikeDeg: 135, dipDeg: 60, rakeDeg: 120,
      provenance: {
        geometry: 'app.js PRESETS.tokyoInland (hypothetical capital-inland M7.3 class)',
        rate: 'Earthquake Research Committee (2017-04-21) capital-region assessment: 70% probability of M7 within 30 years; lambda=-ln(1-0.70)/30',
        sourceUrl: 'https://www.jishin.go.jp/main/choukihyoka/shuto_chokka/',
        accessed: 'figure is public record; page reachable via proxy only from this network (2026-09-01)'
      }
    }
  ];

  // rate conservation diagnostics + per-class mass renormalisation.
  // Multi-scale adaptive top-hat smoothing is NOT mass-conserving (a dense
  // cluster is counted at its own 25 km scale and again, smeared, in the
  // 100 km periphery) — measured excess 1.03/1.31/1.20 pre-correction. We
  // rescale each class so the modelled Mc-rate equals the declustered
  // catalog rate exactly (shape preserved, total auditable), and freeze the
  // pre-correction ratios in the report.
  const conservation = {};
  for (const cls of ['crustal', 'interplate', 'intraslab']) {
    const n = inWindow.filter(e => e.srcType === cls).length;
    const catalogRate = n / Tyears;
    const modelRate = cells.filter(c => c.srcType === cls).reduce((a, c) => a + c.rateMc, 0);
    const factor = catalogRate / modelRate;
    for (const c of cells) if (c.srcType === cls) c.rateMc = +(c.rateMc * factor).toPrecision(4);
    const modelRateAfter = cells.filter(c => c.srcType === cls).reduce((a, c) => a + c.rateMc, 0);
    conservation[cls] = {
      catalogRate: +catalogRate.toPrecision(4), modelRate: +modelRate.toPrecision(4),
      ratioBefore: +(modelRate / catalogRate).toPrecision(3),
      normalisationFactor: +factor.toPrecision(4),
      ratioAfter: +(modelRateAfter / catalogRate).toPrecision(4)
    };
  }

  // B2 pre-registration (frozen before any broadband run — see ROADMAP v6.1)
  const preRegisteredB2 = {
    batch: 'B2 broadband scorecard acceptance (frozen 2026-09-01, before any B2 implementation run)',
    metrics: {
      psaLog10BiasAbsMax: { '0.5-2s': 0.25, '2-10s': 0.25, '0.1-0.5s': 0.30 },
      pgaLog10BiasAbsMax: 0.30, pgvLog10BiasAbsMax: 0.30, jmaIntensityBiasAbsMax: 0.5,
      longPeriodImprovementVsBrune: 'hybrid 2-10s log10 PSA |bias| beats the Brune-carrier baseline by >=0.05, or both <=0.10',
      pgaNonRegressionVsBrune: 'hybrid PGA log10 |bias| may not exceed the Brune baseline by more than 0.05'
    },
    scope: 'per-event median station bias over the 13 frozen Kyoshin packages; failures reported honestly, no post-hoc tuning'
  };

  const model = {
    schema: 'quake-sim-psha-source-v1',
    generatedAt,
    mMin: MMIN, mc, windowStartYear: start, windowYears: +Tyears.toPrecision(5),
    bValues: Object.assign({}, bValues, { method: 'Aki (1965) MLE on declustered in-window mainshocks', global: bGlobal }),
    mMaxByClass: MMAX_BY_CLASS,
    grid: { deg: GRID_DEG, bbox: BBOX, smoothing: { radiiKm: SMOOTH_RADII_KM, minEvents: SMOOTH_MIN_EVENTS, kernel: 'adaptive top-hat', massRenormalisation: 'per-class global rescale so sum(rateMc) equals the declustered in-window catalog rate exactly (pre-correction ratios in the report)' } },
    classification: { interplate: `trenchDist<${INTERPLATE_TRENCH_DIST_KM}km & depth<=${INTERPLATE_MAX_DEPTH_KM}km`, crustal: `depth<${CRUSTAL_MAX_DEPTH_KM}km`, intraslab: 'rest', trenchGeometry: 'public/geojson/plates.json (6 subduction lines)' },
    decluster: { method: 'project-defined magnitude-scaled windows (NOT a published algorithm)', windowDays: 'min(720, 60*10^(0.5*(M-5)))', radiusKm: 'min(150, 20+25*(M-5))', chaining: false },
    provenance: {
      catalog: 'tools/data/psha/comcat-japan.json (USGS ComCat, public domain)',
      limitations: [
        'simplified self-computed model — NOT the official J-SHIS/ERC source model (comparison pending data acquisition)',
        'gridded GR truncated at class Mmax without renormalisation; Japan-trench M9-class recurrence not carried by any scenario in v1 (Sanriku long-RP hazard underestimated)',
        'class-level rake simplification (interplate reverse 90, others neutral); gridded Rrup via equal-area circular patch at hypocentre depth',
        'GMPE modelBias deliberately NOT applied (LOEO evidence: it does not generalise held-out)',
        'adaptive top-hat smoothing assumes seismogenic area fills the circle near coasts/bbox edges (edge effects uncorrected)'
      ]
    },
    cells, scenarios
  };
  fs.writeFileSync(OUT_MODEL, JSON.stringify(model));

  const report = {
    schema: 'quake-sim-psha-source-model-report-v1',
    generatedAt,
    catalogCount: events.length,
    classCounts,
    declusteredMainshocks: mains.length, aftershocksRemoved: dec.nAftershocks,
    completeness: { rule: comp.rule, chosen: comp.chosen, candidates: comp.candidates },
    bValues, classStats,
    cells: { total: cells.length, byClass: cells.reduce((a, c) => { a[c.srcType] = (a[c.srcType] || 0) + 1; return a; }, {}) },
    rateConservation: conservation,
    scenarios: scenarios.map(s => ({ id: s.id, mw: s.mw, ratePerYear: s.ratePerYear })),
    preRegisteredB2
  };
  fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2));

  console.log(`model: ${cells.length} cells (${Object.values(report.cells.byClass).join('/')})`);
  console.log(`decluster: ${mains.length} mainshocks / ${dec.nAftershocks} aftershocks removed`);
  console.log(`completeness: Mc=${mc} start=${start} CV=${comp.chosen.cv.toFixed(3)} count=${comp.chosen.count}`);
  console.log('b values:', JSON.stringify(bValues));
  console.log('conservation:', JSON.stringify(conservation));
}

if (require.main === module) main();
module.exports = { classifyEvent, decluster, decadeRateCV, haversineKm };
