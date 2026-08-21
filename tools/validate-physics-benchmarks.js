'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const DC3D = require('../public/dc3d');
const Physics = require('../public/physics');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/geojson/physics_benchmarks.json'), 'utf8'));
let checks = 0;
function close(actual, expected, abs, rel, label) {
  const limit = Math.max(abs || 0, (rel || 0) * Math.abs(expected));
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= limit,
    `${label}: ${actual} differs from ${expected} by ${Math.abs(actual-expected)} > ${limit}`);
  checks++;
}

for (const testCase of fixture.dc3d) {
  const actual = DC3D.surfaceDisplacement(testCase.input);
  assert.equal(actual.success, 0, `${testCase.id}: DC3D singular status`);
  for (const component of ['ux','uy','uz']) close(actual[component], testCase.expected[component],
    testCase.tolerance.absolute, testCase.tolerance.relative, `${testCase.id}.${component}`);
}

const tt = fixture.layeredTravelTime;
close(Physics.layeredTravelTime(tt.input.horizontalKm,tt.input.depthKm,'P',tt.input.surfaceVp),tt.expected.pSeconds,tt.toleranceSeconds,0,'layered.P');
close(Physics.layeredTravelTime(tt.input.horizontalKm,tt.input.depthKm,'S',tt.input.surfaceVs),tt.expected.sSeconds,tt.toleranceSeconds,0,'layered.S');

const jma=fixture.jmaThreeComponent,n=jma.input.samples,rate=jma.input.sampleRate;
const components={
  x:Array.from({length:n},(_,i)=>100*Math.sin(2*Math.PI*i/100)),
  y:Array.from({length:n},(_,i)=>50*Math.sin(2*Math.PI*i/80)),
  z:Array.from({length:n},(_,i)=>25*Math.sin(2*Math.PI*i/60))
};
close(Physics.calcJmaIntensity3C(components,rate),jma.expectedIntensity,jma.tolerance,0,'jma3c');

const rs=fixture.responseSpectrum;
const acceleration=Array.from({length:rs.input.samples},(_,i)=>100*Math.sin(2*Math.PI*i/100));
const spectra=Physics.sdofResponseSpectrum(acceleration,rs.input.sampleRate,[0.5,1,2],rs.input.damping);
for(const result of spectra)close(result.psaGal,rs.expectedPsaGal[String(result.period)],0,rs.relativeTolerance,`psa.${result.period}`);

// Moment conservation is evaluated at several magnitudes and mesh shapes.
for(const mw of [6.5,7.5,8.5,9.1]){
  const geometry=Physics.genSubSources(38,143,mw,190,15,20,2.8,{sourceType:'interplate',randomSeed:42});
  const sum=geometry.subs.reduce((total,patch)=>total+patch.moment,0);
  close(sum,Physics.seismicMoment(mw),1e-3,2e-14,`moment.Mw${mw}`);
}

console.log(`Physics reference benchmarks passed: ${checks} numerical checks.`);
