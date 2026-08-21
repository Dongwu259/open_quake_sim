'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const DataCatalog = require('../public/data-catalog.js');

const manifest = JSON.parse(fs.readFileSync('public/geojson/research_data_manifest.json', 'utf8'));

test('bundled research manifest is valid but honestly degraded', () => {
  const result = DataCatalog.validateManifest(manifest);
  assert.equal(result.valid, true);
  assert.equal(result.researchReady, false);
  // terrain is certified (GEBCO 2025 resample); the remaining roles still block.
  assert.ok(!result.blockingRoles.includes('terrain'));
  assert.ok(result.blockingRoles.includes('coastal-elevation'));
  assert.ok(result.blockingRoles.includes('vs30'));
  assert.ok(result.blockingRoles.includes('strong-motion'));
});

test('runtime certification requires continuous verified terrain and every v5.1 dataset', () => {
  const result = DataCatalog.assessRuntime(manifest, {
    terrain:{meta:{quality:'official',license:'open',verticalDatum:'JGD2011',continuousTopoBathy:true,dataset:'test'}},
    vs30:{meta:{quality:'official',license:'terms',dataset:'J-SHIS'}},
    strongMotionReady:true,
    tsunamiObservationsReady:true
  });
  assert.equal(result.researchReady, true);
  assert.deepEqual(result.blockers, []);
});

test('demonstration terrain cannot pass runtime certification', () => {
  const result = DataCatalog.assessRuntime(manifest, {
    terrain:{meta:{quality:'demonstration',license:'demo',verticalDatum:'approximate',continuousTopoBathy:false}},
    vs30:null,strongMotionReady:false,tsunamiObservationsReady:false
  });
  assert.equal(result.researchReady, false);
  assert.ok(result.blockers.includes('coastal-elevation'));
});
