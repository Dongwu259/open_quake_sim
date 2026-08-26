#!/usr/bin/env node
'use strict';
// ================================================================
//  v5.6 R1-5: transcribe the Jayaram et al. (2011) appendix period-pair
//  epsilon-correlation tables (Tables 3/4/5: active shallow crustal /
//  subduction interface / subduction slab) from the locally archived PDF
//  text extraction into a frozen, validated JSON the runtime can consume
//  (public/geojson/jayaram2011-rho.json).
//
//  The PDF text layer emits each 16x16 matrix in a jumbled order that
//  differs per table, so the parser carries two layout recipes and picks
//  whichever HARD-VALIDATES (finite, |rho|<=1, diagonal 1.00, symmetry
//  within table rounding after mirroring):
//    A (Tables 3/5, row blocks): full-width rows 0.08/0.05, the T2
//      row-label column, row 0.10, the 8-column header 0.15..1.50 with 16
//      rows x 8 values, then full-width rows 2.00..5.00
//    B (Table 4, column-major): T1=0.05 header + (row-label, value) x 16,
//      then (T1 header, 16 bare values) for T1 = 0.08..5.00
//
//  Local-only input: .cache/papers/jayaram2011.txt (paper archived under
//  .cache/papers — never committed). Output = published-paper
//  coefficients (citation carries the provenance).
// ================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '.cache/papers/jayaram2011.txt');
const OUT = path.join(ROOT, 'public/geojson/jayaram2011-rho.json');

const PERIODS = [0.05, 0.08, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.75, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00];

function sectionTokens(txt, tableNo) {
  const startRe = new RegExp('Table ' + tableNo + ':');
  const start = txt.search(startRe);
  if (start < 0) throw new Error('Table ' + tableNo + ' caption not found');
  const rest = txt.slice(start);
  let end = rest.length;
  const nextTable = rest.slice(1).search(/Table \d+:/);
  if (nextTable >= 0) end = Math.min(end, nextTable + 1);
  const sec8 = rest.slice(1).search(/\n8\.\s/);
  if (sec8 >= 0) end = Math.min(end, sec8 + 1);
  return rest.slice(0, end).match(/-?\d+\.\d+/g).map(Number);
}

function recipeA(t, M, expect, readRow) {
  readRow(0.08); readRow(0.05);
  for (const p of PERIODS) expect(p, 'T2 row-label column');
  readRow(0.10);
  for (let k = 3; k < 11; k++) expect(PERIODS[k], 'col header ' + PERIODS[k]);
  for (let r = 0; r < 16; r++) for (let k = 3; k < 11; k++) M[r][k] = t.next();
  readRow(2.00); readRow(2.50); readRow(3.00); readRow(4.00); readRow(5.00);
}

function recipeB(t, M, expect) {
  expect(0.05, 'T1 first header');
  for (let r = 0; r < 16; r++) {
    expect(PERIODS[r], 'interleaved row label');
    M[r][0] = t.next();
  }
  for (let k = 1; k < 16; k++) {
    expect(PERIODS[k], 'T1 header ' + PERIODS[k]);
    for (let r = 0; r < 16; r++) M[r][k] = t.next();
  }
}

// Table 4's mixed layout: two leading columns (T1=0.05 interleaved with row
// labels, T1=0.08 bare), a 12-row label column, a 12x14 column-major block
// (rows T2=0.10..3.00 x cols T1=0.05..3.00 — the first two columns duplicate
// the leading ones), two 12-value row subsets (T2=4.00/5.00 over cols
// 0.10..3.00, discarded), then the two full-width rows T2=4.00/5.00.
function recipeC(t, M, expect) {
  expect(0.05, 'T1 first header');
  for (let r = 0; r < 16; r++) {
    expect(PERIODS[r], 'interleaved row label');
    M[r][0] = t.next();
  }
  expect(0.08, 'T1 second header');
  for (let r = 0; r < 16; r++) M[r][1] = t.next();
  const blockRows = PERIODS.slice(2, 14); // 0.10..3.00
  const blockCols = [PERIODS[0], PERIODS[1]].concat(blockRows); // 0.05, 0.08, 0.10..3.00
  for (const p of blockRows) expect(p, 'block row label');
  for (const c of blockCols) {
    const k = PERIODS.indexOf(c);
    for (let r = 2; r < 14; r++) M[r][k] = t.next();
  }
  for (let dup = 0; dup < 2; dup++) for (let k = 0; k < 12; k++) t.next(); // duplicate row subsets
  for (const label of [4.00, 5.00]) {
    expect(label, 'trailing row label ' + label);
    const r = PERIODS.indexOf(label);
    for (let j = 0; j < 16; j++) M[r][j] = t.next();
  }
}

