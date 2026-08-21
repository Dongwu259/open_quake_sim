(function(root, factory) {
  var waveformApi = typeof require === 'function' ? require('./waveform-data.js') : root.WaveformData;
  var api = factory(waveformApi);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StrongMotionData = api;
})(typeof self !== 'undefined' ? self : this, function(WaveformData) {
  'use strict';
  var SCHEMA='quake-sim-strong-motion-event-v1';
  function validUrl(value){return /^https?:\/\//i.test(String(value||''));}
  function validate(payload){
    var errors=[],warnings=[],ids=Object.create(null),readyRecords=0;
    if(!payload||payload._schema!==SCHEMA)return {valid:false,researchReady:false,errors:['unsupported-schema'],warnings:[],pairs:[]};
    var event=payload.event||{};if(!event.id||!isFinite(Number(event.mw))||!isFinite(Number(event.lat))||!isFinite(Number(event.lng))||!isFinite(Number(event.depthKm))||!event.originTime||!isFinite(Date.parse(event.originTime))||!validUrl(event.sourceUrl))errors.push('invalid-event-metadata');
    var provenance=payload.provenance||{};if(!provenance.provider||!validUrl(provenance.sourceUrl)||!provenance.license||!provenance.retrievedAt||!isFinite(Date.parse(provenance.retrievedAt)))errors.push('incomplete-provenance');
    if(!Array.isArray(payload.records)||!payload.records.length)errors.push('records-missing');
    (payload.records||[]).forEach(function(record,index){
      var id=String(record.stationId||'');if(!id||ids[id+'|'+record.locationType])errors.push('duplicate-or-missing-record-'+index);ids[id+'|'+record.locationType]=true;
      if(!record.siteId||['surface','borehole'].indexOf(record.locationType)<0)errors.push('invalid-location-'+index);
      if(record.locationType==='borehole'&&!(Number(record.sensorDepthM)>0))errors.push('borehole-depth-missing-'+index);
      if(!record.station||!isFinite(Number(record.station.lat))||!isFinite(Number(record.station.lng)))errors.push('station-coordinates-missing-'+index);
      var result=WaveformData&&WaveformData.validate?WaveformData.validate(record.waveform):{valid:false,researchReady:false,errors:['waveform-parser-unavailable'],warnings:[]};
      result.errors.forEach(function(error){errors.push('record-'+index+':'+error);});
      result.warnings.forEach(function(warning){warnings.push('record-'+index+':'+warning);});
      if(result.researchReady)readyRecords++;
    });
    var pairs=pairSurfaceBorehole(payload.records||[]);
    if(!pairs.length)warnings.push('no-surface-borehole-pairs');
    var requirePairs=!payload.quality||payload.quality.requireSurfaceBoreholePairs!==false;
    var ready=errors.length===0&&readyRecords===(payload.records||[]).length&&(!requirePairs||pairs.length>0)&&payload.quality&&payload.quality.frozen===true;
    return {valid:errors.length===0,researchReady:!!ready,errors:errors,warnings:warnings,pairs:pairs,readyRecords:readyRecords};
  }
  function pairSurfaceBorehole(records){
    var sites=Object.create(null);(records||[]).forEach(function(record){var site=sites[record.siteId]||(sites[record.siteId]={siteId:record.siteId,surface:[],borehole:[]});site[record.locationType].push(record);});
    return Object.keys(sites).filter(function(id){return sites[id].surface.length&&sites[id].borehole.length;}).map(function(id){return sites[id];});
  }
  function pgvAndDuration(motion){
    var c=motion.components,n=c.x.length,dt=1/motion.sampleRate,means={x:0,y:0,z:0};['x','y','z'].forEach(function(k){for(var i=0;i<n;i++)means[k]+=Number(c[k][i])||0;means[k]/=n;});
    var velocity={x:0,y:0,z:0},pgv=0,arias=[],sum=0;
    for(var i=0;i<n;i++){var vectorSq=0;['x','y','z'].forEach(function(k){var a=(Number(c[k][i])||0)-means[k];velocity[k]+=a*dt;vectorSq+=a*a;});pgv=Math.max(pgv,Math.sqrt(velocity.x*velocity.x+velocity.y*velocity.y+velocity.z*velocity.z));sum+=vectorSq*dt;arias.push(sum);}
    var t5=0,t95=0;if(sum>0){for(var j=0;j<n;j++){if(!t5&&arias[j]>=sum*.05)t5=j*dt;if(!t95&&arias[j]>=sum*.95){t95=j*dt;break;}}}
    return {pgvVectorCms:pgv,duration5to95Sec:Math.max(0,t95-t5)};
  }
  function analyze(payload,physics){
    var validation=validate(payload);if(!validation.valid)throw new TypeError(validation.errors.join(', '));if(!physics||typeof physics.analyzeObservedMotion3C!=='function')throw new TypeError('physics analyzer unavailable');
    var rows=payload.records.map(function(record){var motion=WaveformData.toObservedMotion(record.waveform),analysis=physics.analyzeObservedMotion3C(motion),extra=pgvAndDuration(motion);return {stationId:record.stationId,siteId:record.siteId,locationType:record.locationType,sensorDepthM:Number(record.sensorDepthM)||0,intensity:analysis.intensity,pgaVectorGal:analysis.pgaVectorGal,pgvVectorCms:extra.pgvVectorCms,duration5to95Sec:extra.duration5to95Sec,spectra:analysis.spectra,station:record.station};});
    return {schema:'quake-sim-strong-motion-analysis-v1',event:payload.event,researchReady:validation.researchReady,pairs:validation.pairs.length,records:rows};
  }
  return {SCHEMA:SCHEMA,validate:validate,pairSurfaceBorehole:pairSurfaceBorehole,analyze:analyze,pgvAndDuration:pgvAndDuration};
});
