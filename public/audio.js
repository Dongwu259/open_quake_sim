// audio.js v3 — Web Audio API buffer-based playback (Safari compatible)
// All sounds are fetched + decoded into AudioBuffers on preload, then played instantly.
(function(root) {
  'use strict';
  var AudioManager = {};

  AudioManager.getSoundPath = function(name, lang) {
    return 'sounds/' + lang + '/' + name + '.wav';
  };

  AudioManager._audioCtx = null;
  AudioManager._masterGain = null;
  AudioManager._bufferCache = {}; // path → AudioBuffer
  AudioManager._loadPromises = {}; // path → in-flight Promise
  AudioManager._reportedErrors = {}; // suppress repeated errors for one asset
  AudioManager._loadGeneration = 0;
  AudioManager._unlocked = false;
  AudioManager._pendingLoads = 0;
  AudioManager._reloading = false;  // v4.2: lock during stopAll→preload transition
  AudioManager._reloadQueue = [];   // v4.2: queued playbacks during reload
  AudioManager._remoteTtsRequestTimeoutMs = 10000;
  AudioManager._remoteTtsPlaybackFloorMs = 30000;
  AudioManager._remoteTtsPlaybackGraceMs = 5000;

  // Bulletin fragments are generated independently and commonly contain
  // 150-600 ms of encoder padding at both ends.  Keep a small natural
  // breath, but do not concatenate the padding into audible pauses.
  AudioManager._sequenceGap = 0.035;
  AudioManager._trimCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  AudioManager._getSequenceBounds = function(buffer) {
    if (!buffer || typeof buffer.duration !== 'number' ||
        typeof buffer.getChannelData !== 'function' || !buffer.length) {
      return { offset: 0, duration: buffer && buffer.duration ? buffer.duration : 0 };
    }
    if (AudioManager._trimCache && AudioManager._trimCache.has(buffer)) {
      return AudioManager._trimCache.get(buffer);
    }
    var channels = Math.max(1, buffer.numberOfChannels || 1);
    var sampleRate = buffer.sampleRate || Math.round(buffer.length / buffer.duration) || 16000;
    var threshold = 0;
    var data = [];
    for (var ch = 0; ch < channels; ch++) {
      var samples = buffer.getChannelData(ch);
      data.push(samples);
      // A conservative floor avoids retaining quantisation noise as speech.
      for (var j = 0; j < samples.length; j += 16) {
        var a = Math.abs(samples[j]);
        if (a > threshold) threshold = a;
      }
    }
    threshold = Math.max(0.0015, threshold * 0.012);
    var first = buffer.length, last = -1;
    for (var i = 0; i < buffer.length; i++) {
      var active = false;
      for (var c = 0; c < data.length; c++) {
        if (Math.abs(data[c][i]) >= threshold) { active = true; break; }
      }
      if (active) { if (first === buffer.length) first = i; last = i; }
    }
    if (last < 0) {
      var silent = { offset: 0, duration: buffer.duration };
      if (AudioManager._trimCache) AudioManager._trimCache.set(buffer, silent);
      return silent;
    }
    var pad = Math.round(sampleRate * 0.015);
    first = Math.max(0, first - pad);
    last = Math.min(buffer.length - 1, last + pad);
    var bounds = { offset: first / sampleRate, duration: Math.max(0.02, (last - first + 1) / sampleRate) };
    if (AudioManager._trimCache) AudioManager._trimCache.set(buffer, bounds);
    return bounds;
  };

  AudioManager.stopAll = function() {
    // Close and recreate AudioContext to instantly cut all audio
    if (AudioManager._audioCtx) {
      try { AudioManager._audioCtx.close(); } catch(e) {}
      AudioManager._audioCtx = null;
      AudioManager._masterGain = null;
    }
    AudioManager._bufferCache = {}; // clear decoded buffers
    AudioManager._loadPromises = {};
    AudioManager._loadGeneration++;
    AudioManager._pendingLoads = 0;
    AudioManager._reloading = true;  // v4.2: block new playback until preload completes
  };

  // v4.2: Call after preloadAudio() completes to drain queued playback requests
  AudioManager._onReloadComplete = function() {
    AudioManager._reloading = false;
    var q = AudioManager._reloadQueue;
    AudioManager._reloadQueue = [];
    for (var i = 0; i < q.length; i++) {
      try { q[i](); } catch(e) {}
    }
  };

  AudioManager._userGestureDone = false;

  // Must be called from a user gesture (click/touch) to satisfy browser autoplay policy
  AudioManager.initContext = function() {
    if (AudioManager._audioCtx) {
      if (AudioManager._audioCtx.state === 'closed') {
        AudioManager._audioCtx = null;
        AudioManager._masterGain = null;
        // fall through to recreate
      } else {
        if (AudioManager._audioCtx.state === 'suspended') {
          AudioManager._audioCtx.resume().catch(function(){});
        }
        return;
      }
    }
    try {
      AudioManager._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      AudioManager._masterGain = AudioManager._audioCtx.createGain();
      AudioManager._masterGain.gain.value = 1.5;
      AudioManager._masterGain.connect(AudioManager._audioCtx.destination);
      if (AudioManager._audioCtx.state === 'suspended') {
        AudioManager._audioCtx.resume().catch(function(){});
      }
    } catch(e) { return; }
    // Safari unlock: play silent buffer
    if (!AudioManager._unlocked) {
      AudioManager._unlocked = true;
      try {
        var buf = AudioManager._audioCtx.createBuffer(1, 1, 22050);
        var src = AudioManager._audioCtx.createBufferSource();
        src.buffer = buf; src.connect(AudioManager._audioCtx.destination); src.start(0);
      } catch(e) {}
    }
  };

  AudioManager._reportError = function(kind, path, error) {
    var key = kind + ':' + path;
    if (AudioManager._reportedErrors[key]) return;
    AudioManager._reportedErrors[key] = true;
    console.warn('[audio:' + kind + '] ' + path, error && error.message ? error.message : error);
  };

  AudioManager._decodeAudioData = function(ctx, arrayBuf) {
    return new Promise(function(resolve, reject) {
      var settled = false;
      function done(buf) { if (!settled) { settled = true; resolve(buf); } }
      function failed(error) { if (!settled) { settled = true; reject(error || new Error('decodeAudioData failed')); } }
      try {
        var result = ctx.decodeAudioData(arrayBuf.slice(0), done, failed);
        if (result && typeof result.then === 'function') result.then(done, failed);
      } catch (error) {
        failed(error);
      }
    });
  };

  // Preload a sound file into an AudioBuffer
  AudioManager.preloadBuffer = function(path) {
    if (AudioManager._bufferCache[path] && AudioManager._bufferCache[path] !== 'loading') {
      return Promise.resolve(AudioManager._bufferCache[path]);
    }
    if (AudioManager._loadPromises[path]) return AudioManager._loadPromises[path];
    var generation = AudioManager._loadGeneration;
    AudioManager._bufferCache[path] = 'loading';
    AudioManager._pendingLoads++;
    var loadPromise = fetch(path).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.arrayBuffer();
    }).then(function(arrayBuf) {
      if (generation !== AudioManager._loadGeneration) return null;
      if (!AudioManager._audioCtx || AudioManager._audioCtx.state === 'closed') {
        AudioManager._bufferCache[path] = arrayBuf; // store raw, decode later
        return arrayBuf;
      }
      return AudioManager._decodeAudioData(AudioManager._audioCtx, arrayBuf);
    }).then(function(audioBuf) {
      if (generation === AudioManager._loadGeneration && audioBuf) AudioManager._bufferCache[path] = audioBuf;
      return audioBuf;
    }).catch(function(e) {
      if (generation === AudioManager._loadGeneration) delete AudioManager._bufferCache[path];
      AudioManager._reportError('load', path, e);
      return null;
    }).then(function(result) {
      if (generation === AudioManager._loadGeneration) {
        delete AudioManager._loadPromises[path];
        AudioManager._pendingLoads = Math.max(0, AudioManager._pendingLoads - 1);
        if (AudioManager._pendingLoads === 0 && AudioManager._reloading) AudioManager._onReloadComplete();
      }
      return result;
    });
    AudioManager._loadPromises[path] = loadPromise;
    return loadPromise;
  };

  // Ensure a path's buffer is decoded (if stored as raw ArrayBuffer)
  AudioManager.ensureDecoded = function(path, cb) {
    function resolveBuffer() {
      var cached = AudioManager._bufferCache[path];
      if (!cached) {
        return AudioManager.preloadBuffer(path).then(function(result) {
          return result ? resolveBuffer() : null;
        });
      }
      if (cached === 'loading') {
        var pending = AudioManager._loadPromises[path];
        return pending ? pending.then(function(result) {
          return result ? resolveBuffer() : null;
        }) : Promise.resolve(null);
      }
      if (typeof AudioBuffer !== 'undefined' && cached instanceof AudioBuffer) return Promise.resolve(cached);
      if (!(cached instanceof ArrayBuffer) || !AudioManager._audioCtx) return Promise.resolve(cached);
      return AudioManager._decodeAudioData(AudioManager._audioCtx, cached).then(function(buf) {
        AudioManager._bufferCache[path] = buf;
        return buf;
      }).catch(function(error) {
        delete AudioManager._bufferCache[path];
        AudioManager._reportError('decode', path, error);
        return null;
      });
    }
    var promise = resolveBuffer();
    if (typeof cb === 'function') promise.then(cb, function() { cb(null); });
    return promise;
  };

  // Play a sound using Web Audio API buffers (instant, no loading delay)
  AudioManager.playSound = function(name, lang, ttsEnabled, volume) {
    if (!lang || lang === 'off') return;
    if (!ttsEnabled) return;

    // v4.2: Queue playback during reload (stopAll cleared buffers, preload in progress)
    if (AudioManager._reloading) {
      AudioManager._reloadQueue.push(function() {
        AudioManager.playSound(name, lang, ttsEnabled, volume);
      });
      return;
    }

    AudioManager.initContext();
    if (!AudioManager._audioCtx) return;
    var resumePromise = Promise.resolve();
    if (AudioManager._audioCtx.state === 'suspended') {
      resumePromise = AudioManager._audioCtx.resume().catch(function(error) {
        AudioManager._reportError('resume', 'AudioContext', error);
      });
    }

    var path = AudioManager.getSoundPath(name, lang);
    var vol = (typeof volume === 'number') ? volume : 1;

    return resumePromise.then(function() {
      return AudioManager.ensureDecoded(path);
    }).then(function(audioBuf) {
      if (!audioBuf) {
        // Fallback: try HTML5 Audio (for files not preloaded)
        try {
          var a = new Audio(path);
          a.volume = Math.min(1, vol);
          var p = a.play(); if (p) p.catch(function(e){ console.warn('Audio fallback play failed:', path, e); });
          a.addEventListener('ended', function(){ if (typeof a.remove === 'function') a.remove(); else a.pause(); });
        } catch(e) {}
        return;
      }
      try {
        var source = AudioManager._audioCtx.createBufferSource();
        source.buffer = audioBuf;
        var gainNode = AudioManager._audioCtx.createGain();
        gainNode.gain.value = vol;
        source.connect(gainNode);
        gainNode.connect(AudioManager._masterGain);
        source.onended = function() { try { gainNode.disconnect(); } catch(e) {} };
        source.start(0);
      } catch(e) { console.warn('WebAudio play failed:', path, e); }
    });
  };

  AudioManager.shindoRank = function(level) {
    if (level === '5-') return 5;
    if (level === '5+') return 5.5;
    if (level === '6-') return 6;
    if (level === '6+') return 6.5;
    var numeric = Number(level);
    return Number.isFinite(numeric) ? numeric : -1;
  };

  AudioManager.getShindoSoundName = function(level) {
    var key = String(level);
    var names = {
      '0':'Shindo0', '1':'Shindo1', '2':'Shindo2',
      '3':'Shindo3', '4':'Shindo4',
      '5':'Shindo5', '5-':'Shindo5', '5+':'Shindo5',
      '6':'Shindo6', '6-':'Shindo6', '6+':'Shindo6',
      '7':'Shindo7'
    };
    return names[key] || null;
  };

  // PGA1 represents felt but weak shaking; PGA2 is reserved for strong
  // shaking around the JMA 5-lower PGA range (approximately 80 gal).
  AudioManager.getPgaSoundName = function(maxPgaGal) {
    var pga = Number(maxPgaGal);
    if (!Number.isFinite(pga) || pga < 1) return null;
    return pga >= 80 ? 'PGA2' : 'PGA1';
  };

  // Play shindo alert (maps level to sound name)
  AudioManager.playShindoAlert = function(level, maxAnnouncedShindo, lang, ttsEnabled, volume) {
    if (level === null || level === undefined || lang === 'off') return maxAnnouncedShindo;
    var rank = AudioManager.shindoRank(level);
    if (rank <= AudioManager.shindoRank(maxAnnouncedShindo)) return maxAnnouncedShindo;
    var name = AudioManager.getShindoSoundName(level);
    if (!name) return maxAnnouncedShindo;
    // Intensity alerts are effects, so the speech/TTS checkbox must not mute them.
    AudioManager.playSound(name, lang, true, volume);
    return level;
  };

  // Build a bulletin info/female path (new concatenation fragments)
  AudioManager.getBulletinPath = function(name, lang) {
    return 'sounds/' + lang + '/info/female/' + name + '.wav';
  };

  // Speak text via the browser's local Web Speech API (the settings page's
  // "browser" engine). Returns the same abort-capable controller contract as
  // playRemoteTTS so the SREV announcer FIFO can cancel queued speech.
  // Chrome can garbage-collect an unreferenced utterance before it ever
  // speaks (silent failure) — keep every queued utterance alive until its
  // onend/onerror fires.
  AudioManager._browserTtsKeepAlive = [];
  AudioManager.playBrowserTTS = function(text, volume, onEnd, onError) {
    var settled = false;
    var aborted = false;
    function done(ok, err) {
      if (settled) return;
      settled = true;
      if (ok) { if (typeof onEnd === 'function') onEnd(); }
      else if (typeof onError === 'function') onError(err || new Error('Browser TTS failed'));
    }
    var utter = null;
    var controller = {
      abort: function() {
        if (aborted) return;
        aborted = true;
        settled = true;
        try { window.speechSynthesis.cancel(); } catch(e) {}
      }
    };
    try {
      utter = new SpeechSynthesisUtterance(text);
      var keep = AudioManager._browserTtsKeepAlive;
      keep.push(utter);
      function release() {
        var ki = keep.indexOf(utter);
        if (ki >= 0) keep.splice(ki, 1);
      }
      var prefs = (window.Settings && typeof window.Settings.get === 'function') ? window.Settings.get() : {};
      var voices = window.speechSynthesis.getVoices() || [];
      var chosen = null;
      if (prefs.ttsBrowserVoice) {
        for (var i = 0; i < voices.length; i++) {
          if (voices[i].name === prefs.ttsBrowserVoice) { chosen = voices[i]; break; }
        }
      }
      if (!chosen) {
        for (var j = 0; j < voices.length; j++) {
          if (/^ja([-_]|$)/i.test(voices[j].lang)) { chosen = voices[j]; break; }
        }
      }
      // Only pin a language when a matching voice exists; a ja-JP request on a
      // system without a Japanese voice can stay silent on some platforms.
      if (chosen) { utter.voice = chosen; utter.lang = chosen.lang; }
      var rate = Number(prefs.ttsBrowserRate);
      utter.rate = (rate >= 0.5 && rate <= 2) ? rate : 1.0;
      var vol = Number(volume);
      utter.volume = isNaN(vol) ? 1 : Math.max(0, Math.min(1, vol));
      utter.onend = function() { release(); done(true); };
      utter.onerror = function(e) { release(); if (!aborted) done(false, e); };
      // Chrome sometimes leaves the queue paused after a previous cancel().
      try { window.speechSynthesis.resume(); } catch(e) {}
      window.speechSynthesis.speak(utter);
    } catch(e) {
      done(false, e);
    }
    return controller;
  };

  // Fetch, decode and play one dynamically generated TTS response. Unlike
  // preloadBuffer(), this exposes cancellation so reset/replay cannot leave a
  // late network response speaking over the next simulation.
  AudioManager.playRemoteTTS = function(url, volume, onEnd, onError) {
    // Settings page: the browser-local engine speaks via the Web Speech API
    // (no server, no network). Falls through to the server-proxy path when
    // speech synthesis is unavailable.
    if (typeof window !== 'undefined' && window.Settings && typeof window.Settings.get === 'function' &&
        window.Settings.get('ttsEngine') === 'browser' && 'speechSynthesis' in window) {
      try {
        var parsedUrl = new URL(url, window.location.origin);
        var spokenText = parsedUrl.searchParams.get('text');
        if (spokenText) return AudioManager.playBrowserTTS(spokenText, volume, onEnd, onError);
      } catch(e) { /* fall through to the remote path */ }
    }
    var aborted = false;
    var settled = false;
    var source = null;
    var gainNode = null;
    var requestTimeoutId = null;
    var playbackTimeoutId = null;
    var abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    function cleanup() {
      if (requestTimeoutId) { clearTimeout(requestTimeoutId); requestTimeoutId = null; }
      if (playbackTimeoutId) { clearTimeout(playbackTimeoutId); playbackTimeoutId = null; }
      if (gainNode) { try { gainNode.disconnect(); } catch(e) {} gainNode = null; }
      if (source) { try { source.disconnect(); } catch(e) {} source = null; }
    }

    function fail(error) {
      if (settled || aborted) return;
      settled = true;
      cleanup();
      if (typeof onError === 'function') onError(error || new Error('TTS playback failed'));
    }

    var controller = {
      abort: function() {
        if (aborted) return;
        aborted = true;
        settled = true;
        if (abortController) abortController.abort();
        if (source) { try { source.stop(0); } catch(e) {} }
        cleanup();
      }
    };

    AudioManager.initContext();
    var ctx = AudioManager._audioCtx;
    if (!ctx || typeof fetch !== 'function') {
      setTimeout(function() { fail(new Error('Web Audio is unavailable')); }, 0);
      return controller;
    }

    var resume = ctx.state === 'suspended'
      ? ctx.resume().catch(function(error) { throw error; })
      : Promise.resolve();
    requestTimeoutId = setTimeout(function() {
      if (settled || aborted) return;
      if (abortController) abortController.abort();
      fail(new Error('TTS request timed out'));
    }, AudioManager._remoteTtsRequestTimeoutMs);

    resume.then(function() {
      return fetch(url, abortController ? { signal: abortController.signal } : undefined);
    }).then(function(resp) {
      if (!resp.ok) throw new Error('TTS HTTP ' + resp.status);
      return resp.arrayBuffer();
    }).then(function(arrayBuf) {
      if (aborted) return null;
      return AudioManager._decodeAudioData(ctx, arrayBuf);
    }).then(function(audioBuf) {
      if (!audioBuf || aborted) return;
      if (ctx !== AudioManager._audioCtx || ctx.state === 'closed') throw new Error('Audio context changed');
      // The 10-second limit applies only to fetch/decode. Keeping that timer
      // alive during playback truncated longer Japanese bulletins mid-sentence.
      if (requestTimeoutId) { clearTimeout(requestTimeoutId); requestTimeoutId = null; }
      source = ctx.createBufferSource();
      source.buffer = audioBuf;
      gainNode = ctx.createGain();
      gainNode.gain.value = typeof volume === 'number' ? volume : 1;
      source.connect(gainNode);
      gainNode.connect(AudioManager._masterGain);
      source.onended = function() {
        if (settled || aborted) return;
        settled = true;
        cleanup();
        if (typeof onEnd === 'function') onEnd();
      };
      source.start(0);
      var durationMs = Number.isFinite(audioBuf.duration) ? audioBuf.duration * 1000 : 0;
      playbackTimeoutId = setTimeout(function() {
        if (!settled && !aborted) fail(new Error('TTS playback completion timed out'));
      }, Math.max(AudioManager._remoteTtsPlaybackFloorMs, durationMs + AudioManager._remoteTtsPlaybackGraceMs));
    }).catch(function(error) {
      if (!aborted && (!error || error.name !== 'AbortError')) fail(error);
    });

    return controller;
  };

  // Play a sequence of audio fragments sequentially via Web Audio API.
  // seq: [{path: string, vol: number}, ...]
  // onEnd: callback when sequence finishes or is aborted
  // Returns a controller {abort: function}
  AudioManager.playSequence = function(seq, onEnd) {
    var aborted = false;
    var scheduledSources = [];
    var endTimer = null;
    var controller = {
      abort: function() {
        aborted = true;
        if (endTimer) { clearTimeout(endTimer); endTimer = null; }
        for (var i = 0; i < scheduledSources.length; i++) {
          try { scheduledSources[i].stop(0); } catch(e) {}
          try { scheduledSources[i].disconnect(); } catch(e) {}
        }
        scheduledSources = [];
      }
    };

    if (!seq || !seq.length) {
      if (onEnd) onEnd();
      return controller;
    }

    AudioManager.initContext();
    if (!AudioManager._audioCtx) {
      if (onEnd) onEnd();
      return controller;
    }
    if (AudioManager._audioCtx.state === 'suspended') AudioManager._audioCtx.resume();

    var ctx = AudioManager._audioCtx;
    var masterGain = AudioManager._masterGain;
    // Collect all buffers first, then schedule
    var pending = seq.length;
    var buffers = new Array(seq.length);
    var allReady = false;

    function scheduleAll() {
      if (!allReady) return;
      if (aborted) return;

      var t = ctx.currentTime + 0.05;
      var hasPrevious = false;
      for (var i = 0; i < buffers.length; i++) {
        if (aborted) break;
        var buf = buffers[i];
        if (!buf) continue; // skip missing buffers
        try {
          var source = ctx.createBufferSource();
          source.buffer = buf;
          var gainNode = ctx.createGain();
          gainNode.gain.value = (typeof seq[i].vol === 'number') ? seq[i].vol : 1;
          source.connect(gainNode);
          gainNode.connect(masterGain);
          source.onended = (function(node) {
            return function() { try { node.disconnect(); } catch(e) {} };
          })(gainNode);
          scheduledSources.push(source);
          var bounds = AudioManager._getSequenceBounds(buf);
          if (hasPrevious) t += AudioManager._sequenceGap;
          source.start(t, bounds.offset, bounds.duration);
          t += bounds.duration;
          hasPrevious = true;
        } catch(e) { console.warn('Sequence play failed at index', i, e); }
      }
      // Schedule onEnd after last buffer finishes
      var totalDuration = t - ctx.currentTime - 0.05;
      if (totalDuration > 0) {
        endTimer = setTimeout(function() {
          endTimer = null;
          scheduledSources = [];
          if (!aborted && onEnd) onEnd();
        }, totalDuration * 1000 + 200);
      } else {
        if (onEnd) onEnd();
      }
    }

    // Resolve each path to an AudioBuffer
    for (var i = 0; i < seq.length; i++) {
      (function(idx) {
        var path = seq[idx].path;
        AudioManager.ensureDecoded(path, function(audioBuf) {
          if (audioBuf) {
            buffers[idx] = audioBuf;
          } else {
            // Try to load via HTML5 Audio as fallback (will play overlapping, imperfect)
            console.warn('Bulletin fragment not cached:', path);
          }
          pending--;
          if (pending === 0) {
            allReady = true;
            scheduleAll();
          }
        });
      })(i);
    }

    return controller;
  };

  // Expose
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioManager;
  else root.AudioManager = AudioManager;
})(typeof window !== 'undefined' ? window : this);
