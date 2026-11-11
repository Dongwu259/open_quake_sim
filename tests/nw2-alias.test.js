// ================================================================
//  R-C NGA-West2 regional-alias batch — contract locks
//  The frozen alias report (tools/data/nw2-alias-report.json) carries the
//  preregistered G-ADOPT verdicts; the taiwan pack carries the one adopted
//  alias (ask14 -> TWN). These locks make any silent re-adoption or
//  re-rejection fail loudly and pin the alias plumbing end to end.
//  Run with:  node --test tests/nw2-alias.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Physics = require('../public/physics.js');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'nw2-alias-report.json'), 'utf8'));

test('frozen alias report: schema, preregistration pointer, set shape', () => {
  assert.equal(report.schema, 'quake-sim-nw2-alias-report-v1');
  assert.match(report.preregistration, /scorecard-nw2-alias\.js/);
  assert.equal(report.set.metric, 'pga');
  assert.ok(report.set.stationsScored > 2000, 'station coverage');
  assert.equal(report.set.droppedStations, 0);
});

test('G-ADOPT verdicts frozen: cy14:ITA@italy rejected, ask14:TWN@taiwan adopted', () => {
  const ita = report.gates['cy14:ITA@italy'];
  const tw = report.gates['ask14:TWN@taiwan'];
  assert.ok(ita, 'italy gate present');
  assert.ok(tw, 'taiwan gate present');
  assert.equal(ita.pass, false, 'CY14-ITA must stay rejected (bias AND rms worsened)');
  assert.equal(tw.pass, true, 'ASK14-TWN must stay adopted');
  assert.ok(Math.abs(tw.dRms + 0.06722595535262804) < 1e-9, 'frozen dRms (re-runs must be deterministic)');
});

test('pack wiring: taiwan ask14 carries TWN, italy cy14 carries no alias', () => {
  const tw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-taiwan.json'), 'utf8'));
  const it = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-italy.json'), 'utf8'));
  const twAsk = tw.gmpeTree.crustal.find((b) => b.model === 'ask14');
  assert.equal(twAsk && twAsk.variant, 'TWN');
  const itCy = it.gmpeTree.crustal.find((b) => b.model === 'cy14');
  assert.ok(!itCy || itCy.variant == null, 'rejected ITA alias must NOT be frozen into the italy pack');
  assert.match(tw.gmpeTree.note, /R-C measurement gate/);
});

test('R-C tail (2026-11-09 NZ / 2026-11-10 CA+IT): CB14 HighQ/LowQ frozen as PSHA-tree epistemic branches', () => {
  for (const rid of ['newzealand', 'california', 'italy']) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-' + rid + '.json'), 'utf8'));
    const cb = pack.gmpeTree.crustal.filter((b) => b.model === 'cb14');
    assert.deepEqual(cb.map((b) => b.variant), ['HighQ', 'LowQ'], rid);
    assert.deepEqual(cb.map((b) => b.weight), [0.125, 0.125], rid);
    assert.match(pack.gmpeTree.note, /user framework decision 2026-11-(09|10)/, rid + ' note carries the decision');
  }
  // taiwan stays single-branch: base arm already best-fitting there
  const tw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-taiwan.json'), 'utf8'));
  assert.equal(tw.gmpeTree.crustal.filter((b) => b.model === 'cb14').length, 1);
  // both branch motions alive and distinct; the near-symmetric Dc20 pair keeps
  // the equal-weight geometric mean within a few % of base at distance
  // (RP anchors moved <=0.2 gal across the three adopted regions)
  const g = { mw: 6.5, rrup: 150, rjb: 150, rx: 150, ry0: 0, ztor: 5, dip: 60, rake: 0, vs30: 600 };
  const base = Physics.pgaCb2014(g), hq = Physics.pgaCb2014(g, 'HighQ'), lq = Physics.pgaCb2014(g, 'LowQ');
  assert.ok(hq > base && lq < base, 'branches straddle base beyond the 80 km gate');
  const mix = Math.sqrt(hq * lq);
  assert.ok(Math.abs(mix - base) / base < 0.05, 'equal-weight mixture near base (' + mix + ' vs ' + base + ')');
});

test('alias plumbing: TWN branch motion shifts taiwan crustal medians; base byte-stable', () => {
  const g = { mw: 6.5, rrup: 60, rjb: 60, rx: 60, ry0: 0, ztor: 8, dip: 60, rake: 90, vs30: 600 };
  const base = Physics.pgaAsk2014(g);
  const tw = Physics.pgaAsk2014(g, 'TWN');
  assert.ok(Math.abs(tw - base) / base > 0.02, 'TWN term must move the median materially');
  // the a25*rrup distance-linear part grows in LN space with distance
  // (absolute gal shift decays with the motion itself)
  const gFar = { ...g, rrup: 150, rjb: 150, rx: 150 };
  const lnShiftNear = Math.abs(Math.log(tw / base));
  const lnShiftFar = Math.abs(Math.log(Physics.pgaAsk2014(gFar, 'TWN') / Physics.pgaAsk2014(gFar)));
  assert.ok(lnShiftFar > lnShiftNear, 'TWN ln-shift grows with distance (a25*rrup): ' + lnShiftFar + ' vs ' + lnShiftNear);
  // rejected ITA alias still callable but distinct from base (implementation alive)
  assert.notEqual(Physics.pgaCy2014(6.4, { rrup: 60, rjb: 60, rx: 60, ry0: 0, ztor: 8, dip: 60, rake: 90, vs30: 400 }, 'ITA'),
                  Physics.pgaCy2014(6.4, { rrup: 60, rjb: 60, rx: 60, ry0: 0, ztor: 8, dip: 60, rake: 90, vs30: 400 }));
});

test('taiwan RP475 sits at the re-frozen alias anchor', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'geojson', 'psha-source-model-taiwan.json'), 'utf8'));
  const hz = Physics.hazardCurve(m, { lat: 25.03, lng: 121.57, vs30: 600 }, 'pga', { years: 50 });
  const rp = Physics._pshaInvertCurve(hz.imLevels, hz.meanRate, 1 / 475);
  assert.ok(Math.abs(rp - 499.8) / 499.8 < 0.002, 'taiwan RP475 ' + rp + ' vs re-frozen 499.8 (TWN alias)');
});
