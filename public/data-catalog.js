(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ResearchDataCatalog = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var SCHEMA = 'quake-sim-research-data-manifest-v1';
  var REQUIRED_ROLES = ['terrain', 'coastal-elevation', 'vs30', 'strong-motion', 'tsunami-observations'];
  var VALID_STATES = ['ready', 'degraded', 'missing'];

  function validUrl(value) { return /^https?:\/\//i.test(String(value || '')); }
  function validHash(value) { return /^[a-f0-9]{64}$/i.test(String(value || '')); }
  function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }

  function validateResource(resource) {
    var errors = [], warnings = [];
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return {valid:false, errors:['invalid-resource'], warnings:[]};
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(resource.id || ''))) errors.push('invalid-id');
    if (!resource.role) errors.push('missing-role');
    if (VALID_STATES.indexOf(resource.state) < 0) errors.push('invalid-state');
    if (!resource.dataset) errors.push('missing-dataset');
    if (!validUrl(resource.sourceUrl)) errors.push('missing-source-url');
    if (!resource.license) errors.push('missing-license');
    if (!validDate(resource.releaseDate)) errors.push('missing-release-date');
    if (!resource.crs) errors.push('missing-crs');
    if (!resource.processing) errors.push('missing-processing');
    if (resource.state === 'ready' && !validHash(resource.sha256)) errors.push('ready-resource-needs-sha256');
    if (!resource.verticalDatum && (resource.role === 'terrain' || resource.role === 'coastal-elevation' || resource.role === 'tsunami-observations')) warnings.push('vertical-datum-not-declared');
    if (resource.state !== 'ready' && resource.researchReady === true) errors.push('non-ready-resource-marked-research-ready');
    if (resource.state === 'ready' && resource.researchReady !== true) warnings.push('ready-resource-not-certified');
    return {valid:errors.length === 0, errors:errors, warnings:warnings};
  }

  function validateManifest(manifest) {
    var errors = [], warnings = [], ids = Object.create(null), roles = Object.create(null);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return {valid:false, researchReady:false, errors:['invalid-manifest'], warnings:[], byRole:{}};
    if (manifest._schema !== SCHEMA) errors.push('unsupported-schema');
    if (!validDate(manifest.snapshotDate)) errors.push('invalid-snapshot-date');
    if (!Array.isArray(manifest.resources)) errors.push('resources-missing');
    (manifest.resources || []).forEach(function(resource) {
      var result = validateResource(resource), prefix = resource && resource.id || '?';
      result.errors.forEach(function(error) { errors.push(prefix + ':' + error); });
      result.warnings.forEach(function(warning) { warnings.push(prefix + ':' + warning); });
      if (ids[prefix]) errors.push(prefix + ':duplicate-id');
      ids[prefix] = true;
      (roles[resource.role] || (roles[resource.role] = [])).push(resource);
    });
    REQUIRED_ROLES.forEach(function(role) { if (!roles[role]) warnings.push(role + ':role-missing'); });
    var blocking = REQUIRED_ROLES.filter(function(role) {
      return !roles[role] || !roles[role].some(function(resource) { return resource.state === 'ready' && resource.researchReady === true; });
    });
    return {valid:errors.length === 0, researchReady:errors.length === 0 && blocking.length === 0, errors:errors, warnings:warnings, blockingRoles:blocking, byRole:roles};
  }

  function assessRuntime(manifest, runtime) {
    var validation = validateManifest(manifest), blockers = validation.blockingRoles ? validation.blockingRoles.slice() : REQUIRED_ROLES.slice();
    runtime = runtime || {};
    function replace(role, ready, reason) {
      var index = blockers.indexOf(role);
      if (ready && index >= 0) blockers.splice(index, 1);
      if (!ready && index < 0) blockers.push(role);
      return {role:role, ready:!!ready, reason:reason || ''};
    }
    var checks = [];
    if (Object.prototype.hasOwnProperty.call(runtime, 'terrain')) {
      var terrainMeta = runtime.terrain && runtime.terrain.meta || {};
      checks.push(replace('terrain', !!runtime.terrain && ['official','research','user-verified'].indexOf(terrainMeta.quality) >= 0 && !!terrainMeta.license && !!terrainMeta.verticalDatum, terrainMeta.dataset || 'terrain-fallback'));
      checks.push(replace('coastal-elevation', !!runtime.terrain && terrainMeta.continuousTopoBathy === true && !!terrainMeta.verticalDatum, 'continuous-topo-bathy-required'));
    }
    if (Object.prototype.hasOwnProperty.call(runtime, 'vs30')) {
      var vsMeta = runtime.vs30 && runtime.vs30.meta || {};
      checks.push(replace('vs30', !!runtime.vs30 && ['official','research','user-verified'].indexOf(vsMeta.quality) >= 0 && !!vsMeta.license, vsMeta.dataset || 'vs30-fallback'));
    }
    if (Object.prototype.hasOwnProperty.call(runtime, 'strongMotionReady')) checks.push(replace('strong-motion', runtime.strongMotionReady === true, 'event-package-required'));
    if (Object.prototype.hasOwnProperty.call(runtime, 'tsunamiObservationsReady')) checks.push(replace('tsunami-observations', runtime.tsunamiObservationsReady === true, 'historical-observations-required'));
    return {
      valid:validation.valid,
      researchReady:validation.valid && blockers.length === 0,
      certification:validation.valid && blockers.length === 0 ? 'research-ready' : 'degraded',
      blockers:blockers,
      checks:checks,
      errors:validation.errors,
      warnings:validation.warnings
    };
  }

  return {SCHEMA:SCHEMA, REQUIRED_ROLES:REQUIRED_ROLES.slice(), validateResource:validateResource, validateManifest:validateManifest, assessRuntime:assessRuntime};
});
