// ================================================================
//  Earthquake Simulator Pro v5.7 — Ensemble intensity-field worker driver
//
//  Moves large Monte Carlo ensembles (Physics.ensembleIntensityField with
//  >= 100 members; the shipped 40-member overlay stays on the main thread)
//  off the main thread. The ENGINE is physics.js itself — this file is only
//  a messaging driver, exactly like tsunami-worker.js.
//
//  UMD shape:
//    - inside a classic Worker -> reads the physics.js URL from the query
//      string (?physics=physics.js%3Fv%3D...), importScripts it, installs
//      the message loop
//    - under node (require)    -> module.exports; tests drive
//      EnsembleWorkerCore.handle(msg, post) directly
//    - as a plain <script>     -> window.EnsembleWorkerCore (diagnostics)
//
//  ----------------------- MESSAGE PROTOCOL -----------------------
//  Main -> Worker:
//    {type:'boot', physicsUrl}                       — first message
//    {id, type:'run', context, stations, options}    — one ensemble run
//  Worker -> Main:
//    {type:'booted'}
//    {id, type:'result', result}
//    {id, type:'error', message}
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function() { return require('./physics.js'); });
  } else {
    root.EnsembleWorkerCore = factory(function() { return root.Physics; });
  }
}(typeof self !== 'undefined' ? self : this, function(getPhysics) {
'use strict';

var Core = {
  booted: false,
  handle: function(msg, post) {
    msg = msg || {};
    if (msg.type === 'boot') {
      this.booted = true;
      post({ type: 'booted' });
      return;
    }
    if (msg.type !== 'run') return;
    try {
      var Physics = getPhysics();
      var result = Physics.ensembleIntensityField(msg.context, msg.stations, msg.options);
      post({ id: msg.id, type: 'result', result: result });
    } catch (e) {
      post({ id: msg.id, type: 'error', message: String((e && e.message) || e) });
    }
  }
};

if (typeof importScripts === 'function' && typeof window === 'undefined' && typeof module === 'undefined') {
  // classic worker mode: locate physics.js from the query string, boot, loop
  var qs = (self.location && self.location.search) || '';
  var m = qs.match(/[?&]physics=([^&]+)/);
  importScripts(m ? decodeURIComponent(m[1]) : 'physics.js');
  self.onmessage = function(ev) { Core.handle(ev.data, self.postMessage.bind(self)); };
}

return Core;
}));
