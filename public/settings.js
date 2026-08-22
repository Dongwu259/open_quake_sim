// ================================================================
//  Settings page — local preferences (localStorage 'qs-settings') plus the
//  TTS engine picker. The browser engine speaks via the Web Speech API
//  (offline, zero configuration); the server engine proxies a self-hosted
//  or cloud TTS upstream whose URL can be changed from this machine only
//  (POST /api/settings is loopback-gated).
// ================================================================
(function() {
  'use strict';

  var LS_KEY = 'qs-settings';
  var DEFAULTS = {
    ttsEngine: 'browser',      // 'browser' (Web Speech API) | 'server' (proxy upstream)
    ttsBrowserVoice: '',       // '' = auto (first Japanese voice, else system default)
    ttsBrowserRate: 1.0
  };
  var cache = null;

  function load() {
    try { cache = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch(e) { cache = Object.assign({}, DEFAULTS); }
    return cache;
  }
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch(e) {}
  }

  var Settings = {
    get: function(key) {
      if (!cache) load();
      return key === undefined ? cache : cache[key];
    },
    set: function(key, value) {
      if (!cache) load();
      cache[key] = value;
      save();
    }
  };
  window.Settings = Settings;

  function el(id) { return document.getElementById(id); }

  function syncEngineSections() {
    var engine = Settings.get('ttsEngine');
    var browserSec = el('settings-tts-browser');
    var serverSec = el('settings-tts-server');
    if (browserSec) browserSec.style.display = engine === 'browser' ? 'block' : 'none';
    if (serverSec) serverSec.style.display = engine === 'server' ? 'block' : 'none';
  }

  function populateVoices() {
    var select = el('settings-tts-voice');
    if (!select || !('speechSynthesis' in window)) return;
    var current = Settings.get('ttsBrowserVoice');
    var voices = window.speechSynthesis.getVoices() || [];
    var autoLabel = (typeof t === 'function') ? t('settings.voice_auto') : (select.getAttribute('data-auto-label') || 'Auto');
    var html = '<option value="">' + autoLabel + '</option>';
    var ja = [], other = [];
    for (var i = 0; i < voices.length; i++) {
      (/^ja([-_]|$)/i.test(voices[i].lang) ? ja : other).push(voices[i]);
    }
    ja.concat(other).forEach(function(v) {
      html += '<option value="' + v.name.replace(/"/g, '&quot;') + '"' +
        (v.name === current ? ' selected' : '') + '>' +
        (v.name + ' (' + v.lang + ')').replace(/</g, '&lt;') + '</option>';
    });
    select.innerHTML = html;
  }

  function refreshServerSection() {
    fetch('/api/settings').then(function(r) { return r.json(); }).then(function(data) {
      var input = el('settings-tts-upstream');
      var saveBtn = el('settings-tts-save');
      var note = el('settings-tts-upstream-note');
      if (!data || !data.ok || !data.tts) return;
      if (input) input.value = data.tts.upstream || '';
      var editable = !!(data.loopback && data.tts.configurable);
      if (input) input.disabled = !editable;
      if (saveBtn) saveBtn.disabled = !editable;
      var keyInput = el('settings-tts-apikey');
      var keymodeSel = el('settings-tts-keymode');
      var keyClearBtn = el('settings-tts-keyclear');
      if (keyInput) {
        keyInput.disabled = !editable;
        keyInput.value = '';
        keyInput.placeholder = data.tts.hasKey ? '••••••••' : (keyInput.getAttribute('data-ph') || '');
      }
      if (keymodeSel) {
        keymodeSel.disabled = !editable;
        keymodeSel.value = data.tts.keyMode || 'query';
      }
      if (keyClearBtn) keyClearBtn.disabled = !editable || !data.tts.hasKey;
      if (note) {
        var key = 'settings.upstream_hint';
        if (!data.loopback) key = 'settings.remote_only';
        else if (!data.tts.configurable) key = 'settings.env_locked';
        note.textContent = (typeof t === 'function') ? t(key) : key;
      }
    }).catch(function() { /* status line stays as-is */ });
  }

  function bindSettingsModal() {
    var btn = el('btn-settings');
    var overlay = el('settings-overlay');
    if (!btn || !overlay || overlay.getAttribute('data-bound') === '1') return false;
    overlay.setAttribute('data-bound', '1');

    var closeBtn = el('btn-settings-close');
    function open() {
      var engineSel = el('settings-tts-engine');
      var rateInput = el('settings-tts-rate');
      if (engineSel) engineSel.value = Settings.get('ttsEngine');
      if (rateInput) rateInput.value = Settings.get('ttsBrowserRate');
      populateVoices();
      syncEngineSections();
      refreshServerSection();
      if (typeof openAccessibleModal === 'function') openAccessibleModal('settings-overlay', '#btn-settings-close');
      else overlay.style.display = 'flex';
    }
    function close() {
      if (typeof closeAccessibleModal === 'function') closeAccessibleModal('settings-overlay');
      else overlay.style.display = 'none';
    }
    btn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', function(e) {
      if (typeof trapAccessibleModalKey === 'function') trapAccessibleModalKey(e, overlay, close);
      else if (e.key === 'Escape') close();
    });

    var engineSel = el('settings-tts-engine');
    if (engineSel) engineSel.addEventListener('change', function() {
      Settings.set('ttsEngine', this.value === 'server' ? 'server' : 'browser');
      syncEngineSections();
    });
    var voiceSel = el('settings-tts-voice');
    if (voiceSel) voiceSel.addEventListener('change', function() {
      Settings.set('ttsBrowserVoice', this.value);
    });
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
    var rateInput = el('settings-tts-rate');
    if (rateInput) rateInput.addEventListener('change', function() {
      var v = Number(this.value);
      Settings.set('ttsBrowserRate', (v >= 0.5 && v <= 2) ? v : 1.0);
    });

    var saveBtn = el('settings-tts-save');
    if (saveBtn) saveBtn.addEventListener('click', function() {
      var input = el('settings-tts-upstream');
      var keyInput = el('settings-tts-apikey');
      var keymodeSel = el('settings-tts-keymode');
      var status = el('settings-tts-save-status');
      var body = {
        ttsUpstreamUrl: input ? input.value.trim() : '',
        ttsApiKeyMode: keymodeSel ? keymodeSel.value : 'query'
      };
      if (keyInput && keyInput.value.trim() !== '') body.ttsApiKey = keyInput.value.trim();
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (status) status.textContent = (data && data.ok)
          ? ((typeof t === 'function') ? t('settings.saved') : 'Saved')
          : ((typeof t === 'function') ? t('settings.save_fail') : 'Save failed');
        if (data && data.ok) refreshServerSection();
      }).catch(function() {
        if (status) status.textContent = (typeof t === 'function') ? t('settings.save_fail') : 'Save failed';
      });
    });

    var keyClearBtn = el('settings-tts-keyclear');
    if (keyClearBtn) keyClearBtn.addEventListener('click', function() {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttsApiKey: '' })
      }).then(function() { refreshServerSection(); });
    });

    var testBtn = el('settings-tts-test');
    if (testBtn) testBtn.addEventListener('click', function() {
      var status = el('settings-tts-test-status');
      function setStatus(key) {
        if (status) status.textContent = key ? ((typeof t === 'function') ? t(key) : key) : '';
      }
      var sample = '地震シミュレーターの音声テストです。緊急地震速報です。';
      setStatus('settings.testing');
      var finished = false;
      function onEnd() { if (!finished) { finished = true; setStatus('settings.test_done'); } }
      function onError() { if (!finished) { finished = true; setStatus('settings.test_fail'); } }
      if (Settings.get('ttsEngine') === 'browser' && typeof AudioManager !== 'undefined' && AudioManager.playBrowserTTS) {
        try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch(e) {}
        AudioManager.playBrowserTTS(sample, 1, onEnd, onError);
      } else if (typeof AudioManager !== 'undefined' && AudioManager.playRemoteTTS) {
        var voice = (typeof TTSTextBuilder !== 'undefined' && TTSTextBuilder.DEFAULT_VOICE) || 'ja-JP-NanamiNeural';
        AudioManager.playRemoteTTS('/api/tts/synthesize?text=' + encodeURIComponent(sample) + '&voice=' + encodeURIComponent(voice), 1, onEnd, onError);
      } else {
        setStatus('settings.test_fail');
      }
    });

    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindSettingsModal);
  } else {
    bindSettingsModal();
  }
})();
