(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WaveformData = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var SCHEMA = 'quake-sim-waveform-v1';
  var COMPONENTS = ['z', 'n', 'e'];

  function isFiniteArray(value) {
    if (!Array.isArray(value) || value.length < 2) return false;
    for (var i = 0; i < value.length; i++) if (!isFinite(Number(value[i]))) return false;
    return true;
  }

  function validate(payload) {
    var errors = [], warnings = [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {valid:false, researchReady:false, errors:['invalid-payload'], warnings:[]};
    }
    if (payload._schema !== SCHEMA) errors.push('unsupported-schema');
    if (payload.units !== 'gal') errors.push('acceleration-unit-must-be-gal');
    var rate = Number(payload.sampleRateHz);
    if (!(rate > 0 && rate <= 5000)) errors.push('invalid-sample-rate');
    var components = payload.components || {}, lengths = [];
    COMPONENTS.forEach(function(name) {
      var component = components[name];
      if (!component || !isFiniteArray(component.samples)) errors.push('missing-or-invalid-component-' + name);
      else {
        lengths.push(component.samples.length);
        if (!/^[A-Fa-f0-9]{64}$/.test(String(component.sha256 || ''))) warnings.push('missing-component-hash-' + name);
      }
    });
    if (lengths.length === 3 && (lengths[0] !== lengths[1] || lengths[1] !== lengths[2])) errors.push('component-length-mismatch');
    var provenance = payload.provenance || {};
    if (!provenance.provider) errors.push('missing-provider');
    if (!/^https?:\/\//i.test(String(provenance.sourceUrl || ''))) errors.push('missing-source-url');
    if (!provenance.retrievedAt || !isFinite(Date.parse(provenance.retrievedAt))) errors.push('missing-retrieval-time');
    var quality = payload.quality || {};
    if (quality.responseRemoved !== true) errors.push('instrument-response-not-removed');
    if (quality.sourceGapCount > 0) warnings.push('source-gaps-present');
    if (quality.deliveryResampled) warnings.push('delivery-resampled');
    var ready = errors.length === 0 && quality.researchReady === true && warnings.indexOf('source-gaps-present') < 0;
    return {valid:errors.length === 0, researchReady:ready, errors:errors, warnings:warnings};
  }

  function toObservedMotion(payload) {
    var result = validate(payload);
    if (!result.valid) throw new TypeError(result.errors.join(', '));
    return {
      sampleRate:Number(payload.sampleRateHz),
      components:{
        x:payload.components.n.samples.map(Number),
        y:payload.components.e.samples.map(Number),
        z:payload.components.z.samples.map(Number)
      },
      source:[payload.station && payload.station.id, payload.provenance && payload.provenance.provider].filter(Boolean).join(' / '),
      provenance:payload.provenance,
      quality:{researchReady:result.researchReady, warnings:result.warnings.slice()}
    };
  }

  function legacyTrace(payload) {
    if (payload && Array.isArray(payload.data) && payload.data.length) return payload.data[0];
    var component = payload && payload.components && (payload.components.z || payload.components.n || payload.components.e);
    if (!component) return null;
    return {
      id:(payload.station && payload.station.id || '-') + '.' + (component.channel || '?'),
      samples:component.samples, sampling_rate:payload.sampleRateHz,
      npts:component.samples.length, starttime:payload.startTime, unit:payload.units
    };
  }

  return {SCHEMA:SCHEMA, validate:validate, toObservedMotion:toObservedMotion, legacyTrace:legacyTrace};
});
