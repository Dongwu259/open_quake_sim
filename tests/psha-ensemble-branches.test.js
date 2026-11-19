// ================================================================
//  psha-ensemble-branches.test.js — ensemble set-width fix (2026-11-16).
//  The v6.1 engine hard-coded THREE ensemble sets (physics.js nBranchSets=3)
//  and silently dropped branch ranks 3+ — the v7.x regional crustal trees
//  carry five leaves (BSSA14/CY14/CB14-HighQ/CB14-LowQ/ASK14), and the SA
//  degenerate-repeat unconditionally overwrote real regional branch sets
//  down to set 0. Locked here:
//    - Japan three-branch trees stay BYTE-IDENTICAL to their captured
//      snapshot (fixture re-captured 2026-11-19 under the finite-rupture
//      distance convention, tests/psha-point-rupture.test.js — the original
//      capture pinned the pre-convention output, which that disclosed
//      engine change intentionally moved);
//    - set width derives from the widest class tree, floor 3;
//    - ranks beyond a class's own tree carry that class's mean;
//    - regional SA-capable trees keep real branch sets (no repeat overwrite).
//  Run with:  node --test tests/psha-ensemble-branches.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Physics = require('../public/physics.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'psha-ensemble-fixture.json'), 'utf8'));
const JP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'psha-source-model.json'), 'utf8'));
const NZ = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geojson', 'psha-source-model-newzealand.json'), 'utf8'));
const TOKYO = { lat: 35.68, lng: 139.76 }; // vs30 default 600, fixture agreement

test('Japan three-branch trees byte-identical to the pre-fix engine (frozen fixture)', () => {
  const pga = Physics.hazardCurve(JP, TOKYO, 'pga', {});
  assert.equal(pga.ensemble.length, 3);
  assert.equal(pga.diagnostics.singleModel, false);
  assert.equal(pga.diagnostics.branchSetCount, 3);
  const pairs = [['pgaMean', pga.meanRate], ['pgaS0', pga.ensemble[0]], ['pgaS1', pga.ensemble[1]], ['pgaS2', pga.ensemble[2]]];
  for (const [key, arr] of pairs) {
    assert.equal(JSON.stringify(arr), JSON.stringify(FIXTURE[key]),
      key + ' drifted from the pre-fix (verified identical) engine');
  }
});

test('Japan SA zhao collapse keeps the degenerate repeat (floor-3 sets)', () => {
  const sa = Physics.hazardCurve(JP, TOKYO, 'sa:1.00', {});
  assert.equal(sa.ensemble.length, 3);
  assert.equal(sa.diagnostics.singleModel, true, 'zhao collapse is still single-model');
  assert.equal(JSON.stringify(sa.meanRate), JSON.stringify(FIXTURE.saMean));
  assert.equal(JSON.stringify(sa.ensemble[0]), JSON.stringify(FIXTURE.saS0));
  // degenerate: sets 1..2 repeat set 0 exactly
  assert.equal(JSON.stringify(sa.ensemble[1]), JSON.stringify(sa.ensemble[0]));
  assert.equal(JSON.stringify(sa.ensemble[2]), JSON.stringify(sa.ensemble[0]));
});

