#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LANGUAGES = ['jp', 'en', 'zh'];
const SAMPLE_RATE = 32000;
const FORCE = process.argv.includes('--force');

// Short, language-neutral patterns. Pulse count and pitch rise with severity.
const ALERTS = [
  { name: 'EEW_alert',      pulses: 6, on: 0.085, gap: 0.045, tones: [880, 660, 980], gain: 0.56 },
  { name: 'Shindo1_alert',  pulses: 1, on: 0.16, gap: 0.12, tones: [480, 560], gain: 0.38 },
  { name: 'Shindo2_alert',  pulses: 2, on: 0.14, gap: 0.11, tones: [540, 620], gain: 0.43 },
  { name: 'Shindo3_alert',  pulses: 3, on: 0.13, gap: 0.10, tones: [620, 720], gain: 0.48 },
  { name: 'Shindo4_alert',  pulses: 3, on: 0.17, gap: 0.08, tones: [680, 820], gain: 0.52 },
  { name: 'Shindo5m_alert', pulses: 4, on: 0.15, gap: 0.07, tones: [720, 900], gain: 0.55 },
  { name: 'Shindo5p_alert', pulses: 4, on: 0.18, gap: 0.055, tones: [780, 980], gain: 0.57 },
  { name: 'Shindo6m_alert', pulses: 5, on: 0.16, gap: 0.05, tones: [840, 1060], gain: 0.59 },
  { name: 'Shindo6p_alert', pulses: 6, on: 0.15, gap: 0.045, tones: [900, 1160], gain: 0.61 },
  { name: 'Shindo7_alert',  pulses: 7, on: 0.16, gap: 0.04, tones: [960, 1260], gain: 0.63 },
];

function renderPcm(spec) {
  const lead = 0.045;
  const tail = 0.12;
  const duration = lead + spec.pulses * spec.on + (spec.pulses - 1) * spec.gap + tail;
  const sampleCount = Math.ceil(duration * SAMPLE_RATE);
  const samples = new Int16Array(sampleCount);

  for (let pulse = 0; pulse < spec.pulses; pulse++) {
    const start = lead + pulse * (spec.on + spec.gap);
    const end = start + spec.on;
    const f = spec.tones[pulse % spec.tones.length];
    for (let i = Math.floor(start * SAMPLE_RATE); i < Math.min(sampleCount, Math.ceil(end * SAMPLE_RATE)); i++) {
      const local = i / SAMPLE_RATE - start;
      const remaining = end - i / SAMPLE_RATE;
      const envelope = Math.min(1, local / 0.012, remaining / 0.025);
      const fundamental = Math.sin(2 * Math.PI * f * local);
      const harmonic = 0.24 * Math.sin(2 * Math.PI * f * 2 * local);
      const urgency = 0.12 * Math.sin(2 * Math.PI * (f * 0.5) * local);
      const shaped = Math.tanh((fundamental + harmonic + urgency) * 1.15);
      samples[i] = Math.round(32767 * spec.gain * envelope * shaped);
    }
  }
  return samples;
}

function encodeWave(samples) {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

let created = 0;
let skipped = 0;
for (const lang of LANGUAGES) {
  const dir = path.join(ROOT, 'sounds', lang);
  for (const spec of ALERTS) {
    const output = path.join(dir, spec.name + '.wav');
    if (fs.existsSync(output) && !FORCE) {
      skipped++;
      continue;
    }
    fs.writeFileSync(output, encodeWave(renderPcm(spec)));
    created++;
  }
}

console.log(`Alert sounds: ${created} written, ${skipped} kept (${SAMPLE_RATE} Hz, mono PCM16).`);
