// ================================================================
//  Earthquake Simulator Pro v5.5 — Tsunami solver host (main thread)
//
//  Owns the nonlinear/nested-AMR tsunami solvers so app.js does not care
//  WHERE they run:
//    - default: inside public/tsunami-worker.js (classic Web Worker),
//      keeping the 1.6-2.7x nested-grid cost off the UI thread;
//    - fallback: in-process Physics solvers behind the identical proxy
//      interface (no Worker support, worker boot failure, or a runtime
//      worker error — existing proxies then rebuild local solvers lazily).
//
//  The engine is always physics.js; this file only routes messages.
//  Mirrors the rt-kmoni.js / rt-kmoni-worker.js split.
//
//  Proxy interface (the subset of the solver API app.js consumes):
//    advanceTo(t)            — fire-and-forget in worker mode (monotonic)
//    getSnapshot(stride)     — latest posted snapshot (null until first)
//    samplePeak(lat,lng)     — per-checkpoint max|eta| cache
//    sampleWaterDepth(lat,lng)
//    dispose()               — drop the solver (eviction)
//    .model / .isWorker / .isReady — diagnostics
//
//  TsunamiSolverHost.resetAll() disposes every proxy + the worker state
//  (sim reset / terrain swap / solver-option rebuild).
//  TSUNAMI_WORKER_V manually tracks tsunami-worker.js content (like
//  KMONI_WORKER_V in rt-kmoni.js) so the worker URL is cache-busted.
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function() { return require('./physics.js'); }, function() { return require('./tsunami-worker.js'); });
  } else {
    root.TsunamiSolverHost = factory(function() { return root.Physics; }, function() { return root.TsunamiWorkerCore; });
  }
}(typeof self !== 'undefined' ? self : this, function(getPhysics, getWorkerCore) {
'use strict';

var TSUNAMI_WORKER_V = 'ef900d'; // content hash of tsunami-worker.js — set before release
var WORKER_URL = 'tsunami-worker.js?v=';

var _worker = null;          // Worker instance
var _workerState = 'idle';   // idle | booting | ready | dead
var _proxies = Object.create(null); // key -> proxy state
var _gridIds = null;         // WeakMap grid object -> id (worker registry dedup)
var _nextGridId = 1;

function _ckKey(lat, lng) { return Number(lat).toFixed(4) + ',' + Number(lng).toFixed(4); }

// Structured-clone cannot carry functions: deep-copy plain data, pass typed
// arrays through, drop functions. Used for the source model (geometry helper
// closures are rehydrated inside the worker).
function _stripFunctions(value, seen) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (ArrayBuffer.isView(value)) return value;
  if (seen.indexOf(value) >= 0) throw new Error('cyclic source model');
  seen.push(value);
  var out = Array.isArray(value) ? [] : {};
  for (var k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    var v = _stripFunctions(value[k], seen);
    if (v !== undefined) out[k] = v;
  }
  seen.pop();
  return out;
}

function _scriptUrl(name) {
  if (typeof document === 'undefined') return name;
  var el = document.querySelector('script[src^="' + name + '"]');
  return el ? el.src : name;
}

function _ensureWorker() {
  if (_workerState === 'dead') return null;
  if (_worker) return _worker;
  if (typeof Worker !== 'function') { _workerState = 'dead'; return null; }
  try {
    _worker = new Worker(WORKER_URL + TSUNAMI_WORKER_V);
    _workerState = 'booting';
    _gridIds = (typeof WeakMap === 'function') ? new WeakMap() : null;
    _worker.onmessage = _onWorkerMessage;
    _worker.onerror = function() { _killWorker(); };
    _worker.postMessage({type: 'boot', dc3dUrl: _scriptUrl('dc3d.js'), physicsUrl: _scriptUrl('physics.js')});
  } catch (err) {
    _worker = null;
    _workerState = 'dead';
  }
  return _worker;
}

function _onWorkerMessage(e) {
  var msg = e.data || {};
  if (msg.type === 'booted') { _workerState = 'ready'; return; }
  if (msg.type === 'error' && !msg.key) { _killWorker(); return; }
  var st = _proxies[msg.key];
  if (!st) return;
  if (msg.type === 'ready') {
    st.ready = true;
    st.model = msg.model || st.model;
    st.waterDepths = {};
    var cps = st.params.checkpoints || [];
    for (var i = 0; i < cps.length; i++) st.waterDepths[_ckKey(cps[i].lat, cps[i].lng)] = msg.waterDepths[i];
  } else if (msg.type === 'snapshot') {
    st.snapshot = msg.snapshot;
    st.peaks = {};
    var cps2 = st.params.checkpoints || [];
    for (var i2 = 0; i2 < cps2.length; i2++) st.peaks[_ckKey(cps2[i2].lat, cps2[i2].lng)] = msg.peaks[i2];
  } else if (msg.type === 'error') {
    // Solver-level failure (bad grid/source): retire this proxy to local mode.
    _toLocal(st);
  }
}

function _killWorker() {
  try { if (_worker) _worker.terminate(); } catch (err) { /* noop */ }
  _worker = null;
  _workerState = 'dead';
  // Lazily rebuild every live proxy in-process on its next advanceTo.
  for (var k in _proxies) if (_proxies[k] && _proxies[k].mode === 'worker') _toLocal(_proxies[k], true);
}

// Register a grid object with the worker exactly once per worker lifetime and
// attach its payload to the init message only on first registration.
function _attachGrid(grid, payload, idField, payloadField) {
  if (!grid) return;
  if (_gridIds) {
    var id = _gridIds.get(grid);
    if (!id) {
      id = 'g' + (_nextGridId++);
      _gridIds.set(grid, id);
      payload[payloadField] = grid;
    }
    payload[idField] = id;
  } else {
    payload[idField] = 'g' + (_nextGridId++);
    payload[payloadField] = grid; // no WeakMap: safest to always send
  }
}

function _toLocal(st, defer) {
  // Convert a worker proxy to an in-process solver. With defer=true the solver
  // is built on the next advanceTo (worker died); the monotonic advanceTo
  // contract makes the rebuild exact (it replays from t=0 to the target).
  st.mode = 'local';
  st.ready = true;
  if (!defer) _buildLocal(st);
}

function _buildLocal(st) {
  var Physics = getPhysics();
  var source = st.params.source;
  if (source && source.geometry) Physics.rehydrateFaultGeometry(source.geometry);
  var solver = null;
  if (st.params.coarseGrid && st.params.coarseGrid !== st.params.grid) {
    solver = Physics.createNestedTsunamiSolver(st.params.coarseGrid, st.params.grid, source, st.params.options || {});
  }
  if (!solver) solver = Physics.createNonlinearTsunamiSolver(st.params.grid, source, st.params.options || {});
  st.localSolver = solver;
  if (solver && st.targetT > 0) solver.advanceTo(st.targetT);
}

function create(params) {
  var st = {
    key: params.key,
    params: params,
    mode: 'worker',
    ready: false,
    model: 'nonlinearSWE',
    snapshot: null,
    peaks: {},
    waterDepths: {},
    targetT: 0,
    lastStride: 3,
    lastSentStride: 0,
    localSolver: null,
    disposed: false
  };
  _proxies[st.key] = st;

  var worker = _ensureWorker();
  if (!worker) _toLocal(st, false);
  else {
    var payload = {type: 'init', key: st.key, options: params.options || {},
      checkpoints: params.checkpoints || [], source: _stripFunctions(params.source || null, [])};
    _attachGrid(params.grid, payload, 'gridId', 'grid');
    if (params.coarseGrid && params.coarseGrid !== params.grid) {
      _attachGrid(params.coarseGrid, payload, 'coarseGridId', 'coarseGrid');
    }
    try { worker.postMessage(payload); } catch (err) { _toLocal(st, false); }
  }

  return {
    get model() { return st.model; },
    get isWorker() { return st.mode === 'worker'; },
    get isReady() { return st.ready; },
    advanceTo: function(t) {
      if (st.disposed) return;
      st.targetT = Math.max(0, Number(t) || 0);
      if (st.mode === 'local') {
        if (!st.localSolver) _buildLocal(st);
        if (st.localSolver) st.localSolver.advanceTo(st.targetT);
        return;
      }
      if (!_worker || _workerState === 'dead') { _toLocal(st, true); return; }
      try { _worker.postMessage({type: 'advance', key: st.key, t: st.targetT, stride: st.lastStride}); }
      catch (err) { _toLocal(st, true); }
    },
    getSnapshot: function(stride) {
      if (st.mode === 'local') {
        if (!st.localSolver) return null;
        return st.localSolver.getSnapshot(stride || 1);
      }
      var s = Math.max(1, Math.round(stride || 1));
      if (s !== st.lastSentStride && _worker && st.ready) {
        // Zoom change while paused/quiet: ask for a fresh snapshot at the new
        // stride immediately (stride applies to the next advance post).
        st.lastStride = s;
        try { _worker.postMessage({type: 'advance', key: st.key, t: st.targetT, stride: s, force: true}); } catch (err) { /* noop */ }
        st.lastSentStride = s;
      } else {
        st.lastStride = s;
      }
      return st.snapshot;
    },
    samplePeak: function(lat, lng) {
      if (st.mode === 'local') return st.localSolver ? st.localSolver.samplePeak(lat, lng) : 0;
      var v = st.peaks[_ckKey(lat, lng)];
      return isFinite(v) ? v : 0;
    },
    sampleWaterDepth: function(lat, lng) {
      if (st.mode === 'local') return st.localSolver ? st.localSolver.sampleWaterDepth(lat, lng) : null;
      var v = st.waterDepths[_ckKey(lat, lng)];
      return v === undefined ? null : v;
    },
    setCheckpoints: function(cps) {
      if (st.disposed || !Array.isArray(cps) || !cps.length) return;
      st.params.checkpoints = cps;
      if (st.mode === 'worker' && _worker && st.ready) {
        try { _worker.postMessage({type: 'checkpoints', key: st.key, checkpoints: cps}); } catch (err) { /* noop */ }
      }
    },
    dispose: function() {
      if (st.disposed) return;
      st.disposed = true;
      delete _proxies[st.key];
      if (st.mode === 'worker' && _worker) {
        try { _worker.postMessage({type: 'drop', key: st.key}); } catch (err) { /* noop */ }
      }
      st.localSolver = null;
    }
  };
}

function resetAll() {
  for (var k in _proxies) {
    if (_proxies[k]) { _proxies[k].disposed = true; _proxies[k].localSolver = null; }
  }
  _proxies = Object.create(null);
  if (_worker) {
    try { _worker.postMessage({type: 'reset'}); } catch (err) { /* noop */ }
  }
  // Grid registrations die with the reset; force re-registration.
  _gridIds = (typeof WeakMap === 'function') ? new WeakMap() : null;
}

function isWorkerActive() { return _workerState === 'ready' || _workerState === 'booting'; }

return {
  create: create,
  resetAll: resetAll,
  isWorkerActive: isWorkerActive,
  TSUNAMI_WORKER_V: TSUNAMI_WORKER_V,
  _stripFunctions: _stripFunctions // exported for tests
};
}));
