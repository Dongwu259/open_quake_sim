#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LANGUAGES = ['jp', 'en', 'zh'];
const STRICT = process.argv.includes('--strict');
const REQUIRED = [
  'EEW1', 'EEW2', 'EEW_alert', 'EEW_canceled', 'PGA1', 'PGA2',
  'Shindo0', 'Shindo1', 'Shindo2', 'Shindo1_alert', 'Shindo2_alert',
  'Shindo3_alert', 'Shindo4_alert', 'Shindo5m_alert', 'Shindo5p_alert',
  'Shindo6m_alert', 'Shindo6p_alert', 'Shindo7_alert',
  'Tsunami_1', 'Tsunami_2', 'Tsunami_3', 'Tsunami_lifted',
];

const errors = [];
const warnings = [];
let inspected = 0;
let pcmFiles = 0;
let legacyMpeg = 0;

function parseWave(buffer, relative) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) {
      errors.push(`${relative}: truncated ${id.trim() || 'chunk'} chunk`);
      return { valid: false };
    }
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bits: buffer.readUInt16LE(body + 14),
      };
    }
    if (id === 'data') dataBytes = size;
    offset = body + size + (size % 2);
  }
  if (!fmt || dataBytes === null) {
    errors.push(`${relative}: missing fmt or data chunk`);
    return { valid: false };
  }
  const duration = fmt.byteRate > 0 ? dataBytes / fmt.byteRate : 0;
  if (![1, 3].includes(fmt.format)) warnings.push(`${relative}: WAV codec ${fmt.format} is not PCM/float`);
  if (fmt.channels < 1 || fmt.channels > 2) errors.push(`${relative}: unsupported channel count ${fmt.channels}`);
  if (fmt.sampleRate < 16000 || fmt.sampleRate > 96000) errors.push(`${relative}: suspicious sample rate ${fmt.sampleRate}`);
  if (duration < 0.05 || duration > 120) errors.push(`${relative}: suspicious duration ${duration.toFixed(3)}s`);
  return { valid: true, fmt, duration };
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.toLowerCase().endsWith('.wav')) inspect(full);
  }
}

function inspect(file) {
  inspected++;
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  const buffer = fs.readFileSync(file);
  if (buffer.length === 0) {
    errors.push(`${relative}: zero-byte file`);
    return;
  }
  const wave = parseWave(buffer, relative);
  if (wave) {
    if (wave.valid) pcmFiles++;
    return;
  }
  const isMpeg = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
  if (isMpeg) {
    legacyMpeg++;
    warnings.push(`${relative}: MPEG audio is mislabeled with a .wav extension`);
  } else {
    errors.push(`${relative}: not a RIFF/WAVE or recognized MPEG audio file`);
  }
}

for (const lang of LANGUAGES) {
  for (const name of REQUIRED) {
    const file = path.join(ROOT, 'sounds', lang, name + '.wav');
    if (!fs.existsSync(file)) errors.push(`sounds/${lang}/${name}.wav: required asset is missing`);
    else if (name.endsWith('_alert')) {
      const header = fs.readFileSync(file).subarray(0, 12);
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
        errors.push(`sounds/${lang}/${name}.wav: generated alert must be a real WAV file`);
      }
    }
  }
  walk(path.join(ROOT, 'sounds', lang));
}

console.log(`Audio validation: ${inspected} files, ${pcmFiles} RIFF/WAVE, ${legacyMpeg} legacy MPEG-in-WAV.`);
for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);
if (errors.length || (STRICT && warnings.length)) {
  console.error(`Audio validation failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exitCode = 1;
} else {
  console.log(`Audio validation passed with ${warnings.length} compatibility warning(s).`);
}
