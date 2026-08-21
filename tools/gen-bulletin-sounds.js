#!/usr/bin/env node
// Generate the realtime history bulletin chimes (Bulletin_JMA / Bulletin_CENC /
// Bulletin_Other) as 22050 Hz 16-bit mono WAVs in sounds/{jp,en,zh}/ — the
// repo-root sounds/ dir is what server.js serves at /sounds/ (public/sounds/
// is NOT routed there). Chimes are language-independent synthesized tones, so
// all three language dirs hold identical files. Re-run after changing any
// tone recipe; bump-versions is not affected (sounds carry no ?v= markers).
'use strict';
const fs = require('fs');
const path = require('path');

const SR = 22050;

function wavHeader(nSamples) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + nSamples * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(nSamples * 2, 40);
  return b;
}

// A decaying sine with a soft 2nd harmonic. t in seconds.
function tone(freq, t, dur) {
  const env = Math.min(1, t / 0.005) * Math.exp(-3.2 * t / dur);
  return env * (Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(4 * Math.PI * freq * t));
}

// segments: [{freq, dur, gap}] played back to back
function render(segments, peak) {
  const nTotal = Math.ceil(segments.reduce((s, g) => s + g.dur + (g.gap || 0), 0) * SR) + Math.ceil(0.02 * SR);
  const pcm = Buffer.alloc(nTotal * 2);
  let off = 0;
  for (const seg of segments) {
    const n = Math.ceil(seg.dur * SR);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, tone(seg.freq, i / SR, seg.dur) * peak));
      pcm.writeInt16LE(Math.round(v * 32767), (off + i) * 2);
    }
    off += n + Math.ceil((seg.gap || 0) * SR);
  }
  return Buffer.concat([wavHeader(nTotal), pcm]);
}

const RECIPES = {
  // JMA official listing: bright two-tone ding-dong
  Bulletin_JMA: { segs: [{ freq: 1318.5, dur: 0.16, gap: 0.04 }, { freq: 1760.0, dur: 0.30 }], peak: 0.55 },
  // CENC listing: three brisk mid beeps
  Bulletin_CENC: { segs: [{ freq: 880, dur: 0.09, gap: 0.06 }, { freq: 880, dur: 0.09, gap: 0.06 }, { freq: 880, dur: 0.20 }], peak: 0.5 },
  // Other agencies: single soft ping
  Bulletin_Other: { segs: [{ freq: 1174.7, dur: 0.28 }], peak: 0.45 }
};

const dirs = ['jp', 'en', 'zh'].map((l) => path.join(__dirname, '..', 'sounds', l));
for (const dir of dirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(RECIPES)) {
    const r = RECIPES[name];
    const buf = render(r.segs, r.peak);
    fs.writeFileSync(path.join(dir, name + '.wav'), buf);
    console.log('wrote', path.join(path.basename(dir), name + '.wav'), buf.length, 'bytes');
  }
}
