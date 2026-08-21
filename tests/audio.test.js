// ================================================================
//  Unit tests for Earthquake Simulator — Audio module
//  Run with:  node --test tests/audio.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');

// Simulate browser globals needed by audio.js
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

// The IIFE attaches to `this` which in Node.js commonJS is module.exports
const Audio = require('../public/audio.js');

// ================================================================
//  MODULE STRUCTURE
// ================================================================

test('AudioManager exists with expected API', () => {
  assert.ok(Audio, 'AudioManager should exist');
  assert.strictEqual(typeof Audio.getSoundPath, 'function');
  assert.strictEqual(typeof Audio.initContext, 'function');
  assert.strictEqual(typeof Audio.preloadBuffer, 'function');
  assert.strictEqual(typeof Audio.playSound, 'function');
  assert.strictEqual(typeof Audio.playSequence, 'function');
  assert.strictEqual(typeof Audio.playRemoteTTS, 'function');
  assert.strictEqual(typeof Audio.getBulletinPath, 'function');
  assert.strictEqual(typeof Audio.playShindoAlert, 'function');
  assert.strictEqual(typeof Audio.getShindoSoundName, 'function');
  assert.strictEqual(typeof Audio.getPgaSoundName, 'function');
  assert.strictEqual(typeof Audio.shindoRank, 'function');
});

// ================================================================
//  getSoundPath
// ================================================================

test('getSoundPath — returns correct paths', () => {
  assert.strictEqual(Audio.getSoundPath('Shindo6', 'jp'), 'sounds/jp/Shindo6.wav');
  assert.strictEqual(Audio.getSoundPath('EEW', 'en'), 'sounds/en/EEW.wav');
  assert.strictEqual(Audio.getSoundPath('PGA', 'zh'), 'sounds/zh/PGA.wav');
});

test('getSoundPath — handles different sound names', () => {
  const sounds = ['Shindo0','Shindo1','Shindo2','Shindo3','Shindo4','Shindo5',
                  'Shindo6','Shindo7','EEW','PGA','Tsunami','foreign'];
  for (const s of sounds) {
    const path = Audio.getSoundPath(s, 'jp');
    assert.ok(path.startsWith('sounds/jp/'), `${s} should be in sounds/jp/`);
    assert.ok(path.endsWith('.wav'), `${s} should be .wav`);
  }
});

// ================================================================
//  BUFFER CACHE
// ================================================================

test('_bufferCache starts empty', () => {
  Audio._bufferCache = {};
  assert.strictEqual(Object.keys(Audio._bufferCache).length, 0);
});

// ================================================================
//  CONTEXT INITIALISATION
// ================================================================

test('initContext — creates AudioContext', () => {
  Audio._audioCtx = null;
  Audio._unlocked = false;
  Audio.initContext();
  assert.ok(Audio._audioCtx, 'AudioContext should be created');
  assert.ok(Audio._unlocked, 'should be unlocked after init');
});

test('initContext — idempotent (no crash on double init)', () => {
  assert.doesNotThrow(() => Audio.initContext());
});

// ================================================================
//  REGRESSION TESTS
// ================================================================

test('preloadBuffer stores raw buffer without double-decrementing pending loads', async () => {
  Audio._bufferCache = {};
  Audio._audioCtx = null;
  Audio._pendingLoads = 0;
  global.fetch = () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) });
  Audio.preloadBuffer('sounds/test.wav');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(Audio._pendingLoads, 0);
  assert.ok(Audio._bufferCache['sounds/test.wav'] instanceof ArrayBuffer);
});

test('shindo alerts use the original JMA intensity sound assets', () => {
  const expected = {
    0: 'Shindo0',
    1: 'Shindo1',
    2: 'Shindo2',
    3: 'Shindo3',
    4: 'Shindo4',
    5: 'Shindo5',
    '5-': 'Shindo5',
    '5+': 'Shindo5',
    6: 'Shindo6',
    '6-': 'Shindo6',
    '6+': 'Shindo6',
    7: 'Shindo7',
  };
  for (const [level, name] of Object.entries(expected)) {
    assert.strictEqual(Audio.getShindoSoundName(level), name);
  }
  assert.ok(Audio.shindoRank('5-') < Audio.shindoRank('5+'));
  assert.ok(Audio.shindoRank('6-') < Audio.shindoRank('6+'));
});

test('PGA cue selects weak or strong shaking once from the event maximum', () => {
  assert.strictEqual(Audio.getPgaSoundName(0.99), null);
  assert.strictEqual(Audio.getPgaSoundName(1), 'PGA1');
  assert.strictEqual(Audio.getPgaSoundName(79.99), 'PGA1');
  assert.strictEqual(Audio.getPgaSoundName(80), 'PGA2');
  assert.strictEqual(Audio.getPgaSoundName(500), 'PGA2');
});

test('ensureDecoded waits for an in-progress preload', async () => {
  Audio._bufferCache = {};
  Audio._loadPromises = {};
  Audio._pendingLoads = 0;
  Audio._audioCtx = null;
  let releaseFetch;
  global.fetch = () => new Promise(resolve => {
    releaseFetch = () => resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  });
  const preload = Audio.preloadBuffer('sounds/slow.wav');
  const decoded = Audio.ensureDecoded('sounds/slow.wav');
  releaseFetch();
  await preload;
  const result = await decoded;
  assert.ok(result instanceof ArrayBuffer);
  assert.strictEqual(Audio._pendingLoads, 0);
});

