// ================================================================
//  Physics — Pure earthquake computation functions
//  UMD wrapper: works in browser (window.Physics) and Node.js (require)
//  ALL functions take explicit parameters — no cfgGet, no globals
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./dc3d.js')); }
  else { root.Physics = factory(root.DC3D); }
}(typeof self !== 'undefined' ? self : this, function(DC3D) {

var Physics = {};

// -- Constants --
Physics.EARTH_R = 6371;

Physics.SHINDO_FILL = {0:null,1:'#a0d2f0',2:'#6cb4ee',3:'#2ecc71',4:'#f1c40f',
  '5-':'#e67e22','5+':'#e74c3c','6-':'#c0392b','6+':'#8e44ad',7:'#6c0f1f'};

Physics.SIMID_DS = { crustal: 0.00, interplate: (typeof cfgGet !== 'undefined' ? cfgGet('dsInter') : 0.124), intraslab: (typeof cfgGet !== 'undefined' ? cfgGet('dsIntra') : 0.221) };

// Dynamic reader so runtime config changes take effect (was frozen at init — H2 fix)
function _simidDs(src) {
  if (src === 'interplate') return (typeof cfgGet !== 'undefined' ? cfgGet('dsInter') : 0.124);
  if (src === 'intraslab') return (typeof cfgGet !== 'undefined' ? cfgGet('dsIntra') : 0.221);
  return 0;
}
// Public alias — callers outside this module get the live config instead of
// the frozen Physics.SIMID_DS snapshot above.
Physics.simidDs = _simidDs;

Physics.SHINDO_SCORE = {0:0,1:1,2:2,3:3,4:4,'5-':4.75,'5+':5.25,'6-':5.75,'6+':6.25,7:6.75,5:5.0,6:6.0};

Physics.SOIL_PROVINCES = [
  [35.0,36.6,139.0,140.8,1.65],[34.8,35.5,136.5,137.2,1.55],[34.3,35.0,135.0,135.8,1.55],
  [38.0,38.5,140.7,141.3,1.45],[42.7,43.3,141.1,141.8,1.45],[37.6,38.1,138.8,139.5,1.40],
  [36.5,36.9,137.1,137.5,1.35],[33.4,33.8,130.2,130.6,1.40],[33.4,33.7,133.4,133.7,1.35],
  [43.0,44.5,141.3,145.5,1.25],[35.2,35.6,136.8,137.0,1.30],[34.5,34.8,135.3,135.6,1.30],
  [35.5,36.0,138.9,139.4,1.25],[31.2,31.8,130.3,131.2,1.20],[26.0,27.0,127.6,128.3,1.30]
];

// v4.3: Vs30 zones for Japan (geological province-based, replaces flat 400 default)
// Values are approximate NEHRP-based Vs30 in m/s. Stations with explicit Vs30 take priority.
// Default 700 m/s = mountain hard rock (most of Japan). Lower = sedimentary basins.
Physics.VS30_ZONES = [
  [35.0,36.6,139.0,140.8,180],[34.3,35.3,135.0,136.5,190],[34.5,35.5,136.5,137.2,200],
  [38.0,38.5,140.7,141.3,200],[42.7,43.3,141.1,141.8,200],[37.6,38.1,138.8,139.5,200],
  [43.0,44.5,141.3,145.5,260],[33.4,33.8,130.2,130.6,200],[33.4,33.7,133.4,133.7,200],
  [36.5,36.9,137.1,137.5,220],[35.2,35.6,136.8,137.0,220],[34.5,34.8,135.3,135.6,220],
  [35.5,36.0,138.9,139.4,220],[31.2,31.8,130.3,131.2,220],[26.0,27.0,127.6,128.3,250],
  [32.7,33.3,130.3,131.0,200],[40.5,41.0,140.0,141.5,200],[38.0,39.0,140.0,141.5,200],
  [34.0,35.0,132.0,134.0,250],[39.0,40.0,140.0,141.5,220]
];

// v4.3: Regional Q0 zones for Japan (crustal attenuation quality factor)
// Default 200 = normal crust. Lower = higher attenuation (volcanic). Higher = lower attenuation (fore-arc).
Physics.Q_ZONES = [
  [31.0,33.5,130.0,132.0,100],[42.0,43.5,140.0,142.0,120],[36.0,39.5,138.0,141.0,130],
  [33.0,36.0,132.0,136.0,280],[35.0,42.0,141.0,145.0,250],[35.0,36.6,139.0,140.8,150],
  [34.3,35.5,136.5,137.2,260],[42.7,43.3,141.1,141.8,280],[26.0,28.0,127.0,129.0,120],
  [31.0,33.0,130.0,131.5,130],[34.5,36.0,133.0,136.0,270]
];

/**
 * Lookup Vs30 with provenance. Priority: station metadata, optional external
 * grid provider, built-in regional zones, then the hard-rock fallback.
 * The external provider may return a number or { value, source }.
 */
Physics.lookupVs30Details = function(lat, lng, stationVs30, externalLookup, stationSource) {
  if (stationVs30 && stationVs30 > 0 && stationSource === 'measured') return { value:stationVs30, source:'measured' };
  if (typeof externalLookup === 'function') {
    try {
      var ext = externalLookup(lat, lng);
      var extValue = typeof ext === 'number' ? ext : (ext && (ext.value || ext.vs30));
      if (isFinite(extValue) && extValue > 0) {
        return { value:Number(extValue), source:(ext && ext.source) || 'external-grid' };
      }
    } catch (e) { /* fall through to the built-in model */ }
  }
  if (stationVs30 && stationVs30 > 0) return { value:stationVs30, source:stationSource || 'station' };
  var zones = Physics.VS30_ZONES;
  for (var i = 0; i < zones.length; i++) {
    if (lat >= zones[i][0] && lat <= zones[i][1] && lng >= zones[i][2] && lng <= zones[i][3])
      return { value:zones[i][4], source:'regional-zone' };
  }
  return { value:700, source:'fallback' };
};

Physics.lookupVs30 = function(lat, lng, stationVs30, externalLookup) {
  return Physics.lookupVs30Details(lat, lng, stationVs30, externalLookup).value;
};

/**
 * v4.3: Lookup regional Q0 for a given location.
 * @param {number} lat @param {number} lng
 * @returns {number} Q0 value
 */
Physics.lookupQ0 = function(lat, lng) {
  var zones = Physics.Q_ZONES;
  for (var i = 0; i < zones.length; i++) {
    if (lat >= zones[i][0] && lat <= zones[i][1] && lng >= zones[i][2] && lng <= zones[i][3])
      return zones[i][4];
  }
  return 200; // default: normal crust
};

Physics.TSUNAMI_WARN_COLORS = {
  'major': '#ee5a24', 'warn': '#ff9f43', 'adv': '#ffe066'
};

Physics.FRAGILITY_WOODEN = {
  4: {total:0.00, partial:0.01},
  '5-':{total:0.005, partial:0.05},
  '5+':{total:0.02, partial:0.15},
  '6-':{total:0.08, partial:0.40},
  '6+':{total:0.25, partial:0.65},
  7: {total:0.60, partial:0.90}
};

Physics.FRAGILITY_RC = {
  4: {total:0.00, partial:0.00},
  '5-':{total:0.00, partial:0.01},
  '5+':{total:0.005, partial:0.05},
  '6-':{total:0.02, partial:0.15},
  '6+':{total:0.08, partial:0.35},
  7: {total:0.25, partial:0.60}
};

Physics.CITY_TIERS = {
  '東京都千代田区':1,'東京都':1,'横浜市':1,'大阪市':1,'名古屋市':1,
  '札幌市':2,'福岡市':2,'仙台市':2,'広島市':2,'京都市':2,'神戸市':2,
  'さいたま市':2,'川崎市':2,'新潟市':2,'静岡市':2,'浜松市':2,
  '北九州市':2,'堺市':2,'千葉市':2,'相模原市':2,'岡山市':2,
  '熊本市':2,'鹿児島市':2,'那覇市':2,'宇都宮市':2,'松山市':2
};
Physics.TIER_BUILDINGS = [0, 800000, 200000, 50000, 10000];

// -- Unicode superscript --
var _SUP = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻'};

// ================================================================
//  DISTANCE
// ================================================================

/**
 * Great-circle surface distance (Haversine formula). @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 @returns {number} Surface distance in km
 */
Physics.haversineDist = function(lat1, lng1, lat2, lng2) {
  var dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return 2*Physics.EARTH_R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

/**
 * Hypocentral 3D distance from station to source. @param {number} slat @param {number} slng @param {number} elat @param {number} elng @param {number} depthKm @returns {number} Distance in km, Infinity if epicenter null
 */
Physics.hypoDist = function(lat, lng, epLat, epLng, epDepth) {
  if (epLat == null) return Infinity;
  var surf = Physics.haversineDist(epLat, epLng, lat, lng);
  return Math.sqrt(surf*surf + epDepth*epDepth);
};

// ================================================================
//  SOURCE TYPE
// ================================================================

/**
 * Classify earthquake by focal depth. @param {number} depthKm @returns {string} crustal (<=30km) | interplate (30-60) | intraslab (>60)
 */
Physics.sourceType = function(depthKm) {
  if (depthKm < 30) return 'crustal';
  if (depthKm < 60) return 'interplate';
  return 'intraslab';
};

Physics.resolveSourceType = function(depthKm, eventSource, override) {
  if (override && override !== 'auto' && ['crustal','interplate','intraslab'].indexOf(override) >= 0) return override;
  if (eventSource && ['crustal','interplate','intraslab'].indexOf(eventSource) >= 0) return eventSource;
  return Physics.sourceType(depthKm);
};

// Approximate subduction-front polylines bundled in geojson/plates.json. They
// are a tectonic prior only; an observed finite-fault plane remains preferable.
var _JAPAN_SUBDUCTION_LINES = [
    [[43.5,144.5],[42,144],[41,143.5],[40,143],[39,142.5],[38,142.2],[37,142],[36,141.8],[35.5,141.5],[35,141.2],[34.5,140.8]],
    [[34.5,140.8],[33.5,141],[32,141.5],[30.5,142],[29,142.5],[27.5,143]],
    [[34.5,140.8],[34,139.5],[33.5,138],[33,136.5],[32.8,135],[32.5,134],[32.2,133],[31.8,132]],
    [[31.8,132],[30.5,131],[29.5,130],[28,129],[26.5,128],[25.5,127.5],[24,127]],
    [[43.5,144.5],[44.5,145.5],[45.5,147],[46.5,149]],
    [[34.5,140.8],[34.8,140],[35,139.5],[35.2,139]]
  ];

Physics.nearestJapanSubduction = function(lat, lng) {
  var cosLat = Math.max(0.2, Math.cos(Number(lat) * Math.PI / 180));
  var best = {distanceKm:Infinity, strikeDeg:null, lineIndex:-1, segmentIndex:-1};
  for (var li = 0; li < _JAPAN_SUBDUCTION_LINES.length; li++) {
    for (var i = 1; i < _JAPAN_SUBDUCTION_LINES[li].length; i++) {
      var a = _JAPAN_SUBDUCTION_LINES[li][i - 1], b = _JAPAN_SUBDUCTION_LINES[li][i];
      var ax = (a[1] - lng) * 111.32 * cosLat, ay = (a[0] - lat) * 111.32;
      var bx = (b[1] - lng) * 111.32 * cosLat, by = (b[0] - lat) * 111.32;
      var dx = bx - ax, dy = by - ay, denom = dx * dx + dy * dy;
      var t = denom > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
      var px = ax + t * dx, py = ay + t * dy;
      var distance = Math.sqrt(px * px + py * py);
      if (distance < best.distanceKm) {
        best = {distanceKm:distance,
          strikeDeg:(Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
          lineIndex:li, segmentIndex:i - 1};
      }
    }
  }
  return best;
};

// Approximate distance to the subduction front. This is only a prior for
// manual offshore scenarios; catalog metadata or an explicit override wins.
Physics.distanceToJapanSubductionKm = function(lat, lng) {
  return Physics.nearestJapanSubduction(lat, lng).distanceKm;
};

Physics.resolveSourceTypeAt = function(lat, lng, depthKm, eventSource, override, offshore) {
  var explicit = Physics.resolveSourceType(depthKm, eventSource, override);
  if ((override && override !== 'auto') || eventSource) return explicit;
  if (depthKm >= 60) return 'intraslab';
  if (offshore && isFinite(lat) && isFinite(lng) && Physics.distanceToJapanSubductionKm(lat, lng) <= 140) {
    return 'interplate';
  }
  return explicit;
};

Physics.recommendedFaultDip = function(sourceType) {
  return sourceType === 'interplate' ? 15 : (sourceType === 'intraslab' ? 55 : 60);
};

function _faultUndirectedStrikeDifference(a, b) {
  var d = Math.abs(((Number(a) - Number(b) + 180) % 360 + 360) % 360 - 180);
  return Math.min(d, 180 - d);
}

function _faultRakeDifference(a, b) {
  return Math.abs(((Number(a) - Number(b) + 180) % 360 + 360) % 360 - 180);
}

/**
 * Resolve the physical fault plane from the two mathematically interchangeable
 * moment-tensor nodal planes. An explicit plane index wins. Otherwise a known
 * reference mechanism is used, followed by a documented tectonic prior.
 */
Physics.selectFaultPlane = function(mechanism, context) {
  context = context || {};
  var planes = mechanism && [mechanism.plane1, mechanism.plane2];
  if (!planes || !planes[0] || !planes[1]) return null;
  var explicit = Number(context.preferredPlaneIndex);
  if (explicit === 1 || explicit === 2) {
    return {plane:planes[explicit - 1], alternate:planes[2 - explicit], index:explicit,
      method:'explicit', confidence:'high', ambiguous:false, scoreMargin:Infinity, scores:[null,null]};
  }

  var sourceType = context.sourceType || 'crustal';
  var refStrike = context.referenceStrikeDeg != null ? Number(context.referenceStrikeDeg) : null;
  var refDip = context.referenceDipDeg != null ? Number(context.referenceDipDeg) : null;
  var refRake = context.referenceRakeDeg != null ? Number(context.referenceRakeDeg) : null;
  var method = 'source-class-prior', prior = null;
  if (context.referenceAuthoritative && isFinite(refStrike) && isFinite(refDip)) method = 'reference-mechanism';
  else {
    refDip = Physics.recommendedFaultDip(sourceType);
    refRake = sourceType === 'interplate' ? 90 : null;
    if (sourceType === 'interplate' && isFinite(Number(context.lat)) && isFinite(Number(context.lng))) {
      prior = Physics.nearestJapanSubduction(Number(context.lat), Number(context.lng));
      if (prior.distanceKm <= 180) { refStrike = prior.strikeDeg; method = 'subduction-front-prior'; }
    }
  }
  function score(plane) {
    var value = 0, terms = 0;
    if (isFinite(refStrike)) { value += _faultUndirectedStrikeDifference(plane.strikeDeg, refStrike) / 35; terms++; }
    if (isFinite(refDip)) { value += Math.abs(plane.dipDeg - refDip) / 25; terms++; }
    if (isFinite(refRake)) { value += _faultRakeDifference(plane.rakeDeg, refRake) / 90; terms++; }
    return terms ? value / terms : 0;
  }
  var scores = [score(planes[0]), score(planes[1])];
  var selected = scores[1] + 1e-12 < scores[0] ? 1 : 0;
  var margin = Math.abs(scores[0] - scores[1]);
  var confidence = method === 'reference-mechanism' ? (margin >= 0.5 ? 'high' : 'medium')
    : (method === 'subduction-front-prior' && margin >= 0.5 ? 'medium' : 'low');
  return {plane:planes[selected], alternate:planes[1-selected], index:selected+1,
    method:method, confidence:confidence, ambiguous:margin < 0.25,
    scoreMargin:margin, scores:scores, prior:prior};
};

/** Canonical seismic source shared by ground-motion and tsunami models. */
Physics.createSourceModel = function(params) {
  params = params || {};
  var importedFiniteFault = params.finiteFault && params.finiteFault.geometry &&
    params.finiteFault.geometry.kind === 'imported-finite-fault' ? params.finiteFault : null;
  var importedEvent = importedFiniteFault && importedFiniteFault.event || null;
  var inputMw = Number(importedFiniteFault ? importedFiniteFault.mw : (params.mw != null ? params.mw : params.mag));
  if (!isFinite(inputMw)) inputMw = 0;
  var depthInput = importedEvent ? importedEvent.depthKm : (params.depthKm != null ? params.depthKm : params.depth);
  var depth = Math.max(0, Number(depthInput) || 0);
  var sourceLat = importedEvent ? Number(importedEvent.lat) : Number(params.lat);
  var sourceLng = importedEvent ? Number(importedEvent.lng) : Number(params.lng);
  var sourceType = Physics.resolveSourceType(depth, importedEvent && importedEvent.sourceType || params.sourceType, params.sourceTypeOverride);
  var importedPlane = importedFiniteFault && importedFiniteFault.representativePlane;
  var strike = Number(importedPlane ? importedPlane.strikeDeg : (params.strikeDeg != null ? params.strikeDeg : params.strike)) || 0;
  var dip = Math.max(0.1, Math.min(90, Number(importedPlane ? importedPlane.dipDeg : (params.dipDeg != null ? params.dipDeg : params.dip)) || 90));
  var rake = Number(importedPlane ? importedPlane.rakeDeg : (params.rakeDeg != null ? params.rakeDeg : params.rake)) || 0;
  var observedMechanism = null, planeSelection = null;
  if (!importedFiniteFault && params.momentTensor && params.momentTensor.tensor && Physics.focalMechanismFromTensor) {
    observedMechanism = Physics.focalMechanismFromTensor(params.momentTensor);
  } else if (params.momentTensor && params.momentTensor.plane1) {
    var suppliedPlane = params.momentTensor.plane1;
    observedMechanism = Physics.focalMechanism({strike:suppliedPlane.strike,dip:suppliedPlane.dip,
      rake:suppliedPlane.rake,momentNm:Number(params.momentTensor.momentNm)||Physics.seismicMoment(inputMw)});
  }
  if (observedMechanism) {
    planeSelection = Physics.selectFaultPlane(observedMechanism, {
      lat:Number(params.lat), lng:Number(params.lng), sourceType:sourceType,
      preferredPlaneIndex:params.faultPlaneIndex,
      referenceStrikeDeg:params.referenceStrikeDeg, referenceDipDeg:params.referenceDipDeg,
      referenceRakeDeg:params.referenceRakeDeg, referenceAuthoritative:params.referenceMechanismKnown===true
    });
    var selectedPlane = planeSelection ? planeSelection.plane : observedMechanism.plane1;
    strike = selectedPlane.strikeDeg; dip = selectedPlane.dipDeg; rake = selectedPlane.rakeDeg;
  }
  var observedMoment = importedFiniteFault ? Number(importedFiniteFault.totalMomentNm) : (observedMechanism && Number(observedMechanism.momentNm));
  var moment = observedMoment > 0 ? observedMoment : Physics.seismicMoment(inputMw);
  var mw = observedMoment > 0 ? Physics.momentMagnitude(moment) : inputMw;
  var rigidityGPa = Number(importedFiniteFault ? importedFiniteFault.rigidityGPa : params.rigidityGPa);
  if (!(rigidityGPa > 0)) rigidityGPa = sourceType === 'intraslab' ? 50 : (sourceType === 'interplate' ? 40 : 30);
  var faultOptions = Object.assign({}, params.faultOptions || {}, {sourceType:sourceType,rigidityGPa:rigidityGPa});
  var geometry = importedFiniteFault ? importedFiniteFault.geometry : (params.geometry || null);
  var geometryMismatch = !importedFiniteFault && !!geometry && (Math.abs(Number(geometry.mw) - mw) > 1e-6 ||
    _faultUndirectedStrikeDifference(geometry.strikeDeg, strike) > 1e-6 || Math.abs(Number(geometry.dipDeg) - dip) > 1e-6);
  if (!geometry || geometryMismatch) {
    if (params.generateSubSources === true && typeof Physics.genSubSources === 'function') {
      geometry = Physics.genSubSources(Number(params.lat)||0, Number(params.lng)||0, mw, strike, dip, depth,
        Number(params.rupSpeed)||2.8, faultOptions);
    } else {
      geometry = Physics.buildFaultGeometry(Number(params.lat)||0, Number(params.lng)||0, mw, strike, dip, depth, faultOptions);
    }
  }
  if (importedFiniteFault && geometry) {
    geometry.sourceType = sourceType;
    geometry.lat = sourceLat; geometry.lng = sourceLng; geometry.depth = depth;
  }
  var areaM2 = geometry ? Number(geometry.actualArea || geometry.nominalArea || geometry.L * geometry.W) * 1e6 : 0;
  if (geometry && geometry.rigidityGPa > 0) rigidityGPa=geometry.rigidityGPa;
  return {
    lat:isFinite(sourceLat) ? sourceLat : 0, lng:isFinite(sourceLng) ? sourceLng : 0,
    mag:importedFiniteFault ? mw : Number(params.mag != null ? params.mag : mw), mw:mw, depthKm:depth,
    inputMw:inputMw, momentMw:Physics.momentMagnitude(moment),
    strikeDeg:strike, dipDeg:dip, rakeDeg:rake, sourceType:sourceType,
    mechanismKnown:!!importedFiniteFault || params.mechanismKnown !== false || !!observedMechanism,
    momentTensor:params.momentTensor || null,
    mechanismProvenance:params.mechanismProvenance || (params.momentTensor && params.momentTensor.provenance) || null,
    faultPlaneSelection:planeSelection, finiteFault:importedFiniteFault,
    faultModelProvenance:importedFiniteFault && importedFiniteFault.provenance || null,
    faultModelQuality:importedFiniteFault && importedFiniteFault.quality || null,
    rigidityGPa:rigidityGPa, momentNm:moment, areaM2:areaM2,
    averageSlipM:geometry&&geometry.averageSlipM!=null?geometry.averageSlipM:(areaM2 > 0 ? moment / (rigidityGPa * 1e9 * areaM2) : 0),
    geometry:geometry, originTime:Number(params.originTime) || 0,
    magnitudeType:params.magnitudeType || (importedFiniteFault ? 'observed-finite-fault' : (observedMechanism ? 'observed-moment' : (params.mw != null ? 'Mw' : 'assumed-Mw')))
  };
};

// -- Focal mechanism geometry ----------------------------------------------
// Coordinate convention: NED (x=north, y=east, z=down).  Keeping this
// convention explicit makes the beach ball, finite fault and 3-D views
// interchangeable and avoids silently mirroring rake or plunge angles.
function _fmVec(x, y, z) { return {x:x, y:y, z:z}; }
function _fmDot(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function _fmNorm(a) {
  var n = Math.sqrt(_fmDot(a, a));
  return n > 1e-12 ? _fmVec(a.x/n, a.y/n, a.z/n) : _fmVec(0, 0, 0);
}
function _fmCross(a, b) {
  return _fmVec(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x);
}
function _fmScale(a, s) { return _fmVec(a.x*s, a.y*s, a.z*s); }
function _fmAdd(a, b) { return _fmVec(a.x+b.x, a.y+b.y, a.z+b.z); }
function _fmMatVec(m, v) {
  return _fmVec(m.xx*v.x+m.xy*v.y+m.xz*v.z,
    m.xy*v.x+m.yy*v.y+m.yz*v.z,
    m.xz*v.x+m.yz*v.y+m.zz*v.z);
}
function _fmNormalizeAzimuth(deg) { return (deg % 360 + 360) % 360; }

/** Convert a NED unit vector to azimuth/plunge (plunge positive downward). */
function _fmAxis(v) {
  var u = _fmNorm(v);
  if (u.z < 0 || (Math.abs(u.z) < 1e-12 && u.x < 0)) u = _fmScale(u, -1);
  var horizontal = Math.sqrt(u.x*u.x + u.y*u.y);
  return {vector:u, azimuthDeg:_fmNormalizeAzimuth(Math.atan2(u.y, u.x)*180/Math.PI),
    plungeDeg:Math.atan2(u.z, horizontal)*180/Math.PI};
}

/** Jacobi eigensolver for a real symmetric 3x3 matrix. */
function _fmEigen(m) {
  var a = [[m.xx,m.xy,m.xz],[m.xy,m.yy,m.yz],[m.xz,m.yz,m.zz]];
  var v = [[1,0,0],[0,1,0],[0,0,1]];
  for (var iter=0; iter<32; iter++) {
    var p=0,q=1,max=Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { p=0; q=2; max=Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > max) { p=1; q=2; max=Math.abs(a[1][2]); }
    if (max < 1e-12) break;
    var theta=0.5*Math.atan2(2*a[p][q], a[q][q]-a[p][p]);
    var c=Math.cos(theta), s=Math.sin(theta);
    for (var k=0;k<3;k++) {
      var apk=a[p][k], aqk=a[q][k]; a[p][k]=c*apk-s*aqk; a[q][k]=s*apk+c*aqk;
    }
    for (var k2=0;k2<3;k2++) {
      var akp=a[k2][p], akq=a[k2][q]; a[k2][p]=c*akp-s*akq; a[k2][q]=s*akp+c*akq;
    }
    for (var r=0;r<3;r++) { var vr=v[r][p], vq=v[r][q]; v[r][p]=c*vr-s*vq; v[r][q]=s*vr+c*vq; }
  }
  var eig=[];
  for (var i=0;i<3;i++) eig.push({value:a[i][i], vector:_fmVec(v[0][i],v[1][i],v[2][i])});
  eig.sort(function(x,y){ return x.value-y.value; });
  return eig;
}

function _fmPlane(normal, slip) {
  var n=_fmNorm(normal), u=_fmNorm(slip);
  // Use the downward-facing normal so dip is in the conventional 0..90 range.
  if (n.z < 0) { n=_fmScale(n,-1); u=_fmScale(u,-1); }
  var horizontal=_fmVec(-n.y,n.x,0);
  if (Math.sqrt(_fmDot(horizontal,horizontal)) < 1e-10) horizontal=_fmVec(1,0,0);
  var s=_fmNorm(horizontal);
  var d=_fmNorm(_fmCross(n,s));
  var dip=Math.acos(Math.max(-1,Math.min(1,n.z)))*180/Math.PI;
  var rake=Math.atan2(_fmDot(u,d),_fmDot(u,s))*180/Math.PI;
  var strike=_fmNormalizeAzimuth(Math.atan2(s.y,s.x)*180/Math.PI);
  return {strikeDeg:strike,dipDeg:dip,rakeDeg:rake,normal:n,slip:u,strikeVector:s,dipVector:d};
}
function _fmPlaneFromAngles(strike, dip, rake) {
  var s=Number(strike)||0, d=Math.max(0,Math.min(90,Number(dip)||0)), r=Number(rake)||0;
  var sr=s*Math.PI/180, dr=d*Math.PI/180, rr=r*Math.PI/180;
  var sv=_fmVec(Math.cos(sr),Math.sin(sr),0);
  var dv=_fmVec(-Math.cos(dr)*Math.sin(sr),Math.cos(dr)*Math.cos(sr),Math.sin(dr));
  var n=_fmNorm(_fmCross(sv,dv)), u=_fmNorm(_fmAdd(_fmScale(sv,Math.cos(rr)),_fmScale(dv,Math.sin(rr))));
  return _fmPlane(n,u);
}

/**
 * Return a standard double-couple focal mechanism from strike/dip/rake.
 * The returned tensor is in NED coordinates and uses seismic moment in Nm.
 * `plane1` is the entered fault plane; `plane2` is its auxiliary nodal plane.
 */
Physics.focalMechanism = function(params) {
  params=params||{};
  var strike=(Number(params.strikeDeg!=null?params.strikeDeg:params.strike)||0)*Math.PI/180;
  var dip=Math.max(0,Math.min(90,Number(params.dipDeg!=null?params.dipDeg:params.dip)||0))*Math.PI/180;
  var rake=(Number(params.rakeDeg!=null?params.rakeDeg:params.rake)||0)*Math.PI/180;
  var mw=Number(params.mw!=null?params.mw:params.mag);
  var m0=Number(params.momentNm);
  if (!(m0>0)) m0=isFinite(mw)?Physics.seismicMoment(mw):1;
  var s=_fmVec(Math.cos(strike),Math.sin(strike),0);
  var d=_fmVec(-Math.cos(dip)*Math.sin(strike),Math.cos(dip)*Math.cos(strike),Math.sin(dip));
  var n=_fmNorm(_fmCross(s,d));
  var u=_fmNorm(_fmAdd(_fmScale(s,Math.cos(rake)),_fmScale(d,Math.sin(rake))));
  var tensor={xx:m0*2*u.x*n.x, yy:m0*2*u.y*n.y, zz:m0*2*u.z*n.z,
    xy:m0*(u.x*n.y+u.y*n.x), xz:m0*(u.x*n.z+u.z*n.x), yz:m0*(u.y*n.z+u.z*n.y)};
  var eig=_fmEigen(tensor);
  var p=_fmAxis(eig[0].vector), b=_fmAxis(eig[1].vector), tAxis=_fmAxis(eig[2].vector);
  var plane1=_fmPlane(n,u);
  // For a pure double couple, slip on one plane is the normal of the other.
  var plane2=_fmPlane(u,n);
  return {coordinateSystem:'NED',type:'double-couple',momentNm:m0,tensor:tensor,
    eigenvalues:[eig[0].value,eig[1].value,eig[2].value],
    axes:{P:p,T:tAxis,B:b},plane1:plane1,plane2:plane2,
    trace:tensor.xx+tensor.yy+tensor.zz};
};

/**
 * P-wave radiation amplitude for a unit ray in NED coordinates. Positive
 * values are compressional first motion and negative values are dilatational.
 */
Physics.focalRadiation = function(tensor, azimuthDeg, takeoffDeg, convention) {
  if (!tensor) return NaN;
  var az = Number(azimuthDeg), takeoff = Number(takeoffDeg);
  if (!isFinite(az) || !isFinite(takeoff)) return NaN;
  var ar = az * Math.PI / 180, tr = Math.max(0, Math.min(180, takeoff)) * Math.PI / 180;
  var z = Math.cos(tr);
  // Default takeoff is measured from the downward vertical (NED). Support
  // common up-from-vertical records explicitly instead of silently mirroring.
  if (String(convention || 'down').toLowerCase() === 'up') z = -z;
  var v = {x:Math.sin(tr) * Math.cos(ar), y:Math.sin(tr) * Math.sin(ar), z:z};
  return tensor.xx*v.x*v.x + tensor.yy*v.y*v.y + tensor.zz*v.z*v.z +
    2*(tensor.xy*v.x*v.y + tensor.xz*v.x*v.z + tensor.yz*v.y*v.z);
};

function _polaritySign(value) {
  if (typeof value === 'number') return value > 0 ? 1 : (value < 0 ? -1 : 0);
  var s = String(value == null ? '' : value).trim().toLowerCase();
  if (/^(\+|p|u|up|c|compress|compression|positive|1|true)$/.test(s)) return 1;
  if (/^(-|n|d|down|dilat|dilatation|negative|0|false)$/.test(s)) return -1;
  return 0;
}

function _polarityAngle(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

/**
 * Invert first-motion P-wave polarities using a coarse-to-fine DC grid.
 * Records use azimuthDeg (clockwise from north), takeoffDeg, and polarity.
 * takeoffDeg is measured from downward vertical by default; set
 * options.takeoffConvention='up' for up-from-vertical observations.
 * This is a polarity-only mechanism estimate, not waveform inversion.
 */
Physics.invertFocalMechanismPolarity = function(records, options) {
  options = options || {};
  if (!Array.isArray(records)) throw new TypeError('Polarity records must be an array');
  var convention = String(options.takeoffConvention || 'down').toLowerCase();
  if (convention !== 'down' && convention !== 'up') throw new RangeError('Unknown takeoff convention');
  var prepared = [], rejected = [];
  for (var ri = 0; ri < records.length; ri++) {
    var r = records[ri] || {}, az = _polarityAngle(r.azimuthDeg != null ? r.azimuthDeg : (r.azimuth_deg != null ? r.azimuth_deg : (r.azimuth != null ? r.azimuth : r.az)), NaN),
      tk = _polarityAngle(r.takeoffDeg != null ? r.takeoffDeg : (r.takeoff_deg != null ? r.takeoff_deg : (r.takeoff != null ? r.takeoff : r.takeoffAngle)), NaN),
      sign = _polaritySign(r.polarity != null ? r.polarity : (r.firstMotion != null ? r.firstMotion : r.sign)),
      weight = Number(r.weight);
    if (!isFinite(az) || !isFinite(tk) || tk < 0 || tk > 180 || !sign) { rejected.push({index:ri,reason:'invalid azimuth/takeoff/polarity'}); continue; }
    prepared.push({index:ri, azimuthDeg:_fmNormalizeAzimuth(az), takeoffDeg:tk, polarity:sign,
      weight:isFinite(weight) && weight > 0 ? Math.min(weight, 100) : 1, station:r.station || r.id || ''});
  }
  var minRecords = Math.max(3, Number(options.minRecords) || 3);
  if (prepared.length < minRecords) throw new RangeError('At least ' + minRecords + ' valid polarity records are required');
  var rays = prepared.map(function(r) {
    var ar=r.azimuthDeg*Math.PI/180, tr=r.takeoffDeg*Math.PI/180, z=Math.cos(tr);
    if (convention === 'up') z=-z;
    return {x:Math.sin(tr)*Math.cos(ar),y:Math.sin(tr)*Math.sin(ar),z:z};
  });
  var threshold = Number(options.radiationThreshold);
  if (!(threshold >= 0)) threshold = 0.04;
  var candidates = [], best = null;
  function evaluate(strike, dip, rake, keep) {
    var fm = Physics.focalMechanism({strike:strike,dip:dip,rake:rake,momentNm:1}), weighted=0, mismatch=0, margin=0;
    for (var i=0;i<prepared.length;i++) {
      var v=rays[i], m=fm.tensor, rad=m.xx*v.x*v.x+m.yy*v.y*v.y+m.zz*v.z*v.z+2*(m.xy*v.x*v.y+m.xz*v.x*v.z+m.yz*v.y*v.z);
      var pred = Math.abs(rad) < threshold ? 0 : (rad > 0 ? 1 : -1), w=prepared[i].weight;
      weighted += w; if (pred !== prepared[i].polarity) mismatch += w * (pred === 0 ? 0.5 : 1);
      margin += w * Math.min(1, Math.abs(rad) / Math.max(threshold, 1e-9));
    }
    var score = mismatch / weighted - (Number(options.marginWeight) || 0.02) * margin / weighted;
    var item={strikeDeg:_fmNormalizeAzimuth(strike),dipDeg:dip,rakeDeg:rake,score:score,mismatch:mismatch/weighted,margin:margin/weighted,fm:fm};
    if (keep) {
      candidates.push(item); candidates.sort(function(a,b){return a.score-b.score;});
      if (candidates.length>24) candidates.length=24;
    }
    if (!best || item.score < best.score) best=item;
  }
  function scan(s0,s1,ss,d0,d1,ds,r0,r1,rs) {
    for (var s=s0;s<=s1+1e-9;s+=ss) for (var d=d0;d<=d1+1e-9;d+=ds) for (var r=r0;r<=r1+1e-9;r+=rs) evaluate(s,d,r,true);
  }
  var coarse=Number(options.coarseStep)||10;
  scan(0,350,coarse,Math.max(1,Number(options.minDip)||1),90,coarse,-180,180,coarse);
  var b0=best;
  scan(b0.strikeDeg-12,b0.strikeDeg+12,Math.max(1,Number(options.fineStep)||2),Math.max(1,b0.dipDeg-12),Math.min(90,b0.dipDeg+12),Math.max(1,Number(options.fineStep)||2),b0.rakeDeg-12,b0.rakeDeg+12,Math.max(1,Number(options.fineStep)||2));
  b0=best;
  scan(b0.strikeDeg-3,b0.strikeDeg+3,0.5,Math.max(1,b0.dipDeg-3),Math.min(90,b0.dipDeg+3),0.5,b0.rakeDeg-3,b0.rakeDeg+3,0.5);
  best=best || b0;
  var nearTol=Number(options.nearMisfitTolerance); if (!(nearTol>0)) nearTol=0.05;
  var near=candidates.filter(function(c){return c.score <= best.score+nearTol;});
  function angularDistance(a,b) {
    var ds=Math.abs(((a.strikeDeg-b.strikeDeg+180)%360)-180), dr=Math.abs(a.dipDeg-b.dipDeg), dk=Math.abs(a.rakeDeg-b.rakeDeg);
    return Math.sqrt(ds*ds+dr*dr+dk*dk);
  }
  var radius=0; for(var ni=0;ni<near.length;ni++) radius=Math.max(radius,angularDistance(best,near[ni]));
  var predictions=prepared.map(function(r,i){
    var rad=Physics.focalRadiation(best.fm.tensor,r.azimuthDeg,r.takeoffDeg,convention), pred=Math.abs(rad)<threshold?0:(rad>0?1:-1);
    return {index:r.index,station:r.station,azimuthDeg:r.azimuthDeg,takeoffDeg:r.takeoffDeg,observedPolarity:r.polarity,predictedPolarity:pred,radiation:rad,correct:pred===r.polarity};
  });
  var correct=predictions.filter(function(p){return p.correct;}).length;
  var gap=candidates.length>1 ? candidates[1].score-best.score : Infinity;
  return {type:'first-motion-polarity',coordinateSystem:'NED',takeoffConvention:convention,
    mechanism:best.fm,strikeDeg:best.strikeDeg,dipDeg:best.dipDeg,rakeDeg:best.rakeDeg,
    misfit:best.score,mismatchRate:best.mismatch,weightedRecords:prepared.length,rejectedRecords:rejected.length,
    usedRecords:prepared.length,rejected:rejected,correctCount:correct,confidence:{nearMisfitTolerance:nearTol,radiusDeg:radius,objectiveGap:gap,level:prepared.length>=12&&best.mismatch<0.15?'A':(prepared.length>=6&&best.mismatch<0.3?'B':'C')},
    ambiguity:{isAmbiguous:near.length>1,nearSolutions:near.slice(0,8).map(function(c){return {strikeDeg:c.strikeDeg,dipDeg:c.dipDeg,rakeDeg:c.rakeDeg,misfit:c.score};})},
    observations:predictions};
};

/**
 * Calibrate a first-motion polarity catalogue against an independently
 * supplied reference mechanism. The reference must come from a cited
 * waveform/moment-tensor solution; it is never inferred from the catalogue.
 * The optimizer estimates global azimuth/takeoff offsets and flags stations
 * with a persistent polarity reversal. Returned corrected records are intended
 * for a subsequent inversion, not as a replacement for the original data.
 */
Physics.calibratePolarityRecords = function(records, reference, options) {
  options = options || {};
  if (!Array.isArray(records)) throw new TypeError('Polarity records must be an array');
  if (!reference) throw new TypeError('Reference mechanism is required');
  var fm = reference.tensor ? Physics.focalMechanismFromTensor(reference) : Physics.focalMechanism(reference);
  var tensor = fm && fm.tensor; if (!tensor) throw new TypeError('Reference mechanism has no tensor');
  var convention = String(options.takeoffConvention || 'down').toLowerCase();
  if (convention !== 'down' && convention !== 'up') throw new RangeError('Unknown takeoff convention');
  var threshold = Number(options.radiationThreshold); if (!(threshold >= 0)) threshold = 0.04;
  var valid=[], rejected=[];
  for (var i=0;i<records.length;i++) {
    var r=records[i]||{}, az=_polarityAngle(r.azimuthDeg!=null?r.azimuthDeg:(r.azimuth_deg!=null?r.azimuth_deg:r.azimuth),NaN),
      tk=_polarityAngle(r.takeoffDeg!=null?r.takeoffDeg:(r.takeoff_deg!=null?r.takeoff_deg:(r.takeoff!=null?r.takeoff:r.takeoffAngle)),NaN),
      sign=_polaritySign(r.polarity!=null?r.polarity:(r.firstMotion!=null?r.firstMotion:r.sign));
    if(!isFinite(az)||!isFinite(tk)||tk<0||tk>180||!sign){rejected.push({index:i,reason:'invalid azimuth/takeoff/polarity'});continue;}
    valid.push({index:i,record:r,azimuthDeg:_fmNormalizeAzimuth(az),takeoffDeg:tk,polarity:sign,station:String(r.station||r.stationId||r.id||'unknown')});
  }
  var minRecords=Math.max(3,Number(options.minRecords)||3); if(valid.length<minRecords) throw new RangeError('At least '+minRecords+' valid polarity records are required for calibration');
  function score(azOffset,tkOffset,byStationFlip) {
    var total=0,wrong=0,usable=0;
    for(var j=0;j<valid.length;j++){
      var q=valid[j], rad=Physics.focalRadiation(tensor,q.azimuthDeg+azOffset,q.takeoffDeg+tkOffset,convention);
      if(!isFinite(rad)||Math.abs(rad)<threshold)continue;
      var pred=rad>0?1:-1; if(byStationFlip&&byStationFlip[q.station])pred=-pred;
      total++; if(pred!==q.polarity)wrong++;
      usable++;
    }
    return {total:total,wrong:wrong,rate:total?wrong/total:1};
  }
  var coarseStep=Math.max(.5,Number(options.offsetStep)||1), best={azimuthOffsetDeg:0,takeoffOffsetDeg:0,rate:Infinity,total:0};
  for(var ao=-20;ao<=20+1e-9;ao+=coarseStep)for(var to=-10;to<=10+1e-9;to+=coarseStep){var s=score(ao,to,null);if(s.total>=minRecords&&s.rate<best.rate){best={azimuthOffsetDeg:ao,takeoffOffsetDeg:to,rate:s.rate,total:s.total};}}
  var stationStats={}, base=score(0,0,null), aligned=score(best.azimuthOffsetDeg,best.takeoffOffsetDeg,null);
  valid.forEach(function(q){
    var rad=Physics.focalRadiation(tensor,q.azimuthDeg+best.azimuthOffsetDeg,q.takeoffDeg+best.takeoffOffsetDeg,convention);
    if(!isFinite(rad)||Math.abs(rad)<threshold)return;
    var pred=rad>0?1:-1, g=stationStats[q.station]||(stationStats[q.station]={station:q.station,total:0,wrong:0,flip:false});g.total++;if(pred!==q.polarity)g.wrong++;
  });
  var flipMap={}; Object.keys(stationStats).forEach(function(k){var g=stationStats[k];g.mismatchRate=g.wrong/g.total;g.flip=g.total>=Math.max(3,Number(options.stationMinRecords)||3)&&g.mismatchRate>=0.75;if(g.flip)flipMap[k]=true;});
  var correctedScore=score(best.azimuthOffsetDeg,best.takeoffOffsetDeg,flipMap);
  var corrected=records.map(function(r,idx){var q=valid.find(function(x){return x.index===idx;});if(!q||!flipMap[q.station])return r;var c=Object.assign({},r);if(typeof c.polarity==='number')c.polarity=-c.polarity;else if(c.firstMotion!=null)c.firstMotion=_polaritySign(c.firstMotion)>0?'N':'P';else c.polarity=_polaritySign(c.polarity)>0?'N':'P';c.calibrationPolarityFlipped=true;return c;});
  var flippedStations=Object.keys(flipMap);
  return {type:'first-motion-polarity-calibration',coordinateSystem:'NED',takeoffConvention:convention,
    reference:{type:fm.type,strikeDeg:fm.plane1.strikeDeg,dipDeg:fm.plane1.dipDeg,rakeDeg:fm.plane1.rakeDeg,provenance:reference.provenance||null},
    inputRecords:records.length,usedRecords:valid.length,rejectedRecords:rejected.length,rejected:rejected,
    before:{mismatchRate:base.rate,usableRecords:base.total},globalOffset:{azimuthDeg:best.azimuthOffsetDeg,takeoffDeg:best.takeoffOffsetDeg},
    afterGlobal:{mismatchRate:aligned.rate,usableRecords:aligned.total},afterStationFlip:{mismatchRate:correctedScore.rate,usableRecords:correctedScore.total},
    stationStats:Object.keys(stationStats).map(function(k){return stationStats[k];}),flippedStations:flippedStations,correctedRecords:corrected,
    provenance:options.provenance||null,warning:'Calibration is only valid for the supplied reference event and instrument/data processing chain; do not apply offsets blindly to other events.'};
};

/**
 * Build a focal-mechanism result from an observed moment tensor. Inputs are
 * normalized NED components (xx,yy,zz,xy,xz,yz). When nodal planes are not
 * supplied, the principal P/T axes are used to construct the equivalent DC
 * planes. This preserves the observed tensor for provenance while retaining
 * the renderer's existing plane/axis interface.
 */
Physics.focalMechanismFromTensor = function(params) {
  params = params || {};
  var t = params.tensor || params;
  var tensor = {xx:Number(t.xx)||0, yy:Number(t.yy)||0, zz:Number(t.zz)||0,
    xy:Number(t.xy)||0, xz:Number(t.xz)||0, yz:Number(t.yz)||0};
  var trace = tensor.xx + tensor.yy + tensor.zz, iso = trace / 3;
  var dev = {xx:tensor.xx-iso, yy:tensor.yy-iso, zz:tensor.zz-iso, xy:tensor.xy, xz:tensor.xz, yz:tensor.yz};
  var eig = _fmEigen(dev);
  var p = _fmAxis(eig[0].vector), b = _fmAxis(eig[1].vector), ta = _fmAxis(eig[2].vector);
  var dcP = _fmNorm(_fmAdd(eig[0].vector, eig[2].vector));
  var dcT = _fmNorm(_fmAdd(eig[2].vector, _fmScale(eig[0].vector, -1)));
  var plane1 = params.plane1;
  if (plane1 && plane1.strike != null) {
    plane1 = _fmPlaneFromAngles(plane1.strike, plane1.dip, plane1.rake);
  } else {
    plane1 = _fmPlane(dcP, dcT);
  }
  var plane2 = params.plane2;
  if (plane2 && plane2.strike != null) plane2 = _fmPlaneFromAngles(plane2.strike, plane2.dip, plane2.rake);
  else plane2 = _fmPlane(plane1.slip, plane1.normal);
  var devNorm = Math.sqrt(dev.xx*dev.xx+dev.yy*dev.yy+dev.zz*dev.zz+2*(dev.xy*dev.xy+dev.xz*dev.xz+dev.yz*dev.yz));
  var fullNorm = Math.sqrt(tensor.xx*tensor.xx+tensor.yy*tensor.yy+tensor.zz*tensor.zz+2*(tensor.xy*tensor.xy+tensor.xz*tensor.xz+tensor.yz*tensor.yz));
  var mIso=Math.abs(iso), mDev=(Math.abs(eig[0].value)+Math.abs(eig[2].value))/2;
  var total=mIso+mDev, epsilon=mDev?(-eig[1].value/Math.max(Math.abs(eig[0].value),Math.abs(eig[2].value))):0;
  epsilon=Math.max(-0.5,Math.min(0.5,epsilon));
  var devShare=total?mDev/total:0, isoShare=total?mIso/total:0, clvdWithin=Math.min(1,2*Math.abs(epsilon));
  var uncertainty=null, sigma=params.uncertainty&&params.uncertainty.frobeniusNorm;
  if(sigma>0){
    function axisError(gap){return Math.atan2(sigma,Math.max(gap,1e-30))*180/Math.PI;}
    uncertainty={tensorSigmaNorm:sigma,axisDeg:{P:axisError(eig[1].value-eig[0].value),B:axisError(Math.min(eig[1].value-eig[0].value,eig[2].value-eig[1].value)),T:axisError(eig[2].value-eig[1].value)}};
    uncertainty.planeDeg=Math.max(uncertainty.axisDeg.P,uncertainty.axisDeg.T);
  }
  // Scalar seismic moment is the Frobenius norm divided by sqrt(2) for a
  // symmetric moment tensor. Prefer an authoritative catalog scalar moment.
  var scalarMoment=Number(params.momentNm);
  if (!(scalarMoment>0)) scalarMoment=fullNorm/Math.sqrt(2);
  return {coordinateSystem:'NED', type:'observed-moment-tensor', momentNm:scalarMoment,
    tensor:tensor, eigenvalues:eig.map(function(e){return e.value;}), axes:{P:p,T:ta,B:b},
    plane1:plane1, plane2:plane2, trace:trace,
    decomposition:{isoFraction:isoShare,dcFraction:devShare*(1-clvdWithin),clvdFraction:devShare*clvdWithin,
      deviatoricFraction:devShare,deviatoricNorm:devNorm,epsilon:epsilon},
    uncertainty:uncertainty,quality:params.quality||null,provenance:params.provenance || null};
};

// ================================================================
//  GMPE — log model (hand-tuned, validated default)
// ================================================================

/**
 * PGA from log-linear attenuation with near-field saturation. log10(PGA)=attA*effM-attB*log10(Reff)-anelastic*Reff+attC @param {number} mag (Mw) @param {number} Rkm @param {number} attA @param {number} attB @param {number} attC @param {number} anelastic @returns {number} PGA in gal
 */
Physics.pgaLog = function(mag, Rkm, attA, attB, attC, anelastic) {
  var effM = mag <= 9 ? mag : 9 + (mag - 9) * 0.3;
  // Near-field saturation: R_eff = sqrt(R^2 + h^2), prevents PGA → ∞ as R → 0
  // Bound the pseudo-depth term. If it grows without limit, Reff grows faster
  // than the magnitude term and large shallow events are underpredicted.
  var h = Math.min(5, Math.pow(10, 0.35 * effM - 1.0)); // saturation distance (km)
  var Reff = Math.sqrt(Rkm * Rkm + h * h);
  return Math.pow(10, attA*effM - attB*Math.log10(Reff) - anelastic*Reff + attC);
};

/**
 * PGV from log-linear model with near-field saturation. Coeffs from config. @param {number} mag (Mw) @param {number} Rkm @param {number} anelastic @returns {number} PGV in cm/s
 */
Physics.pgvLog = function(mag, Rkm, anelastic) {
  var effM = mag <= 9 ? mag : 9 + (mag - 9) * 0.3;
  // Near-field saturation: use same Reff as PGA to prevent PGV blow-up
  // Match PGA saturation so PGV does not suppress large shallow events.
  var h = Math.min(5, Math.pow(10, 0.35 * effM - 1.0));
  var Reff = Math.sqrt(Rkm * Rkm + h * h);
  var pgvA = (typeof cfgGet !== 'undefined') ? cfgGet('pgvA') : 0.48;
  var pgvB = (typeof cfgGet !== 'undefined') ? cfgGet('pgvB') : 1.46;
  var pgvC = (typeof cfgGet !== 'undefined') ? cfgGet('pgvC') : -1.20;
  return Math.pow(10, pgvA*effM - pgvB*Math.log10(Reff) - anelastic*Reff + pgvC);
};

// ================================================================
//  GMPE — Si & Midorikawa (1999) for Japan
// ================================================================

Physics.pgaSiMid = function(mag, Rkm, depthKm, src) {
  var d = _simidDs(src);
  return Math.pow(10, 0.50*mag + 0.0036*depthKm + 0.61 + d
                      - Math.log10(Rkm + 0.0055*Math.pow(10, 0.50*mag)) - 0.003*Rkm);
};

Physics.pgvSiMid = function(mag, Rkm, depthKm, src) {
  var d = _simidDs(src);
  return Math.pow(10, 0.58*mag + 0.0038*depthKm - 1.29 + d
                      - Math.log10(Rkm + 0.0028*Math.pow(10, 0.50*mag)) - 0.002*Rkm);
};

// ================================================================
//  GMPE ROUTING — dispatches to the active model
// ================================================================

/**
 * Compute PGA with GMPE routing and source-type boost. @param {number} mag @param {number} Rkm @param {number} depthKm @param {string} [epicenterSrc] @param {number} [vs30] @returns {number} PGA in gal
 */
Physics.resolveGmpModel = function(gmpModel, src, mw) {
  if (gmpModel !== 'auto') return gmpModel;
  // Class-based routing (v5.4, validate_accuracy.py n=52): Si & Midorikawa
  // wins on crustal events; Zhao 2006 (with the saturation guard) is far
  // better for great interplate ruptures (Tohoku M9 RMS 2.47 -> 1.21) and
  // offshore/intraslab events (Fukushima-oki 2021 RMS 0.95 -> 0.61).
  // Global RMS improves 1.278 -> ~0.95. The legacy log models remain
  // available explicitly for reproducibility.
  if (src === 'interplate' || src === 'intraslab') return 'zhao2006';
  return 'si-midorikawa';
};

Physics.calcPGA = function(mag, Rkm, gmpModel, depthKm, eventMw, sliderMw, epicenterSrc, attA, attB, attC, anelastic, vs30, rake) {
  if (Rkm <= 0.5) Rkm = 0.5;
  var mw = (eventMw != null) ? (mag + (eventMw - sliderMw)) : mag;
  var src = epicenterSrc || Physics.sourceType(depthKm);
  gmpModel = Physics.resolveGmpModel(gmpModel, src, mw);
  if (gmpModel === 'kanno2006') return Physics.pgaKanno(mw, Rkm, depthKm, vs30 || 400);
  // rake feeds the Zhao-2006 crustal reverse-fault FR term — without it the
  // term was dead code on every routing path (reverse events under-predicted).
  if (gmpModel === 'zhao2006') return Physics.pgaZhao2006(mw, Rkm, depthKm, src, vs30, rake);
  if (gmpModel === 'si-midorikawa' || gmpModel === 'log-ff') {
    if (gmpModel === 'si-midorikawa') return Physics.pgaSiMid(mw, Rkm, depthKm, src);
    var srcBoost = _simidDs(src);
    return Physics.pgaLog(mw, Rkm, attA, attB, attC, anelastic) * Math.pow(10, srcBoost);
  }
  return Physics.pgaLog(mw, Rkm, attA, attB, attC, anelastic);
};

/**
 * Compute PGV with GMPE routing and source-type boost. @param {number} mag @param {number} Rkm @param {number} depthKm @param {string} [epicenterSrc] @param {number} [vs30] @returns {number} PGV in cm/s
 */
Physics.calcPGV = function(mag, Rkm, gmpModel, depthKm, eventMw, sliderMw, epicenterSrc, anelastic, vs30, rake) {
  if (Rkm <= 0.5) Rkm = 0.5;
  var mw = (eventMw != null) ? (mag + (eventMw - sliderMw)) : mag;
  var src = epicenterSrc || Physics.sourceType(depthKm);
  gmpModel = Physics.resolveGmpModel(gmpModel, src, mw);
  if (gmpModel === 'kanno2006') return Physics.pgvKanno(mw, Rkm, depthKm, vs30 || 400);
  if (gmpModel === 'zhao2006') return Physics.pgvZhao2006(mw, Rkm, depthKm, src, vs30, rake);
  if (gmpModel === 'si-midorikawa' || gmpModel === 'log-ff') {
    if (gmpModel === 'si-midorikawa') return Physics.pgvSiMid(mw, Rkm, depthKm, src);
    return Physics.pgvLog(mw, Rkm, anelastic) * Math.pow(10, _simidDs(src));
  }
  return Physics.pgvLog(mw, Rkm, anelastic);
};

// ================================================================
//  JMA INTENSITY
// ================================================================

/**
 * JMA instrumental seismic intensity. I=max(2.23*log10(PGA*0.94)+0.5, 2.68+1.72*log10(PGV)) @param {number} pgaGal @param {number} pgvCms @returns {number} JMA intensity (0~7+)
 */
Physics.calcJmaIntensity = function(pgaGal, pgvCms) {
  if (pgaGal <= 0.01 && pgvCms <= 0.001) return 0;
  var iPGa = pgaGal > 0.01 ? 2.23*Math.log10(pgaGal*0.94) + 0.5 : 0;
  var iPGv = pgvCms > 0.001 ? 2.68 + 1.72*Math.log10(pgvCms) : 0;
  var iSeis = (iPGv > 0 && iPGv > iPGa) ? iPGv : iPGa;
  return Math.max(0, iSeis);
};

/**
 * Convert JMA intensity to Shindo scale (0-7, 5-/5+/6-/6+). @param {number} I @returns {number|string} Shindo level
 */
Physics.intensityToShindo = function(I) {
  if (I < 0.5) return 0; if (I < 1.5) return 1; if (I < 2.5) return 2; if (I < 3.5) return 3;
  if (I < 4.5) return 4; if (I < 5.0) return '5-'; if (I < 5.5) return '5+';
  if (I < 6.0) return '6-'; if (I < 6.5) return '6+'; return 7;
};

Physics.shindoNum = function(s) { return typeof s === 'string' ? (Physics.SHINDO_SCORE[s] != null ? Physics.SHINDO_SCORE[s] : parseInt(s) + 0.5) : s; };

Physics.shindoScore = function(s) {
  return Physics.SHINDO_SCORE[s] !== undefined ? Physics.SHINDO_SCORE[s]
    : (typeof s === 'string' ? parseInt(s) : s);
};

// ================================================================
//  STATION SHAKING PHASE ENVELOPE (P coda -> S ramp -> peak)
// ================================================================

// Seconds from S arrival to full peak: the S-wave train and the running
// intensity window need time to converge; longer for bigger ruptures.
// M<=5 -> 2 s, M7 -> 4.5 s, M9 -> 7.5 s (cap 12 s).
Physics.waveSRampDur = function(mag) {
  return Math.min(12, Math.max(2, 1.5 * ((mag || 5) - 4)));
};

// P-phase display ceiling ~= shindo 4 (I < 4.5): even a great quake P waves
// rarely read higher on a running intensity window. PGA branch: 66 gal ->
// I 4.49; PGV branch: 11 cm/s -> I 4.47.
Physics.P_PHASE_MAX_PGA = 66;
Physics.P_PHASE_MAX_PGV = 11;

/**
 * Station shaking envelope as a fraction of peak amplitude.
 * 0 before P arrival; P phase grows only 0.05 -> 0.12 (P coda stays weak);
 * from S arrival ramps 0.12 -> 1.0 over waveSRampDur(mag); 1.0 afterwards
 * (caller applies hold/decay). During the P phase the caller should also
 * clamp amplitude to P_PHASE_MAX_PGA / P_PHASE_MAX_PGV so a great-quake
 * near-field peak cannot leak shindo-5- class readings at P arrival.
 */
Physics.wavePhaseEnvelope = function(now, pArr, sArr, mag) {
  if (now < pArr) return 0;
  if (now < sArr) return 0.05 + 0.07 * ((now - pArr) / Math.max(sArr - pArr, 0.1));
  var f = (now - sArr) / Physics.waveSRampDur(mag);
  return f >= 1 ? 1 : 0.12 + 0.88 * f;
};

// ================================================================
//  IASP91 DEPTH-DEPENDENT WAVE SPEED MODEL
// ================================================================

// Simplified IASP91 layered velocity model [topKm, Vp km/s, Vs km/s]
Physics.IASP91 = [
  [0,   5.80, 3.36],
  [20,  6.50, 3.75],
  [35,  8.04, 4.48],
  [120, 8.30, 4.51],
  [210, 8.90, 4.77],
  [410, 10.0, 5.37],
  [660, 10.75, 5.95]
];

// Average P-wave velocity from surface to depthKm (time-weighted)
Physics.iasp91PVelocity = function(depthKm) {
  if (depthKm <= 0) return Physics.IASP91[0][1];
  var model = Physics.IASP91;
  var totalTime = 0, totalDist = 0;
  for (var i = 0; i < model.length; i++) {
    var top = model[i][0], vp = model[i][1];
    var bot = (i + 1 < model.length) ? model[i + 1][0] : 9999;
    if (depthKm <= top) break;
    var segTop = top, segBot = Math.min(bot, depthKm);
    var thickness = segBot - segTop;
    if (thickness > 0) { totalDist += thickness; totalTime += thickness / vp; }
  }
  return totalTime > 0 ? totalDist / totalTime : Physics.IASP91[0][1];
};

// Average S-wave velocity from surface to depthKm
Physics.iasp91SVelocity = function(depthKm) {
  if (depthKm <= 0) return Physics.IASP91[0][2];
  var model = Physics.IASP91;
  var totalTime = 0, totalDist = 0;
  for (var i = 0; i < model.length; i++) {
    var top = model[i][0], vs = model[i][2];
    var bot = (i + 1 < model.length) ? model[i + 1][0] : 9999;
    if (depthKm <= top) break;
    var segTop = top, segBot = Math.min(bot, depthKm);
    var thickness = segBot - segTop;
    if (thickness > 0) { totalDist += thickness; totalTime += thickness / vs; }
  }
  return totalTime > 0 ? totalDist / totalTime : Physics.IASP91[0][2];
};

// ================================================================
//  SITE EFFECTS
// ================================================================

Physics.stationRand = function(lat, lng) {
  var x = Math.sin(lat*127.1+lng*311.7)*43758.5453; return x - Math.floor(x);
};

Physics.soilAmp = function(lat, lng, siteModel, siteBase, siteSoftMax, siteHardMin, provinces) {
  if (siteModel === 'none') return siteBase;
  for (var i = 0; i < provinces.length; i++) {
    var p = provinces[i];
    if (lat >= p[0] && lat <= p[1] && lng >= p[2] && lng <= p[3])
      return siteBase + (p[4] - 1.0) * (siteSoftMax - siteHardMin) / 0.77;
  }
  return siteHardMin;
};

// Vs30-based relative site amplification.
// Reference Vs30 = 760 m/s (NEHRP B/C boundary). The returned value is a
// bounded multiplier, not a unit conversion.
/**
 * Site amplification relative to Vs30=760 m/s. @param {number} vs30 (m/s) @param {string} imt (pga|pgv) @returns {number} Amplification factor
 */
Physics.vs30Amplification = function(vs30, imt) {
  if (!vs30 || vs30 <= 0) return 1.0;
  var v = Math.max(150, Math.min(1500, vs30));
  var refVs = 760;
  var exp = (imt === 'pgv') ? 0.55 : 0.35;
  var amp = Math.pow(refVs / v, exp);
  var minAmp = (imt === 'pgv') ? 0.60 : 0.70;
  var maxAmp = (imt === 'pgv') ? 3.20 : 2.40;
  return Math.max(minAmp, Math.min(maxAmp, amp));
};

// ================================================================
//  v4.3: NONLINEAR SITE AMPLIFICATION (Seyhan & Stewart 2014)
//  Reduces amplification at high rock PGA on soft soils.
//  At low intensities (PGA_rock << 0.1g), result ≈ linear amp.
// ================================================================

/**
 * Nonlinear site amplification per Seyhan & Stewart (2014) NGA-West2.
 * amp_nl = amp_lin * exp(f_nl) where f_nl depends on Vs30 and rock PGA.
 * @param {number} vs30 (m/s) — site Vs30
 * @param {string} imt — 'pga' or 'pgv'
 * @param {number} rockPgaGal — reference-rock PGA in gal (cm/s²)
 * @returns {number} Nonlinear amplification factor
 */
Physics.vs30AmplificationNL = function(vs30, imt, rockPgaGal) {
  // Step 1: Linear amplification (existing formula)
  var ampLin = Physics.vs30Amplification(vs30, imt);
  if (!vs30 || vs30 <= 0 || !rockPgaGal || rockPgaGal <= 0) return ampLin;

  // Step 2: Convert rock PGA from gal to g (Seyhan & Stewart use g)
  var pgaRockG = Math.max(0.001, rockPgaGal / 980.665);

  // Step 3: Period-dependent coefficients (PGA proxy: T ≈ 0.01 s)
  // PGV coefficients are approximate — SS14 is primarily a spectral model
  var c, f3, f4, f5;
  if (imt === 'pgv') {
    c  = 0.05;  f3 = 0.05;  f4 = -0.12;  f5 = -0.0045;
  } else {
    c  = 0.10;  f3 = 0.10;  f4 = -0.16;  f5 = -0.00401;
  }

  // Step 4: Linear offset term f1 = c * ln(Vs30 / Vref)
  var f1 = c * Math.log(Math.max(vs30, 150) / 760);

  // Step 5: Vs30-dependent curvature f2
  var vRef = Math.min(vs30, 760);
  var f2 = f4 * (Math.exp(f5 * (vRef - 360)) - Math.exp(f5 * (760 - 360)));

  // Step 6: Nonlinear correction f_nl
  var f_nl = f1 + f2 * Math.log((pgaRockG + f3) / f3);

  // Step 7: Combined amplification
  var amp = ampLin * Math.exp(f_nl);

  // Step 8: Clamp — allow more deamplification than linear, same upper bound
  var minAmp = (imt === 'pgv') ? 0.40 : 0.50;
  var maxAmp = (imt === 'pgv') ? 3.20 : 2.40;
  return Math.max(minAmp, Math.min(maxAmp, amp));
};

// ================================================================
//  v5.5 R2: 1D SH-WAVE TRANSFER FUNCTION (Thomson–Haskell propagator)
//
//  Vertically incident SH waves through a horizontally layered soil
//  column over an elastic halfspace (the KiK-net borehole geometry).
//  The surface motion is normalized against the free-surface (outcrop)
//  motion of the halfspace, so a homogeneous column returns exactly 1.
//
//  State vector [u; tau] propagates downward from the free surface
//  (tau(0)=0) through each layer of thickness h:
//    u(z+h)   =  u*cos(a) + tau/(Z*w) * sin(a)
//    tau(z+h) = -u*Z*w*sin(a) + tau*cos(a)     a = w*h/Vs*,  Z = rho*Vs*
//  With the halfspace radiation condition tau_b = i*Z_b*w*(I-R),
//  u_b = I+R, the outcrop amplification is
//    A(w) = 1 / (M11 + M21/(i*Z_b*w))
//  which for a single layer reduces to the analytic textbook form
//  Z_b / (Z_b*cos(a) + i*Z_1*sin(a))   (f0 = Vs1/(4H), |A|max -> Z_b/Z_1).
//  Hysteretic damping enters as a complex Vs* = Vs*(1+i*zeta).
// ================================================================

/** Approximate bulk density (t/m³) from S-wave velocity, interpolated over
 *  typical sediment-to-rock values. KiK-net PS logs carry measured density
 *  when available — this default is only for synthetic/estimated profiles. */
Physics.densityFromVs = function(vs) {
  var anchors = [[150, 1.65], [400, 1.90], [700, 2.10], [1500, 2.40], [3000, 2.65]];
  if (!(vs > 0)) return 2.0;
  if (vs <= anchors[0][0]) return anchors[0][1];
  for (var i = 1; i < anchors.length; i++) {
    if (vs <= anchors[i][0]) {
      var t = (vs - anchors[i - 1][0]) / (anchors[i][0] - anchors[i - 1][0]);
      return anchors[i - 1][1] + t * (anchors[i][1] - anchors[i - 1][1]);
    }
  }
  return anchors[anchors.length - 1][1];
};

// ================================================================
//  v5.5 B5: JAPAN-FITTED ORTHOGONAL-COMPONENT EPSILON CORRELATION
//
//  Jayaram, Baker, Okano, Ishida, McCann & Mihara (2011), "Correlation of
//  response spectral values in Japanese ground motions", Earthquakes and
//  Structures 2(4), 357-376 — Eq. (6), fitted on K-NET/KiK-net records
//  (the paper notes Japanese ground motions correlate MORE strongly between
//  orthogonal components than previous worldwide datasets). Verified
//  verbatim against the author-hosted PDF (glyph-level extraction).
//
//  The same paper's period-to-period correlation tables (K-NET/KiK-net
//  specific, recommended over Baker & Jayaram 2008 for Japanese sites)
//  remain tabular in the paper — digitize before a conditional-spectrum
//  implementation; do NOT silently substitute the NGA-fit B&J2008 form.
// ================================================================
Physics.orthogonalComponentCorrelation = function(periodSec) {
  if (!(periodSec > 0)) return null;
  var rho = periodSec < 0.1 ? 0.96 : 0.865 - 0.041 * Math.log(periodSec);
  return Math.max(0, Math.min(1, rho));
};

// Minimal complex helpers ({re, im}) used by the SH propagator.
function cAdd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
function cNeg(a) { return { re: -a.re, im: -a.im }; }
function cMul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cScale(a, s) { return { re: a.re * s, im: a.im * s }; }
function cDiv(a, b) {
  var d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function cAbs(a) { return Math.sqrt(a.re * a.re + a.im * a.im); }
// cos/sin of a complex argument.
function cCos(a) {
  return { re: Math.cos(a.re) * Math.cosh(a.im), im: -Math.sin(a.re) * Math.sinh(a.im) };
}
function cSin(a) {
  return { re: Math.sin(a.re) * Math.cosh(a.im), im: Math.cos(a.re) * Math.sinh(a.im) };
}

/**
 * 1D SH transfer function (surface / halfspace-outcrop) for a layered
 * velocity profile.
 * @param {Array} profile [{vs (m/s), thickness (m — ignored for the last
 *   entry, which is the elastic halfspace), density? (t/m³),
 *   damping? (hysteretic zeta, default 0.02)}]
 * @param {Array} freqs frequencies in Hz (must include f>0; w=0 is singular)
 * @returns {Array|null} |A(f)| amplification factors, same order as freqs
 */
Physics.shTransferFunction = function(profile, freqs) {
  if (!profile || profile.length < 2 || !freqs || !freqs.length) return null;
  var layers = [];
  for (var i = 0; i < profile.length; i++) {
    var p = profile[i];
    var vs = Number(p.vs);
    if (!(vs > 0)) return null;
    var zeta = p.damping == null ? 0.02 : Number(p.damping);
    var rho = p.density == null ? Physics.densityFromVs(vs) : Number(p.density);
    if (!(rho > 0)) return null;
    layers.push({
      // Vs* = Vs(1 + i*zeta)
      vsC: { re: vs, im: vs * zeta },
      rho: rho,
      thickness: Number(p.thickness)
    });
  }
  var bed = layers[layers.length - 1];
  var Zb = cScale(bed.vsC, bed.rho); // rho real: Zb = rho * Vs*
  var out = [];
  for (var k = 0; k < freqs.length; k++) {
    var w = 2 * Math.PI * freqs[k];
    if (!(w > 0)) return null;
    var u = { re: 1, im: 0 }, tau = { re: 0, im: 0 };
    for (var m = 0; m < layers.length - 1; m++) {
      var L = layers[m];
      if (!(L.thickness > 0)) continue; // zero-thickness layer: identity
      var Zm = cScale(L.vsC, L.rho);
      // a = w*h / Vs*
      var a = cDiv(cScale({ re: w * L.thickness, im: 0 }, 1), L.vsC);
      var ca = cCos(a), sa = cSin(a);
      // u' = u*cos(a) + tau * sin(a)/(Z*w);  tau' = tau*cos(a) - u*Z*w*sin(a)
      var uNew = cAdd(cMul(u, ca), cDiv(cMul(tau, sa), cScale(Zm, w)));
      var tauNew = cAdd(cMul(tau, ca), cNeg(cMul(cScale(Zm, w), cMul(u, sa))));
      u = uNew; tau = tauNew;
    }
    // A = 1 / (u + tau / (i*Zb*w))
    var denom = cAdd(u, cDiv(tau, cMul(cScale(Zb, w), { re: 0, im: 1 })));
    out.push(cAbs(cDiv({ re: 1, im: 0 }, denom)));
  }
  return out;
};

// ================================================================
//  Site response — Darendeli (2001) curves + equivalent-linear 1D
//  (R2 engine; curve coefficients cross-checked against the reference
//  values of dissertation Tables 10.13/10.14 — see tests/site-response)
// ================================================================

// Darendeli (2001) normalized modulus reduction and damping curves for
// fine-grained soils (modified hyperbola + scaled Masing).
//   strain  decimal shear strain (number or array of numbers)
//   opts    {pi (%, 0), ocr (1), sigmaEffKPa (101.3), freqHz (1), numCycles (10)}
// Returns { ggmax, damping } — arrays matching the input; damping decimal.
Physics.darendeliCurves = function(strain, opts) {
  var o = opts || {};
  var pi = Math.max(0, Number(o.pi) || 0);
  var ocr = Number(o.ocr) > 0 ? Number(o.ocr) : 1;
  var sig = Number(o.sigmaEffKPa) > 0 ? Number(o.sigmaEffKPa) : 101.3;
  var freq = Number(o.freqHz) > 0 ? Number(o.freqHz) : 1;
  var ncyc = Number(o.numCycles) > 1 ? Number(o.numCycles) : 10;
  var atm = sig / 101.325;

  var gammaR = (0.0352 + 0.0010 * pi * Math.pow(ocr, 0.3246)) * Math.pow(atm, 0.3483) / 100;
  var a = 0.9190; // curvature
  var dmin = (0.8005 + 0.0129 * pi * Math.pow(ocr, -0.1069)) *
    Math.pow(atm, -0.2889) * (1 + 0.2919 * Math.log(freq)) / 100;
  var beta = 0.6329 - 0.00566 * Math.log(ncyc); // Masing scaling with cycles
  // Curvature correction between the perfect hyperbola and the modified one
  var c1 = -1.1143 * a * a + 1.8618 * a + 0.2523;
  var c2 = 0.0805 * a * a - 0.0710 * a - 0.0095;
  var c3 = -0.0005 * a * a + 0.0002 * a + 0.0003;

  var strains = Array.isArray(strain) ? strain : [strain];
  var gg = [], dd = [];
  var grp = gammaR * 100; // percent space for the Masing branch
  for (var i = 0; i < strains.length; i++) {
    var g = Math.abs(Number(strains[i]) || 0);
    var r = g / gammaR;
    var G = 1 / (1 + Math.pow(r, a));
    gg.push(G);
    // Masing damping of the modified hyperbola (percent space; the gp->0
    // limit is 0, numerically stable down to gp/grp ~ 1e-4 in doubles)
    var gp = g * 100;
    var dm1 = (100 / Math.PI) * (4 * (gp - grp * Math.log((gp + grp) / grp)) /
      (gp * gp / (gp + grp)) - 2);
    if (!(isFinite(dm1)) || dm1 < 0) dm1 = 0;
    var dm = c1 * dm1 + c2 * dm1 * dm1 + c3 * dm1 * dm1 * dm1;
    var d = dmin + beta * (dm / 100) * Math.pow(G, 0.1);
    dd.push(Math.max(dmin, d));
  }
  return { ggmax: gg, damping: dd, strainRef: gammaR, dampingMin: dmin, masingScale: beta };
};

// Equivalent-linear 1D site response over the Thomson–Haskell engine.
//   profile  [{vs, thickness, density?, pi?}, ..., {vs}] — last is the
//            elastic halfspace (no thickness), same contract as
//            shTransferFunction
//   freqs    frequency grid [Hz]
//   opts     { rockPgaG (required: peak rock/outcrop acceleration in g),
//              effStrainRatio (0.65), maxIter (12), tol (0.02) }
// Iteration: layer shear strain from the bounded wave-motion estimate
// gamma ~ effStrainRatio * (pga * gain) / (Vs * 2*pi*f0) — particle-motion
// strain of the resonant pass (gain = surface amplification, clipped at 3).
// The stress-form tau/G diverges under fixed-point iteration once softening
// starts (strain grows as 1/G while G drops with strain); the displacement
// form saturates naturally. Strains cap at 3% (Darendeli validity) and the
// modulus update is under-relaxed 50/50 for stability. sigma'_v still sets
// the confining-pressure dependence of the curves per layer.
// Returns { amp, ggmax, damping, strain, iter, converged, f0 } where amp is
// the |A(f)| array aligned with freqs and f0 the peak-amplification
// frequency of the final pass.
Physics.siteResponse1D = function(profile, freqs, opts) {
  if (!profile || profile.length < 2 || !freqs || !freqs.length) return null;
  var o = opts || {};
  var pgaG = Number(o.rockPgaG);
  if (!(pgaG > 0)) return null;
  var effRatio = Number(o.effStrainRatio) > 0 ? Number(o.effStrainRatio) : 0.65;
  var maxIter = Math.min(30, Math.max(1, Number(o.maxIter) || 12));
  var tol = Number(o.tol) > 0 ? Number(o.tol) : 0.02;

  var n = profile.length - 1; // layers over the halfspace
  var layers = [];
  var depth = 0;
  for (var i = 0; i < n; i++) {
    var p = profile[i];
    var vs = Number(p.vs);
    var h = Number(p.thickness);
    if (!(vs > 0 && h > 0)) return null;
    var rho = p.density == null ? Physics.densityFromVs(vs) : Number(p.density);
    if (!(rho > 0)) return null;
    // effective stress at mid-layer (kPa); no water-table split — a
    // documented v1 simplification, conservative for shallow layers
    depth += h;
    var sigMidKPa = rho * 9.81 * (depth - h / 2);
    layers.push({ vs: vs, h: h, rho: rho, pi: Math.max(0, Number(p.pi) || 0), sig: sigMidKPa, gg: 1, damp: 0.02 });
  }

  var amp = null, iter = 0, converged = false, f0 = freqs[0];
  for (iter = 1; iter <= maxIter; iter++) {
    var tfProfile = [];
    for (var j = 0; j < n; j++) {
      tfProfile.push({ vs: layers[j].vs * Math.sqrt(layers[j].gg), thickness: layers[j].h,
        density: layers[j].rho, damping: layers[j].damp });
    }
    var bed = profile[n];
    if (!(Number(bed.vs) > 0)) return null;
    tfProfile.push({ vs: Number(bed.vs), density: bed.density == null ? Physics.densityFromVs(Number(bed.vs)) : Number(bed.density) });
    amp = Physics.shTransferFunction(tfProfile, freqs);
    if (!amp) return null;

    var gain = 1;
    var peakIdx = 0;
    for (var k = 1; k < amp.length; k++) if (amp[k] > amp[peakIdx]) peakIdx = k;
    gain = Math.min(3, Math.max(1, amp[peakIdx]));
    f0 = freqs[peakIdx];

    var maxShift = 0;
    var accelMs2 = pgaG * 9.81 * gain;
    var omega = 2 * Math.PI * Math.max(0.2, f0); // guard: freq-grid floor
    for (var m = 0; m < n; m++) {
      var L = layers[m];
      var gam = Math.min(0.03, effRatio * accelMs2 / (L.vs * omega)); // decimal
      var curves = Physics.darendeliCurves(gam, { pi: L.pi, sigmaEffKPa: L.sig, freqHz: f0 });
      var targetGg = curves.ggmax[0];
      var newD = Math.min(0.25, curves.damping[0]);
      // 50/50 under-relaxation keeps the softening feedback stable
      var newGg = 0.5 * L.gg + 0.5 * targetGg;
      var shift = Math.abs(Math.sqrt(newGg) - Math.sqrt(L.gg)) / Math.max(1e-9, Math.sqrt(L.gg));
      if (shift > maxShift) maxShift = shift;
      L.gg = newGg; L.damp = 0.5 * L.damp + 0.5 * newD; L.strain = gam;
    }
    if (maxShift < tol) { converged = true; break; }
  }

  return {
    amp: amp, f0: f0, iter: iter, converged: converged,
    ggmax: layers.map(function(l) { return l.gg; }),
    damping: layers.map(function(l) { return l.damp; }),
    strain: layers.map(function(l) { return l.strain; })
  };
};

// Synthesize a layered profile from the committed grid pair (J-SHIS Vs30
// surface average + JIVSM engineering-bedrock depth). With the S/B
// empirical f0(Vs30) prior registered (setSbEnsemble), the column is
// two-scale: a shallow resonant block whose thickness targets the empirical
// f0 for that Vs30 (real KiK-net resonant columns sit at ~19-48 m — a
// uniform column down to the JIVSM bedrock resonates far too low and
// deamplifies the PGA band at soft deep sites; scorecard 2026-08-25:
// intensity bias -0.154/-0.044, RMS 0.955/0.875 uniform vs two-scale,
// soft-site <200 m/s rms 1.30->0.99), an intermediate transition down to
// the JIVSM engineering bedrock, then the blanket + seismic halfspace.
// Without the prior: v1 uniform single soil layer (documented simplification
// — real KiK-net profiles stay research-side in .cache and enter via
// psLogToProfile). Returns a shTransferFunction-style profile or null.
Physics.synthSiteProfile = function(vs30, bedrockDepthM, opts) {
  if (!(Number(vs30) > 0)) return null;
  var o = opts || {};
  var engVs = Number(o.engBedrockVs) > 0 ? Number(o.engBedrockVs) : 1400;
  var seisVs = Number(o.seismicBedrockVs) > 0 ? Number(o.seismicBedrockVs) : 3200;
  var capM = Number(o.maxSoilM) > 0 ? Number(o.maxSoilM) : 600;
  var H = bedrockDepthM == null ? 30 : Number(bedrockDepthM);
  if (!(H > 0)) H = 5;
  H = Math.min(capM, Math.max(3, H));
  var soilVs = Math.min(1200, Math.max(80, Number(vs30)));
  var prof;
  var f0Emp = Physics.sbF0ForVs30(Number(vs30));
  if (f0Emp > 0) {
    // resonant block: travel time Vs30/(4·f0Emp), clipped to the local
    // bedrock depth (rock sites resonate naturally higher) and 80 m
    var H1 = Math.min(Math.min(H, 80), Math.max(3, Number(vs30) / (4 * f0Emp)));
    prof = [{ vs: soilVs, thickness: H1 }];
    var rest = H - H1;
    if (rest > 5) {
      prof.push({ vs: Math.min(1150, Math.max(200, soilVs * 1.5)), thickness: rest });
    }
  } else {
    prof = [{ vs: soilVs, thickness: H }];
  }
  prof.push({ vs: engVs, thickness: 50 }, { vs: seisVs });
  prof.synthetic = true; // marks synthesized stratigraphy (research-side PS logs differ)
  return prof;
};

// Convert a KiK-net PS-log interval table ({from,to,vs} rows, meters) into a
// transfer-function profile; the halfspace continues below the deepest log
// with a modest stiffness increase (boreholes typically stop inside the
// borehole-bedrock layer). A 2026-08-25 S/B-set scan across halfspace
// multipliers 1.15-3.0 with and without the 1500 m/s floor plateaued at
// 45-50% within-half-octave model-vs-empirical f0 agreement — the residual
// lives in the below-borehole structure and coarse rows, not this knob
// (R3 JIVSM deep columns are the realistic path to >60%).
Physics.psLogToProfile = function(rows, opts) {
  if (!rows || !rows.length) return null;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!(Number(r.vs) > 0)) continue;
    var h = Number(r.to) - Number(r.from);
    if (!(h > 0)) continue;
    out.push({ vs: Number(r.vs), thickness: h, pi: opts && Number(opts.pi) || 0 });
  }
  if (!out.length) return null;
  var lastVs = 0;
  for (var j = rows.length - 1; j >= 0; j--) if (Number(rows[j].vs) > 0) { lastVs = Number(rows[j].vs); break; }
  out.push({ vs: Math.max(lastVs * 1.15, 1500) });
  return out;
};

// Equivalent-linear amplification factors for the GMPE intensity measures:
// runs siteResponse1D on a geometric 0.3-20 Hz grid and band-averages the
// transfer function (geometric mean) over 5-10 Hz for PGA and 0.7-2 Hz for
// PGV — band means stay stable where single-frequency peaks move with
// softening. Factors clip to [0.25, 6].
Physics.eqlinSiteFactor = function(profile, rockPgaGal, opts) {
  if (!profile || profile.length < 2 || !(rockPgaGal > 0)) return null;
  var freqs = [];
  for (var i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
  var res = Physics.siteResponse1D(profile, freqs, opts || { rockPgaG: rockPgaGal / 980.665 });
  if (!res || !res.amp) return null;
  function bandMean(lo, hi) {
    var s = 0, n = 0;
    for (var k = 0; k < freqs.length; k++) {
      if (freqs[k] >= lo && freqs[k] <= hi) { s += Math.log(Math.max(1e-6, res.amp[k])); n++; }
    }
    return n ? Math.min(6, Math.max(0.25, Math.exp(s / n))) : 1;
  }
  return { pga: bandMean(5, 10), pgv: bandMean(0.7, 2), f0: res.f0, converged: res.converged };
};

// ================================================================
//  S/B empirical prior for synthesized profiles (v5.6 R2-4)
// ================================================================
// Registry fed from public/geojson/sb-spectral-ratio.json ensemble block
// (frozen KiK-net surface/borehole pairs, tools/sb-spectral-ratio.js).
// Only the resonance-frequency prior transfers to the runtime synth path:
// 2026-08-25 A/B measurements showed amplitude curves do NOT — the S/B
// ratio references the borehole sensor's own site response, so blending
// band levels toward the bins shifted intensity bias +0.42 and worsened
// RMS, and the within-bin log-amp-vs-Vs30 gradients came out with the
// wrong sign (borehole confounding). A resonance FREQUENCY has no such
// anchor problem, and the empirical f0(Vs30) relation (resonant column
// ~19-48 m for Vs30 150-900) is far shallower than the JIVSM engineering
// bedrock — so synthSiteProfile builds a two-scale column whenever the
// fit is registered. Null registry = legacy uniform column (byte-identical).
Physics.SB_F0_FIT = null;
Physics.SB_ENSEMBLE = null; // full bins kept for diagnostics only

Physics.setSbEnsemble = function(ensemble) {
  var ens = Array.isArray(ensemble) ? { bins: ensemble } : (ensemble || {});
  Physics.SB_ENSEMBLE = (ens.bins && ens.bins.length) ? ens.bins : null;
  var f = ens.f0Vs30Fit;
  Physics.SB_F0_FIT = (f && isFinite(f.a) && isFinite(f.b) && f.n >= 30) ? f : null;
  return !!(Physics.SB_ENSEMBLE || Physics.SB_F0_FIT);
};

// Empirical resonant frequency for a Vs30 under the registered fit
Physics.sbF0ForVs30 = function(vs30) {
  if (!Physics.SB_F0_FIT || !(vs30 > 0)) return 0;
  var f = Physics.SB_F0_FIT.a + Physics.SB_F0_FIT.b * Math.log10(vs30);
  f = Math.pow(10, f);
  return (f > 0.2 && f < 20) ? f : 0;
};

// travel-time fundamental frequency of a layered profile (T0 = 4·Σ h/v)
Physics.profileFundamentalHz = function(profile) {
  if (!profile || profile.length < 2) return 0;
  var t = 0;
  for (var i = 0; i < profile.length - 1; i++) {
    var vs = Number(profile[i].vs), h = Number(profile[i].thickness);
    if (vs > 0 && h > 0) t += h / vs;
  }
  return t > 0 ? 1 / (4 * t) : 0;
};

// ================================================================
//  Cross-period epsilon correlation + conditional spectrum (v5.6 R1-5)
// ================================================================
// Registry fed from public/geojson/jayaram2011-rho.json — the appendix
// Tables 3/4 period-pair correlation matrices (16 periods 0.05-5 s) fitted
// on Japanese K-NET/KiK-net ground motions by Jayaram et al. (2011),
// transcribed and validation-gated by tools/parse-jayaram2011-tables.js.
// Table 5 (subduction slab) is not yet transcribed — the slab class falls
// back to the interface table. Without the registry, rho degenerates to the
// same-paper Eq.(6) orthogonal-component correlation (already verified and
// shipped) — a documented approximation, never a silent one.
Physics.JAYARAM2011_RHO = null;

Physics.setJayaram2011Rho = function(doc) {
  var ok = !!(doc && doc.periods && doc.periods.length >= 8 &&
    doc.classes && doc.classes.crustal && doc.classes.crustal.rho);
  Physics.JAYARAM2011_RHO = ok ? doc : null;
  return ok;
};

Physics._rhoLogBracket = function(periods, T) {
  if (T <= periods[0]) return { i: 0, t: 0 };
  var last = periods.length - 1;
  if (T >= periods[last]) return { i: last - 1, t: 1 };
  for (var i = 0; i < last; i++) {
    if (T >= periods[i] && T <= periods[i + 1]) {
      var lt0 = Math.log(periods[i]), lt1 = Math.log(periods[i + 1]);
      return { i: i, t: (Math.log(T) - lt0) / Math.max(1e-12, lt1 - lt0) };
    }
  }
  return { i: 0, t: 0 };
};

// rho(eps(T1), eps(T2)) — bilinear interpolation in log period over the
// frozen Japan tables; T beyond [0.05, 5] s clamps to the table edge
Physics.rhoPeriodPair = function(T1, T2, sourceType) {
  if (!(T1 > 0) || !(T2 > 0)) return 0;
  if (!Physics.JAYARAM2011_RHO) {
    // fallback: Eq.(6) orthogonal-component correlation at the shorter period
    return Physics.orthogonalComponentCorrelation(Math.min(T1, T2));
  }
  var doc = Physics.JAYARAM2011_RHO;
  var cls = sourceType === 'crustal' ? 'crustal' : 'interface';
  var rho = (doc.classes[cls] || doc.classes.crustal).rho;
  var a = Physics._rhoLogBracket(doc.periods, T1);
  var b = Physics._rhoLogBracket(doc.periods, T2);
  var top = rho[b.i][a.i] * (1 - a.t) + rho[b.i][a.i + 1] * a.t;
  var bot = rho[b.i + 1][a.i] * (1 - a.t) + rho[b.i + 1][a.i + 1] * a.t;
  var v = top * (1 - b.t) + bot * b.t;
  return Math.max(-1, Math.min(1, v));
};

// Conditional spectrum (scalar-anchor Gaussian conditioning, Baker-style):
// given per-period lognormal medians and sigmas (LN units) and an anchor
// epsilon epsStar at anchorPeriod (Sa(T*) observed at median·exp(epsStar·σ*)),
//   muC(T)  = mu(T) + rho(T, T*) · sigma(T) · epsStar
//   sigC(T) = sigma(T) · sqrt(1 - rho(T, T*)²)
// At the anchor period the conditional mean equals the observation and the
// conditional sigma collapses; periods uncorrelated with the anchor keep
// their full marginal spread.
Physics.conditionalSpectrum = function(periods, meanLnSa, sigmaLnSa, anchorPeriod, epsStar, sourceType) {
  if (!periods || !meanLnSa || !sigmaLnSa || periods.length !== meanLnSa.length ||
    periods.length !== sigmaLnSa.length || !(anchorPeriod > 0)) return null;
  var mean = [], sigma = [];
  for (var i = 0; i < periods.length; i++) {
    var rho = Physics.rhoPeriodPair(periods[i], anchorPeriod, sourceType);
    var s = Number(sigmaLnSa[i]);
    if (!(s >= 0)) s = 0;
    mean.push(Number(meanLnSa[i]) + rho * s * epsStar);
    sigma.push(s * Math.sqrt(Math.max(0, 1 - rho * rho)));
  }
  return { periods: periods.slice(), meanLnSa: mean, sigmaLnSa: sigma,
    anchorPeriod: anchorPeriod, epsStar: epsStar };
};

// ================================================================
//  GMPE — Kanno et al. (2006) for Japan (4,632 records, Vs30-based)
// ================================================================

// Site correction for Kanno GMPE: G = p * log10(Vs30 / 800)
Physics._kannoSiteCorr = function(vs30, imt) {
  if (!vs30 || vs30 <= 0) return 0;
  var p = (imt === 'pga') ? -0.5514 : -0.7057;
  return p * Math.log10(vs30 / 800.0);
};

// Kanno et al. (2006) Shallow (depth <= 30km)
Physics.pgaKannoShallow = function(mw, X, vs30) {
  var a = 0.556, b = -0.00307, c = 0.256, d = 0.00547;
  var Reff = X + d * Math.pow(10, 0.50 * mw);
  return Math.pow(10, a * mw + b * X - Math.log10(Reff) + c + Physics._kannoSiteCorr(vs30, 'pga'));
};

Physics.pgvKannoShallow = function(mw, X, vs30) {
  var a = 0.702, b = -0.000925, c = -1.930, d = 0.00217;
  var Reff = X + d * Math.pow(10, 0.50 * mw);
  return Math.pow(10, a * mw + b * X - Math.log10(Reff) + c + Physics._kannoSiteCorr(vs30, 'pgv'));
};

// Kanno et al. (2006) Deep (depth > 30km, d=0)
Physics.pgaKannoDeep = function(mw, X, vs30) {
  var a = 0.556, b = -0.00307, c = 0.256;
  return Math.pow(10, a * mw + b * X - Math.log10(X) + c + Physics._kannoSiteCorr(vs30, 'pga'));
};

Physics.pgvKannoDeep = function(mw, X, vs30) {
  var a = 0.702, b = -0.000925, c = -1.930;
  return Math.pow(10, a * mw + b * X - Math.log10(X) + c + Physics._kannoSiteCorr(vs30, 'pgv'));
};

// Route Kanno model by depth
Physics.pgaKanno = function(mw, X, depthKm, vs30) {
  return (depthKm <= 30) ? Physics.pgaKannoShallow(mw, X, vs30) : Physics.pgaKannoDeep(mw, X, vs30);
};
Physics.pgvKanno = function(mw, X, depthKm, vs30) {
  return (depthKm <= 30) ? Physics.pgvKannoShallow(mw, X, vs30) : Physics.pgvKannoDeep(mw, X, vs30);
};

// ================================================================
//  GMPE — Zhao et al. (2006) for Japan (J-SHIS national hazard maps)
//  Source-type-specific coefficients with depth and site class terms
//  Reference: Zhao, Zhang et al. (2006) BSSA 96-3
// ================================================================
//  GMPE — Zhao et al. (2006), faithful implementation
//  Zhao, Zhang, Asano, Ohno, Oouchi & Takahashi (2006), BSSA 96(3),
//  "Attenuation relations of strong ground motion in Japan using site
//  classification based on predominant period" — Eq. (1) p.901 with the
//  Eq. (5) p.909 magnitude-squared correction. Natural-log units; PGA
//  and SA in gal (cm/s²). Coefficient values re-entered from the
//  paper's Tables 4/5/6 (p.903/p.907); site-class boundaries follow
//  Table 2 p.901.
//
//    ln A = a·M + b·R − ln(R + c·exp(d·M))        magnitude + geometric + Q
//         + [h ≥ 15 km]·e·min(h − 15, 110)        focal-depth term
//         + FR·[45° < rake < 135°]                crustal reverse style
//         + SiteClass(Vs30)                       shared by every class
//         + SI + QI·(M−6.3)² + WI                 interface (PGA: all 0)
//         + SS + SSL·ln R + PS·(M−6.5) + QS·(M−6.5)² + WS   intraslab
//         + QC·(M−6.3)² + WC                      crustal (PGA: 0)
//
//  Near-source saturation is intrinsic to the model: c·exp(d·M) is a
//  magnitude-scaled pseudo-depth (~11 km at M7, ~102 km at M9.1 for
//  PGA), so no external magnitude compression is applied. R is the
//  closest distance to the rupture surface (Rrup); point-source callers
//  approximate it with the hypocentral distance, and the finite-fault
//  composite passes the true per-patch Rrup.
// ================================================================

// Paper coefficient rows. `site` = [CH(>1100), C1(600-1100), C2(300-600),
// C3(200-300), C4(≤200)] m/s. `sa1` is the paper's 1.0 s spectral
// acceleration row (used for the PGV pseudo-velocity derivation below).
Physics.ZHAO2006_PAPER = {
  pga: {
    a: 1.101, b: -0.00564, c: 0.0055, d: 1.080, e: 0.01412, fr: 0.251,
    site: [0.293, 1.111, 1.344, 1.355, 1.420],
    asc:    { qc: 0.0,     wc: 0.0 },
    inter:  { si: 0.000, qi: 0.0,    wi: 0.0,    tau: 0.308 },
    slab:   { ss: 2.607, ssl: -0.528, ps: 0.1392, qs: 0.1584, ws: -0.0529, tau: 0.321 },
    tau: 0.303, sigma: 0.604
  },
  sa1: {
    a: 1.479, b: -0.00220, c: 0.0020, d: 1.115, e: 0.01005, fr: 0.211,
    site: [-2.451, -2.152, -1.776, -1.523, -1.084],
    asc:    { qc: -0.0899, wc: 0.0440 },
    inter:  { si: -0.239, qi: -0.0917, wi: 0.0721, tau: 0.328 },
    slab:   { ss: 2.233, ssl: -0.509, ps: 0.1060, qs: 0.0314, ws: 0.0498, tau: 0.286 },
    tau: 0.338, sigma: 0.657
  }
};

// Site class from Vs30 per Zhao (2006) Table 2 p.901: 0=CH hard rock
// (>1100), 1=C1 rock (600-1100), 2=C2 hard soil (300-600, project default),
// 3=C3 medium soil (200-300), 4=C4 soft soil (≤200 m/s).
Physics._zhaoSiteClass = function(vs30) {
  if (!vs30 || vs30 <= 0) return 2;
  if (vs30 > 1100) return 0; if (vs30 > 600) return 1;
  if (vs30 > 300) return 2; if (vs30 > 200) return 3;
  return 4;
};

// Eq. (1) core in natural-log units. imt: 'pga' | 'sa1'.
Physics.zhao2006LnA = function(imt, srcType, mw, rRup, depthKm, vs30, rake) {
  var T = Physics.ZHAO2006_PAPER[imt] || Physics.ZHAO2006_PAPER.pga;
  var r = Math.max(rRup || 0.1, 0.1); // slab ln(r) singularity guard (p.901)
  var lnA = T.a * mw + T.b * r - Math.log(r + T.c * Math.exp(T.d * mw));
  var h = Math.min(depthKm || 0, 125);
  if (h >= 15) lnA += T.e * (h - 15);
  if (srcType === 'crustal' && rake > 45 && rake < 135) lnA += T.fr;
  lnA += T.site[Physics._zhaoSiteClass(vs30)];
  if (srcType === 'interplate') {
    var dm = mw - 6.3;
    lnA += T.inter.si + T.inter.qi * dm * dm + T.inter.wi;
  } else if (srcType === 'intraslab') {
    var ds = mw - 6.5;
    lnA += T.slab.ss + T.slab.ssl * Math.log(r) +
           T.slab.ps * ds + T.slab.qs * ds * ds + T.slab.ws;
  } else {
    var dc = mw - 6.3;
    lnA += T.asc.qc * dc * dc + T.asc.wc;
  }
  return lnA;
};

// ================================================================
//  GREAT-QUAKE DISPLAY GUARD
// ================================================================
// The paper's distance term saturates intrinsically (pseudo-depth
// c·exp(d·M)), so no magnitude compression is applied; the tanh soft
// caps only clip physically impossible tails beyond the largest Japanese
// records (2011 Tohoku: ~2,700-3,000 gal, ~150-200 cm/s) and stay
// transparent (<4%) below half the cap. Kanno/Si-Mid self-saturate via
// their d*10^(0.5M) distance terms and are untouched.
Physics.GMPE_PGA_SOFT_CAP = 3200; // gal
Physics.GMPE_PGV_SOFT_CAP = 250;  // cm/s

Physics.pgaZhao2006 = function(mw, Rkm, depthKm, srcType, vs30, rake) {
  var lnA = Physics.zhao2006LnA('pga', srcType, mw, Rkm, depthKm, vs30, rake);
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(Math.exp(lnA) / Physics.GMPE_PGA_SOFT_CAP);
};

// The paper publishes no PGV model (Tables 4/5 cover PGA and SA only).
// PGV is derived from the paper's 1.0 s SA row through the pseudo-velocity
// conversion PSV = SA/ω with T = 1 s (PGV ≈ SA/(2π) cm/s) — a documented
// ±~25% engineering approximation, not a published PGV regression.
Physics.pgvZhao2006 = function(mw, Rkm, depthKm, srcType, vs30, rake) {
  var lnSA = Physics.zhao2006LnA('sa1', srcType, mw, Rkm, depthKm, vs30, rake);
  var pgv = Math.exp(lnSA) / (2 * Math.PI);
  return Physics.GMPE_PGV_SOFT_CAP * Math.tanh(pgv / Physics.GMPE_PGV_SOFT_CAP);
};

// ================================================================
//  GMPE ALEATORY VARIABILITY (sigma / standard deviations)
//  Zhao et al. (2006) Table 6, per tectonic class, in ln units,
//  converted to log10 because the chart and residual code use log10.
// ================================================================
var _LN10 = Math.log(10);
function _zhaoSigmaTable(tau, phi) {
  return { tau: tau / _LN10, phi: phi / _LN10, sigmaT: Math.sqrt(tau * tau + phi * phi) / _LN10 };
}
Physics.ZHAO2006_SIGMA = {
  crustal:    _zhaoSigmaTable(0.303, 0.604),
  interplate: _zhaoSigmaTable(0.308, 0.604),
  intraslab:  _zhaoSigmaTable(0.321, 0.604)
};

// Aleatory-to-display bridge: the Zhao 2006 total sigma (log10 PGA units)
// expressed in JMA instrumental-intensity units through the PGA-branch slope
// (2.23 per log10 unit). The UI uses this to show a prediction range
// (e.g. 5-~5+) instead of a single over-confident value; the PGV branch
// slope (1.72) would be slightly tighter, so the PGA slope is conservative.
Physics.GMPE_SHINDO_SIGMA = 2.23 * Physics.ZHAO2006_SIGMA.crustal.sigmaT;
/** ±1σ range around a predicted JMA intensity, with shindo band labels. */
Physics.shindoUncertaintyRange = function(intensity) {
  var I = Number(intensity);
  if (!isFinite(I) || I < 0) return null;
  var d = Physics.GMPE_SHINDO_SIGMA;
  var lo = Math.max(0, I - d), hi = Math.max(0, I + d);
  return { low: lo, high: hi, sigma: d,
    lowLabel: Physics.intensityToShindo(lo), highLabel: Physics.intensityToShindo(hi) };
};

// ================================================================
//  GMPE CALIBRATION (magnitude-binned additive intensity correction)
//  Fitted offline by tools/calibrate-gmpe.js against recorded kmoni peaks
//  with catalog-truth parameters. Forecast paths apply it to the predicted
//  intensity; detection inversion and observed-data processing never do.
//  Additive model-keyed extension: when the caller passes opts {model,
//  distKm} and the table carries a `modelBias` block (fitted from the
//  frozen strong-motion scorecard, tools/scorecard-strong-motion.js
//  --fit-model-bias), a per-model distance-binned shift applies on top of
//  the magnitude bins. Calls without opts are byte-compatible with the
//  original magnitude-binned behavior.
// ================================================================
Physics.gmpeCalibration = null;
Physics.setGmpeCalibration = function(table) {
  var ok = !!(table && table.schema === 'quake-sim-gmpe-calibration-v1' && Array.isArray(table.bins));
  Physics.gmpeCalibration = ok ? table : null;
  return ok;
};
Physics.calibrateIntensity = function(intensity, mag, opts) {
  var I = Number(intensity), M = Number(mag);
  if (!isFinite(I)) return intensity;
  var table = Physics.gmpeCalibration;
  if (!table || !isFinite(M)) return I;
  for (var i = 0; i < table.bins.length; i++) {
    var b = table.bins[i];
    if (M >= b.minM && M < b.maxM) { I = Math.max(0, I + (Number(b.deltaI) || 0)); break; }
  }
  // Model-keyed additive correction (optional): opts.model selects the
  // routed GMPE, opts.distKm the hypocentral distance. Distance-binned
  // entries apply only inside their measured range (no extrapolation);
  // each bin's deltaI is pre-clipped to the measured bin bias at fit time
  // and the applied shift is hard-capped at +/-1.0 intensity unit.
  // Callers that pass no opts get the original magnitude-binned behavior.
  var mb = opts && table.modelBias && table.modelBias[opts.model];
  // Optional minM/maxM gate keeps the correction inside the magnitude
  // range it was fitted on (no extrapolation to unmeasured magnitudes).
  if (mb && M >= (mb.minM == null ? -Infinity : Number(mb.minM))
      && M < (mb.maxM == null ? Infinity : Number(mb.maxM))) {
    var d = 0;
    var r = Number(opts.distKm);
    if (Array.isArray(mb.distBins)) {
      if (isFinite(r)) {
        for (var j = 0; j < mb.distBins.length; j++) {
          var db = mb.distBins[j];
          var lo = db.minKm == null ? -Infinity : Number(db.minKm);
          var hi = db.maxKm == null ? Infinity : Number(db.maxKm);
          if (r >= lo && r < hi) { d = Number(db.deltaI) || 0; break; }
        }
      }
    } else if (mb.deltaI != null) {
      d = Number(mb.deltaI) || 0;
    }
    if (d > 1) d = 1; else if (d < -1) d = -1;
    I = Math.max(0, I + d);
  }
  return I;
};

/** Direct upgoing ray through the layered 1-D velocity model (Snell's law). */
Physics.layeredTravelTime = function(horizontalKm, depthKm, phase, surfaceVelocity) {
  horizontalKm=Math.max(0,Number(horizontalKm)||0);depthKm=Math.max(0,Number(depthKm)||0);
  var col=phase==='S'?2:1,baseSurface=Physics.IASP91[0][col];
  var velocityScale=surfaceVelocity>0?Number(surfaceVelocity)/baseSurface:1;
  if(depthKm<=0)return horizontalKm/(baseSurface*velocityScale);
  var layers=[],maxV=0;
  for(var i=0;i<Physics.IASP91.length;i++){
    var top=Physics.IASP91[i][0],bot=i+1<Physics.IASP91.length?Physics.IASP91[i+1][0]:depthKm;
    if(depthKm<=top)break;var h=Math.min(depthKm,bot)-top;if(h>0){var v=Physics.IASP91[i][col]*velocityScale;layers.push([h,v]);maxV=Math.max(maxV,v);}
  }
  function offset(p){var x=0;for(var j=0;j<layers.length;j++){var pv=Math.min(0.999999,p*layers[j][1]);x+=layers[j][0]*pv/Math.sqrt(1-pv*pv);}return x;}
  function directTime(p){var t=0;for(var j=0;j<layers.length;j++){var pv=Math.min(0.999999,p*layers[j][1]);t+=layers[j][0]/(layers[j][1]*Math.sqrt(1-pv*pv));}return t;}
  // Head wave below the source: IASP91 speeds grow monotonically, so the
  // fastest reachable medium is the deepest row below the source (Pn/Sn).
  // delay = Σ h·cos(θc)/v with sin(θc)=v/vRefractor over the source→refractor
  // column. The layer stack above only ran to the source depth, so far
  // stations used to ride the degenerate near-horizontal direct ray and
  // under-estimate arrivals (X/6.5 instead of a mantle head wave).
  var refractorV=0,refractorTop=Infinity,belowLayers=[];
  for(var ib=0;ib<Physics.IASP91.length;ib++){
    var topB=Physics.IASP91[ib][0],botB=ib+1<Physics.IASP91.length?Physics.IASP91[ib+1][0]:Infinity;
    if(botB<=depthKm)continue;
    // Column from the source depth down to each refractor top; the deepest
    // row is the refractor half-space itself (zero delay thickness).
    var startB=Math.max(topB,depthKm);
    var hB=(botB===Infinity?startB:botB)-startB;
    if(!(hB>0))continue;
    var vB=Physics.IASP91[ib][col]*velocityScale;
    belowLayers.push([hB,vB]);
    if(vB>refractorV){refractorV=vB;refractorTop=startB;}
  }
  var headTime=Infinity;
  if(refractorV>maxV){
    var delay=0;
    for(var jb=0;jb<belowLayers.length;jb++){
      if(belowLayers[jb][1]>=refractorV)break; // at the refractor itself
      var vr=belowLayers[jb][1];var cosc=Math.sqrt(Math.max(0,1-(vr/refractorV)*(vr/refractorV)));
      delay+=belowLayers[jb][0]*cosc/vr;
    }
    // Up-leg back to the surface station: critical passage through the
    // source-depth stack as well (source is buried, station is at the top).
    for(var ju=0;ju<layers.length;ju++){
      if(layers[ju][1]>=refractorV)break;
      var vu=layers[ju][1];var cosu=Math.sqrt(Math.max(0,1-(vu/refractorV)*(vu/refractorV)));
      delay+=layers[ju][0]*cosu/vu;
    }
    headTime=horizontalKm/refractorV+delay;
  }
  var lo=0,hi=0.999999/maxV;
  if(offset(hi)<horizontalKm){
    // Supercritical — no direct ray turns back within the source-depth stack.
    return headTime===Infinity?directTime(hi):headTime;
  }
  for(var it=0;it<70;it++){var mid=(lo+hi)/2;if(offset(mid)<horizontalKm)lo=mid;else hi=mid;}
  var time=directTime((lo+hi)/2);
  // First arrival: near stations take the direct ray, far stations the head wave.
  return Math.min(time,headTime);
};

Physics.pTravelTime = function(horizontalKm, depthKm, surfaceVelocity) { return Physics.layeredTravelTime(horizontalKm,depthKm,'P',surfaceVelocity); };
Physics.sTravelTime = function(horizontalKm, depthKm, surfaceVelocity) { return Physics.layeredTravelTime(horizontalKm,depthKm,'S',surfaceVelocity); };

/**
 * Official JMA instrumental-intensity workflow for three-component acceleration.
 * Inputs are equally-sized acceleration arrays in gal. The JMA frequency-domain
 * filter is applied, then the amplitude whose cumulative duration is 0.3 s is
 * converted with I = 2*log10(a) + 0.94. This is intentionally separate from
 * calcJmaIntensity(), which is an empirical PGA/PGV estimate used by the simulator.
 */
Physics.calcJmaIntensity3C = function(components, sampleRate) {
  if (!components || !components.x || !components.y || !components.z || !(sampleRate > 0)) return null;
  var x = components.x, y = components.y, z = components.z, n = x.length;
  if (!n || y.length !== n || z.length !== n) return null;

  function fft(re, im, inverse) {
    var nn=re.length;
    for(var i=1,j=0;i<nn;i++){
      var bit=nn>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;
      if(i<j){var tr=re[i];re[i]=re[j];re[j]=tr;tr=im[i];im[i]=im[j];im[j]=tr;}
    }
    for(var len=2;len<=nn;len<<=1){
      var ang=2*Math.PI/len*(inverse?1:-1),wlr=Math.cos(ang),wli=Math.sin(ang);
      for(var base=0;base<nn;base+=len){var wr=1,wi=0;
        for(var q0=0;q0<len/2;q0++){
          var uR=re[base+q0],uI=im[base+q0],idx=base+q0+len/2;
          var vR=re[idx]*wr-im[idx]*wi,vI=re[idx]*wi+im[idx]*wr;
          re[base+q0]=uR+vR;im[base+q0]=uI+vI;re[idx]=uR-vR;im[idx]=uI-vI;
          var nwr=wr*wlr-wi*wli;wi=wr*wli+wi*wlr;wr=nwr;
        }
      }
    }
    if(inverse)for(var z0=0;z0<nn;z0++){re[z0]/=nn;im[z0]/=nn;}
  }
  function filtered(input) {
    var size=1;while(size<n)size<<=1;
    var re=new Array(size).fill(0),im=new Array(size).fill(0);
    for(var j=0;j<n;j++)re[j]=Number(input[j]||0);
    fft(re,im,false);
    for(var k=0;k<size;k++){
      var signedF=k<=size/2?k*sampleRate/size:(k-size)*sampleRate/size;
      var f=Math.abs(signedF),gain=0;
      if(f>0){
        var q=f/10;
        var high=1/Math.sqrt(1+0.694*q*q+0.241*Math.pow(q,4)+0.0557*Math.pow(q,6)
          +0.009664*Math.pow(q,8)+0.00134*Math.pow(q,10)+0.000155*Math.pow(q,12));
        var low=Math.sqrt(1-Math.exp(-Math.pow(f/0.5,3)));
        gain=Math.sqrt(1/f)*high*low;
      }
      re[k]*=gain;im[k]*=gain;
    }
    fft(re,im,true);return re.slice(0,n);
  }

  var fx = filtered(x), fy = filtered(y), fz = filtered(z), amplitudes = new Array(n);
  for (var i = 0; i < n; i++) amplitudes[i] = Math.sqrt(fx[i]*fx[i] + fy[i]*fy[i] + fz[i]*fz[i]);
  amplitudes.sort(function(a, b) { return b - a; });
  var requiredSamples = Math.max(1, Math.ceil(0.3 * sampleRate));
  var amplitude = amplitudes[Math.min(requiredSamples - 1, n - 1)];
  if (!(amplitude > 0)) return 0;
  return Math.max(0, 2 * Math.log10(amplitude) + 0.94);
};

/** Official-filter stochastic JMA intensity, scaled to a target vector PGA. */
Physics.calcStochasticJmaIntensity = function(mw, distKm, targetPgaGal, stressDropMPa, sampleRate, seed) {
  if (!(targetPgaGal > 0)) return 0;
  var wave=Physics.synthesizeWaveform3C(mw,distKm,stressDropMPa||10,1,null,sampleRate||50,seed);
  var peak=0;
  for(var i=0;i<wave.x.length;i++)peak=Math.max(peak,Math.sqrt(wave.x[i]*wave.x[i]+wave.y[i]*wave.y[i]+wave.z[i]*wave.z[i]));
  if(!(peak>0))return 0;
  var scale=targetPgaGal/peak;
  var components={x:wave.x.map(function(v){return v*scale;}),y:wave.y.map(function(v){return v*scale;}),z:wave.z.map(function(v){return v*scale;})};
  return Physics.calcJmaIntensity3C(components,wave.sampleRate);
};

/** Process observed three-component acceleration without synthetic substitution. */
Physics.analyzeObservedMotion3C = function(record, periods, damping) {
  if(!record||!record.components||!(record.sampleRate>0))return null;
  var c=record.components,n=c.x&&c.x.length;
  if(!n||!c.y||!c.z||c.y.length!==n||c.z.length!==n)return null;
  function demean(values){var mean=0;for(var i=0;i<values.length;i++)mean+=Number(values[i])||0;mean/=values.length;
    return values.map(function(v){return (Number(v)||0)-mean;});}
  var x=demean(c.x),y=demean(c.y),z=demean(c.z),pga=0;
  for(var i=0;i<n;i++)pga=Math.max(pga,Math.sqrt(x[i]*x[i]+y[i]*y[i]+z[i]*z[i]));
  periods=periods||[0.1,0.2,0.5,1,2,3,5];
  return {intensity:Physics.calcJmaIntensity3C({x:x,y:y,z:z},record.sampleRate),pgaVectorGal:pga,
    spectra:{x:Physics.sdofResponseSpectrum(x,record.sampleRate,periods,damping||0.05),
      y:Physics.sdofResponseSpectrum(y,record.sampleRate,periods,damping||0.05),
      z:Physics.sdofResponseSpectrum(z,record.sampleRate,periods,damping||0.05)},
    sampleRate:record.sampleRate,samples:n,source:record.source||'observed-record'};
};

Physics.exceedanceProbability = function(median, sigmaLog10, threshold) {
  if (!(median > 0) || !(threshold > 0)) return median >= threshold ? 1 : 0;
  if (!(sigmaLog10 > 0)) return median >= threshold ? 1 : 0;
  var z = (Math.log10(threshold) - Math.log10(median)) / sigmaLog10;
  var sign = z < 0 ? -1 : 1, az = Math.abs(z) / Math.sqrt(2);
  var t = 1 / (1 + 0.3275911 * az);
  var erf = sign * (1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-az*az));
  return Math.max(0, Math.min(1, 0.5 * (1 - erf)));
};

// Kanno et al. (2006) — total sigma (no published inter/intra decomposition)
Physics.KANNO2006_SIGMA = { sigmaT: 0.30 };

// Si & Midorikawa (1999) — total sigma
Physics.SIMID_SIGMA = { sigmaT: 0.28 };

// Hand-tuned log model — calibrated to Japanese GMPE residuals (σ ≈ 0.30)
Physics.LOG_SIGMA = { sigmaT: 0.30 };

// R1 (2026-08-24): fitted inter/intra-event sigma components for the two
// models without a published decomposition — one-way random-effects ANOVA
// (method of moments) on the frozen 13-event station set
// (tools/fit-sigma-components.js -> tools/data/sigma-components-report.json;
// si-midorikawa: 9 crustal events / 2,962 stations; kanno2006: forced fit
// over all 13 events / 4,887 stations). ln-PGA units converted to log10 like
// ZHAO2006_SIGMA. Caveat: the frozen dataset's PGA is the shakemap aggregate
// (larger horizontal component) while the GMPEs predict geometric mean, so
// phi carries a small component-convention inflation vs paper regressions.
// Zhao 2006 keeps its paper Table 6 tau/phi (ZHAO2006_SIGMA, asserted
// against openquake.hazardlib in tests/gmpe-benchmarks.test.js).
Physics.GMPE_SIGMA_COMPONENTS = {
  'si-midorikawa': _zhaoSigmaTable(0.256, 0.654),
  'kanno2006': _zhaoSigmaTable(0.551, 0.771)
};

// R1 (2026-08-24): three-branch GMPE logic tree per tectonic class. Weights
// are Scherbaum-LLH information weights (Delavaud w ∝ exp(-(LLH-LLH_min)))
// fitted on the frozen 13-event station set with per-model fitted sigma —
// tools/fit-logic-tree-weights.js -> tools/data/logic-tree-weights.json
// (crustal 9 events / 2,962 stations; interplate 3 / 1,325; intraslab 1 /
// 600 — the slab branch is a single-event fit, documented in the report).
// gmpModel 'logic-tree' aggregates complete per-branch predictions
// (reference × site term) as a weighted geometric mean and reports the
// between-branch spread as epistemic sigma (see predictStationMotion).
Physics.GMPE_LOGIC_TREE = {
  crustal: [
    { model: 'si-midorikawa', weight: 0.3666 },
    { model: 'kanno2006', weight: 0.3376 },
    { model: 'zhao2006', weight: 0.2958 }
  ],
  interplate: [
    { model: 'kanno2006', weight: 0.3717 },
    { model: 'zhao2006', weight: 0.3573 },
    { model: 'si-midorikawa', weight: 0.2710 }
  ],
  intraslab: [
    { model: 'si-midorikawa', weight: 0.3984 },
    { model: 'zhao2006', weight: 0.3519 },
    { model: 'kanno2006', weight: 0.2498 }
  ]
};

/** Branches of the logic tree for a tectonic class, weights normalized to 1.
 *  Unknown classes fall back to the auto-routed single model at weight 1. */
Physics.logicTreeBranches = function(srcType) {
  var tree = Physics.GMPE_LOGIC_TREE[srcType];
  if (!tree || !tree.length) {
    return [{ model: Physics.resolveGmpModel('auto', srcType || 'crustal', 7.0), weight: 1 }];
  }
  var wsum = 0;
  for (var i = 0; i < tree.length; i++) wsum += tree[i].weight;
  return tree.map(function(b) { return { model: b.model, weight: b.weight / wsum }; });
};

// ================================================================
//  STATION-TO-STATION SPATIAL CORRELATION (R1, 2026-08-24)
//  Jayaram & Baker (2009) EESD 38:1687-1708, Eq.(17)-(20): the correlation
//  of normalized intra-event residuals at separation h is the exponential
//  semivariogram complement rho(h) = exp(-3h/b), with the range b
//  period-dependent and short-period ranges split by Vs30 clustering.
// ================================================================
Physics.JB2009 = {
  /** Semivariogram range b (km) per paper Eq.(17)-(19). */
  rangeKm: function(periodSec, vs30Clustering) {
    if (periodSec < 1) return vs30Clustering ? 40.7 - 15.0 * periodSec : 8.5 + 17.2 * periodSec;
    return 22.0 + 3.7 * periodSec;
  },
  /** rho(h) per paper Eq.(20). */
  rho: function(hKm, periodSec, vs30Clustering) {
    return Math.exp(-3 * Math.max(0, hKm) / Physics.JB2009.rangeKm(periodSec, vs30Clustering));
  }
};

// Empirically calibrated ranges for THIS system's two forecast metrics,
// fitted on the frozen 13-event station set by tools/fit-spatial-correlation.js
// (-> tools/data/spatial-correlation-report.json): intra-event residuals
// normalized by the fitted per-model phi, pairwise semivariogram binned by
// station separation, exponential range fitted with short-distance priority
// (paper Section 5: short separations matter most). JMA intensity behaves
// short-period-like (PGA-dominated); PGA is T=0. NOTE: the fitted ranges
// (lnPGA 94 km / intensity 72.5 km) are 2-3x the paper's Case-1 short-period
// range and ~2x its Vs30-clustered Case-2 (40.7 km) — this system's residuals
// decorrelate more slowly than the NGA data behind the paper, because smooth
// model-vs-observation misfit survives the 5-bin detrending. The fitted
// values describe THIS forecast path's actual error structure and are what
// the Monte Carlo engine samples; Physics.JB2009 keeps the paper formula
// unchanged for reference.
Physics.SPATIAL_CORRELATION = {
  lnPga:     { rangeKm: 94 },
  intensity: { rangeKm: 72.5 }
};
/** rho(h) for a metric of this system ('lnPga' | 'intensity'). */
Physics.spatialCorrelation = function(hKm, metric) {
  var m = Physics.SPATIAL_CORRELATION[metric];
  if (!m || !(m.rangeKm > 0)) return 0;
  return Math.exp(-3 * Math.max(0, hKm) / m.rangeKm);
};
// ================================================================
//  MONTE CARLO ENSEMBLE ENGINE (R1, 2026-08-24)
//  Deterministic (seeded) sampling of the full forecast uncertainty stack:
//  logic-tree branch x inter-event tau x source-parameter jitter x
//  spatially-correlated intra-event field (phi, exponential correlation
//  with the empirically fitted range). Members are reproducible on every
//  platform: the RNG is integer math and the field is FFT-based.
// ================================================================

// String-hash seeded RNG (FNV-1a 32-bit + mulberry32): deterministic across
// engines because it only uses 32-bit integer ops and Math.imul.
Physics.seededRng = function(seed) {
  var h = 2166136261;
  var str = String(seed == null ? 'seed' : seed);
  for (var ci = 0; ci < str.length; ci++) {
    h ^= str.charCodeAt(ci);
    h = Math.imul(h, 16777619);
  }
  var a = h >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** Standard normal draw (Box-Muller) from a seededRng stream. */
Physics.gaussRng = function(rng) {
  var u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function _fft1d(re, im, inverse) {
  var n = re.length;
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var tr = re[i]; re[i] = re[j]; re[j] = tr;
      var ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = 2 * Math.PI / len * (inverse ? 1 : -1);
    var wr = Math.cos(ang), wi = Math.sin(ang);
    for (var i2 = 0; i2 < n; i2 += len) {
      var cwr = 1, cwi = 0;
      for (var k = 0; k < (len >> 1); k++) {
        var ur = re[i2 + k], ui = im[i2 + k];
        var vr = re[i2 + k + (len >> 1)] * cwr - im[i2 + k + (len >> 1)] * cwi;
        var vi = re[i2 + k + (len >> 1)] * cwi + im[i2 + k + (len >> 1)] * cwr;
        re[i2 + k] = ur + vr; im[i2 + k] = ui + vi;
        re[i2 + k + (len >> 1)] = ur - vr; im[i2 + k + (len >> 1)] = ui - vi;
        var nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  if (inverse) for (var i3 = 0; i3 < n; i3++) { re[i3] /= n; im[i3] /= n; }
}

/** Unit-variance Gaussian field at scattered points with rho(h)=exp(-3h/range)
 *  (circulant embedding on a covering grid, bilinear sampling at the points).
 *  xs/ys are local-plane km coordinates; deterministic given the rng stream. */
Physics.correlatedGaussianField2D = function(xs, ys, rangeKm, rng) {
  var n = xs.length;
  if (!n) return [];
  if (!(rangeKm > 0) || n === 1) {
    var id = new Array(n);
    for (var q = 0; q < n; q++) id[q] = rangeKm > 0 ? Physics.gaussRng(rng) : 0;
    return id;
  }
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (var i = 0; i < n; i++) {
    if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
  }
  var pad = 2 * rangeKm;
  var cell = Math.max(1, rangeKm / 6);
  function pow2ge(v) { var p = 1; while (p < v) p <<= 1; return p; }
  var needX = Math.ceil((maxX - minX + 2 * pad) / cell);
  var needY = Math.ceil((maxY - minY + 2 * pad) / cell);
  if (needX > 1024 || needY > 1024) cell = Math.max(cell, Math.max(maxX - minX, maxY - minY) / 512);
  var gx = Math.min(1024, pow2ge(Math.ceil((maxX - minX + 2 * pad) / cell)));
  var gy = Math.min(1024, pow2ge(Math.ceil((maxY - minY + 2 * pad) / cell)));
  var cx = gx * 2, cy = gy * 2; // circulant embedding needs the doubled grid
  var re = new Float64Array(cx * cy), im = new Float64Array(cx * cy);
  function lagDist(a, dim) { return (a < dim ? a : (2 * dim - a)) * cell; }
  for (var b = 0; b < cy; b++) {
    var dy = lagDist(b, gy);
    for (var a = 0; a < cx; a++) {
      var dx = lagDist(a, gx);
      re[b * cx + a] = Math.exp(-3 * Math.sqrt(dx * dx + dy * dy) / rangeKm);
    }
  }
  // Forward 2D FFT (rows then columns) of the embedded covariance.
  var rowRe = new Float64Array(cx), rowIm = new Float64Array(cx);
  for (var b2 = 0; b2 < cy; b2++) {
    for (var a2 = 0; a2 < cx; a2++) { rowRe[a2] = re[b2 * cx + a2]; rowIm[a2] = im[b2 * cx + a2]; }
    _fft1d(rowRe, rowIm, false);
    for (var a3 = 0; a3 < cx; a3++) { re[b2 * cx + a3] = rowRe[a3]; im[b2 * cx + a3] = rowIm[a3]; }
  }
  var colRe = new Float64Array(cy), colIm = new Float64Array(cy);
  for (var a4 = 0; a4 < cx; a4++) {
    for (var b3 = 0; b3 < cy; b3++) { colRe[b3] = re[b3 * cx + a4]; colIm[b3] = im[b3 * cx + a4]; }
    _fft1d(colRe, colIm, false);
    for (var b4 = 0; b4 < cy; b4++) { re[b4 * cx + a4] = colRe[b4]; im[b4 * cx + a4] = colIm[b4]; }
  }
  // Spectral synthesis: sqrt of eigenvalues (clamp tiny negatives), complex white noise.
  for (var e = 0; e < cx * cy; e++) {
    var lam = re[e] / (cx * cy); // unnormalized forward FFT scale
    re[e] = Math.sqrt(Math.max(0, lam)) * Physics.gaussRng(rng);
    im[e] = Math.sqrt(Math.max(0, lam)) * Physics.gaussRng(rng);
  }
  // Inverse 2D FFT -> grid field
  for (var b5 = 0; b5 < cy; b5++) {
    for (var a5 = 0; a5 < cx; a5++) { rowRe[a5] = re[b5 * cx + a5]; rowIm[a5] = im[b5 * cx + a5]; }
    _fft1d(rowRe, rowIm, true);
    for (var a6 = 0; a6 < cx; a6++) { re[b5 * cx + a6] = rowRe[a6]; im[b5 * cx + a6] = rowIm[a6]; }
  }
  for (var a7 = 0; a7 < cx; a7++) {
    for (var b6 = 0; b6 < cy; b6++) { colRe[b6] = re[b6 * cx + a7]; colIm[b6] = im[b6 * cx + a7]; }
    _fft1d(colRe, colIm, true);
    for (var b7 = 0; b7 < cy; b7++) { re[b7 * cx + a7] = colRe[b7]; im[b7 * cx + a7] = colIm[b7]; }
  }
  // Normalize to unit variance over the synthesized grid, then sample.
  var mean = 0;
  for (var g = 0; g < cx * cy; g++) mean += re[g];
  mean /= cx * cy;
  var varg = 0;
  for (var g2 = 0; g2 < cx * cy; g2++) { var d = re[g2] - mean; varg += d * d; }
  varg /= cx * cy;
  var sd = Math.sqrt(varg) || 1;
  var out = new Array(n);
  for (var s = 0; s < n; s++) {
    var fx = (xs[s] - (minX - pad)) / cell, fy = (ys[s] - (minY - pad)) / cell;
    var x0 = Math.max(0, Math.min(cx - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(cy - 1, Math.floor(fy)));
    var x1 = Math.min(cx - 1, x0 + 1), y1 = Math.min(cy - 1, y0 + 1);
    var tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    var v00 = (re[y0 * cx + x0] - mean) / sd, v10 = (re[y0 * cx + x1] - mean) / sd;
    var v01 = (re[y1 * cx + x0] - mean) / sd, v11 = (re[y1 * cx + x1] - mean) / sd;
    out[s] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  }
  return out;
};

/** Monte Carlo ensemble of station intensities for one event.
 *  context: {source, geometry, gmpModel, options} as predictStationMotion.
 *  options: {members=200, seed, magSigma=0.2, depthSigmaKm=5, epicenterSigmaKm=5,
 *            jitter=true, keepMembers=false}
 *  Per station with st.observedIntensity set, inside68/inside80 flags and the
 *  pooled coverage diagnostics are computed. */
Physics.ensembleIntensityField = function(context, stations, options) {
  options = options || {};
  var members = Math.max(2, Math.round(options.members || 200));
  var rng = Physics.seededRng(options.seed == null ? 'ensemble' : options.seed);
  var srcType = (context.source && context.source.sourceType) || 'crustal';
  var branches = context.gmpModel === 'logic-tree'
    ? Physics.logicTreeBranches(srcType)
    : [{ model: context.gmpModel || Physics.resolveGmpModel('auto', srcType, context.source.mw), weight: 1 }];
  var jitter = options.jitter !== false;
  var magSigma = jitter ? (options.magSigma == null ? 0.2 : options.magSigma) : 0;
  var depthSigma = jitter ? (options.depthSigmaKm == null ? 5 : options.depthSigmaKm) : 0;
  var epiSigma = jitter ? (options.epicenterSigmaKm == null ? 5 : options.epicenterSigmaKm) : 0;

  var lat0 = context.source.lat, lng0 = context.source.lng;
  var kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  var xs = new Array(stations.length), ys = new Array(stations.length);
  for (var i = 0; i < stations.length; i++) {
    xs[i] = (Number(stations[i].lng) - lng0) * kx;
    ys[i] = (Number(stations[i].lat) - lat0) * ky;
  }
  var rangeKm = Physics.SPATIAL_CORRELATION.lnPga.rangeKm || 94;

  var acc = stations.map(function() { return []; });
  var pgaAcc = options.keepPga ? stations.map(function() { return []; }) : null;
  var LN10 = Math.log(10);
  for (var m = 0; m < members; m++) {
    var u = rng(), wsum = 0, branch = branches[branches.length - 1];
    for (var bi = 0; bi < branches.length; bi++) {
      wsum += branches[bi].weight;
      if (u <= wsum) { branch = branches[bi]; break; }
    }
    var comp = Physics.getGmpSigmaComponents(branch.model, srcType);
    var tauLn = (comp.tau == null ? 0.30 : comp.tau) * LN10;
    var phiLn = (comp.phi == null ? 0.60 : comp.phi) * LN10;
    var delta = Physics.gaussRng(rng) * tauLn;
    var ctxM = {
      source: {
        lat: lat0 + (epiSigma ? Physics.gaussRng(rng) * epiSigma / ky : 0),
        lng: lng0 + (epiSigma ? Physics.gaussRng(rng) * epiSigma / kx : 0),
        mw: context.source.mw + (magSigma ? Physics.gaussRng(rng) * magSigma : 0),
        depthKm: context.source.depthKm + (depthSigma ? Physics.gaussRng(rng) * depthSigma : 0),
        strikeDeg: context.source.strikeDeg, dipDeg: context.source.dipDeg, rakeDeg: context.source.rakeDeg,
        sourceType: srcType
      },
      geometry: context.geometry, gmpModel: branch.model, options: context.options
    };
    var field = Physics.correlatedGaussianField2D(xs, ys, rangeKm, rng);
    for (var s = 0; s < stations.length; s++) {
      var r = Physics.predictStationMotion(ctxM, stations[s], {});
      if (!r) { acc[s].push(null); if (pgaAcc) pgaAcc[s].push(null); continue; }
      var f = Math.exp(delta + phiLn * field[s]);
      acc[s].push(Physics.calcJmaIntensity(r.pga * f, r.pgv * f));
      if (pgaAcc) pgaAcc[s].push(r.pga * f);
    }
  }
  function quant(sorted, q) {
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[idx];
  }
  var inside68 = 0, inside80 = 0, obsN = 0;
  var perStation = stations.map(function(st, s) {
    var vals = acc[s].filter(function(v) { return v != null; }).sort(function(a, b) { return a - b; });
    var row = {
      lat: Number(st.lat), lng: Number(st.lng),
      mean: vals.reduce(function(a, b) { return a + b; }, 0) / (vals.length || 1),
      p10: quant(vals, 0.10), p16: quant(vals, 0.16), p50: quant(vals, 0.50),
      p84: quant(vals, 0.84), p90: quant(vals, 0.90)
    };
    row.median = row.p50;
    if (st.observedIntensity != null) {
      row.observedIntensity = Number(st.observedIntensity);
      var in68 = row.observedIntensity >= row.p16 && row.observedIntensity <= row.p84;
      var in80 = row.observedIntensity >= row.p10 && row.observedIntensity <= row.p90;
      row.inside68 = in68; row.inside80 = in80;
      obsN++; if (in68) inside68++; if (in80) inside80++;
    }
    if (options.keepMembers) row.members = vals;
    if (pgaAcc) row.pgaMembers = pgaAcc[s]
      .filter(function(v) { return v != null; }).sort(function(a, b) { return a - b; });
    return row;
  });
  return {
    members: members, branches: branches, perStation: perStation,
    coverage: obsN ? { n: obsN, p16p84: inside68 / obsN, p10p90: inside80 / obsN } : null
  };
};


/**
 * Return total sigma (log10 units) for the active GMPE model.
 * @param {string} gmpModel — GMPE key (log|si-midorikawa|log-ff|kanno2006|zhao2006|auto)
 * @param {string} srcType — crustal|interplate|intraslab
 * @param {string} imt — 'pga' or 'pgv' (PGV sigma ≈ PGA sigma for most models)
 * @param {number} mw — magnitude used when resolving the auto model
 * @returns {number} Total standard deviation in log10 units
 */
Physics.getGmpSigma = function(gmpModel, srcType, imt, mw) {
  var model = Physics.resolveGmpModel(gmpModel, srcType || 'crustal', mw == null ? 7.0 : mw);
  if (model === 'zhao2006') {
    var s = Physics.ZHAO2006_SIGMA[srcType] || Physics.ZHAO2006_SIGMA['crustal'];
    return s.sigmaT;
  }
  if (model === 'kanno2006') return Physics.KANNO2006_SIGMA.sigmaT;
  if (model === 'si-midorikawa') return Physics.SIMID_SIGMA.sigmaT;
  // log, log-ff, and fallback
  return Physics.LOG_SIGMA.sigmaT;
};

Physics.getGmpSigmaComponents = function(gmpModel, srcType, imt, mw) {
  var model = Physics.resolveGmpModel(gmpModel, srcType || 'crustal', mw == null ? 7.0 : mw);
  if (model === 'zhao2006') {
    var z = Physics.ZHAO2006_SIGMA[srcType] || Physics.ZHAO2006_SIGMA.crustal;
    return { model:model, tau:z.tau, phi:z.phi, sigmaT:z.sigmaT, unit:'log10' };
  }
  var fitted = Physics.GMPE_SIGMA_COMPONENTS[model];
  if (fitted) return { model:model, tau:fitted.tau, phi:fitted.phi, sigmaT:fitted.sigmaT, unit:'log10' };
  var sigmaT = Physics.getGmpSigma(model, srcType, imt, mw);
  return { model:model, tau:null, phi:null, sigmaT:sigmaT, unit:'log10' };
};

// ================================================================
//  RESPONSE SPECTRUM & LPGM
// ================================================================

Physics.calcResponseSpectrum = function(pga, soilAmpVal, T) {
  var Tg = 0.2 * soilAmpVal, S;
  if (Tg <= 0) return pga;
  if (T < Tg) S = 1 + 1.5*(T/Tg); else if (T < 1) S = 2.5; else S = 2.5/T;
  return pga * S;
};

/** Linear SDOF response spectrum calculated with average-acceleration Newmark-beta. */
Physics.sdofResponseSpectrum = function(accGal, sampleRate, periods, damping) {
  if (!accGal || !accGal.length || !(sampleRate > 0)) return [];
  periods = periods || [];
  damping = damping == null ? 0.05 : Math.max(0, Number(damping));
  var dt = 1 / sampleRate, betaN = 0.25, gammaN = 0.5, result = [];
  for (var pi = 0; pi < periods.length; pi++) {
    var T = Math.max(0.01, Number(periods[pi]) || 0.01);
    var omega = 2*Math.PI/T, k = omega*omega, c = 2*damping*omega;
    var u=0, v=0, aRel=-(Number(accGal[0])||0)/100;
    var a0=1/(betaN*dt*dt), a1=gammaN/(betaN*dt), a2=1/(betaN*dt);
    var a3=1/(2*betaN)-1, a4=gammaN/betaN-1, a5=dt*(gammaN/(2*betaN)-1);
    var kEff=k+a0+c*a1, maxU=0, maxAbsAcc=0;
    for (var n=1;n<accGal.length;n++) {
      var ag=(Number(accGal[n])||0)/100;
      var pEff=-ag+a0*u+a2*v+a3*aRel+c*(a1*u+a4*v+a5*aRel);
      var uNew=pEff/kEff;
      var aNew=a0*(uNew-u)-a2*v-a3*aRel;
      var vNew=v+dt*((1-gammaN)*aRel+gammaN*aNew);
      maxU=Math.max(maxU,Math.abs(uNew));
      maxAbsAcc=Math.max(maxAbsAcc,Math.abs(aNew+ag));
      u=uNew; v=vNew; aRel=aNew;
    }
    result.push({period:T,sdM:maxU,psvCms:omega*maxU*100,
      psaGal:omega*omega*maxU*100,absoluteSaGal:maxAbsAcc*100});
  }
  return result;
};

// JMA long-period ground motion classes - official bounds: max 5%-damped
// absolute velocity response Sva over the 1.6-7.8 s band >= 5/15/50/100 cm/s
// for classes 1/2/3/4 (2020 JMA notice; JMA EEW reference table).
Physics.LPCM_THRESHOLDS_CMS = [5, 15, 50, 100];
// Empirical factor anchoring the band spectrum to the GMPE PGA (absorbs the
// oscillator-response vs time-peak ratio; calibrated against the Tohoku-2011
// class-4 and Noto-2024 class-2 observation anchors).
Physics.LPCM_RESP_FACTOR = 0.28;

// Predicted max Sva (cm/s) in the 1.6-7.8 s band and its JMA long-period
// class. A Brune source x Q-path spectrum (magnitude-dependent corner,
// frequency-dependent Q) is anchored to the GMPE PGA at 3 Hz:
// PSA(T) ~= K*PGA*A(1/T)/A(3Hz), Sva ~= PSA*T/2pi, stepped 0.2 s (the JMA
// EEW convention). Great earthquakes keep band energy far offshore (Q spares
// the long periods PGA loses); small events roll off above their corner.
Physics.calcLongPeriodSv = function(mag, distKm, pga) {
  var out = {svCms: 0, lpcClass: 0, peakPeriod: 0};
  if (!(pga > 0) || !(mag > 0)) return out;
  var d = Math.max(1, distKm || 1);
  var aRef = Physics.fullSpectrum(3.0, mag, d, 10, 1);
  if (!(aRef > 0)) return out;
  var maxSv = 0, maxT = 0;
  for (var T = 1.6; T <= 7.8 + 1e-9; T += 0.2) {
    var aF = Physics.fullSpectrum(1 / T, mag, d, 10, 1);
    var sv = Physics.LPCM_RESP_FACTOR * pga * (aF / aRef) * T / (2 * Math.PI);
    if (sv > maxSv) { maxSv = sv; maxT = T; }
  }
  var cls = 0, th = Physics.LPCM_THRESHOLDS_CMS;
  for (var ci = 0; ci < th.length; ci++) { if (maxSv >= th[ci]) cls = ci + 1; }
  out.svCms = maxSv; out.lpcClass = cls; out.peakPeriod = +maxT.toFixed(1);
  return out;
};

// Station-level class (map L1-L4 label, popup, info panel, CSV). Site enters
// via the already site-amplified PGA; soilAmpVal stays for signature parity.
Physics.calcLPGM = function(mag, R, pga, soilAmpVal) {
  return Physics.calcLongPeriodSv(mag, R, pga).lpcClass;
};

// v4.2: Period-specific spectral acceleration (Japanese building code key periods)
Physics.saAtPeriod = function(pga, soilAmpVal, T) {
  return Physics.calcResponseSpectrum(pga, soilAmpVal, T);
};

// v4.2: Convenience accessors for building-code periods
Physics.sa02s = function(pga, soilAmpVal) { return Physics.calcResponseSpectrum(pga, soilAmpVal, 0.2); };
Physics.sa10s = function(pga, soilAmpVal) { return Physics.calcResponseSpectrum(pga, soilAmpVal, 1.0); };

// v4.2: LPGM level label (Japan JMA long-period ground motion classes)
Physics.lpgmLabel = function(level) {
  var labels = {0:'—', 1:'LPGM-1', 2:'LPGM-2', 3:'LPGM-3', 4:'LPGM-4'};
  return labels[level] || '—';
};

// ================================================================
//  v4.2: INTENSITY SCALE CONVERSIONS (JMA Shindo ↔ MMI ↔ EMS-98)
// ================================================================

// JMA Shindo → Modified Mercalli Intensity (MMI) — approximate mapping
Physics.SHINDO_TO_MMI = {0:1, 1:2, 2:4, 3:5, 4:6, '5-':7, '5+':8, '6-':9, '6+':10, 7:11, 5:7, 6:9};
Physics.shindoToMMI = function(shindo) {
  if (typeof shindo === 'number') shindo = Physics.shindoLabel(shindo);
  return Physics.SHINDO_TO_MMI[shindo] != null ? Physics.SHINDO_TO_MMI[shindo] : shindo;
};

// JMA Shindo → EMS-98 intensity — approximate mapping
Physics.SHINDO_TO_EMS = {0:1, 1:2, 2:4, 3:5, 4:6, '5-':7, '5+':8, '6-':9, '6+':10, 7:11, 5:7, 6:9};
Physics.shindoToEMS = function(shindo) {
  if (typeof shindo === 'number') shindo = Physics.shindoLabel(shindo);
  return Physics.SHINDO_TO_EMS[shindo] != null ? Physics.SHINDO_TO_EMS[shindo] : shindo;
};

// MMI → JMA Shindo (reverse lookup — returns closest JMA level)
Physics.mmiToShindo = function(mmi) {
  if (mmi <= 1) return 0; if (mmi <= 2) return 1; if (mmi <= 3) return 2;
  if (mmi <= 4) return 3; if (mmi <= 5) return 4;
  if (mmi <= 6) return '5-'; if (mmi <= 7) return '5+';
  if (mmi <= 8) return '6-'; if (mmi <= 10) return '6+';
  return 7;
};

// v4.2: Convert a shindo value to the configured intensity scale for display
Physics.convertIntensity = function(shindo, scale) {
  if (!scale || scale === 'shindo') return shindo;
  if (scale === 'mmi') return Physics.shindoToMMI(shindo);
  if (scale === 'ems98') return Physics.shindoToEMS(shindo);
  return shindo;
};

// ================================================================
//  FAULT SCALING (Wells & Coppersmith / Strasser et al.)
// ================================================================

/**
 * Fault length from Wells & Coppersmith (1994). @param {number} Mw @returns {number} Length in km, null if Mw<6.5
 */
Physics.faultLength = function(m) {
  return Math.min(800, Math.pow(10, 0.50*m - 1.80));
};

/**
 * Fault width from Wells & Coppersmith (1994). @param {number} Mw @returns {number} Width in km, null if Mw<6.5
 */
Physics.faultWidth = function(m) {
  if (m < 7) return Math.max(10, Physics.faultLength(m) / 2.0);
  if (m < 8) return Math.max(10, Physics.faultLength(m) / 2.5);
  if (m <= 9) return Math.max(10, Math.min(Physics.faultLength(m) / 3.0, 150));
  return Math.min(200, Physics.faultLength(m) / 3.5);
};

// Median rupture dimensions. Crustal values use Wells & Coppersmith (1994)
// subsurface rupture length/width; interface and intraslab values use the
// corresponding Strasser et al. (2010) regressions. Model names and sigmas are
// returned so callers can expose the epistemic uncertainty instead of treating
// the median rectangle as an observed fault solution.
Physics.faultDimensions = function(mw, sourceType) {
  var src = sourceType || 'crustal';
  var L, W, relation, sigmaLogL, sigmaLogW;
  if (src === 'interplate') {
    L = Math.pow(10, -2.477 + 0.585 * mw);
    W = Math.pow(10, -0.882 + 0.351 * mw);
    L = Math.min(1000, Math.max(8, L));
    W = Math.min(250, Math.max(8, W));
    relation = 'Strasser et al. (2010) interface';
    sigmaLogL = 0.180; sigmaLogW = 0.173;
  } else if (src === 'intraslab') {
    L = Math.pow(10, -2.350 + 0.562 * mw);
    W = Math.pow(10, -1.058 + 0.356 * mw);
    L = Math.min(500, Math.max(8, L));
    W = Math.min(120, Math.max(8, W));
    relation = 'Strasser et al. (2010) intraslab';
    sigmaLogL = 0.146; sigmaLogW = 0.067;
  } else {
    L = Math.pow(10, -2.44 + 0.59 * mw);
    W = Math.pow(10, -1.01 + 0.32 * mw);
    L = Math.min(800, Math.max(8, L));
    W = Math.min(80, Math.max(8, W));
    relation = 'Wells & Coppersmith (1994) subsurface';
    sigmaLogL = 0.16; sigmaLogW = 0.15;
  }
  return {L:L, W:W, area:L*W, aspectRatio:L/W, sourceType:src,
    relation:relation, sigmaLogL:sigmaLogL, sigmaLogW:sigmaLogW};
};

Physics.seismicMoment = function(mw) {
  return Math.pow(10, 1.5 * mw + 9.1);
};

Physics.momentMagnitude = function(momentNm) {
  return (Math.log10(Math.max(momentNm, 1)) - 9.1) / 1.5;
};

// Canonical fault geometry shared by distances, subsources and rendering.
Physics.buildFaultGeometry = function(lat, lng, mw, strikeDeg, dipDeg, depthKm, opts) {
  opts = opts || {};
  if (mw < 6.5) return null;
  var sourceType = opts.sourceType || Physics.sourceType(depthKm);
  var dims = Physics.faultDimensions(mw, sourceType);
  var L = dims.L, nominalW = dims.W;
  var dip = Math.max(0.1, Math.min(90, Number(dipDeg) || 90));
  var dipRad = dip * Math.PI / 180;
  var sinDip = Math.max(0.001, Math.sin(dipRad));
  var cosDip = Math.cos(dipRad);
  var hpFrac = opts.hypocenterFrac != null ? opts.hypocenterFrac : 0.35;
  hpFrac = Math.max(0.05, Math.min(0.95, hpFrac));

  var topDepth = opts.seismoTopKm;
  var bottomDepth = opts.seismoBottomKm;
  if (topDepth == null) topDepth = sourceType === 'intraslab' ? Math.max(15, depthKm - 50) : (sourceType === 'interplate' ? 0 : 1);
  if (bottomDepth == null) bottomDepth = sourceType === 'intraslab' ? depthKm + 50
    : (sourceType === 'interplate' ? Math.max(80, depthKm + 20) : Math.max(30, depthKm + 15));
  topDepth = Math.min(topDepth, depthKm - 0.1);
  bottomDepth = Math.max(bottomDepth, depthKm + 0.1);
  // Preserve the scaling-relation width whenever the entire plane can fit in
  // the seismogenic layer. Move the hypocenter fraction first; clipping both
  // sides around a fixed 0.35 fraction was the main cause of long thin faults.
  var verticalSpan = nominalW * sinDip;
  var hpMin = Math.max(0.02, 1 - (bottomDepth - depthKm) / Math.max(verticalSpan, 1e-9));
  var hpMax = Math.min(0.98, (depthKm - topDepth) / Math.max(verticalSpan, 1e-9));
  var maxLayerW = Math.max(0.2, (bottomDepth - topDepth) / sinDip);
  var widthTruncated = nominalW > maxLayerW + 1e-9;
  var W = widthTruncated ? maxLayerW : nominalW;
  if (!widthTruncated && hpMin <= hpMax) hpFrac = Math.max(hpMin, Math.min(hpMax, hpFrac));
  else if (widthTruncated) hpFrac = Math.max(0.02, Math.min(0.98,
    (depthKm - topDepth) / Math.max(bottomDepth - topDepth, 1e-9)));
  var topOffset = -hpFrac * W;
  var bottomOffset = (1 - hpFrac) * W;
  var targetPatchKm = Math.max(10, Math.min(16, Number(opts.targetPatchKm) || 14));
  var nStrike = Math.min(48, Math.max(4, Math.ceil(L / targetPatchKm)));
  var nDip = Math.min(24, Math.max(3, Math.ceil(W / targetPatchKm)));
  var strikeRad = strikeDeg * Math.PI / 180;
  var dipDirRad = strikeRad + Math.PI / 2;
  var cosLat = Math.max(0.0001, Math.cos(lat * Math.PI / 180));
  var halfL = L / 2;

  function point(alongStrike, downDip) {
    var dipHoriz = downDip * cosDip;
    var dLat = alongStrike * Math.cos(strikeRad) / 111.32
      + dipHoriz * Math.cos(dipDirRad) / 111.32;
    var dLng = alongStrike * Math.sin(strikeRad) / (111.32 * cosLat)
      + dipHoriz * Math.sin(dipDirRad) / (111.32 * cosLat);
    return {lat: lat + dLat, lng: lng + dLng, depth: depthKm + downDip * sinDip};
  }
  function leafletPoint(alongStrike, downDip) {
    var p = point(alongStrike, downDip);
    return [p.lat, p.lng];
  }

  return {
    lat: lat, lng: lng, mw: mw, depth: depthKm, sourceType: sourceType,
    strikeDeg: strikeDeg, dipDeg: dip, L: L, W: W, nominalW: nominalW,
    nominalL:L, nominalArea:dims.area, actualArea:L*W, aspectRatio:L/W,
    widthRatio:W/nominalW, widthTruncated:widthTruncated,
    geometryQuality:widthTruncated ? 'depth-limited' : 'nominal',
    scalingRelation:dims.relation, sigmaLogL:dims.sigmaLogL, sigmaLogW:dims.sigmaLogW,
    targetPatchKm:targetPatchKm,
    topDepth: depthKm + topOffset * sinDip,
    bottomDepth: depthKm + bottomOffset * sinDip,
    topOffset: topOffset, bottomOffset: bottomOffset,
    hypocenterFrac: hpFrac, nStrike: nStrike, nDip: nDip, point: point,
    corners: [leafletPoint(-halfL, topOffset), leafletPoint(halfL, topOffset),
      leafletPoint(halfL, bottomOffset), leafletPoint(-halfL, bottomOffset)],
    cellPoint: function(i, j, alongFrac, dipFrac) {
      return point(-halfL + (i + alongFrac) * (L / nStrike),
        topOffset + (j + dipFrac) * (W / nDip));
    },
    cellCorner: function(i, j, alongFrac, dipFrac) {
      var p = this.cellPoint(i, j, alongFrac, dipFrac);
      return [p.lat, p.lng];
    }
  };
};

/**
 * v5.5: re-attach the geometry helper closures (point/cellPoint/cellCorner)
 * to a plain-data fault geometry — e.g. after a source model crossed
 * postMessage into the tsunami worker (functions cannot be structured-cloned).
 * Idempotent: geometries that already carry the helpers pass through.
 */
Physics.rehydrateFaultGeometry = function(geom) {
  if (!geom || typeof geom !== 'object' || typeof geom.point === 'function') return geom;
  var lat = Number(geom.lat), lng = Number(geom.lng), depthKm = Number(geom.depth) || 0;
  var L = Number(geom.L) || 0, W = Number(geom.W) || 0;
  var strikeRad = (Number(geom.strikeDeg) || 0) * Math.PI / 180;
  var dip = Math.max(0.1, Math.min(90, Number(geom.dipDeg) || 90));
  var dipRad = dip * Math.PI / 180;
  var sinDip = Math.max(0.001, Math.sin(dipRad));
  var cosDip = Math.cos(dipRad);
  var dipDirRad = strikeRad + Math.PI / 2;
  var cosLat = Math.max(0.0001, Math.cos(lat * Math.PI / 180));
  var halfL = L / 2;
  var topOffset = Number(geom.topOffset);
  if (!isFinite(topOffset)) topOffset = -0.35 * W;
  var nStrike = Math.max(1, Math.round(Number(geom.nStrike) || 1));
  var nDip = Math.max(1, Math.round(Number(geom.nDip) || 1));
  function point(alongStrike, downDip) {
    var dipHoriz = downDip * cosDip;
    var dLat = alongStrike * Math.cos(strikeRad) / 111.32
      + dipHoriz * Math.cos(dipDirRad) / 111.32;
    var dLng = alongStrike * Math.sin(strikeRad) / (111.32 * cosLat)
      + dipHoriz * Math.sin(dipDirRad) / (111.32 * cosLat);
    return {lat: lat + dLat, lng: lng + dLng, depth: depthKm + downDip * sinDip};
  }
  geom.point = point;
  geom.cellPoint = function(i, j, alongFrac, dipFrac) {
    return point(-halfL + (i + alongFrac) * (L / nStrike),
      topOffset + (j + dipFrac) * (W / nDip));
  };
  geom.cellCorner = function(i, j, alongFrac, dipFrac) {
    var p = this.cellPoint(i, j, alongFrac, dipFrac);
    return [p.lat, p.lng];
  };
  return geom;
};

// ================================================================
//  RUPTURE DISTANCE (Rrup)
// ================================================================

function _rrupVecSub(a,b){return {x:a.x-b.x,y:a.y-b.y,z:a.z-b.z};}
function _rrupVecAdd(a,b){return {x:a.x+b.x,y:a.y+b.y,z:a.z+b.z};}
function _rrupVecScale(a,s){return {x:a.x*s,y:a.y*s,z:a.z*s};}
function _rrupVecDot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z;}
function _rrupVecLengthSq(a){return _rrupVecDot(a,a);}
function _rrupEcef(lat,lng,depthKm){
  var phi=Number(lat)*Math.PI/180,lam=Number(lng)*Math.PI/180,r=6371.0088-Number(depthKm||0),cp=Math.cos(phi);
  return {x:r*cp*Math.cos(lam),y:r*cp*Math.sin(lam),z:r*Math.sin(phi)};
}
// Squared Euclidean distance from a point to a triangle, following the
// Voronoi-region test in Real-Time Collision Detection (Christer Ericson).
function _rrupPointTriangleSq(p,a,b,c){
  var ab=_rrupVecSub(b,a),ac=_rrupVecSub(c,a),ap=_rrupVecSub(p,a);
  var d1=_rrupVecDot(ab,ap),d2=_rrupVecDot(ac,ap);
  if(d1<=0&&d2<=0)return _rrupVecLengthSq(ap);
  var bp=_rrupVecSub(p,b),d3=_rrupVecDot(ab,bp),d4=_rrupVecDot(ac,bp);
  if(d3>=0&&d4<=d3)return _rrupVecLengthSq(bp);
  var vc=d1*d4-d3*d2;
  if(vc<=0&&d1>=0&&d3<=0){var v=d1/(d1-d3);return _rrupVecLengthSq(_rrupVecSub(p,_rrupVecAdd(a,_rrupVecScale(ab,v))));}
  var cp=_rrupVecSub(p,c),d5=_rrupVecDot(ab,cp),d6=_rrupVecDot(ac,cp);
  if(d6>=0&&d5<=d6)return _rrupVecLengthSq(cp);
  var vb=d5*d2-d1*d6;
  if(vb<=0&&d2>=0&&d6<=0){var w=d2/(d2-d6);return _rrupVecLengthSq(_rrupVecSub(p,_rrupVecAdd(a,_rrupVecScale(ac,w))));}
  var va=d3*d6-d5*d4;
  if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){var bc=_rrupVecSub(c,b),q=(d4-d3)/((d4-d3)+(d5-d6));return _rrupVecLengthSq(_rrupVecSub(p,_rrupVecAdd(b,_rrupVecScale(bc,q))));}
  var denom=1/(va+vb+vc),vFace=vb*denom,wFace=vc*denom;
  return _rrupVecLengthSq(_rrupVecSub(p,_rrupVecAdd(a,_rrupVecAdd(_rrupVecScale(ab,vFace),_rrupVecScale(ac,wFace)))));
}
function _rrupImportedCache(fp){
  if(fp._rrupPatchCache)return fp._rrupPatchCache;
  var patches=fp.subs||[],cache=[];
  for(var i=0;i<patches.length;i++){
    var corners=patches[i].corners;if(!corners||corners.length<4)continue;
    var v=corners.slice(0,4).map(function(p){return _rrupEcef(p.lat,p.lng,p.depthKm!=null?p.depthKm:p.depth);});
    var center=_rrupVecScale(_rrupVecAdd(_rrupVecAdd(v[0],v[1]),_rrupVecAdd(v[2],v[3])),0.25),radius=0;
    for(var j=0;j<4;j++)radius=Math.max(radius,Math.sqrt(_rrupVecLengthSq(_rrupVecSub(v[j],center))));
    cache.push({a:v[0],b:v[1],c:v[2],d:v[3],center:center,radius:radius});
  }
  try{Object.defineProperty(fp,'_rrupPatchCache',{value:cache,configurable:true});}catch(error){fp._rrupPatchCache=cache;}
  return cache;
}

Physics.rrupDistance = function(staLat, staLng, faultParams) {
  var fp = faultParams;
  if(fp&&fp.kind==='imported-finite-fault'&&fp.subs&&fp.subs.length){
    var station=_rrupEcef(staLat,staLng,0),items=_rrupImportedCache(fp),bestSq=Infinity;
    for(var ii=0;ii<items.length;ii++){
      var item=items[ii],centerDistance=Math.sqrt(_rrupVecLengthSq(_rrupVecSub(station,item.center)));
      var lower=Math.max(0,centerDistance-item.radius);if(lower*lower>=bestSq)continue;
      bestSq=Math.min(bestSq,_rrupPointTriangleSq(station,item.a,item.b,item.c),_rrupPointTriangleSq(station,item.a,item.c,item.d));
    }
    return Math.max(0.01,Math.sqrt(bestSq));
  }
  var distKm = Physics.haversineDist(fp.lat, fp.lng, staLat, staLng);
  if (distKm < 0.01) distKm = 0.01;
  var dLat = (staLat - fp.lat) * Math.PI / 180;
  var dLng = (staLng - fp.lng) * Math.PI / 180;
  var y = Math.sin(dLng) * Math.cos(staLat * Math.PI / 180);
  var x = Math.cos(fp.lat * Math.PI / 180) * Math.sin(staLat * Math.PI / 180)
        - Math.sin(fp.lat * Math.PI / 180) * Math.cos(staLat * Math.PI / 180) * Math.cos(dLng);
  var bearing = Math.atan2(y, x);
  var srRad = fp.strikeDeg * Math.PI / 180;
  var dipRad = fp.dipDeg * Math.PI / 180;
  var x_s = distKm * Math.cos(bearing - srRad);
  var y_s = distKm * Math.sin(bearing - srRad);
  var halfL = fp.L / 2;
  var xStar = Math.max(-halfL, Math.min(halfL, x_s));
  var topOffset = fp.topOffset != null ? fp.topOffset
    : -(fp.hypocenterFrac != null ? fp.hypocenterFrac : 0.35) * fp.W;
  var bottomOffset = fp.bottomOffset != null ? fp.bottomOffset : topOffset + fp.W;
  var sStar = y_s * Math.cos(dipRad) - fp.depth * Math.sin(dipRad);
  sStar = Math.max(topOffset, Math.min(bottomOffset, sStar));
  var dx = xStar - x_s;
  var dy = sStar * Math.cos(dipRad) - y_s;
  var dz = fp.depth + sStar * Math.sin(dipRad);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

// ================================================================
//  2D FINITE FAULT SUBSOURCE GRID
// ================================================================

Physics.genSubSources = function(la, ln, m, strikeDeg, dipDeg, depthKm, rupSpeed, opts) {
  opts = opts || {};
  var geometry = Physics.buildFaultGeometry(la, ln, m, strikeDeg, dipDeg, depthKm, opts);
  if (!geometry) return null;
  var L = geometry.L, W = geometry.W;
  var nStrike = geometry.nStrike, nDip = geometry.nDip;
  var totalSubs = nStrike * nDip;
  var dL = L / nStrike;
  var dW = W / nDip;
  var subs = [];
  var topOffset = geometry.topOffset;
  // Asperity: slip concentrated along-strike/down-dip at config-defined fractions.
  var aspPosS = (typeof cfgGet === 'function') ? cfgGet('aspPosStrike') : 0.55;
  var aspPosD = (typeof cfgGet === 'function') ? cfgGet('aspPosDip') : 0.6;
  var aspSigIF = (typeof cfgGet === 'function') ? cfgGet('aspSigmaI') : 0.35;
  var aspSigJF = (typeof cfgGet === 'function') ? cfgGet('aspSigmaJ') : 0.4;
  var aspI = Math.floor(nStrike * aspPosS), aspJ = Math.floor(nDip * aspPosD);
  var aspSigmaI = nStrike * aspSigIF, aspSigmaJ = nDip * aspSigJF;
  // Compute raw weights. Default: single Gaussian asperity. Custom opts.aspList:
  // sum of Gaussians at each user-defined asperity {sFrac, dFrac, weight}.
  var rawWeights = [], wSum = 0;
  var perturbation = (typeof cfgGet === 'function') ? Number(cfgGet('slipPerturbation')) : 0.4;
  if (opts.slipPerturbation != null) perturbation = Number(opts.slipPerturbation);
  perturbation = Math.max(0, Math.min(1, isFinite(perturbation) ? perturbation : 0));
  var perturbSeed = (Math.floor((Math.abs(la)*1000 + Math.abs(ln)*100 + m*1000 + strikeDeg*7 + dipDeg*11)) ^ ((Number(opts.randomSeed) || 0) >>> 0)) >>> 0;
  function perturbRand() { perturbSeed = (1664525*perturbSeed + 1013904223) >>> 0; return perturbSeed/4294967296; }
  // Low-wavenumber random field. Independent cell noise made the inferred slip
  // change with mesh resolution and produced a salt-and-pepper rupture. A small
  // Fourier sum gives deterministic, spatially correlated heterogeneity.
  var perturbModes = [];
  for (var pm = 0; pm < 10; pm++) {
    var modeKs=1+(pm%4),modeKd=1+((pm*2+1)%3);
    perturbModes.push({
      ks:modeKs,kd:modeKd,phase:2*Math.PI*perturbRand(),
      amp:1/Math.pow(modeKs*modeKs+modeKd*modeKd,0.65)
    });
  }
  function correlatedPerturb(i, j) {
    var x=(i+0.5)/nStrike, y=(j+0.5)/nDip, value=0, norm=0;
    for (var pmi=0;pmi<perturbModes.length;pmi++) {
      var mode=perturbModes[pmi];
      value += mode.amp*Math.cos(2*Math.PI*(mode.ks*x+mode.kd*y)+mode.phase);
      norm += mode.amp;
    }
    return norm > 0 ? value/norm : 0;
  }
  function edgeTaper(i, j) {
    var tx=Math.sin(Math.PI*(i+0.5)/nStrike), ty=Math.sin(Math.PI*(j+0.5)/nDip);
    return Math.pow(Math.max(0.001,tx*ty),0.55);
  }
  var aspList = (opts && opts.aspList && opts.aspList.length) ? opts.aspList : null;
  if (aspList) {
    for (var i = 0; i < nStrike; i++) {
      for (var j = 0; j < nDip; j++) {
        var w = 0.5; // baseline
        for (var ai = 0; ai < aspList.length; ai++) {
          var a = aspList[ai];
          var ci = (nStrike - 1) * (a.sFrac != null ? a.sFrac : 0.5);
          var cj = (nDip - 1) * (a.dFrac != null ? a.dFrac : 0.5);
          var di2 = (i - ci) / aspSigmaI, dj2 = (j - cj) / aspSigmaJ;
          w += (a.weight != null ? a.weight : 1) * Math.exp(-(di2*di2 + dj2*dj2) / 2);
        }
        w *= edgeTaper(i,j) * Math.exp(perturbation * correlatedPerturb(i,j));
        rawWeights.push(w); wSum += w;
      }
    }
  } else {
    for (var i = 0; i < nStrike; i++) {
      for (var j = 0; j < nDip; j++) {
        var di = (i - aspI) / aspSigmaI, dj = (j - aspJ) / aspSigmaJ;
        var w = 0.5 + 1.3 * Math.exp(-(di*di + dj*dj) / 2); // range ~0.5 to 1.8
        w *= edgeTaper(i,j) * Math.exp(perturbation * correlatedPerturb(i,j));
        rawWeights.push(w); wSum += w;
      }
    }
  }
  var totalMoment = Physics.seismicMoment(m);
  var rigidityGPa = Number(opts.rigidityGPa);
  if (!(rigidityGPa > 0)) rigidityGPa = geometry.sourceType === 'intraslab' ? 50 : (geometry.sourceType === 'interplate' ? 40 : 30);
  var patchAreaM2 = dL*dW*1e6;
  var averageSlipM = totalMoment/(rigidityGPa*1e9*L*W*1e6);
  rupSpeed = Math.max(0.5, Number(rupSpeed) || 2.8);
  var velocityModel=opts.ruptureVelocityModel||'slip-depth';
  var sourceTimeFunction=opts.sourceTimeFunction||'half-cosine';

  // Rupture mode: opts overrides cfg, cfg overrides default bilateral.
  // Bilateral spreads from fault center — identical to the original formula.
  // Unilateral nucleates at one end of strike and propagates in one direction
  // (longer rupture duration, directivity). Optional opts.hypoStrike/hypoDip
  // (fractions 0..1) place the nucleation point anywhere on the fault.
  var rMode = (opts && opts.ruptureMode) || ((typeof cfgGet === 'function') ? cfgGet('ruptureMode') : 'bilateral');
  var hypoSF = (opts && opts.hypoStrike != null) ? opts.hypoStrike : null; // along-strike fraction
  var hypoDF = (opts && opts.hypoDip != null) ? opts.hypoDip : null;       // down-dip fraction
  var unilateral = (rMode === 'unilateral');
  // Nucleation point on the fault plane (in fault-plane coords used by rt).
  var resolvedHypoSF = (hypoSF != null) ? Math.max(0,Math.min(1,hypoSF)) : (unilateral ? 0.02 : 0.5);
  var defaultHypoDF = geometry.hypocenterFrac;
  var resolvedHypoDF = Math.max(0,Math.min(1,(hypoDF != null) ? hypoDF : defaultHypoDF));
  var hypoAlong = -L/2 + resolvedHypoSF*L;
  var hypoJDepth  = topOffset + resolvedHypoDF*W;
  for (var i = 0; i < nStrike; i++) {
    for (var j = 0; j < nDip; j++) {
      var downDip = topOffset + (j + 0.5) * dW;
      var p = geometry.cellPoint(i, j, 0.5, 0.5);
      var rawWeight = rawWeights[i * nDip + j];
      var momentFraction = rawWeight / wSum;
      var patchMoment = totalMoment * momentFraction;
      var subM = Physics.momentMagnitude(patchMoment);
      var slipW = momentFraction * totalSubs;
      // Distance from the nucleation point along the fault plane.
      var alongStrike = -L/2 + (i+0.5)*dL;
      var ndx = alongStrike - hypoAlong, ndy = downDip - hypoJDepth;
      var speedFactor=1;
      if(velocityModel==='slip-depth'){
        var slipFactor=Math.max(0.65,Math.min(1.25,0.82+0.18*Math.sqrt(Math.max(0.1,slipW))));
        var normalizedDepth=Math.max(0,Math.min(1,(p.depth-geometry.topDepth)/Math.max(0.1,geometry.bottomDepth-geometry.topDepth)));
        speedFactor=slipFactor*(0.92+0.12*Math.sin(Math.PI*normalizedDepth));
      }else if(velocityModel==='depth'){
        var normalizedDepthOnly=Math.max(0,Math.min(1,(p.depth-geometry.topDepth)/Math.max(0.1,geometry.bottomDepth-geometry.topDepth)));
        speedFactor=0.85+0.2*Math.sin(Math.PI*normalizedDepthOnly);
      }
      var localRuptureSpeed=Math.max(0.5,rupSpeed*speedFactor);
      var rt = Math.sqrt(ndx*ndx + ndy*ndy) / Math.sqrt(rupSpeed*localRuptureSpeed);
      var patchSlipM = patchMoment/(rigidityGPa*1e9*patchAreaM2);
      var riseTime = Math.max(0.5, Math.min(20,
        0.8*Math.sqrt(dL*dW)/rupSpeed*Math.sqrt(Math.max(0.2,slipW))));
      subs.push({
        lat: p.lat, lng: p.lng,
        m: subM, depth: p.depth, moment: patchMoment,
        momentFraction: momentFraction, slipWeight: slipW, slipM:patchSlipM,
        areaKm2:dL*dW, alongStrikeKm:alongStrike, downDipKm:downDip,
        strikeIndex:i, dipIndex:j, ruptureTime:rt, riseTime:riseTime,
        ruptureSpeedKmS:localRuptureSpeed,sourceTimeFunction:sourceTimeFunction
      });
    }
  }
  var maxRT = 0;
  for (var k = 0; k < subs.length; k++)
    if (subs[k].ruptureTime > maxRT) maxRT = subs[k].ruptureTime;
  geometry.subs = subs;
  geometry.nSub = totalSubs;
  geometry.maxRuptureTime = maxRT;
  geometry.totalMoment = totalMoment;
  geometry.rigidityGPa = rigidityGPa;
  geometry.averageSlipM = averageSlipM;
  geometry.maxSlipM = subs.reduce(function(maximum, sub){return Math.max(maximum,sub.slipM);},0);
  geometry.maxSlipWeight = subs.reduce(function(maximum, sub){return Math.max(maximum,sub.slipWeight);},0);
  geometry.hypocenter = geometry.point(hypoAlong,hypoJDepth);
  geometry.hypocenterStrikeFrac = resolvedHypoSF;
  geometry.hypocenterDipFrac = resolvedHypoDF;
  geometry.ruptureSpeedKmS = rupSpeed;
  geometry.ruptureVelocityModel = velocityModel;
  geometry.sourceTimeFunction = sourceTimeFunction;
  return geometry;
};

Physics.rupturePatchFraction = function(patch, elapsed) {
  if(!patch)return 0;
  var x=(Number(elapsed)-Number(patch.ruptureTime||0))/Math.max(0.01,Number(patch.riseTime)||1);
  x=Math.max(0,Math.min(1,x));
  var stf=patch.sourceTimeFunction||'half-cosine';
  if(stf==='triangle')return x<0.5?2*x*x:1-2*(1-x)*(1-x);
  if(stf==='brune'){
    var a=6,raw=1-(1+a*x)*Math.exp(-a*x),normalizer=1-(1+a)*Math.exp(-a);
    return Math.max(0,Math.min(1,raw/normalizer));
  }
  if(stf==='boxcar')return x;
  return 0.5-0.5*Math.cos(Math.PI*x);
};

Physics.ruptureState = function(geometry, elapsed) {
  var subs=geometry&&geometry.subs||[],released=0,active=0,complete=0,endTime=0;
  for(var i=0;i<subs.length;i++){
    var sub=subs[i],fraction=Physics.rupturePatchFraction(sub,elapsed);
    if(Number(elapsed)>=sub.ruptureTime)active++;
    if(fraction>=1)complete++;
    released+=(sub.momentFraction||0)*fraction;
    endTime=Math.max(endTime,(sub.ruptureTime||0)+(sub.riseTime||0));
  }
  return {releasedMomentFraction:Math.max(0,Math.min(1,released)),activePatches:active,
    completedPatches:complete,totalPatches:subs.length,endTime:endTime};
};

/**
 * Deterministic non-negative kinematic slip inversion for a supplied Green
 * matrix. This is the auditable CPU reference step after waveform processing:
 * callers remain responsible for constructing calibrated observations and
 * Green functions with matching units and component ordering.
 */
Physics.invertFiniteFaultSlip = function(greenMatrix, observations, options) {
  options=options||{};
  if(!Array.isArray(greenMatrix)||!greenMatrix.length||!observations||observations.length!==greenMatrix.length)return null;
  var rows=greenMatrix.length,cols=greenMatrix[0]&&greenMatrix[0].length;
  if(!(cols>0)||greenMatrix.some(function(row){return !row||row.length!==cols;}))return null;
  var G=new Array(rows),d=new Float64Array(rows);
  for(var r=0;r<rows;r++){
    G[r]=new Float64Array(cols);d[r]=Number(observations[r]);if(!isFinite(d[r]))return null;
    for(var c=0;c<cols;c++){G[r][c]=Number(greenMatrix[r][c]);if(!isFinite(G[r][c]))return null;}
  }
  var lambda=Math.max(0,Number(options.smoothing)||0),maxIterations=Math.max(1,Math.min(20000,Math.round(options.maxIterations||4000)));
  var tolerance=Math.max(1e-14,Number(options.tolerance)||1e-10),slip=new Float64Array(cols),gradient=new Float64Array(cols);
  var lipschitz=lambda*4;
  for(var r=0;r<rows;r++){var norm=0;for(var c=0;c<cols;c++)norm+=G[r][c]*G[r][c];lipschitz+=norm;}
  var step=1/Math.max(lipschitz,1e-12),targetMoment=Number(options.targetMomentNm),rigidity=Number(options.rigidityGPa)*1e9;
  var areas=options.patchAreaKm2||[],momentConstraint=targetMoment>0&&rigidity>0&&areas.length===cols;
  function enforceMoment(){
    if(!momentConstraint)return;
    var moment=0;for(var i=0;i<cols;i++)moment+=rigidity*Number(areas[i])*1e6*slip[i];
    if(moment>0){var scale=targetMoment/moment;for(var i=0;i<cols;i++)slip[i]*=scale;}
  }
  var converged=false,iteration=0;
  for(iteration=0;iteration<maxIterations;iteration++){
    gradient.fill(0);
    for(var r=0;r<rows;r++){
      var predicted=0;for(var c=0;c<cols;c++)predicted+=G[r][c]*slip[c];
      var residual=predicted-d[r];for(var c=0;c<cols;c++)gradient[c]+=G[r][c]*residual;
    }
    if(lambda>0)for(var c=0;c<cols;c++){
      var center=slip[c],left=c>0?slip[c-1]:center,right=c<cols-1?slip[c+1]:center;
      gradient[c]+=lambda*(2*center-left-right);
    }
    var maxChange=0;
    for(var c=0;c<cols;c++){var next=Math.max(0,slip[c]-step*gradient[c]);maxChange=Math.max(maxChange,Math.abs(next-slip[c]));slip[c]=next;}
    enforceMoment();
    if(maxChange<=tolerance*Math.max(1,Math.max.apply(null,slip))){converged=true;break;}
  }
  var predictedOut=new Array(rows),sumSq=0;
  for(var r=0;r<rows;r++){var value=0;for(var c=0;c<cols;c++)value+=G[r][c]*slip[c];predictedOut[r]=value;sumSq+=(value-d[r])*(value-d[r]);}
  var resolvedMoment=0;if(rigidity>0&&areas.length===cols)for(var c=0;c<cols;c++)resolvedMoment+=rigidity*Number(areas[c])*1e6*slip[c];
  return {slipM:Array.from(slip),predicted:predictedOut,rms:Math.sqrt(sumSq/rows),iterations:iteration+1,
    converged:converged,nonNegative:true,smoothing:lambda,targetMomentNm:momentConstraint?targetMoment:null,
    resolvedMomentNm:resolvedMoment||null,method:'projected-gradient-nnls-cpu-reference',
    applicability:'linear Green functions with matched units; regularization and fault geometry must be independently justified'};
};

// ================================================================
//  SHARED STATION GROUND-MOTION PREDICTION
// ================================================================

/**
 * Build the immutable event-level inputs used by browser and Node validation.
 * All model/config values are explicit so this path is reproducible without UI
 * globals. A caller may provide a pre-built geometry to reuse an edited fault.
 */
Physics.createGroundMotionContext = function(source, options) {
  source = source || {};
  options = options || {};
  var depthKm = Math.max(0, Number(source.depthKm != null ? source.depthKm : source.depth) || 0);
  var mw = Number(source.mw != null ? source.mw : source.mag);
  var sourceType = source.sourceType || Physics.sourceType(depthKm);
  var gmpModel = Physics.resolveGmpModel(options.gmpModel || 'auto', sourceType, mw);
  var geometry = options.geometry || null;
  if (!geometry && options.finiteFault !== false && mw >= 6.5) {
    geometry = Physics.genSubSources(
      Number(source.lat) || 0, Number(source.lng) || 0, mw,
      Number(source.strikeDeg != null ? source.strikeDeg : source.strike) || 0,
      Number(source.dipDeg != null ? source.dipDeg : source.dip) || 90,
      depthKm, Number(options.rupSpeed) || 2.8, options.faultOptions || {}
    );
  }
  return {
    source: {
      lat:Number(source.lat) || 0, lng:Number(source.lng) || 0, mw:mw, depthKm:depthKm,
      strikeDeg:Number(source.strikeDeg != null ? source.strikeDeg : source.strike) || 0,
      dipDeg:Number(source.dipDeg != null ? source.dipDeg : source.dip) || 90,
      sourceType:sourceType
    },
    options: options, geometry: geometry, gmpModel: gmpModel,
    // Reference Vs30 for the reference-site models (si-midorikawa / log).
    // zhao2006/kanno2006 ignore this — their native site classes take the
    // station Vs30 directly inside predictStationMotion.
    gmpeVs30: 760
  };
};

/**
 * Predict median peak motion and empirical JMA intensity at one station.
 * The finite-fault quadrature is identical to the browser simulation: each
 * patch evaluates the whole-event GMPE and is combined with moment-weighted
 * SRSS, which converges to the point-source median at equal patch distance.
 */
// Initial great-circle bearing in radians (0 = north, clockwise) from
// (lat1,lng1) to (lat2,lng2). Planar atan2(dLng, dLat) overestimates the
// east-west component by 1/cos(lat) (up to ~39% at 46°N) and rotates any
// azimuth-dependent term — directivity used to inherit exactly that bias.
Physics.bearingRad = function(lat1, lng1, lat2, lng2) {
  var p1 = Number(lat1) * Math.PI / 180, p2 = Number(lat2) * Math.PI / 180;
  var dl = (Number(lng2) - Number(lng1)) * Math.PI / 180;
  var y = Math.sin(dl) * Math.cos(p2);
  var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
};

// Somerville (1997)-style azimuthal directivity strength. Shared by
// predictStationMotion and the info-page polar chart so the two cannot drift
// apart (the chart used to hard-code the M9 value 0.35).
Physics.somervilleDirectivityCoefficient = function(mw) {
  return 0.15 + Math.max(0, (Number(mw) || 0) - 5) * 0.05;
};

Physics.predictStationMotion = function(context, station, overrides) {
  if (!context || !context.source || !station) return null;
  var source = context.source;
  var base = context.options || {};
  var opts = {};
  var key;
  for (key in base) opts[key] = base[key];
  for (key in (overrides || {})) opts[key] = overrides[key];
  var geometry = context.geometry;
  var model = context.gmpModel;
  var horizontalKm = Physics.haversineDist(source.lat, source.lng, Number(station.lat), Number(station.lng));
  var rhypoKm = Math.sqrt(horizontalKm * horizontalKm + source.depthKm * source.depthKm);
  var attA = opts.attA == null ? 0.42 : Number(opts.attA);
  var attB = opts.attB == null ? 1.34 : Number(opts.attB);
  var attC = opts.attC == null ? 0.31 : Number(opts.attC);
  var anelastic = opts.anelastic == null ? 0.001 : Number(opts.anelastic);
  var vs30 = Number(station.vs30) || 400;
  var cutoffKm = opts.finiteFaultCutoffKm == null ? 400 : Number(opts.finiteFaultCutoffKm);
  var stationFactor = opts.stationFactor == null ? 1 : Number(opts.stationFactor);
  if (!(stationFactor > 0)) stationFactor = 1;

  // Per-model evaluation: distance convention, GMPE median (point source or
  // finite-fault SRSS quadrature) and the site term. Extracted as a closure
  // so the logic-tree mode can aggregate COMPLETE per-branch predictions —
  // site conventions differ between native-Vs30 (zhao/kanno) and
  // reference-rock (si-mid/log) models, so mixing before the site term
  // would double-count site response.
  function evaluateModel(m) {
    var usesRrup = !!geometry && (m === 'si-midorikawa' || m === 'log-ff');
    var distanceKm = usesRrup ? Physics.rrupDistance(station.lat, station.lng, geometry) : rhypoKm;

    // Site-term convention (matches tools/scorecard-strong-motion.js predictStation
    // and the app forecast path _predictPrefectureShindosFor): zhao2006/kanno2006
    // carry native paper Vs30 site classes, so the station Vs30 is fed straight
    // into the GMPE and NO external amplification is applied on top. The
    // reference-site models (si-midorikawa / log) predict on a 760 m/s reference
    // and take the external vs30Amplification factor below.
    var nativeVsModel = (m === 'zhao2006' || m === 'kanno2006');
    var gmpeVs30 = nativeVsModel ? vs30 : (context.gmpeVs30 || 760);

    function pointPga(distance) {
      return Physics.calcPGA(source.mw, distance, m, source.depthKm, null, source.mw,
        source.sourceType, attA, attB, attC, anelastic, gmpeVs30, source.rakeDeg);
    }
    function pointPgv(distance) {
      return Physics.calcPGV(source.mw, distance, m, source.depthKm, null, source.mw,
        source.sourceType, anelastic, gmpeVs30, source.rakeDeg);
    }

    var patches = [];
    var referencePga, referencePgv;
    if (geometry && geometry.subs && geometry.subs.length && distanceKm < cutoffKm) {
      var pgaSquares = 0, pgvSquares = 0;
      for (var i = 0; i < geometry.subs.length; i++) {
        var sub = geometry.subs[i];
        var patchHorizontal = Physics.haversineDist(station.lat, station.lng, sub.lat, sub.lng);
        var patchDistance = Math.sqrt(patchHorizontal * patchHorizontal + sub.depth * sub.depth);
        var weight = Math.sqrt(Math.max(0, Number(sub.momentFraction) || 0));
        var patchPga = pointPga(patchDistance) * weight;
        var patchPgv = pointPgv(patchDistance) * weight;
        pgaSquares += patchPga * patchPga;
        pgvSquares += patchPgv * patchPgv;
        patches.push({source:sub, horizontalKm:patchHorizontal, distanceKm:patchDistance,
          pga:patchPga, pgv:patchPgv});
      }
      referencePga = Math.sqrt(pgaSquares);
      referencePgv = Math.sqrt(pgvSquares);
    } else if (geometry && geometry.subs && geometry.subs.length) {
      // Beyond the cutoff the full patch quadrature is not worth its cost — but
      // a hard switch to the raw point source used to leave a step in the
      // predicted field at exactly cutoffKm. Carry the SRSS/point ratio
      // measured AT the cutoff distance outwards so the surface stays
      // continuous (at great range the ratio tends to 1 anyway).
      var pgaSqFar = 0, pgvSqFar = 0;
      for (var ifr = 0; ifr < geometry.subs.length; ifr++) {
        var subF = geometry.subs[ifr];
        var phF = Physics.haversineDist(station.lat, station.lng, subF.lat, subF.lng);
        var pdF = Math.sqrt(phF * phF + subF.depth * subF.depth);
        var wF = Math.sqrt(Math.max(0, Number(subF.momentFraction) || 0));
        var pF = pointPga(pdF) * wF, vF = pointPgv(pdF) * wF;
        pgaSqFar += pF * pF; pgvSqFar += vF * vF;
      }
      var basePga = pointPga(cutoffKm), basePgv = pointPgv(cutoffKm);
      referencePga = pointPga(distanceKm) * (basePga > 0 ? Math.sqrt(pgaSqFar) / basePga : 1);
      referencePgv = pointPgv(distanceKm) * (basePgv > 0 ? Math.sqrt(pgvSqFar) / basePgv : 1);
    } else {
      referencePga = pointPga(distanceKm);
      referencePgv = pointPgv(distanceKm);
    }

    var siteModel = opts.siteModel || 'vs30';
    var sitePga, sitePgv;
    if (opts.siteAmplificationPga != null) {
      sitePga = Number(opts.siteAmplificationPga);
      sitePgv = opts.siteAmplificationPgv == null ? sitePga : Number(opts.siteAmplificationPgv);
    } else if (nativeVsModel) {
      // Native Vs30 site classes already applied inside the GMPE above — an
      // external factor here would double-count site response.
      sitePga = sitePgv = 1;
    } else if (siteModel === 'eqlin-1d') {
      // R2: 1D equivalent-linear site response (Darendeli curves +
      // Thomson–Haskell iteration) over a synthesized or measured profile —
      // the physical replacement for the SS14 scalar path. Native-Vs30
      // models never reach this branch (site classes live inside the GMPE).
      var prof = opts.siteProfile || station.siteProfile ||
        Physics.synthSiteProfile(vs30, opts.siteBedrockDepthM);
      var eq = prof && Physics.eqlinSiteFactor(prof, referencePga * stationFactor);
      if (eq) { sitePga = eq.pga; sitePgv = eq.pgv; }
      else {
        sitePga = Physics.vs30Amplification(vs30, 'pga');
        sitePgv = Physics.vs30Amplification(vs30, 'pgv');
      }
    } else if (siteModel === 'vs30') {
      if (opts.siteNonlinear === 'ss14') {
        sitePga = Physics.vs30AmplificationNL(vs30, 'pga', referencePga * stationFactor);
        sitePgv = Physics.vs30AmplificationNL(vs30, 'pgv', referencePga * stationFactor);
      } else {
        sitePga = Physics.vs30Amplification(vs30, 'pga');
        sitePgv = Physics.vs30Amplification(vs30, 'pgv');
      }
    } else if (siteModel === 'none') {
      sitePga = sitePgv = opts.siteBase == null ? 1 : Number(opts.siteBase);
    } else {
      sitePga = sitePgv = station.siteFactor != null ? Number(station.siteFactor) : Physics.soilAmp(
        station.lat, station.lng, siteModel, opts.siteBase == null ? 1 : Number(opts.siteBase),
        opts.siteSoftMax == null ? 1.65 : Number(opts.siteSoftMax),
        opts.siteHardMin == null ? 1 : Number(opts.siteHardMin), opts.soilProvinces || Physics.SOIL_PROVINCES);
    }
    return {
      model:m, usesRrup:usesRrup, distanceKm:distanceKm, patches:patches,
      referencePga:referencePga, referencePgv:referencePgv,
      pointPga:pointPga(distanceKm), pointPgv:pointPgv(distanceKm),
      sitePga:sitePga, sitePgv:sitePgv
    };
  }

  var directivityFactor = 1;
  if (opts.directivity === 'somerville1997' && geometry) {
    var ruptureAzimuth = source.strikeDeg * Math.PI / 180;
    var stationAzimuth = Physics.bearingRad(source.lat, source.lng, station.lat, station.lng);
    var cosine = Math.cos(Math.abs(stationAzimuth - ruptureAzimuth));
    var coefficient = Physics.somervilleDirectivityCoefficient(source.mw);
    if (cosine > 0) directivityFactor = 1 + coefficient * cosine;
  }

  var res, pga, pgv, logicTree = null;
  if (model === 'logic-tree') {
    // Weighted geometric mean over complete branch predictions; the
    // between-branch spread (weights included) is the epistemic sigma.
    var branches = Physics.logicTreeBranches(source.sourceType);
    var evals = branches.map(function(b) { return evaluateModel(b.model); });
    var lnPga = 0, lnPgv = 0, wsum = 0;
    for (var bi = 0; bi < branches.length; bi++) {
      var b = branches[bi];
      var tp = evals[bi].referencePga * evals[bi].sitePga;
      var tv = evals[bi].referencePgv * evals[bi].sitePgv;
      lnPga += b.weight * Math.log(tp); lnPgv += b.weight * Math.log(tv);
      wsum += b.weight;
    }
    var meanLnPga = lnPga / wsum, meanLnPgv = lnPgv / wsum;
    var varPga = 0, varPgv = 0;
    var branchRows = [];
    for (var bj = 0; bj < branches.length; bj++) {
      var bjw = branches[bj].weight;
      var bjPga = evals[bj].referencePga * evals[bj].sitePga;
      var bjPgv = evals[bj].referencePgv * evals[bj].sitePgv;
      varPga += bjw * (Math.log(bjPga) - meanLnPga) * (Math.log(bjPga) - meanLnPga);
      varPgv += bjw * (Math.log(bjPgv) - meanLnPgv) * (Math.log(bjPgv) - meanLnPgv);
      branchRows.push({ model: branches[bj].model, weight: +branches[bj].weight.toFixed(4), pga: bjPga, pgv: bjPgv });
    }
    // Heaviest branch supplies the metadata (distance metric, patches).
    var heaviest = 0;
    for (var bk = 1; bk < branches.length; bk++) if (branches[bk].weight > branches[heaviest].weight) heaviest = bk;
    res = evals[heaviest];
    pga = Math.exp(meanLnPga) * stationFactor * directivityFactor;
    pgv = Math.exp(meanLnPgv) * stationFactor;
    logicTree = {
      branches: branchRows,
      sigmaEpistemicPga: Math.sqrt(varPga),
      sigmaEpistemicPgv: Math.sqrt(varPgv)
    };
  } else {
    res = evaluateModel(model);
    pga = res.referencePga * res.sitePga * stationFactor * directivityFactor;
    pgv = res.referencePgv * res.sitePgv * stationFactor;
  }
  var intensity = Physics.calcJmaIntensity(pga, pgv);
  var out = {
    model:model, distanceMetric:res.usesRrup ? 'Rrup' : 'Rhypo', distanceKm:res.distanceKm,
    horizontalKm:horizontalKm, rhypoKm:rhypoKm, referencePga:res.referencePga,
    referencePgv:res.referencePgv, pointPga:res.pointPga, pointPgv:res.pointPgv,
    pga:pga, pgv:pgv, intensity:intensity, shindo:Physics.intensityToShindo(intensity),
    sitePga:res.sitePga, sitePgv:res.sitePgv, stationFactor:stationFactor,
    directivityFactor:directivityFactor, patches:res.patches
  };
  if (logicTree) out.logicTree = logicTree;
  return out;
};

// ================================================================
//  FAULT CORNERS (surface projection)
// ================================================================

Physics.getFaultCorners = function(lat, lng, mag, strikeDeg, dipDeg, depthKm, optW) {
  var opts = (optW && typeof optW === 'object') ? optW : {};
  var geometry = Physics.buildFaultGeometry(lat, lng, mag, strikeDeg, dipDeg, depthKm, opts);
  if (geometry && typeof optW === 'number' && optW > 0) geometry.nominalW = optW;
  return geometry;
};

// ================================================================
//  IRREGULAR FAULT POLYGON
// ================================================================

Physics.buildIrregularFaultPolygon = function(fc, subs) {
  var nS = fc.nStrike, nD = fc.nDip;
  var THRESHOLD = (typeof cfgGet === 'function') ? cfgGet('slipThreshold') : 0.30;
  var slip = [];
  var maxSlip = 0;
  if (subs && subs.length) {
    for (var sk = 0; sk < subs.length; sk++) maxSlip = Math.max(maxSlip, subs[sk].slipWeight || 0);
  }
  for (var i = 0; i < nS; i++) {
    slip[i] = [];
    for (var j = 0; j < nD; j++) {
      var sourceSlip = subs && subs[i * nD + j] ? subs[i * nD + j].slipWeight : 1;
      slip[i][j] = maxSlip > 0 ? sourceSlip / maxSlip : 1;
    }
  }
  var alive = [];
  for (var i = 0; i < nS; i++) {
    alive[i] = [];
    for (var j = 0; j < nD; j++) { alive[i][j] = slip[i][j] >= THRESHOLD; }
  }
  var subPolys = [];
  for (var i = 0; i < nS; i++) {
    for (var j = 0; j < nD; j++) {
      if (!alive[i][j]) continue;
      subPolys.push([
        fc.cellCorner(i, j, 0, 0), fc.cellCorner(i, j, 1, 0),
        fc.cellCorner(i, j, 1, 1), fc.cellCorner(i, j, 0, 1)
      ]);
    }
  }
  var edgeSet = {};
  function edgeKey(p1, p2) {
    var s1 = p1[0].toFixed(6)+','+p1[1].toFixed(6), s2 = p2[0].toFixed(6)+','+p2[1].toFixed(6);
    return s1 < s2 ? s1 + '-' + s2 : s2 + '-' + s1;
  }
  function toggleEdge(p1, p2) {
    var k = edgeKey(p1, p2);
    if (edgeSet[k]) delete edgeSet[k]; else edgeSet[k] = [p1, p2];
  }
  for (var i = 0; i < nS; i++) {
    for (var j = 0; j < nD; j++) {
      if (!alive[i][j]) continue;
      var tl = fc.cellCorner(i, j, 0, 0), tr = fc.cellCorner(i, j, 1, 0);
      var br = fc.cellCorner(i, j, 1, 1), bl = fc.cellCorner(i, j, 0, 1);
      if (j === 0 || !alive[i][j-1]) toggleEdge(tl, tr);
      if (j === nD - 1 || !alive[i][j+1]) toggleEdge(bl, br);
      if (i === 0 || !alive[i-1][j]) toggleEdge(tl, bl);
      if (i === nS - 1 || !alive[i+1][j]) toggleEdge(tr, br);
    }
  }
  var edges = [];
  for (var k in edgeSet) edges.push(edgeSet[k]);
  var contour = null;
  if (edges.length >= 3) {
    var remaining = edges.slice();
    var poly = [remaining[0][0], remaining[0][1]];
    remaining.splice(0, 1);
    var grown = true;
    while (grown && remaining.length > 0) {
      grown = false;
      var last = poly[poly.length - 1];
      for (var ei = 0; ei < remaining.length; ei++) {
        var e = remaining[ei];
        var d0 = Math.abs(e[0][0] - last[0]) + Math.abs(e[0][1] - last[1]);
        var d1 = Math.abs(e[1][0] - last[0]) + Math.abs(e[1][1] - last[1]);
        if (d0 < 0.0001) { poly.push(e[1]); remaining.splice(ei, 1); grown = true; break; }
        if (d1 < 0.0001) { poly.push(e[0]); remaining.splice(ei, 1); grown = true; break; }
      }
    }
    if (poly.length > 6) {
      var simplified = [poly[0]];
      for (var pi = 1; pi < poly.length - 1; pi++) {
        var prev = simplified[simplified.length - 1];
        var curr = poly[pi], next = poly[pi + 1];
        var a1 = Math.atan2(curr[1] - prev[1], curr[0] - prev[0]);
        var a2 = Math.atan2(next[1] - curr[1], next[0] - curr[0]);
        var angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        if (angleDiff > 30 * Math.PI / 180) simplified.push(curr);
      }
      simplified.push(poly[poly.length - 1]);
      contour = simplified;
    } else { contour = poly; }
  }
  if (!contour || contour.length < 4) contour = fc.corners;
  return { contour: contour, subPolys: subPolys, slip: slip, alive: alive };
};

// ================================================================
//  DURATION & TSUNAMI
// ================================================================

Physics.tauShort = function(m, tauShortCoef) { return tauShortCoef + m*2; };
Physics.tauMid   = function(m) { return 8 + m*4; };
Physics.tauLong  = function(m) { return 12 + m*6; };

/**
 * Tsunami wave height: H0=10^(a*effM-b), H=H0*sqrt(10/dist). @param {number} mag @param {number} distKm @param {number} tsuCoefA @param {number} tsuCoefB @returns {number} Height in meters
 */
Physics.calcTsunamiHeight = function(mag, distKm, tsuCoefA, tsuCoefB) {
  if (distKm <= 0.5) distKm = 0.5;
  var effM = mag <= 9 ? mag : 9 + (mag - 9) * 0.3;
  var H0 = Math.pow(10, tsuCoefA * effM - tsuCoefB);
  return H0 * Math.sqrt(10 / distKm);
};

Physics.tsunamiRakeFactor = function(rakeDeg, dipDeg) {
  var rakeRad=(Number(rakeDeg)||0)*Math.PI/180;
  var dipRad=Math.max(0.1,Math.min(90,Number(dipDeg)||90))*Math.PI/180;
  return Math.max(0,Math.abs(Math.sin(rakeRad))*Math.sin(dipRad));
};

Physics.tsunamiVerticalSlip = function(source) {
  if (!source) return 0;
  return source.averageSlipM*Physics.tsunamiDipSlipFactor(source);
};

/**
 * Vertical-slip fraction for tsunami generation. An untouched optional focal
 * mechanism is unknown, not an explicit rake=0 strike-slip solution. In that
 * case use a source-class prior; once the user or a preset supplies rake, the
 * actual mechanism is authoritative and pure strike slip remains exactly zero.
 */
Physics.tsunamiDipSlipFactor = function(source) {
  if(!source)return 0;
  if(source.mechanismKnown===false){
    if(source.sourceType==='interplate')return 0.30;
    if(source.sourceType==='intraslab')return 0.35;
    return 0.50;
  }
  var rakeRad=(Number(source.rakeDeg)||0)*Math.PI/180;
  var dipRad=Math.max(0.1,Math.min(90,Number(source.dipDeg)||90))*Math.PI/180;
  return Math.sin(rakeRad)*Math.sin(dipRad);
};

/** Initial tsunami amplitude proxy derived from finite-fault vertical slip. */
Physics.tsunamiSourceAmplitude = function(source, waterDepthM, coefficient) {
  if (!source) return 0;
  coefficient = coefficient == null ? 0.7 : Math.max(0, Number(coefficient));
  var verticalSlip=Math.abs(Physics.tsunamiVerticalSlip(source));
  var depthCoupling=Math.exp(-Math.max(0,source.depthKm)*1000/Math.max(5000,Number(waterDepthM)||4000)*0.08);
  return Math.max(0,coefficient*verticalSlip*depthCoupling);
};

Physics.tsunamiWaveContribution = function(source, distKm, waterDepthM, tsuCoefA, tsuCoefB) {
  var empirical=Physics.calcTsunamiHeight(source.mw,distKm,tsuCoefA,tsuCoefB);
  var sourceAmp=Physics.tsunamiSourceAmplitude(source,waterDepthM,0.7);
  // A pure strike-slip source has no vertical displacement. Do not let the
  // empirical magnitude term manufacture a tsunami when source coupling is 0.
  if (!(sourceAmp > 1e-4)) return 0;
  var reference=Math.max(0.05,sourceAmp*Math.sqrt(Math.max(1,source.geometry?source.geometry.W:20)/Math.max(10,distKm)));
  return Math.sqrt(empirical*reference);
};

Physics.tsunamiPhase = function(source, receiverLat, receiverLng) {
  var strike=(source.strikeDeg||0)*Math.PI/180;
  var dLat=(receiverLat-source.lat)*Math.PI/180;
  var dLng=(receiverLng-source.lng)*Math.PI/180;
  var bearing=Math.atan2(Math.sin(dLng)*Math.cos(receiverLat*Math.PI/180),
    Math.cos(source.lat*Math.PI/180)*Math.sin(receiverLat*Math.PI/180)-
    Math.sin(source.lat*Math.PI/180)*Math.cos(receiverLat*Math.PI/180)*Math.cos(dLng));
  var directivity=0.35*Math.cos(2*(bearing-strike));
  return directivity >= 0 ? 1 : -1;
};

Physics.tsunamiTravelTime = function(lat1, lng1, lat2, lng2, depthLookup, fallbackSpeedKmh, segments) {
  var count = Math.max(1, Math.round(segments || 20));
  var totalDist = Physics.haversineDist(lat1, lng1, lat2, lng2);
  if (!(totalDist > 0)) return 0;
  var segmentDist = totalDist / count, seconds = 0;
  for (var i = 0; i < count; i++) {
    var f = (i + 0.5) / count;
    var lat = lat1 + (lat2 - lat1) * f, lng = lng1 + (lng2 - lng1) * f;
    var depth = typeof depthLookup === 'function' ? depthLookup(lat, lng) : null;
    var speed = depth && depth > 0 ? Math.sqrt(9.80665 * Math.max(depth, 5)) * 3.6 : fallbackSpeedKmh;
    if (!(speed > 0)) return Infinity;
    seconds += segmentDist / speed * 3600;
  }
  return seconds;
};

/**
 * Bathymetry-grid eikonal approximation. Dijkstra propagation with local
 * shallow-water speed allows refraction and routes around land barriers.
 */
Physics.buildTsunamiTravelTimeField = function(grid, sourceLat, sourceLng, fallbackSpeedKmh) {
  if (!grid || !grid.data || !grid.nx || !grid.ny || !grid.origin || !(grid.res > 0)) return null;
  var nx=grid.nx,ny=grid.ny,n=nx*ny,dist=new Float64Array(n),pathLength=new Float64Array(n),seen=new Uint8Array(n);
  for(var di=0;di<n;di++){dist[di]=Infinity;pathLength[di]=Infinity;}
  function wet(idx){return grid.data[idx]<0;}
  var sx=Math.round((sourceLng-grid.origin[0])/grid.res),sy=Math.round((sourceLat-grid.origin[1])/grid.res);
  sx=Math.max(0,Math.min(nx-1,sx));sy=Math.max(0,Math.min(ny-1,sy));
  if(!wet(sy*nx+sx)){
    var found=false;
    for(var rad=1;rad<=8&&!found;rad++)for(var yy=Math.max(0,sy-rad);yy<=Math.min(ny-1,sy+rad)&&!found;yy++)
      for(var xx=Math.max(0,sx-rad);xx<=Math.min(nx-1,sx+rad);xx++)if(wet(yy*nx+xx)){sx=xx;sy=yy;found=true;break;}
    if(!found)return null;
  }
  var heapI=[],heapD=[];
  function push(idx,d){var i=heapI.length;heapI.push(idx);heapD.push(d);while(i>0){var p=(i-1)>>1;if(heapD[p]<=d)break;heapI[i]=heapI[p];heapD[i]=heapD[p];i=p;}heapI[i]=idx;heapD[i]=d;}
  function pop(){var idx=heapI[0],d=heapD[0],li=heapI.pop(),ld=heapD.pop();if(heapI.length){var i=0;while(true){var a=i*2+1,b=a+1;if(a>=heapI.length)break;var c=b<heapI.length&&heapD[b]<heapD[a]?b:a;if(heapD[c]>=ld)break;heapI[i]=heapI[c];heapD[i]=heapD[c];i=c;}heapI[i]=li;heapD[i]=ld;}return[idx,d];}
  var start=sy*nx+sx;dist[start]=0;pathLength[start]=0;push(start,0);
  var dirs=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  while(heapI.length){
    var item=pop(),idx=item[0],base=item[1];if(seen[idx])continue;seen[idx]=1;
    var y=Math.floor(idx/nx),x=idx-y*nx,lat=grid.origin[1]+y*grid.res;
    for(var q=0;q<dirs.length;q++){
      var xx=x+dirs[q][0],yy=y+dirs[q][1];if(xx<0||xx>=nx||yy<0||yy>=ny)continue;
      var ni=yy*nx+xx;if(!wet(ni)||seen[ni])continue;
      var h1=Math.max(5,-grid.data[idx]),h2=Math.max(5,-grid.data[ni]);
      var speed=(Math.sqrt(9.80665*h1)+Math.sqrt(9.80665*h2))*0.5;
      if(!(speed>0))speed=(fallbackSpeedKmh||600)/3.6;
      var dyKm=grid.res*111.32,dxKm=grid.res*111.32*Math.max(0.1,Math.cos(lat*Math.PI/180));
      var stepM=Math.sqrt((dirs[q][0]*dxKm*1000)**2+(dirs[q][1]*dyKm*1000)**2);
      var nd=base+stepM/speed;if(nd<dist[ni]){dist[ni]=nd;pathLength[ni]=pathLength[idx]+stepM/1000;push(ni,nd);}
    }
  }
  function cellIndex(lat,lng){
    var x=Math.round((lng-grid.origin[0])/grid.res),y=Math.round((lat-grid.origin[1])/grid.res);
    return x<0||x>=nx||y<0||y>=ny?-1:y*nx+x;
  }
  return {grid:grid,times:dist,pathLengths:pathLength,sourceCell:[sx,sy],lookup:function(lat,lng){
    var idx=cellIndex(lat,lng);return idx<0?Infinity:dist[idx];
  },lookupMeta:function(lat,lng){
    var idx=cellIndex(lat,lng),direct=Physics.haversineDist(sourceLat,sourceLng,lat,lng);
    if(idx<0||!isFinite(dist[idx]))return{travelTime:Infinity,pathDistance:Infinity,directDistance:direct,detourRatio:Infinity};
    // Suppress the path/direct ratio only inside the two-cell discretization
    // floor; `direct` is km, so the threshold must be converted from degrees.
    var path=pathLength[idx],ratio=direct>grid.res*111.32*2?path/direct:1;
    return{travelTime:dist[idx],pathDistance:path,directDistance:direct,detourRatio:Math.max(1,ratio)};
  }};
};

/** Geometric spreading penalty for waves forced around land barriers. */
Physics.tsunamiPathAttenuation = function(detourRatio, directPathBlocked) {
  if(!isFinite(detourRatio))return 0;
  var excess=Math.max(0,detourRatio-1.05);
  var factor=Math.exp(-4*excess);
  if(directPathBlocked)factor*=Math.max(0.08,0.6*Math.exp(-3*Math.max(0,detourRatio-1.1)));
  return Math.max(0,Math.min(1,factor));
};

// JMA's operational system forecasts named coastal areas from a precomputed
// source-scenario database.  This project does not ship that database, but it
// must still distinguish the major water bodies before applying a continuous
// propagation model.  Otherwise a tiny numerical wave which has travelled
// through a strait can be conservatively rounded into a warning for the whole
// coast on the opposite side of Japan.
var _JMA_TSU_BASINS = (function() {
  var table = Object.create(null);
  function add(basin, codes) {
    for (var i=0;i<codes.length;i++) table[String(codes[i]).padStart(3,'0')]=basin;
  }
  add('pacific', [100,101,102,201,210,220,250,300,310,311,320,321,330,380,390,400,
    530,580,600,610,751,760,770,771,772,800,801,802]);
  add('japanSea', [110,111,200,230,240,340,341,350,360,361,370,500,520,540,550,551,
    700,711]);
  add('eastChina', [720,730,731,740,773]);
  add('okhotsk', [120]);
  add('inner', [202,312,391,510,521,522,560,570,590,601,701,710,712,750]);
  return table;
}());

Physics.jmaTsunamiAreaBasin = function(areaCode) {
  return _JMA_TSU_BASINS[String(areaCode == null ? '' : areaCode).padStart(3,'0')] || 'unknown';
};

/**
 * First-order source-area gate used before regional warning classification.
 * It represents basin connectivity, not physical dissipation: the numerical
 * solver may continue to visualise weak waves around capes and through straits.
 */
Physics.jmaTsunamiBasinTransmission = function(sourceAreaCode, targetAreaCode, distanceKm) {
  var sourceCode=String(sourceAreaCode == null ? '' : sourceAreaCode).padStart(3,'0');
  var targetCode=String(targetAreaCode == null ? '' : targetAreaCode).padStart(3,'0');
  var source=Physics.jmaTsunamiAreaBasin(sourceAreaCode);
  var target=Physics.jmaTsunamiAreaBasin(targetAreaCode);
  var distance=Math.max(0,Number(distanceKm)||0);
  if(source==='unknown'||target==='unknown')return 1;
  if(source===target){
    // Mutsu, Tokyo, Ise/Mikawa and Seto waters are not one connected warning
    // basin simply because they share the "inner" label.
    if(source==='inner'&&sourceCode!==targetCode)return 0.02;
    return 1;
  }

  // Pacific/Japan-Sea cross-archipelago leakage is normally below the regional
  // warning decision envelope.  Preserve a larger gateway term near northern
  // Hokkaido/Aomori where waves can genuinely turn through the straits.
  if((source==='pacific'&&target==='japanSea')||(source==='japanSea'&&target==='pacific')){
    var gateway=(targetCode==='110'||targetCode==='111'||targetCode==='200'||targetCode==='201');
    return gateway&&distance<500?0.08:0.012;
  }
  if((source==='pacific'&&target==='okhotsk')||(source==='okhotsk'&&target==='pacific'))
    return distance<700?0.16:0.05;
  if((source==='japanSea'&&target==='okhotsk')||(source==='okhotsk'&&target==='japanSea'))
    return distance<700?0.22:0.07;

  // The East China Sea is openly connected around Kyushu and the Ryukyu arc;
  // treating it as the Japan Sea would create southern-Japan false negatives.
  if((source==='eastChina'&&target==='pacific')||(source==='pacific'&&target==='eastChina'))
    return distance<600?0.35:0.15;
  if((source==='eastChina'&&target==='japanSea')||(source==='japanSea'&&target==='eastChina'))
    return distance<600?0.55:0.25;
  if((source==='eastChina'&&target==='okhotsk')||(source==='okhotsk'&&target==='eastChina'))
    return 0.04;

  // Enclosed bays and the Seto Inland Sea require entrance-specific modelling.
  // Until a high-resolution nested grid exists, keep their regional warning
  // envelope conservative but do not equate them with an open-ocean coast.
  if(target==='inner'){
    if(source==='pacific'&&distance<300&&(targetCode==='202'||targetCode==='312'||targetCode==='391'))
      return targetCode==='312'?0.25:0.20;
    return source==='eastChina'?0.10:0.035;
  }
  if(source==='inner')return 0.10;
  return 0.05;
};

/** Solver peak height is authoritative when a numerical propagation model exists. */
Physics.tsunamiModeledHeight = function(solver, lat, lng) {
  if(!solver)return null;
  var value=typeof solver.samplePeak==='function'?solver.samplePeak(lat,lng):
    (typeof solver.sample==='function'?Math.abs(solver.sample(lat,lng)):0);
  return isFinite(value)?Math.max(0,Math.abs(value)):0;
};

/**
 * Convert the resolved offshore grid amplitude to a coastal forecast height.
 * Regional grids usually end hundreds of metres deep, so their raw eta omits
 * the final Green-law shoaling toward the nominal 10 m nearshore contour.
 */
Physics.tsunamiCoastalHeight = function(solver, lat, lng, targetDepthM, cap) {
  var offshoreHeight=Physics.tsunamiModeledHeight(solver,lat,lng);
  if(!(offshoreHeight>0))return 0;
  var offshoreDepth=typeof solver.sampleWaterDepth==='function'?solver.sampleWaterDepth(lat,lng):null;
  var target=Math.max(5,Number(targetDepthM)||10);
  return offshoreHeight*Physics.greenLawAmplification(offshoreDepth,target,cap||5);
};

/**
 * Resolve a coastline coordinate to the genuinely nearest wet raster cell.
 * The previous row-major search could select a farther cell on the opposite
 * side of a narrow island. The deliberately small default radius also avoids
 * jumping tens of kilometres across land on the bundled regional grid.
 */
Physics.findNearestWetCell = function(grid, lat, lng, maxRadius) {
  if(!grid||!grid.data||!grid.nx||!grid.ny||!grid.origin||!(grid.res>0))return null;
  var cx=Math.round((lng-grid.origin[0])/grid.res),cy=Math.round((lat-grid.origin[1])/grid.res);
  if(cx<0||cx>=grid.nx||cy<0||cy>=grid.ny)return null;
  maxRadius=Math.max(0,Math.min(12,Math.round(maxRadius==null?2:maxRadius)));
  var cosLat=Math.max(0.1,Math.cos(lat*Math.PI/180)),best=null;
  for(var radius=0;radius<=maxRadius;radius++){
    for(var y=Math.max(0,cy-radius);y<=Math.min(grid.ny-1,cy+radius);y++){
      for(var x=Math.max(0,cx-radius);x<=Math.min(grid.nx-1,cx+radius);x++){
        if(Math.max(Math.abs(x-cx),Math.abs(y-cy))!==radius)continue;
        var index=y*grid.nx+x,value=Number(grid.data[index]);
        if(!(value<0))continue;
        var cellLat=grid.origin[1]+y*grid.res,cellLng=grid.origin[0]+x*grid.res;
        var dx=(cellLng-lng)*cosLat,dy=cellLat-lat,d2=dx*dx+dy*dy;
        if(!best||d2<best.distanceSq){best={index:index,x:x,y:y,lat:cellLat,lng:cellLng,
          depth:Math.max(0,-value),distanceSq:d2,distanceCells:Math.sqrt(d2)/grid.res};}
      }
    }
    // A wet cell in the current ring is necessarily nearer than cells two or
    // more rings away; continue one ring only to handle diagonal geometry.
    if(best&&radius>=Math.ceil(best.distanceCells))break;
  }
  return best;
};

/** Validate the common terrain/Vs30 raster schema and expose data provenance. */
Physics.validateResearchGrid = function(grid, kind) {
  var errors=[];
  if(!grid||!Array.isArray(grid.origin)||grid.origin.length!==2||grid.origin.some(function(v){return typeof v!=='number'||!isFinite(v);}))errors.push('origin');
  if(!grid||typeof grid.res!=='number'||!isFinite(grid.res)||!(grid.res>0)||!Number.isInteger(grid.nx)||!Number.isInteger(grid.ny)||!(grid.nx>1)||!(grid.ny>1))errors.push('geometry');
  if(!grid||!grid.data||grid.data.length!==grid.nx*grid.ny)errors.push('data-length');
  var valid=0,land=0,water=0;
  if(grid&&grid.data)for(var i=0;i<grid.data.length;i++){
    var value=grid.data[i];if(typeof value!=='number'||!isFinite(value))continue;valid++;
    if(kind==='terrain'){if(value>=0)land++;else water++;}
  }
  if(!valid)errors.push('no-valid-cells');
  if(grid&&grid.data&&valid!==grid.data.length)errors.push('non-finite-cells');
  if(kind==='terrain'&&(!land||!water))errors.push('land-water-mask');
  return {valid:errors.length===0,errors:errors,validCells:valid,landCells:land,waterCells:water,
    meta:grid&&grid.meta?grid.meta:{quality:'unknown',dataset:'Unlabelled grid'}};
};

/** Bilinear lookup on the common research-grid schema. */
Physics.lookupResearchGrid = function(grid, lat, lng) {
  if(!grid||!grid.data)return null;
  var col=(lng-grid.origin[0])/grid.res,row=(lat-grid.origin[1])/grid.res;
  var x=Math.floor(col),y=Math.floor(row);
  if(x<0||x>=grid.nx-1||y<0||y>=grid.ny-1)return null;
  var fx=col-x,fy=row-y,idx=y*grid.nx+x;
  var values=[grid.data[idx],grid.data[idx+1],grid.data[idx+grid.nx],grid.data[idx+grid.nx+1]];
  if(values.some(function(v){return v==null||!isFinite(v);}))return null;
  var a=values[0]+(values[1]-values[0])*fx,b=values[2]+(values[3]-values[2])*fx;
  return a+(b-a)*fy;
};

/**
 * Finite rectangular-dislocation seafloor deformation.
 *
 * The fault is integrated as moment-weighted rectangular patches in an elastic
 * half-space. The compact surface kernel follows the static Okada displacement
 * symmetries (dip-slip uplift/subsidence, zero far-field volume and strike-slip
 * suppression) while remaining stable on coarse browser grids. It is intended
 * for scenario screening; analytical DC3D remains the benchmark for publication.
 */
Physics.buildLegacyOkadaDeformation = function(grid, source, options) {
  if(!grid||!source||!grid.data)return null;
  options=options||{};
  var nx=grid.nx,ny=grid.ny,n=nx*ny,out=new Float32Array(n);
  var geom=source.geometry;
  var dipSlipFactor=Physics.tsunamiDipSlipFactor(source);
  if(Math.abs(dipSlipFactor)<1e-6)return {data:out,maxUplift:0,maxSubsidence:0,volumeResidual:0,method:'okada-patch'};
  var patches=[];
  if(geom&&geom.subs&&geom.subs.length){
    for(var si=0;si<geom.subs.length;si++)patches.push(geom.subs[si]);
  }else if(geom){
    for(var py=0;py<geom.nDip;py++)for(var px=0;px<geom.nStrike;px++){
      var pp=geom.cellPoint(px,py,0.5,0.5);patches.push({lat:pp.lat,lng:pp.lng,depth:pp.depth,
        momentFraction:1/(geom.nDip*geom.nStrike),slipWeight:1});
    }
  }else patches.push({lat:source.lat,lng:source.lng,depth:source.depthKm,momentFraction:1,slipWeight:1});
  var strike=source.strikeDeg*Math.PI/180;
  var L=geom?geom.L:30,W=geom?geom.W:15;
  var patchL=Math.max(grid.res*80,L/Math.max(1,geom?geom.nStrike:1));
  var patchW=Math.max(grid.res*80,W/Math.max(1,geom?geom.nDip:1));
  var verticalSlip=source.averageSlipM*dipSlipFactor;
  var poisson=options.poissonRatio==null?0.25:Math.max(0,Math.min(0.49,options.poissonRatio));
  var elasticScale=(1-poisson)*0.92;
  var active=[];
  for(var p=0;p<patches.length;p++){
    var patch=patches[p];
    // Each patch kernel is already spatially integrated at its physical size.
    // Slip must therefore enter exactly once; multiplying by momentFraction a
    // second time squares heterogeneous slip and exaggerates asperities.
    var patchSlip=Number(patch.slipM);
    if (!(patchSlip>=0)) patchSlip=source.averageSlipM*(patch.slipWeight||1);
    var slip=patchSlip*dipSlipFactor;
    var sigmaS=Math.max(patchL*0.55,(patch.depth||source.depthKm)*0.35,2);
    var sigmaD=Math.max(patchW*0.55,(patch.depth||source.depthKm)*0.28,2);
    active.push({lat:patch.lat,lng:patch.lng,slip:slip,ss:sigmaS,sd:sigmaD});
  }
  var sum=0,count=0,maxUp=0,minDown=0;
  for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
    var idx=y*nx+x;if(grid.data[idx]>=0)continue;
    var lat=grid.origin[1]+y*grid.res,lng=grid.origin[0]+x*grid.res,value=0;
    for(var p=0;p<active.length;p++){
      var a=active[p];
      var north=(lat-a.lat)*111.32,east=(lng-a.lng)*111.32*Math.cos(a.lat*Math.PI/180);
      var along=north*Math.cos(strike)+east*Math.sin(strike);
      var across=-north*Math.sin(strike)+east*Math.cos(strike);
      var rs=along/a.ss,rd=across/a.sd;
      // Odd down-dip component gives the characteristic uplift/subsidence pair;
      // a compact even term retains near-fault vertical motion.
      var kernel=Math.exp(-0.5*(rs*rs+rd*rd))*(0.72-0.58*rd);
      value+=elasticScale*a.slip*kernel;
    }
    out[idx]=value;sum+=value;count++;maxUp=Math.max(maxUp,value);minDown=Math.min(minDown,value);
  }
  // A static dislocation does not add water volume. Remove coarse-grid residual
  // near the source instead of applying a spurious uniform sea-level offset to
  // every ocean cell in the regional domain.
  var correctionSigma=Math.max(20,Math.min(100,0.5*Math.sqrt(L*W))),weightSum=0;
  for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
    var idx=y*nx+x;if(grid.data[idx]>=0)continue;
    var lat=grid.origin[1]+y*grid.res,lng=grid.origin[0]+x*grid.res;
    var north=(lat-source.lat)*111.32,east=(lng-source.lng)*111.32*Math.cos(source.lat*Math.PI/180);
    weightSum+=Math.exp(-0.5*(north*north+east*east)/(correctionSigma*correctionSigma));
  }
  var residual=0;maxUp=0;minDown=0;
  for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
    var idx=y*nx+x;if(grid.data[idx]>=0)continue;
    var lat=grid.origin[1]+y*grid.res,lng=grid.origin[0]+x*grid.res;
    var north=(lat-source.lat)*111.32,east=(lng-source.lng)*111.32*Math.cos(source.lat*Math.PI/180);
    var weight=Math.exp(-0.5*(north*north+east*east)/(correctionSigma*correctionSigma));
    out[idx]-=weightSum>0?sum*weight/weightSum:0;
    residual+=out[idx];maxUp=Math.max(maxUp,out[idx]);minDown=Math.min(minDown,out[idx]);
  }
  return {data:out,maxUplift:maxUp,maxSubsidence:minDown,volumeResidual:residual,
    method:'okada-patch-linear-slip',poissonRatio:poisson,patches:active.length,
    slipWeighting:'linear'};
};

function _dc3dPatchSize(patch, geometry, grid) {
  function distance3d(a,b) {
    var lat=(Number(a.lat)+Number(b.lat))*Math.PI/360;
    var north=(Number(b.lat)-Number(a.lat))*111.32;
    var east=(Number(b.lng)-Number(a.lng))*111.32*Math.max(0.1,Math.cos(lat));
    var depth=Number(b.depthKm!=null?b.depthKm:b.depth)-Number(a.depthKm!=null?a.depthKm:a.depth);
    return Math.sqrt(north*north+east*east+depth*depth);
  }
  if(patch.corners&&patch.corners.length>=4) return {
    lengthKm:Math.max(0.01,0.5*(distance3d(patch.corners[0],patch.corners[1])+distance3d(patch.corners[3],patch.corners[2]))),
    widthKm:Math.max(0.01,0.5*(distance3d(patch.corners[0],patch.corners[3])+distance3d(patch.corners[1],patch.corners[2])))
  };
  // Whole-fault fallback patches (no sub-source decomposition) span the full
  // scaling-relation geometry; dividing by nStrike/nDip here would shrink the
  // source to a single sub-patch and under-predict the deformation by orders
  // of magnitude.
  if(patch.wholeFault){
    var fullArea=Math.max(0.01,Number(patch.areaKm2)||0),fullL=Number(geometry&&geometry.L)||Math.sqrt(fullArea);
    return {lengthKm:Math.max(0.01,fullL),widthKm:Math.max(0.01,Number(geometry&&geometry.W)||fullArea/fullL)};
  }
  var ns=Math.max(1,Number(geometry&&geometry.nStrike)||1),nd=Math.max(1,Number(geometry&&geometry.nDip)||1);
  var area=Number(patch.areaKm2);
  var length=Math.max(grid.res*20,Number(geometry&&geometry.L)/ns||0);
  var width=Math.max(grid.res*20,Number(geometry&&geometry.W)/nd||0);
  if(area>0&&!(length>0&&width>0)){length=Math.sqrt(area);width=area/length;}
  return {lengthKm:Math.max(0.01,length||1),widthKm:Math.max(0.01,width||1)};
}

/**
 * Analytical Okada DC3D seafloor displacement. The legacy compact kernel is
 * available only through options.deformationModel='legacy'. Horizontal
 * displacement is converted to a fixed-grid vertical change as
 * dzEffective = uz - ue*dz/de - un*dz/dn (Tanioka & Satake, 1996 convention).
 */
Physics.buildOkadaDeformation = function(grid, source, options) {
  options=options||{};
  if(options.deformationModel==='legacy')return Physics.buildLegacyOkadaDeformation(grid,source,options);
  if(!grid||!source||!grid.data||!DC3D||typeof DC3D.surfaceDisplacement!=='function')return null;
  var nx=grid.nx,ny=grid.ny,n=nx*ny;
  var vertical=new Float64Array(n),eastward=new Float64Array(n),northward=new Float64Array(n);
  var out=new Float32Array(n),slopeContribution=new Float32Array(n);
  var geom=source.geometry,patches=[];
  if(geom&&geom.subs&&geom.subs.length)patches=geom.subs.slice();
  else patches=[(function(){
    // Centre the whole-fault patch on the fault centroid: the hypocenter sits
    // at the configured down-dip fraction, not at the geometric centre.
    var center=geom&&typeof geom.point==='function'&&isFinite(Number(geom.topOffset))&&isFinite(Number(geom.bottomOffset))?
      geom.point(0,(Number(geom.topOffset)+Number(geom.bottomOffset))/2):null;
    return {lat:center?center.lat:source.lat,lng:center?center.lng:source.lng,
      depth:center?center.depth:source.depthKm,slipM:source.averageSlipM||0,
      strikeDeg:source.strikeDeg,dipDeg:source.dipDeg,rakeDeg:source.rakeDeg,
      areaKm2:geom?geom.L*geom.W:450,wholeFault:true};
  })()];
  var poisson=options.poissonRatio==null?0.25:Math.max(0,Math.min(0.49,Number(options.poissonRatio)));
  var alpha=DC3D.alphaFromPoisson(poisson),singularCount=0,active=0,prepared=[];
  var totalArea=0,totalStrikePotency=0,totalDipPotency=0,centroidWeight=0,centroidLat=0,centroidLng=0,centroidDepth=0;
  for(var p=0;p<patches.length;p++){
    var patch=patches[p],slip=Number(patch.slipM);
    if(!(slip>=0))slip=(Number(source.averageSlipM)||0)*(Number(patch.slipWeight)||1);
    if(!(slip>0))continue;
    active++;
    var strike=Number(patch.strikeDeg);if(!isFinite(strike))strike=Number(source.strikeDeg)||0;
    var dip=Number(patch.dipDeg);if(!isFinite(dip))dip=Number(source.dipDeg)||90;
    var rake=Number(patch.rakeDeg);if(!isFinite(rake))rake=Number(source.rakeDeg)||0;
    var strikeRad=strike*Math.PI/180,rakeRad=rake*Math.PI/180;
    var size=_dc3dPatchSize(patch,geom,grid),halfL=size.lengthKm/2,halfW=size.widthKm/2;
    var patchLat=Number(patch.lat),patchLng=Number(patch.lng),patchDepth=Number(patch.depthKm!=null?patch.depthKm:patch.depth);
    if(!isFinite(patchLat))patchLat=Number(source.lat)||0;if(!isFinite(patchLng))patchLng=Number(source.lng)||0;
    if(!(patchDepth>0))patchDepth=Math.max(0.01,Number(source.depthKm)||1);
    var strikeSlip=slip*Math.cos(rakeRad),dipSlip=slip*Math.sin(rakeRad);
    var patchArea=size.lengthKm*size.widthKm,potencyWeight=patchArea*Math.abs(slip);
    totalArea+=patchArea;totalStrikePotency+=patchArea*strikeSlip;totalDipPotency+=patchArea*dipSlip;
    centroidWeight+=potencyWeight;centroidLat+=patchLat*potencyWeight;centroidLng+=patchLng*potencyWeight;centroidDepth+=patchDepth*potencyWeight;
    prepared.push({lat:patchLat,lng:patchLng,depth:patchDepth,dip:dip,strikeRad:strikeRad,
      halfL:halfL,halfW:halfW,strikeSlip:strikeSlip,dipSlip:dipSlip});
  }
  var equivalent=null,farFieldCells=0;
  if(prepared.length>1){
    var equivalentL=Math.max(0.01,Number(geom&&geom.L)||Math.sqrt(totalArea));
    var equivalentW=Math.max(0.01,Number(geom&&geom.W)||totalArea/equivalentL);
    var equivalentArea=equivalentL*equivalentW,sourceStrike=(Number(source.strikeDeg)||0)*Math.PI/180;
    equivalent={lat:centroidWeight?centroidLat/centroidWeight:Number(source.lat)||0,
      lng:centroidWeight?centroidLng/centroidWeight:Number(source.lng)||0,
      depth:centroidWeight?centroidDepth/centroidWeight:Math.max(0.01,Number(source.depthKm)||1),
      dip:Number(source.dipDeg)||90,strikeRad:sourceStrike,halfL:equivalentL/2,halfW:equivalentW/2,
      strikeSlip:totalStrikePotency/equivalentArea,dipSlip:totalDipPotency/equivalentArea};
  }
  var nearFieldKm=Math.max(150,Number(options.dc3dNearFieldKm)||0.75*Math.max(Number(geom&&geom.L)||0,Number(geom&&geom.W)||0,80));
  var allowFarAggregation=options.dc3dFarFieldAggregation!==false;
  function accumulate(item,idx,lat,lng){
    var north=(lat-item.lat)*111.32,east=(lng-item.lng)*111.32*Math.cos(item.lat*Math.PI/180);
    var along=north*Math.cos(item.strikeRad)+east*Math.sin(item.strikeRad);
    var across=-north*Math.sin(item.strikeRad)+east*Math.cos(item.strikeRad);
    var displacement=DC3D.surfaceDisplacement({alpha:alpha,x:along,y:-across,depth:item.depth,dip:item.dip,
      al1:-item.halfL,al2:item.halfL,aw1:-item.halfW,aw2:item.halfW,strikeSlip:item.strikeSlip,dipSlip:item.dipSlip,tensile:0});
    if(displacement.success){singularCount++;return;}
    vertical[idx]+=displacement.uz;
    eastward[idx]+=displacement.ux*Math.sin(item.strikeRad)-displacement.uy*Math.cos(item.strikeRad);
    northward[idx]+=displacement.ux*Math.cos(item.strikeRad)+displacement.uy*Math.sin(item.strikeRad);
  }
  for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
    var idx=y*nx+x;if(Number(grid.data[idx])>=0)continue;
    var lat=grid.origin[1]+y*grid.res,lng=grid.origin[0]+x*grid.res;
    var sourceNorth=(lat-(Number(source.lat)||0))*111.32;
    var sourceEast=(lng-(Number(source.lng)||0))*111.32*Math.cos((Number(source.lat)||0)*Math.PI/180);
    if(equivalent&&allowFarAggregation&&Math.sqrt(sourceNorth*sourceNorth+sourceEast*sourceEast)>nearFieldKm){
      accumulate(equivalent,idx,lat,lng);farFieldCells++;
    }else for(var preparedIndex=0;preparedIndex<prepared.length;preparedIndex++)accumulate(prepared[preparedIndex],idx,lat,lng);
  }
  var horizontalEnabled=options.horizontalSlopeCoupling!==false,maxSlope=Math.max(0.05,Number(options.maxHorizontalSlope)||2);
  var maxUp=0,minDown=0,maxHorizontal=0,maxSlopeTerm=0,residual=0,residualM3=0,slopeClamped=0;
  var dyM=grid.res*111320;
  for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
    var idx=y*nx+x;if(Number(grid.data[idx])>=0)continue;
    var dxM=grid.res*111320*Math.max(0.1,Math.cos((grid.origin[1]+y*grid.res)*Math.PI/180));
    var xl=Math.max(0,x-1),xr=Math.min(nx-1,x+1),yd=Math.max(0,y-1),yu=Math.min(ny-1,y+1);
    var dzde=(Number(grid.data[y*nx+xr])-Number(grid.data[y*nx+xl]))/Math.max(dxM*(xr-xl),1);
    var dzdn=(Number(grid.data[yu*nx+x])-Number(grid.data[yd*nx+x]))/Math.max(dyM*(yu-yd),1);
    var slope=Math.sqrt(dzde*dzde+dzdn*dzdn);
    if(slope>maxSlope){var scale=maxSlope/slope;dzde*=scale;dzdn*=scale;slopeClamped++;}
    var correction=horizontalEnabled?-(eastward[idx]*dzde+northward[idx]*dzdn):0;
    var value=vertical[idx]+correction;
    if(!isFinite(value))value=0;
    out[idx]=value;slopeContribution[idx]=correction;
    maxUp=Math.max(maxUp,value);minDown=Math.min(minDown,value);maxSlopeTerm=Math.max(maxSlopeTerm,Math.abs(correction));
    maxHorizontal=Math.max(maxHorizontal,Math.sqrt(eastward[idx]*eastward[idx]+northward[idx]*northward[idx]));
    residual+=value;residualM3+=value*dxM*dyM;
  }
  return {data:out,verticalData:new Float32Array(vertical),horizontalSlopeData:slopeContribution,
    maxUplift:maxUp,maxSubsidence:minDown,volumeResidual:residual,volumeResidualM3:residualM3,
    method:'okada-dc3d-1992-surface',poissonRatio:poisson,patches:active,slipWeighting:'linear',
    farFieldModel:farFieldCells?'moment-conserving-equivalent-rectangle':'full-patch-sum',nearFieldRadiusKm:nearFieldKm,
    farFieldAggregatedCells:farFieldCells,
    horizontalSlopeCoupling:horizontalEnabled,maxHorizontalDisplacement:maxHorizontal,
    maxHorizontalSlopeContribution:maxSlopeTerm,slopeClampedCells:slopeClamped,singularEvaluations:singularCount,
    applicability:'elastic homogeneous half-space; rectangular shear dislocations; no landslide or dispersive source'};
};

/** Conservative 2-D nonlinear SWE solver with wetting/drying and Manning drag.
 *  Spatial reconstruction is second-order MUSCL (minmod-limited) on top of the
 *  hydrostatic-reconstruction Rusanov flux; a plain first-order flux is so
 *  diffusive on the bundled 0.15° terrain grid that metre-scale tsunami
 *  dissipate within minutes and never produce coastal inundation. */
Physics.createNonlinearTsunamiSolver = function(grid, source, options) {
  options=options||{};
  if(!Physics.validateResearchGrid(grid,'terrain').valid||(!source&&typeof options.initialState!=='function'))return null;
  var nx=grid.nx,ny=grid.ny,n=nx*ny,g=9.80665;
  var dry=options.dryTolerance==null?0.05:Math.max(0.001,Number(options.dryTolerance));
  // Depth above which faces use second-order MUSCL reconstruction; shallow
  // cells and the wet-dry front stay on the first-order flux.
  var musclGate=options.secondOrderDepthGate==null?20:Math.max(dry,Number(options.secondOrderDepthGate));
  var arrivalThreshold=options.arrivalThreshold==null?Math.max(0.01,dry*0.5):Math.max(0.001,Number(options.arrivalThreshold));
  var coriolisEnabled=options.coriolis!==false,omega=7.292115e-5;
  var z=new Float32Array(n),h=new Float32Array(n),hu=new Float32Array(n),hv=new Float32Array(n);
  var hn=new Float32Array(n),hun=new Float32Array(n),hvn=new Float32Array(n);
  var maxEta=new Float32Array(n),maxAbsEta=new Float32Array(n),maxDepth=new Float32Array(n),maxSpeed=new Float32Array(n);
  // Hydrodynamic-load tracking: maxLoad = max over time of the instantaneous
  // depth×speed product (= |momentum| hu,hv magnitude, m²/s — the JMA
  // 津波浸水想定 danger criterion), maxFroude = max |u|/sqrt(gh). These must
  // be tracked per step: the product of the independent maxima of depth and
  // speed is NOT the peak load (the two peaks occur at different times).
  var maxLoad=new Float32Array(n),maxFroude=new Float32Array(n);
  var arrivalTime=new Float32Array(n),wetEver=new Uint8Array(n),coastDistanceM=new Float32Array(n);
  var estRunup=new Float32Array(n),estArrival=new Float32Array(n);
  var sEtaX=new Float32Array(n),sEtaY=new Float32Array(n),sHuX=new Float32Array(n),sHuY=new Float32Array(n),sHvX=new Float32Array(n),sHvY=new Float32Array(n);
  var deformation=source?(Physics.buildOkadaDeformation(grid,source,options)||{data:new Float32Array(n)}):
    {data:new Float32Array(n),method:'verification-initial-condition',maxUplift:0,maxSubsidence:0,volumeResidual:0,patches:0};
  var dynamicDeformation=!!(source&&source.geometry&&source.geometry.subs&&source.geometry.subs.length&&options.dynamicDeformation!==false);
  var appliedSourceFraction=dynamicDeformation?Physics.ruptureState(source.geometry,0).releasedMomentFraction:1;
  var cumulativeSourceVolumeM3=0;
  var dy=grid.res*111320,dxRows=new Float64Array(ny),cellAreaRows=new Float64Array(ny),minCellSize=dy;
  for(var row=0;row<ny;row++){
    var rowLat=grid.origin[1]+row*grid.res;
    dxRows[row]=grid.res*111320*Math.max(0.1,Math.cos(rowLat*Math.PI/180));
    cellAreaRows[row]=dxRows[row]*dy;minCellSize=Math.min(minCellSize,dxRows[row]);
  }
  for(var i=0;i<n;i++){
    z[i]=Number(grid.data[i]);
    var stillDepth=Math.max(0,-z[i]);
    var initial={eta:(Number(deformation.data[i])||0)*appliedSourceFraction,u:0,v:0};
    if(typeof options.initialState==='function'){
      var ix=i%nx,iy=Math.floor(i/nx),provided=options.initialState({x:ix,y:iy,lat:grid.origin[1]+iy*grid.res,
        lng:grid.origin[0]+ix*grid.res,terrain:z[i],stillDepth:stillDepth})||{};
      if(isFinite(Number(provided.eta)))initial.eta=Number(provided.eta);
      if(isFinite(Number(provided.u)))initial.u=Number(provided.u);
      if(isFinite(Number(provided.v)))initial.v=Number(provided.v);
    }
    // Displace only genuine water columns. Applying the deformation to dry
    // land cells would fabricate instant inundation long before any wave
    // could arrive; wave-driven wetting handles those cells dynamically.
    h[i]=Math.max(0,stillDepth+(stillDepth>0?initial.eta:0));
    hu[i]=h[i]*initial.u;hv[i]=h[i]*initial.v;
    var eta=h[i]+z[i];maxEta[i]=stillDepth>dry?eta:-Infinity;maxAbsEta[i]=0;maxDepth[i]=z[i]>=0?Math.max(0,h[i]):0;
    arrivalTime[i]=stillDepth>dry&&Math.abs(eta)>=arrivalThreshold?0:-1;
    if(stillDepth>dry)wetEver[i]=1;
    coastDistanceM[i]=z[i]<0?0:Infinity;
  }
  // Approximate inland distance from the initial coastline. The two-pass
  // chamfer transform is sufficient for city-scale summaries and avoids
  // presenting a coarse grid as a street-level inundation boundary.
  for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
    var i=y*nx+x;if(coastDistanceM[i]===0)continue;
    var dx=dxRows[y],diag=Math.sqrt(dx*dx+dy*dy),best=coastDistanceM[i];
    if(x>0)best=Math.min(best,coastDistanceM[i-1]+dx);
    if(y>0){best=Math.min(best,coastDistanceM[i-nx]+dy);if(x>0)best=Math.min(best,coastDistanceM[i-nx-1]+diag);if(x<nx-1)best=Math.min(best,coastDistanceM[i-nx+1]+diag);}
    coastDistanceM[i]=best;
  }
  for(var y=ny-1;y>=0;y--)for(var x=nx-1;x>=0;x--){
    var i=y*nx+x;if(coastDistanceM[i]===0)continue;
    var dx=dxRows[y],diag=Math.sqrt(dx*dx+dy*dy),best=coastDistanceM[i];
    if(x<nx-1)best=Math.min(best,coastDistanceM[i+1]+dx);
    if(y<ny-1){best=Math.min(best,coastDistanceM[i+nx]+dy);if(x>0)best=Math.min(best,coastDistanceM[i+nx-1]+diag);if(x<nx-1)best=Math.min(best,coastDistanceM[i+nx+1]+diag);}
    coastDistanceM[i]=best;
  }
  var sourceX=source?Math.max(0,Math.min(nx-1,Math.round((source.lng-grid.origin[0])/grid.res))):Math.floor(nx/2);
  var sourceY=source?Math.max(0,Math.min(ny-1,Math.round((source.lat-grid.origin[1])/grid.res))):Math.floor(ny/2);
  var sourceDepth=Math.max(5,-grid.data[sourceY*nx+sourceX]);
  var peakStartTime=0.45*minCellSize/Math.sqrt(g*sourceDepth);
  var time=0,stableDt=Infinity,manning=options.manning==null?0.025:Math.max(0,options.manning);
  // 'nested' is the two-way AMR mode: the ghost ring is owned by the nesting
  // driver (createNestedTsunamiSolver), which overwrites it with coarse-grid
  // interpolation before every substep — edge transmission and the sponge band
  // must both stay off so they cannot clobber the injected values.
  var boundary=options.boundary==='radiation'?'radiation':(options.boundary==='nested'?'nested':'wall');
  // Unsplit 2-D MUSCL needs a much tighter CFL number than the plain
  // first-order flux: at 0.38 a closed-basin sloshing mode grows without
  // bound, and sharp 2-D features (island corners) still grow at 0.25; the
  // first-order scheme's extra diffusion masks both. 0.15 stays clear of the
  // observed 0.15-0.25 stability boundary; first-order runs keep 0.38.
  var cflNumber=musclGate<1e8?0.15:0.38;
  var stepCount=0,lastMaxWaveSpeed=0,maxCfl=0;
  var negativeDepthCorrections=0,dryCellCorrections=0,nonFiniteCorrections=0;
  var initialWaterVolume=0;
  for(var massIndex=0;massIndex<n;massIndex++)initialWaterVolume+=h[massIndex]*cellAreaRows[Math.floor(massIndex/nx)];
  function limitedSlope(backward,forward){
    return backward*forward>0?(Math.abs(backward)<Math.abs(forward)?backward:forward):0;
  }
  // Minmod-limited MUSCL slopes of the free surface eta=h+z and of both
  // momenta. Reconstructing eta (not h) keeps a lake at rest exactly: at rest
  // every slope vanishes and the scheme collapses to the well-balanced
  // first-order form below.
  function computeSlopes(){
    for(var y=0;y<ny;y++)for(var x=0;x<nx;x++){
      var i=y*nx+x;
      var il=y*nx+Math.max(0,x-1),ir=y*nx+Math.min(nx-1,x+1);
      var id=Math.max(0,y-1)*nx+x,iu=Math.min(ny-1,y+1)*nx+x;
      var eC=h[i]+z[i];
      sEtaX[i]=limitedSlope(eC-(h[il]+z[il]),(h[ir]+z[ir])-eC);
      sEtaY[i]=limitedSlope(eC-(h[id]+z[id]),(h[iu]+z[iu])-eC);
      sHuX[i]=limitedSlope(hu[i]-hu[il],hu[ir]-hu[i]);
      sHuY[i]=limitedSlope(hu[i]-hu[id],hu[iu]-hu[i]);
      sHvX[i]=limitedSlope(hv[i]-hv[il],hv[ir]-hv[i]);
      sHvY[i]=limitedSlope(hv[i]-hv[id],hv[iu]-hv[i]);
    }
  }
  function face(a,b,axis,out){
    var se=axis===0?sEtaX:sEtaY,su=axis===0?sHuX:sHuY,sv=axis===0?sHvX:sHvY;
    // Second-order extrapolation only where both sides are clearly wet: the
    // first-order Rusanov flux is so diffusive on the bundled 0.15° terrain
    // grid that a metre-scale deep-ocean tsunami dissipates long before it
    // can reach the coast. Shallow and wet-dry-front faces keep the proven
    // first-order treatment, which also preserves the run-up dynamics.
    var smooth=h[a]>musclGate&&h[b]>musclGate?1:0;
    var etaA=h[a]+z[a]+0.5*se[a]*smooth,etaB=h[b]+z[b]-0.5*se[b]*smooth;
    var hA=Math.max(0,etaA-z[a]),hB=Math.max(0,etaB-z[b]);
    var bed=Math.max(z[a],z[b]),ha=Math.max(0,etaA-bed),hb=Math.max(0,etaB-bed);
    var qa=hA>dry?ha/hA:0,qb=hB>dry?hb/hB:0;
    var amx=(hu[a]+0.5*su[a]*smooth)*qa,amy=(hv[a]+0.5*sv[a]*smooth)*qa,bmx=(hu[b]-0.5*su[b]*smooth)*qb,bmy=(hv[b]-0.5*sv[b]*smooth)*qb;
    var ua=ha>dry?amx/ha:0,va=ha>dry?amy/ha:0,ub=hb>dry?bmx/hb:0,vb=hb>dry?bmy/hb:0;
    var ca=Math.sqrt(g*Math.max(ha,dry)),cb=Math.sqrt(g*Math.max(hb,dry));
    var s=Math.max(axis===0?Math.abs(ua)+ca:Math.abs(va)+ca,axis===0?Math.abs(ub)+cb:Math.abs(vb)+cb);
    var fa0=axis===0?amx:amy,fb0=axis===0?bmx:bmy;
    var fa1=axis===0?amx*ua+0.5*g*ha*ha:amy*ua;
    var fb1=axis===0?bmx*ub+0.5*g*hb*hb:bmy*ub;
    var fa2=axis===0?amx*va:amy*va+0.5*g*ha*ha;
    var fb2=axis===0?bmx*vb:bmy*vb+0.5*g*hb*hb;
    out[0]=0.5*(fa0+fb0)-0.5*s*(hb-ha);
    out[1]=0.5*(fa1+fb1)-0.5*s*(bmx-amx);
    out[2]=0.5*(fa2+fb2)-0.5*s*(bmy-amy);out[3]=ha;out[4]=hb;
  }
  function wallFace(i,axis,out){
    var depth=Math.max(0,h[i]);
    out[0]=0;
    out[1]=axis===0?0.5*g*depth*depth:0;
    out[2]=axis===1?0.5*g*depth*depth:0;
    out[3]=depth;out[4]=depth;
  }
  // Transmissive edge state: copy the interior free surface and velocity into
  // the boundary cell. Copying the water DEPTH instead would fabricate an eta
  // jump across every sloping edge face on every step, pumping water in or out
  // until the run explodes; the eta copy keeps a lake at rest exactly.
  function transmitEdge(bnd,ins){
    if(z[bnd]>=0)return;
    if(z[ins]>=0&&h[ins]<=dry)return; // dry land meets the edge: no free surface to copy
    var edgeEta=h[ins]+z[ins];
    h[bnd]=Math.max(0,edgeEta-z[bnd]);
    var edgeU=h[ins]>dry?hu[ins]/h[ins]:0,edgeV=h[ins]>dry?hv[ins]/h[ins]:0;
    hu[bnd]=h[bnd]*edgeU;hv[bnd]=h[bnd]*edgeV;
  }
  function computeDt(){
    var speed=0;
    for(var i=0;i<n;i++)if(h[i]>dry){
      speed=Math.max(speed,Math.abs(hu[i]/h[i])+Math.sqrt(g*h[i]),Math.abs(hv[i]/h[i])+Math.sqrt(g*h[i]));
    }
    lastMaxWaveSpeed=Math.max(speed,Math.sqrt(g*dry));
    return cflNumber*minCellSize/lastMaxWaveSpeed;
  }
  function step(dt){
    if(dynamicDeformation&&appliedSourceFraction<1){
      var targetSourceFraction=Physics.ruptureState(source.geometry,time+dt).releasedMomentFraction;
      var sourceIncrement=Math.max(0,targetSourceFraction-appliedSourceFraction);
      if(sourceIncrement>0)for(var sourceIndex=0;sourceIndex<n;sourceIndex++){
        if(z[sourceIndex]>=0)continue;
        var sourceDepthIncrement=Number(deformation.data[sourceIndex])*sourceIncrement;
        // Book only the water volume actually added; shoreline cells clamp at
        // zero when subsidence exceeds their still depth.
        var depthBefore=h[sourceIndex];
        h[sourceIndex]=Math.max(0,depthBefore+sourceDepthIncrement);
        cumulativeSourceVolumeM3+=(h[sourceIndex]-depthBefore)*cellAreaRows[Math.floor(sourceIndex/nx)];
      }
      appliedSourceFraction=targetSourceFraction;
    }
    if(boundary==='radiation'){
      for(var by=1;by<ny-1;by++){
        var left=by*nx,right=left+nx-1;
        transmitEdge(left,left+1);transmitEdge(right,right-1);
      }
      for(var bx=0;bx<nx;bx++){
        transmitEdge(bx,nx+bx);
        var top=(ny-1)*nx+bx;
        transmitEdge(top,top-nx);
      }
    }
    hn.set(h);hun.set(hu);hvn.set(hv);
    computeSlopes();
    var fl=[0,0,0,0,0],fr=[0,0,0,0,0],fd=[0,0,0,0,0],fu=[0,0,0,0,0];
    for(var y=1;y<ny-1;y++)for(var x=1;x<nx-1;x++){
      var i=y*nx+x,l=i-1,r=i+1,d=i-nx,u=i+nx;
      var wallW=x===1&&(boundary==='wall'||z[l]>=0),wallE=x===nx-2&&(boundary==='wall'||z[r]>=0);
      var wallS=y===1&&(boundary==='wall'||z[d]>=0),wallN=y===ny-2&&(boundary==='wall'||z[u]>=0);
      if(wallW)wallFace(i,0,fl);else face(l,i,0,fl);
      if(wallE)wallFace(i,0,fr);else face(i,r,0,fr);
      if(wallS)wallFace(i,1,fd);else face(d,i,1,fd);
      if(wallN)wallFace(i,1,fu);else face(i,u,1,fu);
      var dx=dxRows[y],area=cellAreaRows[y];
      var southWidth=0.5*(dxRows[y-1]+dx),northWidth=0.5*(dx+dxRows[y+1]);
      var newH=h[i]-dt*((fr[0]-fl[0])*dy+(fu[0]*northWidth-fd[0]*southWidth))/area;
      var mx=hu[i]-dt*((fr[1]-fl[1])*dy+(fu[1]*northWidth-fd[1]*southWidth))/area;
      var my=hv[i]-dt*((fr[2]-fl[2])*dy+(fu[2]*northWidth-fd[2]*southWidth))/area;
      // Hydrostatic-reconstruction source exactly preserves a lake at rest.
      mx+=dt*0.5*g*(fr[3]*fr[3]-fl[4]*fl[4])/dx;
      my+=dt*0.5*g*(fu[3]*fu[3]*northWidth-fd[4]*fd[4]*southWidth)/area;
      // Second-order correction to that source: on flat beds the MUSCL flux
      // already carries the full extrapolated pressure gradient, so the bed
      // source must keep only the part rooted at the cell's own extrapolated
      // depths. Identically zero at first order and at rest (eta slopes are
      // zero in both), which preserves the well-balanced identity. Wall faces
      // carry no extrapolation (their hydrostatic depth is the cell depth), so
      // the correction must vanish there too — otherwise it becomes a spurious
      // momentum source along domain walls.
      var gateE=!wallE&&h[i]>musclGate&&h[r]>musclGate?1:0,gateW=!wallW&&h[i]>musclGate&&h[l]>musclGate?1:0;
      var gateN=!wallN&&h[i]>musclGate&&h[u]>musclGate?1:0,gateS=!wallS&&h[i]>musclGate&&h[d]>musclGate?1:0;
      var hE=Math.max(0,h[i]+0.5*sEtaX[i]*gateE),hW=Math.max(0,h[i]-0.5*sEtaX[i]*gateW);
      var hN=Math.max(0,h[i]+0.5*sEtaY[i]*gateN),hS=Math.max(0,h[i]-0.5*sEtaY[i]*gateS);
      mx+=dt*0.5*g*((h[i]*h[i]-hE*hE)+(hW*hW-h[i]*h[i]))/dx;
      my+=dt*0.5*g*((h[i]*h[i]-hN*hN)*northWidth+(hS*hS-h[i]*h[i])*southWidth)/area;
      if(!isFinite(newH)||!isFinite(mx)||!isFinite(my)){
        nonFiniteCorrections++;newH=0;mx=0;my=0;
      }else if(newH<0){
        negativeDepthCorrections++;newH=0;mx=0;my=0;
      }else if(newH<=dry){
        // Retain sub-threshold water depth so a realistic thin front can
        // accumulate over several steps. Dropping it here both loses mass and
        // prevents city-scale coastal cells from ever becoming wet.
        if(newH>0)dryCellCorrections++;mx=0;my=0;
      }else{
        if(coriolisEnabled){
          var angle=2*omega*Math.sin((grid.origin[1]+y*grid.res)*Math.PI/180)*dt;
          var cosAngle=Math.cos(angle),sinAngle=Math.sin(angle),rotatedMx=mx*cosAngle+my*sinAngle;
          my=my*cosAngle-mx*sinAngle;mx=rotatedMx;
        }
        var vel=Math.sqrt(mx*mx+my*my)/newH;
        var drag=1+dt*g*manning*manning*vel/Math.pow(newH,4/3);
        if(!isFinite(drag)||!(drag>0)){nonFiniteCorrections++;mx=0;my=0;}
        else{mx/=drag;my/=drag;}
      }
      hn[i]=Math.max(0,newH);hun[i]=mx;hvn[i]=my;
    }
    if(boundary==='radiation'){
      // Sponge band along open water edges. A plain zero-gradient open
      // boundary is ill-posed for the 2-D SWE: diffracted energy feeding a
      // domain-scale circulation around coastal topography grows without
      // bound (isolated land cells wound up 50+ m/s gyres with 60 m eta
      // anomalies). Relaxing the band toward the still state absorbs that
      // mode; at rest it is an exact no-op. Band cells facing a land edge
      // cell are skipped so coastlines and narrow land-bounded straits are
      // unaffected.
      for(var sy=1;sy<ny-1;sy++)for(var sx=1;sx<nx-1;sx++){
        var si=sy*nx+sx;
        if(z[si]>=0)continue;
        var edgeDist=Math.min(sx,nx-1-sx,sy,ny-1-sy);
        if(edgeDist>=8)continue;
        var bndCell=edgeDist===sx?sy*nx:edgeDist===nx-1-sx?sy*nx+nx-1:edgeDist===sy?sx:(ny-1)*nx+sx;
        if(z[bndCell]>=0)continue;
        var relax=Math.exp(-0.025*Math.pow(8-edgeDist,2)*dt/Math.max(stableDt,0.1));
        var bandStill=Math.max(0,-z[si]);
        hn[si]=bandStill+(hn[si]-bandStill)*relax;
        hun[si]*=relax;hvn[si]*=relax;
      }
    }
    maxCfl=Math.max(maxCfl,lastMaxWaveSpeed*dt/minCellSize);stepCount++;
    var tmp=h;h=hn;hn=tmp;tmp=hu;hu=hun;hun=tmp;tmp=hv;hv=hvn;hvn=tmp;time+=dt;
    for(var i=0;i<n;i++){
      var eta=h[i]+z[i],inund=z[i]>=0?Math.max(0,h[i]):0;
      if(h[i]>dry&&eta>maxEta[i])maxEta[i]=eta;if(time>=peakStartTime&&h[i]>dry&&Math.abs(eta)>maxAbsEta[i])maxAbsEta[i]=Math.abs(eta);if(inund>maxDepth[i])maxDepth[i]=inund;
      if(h[i]>dry){var momMag=Math.sqrt(hu[i]*hu[i]+hv[i]*hv[i]),speed=momMag/h[i];if(speed>maxSpeed[i])maxSpeed[i]=speed;
        if(momMag>maxLoad[i])maxLoad[i]=momMag;
        var froude=speed/Math.sqrt(g*h[i]);if(froude>maxFroude[i])maxFroude[i]=froude;}
      if(arrivalTime[i]<0&&((z[i]<0&&Math.abs(eta)>=arrivalThreshold)||(z[i]>=0&&h[i]>dry)))arrivalTime[i]=time;
      if(z[i]>=0&&h[i]>dry)wetEver[i]=1;
    }
  }
  function nearest(lat,lng){
    var x=Math.round((lng-grid.origin[0])/grid.res),y=Math.round((lat-grid.origin[1])/grid.res);
    return x<0||x>=nx||y<0||y>=ny?-1:y*nx+x;
  }
  function nearestWet(lat,lng){
    // km-scaled search: 2 cells is ~33 km on the 0.15° global grid but only
    // ~4.6 km on 0.025° regional grids, where coastal query points (Sendai
    // plain) legitimately sit farther from the nearest water cell.
    var radius=Math.max(2,Math.min(12,Math.round(35/(grid.res*111))));
    var cell=Physics.findNearestWetCell(grid,lat,lng,radius);return cell?cell.index:-1;
  }
  function snapshot(stride){
    stride=Math.max(1,Math.round(stride||1));var cells=[],maxRunup=0,maxInundation=0,maxSurfaceElevation=0,maxWaveHeight=0,maxFlowSpeed=0,maxHydroLoad=0;
    var inundatedAreaM2=0,maxInundationDistanceM=0,zoneKm=Math.max(5,Number(options.visualAggregationKm)||15);
    var blockX=Math.max(1,Math.round(zoneKm*1000/dxRows[Math.floor(ny/2)])),blockY=Math.max(1,Math.round(zoneKm*1000/dy)),zoneMap=Object.create(null);
    // Shoreline run-up estimate for the inundation summary. Coastal ocean
    // cells on a regional grid are often hundreds of metres deep, so the
    // resolved wetting alone captures only a trickle of the true run-up.
    // Land cells touching a wet ocean cell therefore also receive the same
    // Green-law shoreline conversion the forecast-area warnings use; the
    // resolved maxDepth below is left untouched.
    for(var ri=0;ri<n;ri++){estRunup[ri]=0;estArrival[ri]=-1;}
    for(var i=0;i<n;i++){
      if(z[i]<0)continue;
      var exI=i%nx;
      for(var dir=0;dir<4;dir++){
        if(dir===0&&exI===0)continue;if(dir===1&&exI===nx-1)continue;
        var j=dir===0?i-1:dir===1?i+1:dir===2?i-nx:i+nx;
        if(j<0||j>=n||z[j]>=0)continue;
        var crest=isFinite(maxEta[j])?maxEta[j]:0;
        if(!(crest>0))continue;
        var runup=crest*Physics.greenLawAmplification(-z[j],10,5);
        if(runup>estRunup[i]){estRunup[i]=runup;estArrival[i]=arrivalTime[j]>=0?arrivalTime[j]:estArrival[i];}
      }
    }
    for(var i=0;i<n;i++){
      if(isFinite(maxEta[i]))maxSurfaceElevation=Math.max(maxSurfaceElevation,maxEta[i]);
      maxWaveHeight=Math.max(maxWaveHeight,maxAbsEta[i]);maxFlowSpeed=Math.max(maxFlowSpeed,maxSpeed[i]);maxHydroLoad=Math.max(maxHydroLoad,maxLoad[i]);
      if(z[i]>=0){
        if(isFinite(maxEta[i]))maxRunup=Math.max(maxRunup,maxEta[i]);
        if(estRunup[i]>maxRunup)maxRunup=estRunup[i];
        var effectiveDepth=Math.max(maxDepth[i],estRunup[i]-z[i]);
        maxInundation=Math.max(maxInundation,effectiveDepth);
        if(effectiveDepth>dry){
          var zy=Math.floor(i/nx),zx=i-zy*nx,zoneKey=Math.floor(zx/blockX)+','+Math.floor(zy/blockY);
          inundatedAreaM2+=cellAreaRows[zy];maxInundationDistanceM=Math.max(maxInundationDistanceM,coastDistanceM[i]);
          var zone=zoneMap[zoneKey];
          if(!zone)zone=zoneMap[zoneKey]={minX:zx,maxX:zx,minY:zy,maxY:zy,maxDepth:0,maxSurface:0,maxVelocity:0,maxLoad:0,maxFroude:0,arrivalTime:Infinity,areaM2:0,cells:0};
          zone.minX=Math.min(zone.minX,zx);zone.maxX=Math.max(zone.maxX,zx);zone.minY=Math.min(zone.minY,zy);zone.maxY=Math.max(zone.maxY,zy);
          zone.maxDepth=Math.max(zone.maxDepth,effectiveDepth);
          zone.maxSurface=Math.max(zone.maxSurface,isFinite(maxEta[i])?maxEta[i]:0,estRunup[i]);
          zone.maxVelocity=Math.max(zone.maxVelocity,maxSpeed[i]);
          zone.maxLoad=Math.max(zone.maxLoad,maxLoad[i]);
          zone.maxFroude=Math.max(zone.maxFroude,maxFroude[i]);
          var cellArrival=arrivalTime[i]>=0?arrivalTime[i]:estArrival[i];
          if(cellArrival>=0)zone.arrivalTime=Math.min(zone.arrivalTime,cellArrival);
          zone.areaM2+=cellAreaRows[zy];zone.cells++;
        }
      }
    }
    for(var y=0;y<ny;y+=stride)for(var x=0;x<nx;x+=stride){var i=y*nx+x;
      var eta=h[i]>dry?h[i]+z[i]:0,inund=z[i]>=0?Math.max(0,h[i]):0,est=z[i]>=0?Math.max(0,estRunup[i]-z[i]):0;
      if((h[i]>dry&&Math.abs(eta)>0.015)||maxDepth[i]>0.03||est>0.03||inund>dry||arrivalTime[i]>=0)cells.push({x:x,y:y,lat:grid.origin[1]+y*grid.res,lng:grid.origin[0]+x*grid.res,res:grid.res,eta:eta,maxEta:isFinite(maxEta[i])?maxEta[i]:0,maxWave:maxAbsEta[i],maxDepth:maxDepth[i],estDepth:est,inundation:inund,maxVelocity:maxSpeed[i],maxLoad:maxLoad[i],maxFroude:maxFroude[i],arrivalTime:arrivalTime[i]>=0?arrivalTime[i]:null,terrain:z[i],wet:wetEver[i]===1});
    }
    var inundationZones=Object.keys(zoneMap).map(function(key){var zone=zoneMap[key];return{
      id:key,
      bbox:[grid.origin[0]+(zone.minX-0.5)*grid.res,grid.origin[1]+(zone.minY-0.5)*grid.res,grid.origin[0]+(zone.maxX+0.5)*grid.res,grid.origin[1]+(zone.maxY+0.5)*grid.res],
      maxDepth:zone.maxDepth,maxSurface:zone.maxSurface,maxVelocity:zone.maxVelocity,maxLoad:zone.maxLoad,maxFroude:zone.maxFroude,arrivalTime:isFinite(zone.arrivalTime)?zone.arrivalTime:null,areaKm2:zone.areaM2/1e6,cells:zone.cells};});
    return{cells:cells,inundationZones:inundationZones,time:time,stride:stride,model:'nonlinearSWE',maxRunup:maxRunup,maxInundation:maxInundation,
      maxEta:maxSurfaceElevation,maxSurfaceElevation:maxSurfaceElevation,maxWaveHeight:maxWaveHeight,maxVelocity:maxFlowSpeed,maxHydroLoad:maxHydroLoad,inundatedAreaKm2:inundatedAreaM2/1e6,
      maxInundationDistanceKm:maxInundationDistanceM/1000,arrivalThreshold:arrivalThreshold,visualAggregationKm:zoneKm,
      deformation:deformation,deformationGrid:{origin:grid.origin,res:grid.res,nx:nx,ny:ny},quality:grid.meta&&grid.meta.quality||'unknown',diagnostics:diagnostics()};
  }
  function diagnostics(){
    var currentWaterVolume=0,nonFiniteCells=0,minWaterDepth=Infinity,maxWaterDepth=0;
    for(var i=0;i<n;i++){
      if(!isFinite(h[i])||!isFinite(hu[i])||!isFinite(hv[i])){nonFiniteCells++;continue;}
      currentWaterVolume+=h[i]*cellAreaRows[Math.floor(i/nx)];
      minWaterDepth=Math.min(minWaterDepth,h[i]);maxWaterDepth=Math.max(maxWaterDepth,h[i]);
    }
    var residual=currentWaterVolume-initialWaterVolume-cumulativeSourceVolumeM3;
    return{timeSeconds:time,steps:stepCount,stableDtSeconds:stableDt,maxCfl:maxCfl,cflLimit:cflNumber,
      gridNx:nx,gridNy:ny,cellCount:n,
      initialWaterVolumeM3:initialWaterVolume,currentWaterVolumeM3:currentWaterVolume,
      dynamicDeformation:dynamicDeformation,sourceFraction:appliedSourceFraction,sourceVolumeM3:cumulativeSourceVolumeM3,
      massResidualM3:residual,massResidualFraction:initialWaterVolume?residual/initialWaterVolume:0,
      negativeDepthCorrections:negativeDepthCorrections,dryCellCorrections:dryCellCorrections,
      nonFiniteCorrections:nonFiniteCorrections,nonFiniteCells:nonFiniteCells,
      minWaterDepthM:minWaterDepth===Infinity?0:minWaterDepth,maxWaterDepthM:maxWaterDepth,
      coriolisEnabled:coriolisEnabled,boundary:boundary,minCellSizeM:minCellSize,maxCellSizeM:Math.max(dy,dxRows[0],dxRows[ny-1])};
  }
  stableDt=computeDt();
  return {advanceTo:function(target){target=Math.max(time,Number(target)||0);while(time+1e-6<target){stableDt=computeDt();step(Math.min(stableDt,target-time));}return time;},
    // Nesting driver seams: state access, a pure CFL probe and a single
    // fixed-length step. The composite solver in createNestedTsunamiSolver
    // owns the pacing of both levels; everything else uses advanceTo only.
    _fields:function(){return{h:h,hu:hu,hv:hv,z:z,nx:nx,ny:ny,origin:grid.origin,res:grid.res};},
    _probeDt:function(){return computeDt();},
    _stepOnce:function(dt,skipProbe){if(!skipProbe)stableDt=computeDt();step(Math.max(1e-6,dt));return time;},
    sample:function(lat,lng){var i=nearestWet(lat,lng);return i>=0?h[i]+z[i]:0;},
    samplePeak:function(lat,lng){var i=nearestWet(lat,lng);return i>=0?maxAbsEta[i]:0;},
    sampleWaterDepth:function(lat,lng){var i=nearestWet(lat,lng);return i>=0?Math.max(0,-z[i]):null;},
    sampleMaxDepth:function(lat,lng){var i=nearest(lat,lng);return i>=0?maxDepth[i]:0;},
    sampleState:function(lat,lng){var i=nearest(lat,lng);return i>=0?{h:h[i],u:h[i]>dry?hu[i]/h[i]:0,v:h[i]>dry?hv[i]/h[i]:0,eta:h[i]+z[i]}:null;},
    getSnapshot:snapshot,getDiagnostics:diagnostics,getTime:function(){return time;},getStableDt:function(){return stableDt;},
    deformation:deformation,model:'nonlinearSWE',dryTolerance:dry,manning:manning,arrivalThreshold:arrivalThreshold,coriolis:coriolisEnabled,boundary:boundary};
};

// ------------------------------------------------------------------
// Two-level nested-grid tsunami solver (structured AMR, two-way coupling).
//
// Motivation: the 0.025° regional grids resolve ria-coast shoaling that the
// 0.15° global grid cannot, but run alone they seal their outer boundary
// (wall reflection or a damping sponge) — far-field propagation out of the
// regional box is wrong and late reflections contaminate the coast. The
// composite runs the global 0.15° grid as the coarse level and the regional
// grid as a fine level, ratio = coarse.res/fine.res (6 in production).
//
// Coupling per coarse step (classic coarse-first pattern):
//   1. coarse advances dtC on its own grid everywhere (including under the
//      fine patch; those cells serve only to feed the interface);
//   2. the fine level advances K>=ratio substeps of dtC/K; its ghost ring is
//      refilled before EVERY substep with bilinear-in-space coarse values
//      linearly interpolated in time between the coarse t_n and t_{n+1}
//      states (the still-water limit is preserved exactly: a uniform eta
//      interpolates to itself and h_ghost = eta - z_fine is the exact rest
//      depth);
//   3. restriction: every coarse cell containing >=1 fine cell centre is
//      overwritten by the area-weighted fine average (conservative over the
//      covered area), so the coarse state that the next coarse step — and
//      the next ghost fill — sees is the fine solution.
// Interface fluxes are not corrected (no Berger-Colella flux fixing), so a
// small mass/bookkeeping residual remains at the seam; it shows up honestly
// in diagnostics.massResidualFraction and the health assessor.
// ------------------------------------------------------------------

/** Check that fineGrid can nest inside coarseGrid. Returns geometry on success. */
Physics.validateNestedGrids = function(coarseGrid, fineGrid) {
  var errors=[];
  var cc=Physics.validateResearchGrid(coarseGrid,'terrain'),cf=Physics.validateResearchGrid(fineGrid,'terrain');
  if(!cc.valid)errors.push('coarse-grid-invalid: '+cc.errors.join('|'));
  if(!cf.valid)errors.push('fine-grid-invalid: '+cf.errors.join('|'));
  if(errors.length)return{valid:false,errors:errors};
  var ratio=coarseGrid.res/fineGrid.res;
  if(!(ratio>=1.999&&ratio<=12.0001)||Math.abs(Math.round(ratio)-ratio)>1e-6)
    errors.push('refinement-ratio-must-be-an-integer-between-2-and-12 (got '+ratio.toFixed(4)+')');
  // Fine extent (outer cell edges) must keep one full coarse cell of margin
  // from the coarse boundary so every bilinear ghost stencil is interior.
  // Cell convention: index x is CENTRED at origin + x*res, so the grid spans
  // [origin-0.5res, origin+(n-0.5)res].
  var fw=fineGrid.origin[0]-0.5*fineGrid.res;
  var fe=fineGrid.origin[0]+(fineGrid.nx-0.5)*fineGrid.res;
  var fs=fineGrid.origin[1]-0.5*fineGrid.res;
  var fn=fineGrid.origin[1]+(fineGrid.ny-0.5)*fineGrid.res;
  var cw=coarseGrid.origin[0]-0.5*coarseGrid.res,ce=coarseGrid.origin[0]+(coarseGrid.nx-0.5)*coarseGrid.res;
  var cs=coarseGrid.origin[1]-0.5*coarseGrid.res,cn=coarseGrid.origin[1]+(coarseGrid.ny-0.5)*coarseGrid.res;
  if(fw<cw+coarseGrid.res||fe>ce-coarseGrid.res)errors.push('fine-grid-not-interior-in-lng');
  if(fs<cs+coarseGrid.res||fn>cn-coarseGrid.res)errors.push('fine-grid-not-interior-in-lat');
  return {valid:errors.length===0,errors:errors,ratio:Math.round(ratio),fineExtent:[fw,fs,fe,fn]};
};

/**
 * Composite two-level nonlinear shallow-water solver.
 * Public surface mirrors createNonlinearTsunamiSolver so every consumer
 * (map layers, warnings, scorecards, research snapshots) works unchanged.
 */
Physics.createNestedTsunamiSolver = function(coarseGrid, fineGrid, source, options) {
  options=options||{};
  var check=Physics.validateNestedGrids(coarseGrid,fineGrid);
  if(!check.valid)return null;
  var ratio=check.ratio;
  var coarseOpts=options, fineOpts={};
  for(var k in options)fineOpts[k]=options[k];
  fineOpts.boundary='nested';
  var coarse=Physics.createNonlinearTsunamiSolver(coarseGrid,source,coarseOpts);
  var fine=Physics.createNonlinearTsunamiSolver(fineGrid,source,fineOpts);
  if(!coarse||!fine)return null;
  var cF=coarse._fields(),fF=fine._fields();
  var cNx=cF.nx,cNy=cF.ny,fNx=fF.nx,fNy=fF.ny;
  var dry=fine.dryTolerance;
  // ---- Ghost-ring prolongation stencils (bilinear over coarse cell centres)
  var ghosts=[],seen=new Uint8Array(fNx*fNy);
  function addGhost(x,y){
    var fi=y*fNx+x;if(seen[fi])return;seen[fi]=1;
    var lng=fF.origin[0]+x*fF.res,lat=fF.origin[1]+y*fF.res;
    var fx=(lng-cF.origin[0])/cF.res,fy=(lat-cF.origin[1])/cF.res;
    var i0=Math.max(0,Math.min(cNx-2,Math.floor(fx))),j0=Math.max(0,Math.min(cNy-2,Math.floor(fy)));
    ghosts.push({fi:fi,c:[j0*cNx+i0,j0*cNx+i0+1,(j0+1)*cNx+i0,(j0+1)*cNx+i0+1],
      wx:fx-i0,wy:fy-j0,z:fF.z[fi]});
  }
  for(var gy=0;gy<fNy;gy++){addGhost(0,gy);addGhost(fNx-1,gy);}
  for(var gx=0;gx<fNx;gx++){addGhost(gx,0);addGhost(gx,fNy-1);}
  // ---- Restriction map: coarse cell -> contributing fine cells + area weights
  var dyF=fF.res*111320,dxFRow=new Float64Array(fNy);
  for(var fr=0;fr<fNy;fr++)dxFRow[fr]=fF.res*111320*Math.max(0.1,Math.cos((fF.origin[1]+fr*fF.res)*Math.PI/180));
  var restrictMap=new Map();
  for(var ry=0;ry<fNy;ry++)for(var rx=0;rx<fNx;rx++){
    var lngC=fF.origin[0]+rx*fF.res,latC=fF.origin[1]+ry*fF.res;
    var I=Math.floor((lngC-cF.origin[0])/cF.res+0.5),J=Math.floor((latC-cF.origin[1])/cF.res+0.5);
    if(I<0||I>=cNx||J<0||J>=cNy)continue;
    var cIdx=J*cNx+I,entry=restrictMap.get(cIdx);
    if(!entry){entry={fi:[],w:[]};restrictMap.set(cIdx,entry);}
    entry.fi.push(ry*fNx+rx);entry.w.push(dxFRow[ry]*dyF);
  }
  var restrictKeys=Array.from(restrictMap.keys());
  // ---- Coarse t_n buffers for time interpolation of the ghost values
  var oldH=new Float32Array(cNx*cNy),oldHu=new Float32Array(cNx*cNy),oldHv=new Float32Array(cNx*cNy);
  function etaAt(h,z,i){return h[i]>dry?h[i]+z[i]:z[i];}
  function fillGhosts(tau){
    // The base solver swaps its h/hu/hv double buffers on every step, so the
    // live arrays must be re-fetched — captured references go stale.
    var cNow=coarse._fields(),hC=cNow.h,huC=cNow.hu,hvC=cNow.hv,zC=cNow.z;
    var fNow=fine._fields(),fNowH=fNow.h,fNowHu=fNow.hu,fNowHv=fNow.hv;
    for(var gi=0;gi<ghosts.length;gi++){
      var g=ghosts[gi],c=g.c,wx=g.wx,wy=g.wy;
      // free surface: wet-weighted bilinear in space, linear between coarse
      // t_n and t_n+1. Dry coarse cells contribute no surface (they would pull
      // the ghost toward the bed); if the whole stencil is dry the ghost dries.
      var wo=0,eo=0,wn=0,en=0;
      for(var p=0;p<4;p++){
        var wgt=p===0?(1-wx)*(1-wy):p===1?wx*(1-wy):p===2?(1-wx)*wy:wx*wy;
        if(oldH[c[p]]>dry){wo+=wgt;eo+=wgt*etaAt(oldH,zC,c[p]);}
        if(hC[c[p]]>dry){wn+=wgt;en+=wgt*etaAt(hC,zC,c[p]);}
      }
      if(wo>0)eo/=wo;
      if(wn>0)en/=wn;
      var eta=eo+(en-eo)*tau;
      // velocities: wet-weighted average of the t_n+1 state (a dry coarse
      // cell carries no velocity); the still-water limit gives exactly 0.
      var ww=0,uNew=0,vNew=0;
      for(var q=0;q<4;q++){
        var w=(q===0?(1-wx)*(1-wy):q===1?wx*(1-wy):q===2?(1-wx)*wy:wx*wy);
        if(hC[c[q]]>dry){ww+=w;uNew+=w*huC[c[q]]/hC[c[q]];vNew+=w*hvC[c[q]]/hC[c[q]];}
      }
      if(ww>0){uNew/=ww;vNew/=ww;}else{uNew=0;vNew=0;}
      var wet=wo>0||wn>0;
      var hG=wet&&g.z<0?Math.max(0,eta-g.z):0;
      fNowH[g.fi]=hG;
      fNowHu[g.fi]=hG>dry?hG*uNew:0;
      fNowHv[g.fi]=hG>dry?hG*vNew:0;
    }
  }
  function restrict(){
    // Eta-based (free-surface) restriction over WET fine cells only: a lake at
    // rest has uniform eta, so the coarse cell keeps eta=0 and h_c=-z_c
    // EXACTLY — including coarse cells whose fine coverage straddles an
    // island or shoreline, where dry fine cells (h=0) would otherwise drag
    // the restricted surface toward the bed elevation and fabricate a mound.
    // Restricting h instead would inject the fine/coarse bed-sampling mismatch
    // as a spurious surface step and drive interface currents. The price is a
    // small non-conservative seam term (bed-volume difference when the surface
    // moves), which lands in diagnostics.massResidualFraction.
    var fNow=fine._fields(),fH=fNow.h,fHu=fNow.hu,fHv=fNow.hv,fZ=fNow.z;
    var cNow=coarse._fields(),cZ=cNow.z;
    for(var ri=0;ri<restrictKeys.length;ri++){
      var cIdx=restrictKeys[ri],entry=restrictMap.get(cIdx);
      var swet=0,seta=0,sH=0,shu=0,shv=0;
      for(var q=0;q<entry.fi.length;q++){
        var fi=entry.fi[q],w=entry.w[q],hf=fH[fi];
        if(hf<=0)continue;
        var fw2=w*hf;
        swet+=w;seta+=w*(hf+fZ[fi]);sH+=fw2;shu+=w*fHu[fi];shv+=w*fHv[fi];
      }
      if(!(swet>0))continue; // no wet fine coverage: leave the coarse evolution alone
      var etaC=seta/swet,hc=Math.max(0,etaC-cZ[cIdx]);
      cNow.h[cIdx]=hc;
      if(hc>dry&&sH>0){cNow.hu[cIdx]=hc*shu/sH;cNow.hv[cIdx]=hc*shv/sH;}
      else{cNow.hu[cIdx]=0;cNow.hv[cIdx]=0;}
    }
  }
  var time=0,coarseSteps=0,lastSubsteps=ratio;
  function advanceTo(target){
    target=Math.max(time,Number(target)||0);
    while(time+1e-6<target){
      var rem=target-time;
      var dtC0=Math.min(coarse._probeDt(),rem);
      var fineProbe=fine._probeDt();
      var K=Math.max(ratio,Math.ceil(dtC0/fineProbe-1e-9));
      var dtC=Math.min(dtC0,K*fineProbe),dtF=dtC/K;
      var cPre=coarse._fields();
      oldH.set(cPre.h);oldHu.set(cPre.hu);oldHv.set(cPre.hv);
      coarse._stepOnce(dtC,true);
      for(var k=1;k<=K;k++){fillGhosts(k/K);fine._stepOnce(dtF,true);}
      restrict();
      time+=dtC;coarseSteps++;lastSubsteps=K;
    }
    return time;
  }
  var ext=check.fineExtent;
  function insideFine(lat,lng){
    return lat>=ext[1]&&lat<=ext[3]&&lng>=ext[0]&&lng<=ext[2];
  }
  function diagnostics(){
    var dc=coarse.getDiagnostics(),df=fine.getDiagnostics();
    var corrections=(dc.negativeDepthCorrections+dc.nonFiniteCorrections)+(df.negativeDepthCorrections+df.nonFiniteCorrections);
    return {timeSeconds:Math.max(dc.timeSeconds,df.timeSeconds),steps:dc.steps,cellCount:dc.cellCount+df.cellCount,
      stableDtSeconds:dc.stableDtSeconds,maxCfl:Math.max(dc.maxCfl,df.maxCfl),cflLimit:dc.cflLimit,
      gridNx:fNx,gridNy:fNy,coarseGridNx:cNx,coarseGridNy:cNy,
      initialWaterVolumeM3:dc.initialWaterVolumeM3,currentWaterVolumeM3:dc.currentWaterVolumeM3,
      dynamicDeformation:dc.dynamicDeformation||df.dynamicDeformation,sourceFraction:df.sourceFraction,
      sourceVolumeM3:dc.sourceVolumeM3+df.sourceVolumeM3,
      massResidualFraction:dc.massResidualFraction,fineMassResidualFraction:df.massResidualFraction,
      negativeDepthCorrections:corrections,nonFiniteCorrections:dc.nonFiniteCorrections+df.nonFiniteCorrections,
      nonFiniteCells:dc.nonFiniteCells+df.nonFiniteCells,
      coriolisEnabled:dc.coriolisEnabled,boundary:dc.boundary,
      nested:{model:'two-way-amr',ratio:ratio,substeps:lastSubsteps,restrictionCells:restrictMap.size,ghostCells:ghosts.length},
      levels:{coarse:dc,fine:df}};
  }
  var sourceInFine=source?insideFine(source.lat,source.lng):false;
  return {advanceTo:advanceTo,
    sample:function(lat,lng){return insideFine(lat,lng)?fine.sample(lat,lng):coarse.sample(lat,lng);},
    samplePeak:function(lat,lng){return insideFine(lat,lng)?fine.samplePeak(lat,lng):coarse.samplePeak(lat,lng);},
    sampleWaterDepth:function(lat,lng){return insideFine(lat,lng)?fine.sampleWaterDepth(lat,lng):coarse.sampleWaterDepth(lat,lng);},
    sampleMaxDepth:function(lat,lng){return insideFine(lat,lng)?fine.sampleMaxDepth(lat,lng):coarse.sampleMaxDepth(lat,lng);},
    sampleState:function(lat,lng){return insideFine(lat,lng)?fine.sampleState(lat,lng):coarse.sampleState(lat,lng);},
    getSnapshot:function(stride){
      var fs=fine.getSnapshot(stride),cs=coarse.getSnapshot(stride);
      var cells=fs.cells.concat(cs.cells.filter(function(c){return !insideFine(c.lat,c.lng);}));
      var zones=(fs.inundationZones||[]).concat((cs.inundationZones||[]).filter(function(z){
        return !insideFine(0.5*(z.bbox[1]+z.bbox[3]),0.5*(z.bbox[0]+z.bbox[2]));}));
      var out={cells:cells,inundationZones:zones,time:Math.max(fs.time,cs.time),stride:stride,model:'nonlinearSWE-nested',
        maxRunup:Math.max(fs.maxRunup,cs.maxRunup),maxInundation:Math.max(fs.maxInundation,cs.maxInundation),
        maxEta:Math.max(fs.maxEta,cs.maxEta),maxSurfaceElevation:Math.max(fs.maxSurfaceElevation,cs.maxSurfaceElevation),
        maxWaveHeight:Math.max(fs.maxWaveHeight,cs.maxWaveHeight),maxVelocity:Math.max(fs.maxVelocity,cs.maxVelocity),
        maxHydroLoad:Math.max(fs.maxHydroLoad||0,cs.maxHydroLoad||0),
        inundatedAreaKm2:(fs.inundatedAreaKm2||0)+(cs.inundatedAreaKm2||0),
        maxInundationDistanceKm:Math.max(fs.maxInundationDistanceKm||0,cs.maxInundationDistanceKm||0),
        arrivalThreshold:fs.arrivalThreshold,visualAggregationKm:fs.visualAggregationKm,
        deformation:(sourceInFine?fs:cs).deformation,deformationGrid:(sourceInFine?fs:cs).deformationGrid,
        quality:fs.quality,diagnostics:diagnostics(),nested:{ratio:ratio,fineExtent:ext}};
      return out;
    },
    getDiagnostics:diagnostics,getTime:function(){return time;},getStableDt:function(){return coarse._probeDt();},
    deformation:(sourceInFine?fine:coarse).deformation,
    levels:{coarse:coarse,fine:fine},
    model:'nonlinearSWE-nested',dryTolerance:dry,manning:fine.manning,arrivalThreshold:fine.arrivalThreshold,
    coriolis:fine.coriolis,boundary:coarse.boundary};
};

/** Classify solver diagnostics without hiding the underlying numerical values. */
Physics.assessTsunamiNumericalHealth = function(diagnostics) {
  var d=diagnostics||{},reasons=[];
  var steps=Math.max(0,Number(d.steps)||0),cells=Math.max(0,Number(d.cellCount)||0);
  var maxCfl=Number(d.maxCfl),cflLimit=Number(d.cflLimit);
  var residual=Number(d.massResidualFraction),massAbs=isFinite(residual)?Math.abs(residual):Infinity;
  var nonFinite=(Number(d.nonFiniteCells)||0)+(Number(d.nonFiniteCorrections)||0);
  var corrections=(Number(d.negativeDepthCorrections)||0)+(Number(d.nonFiniteCorrections)||0);
  var correctionRate=steps>0&&cells>0?corrections/(steps*cells):0;
  if(!steps)return{level:'pending',reasons:['notAdvanced'],massResidualPercent:isFinite(residual)?residual*100:null,correctionRate:correctionRate};
  if(!isFinite(maxCfl)||!isFinite(cflLimit)||!(cflLimit>0)||!isFinite(residual))reasons.push('invalidDiagnostics');
  if(nonFinite>0)reasons.push('nonFinite');
  if(isFinite(maxCfl)&&isFinite(cflLimit)&&maxCfl>cflLimit+1e-9)reasons.push('cflExceeded');
  if(massAbs>0.01)reasons.push('massCritical');
  var unstable=reasons.length>0;
  if(!unstable&&massAbs>0.001)reasons.push('massWarning');
  if(!unstable&&correctionRate>0.001)reasons.push('correctionWarning');
  return{level:unstable?'unstable':(reasons.length?'warning':'healthy'),reasons:reasons,
    massResidualPercent:isFinite(residual)?residual*100:null,correctionRate:correctionRate};
};

/** Coarse linear shallow-water solver for the loaded bathymetry grid. */
Physics.createLinearTsunamiSolver = function(grid, source, options) {
  if(!grid||!grid.data||!source||!grid.nx||!grid.ny)return null;
  options=options||{};
  var nx=grid.nx,ny=grid.ny,n=nx*ny,g=9.80665;
  var eta=new Float32Array(n),u=new Float32Array(n),v=new Float32Array(n),maxAbsEta=new Float32Array(n),maxEta=new Float32Array(n),maxSpeed=new Float32Array(n),arrivalTime=new Float32Array(n);
  var eta2=new Float32Array(n),u2=new Float32Array(n),v2=new Float32Array(n);
  // Per-row zonal cell size: a single mean-latitude dx misrepresents the E-W
  // gradients by 13-27% toward the edges of a 20-50°N grid.
  var dy=grid.res*111320,dxRows=new Float64Array(ny),minDx=dy;
  for(var drow=0;drow<ny;drow++){
    var rowLat=grid.origin[1]+drow*grid.res;
    dxRows[drow]=grid.res*111320*Math.max(0.1,Math.cos(rowLat*Math.PI/180));
    if(dxRows[drow]<minDx)minDx=dxRows[drow];
  }
  var maxDepth=5;
  for(var i=0;i<n;i++)if(grid.data[i]<0)maxDepth=Math.max(maxDepth,-grid.data[i]);
  var stableDt=0.35*Math.min(minDx,dy)/Math.sqrt(g*maxDepth),time=0;
  var amp=Physics.tsunamiSourceAmplitude(source,4000,0.7);
  var deformation=Physics.buildOkadaDeformation(grid,source,options);
  if(deformation)eta.set(deformation.data);
  var arrivalThreshold=options.arrivalThreshold==null?0.03:Math.max(0.001,Number(options.arrivalThreshold));
  for(var ai=0;ai<n;ai++){maxEta[ai]=Math.max(0,eta[ai]);arrivalTime[ai]=wet(ai)&&Math.abs(eta[ai])>=arrivalThreshold?0:-1;}
  var peakStartTime=0.45*Math.min(minDx,dy)/Math.sqrt(g*maxDepth);
  function wet(idx){return idx>=0&&idx<n&&grid.data[idx]<0;}
  function step(dt){
    for(var y=1;y<ny-1;y++)for(var x=1;x<nx-1;x++){
      var i=y*nx+x;if(!wet(i)){u2[i]=v2[i]=eta2[i]=0;continue;}
      var il=i-1,ir=i+1,id=i-nx,iu=i+nx;
      var eL=wet(il)?eta[il]:eta[i],eR=wet(ir)?eta[ir]:eta[i];
      var eD=wet(id)?eta[id]:eta[i],eU=wet(iu)?eta[iu]:eta[i];
      u2[i]=(u[i]-g*dt*(eR-eL)/(2*dxRows[y]))*0.9995;
      v2[i]=(v[i]-g*dt*(eU-eD)/(2*dy))*0.9995;
      var velEdgeDist=Math.min(x,y,nx-1-x,ny-1-y);
      if(velEdgeDist<8){
        var velSponge=Math.exp(-0.025*Math.pow(8-velEdgeDist,2)*dt/Math.max(stableDt,0.1));
        u2[i]*=velSponge;v2[i]*=velSponge;
      }
      // Backstop only: a blown-up velocity is unphysical; never let it reach
      // the snapshot's maxSpeed or the next step's fluxes.
      if(!isFinite(u2[i])||Math.abs(u2[i])>100)u2[i]=0;
      if(!isFinite(v2[i])||Math.abs(v2[i])>100)v2[i]=0;
    }
    for(var y=1;y<ny-1;y++)for(var x=1;x<nx-1;x++){
      var i=y*nx+x;if(!wet(i)){eta2[i]=0;continue;}
      var il=i-1,ir=i+1,id=i-nx,iu=i+nx,h=Math.max(5,-grid.data[i]);
      var qL=wet(il)?Math.max(5,-grid.data[il])*u2[il]:0;
      var qR=wet(ir)?Math.max(5,-grid.data[ir])*u2[ir]:0;
      var qD=wet(id)?Math.max(5,-grid.data[id])*v2[id]:0;
      var qU=wet(iu)?Math.max(5,-grid.data[iu])*v2[iu]:0;
      eta2[i]=eta[i]-dt*((qR-qL)/(2*dxRows[y])+(qU-qD)/(2*dy));
      var edgeDist=Math.min(x,y,nx-1-x,ny-1-y);
      if(edgeDist<8){
        // Sponge layer limits artificial reflection from the finite grid edge.
        var sponge=Math.exp(-0.025*Math.pow(8-edgeDist,2)*dt/Math.max(stableDt,0.1));
        eta2[i]*=sponge;
      }
      if(!isFinite(eta2[i])||Math.abs(eta2[i])>100)eta2[i]=isFinite(eta[i])?Math.max(-100,Math.min(100,eta[i])):0;
    }
    // The outermost ring is never time-stepped; copy the adjacent interior
    // row/column into it so the alternating buffers do not expose stale or
    // zero edge values (transmissive edge, consistent with the sponge).
    for(var rb2=1;rb2<ny-1;rb2++){eta2[rb2*nx]=eta2[rb2*nx+1];eta2[rb2*nx+nx-1]=eta2[rb2*nx+nx-2];}
    for(var rb=0;rb<nx;rb++){eta2[rb]=eta2[nx+rb];eta2[(ny-1)*nx+rb]=eta2[(ny-2)*nx+rb];}
    var tmp=eta;eta=eta2;eta2=tmp;tmp=u;u=u2;u2=tmp;tmp=v;v=v2;v2=tmp;time+=dt;
    for(var pi=0;pi<n;pi++)if(wet(pi)){
      if(time>=peakStartTime&&Math.abs(eta[pi])>maxAbsEta[pi])maxAbsEta[pi]=Math.abs(eta[pi]);
      if(eta[pi]>maxEta[pi])maxEta[pi]=eta[pi];var speed=Math.sqrt(u[pi]*u[pi]+v[pi]*v[pi]);if(speed>maxSpeed[pi])maxSpeed[pi]=speed;
      if(arrivalTime[pi]<0&&Math.abs(eta[pi])>=arrivalThreshold)arrivalTime[pi]=time;
    }
  }
  function nearestWet(lat,lng){
    // km-scaled search: 2 cells is ~33 km on the 0.15° global grid but only
    // ~4.6 km on 0.025° regional grids, where coastal query points (Sendai
    // plain) legitimately sit farther from the nearest water cell.
    var radius=Math.max(2,Math.min(12,Math.round(35/(grid.res*111))));
    var cell=Physics.findNearestWetCell(grid,lat,lng,radius);return cell?cell.index:-1;
  }
  var initialSourceResidual=0;
  for(var ri=0;ri<n;ri++)initialSourceResidual+=eta[ri];
  return {advanceTo:function(target){target=Math.max(time,Number(target)||0);while(time+1e-6<target)step(Math.min(stableDt,target-time));return time;},
    sample:function(lat,lng){var idx=nearestWet(lat,lng);return idx>=0?eta[idx]:0;},
    samplePeak:function(lat,lng){var idx=nearestWet(lat,lng);return idx>=0?maxAbsEta[idx]:0;},
    sampleWaterDepth:function(lat,lng){var idx=nearestWet(lat,lng);return idx>=0?Math.max(0,-grid.data[idx]):null;},
    getSnapshot:function(stride){stride=Math.max(1,Math.round(stride||1));var cells=[],maxSurfaceElevation=0,maxWaveHeight=0,maxFlowSpeed=0;
      for(var si=0;si<n;si++){maxSurfaceElevation=Math.max(maxSurfaceElevation,maxEta[si]);maxWaveHeight=Math.max(maxWaveHeight,maxAbsEta[si]);maxFlowSpeed=Math.max(maxFlowSpeed,maxSpeed[si]);}
      for(var y=0;y<ny;y+=stride)for(var x=0;x<nx;x+=stride){var idx=y*nx+x;if(grid.data[idx]<0&&(Math.abs(eta[idx])>0.002||arrivalTime[idx]>=0))cells.push({x:x,y:y,eta:eta[idx],maxEta:maxEta[idx],maxWave:maxAbsEta[idx],maxDepth:0,inundation:0,maxVelocity:maxSpeed[idx],maxLoad:0,maxFroude:0,arrivalTime:arrivalTime[idx]>=0?arrivalTime[idx]:null,terrain:grid.data[idx],wet:true});}
      return{cells:cells,inundationZones:[],time:time,stride:stride,model:'linearSWE',maxRunup:0,maxInundation:0,maxEta:maxSurfaceElevation,maxSurfaceElevation:maxSurfaceElevation,maxWaveHeight:maxWaveHeight,maxVelocity:maxFlowSpeed,maxHydroLoad:0,
        inundatedAreaKm2:0,maxInundationDistanceKm:0,arrivalThreshold:arrivalThreshold,deformation:deformation,quality:grid.meta&&grid.meta.quality||'unknown'};},
    getTime:function(){return time;},stableDt:stableDt,sourceAmplitude:amp,
    initialSourceResidual:initialSourceResidual,deformation:deformation,model:'linearSWE',arrivalThreshold:arrivalThreshold};
};

Physics.greenLawAmplification = function(offshoreDepth, coastalDepth, cap) {
  if (!(offshoreDepth > 0) || !(coastalDepth > 0)) return 1;
  return Math.min(cap || 5, Math.pow(Math.max(offshoreDepth, coastalDepth) / Math.max(coastalDepth, 10), 0.25));
};

/**
 * Tsunami warning level from predicted height. @param {number} H (meters) @returns {string|null} major|warn|adv|null
 */
Physics.tsunamiWarningLevel = function(H, levelBoost) {
  var rank=H>=3.0?3:H>=1.0?2:H>=0.2?1:0;
  if(!rank)return null;
  rank=Math.min(3,rank+Math.max(0,Math.min(2,Math.round(Number(levelBoost)||0))));
  return rank===3?'major':rank===2?'warn':'adv';
};

/**
 * JMA-style regional forecast decision. Physical height is preserved while a
 * separate conservative envelope and optional user uplift determine the alert.
 */
Physics.jmaTsunamiForecast = function(physicalHeight, levelBoost, conservativeFactor) {
  var physical=isFinite(physicalHeight)?Math.max(0,Number(physicalHeight)):0;
  var factor=isFinite(conservativeFactor)?Math.max(1,Number(conservativeFactor)):1;
  var alertHeight=physical*factor;
  var rank=alertHeight>=3?3:alertHeight>=1?2:alertHeight>=0.2?1:0;
  if(rank)rank=Math.min(3,rank+Math.max(0,Math.min(2,Math.round(Number(levelBoost)||0))));
  var level=rank===3?'major':rank===2?'warn':rank===1?'adv':null;
  var announcedHeight=null;
  if(rank===1)announcedHeight='1m';
  else if(rank===2)announcedHeight='3m';
  else if(rank===3)announcedHeight=alertHeight>10?'>10m':alertHeight>=5?'10m':'5m';
  return {physicalHeight:physical,alertHeight:alertHeight,conservativeFactor:factor,
    rank:rank,level:level,announcedHeight:announcedHeight};
};

Physics.tsunamiWarningRank = function(level) {
  return level==='major'?3:level==='warn'?2:level==='adv'?1:0;
};

/**
 * Expand sparse warning samples over their coastline segments and close one
 * missing sample between warned neighbours. ringId prevents bridging islands.
 */
Physics.buildCoastalWarningCoverage = function(samples, baseRadius, maxBridge, segmentRingIds) {
  baseRadius = Math.max(0, Math.round(baseRadius == null ? 3 : baseRadius));
  maxBridge = Math.max(0, Math.round(maxBridge == null ? 10 : maxBridge));
  var groups = Object.create(null), coverage = Object.create(null);

  function put(index, ringId, level) {
    if (segmentRingIds && (index < 0 || index >= segmentRingIds.length ||
        String(segmentRingIds[index]) !== ringId)) return;
    var key = String(index), current = coverage[key];
    if (!current || Physics.tsunamiWarningRank(level) > Physics.tsunamiWarningRank(current.level)) {
      coverage[key] = {ringId:ringId, level:level};
    }
  }

  for (var i = 0; i < (samples || []).length; i++) {
    var sample = samples[i], index = Number(sample && sample.segmentIndex);
    if (!sample || !isFinite(index) || !Physics.tsunamiWarningRank(sample.level)) continue;
    index = Math.round(index);
    var ringId = sample.ringId == null ? 'default' : String(sample.ringId);
    if (!groups[ringId]) groups[ringId] = Object.create(null);
    var existing = groups[ringId][index];
    if (!existing || Physics.tsunamiWarningRank(sample.level) > Physics.tsunamiWarningRank(existing.level)) {
      groups[ringId][index] = {index:index, ringId:ringId, level:sample.level};
    }
  }

  for (var groupId in groups) {
    var anchors = Object.keys(groups[groupId]).map(function(key) { return groups[groupId][key]; });
    anchors.sort(function(a, b) { return a.index - b.index; });
    for (var ai = 0; ai < anchors.length; ai++) {
      var anchor = anchors[ai];
      for (var offset = -baseRadius; offset <= baseRadius; offset++) {
        put(anchor.index + offset, anchor.ringId, anchor.level);
      }
      if (ai === 0) continue;
      var previous = anchors[ai - 1], gap = anchor.index - previous.index;
      if (gap <= 1 || gap > maxBridge) continue;
      for (var bridgeIndex = previous.index + 1; bridgeIndex < anchor.index; bridgeIndex++) {
        var usePrevious = bridgeIndex - previous.index <= anchor.index - bridgeIndex;
        put(bridgeIndex, anchor.ringId, usePrevious ? previous.level : anchor.level);
      }
    }
  }
  return coverage;
};

// Index of the sub-event the UI should present at sim time t: the event with
// the greatest originTime <= t (0 when none has started). Pure helper so the
// multi-event display-event selection (v5.2) is testable outside the UI.
Physics.activeEventIndex = function(events, simElapsed) {
  if (!events || !events.length) return 0;
  var idx = -1, best = -Infinity;
  for (var i = 0; i < events.length; i++) {
    var ot = (events[i] && events[i].originTime != null) ? events[i].originTime : 0;
    if (ot <= simElapsed && ot >= best) { best = ot; idx = i; }
  }
  return idx >= 0 ? idx : 0;
};

// ================================================================
//  EVENT FACTORY
// ================================================================

Physics.createEventState = function(lat, lng, mag, depth, originTime, isMainshock) {
  return {
    lat: lat, lng: lng, mag: mag, depth: depth,
    originTime: originTime, isMainshock: isMainshock,
    pRadius: 0, sRadius: 0, pTravel: 0, sTravel: 0,
    marker: null,
    colorP: isMainshock ? 'rgba(77,166,255,0.7)' : 'rgba(255,140,40,0.7)',
    colorS: isMainshock ? 'rgba(255,159,67,0.8)' : 'rgba(255,100,30,0.8)',
    id: isMainshock ? 'event_main' : ('as_' + lat.toFixed(2) + '_' + lng.toFixed(2) + '_' + originTime.toFixed(1))
  };
};

// ================================================================
//  AFTERSHOCK CATALOG (Omori-Utsu + Gutenberg-Richter)
// ================================================================

// Calibrated aftershock productivity scaling: log10(N) gained per unit of
// mainshock magnitude. Literature has this at the aftershock b-value level
// (Utsu 1970; Reasenberg & Jones 1989: N ~ 10^(b*(Mmain-Mmin))); the LSQ fit
// over three USGS sequences (Kumamoto 2016, Noto 2024, Tohoku 2011 —
// tools/data/etas-calibration-report.json) gives 0.809. The previous
// 2^(M-5) law (slope log10(2)=0.301) under-scaled productivity ~2.7x per
// magnitude: a M9.1 produced only ~17x the aftershocks of a M5 instead of
// the observed ~2000x. The absolute anchor at M5 (20 events per asyK=150)
// stays the display budget — catalogCap keeps the visualized catalog sane —
// only the magnitude slope is calibrated.
Physics.AFTERSHOCK_PRODUCTIVITY_LOG10 = 0.809;
// ETAS branching productivity in natural-log units (Ogata's alpha):
// K*exp(alpha*(M-Mmin)) direct children per parent. 0.809*log10-slope in
// natural log. Config etasAlpha default mirrors this value.
Physics.ETAS_ALPHA_NATLOG = 0.809 * Math.LN10;

// v4.3: ETAS branching process — each aftershock can trigger its own aftershocks
Physics._generateAftershockCatalogETAS = function(mainMw, mainLat, mainLng, mainStrike, mainDip, mainDepth,
                                                    asyK, asyC, asyP, asyB, maxTimeDays, etasAlpha, catalogCap,
                                                    mainSourceType, randomSeed) {
  var Mmin = 4.0, Mmax = mainMw - 0.5;
  if (!(asyP > 1)) asyP = 1.01;
  if (Mmax < Mmin + 0.5) Mmax = Mmin + 0.5;
  var cap = catalogCap || 200;
  var mainGeometry = Physics.buildFaultGeometry(mainLat, mainLng, mainMw, mainStrike, mainDip, mainDepth,
    {sourceType:mainSourceType || Physics.sourceType(mainDepth)});
  var fL = mainGeometry ? mainGeometry.L : Physics.faultLength(mainMw);
  var fW = mainGeometry ? mainGeometry.W : Physics.faultWidth(mainMw);
  var dipRad = mainDip * Math.PI / 180;
  var sinDip = Math.sin(dipRad); if (sinDip < 0.001) sinDip = 0.001;
  var strikeRad = mainStrike * Math.PI / 180;
  var dipDirRad = strikeRad + Math.PI / 2;
  var cosDip = Math.cos(dipRad);
  var cosLa = Math.max(0.0001, Math.cos(mainLat * Math.PI / 180));
  var hpFracAS = mainGeometry ? mainGeometry.hypocenterFrac : 0.35;

  function seededRand(seed) {
    var s = seed;
    return function() { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
  }
  var rng = seededRand((Math.floor(mainLat * 1000 + mainLng * 1000 + mainMw * 100) ^ ((Number(randomSeed) || 0) >>> 0)) >>> 0);

  // u1/u2 must start at 0 (not undefined) or the while loops below never run
  // and every ETAS child gets NaN coordinates/depth.
  function gauss() { var u1=0,u2=0,safety=0; while(u1===0&&safety++<100)u1=rng(); safety=0; while(u2===0&&safety++<100)u2=rng(); return Math.sqrt(-2*Math.log(Math.max(u1,1e-10)))*Math.cos(2*Math.PI*Math.max(u2,1e-10)); }

  var catalog = [];
  var queue = [{id: -1, time: 0, lat: mainLat, lng: mainLng, mag: mainMw, depth: mainDepth,
                alongStrike: 0, downDip: 0}]; // seed = mainshock

  while (queue.length > 0 && catalog.length < cap) {
    var parent = queue.shift();
    // Productivity: K * exp(alpha*(M-M0)) — magnitude-dependent triggering.
    // alpha defaults to the calibrated natural-log slope (ETAS_ALPHA_NATLOG).
    var alpha = (etasAlpha != null) ? etasAlpha : Physics.ETAS_ALPHA_NATLOG;
    var prod = (asyK/150) * Math.exp(alpha * (parent.mag - Mmin));
    var nChildren = Math.floor(prod + rng());
    nChildren = Math.min(nChildren, cap - catalog.length);
    if (nChildren < 1) continue;

    for (var ci = 0; ci < nChildren; ci++) {
      // Time from parent (Omori-Utsu)
      var u = rng();
      var tDelta = asyC * (Math.pow(u, -1 / (asyP - 1)) - 1);
      if (tDelta > maxTimeDays) tDelta = maxTimeDays * rng();
      var tSeconds = parent.time + tDelta * 86400;
      if (tSeconds > maxTimeDays * 86400) continue;

      // Magnitude (Gutenberg-Richter)
      var safeB = Math.max(0.01, asyB);
      var M = Mmin - Math.log(rng()) / (safeB * Math.LN10);
      if (M > Mmax) M = Mmax;
      if (M < Mmin) M = Mmin;

      // Spatial: near parent on fault plane
      var alongStrike = parent.alongStrike + (rng() - 0.5) * fL / 4 + gauss() * fL / 20;
      var downDip = parent.downDip + (rng() - 0.5) * fW / 4 + gauss() * fW / 10;
      downDip = Math.max(-hpFracAS * fW, Math.min((1 - hpFracAS) * fW, downDip));
      alongStrike = Math.max(-fL/2, Math.min(fL/2, alongStrike));
      var depth = mainDepth + downDip * sinDip + gauss() * 1;
      if (depth < 1) depth = 1;
      var dipHoriz = downDip * cosDip;
      var dLat_s = alongStrike * Math.cos(strikeRad) / 111.32;
      var dLng_s = alongStrike * Math.sin(strikeRad) / (111.32 * cosLa);
      var dLat_d = dipHoriz * Math.cos(dipDirRad) / 111.32;
      var dLng_d = dipHoriz * Math.sin(dipDirRad) / (111.32 * cosLa);

      var child = {
        id: catalog.length, time: tSeconds,
        lat: mainLat + dLat_s + dLat_d, lng: mainLng + dLng_s + dLng_d,
        mag: M, depth: depth,
        alongStrike: alongStrike, downDip: downDip
      };
      catalog.push(child);
      // Child can trigger its own aftershocks if above Mmin
      if (M >= Mmin && child.time < maxTimeDays * 86400) queue.push(child);
    }
  }
  catalog.sort(function(a, b) { return a.time - b.time; });
  // Strip internal fields before returning
  for (var i = 0; i < catalog.length; i++) {
    delete catalog[i].alongStrike; delete catalog[i].downDip;
  }
  return catalog;
};

/**
 * Aftershock catalog via Omori-Utsu (+ ETAS optional) + Gutenberg-Richter.
 * v4.3: ETAS branching process when etasEnable is truthy; also fixes asyK dead code.
 * v5.4: productivity magnitude slope calibrated (10^0.809/Mw, see
 *   AFTERSHOCK_PRODUCTIVITY_LOG10); ETAS alpha default = ETAS_ALPHA_NATLOG.
 * @param {number} mainMw @param {number} mainLat @param {number} mainLng
 * @param {number} strike @param {number} dip @param {number} depth
 * @param {number} asyK — productivity (used for nExpected now)
 * @param {number} asyC @param {number} asyP @param {number} asyB
 * @param {number} maxTimeDays
 * @param {boolean|number} etasEnable — 0=Omori-Utsu, 1=ETAS
 * @param {number} etasAlpha — magnitude-triggering efficiency (natural log; default ETAS_ALPHA_NATLOG)
 * @param {number} catalogCap — max catalog size (replaces hardcoded 50)
 * @returns {Array} Sorted catalog
 */
Physics.generateAftershockCatalog = function(mainMw, mainLat, mainLng, mainStrike, mainDip, mainDepth,
                                              asyK, asyC, asyP, asyB, maxTimeDays, etasEnable, etasAlpha, catalogCap,
                                              mainSourceType, randomSeed) {
  // v4.3: Branch to ETAS
  if (etasEnable) {
    return Physics._generateAftershockCatalogETAS(mainMw, mainLat, mainLng, mainStrike, mainDip, mainDepth,
                                                   asyK, asyC, asyP, asyB, maxTimeDays, etasAlpha, catalogCap || 200,
                                                   mainSourceType, randomSeed);
  }
  // --- Original Omori-Utsu path (v4.3: uses asyK + catalogCap) ---
  var Mmin = 4.0;
  if (!(asyP > 1)) asyP = 1.01;
  var Mmax = mainMw - 0.5;
  if (Mmax < Mmin + 0.5) Mmax = Mmin + 0.5;
  var cap = catalogCap || 50;
  // v4.3: Use asyK for nExpected instead of hardcoded formula (fixes dead code)
  // v5.4: magnitude slope is the calibrated 10^0.809 law (see
  // AFTERSHOCK_PRODUCTIVITY_LOG10 above) — 2^(M-5) under-scaled M8/M9
  // productivity by ~3x per magnitude.
  var prodScale = Math.pow(10, Physics.AFTERSHOCK_PRODUCTIVITY_LOG10 * (mainMw - 5));
  var nExpected = asyK > 0 ? Math.floor(asyK * prodScale / 150 * 20) :
    Math.floor(20 * prodScale);
  nExpected = Math.min(cap, Math.max(10, nExpected));
  var mainGeometry = Physics.buildFaultGeometry(mainLat, mainLng, mainMw, mainStrike, mainDip, mainDepth,
    {sourceType:mainSourceType || Physics.sourceType(mainDepth)});
  var fL = mainGeometry ? mainGeometry.L : Physics.faultLength(mainMw);
  var fW = mainGeometry ? mainGeometry.W : Physics.faultWidth(mainMw);
  var dipRad = mainDip * Math.PI / 180;
  var sinDip = Math.sin(dipRad); if (sinDip < 0.001) sinDip = 0.001;
  var strikeRad = mainStrike * Math.PI / 180;
  var dipDirRad = strikeRad + Math.PI / 2;
  var cosDip = Math.cos(dipRad);
  var cosLa = Math.max(0.0001, Math.cos(mainLat * Math.PI / 180));

  function seededRand(seed) {
    var s = seed;
    return function() { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
  }
  var rng = seededRand((Math.floor(mainLat * 1000 + mainLng * 1000 + mainMw * 100) ^ ((Number(randomSeed) || 0) >>> 0)) >>> 0);

  var catalog = [];
  for (var i = 0; i < nExpected; i++) {
    var u = rng();
    var tDays = asyC * (Math.pow(u, -1 / (asyP - 1)) - 1);
    if (tDays > maxTimeDays) tDays = maxTimeDays * rng();
    var tSeconds = tDays * 86400;
    var u2 = rng();
    var safeB = Math.max(0.01, asyB);
    var M = Mmin - Math.log(u2) / (safeB * Math.LN10);
    if (M > Mmax) M = Mmax;
    if (M < Mmin) M = Mmin;
    var alongStrike = (rng() - 0.5) * fL;
    var hpFracAS = mainGeometry ? mainGeometry.hypocenterFrac : 0.35;
    var downDip = (rng() - hpFracAS) * fW;
    function gauss() { var u1=0,u2=0,safety=0; while(u1===0&&safety++<100)u1=rng(); safety=0; while(u2===0&&safety++<100)u2=rng(); return Math.sqrt(-2*Math.log(Math.max(u1,1e-10)))*Math.cos(2*Math.PI*Math.max(u2,1e-10)); }
    alongStrike += gauss() * fL / 20;
    downDip += gauss() * fW / 10;
    downDip = Math.max(-hpFracAS * fW, Math.min((1 - hpFracAS) * fW, downDip));
    var depth = mainDepth + downDip * sinDip + gauss() * 1;
    if (depth < 1) depth = 1;
    alongStrike = Math.max(-fL/2, Math.min(fL/2, alongStrike));
    var dipHoriz = downDip * cosDip;
    var dLat_s = alongStrike * Math.cos(strikeRad) / 111.32;
    var dLng_s = alongStrike * Math.sin(strikeRad) / (111.32 * cosLa);
    var dLat_d = dipHoriz * Math.cos(dipDirRad) / 111.32;
    var dLng_d = dipHoriz * Math.sin(dipDirRad) / (111.32 * cosLa);
    catalog.push({
      id: i, time: tSeconds,
      lat: mainLat + dLat_s + dLat_d,
      lng: mainLng + dLng_s + dLng_d,
      mag: M, depth: depth
    });
  }
  catalog.sort(function(a, b) { return a.time - b.time; });
  return catalog;
};

/**
 * v5.5: merge user-defined manual aftershocks into a generated catalog.
 * Manual entries are plain {time, mag, depth} objects whose time is in
 * SIM seconds (when the aftershock should appear after the sim starts);
 * they are placed at the mainshock epicenter and converted to the catalog's
 * compressed time base (multiplied by timeScale = Aftershock AS_TIME_SCALE).
 * @param {Array} catalog — output of generateAftershockCatalog (may be empty)
 * @param {Array} manual — [{time (sim s), mag, depth}]
 * @param {number} lat @param {number} lng — mainshock epicenter
 * @param {number} timeScale — Aftershock.AS_TIME_SCALE (21600)
 * @returns {Array} new catalog, sorted by time; manual entries carry manual:true
 */
Physics.mergeManualAftershocks = function(catalog, manual, lat, lng, timeScale) {
  var base = Array.isArray(catalog) ? catalog.slice() : [];
  if (!Array.isArray(manual) || !manual.length) {
    base.sort(function(a, b) { return a.time - b.time; });
    return base;
  }
  var ts = (isFinite(timeScale) && timeScale > 0) ? timeScale : 21600;
  var out = base.slice();
  for (var i = 0; i < manual.length; i++) {
    var m = manual[i] || {};
    var tSim = Math.max(0, Number(m.time) || 0);
    var mag = Number(m.mag), dep = Number(m.depth);
    if (!isFinite(mag) || !isFinite(dep)) continue;
    mag = Math.min(9.5, Math.max(3.0, mag));
    dep = Math.min(700, Math.max(0, dep));
    // v5.5: an entry may carry its own epicenter (map-picked); default is the
    // mainshock epicenter.
    var mLat = isFinite(Number(m.lat)) ? Number(m.lat) : lat;
    var mLng = isFinite(Number(m.lng)) ? Number(m.lng) : lng;
    out.push({
      id: 'man' + i, time: tSim * ts,
      lat: mLat, lng: mLng,
      mag: mag, depth: dep, manual: true
    });
  }
  out.sort(function(a, b) { return a.time - b.time; });
  return out;
};

// ================================================================
//  BUILDING DAMAGE
// ================================================================

Physics.estimateBuildingsForStation = function(name) {
  var tier = Physics.CITY_TIERS[name] || 4;
  var total = Physics.TIER_BUILDINGS[tier] || 10000;
  return { wooden: Math.round(total * 0.7), rc: Math.round(total * 0.3) };
};

/**
 * Building damage from fragility curves. @param {Array} circles - Station intensity data @returns {object} Damage estimates in building units
 */
Physics.aggregateBuildingDamage = function(visibleCircles) {
  var result = { wooden_total: 0, wooden_partial: 0, rc_total: 0, rc_partial: 0 };
  for (var i = 0; i < visibleCircles.length; i++) {
    var c = visibleCircles[i];
    if (c.shindo === 0) continue;
    var bld = Physics.estimateBuildingsForStation(c.name);
    var wf = Physics.FRAGILITY_WOODEN[c.shindo] || {total: 0, partial: 0};
    var rf = Physics.FRAGILITY_RC[c.shindo] || {total: 0, partial: 0};
    result.wooden_total += bld.wooden * wf.total;
    result.wooden_partial += bld.wooden * wf.partial;
    result.rc_total += bld.rc * rf.total;
    result.rc_partial += bld.rc * rf.partial;
  }
  return result;
};

// ================================================================
//  FORMATTING
// ================================================================

Physics.supNum = function(n) {
  return String(n).split('').map(function(ch){return _SUP[ch]||ch;}).join('');
};

Physics.fmtSci = function(x) {
  if(!(x>0)||!isFinite(x)) return '0';
  var e=Math.floor(Math.log10(x)); var m=x/Math.pow(10,e);
  return m.toFixed(2)+'×10'+Physics.supNum(e);
};

Physics.fmtTNT = function(t) {
  if(t>=1e9) return (t/1e9).toFixed(1)+' Gt';
  if(t>=1e6) return (t/1e6).toFixed(1)+' Mt';
  if(t>=1e3) return (t/1e3).toFixed(1)+' kt';
  return Math.round(t)+' t';
};

// ================================================================
//  BRUNE ω² STOCHASTIC METHOD (Boore 2003)
// ================================================================

// Corner frequency (Hz) — Brune (1970)
Physics.cornerFrequency = function(Mw, stressDropMPa, beta) {
  if (!beta) beta = 3.5; // km/s
  var M0 = Physics.seismicMoment(Mw);
  // Brune/Boore relation: beta [km/s], stress drop [bar], M0 [dyne-cm].
  var dSigmaBar = Math.max(0.01, stressDropMPa || 10) * 10;
  var momentDyneCm = M0 * 1e7;
  return 4.9e6 * beta * Math.pow(dSigmaBar / momentDyneCm, 1.0 / 3.0);
};

// Physical duration: T_source + T_path (seconds)
Physics.physicalDuration = function(Mw, distKm, stressDropMPa) {
  var f0 = Physics.cornerFrequency(Mw, stressDropMPa || 10);
  var Tsource = 1.0 / Math.max(f0, 0.01);
  var Tpath = 0.05 * distKm;
  return Tsource + Tpath;
};

// Brune ω² source amplitude spectrum (displacement)
// Returns amplitude at frequency f (Hz) in relative units
Physics.bruneSpectrum = function(f, Mw, stressDropMPa, beta) {
  var M0 = Physics.seismicMoment(Mw);
  var f0 = Physics.cornerFrequency(Mw, stressDropMPa, beta);
  // Acceleration spectrum: A(f) = C * M0 * (2πf)² / [1 + (f/f0)²]
  var omega = 2 * Math.PI * f;
  var source = M0 * omega * omega / (1 + (f / f0) * (f / f0));
  return source;
};

// Q(f) frequency-dependent attenuation — path effect
// Returns attenuation factor (0-1) for given frequency and distance
Physics.qAttenuation = function(f, distKm, Q0, eta, beta) {
  if (!Q0) Q0 = 200;   // Japan crust typical
  if (!eta) eta = 0.7;
  if (!beta) beta = 3.5; // km/s
  var Q = Q0 * Math.pow(Math.max(f, 0.01), eta);
  return Math.exp(-Math.PI * f * distKm / (Q * beta));
};

// Geometric spreading
Physics.geometricSpreading = function(distKm) {
  if (distKm <= 40) return 1.0 / Math.max(distKm, 1);
  if (distKm <= 120) return (1.0 / 40) * Math.pow(40 / distKm, 0.5);
  return (1.0 / 40) * Math.pow(40 / 120, 0.5) * Math.pow(120 / distKm, 0.5);
};

// Full amplitude spectrum A(f) = Source × Path × Site
Physics.fullSpectrum = function(f, Mw, distKm, stressDropMPa, siteAmp, Q0, eta) {
  var src = Physics.bruneSpectrum(f, Mw, stressDropMPa);
  var geo = Physics.geometricSpreading(distKm);
  var qAtt = Physics.qAttenuation(f, distKm, Q0, eta);
  var sa = siteAmp || 1.0;
  return src * geo * qAtt * sa;
};

/** Three-component stochastic carrier for JMA filtering and SDOF spectra. */
Physics.synthesizeWaveform3C = function(Mw, distKm, stressDropMPa, siteAmp, duration, sampleRate, seed) {
  sampleRate = sampleRate || 50;
  duration = duration || Physics.physicalDuration(Mw, distKm, stressDropMPa);
  duration = Math.max(2, Math.min(duration, 180));
  var n=Math.max(10,Math.floor(duration*sampleRate)), nFreq=96;
  var fMin=0.1, fMax=Math.min(20,sampleRate*0.45), freqs=[], amps=[], phases=[[],[],[]], norm2=0;
  var state=(seed==null?Math.floor((Mw*1000+distKm*17)*1000):seed)>>>0;
  function rand(){state=(1664525*state+1013904223)>>>0;return state/4294967296;}
  for(var i=0;i<nFreq;i++){
    var f=Math.exp(Math.log(fMin)+(Math.log(fMax)-Math.log(fMin))*i/(nFreq-1));
    var amp=Physics.fullSpectrum(f,Mw,distKm,stressDropMPa,siteAmp,200,0.7);
    freqs.push(f);amps.push(amp);norm2+=amp*amp;
    for(var c0=0;c0<3;c0++)phases[c0].push(rand()*2*Math.PI);
  }
  var norm=Math.sqrt(Math.max(norm2,1e-30)),x=[],y=[],z=[];
  var f0=Physics.cornerFrequency(Mw,stressDropMPa||10);
  var rise=Math.min(duration*0.2,Math.max(0.5,1/Math.max(f0,0.01))),strong=duration*0.45;
  function env(t){if(t<rise)return Math.pow(t/Math.max(rise,0.01),2);if(t<rise+strong)return 1;return Math.exp(-3*(t-rise-strong)/Math.max(duration-rise-strong,0.1));}
  for(var j=0;j<n;j++){
    var t=j/sampleRate,vals=[0,0,0];
    for(var k0=0;k0<nFreq;k0++){
      var an=amps[k0]/norm;
      for(var c1=0;c1<3;c1++)vals[c1]+=an*Math.sin(2*Math.PI*freqs[k0]*t+phases[c1][k0]);
    }
    var e=env(t);x.push(vals[0]*e);y.push(vals[1]*e);z.push(vals[2]*e*0.7);
  }
  return{x:x,y:y,z:z,sampleRate:sampleRate,duration:duration,normalized:true};
};

// Synthesize time-domain waveform using spectral method
// Returns array of {t, a} acceleration samples
Physics.synthesizeWaveform = function(Mw, distKm, stressDropMPa, siteAmp, duration, sampleRate, seed) {
  if (!sampleRate) sampleRate = 50; // Hz
  if (!duration) duration = Physics.physicalDuration(Mw, distKm, stressDropMPa);
  duration = Math.min(duration, 60); // cap at 60s
  var N = Math.floor(duration * sampleRate);
  if (N < 10) N = 10;
  var dt = 1.0 / sampleRate;

  // Frequency bins (configurable; defaults reproduce prior 40 / 0.5–20 Hz)
  var nFreq = Math.max(2, (typeof cfgGet === 'function') ? Math.round(cfgGet('spectrumBins')) : 40);
  var fMin = (typeof cfgGet === 'function') ? cfgGet('spectrumFMin') : 0.5;
  var fMax = (typeof cfgGet === 'function') ? cfgGet('spectrumFMax') : 20;
  var logFMin = Math.log(fMin), logFMax = Math.log(fMax);

  var phaseState = (seed == null ? Math.floor((Mw * 1000 + distKm * 17) * 1000) : Number(seed)) >>> 0;
  function phaseRand() { phaseState = (Math.imul(1664525, phaseState) + 1013904223) >>> 0; return phaseState / 4294967296; }
  // Compute spectral amplitudes + deterministic random phases
  var amps = [], phases = [], freqs = [];
  var maxAmp = 0;
  for (var i = 0; i < nFreq; i++) {
    var f = Math.exp(logFMin + (logFMax - logFMin) * i / (nFreq - 1));
    var A = Physics.fullSpectrum(f, Mw, distKm, stressDropMPa, siteAmp,
      (typeof cfgGet === 'function') ? cfgGet('faultQ0') : 200,
      (typeof cfgGet === 'function') ? cfgGet('faultQeta') : 0.7);
    var phi = phaseRand() * 2 * Math.PI;
    freqs.push(f); amps.push(A); phases.push(phi);
    if (A > maxAmp) maxAmp = A;
  }

  // Normalize amplitudes
  if (maxAmp > 0) for (var i = 0; i < nFreq; i++) amps[i] /= maxAmp;

  // Envelope function (Saragoni-Hart)
  var f0 = Physics.cornerFrequency(Mw, stressDropMPa || 10);
  var tRise = Math.min(0.2 * duration, 1.0 / f0);
  var tHold = 0.4 * duration;
  var tDecay = duration - tRise - tHold;

  function envelope(t) {
    if (t < tRise) return Math.pow(t / tRise, 2);
    if (t < tRise + tHold) return 1.0;
    var td = t - tRise - tHold;
    return Math.exp(-3 * td / Math.max(tDecay, 0.1));
  }

  // Synthesize: sum of sinusoids × envelope
  var samples = [];
  for (var n = 0; n < N; n++) {
    var t = n * dt;
    var acc = 0;
    for (var k = 0; k < nFreq; k++) {
      acc += amps[k] * Math.sin(2 * Math.PI * freqs[k] * t + phases[k]);
    }
    acc *= envelope(t);
    samples.push({t: t, a: acc});
  }
  return samples;
};

return Physics;
}));
