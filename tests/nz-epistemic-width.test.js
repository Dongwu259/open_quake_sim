// ================================================================
//  R8-2e NZ epistemic-width validation — tripwire locks
//  MEASUREMENT ONLY. Preregistered verdicts: H1 PASS (our tree
//  understates the official spread at all six sites), H2 FALSIFIED
//  as measured (our Wellington mean sits BELOW the official epistemic
//  band), H3 PASS. Engine ensemble limitation registered, not fixed.
//  Run with:  node --test tests/nz-epistemic-width.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nz-epistemic-width-report.json'), 'utf8'));
const quant = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nshmnz', 'nshm-v104-quantiles.json'), 'utf8'));

test('frozen report: schema, preregistration pointer, provenance', () => {
  assert.equal(report.schema, 'quake-sim-nz-epistemic-width-v1');
  assert.match(report.preregistration, /scorecard-nz-epistemic-width\.js/);
  assert.equal(report.official.hazardModel, 'NSHM_v1.0.4');
  assert.deepEqual(report.official.aggregates, ['mean', '0.1', '0.9']);
  assert.match(report.note, /MEASUREMENT ONLY/);
  assert.match(report.engineNote, /indices < 3/);
  assert.equal(quant.curves.length, 36);
  assert.match(quant.note, /epistemic fractile/);
});

test('preregistered verdicts frozen: H1/H3 pass, H2 falsified as measured', () => {
  assert.equal(report.hypotheses.H1_understated_spread_wlg_pga_rp475, true);
  assert.equal(report.hypotheses.H2_central_containment_wlg_pga_rp475, false, 'H2 frozen falsified');
  assert.equal(report.hypotheses.H3_broadband_sa10, true);
});

test('headline widths byte-frozen: our spread 5-40x narrower than official', () => {
  // our collapse spread (log10 max/min) vs official fractile width at RP475 PGA
  const w = (s) => report.widths[s + '|pga|rp475'];
  for (const s of ['WLG', 'AKL', 'CHC', 'NSN', 'ZQN', 'IVC']) {
    assert.ok(w(s).ours < w(s).off, s + ' width ours ' + w(s).ours + ' vs off ' + w(s).off);
  }
  // 2026-11-19 convention re-freeze: 0.079 -> 0.093566 / 0.083 -> 0.0874199
  assert.ok(Math.abs(w('AKL').ours - 0.093566) < 0.001, 'AKL ours width ' + w('AKL').ours);
  assert.ok(Math.abs(w('CHC').ours - 0.0874199) < 0.001, 'CHC ours width ' + w('CHC').ours);
  assert.ok(Math.abs(w('WLG').off - 0.394) < 0.001, 'WLG official width ' + w('WLG').off);
  // WLG degenerate (subduction-dominated, single-branch ngasub): width 0
  // 2026-11-19: 0.000656829 (was <0.0005 dead-flat) — a sliver of the NZ
  // crustal-tree spread now reaches WLG under the finite-rupture convention
  assert.ok(Math.abs(w('WLG').ours) < 0.001, 'WLG ours width near-degenerate');
  // the containment headline: our mean below the official P10 at WLG
  const o = report.sites.WLG.official.pga.rp475, u = report.sites.WLG.ours.pga.rp475;
  assert.ok(Math.abs(o.imP10 - 492.9) < 0.1, 'WLG P10 ' + o.imP10);
  assert.ok(Math.abs(o.imP90 - 1219.8) < 0.1, 'WLG P90 ' + o.imP90);
  assert.ok(u.ourMeanIm < o.imP10, 'our WLG mean below official P10 (containment falsified)');
  // CHC overestimate echo (R8-2b) — 2026-11-19 convention re-measure:
  // the pre-convention "every branch above the official mean" echo is GONE
  // (branches 344.7/349.6/374.8/438.5/438.7 vs official mean 351.2 — 2/5 now
  // sit below); the CHC overestimate headline rides the MEAN curve
  // (ratio 1.61997, pinned in the CHC attribution test), not every branch
  const chc = report.sites.CHC.branchImsGal.rp475;
  assert.ok(Math.abs(Math.min.apply(null, chc) - 344.689) < 0.1, 'CHC min branch ' + Math.min.apply(null, chc));
  assert.ok(Math.abs(Math.max.apply(null, chc) - 438.669) < 0.1, 'CHC max branch ' + Math.max.apply(null, chc));
});

test('determinism: re-running reproduces the frozen widths and branch IMs', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'scorecard-nz-epistemic-width.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rerun = JSON.parse(out);
  for (const s of ['WLG', 'AKL', 'CHC', 'NSN', 'ZQN', 'IVC']) {
    assert.ok(Math.abs(rerun.widths[s + '|pga|rp475'].ours - report.widths[s + '|pga|rp475'].ours) < 1e-9, s);
    assert.ok(Math.abs(rerun.sites[s].ours.pga.rp475.ourMeanIm - report.sites[s].ours.pga.rp475.ourMeanIm) < 1e-9, s + ' mean');
  }
});
