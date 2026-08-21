// Finite-fault import, normalization and validation (standard JSON, GeoJSON, SRCMOD FSP).
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FiniteFault = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var SCHEMA = 'quake-sim-finite-fault-v1';
  var MAX_PATCHES = 20000;

  function number(value) {
    var out = Number(value);
    return isFinite(out) ? out : null;
  }
  function first(object, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (object && object[keys[i]] != null) {
        var out = number(object[keys[i]]);
        if (out != null) return out;
      }
    }
    return null;
  }
  function textHash(value) {
    var text = String(value || ''), hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }
  function momentMagnitude(momentNm) {
    return (Math.log10(Math.max(1, momentNm)) - 9.1) / 1.5;
  }
  function seismicMoment(mw) {
    return Math.pow(10, 1.5 * mw + 9.1);
  }
  function wrap360(value) {
    return ((Number(value) % 360) + 360) % 360;
  }
  function wrap180(value) {
    return ((Number(value) + 180) % 360 + 360) % 360 - 180;
  }
  function point(value, depthUnit, fallbackDepth) {
    var lat, lng, depth;
    if (Array.isArray(value)) {
      lng = number(value[0]); lat = number(value[1]); depth = number(value[2]);
    } else {
      lat = first(value, ['lat','latitude']); lng = first(value, ['lng','lon','longitude']);
      depth = first(value, ['depthKm','depth','z']);
    }
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new TypeError('Invalid finite-fault corner coordinate');
    }
    if (depth == null) depth = number(fallbackDepth);
    if (depth == null) depth = 0;
    if (String(depthUnit || 'km').toLowerCase() === 'm') depth /= 1000;
    if (depth < -12 || depth > 800) throw new TypeError('Finite-fault depth is outside supported range');
    return {lat:lat, lng:lng, depthKm:depth, depth:depth};
  }
  function localVector(origin, target) {
    var north = (target.lat - origin.lat) * 111.32;
    var east = (target.lng - origin.lng) * 111.32 * Math.max(0.1, Math.cos(origin.lat * Math.PI / 180));
    return {x:north, y:east, z:target.depthKm - origin.depthKm};
  }
  function cross(a, b) {
    return {x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x};
  }
  function norm(v) { return Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z); }
  function triangleArea(a, b, c) {
    var ab=localVector(a,b), ac=localVector(a,c);
    return 0.5 * norm(cross(ab,ac));
  }
  function quadArea(corners) {
    return triangleArea(corners[0],corners[1],corners[2]) + triangleArea(corners[0],corners[2],corners[3]);
  }
  function centerOf(corners) {
    var out={lat:0,lng:0,depthKm:0};
    for(var i=0;i<corners.length;i++) { out.lat+=corners[i].lat;out.lng+=corners[i].lng;out.depthKm+=corners[i].depthKm; }
    out.lat/=corners.length;out.lng/=corners.length;out.depthKm/=corners.length;out.depth=out.depthKm;
    return out;
  }
  function offsetPoint(center, strikeDeg, dipDeg, alongKm, downDipKm) {
    var strike=strikeDeg*Math.PI/180,dip=dipDeg*Math.PI/180,dipDir=strike+Math.PI/2;
    var north=alongKm*Math.cos(strike)+downDipKm*Math.cos(dip)*Math.cos(dipDir);
    var east=alongKm*Math.sin(strike)+downDipKm*Math.cos(dip)*Math.sin(dipDir);
    var lat=center.lat+north/111.32;
    var lng=center.lng+east/(111.32*Math.max(0.1,Math.cos(center.lat*Math.PI/180)));
    var depth=center.depthKm+downDipKm*Math.sin(dip);
    return {lat:lat,lng:lng,depthKm:depth,depth:depth};
  }
  function cornersFromCenter(center, strike, dip, lengthKm, widthKm) {
    return [offsetPoint(center,strike,dip,-lengthKm/2,-widthKm/2),
      offsetPoint(center,strike,dip,lengthKm/2,-widthKm/2),
      offsetPoint(center,strike,dip,lengthKm/2,widthKm/2),
      offsetPoint(center,strike,dip,-lengthKm/2,widthKm/2)];
  }
  function weightedDirection(patches, field, axial) {
    var x=0,y=0,total=0,mult=axial?2:1;
    for(var i=0;i<patches.length;i++) {
      var angle=number(patches[i][field]);if(angle==null)continue;
      var weight=Math.max(0,patches[i].momentNm||patches[i].areaKm2||1),rad=angle*mult*Math.PI/180;
      x+=Math.cos(rad)*weight;y+=Math.sin(rad)*weight;total+=weight;
    }
    if(!total)return 0;
    var result=Math.atan2(y,x)*180/Math.PI/mult;
    return axial?wrap360(result):wrap180(result);
  }
  function bilinear(corners, along, down) {
    along=Math.max(0,Math.min(1,number(along)==null?0.5:Number(along)));
    down=Math.max(0,Math.min(1,number(down)==null?0.5:Number(down)));
    function mix(field) {
      var top=corners[0][field]+(corners[1][field]-corners[0][field])*along;
      var bottom=corners[3][field]+(corners[2][field]-corners[3][field])*along;
      return top+(bottom-top)*down;
    }
    var depth=mix('depthKm');return {lat:mix('lat'),lng:mix('lng'),depthKm:depth,depth:depth};
  }

  function normalizePatch(raw, index, defaults, warnings) {
    raw=raw||{};defaults=defaults||{};
    var strike=first(raw,['strikeDeg','strike','stk']);if(strike==null)strike=defaults.strikeDeg;
    var dip=first(raw,['dipDeg','dip']);if(dip==null)dip=defaults.dipDeg;
    var rake=first(raw,['rakeDeg','rake']);if(rake==null)rake=defaults.rakeDeg;
    strike=wrap360(strike==null?0:strike);dip=Math.max(0.1,Math.min(90,dip==null?90:dip));rake=wrap180(rake==null?0:rake);
    var corners=[];
    if(Array.isArray(raw.corners)&&raw.corners.length>=4) {
      var cornerDepth=first(raw,['depthKm','depth','z']);
      for(var ci=0;ci<4;ci++)corners.push(point(raw.corners[ci],defaults.depthUnit,cornerDepth));
    } else if(raw.geometry&&raw.geometry.type==='Polygon'&&raw.geometry.coordinates&&raw.geometry.coordinates[0]) {
      var ring=raw.geometry.coordinates[0];
      var geometryDepth=first(raw,['depthKm','depth','z']);
      for(var gi=0;gi<Math.min(4,ring.length);gi++)corners.push(point(ring[gi],defaults.depthUnit,geometryDepth));
    } else {
      var center=point(raw.center||raw,defaults.depthUnit);
      var length=first(raw,['lengthKm','patchLengthKm','dxKm']);if(length==null)length=defaults.patchLengthKm;
      var width=first(raw,['widthKm','patchWidthKm','dyKm','dzKm']);if(width==null)width=defaults.patchWidthKm;
      if(!(length>0&&width>0))throw new TypeError('Patch '+index+' needs four corners or positive length/width');
      corners=cornersFromCenter(center,strike,dip,length,width);warnings.push('patch_'+index+'_corners_inferred');
    }
    if(corners.length!==4)throw new TypeError('Patch '+index+' must have four corners');
    var centerPoint=centerOf(corners),area=first(raw,['areaKm2','area']);
    if(!(area>0))area=quadArea(corners);
    if(!(area>0))throw new TypeError('Patch '+index+' has zero area');
    var slip=first(raw,['slipM','slip','displacementM']);if(slip==null)slip=0;
    if(String(defaults.slipUnit||'m').toLowerCase()==='cm')slip/=100;
    if(slip<0)throw new TypeError('Patch '+index+' has negative slip');
    var rigidity=first(raw,['rigidityGPa','muGPa']);if(!(rigidity>0))rigidity=defaults.rigidityGPa||30;
    var slipWasSupplied=slip>0;
    var moment=first(raw,['momentNm','moment','m0']),momentWasSupplied=moment>0;
    var momentUnit=String(defaults.momentUnit||'Nm').toLowerCase().replace(/[\s_-]/g,'');
    if(moment>0&&(momentUnit==='dynecm'||momentUnit==='dyncm'))moment*=1e-7;
    if(!(moment>0)&&slip>0)moment=rigidity*1e9*area*1e6*slip;
    if(!(moment>0))throw new TypeError('Patch '+index+' has neither positive slip nor moment');
    if(!(slip>0))slip=moment/(rigidity*1e9*area*1e6);
    var momentSlipResidual=momentWasSupplied&&slipWasSupplied?(rigidity*1e9*area*1e6*slip-moment)/moment:0;
    if(momentWasSupplied&&slipWasSupplied&&Math.abs(momentSlipResidual)>0.05)warnings.push('patch_'+index+'_moment_slip_mismatch');
    var rupture=first(raw,['ruptureTime','ruptureTimeS','trup','tinit']);if(rupture==null)rupture=0;
    var rise=first(raw,['riseTime','riseTimeS','trise']);if(rise==null)rise=defaults.riseTimeS||1;
    var ruptureSpeed=first(raw,['ruptureSpeedKmS','ruptureVelocityKmS','vr']);
    var sourceTimeFunction=raw.sourceTimeFunction||raw.stf||defaults.sourceTimeFunction||'half-cosine';
    if(['half-cosine','triangle','brune','boxcar'].indexOf(sourceTimeFunction)<0)throw new TypeError('Patch '+index+' has unsupported source-time function');
    if(rupture<0||!(rise>0))throw new TypeError('Patch '+index+' has invalid rupture timing');
    return {id:String(raw.id!=null?raw.id:index+1),lat:centerPoint.lat,lng:centerPoint.lng,
      depth:centerPoint.depthKm,depthKm:centerPoint.depthKm,corners:corners,
      strikeDeg:strike,dipDeg:dip,rakeDeg:rake,slipM:slip,areaKm2:area,
      rigidityGPa:rigidity,moment:moment,momentNm:moment,ruptureTime:rupture,riseTime:rise,
      ruptureSpeedKmS:ruptureSpeed>0?ruptureSpeed:null,sourceTimeFunction:sourceTimeFunction,
      momentSlipResidualFraction:momentSlipResidual,
      strikeIndex:index,dipIndex:0,sourceProperties:raw.properties||null};
  }

  function buildGeometry(model) {
    var patches=model.patches,totalMoment=model.totalMomentNm,totalArea=0,weightedSlip=0,maxSlip=0,maxRT=0,maxRise=0;
    for(var i=0;i<patches.length;i++) {
      var patch=patches[i];patch.momentFraction=patch.momentNm/totalMoment;
      patch.m=momentMagnitude(patch.momentNm);patch.alongStrikeKm=0;patch.downDipKm=0;
      totalArea+=patch.areaKm2;weightedSlip+=patch.slipM*patch.areaKm2;maxSlip=Math.max(maxSlip,patch.slipM);
      maxRT=Math.max(maxRT,patch.ruptureTime);maxRise=Math.max(maxRise,patch.riseTime);
    }
    var averageSlip=weightedSlip/totalArea,maxSlipWeight=0;
    for(var wi=0;wi<patches.length;wi++){
      patches[wi].slipWeight=averageSlip>0?patches[wi].slipM/averageSlip:1;
      maxSlipWeight=Math.max(maxSlipWeight,patches[wi].slipWeight);
    }
    var strike=model.representativePlane.strikeDeg,dip=model.representativePlane.dipDeg;
    var all=[];for(var pi=0;pi<patches.length;pi++)all=all.concat(patches[pi].corners);
    var center=centerOf(all),sr=strike*Math.PI/180,minS=Infinity,maxS=-Infinity;
    var minDepth=Infinity,maxDepth=-Infinity,minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
    for(var ci=0;ci<all.length;ci++) {
      var v=localVector(center,all[ci]),along=v.x*Math.cos(sr)+v.y*Math.sin(sr);
      minS=Math.min(minS,along);maxS=Math.max(maxS,along);minDepth=Math.min(minDepth,all[ci].depthKm);maxDepth=Math.max(maxDepth,all[ci].depthKm);
      minLat=Math.min(minLat,all[ci].lat);maxLat=Math.max(maxLat,all[ci].lat);minLng=Math.min(minLng,all[ci].lng);maxLng=Math.max(maxLng,all[ci].lng);
    }
    var length=Math.max(0.1,maxS-minS),width=Math.max(0.1,totalArea/length);
    var geometry={kind:'imported-finite-fault',schema:SCHEMA,modelId:model.id,modelHash:model.hash,
      lat:model.event.lat,lng:model.event.lng,depth:model.event.depthKm,mw:model.mw,sourceType:model.event.sourceType||'crustal',
      strikeDeg:strike,dipDeg:dip,L:length,W:width,nominalL:length,nominalW:width,
      nominalArea:totalArea,actualArea:totalArea,aspectRatio:length/width,widthRatio:1,widthTruncated:false,
      geometryQuality:model.quality.researchReady?'observed-research-ready':'observed-degraded',
      scalingRelation:'Imported finite-fault model',sigmaLogL:null,sigmaLogW:null,
      nStrike:patches.length,nDip:1,nSub:patches.length,subs:patches,totalMoment:totalMoment,
      rigidityGPa:model.rigidityGPa,averageSlipM:averageSlip,maxSlipM:maxSlip,
      maxSlipWeight:maxSlipWeight,
      maxRuptureTime:maxRT,hypocenter:model.event,hypocenterStrikeFrac:0.5,hypocenterDipFrac:0.5,
      ruptureSpeedKmS:null,topDepth:minDepth,bottomDepth:maxDepth,topOffset:0,bottomOffset:width,
      corners:[[minLat,minLng],[maxLat,minLng],[maxLat,maxLng],[minLat,maxLng]],
      provenance:model.provenance,quality:model.quality,
      cellPoint:function(i,j,along,down){var p=this.subs[i];if(!p)throw new RangeError('Patch index');return bilinear(p.corners,along,down);},
      cellCorner:function(i,j,along,down){var p=this.cellPoint(i,j,along,down);return [p.lat,p.lng];},
      patchCorners:function(i){return this.subs[i]&&this.subs[i].corners;}
    };
    return geometry;
  }

  function normalize(raw, options) {
    raw=raw||{};options=options||{};
    var errors=[],warnings=[],event=raw.event||{},provenance=Object.assign({},raw.provenance||{},options.provenance||{});
    if(raw.schema&&raw.schema!==SCHEMA)throw new TypeError('Unsupported finite-fault schema: '+raw.schema);
    var defaults=Object.assign({depthUnit:raw.units&&raw.units.depth||'km',slipUnit:raw.units&&raw.units.slip||'m',
      momentUnit:raw.units&&raw.units.moment||'Nm',
      rigidityGPa:first(raw,['rigidityGPa','muGPa'])||30,
      strikeDeg:first(raw,['strikeDeg','strike']),dipDeg:first(raw,['dipDeg','dip']),rakeDeg:first(raw,['rakeDeg','rake'])},options.defaults||{});
    var inputPatches=raw.patches||raw.subfaults;
    if(!Array.isArray(inputPatches)||!inputPatches.length)throw new TypeError('Finite-fault model has no patches');
    if(inputPatches.length>MAX_PATCHES)throw new TypeError('Finite-fault model exceeds '+MAX_PATCHES+' patches');
    var patches=[];
    for(var i=0;i<inputPatches.length;i++)patches.push(normalizePatch(inputPatches[i],i,defaults,warnings));
    var totalMoment=patches.reduce(function(sum,p){return sum+p.momentNm;},0);
    var suppliedMoment=first(event,['momentNm','m0']);if(!(suppliedMoment>0))suppliedMoment=first(raw,['momentNm','totalMomentNm','m0']);
    var residual=suppliedMoment>0?(totalMoment-suppliedMoment)/suppliedMoment:0;
    if(suppliedMoment>0&&Math.abs(residual)>0.05)warnings.push('event_patch_moment_mismatch');
    var suppliedMw=first(event,['mw','magnitude']);if(suppliedMw==null)suppliedMw=first(raw,['mw','magnitude']);
    var mw=momentMagnitude(totalMoment);
    if(suppliedMw!=null&&Math.abs(suppliedMw-mw)>0.15)warnings.push('event_patch_mw_mismatch');
    var representative={strikeDeg:weightedDirection(patches,'strikeDeg',true),
      dipDeg:patches.reduce(function(s,p){return s+p.dipDeg*p.momentNm;},0)/totalMoment,
      rakeDeg:weightedDirection(patches,'rakeDeg',false)};
    var eventLat=first(event,['lat','latitude']),eventLng=first(event,['lng','lon','longitude']),eventDepth=first(event,['depthKm','depth']);
    if(eventLat==null||eventLng==null||eventDepth==null) {
      var nucleation=patches.slice().sort(function(a,b){return a.ruptureTime-b.ruptureTime;})[0];
      if(eventLat==null)eventLat=nucleation.lat;if(eventLng==null)eventLng=nucleation.lng;if(eventDepth==null)eventDepth=nucleation.depthKm;
      warnings.push('event_hypocenter_inferred');
    }
    if(eventLat < -90 || eventLat > 90 || eventLng < -180 || eventLng > 180 || eventDepth < -12 || eventDepth > 800) {
      throw new TypeError('Finite-fault event hypocenter is outside supported range');
    }
    if(!provenance.source)warnings.push('source_missing');
    if(!provenance.url)warnings.push('source_url_missing');
    if(!provenance.license)warnings.push('license_missing');
    if(!patches.some(function(p){return p.ruptureTime>0;}))warnings.push('rupture_times_missing_or_zero');
    var patchConsistency=patches.every(function(p){return Math.abs(p.momentSlipResidualFraction||0)<=0.05;});
    var quality={valid:errors.length===0,researchReady:errors.length===0&&!!provenance.source&&!!provenance.url&&!!provenance.license&&Math.abs(residual)<=0.05&&patchConsistency,
      grade:errors.length?'D':(warnings.length?'B':'A'),errors:errors,warnings:warnings,
      momentResidualFraction:residual,patchCount:patches.length};
    var model={schema:SCHEMA,id:String(raw.id||event.id||provenance.eventId||('finite-fault-'+textHash(JSON.stringify(raw)))),
      event:{id:event.id||provenance.eventId||null,lat:eventLat,lng:eventLng,depthKm:eventDepth,depth:eventDepth,
        sourceType:event.sourceType||raw.sourceType||options.sourceType||null},
      mw:mw,inputMw:suppliedMw,totalMomentNm:totalMoment,suppliedMomentNm:suppliedMoment,
      rigidityGPa:defaults.rigidityGPa,representativePlane:representative,patches:patches,
      units:{coordinates:'WGS84',depth:'km',slip:'m',time:'s',moment:'Nm'},
      provenance:{source:provenance.source||'imported',eventId:provenance.eventId||event.id||null,
        url:provenance.url||null,license:provenance.license||null,retrievedAt:provenance.retrievedAt||null,
        format:provenance.format||'quake-sim-json',hash:provenance.hash||textHash(JSON.stringify(raw))},quality:quality};
    model.hash=textHash(JSON.stringify({event:model.event,mw:model.mw,patches:patches.map(function(p){return [p.id,p.corners,p.slipM,p.strikeDeg,p.dipDeg,p.rakeDeg,p.ruptureTime,p.riseTime];})}));
    model.geometry=buildGeometry(model);
    return model;
  }

  function parseGeoJSON(doc, options) {
    options=options||{};var features=doc&&doc.features;if(!Array.isArray(features))throw new TypeError('GeoJSON has no features');
    var meta=doc.metadata||doc.properties||{},patches=[];
    for(var i=0;i<features.length;i++) {
      var feature=features[i]||{},properties=feature.properties||{},geometry=feature.geometry||{};
      if(geometry.type==='MultiPolygon') {
        for(var mi=0;mi<geometry.coordinates.length;mi++)patches.push(Object.assign({},properties,{id:(feature.id||i)+'-'+mi,geometry:{type:'Polygon',coordinates:geometry.coordinates[mi]}}));
      } else if(geometry.type==='Polygon') patches.push(Object.assign({},properties,{id:feature.id||i,geometry:geometry}));
      else if(geometry.type==='Point')patches.push(Object.assign({},properties,{id:feature.id||i,center:geometry.coordinates}));
    }
    return normalize({event:meta.event||meta,patches:patches,units:meta.units||doc.units,
      rigidityGPa:first(meta,['rigidityGPa','muGPa']),provenance:Object.assign({source:meta.source||'USGS finite-fault GeoJSON',
        eventId:meta.eventId||meta.id||null,url:meta.url||null,license:meta.license||null,format:'GeoJSON'},options.provenance||{})},options);
  }

  function headerNumber(source, patterns) {
    for(var i=0;i<patterns.length;i++){var match=source.match(patterns[i]);if(match&&number(match[1])!=null)return number(match[1]);}
    return null;
  }
  function parseFSP(source, options) {
    options=options||{};var lines=String(source||'').replace(/^\uFEFF/,'').split(/\r?\n/),headerIndex=-1,columns=[];
    for(var i=0;i<lines.length;i++) {
      var candidate=lines[i].replace(/^\s*%+\s*/,'').trim();
      if(/\bLAT\b/i.test(candidate)&&/\bLON\b/i.test(candidate)&&/\bSLIP\b/i.test(candidate)) {
        headerIndex=i;columns=candidate.split(/\s+/).map(function(v){return v.toUpperCase().replace(/[^A-Z0-9_]/g,'');});
      }
    }
    if(headerIndex<0)throw new TypeError('SRCMOD/FSP column header with LAT LON SLIP was not found');
    function index(names){for(var n=0;n<names.length;n++){var found=columns.indexOf(names[n]);if(found>=0)return found;}return -1;}
    var ix={lat:index(['LAT','LATITUDE']),lng:index(['LON','LONG','LONGITUDE']),depth:index(['Z','DEP','DEPTH']),
      slip:index(['SLIP','SLIPM','SLIPCM']),rake:index(['RAKE']),strike:index(['STRIKE','STRK','STK']),dip:index(['DIP']),
      rupture:index(['TRUP','TINIT','RUPTURETIME']),rise:index(['RISE','TRISE','RISETIME']),moment:index(['MOMENT','M0','SFMOMENT','SF_MOM'])};
    if(ix.lat<0||ix.lng<0||ix.slip<0)throw new TypeError('SRCMOD/FSP requires LAT, LON and SLIP columns');
    var length=headerNumber(source,[/\bLEN(?:GTH)?\s*=\s*([\d.eE+-]+)/i]),width=headerNumber(source,[/\bWID(?:TH)?\s*=\s*([\d.eE+-]+)/i]);
    var nx=headerNumber(source,[/\bN[xX]\s*=\s*(\d+)/]),ny=headerNumber(source,[/\bN[yYzZ]\s*=\s*(\d+)/]);
    var patchLength=headerNumber(source,[/\bD[xX]\s*=\s*([\d.eE+-]+)/]),patchWidth=headerNumber(source,[/\bD[yYzZ]\s*=\s*([\d.eE+-]+)/]);
    if(!(patchLength>0)&&length>0&&nx>0)patchLength=length/nx;
    if(!(patchWidth>0)&&width>0&&ny>0)patchWidth=width/ny;
    var defaultStrike=headerNumber(source,[/\bSTRK?\s*=\s*([\d.eE+-]+)/i,/\bSTRIKE\s*=\s*([\d.eE+-]+)/i]);
    var defaultDip=headerNumber(source,[/\bDIP\s*=\s*([\d.eE+-]+)/i]);
    var unitTokens=headerIndex+1<lines.length?lines[headerIndex+1].replace(/^\s*%+\s*/,'').trim().split(/\s+/):[];
    var slipColumnUnit=ix.slip>=0&&unitTokens[ix.slip]?unitTokens[ix.slip]:'';
    var momentColumnUnit=ix.moment>=0&&unitTokens[ix.moment]?unitTokens[ix.moment]:'';
    var slipUnit=/CM/i.test(slipColumnUnit)||/SLIP[^\n]*(?:\(CM\)|\[CM\]|\bCM\b)/i.test(source)?'cm':'m';
    var momentUnit=/(?:DYNE|DYN)/i.test(momentColumnUnit)||/(?:SF_?MOM|MOMENT|\bM0\b)[^\n]*(?:DYNE\s*[- ]?\s*CM|DYN\s*[- ]?\s*CM)/i.test(source)?'dyne-cm':'Nm',patches=[];
    for(var row=headerIndex+1;row<lines.length;row++) {
      var clean=lines[row].trim();if(!clean||/^%/.test(clean))continue;
      var values=clean.split(/\s+/).map(Number);if(values.some(function(v){return !isFinite(v);})||values.length<columns.length)continue;
      var raw={id:patches.length+1,lat:values[ix.lat],lng:values[ix.lng],depthKm:ix.depth>=0?values[ix.depth]:0,
        slipM:values[ix.slip],rakeDeg:ix.rake>=0?values[ix.rake]:0,
        strikeDeg:ix.strike>=0?values[ix.strike]:defaultStrike,dipDeg:ix.dip>=0?values[ix.dip]:defaultDip,
        ruptureTime:ix.rupture>=0?values[ix.rupture]:0,riseTime:ix.rise>=0?values[ix.rise]:1,
        momentNm:ix.moment>=0?values[ix.moment]:null,lengthKm:patchLength,widthKm:patchWidth};
      patches.push(raw);
    }
    if(!patches.length)throw new TypeError('SRCMOD/FSP contains no readable patch rows');
    var event={id:(source.match(/(?:EventTAG|Event)\s*[:=]\s*([^\r\n]+)/i)||[])[1]||null,
      lat:headerNumber(source,[/\bLAT\s*=\s*([\d.eE+-]+)/i]),lng:headerNumber(source,[/\bLON\s*=\s*([\d.eE+-]+)/i]),
      depthKm:headerNumber(source,[/\bDEP(?:TH)?\s*=\s*([\d.eE+-]+)/i]),mw:headerNumber(source,[/\bMw\s*=\s*([\d.eE+-]+)/i])};
    return normalize({event:event,patches:patches,units:{depth:'km',slip:slipUnit,moment:momentUnit},
      provenance:Object.assign({source:'SRCMOD',eventId:event.id,url:null,license:null,format:'SRCMOD FSP'},options.provenance||{})},
      Object.assign({},options,{defaults:Object.assign({patchLengthKm:patchLength,patchWidthKm:patchWidth,strikeDeg:defaultStrike,dipDeg:defaultDip,slipUnit:slipUnit,momentUnit:momentUnit},options.defaults||{})}));
  }

  function parse(input, options) {
    options=options||{};
    if(typeof input==='string') {
      var trimmed=input.trim();
      if(trimmed.charAt(0)==='{'||trimmed.charAt(0)==='[')return parse(JSON.parse(trimmed),options);
      return parseFSP(input,options);
    }
    if(!input||typeof input!=='object')throw new TypeError('Finite-fault input must be JSON, GeoJSON, or FSP text');
    if(input.type==='FeatureCollection'||Array.isArray(input.features))return parseGeoJSON(input,options);
    return normalize(input,options);
  }

  function serialize(model) {
    if(!model||model.schema!==SCHEMA)throw new TypeError('Not a normalized finite-fault model');
    return {schema:SCHEMA,id:model.id,event:Object.assign({},model.event,{mw:model.mw,momentNm:model.totalMomentNm}),
      units:model.units,provenance:model.provenance,patches:model.patches.map(function(p){return {
        id:p.id,corners:p.corners.map(function(c){return {lat:c.lat,lng:c.lng,depthKm:c.depthKm};}),
        strikeDeg:p.strikeDeg,dipDeg:p.dipDeg,rakeDeg:p.rakeDeg,slipM:p.slipM,
        ruptureTimeS:p.ruptureTime,riseTimeS:p.riseTime,ruptureSpeedKmS:p.ruptureSpeedKmS,
        sourceTimeFunction:p.sourceTimeFunction,rigidityGPa:p.rigidityGPa,momentNm:p.momentNm
      };})};
  }

  return {SCHEMA:SCHEMA,MAX_PATCHES:MAX_PATCHES,parse:parse,normalize:normalize,
    parseGeoJSON:parseGeoJSON,parseFSP:parseFSP,serialize:serialize,
    buildGeometry:buildGeometry,quadArea:quadArea,cornersFromCenter:cornersFromCenter};
});
