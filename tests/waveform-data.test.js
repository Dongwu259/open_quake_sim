'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WaveformData = require('../public/waveform-data.js');

function packageFixture(overrides) {
  const component = channel => ({channel, samples:[0, 1, -1], sha256:'a'.repeat(64)});
  return Object.assign({
    _schema:'quake-sim-waveform-v1', type:'waveform', units:'gal', sampleRateHz:100,
    startTime:'2026-01-01T00:00:00Z', station:{id:'XX.TEST'},
    components:{z:component('HNZ'), n:component('HNN'), e:component('HNE')},
    quality:{researchReady:true,responseRemoved:true,sourceGapCount:0,deliveryResampled:false},
    provenance:{provider:'TEST',sourceUrl:'https://example.org/fdsn',retrievedAt:'2026-01-01T00:01:00Z'}
  }, overrides || {});
}

test('response-corrected three-component package is research-ready', () => {
  const result = WaveformData.validate(packageFixture());
  assert.equal(result.valid, true);
  assert.equal(result.researchReady, true);
});

test('counts and incomplete components are rejected', () => {
  const payload = packageFixture({units:'counts'});
  delete payload.components.e;
  const result = WaveformData.validate(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('acceleration-unit-must-be-gal'));
  assert.ok(result.errors.includes('missing-or-invalid-component-e'));
});

test('gaps or delivery resampling prevent research certification', () => {
  const payload = packageFixture();
  payload.quality = {...payload.quality, researchReady:false, sourceGapCount:1, deliveryResampled:true};
  const result = WaveformData.validate(payload);
  assert.equal(result.valid, true);
  assert.equal(result.researchReady, false);
  assert.ok(result.warnings.includes('source-gaps-present'));
});

test('package converts north/east/vertical to observed x/y/z motion', () => {
  const motion = WaveformData.toObservedMotion(packageFixture());
  assert.deepEqual(motion.components, {x:[0,1,-1],y:[0,1,-1],z:[0,1,-1]});
  assert.equal(motion.sampleRate, 100);
});
