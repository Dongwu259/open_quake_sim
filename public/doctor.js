// doctor.js — resource diagnostics panel (settings -> 资源诊断).
// Checks whether audio / map basemap / data packages are complete on BOTH
// sides: the server disk truth comes from GET /api/doctor (inventory of the
// sounds dir, geojson packages and research-manifest sha256), the browser
// side probes LAZY_SCRIPTS with HEAD (the service worker only intercepts
// GET, so HEAD reports the true network answer) and lists SW caches.
// "二次拉取" = purge the SW runtime cache (page-side caches API, no SW
// cooperation needed) + re-GET the missing URLs with cache:'reload'. Files
// genuinely absent from the server disk can NOT be pulled by the browser —
// the panel says so and names the regeneration tools instead.
// Pure helpers are exported for node tests (buildAudioProbeList /
// buildFragmentList / summarize / buildRefetchPlan).
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Doctor = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Mirror of the server-side lists (tools/validate-audio-assets.js REQUIRED +
  // CSIS 12-level lazy sounds + bulletin fragments per bulletin-builder.js).
  var REQUIRED_SOUNDS = [
    'EEW1', 'EEW2', 'EEW_alert', 'EEW_canceled', 'PGA1', 'PGA2',
    'Shindo0', 'Shindo1', 'Shindo2', 'Shindo1_alert', 'Shindo2_alert',
    'Shindo3_alert', 'Shindo4_alert', 'Shindo5m_alert', 'Shindo5p_alert',
    'Shindo6m_alert', 'Shindo6p_alert', 'Shindo7_alert',
    'Tsunami_1', 'Tsunami_2', 'Tsunami_3', 'Tsunami_lifted',
  ];
  var INTENSITY12 = ['1','2','3','4','5','6','7','8','9','10','11','12'];
  var LANGS = ['jp', 'en', 'zh'];

  function buildFragmentNames(lang) {
    var names = [];
    var i;
    for (i = 0; i < 100; i++) names.push('num_' + (i < 10 ? '0' + i : '' + i));
    for (i = 1; i <= 47; i++) names.push('pref_' + (i < 10 ? '0' + i : '' + i));
    names.push('int_0','int_1','int_2','int_3','int_4','int_5m','int_5p','int_6m','int_6p','int_7');
    if (lang === 'en') {
      names.push('ph_intro1','ph_intro2','ph_mag','ph_depth','ph_km','ph_decimal',
        'ph_tsu_major','ph_tsu_warning','ph_tsu_advisory','ph_affected');
    } else {
      names.push('ph_hour','ph_min','ph_intro1','ph_intro2','ph_mag','ph_depth','ph_km','ph_decimal',
        'ph_tsu_major','ph_tsu_warning','ph_tsu_advisory','ph_affected');
    }
    names.push('1','2','3','4','5-','5+','6-','6+','7','foreign');
    return names;
  }

  function buildAudioProbeList(lang) {
    var out = [];
    REQUIRED_SOUNDS.forEach(function(n) { out.push({ name: n + '.wav', kind: 'required', url: 'sounds/' + lang + '/' + n + '.wav' }); });
    INTENSITY12.forEach(function(n) { out.push({ name: 'Intensity' + n + '.wav', kind: 'intensity12', url: 'sounds/' + lang + '/Intensity' + n + '.wav' }); });
    return out;
  }

  function buildFragmentList(lang) {
    return buildFragmentNames(lang).map(function(n) {
      return { name: n + '.wav', kind: 'fragment', url: 'sounds/' + lang + '/info/female/' + n + '.wav' };
    });
  }

  // Merge the server inventory + the browser probes into a view model.
  // client: { lazy: [{key,url,ok}], swCaches: [names] } (either may be null)
  function summarize(server, client) {
    var sections = [];
    var langLabel = { jp: '日本語 (jp)', en: 'English (en)', zh: '中文 (zh)' };
    // 1) Audio
    var audioItems = [], audioBad = 0, audioAdv = 0;
    LANGS.forEach(function(lang) {
      var a = server && server.audio && server.audio[lang];
      if (!a) return;
      var reqMiss = (a.required && a.required.missing) || [];
      var i12Miss = (a.intensity12 && a.intensity12.missing) || [];
      var fragMiss = (a.bulletinFragments && a.bulletinFragments.missing) || [];
      reqMiss.forEach(function(n) { audioItems.push({ name: langLabel[lang] + ' ' + n, ok: false, refetch: 'sounds/' + lang + '/' + n }); audioBad++; });
      i12Miss.forEach(function(n) { audioItems.push({ name: langLabel[lang] + ' ' + n, ok: false, advisory: true, refetch: 'sounds/' + lang + '/' + n }); audioAdv++; });
      if (fragMiss.length === (a.bulletinFragments && a.bulletinFragments.total)) {
        // Every fragment absent = a deliberately trimmed deployment (Docker
        // .dockerignore drops info/female; account-gated waveform packs are
        // the same class). Advisory, never a failure.
        audioItems.push({ name: langLabel[lang] + ' info/female/*', ok: false, advisory: true,
          note: 'all', refetch: null });
        audioAdv++;
      } else {
        fragMiss.forEach(function(n) { audioItems.push({ name: langLabel[lang] + ' ' + n, ok: false, advisory: true, refetch: 'sounds/' + lang + '/info/female/' + n }); audioAdv++; });
      }
    });
    sections.push({ id: 'audio', severity: audioBad ? 'bad' : 'ok', bad: audioBad, advisory: audioAdv, items: audioItems });

    // 2) Map basemap
    var mapItems = [], mapBad = 0;
    (server && server.map && server.map.offlineVector || []).forEach(function(f) {
      if (!f.ok) mapBad++;
      mapItems.push({ name: f.file, ok: !!f.ok, refetch: f.ok ? null : 'geojson/' + f.file });
    });
    if (server && server.map && server.map.localTiles && !server.map.localTiles.installed) {
      mapItems.push({ name: 'tiles/osm/*', ok: false, advisory: true, note: 'tiles_optional' });
    }
    (client && client.lazy || []).forEach(function(l) {
      if (!l.ok) mapBad++;
      mapItems.push({ name: 'lazy: ' + l.key, ok: !!l.ok, advisory: false, refetch: l.ok ? null : l.url });
    });
    sections.push({ id: 'map', severity: mapBad ? 'bad' : 'ok', bad: mapBad, advisory: mapItems.filter(function(i) { return i.advisory && !i.ok; }).length, items: mapItems });

    // 3) Data packages
    var pkgItems = [], pkgBad = 0;
    (server && server.packages && server.packages.terrain || []).forEach(function(f) {
      if (!f.ok) pkgBad++;
      pkgItems.push({ name: f.file, ok: !!f.ok, refetch: f.ok ? null : 'geojson/' + f.file });
    });
    (server && server.packages && server.packages.regions || []).forEach(function(r) {
      ['pack', 'stations'].forEach(function(k) {
        if (!r[k]) { pkgBad++; pkgItems.push({ name: 'region-' + k + '-' + r.region + '.json', ok: false, refetch: 'geojson/region-' + k + '-' + r.region + '.json' }); }
      });
      ['areas', 'vs30'].forEach(function(k) {
        if (!r[k]) pkgItems.push({ name: 'region-' + k + '-' + r.region + '.json', ok: false, advisory: true, refetch: 'geojson/region-' + k + '-' + r.region + '.json' });
      });
    });
    var fmi = server && server.packages && server.packages.faultModelIndex;
    if (!fmi) pkgBad++;
    pkgItems.push({ name: 'fault-models/index.json', ok: !!fmi, refetch: fmi ? null : 'geojson/fault-models/index.json' });
    sections.push({ id: 'packages', severity: pkgBad ? 'bad' : 'ok', bad: pkgBad, advisory: pkgItems.filter(function(i) { return i.advisory && !i.ok; }).length, items: pkgItems });

    // 4) Research manifest sha256 reconciliation
    var manItems = [], manBad = 0;
    (server && server.manifest && server.manifest.resources || []).forEach(function(r) {
      if (!r.sha256Ok) manBad++;
      manItems.push({ name: r.path + (r.exists ? '' : ' (missing)'), ok: !!r.sha256Ok, note: 'sha256', refetch: r.sha256Ok ? null : r.path });
    });
    sections.push({ id: 'manifest', severity: manBad ? 'bad' : 'ok', bad: manBad, advisory: 0, items: manItems });

    // 5) Browser SW caches (informational)
    if (client && client.swCaches) {
      sections.push({ id: 'sw', severity: 'ok', bad: 0, advisory: 0,
        items: (client.swCaches.length ? client.swCaches : []).map(function(n) { return { name: n, ok: true, note: 'client_cache' }; }) });
    }
    var bad = sections.reduce(function(s, x) { return s + (x.bad || 0); }, 0);
    return { status: bad ? 'degraded' : 'ok', bad: bad, sections: sections };
  }

  // URLs worth re-pulling for a section: only the non-advisory missing items
  // (advisory rows are deliberate-absent or regenerable extras).
  function buildRefetchPlan(summary, sectionId) {
    var sec = summary.sections.filter(function(s) { return s.id === sectionId; })[0];
    if (!sec) return [];
    return sec.items.filter(function(i) { return !i.ok && !i.advisory && i.refetch; }).map(function(i) { return i.refetch; });
  }

  // ---- browser side -------------------------------------------------------
  function _t(key) {
    if (typeof t === 'function') return t(key);
    return key;
  }

  function probeClient() {
    var lazy = [];
    var scripts = (typeof window !== 'undefined' && window.LAZY_SCRIPTS) || {};
    Object.keys(scripts).forEach(function(key) {
      lazy.push({ key: key, url: scripts[key], ok: null });
    });
    var p = Promise.resolve();
    lazy.forEach(function(l) {
      p = p.then(function() {
        return fetch(l.url, { method: 'HEAD' }).then(function(r) { l.ok = r.ok; }).catch(function() { l.ok = false; });
      });
    });
    var cachesP = (typeof caches !== 'undefined' && caches.keys)
      ? caches.keys().then(function(ks) { return ks.filter(function(k) { return k.indexOf('qs-cache-') === 0; }); }).catch(function() { return []; })
      : Promise.resolve([]);
    return Promise.all([p, cachesP]).then(function(res) {
      return { lazy: lazy, swCaches: res[1] };
    });
  }

  function purgeRuntimeCaches() {
    if (typeof caches === 'undefined' || !caches.keys) return Promise.resolve(0);
    return caches.keys().then(function(ks) {
      var runtime = ks.filter(function(k) { return k.indexOf('qs-cache-') === 0 && k.indexOf('-runtime') !== -1; });
      return Promise.all(runtime.map(function(k) { return caches.delete(k); })).then(function() { return runtime.length; });
    }).catch(function() { return 0; });
  }

  function refetchUrls(urls, progress) {
    var results = [];
    var CONCURRENCY = 6;
    var idx = 0;
    function worker() {
      if (idx >= urls.length) return Promise.resolve();
      var url = urls[idx++];
      return fetch(url, { cache: 'reload' }).then(function(r) { results.push({ url: url, ok: r.ok, status: r.status }); })
        .catch(function() { results.push({ url: url, ok: false, status: 0 }); })
        .then(function() { if (progress) progress(results.length, urls.length); return worker(); });
    }
    return purgeRuntimeCaches().then(function() {
      var workers = [];
      for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
      return Promise.all(workers).then(function() { return results; });
    });
  }

  // ---- panel rendering ----------------------------------------------------
  var _state = { server: null, client: null, summary: null };

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function _sectionHtml(sec) {
    var dot = sec.severity === 'bad' ? '#e94560' : (sec.advisory ? '#d9a441' : '#2e9e5b');
    var titleKey = { audio: 'doctor.section_audio', map: 'doctor.section_map', packages: 'doctor.section_packages', manifest: 'doctor.section_manifest', sw: 'doctor.client_probe' }[sec.id] || sec.id;
    var html = '<details class="doctor-section" data-sec="' + sec.id + '" style="margin:10px 0;border:1px solid rgba(255,255,255,0.12);border-radius:10px;">';
    html += '<summary style="cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:10px;">';
    html += '<span style="width:11px;height:11px;border-radius:6px;background:' + dot + ';display:inline-block;"></span>';
    html += '<b>' + _esc(_t(titleKey)) + '</b>';
    if (sec.bad) html += '<span style="color:#e94560;font-weight:700;">' + _esc(_t('doctor.missing_of').replace('{n}', sec.bad)) + '</span>';
    else html += '<span style="color:#2e9e5b;">' + _esc(_t('doctor.present')) + '</span>';
    html += '</summary><div style="padding:4px 16px 12px;">';
    if (sec.id === 'map' || sec.id === 'audio' || sec.id === 'packages' || sec.id === 'manifest') {
      var plan = _state.summary ? buildRefetchPlan(_state.summary, sec.id) : [];
      if (plan.length) {
        html += '<div style="margin:6px 0;"><button class="rt-mini-btn doctor-refetch" data-sec="' + sec.id + '" type="button">' + _esc(_t('doctor.refetch')) + '</button> <span class="settings-note doctor-sec-status"></span></div>';
      }
    }
    var rows = sec.items.filter(function(i) { return !i.ok; });
    if (!rows.length) {
      html += '<p class="settings-note">' + _esc(_t('doctor.present')) + '</p>';
    } else {
      html += '<ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.7;">';
      rows.slice(0, 60).forEach(function(i) {
        var color = i.advisory ? '#d9a441' : '#e94560';
        html += '<li style="color:' + color + ';">' + _esc(i.name);
        if (i.note === 'all') html += ' — ' + _esc(_t('doctor.expected_missing'));
        else if (i.note === 'tiles_optional') html += ' — ' + _esc(_t('doctor.tiles_optional'));
        html += '</li>';
      });
      if (rows.length > 60) html += '<li>… +' + (rows.length - 60) + '</li>';
      html += '</ul>';
    }
    html += '</div></details>';
    return html;
  }

  function _statusNote() {
    var el = document.getElementById('doctor-status');
    if (!el) return;
    if (!_state.summary) { el.textContent = _t('doctor.checking'); return; }
    el.innerHTML = _state.summary.status === 'ok'
      ? '<span style="color:#2e9e5b;font-weight:700;">✔ ' + _esc(_t('doctor.status_ok')) + '</span>'
      : '<span style="color:#e94560;font-weight:700;">✘ ' + _esc(_t('doctor.status_degraded')) + ' (' + _state.summary.bad + ')</span>';
  }

  function _render() {
    var box = document.getElementById('doctor-sections');
    if (!box || !_state.summary) return;
    var html = '';
    _state.summary.sections.forEach(function(sec) { html += _sectionHtml(sec); });
    box.innerHTML = html;
    _statusNote();
    Array.prototype.forEach.call(box.querySelectorAll('.doctor-refetch'), function(btn) {
      btn.addEventListener('click', function() { _refetchSection(btn.getAttribute('data-sec'), btn); });
    });
  }

  function _refetchSection(sectionId, btn) {
    var statusEl = btn.parentElement.querySelector('.doctor-sec-status');
    var plan = buildRefetchPlan(_state.summary, sectionId);
    if (!plan.length) { if (statusEl) statusEl.textContent = _t('doctor.refetch_none'); return; }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = _t('doctor.checking');
    refetchUrls(plan).then(function(results) {
      var still = results.filter(function(r) { return !r.ok; }).length;
      btn.disabled = false;
      if (statusEl) statusEl.textContent = _t('doctor.refetch_done').replace('{n}', results.length - still).replace('{m}', still) + (still ? ' ' + _t('doctor.server_missing_hint') : '');
      return runCheck(); // re-probe so the panel reflects reality
    }).catch(function() { btn.disabled = false; if (statusEl) statusEl.textContent = _t('doctor.refetch_failed'); });
  }

  function runCheck() {
    _state.summary = null;
    _statusNote();
    var box = document.getElementById('doctor-sections');
    if (box) box.innerHTML = '<p class="settings-note">' + _esc(_t('doctor.loading_fetch')) + '</p>';
    return Promise.all([
      fetch('/api/doctor', { cache: 'no-store' }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function() {
          // 200 but not JSON = a proxy fell back to an HTML page for the
          // unknown path (or an old server served the app shell)
          throw new Error('NOT_JSON');
        });
      }),
      probeClient(),
    ]).then(function(res) {
      _state.server = res[0];
      _state.client = res[1];
      _state.summary = summarize(_state.server, _state.client);
      _render();
      return _state.summary;
    }).catch(function(e) {
      var el = document.getElementById('doctor-status');
      if (el) {
        var msg = (e && e.message) || '';
        var key = 'doctor.err_net';
        if (msg.indexOf('HTTP 404') === 0) key = 'doctor.err_404';
        else if (msg.indexOf('HTTP 429') === 0) key = 'doctor.err_429';
        else if (msg.indexOf('HTTP 5') === 0) key = 'doctor.err_5xx';
        else if (msg.indexOf('NOT_JSON') === 0) key = 'doctor.err_html';
        el.innerHTML = '<span style="color:#e94560;font-weight:700;">✘ ' + _esc(_t('doctor.error_fetch')) +
          ' — ' + _esc(_t(key)) + '</span>';
      }
      throw new Error('doctor: server inventory unavailable (' + ((e && e.message) || 'network') + ')');
    });
  }

  function openModal() {
    var overlay = document.getElementById('doctor-overlay');
    if (!overlay) return;
    if (typeof openAccessibleModal === 'function') openAccessibleModal('doctor-overlay', '#btn-doctor-close');
    else overlay.style.display = 'flex';
    if (!overlay.getAttribute('data-bound')) {
      overlay.setAttribute('data-bound', '1');
      var closeBtn = document.getElementById('btn-doctor-close');
      function close() {
        if (typeof closeAccessibleModal === 'function') closeAccessibleModal('doctor-overlay');
        else overlay.style.display = 'none';
      }
      if (closeBtn) closeBtn.addEventListener('click', close);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
      overlay.addEventListener('keydown', function(e) {
        if (typeof trapAccessibleModalKey === 'function') trapAccessibleModalKey(e, overlay, close);
        else if (e.key === 'Escape') close();
      });
      var rerun = document.getElementById('btn-doctor-refresh');
      if (rerun) rerun.addEventListener('click', function() { runCheck().catch(function() {}); });
      var purge = document.getElementById('btn-doctor-purge');
      if (purge) purge.addEventListener('click', function() {
        purgeRuntimeCaches().then(function(n) {
          var el = document.getElementById('doctor-action-status');
          if (el) el.textContent = n ? _t('doctor.purge_done').replace('{n}', n) : _t('doctor.purge_none');
          return runCheck().catch(function() {});
        });
      });
    }
    var action = document.getElementById('doctor-action-status');
    if (action) action.textContent = '';
    runCheck().catch(function() {});
  }

  return {
    REQUIRED_SOUNDS: REQUIRED_SOUNDS.slice(),
    INTENSITY12: INTENSITY12.slice(),
    buildAudioProbeList: buildAudioProbeList,
    buildFragmentList: buildFragmentList,
    buildFragmentNames: buildFragmentNames,
    summarize: summarize,
    buildRefetchPlan: buildRefetchPlan,
    runCheck: runCheck,
    openModal: openModal,
  };
});
