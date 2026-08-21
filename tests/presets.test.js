// ================================================================
//  Unit tests for the japanSinks (日本沈没) chain preset in app.js
//  Run with:  node --test tests/presets.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

function loadPreset(name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const m = src.match(new RegExp('(?:^|[,\\s])' + name + '\\s*:\\s*\\{'));
  assert.ok(m, `preset ${name} not found in app.js`);
  const open = src.indexOf('{', m.index);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > open, `preset ${name} literal is not balanced`);
  // Strip trailing // comments so the literal evaluates cleanly.
  const literal = src.slice(open, end).replace(/\/\/[^\n]*/g, '');
  return new Function('return (' + literal + ')')();
}

const EXPECTED_MAGS = [9.1, 7.3, 5.3, 6.6, 6.1, 6.7, 6.7, 7.3, 7.4, 6.5, 7.6, 6.6, 7.1, 7.5, 6.9, 5.6, 7.1, 9.0, 8.4];

test('japanSinks — 19 chained sub-events (17-event historical catalog + 2 hypothetical megathrusts)', () => {
  const p = loadPreset('japanSinks');
  assert.ok(Array.isArray(p.subEvents));
  assert.strictEqual(p.subEvents.length, 19);
  assert.deepStrictEqual(p.subEvents.map(se => se.mag), EXPECTED_MAGS);
  assert.strictEqual(p.subEvents[0].mag, 9.1, 'chain must open with the 2011 Tohoku-Oki earthquake');
  assert.strictEqual(p.subEvents[17].mag, 9.0, 'hypothetical Nankai Trough M9.0 follows the catalog');
  assert.strictEqual(p.subEvents[18].mag, 8.4, 'hypothetical Hokkaido-east-offshore M8.4 closes the chain');
});

test('japanSinks — random compressed intervals are frozen and in range', () => {
  const p = loadPreset('japanSinks');
  assert.strictEqual(p.subEvents[0].time, 0);
  for (let i = 1; i < p.subEvents.length; i++) {
    const gap = p.subEvents[i].time - p.subEvents[i - 1].time;
    assert.ok(gap >= 25 && gap <= 75, `interval ${i} = ${gap}s outside 25-75s`);
  }
  const span = p.subEvents[p.subEvents.length - 1].time;
  assert.ok(span <= 20 * 60, 'chain spans more than 20 sim-minutes');
});

test('japanSinks — preset magnitude preserves per-event moment (rescale ~1)', () => {
  const p = loadPreset('japanSinks');
  const sum = p.subEvents.reduce((acc, se) => acc + Physics.seismicMoment(se.mag), 0);
  const combined = Physics.momentMagnitude(sum);
  assert.ok(Math.abs(combined - p.mag) < 0.01,
    `combined Mw ${combined.toFixed(3)} drifts from preset mag ${p.mag}`);
});

test('japanSinks — every event carries explicit geometry and mechanism', () => {
  const p = loadPreset('japanSinks');
  const seen = new Set();
  for (const [i, se] of p.subEvents.entries()) {
    for (const key of ['lat', 'lng', 'mag', 'depth', 'strike', 'dip', 'rake', 'time']) {
      assert.ok(Number.isFinite(se[key]), `event ${i} missing numeric ${key}`);
    }
    assert.strictEqual(se.mechanismKnown, true, `event ${i} mechanism not explicit`);
    assert.ok(se.lat > 20 && se.lat < 50 && se.lng > 125 && se.lng < 150, `event ${i} outside Japan region`);
    assert.ok(se.depth > 0 && se.depth <= 100, `event ${i} depth out of range`);
    const key = `${se.lat},${se.lng},${se.time}`;
    assert.ok(!seen.has(key), `duplicate event at ${key}`);
    seen.add(key);
  }
});

test('japanSinks — registered in the preset dropdown', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('<option value="japanSinks">'), 'japanSinks option missing from index.html');
});

test('japanSinks — megathrust events wire bundled fault models (near-field Shindo 7 fidelity)', () => {
  const p = loadPreset('japanSinks');
  assert.strictEqual(p.subEvents[0].faultModel, 'tohoku',
    '2011 Tohoku-Oki sub-event must use the Hayes 2017 observed slip model');
  assert.strictEqual(p.subEvents[1].faultModel, 'kumamoto2016',
    '2016 Kumamoto sub-event must use the USGS Hayes 2018 observed slip model');
  assert.strictEqual(p.subEvents[10].faultModel, 'noto2024',
    '2024 Noto Hanto sub-event must use the USGS Goldberg 2024 observed slip model');
  assert.strictEqual(p.subEvents[17].faultModel, 'nankaiM9',
    'hypothetical Nankai Trough sub-event must use the bundled 4-segment scenario model');
});

test('single-event presets wire their observed fault models', () => {
  assert.strictEqual(loadPreset('tohoku').faultModel, 'tohoku');
  assert.strictEqual(loadPreset('kumamoto').faultModel, 'kumamoto2016');
  assert.strictEqual(loadPreset('noto2024').faultModel, 'noto2024');
  assert.strictEqual(loadPreset('nankaiM9').faultModel, 'nankaiM9');
});