test('preloadBuffer reports an HTTP failure and clears loading state', async () => {
  Audio._bufferCache = {};
  Audio._loadPromises = {};
  Audio._reportedErrors = {};
  Audio._pendingLoads = 0;
  global.fetch = () => Promise.resolve({ ok: false, status: 404 });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await Audio.preloadBuffer('sounds/missing.wav');
    assert.strictEqual(result, null);
    assert.strictEqual(Audio._bufferCache['sounds/missing.wav'], undefined);
    assert.strictEqual(Audio._loadPromises['sounds/missing.wav'], undefined);
    assert.strictEqual(Audio._pendingLoads, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('playSequence abort stops scheduled WebAudio sources', async () => {
  const stopped = [];
  global.AudioBuffer = function MockAudioBuffer(duration) { this.duration = duration; };
  Audio._bufferCache = {
    'a.wav': new global.AudioBuffer(0.1),
    'b.wav': new global.AudioBuffer(0.1),
  };
  Audio._audioCtx = {
    state: 'running',
    currentTime: 0,
    createBufferSource: () => {
      const src = {
        buffer: null,
        connect: () => {},
        disconnect: () => {},
        start: () => {},
        stop: () => { stopped.push(src); },
      };
      return src;
    },
    createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
  };
  Audio._masterGain = {};
  const ctrl = Audio.playSequence([{ path: 'a.wav' }, { path: 'b.wav' }], () => {});
  await new Promise(resolve => setImmediate(resolve));
  ctrl.abort();
  assert.strictEqual(stopped.length, 2);
  delete global.AudioBuffer;
});

test('playRemoteTTS decodes a complete MP3 response and reports playback end', async () => {
  let source;
  let ended = false;
  Audio._audioCtx = {
    state: 'running',
    decodeAudioData: () => Promise.resolve({ duration: 1 }),
    createBufferSource: () => (source = {
      connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {}
    }),
    createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} })
  };
  Audio._masterGain = {};
  global.fetch = () => Promise.resolve({
    ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
  });
  Audio.playRemoteTTS('/api/tts/synthesize?text=test', 0.8, () => { ended = true; });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(source, 'decoded audio should create a source');
  source.onended();
  assert.strictEqual(ended, true);
});

test('playRemoteTTS request timeout does not truncate long playback', async () => {
  let source;
  let errors = 0;
  let ended = 0;
  const originalTimeout = Audio._remoteTtsRequestTimeoutMs;
  Audio._remoteTtsRequestTimeoutMs = 10;
  Audio._audioCtx = {
    state: 'running',
    decodeAudioData: () => Promise.resolve({ duration: 60 }),
    createBufferSource: () => (source = {
      connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {}
    }),
    createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} })
  };
  Audio._masterGain = {};
  global.fetch = () => Promise.resolve({
    ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
  });
  try {
    Audio.playRemoteTTS('/api/tts/synthesize?text=long', 0.8, () => { ended++; }, () => { errors++; });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(source, 'long TTS should start playback');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.strictEqual(errors, 0, 'request timeout must be cleared before playback');
    source.onended();
    assert.strictEqual(ended, 1);
  } finally {
    Audio._remoteTtsRequestTimeoutMs = originalTimeout;
  }
});

test('playRemoteTTS abort cancels an in-flight fetch without error fallback', async () => {
  let signal;
  let errors = 0;
  Audio._audioCtx = { state: 'running' };
  Audio._masterGain = {};
  global.fetch = (url, opts) => {
    signal = opts.signal;
    return new Promise(() => {});
  };
  const ctrl = Audio.playRemoteTTS('/api/tts/synthesize?text=test', 1, null, () => { errors++; });
  await new Promise(resolve => setImmediate(resolve));
  ctrl.abort();
  assert.ok(signal && signal.aborted);
  assert.strictEqual(errors, 0);
});

test('playRemoteTTS reports an HTTP failure for local-fragment fallback', async () => {
  let errorMessage = '';
  Audio._audioCtx = { state: 'running' };
  Audio._masterGain = {};
  global.fetch = () => Promise.resolve({ ok: false, status: 502 });
  Audio.playRemoteTTS('/api/tts/synthesize?text=test', 1, null, error => {
    errorMessage = error.message;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errorMessage, /HTTP 502/);
});

test('bulletin sequence trims encoder padding while keeping a short lead-in', () => {
  const samples = new Float32Array(16000);
  for (let i = 3200; i < 11200; i++) samples[i] = 0.2;
  const buffer = {
    length: samples.length,
    duration: 1,
    sampleRate: 16000,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
  const bounds = Audio._getSequenceBounds(buffer);
  assert.ok(bounds.offset > 0.15 && bounds.offset < 0.25);
  assert.ok(bounds.duration < 0.55);
  assert.ok(bounds.offset + bounds.duration <= 1);
});

//  CLEANUP
// ================================================================

test('cleanup', () => {
  delete global.window;
  delete global.AudioContext;
  delete global.fetch;
  delete global.AudioManager;
});
