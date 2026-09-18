'use strict';
// 12-degree intensity (CSIS / GB/T 17742) mode: conversion anchors, cue-name
// mapping, i18n parity, and the frozen Intensity1-12 cue assets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Physics = require('../public/physics.js');

test('shindoToCsis — anchors match the MMI-aligned 12-degree table', () => {
  assert.strictEqual(Physics.shindoToCsis(0), 1);
  assert.strictEqual(Physics.shindoToCsis(2), 4);
  assert.strictEqual(Physics.shindoToCsis(4.8), 7);   // 4.8 → '5-' → 7
  assert.strictEqual(Physics.shindoToCsis(5.3), 8);   // 5.3 → '5+' → 8
  assert.strictEqual(Physics.shindoToCsis(6.2), 10);  // 6.2 → '6+' → 10
  assert.strictEqual(Physics.shindoToCsis(6.8), 11);  // 6.8 → 7 → 11
  assert.strictEqual(Physics.shindoToCsis('7'), 11);
  // XII (near-total destruction) is deliberately unreachable from
  // instrumental shindo — the mapping caps at XI.
  for (const k of Object.values(Physics.SHINDO_TO_CSIS)) assert.ok(k >= 1 && k <= 11);
});

test('convertIntensity — csis branch routes like mmi/ems98', () => {
  assert.strictEqual(Physics.convertIntensity('5+', 'csis'), 8);
  assert.strictEqual(Physics.convertIntensity(4, 'csis'), 6);
  assert.strictEqual(Physics.convertIntensity(4, 'shindo'), 4);
});

test('getIntensity12Name — clamps to Intensity1..12', () => {
  // audio.js is loaded in tests/audio.test.js with browser globals; do the
  // same minimal shim here.
  global.window = global;
  global.fetch = () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  global.AudioContext = function() {
    this.state = 'running';
    this.createGain = () => ({ gain: { value: 1 }, connect: () => {} });
    this.createBuffer = (ch, len, rate) => ({});
    this.createBufferSource = () => ({ buffer: null, connect: () => {}, start: () => {} });
    this.decodeAudioData = (buf) => Promise.resolve({});
    this.destination = {};
  };
  delete require.cache[require.resolve('../public/audio.js')];
  const Audio = require('../public/audio.js');
  assert.strictEqual(Audio.getIntensity12Name(7), 'Intensity7');
  assert.strictEqual(Audio.getIntensity12Name(0), 'Intensity1');
  assert.strictEqual(Audio.getIntensity12Name(99), 'Intensity12');
  assert.strictEqual(Audio.getIntensity12Name(6.4), 'Intensity6');
  assert.strictEqual(Audio.getIntensity12Name(NaN), null);
});

test('Intensity1-12 cue assets exist (x3 languages, real RIFF/WAVE)', () => {
  for (const lang of ['jp', 'en', 'zh']) {
    for (let deg = 1; deg <= 12; deg++) {
      const file = path.join(ROOT, 'sounds', lang, 'Intensity' + deg + '.wav');
      assert.ok(fs.existsSync(file), file + ' missing');
      const buf = fs.readFileSync(file);
      assert.ok(buf.length > 1000, file + ' too small');
      assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF', file + ' not RIFF');
      assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE', file + ' not WAVE');
    }
  }
});

test('i18n: intensity.csis / bulletin.csis_line / audio.lazy present x3', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  for (const key of ['intensity.csis', 'bulletin.csis_line', 'audio.lazy', 'region.st_note']) {
    const n = src.split('"' + key + '":').length - 1;
    assert.strictEqual(n, 3, key + ' must appear in all three languages, got ' + n);
  }
});

test('config: csis is a legal intensityScale option', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'config.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('intensityScale:'));
  assert.ok(line.includes("'csis'"), 'csis must be in intensityScale opts: ' + line);
});
