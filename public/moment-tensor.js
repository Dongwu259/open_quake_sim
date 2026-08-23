// Observed focal-mechanism import and normalization (F-net / GCMT / USGS / QuakeML).
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MomentTensor = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var COMPONENTS = ['xx','yy','zz','xy','xz','yz'];
  var ALIASES = {
    xx:['xx','mxx','Mxx','Mrr','mrr','rr','tensor-mrr','derived-mrr'],
    yy:['yy','myy','Myy','Mtt','mtt','tt','tensor-mtt','derived-mtt'],
    zz:['zz','mzz','Mzz','Mpp','mpp','pp','tensor-mpp','derived-mpp'],
    xy:['xy','mxy','Mxy','Mrt','mrt','rt','tensor-mrt','derived-mrt'],
    xz:['xz','mxz','Mxz','Mrp','mrp','rp','tensor-mrp','derived-mrp'],
    yz:['yz','myz','Myz','Mtp','mtp','tp','tensor-mtp','derived-mtp']
  };
  // USGS feeds several tensor fields as "value, uncertainty" strings — take
  // the leading token or Number() yields NaN and the whole import throws.
  function num(v) { if (typeof v === 'string') v = v.split(',')[0].trim(); var n=Number(v); return isFinite(n)?n:null; }
  function first(obj, keys) {
    for(var i=0;i<keys.length;i++) if(obj&&obj[keys[i]]!=null&&num(obj[keys[i]])!=null) return num(obj[keys[i]]);
    return null;
  }
  function hashText(text) {
    var h=0x811c9dc5; text=String(text||'');
    for(var i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
    return ('00000000'+h.toString(16)).slice(-8);
  }
  function canonicalCoordinate(value) {
    var v=String(value||'NED').toUpperCase().replace(/[ _-]/g,'');
    if(v==='NED'||v==='NORTHEASTDOWN') return 'NED';
    if(v==='RTP'||v==='RTZ'||v==='RTHETAPHI'||v==='GCMT') return 'RTP';
    if(v==='USE'||v==='UPNORTHEAST') return 'USE';
    return null;
  }
  function unitScale(units) {
    var u=String(units||'').toLowerCase().replace(/\s/g,'');
    if(u==='nm'||u==='n*m'||u==='newton-meter'||u==='newtonmetre'||u==='newtonmeter') return 1;
    if(u==='dyne-cm'||u==='dyn-cm'||u==='dynecm'||u==='dyncm') return 1e-7;
    return null;
  }
  function readComponents(raw) {
    var values={}, missing=[];
    COMPONENTS.forEach(function(k){values[k]=first(raw,ALIASES[k]);if(values[k]==null)missing.push(k);});
    return {values:values,missing:missing};
  }
  function convertToNed(c, coordinate) {
    if(coordinate==='NED') return {xx:c.xx,yy:c.yy,zz:c.zz,xy:c.xy,xz:c.xz,yz:c.yz};
    if(coordinate==='RTP') {
      // GCMT/USGS: r=up, theta=south, phi=east; N=-theta, E=phi, D=-r.
      return {xx:c.yy,yy:c.zz,zz:c.xx,xy:-c.yz,xz:c.xy,yz:-c.xz};
    }
    // USE: up, south, east has the same axis directions as RTP.
    return {xx:c.yy,yy:c.zz,zz:c.xx,xy:-c.yz,xz:c.xy,yz:-c.xz};
  }
  function tensorNorm(t) { return Math.sqrt(t.xx*t.xx+t.yy*t.yy+t.zz*t.zz+2*(t.xy*t.xy+t.xz*t.xz+t.yz*t.yz)); }
  function normalizeUncertainty(raw, scale, coordinate) {
    if(!raw) return null;
    var got=readComponents(raw), out={};
    if(got.missing.length) return {components:null,missing:got.missing};
    COMPONENTS.forEach(function(k){got.values[k]=Math.abs(got.values[k])*scale;});
    out.components=convertToNed(got.values,coordinate);out.missing=[];
    out.frobeniusNorm=tensorNorm(out.components);return out;
  }
  function assessQuality(result) {
    var errors=[],warnings=[],p=result.provenance||{},t=result.tensor;
    if(!t) errors.push('tensor_missing');
    if(result.missingComponents&&result.missingComponents.length) errors.push('missing_components:'+result.missingComponents.join(','));
    var norm=t?tensorNorm(t):0;
    if(!(norm>0)) errors.push('zero_tensor');
    if(!p.eventId) warnings.push('event_id_missing');
    if(!p.source||p.source==='imported') warnings.push('source_generic');
    if(!p.unitsOriginal) warnings.push('units_missing');
    if(!p.coordinateSystemOriginal) warnings.push('coordinate_system_missing');
    if(result.momentNm&&norm&&Math.abs(Math.log10(result.momentNm/norm))>1) warnings.push('scalar_moment_mismatch');
    if(result.uncertainty&&result.uncertainty.missing&&result.uncertainty.missing.length) warnings.push('uncertainty_incomplete');
    var grade=errors.length?'D':(warnings.length>=3?'C':(warnings.length?'B':'A'));
    return {valid:errors.length===0,grade:grade,errors:errors,warnings:warnings,componentCompleteness:6-(result.missingComponents||[]).length};
  }
  function normalizeTensor(raw, options) {
    options=options||{}; raw=raw||{};
    var coordinate=canonicalCoordinate(options.coordinateSystem);
    if(!coordinate) throw new TypeError('Unsupported coordinate system: '+options.coordinateSystem);
    var scale=num(options.scale);if(scale==null)scale=unitScale(options.units);
    if(scale==null) throw new TypeError('Unsupported or missing moment-tensor units');
    var read=readComponents(raw);
    if(read.missing.length&&options.allowIncomplete!==true) throw new TypeError('Missing tensor components: '+read.missing.join(', '));
    COMPONENTS.forEach(function(k){if(read.values[k]==null)read.values[k]=0;read.values[k]*=scale;});
    var provenance=options.provenance||{}, tensor=convertToNed(read.values,coordinate);
    var scalarMoment=num(options.momentNm);if(scalarMoment!=null)scalarMoment*=scale;
    var result={tensor:tensor,momentNm:scalarMoment,missingComponents:read.missing,
      uncertainty:normalizeUncertainty(options.uncertainty,scale,coordinate),
      provenance:{source:provenance.source||'imported',eventId:provenance.eventId||null,url:provenance.url||null,
        coordinateSystemOriginal:coordinate,coordinateSystem:'NED',unitsOriginal:options.units||null,units:'Nm',timestamp:provenance.timestamp||null,
        hash:provenance.hash||hashText(JSON.stringify({tensor:tensor,eventId:provenance.eventId||null}))}};
    result.quality=assessQuality(result);
    if(!result.quality.valid) throw new TypeError(result.quality.errors.join('; '));
    return result;
  }
  function parseUSGS(doc) {
    var p=doc&&doc.properties||doc||{}, products=p.products||{}, mt=products['moment-tensor']&&products['moment-tensor'][0];
    var mp=mt&&mt.properties||{}, tensor=mp.tensor||mp, units=mp['tensor-unit']||mp.units||'Nm';
    return normalizeTensor(tensor,{coordinateSystem:'RTP',units:units,momentNm:mp['scalar-moment'],uncertainty:mp.uncertainty,
      provenance:{source:'USGS',eventId:p.code||p.eventid||mp.eventId||null,url:mt&&mt.contents&&mt.contents['quakeml.xml']&&mt.contents['quakeml.xml'].url||p.url||null,timestamp:p.time||null}});
  }
  function parseQuakeML(xml) {
    if(typeof xml!=='string') throw new TypeError('QuakeML must be text');
    function tag(name){var re=new RegExp('<(?:[\\w.-]+:)?'+name+'[^>]*>[\\s\\S]*?<(?:[\\w.-]+:)?value[^>]*>([^<]+)<','i'),m=xml.match(re);if(!m){re=new RegExp('<(?:[\\w.-]+:)?'+name+'[^>]*>([^<]+)<','i');m=xml.match(re);}return m?m[1].trim():null;}
    var raw={mrr:tag('Mrr'),mtt:tag('Mtt'),mpp:tag('Mpp'),mrt:tag('Mrt'),mrp:tag('Mrp'),mtp:tag('Mtp')};
    var eventId=(xml.match(/<(?:[\w.-]+:)?event[^>]*publicID="([^"]+)"/i)||[])[1]||null;
    return normalizeTensor(raw,{coordinateSystem:'RTP',units:'Nm',momentNm:tag('scalarMoment'),
      provenance:{source:'QuakeML',eventId:eventId,hash:hashText(xml)}});
  }
  function parseFnet(doc) {
    var p=doc&&doc.properties||doc||{};
    if(p.tensor||p.Mrr!=null||p.mrr!=null||p.xx!=null) return normalizeTensor(p.tensor||p,{coordinateSystem:p.coordinateSystem||'NED',units:p.units,momentNm:p.momentNm||p.scalarMoment,uncertainty:p.uncertainty||p.errors,
      provenance:{source:p.source||'F-net',eventId:p.eventId||p.id||null,url:p.url||null,timestamp:p.time||null}});
    var plane=p.plane||p.nodalPlane||p;
    if(plane.strike!=null&&plane.dip!=null&&plane.rake!=null) return {plane1:{strike:Number(plane.strike),dip:Number(plane.dip),rake:Number(plane.rake)},tensor:null,momentNm:num(p.momentNm),
      provenance:{source:p.source||'F-net',eventId:p.eventId||p.id||null,url:p.url||null,coordinateSystem:'NED',units:p.units||'Nm'},quality:{valid:true,grade:'B',errors:[],warnings:['nodal_plane_only'],componentCompleteness:0}};
    throw new TypeError('No supported F-net tensor or nodal plane fields');
  }
  function parse(input,options) {
    options=options||{};
    if(typeof input==='string'){if(/^\s*</.test(input))return parseQuakeML(input);input=JSON.parse(input);}
    var source=(input.source||input.sourceType||options.source||'').toString().toLowerCase();
    if(source.indexOf('usgs')>=0||input.properties&&input.properties.products)return parseUSGS(input);
    if(source.indexOf('f-net')>=0||source.indexOf('fnet')>=0)return parseFnet(input);
    if(input.tensor||input.Mrr!=null||input.mrr!=null||input.xx!=null)return normalizeTensor(input.tensor||input,{coordinateSystem:input.coordinateSystem||options.coordinateSystem||'NED',units:input.units||options.units,momentNm:input.momentNm||input.scalarMoment,uncertainty:input.uncertainty||input.errors,
      provenance:{source:input.source||options.source||'observed',eventId:input.eventId||input.id||null,url:input.url||null,timestamp:input.time||null}});
    if(input.strike!=null&&input.dip!=null&&input.rake!=null)return parseFnet(input);
    throw new TypeError('Unsupported moment-tensor format');
  }
  return {normalizeTensor:normalizeTensor,parseUSGS:parseUSGS,parseFnet:parseFnet,parseQuakeML:parseQuakeML,parse:parse,
    assessQuality:assessQuality,canonicalCoordinate:canonicalCoordinate,unitScale:unitScale,convertToNed:convertToNed};
});
