'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Tsunami=require('../public/tsunami-validation.js');
const dataset=JSON.parse(fs.readFileSync('public/geojson/historical_tsunami_observations.json','utf8'));
test('direct-curation v2 dataset is structurally valid and research-certified',()=>{const result=Tsunami.validate(dataset);assert.equal(result.valid,true);assert.equal(result.researchReady,true);assert.equal(result.eventCount,5);assert.ok(result.observationCount>=50);assert.ok(result.areaCount>=20);
  // every single record is direct-cited — the R5-6 contract
  assert.equal(result.directCount,result.observationCount+result.areaCount);});
test('evaluator separates warning confusion, runup and tide-gauge errors',()=>{const predictions={events:dataset.events.map(event=>({id:event.id,forecastAreas:event.forecastAreas.map(area=>({code:area.code,predictedLevel:area.observedLevel})),observations:event.observations.map(obs=>({id:obs.id,peakHeightM:obs.peakHeightM}))}))};const report=Tsunami.evaluate(dataset,predictions);assert.equal(report.classification.misses,0);assert.equal(report.classification.hits,dataset.events.reduce((n,e)=>n+e.forecastAreas.length,0));assert.equal(report.heightByType.runup.rms,0);assert.equal(report.heightByType['tide-gauge'].rms,0);});
test('arrival times are ISO and JST-consistent for the 2011 anchors',()=>{
  const ev=dataset.events.find(e=>e.id==='tokachi2003');
  const kushiro=ev.observations.find(o=>o.id==='tokachi2003-釧路');
  assert.equal(kushiro.arrivalTime,'2003-09-25T20:06:00.000Z'); // 05:06 JST per the frozen monthly record
  const e2=dataset.events.find(e=>e.id==='hokkaido1993');
  const esashi=e2.observations.find(o=>o.id==='hokkaido1993-esashi');
  assert.equal(esashi.arrivalTime,'1993-07-12T13:24:12.000Z'); // ~7 min after origin per JMA Sapporo
});
