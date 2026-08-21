const test = require('node:test');
const assert = require('node:assert/strict');
const Research = require('../public/research.js');

test('stable hashes ignore object insertion order', () => {
  assert.equal(Research.hash({b:2,a:1}), Research.hash({a:1,b:2}));
  assert.notEqual(Research.hash({a:1}), Research.hash({a:2}));
});

test('random streams are deterministic and independently addressed', () => {
  const run = Array.from({length:8}, (_, i) => Research.randomAt(1234, 'waveform', i));
  assert.deepEqual(run, Array.from({length:8}, (_, i) => Research.randomAt(1234, 'waveform', i)));
  assert.notDeepEqual(run, Array.from({length:8}, (_, i) => Research.randomAt(1234, 'aftershock', i)));
  assert.ok(run.every(v => v >= 0 && v < 1));
});

test('legacy scenario migrates to complete v2 envelope', () => {
  const migrated = Research.migrateScenario({version:1,name:'legacy',events:[{lat:35,lng:140,mag:7,depth:20}]});
  assert.equal(migrated.schema, Research.SCENARIO_SCHEMA);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.events[0].dip, 90);
  assert.equal(migrated.seed, 20260725);
  assert.deepEqual(migrated.config, {});
});

test('scenario migration rejects an empty or malformed event list', () => {
  assert.throws(() => Research.migrateScenario({events:[]}), /valid events/);
  assert.throws(() => Research.migrateScenario({events:[{lat:'bad'}]}), /valid events/);
});

test('experiment separates reproducible hashes from unique run identity', () => {
  const common = {seed:9,config:{gmp:'x'},scenario:{events:[1]},createdAt:'2026-07-25T00:00:00.000Z'};
  const a = Research.createExperiment({...common, nonce:'a'});
  const b = Research.createExperiment({...common, nonce:'b'});
  assert.notEqual(a.id, b.id);
  assert.equal(a.hashes.config, b.hashes.config);
  assert.equal(a.hashes.scenario, b.hashes.scenario);
});

test('snapshot bounds stored arrays and keeps endpoints', () => {
  const waveform = Array.from({length:1000}, (_, i) => ({t:i,a:i}));
  const snap = Research.createSnapshot({waveform,maxWaveformPoints:40,stations:Array.from({length:300},(_,i)=>({id:i,peakPga:i}))});
  assert.equal(snap.waveform.length, 40);
  assert.equal(snap.waveform[0].t, 0);
  assert.equal(snap.waveform.at(-1).t, 999);
  assert.equal(snap.stations.length, 250);
  assert.equal(snap.stations[0].peakPga, 299);
});

test('comparison reports parameters, waveforms, stations, and tsunami regions', () => {
  const base = {experiment:{id:'a'},scenario:{events:[{mag:7}]},config:{x:1},summary:{maxPga:10,maxPgv:2,maxShindoScore:4,maxTsunamiHeight:1},waveform:[{a:1},{a:2}],intensitySeries:[{shindo:2}],stations:[{id:'s',peakPga:10,peakPgv:2,intensity:4}],tsunami:{regions:[{code:'A',height:1,level:1}]}};
  const next = JSON.parse(JSON.stringify(base)); next.experiment.id='b'; next.config.x=2; next.summary.maxPga=13; next.waveform[1].a=4; next.stations[0].peakPga=13; next.tsunami.regions[0].height=2;
  const diff = Research.compareSnapshots(base,next);
  assert.equal(diff.summary.maxPga.delta,3);
  assert.equal(diff.parameterDiff[0].key,'config.x');
  assert.ok(diff.waveform.rmse > 0);
  assert.equal(diff.stations[0].peakPga.delta,3);
  assert.equal(diff.tsunamiRegions[0].height.delta,1);
});

test('residual report includes bias, RMS, MAE, and percentiles', () => {
  const m = Research.residualMetrics([{residual:-1},{residual:0},{residual:2}]);
  assert.equal(m.count,3);
  assert.ok(Math.abs(m.bias - 1/3) < 1e-12);
  assert.ok(Math.abs(m.rms - Math.sqrt(5/3)) < 1e-12);
  assert.equal(m.median,0);
  assert.equal(m.p50,0);
});
