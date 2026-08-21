// ================================================================
//  Earthquake Simulator Pro v5.5 — Tsunami solver worker driver
//
//  Moves the nonlinear / nested-AMR NLSWE stepping off the main thread.
//  The ENGINE is physics.js itself (Physics.createNonlinearTsunamiSolver /
//  Physics.createNestedTsunamiSolver) — this file is only the messaging
//  driver, so there is exactly one solver implementation whether it runs
//  in a Worker or in-process (tsunami-solver-host.js fallback).
//
//  UMD shape:
//    - inside a classic Worker  -> importScripts(dc3d.js, physics.js) on
//      'boot', then installs the message loop (see bootstrap at bottom)
//    - under node (require)     -> module.exports; tests drive
//      TsunamiWorkerCore.create().handle(msg, post) directly
//    - as a plain browser <script> -> window.TsunamiWorkerCore (unused in
//      production; the main thread talks to tsunami-solver-host.js instead)
//
//  ----------------------- MESSAGE PROTOCOL -----------------------
//  Main -> Worker (structured clone):
//    {type:'boot', dc3dUrl, physicsUrl}   — first message; loads the engine
//    {type:'init', key, gridId, grid?, coarseGridId?, coarseGrid?, source,
//                 options, checkpoints:[{lat,lng}]}
//        Create a solver for one event. Grid payloads are sent only the
//        first time a gridId appears; later inits reuse the registered grid.
//        `source` arrives function-stripped (host side); geometry helper
//        closures are rehydrated here via Physics.rehydrateFaultGeometry.
//    {type:'advance', key, t, stride}     — advanceTo(t); posts a snapshot
//        throttled to ~5 Hz wall per solver (always posts once t is reached
//        and 180 ms have passed since the last post for that solver).
//    {type:'drop', key}                   — dispose one solver
//    {type:'reset'}                       — dispose all solvers + grids
//  Worker -> Main:
//    {type:'booted'}
//    {type:'ready', key, waterDepths:[...], model}
//    {type:'snapshot', key, snapshot, peaks:[...]}   — peaks align with the
//        init checkpoints array (solver.samplePeak per checkpoint)
//    {type:'error', key?, message}
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function() { return require('./physics.js'); });
  } else {
    root.TsunamiWorkerCore = factory(function() { return root.Physics; });
  }
}(typeof self !== 'undefined' ? self : this, function(getPhysics) {
'use strict';

var SNAPSHOT_MIN_INTERVAL_MS = 180; // per-solver post throttle (~5 Hz)

function create() {
  var solvers = Object.create(null);   // key -> {solver, checkpoints, lastPostAt, lastStride}
  var grids = Object.create(null);     // gridId -> grid payload

  function reviveSource(source) {
    if (!source) return source;
    var Physics = getPhysics();
    if (source.geometry) Physics.rehydrateFaultGeometry(source.geometry);
    return source;
  }

  function postError(post, key, err) {
    post({type: 'error', key: key || null, message: String(err && err.message || err)});
  }

  function handle(msg, post) {
    var Physics = getPhysics();
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.type === 'init') {
        if (msg.grid) grids[msg.gridId] = msg.grid;
        if (msg.coarseGrid && msg.coarseGridId) grids[msg.coarseGridId] = msg.coarseGrid;
        var grid = grids[msg.gridId];
        if (!grid) { postError(post, msg.key, 'unknown gridId ' + msg.gridId); return; }
        var source = reviveSource(msg.source);
        var solver = null;
        if (msg.coarseGridId) {
          var coarse = grids[msg.coarseGridId];
          if (coarse && coarse !== grid) solver = Physics.createNestedTsunamiSolver(coarse, grid, source, msg.options || {});
        }
        if (!solver) solver = Physics.createNonlinearTsunamiSolver(grid, source, msg.options || {});
        if (!solver) { postError(post, msg.key, 'solver creation returned null'); return; }
        var cps = Array.isArray(msg.checkpoints) ? msg.checkpoints : [];
        var waterDepths = new Array(cps.length);
        for (var i = 0; i < cps.length; i++) waterDepths[i] = solver.sampleWaterDepth(cps[i].lat, cps[i].lng);
        solvers[msg.key] = {solver: solver, checkpoints: cps, lastPostAt: 0, lastStride: 3};
        post({type: 'ready', key: msg.key, waterDepths: waterDepths, model: solver.model || 'nonlinearSWE'});
        return;
      }
      if (msg.type === 'advance') {
        var st = solvers[msg.key];
        if (!st) return; // dropped or unknown — stay silent, host may re-init
        var target = Math.max(0, Number(msg.t) || 0);
        st.solver.advanceTo(target);
        if (isFinite(msg.stride)) st.lastStride = Math.max(1, Math.round(msg.stride));
        var now = Date.now();
        if (msg.force || now - st.lastPostAt >= SNAPSHOT_MIN_INTERVAL_MS) {
          st.lastPostAt = now;
          var peaks = new Array(st.checkpoints.length);
          for (var pi = 0; pi < st.checkpoints.length; pi++) {
            peaks[pi] = st.solver.samplePeak(st.checkpoints[pi].lat, st.checkpoints[pi].lng);
          }
          post({type: 'snapshot', key: msg.key, snapshot: st.solver.getSnapshot(st.lastStride), peaks: peaks});
        }
        return;
      }
      if (msg.type === 'drop') { delete solvers[msg.key]; return; }
      if (msg.type === 'checkpoints') {
        // The coastline control-point set can finish loading after a solver
        // was created (page-start race) — refresh it and re-send water depths.
        var cst = solvers[msg.key];
        if (!cst || !Array.isArray(msg.checkpoints)) return;
        cst.checkpoints = msg.checkpoints;
        var wds = new Array(cst.checkpoints.length);
        for (var wi = 0; wi < cst.checkpoints.length; wi++) wds[wi] = cst.solver.sampleWaterDepth(cst.checkpoints[wi].lat, cst.checkpoints[wi].lng);
        post({type: 'ready', key: msg.key, waterDepths: wds, model: cst.solver.model || 'nonlinearSWE'});
        return;
      }
      if (msg.type === 'reset') { solvers = Object.create(null); grids = Object.create(null); return; }
    } catch (err) {
      postError(post, msg.key, err);
    }
  }

  return {handle: handle, _solvers: function() { return solvers; }, _grids: function() { return grids; }};
}

return {create: create, SNAPSHOT_MIN_INTERVAL_MS: SNAPSHOT_MIN_INTERVAL_MS};
}));

// ---- WORKER BOOTSTRAP — only inside a classic Worker scope ----
(function() {
  if (typeof importScripts !== 'function') return; // not a worker
  if (typeof module === 'object' && module.exports) return; // node test import
  var core = null;
  self.onmessage = function(e) {
    var msg = e.data || {};
    if (msg.type === 'boot') {
      try {
        importScripts(msg.dc3dUrl, msg.physicsUrl);
        core = self.TsunamiWorkerCore.create();
        self.postMessage({type: 'booted'});
      } catch (err) {
        self.postMessage({type: 'error', key: null, message: 'boot failed: ' + String(err && err.message || err)});
      }
      return;
    }
    if (!core) {
      self.postMessage({type: 'error', key: msg.key || null, message: 'worker not booted'});
      return;
    }
    core.handle(msg, function(reply) { self.postMessage(reply); });
  };
})();