// ---- synthetic 5+1 branch decomposition --------------------------------
function miniModel(withCrustal, withInterplate) {
  const cells = [];
  // crustal cell ~149 km out: CB14 HighQ/LowQ are Dc20 attenuation overlays
  // that only separate beyond ~76 km Rrup (the equal-area proxy subtracts the
  // equivalent radius) — a near-field cell would make the pair bit-identical
  // and the five-member assertion vacuous
  if (withCrustal) cells.push({ lat: -42.64, lng: 174.9, srcType: 'crustal', rateMc: 0.02, depthKm: 10 });
  if (withInterplate) cells.push({ lat: -41.3, lng: 175.1, srcType: 'interplate', rateMc: 0.01, depthKm: 25 });
  return {
    schema: 'quake-sim-psha-source-v1', mc: 5.0, mMin: 5.0,
    bValues: { crustal: 0.9, interplate: 1.0 },
    mMaxByClass: { crustal: 7.0, interplate: 8.5 },
    cells,
    scenarios: [],
    gmpeTree: {
      crustal: [
        { model: 'bssa14', weight: 0.25 },
        { model: 'cy14', weight: 0.25 },
        { model: 'cb14', weight: 0.125, variant: 'HighQ' },
        { model: 'cb14', weight: 0.125, variant: 'LowQ' },
        { model: 'ask14', weight: 0.25 }
      ],
      interplate: [{ model: 'ngasub', weight: 1 }]
    }
  };
}
const WLG = { lat: -41.29, lng: 174.78 };

test('set width = widest class tree; ranks beyond a class tree carry its mean', () => {
  const full = Physics.hazardCurve(miniModel(true, true), WLG, 'pga', {});
  const crustalOnly = Physics.hazardCurve(miniModel(true, false), WLG, 'pga', {});
  const interOnly = Physics.hazardCurve(miniModel(false, true), WLG, 'pga', {});
  assert.equal(full.ensemble.length, 5, 'crustal tree width 5 drives 5 sets');
  assert.equal(crustalOnly.ensemble.length, 5);
  assert.equal(full.diagnostics.branchSetCount, 5);
  // single-branch interplate pack: floor-3 sets, sets 1..2 repeat set 0
  assert.equal(interOnly.ensemble.length, 3);
  assert.equal(JSON.stringify(interOnly.ensemble[1]), JSON.stringify(interOnly.ensemble[0]));
  assert.equal(JSON.stringify(interOnly.ensemble[2]), JSON.stringify(interOnly.ensemble[0]));
  // decomposition: full set k = crustal rank k + interplate (1 branch = mean)
  for (let k = 0; k < 5; k++) {
    for (let i = 0; i < full.imLevels.length; i++) {
      const expected = crustalOnly.ensemble[k][i] + interOnly.ensemble[0][i];
      const diff = Math.abs(full.ensemble[k][i] - expected);
      assert.ok(diff <= 1e-15 + 1e-9 * Math.abs(expected),
        'set ' + k + ' level ' + i + ': ' + full.ensemble[k][i] + ' vs ' + expected);
    }
  }
  // the five sets actually differ (real branch spread, not the old drop-to-zero)
  const uniq = new Set(full.ensemble.map((c) => JSON.stringify(c)));
  assert.equal(uniq.size, 5, 'five distinct epistemic members');
});

test('regional packs: NZ five real sets, SA branch sets NOT overwritten by the repeat', () => {
  const pga = Physics.hazardCurve(NZ, WLG, 'pga', {});
  assert.equal(pga.ensemble.length, 5);
  assert.equal(pga.diagnostics.branchSetCount, 5);
  assert.equal(pga.diagnostics.branchSets[0].length, 5, 'crustal tree exposes five models');
  const nzSa = Physics.hazardCurve(NZ, WLG, 'sa:1.00', {});
  assert.equal(nzSa.ensemble.length, 5, 'SA-capable regional tree keeps its width');
  assert.equal(nzSa.diagnostics.singleModel, false, 'capable tree is not single-model');
  // pre-fix, the unconditional isSa repeat overwrote sets 1..2 with set 0
  const uniqSa = new Set(nzSa.ensemble.map((c) => JSON.stringify(c)));
  assert.ok(uniqSa.size >= 4, 'SA sets keep real branch spread, got ' + uniqSa.size);
  // every set subscribes the single-branch subduction mean (nonzero where mean is)
  const firstIdx = pga.meanRate.findIndex((r) => r > 0);
  assert.ok(firstIdx >= 0);
  for (const set of pga.ensemble) assert.ok(set[firstIdx] > 0, 'carry-mean keeps subduction in every set');
});
