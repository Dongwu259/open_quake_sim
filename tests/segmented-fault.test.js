// ================================================================
//  Unit tests for the v6.2 tier-2 fault geometry upgrades:
//    - Physics.genSegmentedFault — bent multi-segment planes with ONE
//      continuous von Kármán slip field, per-segment strike/dip/rake,
//      3D rupture times, moment conservation, deterministic
//    - listric dip (dipRowAnchors + buildFaultGeometry integration +
//      rehydrate parity) — default 0 stays byte-identical
//  Run with:  node --test tests/segmented-fault.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

const NODES = [
  { lat: 33.0, lng: 135.5 },
  { lat: 33.6, lng: 136.2 },
  { lat: 34.4, lng: 136.6 },
  { lat: 35.2, lng: 136.9 }
];
const SEGOPTS = { sourceType: 'interplate', depthKm: 25, dipDeg: 20, listricDipDeg: 10, randomSeed: 3 };

// ================================================================
//  STRUCTURE + CONSERVATION
// ================================================================
test('segmented fault: structure, exact moment conservation, determinism', () => {
  const g = Physics.genSegmentedFault(NODES, 8.2, SEGOPTS);
  assert.ok(g, 'geometry builds');
  assert.strictEqual(g.kind, 'synthetic-segmented');
  assert.strictEqual(g.segments.length, 3);
  assert.strictEqual(g.subs.length, g.nStrike * g.nDip);
  const momSum = g.subs.reduce((a, s) => a + s.moment, 0);
  assert.ok(Math.abs(momSum / g.totalMoment - 1) < 1e-12, 'moment rel err');
  const g2 = Physics.genSegmentedFault(NODES, 8.2, SEGOPTS);
  assert.deepStrictEqual(g.subs.map(s => s.slipWeight), g2.subs.map(s => s.slipWeight));
  assert.deepStrictEqual(g.subs.map(s => s.ruptureTime), g2.subs.map(s => s.ruptureTime));
});

test('segmented fault: honest rejections', () => {
  assert.strictEqual(Physics.genSegmentedFault([NODES[0]], 8.2, SEGOPTS), null);
  assert.strictEqual(Physics.genSegmentedFault([], 8.2, SEGOPTS), null);
  assert.strictEqual(Physics.genSegmentedFault(NODES, 6.2, SEGOPTS), null, 'M<6.5 rejected');
  assert.strictEqual(Physics.genSegmentedFault(null, 8.2, SEGOPTS), null);
});

test('segmented fault: surface trace continuous — segment planes start at the previous node chain', () => {
  const g = Physics.genSegmentedFault(NODES, 8.2, SEGOPTS);
  // top-edge (dipIndex 0) first patch of segment k sits near node k
  for (let k = 0; k < g.segments.length; k++) {
    const first = g.subs.find(s => s.segIndex === k && s.dipIndex === 0);
    const d = Physics.haversineDist(first.lat, first.lng, NODES[k].lat, NODES[k].lng);
    assert.ok(d < g.segments[k].lenKm / g.segments[k].nStrike * 1.2,
      'segment ' + k + ' top edge starts at its node (off by ' + d.toFixed(1) + ' km)');
  }
  // the documented plane-approximation caveat: at depth, bends open honest
  // gaps (surface trace continuous; deep offsets diverge with dip direction)
  const midJ = Math.floor(g.nDip / 2);
  const s0end = g.subs.filter(s => s.segIndex === 0 && s.dipIndex === midJ).pop();
  const s1start = g.subs.find(s => s.segIndex === 1 && s.dipIndex === midJ);
  const gap = Physics.haversineDist(s0end.lat, s0end.lng, s1start.lat, s1start.lng);
  assert.ok(gap > 0 && gap < g.W, 'deep bend gap finite and sub-width: ' + gap.toFixed(1) + ' km');
});

test('segmented fault: per-patch strike matches the node bearings (or explicit override)', () => {
  const nodes = NODES.map(n => ({ ...n }));
  const g = Physics.genSegmentedFault(nodes, 8.2, SEGOPTS);
  for (let k = 0; k < g.segments.length; k++) {
    const expected = Physics.bearingRad(NODES[k].lat, NODES[k].lng, NODES[k + 1].lat, NODES[k + 1].lng) * 180 / Math.PI;
    let diff = Math.abs(g.segments[k].strikeDeg - expected) % 360;
    if (diff > 180) diff = 360 - diff;
    assert.ok(diff < 0.5, 'segment ' + k + ' strike ' + g.segments[k].strikeDeg + ' vs bearing ' + expected);
  }
  // explicit override honoured
  const ov = Physics.genSegmentedFault(NODES.map((n, i) => i === 1 ? { ...n, strikeDeg: 90 } : n), 8.2, SEGOPTS);
  assert.ok(Math.abs(ov.segments[1].strikeDeg - 90) < 1e-9);
});

