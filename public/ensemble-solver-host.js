// ================================================================
//  Earthquake Simulator Pro v5.7 — Ensemble solver host
//
//  EnsembleSolverHost.run(context, stations, options) -> Promise
//
//  v5.7 tail decision (pre-registered in the v5.6 re-scope, measured by
//  tools/bench-ensemble.js): 97 centroids x 40 members runs ~90 ms on the
//  main thread (param-keyed cache, one-shot per forecast refresh — kept
//  synchronous), but 200 members exceed 400 ms, so runs with
//  options.members >= ENSEMBLE_WORKER_MIN_MEMBERS (100) go to a Worker.
//  Worker failure permanently falls back to the synchronous in-process
//  engine (identical results — same physics.js code runs in both).
//
//  ENSEMBLE_WORKER_V manually tracks ensemble-worker.js content (like
//  TSUNAMI_WORKER_V); the physics.js URL is taken from the page's current
//  ?v= marker so the worker and the main thread always share one build.
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function() { return require('./physics.js'); }, function() { return require('./ensemble-worker.js'); });
  } else {
    root.EnsembleSolverHost = factory(function() { return root.Physics; }, null);
  }
}(typeof self !== 'undefined' ? self : this, function(getPhysics) {
'use strict';

var ENSEMBLE_WORKER_V = '5b066a'; // content hash of ensemble-worker.js — set before release
var WORKER_MIN_MEMBERS = 100;
var _worker = null;        // shared Worker instance
var _workerDead = false;   // permanent fallback after a failure
var _pending = {};         // id -> {resolve, reject}
var _nextId = 1;

function _physicsUrl() {
  // current content-hashed physics.js URL from the live DOM
  try {
    var els = document.querySelectorAll('script[src*="physics.js"]');
    for (var i = 0; i < els.length; i++) {
      var src = els[i].getAttribute('src') || '';
      if (src.indexOf('physics.js') >= 0) return src;
    }
  } catch (e) { /* no DOM (tests) */ }
  return 'physics.js';
}

function _ensureWorker() {
  if (_workerDead || typeof Worker === 'undefined') return null;
  if (_worker) return _worker;
  try {
    var url = 'ensemble-worker.js?v=' + ENSEMBLE_WORKER_V +
      '&physics=' + encodeURIComponent(_physicsUrl());
    _worker = new Worker(url);
    _worker.onmessage = function(ev) {
      var msg = ev.data || {};
      if (msg.type === 'error' && !msg.id) { _killWorker(msg.message); return; }
      var slot = _pending[msg.id];
      if (!slot) return;
      delete _pending[msg.id];
      if (msg.type === 'result') slot.resolve(msg.result);
      else slot.reject(new Error(msg.message || 'ensemble worker error'));
    };
    _worker.onerror = function(e) { _killWorker(e && e.message); };
    _worker.postMessage({ type: 'boot', physicsUrl: _physicsUrl() });
    return _worker;
  } catch (e) {
    _killWorker(e && e.message);
    return null;
  }
}

function _killWorker(message) {
  _workerDead = true;
  try { if (_worker) _worker.terminate(); } catch (e) {}
  _worker = null;
  var ids = Object.keys(_pending);
  for (var i = 0; i < ids.length; i++) {
    _pending[ids[i]].reject(new Error(message || 'ensemble worker died'));
    delete _pending[ids[i]];
  }
}

function run(context, stations, options) {
  options = options || {};
  var members = Math.max(2, Math.round(options.members || 200));
  var worker = (members >= WORKER_MIN_MEMBERS) ? _ensureWorker() : null;
  if (!worker) {
    // synchronous fallback — same engine, same numbers
    var Physics = getPhysics();
    return Promise.resolve().then(function() {
      return Physics.ensembleIntensityField(context, stations, options);
    });
  }
  return new Promise(function(resolve, reject) {
    var id = _nextId++;
    _pending[id] = { resolve: resolve, reject: reject };
    try {
      worker.postMessage({ id: id, type: 'run', context: context, stations: stations, options: options });
    } catch (e) {
      delete _pending[id];
      reject(e);
    }
  });
}

function dispose() { _killWorker('disposed'); }

return {
  run: run,
  dispose: dispose,
  WORKER_MIN_MEMBERS: WORKER_MIN_MEMBERS,
  isWorkerActive: function() { return !!_worker; },
  workerDead: function() { return _workerDead; }
};
}));
