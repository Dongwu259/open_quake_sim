// ============================================================
//  QuakeSim Service Worker — PWA shell (v5.6, cache-first)
//  Bump CACHE_VERSION when changing SW behavior to purge old caches.
// ============================================================
var CACHE_VERSION = 'qs-cache-v451016';
var CORE_CACHE    = CACHE_VERSION + '-core';

// v4.2: Slim precache — app shell + critical JS/CSS only.
// Three.js, OrbitControls, quake3d.js are lazy-loaded on demand.
var PRECACHE_URLS = [
  './',
  'index.html',
  'report.html',          // v6.2 experience report page
  'guide.html',           // v6.2 illustrated guide page
  'geojson/report-demo.json',  // v6.2 report demo snapshot (~40KB)
  'style.css',
  'app.js',
  'physics.js',
  'dc3d.js',
  'reference-backend.js',
  'waveform-data.js',
  'strong-motion-waveforms.js',
  'sim-utils.js',
  'research.js',
  'data-catalog.js',
  'grid-package.js',
  'strong-motion-data.js',
  'tsunami-validation.js',
  'tsunami-solver-host.js',
  'tsunami-worker.js',
  'ensemble-solver-host.js',
  'ensemble-worker.js',
  'moment-tensor.js',
  'finite-fault.js',
  'observed-fault-models.js',
  'audio.js',
  'tts-text-builder.js',
  'srev-announcer.js',
  'settings.js',
  'i18n.js',
  'config.js',
  'aftershock.js',
  'rt-data.js',
  'rt-kmoni.js',
  'rt-kmoni-worker.js',
  'rt-eew.js',
  'rt-demo.js',
  'rt-quakeinfo.js',
  'rt-tsunami.js',
  'info-panel.js',
  'renderer.js',
  'leaflet/leaflet.js',
  'leaflet/leaflet.css',
  'manifest.json',
  'icon.svg',
  'icon-192.png',
  'icon-512.png'
];

function discoverVersionedAssets(html) {
  var wanted = Object.create(null);
  for (var i = 0; i < PRECACHE_URLS.length; i++) {
    wanted[PRECACHE_URLS[i].replace(/^\.\//, '')] = true;
  }
  var urls = ['index.html'];
  var seen = {'index.html':true};
  var pattern = /(?:src|href)=["']([^"'#]+)["']/gi;
  var match;
  while ((match = pattern.exec(String(html || '')))) {
    var parsed;
    try { parsed = new URL(match[1], self.location.origin + '/'); } catch (error) { continue; }
    if (parsed.origin !== self.location.origin) continue;
    var barePath = parsed.pathname.replace(/^\//, '');
    if (!wanted[barePath]) continue;
    var key = barePath + parsed.search;
    if (!seen[key]) { seen[key] = true; urls.push(key); }
  }
  return urls;
}

// Precached URLs discovered at install. activate() uses this to evict stale
// hashed copies of precache assets from the current core cache — the cache
// name only changes with sw.js itself, so old ?v= entries would otherwise
// accumulate across deploys.
var _installedAssets = null;

// Preserve query strings for versioned assets; only normalize app-shell navigations.
function cacheKey(url) {
  var u = new URL(url, self.location.href);
  if (u.pathname === '/' || u.pathname === '/index.html' || u.href === self.location.origin + '/') {
    return self.location.origin + '/index.html';
  }
  return u.href;
}

self.addEventListener('install', function(e) {
  e.waitUntil(
    fetch(new Request('index.html', { cache: 'reload' })).then(function(indexResponse) {
      if (!indexResponse.ok) throw new Error('App shell unavailable');
      return indexResponse.clone().text().then(function(html) {
        _installedAssets = discoverVersionedAssets(html);
        return caches.open(CORE_CACHE).then(function(cache) {
          return cache.put(cacheKey('index.html'), indexResponse).then(function() {
            return Promise.all(_installedAssets.map(function(url) {
              if (url === 'index.html') return Promise.resolve();
              return cache.add(new Request(url, { cache: 'reload' })).catch(function() {
                /* optional/lazy assets may not exist on every deployment */
              });
            }));
          });
        });
      });
    }).catch(function() {
      return caches.open(CORE_CACHE).then(function(cache) {
        return Promise.all(PRECACHE_URLS.map(function(url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function() {});
        }));
      });
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

function pruneStaleCoreEntries() {
  if (!_installedAssets) return Promise.resolve();
  var keep = Object.create(null);
  for (var i = 0; i < _installedAssets.length; i++) {
    keep[self.location.origin + '/' + _installedAssets[i].replace(/^\.\//, '')] = true;
  }
  var precacheNames = Object.create(null);
  for (var j = 0; j < PRECACHE_URLS.length; j++) {
    precacheNames[PRECACHE_URLS[j].replace(/^\.\//, '')] = true;
  }
  return caches.open(CORE_CACHE).then(function(cache) {
    return cache.keys().then(function(requests) {
      return Promise.all(requests.map(function(r) {
        if (r.url.indexOf('?v=') === -1) return Promise.resolve();
        var barePath;
        try { barePath = new URL(r.url).pathname.replace(/^\//, ''); } catch (error) { return Promise.resolve(); }
        // Only stale hashed copies of precache-managed assets — lazy-loaded
        // extras (three.min.js etc.) cached at runtime are left alone.
        if (!precacheNames[barePath] || keep[r.url]) return Promise.resolve();
        return cache.delete(r);
      }));
    });
  });
}

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) {
        return k.indexOf(CACHE_VERSION) !== 0;
      }).map(function(k) { return caches.delete(k); }));
    }).then(pruneStaleCoreEntries).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Never cache runtime server data
  var RUNTIME_DATA = ['/traffic.json'];
  if (RUNTIME_DATA.indexOf(url.pathname) !== -1) return;

  // API endpoints: network-first, no caching
  if (url.pathname.indexOf('/api/') === 0) {
    e.respondWith(fetch(req).catch(function() {
      return new Response('', { status: 503, statusText: 'Offline' });
    }));
    return;
  }

  var sameOrigin = url.origin === self.location.origin;
  var isSound = url.pathname.indexOf('/sounds/') === 0;
  var isTile = !sameOrigin;
  var isGeoJSON = url.pathname.indexOf('/geojson/') === 0;

  // Navigation (HTML page): network-first, fallback to cached app shell.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function() {
        return caches.match(cacheKey('index.html')).then(function(r) {
          return r || caches.match('index.html');
        });
      })
    );
    return;
  }

  // Tiles, sounds, GeoJSON (large on-demand data): stale-while-revalidate
  if (isTile || isSound || isGeoJSON) {
    e.respondWith(
      caches.open(CACHE_VERSION + '-runtime').then(function(cache) {
        return cache.match(req).then(function(cached) {
          var fetchPromise = fetch(req).then(function(netResp) {
            if (netResp && netResp.status === 200) cache.put(req, netResp.clone());
            return netResp;
          }).catch(function() { return cached; });
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // Same-origin versioned assets (?v=hash): cache-first with the full URL as key.
  // New version -> new hash -> new URL -> cache miss -> network -> cache.
  if (sameOrigin) {
    e.respondWith(
      caches.match(cacheKey(req.url)).then(function(cached) {
        if (cached) return cached;
        return fetch(req).then(function(netResp) {
          if (netResp && netResp.status === 200) {
            var clone = netResp.clone();
            caches.open(CORE_CACHE).then(function(cache) {
              cache.put(cacheKey(req.url), clone);
            });
          }
          return netResp;
        }).catch(function() {
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      })
    );
    return;
  }

  // Everything else: straight to network.
});