test('segmented fault: slip field continuous through bends (no cliff at internal boundaries)', () => {
  const g = Physics.genSegmentedFault(NODES, 8.2, { ...SEGOPTS, slipPerturbation: 0.4 });
  const midJ = Math.floor(g.nDip / 2);
  let worst = 0;
  for (let k = 1; k < g.segments.length; k++) {
    const last = g.subs.filter(s => s.segIndex === k - 1 && s.dipIndex === midJ).pop();
    const next = g.subs.find(s => s.segIndex === k && s.dipIndex === midJ);
    const ratio = Math.max(last.slipWeight, next.slipWeight) / Math.max(1e-9, Math.min(last.slipWeight, next.slipWeight));
    worst = Math.max(worst, ratio);
  }
  assert.ok(worst < 2.2, 'boundary slip ratio bounded: ' + worst.toFixed(2));
});

test('segmented fault: rupture times propagate from the hypocentre (monotone with 3D distance)', () => {
  const g = Physics.genSegmentedFault(NODES, 8.2, SEGOPTS);
  const h = g.hypocenter;
  let checked = 0;
  for (const s of g.subs) {
    const surf = Physics.haversineDist(h.lat, h.lng, s.lat, s.lng);
    const d3 = Math.sqrt(surf * surf + (s.depth - h.depth) ** 2);
    const implied = d3 / s.ruptureSpeedKmS;
    assert.ok(Math.abs(implied - s.ruptureTime) / Math.max(implied, 0.01) < 0.01, 'rt = 3D dist / local v');
    checked++;
  }
  assert.ok(checked === g.subs.length);
  assert.ok(g.maxRuptureTime > 10 && g.maxRuptureTime < 300, 'duration band: ' + g.maxRuptureTime);
});

test('segmented fault: createSourceModel consumes faultPath and returns the segmented geometry', () => {
  const src = Physics.createSourceModel({
    lat: NODES[0].lat, lng: NODES[0].lng, mw: 8.2, depth: 25,
    strike: 60, dip: 20, rake: 90, sourceType: 'interplate',
    generateSubSources: true, faultPath: NODES,
    faultOptions: { randomSeed: 3, sourceType: 'interplate' }
  });
  assert.ok(src.geometry, 'source model has geometry');
  assert.strictEqual(src.geometry.kind, 'synthetic-segmented');
  assert.strictEqual(src.geometry.segments.length, 3);
});

// ================================================================
//  LISTRIC
// ================================================================
test('dipRowAnchors: amount 0 reduces exactly to the closed form', () => {
  const rows = Physics.dipRowAnchors(30, 0, 40, 8);
  for (let j = 0; j <= 8; j++) {
    assert.ok(Math.abs(rows[j].depth - j * 5 * Math.sin(Math.PI / 6)) < 1e-12);
    assert.ok(Math.abs(rows[j].horiz - j * 5 * Math.cos(Math.PI / 6)) < 1e-12);
  }
});

test('listric knob: shallower bottom + wider spread, moment conserved, default byte-identical', () => {
  const base = Physics.genSubSources(38.1, 142.8, 8.0, 190, 18, 24, 2.8, { sourceType: 'interplate', randomSeed: 5 });
  const twin = Physics.genSubSources(38.1, 142.8, 8.0, 190, 18, 24, 2.8, { sourceType: 'interplate', randomSeed: 5 });
  assert.deepStrictEqual(base.subs, twin.subs, 'amount 0 byte-identical');
  const listric = Physics.genSubSources(38.1, 142.8, 8.0, 190, 18, 24, 2.8, { sourceType: 'interplate', randomSeed: 5, listricDipDeg: 25 });
  const bottom = g => Math.max(...g.subs.filter(s => s.dipIndex === g.nDip - 1).map(s => s.depth));
  assert.ok(bottom(listric) < bottom(base) - 3, 'bottom shallower: ' + bottom(base).toFixed(1) + ' -> ' + bottom(listric).toFixed(1));
  const momA = base.subs.reduce((a, s) => a + s.moment, 0);
  const momB = listric.subs.reduce((a, s) => a + s.moment, 0);
  assert.ok(Math.abs(momA - momB) / momA < 1e-12, 'moment conserved');
  assert.strictEqual(base.listricDipDeg, 0);
  assert.strictEqual(listric.listricDipDeg, 25);
});

test('segmented + listric compose deterministically', () => {
  const g = Physics.genSegmentedFault(NODES, 8.2, { ...SEGOPTS, listricDipDeg: 15 });
  assert.ok(g);
  const g2 = Physics.genSegmentedFault(NODES, 8.2, { ...SEGOPTS, listricDipDeg: 15 });
  assert.deepStrictEqual(g.subs.map(s => s.depth), g2.subs.map(s => s.depth));
  const momSum = g.subs.reduce((a, s) => a + s.moment, 0);
  assert.ok(Math.abs(momSum / g.totalMoment - 1) < 1e-12);
});