// Table 5's layout: full-width rows 0.08/0.05/0.10, the 16-row T2 label
// column, an 8-column sub-table header (0.15..1.50), a NINTH header 2.00
// (the overflowing last column label), then a 16-row x 9-value block
// (every T2 row over columns 0.15..2.00 — rows that already appeared full
// width DUPLICATE their values, which this recipe asserts must agree), then
// the four full-width trailing rows 2.50..5.00. The remaining triangle is
// mirrored exactly like the other tables.
function recipeD(t, M, expect, readRow) {
  readRow(0.08); readRow(0.05);
  const labels = [];
  for (const p of PERIODS) { expect(p, 'T2 row-label column'); labels.push(p); }
  readRow(0.10);
  for (let k = 3; k < 11; k++) expect(PERIODS[k], 'col header ' + PERIODS[k]);
  expect(2.00, 'ninth column header 2.00');
  const dup = [];
  for (const p of labels) {
    const r = PERIODS.indexOf(p);
    for (let k = 3; k < 12; k++) {
      const v = t.next();
      if (isFinite(M[r][k])) dup.push([p, PERIODS[k], M[r][k], v]);
      M[r][k] = v;
    }
  }
  for (const [p, c, was, now] of dup) {
    if (Math.abs(was - now) > 1e-9) throw new Error(
      'Table 5 duplicate disagreement at T2=' + p + ' T1=' + c + ': ' + was + ' vs ' + now);
  }
  readRow(2.50); readRow(3.00); readRow(4.00); readRow(5.00);
}

function parseTable(txt, tableNo) {
  const raw = sectionTokens(txt, tableNo);
  const recipes = { A: recipeA, B: recipeB, C: recipeC, D: recipeD };
  let lastErr = null;
  for (const [name, fn] of Object.entries(recipes)) {
    const t = { arr: raw.slice(), i: 0, next() { return this.arr[this.i++]; } };
    const M = PERIODS.map(() => PERIODS.map(() => NaN));
    const expect = (v, what) => {
      const got = t.next();
      if (got == null || Math.abs(got - v) > 1e-9) throw new Error(
        'Table ' + tableNo + ' recipe ' + name + ' drift at ' + what + ': expected ' + v + ', got ' + got);
    };
    const readRow = label => {
      expect(label, 'row label ' + label);
      const r = PERIODS.indexOf(label);
      for (let j = 0; j < 16; j++) M[r][j] = t.next();
    };
    try {
      fn(t, M, expect, readRow);
      // mirror both ways (each table leaves one triangle implicit)
      for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
        if (!isFinite(M[i][j]) && isFinite(M[j][i])) M[i][j] = M[j][i];
      }
      // validation
      let maxAsym = 0, bad = null;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
        const v = M[i][j];
        if (!isFinite(v)) bad = 'incomplete at ' + i + ',' + j;
        else if (Math.abs(v) > 1.0001) bad = '|rho|>1 at ' + i + ',' + j;
        else if (i === j && Math.abs(v - 1) > 1e-9) bad = 'diagonal != 1 at ' + i;
        if (!bad && isFinite(M[j][i])) maxAsym = Math.max(maxAsym, Math.abs(v - M[j][i]));
      }
      if (bad) throw new Error('Table ' + tableNo + ' recipe ' + name + ': ' + bad);
      if (maxAsym > 0.02) throw new Error('Table ' + tableNo + ' recipe ' + name + ': asymmetry ' + maxAsym);
      if (t.i !== raw.length) throw new Error('Table ' + tableNo + ' recipe ' + name + ': ' +
        (raw.length - t.i) + ' unconsumed tokens');
      for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
        const s = (M[i][j] + M[j][i]) / 2; M[i][j] = s; M[j][i] = s;
      }
      return { recipe: name, rho: M.map(r => r.map(v => +v.toFixed(3))), maxAsymmetry: +maxAsym.toFixed(4) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function main() {
  const txt = fs.readFileSync(SRC, 'utf8');
  // Table 5 (slab) decoded 2026-08-25 (v5.7 tail): recipe D reconstructs the
  // 16x9 block with the overflowing ninth column header and cross-checks the
  // duplicate copies of the full-width rows before mirroring the rest.
  const classes = { crustal: 3, interface: 4, slab: 5 };
  const out = {};
  for (const [cls, no] of Object.entries(classes)) out[cls] = { table: no, ...parseTable(txt, no) };
  const doc = {
    schema: 'quake-sim-jayaram2011-rho-v1',
    meta: {
      source: 'Jayaram, N., Baker, J. W., Okano, H., Ishida, H., McCann, M. W., Jr., and Mihara, Y. (2011). ' +
        '"Correlation of response spectral values in Japanese ground motions." Earthquakes and Structures, 2(4), 357-376 — ' +
        'appendix Tables 3 (active shallow crustal), 4 (subduction interface) and 5 (subduction slab).',
      archive: '.cache/papers/Jayaram_et_al_(2011)_Japan_Correlations,_E&S.pdf (local-only)',
      generatedBy: 'tools/parse-jayaram2011-tables.js',
      note: 'epsilon(T1)-epsilon(T2) correlation from K-NET/KiK-net Japanese ground motions; values symmetrized to kill table rounding.',
      validation: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, 'recipe ' + v.recipe + ', max asymmetry ' + v.maxAsymmetry]))
    },
    periods: PERIODS,
    classes: out
  };
  fs.writeFileSync(OUT, JSON.stringify(doc));
  for (const [k, v] of Object.entries(out)) {
    console.log(k.padEnd(10), 'table', v.table, '| recipe', v.recipe, '| maxAsym', v.maxAsymmetry,
      '| rho(0.05,5.0)', v.rho[0][15], '| rho(1.0,2.0)', v.rho[9][11]);
  }
  console.log('->', OUT);
}

if (require.main === module) main();
module.exports = { parseTable, sectionTokens, PERIODS };
