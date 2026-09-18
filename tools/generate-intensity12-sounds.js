#!/usr/bin/env node
'use strict';
// Generate the 12-degree intensity cue set (Intensity1..12.wav) used by the
// CSIS (GB/T 17742) display/announcement mode. Language-neutral tone patterns
// (same design language as generate-alert-sounds.js): pulse count and pitch
// rise with the degree. Generated into every language directory so the normal
// per-language sound lookup finds them; the audio itself is identical.
//
// These are NOT boot-preloaded (lazy resource policy): AudioManager loads them
// on first play, and app.js shows a download prompt when that happens.
//
// Usage: node tools/generate-intensity12-sounds.js [--force]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LANGUAGES = ['jp', 'en', 'zh'];
const SAMPLE_RATE = 32000;
const FORCE = process.argv.includes('--force');

// Degree 1..12: pulses = min(degree, 8), base pitch rises 520+38*deg Hz,
// alternating second tone a minor third up, gain 0.36 -> 0.66.
function specFor(deg) {
  const pulses = Math.min(deg + 1, 9);
  const f0 = 520 + 38 * deg;
  return {
    name: 'Intensity' + deg,
    pulses,
    on: 0.15,
    gap: Math.max(0.03, 0.1 - deg * 0.006),
    tones: [f0, Math.round(f0 * 1.19)],
    gain: Math.min(0.66, 0.36 + deg * 0.025)
  };
}

function renderPcm(spec) {
  const lead = 0.05;
  const tail = 0.14;
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
      samples[i] += Math.round(Math.sin(2 * Math.PI * f * i / SAMPLE_RATE) * envelope * spec.gain * 32767);
    }
  }
  for (let i = 0; i < sampleCount; i++) {
    if (samples[i] > 32767) samples[i] = 32767;
    if (samples[i] < -32768) samples[i] = -32768;
  }
  return { samples, duration: sampleCount / SAMPLE_RATE };
}

function writeWav(file, pcm) {
  const { samples, duration } = pcm;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  const data = Buffer.from(samples.buffer, 0, samples.length * 2);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return 44 + samples.length * 2;
}

let written = 0, skipped = 0;
for (const lang of LANGUAGES) {
  const dir = path.join(ROOT, 'sounds', lang);
  fs.mkdirSync(dir, { recursive: true });
  for (let deg = 1; deg <= 12; deg++) {
    const spec = specFor(deg);
    const file = path.join(dir, spec.name + '.wav');
    if (fs.existsSync(file) && !FORCE) { skipped++; continue; }
    const bytes = writeWav(file, renderPcm(spec));
    written++;
    console.log('wrote', path.relative(ROOT, file), spec.pulses + ' pulses', (bytes / 1024).toFixed(1) + 'KB');
  }
}
console.log('done:', written + ' written, ' + skipped + ' skipped (use --force to regenerate)');
