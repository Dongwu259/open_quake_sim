#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.7 tail 3: f0 consistency re-evaluation with JIVSM deep columns.
//
//  The R2-4 negative result: model-vs-empirical f0 (S/B spectral-ratio
//  peaks) agreed within a half octave for only ~45% of KiK-net stations —
//  the R2 model profile below the borehole was psLogToProfile's uniform
//  halfspace (last log Vs x1.15, min 1500), and the half-space stiffness
//  scan plateaued at 45-50% ("no knob reaches 60%; the residual lives in
//  the structure BELOW the log"). This re-eval splices the actual JIVSM
//  V4 column (public/geojson/jivsm-columns.json) below each borehole and
//  recomputes the agreement — the R3 follow-up that investigation called
//  for.
//
//  Inputs: public/geojson/sb-spectral-ratio.json (frozen empirical f0 per
//  station), .cache/kiknet-logs/kiknet-ps-logs.json (PS profiles,
//  local-only raw derivative source). Report printed + frozen into
//  tools/data/f0-jivsm-reeval.json.
//
//  Usage: node tools/reeval-f0-jivsm.js [--freeze]
// ================================================================
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const SB = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/sb-spectral-ratio.json'), 'utf8'));
const PS = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache/kiknet-logs/kiknet-ps-logs.json'), 'utf8'));
const COLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/jivsm-columns.json'), 'utf8'));
Physics.setJivsmColumns(COLS);

const psStations = Array.isArray(PS) ? PS : (PS.stations || []);
const profileByCode = new Map();
for (const st of psStations) {
  const rows = st.rows || st.layers || st.log;
  if (rows && rows.length && rows[0].vs != null) profileByCode.set(st.code || st.id, rows);
}
console.log('PS profiles:', profileByCode.size, '| S/B stations:', SB.stations.length);

// frequency grid of the frozen S/B analysis
const freqs = [];
for (let i = 0; i < 80; i++) freqs.push(0.3 * Math.pow(15 / 0.3, i / 79));

function modelF0(profile) {
  const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: 0.05 });
  if (!res || !res.amp) return null;
  let f0 = null, pk = 0;
  for (let j = 0; j < freqs.length; j++) {
    if (freqs[j] >= 0.3 && freqs[j] <= 10 && res.amp[j] > pk) { pk = res.amp[j]; f0 = freqs[j]; }
  }
  return f0;
}

// splice the JIVSM column below the log bottom; the deepest JIVSM layer
// extends as the halfspace
function spliceProfile(rows) {
  const base = [];
  let bottom = 0;
  for (const r of rows) {
    if (!(Number(r.vs) > 0)) continue;
    const h = Number(r.to) - Number(r.from);
    if (!(h > 0)) continue;
    base.push({ vs: Number(r.vs), thickness: h });
    bottom = Math.max(bottom, Number(r.to));
  }
  if (!base.length) return null;
  return { base, bottom };
}

const med = arr => { const v = arr.slice().sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
const pairsOld = [], pairsNew = [];
let nBoth = 0, nNoColumn = 0, nNoLog = 0, spliceDepth = [];

for (const s of SB.stations) {
  const rows = profileByCode.get(s.code);
  if (!rows) { nNoLog++; continue; }
  const sp = spliceProfile(rows);
  if (!sp) { nNoLog++; continue; }
  // baseline (R2): uniform halfspace below the log
  const lastVs = (() => { for (let i = rows.length - 1; i >= 0; i--) if (Number(rows[i].vs) > 0) return Number(rows[i].vs); return 0; })();
  const oldProf = sp.base.concat([{ vs: Math.max(lastVs * 1.15, 1500) }]);
  const f0Old = modelF0(oldProf);
  // JIVSM splice
  const col = Physics.jivsmColumnAt(s.lat, s.lng);
  if (!col) { nNoColumn++; if (f0Old != null) pairsOld.push({ e: s.f0Hz, m: f0Old }); continue; }
  const colBottomM = col[col.length - 1].bottomM;
  const newProf = sp.base.slice();
  let top = sp.bottom;
  let spliced = 0;
  for (const l of col) {
    if (l.bottomM <= top) continue;
    const segTop = Math.max(l.topM, top);
    const h = (l.bottomM - segTop) / 1000;
    if (h <= 0) continue;
    newProf.push({ vs: l.vs, thickness: h });
    spliced += h;
    top = l.bottomM;
  }
  // deepest JIVSM material extends as the halfspace
  const halfVs = col[col.length - 1].vs;
  newProf.push({ vs: halfVs });
  spliceDepth.push(spliced);
  const f0New = modelF0(newProf);
  nBoth++;
  if (f0Old != null) pairsOld.push({ e: s.f0Hz, m: f0Old });
  if (f0New != null) pairsNew.push({ e: s.f0Hz, m: f0New });
}

function agree(pairs) {
  const half = Math.log(2) / 2;
  const within = pairs.filter(p => Math.abs(Math.log(p.e / p.m)) <= half).length;
  return { n: pairs.length, withinHalfOctavePct: +(100 * within / pairs.length).toFixed(1),
    medianLogDiff: +med(pairs.map(p => Math.abs(Math.log(p.e / p.m)))).toFixed(3) };
}
const aOld = agree(pairsOld), aNew = agree(pairsNew);
console.log('stations with log+column:', nBoth, '| no column:', nNoColumn, '| no log:', nNoLog);
console.log('median JIVSM splice thickness:', med(spliceDepth).toFixed(0) + ' m');
console.log('f0 agreement  R2 halfspace :', JSON.stringify(aOld));
console.log('f0 agreement  JIVSM splice :', JSON.stringify(aNew));
console.log('verdict:', aNew.withinHalfOctavePct > aOld.withinHalfOctavePct
  ? 'JIVSM splice IMPROVES f0 agreement (+' + (aNew.withinHalfOctavePct - aOld.withinHalfOctavePct).toFixed(1) + 'pp)'
  : 'JIVSM splice does NOT improve f0 agreement (' + (aNew.withinHalfOctavePct - aOld.withinHalfOctavePct).toFixed(1) + 'pp)');

if (process.argv.includes('--freeze')) {
  fs.writeFileSync(path.join(ROOT, 'tools/data/f0-jivsm-reeval.json'), JSON.stringify({
    schema: 'quake-sim-f0-jivsm-reeval-v1',
    verdict: aNew.withinHalfOctavePct > aOld.withinHalfOctavePct ? 'improved' : 'not-improved',
    r2Halfspace: aOld, jivsmSplice: aNew,
    medianSpliceThicknessM: +med(spliceDepth).toFixed(0),
    method: 'psLogToProfile baseline vs the same PS log spliced onto the JIVSM V4 column (deepest JIVSM layer as halfspace); empirical f0 = frozen S/B spectral-ratio peaks (sb-spectral-ratio.json); siteResponse1D rock PGA 0.05 g over the 0.3-15 Hz grid'
  }, null, 1));
  console.log('frozen -> tools/data/f0-jivsm-reeval.json');
}
