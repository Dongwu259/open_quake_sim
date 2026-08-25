'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parsePsLog } = require('../tools/fetch-kiknet-logs.js');
const Physics = require('../public/physics.js');

// Tolerant parser scaffold: the exact portal file layout gets locked in with
// a real sample on approval day; these tests pin the classification rules.
const SAMPLE_WHITESPACE = `観測点 IWTH27 位置 39.27 141.06
PS検層結果 (m, m/s, m/s)
0.0 1650 90
2.0 1650 110
4.5 1800 150
7.0 1800 210
10.0 2200 340
13.0 2200 420
16.0 2600 620
20.0 3100 900
`;

test('parsePsLog: whitespace PS-log table with depth/Vp/Vs classification', () => {
  const p = parsePsLog(SAMPLE_WHITESPACE, 'IWTH27.txt');
  assert.ok(p, 'parses');
  assert.equal(p.rows.length, 8);
  assert.deepEqual(p.rows[0], { from: 0, to: 2, vp: 1650, vs: 90 });
  assert.deepEqual(p.rows[7], { from: 20, to: 22, vp: 3100, vs: 900 });
  // depth column picked (not a velocity), Vp > Vs everywhere
  for (const r of p.rows) assert.ok(r.vp > r.vs);
});

const SAMPLE_COMMA_INTERVAL = `IWTH27,岩手県,,,,
#  深度(m),深度(m),Vp(m/s),Vs(m/s)
0.0,2.0,1650,90
2.0,4.5,1650,110
4.5,7.0,1800,150
`;

test('parsePsLog: comma interval form survives as from-depth rows', () => {
  const p = parsePsLog(SAMPLE_COMMA_INTERVAL, 'x.csv');
  assert.ok(p, 'parses');
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[1].from, 2.0);
  assert.ok(p.rows[1].vs === 110 && p.rows[1].vp === 1650);
});

test('parsePsLog: junk-only text returns null', () => {
  assert.equal(parsePsLog('no numbers here\njust words\n', 'a.txt'), null);
  assert.equal(parsePsLog('1 2\n3 4\n', 'b.txt'), null); // too few rows
});

test('parsed PS log feeds the SH transfer function end-to-end', () => {
  const p = parsePsLog(SAMPLE_WHITESPACE, 'IWTH27.txt');
  // profile for the propagator: layer per interval + engineering bedrock at the bottom
  const profile = p.rows.map(r => ({ vs: r.vs, thickness: r.to - r.from, density: Physics.densityFromVs(r.vs) }));
  profile.push({ vs: 2200, density: 2.5 }); // halfspace below the logged column
  const f = []; for (let i = 1; i <= 300; i++) f.push(+(i * 0.02).toFixed(3));
  const A = Physics.shTransferFunction(profile, f);
  assert.ok(A && A.length === f.length);
  // a 90-900 m/s soft column over 2.2 km/s rock must amplify somewhere
  assert.ok(Math.max(...A) > 2, 'site amplification expected, max ' + Math.max(...A).toFixed(2));
  assert.ok(A[0] > 0.9 && A[0] < 1.1, 'low-f normalization, got ' + A[0].toFixed(3));
});

// ---- strict soil_image format (raw samples relayed 2026-08-25) -------------

test('parsePsLog: strict 5-column format with halfspace row (ABSH01 raw sample)', () => {
  const raw = [
    ' No Thickness   Depth    Vp       Vs',
    '        (m)       (m)    (m/s)    (m/s)',
    ' 1,    2.00,    2.00,  480.00,  180.00',
    ' 2,    8.00,   10.00, 2320.00,  700.00',
    ' 3,    8.00,   18.00, 2980.00, 1150.00',
    ' 4,   52.00,   70.00, 2980.00, 1720.00',
    ' 5, -------, -------, 3120.00, 1870.00'
  ].join('\n');
  const p = parsePsLog(raw, 'ABSH01_soil_image.txt');
  assert.ok(p, 'strict parse failed');
  assert.equal(p.rows.length, 4);
  assert.deepEqual(p.rows[0], { from: 0, to: 2, vp: 480, vs: 180 });
  assert.deepEqual(p.rows[3], { from: 18, to: 70, vp: 2980, vs: 1720 });
  assert.deepEqual(p.halfspace, { vp: 3120, vs: 1870 });
  // vs30 sanity: the travel-time average over 30 m must be physical (~822)
  let tt = 0, H = 0;
  for (const r of p.rows) { const h = Math.min(r.to, 30) - Math.min(r.from, 30); if (h > 0) { tt += h / r.vs; H += h; } }
  const vs30 = H / tt;
  assert.ok(vs30 > 700 && vs30 < 950, 'ABSH01 vs30 ' + vs30);
});

test('parsePsLog: km/s-labelled-m/s files are normalized (NGNH07 raw sample)', () => {
  const raw = [
    ' No Thickness   Depth    Vp       Vs',
    '        (m)       (m)    (m/s)    (m/s)',
    ' 1,    2.00,    2.00,    1.54,    0.16',
    ' 2,   50.00,   52.00,    2.56,    0.75',
    ' 3,   94.00,  146.00,    5.31,    1.87',
    ' 4, -------, -------,    2.94,    1.63'
  ].join('\n');
  const p = parsePsLog(raw, 'NGNH07_soil_image.txt');
  assert.ok(p, 'strict parse failed');
  assert.equal(p.rows[2].vp, 5310);
  assert.equal(p.rows[2].vs, 1870);
  assert.deepEqual(p.halfspace, { vp: 2940, vs: 1630 });
});

test('parsePsLog: the No-column misread is impossible in strict mode', () => {
  // the 2026-08-25 failure: the tolerant heuristic picked the layer counter
  // as "depth" — the strict path must produce depths matching the Depth
  // column, never 1..N sequence numbers
  const raw = [
    ' 1,    2.00,    2.00,  480.00,  180.00',
    ' 2,    8.00,   10.00, 2320.00,  700.00',
    ' 3, -------, -------, 3120.00, 1870.00'
  ].join('\n');
  const p = parsePsLog(raw, 'x.txt');
  assert.ok(p);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].to, 10); // Depth column, not the "2" layer number
  assert.ok(p.rows.every(r => r.vs > 100)); // velocities, not N-values
});
