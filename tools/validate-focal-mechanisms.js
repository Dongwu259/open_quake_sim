#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const Physics=require('../public/physics.js');

const observed=JSON.parse(fs.readFileSync(path.join(__dirname,'../public/geojson/observed.json'),'utf8'));
function angle(a,b){
  const dot=Math.max(-1,Math.min(1,a.x*b.x+a.y*b.y+a.z*b.z));
  return Math.acos(Math.abs(dot))*180/Math.PI;
}
function axisMisfit(reference,candidate){
  return Math.sqrt(['P','T','B'].reduce((s,k)=>s+angle(reference.axes[k].vector,candidate.axes[k].vector)**2,0)/3);
}
const rows=[];
for(const [id,e] of Object.entries(observed)){
  if(id.startsWith('_')||!e||![e.strike,e.dip,e.rake].every(Number.isFinite)) continue;
  const reference=Physics.focalMechanism({strike:e.strike,dip:e.dip,rake:e.rake,mw:e.mw||e.mag});
  const recovered=Physics.focalMechanismFromTensor({tensor:reference.tensor,momentNm:reference.momentNm});
  rows.push({id,sourceClass:e.src||'unknown',estimated:!!e.estimated,axisRmsDeg:axisMisfit(reference,recovered),
    planeNormalDeg:Math.min(angle(reference.plane1.normal,recovered.plane1.normal),angle(reference.plane1.normal,recovered.plane2.normal))});
}
function rms(field){return Math.sqrt(rows.reduce((s,r)=>s+r[field]*r[field],0)/Math.max(1,rows.length));}
const report={schema:'quake-sim-focal-validation-v1',generatedAt:new Date().toISOString(),events:rows.length,
  reference:'public/geojson/observed.json: published USGS/F-net/GCMT strike/dip/rake compilation',
  scope:'coordinate-convention and tensor-to-mechanism conversion regression; not an independent waveform inversion validation',
  metrics:{axisRmsDeg:rms('axisRmsDeg'),planeNormalRmsDeg:rms('planeNormalDeg')},rows};
if(process.argv.includes('--json')) console.log(JSON.stringify(report,null,2));
else console.log(`Focal validation: ${report.events} events, axis RMS ${report.metrics.axisRmsDeg.toExponential(3)} deg, plane RMS ${report.metrics.planeNormalRmsDeg.toExponential(3)} deg`);
if(!rows.length||report.metrics.axisRmsDeg>1e-5||report.metrics.planeNormalRmsDeg>1e-5) process.exitCode=1;
