// ================================================================
//  R-B Japan-Trench M9 stationary-package measurement — contract locks
//  The frozen report is DECISION SUPPORT (no adoption). These locks keep
//  the frozen numbers reproducible: re-running the preregistered tool must
//  land on the same values, and the production package must stay untouched
//  (the hypothetical source exists only inside the tool).
//  Run with:  node --test tests/jtrench-m9.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'jtrench-m9-report.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, six decompose sites', () => {
  assert.equal(report.schema, 'quake-sim-jtrench-m9-report-v1');
  assert.match(report.preregistration, /scorecard-jtrench-m9\.js/);
  assert.deepEqual(Object.keys(report.sites).sort(),
    ['fukuoka', 'kochi', 'nagoya', 'osaka', 'sendai', 'tokyo']);
  assert.match(report.note, /user framework decision/);
});

test('M1: RP475 shifts are negligible everywhere and confined to sendai', () => {
  for (const [sid, res] of Object.entries(report.sites)) {
    const b = res.pga.base.rp475;
    for (const tag of ['A-1/600', 'A-1/1200', 'B-1/600', 'B-1/1200']) {
      const rel = res.pga[tag].rp475 / b;
      if (sid === 'sendai') {
        assert.ok(rel > 1.0 && rel < 1.01, sid + ' ' + tag + ' shift ' + rel);
      } else {
        assert.ok(Math.abs(rel - 1) < 0.001, sid + ' ' + tag + ' must not move (' + rel + ')');
      }
    }
  }
});

test('M2: sendai PPE ratio — GR arm near-neutral, patch arm materially worse', () => {
  const p = report.sites.sendai.ppe;
  assert.ok(Math.abs(p.ratioBase - 1.457) < 0.002, 'frozen base ratio (decompose H2 lineage) ' + p.ratioBase);
  assert.ok(p['ratioA-1/600'] - p.ratioBase < 0.03, 'GR-cells arm stays near-neutral');
  assert.ok(p['ratioB-1/600'] - p.ratioBase > 0.15, 'characteristic-patch arm worsens sendai PPE by >0.15');
  // every other site: patch arm immaterial (distance)
  for (const sid of ['osaka', 'kochi', 'fukuoka']) {
    assert.ok(Math.abs(report.sites[sid].ppe['ratioB-1/600'] - report.sites[sid].ppe.ratioBase) < 0.001,
      sid + ' must not move');
  }
});

test('production package untouched: shipped model carries no hypothetical source', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
  assert.ok(!m.gridMfdSources, 'no gridMfdSources in the shipped Japan model');
  assert.ok(!m.scenarios.some((s) => /jtrench/i.test(s.id)), 'no Japan-Trench scenario in the shipped model');
  // and the tool is deterministic: a re-run reproduces the frozen sendai RP475 ratio
  const out = execFileSync(process.execPath,
    [path.join(ROOT, 'tools', 'scorecard-jtrench-m9.js')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rerun = JSON.parse(out);
  assert.ok(Math.abs(rerun.sites.sendai.ppe.ratioBase - report.sites.sendai.ppe.ratioBase) < 1e-12);
  assert.ok(Math.abs(rerun.sites.sendai.pga['B-1/600'].rp475 - report.sites.sendai.pga['B-1/600'].rp475) < 1e-9);
});
