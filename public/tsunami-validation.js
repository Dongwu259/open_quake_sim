(function(root,factory){var api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;if(root)root.TsunamiValidation=api;})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  var SCHEMA='quake-sim-tsunami-observations-v1',LEVELS=['none','advisory','warning','major'];
  function validUrl(value){return /^https?:\/\//i.test(String(value||''));}
  function validate(dataset){
    var errors=[],warnings=[],eventIds=Object.create(null),observationCount=0,areaCount=0,directCount=0;
    if(!dataset||dataset._schema!==SCHEMA)return {valid:false,researchReady:false,errors:['unsupported-schema'],warnings:[],eventCount:0,observationCount:0,areaCount:0,directCount:0};
    if(!Array.isArray(dataset.events)||!dataset.events.length)errors.push('events-missing');
    (dataset.events||[]).forEach(function(event,ei){
      if(!event.id||eventIds[event.id])errors.push('duplicate-event-'+ei);eventIds[event.id]=true;
      if(!event.originTime||!isFinite(Date.parse(event.originTime))||!isFinite(Number(event.mw))||!isFinite(Number(event.lat))||!isFinite(Number(event.lng))||!isFinite(Number(event.depthKm))||!validUrl(event.sourceUrl))errors.push('invalid-event-'+ei);
      var sources=Object.create(null);(event.sources||[]).forEach(function(source){if(!source.id||!validUrl(source.url)||!source.citation)errors.push('invalid-source-'+event.id);sources[source.id]=source;});
      (event.observations||[]).forEach(function(obs,oi){observationCount++;if(!obs.id||!['tide-gauge','offshore-gauge','runup','inundation'].includes(obs.type)||!isFinite(Number(obs.lat))||!isFinite(Number(obs.lng))||!(Number(obs.peakHeightM)>=0)||!sources[obs.sourceId])errors.push('invalid-observation-'+event.id+'-'+oi);if(obs.type!=='runup'&&!obs.verticalDatum)warnings.push('vertical-datum-missing-'+event.id+'-'+obs.id);if(obs.quality==='direct')directCount++;});
      (event.forecastAreas||[]).forEach(function(area,ai){areaCount++;if(!/^\d{3}$/.test(String(area.code||''))||!LEVELS.includes(area.observedLevel)||!sources[area.sourceId])errors.push('invalid-area-'+event.id+'-'+ai);if(area.quality==='direct')directCount++;});
    });
    var ready=errors.length===0&&(dataset.events||[]).length>=3&&observationCount>=10&&areaCount>=10&&directCount===observationCount+areaCount&&dataset.quality&&dataset.quality.frozen===true;
    if(!ready)warnings.push('direct-citations-or-coverage-incomplete');
    return {valid:errors.length===0,researchReady:ready,errors,warnings,eventCount:(dataset.events||[]).length,observationCount,areaCount,directCount};
  }
  function levelIndex(level){var index=LEVELS.indexOf(level);return index<0?0:index;}
  function metrics(residuals){if(!residuals.length)return {count:0,bias:null,rms:null,mae:null};var sum=0,sumSq=0,sumAbs=0;residuals.forEach(function(v){sum+=v;sumSq+=v*v;sumAbs+=Math.abs(v);});return {count:residuals.length,bias:sum/residuals.length,rms:Math.sqrt(sumSq/residuals.length),mae:sumAbs/residuals.length};}
  function evaluate(dataset,predictions){
    var validation=validate(dataset);if(!validation.valid)throw new TypeError(validation.errors.join(', '));var byEvent=Object.create(null);(predictions&&predictions.events||[]).forEach(function(event){byEvent[event.id]=event;});
    var matrix=LEVELS.map(function(){return [0,0,0,0];}),heightByType={},arrivalResiduals=[],missing=[],missingObservations=0,missingObservationsByEvent={};
    dataset.events.forEach(function(event){var predicted=byEvent[event.id];if(!predicted){missing.push(event.id);return;}var areas=Object.create(null),points=Object.create(null);(predicted.forecastAreas||[]).forEach(function(area){areas[String(area.code)]=area;});(predicted.observations||[]).forEach(function(obs){points[obs.id]=obs;});
      (event.forecastAreas||[]).forEach(function(observed){var result=areas[String(observed.code)],actual=levelIndex(observed.observedLevel),forecast=levelIndex(result&&result.predictedLevel||'none');matrix[actual][forecast]++;});
      var eventMissing=0;(event.observations||[]).forEach(function(observed){var result=points[observed.id],predictedHeight=result&&Number(result.peakHeightM);if(!result||!isFinite(predictedHeight)){eventMissing++;return;}var residual=predictedHeight-Number(observed.peakHeightM);(heightByType[observed.type]||(heightByType[observed.type]=[])).push(residual);if(observed.arrivalTime&&result.arrivalTime&&isFinite(Date.parse(observed.arrivalTime))&&isFinite(Date.parse(result.arrivalTime)))arrivalResiduals.push((Date.parse(result.arrivalTime)-Date.parse(observed.arrivalTime))/60000);});
      if(eventMissing){missingObservations+=eventMissing;missingObservationsByEvent[event.id]=eventMissing;}
    });
    var heightMetrics={};Object.keys(heightByType).forEach(function(type){heightMetrics[type]=metrics(heightByType[type]);});var hits=0,misses=0,falseAlarms=0,total=0;for(var actual=0;actual<4;actual++)for(var forecast=0;forecast<4;forecast++){var n=matrix[actual][forecast];total+=n;if(actual>0&&forecast>0)hits+=n;if(actual>0&&forecast===0)misses+=n;if(actual===0&&forecast>0)falseAlarms+=n;}
    return {schema:'quake-sim-tsunami-validation-report-v1',createdAt:new Date().toISOString(),datasetResearchReady:validation.researchReady,confusionMatrix:{labels:LEVELS,matrix},classification:{total,hits,misses,falseAlarms,hitRate:hits+misses?hits/(hits+misses):null,falseAlarmRate:falseAlarms+hits?falseAlarms/(falseAlarms+hits):null},heightByType:heightMetrics,arrivalMinutes:metrics(arrivalResiduals),missingEvents:missing,missingObservations:missingObservations,missingObservationsByEvent:missingObservationsByEvent};
  }
  return {SCHEMA,LEVELS:LEVELS.slice(),validate,evaluate};
});
