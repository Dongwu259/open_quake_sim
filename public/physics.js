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

// v6.7 source-classification batch: regional subduction-front polylines for
// the global-mode pilot regions — the same tectonic prior role as the Japan
// lines above (offshore + within 140 km -> interplate in resolveSourceTypeAt,
// strike prior in selectFaultPlane). Approximate trench/deformation-front
// axes from published plate-boundary geometry (USGS/Bird/slab2 family);
// priors only — preset sourceType fields and explicit overrides win.
// italy intentionally carries NO front: its catalog is Apennine shallow-
// crustal and the Calabrian slab resolves via the depth>=60 rule.
Physics.REGIONAL_SUBDUCTION_LINES = {
  // Peru-Chile trench (megathrust: Valdivia/Maule/Illapel/Iquique class)
  chile: [[-18.0,-71.5],[-20.5,-71.0],[-23.0,-71.2],[-25.5,-71.4],[-28.0,-71.7],[-30.5,-72.0],[-33.0,-72.3],[-35.5,-73.0],[-38.0,-73.9],[-40.5,-74.4],[-43.0,-74.6],[-45.5,-74.9]],
  // Ryukyu trench (east of Hualien) + Manila trench (south of the island)
  taiwan: [[[23.2,122.4],[23.9,122.9],[24.6,123.5],[25.3,124.3]],[[20.3,119.3],[21.0,119.9],[21.7,120.5],[22.3,121.0]]],
  // Hikurangi trough (east of North Island) + Puysegur-Fiordland (SW)
  newzealand: [[[-36.8,178.7],[-38.0,179.0],[-39.3,178.5],[-40.5,177.3],[-41.5,175.6],[-42.3,174.6]],[[-45.2,166.7],[-46.3,165.6],[-47.4,164.6],[-48.4,163.8]]],
  // Cascadia deformation front, southern segment off Cape Mendocino; the
  // San Andreas system itself is crustal strike-slip and gets no front.
  california: [[40.3,-124.9],[41.3,-124.9],[42.4,-125.1]],
  // Ecuador-Colombia trench (northern Peru-Chile trench segment): Pedernales
  // 2016 / Esmeraldas 1906 / Tumaco 1979 megathrust class. Approximate axis
  // ~100-130 km offshore, Gulf of Guayaquil (S) to Buenaventura (N).
  // 2026-10-14 new-region batch.
  ecuador: [[-5.2,-81.8],[-4.5,-81.7],[-3.8,-81.6],[-3.0,-81.5],[-2.2,-81.4],[-1.4,-81.2],[-0.6,-80.9],[0.2,-80.7],[0.8,-80.3],[1.4,-79.9],[2.0,-79.6],[2.6,-79.3]]
};
var _activeSubductionLines = null; // null -> Japan lines (legacy byte-identical)
/** Region activation hook: swap the subduction-front prior set. Pass null (or
 *  nothing) to restore the Japan default. Values from REGIONAL_SUBDUCTION_LINES. */
Physics.setActiveSubductionLines = function(lines) {
  _activeSubductionLines = (lines && lines.length) ? lines : null;
};
// Registry shape: a region may carry one polyline or several (taiwan and
// newzealand carry two fronts each) — normalize to a list of polylines.
function _frontLineSet(entry) {
  if (!entry || !entry.length) return null;
  return (typeof entry[0][0] === 'number') ? [entry] : entry;
}

function _nearestFrontOnLines(lines, lat, lng) {
  var cosLat = Math.max(0.2, Math.cos(Number(lat) * Math.PI / 180));
  var best = {distanceKm:Infinity, strikeDeg:null, lineIndex:-1, segmentIndex:-1};
  if (!lines) return best;
  for (var li = 0; li < lines.length; li++) {
    for (var i = 1; i < lines[li].length; i++) {
      var a = lines[li][i - 1], b = lines[li][i];
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
}

Physics.nearestJapanSubduction = function(lat, lng) {
  return _nearestFrontOnLines(_JAPAN_SUBDUCTION_LINES, lat, lng);
};

/** Nearest ACTIVE subduction front: the active region's registered lines,
 *  else the Japan lines (identical loop, identical numbers on the legacy
 *  path). */
Physics.nearestSubductionFront = function(lat, lng) {
  return _nearestFrontOnLines(_frontLineSet(_activeSubductionLines) || _JAPAN_SUBDUCTION_LINES, lat, lng);
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
  if (offshore && isFinite(lat) && isFinite(lng) && Physics.nearestSubductionFront(lat, lng).distanceKm <= 140) {
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
      // Active-region aware (v6.7): regional fronts while a region is active,
      // Japan lines otherwise — same numbers on the legacy path.
      prior = Physics.nearestSubductionFront(Number(context.lat), Number(context.lng));
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
    // v6.2 tier-2: an explicit faultPath (surface-trace polyline, >= 2 nodes)
    // builds a segmented bent geometry instead of the single planar rectangle
    if (Array.isArray(params.faultPath) && params.faultPath.length >= 2 &&
        typeof Physics.genSegmentedFault === 'function') {
      var segOpts = {};
      for (var so in (faultOptions || {})) segOpts[so] = faultOptions[so];
      if (segOpts.dipDeg == null) segOpts.dipDeg = dip;
      if (segOpts.depthKm == null) segOpts.depthKm = depth;
      if (segOpts.rakeDeg == null && params.rakeDeg != null) segOpts.rakeDeg = params.rakeDeg;
      geometry = Physics.genSegmentedFault(params.faultPath, mw, segOpts);
    } else if (params.generateSubSources === true && typeof Physics.genSubSources === 'function') {
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

// v6.7 NGA-West2 batch: active-region hook for the auto GMPE route. null ->
// Japan (legacy byte-identical). A non-Japan region id re-routes shallow
// CRUSTAL events from si-midorikawa (Japan-calibrated) to BSSA14 (NGA-West2,
// the active-shallow-crust model). v6.8 NGA-Sub batch: the same hook
// re-routes interplate/intraslab events from zhao2006 (Japan-calibrated) to
// Parker et al. 2022 (NGA-Sub, with the region's frozen variant).
var _activeGmpRegion = null;
Physics.setActiveGmpRegion = function(regionId) { _activeGmpRegion = regionId || null; };
Physics.activeGmpRegion = function() { return _activeGmpRegion; };
// BSSA14 regional anelastic variant for the active region: the paper only
// publishes regional Dc3 adjustments for Japan/Italy (LowQ) and China/Turkey
// (HighQ); every other bundled region keeps the base (global) path term.
Physics.activeBssa2014Variant = function() {
  if (!_activeGmpRegion || _activeGmpRegion === 'japan' || _activeGmpRegion === 'italy') return 'lowQ';
  return 'base';
};

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
  if (src === 'interplate' || src === 'intraslab') {
    // v6.8: outside Japan, subduction events route to NGA-Sub (Parker 2022) —
    // zhao2006 is Japan-calibrated and was never validated on regional
    // subduction (regional scorecard measured Chile PGA bias -0.551 with it).
    if (_activeGmpRegion && _activeGmpRegion !== 'japan') return 'ngasub';
    return 'zhao2006';
  }
  // v6.7: outside Japan, crustal events route to BSSA14 (NGA-West2) — the
  // si-midorikawa model is Japan-calibrated and was never validated offshore.
  if (_activeGmpRegion && _activeGmpRegion !== 'japan') return 'bssa14';
  return 'si-midorikawa';
};

Physics.calcPGA = function(mag, Rkm, gmpModel, depthKm, eventMw, sliderMw, epicenterSrc, attA, attB, attC, anelastic, vs30, rake, dipDeg) {
  if (Rkm <= 0.5) Rkm = 0.5;
  var mw = (eventMw != null) ? (mag + (eventMw - sliderMw)) : mag;
  var src = epicenterSrc || Physics.sourceType(depthKm);
  gmpModel = Physics.resolveGmpModel(gmpModel, src, mw);
  if (gmpModel === 'kanno2006') return Physics.pgaKanno(mw, Rkm, depthKm, vs30 || 400);
  // BSSA14 (NGA-West2): Rkm is interpreted as Rjb (callers pass the
  // horizontal distance; see the model block for the metric note). Depth is
  // not a predictor — the h pseudo-depth carries it.
  if (gmpModel === 'bssa14') return Physics.pgaBssa2014(mw, Rkm, vs30 || 400, rake, Physics.activeBssa2014Variant());
  // NGA-Sub (Parker 2022): Rkm is Rrup (same metric convention as zhao2006
  // in this engine); depthKm feeds the intraslab depth scaling.
  if (gmpModel === 'ngasub') {
    var ntrtP = (src === 'intraslab') ? 'intraslab' : 'interface';
    return Physics.pgaParker2022(mw, Rkm, vs30 || 400, ntrtP, depthKm, Physics.activeNgasubVariant());
  }
  // NGA-West2 CY14/CB14/ASK14 (v7.x batch): Rkm reads as Rjb (the bssa14
  // branch convention); the shared point-source geometry derives Rrup from
  // the source depth as ztor, sets Rx = Rjb / Ry0 = 0 and defaults dip to the
  // crustal prior 60 deg (documented on the model block). Regional crustal
  // use; the Japan auto route never resolves to these.
  if (gmpModel === 'cy14') return Physics.pgaCy2014(mw, Physics.nw2PointGeom(mw, Rkm, depthKm, vs30 || 400, rake, dipDeg));
  if (gmpModel === 'cb14') return Physics.pgaCb2014(Physics.nw2PointGeom(mw, Rkm, depthKm, vs30 || 400, rake, dipDeg));
  if (gmpModel === 'ask14') return Physics.pgaAsk2014(Physics.nw2PointGeom(mw, Rkm, depthKm, vs30 || 400, rake, dipDeg));
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
Physics.calcPGV = function(mag, Rkm, gmpModel, depthKm, eventMw, sliderMw, epicenterSrc, anelastic, vs30, rake, dipDeg) {
  if (Rkm <= 0.5) Rkm = 0.5;
  var mw = (eventMw != null) ? (mag + (eventMw - sliderMw)) : mag;
  var src = epicenterSrc || Physics.sourceType(depthKm);
  gmpModel = Physics.resolveGmpModel(gmpModel, src, mw);
  if (gmpModel === 'kanno2006') return Physics.pgvKanno(mw, Rkm, depthKm, vs30 || 400);
  if (gmpModel === 'bssa14') return Physics.pgvBssa2014(mw, Rkm, vs30 || 400, rake, Physics.activeBssa2014Variant());
  if (gmpModel === 'ngasub') {
    var ntrtV = (src === 'intraslab') ? 'intraslab' : 'interface';
    return Physics.pgvParker2022(mw, Rkm, vs30 || 400, ntrtV, depthKm, Physics.activeNgasubVariant());
  }
  // NGA-West2 CY14/CB14/ASK14 (v7.x batch): Rkm reads as Rjb — see calcPGA.
  if (gmpModel === 'cy14') return Physics.pgvCy2014(mw, Physics.nw2PointGeom(mw, Rkm, depthKm, vs30 || 400, rake, dipDeg));
  if (gmpModel === 'cb14') return Physics.pgvCb2014(Physics.nw2PointGeom(mw, Rkm, depthKm, vs30 || 400, rake, dipDeg));
  if (gmpModel === 'ask14') return Physics.pgvAsk2014(Physics.nw2PointGeom(mw, Rkm, depthKm, vs30 || 400, rake, dipDeg));
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

// Alias used by the intensity-scale conversions (shindoToMMI/shindoToEMS): a
// numeric JMA intensity is first bucketed to its discrete Shindo level.
Physics.shindoLabel = Physics.intensityToShindo;

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
function _shPropagate(profile, freqs) {
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
    out.push(cDiv({ re: 1, im: 0 }, denom));
  }
  return out;
}
Physics.shTransferFunction = function(profile, freqs) {
  var complex = _shPropagate(profile, freqs);
  if (!complex) return null;
  return complex.map(cAbs);
};
// Complex A(f) for frequency-domain convolution (SHAKE-style benchmark):
// same propagator, phase preserved. Returns {re, im} arrays or null.
Physics.shTransferComplex = function(profile, freqs) {
  var complex = _shPropagate(profile, freqs);
  if (!complex) return null;
  return { re: complex.map(function(c) { return c.re; }), im: complex.map(function(c) { return c.im; }) };
};

// Public alias of the tabulated-curve interpolation for research tooling
// (frozen external benchmarks interpolate the case's own curve tables).
Physics.interpolateLayerCurve = function(curve, strainPct) { return _interpLayerCurve(curve, strainPct); };

// Per-layer shear-strain transfer, SHAKE-style full frequency-domain strain:
// γ_m(f) = T_m(f)·F(f), where F is the halfspace-outcrop acceleration
// spectrum in g and T_m maps it to layer-m mid-depth shear strain (decimal).
// Derivation: the propagator state (u dimensionless, τ ~ Zω) gives
// γ_rel = τ/μ* per unit surface displacement; the surface/outcrop
// normalization A(f) = 1/(u_b + τ_b/(iZ_bω)) and the displacement spectrum
// D_in = -F·9.81/ω² combine to T_m = -(9.81/ω²)·A·γ_rel,m.
// Research path for the external benchmark ladder; production
// siteResponse1D keeps its bounded single-frequency strain proxy.
// Returns an array of nLayers {re, im} arrays, or null.
Physics.shStrainTransfers = function(profile, freqs) {
  if (!profile || profile.length < 2 || !freqs || !freqs.length) return null;
  var layers = [];
  for (var i = 0; i < profile.length; i++) {
    var p = profile[i];
    var vs = Number(p.vs);
    if (!(vs > 0)) return null;
    var zeta = p.damping == null ? 0.02 : Number(p.damping);
    var rho = p.density == null ? Physics.densityFromVs(vs) : Number(p.density);
    if (!(rho > 0)) return null;
    layers.push({ vsC: { re: vs, im: vs * zeta }, rho: rho, thickness: Number(p.thickness) });
  }
  var bed = layers[layers.length - 1];
  var Zb = cScale(bed.vsC, bed.rho);
  var nSoil = layers.length - 1;
  var out = [];
  for (var m = 0; m < nSoil; m++) out.push({ re: [], im: [] });
  for (var k = 0; k < freqs.length; k++) {
    var w = 2 * Math.PI * freqs[k];
    if (!(w > 0)) return null;
    var u = { re: 1, im: 0 }, tau = { re: 0, im: 0 };
    for (var m2 = 0; m2 < nSoil; m2++) {
      var L = layers[m2];
      if (!(L.thickness > 0)) continue; // zero-thickness layer: identity
      var Zm = cScale(L.vsC, L.rho);
      var mu = cMul(L.vsC, cScale(L.vsC, L.rho)); // mu* = rho * Vs*^2
      var aHalf = cDiv(cScale({ re: w * L.thickness / 2, im: 0 }, 1), L.vsC);
      var ca = cCos(aHalf), sa = cSin(aHalf);
      // mid-layer state: propagate h/2 from the layer top
      var uMid = cAdd(cMul(u, ca), cDiv(cMul(tau, sa), cScale(Zm, w)));
      var tauMid = cAdd(cMul(tau, ca), cNeg(cMul(cScale(Zm, w), cMul(u, sa))));
      var gRel = cDiv(tauMid, mu); // strain per unit surface displacement
      // continue to the layer bottom (same step again, from the mid state)
      u = cAdd(cMul(uMid, ca), cDiv(cMul(tauMid, sa), cScale(Zm, w)));
      tau = cAdd(cMul(tauMid, ca), cNeg(cMul(cScale(Zm, w), cMul(uMid, sa))));
      out[m2]._uBottom = u; out[m2]._tauBottom = tau; // stash for A below
      out[m2]._gRel = gRel;
    }
    // normalization: A(f) for unit outcrop input (state at halfspace top)
    var denom = cAdd(u, cDiv(tau, cMul(cScale(Zb, w), { re: 0, im: 1 })));
    var A = cDiv({ re: 1, im: 0 }, denom);
    var amp2acc = -9.81 / (w * w); // displacement-per-acceleration + sign
    for (var m3 = 0; m3 < nSoil; m3++) {
      var t = cMul(cScale(out[m3]._gRel, amp2acc), A);
      out[m3].re.push(t.re); out[m3].im.push(t.im);
      delete out[m3]._gRel; delete out[m3]._uBottom; delete out[m3]._tauBottom;
    }
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
// Log10-strain piecewise-linear interpolation of a published tabulated
// curve set ({strainPct, ggmax, dampingPct}); clamps outside the table.
// Used by the frozen external benchmark (Seed & Sun clay / Seed & Idriss
// sand + Idriss 1990 damping). Returns {ggmax, damping} (damping decimal).
function _interpLayerCurve(curve, strainPct) {
  var s = curve.strainPct, g = curve.ggmax, d = curve.dampingPct;
  var lg = Math.log10(Math.max(1e-7, strainPct));
  var lo = 0;
  while (lo < s.length - 1 && Math.log10(s[lo + 1]) < lg) lo++;
  var hi = Math.min(s.length - 1, lo + 1);
  var lgLo = Math.log10(s[lo]), lgHi = Math.log10(s[hi]);
  var t = lgHi > lgLo ? (lg - lgLo) / (lgHi - lgLo) : 0;
  t = Math.min(1, Math.max(0, t));
  var gg = g[lo] + t * (g[hi] - g[lo]);
  // damping keeps its own strain grid (terminal 3.16% vs 3% on G/Gmax)
  var ds = curve.dampingStrainPct || curve.strainPct;
  var dl = 0;
  while (dl < ds.length - 1 && ds[dl + 1] < strainPct) dl++;
  var dh = Math.min(ds.length - 1, dl + 1);
  var sLo = ds[dl], sHi = ds[dh];
  var td = sHi > sLo ? (strainPct - sLo) / (sHi - sLo) : 0;
  td = Math.min(1, Math.max(0, td));
  var damp = d[dl] + td * (d[dh] - d[dl]);
  return { ggmax: gg, damping: damp / 100 };
}

Physics.siteResponse1D = function(profile, freqs, opts) {
  if (!profile || profile.length < 2 || !freqs || !freqs.length) return null;
  var o = opts || {};
  var pgaG = Number(o.rockPgaG);
  if (!(pgaG > 0)) return null;
  var effRatio = Number(o.effStrainRatio) > 0 ? Number(o.effStrainRatio) : 0.65;
  var maxIter = Math.min(30, Math.max(1, Number(o.maxIter) || 12));
  var tol = Number(o.tol) > 0 ? Number(o.tol) : 0.02;
  // Per-layer published curve sets override the Darendeli default (external
  // benchmark runs the case's own Seed-Idriss/Seed-Sun tables); entries may
  // be null to keep Darendeli for that layer.
  var layerCurves = o.layerCurves || null;

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
      var targetGg, newD;
      var lc = layerCurves && layerCurves[m];
      if (lc) {
        var tab = _interpLayerCurve(lc, gam * 100);
        targetGg = tab.ggmax; newD = Math.min(0.25, tab.damping);
      } else {
        var curves = Physics.darendeliCurves(gam, { pi: L.pi, sigmaEffKPa: L.sig, freqHz: f0 });
        targetGg = curves.ggmax[0]; newD = Math.min(0.25, curves.damping[0]);
      }
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
// Tables 3/4/5 period-pair correlation matrices (16 periods 0.05-5 s) fitted
// on Japanese K-NET/KiK-net ground motions by Jayaram et al. (2011),
// transcribed and validation-gated by tools/parse-jayaram2011-tables.js
// (Table 5 subduction slab joined 2026-08-25; registries without it keep the
// documented interface fallback). Without the registry, rho degenerates to
// the same-paper Eq.(6) orthogonal-component correlation (already verified
// and shipped) — a documented approximation, never a silent one.
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
  var cls = sourceType === 'crustal' ? 'crustal'
    : (sourceType === 'slab' || sourceType === 'intraslab') ? 'slab' : 'interface';
  if (!doc.classes[cls]) cls = doc.classes.interface ? 'interface' : 'crustal';
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
// v6.1 P2 (2026-09-01): extended to ALL 21 hazardlib IMTs (pga + 20 SA
// periods 0.05-5.00 s), transcribed verbatim from the SAME frozen hazardlib
// source (gem/oq-engine zhao_2006.py, sha256 3322dd09...ac88ec9 — verified
// identical at fetch time). Every row asserted point-wise against the
// regenerated fixtures in tests/gmpe-benchmarks.test.js. 'sa1' is kept as a
// label alias of the 1.00 s row (fixture back-compat).
Physics.ZHAO2006_PAPER = {
  'pga': {
    a: 1.101, b: -0.00564, c: 0.0055, d: 1.08, e: 0.01412, fr: 0.251,
    site: [0.293, 1.111, 1.344, 1.355, 1.42],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: 0.0, wi: 0.0, tau: 0.308 },
    slab:   { ss: 2.607, ssl: -0.528, ps: 0.1392, qs: 0.1584, ws: -0.0529, tau: 0.321 },
    tau: 0.303, sigma: 0.604
  },
  '0.05': {
    a: 1.076, b: -0.00671, c: 0.0075, d: 1.06, e: 0.01463, fr: 0.251,
    site: [0.939, 1.684, 1.793, 1.747, 1.814],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: 0.0, wi: 0.0, tau: 0.343 },
    slab:   { ss: 2.764, ssl: -0.551, ps: 0.1636, qs: 0.1932, ws: -0.0841, tau: 0.378 },
    tau: 0.326, sigma: 0.64
  },
  '0.10': {
    a: 1.118, b: -0.00787, c: 0.009, d: 1.083, e: 0.01423, fr: 0.24,
    site: [1.499, 2.061, 2.135, 2.031, 2.082],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: 0.0, wi: 0.0, tau: 0.403 },
    slab:   { ss: 2.156, ssl: -0.42, ps: 0.169, qs: 0.2057, ws: -0.0877, tau: 0.42 },
    tau: 0.342, sigma: 0.694
  },
  '0.15': {
    a: 1.134, b: -0.00722, c: 0.01, d: 1.053, e: 0.01509, fr: 0.251,
    site: [1.462, 1.916, 2.168, 2.052, 2.113],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: -0.0138, wi: 0.0286, tau: 0.367 },
    slab:   { ss: 2.161, ssl: -0.431, ps: 0.1669, qs: 0.1984, ws: -0.0773, tau: 0.372 },
    tau: 0.331, sigma: 0.702
  },
  '0.20': {
    a: 1.147, b: -0.00659, c: 0.012, d: 1.014, e: 0.01462, fr: 0.26,
    site: [1.28, 1.669, 2.085, 2.001, 2.03],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: -0.0256, wi: 0.0352, tau: 0.328 },
    slab:   { ss: 1.901, ssl: -0.372, ps: 0.1631, qs: 0.1856, ws: -0.0644, tau: 0.324 },
    tau: 0.312, sigma: 0.692
  },
  '0.25': {
    a: 1.149, b: -0.0059, c: 0.014, d: 0.966, e: 0.01459, fr: 0.269,
    site: [1.121, 1.468, 1.942, 1.941, 1.937],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: -0.0348, wi: 0.0403, tau: 0.289 },
    slab:   { ss: 1.814, ssl: -0.36, ps: 0.1588, qs: 0.1714, ws: -0.0515, tau: 0.294 },
    tau: 0.298, sigma: 0.682
  },
  '0.30': {
    a: 1.163, b: -0.0052, c: 0.015, d: 0.934, e: 0.01458, fr: 0.259,
    site: [0.852, 1.172, 1.683, 1.808, 1.77],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: 0.0, qi: -0.0423, wi: 0.0445, tau: 0.28 },
    slab:   { ss: 2.181, ssl: -0.45, ps: 0.1544, qs: 0.1573, ws: -0.0395, tau: 0.284 },
    tau: 0.3, sigma: 0.67
  },
  '0.40': {
    a: 1.2, b: -0.00422, c: 0.01, d: 0.959, e: 0.01257, fr: 0.248,
    site: [0.365, 0.655, 1.127, 1.482, 1.397],
    asc:    { qc: 0.0, wc: 0.0 },
    inter:  { si: -0.041, qi: -0.0541, wi: 0.0511, tau: 0.271 },
    slab:   { ss: 2.432, ssl: -0.506, ps: 0.146, qs: 0.1309, ws: -0.0183, tau: 0.278 },
    tau: 0.346, sigma: 0.659
  },
  '0.50': {
    a: 1.25, b: -0.00338, c: 0.006, d: 1.008, e: 0.01114, fr: 0.247,
    site: [-0.207, 0.071, 0.515, 0.934, 0.955],
    asc:    { qc: -0.0126, wc: 0.0116 },
    inter:  { si: -0.053, qi: -0.0632, wi: 0.0562, tau: 0.277 },
    slab:   { ss: 2.629, ssl: -0.554, ps: 0.1381, qs: 0.1078, ws: -0.0008, tau: 0.272 },
    tau: 0.338, sigma: 0.653
  },
  '0.60': {
    a: 1.293, b: -0.00282, c: 0.003, d: 1.088, e: 0.01019, fr: 0.233,
    site: [-0.705, -0.429, -0.003, 0.394, 0.559],
    asc:    { qc: -0.0329, wc: 0.0202 },
    inter:  { si: -0.103, qi: -0.0707, wi: 0.0604, tau: 0.296 },
    slab:   { ss: 2.702, ssl: -0.575, ps: 0.1307, qs: 0.0878, ws: 0.0136, tau: 0.285 },
    tau: 0.349, sigma: 0.653
  },
  '0.70': {
    a: 1.336, b: -0.00258, c: 0.0025, d: 1.084, e: 0.00979, fr: 0.22,
    site: [-1.144, -0.866, -0.449, -0.111, 0.188],
    asc:    { qc: -0.0501, wc: 0.0274 },
    inter:  { si: -0.146, qi: -0.0771, wi: 0.0639, tau: 0.313 },
    slab:   { ss: 2.654, ssl: -0.572, ps: 0.1239, qs: 0.0705, ws: 0.0254, tau: 0.29 },
    tau: 0.351, sigma: 0.652
  },
  '0.80': {
    a: 1.386, b: -0.00242, c: 0.0022, d: 1.088, e: 0.00944, fr: 0.232,
    site: [-1.609, -1.325, -0.928, -0.62, -0.246],
    asc:    { qc: -0.065, wc: 0.0336 },
    inter:  { si: -0.164, qi: -0.0825, wi: 0.067, tau: 0.329 },
    slab:   { ss: 2.48, ssl: -0.54, ps: 0.1176, qs: 0.0556, ws: 0.0352, tau: 0.299 },
    tau: 0.356, sigma: 0.647
  },
  '0.90': {
    a: 1.433, b: -0.00232, c: 0.002, d: 1.109, e: 0.00972, fr: 0.22,
    site: [-2.023, -1.732, -1.349, -1.066, -0.643],
    asc:    { qc: -0.0781, wc: 0.0391 },
    inter:  { si: -0.206, qi: -0.0874, wi: 0.0697, tau: 0.324 },
    slab:   { ss: 2.332, ssl: -0.522, ps: 0.1116, qs: 0.0426, ws: 0.0432, tau: 0.289 },
    tau: 0.348, sigma: 0.653
  },
  '1.00': {
    a: 1.479, b: -0.0022, c: 0.002, d: 1.115, e: 0.01005, fr: 0.211,
    site: [-2.451, -2.152, -1.776, -1.523, -1.084],
    asc:    { qc: -0.0899, wc: 0.044 },
    inter:  { si: -0.239, qi: -0.0917, wi: 0.0721, tau: 0.328 },
    slab:   { ss: 2.233, ssl: -0.509, ps: 0.106, qs: 0.0314, ws: 0.0498, tau: 0.286 },
    tau: 0.338, sigma: 0.657
  },
  '1.25': {
    a: 1.551, b: -0.00207, c: 0.002, d: 1.083, e: 0.01003, fr: 0.251,
    site: [-3.243, -2.923, -2.542, -2.327, -1.936],
    asc:    { qc: -0.1148, wc: 0.0545 },
    inter:  { si: -0.256, qi: -0.1009, wi: 0.0772, tau: 0.339 },
    slab:   { ss: 2.029, ssl: -0.469, ps: 0.0933, qs: 0.0093, ws: 0.0612, tau: 0.277 },
    tau: 0.313, sigma: 0.66
  },
  '1.50': {
    a: 1.621, b: -0.00224, c: 0.002, d: 1.091, e: 0.00928, fr: 0.248,
    site: [-3.888, -3.548, -3.169, -2.979, -2.661],
    asc:    { qc: -0.1351, wc: 0.063 },
    inter:  { si: -0.306, qi: -0.1083, wi: 0.0814, tau: 0.352 },
    slab:   { ss: 1.589, ssl: -0.379, ps: 0.0821, qs: -0.0062, ws: 0.0674, tau: 0.282 },
    tau: 0.306, sigma: 0.664
  },
  '2.00': {
    a: 1.694, b: -0.00201, c: 0.0025, d: 1.055, e: 0.00833, fr: 0.263,
    site: [-4.783, -4.41, -4.039, -3.871, -3.64],
    asc:    { qc: -0.1672, wc: 0.0764 },
    inter:  { si: -0.321, qi: -0.1202, wi: 0.088, tau: 0.36 },
    slab:   { ss: 0.966, ssl: -0.248, ps: 0.0628, qs: -0.0235, ws: 0.0692, tau: 0.3 },
    tau: 0.283, sigma: 0.669
  },
  '2.50': {
    a: 1.748, b: -0.00187, c: 0.0028, d: 1.052, e: 0.00776, fr: 0.262,
    site: [-5.444, -5.049, -4.698, -4.496, -4.341],
    asc:    { qc: -0.1921, wc: 0.0869 },
    inter:  { si: -0.337, qi: -0.1293, wi: 0.0931, tau: 0.356 },
    slab:   { ss: 0.789, ssl: -0.221, ps: 0.0465, qs: -0.0287, ws: 0.0622, tau: 0.292 },
    tau: 0.287, sigma: 0.671
  },
  '3.00': {
    a: 1.759, b: -0.00147, c: 0.0032, d: 1.025, e: 0.00644, fr: 0.307,
    site: [-5.839, -5.431, -5.089, -4.893, -4.758],
    asc:    { qc: -0.2124, wc: 0.0954 },
    inter:  { si: -0.331, qi: -0.1368, wi: 0.0972, tau: 0.338 },
    slab:   { ss: 1.037, ssl: -0.263, ps: 0.0322, qs: -0.0261, ws: 0.0496, tau: 0.274 },
    tau: 0.278, sigma: 0.667
  },
  '4.00': {
    a: 1.826, b: -0.00195, c: 0.004, d: 1.044, e: 0.0059, fr: 0.353,
    site: [-6.598, -6.181, -5.882, -5.698, -5.588],
    asc:    { qc: -0.2445, wc: 0.1088 },
    inter:  { si: -0.39, qi: -0.1486, wi: 0.1038, tau: 0.307 },
    slab:   { ss: 0.561, ssl: -0.169, ps: 0.0083, qs: -0.0065, ws: 0.015, tau: 0.281 },
    tau: 0.273, sigma: 0.647
  },
  '5.00': {
    a: 1.825, b: -0.00237, c: 0.005, d: 1.065, e: 0.0051, fr: 0.248,
    site: [-6.752, -6.347, -6.051, -5.873, -5.798],
    asc:    { qc: -0.2694, wc: 0.1193 },
    inter:  { si: -0.498, qi: -0.1578, wi: 0.109, tau: 0.272 },
    slab:   { ss: 0.225, ssl: -0.12, ps: -0.0117, qs: 0.0246, ws: -0.0268, tau: 0.296 },
    tau: 0.275, sigma: 0.643
  }
};
Physics.ZHAO2006_PAPER.sa1 = Physics.ZHAO2006_PAPER['1.00'];

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
//  GMPE — Boore, Stewart, Seyhan & Atkinson (2014) "BSSA14" (NGA-West2)
// ================================================================
//  Faithful transcription of the OFFICIAL openquake.hazardlib
//  implementation (gem/oq-engine openquake/hazardlib/gsim/boore_2014.py,
//  sha256 c12315ff4c3d7c84ef39433348285ead4999032ec3ada0b4ccd09238cf3b4422,
//  verified identical at fetch time 2026-10-01) — the same
//  cross-implementation discipline as zhao2006:
//  tools/gen-gmpe-fixtures-bssa14.py is an INDEPENDENT scalar transcription
//  and tests/gmpe-bssa14.test.js asserts both against each other
//  point-wise (max |Δln| < 1e-12 over the frozen grid).
//
//  Paper: Boore, Stewart, Seyhan & Atkinson (2014), Earthquake Spectra
//  30(3) 1057-1085 — Eq.(2) event term with style-of-faulting e0-e3 and
//  Mh hinge, Eq.(3)-(4) path with R = sqrt(Rjb^2 + h^2) and regional Dc3,
//  Eq.(5)-(8) linear + nonlinear Vs30 site (rock PGA reference),
//  Eq.(13)-(17) magnitude/distance/site-dependent tau and phi.
//  Scope honesty (all documented, none hidden):
//  - Shallow CRUSTAL events in active tectonic regions only (the model's
//    calibration domain). Hypocentral depth is NOT a predictor — depth
//    enters only through the per-IMT h pseudo-depth.
//  - Distance metric is Rjb. Point-source callers pass the epicentral
//    (horizontal) distance; the finite-fault composite passes the
//    horizontal distance to each patch centroid (its surface projection) —
//    the Rjb analog of the zhao per-patch Rrup treatment.
//  - Basin term OFF (hazardlib region='nobasin'): no z1.0 site data are
//    available in any region pack, so the term returns 0 identically. The
//    f6/f7 columns are carried verbatim but unused. (v6.9 note: the hazardlib
//    LowQ source table carries coarsely-rounded f6/f7 literals at some
//    periods vs base — print-precision artifacts in UNUSED columns only; the
//    transcription freezes the base values.)
//  - Regional anelastic Dc3: the hazardlib HighQ (China/Turkey) and LowQ
//    (Italy/Japan) subclasses differ from the base table ONLY in the Dc3
//    column (verified programmatically across all 107 rows x 27 columns);
//    Physics.activeBssa2014Variant picks the variant from the
//    active region (italy/japan -> lowQ, everything else -> base; taiwan,
//    newzealand and chile have no published regional adjustment).
//  - Units follow hazardlib: ln(PGA) in g, ln(PGV) in cm/s. The
//    pgaBssa2014/pgvBssa2014 wrappers convert with standard gravity
//    (980.665 gal/g) and apply the same display soft caps as zhao2006.
//  v6.9 BSSA14 SA full-period batch (2026-10-07): all 105 SA rows
//  (0.010-10.00 s) of the SAME frozen hazardlib source transcribed
//  (extract-verify-splice, zero hand-keying) — BSSA2014_SA_KEYS +
//  per-IMT Dc3 columns; bssa2014Ln/bssa2014SigmaLn resolve SA periods
//  (exact row else log-period interpolation of the final value, the
//  parker2022 engine convention; null outside [0.01, 10] s); the PSHA
//  crustal SA path no longer collapses to zhao2006 (see _pshaBranchesFor).
// ================================================================
Physics.BSSA2014_CONSTS = { mref: 4.5, rref: 1.0, vref: 760.0, f1: 0.0, f3: 0.1, v1: 225.0, v2: 300.0 };
// Coefficient rows (hazardlib COEFFS base table, verbatim). phi1/phi2 are the
// table columns named f1/f2 (phi magnitude ramp) — renamed here so they can
// never be confused with the IMT-independent CONSTS.f1/f3 of the nonlinear
// site term. f6/f7 (basin) are transcribed for completeness but unused with
// the basin term off.
Physics.BSSA2014_SA_KEYS = ['0.010', '0.020', '0.022', '0.025', '0.029', '0.030', '0.032', '0.035', '0.036', '0.040', '0.042', '0.044', '0.045', '0.046', '0.048', '0.050', '0.055', '0.060', '0.065', '0.067', '0.070', '0.075', '0.080', '0.085', '0.090', '0.095', '0.100', '0.110', '0.120', '0.130', '0.133', '0.140', '0.150', '0.160', '0.170', '0.180', '0.190', '0.200', '0.220', '0.240', '0.250', '0.260', '0.280', '0.290', '0.300', '0.320', '0.340', '0.350', '0.360', '0.380', '0.400', '0.420', '0.440', '0.450', '0.460', '0.480', '0.500', '0.550', '0.600', '0.650', '0.667', '0.700', '0.750', '0.800', '0.850', '0.900', '0.950', '1.000', '1.100', '1.200', '1.300', '1.400', '1.500', '1.600', '1.700', '1.800', '1.900', '2.000', '2.200', '2.400', '2.500', '2.600', '2.800', '3.000', '3.200', '3.400', '3.500', '3.600', '3.800', '4.000', '4.200', '4.400', '4.600', '4.800', '5.000', '5.500', '6.000', '6.500', '7.000', '7.500', '8.000', '8.500', '9.000', '9.500', '10.00'];
Physics.BSSA2014_PAPER = {
  'pga': {
    e0: 0.4473, e1: 0.4856, e2: 0.2459, e3: 0.4539, e4: 1.431, e5: 0.05053, e6: -0.1662, mh: 5.5,
    c1: -1.134, c2: 0.1917, c3: -0.008088, h: 4.5, dc3: 0.0,
    c: -0.6, vc: 1500.0, f4: -0.15, f5: -0.00701, f6: -9.9, f7: -9.9,
    r1: 110.0, r2: 270.0, dfr: 0.1, dfv: 0.07, phi1: 0.695, phi2: 0.495, tau1: 0.398, tau2: 0.348
  },
  'pgv': {
    e0: 5.037, e1: 5.078, e2: 4.849, e3: 5.033, e4: 1.073, e5: -0.1536, e6: 0.2252, mh: 6.2,
    c1: -1.243, c2: 0.1489, c3: -0.00344, h: 5.3, dc3: 0.0,
    c: -0.84, vc: 1300.0, f4: -0.1, f5: -0.00844, f6: -9.9, f7: -9.9,
    r1: 105.0, r2: 272.0, dfr: 0.082, dfv: 0.08, phi1: 0.644, phi2: 0.552, tau1: 0.401, tau2: 0.346
  },
  '0.010': { e0: 0.4534, e1: 0.4916, e2: 0.2519, e3: 0.4599, e4: 1.421, e5: 0.04932, e6: -0.1659, mh: 5.5, c1: -1.134, c2: 0.1916, c3: -0.008088, h: 4.5, dc3: 0.0, c: -0.60372, vc: 1500.2, f4: -0.14833, f5: -0.00701, f6: -9.9, f7: -9.9, r1: 111.67, r2: 270, dfr: 0.096, dfv: 0.07, phi1: 0.698, phi2: 0.499, tau1: 0.402, tau2: 0.345 },
  '0.020': { e0: 0.48598, e1: 0.52359, e2: 0.29707, e3: 0.48875, e4: 1.4331, e5: 0.053388, e6: -0.16561, mh: 5.5, c1: -1.1394, c2: 0.18962, c3: -0.008074, h: 4.5, dc3: 0.0, c: -0.57388, vc: 1500.36, f4: -0.1471, f5: -0.00728, f6: -9.9, f7: -9.9, r1: 113.1, r2: 270, dfr: 0.092, dfv: 0.03, phi1: 0.702, phi2: 0.502, tau1: 0.409, tau2: 0.346 },
  '0.022': { e0: 0.49866, e1: 0.53647, e2: 0.31347, e3: 0.49973, e4: 1.4336, e5: 0.054888, e6: -0.1652, mh: 5.5, c1: -1.1405, c2: 0.18924, c3: -0.008095, h: 4.5, dc3: 0.0, c: -0.56675, vc: 1500.68, f4: -0.14801, f5: -0.00732, f6: -9.9, f7: -9.9, r1: 113.37, r2: 270, dfr: 0.088, dfv: 0.027, phi1: 0.707, phi2: 0.505, tau1: 0.418, tau2: 0.349 },
  '0.025': { e0: 0.52283, e1: 0.5613, e2: 0.34426, e3: 0.51999, e4: 1.4328, e5: 0.057529, e6: -0.16499, mh: 5.5, c1: -1.1419, c2: 0.18875, c3: -0.008153, h: 4.5, dc3: 0.0, c: -0.5552, vc: 1501.04, f4: -0.15015, f5: -0.00736, f6: -9.9, f7: -9.9, r1: 113.07, r2: 270, dfr: 0.086, dfv: 0.026, phi1: 0.711, phi2: 0.508, tau1: 0.427, tau2: 0.354 },
  '0.029': { e0: 0.55949, e1: 0.59923, e2: 0.39146, e3: 0.54995, e4: 1.4279, e5: 0.060732, e6: -0.16632, mh: 5.5, c1: -1.1423, c2: 0.18844, c3: -0.00829, h: 4.5, dc3: 0.0, c: -0.5385, vc: 1501.26, f4: -0.15387, f5: -0.00737, f6: -9.9, f7: -9.9, r1: 112.36, r2: 270, dfr: 0.084, dfv: 0.028, phi1: 0.716, phi2: 0.51, tau1: 0.436, tau2: 0.359 },
  '0.030': { e0: 0.56916, e1: 0.6092, e2: 0.40391, e3: 0.55783, e4: 1.4261, e5: 0.061444, e6: -0.1669, mh: 5.5, c1: -1.1421, c2: 0.18842, c3: -0.008336, h: 4.49, dc3: 0.0, c: -0.53414, vc: 1502.95, f4: -0.15485, f5: -0.00735, f6: -9.9, f7: -9.9, r1: 112.13, r2: 270, dfr: 0.081, dfv: 0.029, phi1: 0.721, phi2: 0.514, tau1: 0.445, tau2: 0.364 },
  '0.032': { e0: 0.58802, e1: 0.62875, e2: 0.42788, e3: 0.5733, e4: 1.4227, e5: 0.062806, e6: -0.16813, mh: 5.5, c1: -1.1412, c2: 0.1884, c3: -0.008445, h: 4.45, dc3: 0.0, c: -0.52529, vc: 1503.12, f4: -0.15685, f5: -0.00731, f6: -9.9, f7: -9.9, r1: 111.65, r2: 270, dfr: 0.078, dfv: 0.03, phi1: 0.726, phi2: 0.516, tau1: 0.454, tau2: 0.369 },
  '0.035': { e0: 0.61636, e1: 0.65818, e2: 0.46252, e3: 0.59704, e4: 1.4174, e5: 0.064559, e6: -0.17015, mh: 5.5, c1: -1.1388, c2: 0.18839, c3: -0.008642, h: 4.4, dc3: 0.0, c: -0.51192, vc: 1503.24, f4: -0.16016, f5: -0.00721, f6: -9.9, f7: -9.9, r1: 110.64, r2: 270, dfr: 0.077, dfv: 0.031, phi1: 0.73, phi2: 0.518, tau1: 0.462, tau2: 0.374 },
  '0.036': { e0: 0.62554, e1: 0.66772, e2: 0.47338, e3: 0.60496, e4: 1.4158, e5: 0.065028, e6: -0.17083, mh: 5.5, c1: -1.1378, c2: 0.18837, c3: -0.008715, h: 4.38, dc3: 0.0, c: -0.50752, vc: 1503.32, f4: -0.16142, f5: -0.00717, f6: -9.9, f7: -9.9, r1: 109.53, r2: 270, dfr: 0.075, dfv: 0.031, phi1: 0.734, phi2: 0.52, tau1: 0.47, tau2: 0.379 },
  '0.040': { e0: 0.66281, e1: 0.70604, e2: 0.51532, e3: 0.63828, e4: 1.409, e5: 0.066183, e6: -0.17357, mh: 5.5, c1: -1.1324, c2: 0.18816, c3: -0.00903, h: 4.32, dc3: 0.0, c: -0.49065, vc: 1503.35, f4: -0.16777, f5: -0.00698, f6: -9.9, f7: -9.9, r1: 108.28, r2: 270, dfr: 0.073, dfv: 0.032, phi1: 0.738, phi2: 0.521, tau1: 0.478, tau2: 0.384 },
  '0.042': { e0: 0.68087, e1: 0.72443, e2: 0.53445, e3: 0.65505, e4: 1.4059, e5: 0.066438, e6: -0.17485, mh: 5.5, c1: -1.1292, c2: 0.18797, c3: -0.009195, h: 4.29, dc3: 0.0, c: -0.4829, vc: 1503.34, f4: -0.17193, f5: -0.00687, f6: -9.9, f7: -9.9, r1: 106.99, r2: 270, dfr: 0.072, dfv: 0.032, phi1: 0.742, phi2: 0.523, tau1: 0.484, tau2: 0.39 },
  '0.044': { e0: 0.69882, e1: 0.74277, e2: 0.55282, e3: 0.67225, e4: 1.4033, e5: 0.066663, e6: -0.17619, mh: 5.5, c1: -1.1259, c2: 0.18775, c3: -0.00936, h: 4.27, dc3: 0.0, c: -0.47572, vc: 1503.13, f4: -0.17664, f5: -0.00677, f6: -9.9, f7: -9.9, r1: 105.41, r2: 270, dfr: 0.07, dfv: 0.031, phi1: 0.745, phi2: 0.525, tau1: 0.49, tau2: 0.397 },
  '0.045': { e0: 0.70822, e1: 0.75232, e2: 0.56222, e3: 0.68139, e4: 1.4021, e5: 0.066774, e6: -0.17693, mh: 5.5, c1: -1.1242, c2: 0.18764, c3: -0.009441, h: 4.25, dc3: 0.0, c: -0.47236, vc: 1502.84, f4: -0.17914, f5: -0.00672, f6: -9.9, f7: -9.9, r1: 103.61, r2: 270, dfr: 0.069, dfv: 0.031, phi1: 0.748, phi2: 0.527, tau1: 0.496, tau2: 0.405 },
  '0.046': { e0: 0.71779, e1: 0.76202, e2: 0.57166, e3: 0.69076, e4: 1.4009, e5: 0.066891, e6: -0.17769, mh: 5.5, c1: -1.1224, c2: 0.18752, c3: -0.009521, h: 4.24, dc3: 0.0, c: -0.46915, vc: 1502.47, f4: -0.1817, f5: -0.00667, f6: -9.9, f7: -9.9, r1: 101.7, r2: 270, dfr: 0.067, dfv: 0.031, phi1: 0.75, phi2: 0.529, tau1: 0.499, tau2: 0.412 },
  '0.048': { e0: 0.73574, e1: 0.78015, e2: 0.58888, e3: 0.70854, e4: 1.3991, e5: 0.067127, e6: -0.1792, mh: 5.5, c1: -1.1192, c2: 0.1873, c3: -0.009676, h: 4.22, dc3: 0.0, c: -0.46321, vc: 1502.01, f4: -0.18688, f5: -0.00656, f6: -9.9, f7: -9.9, r1: 99.76, r2: 270, dfr: 0.065, dfv: 0.031, phi1: 0.752, phi2: 0.53, tau1: 0.502, tau2: 0.419 },
  '0.050': { e0: 0.75436, e1: 0.79905, e2: 0.60652, e3: 0.72726, e4: 1.3974, e5: 0.067357, e6: -0.18082, mh: 5.5, c1: -1.1159, c2: 0.18709, c3: -0.009819, h: 4.2, dc3: 0.0, c: -0.45795, vc: 1501.42, f4: -0.192, f5: -0.00647, f6: -9.9, f7: -9.9, r1: 97.93, r2: 270, dfr: 0.063, dfv: 0.03, phi1: 0.753, phi2: 0.532, tau1: 0.503, tau2: 0.426 },
  '0.055': { e0: 0.7996, e1: 0.8445, e2: 0.6477, e3: 0.7737, e4: 1.3947, e5: 0.067797, e6: -0.1848, mh: 5.5, c1: -1.1082, c2: 0.18655, c3: -0.01012, h: 4.15, dc3: 0.0, c: -0.44787, vc: 1500.71, f4: -0.20369, f5: -0.00625, f6: -9.9, f7: -9.9, r1: 96.03, r2: 270, dfr: 0.062, dfv: 0.029, phi1: 0.753, phi2: 0.534, tau1: 0.502, tau2: 0.434 },
  '0.060': { e0: 0.84394, e1: 0.88884, e2: 0.68562, e3: 0.82067, e4: 1.3954, e5: 0.068591, e6: -0.18858, mh: 5.5, c1: -1.1009, c2: 0.18582, c3: -0.01033, h: 4.11, dc3: 0.0, c: -0.44186, vc: 1499.83, f4: -0.21374, f5: -0.00607, f6: -9.9, f7: -9.9, r1: 94.1, r2: 270.01, dfr: 0.061, dfv: 0.027, phi1: 0.753, phi2: 0.536, tau1: 0.499, tau2: 0.441 },
  '0.065': { e0: 0.88655, e1: 0.93116, e2: 0.71941, e3: 0.86724, e4: 1.4004, e5: 0.070127, e6: -0.19176, mh: 5.5, c1: -1.0942, c2: 0.18485, c3: -0.01048, h: 4.08, dc3: 0.0, c: -0.43951, vc: 1498.74, f4: -0.22225, f5: -0.00593, f6: -9.9, f7: -9.9, r1: 92.08, r2: 270.02, dfr: 0.061, dfv: 0.025, phi1: 0.752, phi2: 0.538, tau1: 0.495, tau2: 0.448 },
  '0.067': { e0: 0.9027, e1: 0.94711, e2: 0.73171, e3: 0.88526, e4: 1.4032, e5: 0.070895, e6: -0.19291, mh: 5.5, c1: -1.0918, c2: 0.18442, c3: -0.01052, h: 4.07, dc3: 0.0, c: -0.4395, vc: 1497.42, f4: -0.22524, f5: -0.00588, f6: -9.9, f7: -9.9, r1: 90.01, r2: 270.02, dfr: 0.061, dfv: 0.025, phi1: 0.75, phi2: 0.54, tau1: 0.489, tau2: 0.455 },
  '0.070': { e0: 0.92652, e1: 0.97057, e2: 0.7494, e3: 0.91227, e4: 1.4082, e5: 0.072075, e6: -0.19451, mh: 5.5, c1: -1.0884, c2: 0.18369, c3: -0.01056, h: 4.06, dc3: 0.0, c: -0.4404, vc: 1495.85, f4: -0.22931, f5: -0.00582, f6: -9.9, f7: -9.9, r1: 87.97, r2: 270.03, dfr: 0.062, dfv: 0.024, phi1: 0.748, phi2: 0.541, tau1: 0.483, tau2: 0.461 },
  '0.075': { e0: 0.96447, e1: 1.0077, e2: 0.77678, e3: 0.9563, e4: 1.4174, e5: 0.073549, e6: -0.19665, mh: 5.5, c1: -1.0831, c2: 0.18225, c3: -0.01058, h: 4.04, dc3: 0.0, c: -0.44411, vc: 1494, f4: -0.235, f5: -0.00573, f6: -9.9, f7: -9.9, r1: 85.99, r2: 270.04, dfr: 0.064, dfv: 0.022, phi1: 0.745, phi2: 0.542, tau1: 0.474, tau2: 0.466 },
  '0.080': { e0: 1.0003, e1: 1.0426, e2: 0.80161, e3: 0.99818, e4: 1.4261, e5: 0.073735, e6: -0.19816, mh: 5.5, c1: -1.0785, c2: 0.18052, c3: -0.01056, h: 4.02, dc3: 0.0, c: -0.4502, vc: 1491.82, f4: -0.23944, f5: -0.00567, f6: -9.9, f7: -9.9, r1: 84.23, r2: 270.05, dfr: 0.067, dfv: 0.02, phi1: 0.741, phi2: 0.543, tau1: 0.464, tau2: 0.468 },
  '0.085': { e0: 1.034, e1: 1.0755, e2: 0.82423, e3: 1.0379, e4: 1.4322, e5: 0.07194, e6: -0.19902, mh: 5.51, c1: -1.0745, c2: 0.17856, c3: -0.01051, h: 4.03, dc3: 0.0, c: -0.45813, vc: 1489.29, f4: -0.24285, f5: -0.00563, f6: -9.9, f7: -9.9, r1: 82.74, r2: 270.06, dfr: 0.072, dfv: 0.019, phi1: 0.737, phi2: 0.543, tau1: 0.452, tau2: 0.468 },
  '0.090': { e0: 1.0666, e1: 1.1076, e2: 0.84591, e3: 1.0762, e4: 1.435, e5: 0.068097, e6: -0.19929, mh: 5.52, c1: -1.0709, c2: 0.17643, c3: -0.01042, h: 4.07, dc3: 0.0, c: -0.46732, vc: 1486.36, f4: -0.24544, f5: -0.00561, f6: -9.9, f7: -9.9, r1: 81.54, r2: 270.07, dfr: 0.076, dfv: 0.017, phi1: 0.734, phi2: 0.542, tau1: 0.44, tau2: 0.466 },
  '0.095': { e0: 1.0981, e1: 1.1385, e2: 0.86703, e3: 1.1127, e4: 1.4339, e5: 0.062327, e6: -0.199, mh: 5.53, c1: -1.0678, c2: 0.1742, c3: -0.01032, h: 4.1, dc3: 0.0, c: -0.47721, vc: 1482.98, f4: -0.24747, f5: -0.0056, f6: -9.9, f7: -9.9, r1: 80.46, r2: 270.08, dfr: 0.082, dfv: 0.016, phi1: 0.731, phi2: 0.542, tau1: 0.428, tau2: 0.464 },
  '0.100': { e0: 1.1268, e1: 1.1669, e2: 0.8871, e3: 1.1454, e4: 1.4293, e5: 0.055231, e6: -0.19838, mh: 5.54, c1: -1.0652, c2: 0.17203, c3: -0.0102, h: 4.13, dc3: 0.0, c: -0.48724, vc: 1479.12, f4: -0.24916, f5: -0.0056, f6: -9.9, f7: -9.9, r1: 79.59, r2: 270.09, dfr: 0.087, dfv: 0.014, phi1: 0.728, phi2: 0.541, tau1: 0.415, tau2: 0.458 },
  '0.110': { e0: 1.1785, e1: 1.2179, e2: 0.92702, e3: 1.203, e4: 1.411, e5: 0.037389, e6: -0.19601, mh: 5.57, c1: -1.0607, c2: 0.1677, c3: -0.009964, h: 4.19, dc3: 0.0, c: -0.50632, vc: 1474.74, f4: -0.25213, f5: -0.00562, f6: -9.9, f7: -9.9, r1: 79.05, r2: 270.11, dfr: 0.093, dfv: 0.012, phi1: 0.726, phi2: 0.54, tau1: 0.403, tau2: 0.451 },
  '0.120': { e0: 1.223, e1: 1.2621, e2: 0.96616, e3: 1.2502, e4: 1.3831, e5: 0.016373, e6: -0.19265, mh: 5.62, c1: -1.0572, c2: 0.16352, c3: -0.009722, h: 4.24, dc3: 0.0, c: -0.52438, vc: 1469.75, f4: -0.25455, f5: -0.00567, f6: -9.9, f7: -9.9, r1: 78.85, r2: 270.13, dfr: 0.099, dfv: 0.011, phi1: 0.724, phi2: 0.539, tau1: 0.392, tau2: 0.441 },
  '0.130': { e0: 1.2596, e1: 1.2986, e2: 1.0031, e3: 1.2869, e4: 1.3497, e5: -0.005158, e6: -0.18898, mh: 5.66, c1: -1.0549, c2: 0.15982, c3: -0.009476, h: 4.29, dc3: 0.0, c: -0.54214, vc: 1464.09, f4: -0.25628, f5: -0.00572, f6: -9.9, f7: -9.9, r1: 78.99, r2: 270.15, dfr: 0.104, dfv: 0.011, phi1: 0.723, phi2: 0.538, tau1: 0.381, tau2: 0.43 },
  '0.133': { e0: 1.2692, e1: 1.3082, e2: 1.0135, e3: 1.2961, e4: 1.3395, e5: -0.011354, e6: -0.18792, mh: 5.67, c1: -1.0545, c2: 0.15882, c3: -0.009402, h: 4.3, dc3: 0.0, c: -0.54752, vc: 1457.76, f4: -0.25665, f5: -0.00574, f6: -9.9, f7: -9.9, r1: 79.47, r2: 270.15, dfr: 0.11, dfv: 0.011, phi1: 0.722, phi2: 0.538, tau1: 0.371, tau2: 0.417 },
  '0.140': { e0: 1.2883, e1: 1.327, e2: 1.036, e3: 1.3137, e4: 1.3162, e5: -0.024711, e6: -0.18566, mh: 5.7, c1: -1.0537, c2: 0.15672, c3: -0.009228, h: 4.34, dc3: 0.0, c: -0.56032, vc: 1450.71, f4: -0.25719, f5: -0.00578, f6: -9.9, f7: -9.9, r1: 80.26, r2: 270.16, dfr: 0.115, dfv: 0.012, phi1: 0.721, phi2: 0.537, tau1: 0.362, tau2: 0.403 },
  '0.150': { e0: 1.3095, e1: 1.3481, e2: 1.0648, e3: 1.3324, e4: 1.2844, e5: -0.042065, e6: -0.18234, mh: 5.74, c1: -1.0532, c2: 0.15401, c3: -0.008977, h: 4.39, dc3: 0.0, c: -0.57962, vc: 1442.85, f4: -0.25713, f5: -0.00585, f6: -9.9, f7: -9.9, r1: 81.33, r2: 270.16, dfr: 0.12, dfv: 0.015, phi1: 0.72, phi2: 0.537, tau1: 0.354, tau2: 0.388 },
  '0.160': { e0: 1.3235, e1: 1.3615, e2: 1.0876, e3: 1.3437, e4: 1.2541, e5: -0.057593, e6: -0.17853, mh: 5.78, c1: -1.0533, c2: 0.15158, c3: -0.008725, h: 4.44, dc3: 0.0, c: -0.60052, vc: 1434.22, f4: -0.25604, f5: -0.00591, f6: -9.9, f7: -9.9, r1: 82.86, r2: 270.16, dfr: 0.125, dfv: 0.02, phi1: 0.72, phi2: 0.536, tau1: 0.349, tau2: 0.372 },
  '0.170': { e0: 1.3306, e1: 1.3679, e2: 1.104, e3: 1.3487, e4: 1.2244, e5: -0.071861, e6: -0.17421, mh: 5.82, c1: -1.0541, c2: 0.14948, c3: -0.008472, h: 4.49, dc3: 0.0, c: -0.62252, vc: 1424.85, f4: -0.25414, f5: -0.00597, f6: -9.9, f7: -9.9, r1: 84.72, r2: 270.14, dfr: 0.128, dfv: 0.026, phi1: 0.718, phi2: 0.536, tau1: 0.346, tau2: 0.357 },
  '0.180': { e0: 1.3327, e1: 1.3689, e2: 1.1149, e3: 1.3492, e4: 1.1941, e5: -0.08564, e6: -0.16939, mh: 5.85, c1: -1.0556, c2: 0.14768, c3: -0.008219, h: 4.53, dc3: 0.0, c: -0.64486, vc: 1414.77, f4: -0.25173, f5: -0.00602, f6: -9.9, f7: -9.9, r1: 86.67, r2: 270.11, dfr: 0.131, dfv: 0.033, phi1: 0.717, phi2: 0.536, tau1: 0.344, tau2: 0.341 },
  '0.190': { e0: 1.3307, e1: 1.3656, e2: 1.1208, e3: 1.3463, e4: 1.1635, e5: -0.098884, e6: -0.16404, mh: 5.89, c1: -1.0579, c2: 0.14616, c3: -0.007967, h: 4.57, dc3: 0.0, c: -0.66681, vc: 1403.99, f4: -0.24911, f5: -0.00608, f6: -9.9, f7: -9.9, r1: 88.73, r2: 270.06, dfr: 0.134, dfv: 0.039, phi1: 0.714, phi2: 0.537, tau1: 0.343, tau2: 0.324 },
  '0.200': { e0: 1.3255, e1: 1.359, e2: 1.122, e3: 1.3414, e4: 1.1349, e5: -0.11096, e6: -0.15852, mh: 5.92, c1: -1.0607, c2: 0.14489, c3: -0.007717, h: 4.61, dc3: 0.0, c: -0.68762, vc: 1392.61, f4: -0.24658, f5: -0.00614, f6: -9.9, f7: -9.9, r1: 90.91, r2: 270, dfr: 0.136, dfv: 0.045, phi1: 0.711, phi2: 0.539, tau1: 0.344, tau2: 0.309 },
  '0.220': { e0: 1.3091, e1: 1.3394, e2: 1.1133, e3: 1.3281, e4: 1.0823, e5: -0.133, e6: -0.14704, mh: 5.97, c1: -1.067, c2: 0.14263, c3: -0.007224, h: 4.68, dc3: 0.0, c: -0.72431, vc: 1380.72, f4: -0.24235, f5: -0.00626, f6: -9.9, f7: -9.9, r1: 93.04, r2: 269.83, dfr: 0.138, dfv: 0.052, phi1: 0.708, phi2: 0.541, tau1: 0.345, tau2: 0.294 },
  '0.240': { e0: 1.2881, e1: 1.315, e2: 1.0945, e3: 1.3132, e4: 1.0366, e5: -0.15299, e6: -0.13445, mh: 6.03, c1: -1.0737, c2: 0.14035, c3: -0.006747, h: 4.75, dc3: 0.0, c: -0.75646, vc: 1368.51, f4: -0.23823, f5: -0.00638, f6: -9.9, f7: -9.9, r1: 95.08, r2: 269.59, dfr: 0.14, dfv: 0.055, phi1: 0.703, phi2: 0.544, tau1: 0.347, tau2: 0.28 },
  '0.250': { e0: 1.2766, e1: 1.3017, e2: 1.0828, e3: 1.3052, e4: 1.0166, e5: -0.16213, e6: -0.12784, mh: 6.05, c1: -1.0773, c2: 0.13925, c3: -0.006517, h: 4.78, dc3: 0.0, c: -0.77177, vc: 1356.21, f4: -0.23574, f5: -0.00644, f6: -9.9, f7: -9.9, r1: 97.04, r2: 269.45, dfr: 0.141, dfv: 0.055, phi1: 0.698, phi2: 0.547, tau1: 0.35, tau2: 0.266 },
  '0.260': { e0: 1.2651, e1: 1.2886, e2: 1.071, e3: 1.2972, e4: 0.99932, e5: -0.17041, e6: -0.12115, mh: 6.07, c1: -1.0808, c2: 0.13818, c3: -0.006293, h: 4.82, dc3: 0.0, c: -0.78697, vc: 1343.89, f4: -0.2328, f5: -0.0065, f6: -9.9, f7: -9.9, r1: 98.87, r2: 269.3, dfr: 0.141, dfv: 0.055, phi1: 0.693, phi2: 0.55, tau1: 0.353, tau2: 0.255 },
  '0.280': { e0: 1.2429, e1: 1.2635, e2: 1.0476, e3: 1.2815, e4: 0.97282, e5: -0.18463, e6: -0.10714, mh: 6.11, c1: -1.0879, c2: 0.13604, c3: -0.005866, h: 4.88, dc3: 0.0, c: -0.81613, vc: 1331.67, f4: -0.22601, f5: -0.0066, f6: -9.9, f7: -9.9, r1: 100.53, r2: 268.96, dfr: 0.14, dfv: 0.053, phi1: 0.687, phi2: 0.554, tau1: 0.357, tau2: 0.244 },
  '0.290': { e0: 1.2324, e1: 1.2517, e2: 1.0363, e3: 1.2736, e4: 0.96348, e5: -0.19057, e6: -0.10011, mh: 6.12, c1: -1.0913, c2: 0.13499, c3: -0.005666, h: 4.9, dc3: 0.0, c: -0.8295, vc: 1319.83, f4: -0.2225, f5: -0.00665, f6: -9.9, f7: -9.9, r1: 102.01, r2: 268.78, dfr: 0.139, dfv: 0.051, phi1: 0.681, phi2: 0.557, tau1: 0.36, tau2: 0.236 },
  '0.300': { e0: 1.2217, e1: 1.2401, e2: 1.0246, e3: 1.2653, e4: 0.95676, e5: -0.1959, e6: -0.092855, mh: 6.14, c1: -1.0948, c2: 0.13388, c3: -0.005475, h: 4.93, dc3: 0.0, c: -0.84165, vc: 1308.47, f4: -0.21912, f5: -0.0067, f6: -9.9, f7: -9.9, r1: 103.15, r2: 268.59, dfr: 0.138, dfv: 0.05, phi1: 0.675, phi2: 0.561, tau1: 0.363, tau2: 0.229 },
  '0.320': { e0: 1.2007, e1: 1.2177, e2: 1.0011, e3: 1.2479, e4: 0.95004, e5: -0.20454, e6: -0.078923, mh: 6.16, c1: -1.1013, c2: 0.13179, c3: -0.005122, h: 4.98, dc3: 0.0, c: -0.86175, vc: 1297.65, f4: -0.21318, f5: -0.0068, f6: -9.9, f7: -9.9, r1: 104, r2: 268.2, dfr: 0.135, dfv: 0.048, phi1: 0.67, phi2: 0.566, tau1: 0.366, tau2: 0.223 },
  '0.340': { e0: 1.179, e1: 1.1955, e2: 0.97677, e3: 1.2286, e4: 0.94956, e5: -0.21134, e6: -0.065134, mh: 6.18, c1: -1.1074, c2: 0.12984, c3: -0.004808, h: 5.03, dc3: 0.0, c: -0.87726, vc: 1287.5, f4: -0.20816, f5: -0.00689, f6: -9.9, f7: -9.9, r1: 104.7, r2: 267.79, dfr: 0.133, dfv: 0.047, phi1: 0.664, phi2: 0.57, tau1: 0.369, tau2: 0.218 },
  '0.350': { e0: 1.1674, e1: 1.1836, e2: 0.9638, e3: 1.2177, e4: 0.95077, e5: -0.21446, e6: -0.057921, mh: 6.18, c1: -1.1105, c2: 0.1289, c3: -0.004663, h: 5.06, dc3: 0.0, c: -0.88375, vc: 1278.06, f4: -0.20592, f5: -0.00693, f6: -9.9, f7: -9.9, r1: 105.26, r2: 267.58, dfr: 0.13, dfv: 0.047, phi1: 0.658, phi2: 0.573, tau1: 0.372, tau2: 0.215 },
  '0.360': { e0: 1.1558, e1: 1.172, e2: 0.9512, e3: 1.2066, e4: 0.95278, e5: -0.21716, e6: -0.05104, mh: 6.19, c1: -1.1133, c2: 0.12806, c3: -0.004527, h: 5.08, dc3: 0.0, c: -0.88965, vc: 1269.19, f4: -0.20379, f5: -0.00697, f6: -9.9, f7: -9.9, r1: 105.61, r2: 267.37, dfr: 0.128, dfv: 0.047, phi1: 0.653, phi2: 0.576, tau1: 0.375, tau2: 0.212 },
  '0.380': { e0: 1.1305, e1: 1.1468, e2: 0.9244, e3: 1.1816, e4: 0.95899, e5: -0.22214, e6: -0.036755, mh: 6.19, c1: -1.119, c2: 0.12647, c3: -0.004276, h: 5.12, dc3: 0.0, c: -0.90038, vc: 1260.74, f4: -0.19978, f5: -0.00705, f6: -9.9, f7: -9.9, r1: 105.87, r2: 266.95, dfr: 0.125, dfv: 0.048, phi1: 0.648, phi2: 0.578, tau1: 0.378, tau2: 0.21 },
  '0.400': { e0: 1.1046, e1: 1.1214, e2: 0.89765, e3: 1.1552, e4: 0.96766, e5: -0.22608, e6: -0.023189, mh: 6.2, c1: -1.1243, c2: 0.12512, c3: -0.004053, h: 5.16, dc3: 0.0, c: -0.91092, vc: 1252.66, f4: -0.19582, f5: -0.00713, f6: -9.9, f7: -9.9, r1: 106.02, r2: 266.54, dfr: 0.122, dfv: 0.049, phi1: 0.643, phi2: 0.58, tau1: 0.381, tau2: 0.21 },
  '0.420': { e0: 1.0782, e1: 1.0955, e2: 0.87067, e3: 1.1276, e4: 0.97862, e5: -0.22924, e6: -0.010417, mh: 6.2, c1: -1.1291, c2: 0.12389, c3: -0.003853, h: 5.2, dc3: 0.0, c: -0.92241, vc: 1244.8, f4: -0.19171, f5: -0.00719, f6: -9.9, f7: -9.9, r1: 106.03, r2: 266.16, dfr: 0.12, dfv: 0.051, phi1: 0.638, phi2: 0.583, tau1: 0.384, tau2: 0.21 },
  '0.440': { e0: 1.0515, e1: 1.0697, e2: 0.84355, e3: 1.0995, e4: 0.99144, e5: -0.23166, e6: 0.001168, mh: 6.2, c1: -1.1337, c2: 0.12278, c3: -0.003673, h: 5.24, dc3: 0.0, c: -0.93459, vc: 1237.03, f4: -0.18747, f5: -0.00726, f6: -9.9, f7: -9.9, r1: 105.92, r2: 265.8, dfr: 0.117, dfv: 0.053, phi1: 0.634, phi2: 0.585, tau1: 0.388, tau2: 0.211 },
  '0.450': { e0: 1.0376, e1: 1.0562, e2: 0.82941, e3: 1.0847, e4: 0.99876, e5: -0.23263, e6: 0.006589, mh: 6.2, c1: -1.1359, c2: 0.12227, c3: -0.00359, h: 5.25, dc3: 0.0, c: -0.94075, vc: 1229.23, f4: -0.18534, f5: -0.00729, f6: -9.9, f7: -9.9, r1: 105.79, r2: 265.64, dfr: 0.115, dfv: 0.054, phi1: 0.629, phi2: 0.589, tau1: 0.393, tau2: 0.213 },
  '0.460': { e0: 1.0234, e1: 1.0426, e2: 0.81509, e3: 1.0696, e4: 1.0064, e5: -0.2335, e6: 0.011871, mh: 6.2, c1: -1.1381, c2: 0.12177, c3: -0.00351, h: 5.27, dc3: 0.0, c: -0.94686, vc: 1221.16, f4: -0.18321, f5: -0.00732, f6: -9.9, f7: -9.9, r1: 105.69, r2: 265.48, dfr: 0.113, dfv: 0.055, phi1: 0.624, phi2: 0.592, tau1: 0.398, tau2: 0.216 },
  '0.480': { e0: 0.99719, e1: 1.0172, e2: 0.7886, e3: 1.0415, e4: 1.0215, e5: -0.23464, e6: 0.020767, mh: 6.2, c1: -1.142, c2: 0.12093, c3: -0.00336, h: 5.3, dc3: 0.0, c: -0.95863, vc: 1212.74, f4: -0.17902, f5: -0.00738, f6: -9.9, f7: -9.9, r1: 105.59, r2: 265.21, dfr: 0.111, dfv: 0.057, phi1: 0.619, phi2: 0.595, tau1: 0.404, tau2: 0.219 },
  '0.500': { e0: 0.96991, e1: 0.99106, e2: 0.7615, e3: 1.012, e4: 1.0384, e5: -0.23522, e6: 0.029119, mh: 6.2, c1: -1.1459, c2: 0.12015, c3: -0.00322, h: 5.34, dc3: 0.0, c: -0.9693, vc: 1203.91, f4: -0.175, f5: -0.00744, f6: -9.9, f7: -9.9, r1: 105.54, r2: 265, dfr: 0.109, dfv: 0.06, phi1: 0.615, phi2: 0.599, tau1: 0.41, tau2: 0.224 },
  '0.550': { e0: 0.9048, e1: 0.9283, e2: 0.6984, e3: 0.9417, e4: 1.0833, e5: -0.23449, e6: 0.046932, mh: 6.2, c1: -1.1543, c2: 0.11847, c3: -0.002897, h: 5.41, dc3: 0.0, c: -0.98925, vc: 1194.59, f4: -0.16601, f5: -0.00758, f6: -9.9, f7: -9.9, r1: 105.61, r2: 264.74, dfr: 0.108, dfv: 0.066, phi1: 0.61, phi2: 0.603, tau1: 0.417, tau2: 0.229 },
  '0.600': { e0: 0.84165, e1: 0.86715, e2: 0.63875, e3: 0.87351, e4: 1.1336, e5: -0.23128, e6: 0.062667, mh: 6.2, c1: -1.1615, c2: 0.11671, c3: -0.00261, h: 5.48, dc3: 0.0, c: -1.0012, vc: 1184.93, f4: -0.1583, f5: -0.00773, f6: -9.9, f7: -9.9, r1: 105.83, r2: 264.83, dfr: 0.106, dfv: 0.071, phi1: 0.605, phi2: 0.607, tau1: 0.424, tau2: 0.235 },
  '0.650': { e0: 0.78181, e1: 0.80876, e2: 0.58231, e3: 0.80948, e4: 1.1861, e5: -0.22666, e6: 0.077997, mh: 6.2, c1: -1.1676, c2: 0.11465, c3: -0.002356, h: 5.53, dc3: 0.0, c: -1.0078, vc: 1175.19, f4: -0.15144, f5: -0.00787, f6: 0.005829, f7: 0.003762, r1: 106.2, r2: 265.2, dfr: 0.105, dfv: 0.073, phi1: 0.599, phi2: 0.611, tau1: 0.431, tau2: 0.243 },
  '0.667': { e0: 0.76262, e1: 0.78994, e2: 0.56422, e3: 0.78916, e4: 1.2035, e5: -0.22497, e6: 0.083058, mh: 6.2, c1: -1.1694, c2: 0.11394, c3: -0.002276, h: 5.54, dc3: 0.0, c: -1.0093, vc: 1165.69, f4: -0.14923, f5: -0.00792, f6: 0.026446, f7: 0.0171, r1: 106.75, r2: 265.38, dfr: 0.103, dfv: 0.074, phi1: 0.593, phi2: 0.615, tau1: 0.44, tau2: 0.25 },
  '0.700': { e0: 0.72513, e1: 0.75302, e2: 0.52878, e3: 0.74985, e4: 1.2375, e5: -0.22143, e6: 0.093185, mh: 6.2, c1: -1.1728, c2: 0.11253, c3: -0.002131, h: 5.56, dc3: 0.0, c: -1.0117, vc: 1156.46, f4: -0.14503, f5: -0.008, f6: 0.055495, f7: 0.035728, r1: 107.48, r2: 265.78, dfr: 0.102, dfv: 0.073, phi1: 0.587, phi2: 0.619, tau1: 0.448, tau2: 0.258 },
  '0.750': { e0: 0.66903, e1: 0.69737, e2: 0.47523, e3: 0.69173, e4: 1.2871, e5: -0.21591, e6: 0.10829, mh: 6.2, c1: -1.1777, c2: 0.11054, c3: -0.001931, h: 5.6, dc3: 0.0, c: -1.0154, vc: 1147.59, f4: -0.13866, f5: -0.00812, f6: 0.092259, f7: 0.059024, r1: 108.39, r2: 266.51, dfr: 0.1, dfv: 0.07, phi1: 0.581, phi2: 0.622, tau1: 0.457, tau2: 0.266 },
  '0.800': { e0: 0.61346, e1: 0.64196, e2: 0.42173, e3: 0.63519, e4: 1.3341, e5: -0.21047, e6: 0.12256, mh: 6.2, c1: -1.1819, c2: 0.10873, c3: -0.001754, h: 5.63, dc3: 0.0, c: -1.021, vc: 1139.21, f4: -0.13201, f5: -0.00822, f6: 0.1404, f7: 0.088481, r1: 109.62, r2: 267.32, dfr: 0.099, dfv: 0.063, phi1: 0.576, phi2: 0.624, tau1: 0.466, tau2: 0.274 },
  '0.850': { e0: 0.55853, e1: 0.58698, e2: 0.36813, e3: 0.57969, e4: 1.378, e5: -0.20528, e6: 0.13608, mh: 6.2, c1: -1.1854, c2: 0.10709, c3: -0.001597, h: 5.66, dc3: 0.0, c: -1.0282, vc: 1131.34, f4: -0.12517, f5: -0.0083, f6: 0.19495, f7: 0.12029, r1: 111.08, r2: 268.14, dfr: 0.099, dfv: 0.053, phi1: 0.57, phi2: 0.625, tau1: 0.475, tau2: 0.281 },
  '0.900': { e0: 0.50296, e1: 0.53136, e2: 0.31376, e3: 0.52361, e4: 1.4208, e5: -0.20011, e6: 0.14983, mh: 6.2, c1: -1.1884, c2: 0.10548, c3: -0.001456, h: 5.69, dc3: 0.0, c: -1.036, vc: 1123.91, f4: -0.11831, f5: -0.00836, f6: 0.25203, f7: 0.15159, r1: 112.71, r2: 268.9, dfr: 0.098, dfv: 0.042, phi1: 0.564, phi2: 0.626, tau1: 0.483, tau2: 0.288 },
  '0.950': { e0: 0.44701, e1: 0.47541, e2: 0.25919, e3: 0.46706, e4: 1.4623, e5: -0.1949, e6: 0.16432, mh: 6.2, c1: -1.1909, c2: 0.10389, c3: -0.001328, h: 5.72, dc3: 0.0, c: -1.0436, vc: 1116.83, f4: -0.1116, f5: -0.00841, f6: 0.3094, f7: 0.18077, r1: 114.5, r2: 269.55, dfr: 0.098, dfv: 0.03, phi1: 0.558, phi2: 0.626, tau1: 0.491, tau2: 0.294 },
  '1.000': { e0: 0.3932, e1: 0.4218, e2: 0.207, e3: 0.4124, e4: 1.5004, e5: -0.18983, e6: 0.17895, mh: 6.2, c1: -1.193, c2: 0.10248, c3: -0.00121, h: 5.74, dc3: 0.0, c: -1.05, vc: 1109.95, f4: -0.10521, f5: -0.00844, f6: 0.36695, f7: 0.20789, r1: 116.39, r2: 270, dfr: 0.098, dfv: 0.02, phi1: 0.553, phi2: 0.625, tau1: 0.498, tau2: 0.298 },
  '1.100': { e0: 0.28484, e1: 0.31374, e2: 0.10182, e3: 0.30209, e4: 1.569, e5: -0.18001, e6: 0.21042, mh: 6.2, c1: -1.1966, c2: 0.10016, c3: -0.000994, h: 5.82, dc3: 0.0, c: -1.0573, vc: 1103.07, f4: -0.093837, f5: -0.00847, f6: 0.42452, f7: 0.2331, r1: 118.3, r2: 270.18, dfr: 0.099, dfv: 0.007, phi1: 0.548, phi2: 0.624, tau1: 0.505, tau2: 0.302 },
  '1.200': { e0: 0.1734, e1: 0.20259, e2: -0.006195, e3: 0.18866, e4: 1.6282, e5: -0.1709, e6: 0.2441, mh: 6.2, c1: -1.1996, c2: 0.098482, c3: -0.000803, h: 5.92, dc3: 0.0, c: -1.0584, vc: 1096.04, f4: -0.084144, f5: -0.00842, f6: 0.48116, f7: 0.25606, r1: 120.19, r2: 269.42, dfr: 0.1, dfv: 0.002, phi1: 0.543, phi2: 0.623, tau1: 0.511, tau2: 0.306 },
  '1.300': { e0: 0.06152, e1: 0.09106, e2: -0.11345, e3: 0.07433, e4: 1.6794, e5: -0.16233, e6: 0.27799, mh: 6.2, c1: -1.2018, c2: 0.097375, c3: -0.000635, h: 6.01, dc3: 0.0, c: -1.0554, vc: 1088.67, f4: -0.075819, f5: -0.00829, f6: 0.53597, f7: 0.27648, r1: 122.01, r2: 267.82, dfr: 0.101, dfv: 0.003, phi1: 0.539, phi2: 0.622, tau1: 0.516, tau2: 0.309 },
  '1.400': { e0: -0.04575, e1: -0.0157, e2: -0.2155, e3: -0.03607, e4: 1.7239, e5: -0.15413, e6: 0.30956, mh: 6.2, c1: -1.2039, c2: 0.096743, c3: -0.00049, h: 6.1, dc3: 0.0, c: -1.0504, vc: 1080.77, f4: -0.068543, f5: -0.00806, f6: 0.58832, f7: 0.29424, r1: 123.75, r2: 265.45, dfr: 0.102, dfv: 0.006, phi1: 0.535, phi2: 0.62, tau1: 0.521, tau2: 0.312 },
  '1.500': { e0: -0.14954, e1: -0.11866, e2: -0.3138, e3: -0.1437, e4: 1.7622, e5: -0.1467, e6: 0.33896, mh: 6.2, c1: -1.2063, c2: 0.096445, c3: -0.000365, h: 6.18, dc3: 0.0, c: -1.0454, vc: 1072.39, f4: -0.062, f5: -0.00771, f6: 0.63789, f7: 0.30944, r1: 125.38, r2: 262.41, dfr: 0.104, dfv: 0.01, phi1: 0.532, phi2: 0.619, tau1: 0.525, tau2: 0.315 },
  '1.600': { e0: -0.2486, e1: -0.21672, e2: -0.40682, e3: -0.24708, e4: 1.7955, e5: -0.13997, e6: 0.36616, mh: 6.2, c1: -1.2086, c2: 0.096338, c3: -0.000259, h: 6.26, dc3: 0.0, c: -1.0421, vc: 1061.77, f4: -0.055927, f5: -0.00723, f6: 0.68889, f7: 0.32449, r1: 126.9, r2: 258.78, dfr: 0.105, dfv: 0.012, phi1: 0.529, phi2: 0.618, tau1: 0.528, tau2: 0.318 },
  '1.700': { e0: -0.34145, e1: -0.3084, e2: -0.49295, e3: -0.34465, e4: 1.8259, e5: -0.13361, e6: 0.39065, mh: 6.2, c1: -1.2106, c2: 0.096254, c3: -0.000171, h: 6.33, dc3: 0.0, c: -1.0404, vc: 1049.29, f4: -0.050286, f5: -0.00666, f6: 0.73578, f7: 0.3372, r1: 128.14, r2: 254.66, dfr: 0.106, dfv: 0.012, phi1: 0.527, phi2: 0.618, tau1: 0.53, tau2: 0.321 },
  '1.800': { e0: -0.42975, e1: -0.39558, e2: -0.57388, e3: -0.43818, e4: 1.8564, e5: -0.12686, e6: 0.41244, mh: 6.2, c1: -1.2123, c2: 0.096207, c3: -0.000099, h: 6.4, dc3: 0.0, c: -1.0397, vc: 1036.42, f4: -0.045096, f5: -0.00603, f6: 0.77992, f7: 0.34963, r1: 129.11, r2: 250.11, dfr: 0.106, dfv: 0.012, phi1: 0.526, phi2: 0.618, tau1: 0.531, tau2: 0.323 },
  '1.900': { e0: -0.51276, e1: -0.47731, e2: -0.64899, e3: -0.52682, e4: 1.8868, e5: -0.11959, e6: 0.43151, mh: 6.2, c1: -1.2141, c2: 0.096255, c3: -0.000042, h: 6.48, dc3: 0.0, c: -1.0395, vc: 1023.14, f4: -0.040373, f5: -0.0054, f6: 0.82427, f7: 0.36413, r1: 129.86, r2: 245.25, dfr: 0.106, dfv: 0.01, phi1: 0.526, phi2: 0.618, tau1: 0.532, tau2: 0.326 },
  '2.000': { e0: -0.58669, e1: -0.55003, e2: -0.71466, e3: -0.60658, e4: 1.9152, e5: -0.11237, e6: 0.44788, mh: 6.2, c1: -1.2159, c2: 0.096361, c3: 0.0, h: 6.54, dc3: 0.0, c: -1.0392, vc: 1009.49, f4: -0.036136, f5: -0.00479, f6: 0.87138, f7: 0.38245, r1: 130.37, r2: 240.14, dfr: 0.105, dfv: 0.008, phi1: 0.526, phi2: 0.618, tau1: 0.532, tau2: 0.329 },
  '2.200': { e0: -0.72143, e1: -0.6822, e2: -0.83003, e3: -0.75402, e4: 1.9681, e5: -0.098017, e6: 0.48024, mh: 6.2, c1: -1.219, c2: 0.096497, c3: 0.0, h: 6.66, dc3: 0.0, c: -1.0368, vc: 995.52, f4: -0.029105, f5: -0.00378, f6: 0.92033, f7: 0.40402, r1: 130.67, r2: 229.55, dfr: 0.103, dfv: 0.005, phi1: 0.527, phi2: 0.619, tau1: 0.533, tau2: 0.332 },
  '2.400': { e0: -0.8481, e1: -0.8069, e2: -0.9326, e3: -0.8941, e4: 2.017, e5: -0.083765, e6: 0.51873, mh: 6.2, c1: -1.2202, c2: 0.096198, c3: 0.0, h: 6.73, dc3: 0.0, c: -1.0323, vc: 981.33, f4: -0.02371, f5: -0.00302, f6: 0.96931, f7: 0.42742, r1: 130.81, r2: 219.05, dfr: 0.1, dfv: 0.003, phi1: 0.528, phi2: 0.619, tau1: 0.533, tau2: 0.335 },
  '2.500': { e0: -0.90966, e1: -0.86765, e2: -0.98228, e3: -0.96187, e4: 2.0406, e5: -0.076308, e6: 0.53883, mh: 6.2, c1: -1.2201, c2: 0.096106, c3: 0.0, h: 6.77, dc3: 0.0, c: -1.0294, vc: 966.94, f4: -0.021509, f5: -0.00272, f6: 1.0167, f7: 0.45142, r1: 130.81, r2: 214.04, dfr: 0.097, dfv: 0.002, phi1: 0.53, phi2: 0.619, tau1: 0.534, tau2: 0.337 },
  '2.600': { e0: -0.96863, e1: -0.92577, e2: -1.0313, e3: -1.0266, e4: 2.0628, e5: -0.068925, e6: 0.5581, mh: 6.2, c1: -1.2198, c2: 0.096136, c3: 0.0, h: 6.81, dc3: 0.0, c: -1.0262, vc: 952.34, f4: -0.019576, f5: -0.00246, f6: 1.0601, f7: 0.47422, r1: 130.72, r2: 209.32, dfr: 0.094, dfv: 0.001, phi1: 0.531, phi2: 0.62, tau1: 0.535, tau2: 0.34 },
  '2.800': { e0: -1.0817, e1: -1.0367, e2: -1.1301, e3: -1.1495, e4: 2.1014, e5: -0.055229, e6: 0.59394, mh: 6.2, c1: -1.2189, c2: 0.096667, c3: 0.0, h: 6.87, dc3: 0.0, c: -1.019, vc: 937.52, f4: -0.016324, f5: -0.00208, f6: 1.099, f7: 0.49536, r1: 130.57, r2: 201.08, dfr: 0.091, dfv: 0.0, phi1: 0.532, phi2: 0.619, tau1: 0.536, tau2: 0.342 },
  '3.000': { e0: -1.1898, e1: -1.142, e2: -1.23, e3: -1.2664, e4: 2.1323, e5: -0.04332, e6: 0.62694, mh: 6.2, c1: -1.2179, c2: 0.097638, c3: 0.0, h: 6.93, dc3: 0.0, c: -1.0112, vc: 922.43, f4: -0.013577, f5: -0.00183, f6: 1.1348, f7: 0.51585, r1: 130.36, r2: 195, dfr: 0.088, dfv: 0.0, phi1: 0.534, phi2: 0.619, tau1: 0.537, tau2: 0.344 },
  '3.200': { e0: -1.2914, e1: -1.2406, e2: -1.3255, e3: -1.376, e4: 2.1545, e5: -0.03444, e6: 0.65811, mh: 6.2, c1: -1.2169, c2: 0.098649, c3: -0.000023, h: 6.99, dc3: 0.0, c: -1.0032, vc: 908.79, f4: -0.01103, f5: -0.00167, f6: 1.1638, f7: 0.53411, r1: 130.13, r2: 191.61, dfr: 0.084, dfv: 0.0, phi1: 0.535, phi2: 0.618, tau1: 0.538, tau2: 0.345 },
  '3.400': { e0: -1.386, e1: -1.3322, e2: -1.415, e3: -1.4786, e4: 2.1704, e5: -0.027889, e6: 0.68755, mh: 6.2, c1: -1.216, c2: 0.099553, c3: -0.00004, h: 7.08, dc3: 0.0, c: -0.99512, vc: 896.15, f4: -0.008665, f5: -0.00158, f6: 1.1882, f7: 0.55145, r1: 129.9, r2: 190.73, dfr: 0.081, dfv: 0.0, phi1: 0.535, phi2: 0.618, tau1: 0.54, tau2: 0.346 },
  '3.500': { e0: -1.4332, e1: -1.3778, e2: -1.4599, e3: -1.5297, e4: 2.1775, e5: -0.024997, e6: 0.70216, mh: 6.2, c1: -1.2156, c2: 0.099989, c3: -0.000045, h: 7.12, dc3: 0.0, c: -0.991, vc: 883.16, f4: -0.007568, f5: -0.00155, f6: 1.2114, f7: 0.56981, r1: 129.71, r2: 191.11, dfr: 0.078, dfv: 0.0, phi1: 0.536, phi2: 0.617, tau1: 0.541, tau2: 0.347 },
  '3.600': { e0: -1.4762, e1: -1.4193, e2: -1.5014, e3: -1.5764, e4: 2.1834, e5: -0.022575, e6: 0.71523, mh: 6.2, c1: -1.2156, c2: 0.10043, c3: -0.000049, h: 7.16, dc3: 0.0, c: -0.98682, vc: 870.05, f4: -0.006537, f5: -0.00154, f6: 1.2336, f7: 0.58932, r1: 129.56, r2: 191.98, dfr: 0.075, dfv: 0.0, phi1: 0.536, phi2: 0.616, tau1: 0.542, tau2: 0.348 },
  '3.800': { e0: -1.5617, e1: -1.5014, e2: -1.5865, e3: -1.6685, e4: 2.1938, e5: -0.018362, e6: 0.74028, mh: 6.2, c1: -1.2158, c2: 0.10142, c3: -0.000053, h: 7.24, dc3: 0.0, c: -0.97826, vc: 857.07, f4: -0.004702, f5: -0.00152, f6: 1.2534, f7: 0.60918, r1: 129.49, r2: 195.01, dfr: 0.072, dfv: 0.0, phi1: 0.536, phi2: 0.616, tau1: 0.543, tau2: 0.349 },
  '4.000': { e0: -1.6388, e1: -1.5748, e2: -1.6673, e3: -1.7516, e4: 2.204, e5: -0.014642, e6: 0.76303, mh: 6.2, c1: -1.2162, c2: 0.10218, c3: -0.000052, h: 7.32, dc3: 0.0, c: -0.96938, vc: 844.48, f4: -0.003212, f5: -0.00152, f6: 1.2711, f7: 0.62939, r1: 129.49, r2: 199.45, dfr: 0.07, dfv: 0.0, phi1: 0.536, phi2: 0.616, tau1: 0.543, tau2: 0.349 },
  '4.200': { e0: -1.7116, e1: -1.6439, e2: -1.7451, e3: -1.829, e4: 2.2123, e5: -0.012248, e6: 0.78552, mh: 6.2, c1: -1.2165, c2: 0.10269, c3: -0.000047, h: 7.39, dc3: 0.0, c: -0.96012, vc: 832.45, f4: -0.002103, f5: -0.00152, f6: 1.287, f7: 0.65157, r1: 129.57, r2: 204.93, dfr: 0.068, dfv: 0.0, phi1: 0.535, phi2: 0.616, tau1: 0.542, tau2: 0.349 },
  '4.400': { e0: -1.7798, e1: -1.7089, e2: -1.8192, e3: -1.9011, e4: 2.2181, e5: -0.011459, e6: 0.80792, mh: 6.2, c1: -1.2169, c2: 0.10304, c3: -0.000039, h: 7.46, dc3: 0.0, c: -0.95049, vc: 821.18, f4: -0.001324, f5: -0.0015, f6: 1.3004, f7: 0.67421, r1: 129.71, r2: 211.09, dfr: 0.066, dfv: 0.0, phi1: 0.534, phi2: 0.617, tau1: 0.54, tau2: 0.347 },
  '4.600': { e0: -1.8469, e1: -1.7731, e2: -1.8923, e3: -1.9712, e4: 2.223, e5: -0.01176, e6: 0.83126, mh: 6.2, c1: -1.2175, c2: 0.10324, c3: -0.000027, h: 7.52, dc3: 0.0, c: -0.9405, vc: 810.79, f4: -0.000804, f5: -0.00148, f6: 1.3125, f7: 0.69698, r1: 129.87, r2: 217.56, dfr: 0.064, dfv: 0.0, phi1: 0.533, phi2: 0.619, tau1: 0.538, tau2: 0.345 },
  '4.800': { e0: -1.9063, e1: -1.8303, e2: -1.9573, e3: -2.0326, e4: 2.2268, e5: -0.012879, e6: 0.8524, mh: 6.2, c1: -1.2182, c2: 0.10337, c3: -0.000014, h: 7.64, dc3: 0.0, c: -0.93018, vc: 801.41, f4: -0.000471, f5: -0.00146, f6: 1.3225, f7: 0.71888, r1: 130.05, r2: 223.99, dfr: 0.063, dfv: 0.0, phi1: 0.531, phi2: 0.621, tau1: 0.535, tau2: 0.341 },
  '5.000': { e0: -1.966, e1: -1.8882, e2: -2.0245, e3: -2.0928, e4: 2.2299, e5: -0.014855, e6: 0.87314, mh: 6.2, c1: -1.2189, c2: 0.10353, c3: 0.0, h: 7.78, dc3: 0.0, c: -0.91954, vc: 793.13, f4: -0.000255, f5: -0.00144, f6: 1.3289, f7: 0.73806, r1: 130.22, r2: 230, dfr: 0.061, dfv: 0.0, phi1: 0.528, phi2: 0.622, tau1: 0.532, tau2: 0.335 },
  '5.500': { e0: -2.1051, e1: -2.0232, e2: -2.1908, e3: -2.2288, e4: 2.2389, e5: -0.019502, e6: 0.91466, mh: 6.2, c1: -1.2204, c2: 0.1046, c3: 0.0, h: 8.07, dc3: 0.0, c: -0.89176, vc: 785.73, f4: 0.000072, f5: -0.0014, f6: 1.345, f7: 0.7779, r1: 130.39, r2: 241.86, dfr: 0.06, dfv: 0.0, phi1: 0.526, phi2: 0.624, tau1: 0.528, tau2: 0.329 },
  '6.000': { e0: -2.2421, e1: -2.1563, e2: -2.3659, e3: -2.3579, e4: 2.2377, e5: -0.026383, e6: 0.9487, mh: 6.2, c1: -1.2232, c2: 0.1075, c3: 0.0, h: 8.48, dc3: 0.0, c: -0.86286, vc: 779.91, f4: 0.000188, f5: -0.00138, f6: 1.3496, f7: 0.80278, r1: 130.53, r2: 249.34, dfr: 0.059, dfv: 0.0, phi1: 0.524, phi2: 0.625, tau1: 0.524, tau2: 0.321 },
  '6.500': { e0: -2.3686, e1: -2.2785, e2: -2.5322, e3: -2.477, e4: 2.215, e5: -0.039505, e6: 0.97643, mh: 6.2, c1: -1.2299, c2: 0.11231, c3: 0.0, h: 8.9, dc3: 0.0, c: -0.83355, vc: 775.6, f4: 0.000159, f5: -0.00137, f6: 1.3489, f7: 0.8148, r1: 130.63, r2: 252.94, dfr: 0.059, dfv: 0.0, phi1: 0.52, phi2: 0.634, tau1: 0.517, tau2: 0.312 },
  '7.000': { e0: -2.4827, e1: -2.3881, e2: -2.6818, e3: -2.5854, e4: 2.172, e5: -0.05914, e6: 0.99757, mh: 6.2, c1: -1.2408, c2: 0.11853, c3: 0.0, h: 9.2, dc3: 0.0, c: -0.80457, vc: 772.68, f4: 0.000056, f5: -0.00137, f6: 1.3422, f7: 0.81615, r1: 130.7, r2: 253.12, dfr: 0.059, dfv: 0.0, phi1: 0.515, phi2: 0.636, tau1: 0.514, tau2: 0.302 },
  '7.500': { e0: -2.5865, e1: -2.4874, e2: -2.8176, e3: -2.6854, e4: 2.1187, e5: -0.081606, e6: 1.0121, mh: 6.2, c1: -1.2543, c2: 0.12507, c3: 0.0, h: 9.48, dc3: 0.0, c: -0.77665, vc: 771.01, f4: -0.000055, f5: -0.00137, f6: 1.3288, f7: 0.809, r1: 130.72, r2: 250.39, dfr: 0.058, dfv: 0.0, phi1: 0.512, phi2: 0.634, tau1: 0.511, tau2: 0.27 },
  '8.000': { e0: -2.6861, e1: -2.5829, e2: -2.9438, e3: -2.7823, e4: 2.0613, e5: -0.10382, e6: 1.0232, mh: 6.2, c1: -1.2688, c2: 0.13146, c3: 0.0, h: 9.57, dc3: 0.0, c: -0.75033, vc: 760.81, f4: -0.000117, f5: -0.00137, f6: 1.3084, f7: 0.79538, r1: 130.87, r2: 245.23, dfr: 0.059, dfv: 0.0, phi1: 0.51, phi2: 0.63, tau1: 0.507, tau2: 0.278 },
  '8.500': { e0: -2.782, e1: -2.6752, e2: -3.0597, e3: -2.8776, e4: 2.0084, e5: -0.12114, e6: 1.0335, mh: 6.2, c1: -1.2839, c2: 0.13742, c3: 0.0, h: 9.62, dc3: 0.0, c: -0.72544, vc: 764.5, f4: -0.000131, f5: -0.00137, f6: 1.2822, f7: 0.77671, r1: 130.71, r2: 238.13, dfr: 0.059, dfv: 0.0, phi1: 0.509, phi2: 0.622, tau1: 0.503, tau2: 0.265 },
  '9.000': { e0: -2.8792, e1: -2.7687, e2: -3.1713, e3: -2.9759, e4: 1.9605, e5: -0.13407, e6: 1.0453, mh: 6.2, c1: -1.2989, c2: 0.14294, c3: 0.0, h: 9.66, dc3: 0.0, c: -0.70161, vc: 768.07, f4: -0.000108, f5: -0.00137, f6: 1.2515, f7: 0.75425, r1: 130.5, r2: 229.56, dfr: 0.06, dfv: 0.0, phi1: 0.509, phi2: 0.613, tau1: 0.498, tau2: 0.252 },
  '9.500': { e0: -2.9769, e1: -2.8634, e2: -3.2785, e3: -3.076, e4: 1.9189, e5: -0.14364, e6: 1.0567, mh: 6.2, c1: -1.313, c2: 0.14781, c3: 0.0, h: 9.66, dc3: 0.0, c: -0.6785, vc: 771.55, f4: -0.00006, f5: -0.00136, f6: 1.2179, f7: 0.72925, r1: 130.26, r2: 220.02, dfr: 0.06, dfv: 0.0, phi1: 0.509, phi2: 0.604, tau1: 0.492, tau2: 0.239 },
  '10.00': { e0: -3.0702, e1: -2.9537, e2: -3.3776, e3: -3.1726, e4: 1.8837, e5: -0.15096, e6: 1.0651, mh: 6.2, c1: -1.3253, c2: 0.15183, c3: 0.0, h: 9.66, dc3: 0.0, c: -0.65575, vc: 775, f4: 0.0, f5: -0.00136, f6: 1.1829, f7: 0.703, r1: 130, r2: 210, dfr: 0.06, dfv: 0.0, phi1: 0.51, phi2: 0.604, tau1: 0.487, tau2: 0.239 }
};
// Regional anelastic-path adjustments (the only column that differs between
// the hazardlib base / LowQ / HighQ tables).
Physics.BSSA2014_DC3 = {
  base: { pga: 0.0, pgv: 0.0,
    '0.010': 0.0,
    '0.020': 0.0,
    '0.022': 0.0,
    '0.025': 0.0,
    '0.029': 0.0,
    '0.030': 0.0,
    '0.032': 0.0,
    '0.035': 0.0,
    '0.036': 0.0,
    '0.040': 0.0,
    '0.042': 0.0,
    '0.044': 0.0,
    '0.045': 0.0,
    '0.046': 0.0,
    '0.048': 0.0,
    '0.050': 0.0,
    '0.055': 0.0,
    '0.060': 0.0,
    '0.065': 0.0,
    '0.067': 0.0,
    '0.070': 0.0,
    '0.075': 0.0,
    '0.080': 0.0,
    '0.085': 0.0,
    '0.090': 0.0,
    '0.095': 0.0,
    '0.100': 0.0,
    '0.110': 0.0,
    '0.120': 0.0,
    '0.130': 0.0,
    '0.133': 0.0,
    '0.140': 0.0,
    '0.150': 0.0,
    '0.160': 0.0,
    '0.170': 0.0,
    '0.180': 0.0,
    '0.190': 0.0,
    '0.200': 0.0,
    '0.220': 0.0,
    '0.240': 0.0,
    '0.250': 0.0,
    '0.260': 0.0,
    '0.280': 0.0,
    '0.290': 0.0,
    '0.300': 0.0,
    '0.320': 0.0,
    '0.340': 0.0,
    '0.350': 0.0,
    '0.360': 0.0,
    '0.380': 0.0,
    '0.400': 0.0,
    '0.420': 0.0,
    '0.440': 0.0,
    '0.450': 0.0,
    '0.460': 0.0,
    '0.480': 0.0,
    '0.500': 0.0,
    '0.550': 0.0,
    '0.600': 0.0,
    '0.650': 0.0,
    '0.667': 0.0,
    '0.700': 0.0,
    '0.750': 0.0,
    '0.800': 0.0,
    '0.850': 0.0,
    '0.900': 0.0,
    '0.950': 0.0,
    '1.000': 0.0,
    '1.100': 0.0,
    '1.200': 0.0,
    '1.300': 0.0,
    '1.400': 0.0,
    '1.500': 0.0,
    '1.600': 0.0,
    '1.700': 0.0,
    '1.800': 0.0,
    '1.900': 0.0,
    '2.000': 0.0,
    '2.200': 0.0,
    '2.400': 0.0,
    '2.500': 0.0,
    '2.600': 0.0,
    '2.800': 0.0,
    '3.000': 0.0,
    '3.200': 0.0,
    '3.400': 0.0,
    '3.500': 0.0,
    '3.600': 0.0,
    '3.800': 0.0,
    '4.000': 0.0,
    '4.200': 0.0,
    '4.400': 0.0,
    '4.600': 0.0,
    '4.800': 0.0,
    '5.000': 0.0,
    '5.500': 0.0,
    '6.000': 0.0,
    '6.500': 0.0,
    '7.000': 0.0,
    '7.500': 0.0,
    '8.000': 0.0,
    '8.500': 0.0,
    '9.000': 0.0,
    '9.500': 0.0,
    '10.00': 0.0
  },
  lowQ: { pga: -0.00255, pgv: -0.00033,  // Italy / Japan
    '0.010': -0.0024367,
    '0.020': -0.00234,
    '0.022': -0.0022886,
    '0.025': -0.00225,
    '0.029': -0.0022145,
    '0.030': -0.0021676,
    '0.032': -0.0021167,
    '0.035': -0.0020957,
    '0.036': -0.0020748,
    '0.040': -0.0020539,
    '0.042': -0.0020348,
    '0.044': -0.0020157,
    '0.045': -0.0020011,
    '0.046': -0.0019929,
    '0.048': -0.0019884,
    '0.050': -0.0019911,
    '0.055': -0.0020011,
    '0.060': -0.0020193,
    '0.065': -0.0020448,
    '0.067': -0.0020766,
    '0.070': -0.0021148,
    '0.075': -0.0021594,
    '0.080': -0.0022122,
    '0.085': -0.0022695,
    '0.090': -0.0023269,
    '0.095': -0.0023833,
    '0.100': -0.0024388,
    '0.110': -0.0024916,
    '0.120': -0.0025398,
    '0.130': -0.0025844,
    '0.133': -0.0026263,
    '0.140': -0.0026663,
    '0.150': -0.0027063,
    '0.160': -0.0027509,
    '0.170': -0.0028019,
    '0.180': -0.0028547,
    '0.190': -0.0029111,
    '0.200': -0.0029702,
    '0.220': -0.0030285,
    '0.240': -0.0030849,
    '0.250': -0.0031395,
    '0.260': -0.0031896,
    '0.280': -0.0032351,
    '0.290': -0.0032742,
    '0.300': -0.0032969,
    '0.320': -0.0033033,
    '0.340': -0.0032997,
    '0.350': -0.0032869,
    '0.360': -0.0032669,
    '0.380': -0.0032423,
    '0.400': -0.0032123,
    '0.420': -0.0031768,
    '0.440': -0.0031322,
    '0.450': -0.0030794,
    '0.460': -0.0030212,
    '0.480': -0.0029639,
    '0.500': -0.0029065,
    '0.550': -0.0028483,
    '0.600': -0.0027892,
    '0.650': -0.0027273,
    '0.667': -0.0026618,
    '0.700': -0.0025953,
    '0.750': -0.0025271,
    '0.800': -0.0024561,
    '0.850': -0.0023787,
    '0.900': -0.0022932,
    '0.950': -0.0021958,
    '1.000': -0.0020894,
    '1.100': -0.0019774,
    '1.200': -0.0018619,
    '1.300': -0.0017454,
    '1.400': -0.0016298,
    '1.500': -0.0015179,
    '1.600': -0.0014114,
    '1.700': -0.0013231,
    '1.800': -0.0012531,
    '1.900': -0.0012012,
    '2.000': -0.0011703,
    '2.200': -0.0011566,
    '2.400': -0.0011548,
    '2.500': -0.0011593,
    '2.600': -0.0011684,
    '2.800': -0.0011803,
    '3.000': -0.0011885,
    '3.200': -0.0011921,
    '3.400': -0.0011866,
    '3.500': -0.0011739,
    '3.600': -0.0011539,
    '3.800': -0.0011229,
    '4.000': -0.0010829,
    '4.200': -0.0010247,
    '4.400': -0.0009464,
    '4.600': -0.0008445,
    '4.800': -0.000718,
    '5.000': -0.0005715,
    '5.500': -0.0004077,
    '6.000': -0.0002284,
    '6.500': -0.0000364,
    '7.000': 0.0001684,
    '7.500': 0.0003849,
    '8.000': 0.00072,
    '8.500': 0.00094,
    '9.000': 0.00113,
    '9.500': 0.00131,
    '10.00': 0.00149
  },
  highQ: { pga: 0.002858, pgv: 0.004345,  // China / Turkey
    '0.010': 0.002816,
    '0.020': 0.00278,
    '0.022': 0.00276,
    '0.025': 0.002754,
    '0.029': 0.002762,
    '0.030': 0.002765,
    '0.032': 0.002769,
    '0.035': 0.002784,
    '0.036': 0.002801,
    '0.040': 0.002822,
    '0.042': 0.002847,
    '0.044': 0.002874,
    '0.045': 0.0029,
    '0.046': 0.002923,
    '0.048': 0.002944,
    '0.050': 0.002957,
    '0.055': 0.002964,
    '0.060': 0.002968,
    '0.065': 0.002968,
    '0.067': 0.002968,
    '0.070': 0.002964,
    '0.075': 0.002957,
    '0.080': 0.002945,
    '0.085': 0.00293,
    '0.090': 0.002914,
    '0.095': 0.002897,
    '0.100': 0.002879,
    '0.110': 0.002863,
    '0.120': 0.002847,
    '0.130': 0.002831,
    '0.133': 0.002817,
    '0.140': 0.002802,
    '0.150': 0.002786,
    '0.160': 0.002765,
    '0.170': 0.002734,
    '0.180': 0.002699,
    '0.190': 0.00266,
    '0.200': 0.002612,
    '0.220': 0.00256,
    '0.240': 0.002505,
    '0.250': 0.002444,
    '0.260': 0.00238,
    '0.280': 0.002314,
    '0.290': 0.00225,
    '0.300': 0.002196,
    '0.320': 0.002155,
    '0.340': 0.002124,
    '0.350': 0.002104,
    '0.360': 0.002097,
    '0.380': 0.002098,
    '0.400': 0.002107,
    '0.420': 0.002127,
    '0.440': 0.00216,
    '0.450': 0.002202,
    '0.460': 0.00225,
    '0.480': 0.002298,
    '0.500': 0.002348,
    '0.550': 0.002399,
    '0.600': 0.002452,
    '0.650': 0.002508,
    '0.667': 0.002568,
    '0.700': 0.002629,
    '0.750': 0.00269,
    '0.800': 0.002746,
    '0.850': 0.002797,
    '0.900': 0.002843,
    '0.950': 0.002885,
    '1.000': 0.002921,
    '1.100': 0.002954,
    '1.200': 0.002982,
    '1.300': 0.003007,
    '1.400': 0.003026,
    '1.500': 0.003039,
    '1.600': 0.003041,
    '1.700': 0.003026,
    '1.800': 0.003,
    '1.900': 0.002968,
    '2.000': 0.002923,
    '2.200': 0.00287,
    '2.400': 0.002815,
    '2.500': 0.002761,
    '2.600': 0.002708,
    '2.800': 0.002658,
    '3.000': 0.002616,
    '3.200': 0.002588,
    '3.400': 0.002575,
    '3.500': 0.002572,
    '3.600': 0.002574,
    '3.800': 0.002586,
    '4.000': 0.002605,
    '4.200': 0.002619,
    '4.400': 0.002624,
    '4.600': 0.002622,
    '4.800': 0.002615,
    '5.000': 0.002604,
    '5.500': 0.002591,
    '6.000': 0.002584,
    '6.500': 0.002586,
    '7.000': 0.002603,
    '7.500': 0.0026,
    '8.000': 0.00263,
    '8.500': 0.00267,
    '9.000': 0.00276,
    '9.500': 0.00289,
    '10.00': 0.00303
  }
};

// Style-of-faulting term (hazardlib _get_style_of_faulting_term): default
// normal (e2); |rake|<=30 or 180-|rake|<=30 -> strike-slip (e1);
// 30 < rake < 150 (signed) -> reverse (e3). rake == null -> unspecified e0
// (the hazardlib NoSOF alias).
function _bssa14StyleTerm(C, rake) {
  if (rake == null || !isFinite(Number(rake))) return C.e0;
  var r = Number(rake), a = Math.abs(r);
  if (a <= 30 || (180 - a) <= 30) return C.e1;
  if (r > 30 && r < 150) return C.e3;
  return C.e2;
}
// Eq.(2) magnitude ramp around the Mh hinge.
function _bssa14MagTerm(C, mw) {
  var d = mw - C.mh;
  return mw <= C.mh ? C.e4 * d + C.e5 * d * d : C.e6 * d;
}
// Eq.(3)-(4) path term with the regional Dc3 anelastic adjustment.
function _bssa14PathTerm(C, mw, rjbKm, dc3) {
  var K = Physics.BSSA2014_CONSTS;
  var R = Math.sqrt(rjbKm * rjbKm + C.h * C.h);
  return (C.c1 + C.c2 * (mw - K.mref)) * Math.log(R / K.rref) + (C.c3 + dc3) * (R - K.rref);
}
// Eq.(5) site term = Eq.(6) linear + Eq.(7)-(8) nonlinear (basin off).
// pgaRockG is the median PGA on rock (g) from the PGA row, per hazardlib.
function _bssa14SiteTerm(C, vs30, pgaRockG) {
  var K = Physics.BSSA2014_CONSTS;
  var flin = C.c * Math.log(Math.min(vs30, C.vc) / K.vref);
  var vs = Math.min(vs30, K.vref);
  var f2 = C.f4 * (Math.exp(C.f5 * (vs - 360.0)) - Math.exp(C.f5 * 400.0));
  var fnl = K.f1 + f2 * Math.log((pgaRockG + K.f3) / K.f3);
  return flin + fnl;
}
// SA period resolution (same engine conventions as the NGA-Sub Parker table):
// exact table row else log-period interpolation of the FINAL value between
// the bracketing rows (the production PSHA/UHS period set — 0.10..5.00 s —
// all hits exact rows; the interpolation is for off-grid ad-hoc requests).
// Outside [0.01, 10] s there is honest no-coverage (null).
function _bssa14SaKey(T) {
  var keys = Physics.BSSA2014_SA_KEYS;
  for (var i = 0; i < keys.length; i++) {
    if (Math.abs(parseFloat(keys[i]) - T) < 1e-12) return keys[i];
  }
  return null;
}
function _bssa14SaBracket(T) {
  var keys = Physics.BSSA2014_SA_KEYS;
  var t0 = parseFloat(keys[0]), tN = parseFloat(keys[keys.length - 1]);
  if (!(T > t0 && T < tN)) return null;
  for (var i = 0; i < keys.length - 1; i++) {
    var lo = parseFloat(keys[i]), hi = parseFloat(keys[i + 1]);
    if (T > lo && T < hi) return { lo: keys[i], hi: keys[i + 1], tLo: lo, tHi: hi };
  }
  return null;
}
// Median rock PGA (g), PGA row only — drives the nonlinear site term.
Physics.bssa2014PgaRockG = function(mw, rjbKm, rake, variant) {
  var C = Physics.BSSA2014_PAPER.pga;
  var v = Physics.BSSA2014_DC3[variant] || Physics.BSSA2014_DC3.base;
  var rjb = Math.max(0, Number(rjbKm) || 0);
  return Math.exp(_bssa14StyleTerm(C, rake) + _bssa14MagTerm(C, mw) +
                  _bssa14PathTerm(C, mw, rjb, v.pga));
};
/**
 * BSSA14 ln(median) in hazardlib native units: 'pga' -> ln g, 'pgv' ->
 * ln cm/s, SA period key or number (seconds) -> ln g. variant: 'base' |
 * 'lowQ' | 'highQ' (per-IMT Dc3 adjustment). Unknown periods -> null
 * (never the pga fallback).
 */
Physics.bssa2014Ln = function(imt, mw, rjbKm, vs30, rake, variant) {
  var v = Physics.BSSA2014_DC3[variant] || Physics.BSSA2014_DC3.base;
  var rjb = Math.max(0, Number(rjbKm) || 0);
  var v30 = Number(vs30) || 400;
  var pgaRock = Physics.bssa2014PgaRockG(mw, rjb, rake, variant);
  function rowLn(key) {
    var C = Physics.BSSA2014_PAPER[key];
    if (!C) return null;
    var dc3 = v[key] != null ? v[key] : 0;
    return _bssa14StyleTerm(C, rake) + _bssa14MagTerm(C, mw) +
           _bssa14PathTerm(C, mw, rjb, dc3) + _bssa14SiteTerm(C, v30, pgaRock);
  }
  if (imt === 'pga' || imt === 'pgv') return rowLn(imt);
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _bssa14SaKey(T);
  if (key) return rowLn(key);
  var br = _bssa14SaBracket(T);
  if (!br) return null;
  var lo = rowLn(br.lo), hi = rowLn(br.hi);
  var w = (Math.log(T) - Math.log(br.tLo)) / (Math.log(br.tHi) - Math.log(br.tLo));
  return lo + w * (hi - lo);
};
// Eq.(13)-(17) aleatory variability in ln units. Faithful to hazardlib —
// including its boundary quirk at vs30 == v1 exactly, where BOTH the vs30<=v1
// branch (-DfV) and the v1<=vs30<=v2 taper branch (-DfV * 1) fire (the
// fixture grid pins 225.0 m/s so the quirk is locked, not hidden). SA periods
// read the per-row tau/phi columns; off-grid requests interpolate the (tau,
// phi) components between the bracketing rows (parker2022SigmaLn convention).
Physics.bssa2014SigmaLn = function(imt, mw, rjbKm, vs30) {
  var K = Physics.BSSA2014_CONSTS;
  var m = Number(mw) || 0;
  var r = Math.max(0, Number(rjbKm) || 0);
  var v = Number(vs30) || 400;
  function rowSigma(key) {
    var C = Physics.BSSA2014_PAPER[key];
    if (!C) return null;
    var tau = m <= 4.5 ? C.tau1 : (m >= 5.5 ? C.tau2 : C.tau1 + (C.tau2 - C.tau1) * (m - 4.5));
    var phi = m <= 4.5 ? C.phi1 : (m >= 5.5 ? C.phi2 : C.phi1 + (C.phi2 - C.phi1) * (m - 4.5));
    if (r > C.r2) phi += C.dfr;
    else if (r > C.r1) phi += C.dfr * (Math.log(r / C.r1) / Math.log(C.r2 / C.r1));
    if (v <= K.v1) phi -= C.dfv;
    if (v >= K.v1 && v <= K.v2) phi -= C.dfv * (Math.log(K.v2 / v) / Math.log(K.v2 / K.v1));
    return { tau: tau, phi: phi };
  }
  function finish(s) { s.sigmaT = Math.sqrt(s.tau * s.tau + s.phi * s.phi); return s; }
  if (imt === 'pga' || imt === 'pgv') return finish(rowSigma(imt));
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _bssa14SaKey(T);
  if (key) return finish(rowSigma(key));
  var br = _bssa14SaBracket(T);
  if (!br) return null;
  var slo = rowSigma(br.lo), shi = rowSigma(br.hi);
  var w = (Math.log(T) - Math.log(br.tLo)) / (Math.log(br.tHi) - Math.log(br.tLo));
  var tauI = slo.tau + w * (shi.tau - slo.tau), phiI = slo.phi + w * (shi.phi - slo.phi);
  return { tau: tauI, phi: phiI, sigmaT: Math.sqrt(tauI * tauI + phiI * phiI) };
};
Physics.bssa2014Sigma = function(imt, mw, rjbKm, vs30) {
  var s = Physics.bssa2014SigmaLn(imt, mw, rjbKm, vs30);
  if (!s) return null;
  return { tau: s.tau / _LN10, phi: s.phi / _LN10, sigmaT: s.sigmaT / _LN10 };
};
Physics.BSSA2014_G_TO_GAL = 980.665;
Physics.pgaBssa2014 = function(mw, rjbKm, vs30, rake, variant) {
  var pgaGal = Math.exp(Physics.bssa2014Ln('pga', mw, rjbKm, vs30, rake, variant)) * Physics.BSSA2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(pgaGal / Physics.GMPE_PGA_SOFT_CAP);
};
Physics.pgvBssa2014 = function(mw, rjbKm, vs30, rake, variant) {
  var pgv = Math.exp(Physics.bssa2014Ln('pgv', mw, rjbKm, vs30, rake, variant));
  return Physics.GMPE_PGV_SOFT_CAP * Math.tanh(pgv / Physics.GMPE_PGV_SOFT_CAP);
};
/** SA in gal (display soft-capped like the zhao2006/ngasub SA paths); null
 *  for periods outside [0.01, 10] s. */
Physics.saBssa2014Gal = function(periodKey, mw, rjbKm, vs30, rake, variant) {
  var lnA = Physics.bssa2014Ln(periodKey, mw, rjbKm, vs30, rake, variant || Physics.activeBssa2014Variant());
  if (lnA == null) return null;
  var saGal = Math.exp(lnA) * Physics.BSSA2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(saGal / Physics.GMPE_PGA_SOFT_CAP);
};

// ================================================================
//  NGA-SUB GMPE (Parker et al. 2020 PEER 2020/03; Parker et al. 2022
//  Earthquake Spectra 38(2) 845-870) — v6.8 NGA-Sub batch
//
//  Faithful scalar port of the official openquake.hazardlib implementation
//  (gem/oq-engine openquake/hazardlib/gsim/parker_2020.py, sha256
//  32df333b97242449ad2de22f93ffd7d0bf5335b5c56a69c05e3142dcf568f322), asserted
//  in tests/gmpe-ngasub.test.js against the independent Python transcription
//  tools/gen-gmpe-fixtures-ngasub.py (35,568 frozen points, max |Δln| target
//  ~1e-14 like zhao/bssa14). Scope:
//   * interface + intraslab medians, all 26 IMT rows (pgv/pga/SA 0.01-10 s),
//     regional c0 / a0 / s1-s2 / m_b factors; ergodic Tau/phi sigma model.
//   * Basin term OFF (no region pack carries z2.5 data) — the J_e*/C_e*/
//     del_* columns are carried verbatim but unused; epistemic sigma_mu and
//     the Alaska-2023 bias adjustment are not applied (hazardlib defaults);
//     non-ergodic sigma columns carried but unused.
//   * trt: 'interface' | 'intraslab'; variant: { region: null|'Cascadia'|
//     'SA'|'TW', sat: null|'SA_S'|'TW_E' } — sat defaults to region exactly
//     like the hazardlib __init__.
//   * Region assignment (production): california -> Cascadia; chile -> SA/
//     SA_S (the report's split is tectonic — "the southern part of South
//     America (namely, Chile)" PEER 2020/03 §4.3.4 — so the whole bundled
//     strip is SA_S); ecuador -> SA/SA_N (the northern South America segment
//     — Ecuador/Colombia margin; 2026-10-14 new-region batch); taiwan ->
//     TW/TW_E (columns identical to TW_W, and the report applied the
//     northeast constant to the full region); newzealand / italy / unset ->
//     global (NGA-Sub collected NZ data but published no NZ regional factors;
//     Italy has no subduction class).
//   * SA periods missing from the table (zhao keys 0.60/0.70/0.80/0.90/1.25)
//     are log-period interpolated between the bracketing Parker rows (engine-
//     side convention — hazardlib raises KeyError there); outside [0.01,10] s
//     the Ln/Sigma return null (honest no-coverage).
//  pgaParker2022 converts ln g -> gal with 980.665 and applies the same
//  display soft caps as zhao2006/bssa14.
// ================================================================
Physics.PARKER2022_CONSTS = { b4: 0.1, f3: 0.05, vb: 200, vrefF: 760, v1: 270, vref: 760 };
Physics.PARKER2022_MB_INTERFACE = { Aleutian: 8, AK: 8.6, Cascadia: 7.7, CAM_S: 7.4, CAM_N: 7.4, JP_Pac: 8.5, JP_Phi: 7.7, SA_N: 8.5, SA_S: 8.6, TW_W: 7.1, TW_E: 7.1, 'default': 7.9 };
Physics.PARKER2022_MB_SLAB = { Aleutian: 7.98, AK: 7.2, Cascadia: 7.2, CAM_S: 7.6, CAM_N: 7.4, JP_Pac: 7.65, JP_Phi: 7.55, SA_N: 7.3, SA_S: 7.25, TW_W: 7.7, TW_E: 7.7, 'default': 7.6 };
Physics.PARKER2022_PAPER = {
  'pgv': { "c0": 8.097, "AK_c0": 9.283796298, "Aleutian_c0": 8.374796298, "Cascadia_c0": 7.728, "CAM_N_c0": 7.046899908, "CAM_S_c0": 7.046899908, "JP_Pac_c0": 8.772125851, "JP_Phi_c0": 7.579125851, "SA_N_c0": 8.528671414, "SA_S_c0": 8.679671414, "TW_E_c0": 7.559846279, "TW_W_c0": 7.559846279, "c0slab": 13.194, "AK_c0slab": 12.79, "Aleutian_c0slab": 13.6, "Cascadia_c0slab": 12.874, "CAM_c0slab": 12.81, "JP_c0slab": 13.248, "SA_N_c0slab": 12.754, "SA_S_c0slab": 12.927, "TW_c0slab": 13.516, "c1": -1.661, "c1slab": -2.422, "b4": 0.1, "a0": -0.00395, "AK_a0": -0.00404, "CAM_a0": -0.00153, "JP_a0": -0.00239, "SA_a0": -0.000311, "TW_a0": -0.00514, "a0slab": -0.0019, "AK_a0slab": -0.00238, "Cascadia_a0slab": -0.00109, "CAM_a0slab": -0.00192, "JP_a0slab": -0.00215, "SA_a0slab": -0.00192, "TW_a0slab": -0.00366, "c4": 1.336, "c5": -0.039, "c6": 1.844, "c4slab": 1.84, "c5slab": -0.05, "c6slab": 0.8, "d": 0.2693, "m": 0.0252, "db": 67, "V2": 850, "JP_s1": -0.738, "TW_s1": -0.454, "s2": -0.601, "AK_s2": -1.031, "Cascadia_s2": -0.671, "JP_s2": -0.738, "SA_s2": -0.681, "TW_s2": -0.59, "f4": -0.31763, "f4slab": -0.31763, "f5": -0.0052, "J_e1": -0.137, "J_e2": 0.137, "J_e3": 0.091, "C_e1": 0, "C_e2": 0.115, "C_e3": 0.068, "del_None": -0.115, "del_Seattle": 0, "Tau": 0.477, "phi21": 0.348, "phi22": 0.288, "phi2V": -0.179, "VM": 423, "phi2S2S,0": 0.142, "a1": 0.047, "phi2SS,1": 0.153, "phi2SS,2": 0.166, "a2": 0.011 },
  'pga': { "c0": 4.082, "AK_c0": 4.458796298, "Aleutian_c0": 3.652796298, "Cascadia_c0": 3.856, "CAM_N_c0": 2.875899908, "CAM_S_c0": 2.875899908, "JP_Pac_c0": 5.373125851, "JP_Phi_c0": 4.309125851, "SA_N_c0": 5.064671414, "SA_S_c0": 5.198671414, "TW_E_c0": 3.032846279, "TW_W_c0": 3.032846279, "c0slab": 9.907, "AK_c0slab": 9.404, "Aleutian_c0slab": 9.912, "Cascadia_c0slab": 9.6, "CAM_c0slab": 9.58, "JP_c0slab": 10.145, "SA_N_c0slab": 9.254, "SA_S_c0slab": 9.991, "TW_c0slab": 10.071, "c1": -1.662, "c1slab": -2.543, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00227, "Cascadia_a0slab": -0.00354, "CAM_a0slab": -0.00238, "JP_a0slab": -0.00335, "SA_a0slab": -0.00238, "TW_a0slab": -0.00362, "c4": 1.246, "c5": -0.021, "c6": 1.128, "c4slab": 1.84, "c5slab": -0.05, "c6slab": 0.4, "d": 0.3004, "m": 0.0314, "db": 67, "V2": 1350, "JP_s1": -0.586, "TW_s1": -0.44, "s2": -0.498, "AK_s2": -0.785, "Cascadia_s2": -0.572, "JP_s2": -0.586, "SA_s2": -0.333, "TW_s2": -0.44, "f4": -0.44169, "f4slab": -0.44169, "f5": -0.0052, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.48, "phi21": 0.396, "phi22": 0.565, "phi2V": -0.18, "VM": 423, "phi2S2S,0": 0.221, "a1": 0.093, "phi2SS,1": 0.149, "phi2SS,2": 0.327, "a2": 0.068 },
  '0.01': { "c0": 3.714, "AK_c0": 4.094796298, "Aleutian_c0": 3.288796298, "Cascadia_c0": 3.488, "CAM_N_c0": 2.564899908, "CAM_S_c0": 2.564899908, "JP_Pac_c0": 5.022125851, "JP_Phi_c0": 3.901125851, "SA_N_c0": 4.673671414, "SA_S_c0": 4.807671414, "TW_E_c0": 2.636846279, "TW_W_c0": 2.636846279, "c0slab": 9.962, "AK_c0slab": 9.451, "Aleutian_c0slab": 9.954, "Cascadia_c0slab": 9.802, "CAM_c0slab": 9.612, "JP_c0slab": 10.162, "SA_N_c0slab": 9.293, "SA_S_c0slab": 9.994, "TW_c0slab": 10.174, "c1": -1.587, "c1slab": -2.554, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.246, "c5": -0.021, "c6": 1.128, "c4slab": 1.84, "c5slab": -0.05, "c6slab": 0.4, "d": 0.2839, "m": 0.0296, "db": 67, "V2": 1300, "JP_s1": -0.604, "TW_s1": -0.44, "s2": -0.498, "AK_s2": -0.803, "Cascadia_s2": -0.571, "JP_s2": -0.604, "SA_s2": -0.333, "TW_s2": -0.44, "f4": -0.4859, "f4slab": -0.4859, "f5": -0.0052, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.476, "phi21": 0.397, "phi22": 0.56, "phi2V": -0.18, "VM": 423, "phi2S2S,0": 0.223, "a1": 0.098, "phi2SS,1": 0.148, "phi2SS,2": 0.294, "a2": 0.071 },
  '0.02': { "c0": 3.762, "AK_c0": 4.132796298, "Aleutian_c0": 3.338796298, "Cascadia_c0": 3.536, "CAM_N_c0": 2.636899908, "CAM_S_c0": 2.636899908, "JP_Pac_c0": 5.066125851, "JP_Phi_c0": 3.935125851, "SA_N_c0": 4.694671414, "SA_S_c0": 4.827671414, "TW_E_c0": 2.698846279, "TW_W_c0": 2.698846279, "c0slab": 10.099, "AK_c0slab": 9.587, "Aleutian_c0slab": 10.086, "Cascadia_c0slab": 9.933, "CAM_c0slab": 9.771, "JP_c0slab": 10.306, "SA_N_c0slab": 9.403, "SA_S_c0slab": 10.152, "TW_c0slab": 10.273, "c1": -1.593, "c1slab": -2.566, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.227, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.415, "d": 0.2854, "m": 0.0298, "db": 67, "V2": 1225, "JP_s1": -0.593, "TW_s1": -0.458, "s2": -0.478, "AK_s2": -0.785, "Cascadia_s2": -0.575, "JP_s2": -0.593, "SA_s2": -0.345, "TW_s2": -0.458, "f4": -0.4859, "f4slab": -0.4859, "f5": -0.00518, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.482, "phi21": 0.401, "phi22": 0.563, "phi2V": -0.181, "VM": 423, "phi2S2S,0": 0.227, "a1": 0.105, "phi2SS,1": 0.149, "phi2SS,2": 0.294, "a2": 0.073 },
  '0.025': { "c0": 3.859, "AK_c0": 4.246796298, "Aleutian_c0": 3.392796298, "Cascadia_c0": 3.633, "CAM_N_c0": 2.731899908, "CAM_S_c0": 2.731899908, "JP_Pac_c0": 5.140125851, "JP_Phi_c0": 4.094125851, "SA_N_c0": 4.779671414, "SA_S_c0": 4.911671414, "TW_E_c0": 2.800846279, "TW_W_c0": 2.800846279, "c0slab": 10.181, "AK_c0slab": 9.667, "Aleutian_c0slab": 10.172, "Cascadia_c0slab": 10.009, "CAM_c0slab": 9.85, "JP_c0slab": 10.387, "SA_N_c0slab": 9.481, "SA_S_c0slab": 10.292, "TW_c0slab": 10.329, "c1": -1.607, "c1slab": -2.578, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.221, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.43, "d": 0.2891, "m": 0.0302, "db": 67, "V2": 1200, "JP_s1": -0.569, "TW_s1": -0.454, "s2": -0.464, "AK_s2": -0.745, "Cascadia_s2": -0.573, "JP_s2": -0.579, "SA_s2": -0.362, "TW_s2": -0.459, "f4": -0.4859, "f4slab": -0.4859, "f5": -0.00515, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.49, "phi21": 0.405, "phi22": 0.575, "phi2V": -0.183, "VM": 423, "phi2S2S,0": 0.231, "a1": 0.12, "phi2SS,1": 0.15, "phi2SS,2": 0.31, "a2": 0.076 },
  '0.03': { "c0": 4.014, "AK_c0": 4.386796298, "Aleutian_c0": 3.535796298, "Cascadia_c0": 3.788, "CAM_N_c0": 2.890899908, "CAM_S_c0": 2.890899908, "JP_Pac_c0": 5.317125851, "JP_Phi_c0": 4.278125851, "SA_N_c0": 4.935671414, "SA_S_c0": 5.066671414, "TW_E_c0": 2.926846279, "TW_W_c0": 2.926846279, "c0slab": 10.311, "AK_c0slab": 9.808, "Aleutian_c0slab": 10.302, "Cascadia_c0slab": 10.133, "CAM_c0slab": 9.993, "JP_c0slab": 10.498, "SA_N_c0slab": 9.592, "SA_S_c0slab": 10.459, "TW_c0slab": 10.451, "c1": -1.63, "c1slab": -2.594, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.215, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.445, "d": 0.2932, "m": 0.0306, "db": 67, "V2": 1200, "JP_s1": -0.539, "TW_s1": -0.455, "s2": -0.446, "AK_s2": -0.69, "Cascadia_s2": -0.565, "JP_s2": -0.561, "SA_s2": -0.38, "TW_s2": -0.464, "f4": -0.4908, "f4slab": -0.4908, "f5": -0.00511, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.5, "phi21": 0.413, "phi22": 0.589, "phi2V": -0.188, "VM": 423, "phi2S2S,0": 0.239, "a1": 0.145, "phi2SS,1": 0.153, "phi2SS,2": 0.313, "a2": 0.077 },
  '0.04': { "c0": 4.223, "AK_c0": 4.553796298, "Aleutian_c0": 3.747796298, "Cascadia_c0": 3.997, "CAM_N_c0": 3.075899908, "CAM_S_c0": 3.075899908, "JP_Pac_c0": 5.564125851, "JP_Phi_c0": 4.531125851, "SA_N_c0": 5.182671414, "SA_S_c0": 5.312671414, "TW_E_c0": 3.069846279, "TW_W_c0": 3.069846279, "c0slab": 10.588, "AK_c0slab": 10.086, "Aleutian_c0slab": 10.602, "Cascadia_c0slab": 10.404, "CAM_c0slab": 10.317, "JP_c0slab": 10.744, "SA_N_c0slab": 9.834, "SA_S_c0slab": 10.818, "TW_c0slab": 10.678, "c1": -1.657, "c1slab": -2.629, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.207, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.46, "d": 0.3004, "m": 0.0313, "db": 67, "V2": 1200, "JP_s1": -0.468, "TW_s1": -0.453, "s2": -0.431, "AK_s2": -0.636, "Cascadia_s2": -0.546, "JP_s2": -0.508, "SA_s2": -0.403, "TW_s2": -0.466, "f4": -0.49569, "f4slab": -0.49569, "f5": -0.00505, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.515, "phi21": 0.439, "phi22": 0.616, "phi2V": -0.205, "VM": 423, "phi2S2S,0": 0.261, "a1": 0.177, "phi2SS,1": 0.159, "phi2SS,2": 0.322, "a2": 0.08 },
  '0.05': { "c0": 4.456, "AK_c0": 4.745796298, "Aleutian_c0": 3.959796298, "Cascadia_c0": 4.23, "CAM_N_c0": 3.287899908, "CAM_S_c0": 3.287899908, "JP_Pac_c0": 5.843125851, "JP_Phi_c0": 4.816125851, "SA_N_c0": 5.457671414, "SA_S_c0": 5.586671414, "TW_E_c0": 3.236846279, "TW_W_c0": 3.236846279, "c0slab": 10.824, "AK_c0slab": 10.379, "Aleutian_c0slab": 10.862, "Cascadia_c0slab": 10.634, "CAM_c0slab": 10.563, "JP_c0slab": 10.981, "SA_N_c0slab": 10.027, "SA_S_c0slab": 11.102, "TW_c0slab": 10.86, "c1": -1.687, "c1slab": -2.649, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.201, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.475, "d": 0.3048, "m": 0.0316, "db": 67, "V2": 1225, "JP_s1": -0.403, "TW_s1": -0.452, "s2": -0.42, "AK_s2": -0.594, "Cascadia_s2": -0.519, "JP_s2": -0.461, "SA_s2": -0.427, "TW_s2": -0.468, "f4": -0.49823, "f4slab": -0.49823, "f5": -0.00497, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0.1, "C_e2": -0.1, "C_e3": -0.063, "del_None": -0.05, "del_Seattle": 0, "Tau": 0.528, "phi21": 0.473, "phi22": 0.653, "phi2V": -0.23, "VM": 423, "phi2S2S,0": 0.285, "a1": 0.2, "phi2SS,1": 0.167, "phi2SS,2": 0.33, "a2": 0.077 },
  '0.075': { "c0": 4.742, "AK_c0": 4.972796298, "Aleutian_c0": 4.231796298, "Cascadia_c0": 4.516, "CAM_N_c0": 3.560899908, "CAM_S_c0": 3.560899908, "JP_Pac_c0": 6.146125851, "JP_Phi_c0": 5.126125851, "SA_N_c0": 5.788671414, "SA_S_c0": 5.917671414, "TW_E_c0": 3.446846279, "TW_W_c0": 3.446846279, "c0slab": 11.084, "AK_c0slab": 10.65, "Aleutian_c0slab": 11.184, "Cascadia_c0slab": 10.888, "CAM_c0slab": 10.785, "JP_c0slab": 11.25, "SA_N_c0slab": 10.265, "SA_S_c0slab": 11.424, "TW_c0slab": 11.093, "c1": -1.715, "c1slab": -2.65, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.19, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.49, "d": 0.2992, "m": 0.0321, "db": 67, "V2": 1350, "JP_s1": -0.325, "TW_s1": -0.456, "s2": -0.442, "AK_s2": -0.586, "Cascadia_s2": -0.497, "JP_s2": -0.452, "SA_s2": -0.458, "TW_s2": -0.473, "f4": -0.49724, "f4slab": -0.49724, "f5": -0.00489, "J_e1": 0.05, "J_e2": -0.043, "J_e3": -0.025, "C_e1": 0.3, "C_e2": -0.34, "C_e3": -0.2, "del_None": -0.075, "del_Seattle": 0.078, "Tau": 0.53, "phi21": 0.529, "phi22": 0.722, "phi2V": -0.262, "VM": 423, "phi2S2S,0": 0.339, "a1": 0.205, "phi2SS,1": 0.184, "phi2SS,2": 0.299, "a2": 0.063 },
  '0.1': { "c0": 4.952, "AK_c0": 5.160796298, "Aleutian_c0": 4.471796298, "Cascadia_c0": 4.726, "CAM_N_c0": 3.788899908, "CAM_S_c0": 3.788899908, "JP_Pac_c0": 6.346125851, "JP_Phi_c0": 5.333125851, "SA_N_c0": 5.998671414, "SA_S_c0": 6.126671414, "TW_E_c0": 3.643846279, "TW_W_c0": 3.643846279, "c0slab": 11.232, "AK_c0slab": 10.816, "Aleutian_c0slab": 11.304, "Cascadia_c0slab": 11.03, "CAM_c0slab": 10.841, "JP_c0slab": 11.466, "SA_N_c0slab": 10.467, "SA_S_c0slab": 11.49, "TW_c0slab": 11.283, "c1": -1.737, "c1slab": -2.647, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.182, "c5": -0.021, "c6": 1.128, "c4slab": 1.884, "c5slab": -0.05, "c6slab": 0.505, "d": 0.2854, "m": 0.032, "db": 67, "V2": 1450, "JP_s1": -0.264, "TW_s1": -0.468, "s2": -0.485, "AK_s2": -0.629, "Cascadia_s2": -0.486, "JP_s2": -0.498, "SA_s2": -0.49, "TW_s2": -0.482, "f4": -0.49471, "f4slab": -0.49471, "f5": -0.00478, "J_e1": 0.1, "J_e2": -0.085, "J_e3": -0.05, "C_e1": 0.333, "C_e2": -0.377, "C_e3": -0.222, "del_None": -0.081, "del_Seattle": 0.075, "Tau": 0.524, "phi21": 0.517, "phi22": 0.712, "phi2V": -0.239, "VM": 423, "phi2S2S,0": 0.347, "a1": 0.185, "phi2SS,1": 0.176, "phi2SS,2": 0.31, "a2": 0.061 },
  '0.15': { "c0": 5.08, "AK_c0": 5.285796298, "Aleutian_c0": 4.665796298, "Cascadia_c0": 4.848, "CAM_N_c0": 3.945899908, "CAM_S_c0": 3.945899908, "JP_Pac_c0": 6.425125851, "JP_Phi_c0": 5.420125851, "SA_N_c0": 6.103671414, "SA_S_c0": 6.230671414, "TW_E_c0": 3.798846279, "TW_W_c0": 3.798846279, "c0slab": 11.311, "AK_c0slab": 10.883, "Aleutian_c0slab": 11.402, "Cascadia_c0slab": 11.103, "CAM_c0slab": 10.809, "JP_c0slab": 11.619, "SA_N_c0slab": 10.566, "SA_S_c0slab": 11.32, "TW_c0slab": 11.503, "c1": -1.745, "c1slab": -2.634, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.171, "c5": -0.021, "c6": 1.162, "c4slab": 1.884, "c5slab": -0.06, "c6slab": 0.52, "d": 0.2814, "m": 0.0325, "db": 67, "V2": 1500, "JP_s1": -0.25, "TW_s1": -0.484, "s2": -0.546, "AK_s2": -0.729, "Cascadia_s2": -0.499, "JP_s2": -0.568, "SA_s2": -0.536, "TW_s2": -0.499, "f4": -0.48583, "f4slab": -0.48583, "f5": -0.0046, "J_e1": 0.164, "J_e2": -0.139, "J_e3": -0.082, "C_e1": 0.29, "C_e2": -0.29, "C_e3": -0.193, "del_None": -0.091, "del_Seattle": 0.064, "Tau": 0.51, "phi21": 0.457, "phi22": 0.644, "phi2V": -0.185, "VM": 423, "phi2S2S,0": 0.313, "a1": 0.123, "phi2SS,1": 0.164, "phi2SS,2": 0.307, "a2": 0.076 },
  '0.2': { "c0": 5.035, "AK_c0": 5.277796298, "Aleutian_c0": 4.661796298, "Cascadia_c0": 4.798, "CAM_N_c0": 3.943899908, "CAM_S_c0": 3.943899908, "JP_Pac_c0": 6.288125851, "JP_Phi_c0": 5.289125851, "SA_N_c0": 6.013671414, "SA_S_c0": 6.140671414, "TW_E_c0": 3.827846279, "TW_W_c0": 3.827846279, "c0slab": 11.055, "AK_c0slab": 10.633, "Aleutian_c0slab": 11.183, "Cascadia_c0slab": 10.841, "CAM_c0slab": 10.519, "JP_c0slab": 11.351, "SA_N_c0slab": 10.33, "SA_S_c0slab": 10.927, "TW_c0slab": 11.32, "c1": -1.732, "c1slab": -2.583, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.163, "c5": -0.021, "c6": 1.187, "c4slab": 1.884, "c5slab": -0.068, "c6slab": 0.535, "d": 0.291, "m": 0.0306, "db": 67, "V2": 1425, "JP_s1": -0.288, "TW_s1": -0.498, "s2": -0.612, "AK_s2": -0.867, "Cascadia_s2": -0.533, "JP_s2": -0.667, "SA_s2": -0.584, "TW_s2": -0.522, "f4": -0.47383, "f4slab": -0.47383, "f5": -0.00434, "J_e1": 0.164, "J_e2": -0.139, "J_e3": -0.082, "C_e1": 0.177, "C_e2": -0.192, "C_e3": -0.148, "del_None": -0.092, "del_Seattle": 0.075, "Tau": 0.501, "phi21": 0.432, "phi22": 0.64, "phi2V": -0.138, "VM": 423, "phi2S2S,0": 0.277, "a1": 0.11, "phi2SS,1": 0.163, "phi2SS,2": 0.301, "a2": 0.07 },
  '0.25': { "c0": 4.859, "AK_c0": 5.154796298, "Aleutian_c0": 4.503796298, "Cascadia_c0": 4.618, "CAM_N_c0": 3.800899908, "CAM_S_c0": 3.800899908, "JP_Pac_c0": 5.972125851, "JP_Phi_c0": 4.979125851, "SA_N_c0": 5.849671414, "SA_S_c0": 5.974671414, "TW_E_c0": 3.765846279, "TW_W_c0": 3.765846279, "c0slab": 10.803, "AK_c0slab": 10.322, "Aleutian_c0slab": 10.965, "Cascadia_c0slab": 10.583, "CAM_c0slab": 10.268, "JP_c0slab": 11.063, "SA_N_c0slab": 10.124, "SA_S_c0slab": 10.555, "TW_c0slab": 11.147, "c1": -1.696, "c1slab": -2.539, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.156, "c5": -0.021, "c6": 1.204, "c4slab": 1.884, "c5slab": -0.075, "c6slab": 0.55, "d": 0.2758, "m": 0.0306, "db": 67, "V2": 1350, "JP_s1": -0.36, "TW_s1": -0.511, "s2": -0.688, "AK_s2": -1.011, "Cascadia_s2": -0.592, "JP_s2": -0.781, "SA_s2": -0.654, "TW_s2": -0.555, "f4": -0.47696, "f4slab": -0.47696, "f5": -0.00402, "J_e1": 0.08, "J_e2": -0.08, "J_e3": -0.053, "C_e1": 0.1, "C_e2": -0.035, "C_e3": -0.054, "del_None": 0, "del_Seattle": 0, "Tau": 0.492, "phi21": 0.45, "phi22": 0.633, "phi2V": -0.185, "VM": 423, "phi2S2S,0": 0.26, "a1": 0.119, "phi2SS,1": 0.169, "phi2SS,2": 0.233, "a2": 0.077 },
  '0.3': { "c0": 4.583, "AK_c0": 4.910796298, "Aleutian_c0": 4.276796298, "Cascadia_c0": 4.34, "CAM_N_c0": 3.491899908, "CAM_S_c0": 3.491899908, "JP_Pac_c0": 5.582125851, "JP_Phi_c0": 4.592125851, "SA_N_c0": 5.603671414, "SA_S_c0": 5.728671414, "TW_E_c0": 3.602846279, "TW_W_c0": 3.602846279, "c0slab": 10.669, "AK_c0slab": 10.116, "Aleutian_c0slab": 10.87, "Cascadia_c0slab": 10.443, "CAM_c0slab": 10.134, "JP_c0slab": 10.878, "SA_N_c0slab": 10.077, "SA_S_c0slab": 10.328, "TW_c0slab": 11.079, "c1": -1.643, "c1slab": -2.528, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.151, "c5": -0.021, "c6": 1.215, "c4slab": 1.884, "c5slab": -0.082, "c6slab": 0.565, "d": 0.2719, "m": 0.0323, "db": 67, "V2": 1250, "JP_s1": -0.455, "TW_s1": -0.514, "s2": -0.748, "AK_s2": -1.133, "Cascadia_s2": -0.681, "JP_s2": -0.867, "SA_s2": -0.725, "TW_s2": -0.596, "f4": -0.4845, "f4slab": -0.4845, "f5": -0.0037, "J_e1": 0, "J_e2": 0, "J_e3": 1, "C_e1": 0, "C_e2": 0, "C_e3": 1, "del_None": 0, "del_Seattle": 0, "Tau": 0.492, "phi21": 0.436, "phi22": 0.584, "phi2V": -0.158, "VM": 423, "phi2S2S,0": 0.254, "a1": 0.092, "phi2SS,1": 0.159, "phi2SS,2": 0.22, "a2": 0.065 },
  '0.4': { "c0": 4.18, "AK_c0": 4.548796298, "Aleutian_c0": 3.919796298, "Cascadia_c0": 3.935, "CAM_N_c0": 3.128899908, "CAM_S_c0": 3.128899908, "JP_Pac_c0": 5.091125851, "JP_Phi_c0": 4.089125851, "SA_N_c0": 5.151671414, "SA_S_c0": 5.277671414, "TW_E_c0": 3.343846279, "TW_W_c0": 3.343846279, "c0slab": 10.116, "AK_c0slab": 9.561, "Aleutian_c0slab": 10.411, "Cascadia_c0slab": 9.884, "CAM_c0slab": 9.598, "JP_c0slab": 10.296, "SA_N_c0slab": 9.539, "SA_S_c0slab": 9.639, "TW_c0slab": 10.547, "c1": -1.58, "c1slab": -2.452, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.143, "c5": -0.022, "c6": 1.227, "c4slab": 1.884, "c5slab": -0.091, "c6slab": 0.58, "d": 0.2539, "m": 0.0302, "db": 67, "V2": 1150, "JP_s1": -0.617, "TW_s1": -0.51, "s2": -0.802, "AK_s2": -1.238, "Cascadia_s2": -0.772, "JP_s2": -0.947, "SA_s2": -0.801, "TW_s2": -0.643, "f4": -0.48105, "f4slab": -0.48105, "f5": -0.00342, "J_e1": -0.13, "J_e2": 0.113, "J_e3": 0.087, "C_e1": 0, "C_e2": 0.05, "C_e3": 0.2, "del_None": 0, "del_Seattle": 0, "Tau": 0.492, "phi21": 0.433, "phi22": 0.556, "phi2V": -0.19, "VM": 423, "phi2S2S,0": 0.23, "a1": 0.044, "phi2SS,1": 0.158, "phi2SS,2": 0.222, "a2": 0.064 },
  '0.5': { "c0": 3.752, "AK_c0": 4.168796298, "Aleutian_c0": 3.486796298, "Cascadia_c0": 3.505, "CAM_N_c0": 2.640899908, "CAM_S_c0": 2.640899908, "JP_Pac_c0": 4.680125851, "JP_Phi_c0": 3.571125851, "SA_N_c0": 4.719671414, "SA_S_c0": 4.848671414, "TW_E_c0": 3.028846279, "TW_W_c0": 3.028846279, "c0slab": 9.579, "AK_c0slab": 8.973, "Aleutian_c0slab": 9.901, "Cascadia_c0slab": 9.341, "CAM_c0slab": 9.097, "JP_c0slab": 9.711, "SA_N_c0slab": 9.03, "SA_S_c0slab": 9.03, "TW_c0slab": 10.049, "c1": -1.519, "c1slab": -2.384, "b4": 0.1, "a0": -0.00657, "AK_a0": -0.00541, "CAM_a0": -0.00387, "JP_a0": -0.00862, "SA_a0": -0.00397, "TW_a0": -0.00787, "a0slab": -0.00255, "AK_a0slab": -0.00219, "Cascadia_a0slab": -0.00401, "CAM_a0slab": -0.00217, "JP_a0slab": -0.00311, "SA_a0slab": -0.00217, "TW_a0slab": -0.00355, "c4": 1.143, "c5": -0.023, "c6": 1.234, "c4slab": 1.884, "c5slab": -0.1, "c6slab": 0.595, "d": 0.2482, "m": 0.0295, "db": 67, "V2": 1025, "JP_s1": -0.757, "TW_s1": -0.506, "s2": -0.845, "AK_s2": -1.321, "Cascadia_s2": -0.838, "JP_s2": -1.003, "SA_s2": -0.863, "TW_s2": -0.689, "f4": -0.46492, "f4slab": -0.46492, "f5": -0.00322, "J_e1": -0.2, "J_e2": 0.176, "J_e3": 0.118, "C_e1": 0, "C_e2": 0.1, "C_e3": 0.2, "del_None": 0, "del_Seattle": 0, "Tau": 0.492, "phi21": 0.428, "phi22": 0.51, "phi2V": -0.186, "VM": 423, "phi2S2S,0": 0.225, "a1": 0.038, "phi2SS,1": 0.16, "phi2SS,2": 0.243, "a2": 0.044 },
  '0.75': { "c0": 3.085, "AK_c0": 3.510796298, "Aleutian_c0": 2.710796298, "Cascadia_c0": 2.837, "CAM_N_c0": 1.987899908, "CAM_S_c0": 1.987899908, "JP_Pac_c0": 3.906125851, "JP_Phi_c0": 2.844125851, "SA_N_c0": 3.995671414, "SA_S_c0": 4.129671414, "TW_E_c0": 2.499846279, "TW_W_c0": 2.499846279, "c0slab": 8.837, "AK_c0slab": 8.246, "Aleutian_c0slab": 9.335, "Cascadia_c0slab": 8.593, "CAM_c0slab": 8.324, "JP_c0slab": 8.934, "SA_N_c0slab": 8.258, "SA_S_c0slab": 8.258, "TW_c0slab": 9.327, "c1": -1.44, "c1slab": -2.338, "b4": 0.1, "a0": -0.00635, "AK_a0": -0.00478, "CAM_a0": -0.00342, "JP_a0": -0.00763, "SA_a0": -0.00351, "TW_a0": -0.0068, "a0slab": -0.00211, "AK_a0slab": -0.00189, "Cascadia_a0slab": -0.00347, "CAM_a0slab": -0.00188, "JP_a0slab": -0.00269, "SA_a0slab": -0.00188, "TW_a0slab": -0.00307, "c4": 1.217, "c5": -0.026, "c6": 1.24, "c4slab": 1.884, "c5slab": -0.115, "c6slab": 0.61, "d": 0.2227, "m": 0.0266, "db": 67, "V2": 900, "JP_s1": -0.966, "TW_s1": -0.5, "s2": -0.911, "AK_s2": -1.383, "Cascadia_s2": -0.922, "JP_s2": -1.052, "SA_s2": -0.942, "TW_s2": -0.745, "f4": -0.43439, "f4slab": -0.43439, "f5": -0.00312, "J_e1": -0.401, "J_e2": 0.284, "J_e3": 0.167, "C_e1": 0, "C_e2": 0.2, "C_e3": 0.125, "del_None": -0.2, "del_Seattle": 0.012, "Tau": 0.492, "phi21": 0.448, "phi22": 0.471, "phi2V": -0.177, "VM": 422, "phi2S2S,0": 0.218, "a1": 0.04, "phi2SS,1": 0.175, "phi2SS,2": 0.241, "a2": 0.04 },
  '1.0': { "c0": 2.644, "AK_c0": 3.067796298, "Aleutian_c0": 2.238796298, "Cascadia_c0": 2.396, "CAM_N_c0": 1.553899908, "CAM_S_c0": 1.553899908, "JP_Pac_c0": 3.481125851, "JP_Phi_c0": 2.371125851, "SA_N_c0": 3.512671414, "SA_S_c0": 3.653671414, "TW_E_c0": 2.140846279, "TW_W_c0": 2.140846279, "c0slab": 8.067, "AK_c0slab": 7.507, "Aleutian_c0slab": 8.68, "Cascadia_c0slab": 7.817, "CAM_c0slab": 7.557, "JP_c0slab": 8.164, "SA_N_c0slab": 7.467, "SA_S_c0slab": 7.417, "TW_c0slab": 8.504, "c1": -1.419, "c1slab": -2.267, "b4": 0.1, "a0": -0.0058, "AK_a0": -0.00415, "CAM_a0": -0.00297, "JP_a0": -0.00663, "SA_a0": -0.00305, "TW_a0": -0.00605, "a0slab": -0.00187, "AK_a0slab": -0.00168, "Cascadia_a0slab": -0.00309, "CAM_a0slab": -0.00167, "JP_a0slab": -0.00239, "SA_a0slab": -0.00167, "TW_a0slab": -0.00273, "c4": 1.27, "c5": -0.028, "c6": 1.24, "c4slab": 1.884, "c5slab": -0.134, "c6slab": 0.625, "d": 0.1969, "m": 0.0231, "db": 67, "V2": 800, "JP_s1": -0.986, "TW_s1": -0.49, "s2": -0.926, "AK_s2": -1.414, "Cascadia_s2": -0.932, "JP_s2": -1.028, "SA_s2": -0.96, "TW_s2": -0.777, "f4": -0.38484, "f4slab": -0.38484, "f5": -0.0031, "J_e1": -0.488, "J_e2": 0.346, "J_e3": 0.203, "C_e1": 0, "C_e2": 0.245, "C_e3": 0.153, "del_None": -0.245, "del_Seattle": 0.037, "Tau": 0.492, "phi21": 0.43, "phi22": 0.43, "phi2V": -0.166, "VM": 422, "phi2S2S,0": 0.227, "a1": 0.015, "phi2SS,1": 0.195, "phi2SS,2": 0.195, "a2": 0.043 },
  '1.5': { "c0": 2.046, "AK_c0": 2.513796298, "Aleutian_c0": 1.451796298, "Cascadia_c0": 1.799, "CAM_N_c0": 0.990899908, "CAM_S_c0": 0.990899908, "JP_Pac_c0": 2.870125851, "JP_Phi_c0": 1.779125851, "SA_N_c0": 2.875671414, "SA_S_c0": 3.023671414, "TW_E_c0": 1.645846279, "TW_W_c0": 1.645846279, "c0slab": 6.829, "AK_c0slab": 6.213, "Aleutian_c0slab": 7.581, "Cascadia_c0slab": 6.573, "CAM_c0slab": 6.35, "JP_c0slab": 6.896, "SA_N_c0slab": 6.22, "SA_S_c0slab": 6.18, "TW_c0slab": 7.204, "c1": -1.4, "c1slab": -2.166, "b4": 0.1, "a0": -0.00505, "AK_a0": -0.00342, "CAM_a0": -0.00245, "JP_a0": -0.00546, "SA_a0": -0.00252, "TW_a0": -0.00498, "a0slab": -0.00154, "AK_a0slab": -0.00139, "Cascadia_a0slab": -0.00254, "CAM_a0slab": -0.00138, "JP_a0slab": -0.00197, "SA_a0slab": -0.00138, "TW_a0slab": -0.00225, "c4": 1.344, "c5": -0.031, "c6": 1.237, "c4slab": 1.884, "c5slab": -0.154, "c6slab": 0.64, "d": 0.1452, "m": 0.0118, "db": 67, "V2": 760, "JP_s1": -0.966, "TW_s1": -0.486, "s2": -0.888, "AK_s2": -1.43, "Cascadia_s2": -0.814, "JP_s2": -0.971, "SA_s2": -0.942, "TW_s2": -0.79, "f4": -0.32318, "f4slab": -0.32318, "f5": -0.0031, "J_e1": -0.578, "J_e2": 0.48, "J_e3": 0.24, "C_e1": 0, "C_e2": 0.32, "C_e3": 0.2, "del_None": -0.32, "del_Seattle": 0.064, "Tau": 0.492, "phi21": 0.406, "phi22": 0.406, "phi2V": -0.111, "VM": 422, "phi2S2S,0": 0.244, "a1": -0.047, "phi2SS,1": 0.204, "phi2SS,2": 0.204, "a2": -0.034 },
  '2.0': { "c0": 1.556, "AK_c0": 2.061796298, "Aleutian_c0": 0.906796298, "Cascadia_c0": 1.31, "CAM_N_c0": 0.534899908, "CAM_S_c0": 0.534899908, "JP_Pac_c0": 2.507125851, "JP_Phi_c0": 1.293125851, "SA_N_c0": 2.327671414, "SA_S_c0": 2.481671414, "TW_E_c0": 1.217846279, "TW_W_c0": 1.217846279, "c0slab": 5.871, "AK_c0slab": 5.206, "Aleutian_c0slab": 6.671, "Cascadia_c0slab": 5.609, "CAM_c0slab": 5.434, "JP_c0slab": 5.935, "SA_N_c0slab": 5.261, "SA_S_c0slab": 5.161, "TW_c0slab": 6.227, "c1": -1.391, "c1slab": -2.077, "b4": 0.1, "a0": -0.00429, "AK_a0": -0.0029, "CAM_a0": -0.00208, "JP_a0": -0.00463, "SA_a0": -0.00214, "TW_a0": -0.00423, "a0slab": -0.00131, "AK_a0slab": -0.00118, "Cascadia_a0slab": -0.00216, "CAM_a0slab": -0.00117, "JP_a0slab": -0.00167, "SA_a0slab": -0.00117, "TW_a0slab": -0.00191, "c4": 1.396, "c5": -0.034, "c6": 1.232, "c4slab": 1.884, "c5slab": -0.154, "c6slab": 0.655, "d": 0.06, "m": 0.007, "db": 67, "V2": 760, "JP_s1": -0.901, "TW_s1": -0.475, "s2": -0.808, "AK_s2": -1.421, "Cascadia_s2": -0.725, "JP_s2": -0.901, "SA_s2": -0.891, "TW_s2": -0.765, "f4": -0.26577, "f4slab": -0.26577, "f5": -0.0031, "J_e1": -0.645, "J_e2": 0.579, "J_e3": 0.254, "C_e1": 0, "C_e2": 0.37, "C_e3": 0.239, "del_None": -0.28, "del_Seattle": 0.14, "Tau": 0.492, "phi21": 0.393, "phi22": 0.393, "phi2V": 0, "VM": 422, "phi2S2S,0": 0.231, "a1": -0.036, "phi2SS,1": 0.196, "phi2SS,2": 0.196, "a2": -0.036 },
  '2.5': { "c0": 1.167, "AK_c0": 1.709796298, "Aleutian_c0": 0.392796298, "Cascadia_c0": 0.922, "CAM_N_c0": 0.186899908, "CAM_S_c0": 0.186899908, "JP_Pac_c0": 2.160125851, "JP_Phi_c0": 0.895125851, "SA_N_c0": 1.950671414, "SA_S_c0": 2.111671414, "TW_E_c0": 0.871846279, "TW_W_c0": 0.871846279, "c0slab": 5.2, "AK_c0slab": 4.594, "Aleutian_c0slab": 6.047, "Cascadia_c0slab": 4.932, "CAM_c0slab": 4.773, "JP_c0slab": 5.234, "SA_N_c0slab": 4.567, "SA_S_c0slab": 4.517, "TW_c0slab": 5.517, "c1": -1.394, "c1slab": -2.015, "b4": 0.1, "a0": -0.00369, "AK_a0": -0.0025, "CAM_a0": -0.00179, "JP_a0": -0.00399, "SA_a0": -0.00184, "TW_a0": -0.00364, "a0slab": -0.00113, "AK_a0slab": -0.00101, "Cascadia_a0slab": -0.00186, "CAM_a0slab": -0.00101, "JP_a0slab": -0.00144, "SA_a0slab": -0.00101, "TW_a0slab": -0.00164, "c4": 1.437, "c5": -0.036, "c6": 1.227, "c4slab": 1.884, "c5slab": -0.154, "c6slab": 0.67, "d": 0, "m": 0, "db": 0, "V2": 760, "JP_s1": -0.822, "TW_s1": -0.453, "s2": -0.743, "AK_s2": -1.391, "Cascadia_s2": -0.632, "JP_s2": -0.822, "SA_s2": -0.842, "TW_s2": -0.724, "f4": -0.21236, "f4slab": -0.21236, "f5": -0.0031, "J_e1": -0.678, "J_e2": 0.609, "J_e3": 0.267, "C_e1": 0, "C_e2": 0.4, "C_e3": 0.264, "del_None": -0.313, "del_Seattle": 0.19, "Tau": 0.492, "phi21": 0.381, "phi22": 0.381, "phi2V": 0, "VM": 421, "phi2S2S,0": 0.222, "a1": -0.025, "phi2SS,1": 0.169, "phi2SS,2": 0.169, "a2": -0.029 },
  '3.0': { "c0": 0.92, "AK_c0": 1.456796298, "Aleutian_c0": 0.099796298, "Cascadia_c0": 0.675, "CAM_N_c0": -0.087100092, "CAM_S_c0": -0.087100092, "JP_Pac_c0": 1.969125851, "JP_Phi_c0": 0.607125851, "SA_N_c0": 1.766671414, "SA_S_c0": 1.932671414, "TW_E_c0": 0.596846279, "TW_W_c0": 0.596846279, "c0slab": 4.83, "AK_c0slab": 4.206, "Aleutian_c0slab": 5.667, "Cascadia_c0slab": 4.556, "CAM_c0slab": 4.441, "JP_c0slab": 4.849, "SA_N_c0slab": 4.176, "SA_S_c0slab": 4.076, "TW_c0slab": 5.157, "c1": -1.416, "c1slab": -2.012, "b4": 0.1, "a0": -0.00321, "AK_a0": -0.00217, "CAM_a0": -0.00156, "JP_a0": -0.00347, "SA_a0": -0.0016, "TW_a0": -0.00316, "a0slab": -0.000979, "AK_a0slab": -0.00088, "Cascadia_a0slab": -0.00161, "CAM_a0slab": -0.000873, "JP_a0slab": -0.00125, "SA_a0slab": -0.000873, "TW_a0slab": -0.00143, "c4": 1.47, "c5": -0.038, "c6": 1.223, "c4slab": 1.949, "c5slab": -0.154, "c6slab": 0.685, "d": 0, "m": 0, "db": 0, "V2": 760, "JP_s1": -0.751, "TW_s1": -0.428, "s2": -0.669, "AK_s2": -1.343, "Cascadia_s2": -0.57, "JP_s2": -0.751, "SA_s2": -0.787, "TW_s2": -0.675, "f4": 0, "f4slab": -0.17807, "f5": -0.0031, "J_e1": -0.772, "J_e2": 0.635, "J_e3": 0.265, "C_e1": 0, "C_e2": 0.43, "C_e3": 0.287, "del_None": -0.355, "del_Seattle": 0.165, "Tau": 0.492, "phi21": 0.367, "phi22": 0.367, "phi2V": 0, "VM": 419, "phi2S2S,0": 0.199, "a1": -0.03, "phi2SS,1": 0.177, "phi2SS,2": 0.177, "a2": -0.011 },
  '4.0': { "c0": 0.595, "AK_c0": 1.207796298, "Aleutian_c0": -0.356203702, "Cascadia_c0": 0.352, "CAM_N_c0": -0.353100092, "CAM_S_c0": -0.353100092, "JP_Pac_c0": 1.675125851, "JP_Phi_c0": 0.303125851, "SA_N_c0": 1.524671414, "SA_S_c0": 1.698671414, "TW_E_c0": 0.268846279, "TW_W_c0": 0.268846279, "c0slab": 4.173, "AK_c0slab": 3.517, "Aleutian_c0slab": 4.97, "Cascadia_c0slab": 3.893, "CAM_c0slab": 3.849, "JP_c0slab": 4.074, "SA_N_c0slab": 3.495, "SA_S_c0slab": 3.445, "TW_c0slab": 4.55, "c1": -1.452, "c1slab": -1.989, "b4": 0.1, "a0": -0.00244, "AK_a0": -0.00165, "CAM_a0": -0.00118, "JP_a0": -0.00264, "SA_a0": -0.00122, "TW_a0": -0.00241, "a0slab": -0.000745, "AK_a0slab": -0.00067, "Cascadia_a0slab": -0.00123, "CAM_a0slab": -0.000664, "JP_a0slab": -0.000952, "SA_a0slab": -0.000664, "TW_a0slab": -0.00109, "c4": 1.523, "c5": -0.044, "c6": 1.216, "c4slab": 2.031, "c5slab": -0.154, "c6slab": 0.7, "d": 0, "m": 0, "db": 0, "V2": 760, "JP_s1": -0.68, "TW_s1": -0.396, "s2": -0.585, "AK_s2": -1.297, "Cascadia_s2": -0.489, "JP_s2": -0.68, "SA_s2": -0.706, "TW_s2": -0.613, "f4": 0, "f4slab": -0.13729, "f5": -0.0031, "J_e1": -0.699, "J_e2": 0.709, "J_e3": 0.259, "C_e1": 0, "C_e2": 0.44, "C_e3": 0.303, "del_None": -0.417, "del_Seattle": 0.163, "Tau": 0.492, "phi21": 0.33, "phi22": 0.33, "phi2V": 0, "VM": 416, "phi2S2S,0": 0.191, "a1": -0.042, "phi2SS,1": 0.158, "phi2SS,2": 0.158, "a2": 0.033 },
  '5.0': { "c0": 0.465, "AK_c0": 1.131796298, "Aleutian_c0": -0.601203702, "Cascadia_c0": 0.223, "CAM_N_c0": -0.491100092, "CAM_S_c0": -0.491100092, "JP_Pac_c0": 1.601125851, "JP_Phi_c0": 0.183125851, "SA_N_c0": 1.483671414, "SA_S_c0": 1.665671414, "TW_E_c0": 0.014846279, "TW_W_c0": 0.014846279, "c0slab": 3.833, "AK_c0slab": 3.142, "Aleutian_c0slab": 4.592, "Cascadia_c0slab": 3.547, "CAM_c0slab": 3.502, "JP_c0slab": 3.814, "SA_N_c0slab": 3.038, "SA_S_c0slab": 3.038, "TW_c0slab": 4.229, "c1": -1.504, "c1slab": -1.998, "b4": 0.1, "a0": -0.0016, "AK_a0": -0.00125, "CAM_a0": -0.000895, "JP_a0": -0.002, "SA_a0": -0.000919, "TW_a0": -0.00182, "a0slab": -0.000564, "AK_a0slab": -0.000507, "Cascadia_a0slab": -0.000929, "CAM_a0slab": -0.000503, "JP_a0slab": -0.00072, "SA_a0slab": -0.000503, "TW_a0slab": -0.000822, "c4": 1.564, "c5": -0.048, "c6": 1.21, "c4slab": 2.131, "c5slab": -0.154, "c6slab": 0.715, "d": 0, "m": 0, "db": 0, "V2": 760, "JP_s1": -0.592, "TW_s1": -0.353, "s2": -0.506, "AK_s2": -1.233, "Cascadia_s2": -0.421, "JP_s2": -0.592, "SA_s2": -0.621, "TW_s2": -0.536, "f4": 0, "f4slab": -0.07733, "f5": -0.0031, "J_e1": -0.642, "J_e2": 0.63, "J_e3": 0.215, "C_e1": 0, "C_e2": 0.45, "C_e3": 0.321, "del_None": -0.45, "del_Seattle": 0.132, "Tau": 0.492, "phi21": 0.298, "phi22": 0.298, "phi2V": 0, "VM": 415, "phi2S2S,0": 0.181, "a1": 0.005, "phi2SS,1": 0.132, "phi2SS,2": 0.132, "a2": 0.014 },
  '7.5': { "c0": 0.078, "AK_c0": 0.758796298, "Aleutian_c0": -1.137203702, "Cascadia_c0": -0.162, "CAM_N_c0": -0.837100092, "CAM_S_c0": -0.837100092, "JP_Pac_c0": 1.270125851, "JP_Phi_c0": -0.143874149, "SA_N_c0": 1.175671414, "SA_S_c0": 1.366671414, "TW_E_c0": -0.446153721, "TW_W_c0": -0.446153721, "c0slab": 3.132, "AK_c0slab": 2.391, "Aleutian_c0slab": 3.65, "Cascadia_c0slab": 2.84, "CAM_c0slab": 2.821, "JP_c0slab": 3.152, "SA_N_c0slab": 2.368, "SA_S_c0slab": 2.368, "TW_c0slab": 3.554, "c1": -1.569, "c1slab": -2.019, "b4": 0.1, "a0": -0.000766, "AK_a0": -0.000519, "CAM_a0": -0.000371, "JP_a0": -0.000828, "SA_a0": -0.000382, "TW_a0": -0.000755, "a0slab": -0.000234, "AK_a0slab": -0.00021, "Cascadia_a0slab": -0.000385, "CAM_a0slab": -0.000209, "JP_a0slab": -0.000299, "SA_a0slab": -0.000209, "TW_a0slab": -0.000341, "c4": 1.638, "c5": -0.059, "c6": 1.2, "c4slab": 2.185, "c5slab": -0.154, "c6slab": 0.73, "d": 0, "m": 0, "db": 0, "V2": 760, "JP_s1": -0.494, "TW_s1": -0.311, "s2": -0.418, "AK_s2": -1.147, "Cascadia_s2": -0.357, "JP_s2": -0.52, "SA_s2": -0.52, "TW_s2": -0.444, "f4": 0, "f4slab": -0.05443, "f5": -0.0031, "J_e1": -0.524, "J_e2": 0.306, "J_e3": 0.175, "C_e1": 0, "C_e2": 0.406, "C_e3": 0.312, "del_None": -0.35, "del_Seattle": 0.15, "Tau": 0.492, "phi21": 0.254, "phi22": 0.254, "phi2V": 0, "VM": 419, "phi2S2S,0": 0.181, "a1": -0.016, "phi2SS,1": 0.113, "phi2SS,2": 0.113, "a2": 0.016 },
  '10.0': { "c0": 0.046, "AK_c0": 0.708796298, "Aleutian_c0": -1.290203702, "Cascadia_c0": -0.193, "CAM_N_c0": -0.864100092, "CAM_S_c0": -0.864100092, "JP_Pac_c0": 1.364125851, "JP_Phi_c0": -0.195874149, "SA_N_c0": 1.271671414, "SA_S_c0": 1.462671414, "TW_E_c0": -0.473153721, "TW_W_c0": -0.473153721, "c0slab": 2.72, "AK_c0slab": 2.031, "Aleutian_c0slab": 2.95, "Cascadia_c0slab": 2.422, "CAM_c0slab": 2.408, "JP_c0slab": 2.791, "SA_N_c0slab": 1.939, "SA_S_c0slab": 1.939, "TW_c0slab": 3.166, "c1": -1.676, "c1slab": -2.047, "b4": 0.1, "a0": 0, "AK_a0": 0, "CAM_a0": 0, "JP_a0": 0, "SA_a0": 0, "TW_a0": 0, "a0slab": 0, "AK_a0slab": 0, "Cascadia_a0slab": 0, "CAM_a0slab": 0, "JP_a0slab": 0, "SA_a0slab": 0, "TW_a0slab": 0, "c4": 1.69, "c5": -0.067, "c6": 1.194, "c4slab": 2.35, "c5slab": -0.154, "c6slab": 0.745, "d": 0, "m": 0, "db": 0, "V2": 760, "JP_s1": -0.395, "TW_s1": -0.261, "s2": -0.321, "AK_s2": -1.06, "Cascadia_s2": -0.302, "JP_s2": -0.395, "SA_s2": -0.42, "TW_s2": -0.352, "f4": 0, "f4slab": -0.03313, "f5": -0.0031, "J_e1": -0.327, "J_e2": 0.182, "J_e3": 0.121, "C_e1": 0, "C_e2": 0.345, "C_e3": 0.265, "del_None": -0.331, "del_Seattle": 0.117, "Tau": 0.492, "phi21": 0.231, "phi22": 0.231, "phi2V": 0, "VM": 427, "phi2S2S,0": 0.181, "a1": 0.04, "phi2SS,1": 0.11, "phi2SS,2": 0.11, "a2": 0.017 },
};
Physics.PARKER2022_SA_KEYS = ['0.01','0.02','0.025','0.03','0.04','0.05','0.075','0.1','0.15','0.2','0.25','0.3','0.4','0.5','0.75','1.0','1.5','2.0','2.5','3.0','4.0','5.0','7.5','10.0'];
function _parker2022SaKey(T) {
  for (var i = 0; i < Physics.PARKER2022_SA_KEYS.length; i++) {
    if (Math.abs(parseFloat(Physics.PARKER2022_SA_KEYS[i]) - T) < 1e-12) return Physics.PARKER2022_SA_KEYS[i];
  }
  return null;
}
function _parker2022Bracket(T) {
  var nums = Physics.PARKER2022_SA_KEYS.map(parseFloat);
  if (!(T > nums[0] && T < nums[nums.length - 1])) return null;
  for (var i = 0; i < nums.length - 1; i++) {
    if (T > nums[i] && T < nums[i + 1]) {
      return { lo: Physics.PARKER2022_SA_KEYS[i], hi: Physics.PARKER2022_SA_KEYS[i + 1], tLo: nums[i], tHi: nums[i + 1] };
    }
  }
  return null;
}
function _parker2022Mb(trt, sat) {
  var mb = trt === 'interface' ? Physics.PARKER2022_MB_INTERFACE : Physics.PARKER2022_MB_SLAB;
  return (sat != null && mb[sat] != null) ? mb[sat] : mb['default'];
}
function _parker2022C0(trt, region, sat, C) {
  var col;
  if (trt === 'interface') {
    col = sat == null ? 'c0' : sat + '_c0';
  } else if (sat == null) {
    col = 'c0slab';
  } else if (region === 'AK' || region === 'SA') {
    col = sat + '_c0slab';
  } else {
    col = region + '_c0slab';
  }
  return C[col];
}
function _parker2022Mag(sfx, C, mag, mb) {
  var dm = mag - mb;
  return dm > 0 ? C['c6' + sfx] * dm : C['c4' + sfx] * dm + C['c5' + sfx] * dm * dm;
}
function _parker2022H(trt, mag, mb) {
  if (trt === 'interface') return Math.pow(10, -0.82 + 0.252 * mag);
  var m = (Math.log10(35) - Math.log10(3.12)) / (mb - 4);
  return mag <= mb ? Math.pow(10, m * (mag - mb) + Math.log10(35)) : 35;
}
function _parker2022A0(trt, region, C) {
  if (trt === 'interface') return (region == null || region === 'Cascadia') ? C.a0 : C[region + '_a0'];
  return region == null ? C.a0slab : C[region + '_a0slab'];
}
function _parker2022Path(trt, region, sfx, C, mag, rrup, mb) {
  var h = _parker2022H(trt, mag, mb);
  var r = Math.sqrt(rrup * rrup + h * h);
  var rRref = Math.log(r / Math.sqrt(1 + h * h));
  var a0 = _parker2022A0(trt, region, C);
  return C['c1' + sfx] * Math.log(r) + (Physics.PARKER2022_CONSTS.b4 * mag) * rRref + a0 * r;
}
function _parker2022Depth(trt, C, zhyp) {
  if (trt === 'interface') return 0;
  var res = C.m * (zhyp - C.db) + C.d;
  if (zhyp >= C.db) res = C.d;
  if (zhyp <= 20) res = C.m * (20 - C.db) + C.d;
  return res;
}
function _parker2022LinSite(region, C, vs30) {
  var K = Physics.PARKER2022_CONSTS;
  var s2, s1;
  if (region == null || region === 'CAM') { s2 = C.s2; s1 = s2; }
  else if (region === 'TW' || region === 'JP') { s2 = C[region + '_s2']; s1 = C[region + '_s1']; }
  else { s2 = C[region + '_s2']; s1 = s2; }
  if (vs30 <= K.v1) return s1 * Math.log(vs30 / K.v1) + s2 * Math.log(K.v1 / K.vref);
  if (vs30 <= C.V2) return s2 * Math.log(vs30 / K.vref);
  return s2 * Math.log(C.V2 / K.vref);
}
function _parker2022Nonlin(C, period, vs30, fp, fm, c0, fd) {
  var K = Physics.PARKER2022_CONSTS;
  var pgar = Math.exp(fp + fm + c0 + fd);
  if (period != null && period >= 3) return 0;
  var fnl = C.f4 * (Math.exp(C.f5 * (Math.min(vs30, K.vrefF) - K.vb)) - Math.exp(C.f5 * (K.vrefF - K.vb)));
  return fnl * Math.log((pgar + K.f3) / K.f3);
}
function _parker2022LnRow(C, CP, trt, period, region, sat, mw, rrup, vs30, zhyp) {
  var sfx = trt === 'interface' ? '' : 'slab';
  var satE = sat != null ? sat : region;
  var mb = _parker2022Mb(trt, satE);
  var c0 = _parker2022C0(trt, region, satE, C);
  var fm = _parker2022Mag(sfx, C, mw, mb);
  var fp = _parker2022Path(trt, region, sfx, C, mw, rrup, mb);
  var fd = _parker2022Depth(trt, C, zhyp);
  var flin = _parker2022LinSite(region, C, vs30);
  var c0p = _parker2022C0(trt, region, satE, CP);
  var fmp = _parker2022Mag(sfx, CP, mw, mb);
  var fpp = _parker2022Path(trt, region, sfx, CP, mw, rrup, mb);
  var fdp = _parker2022Depth(trt, CP, zhyp);
  var fnl = _parker2022Nonlin(C, period, vs30, fpp, fmp, c0p, fdp);
  return fp + fnl + flin + fm + c0 + fd; // fb = 0 (basin off)
}
/** Median ln ground motion. imt: 'pga' | 'pgv' | SA period key or number
 *  (seconds; exact table row else log-period interpolation). trt:
 *  'interface' | 'intraslab'. Units follow hazardlib: ln g (pga/SA) and
 *  ln cm/s (pgv). Returns null for SA periods outside [0.01, 10] s. */
Physics.parker2022Ln = function(imt, trt, mw, rrupKm, vs30, hypoDepthKm, variant) {
  var v = variant || { region: null, sat: null };
  var region = v.region != null ? v.region : null;
  var sat = v.sat != null ? v.sat : null;
  var rrup = Math.max(0.1, Number(rrupKm) || 0.1);
  var v30 = Number(vs30) || 400;
  var zhyp = Number(hypoDepthKm) || (trt === 'intraslab' ? 50 : 30);
  var CP = Physics.PARKER2022_PAPER.pga;
  if (imt === 'pga' || imt === 'pgv') {
    return _parker2022LnRow(Physics.PARKER2022_PAPER[imt], CP, trt, null, region, sat, mw, rrup, v30, zhyp);
  }
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _parker2022SaKey(T);
  if (key) return _parker2022LnRow(Physics.PARKER2022_PAPER[key], CP, trt, T, region, sat, mw, rrup, v30, zhyp);
  var br = _parker2022Bracket(T);
  if (!br) return null;
  var lo = _parker2022LnRow(Physics.PARKER2022_PAPER[br.lo], CP, trt, T, region, sat, mw, rrup, v30, zhyp);
  var hi = _parker2022LnRow(Physics.PARKER2022_PAPER[br.hi], CP, trt, T, region, sat, mw, rrup, v30, zhyp);
  var w = (Math.log(T) - Math.log(br.tLo)) / (Math.log(br.tHi) - Math.log(br.tLo));
  return lo + w * (hi - lo);
};
function _parker2022SigmaRow(C, rrup, vs30) {
  var v1 = 200, v2 = 500, r1 = 200, r2 = 500;
  var phiRv;
  if (rrup <= r1) phiRv = C.phi21;
  else if (rrup >= r2) phiRv = C.phi22;
  else phiRv = (C.phi22 - C.phi21) / (Math.log(r2) - Math.log(r1)) * (Math.log(rrup) - Math.log(r1)) + C.phi21;
  if (vs30 <= v1) phiRv += C.phi2V * (Math.log(r2 / Math.max(r1, Math.min(r2, rrup))) / Math.log(r2 / r1));
  else if (vs30 < v2) phiRv += C.phi2V * ((Math.log(v2 / Math.min(v2, vs30)) / Math.log(v2 / v1))) * (Math.log(r2 / Math.max(r1, Math.min(r2, rrup))) / Math.log(r2 / r1));
  var phi = Math.sqrt(phiRv);
  return { sigma: Math.sqrt(C.Tau * C.Tau + phi * phi), tau: C.Tau, phi: phi };
}
/** Ergodic sigma in ln units (total / tau / phi). Same imt rules as
 *  parker2022Ln (SA interpolation lerps the components). */
Physics.parker2022SigmaLn = function(imt, rrupKm, vs30) {
  var rrup = Math.max(0.1, Number(rrupKm) || 0.1);
  var v30 = Number(vs30) || 400;
  if (imt === 'pga' || imt === 'pgv') return _parker2022SigmaRow(Physics.PARKER2022_PAPER[imt], rrup, v30);
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _parker2022SaKey(T);
  if (key) return _parker2022SigmaRow(Physics.PARKER2022_PAPER[key], rrup, v30);
  var br = _parker2022Bracket(T);
  if (!br) return null;
  var slo = _parker2022SigmaRow(Physics.PARKER2022_PAPER[br.lo], rrup, v30);
  var shi = _parker2022SigmaRow(Physics.PARKER2022_PAPER[br.hi], rrup, v30);
  var w = (Math.log(T) - Math.log(br.tLo)) / (Math.log(br.tHi) - Math.log(br.tLo));
  return { sigma: slo.sigma + w * (shi.sigma - slo.sigma), tau: slo.tau + w * (shi.tau - slo.tau), phi: slo.phi + w * (shi.phi - slo.phi) };
};
Physics.parker2022Sigma = function(imt, rrupKm, vs30) {
  var s = Physics.parker2022SigmaLn(imt, rrupKm, vs30);
  if (!s) return null;
  return { tau: s.tau / _LN10, phi: s.phi / _LN10, sigmaT: s.sigma / _LN10 };
};
/** NGA-Sub region variant for the active region (v6.8): california ->
 *  Cascadia, chile -> SA/SA_S, ecuador -> SA/SA_N (northern South America
 *  segment, PEER 2020/03 §4.3.4 — 2026-10-14 new-region batch), taiwan ->
 *  TW/TW_E, everything else (incl. newzealand/italy/unset) -> the global
 *  default. Japan never reaches this model on the auto route (zhao2006 stays
 *  the Japan subduction model). */
Physics.activeNgasubVariant = function() {
  var r = _activeGmpRegion;
  if (r === 'california') return { region: 'Cascadia', sat: null };
  if (r === 'chile') return { region: 'SA', sat: 'SA_S' };
  if (r === 'ecuador') return { region: 'SA', sat: 'SA_N' };
  if (r === 'taiwan') return { region: 'TW', sat: 'TW_E' };
  return { region: null, sat: null };
};
Physics.PARKER2022_G_TO_GAL = 980.665;
Physics.pgaParker2022 = function(mw, rrupKm, vs30, trt, hypoDepthKm, variant) {
  var lnA = Physics.parker2022Ln('pga', trt, mw, rrupKm, vs30, hypoDepthKm, variant || Physics.activeNgasubVariant());
  var pgaGal = Math.exp(lnA) * Physics.PARKER2022_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(pgaGal / Physics.GMPE_PGA_SOFT_CAP);
};
Physics.pgvParker2022 = function(mw, rrupKm, vs30, trt, hypoDepthKm, variant) {
  var lnA = Physics.parker2022Ln('pgv', trt, mw, rrupKm, vs30, hypoDepthKm, variant || Physics.activeNgasubVariant());
  var pgv = Math.exp(lnA);
  return Physics.GMPE_PGV_SOFT_CAP * Math.tanh(pgv / Physics.GMPE_PGV_SOFT_CAP);
};
/** SA in gal (display soft-capped like the zhao2006 SA path); null for
 *  periods outside [0.01, 10] s. */
Physics.saParker2022Gal = function(periodKey, trt, mw, rrupKm, vs30, hypoDepthKm, variant) {
  var lnA = Physics.parker2022Ln(periodKey, trt, mw, rrupKm, vs30, hypoDepthKm, variant || Physics.activeNgasubVariant());
  if (lnA == null) return null;
  var saGal = Math.exp(lnA) * Physics.PARKER2022_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(saGal / Physics.GMPE_PGA_SOFT_CAP);
};

// ================================================================
//  GMPE — NGA-West2 remaining models (v7.x batch, 2026-10-12):
//  CY14 Chiou & Youngs (2014) Earthquake Spectra 30(3) 1117-1153;
//  CB14 Campbell & Bozorgnia (2014) Earthquake Spectra 30(3) 1087-1115;
//  ASK14 Abrahamson, Silva & Kamai (2014) Earthquake Spectra 30(3) 1025-1055.
//
//  Purpose: the regional crustal PSHA class moves from the single-branch
//  BSSA14 tree to the published four-model NGA-West2 logic tree (USGS 2014
//  NSHM convention: BSSA14 / CY14 / CB14 / ASK14 at equal weight 0.25).
//  Live-sim regional auto routing is unchanged (still BSSA14); the three new
//  models are additionally selectable as explicit ADV models.
//
//  Transcription sources (pinned + sha256-locked; fetched via the GitHub
//  pinned-IP contents channel, jsDelivr being TLS-reset from this network):
//    gem/oq-engine master openquake/hazardlib/gsim/chiou_youngs_2014.py
//      sha256 8ca60bceafe62b4c42d8339efd2c0bbe713c56dd72ccf59a4758d67606a2b4eb
//    gem/oq-engine master openquake/hazardlib/gsim/campbell_bozorgnia_2014.py
//      sha256 c634814d0cd9582ab84ba3d52b71ce35a12da202f711646f943fa1e6000dd7fc
//    gem/oq-engine master openquake/hazardlib/gsim/abrahamson_2014.py
//      sha256 386e496e65f3ad228df618bc2c399275686018ed432c7ba30a083ed2ef0f8f8c
//  The coefficient tables below are extract-verify-spliced from those sources
//  (tools/nw2 pipeline, zero hand-keying); tests/gmpe-{cy14,cb14,ask14}.test.js
//  assert physics.js against the INDEPENDENT scalar transcriptions in
//  tools/gen-gmpe-fixtures-{cy14,cb14,ask14}.py (~1e-14 like zhao/bssa14/
//  parker). Hand-copied spot cells in the tests pin the tables against
//  fixture/generator tampering.
//
//  Scope (documented limitations):
//   * Base/global regional variants only (CY14 'CAL' — which is the base
//     class —, CB14 SJ=false base table, ASK14 region=None California).
//     The published regional aliases (CY14 JPN/ITA/WEN, CB14 HighQ/LowQ/Japan
//     site, ASK14 CHN/JPN/TWN) are NOT wired; Italy keeps its BSSA14 lowQ
//     branch only. Documented in the pack gmpeTree note.
//   * No measured basin depths anywhere in the engine, so the basin terms
//     take the hazardlib unmeasured-site defaults: CY14 dz1pt0 = z1 -
//     z1mean(vs30) = 0 -> EXACTLY 0; ASK14 factor = ln(z1ref/z1ref) = 0 ->
//     EXACTLY 0; CB14 evaluates the California Vs30->Z2.5 relation (Eq. 33),
//     which is nonzero only for stiff sites (z2pt5 < 1 km; ~+2.5e-3 ln at
//     PGA/Vs30 760) — carried faithfully.
//   * CY14 directivity term off (no rcdpp -> centered_dpp = 0); Boore et al.
//     2022 delta_c1/delta_g/delta_cm host-to-target adjustments off; ASK14
//     aftershock f11 term off (mainshock use); epistemic sigma_mu = 0;
//     USGS basin scaling / CyberShake adjustments off.
//   * vs30measured = false (regional Vs30 are grid/estimated values) — CY14
//     phi uses the sig3 column, ASK14 the s1e/s2e (estimated) pair.
//   * SA periods missing from a table are log-period interpolated between
//     the bracketing rows (parker2022 engine convention); outside the table
//     range Ln/Sigma return null (honest no-coverage). CY14's hazardlib PGA
//     floor (SA mean at T <= 0.3 s raised to the PGA mean when lower) and
//     CB14's soil-PGA floor (T < 0.25 s) are applied per table row BEFORE
//     interpolation.
//   * Point-source geometry convention (shared by calcPGA/calcPGV and the
//     PSHA tree): the single caller distance reads as Rjb (same read as the
//     bssa14 branch), Rrup = sqrt(Rjb^2 + ztor^2) with ztor = source depth,
//     Rx = Rjb (hanging-wall side), Ry0 = 0 (no along-strike taper), dip
//     defaults to the crustal prior 60 deg when not carried by the source,
//     CB14 width/hypo-depth estimated by the paper's own Eqs. 39 / 35-37
//     (zbot default 20 km seismogenic thickness), ASK14 width by the engine's
//     Wells & Coppersmith crustal width (ASK14 publishes no width relation).
//  pgaCy2014/pgaCb2014/pgaAsk2014 convert ln g -> gal with 980.665 and apply
//  the same display soft caps as zhao2006/bssa14/ngasub.
// ================================================================
Physics.CY2014_CONSTS = { c2: 1.06, c4: -2.1, c4a: -0.5, crb: 50.0, c8a: 0.2695, c11: 0.0, phi6: 300.0, phi6jp: 800.0, refVs: 1130 };
Physics.CB2014_CONSTS = { h4: 1.0, c: 1.88, n: 1.18, zbotKm: 20 };
Physics.ASK2014_CONSTS = { n: 1.5, m2: 5.0, h1: 0.25, h2: 1.5, h3: -0.75, refVs: 1180 };

Physics.CY2014_PAPER = {
  'pga': { c1: -1.5065, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255, cn: 16.0875, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.0956, c6: 0.4908, c7: 0.0352, c7b: 0.0462, c8: 0.0, c8a: 0.2695, c8b: 0.4833, c9: 0.9228, c9a: 0.1202, c9b: 6.8607, c11: 0.0, c11b: -0.4536, cg1: -0.007146, cg2: -0.006758, cg3: 4.2542, phi1: -0.521, phi2: -0.1417, phi3: -0.00701, phi4: 0.102151, phi5: 0.0, phi6: 300.0, gjpit: 1.5817, gwn: 0.7594, phi1jp: -0.6846, phi5jp: 0.459, phi6jp: 800.0, tau1: 0.4, tau2: 0.26, sig1: 0.4912, sig2: 0.3762, sig3: 0.8, sig2jp: 0.4528 },
  'pgv': { c1: 2.3549, c1a: 0.165, c1b: -0.0626, c1c: -0.165, c1d: 0.0626, cn: 3.3024, cm: 5.423, c2: 1.06, c3: 2.3152, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 5.8096, chm: 3.0514, c6: 0.4407, c7: 0.0324, c7b: 0.0097, c8: 0.2154, c8a: 0.2695, c8b: 5.0, c9: 0.3079, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.3834, cg1: -0.001852, cg2: -0.007403, cg3: 4.3439, phi1: -0.7936, phi2: -0.0699, phi3: -0.008444, phi4: 5.41, phi5: 0.0202, phi6: 300.0, gjpit: 2.2306, gwn: 0.335, phi1jp: -0.7966, phi5jp: 0.9488, phi6jp: 800.0, tau1: 0.3894, tau2: 0.2578, sig1: 0.4785, sig2: 0.3629, sig3: 0.7504, sig2jp: 0.3918 },
  '0.01': { c1: -1.5065, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255, cn: 16.0875, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.0956, c6: 0.4908, c7: 0.0352, c7b: 0.0462, c8: 0.0, c8a: 0.2695, c8b: 0.4833, c9: 0.9228, c9a: 0.1202, c9b: 6.8607, c11: 0.0, c11b: -0.4536, cg1: -0.007146, cg2: -0.006758, cg3: 4.2542, phi1: -0.521, phi2: -0.1417, phi3: -0.00701, phi4: 0.102151, phi5: 0.0, phi6: 300.0, gjpit: 1.5817, gwn: 0.7594, phi1jp: -0.6846, phi5jp: 0.459, phi6jp: 800.0, tau1: 0.4, tau2: 0.26, sig1: 0.4912, sig2: 0.3762, sig3: 0.8, sig2jp: 0.4528 },
  '0.02': { c1: -1.4798, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255, cn: 15.7118, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.0963, c6: 0.4925, c7: 0.0352, c7b: 0.0472, c8: 0.0, c8a: 0.2695, c8b: 1.2144, c9: 0.9296, c9a: 0.1217, c9b: 6.8697, c11: 0.0, c11b: -0.4536, cg1: -0.007249, cg2: -0.006758, cg3: 4.2386, phi1: -0.5055, phi2: -0.1364, phi3: -0.007279, phi4: 0.10836, phi5: 0.0, phi6: 300.0, gjpit: 1.574, gwn: 0.7606, phi1jp: -0.6681, phi5jp: 0.458, phi6jp: 800.0, tau1: 0.4026, tau2: 0.2637, sig1: 0.4904, sig2: 0.3762, sig3: 0.8, sig2jp: 0.4551 },
  '0.03': { c1: -1.2972, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255, cn: 15.8819, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.0974, c6: 0.4992, c7: 0.0352, c7b: 0.0533, c8: 0.0, c8a: 0.2695, c8b: 1.6421, c9: 0.9396, c9a: 0.1194, c9b: 6.9113, c11: 0.0, c11b: -0.4536, cg1: -0.007869, cg2: -0.006758, cg3: 4.2519, phi1: -0.4368, phi2: -0.1403, phi3: -0.007354, phi4: 0.119888, phi5: 0.0, phi6: 300.0, gjpit: 1.5544, gwn: 0.7642, phi1jp: -0.6314, phi5jp: 0.462, phi6jp: 800.0, tau1: 0.4063, tau2: 0.2689, sig1: 0.4988, sig2: 0.3849, sig3: 0.8, sig2jp: 0.4571 },
  '0.04': { c1: -1.1007, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255, cn: 16.4556, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.0988, c6: 0.5037, c7: 0.0352, c7b: 0.0596, c8: 0.0, c8a: 0.2695, c8b: 1.9456, c9: 0.9661, c9a: 0.1166, c9b: 7.0271, c11: 0.0, c11b: -0.4536, cg1: -0.008316, cg2: -0.006758, cg3: 4.296, phi1: -0.3752, phi2: -0.1591, phi3: -0.006977, phi4: 0.133641, phi5: 0.0, phi6: 300.0, gjpit: 1.5502, gwn: 0.7676, phi1jp: -0.5855, phi5jp: 0.453, phi6jp: 800.0, tau1: 0.4095, tau2: 0.2736, sig1: 0.5049, sig2: 0.391, sig3: 0.8, sig2jp: 0.4642 },
  '0.05': { c1: -0.9292, c1a: 0.165, c1b: -0.255, c1c: -0.165, c1d: 0.255, cn: 17.6453, cm: 4.9993, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.1011, c6: 0.5048, c7: 0.0352, c7b: 0.0639, c8: 0.0, c8a: 0.2695, c8b: 2.181, c9: 0.9794, c9a: 0.1176, c9b: 7.0959, c11: 0.0, c11b: -0.4536, cg1: -0.008743, cg2: -0.006758, cg3: 4.3578, phi1: -0.3469, phi2: -0.1862, phi3: -0.006467, phi4: 0.148927, phi5: 0.0, phi6: 300.0, gjpit: 1.5391, gwn: 0.7739, phi1jp: -0.5457, phi5jp: 0.436, phi6jp: 800.0, tau1: 0.4124, tau2: 0.2777, sig1: 0.5096, sig2: 0.3957, sig3: 0.8, sig2jp: 0.4716 },
  '0.075': { c1: -0.658, c1a: 0.165, c1b: -0.254, c1c: -0.165, c1d: 0.254, cn: 20.1772, cm: 5.0031, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.4551, chm: 3.1094, c6: 0.5048, c7: 0.0352, c7b: 0.063, c8: 0.0, c8a: 0.2695, c8b: 2.6087, c9: 1.026, c9a: 0.1171, c9b: 7.3298, c11: 0.0, c11b: -0.4536, cg1: -0.009537, cg2: -0.00619, cg3: 4.5455, phi1: -0.3747, phi2: -0.2538, phi3: -0.005734, phi4: 0.190596, phi5: 0.0, phi6: 300.0, gjpit: 1.4804, gwn: 0.7956, phi1jp: -0.4685, phi5jp: 0.383, phi6jp: 800.0, tau1: 0.4179, tau2: 0.2855, sig1: 0.5179, sig2: 0.4043, sig3: 0.8, sig2jp: 0.5022 },
  '0.1': { c1: -0.5613, c1a: 0.165, c1b: -0.253, c1c: -0.165, c1d: 0.253, cn: 19.9992, cm: 5.0172, c2: 1.06, c3: 1.9636, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 6.8305, chm: 3.2381, c6: 0.5048, c7: 0.0352, c7b: 0.0532, c8: 0.0, c8a: 0.2695, c8b: 2.9122, c9: 1.0177, c9a: 0.1146, c9b: 7.2588, c11: 0.0, c11b: -0.4536, cg1: -0.00983, cg2: -0.005332, cg3: 4.7603, phi1: -0.444, phi2: -0.2943, phi3: -0.005604, phi4: 0.230662, phi5: 0.0, phi6: 300.0, gjpit: 1.4094, gwn: 0.7932, phi1jp: -0.4985, phi5jp: 0.375, phi6jp: 800.0, tau1: 0.4219, tau2: 0.2913, sig1: 0.5236, sig2: 0.4104, sig3: 0.8, sig2jp: 0.523 },
  '0.12': { c1: -0.5342, c1a: 0.165, c1b: -0.252, c1c: -0.165, c1d: 0.252, cn: 18.7106, cm: 5.0315, c2: 1.06, c3: 1.9795, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.1333, chm: 3.3407, c6: 0.5048, c7: 0.0352, c7b: 0.0452, c8: 0.0, c8a: 0.2695, c8b: 3.1045, c9: 1.0008, c9a: 0.1128, c9b: 7.2372, c11: 0.0, c11b: -0.4536, cg1: -0.009913, cg2: -0.004732, cg3: 4.8963, phi1: -0.4895, phi2: -0.3077, phi3: -0.005696, phi4: 0.253169, phi5: 0.0, phi6: 300.0, gjpit: 1.3682, gwn: 0.7768, phi1jp: -0.5603, phi5jp: 0.377, phi6jp: 800.0, tau1: 0.4244, tau2: 0.2949, sig1: 0.527, sig2: 0.4143, sig3: 0.8, sig2jp: 0.5278 },
  '0.15': { c1: -0.5462, c1a: 0.165, c1b: -0.25, c1c: -0.165, c1d: 0.25, cn: 16.6246, cm: 5.0547, c2: 1.06, c3: 2.0362, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.3621, chm: 3.43, c6: 0.5045, c7: 0.0352, c7b: 0.0345, c8: 0.0, c8a: 0.2695, c8b: 3.3399, c9: 0.9801, c9a: 0.1106, c9b: 7.2109, c11: 0.0, c11b: -0.4536, cg1: -0.009896, cg2: -0.003806, cg3: 5.0644, phi1: -0.5477, phi2: -0.3113, phi3: -0.005845, phi4: 0.266468, phi5: 0.0, phi6: 300.0, gjpit: 1.3241, gwn: 0.7437, phi1jp: -0.6451, phi5jp: 0.379, phi6jp: 800.0, tau1: 0.4275, tau2: 0.2993, sig1: 0.5308, sig2: 0.4191, sig3: 0.8, sig2jp: 0.5304 },
  '0.17': { c1: -0.5858, c1a: 0.165, c1b: -0.248, c1c: -0.165, c1d: 0.248, cn: 15.3709, cm: 5.0704, c2: 1.06, c3: 2.0823, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.4365, chm: 3.4688, c6: 0.5036, c7: 0.0352, c7b: 0.0283, c8: 0.0, c8a: 0.2695, c8b: 3.4719, c9: 0.9652, c9a: 0.115, c9b: 7.2491, c11: 0.0, c11b: -0.4536, cg1: -0.009787, cg2: -0.00328, cg3: 5.1371, phi1: -0.5922, phi2: -0.3062, phi3: -0.005959, phi4: 0.26506, phi5: 0.0, phi6: 300.0, gjpit: 1.3071, gwn: 0.7219, phi1jp: -0.6981, phi5jp: 0.38, phi6jp: 800.0, tau1: 0.4292, tau2: 0.3017, sig1: 0.5328, sig2: 0.4217, sig3: 0.8, sig2jp: 0.531 },
  '0.2': { c1: -0.6798, c1a: 0.165, c1b: -0.2449, c1c: -0.165, c1d: 0.2449, cn: 13.7012, cm: 5.0939, c2: 1.06, c3: 2.1521, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.4972, chm: 3.5146, c6: 0.5016, c7: 0.0352, c7b: 0.0202, c8: 0.0, c8a: 0.2695, c8b: 3.6434, c9: 0.9459, c9a: 0.1208, c9b: 7.2988, c11: 0.0, c11b: -0.444, cg1: -0.009505, cg2: -0.00269, cg3: 5.188, phi1: -0.6693, phi2: -0.2927, phi3: -0.006141, phi4: 0.255253, phi5: 0.0, phi6: 300.0, gjpit: 1.2931, gwn: 0.6922, phi1jp: -0.7653, phi5jp: 0.384, phi6jp: 800.0, tau1: 0.4313, tau2: 0.3047, sig1: 0.5351, sig2: 0.4252, sig3: 0.8, sig2jp: 0.5312 },
  '0.25': { c1: -0.8663, c1a: 0.165, c1b: -0.2382, c1c: -0.165, c1d: 0.2382, cn: 11.2667, cm: 5.1315, c2: 1.06, c3: 2.2574, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5416, chm: 3.5746, c6: 0.4971, c7: 0.0352, c7b: 0.009, c8: 0.0, c8a: 0.2695, c8b: 3.8787, c9: 0.9196, c9a: 0.1208, c9b: 7.3691, c11: 0.0, c11b: -0.3539, cg1: -0.008918, cg2: -0.002128, cg3: 5.2164, phi1: -0.7766, phi2: -0.2662, phi3: -0.006439, phi4: 0.231541, phi5: 0.0, phi6: 300.0, gjpit: 1.315, gwn: 0.6579, phi1jp: -0.8469, phi5jp: 0.393, phi6jp: 800.0, tau1: 0.4341, tau2: 0.3087, sig1: 0.5377, sig2: 0.4299, sig3: 0.7999, sig2jp: 0.5309 },
  '0.3': { c1: -1.0514, c1a: 0.165, c1b: -0.2313, c1c: -0.165, c1d: 0.2313, cn: 9.1908, cm: 5.167, c2: 1.06, c3: 2.344, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.56, chm: 3.6232, c6: 0.4919, c7: 0.0352, c7b: -0.0004, c8: 0.0, c8a: 0.2695, c8b: 4.0711, c9: 0.8829, c9a: 0.1175, c9b: 6.8789, c11: 0.0, c11b: -0.2688, cg1: -0.008251, cg2: -0.001812, cg3: 5.1954, phi1: -0.8501, phi2: -0.2405, phi3: -0.006704, phi4: 0.207277, phi5: 0.001, phi6: 300.0, gjpit: 1.3514, gwn: 0.6362, phi1jp: -0.8999, phi5jp: 0.408, phi6jp: 800.0, tau1: 0.4363, tau2: 0.3119, sig1: 0.5395, sig2: 0.4338, sig3: 0.7997, sig2jp: 0.5307 },
  '0.4': { c1: -1.3794, c1a: 0.165, c1b: -0.2146, c1c: -0.165, c1d: 0.2146, cn: 6.5459, cm: 5.2317, c2: 1.06, c3: 2.4709, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5735, chm: 3.6945, c6: 0.4807, c7: 0.0352, c7b: -0.0155, c8: 0.0, c8a: 0.2695, c8b: 4.3745, c9: 0.8302, c9a: 0.106, c9b: 6.5334, c11: 0.0, c11b: -0.1793, cg1: -0.007267, cg2: -0.001274, cg3: 5.0899, phi1: -0.9431, phi2: -0.1975, phi3: -0.007125, phi4: 0.165464, phi5: 0.004, phi6: 300.0, gjpit: 1.4051, gwn: 0.6049, phi1jp: -0.9618, phi5jp: 0.462, phi6jp: 800.0, tau1: 0.4396, tau2: 0.3165, sig1: 0.5422, sig2: 0.4399, sig3: 0.7988, sig2jp: 0.531 },
  '0.5': { c1: -1.6508, c1a: 0.165, c1b: -0.1972, c1c: -0.165, c1d: 0.1972, cn: 5.2305, cm: 5.2893, c2: 1.06, c3: 2.5567, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5778, chm: 3.7401, c6: 0.4707, c7: 0.0352, c7b: -0.0278, c8: 0.0991, c8a: 0.2695, c8b: 4.6099, c9: 0.7884, c9a: 0.1061, c9b: 6.526, c11: 0.0, c11b: -0.1428, cg1: -0.006492, cg2: -0.001074, cg3: 4.7854, phi1: -1.0044, phi2: -0.1633, phi3: -0.007435, phi4: 0.133828, phi5: 0.01, phi6: 300.0, gjpit: 1.4402, gwn: 0.5507, phi1jp: -0.9945, phi5jp: 0.524, phi6jp: 800.0, tau1: 0.4419, tau2: 0.3199, sig1: 0.5433, sig2: 0.4446, sig3: 0.7966, sig2jp: 0.5313 },
  '0.75': { c1: -2.1511, c1a: 0.165, c1b: -0.162, c1c: -0.165, c1d: 0.162, cn: 3.7896, cm: 5.4109, c2: 1.06, c3: 2.6812, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5808, chm: 3.7941, c6: 0.4575, c7: 0.0352, c7b: -0.0477, c8: 0.1982, c8a: 0.2695, c8b: 5.0376, c9: 0.6754, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1138, cg1: -0.005147, cg2: -0.001115, cg3: 4.3304, phi1: -1.0602, phi2: -0.1028, phi3: -0.00812, phi4: 0.085153, phi5: 0.034, phi6: 300.0, gjpit: 1.528, gwn: 0.3582, phi1jp: -1.0225, phi5jp: 0.658, phi6jp: 800.0, tau1: 0.4459, tau2: 0.3255, sig1: 0.5294, sig2: 0.4533, sig3: 0.7792, sig2jp: 0.5309 },
  '1': { c1: -2.5365, c1a: 0.165, c1b: -0.14, c1c: -0.165, c1d: 0.14, cn: 3.3024, cm: 5.5106, c2: 1.06, c3: 2.7474, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5814, chm: 3.8144, c6: 0.4522, c7: 0.0352, c7b: -0.0559, c8: 0.2154, c8a: 0.2695, c8b: 5.3411, c9: 0.6196, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1062, cg1: -0.004277, cg2: -0.001197, cg3: 4.1667, phi1: -1.0941, phi2: -0.0699, phi3: -0.008444, phi4: 0.058595, phi5: 0.067, phi6: 300.0, gjpit: 1.6523, gwn: 0.2003, phi1jp: -1.0002, phi5jp: 0.78, phi6jp: 800.0, tau1: 0.4484, tau2: 0.3291, sig1: 0.5105, sig2: 0.4594, sig3: 0.7504, sig2jp: 0.5302 },
  '1.5': { c1: -3.0686, c1a: 0.165, c1b: -0.1184, c1c: -0.165, c1d: 0.1184, cn: 2.8498, cm: 5.6705, c2: 1.06, c3: 2.8161, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5817, chm: 3.8284, c6: 0.4501, c7: 0.0352, c7b: -0.063, c8: 0.2154, c8a: 0.2695, c8b: 5.7688, c9: 0.5101, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.102, cg1: -0.002979, cg2: -0.001675, cg3: 4.0029, phi1: -1.1142, phi2: -0.0425, phi3: -0.007707, phi4: 0.031787, phi5: 0.143, phi6: 300.0, gjpit: 1.8872, gwn: 0.0356, phi1jp: -0.9245, phi5jp: 0.96, phi6jp: 800.0, tau1: 0.4515, tau2: 0.3335, sig1: 0.4783, sig2: 0.468, sig3: 0.7136, sig2jp: 0.5276 },
  '2': { c1: -3.4148, c1a: 0.1645, c1b: -0.11, c1c: -0.1645, c1d: 0.11, cn: 2.5417, cm: 5.7981, c2: 1.06, c3: 2.8514, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5818, chm: 3.833, c6: 0.45, c7: 0.0352, c7b: -0.0665, c8: 0.2154, c8a: 0.2695, c8b: 6.0723, c9: 0.3917, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1009, cg1: -0.002301, cg2: -0.002349, cg3: 3.8949, phi1: -1.1154, phi2: -0.0302, phi3: -0.004792, phi4: 0.019716, phi5: 0.203, phi6: 300.0, gjpit: 2.1348, gwn: 0.0, phi1jp: -0.8626, phi5jp: 1.11, phi6jp: 800.0, tau1: 0.4534, tau2: 0.3363, sig1: 0.4681, sig2: 0.4681, sig3: 0.7035, sig2jp: 0.5167 },
  '3': { c1: -3.9013, c1a: 0.1168, c1b: -0.104, c1c: -0.1168, c1d: 0.104, cn: 2.1488, cm: 5.9983, c2: 1.06, c3: 2.8875, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5818, chm: 3.8361, c6: 0.45, c7: 0.016, c7b: -0.0516, c8: 0.2154, c8a: 0.2695, c8b: 6.5, c9: 0.1244, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1003, cg1: -0.001344, cg2: -0.003306, cg3: 3.7928, phi1: -1.1081, phi2: -0.0129, phi3: -0.001828, phi4: 0.009643, phi5: 0.277, phi6: 300.0, gjpit: 3.5752, gwn: 0.0, phi1jp: -0.7882, phi5jp: 1.291, phi6jp: 800.0, tau1: 0.4558, tau2: 0.3398, sig1: 0.4617, sig2: 0.4617, sig3: 0.7006, sig2jp: 0.4917 },
  '4': { c1: -4.2466, c1a: 0.0732, c1b: -0.102, c1c: -0.0732, c1d: 0.102, cn: 1.8957, cm: 6.1552, c2: 1.06, c3: 2.9058, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5818, chm: 3.8369, c6: 0.45, c7: 0.0062, c7b: -0.0448, c8: 0.2154, c8a: 0.2695, c8b: 6.8035, c9: 0.0086, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1001, cg1: -0.001084, cg2: -0.003566, cg3: 3.7443, phi1: -1.0603, phi2: -0.0016, phi3: -0.001523, phi4: 0.005379, phi5: 0.309, phi6: 300.0, gjpit: 3.8646, gwn: 0.0, phi1jp: -0.7195, phi5jp: 1.387, phi6jp: 800.0, tau1: 0.4574, tau2: 0.3419, sig1: 0.4571, sig2: 0.4571, sig3: 0.7001, sig2jp: 0.4682 },
  '5': { c1: -4.5143, c1a: 0.0484, c1b: -0.101, c1c: -0.0484, c1d: 0.101, cn: 1.7228, cm: 6.2856, c2: 1.06, c3: 2.9169, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5818, chm: 3.8376, c6: 0.45, c7: 0.0029, c7b: -0.0424, c8: 0.2154, c8a: 0.2695, c8b: 7.0389, c9: 0.0, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1001, cg1: -0.00101, cg2: -0.00364, cg3: 3.709, phi1: -0.9872, phi2: 0.0, phi3: -0.00144, phi4: 0.003223, phi5: 0.321, phi6: 300.0, gjpit: 3.7292, gwn: 0.0, phi1jp: -0.656, phi5jp: 1.433, phi6jp: 800.0, tau1: 0.4584, tau2: 0.3435, sig1: 0.4535, sig2: 0.4535, sig3: 0.7, sig2jp: 0.4517 },
  '7.5': { c1: -5.0009, c1a: 0.022, c1b: -0.101, c1c: -0.022, c1d: 0.101, cn: 1.5737, cm: 6.5428, c2: 1.06, c3: 2.932, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5818, chm: 3.838, c6: 0.45, c7: 0.0007, c7b: -0.0348, c8: 0.2154, c8a: 0.2695, c8b: 7.4666, c9: 0.0, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1, cg1: -0.000964, cg2: -0.003686, cg3: 3.6632, phi1: -0.8274, phi2: 0.0, phi3: -0.001369, phi4: 0.001134, phi5: 0.329, phi6: 300.0, gjpit: 2.3763, gwn: 0.0, phi1jp: -0.5202, phi5jp: 1.46, phi6jp: 800.0, tau1: 0.4601, tau2: 0.3459, sig1: 0.4471, sig2: 0.4471, sig3: 0.7, sig2jp: 0.4167 },
  '10': { c1: -5.3461, c1a: 0.0124, c1b: -0.1, c1c: -0.0124, c1d: 0.1, cn: 1.5265, cm: 6.7415, c2: 1.06, c3: 2.9396, c4: -2.1, c4a: -0.5, crb: 50.0, c5: 7.5818, chm: 3.838, c6: 0.45, c7: 0.0003, c7b: -0.0253, c8: 0.2154, c8a: 0.2695, c8b: 7.77, c9: 0.0, c9a: 0.1, c9b: 6.5, c11: 0.0, c11b: -0.1, cg1: -0.00095, cg2: -0.0037, cg3: 3.623, phi1: -0.7053, phi2: 0.0, phi3: -0.001361, phi4: 0.000515, phi5: 0.33, phi6: 300.0, gjpit: 1.7679, gwn: 0.0, phi1jp: -0.4068, phi5jp: 1.464, phi6jp: 800.0, tau1: 0.4612, tau2: 0.3474, sig1: 0.4426, sig2: 0.4426, sig3: 0.7, sig2jp: 0.3755 },
};

Physics.CY2014_SA_KEYS = ["0.01", "0.02", "0.03", "0.04", "0.05", "0.075", "0.1", "0.12", "0.15", "0.17", "0.2", "0.25", "0.3", "0.4", "0.5", "0.75", "1", "1.5", "2", "3", "4", "5", "7.5", "10"];

Physics.CB2014_PAPER = {
  'pga': { c0: -4.416, c1: 0.984, c2: 0.537, c3: -1.499, c4: -0.496, c5: -2.773, c6: 0.248, c7: 6.768, c8: 0.0, c9: -0.212, c10: 0.72, c11: 1.09, c12: 2.186, c13: 1.42, c14: -0.0064, c15: -0.202, c16: 0.393, c17: 0.0977, c18: 0.0333, c19: 0.00757, c20: -0.0055, Dc20: 0.0, a2: 0.167, h1: 0.241, h2: 1.474, h3: -0.715, h5: -0.337, h6: -0.27, k1: 865.0, k2: -1.186, k3: 1.839, phi1: 0.734, phi2: 0.492, tau1: 0.409, tau2: 0.322, rho1pga: 1.0, rho2pga: 1.0, philnAF: 0.3, phiC: 0.271, rholny: 1.0 },
  'pgv': { c0: -2.895, c1: 1.51, c2: 0.27, c3: -1.299, c4: -0.453, c5: -2.466, c6: 0.204, c7: 5.837, c8: 0.0, c9: -0.168, c10: 0.305, c11: 1.713, c12: 2.602, c13: 2.457, c14: 0.106, c15: 0.332, c16: 0.585, c17: 0.0517, c18: 0.0327, c19: 0.00613, c20: -0.0017, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: -1.955, k3: 1.929, phi1: 0.655, phi2: 0.494, tau1: 0.317, tau2: 0.297, rho1pga: 0.877, rho2pga: 0.654, philnAF: 0.3, phiC: 0.29, rholny: 0.684 },
  '0.01': { c0: -4.365, c1: 0.977, c2: 0.533, c3: -1.485, c4: -0.499, c5: -2.773, c6: 0.248, c7: 6.753, c8: 0.0, c9: -0.214, c10: 0.72, c11: 1.094, c12: 2.191, c13: 1.416, c14: -0.007, c15: -0.207, c16: 0.39, c17: 0.0981, c18: 0.0334, c19: 0.00755, c20: -0.0055, Dc20: 0.0, a2: 0.168, h1: 0.242, h2: 1.471, h3: -0.714, h5: -0.336, h6: -0.27, k1: 865.0, k2: -1.186, k3: 1.839, phi1: 0.734, phi2: 0.492, tau1: 0.404, tau2: 0.325, rho1pga: 1.0, rho2pga: 1.0, philnAF: 0.3, phiC: 0.19, rholny: 1.0 },
  '0.02': { c0: -4.348, c1: 0.976, c2: 0.549, c3: -1.488, c4: -0.501, c5: -2.772, c6: 0.247, c7: 6.502, c8: 0.0, c9: -0.208, c10: 0.73, c11: 1.149, c12: 2.189, c13: 1.453, c14: -0.0167, c15: -0.199, c16: 0.387, c17: 0.1009, c18: 0.0327, c19: 0.00759, c20: -0.0055, Dc20: 0.0, a2: 0.166, h1: 0.244, h2: 1.467, h3: -0.711, h5: -0.339, h6: -0.263, k1: 865.0, k2: -1.219, k3: 1.84, phi1: 0.738, phi2: 0.496, tau1: 0.417, tau2: 0.326, rho1pga: 0.999, rho2pga: 0.998, philnAF: 0.3, phiC: 0.166, rholny: 0.998 },
  '0.03': { c0: -4.024, c1: 0.931, c2: 0.628, c3: -1.494, c4: -0.517, c5: -2.782, c6: 0.246, c7: 6.291, c8: 0.0, c9: -0.213, c10: 0.759, c11: 1.29, c12: 2.164, c13: 1.476, c14: -0.0422, c15: -0.202, c16: 0.378, c17: 0.1095, c18: 0.0331, c19: 0.0079, c20: -0.0057, Dc20: 0.0, a2: 0.167, h1: 0.246, h2: 1.467, h3: -0.713, h5: -0.338, h6: -0.259, k1: 908.0, k2: -1.273, k3: 1.841, phi1: 0.747, phi2: 0.503, tau1: 0.446, tau2: 0.344, rho1pga: 0.987, rho2pga: 0.987, philnAF: 0.3, phiC: 0.166, rholny: 0.986 },
  '0.05': { c0: -3.479, c1: 0.887, c2: 0.674, c3: -1.388, c4: -0.615, c5: -2.791, c6: 0.24, c7: 6.317, c8: 0.0, c9: -0.244, c10: 0.826, c11: 1.449, c12: 2.138, c13: 1.549, c14: -0.0663, c15: -0.339, c16: 0.295, c17: 0.1226, c18: 0.027, c19: 0.00803, c20: -0.0063, Dc20: 0.0, a2: 0.173, h1: 0.251, h2: 1.449, h3: -0.701, h5: -0.338, h6: -0.263, k1: 1054.0, k2: -1.346, k3: 1.843, phi1: 0.777, phi2: 0.52, tau1: 0.508, tau2: 0.377, rho1pga: 0.955, rho2pga: 0.946, philnAF: 0.3, phiC: 0.166, rholny: 0.938 },
  '0.075': { c0: -3.293, c1: 0.902, c2: 0.726, c3: -1.469, c4: -0.596, c5: -2.745, c6: 0.227, c7: 6.861, c8: 0.0, c9: -0.266, c10: 0.815, c11: 1.535, c12: 2.446, c13: 1.772, c14: -0.0794, c15: -0.404, c16: 0.322, c17: 0.1165, c18: 0.0288, c19: 0.00811, c20: -0.007, Dc20: 0.0, a2: 0.198, h1: 0.26, h2: 1.435, h3: -0.695, h5: -0.347, h6: -0.219, k1: 1086.0, k2: -1.471, k3: 1.845, phi1: 0.782, phi2: 0.535, tau1: 0.504, tau2: 0.418, rho1pga: 0.943, rho2pga: 0.897, philnAF: 0.3, phiC: 0.165, rholny: 0.887 },
  '0.1': { c0: -3.666, c1: 0.993, c2: 0.698, c3: -1.572, c4: -0.536, c5: -2.633, c6: 0.21, c7: 7.294, c8: 0.0, c9: -0.229, c10: 0.831, c11: 1.615, c12: 2.969, c13: 1.916, c14: -0.0294, c15: -0.416, c16: 0.384, c17: 0.0998, c18: 0.0325, c19: 0.00744, c20: -0.0073, Dc20: 0.0, a2: 0.174, h1: 0.259, h2: 1.449, h3: -0.708, h5: -0.391, h6: -0.201, k1: 1032.0, k2: -1.624, k3: 1.847, phi1: 0.769, phi2: 0.543, tau1: 0.445, tau2: 0.426, rho1pga: 0.942, rho2pga: 0.883, philnAF: 0.3, phiC: 0.162, rholny: 0.87 },
  '0.15': { c0: -4.866, c1: 1.267, c2: 0.51, c3: -1.669, c4: -0.49, c5: -2.458, c6: 0.183, c7: 8.031, c8: 0.0, c9: -0.211, c10: 0.749, c11: 1.877, c12: 3.544, c13: 2.161, c14: 0.0642, c15: -0.407, c16: 0.417, c17: 0.076, c18: 0.0388, c19: 0.00716, c20: -0.0069, Dc20: 0.0, a2: 0.198, h1: 0.254, h2: 1.461, h3: -0.715, h5: -0.449, h6: -0.099, k1: 878.0, k2: -1.931, k3: 1.852, phi1: 0.769, phi2: 0.543, tau1: 0.382, tau2: 0.387, rho1pga: 0.921, rho2pga: 0.891, philnAF: 0.3, phiC: 0.158, rholny: 0.876 },
  '0.2': { c0: -5.411, c1: 1.366, c2: 0.447, c3: -1.75, c4: -0.451, c5: -2.421, c6: 0.182, c7: 8.385, c8: 0.0, c9: -0.163, c10: 0.764, c11: 2.069, c12: 3.707, c13: 2.465, c14: 0.0968, c15: -0.311, c16: 0.404, c17: 0.0571, c18: 0.0437, c19: 0.00688, c20: -0.006, Dc20: 0.0, a2: 0.204, h1: 0.237, h2: 1.484, h3: -0.721, h5: -0.393, h6: -0.198, k1: 748.0, k2: -2.188, k3: 1.856, phi1: 0.761, phi2: 0.552, tau1: 0.339, tau2: 0.338, rho1pga: 0.874, rho2pga: 0.881, philnAF: 0.3, phiC: 0.17, rholny: 0.87 },
  '0.25': { c0: -5.962, c1: 1.458, c2: 0.274, c3: -1.711, c4: -0.404, c5: -2.392, c6: 0.189, c7: 7.534, c8: 0.0, c9: -0.15, c10: 0.716, c11: 2.205, c12: 3.343, c13: 2.766, c14: 0.1441, c15: -0.172, c16: 0.466, c17: 0.0437, c18: 0.0463, c19: 0.00556, c20: -0.0055, Dc20: 0.0, a2: 0.185, h1: 0.206, h2: 1.581, h3: -0.787, h5: -0.339, h6: -0.21, k1: 654.0, k2: -2.381, k3: 1.861, phi1: 0.744, phi2: 0.545, tau1: 0.34, tau2: 0.316, rho1pga: 0.809, rho2pga: 0.861, philnAF: 0.3, phiC: 0.18, rholny: 0.85 },
  '0.3': { c0: -6.403, c1: 1.528, c2: 0.193, c3: -1.77, c4: -0.321, c5: -2.376, c6: 0.195, c7: 6.99, c8: 0.0, c9: -0.131, c10: 0.737, c11: 2.306, c12: 3.334, c13: 3.011, c14: 0.1597, c15: -0.084, c16: 0.528, c17: 0.0323, c18: 0.0508, c19: 0.00458, c20: -0.0049, Dc20: 0.0, a2: 0.164, h1: 0.21, h2: 1.586, h3: -0.795, h5: -0.447, h6: -0.121, k1: 587.0, k2: -2.518, k3: 1.865, phi1: 0.727, phi2: 0.568, tau1: 0.34, tau2: 0.3, rho1pga: 0.741, rho2pga: 0.824, philnAF: 0.3, phiC: 0.186, rholny: 0.819 },
  '0.4': { c0: -7.566, c1: 1.739, c2: -0.02, c3: -1.594, c4: -0.426, c5: -2.303, c6: 0.185, c7: 7.012, c8: 0.0, c9: -0.159, c10: 0.738, c11: 2.398, c12: 3.544, c13: 3.203, c14: 0.141, c15: 0.085, c16: 0.54, c17: 0.0209, c18: 0.0432, c19: 0.00401, c20: -0.0037, Dc20: 0.0, a2: 0.16, h1: 0.226, h2: 1.544, h3: -0.77, h5: -0.525, h6: -0.086, k1: 503.0, k2: -2.657, k3: 1.874, phi1: 0.69, phi2: 0.593, tau1: 0.356, tau2: 0.264, rho1pga: 0.635, rho2pga: 0.738, philnAF: 0.3, phiC: 0.191, rholny: 0.743 },
  '0.5': { c0: -8.379, c1: 1.872, c2: -0.121, c3: -1.577, c4: -0.44, c5: -2.296, c6: 0.186, c7: 6.902, c8: 0.0, c9: -0.153, c10: 0.718, c11: 2.355, c12: 3.016, c13: 3.333, c14: 0.1474, c15: 0.233, c16: 0.638, c17: 0.0092, c18: 0.0405, c19: 0.00388, c20: -0.0027, Dc20: 0.0, a2: 0.184, h1: 0.217, h2: 1.554, h3: -0.77, h5: -0.407, h6: -0.281, k1: 457.0, k2: -2.669, k3: 1.883, phi1: 0.663, phi2: 0.611, tau1: 0.379, tau2: 0.263, rho1pga: 0.553, rho2pga: 0.661, philnAF: 0.3, phiC: 0.198, rholny: 0.684 },
  '0.75': { c0: -9.841, c1: 2.021, c2: -0.042, c3: -1.757, c4: -0.443, c5: -2.232, c6: 0.186, c7: 5.522, c8: 0.0, c9: -0.09, c10: 0.795, c11: 1.995, c12: 2.616, c13: 3.054, c14: 0.1764, c15: 0.411, c16: 0.776, c17: -0.0082, c18: 0.042, c19: 0.0042, c20: -0.0016, Dc20: 0.0, a2: 0.216, h1: 0.154, h2: 1.626, h3: -0.78, h5: -0.371, h6: -0.285, k1: 410.0, k2: -2.401, k3: 1.906, phi1: 0.606, phi2: 0.633, tau1: 0.43, tau2: 0.326, rho1pga: 0.393, rho2pga: 0.526, philnAF: 0.3, phiC: 0.206, rholny: 0.562 },
  '1': { c0: -11.011, c1: 2.18, c2: -0.069, c3: -1.707, c4: -0.527, c5: -2.158, c6: 0.169, c7: 5.65, c8: 0.0, c9: -0.105, c10: 0.556, c11: 1.447, c12: 2.47, c13: 2.562, c14: 0.2593, c15: 0.479, c16: 0.771, c17: -0.0131, c18: 0.0426, c19: 0.00409, c20: -0.0006, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: -1.955, k3: 1.929, phi1: 0.579, phi2: 0.628, tau1: 0.47, tau2: 0.353, rho1pga: 0.313, rho2pga: 0.438, philnAF: 0.3, phiC: 0.208, rholny: 0.467 },
  '1.5': { c0: -12.469, c1: 2.27, c2: 0.047, c3: -1.621, c4: -0.63, c5: -2.063, c6: 0.158, c7: 5.795, c8: 0.0, c9: -0.058, c10: 0.48, c11: 0.33, c12: 2.108, c13: 1.453, c14: 0.2881, c15: 0.566, c16: 0.748, c17: -0.0187, c18: 0.038, c19: 0.00424, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: -1.025, k3: 1.974, phi1: 0.541, phi2: 0.603, tau1: 0.497, tau2: 0.399, rho1pga: 0.242, rho2pga: 0.36, philnAF: 0.3, phiC: 0.221, rholny: 0.364 },
  '2': { c0: -12.969, c1: 2.271, c2: 0.149, c3: -1.512, c4: -0.768, c5: -2.104, c6: 0.158, c7: 6.632, c8: 0.0, c9: -0.028, c10: 0.401, c11: -0.514, c12: 1.327, c13: 0.657, c14: 0.3112, c15: 0.562, c16: 0.763, c17: -0.0258, c18: 0.0252, c19: 0.00448, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: -0.299, k3: 2.019, phi1: 0.529, phi2: 0.588, tau1: 0.499, tau2: 0.4, rho1pga: 0.234, rho2pga: 0.318, philnAF: 0.3, phiC: 0.225, rholny: 0.298 },
  '3': { c0: -13.306, c1: 2.15, c2: 0.368, c3: -1.315, c4: -0.89, c5: -2.051, c6: 0.148, c7: 6.759, c8: 0.0, c9: 0.0, c10: 0.206, c11: -0.848, c12: 0.601, c13: 0.367, c14: 0.3478, c15: 0.534, c16: 0.686, c17: -0.0311, c18: 0.0236, c19: 0.00345, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: 0.0, k3: 2.11, phi1: 0.527, phi2: 0.578, tau1: 0.5, tau2: 0.417, rho1pga: 0.236, rho2pga: 0.295, philnAF: 0.3, phiC: 0.222, rholny: 0.234 },
  '4': { c0: -14.02, c1: 2.132, c2: 0.726, c3: -1.506, c4: -0.885, c5: -1.986, c6: 0.135, c7: 7.978, c8: 0.0, c9: 0.0, c10: 0.105, c11: -0.793, c12: 0.568, c13: 0.306, c14: 0.3747, c15: 0.522, c16: 0.691, c17: -0.0413, c18: 0.0102, c19: 0.00603, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: 0.0, k3: 2.2, phi1: 0.521, phi2: 0.559, tau1: 0.543, tau2: 0.393, rho1pga: 0.232, rho2pga: 0.274, philnAF: 0.3, phiC: 0.226, rholny: 0.202 },
  '5': { c0: -14.558, c1: 2.116, c2: 1.027, c3: -1.721, c4: -0.878, c5: -2.021, c6: 0.135, c7: 8.538, c8: 0.0, c9: 0.0, c10: 0.0, c11: -0.748, c12: 0.356, c13: 0.268, c14: 0.3382, c15: 0.477, c16: 0.67, c17: -0.0281, c18: 0.0034, c19: 0.00805, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: 0.0, k3: 2.291, phi1: 0.502, phi2: 0.551, tau1: 0.534, tau2: 0.421, rho1pga: 0.182, rho2pga: 0.247, philnAF: 0.3, phiC: 0.229, rholny: 0.184 },
  '7.5': { c0: -15.509, c1: 2.223, c2: 0.169, c3: -0.756, c4: -1.077, c5: -2.179, c6: 0.165, c7: 8.468, c8: 0.0, c9: 0.0, c10: 0.0, c11: -0.664, c12: 0.075, c13: 0.374, c14: 0.3754, c15: 0.321, c16: 0.757, c17: -0.0205, c18: 0.005, c19: 0.0028, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: 0.0, k3: 2.517, phi1: 0.457, phi2: 0.546, tau1: 0.523, tau2: 0.438, rho1pga: 0.142, rho2pga: 0.203, philnAF: 0.3, phiC: 0.237, rholny: 0.176 },
  '10': { c0: -15.975, c1: 2.132, c2: 0.367, c3: -0.8, c4: -1.282, c5: -2.244, c6: 0.18, c7: 6.564, c8: 0.0, c9: 0.0, c10: 0.0, c11: -0.576, c12: -0.027, c13: 0.297, c14: 0.3506, c15: 0.174, c16: 0.621, c17: 0.0009, c18: 0.0099, c19: 0.00458, c20: 0.0, Dc20: 0.0, a2: 0.596, h1: 0.117, h2: 1.616, h3: -0.733, h5: -0.128, h6: -0.756, k1: 400.0, k2: 0.0, k3: 2.744, phi1: 0.441, phi2: 0.543, tau1: 0.466, tau2: 0.438, rho1pga: 0.111, rho2pga: 0.103, philnAF: 0.3, phiC: 0.237, rholny: 0.154 },
};

Physics.CB2014_SA_KEYS = ["0.01", "0.02", "0.03", "0.05", "0.075", "0.1", "0.15", "0.2", "0.25", "0.3", "0.4", "0.5", "0.75", "1", "1.5", "2", "3", "4", "5", "7.5", "10"];

Physics.ASK2014_PAPER = {
  'pga': { m1: 6.75, vlin: 660.0, b: -1.47, c: 2.4, c4: 4.5, a1: 0.587, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.154, a7: 0.0, a8: -0.015, a10: 1.735, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0072, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0015, a28: 0.0025, a29: -0.0034, a31: -0.1503, a36: 0.265, a37: 0.337, a38: 0.188, a39: 0.0, a40: 0.088, a41: -0.196, a42: 0.044, s1e: 0.754, s2e: 0.52, s3: 0.47, s4: 0.36, s1m: 0.741, s2m: 0.501, s5: 0.54, s6: 0.63 },
  'pgv': { m1: 6.75, vlin: 330.0, b: -2.02, c: 2400.0, c4: 4.5, a1: 5.975, a2: -0.919, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.366, a7: 0.0, a8: -0.094, a10: 2.36, a11: 0.0, a12: -0.1, a13: 0.25, a14: 0.22, a15: 0.3, a17: -0.0005, a43: 0.28, a44: 0.15, a45: 0.09, a46: 0.07, a25: -0.0001, a28: 0.0005, a29: -0.0037, a31: -0.1462, a36: 0.377, a37: 0.212, a38: 0.157, a39: 0.0, a40: 0.095, a41: -0.038, a42: 0.065, s1e: 0.662, s2e: 0.51, s3: 0.38, s4: 0.38, s1m: 0.66, s2m: 0.51, s5: 0.58, s6: 0.53 },
  '0.01': { m1: 6.75, vlin: 660.0, b: -1.47, c: 2.4, c4: 4.5, a1: 0.587, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.154, a7: 0.0, a8: -0.015, a10: 1.735, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0072, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0015, a28: 0.0025, a29: -0.0034, a31: -0.1503, a36: 0.265, a37: 0.337, a38: 0.188, a39: 0.0, a40: 0.088, a41: -0.196, a42: 0.044, s1e: 0.754, s2e: 0.52, s3: 0.47, s4: 0.36, s1m: 0.741, s2m: 0.501, s5: 0.54, s6: 0.63 },
  '0.02': { m1: 6.75, vlin: 680.0, b: -1.46, c: 2.4, c4: 4.5, a1: 0.598, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.146, a7: 0.0, a8: -0.015, a10: 1.718, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0073, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0015, a28: 0.0024, a29: -0.0033, a31: -0.1479, a36: 0.255, a37: 0.328, a38: 0.184, a39: 0.0, a40: 0.088, a41: -0.194, a42: 0.061, s1e: 0.76, s2e: 0.52, s3: 0.47, s4: 0.36, s1m: 0.747, s2m: 0.501, s5: 0.54, s6: 0.63 },
  '0.03': { m1: 6.75, vlin: 770.0, b: -1.39, c: 2.4, c4: 4.5, a1: 0.602, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.157, a7: 0.0, a8: -0.015, a10: 1.615, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0075, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0016, a28: 0.0023, a29: -0.0034, a31: -0.1447, a36: 0.249, a37: 0.32, a38: 0.18, a39: 0.0, a40: 0.093, a41: -0.175, a42: 0.162, s1e: 0.781, s2e: 0.52, s3: 0.47, s4: 0.36, s1m: 0.769, s2m: 0.501, s5: 0.55, s6: 0.63 },
  '0.05': { m1: 6.75, vlin: 915.0, b: -1.22, c: 2.4, c4: 4.5, a1: 0.707, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.085, a7: 0.0, a8: -0.015, a10: 1.358, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.008, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.002, a28: 0.0027, a29: -0.0033, a31: -0.1326, a36: 0.202, a37: 0.289, a38: 0.167, a39: 0.0, a40: 0.133, a41: -0.09, a42: 0.451, s1e: 0.81, s2e: 0.53, s3: 0.47, s4: 0.36, s1m: 0.798, s2m: 0.512, s5: 0.56, s6: 0.65 },
  '0.075': { m1: 6.75, vlin: 960.0, b: -1.15, c: 2.4, c4: 4.5, a1: 0.973, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.029, a7: 0.0, a8: -0.015, a10: 1.258, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0089, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0027, a28: 0.0032, a29: -0.0029, a31: -0.1353, a36: 0.126, a37: 0.275, a38: 0.173, a39: 0.0, a40: 0.186, a41: 0.09, a42: 0.506, s1e: 0.81, s2e: 0.54, s3: 0.47, s4: 0.36, s1m: 0.798, s2m: 0.522, s5: 0.57, s6: 0.69 },
  '0.1': { m1: 6.75, vlin: 910.0, b: -1.23, c: 2.4, c4: 4.5, a1: 1.169, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.041, a7: 0.0, a8: -0.015, a10: 1.31, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0095, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0033, a28: 0.0036, a29: -0.0025, a31: -0.1128, a36: 0.022, a37: 0.256, a38: 0.189, a39: 0.0, a40: 0.16, a41: 0.006, a42: 0.335, s1e: 0.81, s2e: 0.55, s3: 0.47, s4: 0.36, s1m: 0.795, s2m: 0.527, s5: 0.57, s6: 0.7 },
  '0.15': { m1: 6.75, vlin: 740.0, b: -1.59, c: 2.4, c4: 4.5, a1: 1.442, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.121, a7: 0.0, a8: -0.022, a10: 1.66, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0095, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.05, a25: -0.0035, a28: 0.0033, a29: -0.0025, a31: 0.0383, a36: -0.136, a37: 0.162, a38: 0.108, a39: 0.0, a40: 0.068, a41: -0.156, a42: -0.084, s1e: 0.801, s2e: 0.56, s3: 0.47, s4: 0.36, s1m: 0.773, s2m: 0.519, s5: 0.58, s6: 0.7 },
  '0.2': { m1: 6.75, vlin: 590.0, b: -2.01, c: 2.4, c4: 4.5, a1: 1.637, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.224, a7: 0.0, a8: -0.03, a10: 2.22, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.3, a15: 1.1, a17: -0.0086, a43: 0.1, a44: 0.05, a45: 0.0, a46: -0.03, a25: -0.0033, a28: 0.0027, a29: -0.0031, a31: 0.0775, a36: -0.078, a37: 0.224, a38: 0.115, a39: 0.0, a40: 0.048, a41: -0.274, a42: -0.178, s1e: 0.789, s2e: 0.565, s3: 0.47, s4: 0.36, s1m: 0.753, s2m: 0.514, s5: 0.59, s6: 0.7 },
  '0.25': { m1: 6.75, vlin: 495.0, b: -2.41, c: 2.4, c4: 4.5, a1: 1.701, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.312, a7: 0.0, a8: -0.038, a10: 2.77, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.24, a15: 1.1, a17: -0.0074, a43: 0.1, a44: 0.05, a45: 0.0, a46: 0.0, a25: -0.0029, a28: 0.0024, a29: -0.0036, a31: 0.0741, a36: 0.037, a37: 0.248, a38: 0.122, a39: 0.0, a40: 0.055, a41: -0.248, a42: -0.187, s1e: 0.77, s2e: 0.57, s3: 0.47, s4: 0.36, s1m: 0.729, s2m: 0.513, s5: 0.61, s6: 0.7 },
  '0.3': { m1: 6.75, vlin: 430.0, b: -2.76, c: 2.4, c4: 4.5, a1: 1.712, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.338, a7: 0.0, a8: -0.045, a10: 3.25, a11: 0.0, a12: -0.1, a13: 0.6, a14: -0.19, a15: 1.03, a17: -0.0064, a43: 0.1, a44: 0.05, a45: 0.03, a46: 0.03, a25: -0.0027, a28: 0.002, a29: -0.0039, a31: 0.2548, a36: -0.091, a37: 0.203, a38: 0.096, a39: 0.0, a40: 0.073, a41: -0.203, a42: -0.159, s1e: 0.74, s2e: 0.58, s3: 0.47, s4: 0.36, s1m: 0.693, s2m: 0.519, s5: 0.63, s6: 0.7 },
  '0.4': { m1: 6.75, vlin: 360.0, b: -3.28, c: 2.4, c4: 4.5, a1: 1.662, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.469, a7: 0.0, a8: -0.055, a10: 3.99, a11: 0.0, a12: -0.1, a13: 0.58, a14: -0.11, a15: 0.92, a17: -0.0043, a43: 0.1, a44: 0.07, a45: 0.06, a46: 0.06, a25: -0.0023, a28: 0.001, a29: -0.0048, a31: 0.2136, a36: 0.129, a37: 0.232, a38: 0.123, a39: 0.0, a40: 0.143, a41: -0.154, a42: -0.023, s1e: 0.699, s2e: 0.59, s3: 0.47, s4: 0.36, s1m: 0.644, s2m: 0.524, s5: 0.66, s6: 0.7 },
  '0.5': { m1: 6.75, vlin: 340.0, b: -3.6, c: 2.4, c4: 4.5, a1: 1.571, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.559, a7: 0.0, a8: -0.065, a10: 4.45, a11: 0.0, a12: -0.1, a13: 0.56, a14: -0.04, a15: 0.84, a17: -0.0032, a43: 0.1, a44: 0.1, a45: 0.1, a46: 0.09, a25: -0.002, a28: 0.0008, a29: -0.005, a31: 0.1542, a36: 0.31, a37: 0.252, a38: 0.134, a39: 0.0, a40: 0.16, a41: -0.159, a42: -0.029, s1e: 0.676, s2e: 0.6, s3: 0.47, s4: 0.36, s1m: 0.616, s2m: 0.532, s5: 0.69, s6: 0.7 },
  '0.75': { m1: 6.75, vlin: 330.0, b: -3.8, c: 2.4, c4: 4.5, a1: 1.299, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.682, a7: 0.0, a8: -0.095, a10: 4.75, a11: 0.0, a12: -0.1, a13: 0.53, a14: 0.07, a15: 0.68, a17: -0.0025, a43: 0.14, a44: 0.14, a45: 0.14, a46: 0.13, a25: -0.001, a28: 0.0007, a29: -0.0041, a31: 0.0787, a36: 0.505, a37: 0.208, a38: 0.129, a39: 0.0, a40: 0.158, a41: -0.141, a42: 0.061, s1e: 0.631, s2e: 0.615, s3: 0.47, s4: 0.36, s1m: 0.566, s2m: 0.548, s5: 0.73, s6: 0.69 },
  '1': { m1: 6.75, vlin: 330.0, b: -3.5, c: 2.4, c4: 4.5, a1: 1.043, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.763, a7: 0.0, a8: -0.11, a10: 4.3, a11: 0.0, a12: -0.1, a13: 0.5, a14: 0.15, a15: 0.57, a17: -0.0025, a43: 0.17, a44: 0.17, a45: 0.17, a46: 0.14, a25: -0.0005, a28: 0.0007, a29: -0.0032, a31: 0.0476, a36: 0.358, a37: 0.208, a38: 0.152, a39: 0.0, a40: 0.145, a41: -0.144, a42: 0.062, s1e: 0.609, s2e: 0.63, s3: 0.47, s4: 0.36, s1m: 0.541, s2m: 0.565, s5: 0.77, s6: 0.68 },
  '1.5': { m1: 6.75, vlin: 330.0, b: -2.4, c: 2.4, c4: 4.5, a1: 0.665, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.836, a7: 0.0, a8: -0.124, a10: 2.6, a11: 0.0, a12: -0.1, a13: 0.42, a14: 0.27, a15: 0.42, a17: -0.0022, a43: 0.22, a44: 0.21, a45: 0.2, a46: 0.16, a25: -0.0004, a28: 0.0006, a29: -0.002, a31: -0.0163, a36: 0.131, a37: 0.108, a38: 0.118, a39: 0.0, a40: 0.131, a41: -0.126, a42: 0.037, s1e: 0.578, s2e: 0.64, s3: 0.47, s4: 0.36, s1m: 0.506, s2m: 0.576, s5: 0.8, s6: 0.66 },
  '2': { m1: 6.75, vlin: 330.0, b: -1.0, c: 2.4, c4: 4.5, a1: 0.329, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.897, a7: 0.0, a8: -0.138, a10: 0.55, a11: 0.0, a12: -0.1, a13: 0.35, a14: 0.35, a15: 0.31, a17: -0.0019, a43: 0.26, a44: 0.25, a45: 0.22, a46: 0.16, a25: -0.0002, a28: 0.0003, a29: -0.0017, a31: -0.1203, a36: 0.123, a37: 0.068, a38: 0.119, a39: 0.0, a40: 0.083, a41: -0.075, a42: -0.143, s1e: 0.555, s2e: 0.65, s3: 0.47, s4: 0.36, s1m: 0.48, s2m: 0.587, s5: 0.8, s6: 0.62 },
  '3': { m1: 6.82, vlin: 330.0, b: 0.0, c: 2.4, c4: 4.5, a1: -0.06, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.906, a7: 0.0, a8: -0.172, a10: -0.95, a11: 0.0, a12: -0.1, a13: 0.2, a14: 0.46, a15: 0.16, a17: -0.0015, a43: 0.34, a44: 0.3, a45: 0.23, a46: 0.16, a25: 0.0, a28: 0.0, a29: -0.002, a31: -0.2719, a36: 0.109, a37: -0.023, a38: 0.093, a39: 0.0, a40: 0.07, a41: -0.021, a42: -0.028, s1e: 0.548, s2e: 0.64, s3: 0.47, s4: 0.36, s1m: 0.472, s2m: 0.576, s5: 0.8, s6: 0.55 },
  '4': { m1: 6.92, vlin: 330.0, b: 0.0, c: 2.4, c4: 4.5, a1: -0.299, a2: -0.79, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.889, a7: 0.0, a8: -0.197, a10: -0.95, a11: 0.0, a12: -0.1, a13: 0.0, a14: 0.54, a15: 0.05, a17: -0.001, a43: 0.41, a44: 0.32, a45: 0.23, a46: 0.14, a25: 0.0, a28: 0.0, a29: -0.002, a31: -0.2958, a36: 0.135, a37: 0.028, a38: 0.084, a39: 0.0, a40: 0.101, a41: 0.072, a42: -0.097, s1e: 0.527, s2e: 0.63, s3: 0.47, s4: 0.36, s1m: 0.447, s2m: 0.565, s5: 0.76, s6: 0.52 },
  '5': { m1: 7.0, vlin: 330.0, b: 0.0, c: 2.4, c4: 4.5, a1: -0.562, a2: -0.765, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.898, a7: 0.0, a8: -0.218, a10: -0.93, a11: 0.0, a12: -0.1, a13: 0.0, a14: 0.61, a15: -0.04, a17: -0.001, a43: 0.51, a44: 0.32, a45: 0.22, a46: 0.13, a25: 0.0, a28: 0.0, a29: -0.002, a31: -0.2718, a36: 0.189, a37: 0.031, a38: 0.058, a39: 0.0, a40: 0.095, a41: 0.205, a42: 0.015, s1e: 0.505, s2e: 0.63, s3: 0.47, s4: 0.36, s1m: 0.425, s2m: 0.568, s5: 0.72, s6: 0.5 },
  '6': { m1: 7.06, vlin: 330.0, b: 0.0, c: 2.4, c4: 4.5, a1: -0.875, a2: -0.711, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.896, a7: 0.0, a8: -0.235, a10: -0.91, a11: 0.0, a12: -0.2, a13: 0.0, a14: 0.65, a15: -0.11, a17: -0.001, a43: 0.55, a44: 0.32, a45: 0.2, a46: 0.1, a25: 0.0, a28: 0.0, a29: -0.002, a31: -0.2517, a36: 0.215, a37: 0.024, a38: 0.065, a39: 0.0, a40: 0.133, a41: 0.285, a42: 0.104, s1e: 0.477, s2e: 0.63, s3: 0.47, s4: 0.36, s1m: 0.395, s2m: 0.571, s5: 0.7, s6: 0.5 },
  '7.5': { m1: 7.15, vlin: 330.0, b: 0.0, c: 2.4, c4: 4.5, a1: -1.303, a2: -0.634, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.87, a7: 0.0, a8: -0.255, a10: -0.87, a11: 0.0, a12: -0.2, a13: 0.0, a14: 0.72, a15: -0.19, a17: -0.001, a43: 0.49, a44: 0.28, a45: 0.17, a46: 0.09, a25: 0.0, a28: 0.0, a29: -0.002, a31: -0.14, a36: 0.15, a37: -0.07, a38: 0.0, a39: 0.0, a40: 0.151, a41: 0.329, a42: 0.299, s1e: 0.457, s2e: 0.63, s3: 0.47, s4: 0.36, s1m: 0.378, s2m: 0.575, s5: 0.67, s6: 0.5 },
  '10': { m1: 7.25, vlin: 330.0, b: 0.0, c: 2.4, c4: 4.5, a1: -1.928, a2: -0.529, a3: 0.275, a4: -0.1, a5: -0.41, a6: 2.843, a7: 0.0, a8: -0.285, a10: -0.8, a11: 0.0, a12: -0.2, a13: 0.0, a14: 0.8, a15: -0.3, a17: -0.001, a43: 0.42, a44: 0.22, a45: 0.14, a46: 0.08, a25: 0.0, a28: 0.0, a29: -0.002, a31: -0.0216, a36: 0.092, a37: -0.159, a38: -0.05, a39: 0.0, a40: 0.124, a41: 0.301, a42: 0.243, s1e: 0.429, s2e: 0.63, s3: 0.47, s4: 0.36, s1m: 0.359, s2m: 0.585, s5: 0.64, s6: 0.5 },
};

Physics.ASK2014_SA_KEYS = ["0.01", "0.02", "0.03", "0.05", "0.075", "0.1", "0.15", "0.2", "0.25", "0.3", "0.4", "0.5", "0.75", "1", "1.5", "2", "3", "4", "5", "6", "7.5", "10"];

function _nw2SaKey(keys, T) {
  for (var i = 0; i < keys.length; i++) {
    if (Math.abs(parseFloat(keys[i]) - T) < 1e-12) return keys[i];
  }
  return null;
}
function _nw2SaBracket(keys, T) {
  var nums = keys.map(parseFloat);
  if (!(T > nums[0] && T < nums[nums.length - 1])) return null;
  for (var i = 0; i < nums.length - 1; i++) {
    if (T > nums[i] && T < nums[i + 1]) return { lo: keys[i], hi: keys[i + 1], tLo: nums[i], tHi: nums[i + 1] };
  }
  return null;
}
function _nw2LerpLn(lo, hi, br, T) {
  var w = (Math.log(T) - Math.log(br.tLo)) / (Math.log(br.tHi) - Math.log(br.tLo));
  return lo + w * (hi - lo);
}
function _nw2LerpSig(slo, shi, br, T) {
  var w = (Math.log(T) - Math.log(br.tLo)) / (Math.log(br.tHi) - Math.log(br.tLo));
  return { sigma: slo.sigma + w * (shi.sigma - slo.sigma), tau: slo.tau + w * (shi.tau - slo.tau), phi: slo.phi + w * (shi.phi - slo.phi) };
}

// ---------------- CY14 (Chiou & Youngs 2014) ----------------
// hazardlib get_ln_y_ref/get_magnitude_scaling/get_source_scaling_terms/
// get_geometric_spreading/get_far_field_distance_scaling(CAL)/
// get_hanging_wall_term + get_linear_site_term/get_nonlinear_site_term,
// one for one. delta_ztor centers ztor on the CY14 eqs. 4/5 mean.
function _cy2014CenteredZtor(mw, rake, ztor) {
  var rev = (rake >= 30 && rake <= 150);
  var meanZ = rev ? Math.pow(Math.max(2.704 - 1.226 * Math.max(mw - 5.849, 0), 0), 2)
                  : Math.pow(Math.max(2.673 - 1.136 * Math.max(mw - 4.970, 0), 0), 2);
  return ztor - meanZ;
}
function _cy2014LnRow(C, mw, rrup, rjb, rx, ztor, dipDeg, rake, vs30) {
  var K = Physics.CY2014_CONSTS;
  var coshm = Math.cosh(2 * Math.max(mw - 4.5, 0));
  var Frv = (rake >= 30 && rake <= 150) ? 1 : 0;
  var Fnm = (rake >= -120 && rake <= -60) ? 1 : 0;
  var dZtor = _cy2014CenteredZtor(mw, rake, ztor);
  var dipRad = dipDeg * Math.PI / 180;
  var cosDip2 = Math.pow(Math.cos(dipRad), 2);
  // magnitude scaling (delta_cm = 0)
  var fM = K.c2 * (mw - 6) + ((K.c2 - C.c3) / C.cn) * Math.log(1 + Math.exp(C.cn * (C.cm - mw)));
  // source scaling: style of faulting + top-of-rupture + dip (alpha_nm = 1)
  var fSrc = (C.c1a + C.c1c / coshm) * Frv + (C.c1b + C.c1d / coshm) * Fnm
    + (C.c7 + C.c7b / coshm) * dZtor
    + (K.c11 + C.c11b / coshm) * cosDip2;
  // near-field geometric spreading
  var fG = K.c4 * Math.log(rrup + C.c5 * Math.cosh(C.c6 * Math.max(mw - C.chm, 0)));
  // far-field distance scaling, region CAL (delta_g = 0)
  var gamma = C.cg1 + C.cg2 / Math.cosh(Math.max(mw - C.cg3, 0));
  var fRm = (K.c4a - K.c4) * Math.log(Math.sqrt(rrup * rrup + K.crb * K.crb)) + gamma * rrup;
  // hanging wall (use_hw = true); rx < 0 (footwall) contributes 0
  var fhw = 0;
  if (rx >= 0) {
    var fdist = 1 - Math.sqrt(rjb * rjb + ztor * ztor) / (rrup + 1);
    fdist *= C.c9a + (1 - C.c9a) * Math.tanh(rx / C.c9b);
    fhw = C.c9 * Math.cos(dipRad) * fdist;
  }
  // directivity 0 (no rcdpp); delta_c1 off; basin identically 0 (unmeasured)
  var lnYref = C.c1 + fM + fSrc + fG + fRm + fhw;
  var yRef = Math.exp(lnYref);
  // site (CAL branch): linear + nonlinear
  var fLin = C.phi1 * Math.min(Math.log(vs30 / K.refVs), 0);
  var fNlScale = C.phi2 * (Math.exp(C.phi3 * (Math.min(vs30, K.refVs) - 360)) - Math.exp(C.phi3 * (K.refVs - 360)));
  var fNl = fNlScale * Math.log((yRef + C.phi4) / C.phi4);
  return { mean: lnYref + fLin + fNl, yRef: yRef, fNlScale: fNlScale };
}
function _cy2014MeanPair(C, CP, period, mw, rrup, rjb, rx, ztor, dipDeg, rake, vs30) {
  var r = _cy2014LnRow(C, mw, rrup, rjb, rx, ztor, dipDeg, rake, vs30);
  var mean = r.mean;
  if (period != null && period <= 0.3) {
    // hazardlib compute(): predicted SA at T <= 0.3 s is raised to the PGA
    // mean when it falls below it (paper p.1144).
    var rp = _cy2014LnRow(CP, mw, rrup, rjb, rx, ztor, dipDeg, rake, vs30);
    if (mean < rp.mean) mean = rp.mean;
  }
  return { mean: mean, yRef: r.yRef, fNlScale: r.fNlScale };
}
function _cy2014SigmaRow(C, mw, vs30, row) {
  // get_stddevs/get_tau/get_phi: vs30measured = false -> sig3 column
  var nl0 = row.fNlScale * (row.yRef / (row.yRef + C.phi4));
  var mClip = Math.min(Math.max(mw - 5, 0), 1.5);
  var tau = C.tau1 + (C.tau2 - C.tau1) / 1.5 * mClip;
  var mdep = C.sig1 + (C.sig2 - C.sig1) * mClip / 1.5;
  var phi = mdep * Math.sqrt(C.sig3 + Math.pow(1 + nl0, 2));
  var sigma = Math.sqrt(Math.pow(1 + nl0, 2) * tau * tau + phi * phi);
  return { sigma: sigma, tau: Math.abs((1 + nl0) * tau), phi: phi };
}
function _cy2014Geom(g) {
  // rx passes through signed: rx < 0 is the footwall (hanging-wall term 0),
  // exactly the hazardlib get_hanging_wall_term gate.
  return { rrup: Math.max(0.1, g.rrup), rjb: Math.max(0, g.rjb), rx: g.rx,
           ztor: Math.max(0, g.ztor), dip: g.dip, rake: g.rake, vs30: g.vs30 };
}
/** Median ln ground motion. imt: 'pga' | 'pgv' | SA period key/number.
 *  geom: {rrup, rjb, rx, ztor, dip, rake, vs30} (km / deg / m/s). */
Physics.cy2014Ln = function(imt, mw, geom) {
  var g = _cy2014Geom(geom);
  var CP = Physics.CY2014_PAPER.pga;
  if (imt === 'pga' || imt === 'pgv') {
    return _cy2014MeanPair(Physics.CY2014_PAPER[imt], CP, null, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.vs30).mean;
  }
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _nw2SaKey(Physics.CY2014_SA_KEYS, T);
  if (key) return _cy2014MeanPair(Physics.CY2014_PAPER[key], CP, T, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.vs30).mean;
  var br = _nw2SaBracket(Physics.CY2014_SA_KEYS, T);
  if (!br) return null;
  var lo = _cy2014MeanPair(Physics.CY2014_PAPER[br.lo], CP, br.tLo, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.vs30).mean;
  var hi = _cy2014MeanPair(Physics.CY2014_PAPER[br.hi], CP, br.tHi, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.vs30).mean;
  return _nw2LerpLn(lo, hi, br, T);
};
Physics.cy2014SigmaLn = function(imt, mw, geom) {
  var g = _cy2014Geom(geom);
  var CP = Physics.CY2014_PAPER.pga;
  function rowSig(C, period) {
    var r = _cy2014LnRow(C, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.vs30);
    return _cy2014SigmaRow(C, mw, g.vs30, r);
  }
  if (imt === 'pga' || imt === 'pgv') return rowSig(Physics.CY2014_PAPER[imt], null);
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _nw2SaKey(Physics.CY2014_SA_KEYS, T);
  if (key) return rowSig(Physics.CY2014_PAPER[key], T);
  var br = _nw2SaBracket(Physics.CY2014_SA_KEYS, T);
  if (!br) return null;
  return _nw2LerpSig(rowSig(Physics.CY2014_PAPER[br.lo], br.tLo), rowSig(Physics.CY2014_PAPER[br.hi], br.tHi), br, T);
};
Physics.cy2014Sigma = function(imt, mw, geom) {
  var s = Physics.cy2014SigmaLn(imt, mw, geom);
  if (!s) return null;
  return { tau: s.tau / _LN10, phi: s.phi / _LN10, sigmaT: s.sigma / _LN10 };
};
Physics.CY2014_G_TO_GAL = 980.665;
Physics.pgaCy2014 = function(mw, geom) {
  var pgaGal = Math.exp(Physics.cy2014Ln('pga', mw, geom)) * Physics.CY2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(pgaGal / Physics.GMPE_PGA_SOFT_CAP);
};
Physics.pgvCy2014 = function(mw, geom) {
  var pgv = Math.exp(Physics.cy2014Ln('pgv', mw, geom));
  return Physics.GMPE_PGV_SOFT_CAP * Math.tanh(pgv / Physics.GMPE_PGV_SOFT_CAP);
};
Physics.saCy2014Gal = function(periodKey, mw, geom) {
  var lnA = Physics.cy2014Ln(periodKey, mw, geom);
  if (lnA == null) return null;
  var saGal = Math.exp(lnA) * Physics.CY2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(saGal / Physics.GMPE_PGA_SOFT_CAP);
};

// ---------------- CB14 (Campbell & Bozorgnia 2014) ----------------
// hazardlib _get_magnitude_term/_get_geometric_attenuation_term/
// _get_style_of_faulting_term/_get_hanging_wall_term(Eqs. 7-16)/
// _get_shallow_site_response_term(SJ=false)/_get_basin_term(default CA)/
// _get_hypocentral_depth_term/_get_fault_dip_term/
// _get_anelastic_attenuation_term + compute_sigma, one for one.
// width/hypo_depth estimates (used when the caller carries neither — the
// paper's own Eqs. 39 / 35-37; zbot default = CB2014_CONSTS.zbotKm):
Physics.cb2014EstWidthKm = function(mw, dipDeg, ztorKm) {
  var w = Math.sqrt(Math.pow(10, (mw - 4.07) / 0.98));
  var sinDip = Math.abs(Math.sin(dipDeg * Math.PI / 180));
  if (sinDip > 0) w = Math.min(w, (Physics.CB2014_CONSTS.zbotKm - ztorKm) / sinDip);
  return Math.max(w, 0.1);
};
Physics.cb2014EstHypoDepthKm = function(mw, dipDeg, ztorKm, widthKm) {
  var fdzM = mw < 6.75 ? -4.317 + 0.984 * mw : 2.325;
  var fdzD = dipDeg <= 40 ? 0.0445 * (dipDeg - 40) : 0;
  var zbor = ztorKm + widthKm * Math.sin(dipDeg * Math.PI / 180);
  var dz = 0;
  if (zbor > ztorKm) dz = Math.exp(Math.min(fdzM + fdzD, Math.log(0.9 * (zbor - ztorKm))));
  return ztorKm + dz;
};
function _cb2014MagTerm(C, mag) {
  var f = C.c0 + C.c1 * mag;
  if (mag > 4.5 && mag <= 5.5) f += C.c2 * (mag - 4.5);
  else if (mag > 5.5 && mag <= 6.5) f += C.c2 * (mag - 4.5) + C.c3 * (mag - 5.5);
  else if (mag > 6.5) f += C.c2 * (mag - 4.5) + C.c3 * (mag - 5.5) + C.c4 * (mag - 6.5);
  return f;
}
function _cb2014Sof(C, mag, rake) {
  var frv = (rake > 30 && rake < 150) ? 1 : 0;
  var fnm = (rake > -150 && rake < -30) ? 1 : 0;
  var m = mag <= 4.5 ? 0 : (mag > 5.5 ? 1 : mag - 4.5);
  return (C.c8 * frv + C.c9 * fnm) * m;
}
function _cb2014HwRx(C, rx, width, dipDeg, mag) {
  var K = Physics.CB2014_CONSTS;
  var r1 = width * Math.cos(dipDeg * Math.PI / 180);
  var r2 = 62 * mag - 350;
  if (rx >= 0 && rx < r1) {
    var xr = rx / r1;
    return C.h1 + C.h2 * xr + C.h3 * xr * xr;
  }
  if (rx >= r1) {
    var drx = (rx - r1) / (r2 - r1);
    return Math.max(K.h4 + C.h5 * drx + C.h6 * drx * drx, 0);
  }
  return 0;
}
function _cb2014Hw(C, mw, rrup, rjb, rx, ztor, dipDeg, width) {
  var fRx = _cb2014HwRx(C, rx, width, dipDeg, mw);
  var fRrup = rrup > 0 ? (rrup - rjb) / rrup : 1;
  var fMag = (mw - 5.5) * (1 + C.a2 * (mw - 6.5));
  if (mw < 5.5) fMag = 0;
  if (mw > 6.5) fMag = 1 + C.a2 * (mw - 6.5);
  var fZtor = ztor > 16.66 ? 0 : 1 - 0.06 * ztor;
  var fDip = (90 - dipDeg) / 45;
  return C.c10 * fRx * fRrup * fMag * fZtor * fDip;
}
function _cb2014Site(C, vs30, pgaRock) {
  // SJ = false; site model path (a1100 array). pgaRock = exp(mean PGA at
  // Vs30 1100); for the rock reference itself pgaRock is unused because
  // 1100 > k1 on the pga row (the nonlinear branch is never taken there).
  var K = Physics.CB2014_CONSTS;
  var vsMod = vs30 / C.k1;
  var f = C.c11 * Math.log(vsMod);
  if (vs30 > C.k1) f += C.k2 * K.n * Math.log(vsMod);
  else f += C.k2 * (Math.log(pgaRock + K.c * Math.pow(vsMod, K.n)) - Math.log(pgaRock + K.c));
  return f;
}
function _cb2014Basin(C, vs30) {
  // default (unmeasured) z2pt5 = the paper's California relation (Eq. 33)
  var z = Math.exp(7.089 - 1.144 * Math.log(vs30));
  if (z < 1) return C.c14 * (z - 1); // SJ = false -> c15 * SJ = 0
  if (z > 3) return C.c16 * C.k3 * Math.exp(-0.75) * (1 - Math.exp(-0.25 * (z - 3)));
  return 0;
}
function _cb2014LnRow(C, mw, rrup, rjb, rx, ztor, dipDeg, rake, widthKm, hypoDepthKm, vs30, pgaRock, useSiteVs30) {
  var fMag = _cb2014MagTerm(C, mw);
  var fGeom = (C.c5 + C.c6 * mw) * Math.log(Math.sqrt(rrup * rrup + C.c7 * C.c7));
  var fFlt = _cb2014Sof(C, mw, rake);
  var fHw = _cb2014Hw(C, mw, rrup, rjb, rx, ztor, dipDeg, widthKm);
  var fSite = _cb2014Site(C, useSiteVs30 ? vs30 : 1100, pgaRock);
  var fBasin = _cb2014Basin(C, useSiteVs30 ? vs30 : 1100);
  var hClip = Math.min(Math.max(hypoDepthKm - 7, 0), 13);
  var fHypM = mw <= 5.5 ? C.c17 : (mw > 6.5 ? C.c18 : C.c17 + (C.c18 - C.c17) * (mw - 5.5));
  var fHyp = hClip * fHypM;
  var fDip = 0;
  if (mw < 4.5) fDip = C.c19 * dipDeg;
  else if (mw <= 5.5) fDip = C.c19 * (5.5 - mw) * dipDeg;
  var fAtn = rrup >= 80 ? (C.c20 + C.Dc20) * (rrup - 80) : 0;
  return fMag + fGeom + fFlt + fHw + fSite + fBasin + fHyp + fDip + fAtn;
}
function _cb2014Pga1100(CP, mw, rrup, rjb, rx, ztor, dipDeg, rake, widthKm, hypoDepthKm) {
  // mean PGA on the rock reference (Vs30 = 1100, basin at z_ref(1100))
  return Math.exp(_cb2014LnRow(CP, mw, rrup, rjb, rx, ztor, dipDeg, rake, widthKm, hypoDepthKm, 1100, null, false));
}
function _cb2014MeanPair(C, CP, period, mw, g) {
  var pga1100 = _cb2014Pga1100(CP, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.widthKm, g.hypoDepthKm);
  var mean = _cb2014LnRow(C, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.widthKm, g.hypoDepthKm, g.vs30, pga1100, true);
  if (period != null && period < 0.25) {
    // hazardlib compute(): SA at T < 0.25 s raised to the soil PGA when lower
    var pgaSoil = _cb2014LnRow(CP, mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.widthKm, g.hypoDepthKm, g.vs30, pga1100, true);
    if (mean <= pgaSoil) mean = pgaSoil;
  }
  return { mean: mean, pga1100: pga1100 };
}
function _cb2014TauLnY(C, mag) {
  if (mag <= 4.5) return C.tau1;
  if (mag >= 5.5) return C.tau2;
  return C.tau2 + (C.tau1 - C.tau2) * (5.5 - mag);
}
function _cb2014PhiLnY(C, mag) {
  if (mag <= 4.5) return C.phi1;
  if (mag >= 5.5) return C.phi2;
  return C.phi2 + (C.phi1 - C.phi2) * (5.5 - mag);
}
function _cb2014Alpha(C, vs30, pgaRock) {
  var K = Physics.CB2014_CONSTS;
  if (!(vs30 < C.k1)) return 0;
  var vsk1 = vs30 / C.k1;
  return C.k2 * pgaRock * (1 / (pgaRock + K.c * Math.pow(vsk1, K.n)) - 1 / (pgaRock + K.c));
}
function _cb2014SigmaRow(C, CP, mw, vs30, pga1100) {
  // compute_sigma (CB14 supplementary-spreadsheet form; imt is never CAV/IA)
  var tauB = _cb2014TauLnY(C, mw);
  var phiLnyB = Math.sqrt(Math.pow(_cb2014PhiLnY(C, mw), 2) - Math.pow(C.philnAF, 2));
  var alpha = _cb2014Alpha(C, vs30, pga1100);
  var tauPgaB = _cb2014TauLnY(CP, mw);
  var phiLnpgaB = Math.sqrt(Math.pow(_cb2014PhiLnY(CP, mw), 2) - Math.pow(CP.philnAF, 2));
  var rho = C.rholny;
  var t = Math.sqrt(tauB * tauB + alpha * alpha * tauPgaB * tauPgaB + 2 * alpha * rho * tauB * tauPgaB);
  var p = Math.sqrt(phiLnyB * phiLnyB + C.philnAF * C.philnAF + alpha * alpha * phiLnpgaB * phiLnpgaB + 2 * alpha * rho * phiLnyB * phiLnpgaB);
  return { sigma: Math.sqrt(t * t + p * p), tau: t, phi: p };
}
function _cb2014Geom(g) {
  var ztor = Math.max(0, g.ztor);
  var dip = g.dip;
  var width = g.widthKm != null ? g.widthKm : Physics.cb2014EstWidthKm(g.mw, dip, ztor);
  var hypo = g.hypoDepthKm != null ? g.hypoDepthKm : Physics.cb2014EstHypoDepthKm(g.mw, dip, ztor, width);
  return { mw: g.mw, rrup: Math.max(0.1, g.rrup), rjb: Math.max(0, g.rjb), rx: g.rx,
           ztor: ztor, dip: dip, rake: g.rake, widthKm: width, hypoDepthKm: hypo, vs30: g.vs30 };
}
/** Median ln ground motion (g for pga/SA, cm/s for pgv). geom: {mw, rrup,
 *  rjb, rx, ztor, dip, rake, vs30, widthKm?, hypoDepthKm?} — width/hypoDepth
 *  default to the paper's estimators (documented zbot 20 km). */
Physics.cb2014Ln = function(imt, geom) {
  var g = _cb2014Geom(geom);
  var CP = Physics.CB2014_PAPER.pga;
  if (imt === 'pga' || imt === 'pgv') return _cb2014MeanPair(Physics.CB2014_PAPER[imt], CP, null, g.mw, g).mean;
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _nw2SaKey(Physics.CB2014_SA_KEYS, T);
  if (key) return _cb2014MeanPair(Physics.CB2014_PAPER[key], CP, T, g.mw, g).mean;
  var br = _nw2SaBracket(Physics.CB2014_SA_KEYS, T);
  if (!br) return null;
  var lo = _cb2014MeanPair(Physics.CB2014_PAPER[br.lo], CP, br.tLo, g.mw, g).mean;
  var hi = _cb2014MeanPair(Physics.CB2014_PAPER[br.hi], CP, br.tHi, g.mw, g).mean;
  return _nw2LerpLn(lo, hi, br, T);
};
Physics.cb2014SigmaLn = function(imt, geom) {
  var g = _cb2014Geom(geom);
  var CP = Physics.CB2014_PAPER.pga;
  var pga1100 = _cb2014Pga1100(CP, g.mw, g.rrup, g.rjb, g.rx, g.ztor, g.dip, g.rake, g.widthKm, g.hypoDepthKm);
  if (imt === 'pga' || imt === 'pgv') return _cb2014SigmaRow(Physics.CB2014_PAPER[imt], CP, g.mw, g.vs30, pga1100);
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _nw2SaKey(Physics.CB2014_SA_KEYS, T);
  if (key) return _cb2014SigmaRow(Physics.CB2014_PAPER[key], CP, g.mw, g.vs30, pga1100);
  var br = _nw2SaBracket(Physics.CB2014_SA_KEYS, T);
  if (!br) return null;
  return _nw2LerpSig(_cb2014SigmaRow(Physics.CB2014_PAPER[br.lo], CP, g.mw, g.vs30, pga1100),
                     _cb2014SigmaRow(Physics.CB2014_PAPER[br.hi], CP, g.mw, g.vs30, pga1100), br, T);
};
Physics.cb2014Sigma = function(imt, geom) {
  var s = Physics.cb2014SigmaLn(imt, geom);
  if (!s) return null;
  return { tau: s.tau / _LN10, phi: s.phi / _LN10, sigmaT: s.sigma / _LN10 };
};
Physics.CB2014_G_TO_GAL = 980.665;
Physics.pgaCb2014 = function(geom) {
  var pgaGal = Math.exp(Physics.cb2014Ln('pga', geom)) * Physics.CB2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(pgaGal / Physics.GMPE_PGA_SOFT_CAP);
};
Physics.pgvCb2014 = function(geom) {
  var pgv = Math.exp(Physics.cb2014Ln('pgv', geom));
  return Physics.GMPE_PGV_SOFT_CAP * Math.tanh(pgv / Physics.GMPE_PGV_SOFT_CAP);
};
Physics.saCb2014Gal = function(periodKey, geom) {
  var lnA = Physics.cb2014Ln(periodKey, geom);
  if (lnA == null) return null;
  var saGal = Math.exp(lnA) * Physics.CB2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(saGal / Physics.GMPE_PGA_SOFT_CAP);
};

// ---------------- ASK14 (Abrahamson, Silva & Kamai 2014) ----------------
// hazardlib _get_basic_term/_get_faulting_style_term/_get_hanging_wall_term
// (tapers 1-5)/_get_top_of_rupture_depth_term/_get_site_response_term/
// _get_basin_term (unmeasured default = identically 0)/_get_regional_term
// (None = 0) + _get_stddevs, one for one; region = None (California base).
// No aftershock term (mainshock use). Width: ASK14 publishes no width
// relation — the engine's Wells & Coppersmith crustal width is the
// documented point-source default (widthKm override supported).
function _ask2014V1(period) {
  // eq. 9 (p. 1034): period-dependent v1 for the vs30star cap
  if (period == null) return 1500; // pga & pgv
  if (period <= 0.5) return 1500;
  if (period < 3) return Math.exp(-0.35 * Math.log(period / 0.5) + Math.log(1500));
  return 800;
}
function _ask2014Basic(C, mag, rrup) {
  var K = Physics.ASK2014_CONSTS;
  var c4m = C.c4 - (C.c4 - 1) * (5 - mag);
  if (mag > 5) c4m = C.c4;
  if (mag < 4) c4m = 1;
  var R = Math.sqrt(rrup * rrup + c4m * c4m);
  var base = C.a1 + C.a17 * rrup;
  if (mag >= C.m1) {
    base += C.a5 * (mag - C.m1) + C.a8 * Math.pow(8.5 - mag, 2) + (C.a2 + C.a3 * (mag - C.m1)) * Math.log(R);
  } else if (mag >= K.m2) {
    base += C.a4 * (mag - C.m1) + C.a8 * Math.pow(8.5 - mag, 2) + (C.a2 + C.a3 * (mag - C.m1)) * Math.log(R);
  } else {
    base += C.a4 * (K.m2 - C.m1) + C.a8 * Math.pow(8.5 - K.m2, 2) + C.a6 * (mag - K.m2) + C.a7 * Math.pow(mag - K.m2, 2) + (C.a2 + C.a3 * (K.m2 - C.m1)) * Math.log(R);
  }
  return base;
}
function _ask2014FaultStyle(C, mag, rake) {
  var f7 = C.a11 * Math.min(Math.max(mag - 4, 0), 1);
  var f8 = C.a12 * Math.min(Math.max(mag - 4, 0), 1);
  return f7 * ((rake > 30 && rake < 150) ? 1 : 0) + f8 * ((rake > -150 && rake < -30) ? 1 : 0);
}
function _ask2014Hw(C, mag, rx, ry0, ztor, dipDeg, widthKm) {
  if (!(rx > 0)) return 0;
  if (dipDeg === 90) return 0;
  var K = Physics.ASK2014_CONSTS;
  var T1 = (90 - dipDeg) / 45;
  if (dipDeg <= 30) T1 = 60 / 45;
  var T2 = 1 + 0.2 * (mag - 6.5) - (1 - 0.2) * Math.pow(mag - 6.5, 2);
  if (mag > 6.5) T2 = 1 + 0.2 * (mag - 6.5);
  if (mag <= 5.5) T2 = 0;
  var dipRad = dipDeg * Math.PI / 180;
  var r1 = widthKm * Math.cos(dipRad);
  var r2 = 3 * r1;
  var T3 = 0;
  if (rx < r1) T3 = K.h1 + K.h2 * (rx / r1) + K.h3 * Math.pow(rx / r1, 2);
  else if (rx <= r2) T3 = 1 - (rx - r1) / (r2 - r1);
  var T4 = ztor <= 10 ? 1 - ztor * ztor / 100 : 0;
  var ry1 = rx * Math.tan(20 * Math.PI / 180);
  var dRy = ry0 - ry1;
  var T5 = 0;
  if (dRy <= 0) T5 = 1;
  else if (dRy < 5) T5 = 1 - dRy / 5;
  return C.a13 * T1 * T2 * T3 * T4 * T5;
}
function _ask2014Site(C, period, vs30, sa1180) {
  var K = Physics.ASK2014_CONSTS;
  var v1 = _ask2014V1(period);
  var vs30star = Math.min(vs30, v1);
  var rat = vs30star / C.vlin;
  if (vs30 >= C.vlin) return (C.a10 + C.b * K.n) * Math.log(rat);
  return C.a10 * Math.log(rat) - C.b * Math.log(sa1180 + C.c) + C.b * Math.log(sa1180 + C.c * Math.pow(rat, K.n));
}
function _ask2014Basin(vs30) {
  // unmeasured z1pt0 -> z10 = z1ref(vs30) -> factor = ln(1) = 0 (region None
  // relation, eq. 18); carried explicitly so the identity is auditable
  var z1ref = Math.exp((-7.67 / 4) * Math.log((Math.pow(vs30, 4) + Math.pow(610, 4)) / (Math.pow(1360, 4) + Math.pow(610, 4)))) / 1000;
  var factor = Math.log((z1ref + 0.01) / (z1ref + 0.01));
  return 0 * factor; // f2(vs30) * factor + adj(0); f2 irrelevant at factor 0
}
function _ask2014LnRow(C, period, mw, rrup, rx, ry0, ztor, dipDeg, rake, widthKm, vs30, sa1180, rockRef) {
  // rockRef: evaluate at Vs30 = 1180 with reference shaking 0 (the sa1180
  // construction of _get_sa_at_1180) — basin term stays 0 there as well.
  var v = rockRef ? 1180 : vs30;
  var sa = rockRef ? 0 : sa1180;
  return _ask2014Basic(C, mw, rrup)
    + _ask2014Hw(C, mw, rx, ry0, ztor, dipDeg, widthKm)
    + _ask2014Site(C, period, v, sa)
    + C.a15 * Math.min(ztor / 20, 1)
    + _ask2014FaultStyle(C, mw, rake)
    + 0 // aftershock f11: off (mainshock use)
    + _ask2014Basin(v)
    + 0; // regional term: None (California base)
}
function _ask2014MeanPair(C, period, mw, g) {
  var sa1180 = Math.exp(_ask2014LnRow(C, period, mw, g.rrup, g.rx, g.ry0, g.ztor, g.dip, g.rake, g.widthKm, 1180, null, true));
  return { mean: _ask2014LnRow(C, period, mw, g.rrup, g.rx, g.ry0, g.ztor, g.dip, g.rake, g.widthKm, g.vs30, sa1180, false), sa1180: sa1180 };
}
function _ask2014SigmaRow(C, period, mw, rrup, vs30, sa1180) {
  // vs30measured = false -> estimated pair s1e/s2e (regional grids)
  var phiAl = C.s1e + (C.s2e - C.s1e) / 2 * (mw - 4);
  if (mw < 4) phiAl = C.s1e;
  if (mw >= 6) phiAl = C.s2e;
  var tauAl = C.s3 + (C.s4 - C.s3) / 2 * (mw - 5);
  if (mw < 5) tauAl = C.s3;
  if (mw >= 7) tauAl = C.s4;
  var K = Physics.ASK2014_CONSTS;
  var derAmp = 0;
  if (vs30 < C.vlin) derAmp = C.b * sa1180 * (-1 / (sa1180 + C.c) + 1 / (sa1180 + C.c * Math.pow(vs30 / C.vlin, K.n)));
  var phiAmp = 0.4;
  if (phiAl < phiAmp) phiAmp = 0.99 * phiAl;
  var phiB = Math.sqrt(phiAl * phiAl - phiAmp * phiAmp);
  var phi = Math.sqrt(phiB * phiB * Math.pow(1 + derAmp, 2) + phiAmp * phiAmp);
  var tau = tauAl * (1 + derAmp);
  return { sigma: Math.sqrt(phi * phi + tau * tau), tau: tau, phi: phi };
}
function _ask2014Geom(g) {
  return { mw: g.mw, rrup: Math.max(0.1, g.rrup), rx: g.rx, ry0: Math.max(0, g.ry0 || 0),
           ztor: Math.max(0, g.ztor), dip: g.dip, rake: g.rake,
           widthKm: g.widthKm != null ? g.widthKm : Physics.faultDimensions(g.mw, 'crustal').W,
           vs30: g.vs30 };
}
/** Median ln ground motion (g for pga/SA, cm/s for pgv). geom: {mw, rrup,
 *  rx, ry0, ztor, dip, rake, vs30, widthKm?} — width defaults to the
 *  engine's W&C crustal width (ASK14 publishes none; documented). */
Physics.ask2014Ln = function(imt, geom) {
  var g = _ask2014Geom(geom);
  if (imt === 'pga' || imt === 'pgv') return _ask2014MeanPair(Physics.ASK2014_PAPER[imt], null, g.mw, g).mean;
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _nw2SaKey(Physics.ASK2014_SA_KEYS, T);
  if (key) return _ask2014MeanPair(Physics.ASK2014_PAPER[key], T, g.mw, g).mean;
  var br = _nw2SaBracket(Physics.ASK2014_SA_KEYS, T);
  if (!br) return null;
  var lo = _ask2014MeanPair(Physics.ASK2014_PAPER[br.lo], br.tLo, g.mw, g).mean;
  var hi = _ask2014MeanPair(Physics.ASK2014_PAPER[br.hi], br.tHi, g.mw, g).mean;
  return _nw2LerpLn(lo, hi, br, T);
};
Physics.ask2014SigmaLn = function(imt, geom) {
  var g = _ask2014Geom(geom);
  function rowSig(C, period) {
    var sa1180 = Math.exp(_ask2014LnRow(C, period, g.mw, g.rrup, g.rx, g.ry0, g.ztor, g.dip, g.rake, g.widthKm, 1180, null, true));
    return _ask2014SigmaRow(C, period, g.mw, g.rrup, g.vs30, sa1180);
  }
  if (imt === 'pga' || imt === 'pgv') return rowSig(Physics.ASK2014_PAPER[imt], null);
  var T = parseFloat(imt);
  if (!isFinite(T)) return null;
  var key = _nw2SaKey(Physics.ASK2014_SA_KEYS, T);
  if (key) return rowSig(Physics.ASK2014_PAPER[key], T);
  var br = _nw2SaBracket(Physics.ASK2014_SA_KEYS, T);
  if (!br) return null;
  return _nw2LerpSig(rowSig(Physics.ASK2014_PAPER[br.lo], br.tLo), rowSig(Physics.ASK2014_PAPER[br.hi], br.tHi), br, T);
};
Physics.ask2014Sigma = function(imt, geom) {
  var s = Physics.ask2014SigmaLn(imt, geom);
  if (!s) return null;
  return { tau: s.tau / _LN10, phi: s.phi / _LN10, sigmaT: s.sigma / _LN10 };
};
Physics.ASK2014_G_TO_GAL = 980.665;
Physics.pgaAsk2014 = function(geom) {
  var pgaGal = Math.exp(Physics.ask2014Ln('pga', geom)) * Physics.ASK2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(pgaGal / Physics.GMPE_PGA_SOFT_CAP);
};
Physics.pgvAsk2014 = function(geom) {
  var pgv = Math.exp(Physics.ask2014Ln('pgv', geom));
  return Physics.GMPE_PGV_SOFT_CAP * Math.tanh(pgv / Physics.GMPE_PGV_SOFT_CAP);
};
Physics.saAsk2014Gal = function(periodKey, geom) {
  var lnA = Physics.ask2014Ln(periodKey, geom);
  if (lnA == null) return null;
  var saGal = Math.exp(lnA) * Physics.ASK2014_G_TO_GAL;
  return Physics.GMPE_PGA_SOFT_CAP * Math.tanh(saGal / Physics.GMPE_PGA_SOFT_CAP);
};

/** Shared point-source geometry for the NGA-West2 CY14/CB14/ASK14 family
 *  (documented on the model block): the caller distance reads as Rjb, Rrup
 *  derives geometrically from the source depth as ztor, Rx = Rjb (hanging-
 *  wall side), Ry0 = 0, dip defaults to the crustal prior 60 deg. */
Physics.nw2PointGeom = function(mw, rjbKm, depthKm, vs30, rake, dipDeg) {
  var rjb = Math.max(0.1, Number(rjbKm) || 0.1);
  var ztor = Math.max(0.1, Number(depthKm) || 10);
  var rrup = Math.sqrt(rjb * rjb + ztor * ztor);
  return { mw: mw, rrup: rrup, rjb: rjb, rx: rjb, ry0: 0, ztor: ztor,
           dip: dipDeg != null ? dipDeg : 60, rake: rake != null ? rake : 0,
           vs30: vs30 || 400 };
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

// ================================================================
//  JIVSM LAYERED VELOCITY-COLUMN REGISTRY + COMPOSED TRAVEL PATH (v5.7 R3)
// ================================================================
// Registry from public/geojson/jivsm-columns.json (built by
// tools/build-jivsm-columns.js from the J-SHIS JIVSM V4 LYRD archive,
// dstrct-API verified): a 0.125° national grid of distinct-layer bottoms on
// the 32-unit PYS velocity ladder. Null registry = legacy IASP91-only travel
// times (byte-compatible path).
Physics.JIVSM_COLUMNS = null;
// A/B switch for the station-column travel path. null = follow the runtime
// config (travelModel === 'jivsm'); tests set it explicitly.
Physics.JIVSM_TRAVEL_ON = null;

Physics.setJivsmColumns = function(doc) {
  var ok = !!(doc && doc.schema === 'quake-sim-jivsm-columns-v1' && doc.data &&
    doc.pys && doc.pys.length === 32 && doc.origin && isFinite(doc.res) && doc.res > 0 &&
    doc.nx > 0 && doc.ny > 0);
  Physics.JIVSM_COLUMNS = ok ? doc : null;
  return ok;
};

// Column at the nearest grid cell (structure is discrete — no interpolation):
// [{stn, topM, bottomM, vp, vs, rho}] from the surface down to the deepest
// defined JIVSM boundary, or null outside coverage. Below that boundary the
// model saturates; consumers splice the regional model (travel time: IASP91).
Physics.jivsmColumnAt = function(lat, lng) {
  var doc = Physics.JIVSM_COLUMNS;
  if (!doc) return null;
  var x = Math.floor((lng - doc.origin[0]) / doc.res);
  var y = Math.floor((lat - doc.origin[1]) / doc.res);
  if (x < 0 || x >= doc.nx || y < 0 || y >= doc.ny) return null;
  var flat = doc.data[y * doc.nx + x];
  if (!flat || !flat.length) return null;
  var col = [], top = 0;
  for (var i = 0; i + 1 < flat.length; i += 2) {
    var stn = flat[i], bottom = flat[i + 1];
    if (!(stn >= 1 && stn <= 32) || !(bottom > top)) return null;
    var pys = doc.pys[stn - 1];
    col.push({ stn: stn, topM: top, bottomM: bottom, vp: pys[0], vs: pys[1], rho: pys[2] });
    top = bottom;
  }
  return col.length ? col : null;
};

// Composed 1-D segment list [[topKm, bottomKm, v km/s]] — the JIVSM station
// column (its own Vp/Vs, unscaled) down to its deepest boundary, then the
// IASP91 continuation (scaled by surfaceVelocity exactly like the legacy
// stack so the knob keeps its meaning below the column).
Physics.composedTravelSegments = function(col, phase, velocityScale) {
  if (!col || !col.length) return null;
  var vcol = phase === 'S' ? 'vs' : 'vp', viasp = phase === 'S' ? 2 : 1;
  var segs = [], colBottom = col[col.length - 1].bottomM / 1000;
  for (var i = 0; i < col.length; i++) {
    var top = col[i].topM / 1000, bot = col[i].bottomM / 1000;
    var v = col[i][vcol] / 1000;
    if (!(v > 0) || !(bot > top)) return null;
    segs.push([top, bot, v]);
  }
  for (var r = 0; r < Physics.IASP91.length; r++) {
    var rTop = Physics.IASP91[r][0];
    var rBot = r + 1 < Physics.IASP91.length ? Physics.IASP91[r + 1][0] : Infinity;
    if (rBot <= colBottom) continue;
    var segTop = Math.max(rTop, colBottom);
    if (rBot > segTop) segs.push([segTop, rBot, Physics.IASP91[r][viasp] * velocityScale]);
  }
  return segs.length ? segs : null;
};

// First-arrival travel time through an arbitrary piecewise-constant segment
// stack [[topKm, bottomKm|Infinity, v km/s]]: direct-ray bisection on the
// ray parameter plus a head wave on the fastest below-source medium — the
// same machinery as layeredTravelTime, which delegates here for the composed
// JIVSM+IASP91 path (station-side basin statics fall out of the 1-D Snell
// integral: near-vertical slow-fill crossings become fixed far-station
// delays, near stations get the full delayed direct ray).
Physics.segmentsTravelTime = function(horizontalKm, depthKm, segs) {
  var layers = [], maxV = 0, i;
  for (i = 0; i < segs.length; i++) {
    if (segs[i][0] >= depthKm) break;
    var bot = Math.min(segs[i][1], depthKm);
    if (bot > segs[i][0]) {
      layers.push([bot - segs[i][0], segs[i][2]]);
      if (segs[i][2] > maxV) maxV = segs[i][2];
    }
  }
  var refractorV = 0, belowLayers = [];
  for (i = 0; i < segs.length; i++) {
    if (segs[i][1] <= depthKm) continue;
    var startB = Math.max(segs[i][0], depthKm);
    var hB = (segs[i][1] === Infinity ? startB : segs[i][1]) - startB;
    if (!(hB > 0)) continue;
    belowLayers.push([hB, segs[i][2]]);
    if (segs[i][2] > refractorV) refractorV = segs[i][2];
  }
  function offset(p){var x=0;for(var j=0;j<layers.length;j++){var pv=Math.min(0.999999,p*layers[j][1]);x+=layers[j][0]*pv/Math.sqrt(1-pv*pv);}return x;}
  function directTime(p){var t=0;for(var j=0;j<layers.length;j++){var pv=Math.min(0.999999,p*layers[j][1]);t+=layers[j][0]/(layers[j][1]*Math.sqrt(1-pv*pv));}return t;}
  var headTime=Infinity;
  if(refractorV>maxV){
    var delay=0,jb;
    for(jb=0;jb<belowLayers.length;jb++){
      if(belowLayers[jb][1]>=refractorV)break;
      var vr=belowLayers[jb][1];var cosc=Math.sqrt(Math.max(0,1-(vr/refractorV)*(vr/refractorV)));
      delay+=belowLayers[jb][0]*cosc/vr;
    }
    for(jb=0;jb<layers.length;jb++){
      if(layers[jb][1]>=refractorV)break;
      var vu=layers[jb][1];var cosu=Math.sqrt(Math.max(0,1-(vu/refractorV)*(vu/refractorV)));
      delay+=layers[jb][0]*cosu/vu;
    }
    headTime=horizontalKm/refractorV+delay;
  }
  var lo=0,hi=0.999999/maxV;
  if(offset(hi)<horizontalKm){
    return headTime===Infinity?directTime(hi):headTime;
  }
  for(var it=0;it<70;it++){var mid=(lo+hi)/2;if(offset(mid)<horizontalKm)lo=mid;else hi=mid;}
  var time=directTime((lo+hi)/2);
  return Math.min(time,headTime);
};

/** Direct upgoing ray through the layered 1-D velocity model (Snell's law). */
Physics.layeredTravelTime = function(horizontalKm, depthKm, phase, surfaceVelocity, stationLat, stationLng) {
  horizontalKm=Math.max(0,Number(horizontalKm)||0);depthKm=Math.max(0,Number(depthKm)||0);
  var col=phase==='S'?2:1,baseSurface=Physics.IASP91[0][col];
  var velocityScale=surfaceVelocity>0?Number(surfaceVelocity)/baseSurface:1;
  if(depthKm<=0)return horizontalKm/(baseSurface*velocityScale);
  // v5.7 R3-2: station-column path (JIVSM registry + travelModel 'jivsm').
  // Absent registry/column/coords the legacy IASP91 stack below is untouched.
  if(stationLat!=null&&stationLng!=null&&
     (Physics.JIVSM_TRAVEL_ON===true||
      (Physics.JIVSM_TRAVEL_ON==null&&typeof cfgGet==='function'&&cfgGet('travelModel')==='jivsm'))){
    var jcol=Physics.jivsmColumnAt(stationLat,stationLng);
    var jsegs=jcol?Physics.composedTravelSegments(jcol,phase,velocityScale):null;
    if(jsegs)return Physics.segmentsTravelTime(horizontalKm,depthKm,jsegs);
  }
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

Physics.pTravelTime = function(horizontalKm, depthKm, surfaceVelocity, stationLat, stationLng) { return Physics.layeredTravelTime(horizontalKm,depthKm,'P',surfaceVelocity,stationLat,stationLng); };
Physics.sTravelTime = function(horizontalKm, depthKm, surfaceVelocity, stationLat, stationLng) { return Physics.layeredTravelTime(horizontalKm,depthKm,'S',surfaceVelocity,stationLat,stationLng); };

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
//  PSHA HAZARD INTEGRATION (v6.1 P1, 2026-09-01)
//  Poisson hazard curve for a site from a gridded GR source model
//  (quake-sim-psha-source-v1, tools/build-psha-source-model.js) plus
//  scenario sources. Medians come from the SAME three GMPE families the
//  simulation path uses, weighted per tectonic class by the frozen LLH
//  logic tree (GMPE_LOGIC_TREE) — modelBias is deliberately NOT applied
//  (LOEO evidence in tools/data/model-bias-loeo-report.json: it does not
//  generalise held-out). Aleatory uncertainty is the per-model total
//  sigma (log10 units); epistemic spread is shown as a 3-curve branch-set
//  ensemble (branch rank k applied consistently across all classes — an
//  approximation of the joint logic tree, documented).
//
//  Distance convention: gridded cells use an equal-area circular rupture
//  patch at the smoothed hypocentre depth (strike/dip unknown for grid
//  sources): Rrup = hypDist - sqrt(L*W/pi) with L,W from faultDimensions;
//  scenario sources with patch geometry use the min 3-D distance to patch
//  centroids, point scenarios use the circular-patch rule. Rake is a
//  class-level simplification (interplate reverse 90 deg, others neutral).
// ================================================================

/** Probability of at least one event in `years` for a Poisson annual rate. */
Physics.poissonExceedProb = function(annualRate, years) {
  if (!(annualRate > 0) || !(years > 0)) return 0;
  return 1 - Math.exp(-annualRate * years);
};
/** Poisson annual rate whose `years`-year exceedance probability is `prob`. */
Physics.poissonRateFromProb = function(prob, years) {
  if (!(prob > 0) || !(years > 0) || prob >= 1) return Infinity;
  return -Math.log(1 - prob) / years;
};

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |eps| <= 1.5e-7).
 *  Shared by the BPT renewal engine and any tail-form exceedance math. */
Physics.normCdf = function(x) {
  var sign = x < 0 ? -1 : 1;
  var az = Math.abs(x) / Math.SQRT2;
  var t = 1 / (1 + 0.3275911 * az);
  var erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-az * az));
  return 0.5 * (1 + erf);
};

// ================================================================
//  BPT (Brownian passage time) renewal source — time-dependent
//  characteristic-earthquake recurrence (Matthews, Ellsworth & Reasenberg
//  2002). The renewal density is the inverse Gaussian IG(mu, lambda =
//  mu/alpha^2): mean interval mu (yr), aperiodicity alpha = sigma/mu
//  (coefficient of variation of the interval distribution).
//
//  Closed-form CDF (standard IG): F(t) = Phi(sqrt(l/t)(t/mu - 1))
//    + exp(2l/mu) * Phi(-sqrt(l/t)(t/mu + 1)),  l = mu/alpha^2.
//  The exp(2l/mu) factor overflows double range for alpha < ~0.053
//  (2l/mu = 2/alpha^2 > 709); alpha below 0.06 is clamped (documented
//  engine limit — every published Nankai BPT aperiodicity sits at or above
//  0.2). All inputs in years.
// ================================================================

/** BPT renewal density at elapsed time t (yr). */
Physics.bptDensity = function(tYears, muYears, alpha) {
  if (!(tYears > 0) || !(muYears > 0) || !(alpha > 0)) return 0;
  var d = tYears - muYears;
  return Math.sqrt(muYears / (2 * Math.PI * alpha * alpha * Math.pow(tYears, 3))) *
    Math.exp(-(d * d) / (2 * alpha * alpha * muYears * tYears));
};

/** Tail-normal CDF for |arg| > 5.5: 0.5*erfc(x/sqrt2) via the asymptotic
 *  series (relative ~1e-6 at x = 5.9, improving fast). The BPT CDF's second
 *  term multiplies Phi(-b) by exp(2/alpha^2) ~ 1e15 — the polynomial erf's
 *  1.5e-7 ABSOLUTE noise there becomes ±0.02+ CDF error (measured B2/B3
 *  failures), so the tail branch is mandatory, not cosmetic. */
function bptPhiTail(b) {
  // Phi(-b) = exp(-b^2/2) / (b*sqrt(2*pi)) * (1 - 1/b^2 + 3/b^4 - 15/b^6 + ...)
  var b2 = b * b;
  var series = 1 - 1 / b2 + 3 / (b2 * b2) - 15 / (b2 * b2 * b2) + 105 / (b2 * b2 * b2 * b2);
  return Math.exp(-b2 / 2) / (b * Math.sqrt(2 * Math.PI)) * series;
}

/** BPT CDF: probability the interval has completed by t (yr). */
Physics.bptCdf = function(tYears, muYears, alpha) {
  if (!(tYears > 0)) return 0;
  alpha = Math.max(alpha, 0.06);
  var lam = muYears / (alpha * alpha);
  var sq = Math.sqrt(lam / tYears);
  var ratio = tYears / muYears;
  var b = sq * (ratio + 1);
  var phiNegB = b > 5.5 ? bptPhiTail(b) : Physics.normCdf(-b);
  return Physics.normCdf(sq * (ratio - 1)) +
    Math.exp(2 * lam / muYears) * phiNegB;
};

/** Probability of rupture within `horizonYears` given `elapsedYears` of
 *  quiescence: (F(s+T) - F(s)) / (1 - F(s)). This is the number the ERC
 *  style 時間猶予確率 maps publish. */
Physics.bptConditionalProb = function(horizonYears, elapsedYears, muYears, alpha) {
  if (!(horizonYears > 0)) return 0;
  var s = elapsedYears > 0 ? elapsedYears : 0;
  var f0 = Physics.bptCdf(s, muYears, alpha);
  var f1 = Physics.bptCdf(s + horizonYears, muYears, alpha);
  var survival = 1 - f0;
  if (!(survival > 0)) return 1;
  return Math.max(0, Math.min(1, (f1 - f0) / survival));
};

/** BPT instantaneous hazard rate f(t)/(1 - F(t)) (per year) — the renewal
 *  rate whose average over a horizon reproduces the conditional probability. */
Physics.bptInstantaneousRate = function(tYears, muYears, alpha) {
  var survival = 1 - Physics.bptCdf(tYears, muYears, alpha);
  if (!(survival > 0)) return Infinity;
  return Physics.bptDensity(tYears, muYears, alpha) / survival;
};

// ================================================================
//  UCERF3-TD time-dependent primitives (2026-10-12 batch). Official model =
//  Field et al. (2015, BSSA 105(2A)) Table 1 blend + the Field & Jordan
//  (2015) eq. (6) historic-open-interval form, cross-verified verbatim
//  against OpenSHA (ProbabilityModelsCalc / MagDependentAperiodicityOptions /
//  BPTAveragingTypeParam / HistoricOpenIntervalParam) — methodology and data
//  provenance in docs/UCERF3-TD-AVAILABILITY.md.
// ================================================================

/** Official UCERF3-TD magnitude-dependent aperiodicity branches (paper
 *  Table 1 verbatim; identical to OpenSHA MagDependentAperiodicityOptions
 *  LOW/MID/HIGH and the U3_PREF_BLEND weights incl. the 0.2 Poisson branch).
 *  Mag bins: M<=6.7, 6.7<M<=7.2, 7.2<M<=7.7, M>7.7. */
Physics.UCERF3_TD_APERIODICITY = {
  magBounds: [6.7, 7.2, 7.7],
  low: [0.4, 0.3, 0.2, 0.1],
  mid: [0.5, 0.4, 0.3, 0.2],
  high: [0.6, 0.5, 0.4, 0.3],
  weights: { low: 0.1, mid: 0.4, high: 0.3, poisson: 0.2 }
};
/** Historic open interval start (paper: "We use the year 1875"; T_H grows
 *  with the run year, T_H = currentYear - 1875). */
Physics.UCERF3_TD_HISTORIC_OPEN_START_YEAR = 1875;

/** Aperiodicity triplet {low, mid, high} for a magnitude bin. */
Physics.ucerf3TdAperForMag = function(mag) {
  var t = Physics.UCERF3_TD_APERIODICITY;
  var i = 0;
  while (i < t.magBounds.length && mag > t.magBounds[i]) i++;
  return { low: t.low[i], mid: t.mid[i], high: t.high[i] };
};

/** Survival-function integral ∫_a^b (1 - F_BPT(t)) dt by adaptive Simpson on
 *  the exact IG closed form (OpenSHA uses a 501-pt discretised normalised
 *  CDF; the closed form here is exact — cross-checks use tolerance gates). */
function bptSurvivalIntegral(a, b, muYears, alpha) {
  if (!(b > a)) return 0;
  function S(t) { return 1 - Physics.bptCdf(t, muYears, alpha); }
  function simpson(f, x0, x2) {
    var x1 = (x0 + x2) / 2;
    return (x2 - x0) / 6 * (f(x0) + 4 * f(x1) + f(x2));
  }
  var fa0 = S(a), fb0 = S(b), fm0 = S((a + b) / 2);
  var whole = (b - a) / 6 * (fa0 + 4 * fm0 + fb0);
  function rec(x0, x2, f0, f1, f2, est, tol, depth) {
    var x1 = (x0 + x2) / 2, xl = (x0 + x1) / 2, xr = (x1 + x2) / 2;
    var fl = S(xl), fr = S(xr);
    var left = (x1 - x0) / 6 * (f0 + 4 * fl + f1);
    var right = (x2 - x1) / 6 * (f1 + 4 * fr + f2);
    var delta = left + right - est;
    if (depth <= 0 || Math.abs(delta) <= 15 * tol) return left + right + delta / 15;
    return rec(x0, x1, f0, fl, f1, left, tol / 2, depth - 1) +
           rec(x1, x2, f1, fr, f2, right, tol / 2, depth - 1);
  }
  return rec(a, b, fa0, fm0, fb0, whole, Math.max(1e-10 * (b - a), 1e-10), 24);
}

/** Field & Jordan (2015) eq. (6): probability of rupture within
 *  `horizonYears` when the time since the last event is known only to exceed
 *  `histOpenYears` (T_H), for a BPT(mu, alpha) renewal process:
 *    P = ∫_{TH}^{TH+T} S(t) dt / ∫_{TH}^∞ S(t) dt,  S = 1 - F.
 *  The denominator is integrated DIRECTLY as the tail ∫_{TH}^∞ S dt in
 *  geometrically growing chunks (μ - ∫_0^{TH} S dt would cancel catastrophically
 *  when T_H >> μ — measured: Creeping-Section-like RI~28 yr, T_H=139 gave a
 *  3.5x biased gain before this fix). Identities: TH=0 & T<<μ → T/μ
 *  (equilibrium first-order). */
Physics.bptProbOpenInterval = function(horizonYears, histOpenYears, muYears, alpha) {
  if (!(horizonYears > 0) || !(muYears > 0)) return 0;
  var TH = Math.max(0, histOpenYears || 0);
  var num = bptSurvivalIntegral(TH, TH + horizonYears, muYears, alpha);
  var den = 0, lo = TH, len = Math.max(muYears, horizonYears, 1);
  for (var chunk = 0; chunk < 60; chunk++) {
    var part = bptSurvivalIntegral(lo, lo + len, muYears, alpha);
    den += part;
    if (part < Math.max(1e-12 * den, 1e-13)) break;
    lo += len; len *= 2;
  }
  if (!(den > 0)) return 0;
  return Math.max(0, Math.min(1, num / den));
};

// Memo for the open-interval form: the same (T, TH, mu, alpha) bins recur
// across the 8 UHS period evaluations of one card compute.
var _bptOpenIntervalCache = new Map();

/** UCERF3-TD rate gain for one characteristic source's magnitude bin —
 *  participation-level reduction of the official rupture-level algorithm
 *  (docs/UCERF3-TD-AVAILABILITY.md §3; the pack's sources are parent-section
 *  aggregates, and OpenSHA's aveCondRecurInterval IS the area-weighted mean
 *  of section PARTICIPATION RIs — "the recurrence interval assuming the
 *  rupture is the next to occur" — so at parent granularity the rupture-level
 *  algebra reduces exactly to a renewal at the participation RI):
 *    gain(α) = P_renewal(α) / (partRate × T)     (OpenSHA probGain definition)
 *    P_renewal(α) = BPT(T | elapsed, RI_part, α)          [date of last known]
 *                 = eq.(6) open-interval(T, T_H, RI_part, α)  [null date]
 *    g(mag)  = 0.1·gain(α_low) + 0.4·gain(α_mid) + 0.3·gain(α_high) + 0.2×1
 *            (paper Table 1; Poisson branch gain ≡ 1 as in U3_PREF_BLEND)
 *  The bin's Poisson rate is multiplied by g(mag); gain-1 degenerates to the
 *  stationary model byte-exactly. elapsedYears = raw years since the parent's
 *  last event (null -> historic open interval, T_H = currentYear - 1875). */
Physics.ucerf3TdRateGain = function(horizonYears, mag, partRatePerYr, elapsedYears, currentYear) {
  if (!(partRatePerYr > 0) || !(horizonYears > 0)) return 1;
  var mu = 1 / partRatePerYr;
  var aper = Physics.ucerf3TdAperForMag(mag);
  var w = Physics.UCERF3_TD_APERIODICITY.weights;
  var expNum = partRatePerYr * horizonYears; // OpenSHA expNum = duration/RI
  function branchGain(alpha) {
    var p;
    if (elapsedYears != null) {
      p = Physics.bptConditionalProb(horizonYears, Math.max(0, elapsedYears), mu, alpha);
    } else {
      var TH = Math.max(0, currentYear - Physics.UCERF3_TD_HISTORIC_OPEN_START_YEAR);
      var key = horizonYears.toPrecision(6) + '|' + TH.toPrecision(6) + '|' + mu.toPrecision(6) + '|' + alpha;
      p = _bptOpenIntervalCache.get(key);
      if (p === undefined) {
        p = Physics.bptProbOpenInterval(horizonYears, TH, mu, alpha);
        if (_bptOpenIntervalCache.size > 6000) _bptOpenIntervalCache.clear();
        _bptOpenIntervalCache.set(key, p);
      }
    }
    return p / expNum;
  }
  return w.low * branchGain(aper.low) + w.mid * branchGain(aper.mid) +
         w.high * branchGain(aper.high) + w.poisson; // Poisson branch gain = 1
};

/** Class-level rake simplification for hazard integration. */
Physics.PSHA_CLASS_RAKE = { crustal: 0, interplate: 90, intraslab: 0 };

/** Period-aware Zhao 2006 sigma (log10 units): tau from the tectonic-class
 *  sub-table of the period row (crustal tauC / interplate tauI / slab tauS),
 *  phi = the row's shared sigma (hazardlib sets phi = sigma). imt is a
 *  ZHAO2006_PAPER key ('pga', '0.05'...'5.00'); 'pgv' maps to the 1.00 s row
 *  (the pseudo-velocity conversion source). For the pga/pgv keys this is
 *  byte-identical to the class-constant ZHAO2006_SIGMA. */
Physics.zhao2006Sigma = function(imt, srcType) {
  var T = Physics.ZHAO2006_PAPER[imt] || (imt === 'pgv' ? Physics.ZHAO2006_PAPER['1.00'] : null) || Physics.ZHAO2006_PAPER.pga;
  var tauLn = srcType === 'interplate' ? T.inter.tau : (srcType === 'intraslab' ? T.slab.tau : T.tau);
  var phiLn = T.sigma;
  return { tau: tauLn / _LN10, phi: phiLn / _LN10, sigmaT: Math.sqrt(tauLn * tauLn + phiLn * phiLn) / _LN10 };
};

/** Median and total sigma (log10 units) for one GMPE family at a hazard
 *  contribution. imt: 'pga' (gal) | 'pgv' (cm/s) | 'sa:<periodKey>' (gal,
 *  periodKey in seconds like '0.50'). Returns {median, sigmaLog10},
 *  or null when the family does not implement the imt — si-midorikawa and
 *  kanno2006 publish no spectral rows; zhao2006 is the Japan SA model
 *  (documented limitation: no logic-tree epistemic spread in periods);
 *  bssa14 (v6.9: full 107-row table) and ngasub serve regional SA through
 *  the pack gmpeTree. */
Physics._pshaBranchMotion = function(modelName, imt, srcType, mw, rRupKm, depthKm, vs30, rake, variant) {
  // v6.8: NGA-Sub (Parker 2022) branch — handles pga/pgv AND spectral periods
  // (full 26-row table; SA periods missing from the table are log-period
  // interpolated, outside [0.01,10] s -> null). srcType maps interface/
  // intraslab; depthKm feeds the intraslab depth scaling; variant is the
  // pack-frozen region/sat pair (regional packs) else the active-region
  // default. Japan callers never reach this branch — ngasub is not in the
  // Japan tree.
  if (modelName === 'ngasub') {
    var nv = variant || Physics.activeNgasubVariant();
    var ntrt = srcType === 'intraslab' ? 'intraslab' : 'interface';
    var nkey = imt.slice(0, 3) === 'sa:' ? imt.slice(3) : imt;
    var nsig = Physics.parker2022Sigma(nkey, rRupKm, vs30);
    if (!nsig) return null;
    if (imt.slice(0, 3) === 'sa:') {
      var saGal = Physics.saParker2022Gal(nkey, ntrt, mw, rRupKm, vs30, depthKm, nv);
      if (saGal == null) return null;
      return { median: saGal, sigmaLog10: nsig.sigmaT };
    }
    if (imt === 'pga') {
      return { median: Physics.pgaParker2022(mw, rRupKm, vs30, ntrt, depthKm, nv), sigmaLog10: nsig.sigmaT };
    }
    return { median: Physics.pgvParker2022(mw, rRupKm, vs30, ntrt, depthKm, nv), sigmaLog10: nsig.sigmaT };
  }
  if (imt.slice(0, 3) === 'sa:') {
    // v6.9: the regional crustal BSSA14 branch is SA-capable (full 105-row
    // table transcribed from the same frozen hazardlib source). rRupKm reads
    // as Rjb, per the pga/pgv branch convention below.
    if (modelName === 'bssa14') {
      var bvS = variant || Physics.activeBssa2014Variant();
      var bT = imt.slice(3);
      var bGal = Physics.saBssa2014Gal(bT, mw, rRupKm, vs30, rake, bvS);
      if (bGal == null) return null;
      var bSig = Physics.bssa2014Sigma(bT, mw, rRupKm, vs30);
      if (!bSig) return null;
      return { median: bGal, sigmaLog10: bSig.sigmaT };
    }
    // v7.x: the remaining NGA-West2 tree branches (CY14/CB14/ASK14) are
    // SA-capable (full tables). Same point-source read: rRupKm is Rjb, Rrup
    // derives from the source depth (nw2PointGeom; documented on the model
    // block). dip defaults to the crustal prior 60 deg.
    if (modelName === 'cy14' || modelName === 'cb14' || modelName === 'ask14') {
      var wT = imt.slice(3);
      var wGeom = Physics.nw2PointGeom(mw, rRupKm, depthKm, vs30, rake, null);
      var wGal = modelName === 'cy14' ? Physics.saCy2014Gal(wT, mw, wGeom)
        : (modelName === 'cb14' ? Physics.saCb2014Gal(wT, wGeom) : Physics.saAsk2014Gal(wT, wGeom));
      if (wGal == null) return null;
      var wSig = modelName === 'cy14' ? Physics.cy2014Sigma(wT, mw, wGeom)
        : (modelName === 'cb14' ? Physics.cb2014Sigma(wT, wGeom) : Physics.ask2014Sigma(wT, wGeom));
      if (!wSig) return null;
      return { median: wGal, sigmaLog10: wSig.sigmaT };
    }
    if (modelName !== 'zhao2006') return null;
    var key = imt.slice(3);
    return {
      median: Physics.GMPE_PGA_SOFT_CAP * Math.tanh(Math.exp(Physics.zhao2006LnA(key, srcType, mw, rRupKm, depthKm, vs30, rake)) / Physics.GMPE_PGA_SOFT_CAP),
      sigmaLog10: Physics.zhao2006Sigma(key, srcType).sigmaT
    };
  }
  if (modelName === 'bssa14') {
    // v6.7 D: NGA-West2 branch for regional crustal sources. rRupKm is read
    // as Rjb (the hazard engine's equal-area point proxy is horizontal-first —
    // documented convention, same as the regional scorecard). variant is the
    // paper's regional anelastic Dc3 adjustment frozen into the pack's
    // gmpeTree; absent it, fall back to the active-region default (Japan
    // callers never reach this branch — bssa14 is not in the Japan tree).
    var bv = variant || Physics.activeBssa2014Variant();
    if (imt === 'pga') {
      return { median: Physics.pgaBssa2014(mw, rRupKm, vs30, rake, bv), sigmaLog10: Physics.bssa2014Sigma('pga', mw, rRupKm, vs30).sigmaT };
    }
    return { median: Physics.pgvBssa2014(mw, rRupKm, vs30, rake, bv), sigmaLog10: Physics.bssa2014Sigma('pgv', mw, rRupKm, vs30).sigmaT };
  }
  if (modelName === 'cy14' || modelName === 'cb14' || modelName === 'ask14') {
    // v7.x: the remaining NGA-West2 tree branches — same Rjb read as bssa14
    // (nw2PointGeom derives Rrup from the source depth; documented on the
    // model block).
    var wGeom2 = Physics.nw2PointGeom(mw, rRupKm, depthKm, vs30, rake, null);
    if (imt === 'pga') {
      var wPga = modelName === 'cy14' ? Physics.pgaCy2014(mw, wGeom2)
        : (modelName === 'cb14' ? Physics.pgaCb2014(wGeom2) : Physics.pgaAsk2014(wGeom2));
      var wSigP = modelName === 'cy14' ? Physics.cy2014Sigma('pga', mw, wGeom2)
        : (modelName === 'cb14' ? Physics.cb2014Sigma('pga', wGeom2) : Physics.ask2014Sigma('pga', wGeom2));
      return { median: wPga, sigmaLog10: wSigP.sigmaT };
    }
    var wPgv = modelName === 'cy14' ? Physics.pgvCy2014(mw, wGeom2)
      : (modelName === 'cb14' ? Physics.pgvCb2014(wGeom2) : Physics.pgvAsk2014(wGeom2));
    var wSigV = modelName === 'cy14' ? Physics.cy2014Sigma('pgv', mw, wGeom2)
      : (modelName === 'cb14' ? Physics.cb2014Sigma('pgv', wGeom2) : Physics.ask2014Sigma('pgv', wGeom2));
    return { median: wPgv, sigmaLog10: wSigV.sigmaT };
  }
  if (modelName === 'zhao2006') {
    var sig = Physics.zhao2006Sigma(imt === 'pgv' ? '1.00' : imt, srcType);
    if (imt === 'pga') {
      return { median: Physics.pgaZhao2006(mw, rRupKm, depthKm, srcType, vs30, rake), sigmaLog10: sig.sigmaT };
    }
    return { median: Physics.pgvZhao2006(mw, rRupKm, depthKm, srcType, vs30, rake), sigmaLog10: sig.sigmaT };
  }
  if (modelName === 'si-midorikawa') {
    if (imt === 'pga') return { median: Physics.pgaSiMid(mw, rRupKm, depthKm, srcType), sigmaLog10: Physics.SIMID_SIGMA.sigmaT };
    return { median: Physics.pgvSiMid(mw, rRupKm, depthKm, srcType), sigmaLog10: Physics.SIMID_SIGMA.sigmaT };
  }
  if (modelName === 'kanno2006') {
    if (imt === 'pgv') return { median: Physics.pgvKanno(mw, rRupKm, depthKm, vs30), sigmaLog10: Physics.KANNO2006_SIGMA.sigmaT };
    return { median: Physics.pgaKanno(mw, rRupKm, depthKm, vs30), sigmaLog10: Physics.KANNO2006_SIGMA.sigmaT };
  }
  return null;
};

/** Logic-tree branches for an imt: spectral periods collapse to the zhao2006
 *  single model at weight 1 (si-mid/kanno publish no SA rows). v6.7 D: a
 *  source model may carry its own `gmpeTree` (regional packs — crustal is
 *  the four-model NGA-West2 tree at equal 0.25 since v7.x (BSSA14 with the
 *  frozen regional variant + CY14 + CB14 + ASK14), subduction classes
 *  single-branch NGA-Sub); absent the field the Japan three-branch logic
 *  tree applies (legacy byte-identical). Branch entries may carry a
 *  `variant` (e.g. BSSA14 'lowQ'/'base') forwarded to the branch motion. */
/** v7.x: SA-capable gmpeTree branch models (a pack tree drives spectral
 *  periods only when EVERY branch of the class is SA-capable — else the
 *  zhao2006 single-model collapse keeps the period honest). */
Physics.PSHA_SA_CAPABLE_MODELS = { bssa14: 1, ngasub: 1, cy14: 1, cb14: 1, ask14: 1 };
Physics._pshaBranchesFor = function(srcType, imt, sourceModel) {
  var lt = sourceModel && sourceModel.gmpeTree;
  if (imt.slice(0, 3) === 'sa:') {
    // v6.8/v6.9: a pack gmpeTree whose class branch is SA-capable (NGA-Sub
    // full 26-row table, BSSA14 full 107-row table since v6.9, CY14/CB14/
    // ASK14 full tables since v7.x) drives spectral periods too; any other
    // tree (or no tree) keeps the zhao2006 single-model collapse — Japan
    // byte-identical.
    if (lt && lt[srcType] && lt[srcType].length) {
      var allCapable = true;
      for (var iC = 0; iC < lt[srcType].length; iC++) {
        if (!Physics.PSHA_SA_CAPABLE_MODELS[lt[srcType][iC].model]) { allCapable = false; break; }
      }
      if (allCapable) {
        var wsumS = 0;
        for (var iS = 0; iS < lt[srcType].length; iS++) wsumS += lt[srcType][iS].weight;
        return lt[srcType].map(function(b) { return { model: b.model, weight: b.weight / wsumS, variant: b.variant }; });
      }
    }
    return [{ model: 'zhao2006', weight: 1 }];
  }
  var lt2 = lt;
  if (lt2 && lt2[srcType] && lt2[srcType].length) {
    var wsum = 0;
    for (var i = 0; i < lt2[srcType].length; i++) wsum += lt2[srcType][i].weight;
    return lt2[srcType].map(function(b) { return { model: b.model, weight: b.weight / wsum, variant: b.variant }; });
  }
  return Physics.logicTreeBranches(srcType);
};

/** Equal-area circular-patch Rrup proxy for a gridded/point source. */
Physics._pshaPointRrup = function(hypDistKm, mw, srcType) {
  var dims = Physics.faultDimensions(mw, srcType);
  var rEq = Math.sqrt(dims.area / Math.PI);
  return Math.max(hypDistKm - rEq, 0.1);
};

/** v3-pack extra source blocks (UCERF3 batch B, 2026-10-12):
 *  - gridMfdSources: point sources carrying an explicit incremental MFD
 *    ([[magCenter, ratePerYr], ...]) instead of a GR a/b pair — consumed like
 *    grid cells (equal-area point Rrup proxy at the node depth).
 *  - characteristicSources: finite-fault sources with an explicit MFD and a
 *    patch-point rupture-surface proxy. Distance defaults to the Rjb
 *    convention (min HORIZONTAL offset to the patch points — the regional
 *    crustal BSSA14 branch reads the distance argument as Rjb, v6.7 D
 *    convention); an entry may opt into 'rrup' (3-D) via distanceMetric.
 *  cb receives (srcType, mag, rRupKm, depthKm, ratePerYr, lat, lng) — the
 *  same shape the cells/scenarios loops feed in all three engines
 *  (hazardCurve / hazardCurveTimeDependent background / deaggregate).
 *  Absent arrays (v1|v2 packs) make this a no-op — byte-identical legacy. */
Physics._pshaV3SourcesEach = function(sourceModel, site, maxDistKm, cb, opts) {
  var used = { grid: 0, char: 0 };
  if (!sourceModel) return used;
  var gm = sourceModel.gridMfdSources;
  if (gm && gm.length) {
    for (var gi = 0; gi < gm.length; gi++) {
      var n = gm[gi];
      var hd = Physics.haversineDist(site.lat, site.lng, n.lat, n.lng);
      if (hd > maxDistKm) continue;
      var dep = n.depthKm != null ? n.depthKm : 6;
      var hyp = Math.sqrt(hd * hd + dep * dep);
      var cls = n.srcType || 'crustal';
      for (var bi = 0; bi < n.mfd.length; bi++) {
        var rate = n.mfd[bi][1];
        if (!(rate > 0)) continue;
        cb(cls, n.mfd[bi][0], Physics._pshaPointRrup(hyp, n.mfd[bi][0], cls), dep, rate, n.lat, n.lng);
      }
      used.grid++;
    }
  }
  var ch = sourceModel.characteristicSources;
  if (ch && ch.length) {
    for (var si = 0; si < ch.length; si++) {
      var s = ch[si];
      var w = s.weight != null ? s.weight : 1;
      var patches = s.patches || [];
      var best = Infinity, blat = 0, blng = 0;
      for (var pi = 0; pi < patches.length; pi++) {
        var pp = patches[pi];
        var hdP = Physics.haversineDist(site.lat, site.lng, pp[0], pp[1]);
        var d = s.distanceMetric === 'rrup' ? Math.sqrt(hdP * hdP + pp[2] * pp[2]) : hdP;
        if (d < best) { best = d; blat = pp[0]; blng = pp[1]; }
      }
      if (!isFinite(best) || best > maxDistKm) continue;
      var depS = s.depthKm != null ? s.depthKm : 6;
      var clsS = s.srcType || 'crustal';
      var rS = Math.max(best, 0.1);
      // UCERF3-TD: when the caller supplies opts.charCb (the time-dependent
      // engine), each characteristic source is handed over ONCE with its
      // precomputed site geometry instead of feeding per-bin Poisson rates —
      // the callback owns the renewal-channel treatment of the mfd bins.
      if (opts && opts.charCb) { opts.charCb(s, rS, depS, clsS); used.char++; continue; }
      for (var bi2 = 0; bi2 < s.mfd.length; bi2++) {
        var r2 = s.mfd[bi2][1] * w;
        if (!(r2 > 0)) continue;
        cb(clsS, s.mfd[bi2][0], rS, depS, r2, blat, blng);
      }
      used.char++;
    }
  }
  return used;
};

/** Hazard curve(s) at a site. site: {lat, lng, vs30?}. imt: 'pga'|'pgv'|
 *  'sa:<periodKey>' (seconds, gal; Japan model: zhao2006 single-model
 *  collapse — si-mid/kanno publish no SA rows; regional packs since v6.9:
 *  the pack gmpeTree branch per class, bssa14 crustal / ngasub subduction).
 *  options: {imLevels?, vs30?=600, maxDistKm?=500, mStep?=0.1, years?=50}.
 *  Returns {imLevels, meanRate, ensemble, poissonProb, diagnostics} where
 *  meanRate[i] is the mean annual exceedance rate of imLevels[i], ensemble
 *  is the 3-branch-set hazard (index-aligned with GMPE_LOGIC_TREE rank;
 *  single-branch imts repeat the mean curve), poissonProb is P(exceed in
 *  `years`) for the mean curve. */
Physics.hazardCurve = function(sourceModel, site, imt, options) {
  options = options || {};
  var isSa = imt.slice(0, 3) === 'sa:';
  var imtKey = imt === 'pgv' ? 'pgv' : (isSa ? imt : 'pga');
  var vs30 = site && site.vs30 != null ? site.vs30 : (options.vs30 != null ? options.vs30 : 600);
  var maxDistKm = options.maxDistKm != null ? options.maxDistKm : 500;
  var mStep = options.mStep || 0.1;
  var years = options.years != null ? options.years : 50;
  var imLevels = options.imLevels;
  if (!imLevels || !imLevels.length) {
    imLevels = [];
    var lo = imtKey === 'pga' ? 3 : (isSa ? 0.01 : 0.3);
    var hi = imtKey === 'pga' ? 3000 : (isSa ? 3000 : 300);
    var nLv = isSa ? 50 : 40;
    for (var q = 0; q < nLv; q++) imLevels.push(+(lo * Math.pow(hi / lo, q / (nLv - 1))).toPrecision(3));
  }
  var nIm = imLevels.length;
  var meanRate = new Array(nIm).fill(0);
  var nBranchSets = 3;
  var ensemble = [];
  for (var bs = 0; bs < nBranchSets; bs++) ensemble.push(new Array(nIm).fill(0));
  var logIm = imLevels.map(function(v) { return Math.log10(v); });

  var mc = sourceModel.mc, mMin = sourceModel.mMin != null ? sourceModel.mMin : 5.0;
  var nCells = 0, nBins = 0;

  function accumulate(srcType, mag, rRupKm, depthKm, rate) {
    var branches = Physics._pshaBranchesFor(srcType, imtKey, sourceModel);
    var rake = Physics.PSHA_CLASS_RAKE[srcType] || 0;
    for (var bi = 0; bi < branches.length; bi++) {
      var motion = Physics._pshaBranchMotion(branches[bi].model, imtKey, srcType, mag, rRupKm, depthKm, vs30, rake, branches[bi].variant);
      if (!motion || !(motion.median > 0)) continue;
      var medLog = Math.log10(motion.median);
      var sig = motion.sigmaLog10;
      for (var ii = 0; ii < nIm; ii++) {
        var z = (logIm[ii] - medLog) / sig;
        var sign = z < 0 ? -1 : 1, az = Math.abs(z) / Math.SQRT2;
        var t = 1 / (1 + 0.3275911 * az);
        var erf = sign * (1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-az*az));
        var p = Math.max(0, Math.min(1, 0.5 * (1 - erf)));
        if (p <= 0) continue;
        // mean curve: logic-tree-weighted mix of the branch CCDFs;
        // ensemble set k: branch rank k carries the FULL rate within its set.
        meanRate[ii] += branches[bi].weight * rate * p;
        if (bi < nBranchSets) ensemble[bi][ii] += rate * p;
      }
    }
  }

  // gridded cells
  var cells = sourceModel.cells || [];
  for (var ci = 0; ci < cells.length; ci++) {
    var c = cells[ci];
    var hd = Physics.haversineDist(site.lat, site.lng, c.lat, c.lng);
    if (hd > maxDistKm) continue;
    nCells++;
    var b = sourceModel.bValues[c.srcType];
    var mMax = (sourceModel.mMaxByClass || {})[c.srcType] || 7.5;
    if (!(b > 0) || !(c.rateMc > 0)) continue;
    var hypDist = Math.sqrt(hd * hd + c.depthKm * c.depthKm);
    var mLo = Math.ceil(mMin / mStep - 1e-9) * mStep;
    for (var m = mLo; m <= mMax + 1e-9; m += mStep) {
      // incremental rate of bin [m, m+mStep) from the GR survival function
      var lam = c.rateMc * (Math.pow(10, -b * (m - mc)) - Math.pow(10, -b * (m + mStep - mc)));
      if (!(lam > 1e-9)) continue;
      nBins++;
      var mm = Math.min(m + mStep / 2, mMax);
      var rRup = Physics._pshaPointRrup(hypDist, mm, c.srcType);
      accumulate(c.srcType, mm, rRup, c.depthKm, lam);
    }
  }

  // scenario sources
  var scenUsed = 0;
  var scenarios = sourceModel.scenarios || [];
  for (var si = 0; si < scenarios.length; si++) {
    var s = scenarios[si];
    var rRupS, depthS;
    if (s.patches && s.patches.length) {
      rRupS = Infinity; depthS = s.depthKm != null ? s.depthKm : 0;
      for (var pi = 0; pi < s.patches.length; pi++) {
        var p = s.patches[pi];
        var d3 = Math.sqrt(Math.pow(Physics.haversineDist(site.lat, site.lng, p[0], p[1]), 2) + p[2] * p[2]);
        if (d3 < rRupS) rRupS = d3;
      }
    } else {
      depthS = s.depthKm != null ? s.depthKm : 15;
      var hdS = Physics.haversineDist(site.lat, site.lng, s.lat != null ? s.lat : 0, s.lng != null ? s.lng : 0);
      rRupS = Physics._pshaPointRrup(Math.sqrt(hdS * hdS + depthS * depthS), s.mw, s.sourceType || 'crustal');
    }
    scenUsed++;
    accumulate(s.sourceType || 'crustal', s.mw, Math.max(rRupS, 0.1), depthS, s.ratePerYear);
  }

  // v3 packs (UCERF3 batch B): grid MFD nodes + characteristic sources
  var v3Used = Physics._pshaV3SourcesEach(sourceModel, site, maxDistKm, accumulate);

  var poissonProb = meanRate.map(function(r) { return Physics.poissonExceedProb(r, years); });
  if (isSa) {
    // single-model imt: the branch-set ensemble is degenerate — repeat the
    // mean curve so downstream fractile code stays well-defined.
    for (var rep = 1; rep < nBranchSets; rep++) {
      for (var ri = 0; ri < nIm; ri++) ensemble[rep][ri] = ensemble[0][ri];
    }
  }
  return {
    imt: imtKey, imLevels: imLevels, meanRate: meanRate, ensemble: ensemble,
    poissonProb: poissonProb, years: years,
    diagnostics: {
      nCellsUsed: nCells, nMagnitudeBins: nBins, nScenarios: scenUsed,
      nGridMfdUsed: v3Used.grid, nCharUsed: v3Used.char,
      mStep: mStep, maxDistKm: maxDistKm, vs30: vs30,
      singleModel: isSa,
      branchSets: ['crustal', 'interplate', 'intraslab'].map(function(cls) {
        return Physics._pshaBranchesFor(cls, imtKey, sourceModel).map(function(b) { return b.model; });
      })
    }
  };
};

/** Time-dependent hazard curve: BPT renewal sources (scenario entries with a
 *  `bpt` block, or the registered PSHA_BPT_SOURCES table) contribute their
 *  CONDITIONAL rupture probability over the horizon instead of a Poisson
 *  rate; everything else (GR grid cells, plain scenarios) stays stationary
 *  Poisson. Total exceedance per IM level combines the independent channels
 *  multiplicatively: 1 - (1-p_bg) * prod_scen (1 - pChar_s * pExceed_s(IM)).
 *
 *  options: { horizonYears (=30), currentYear (=2025.75), elapsedYears
 *  (global override), alpha (global override, default 0.24), vs30,
 *  maxDistKm, mStep, imLevels }. A scenario opts in via sourceModel entry
 *  `bpt: {muYears, alpha?, lastEventYear}` or the registered default table;
 *  `elapsedYears` inside the bpt block wins over lastEventYear arithmetic.
 *  Returns the hazardCurve shape plus a `timeDependent` diagnostics block
 *  (per-BPT-source: mu, alpha, elapsed, conditional probability) and
 *  `meanRate` recomputed as the equivalent Poisson rate of the total
 *  exceedance (so downstream UHS/inversion code stays well-defined). */
Physics.PSHA_BPT_SOURCES = {
  nankaiFullM89: { muYears: 117, lastEventYear: 1707 },   // Hoei-type full-segment episode
  nankaiEastM82: { muYears: 468, lastEventYear: 1944 },   // Tonankai single-segment (1/4 mode share of 1/117yr)
  nankaiWestM83: { muYears: 468, lastEventYear: 1946 }    // Nankai single-segment (1/4 mode share)
};

Physics.hazardCurveTimeDependent = function(sourceModel, site, imt, options) {
  options = options || {};
  var isSa = imt.slice(0, 3) === 'sa:';
  var imtKey = imt === 'pgv' ? 'pgv' : (isSa ? imt : 'pga');
  var vs30 = site && site.vs30 != null ? site.vs30 : (options.vs30 != null ? options.vs30 : 600);
  var maxDistKm = options.maxDistKm != null ? options.maxDistKm : 500;
  var mStep = options.mStep || 0.1;
  var years = options.horizonYears != null ? options.horizonYears : 30;
  var currentYear = options.currentYear != null ? options.currentYear : 2025.75;
  var globalAlpha = options.alpha;
  var imLevels = options.imLevels;
  if (!imLevels || !imLevels.length) {
    imLevels = [];
    var lo = imtKey === 'pga' ? 3 : (isSa ? 0.01 : 0.3);
    var hi = imtKey === 'pga' ? 3000 : (isSa ? 3000 : 300);
    var nLv = isSa ? 50 : 40;
    for (var q0 = 0; q0 < nLv; q0++) imLevels.push(+(lo * Math.pow(hi / lo, q0 / (nLv - 1))).toPrecision(3));
  }
  var nIm = imLevels.length;
  var meanRate = new Array(nIm).fill(0);
  var logIm = imLevels.map(function(v) { return Math.log10(v); });
  var mc = sourceModel.mc, mMin = sourceModel.mMin != null ? sourceModel.mMin : 5.0;
  var nCells = 0, nBins = 0;

  function accumulate(srcType, mag, rRupKm, depthKm, rate) {
    var branches = Physics._pshaBranchesFor(srcType, imtKey, sourceModel);
    var rake = Physics.PSHA_CLASS_RAKE[srcType] || 0;
    for (var bi = 0; bi < branches.length; bi++) {
      var motion = Physics._pshaBranchMotion(branches[bi].model, imtKey, srcType, mag, rRupKm, depthKm, vs30, rake, branches[bi].variant);
      if (!motion || !(motion.median > 0)) continue;
      var medLog = Math.log10(motion.median);
      var sig = motion.sigmaLog10;
      for (var ii = 0; ii < nIm; ii++) {
        var z = (logIm[ii] - medLog) / sig;
        var sign = z < 0 ? -1 : 1, az = Math.abs(z) / Math.SQRT2;
        var t = 1 / (1 + 0.3275911 * az);
        var erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-az * az));
        var p = Math.max(0, Math.min(1, 0.5 * (1 - erf)));
        if (p <= 0) continue;
        meanRate[ii] += branches[bi].weight * rate * p;
      }
    }
  }
  /** Branch-mixture exceedance given ONE event (no rate): P(IM > x | rupture). */
  function exceedGivenEvent(srcType, mag, rRupKm, depthKm) {
    var branches = Physics._pshaBranchesFor(srcType, imtKey, sourceModel);
    var rake = Physics.PSHA_CLASS_RAKE[srcType] || 0;
    var out = new Array(nIm).fill(0);
    for (var bi = 0; bi < branches.length; bi++) {
      var motion = Physics._pshaBranchMotion(branches[bi].model, imtKey, srcType, mag, rRupKm, depthKm, vs30, rake, branches[bi].variant);
      if (!motion || !(motion.median > 0)) continue;
      var medLog = Math.log10(motion.median);
      var sig = motion.sigmaLog10;
      for (var ii = 0; ii < nIm; ii++) {
        var z = (logIm[ii] - medLog) / sig;
        var sign = z < 0 ? -1 : 1, az = Math.abs(z) / Math.SQRT2;
        var t = 1 / (1 + 0.3275911 * az);
        var erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-az * az));
        var p = Math.max(0, Math.min(1, 0.5 * (1 - erf)));
        out[ii] += branches[bi].weight * p;
      }
    }
    return out;
  }

  // --- stationary background: GR grid cells + plain scenarios (Poisson) ---
  var cells = sourceModel.cells || [];
  for (var ci = 0; ci < cells.length; ci++) {
    var c = cells[ci];
    var hd = Physics.haversineDist(site.lat, site.lng, c.lat, c.lng);
    if (hd > maxDistKm) continue;
    nCells++;
    var b = sourceModel.bValues[c.srcType];
    var mMax = (sourceModel.mMaxByClass || {})[c.srcType] || 7.5;
    if (!(b > 0) || !(c.rateMc > 0)) continue;
    var hypDist = Math.sqrt(hd * hd + c.depthKm * c.depthKm);
    var mLo = Math.ceil(mMin / mStep - 1e-9) * mStep;
    for (var m = mLo; m <= mMax + 1e-9; m += mStep) {
      var lam = c.rateMc * (Math.pow(10, -b * (m - mc)) - Math.pow(10, -b * (m + mStep - mc)));
      if (!(lam > 1e-9)) continue;
      nBins++;
      var mm = Math.min(m + mStep / 2, mMax);
      var rRup = Physics._pshaPointRrup(hypDist, mm, c.srcType);
      accumulate(c.srcType, mm, rRup, c.depthKm, lam);
    }
  }

  // --- scenarios: BPT renewal sources vs plain Poisson sources ---
  var bptUsed = [];
  var scenarios = sourceModel.scenarios || [];
  for (var si = 0; si < scenarios.length; si++) {
    var s = scenarios[si];
    var rRupS, depthS;
    if (s.patches && s.patches.length) {
      rRupS = Infinity; depthS = s.depthKm != null ? s.depthKm : 0;
      for (var pi = 0; pi < s.patches.length; pi++) {
        var pp = s.patches[pi];
        var d3 = Math.sqrt(Math.pow(Physics.haversineDist(site.lat, site.lng, pp[0], pp[1]), 2) + pp[2] * pp[2]);
        if (d3 < rRupS) rRupS = d3;
      }
    } else {
      depthS = s.depthKm != null ? s.depthKm : 15;
      var hdS = Physics.haversineDist(site.lat, site.lng, s.lat != null ? s.lat : 0, s.lng != null ? s.lng : 0);
      rRupS = Physics._pshaPointRrup(Math.sqrt(hdS * hdS + depthS * depthS), s.mw, s.sourceType || 'crustal');
    }
    rRupS = Math.max(rRupS, 0.1);
    var bptCfg = s.bpt || Physics.PSHA_BPT_SOURCES[s.id] || null;
    var isBpt = !!(bptCfg && (options.elapsedYears != null || bptCfg.lastEventYear != null || bptCfg.elapsedYears != null));
    if (!isBpt) {
      accumulate(s.sourceType || 'crustal', s.mw, rRupS, depthS, s.ratePerYear);
      continue;
    }
    var muYears = bptCfg.muYears;
    var alpha = globalAlpha != null ? globalAlpha : (bptCfg.alpha != null ? bptCfg.alpha : 0.24);
    var elapsed = options.elapsedYears != null ? options.elapsedYears :
      (bptCfg.elapsedYears != null ? bptCfg.elapsedYears : currentYear - bptCfg.lastEventYear);
    var pChar = Physics.bptConditionalProb(years, elapsed, muYears, alpha);
    var ex = exceedGivenEvent(s.sourceType || 'crustal', s.mw, rRupS, depthS);
    bptUsed.push({
      id: s.id, mw: s.mw, muYears: muYears, alpha: alpha,
      elapsedYears: +elapsed.toFixed(2), horizonYears: years,
      conditionalProb: +pChar.toPrecision(4),
      rRupKm: +rRupS.toFixed(1), srcType: s.sourceType || 'crustal',
      pExceedGivenEvent: ex
    });
  }

  // v3 packs (UCERF3 batch B): grid MFD nodes are stationary Poisson and ride
  // the background channel; characteristic sources carrying a `bpt` block
  // (UCERF3-TD batch B) get their charMfd bin rates multiplied by the
  // UCERF3-TD rate gain (Field et al. 2015 Table 1 blend at participation
  // level; lastEventYear null -> historic-open-interval form) and ride the
  // same background channel — gain-1 degenerates to the stationary model
  // exactly. Char sources without a bpt block are untouched.
  var bptCharUsed = 0;
  var bptCharSummary = [];
  Physics._pshaV3SourcesEach(sourceModel, site, maxDistKm, accumulate, {
    charCb: function(src, rRup, depKm, cls) {
      if (!src.bpt) {
        for (var biL = 0; biL < src.mfd.length; biL++) {
          var rL = src.mfd[biL][1] * (src.weight != null ? src.weight : 1);
          if (rL > 0) accumulate(cls, src.mfd[biL][0], rRup, depKm, rL);
        }
        return;
      }
      var wS = src.weight != null ? src.weight : 1;
      var ley = src.bpt.lastEventYear != null ? src.bpt.lastEventYear : null;
      var elapsed = ley != null ? Math.max(0, currentYear - ley) : null;
      var partRate = src.participationRatePerYr > 0 ? src.participationRatePerYr : null;
      if (partRate == null) elapsed = null; // no rate: keep the bins stationary
      var gSum = 0, nG = 0;
      for (var bi = 0; bi < src.mfd.length; bi++) {
        var mag = src.mfd[bi][0], rate = src.mfd[bi][1]; // FULL long-term rate (FM weight applied below)
        if (!(rate > 0)) continue;
        var g = partRate != null ? Physics.ucerf3TdRateGain(years, mag, partRate, elapsed, currentYear) : 1;
        if (!(g > 0)) continue;
        gSum += g; nG++;
        accumulate(cls, mag, rRup, depKm, rate * g * wS);
      }
      if (nG) {
        bptCharUsed++;
        bptCharSummary.push({
          id: src.id, mw: src.mmax, muYears: +(1 / partRate).toFixed(1),
          elapsedYears: elapsed != null ? +elapsed.toFixed(2) : null,
          meanGain: +(gSum / nG).toPrecision(4), rRupKm: +rRup.toFixed(1), srcType: cls
        });
      }
    }
  });

  // --- combine independent channels: Poisson background x BPT scenarios ---
  var bgProb = meanRate.map(function(r) { return Physics.poissonExceedProb(r, years); });
  var totalProb = new Array(nIm);
  for (var ii3 = 0; ii3 < nIm; ii3++) {
    var survive = 1 - bgProb[ii3];
    for (var bj = 0; bj < bptUsed.length; bj++) {
      survive *= 1 - bptUsed[bj].conditionalProb * bptUsed[bj].pExceedGivenEvent[ii3];
    }
    totalProb[ii3] = 1 - survive;
  }
  var eqRate = totalProb.map(function(p) { return p >= 1 ? Infinity : -Math.log(1 - p) / years; });

  return {
    imt: imtKey, imLevels: imLevels, meanRate: eqRate, poissonProb: totalProb, years: years,
    timeDependent: {
      horizonYears: years, currentYear: currentYear,
      alphaDefault: globalAlpha != null ? globalAlpha : 0.24,
      sources: bptUsed.map(function(b) {
        return { id: b.id, mw: b.mw, muYears: b.muYears, alpha: b.alpha,
                 elapsedYears: b.elapsedYears, horizonYears: b.horizonYears,
                 conditionalProb: b.conditionalProb, rRupKm: b.rRupKm, srcType: b.srcType };
      }),
      charSources: bptCharSummary,
      ucerf3Td: bptCharUsed ? {
        model: 'UCERF3-TD Field et al. 2015 Table 1 blend (participation level) + historic open interval from 1875',
        aperiodicityBlend: Physics.UCERF3_TD_APERIODICITY.weights
      } : null
    },
    diagnostics: {
      nCellsUsed: nCells, nMagnitudeBins: nBins, mStep: mStep, maxDistKm: maxDistKm, vs30: vs30,
      singleModel: isSa,
      nBptSources: bptUsed.length,
      nCharTdSources: bptCharUsed
    }
  };
};

/** Invert a hazard curve (descending rates over ascending imLevels) to the IM
 *  with annual exceedance rate `targetRate`, by log-linear interpolation.
 *  Returns null when the target lies outside the computed grid. */
Physics._pshaInvertCurve = function(imLevels, rates, targetRate) {
  if (!imLevels || imLevels.length < 2) return null;
  if (rates[0] < targetRate || rates[rates.length - 1] > targetRate) return null;
  for (var i = 1; i < rates.length; i++) {
    if (rates[i] <= targetRate) {
      var r0 = rates[i - 1], r1 = rates[i];
      if (r0 <= 0) return imLevels[i - 1];
      var f = r1 === r0 ? 0 : (Math.log(r0) - Math.log(targetRate)) / (Math.log(r0) - Math.log(r1));
      var x0 = Math.log10(imLevels[i - 1]), x1 = Math.log10(imLevels[i]);
      return Math.pow(10, x0 + f * (x1 - x0));
    }
  }
  return null;
};

/** Uniform hazard spectra at a site: for each return period (years) the
 *  Sa(T) whose mean annual exceedance rate is 1/RP. Period '0' is the PGA
 *  anchor from the pga curve. SA periods follow each class's branch models
 *  (Japan: the zhao2006 single-model collapse — no epistemic spread at SA;
 *  regional packs: the pack gmpeTree per class — crustal is the four-model
 *  NGA-West2 tree since v7.x (epistemic spread on crustal SA), subduction
 *  stays single-branch ngasub (documented limitation)). options: {periods?,
 *  vs30?, maxDistKm?, mStep?}.
 *  Returns {periodsSec, uhs: {rp: [gal...]}, pga: {rp: gal}, diagnostics}. */
Physics.uhs = function(sourceModel, site, returnPeriods, options) {
  options = options || {};
  var rps = (returnPeriods && returnPeriods.length ? returnPeriods : [475]).slice();
  var periodKeys = options.periods ||
    ['0.10', '0.20', '0.30', '0.50', '0.70', '1.00', '1.50', '2.00', '3.00', '5.00'];
  var periodsSec = periodKeys.map(function(k) { return parseFloat(k); });

  // timeDependent passthrough (v6.2 BPT UI batch): route every period's
  // engine call through hazardCurveTimeDependent (BPT renewal scenarios over
  // the Poisson background) and invert the equivalent-Poisson rate curves —
  // downstream RP inversion semantics unchanged. Flag off = the legacy
  // pure-Poisson path with identical call arguments (byte-compatible).
  var td = !!options.timeDependent;
  var engine = td ? Physics.hazardCurveTimeDependent : Physics.hazardCurve;
  var baseOpts = td
    ? { vs30: options.vs30, maxDistKm: options.maxDistKm, mStep: options.mStep,
        horizonYears: options.years, currentYear: options.currentYear, alpha: options.alpha }
    : { vs30: options.vs30, maxDistKm: options.maxDistKm, mStep: options.mStep };

  var pgaCurve = engine(sourceModel, site, 'pga', baseOpts);
  var pga = {};
  var curves = [];
  for (var pi = 0; pi < periodKeys.length; pi++) {
    curves.push(engine(sourceModel, site, 'sa:' + periodKeys[pi], baseOpts));
  }
  // string RP keys keep JSON round-trips exact
  var uhs = {};
  for (var rk = 0; rk < rps.length; rk++) {
    var t = 1 / rps[rk];
    uhs[String(rps[rk])] = curves.map(function(cv) {
      return Physics._pshaInvertCurve(cv.imLevels, cv.meanRate, t);
    });
  }
  var pgaOut = {};
  for (var rk2 = 0; rk2 < rps.length; rk2++) {
    pgaOut[String(rps[rk2])] = Physics._pshaInvertCurve(pgaCurve.imLevels, pgaCurve.meanRate, 1 / rps[rk2]);
  }
  return {
    periodsSec: periodsSec, uhs: uhs, pga: pgaOut, units: 'gal',
    vs30: pgaCurve.diagnostics.vs30,
    timeDependent: td,
    bptSources: td && pgaCurve.timeDependent ? pgaCurve.timeDependent.sources : undefined,
    diagnostics: {
      nCellsUsed: pgaCurve.diagnostics.nCellsUsed,
      nPeriods: periodKeys.length, singleModel: true,
      // v6.9/v7.x: regional packs drive SA through their own gmpeTree
      // (crustal = four-model NGA-West2 tree since v7.x, ngasub subduction);
      // Japan keeps the zhao single-model collapse. Subduction classes stay
      // single-model per class — no SA epistemic spread there.
      note: (sourceModel && sourceModel.gmpeTree)
        ? 'SA periods: regional gmpeTree (crustal NGA-West2 four-model tree at 0.25 each / ngasub subduction single branch); no epistemic spread on subduction SA'
        : 'SA periods: zhao2006 single model (si-mid/kanno publish no spectral rows); absolute level vs J-SHIS pending external gate'
    }
  };
};

/** Deaggregation of the MEAN hazard at `imt` around one conditioning IM
 *  level (v6.1 CS pipeline groundwork): contributions accumulated per
 *  (source class x 0.5-magnitude bin x Rrup distance bin) using exactly the
 *  hazardCurve bin/branch arithmetic (same GR bins, same equal-area Rrup
 *  proxy, same logic-tree-weighted CCDF mix), but evaluated at a single IM
 *  level. Each bin carries a rate-weighted representative geometry so
 *  downstream scenario sampling can replay the contributor.
 *
 *  The conditioning level is options.imTarget directly, or resolved by
 *  inverting the mean hazard curve at 1/options.returnPeriod (identical to
 *  the Physics.uhs anchor). Returns null when the inversion falls outside
 *  the computed IM grid.
 *
 *  Per-branch epsilon z = (log10(imTarget) - log10(median)) / sigmaLog10 is
 *  accumulated contribution-weighted, so bins.meanEps is the branch-mixed
 *  mean epsilon of that contributor; the top-level mean.eps is the overall
 *  mean epsilon (the value that enters a Baker conditional spectrum). */
Physics.deaggregate = function(sourceModel, site, imt, options) {
  options = options || {};
  var isSa = imt.slice(0, 3) === 'sa:';
  var imtKey = imt === 'pgv' ? 'pgv' : (isSa ? imt : 'pga');
  var vs30 = site && site.vs30 != null ? site.vs30 : (options.vs30 != null ? options.vs30 : 600);
  var maxDistKm = options.maxDistKm != null ? options.maxDistKm : 500;
  var mStep = options.mStep || 0.1;
  var imTarget = options.imTarget;
  if (!(imTarget > 0)) {
    var rp = options.returnPeriod;
    if (!(rp > 0)) return null;
    var anchorCurve = Physics.hazardCurve(sourceModel, site, imt, {
      vs30: vs30, maxDistKm: maxDistKm, mStep: mStep
    });
    imTarget = Physics._pshaInvertCurve(anchorCurve.imLevels, anchorCurve.meanRate, 1 / rp);
    if (!(imTarget > 0)) return null;
  }
  var logTarget = Math.log10(imTarget);

  var magBinW = 0.5;
  var rEdges = [0, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, Infinity];
  var bins = {};
  var classRate = { crustal: 0, interplate: 0, intraslab: 0 };
  var totalRate = 0;

  function binOf(srcType, mag, rRupKm) {
    var mk = Math.floor(mag / magBinW + 1e-9), rk = rEdges.length - 2;
    for (var i = 1; i < rEdges.length - 1; i++) {
      if (rRupKm < rEdges[i]) { rk = i - 1; break; }
    }
    var key = srcType + '|' + mk + '|' + rk;
    if (!bins[key]) {
      bins[key] = {
        srcType: srcType, magBin: mk, rBin: rk,
        magLo: mk * magBinW, magHi: (mk + 1) * magBinW,
        rLo: rEdges[rk], rHi: rEdges[rk + 1],
        rate: 0, epsSum: 0, magSum: 0, rSum: 0, depthSum: 0, latSum: 0, lngSum: 0
      };
    }
    return bins[key];
  }

  function accumulate(srcType, mag, rRupKm, depthKm, rate, lat, lng) {
    var branches = Physics._pshaBranchesFor(srcType, imtKey, sourceModel);
    var rake = Physics.PSHA_CLASS_RAKE[srcType] || 0;
    for (var bi = 0; bi < branches.length; bi++) {
      var motion = Physics._pshaBranchMotion(branches[bi].model, imtKey, srcType, mag, rRupKm, depthKm, vs30, rake, branches[bi].variant);
      if (!motion || !(motion.median > 0)) continue;
      var medLog = Math.log10(motion.median);
      var sig = motion.sigmaLog10;
      var z = (logTarget - medLog) / sig;
      var p = Physics.exceedanceProbability(motion.median, sig, imTarget);
      if (p <= 0) continue;
      var c = branches[bi].weight * rate * p;
      var bin = binOf(srcType, mag, rRupKm);
      bin.rate += c;
      bin.epsSum += c * z;
      bin.magSum += c * mag;
      bin.rSum += c * rRupKm;
      bin.depthSum += c * depthKm;
      bin.latSum += c * lat;
      bin.lngSum += c * lng;
      classRate[srcType] = (classRate[srcType] || 0) + c;
      totalRate += c;
    }
  }

  var mc = sourceModel.mc, mMin = sourceModel.mMin != null ? sourceModel.mMin : 5.0;
  var cells = sourceModel.cells || [];
  var nCells = 0;
  for (var ci = 0; ci < cells.length; ci++) {
    var c = cells[ci];
    var hd = Physics.haversineDist(site.lat, site.lng, c.lat, c.lng);
    if (hd > maxDistKm) continue;
    nCells++;
    var b = sourceModel.bValues[c.srcType];
    var mMax = (sourceModel.mMaxByClass || {})[c.srcType] || 7.5;
    if (!(b > 0) || !(c.rateMc > 0)) continue;
    var hypDist = Math.sqrt(hd * hd + c.depthKm * c.depthKm);
    var mLo = Math.ceil(mMin / mStep - 1e-9) * mStep;
    for (var m = mLo; m <= mMax + 1e-9; m += mStep) {
      var lam = c.rateMc * (Math.pow(10, -b * (m - mc)) - Math.pow(10, -b * (m + mStep - mc)));
      if (!(lam > 1e-9)) continue;
      var mm = Math.min(m + mStep / 2, mMax);
      var rRup = Physics._pshaPointRrup(hypDist, mm, c.srcType);
      accumulate(c.srcType, mm, rRup, c.depthKm, lam, c.lat, c.lng);
    }
  }

  var scenUsed = 0;
  var scenarios = sourceModel.scenarios || [];
  for (var si = 0; si < scenarios.length; si++) {
    var s = scenarios[si];
    var rRupS, depthS, slat, slng;
    if (s.patches && s.patches.length) {
      rRupS = Infinity; depthS = s.depthKm != null ? s.depthKm : 0;
      slat = 0; slng = 0;
      for (var pi = 0; pi < s.patches.length; pi++) {
        var p = s.patches[pi];
        var d3 = Math.sqrt(Math.pow(Physics.haversineDist(site.lat, site.lng, p[0], p[1]), 2) + p[2] * p[2]);
        if (d3 < rRupS) { rRupS = d3; slat = p[0]; slng = p[1]; }
      }
    } else {
      depthS = s.depthKm != null ? s.depthKm : 15;
      slat = s.lat != null ? s.lat : 0; slng = s.lng != null ? s.lng : 0;
      var hdS = Physics.haversineDist(site.lat, site.lng, slat, slng);
      rRupS = Physics._pshaPointRrup(Math.sqrt(hdS * hdS + depthS * depthS), s.mw, s.sourceType || 'crustal');
    }
    scenUsed++;
    accumulate(s.sourceType || 'crustal', s.mw, Math.max(rRupS, 0.1), depthS, s.ratePerYear, slat, slng);
  }

  // v3 packs (UCERF3 batch B): grid MFD nodes + characteristic sources
  Physics._pshaV3SourcesEach(sourceModel, site, maxDistKm, accumulate);

  if (!(totalRate > 0)) return null;
  var out = [];
  for (var key in bins) {
    var bb = bins[key];
    if (!(bb.rate > 0)) continue;
    out.push({
      srcType: bb.srcType, magBin: bb.magBin, rBin: bb.rBin,
      magLo: bb.magLo, magHi: bb.magHi, rLo: bb.rLo, rHi: bb.rHi === Infinity ? null : bb.rHi,
      rate: bb.rate, prob: bb.rate / totalRate,
      meanMag: bb.magSum / bb.rate, meanRrupKm: bb.rSum / bb.rate,
      meanDepthKm: bb.depthSum / bb.rate, meanEps: bb.epsSum / bb.rate,
      repr: { lat: bb.latSum / bb.rate, lng: bb.lngSum / bb.rate, depthKm: bb.depthSum / bb.rate, mw: bb.magSum / bb.rate, srcType: bb.srcType }
    });
  }
  out.sort(function(a, b2) { return b2.rate - a.rate; });
  var mean = { mw: 0, rRupKm: 0, eps: 0, depthKm: 0 };
  for (var oi = 0; oi < out.length; oi++) {
    var w = out[oi].prob;
    mean.mw += w * out[oi].meanMag;
    mean.rRupKm += w * out[oi].meanRrupKm;
    mean.eps += w * out[oi].meanEps;
    mean.depthKm += w * out[oi].meanDepthKm;
  }
  var classShares = {};
  for (var cls in classRate) {
    if (classRate[cls] > 0) classShares[cls] = classRate[cls] / totalRate;
  }
  return {
    imt: imtKey, imTarget: imTarget,
    totalRate: totalRate, mean: mean, classShares: classShares, bins: out,
    rEdgesKm: rEdges.slice(0, rEdges.length - 1).concat([null]),
    diagnostics: {
      nCellsUsed: nCells, nScenarios: scenUsed, mStep: mStep,
      maxDistKm: maxDistKm, vs30: vs30, magBinW: magBinW, nBins: out.length,
      note: 'mean-curve deaggregation (logic-tree-weighted branch mix); bins carry rate-weighted representative geometries for scenario replay'
    }
  };
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
  if (model === 'bssa14') {
    // BSSA14 phi is magnitude/distance/site dependent (Eqs. 13-17); the
    // single-value display sigma is evaluated at the documented
    // representative condition (Rjb 60 km, Vs30 400 m/s) and the caller's
    // magnitude. Station-aware sigma needs Physics.bssa2014Sigma directly.
    // v6.9: 'sa:T' imts read the per-period tau/phi columns.
    var bImt = imt === 'pgv' ? 'pgv' : (imt.slice(0, 3) === 'sa:' ? imt.slice(3) : 'pga');
    var bs = Physics.bssa2014Sigma(bImt, mw == null ? 7.0 : mw, 60, 400);
    return bs ? bs.sigmaT : Physics.bssa2014Sigma('pga', mw == null ? 7.0 : mw, 60, 400).sigmaT;
  }
  if (model === 'cy14' || model === 'cb14' || model === 'ask14') {
    // v7.x NGA-West2 branches: same representative convention (Rjb 60 km,
    // Vs30 400 m/s, depth 10 km, crustal dip prior 60, class rake);
    // station-aware sigma needs the per-model Sigma function directly.
    var wImt = imt === 'pgv' ? 'pgv' : (imt.slice(0, 3) === 'sa:' ? imt.slice(3) : 'pga');
    var wGeom = Physics.nw2PointGeom(mw == null ? 7.0 : mw, 60, 10, 400, Physics.PSHA_CLASS_RAKE[srcType] || 0, 60);
    var ws = model === 'cy14' ? Physics.cy2014Sigma(wImt, wGeom.mw, wGeom)
      : (model === 'cb14' ? Physics.cb2014Sigma(wImt, wGeom) : Physics.ask2014Sigma(wImt, wGeom));
    if (!ws) ws = model === 'cy14' ? Physics.cy2014Sigma('pga', wGeom.mw, wGeom)
      : (model === 'cb14' ? Physics.cb2014Sigma('pga', wGeom) : Physics.ask2014Sigma('pga', wGeom));
    return ws.sigmaT;
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
  if (model === 'bssa14') {
    // Representative condition (Rjb 60 km, Vs30 400 m/s) — see getGmpSigma.
    // v6.9: 'sa:T' imts read the per-period tau/phi columns.
    var bImtC = imt === 'pgv' ? 'pgv' : (imt.slice(0, 3) === 'sa:' ? imt.slice(3) : 'pga');
    var b = Physics.bssa2014Sigma(bImtC, mw == null ? 7.0 : mw, 60, 400) ||
            Physics.bssa2014Sigma('pga', mw == null ? 7.0 : mw, 60, 400);
    return { model:model, tau:b.tau, phi:b.phi, sigmaT:b.sigmaT, unit:'log10' };
  }
  if (model === 'ngasub') {
    // Same representative convention (Rrup 60 km, Vs30 400 m/s); 'sa:T' imts
    // read the per-period sigma rows.
    var nImt = imt === 'pgv' ? 'pgv' : (imt.slice(0, 3) === 'sa:' ? imt.slice(3) : 'pga');
    var n = Physics.parker2022Sigma(nImt, 60, 400) || Physics.parker2022Sigma('pga', 60, 400);
    return { model:model, tau:n.tau, phi:n.phi, sigmaT:n.sigmaT, unit:'log10' };
  }
  if (model === 'cy14' || model === 'cb14' || model === 'ask14') {
    // Same representative convention as bssa14 (Rjb 60 km, Vs30 400 m/s).
    var wImtC = imt === 'pgv' ? 'pgv' : (imt.slice(0, 3) === 'sa:' ? imt.slice(3) : 'pga');
    var wGeomC = Physics.nw2PointGeom(mw == null ? 7.0 : mw, 60, 10, 400, Physics.PSHA_CLASS_RAKE[srcType] || 0, 60);
    var wc = model === 'cy14' ? (Physics.cy2014Sigma(wImtC, wGeomC.mw, wGeomC) || Physics.cy2014Sigma('pga', wGeomC.mw, wGeomC))
      : (model === 'cb14' ? (Physics.cb2014Sigma(wImtC, wGeomC) || Physics.cb2014Sigma('pga', wGeomC))
        : (Physics.ask2014Sigma(wImtC, wGeomC) || Physics.ask2014Sigma('pga', wGeomC)));
    return { model:model, tau:wc.tau, phi:wc.phi, sigmaT:wc.sigmaT, unit:'log10' };
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
// Long-period basin factor (v5.7 R3-3): band-averaged SH transfer of the
// JIVSM station column (1.6-7.8 s) relative to its own 3 Hz anchor — the
// soft-basin long-period amplification the Vs30 scalar path cannot carry
// (R2 leftover: Kanto/Osaka 2-4 s boost). Null when no registry/column.
Physics.lpcmBasinFactor = function(lat, lng) {
  var col = Physics.jivsmColumnAt(lat, lng);
  if (!col || col.length < 2) return null;
  var profile = [];
  for (var i = 0; i < col.length; i++) {
    profile.push({ vs: col[i].vs / 1000, thickness: (col[i].bottomM - col[i].topM) / 1000 });
  }
  var freqs = [3.0];
  for (var T = 1.6; T <= 7.8 + 1e-9; T += 0.2) freqs.push(1 / T);
  var tf = Physics.shTransferFunction(profile, freqs);
  if (!tf) return null;
  for (var k = 0; k < tf.length; k++) if (!isFinite(tf[k]) || tf[k] < 0) return null;
  var band = 0;
  for (var j = 1; j < tf.length; j++) band += tf[j];
  band /= (tf.length - 1);
  if (!(tf[0] > 0)) return null;
  var ratio = band / tf[0];
  // keep the factor inside a physical band (thin-column noise, resonance
  // extremes) — the LPCM classes span factors of ~4 per class
  return Math.max(0.5, Math.min(2.5, ratio));
};

Physics.calcLongPeriodSv = function(mag, distKm, pga, opts) {
  var out = { svCms: 0, lpcClass: 0, peakPeriod: 0 };
  if (!(pga > 0) || !(mag > 0)) return out;
  var d = Math.max(1, distKm || 1);
  // v5.7 R3-3: regional Q0 from the caller's coordinates (default 200 keeps
  // the legacy spectrum when no coords are provided)
  var q0 = 200;
  var basin = null;
  if (opts && opts.lat != null && opts.lng != null) {
    q0 = Physics.lookupQ0(opts.lat, opts.lng);
    basin = Physics.lpcmBasinFactor(opts.lat, opts.lng);
  }
  var aRef = Physics.fullSpectrum(3.0, mag, d, 10, 1, q0, 0.7);
  if (!(aRef > 0)) return out;
  var maxSv = 0, maxT = 0;
  for (var T = 1.6; T <= 7.8 + 1e-9; T += 0.2) {
    var aF = Physics.fullSpectrum(1 / T, mag, d, 10, 1, q0, 0.7);
    var sv = Physics.LPCM_RESP_FACTOR * pga * (aF / aRef) * T / (2 * Math.PI);
    if (basin) sv *= basin;
    if (sv > maxSv) { maxSv = sv; maxT = T; }
  }
  var cls = 0, th = Physics.LPCM_THRESHOLDS_CMS;
  for (var ci = 0; ci < th.length; ci++) { if (maxSv >= th[ci]) cls = ci + 1; }
  out.svCms = maxSv; out.lpcClass = cls; out.peakPeriod = +maxT.toFixed(1);
  return out;
};

// Station-level class (map L1-L4 label, popup, info panel, CSV). Site enters
// via the already site-amplified PGA; soilAmpVal stays for signature parity.
Physics.calcLPGM = function(mag, R, pga, soilAmpVal, opts) {
  return Physics.calcLongPeriodSv(mag, R, pga, opts).lpcClass;
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

// JMA Shindo → Chinese seismic intensity (GB/T 17742, 12-degree CSIS).
// Approximate alignment through the 12-degree equivalence with MMI (both span
// I-XII with broadly similar PGA anchors); JMA 7 maps to XI — XII is the
// near-total-destruction degree and is deliberately unreachable from
// instrumental shindo (documented approximation, same spirit as shindoToMMI).
Physics.SHINDO_TO_CSIS = {0:1, 1:2, 2:4, 3:5, 4:6, '5-':7, '5+':8, '6-':9, '6+':10, 7:11, 5:7, 6:9};
Physics.shindoToCsis = function(shindo) {
  if (typeof shindo === 'number') shindo = Physics.shindoLabel(shindo);
  return Physics.SHINDO_TO_CSIS[shindo] != null ? Physics.SHINDO_TO_CSIS[shindo] : shindo;
};

// v4.2: Convert a shindo value to the configured intensity scale for display
Physics.convertIntensity = function(shindo, scale) {
  if (!scale || scale === 'shindo') return shindo;
  if (scale === 'mmi') return Physics.shindoToMMI(shindo);
  if (scale === 'ems98') return Physics.shindoToEMS(shindo);
  if (scale === 'csis') return Physics.shindoToCsis(shindo);
  return shindo;
};

// v6.4 region Vs30: bilinear sample of a quake-sim-region-vs30-v1 package
// (built per region, e.g. California from Yong et al. 2014). Corners coded
// nodata (0, offshore/water) drop out of the bilinear blend with renormalized
// weights; an all-nodata footprint or an out-of-grid point returns null — the
// caller keeps its honest 500 m/s default-estimate fallback. Exported pure
// for node tests.
Physics.regionVs30Sample = function (pack, lat, lng) {
  if (!pack || pack._schema !== 'quake-sim-region-vs30-v1' || !pack.data) return null;
  var nx = pack.nx | 0, ny = pack.ny | 0, res = +pack.res;
  if (!nx || !ny || !(res > 0)) return null;
  var data = pack.data, lat0 = +pack.origin[1], lng0 = +pack.origin[0];
  var fx = (lng - lng0) / res, fy = (lat - lat0) / res;
  if (!isFinite(fx) || !isFinite(fy)) return null;
  var x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= nx || y0 + 1 >= ny) return null;
  var tx = fx - x0, ty = fy - y0;
  var i00 = y0 * nx + x0, i10 = i00 + 1, i01 = i00 + nx, i11 = i01 + 1;
  var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  var sum = 0, wsum = 0;
  var corners = [[i00, w00], [i10, w10], [i01, w01], [i11, w11]];
  for (var k = 0; k < 4; k++) {
    var v = data[corners[k][0]];
    if (v != null && v > 0 && isFinite(v)) { sum += v * corners[k][1]; wsum += corners[k][1]; }
  }
  if (wsum <= 0) return null;
  return Math.round((sum / wsum) * 10) / 10;
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
// v6.2 tier-2: down-dip row anchors for listric planes (dip decreasing with
// depth). Returns cumulative {depth, horiz} offsets at each row BOUNDARY
// (j*dW steps) using the local dip of the row below each boundary. With
// amount == 0 the anchors reduce exactly to the closed-form j*dW*(sin,cos)
// values, so the default path stays byte-identical to the legacy geometry.
Physics.dipRowAnchors = function(dipDeg, listricAmountDeg, W, nDip) {
  var dW = W / Math.max(1, nDip);
  var amount = Math.max(0, Math.min(60, Number(listricAmountDeg) || 0));
  var rows = [{ depth: 0, horiz: 0 }];
  var depth = 0, horiz = 0;
  for (var j = 0; j < nDip; j++) {
    var dipEff = (dipDeg - amount * ((j + 0.5) / nDip)) * Math.PI / 180;
    dipEff = Math.max(0.05, Math.min(89.95, dipEff));
    depth += dW * Math.sin(dipEff);
    horiz += dW * Math.cos(dipEff);
    rows.push({ depth: depth, horiz: horiz });
  }
  return rows;
};

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

  var listric = Math.max(0, Math.min(60, Number(opts.listricDipDeg) || 0));
  var rowAnchors = Physics.dipRowAnchors(dip, listric, W, nDip);
  // interpolate the cumulative listric anchors at an arbitrary down-dip offset
  function downDipOffsets(downDip) {
    if (listric <= 0) return { depth: downDip * sinDip, horiz: downDip * cosDip };
    var dWl = W / nDip;
    var jf = Math.max(0, Math.min(nDip, downDip / dWl));
    var j0 = Math.min(nDip - 1, Math.floor(jf)), f = jf - j0;
    var a0 = rowAnchors[j0], a1 = rowAnchors[j0 + 1];
    return { depth: a0.depth + f * (a1.depth - a0.depth), horiz: a0.horiz + f * (a1.horiz - a0.horiz) };
  }
  function point(alongStrike, downDip) {
    var dd = downDipOffsets(downDip);
    var dLat = alongStrike * Math.cos(strikeRad) / 111.32
      + dd.horiz * Math.cos(dipDirRad) / 111.32;
    var dLng = alongStrike * Math.sin(strikeRad) / (111.32 * cosLat)
      + dd.horiz * Math.sin(dipDirRad) / (111.32 * cosLat);
    return {lat: lat + dLat, lng: lng + dLng, depth: depthKm + dd.depth};
  }
  function leafletPoint(alongStrike, downDip) {
    var p = point(alongStrike, downDip);
    return [p.lat, p.lng];
  }

  return {
    lat: lat, lng: lng, mw: mw, depth: depthKm, sourceType: sourceType,
    strikeDeg: strikeDeg, dipDeg: dip, listricDipDeg: listric, L: L, W: W, nominalW: nominalW,
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
  var listricR = Math.max(0, Math.min(60, Number(geom.listricDipDeg) || 0));
  var rowAnchorsR = Physics.dipRowAnchors(dip, listricR, W, Math.max(1, Math.round(W / (Number(geom.targetPatchKm) || 14))));
  function point(alongStrike, downDip) {
    var dipHoriz = downDip * cosDip;
    var depthOff = downDip * sinDip;
    if (listricR > 0) {
      var nR = rowAnchorsR.length - 1;
      var jfR = Math.max(0, Math.min(nR, downDip / (W / nR)));
      var j0R = Math.min(nR - 1, Math.floor(jfR)), fR = jfR - j0R;
      dipHoriz = rowAnchorsR[j0R].horiz + fR * (rowAnchorsR[j0R + 1].horiz - rowAnchorsR[j0R].horiz);
      depthOff = rowAnchorsR[j0R].depth + fR * (rowAnchorsR[j0R + 1].depth - rowAnchorsR[j0R].depth);
    }
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
//  Rjb (JOYNER-BOORE) DISTANCE — v6.7 NGA-West2 batch
// ================================================================
// Horizontal distance to the rupture's SURFACE PROJECTION (0 when the
// station sits inside it). BSSA14's native metric; the planar branch mirrors
// the rrupDistance fault frame (x along strike, y along dip, top/bottom
// down-dip offsets times cos(dip) become the projected strip), and the
// imported-finite-fault branch takes the min over patch surface-projection
// quads in a station-local equirectangular km frame.
function _rjbLocalKm(refLat, refLng, lat, lng) {
  var cosLat = Math.max(0.2, Math.cos(refLat * Math.PI / 180));
  return [(lng - refLng) * 111.32 * cosLat, (lat - refLat) * 111.32];
}
function _rjbPointSegSq(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay, den = dx * dx + dy * dy;
  var t = den > 0 ? Math.max(0, Math.min(1, -((ax - px) * dx + (ay - py) * dy) / den)) : 0;
  var cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}
Physics.rjbDistance = function(staLat, staLng, faultParams) {
  var fp = faultParams || {};
  if (fp.kind === 'imported-finite-fault' && fp.subs && fp.subs.length) {
    var bestSq = Infinity;
    for (var i = 0; i < fp.subs.length; i++) {
      var corners = fp.subs[i].corners;
      if (!corners || corners.length < 4) continue;
      // station-local km frame; each patch quad projected to the surface
      var pts = [];
      for (var k = 0; k < 4; k++) pts.push(_rjbLocalKm(staLat, staLng, corners[k].lat, corners[k].lng));
      var pos = 0, neg = 0;
      for (var e = 0; e < 4; e++) {
        var a = pts[e], b = pts[(e + 1) % 4];
        var cross = (b[0] - a[0]) * -a[1] - (b[1] - a[1]) * -a[0];
        if (cross > 0) pos++; else if (cross < 0) neg++;
      }
      if (pos === 0 || neg === 0) return 0; // inside this patch's projection
      for (var e2 = 0; e2 < 4; e2++) {
        bestSq = Math.min(bestSq, _rjbPointSegSq(0, 0, pts[e2][0], pts[e2][1], pts[(e2 + 1) % 4][0], pts[(e2 + 1) % 4][1]));
      }
    }
    if (isFinite(bestSq)) return Math.sqrt(bestSq);
    return Physics.haversineDist(fp.lat, fp.lng, staLat, staLng);
  }
  var distKm = Physics.haversineDist(fp.lat, fp.lng, staLat, staLng);
  var dLat = (staLat - fp.lat) * Math.PI / 180;
  var dLng = (staLng - fp.lng) * Math.PI / 180;
  var y = Math.sin(dLng) * Math.cos(staLat * Math.PI / 180);
  var x = Math.cos(fp.lat * Math.PI / 180) * Math.sin(staLat * Math.PI / 180)
        - Math.sin(fp.lat * Math.PI / 180) * Math.cos(staLat * Math.PI / 180) * Math.cos(dLng);
  var bearing = Math.atan2(y, x);
  var srRad = fp.strikeDeg * Math.PI / 180;
  var dipRad = fp.dipDeg * Math.PI / 180;
  var xS = distKm * Math.cos(bearing - srRad);
  var yS = distKm * Math.sin(bearing - srRad);
  var topOffset = fp.topOffset != null ? fp.topOffset
    : -(fp.hypocenterFrac != null ? fp.hypocenterFrac : 0.35) * fp.W;
  var bottomOffset = fp.bottomOffset != null ? fp.bottomOffset : topOffset + fp.W;
  var cosDip = Math.cos(dipRad);
  var yLo = Math.min(topOffset, bottomOffset) * cosDip;
  var yHi = Math.max(topOffset, bottomOffset) * cosDip;
  var xStar = Math.max(-fp.L / 2, Math.min(fp.L / 2, xS));
  var yStar = Math.max(yLo, Math.min(yHi, yS));
  var ddx = xStar - xS, ddy = yStar - yS;
  return Math.sqrt(ddx * ddx + ddy * ddy);
};

// ================================================================
//  2D FINITE FAULT SUBSOURCE GRID
// ================================================================

Physics.genSubSources = function(la, ln, m, strikeDeg, dipDeg, depthKm, rupSpeed, opts) {
  opts = opts || {};
  var listricOpt = opts.listricDipDeg != null ? opts.listricDipDeg
    : ((typeof cfgGet === 'function') ? cfgGet('faultListricDip') : 0);
  var geoOpts = opts;
  if (listricOpt) {
    geoOpts = {};
    for (var lk in opts) geoOpts[lk] = opts[lk];
    geoOpts.listricDipDeg = listricOpt;
  }
  var geometry = Physics.buildFaultGeometry(la, ln, m, strikeDeg, dipDeg, depthKm, geoOpts);
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
  // change with mesh resolution and produced a salt-and-pepper rupture. The
  // field is synthesized as a FIXED cosine sum over a wavenumber grid and
  // evaluated at the patches' normalized coordinates — a continuous function,
  // so refining the mesh samples the same field (mesh-independent).
  // v6.2 tier-1 upgrade: Mai & Beroza (2002)-style anisotropic von Kármán
  // spectrum — amplitude ∝ (1+(kx·a_x)²+(ky·a_y)²)^-(H+1)/2 with Hurst H=0.75,
  // along-strike correlation (a_x=0.50, fraction of L) longer than down-dip
  // (a_y=0.22, fraction of W), replacing the old 10-mode k^-1.3 sketch.
  var perturbModes = [];
  var perturbNorm = 0;
  var VK_HURST = 0.75, VK_AX = 0.50, VK_AY = 0.22;
  for (var pkx = 0; pkx <= 6; pkx++) {
    for (var pky = 0; pky <= 6; pky++) {
      if (pkx === 0 && pky === 0) continue; // no DC — the asperity carries the mean
      var kDen = 1 + (pkx / VK_AX) * (pkx / VK_AX) + (pky / VK_AY) * (pky / VK_AY);
      var kAmp = Math.pow(kDen, -(VK_HURST + 1) / 2);
      perturbModes.push({ kx: pkx, ky: pky, phase: 2 * Math.PI * perturbRand(), amp: kAmp });
      perturbNorm += kAmp;
    }
  }
  function correlatedPerturb(x, y) {
    var value = 0;
    for (var pmi = 0; pmi < perturbModes.length; pmi++) {
      var mode = perturbModes[pmi];
      value += mode.amp * Math.cos(2 * Math.PI * (mode.kx * x + mode.ky * y) + mode.phase);
    }
    return perturbNorm > 0 ? value / perturbNorm : 0;
  }
  function edgeTaper(i, j) {
    var tx=Math.sin(Math.PI*(i+0.5)/nStrike), ty=Math.sin(Math.PI*(j+0.5)/nDip);
    return Math.pow(Math.max(0.001,tx*ty),0.55);
  }
  var aspList = (opts && opts.aspList && opts.aspList.length) ? opts.aspList : null;
  // Shallow slip deficit (v6.2 tier-1): near-surface slip impoverishment of
  // large thrust ruptures (creep/SSD literature convention). Factor
  // 1 − ssd·exp(−d/0.22): strongest at the top edge, e-folding over ~22% of
  // the down-dip width; moment stays conserved through the wSum normalisation.
  var ssd = opts.shallowSlipDeficit != null ? Number(opts.shallowSlipDeficit)
    : ((typeof cfgGet === 'function') ? Number(cfgGet('shallowSlipDeficit')) : 0);
  ssd = Math.max(0, Math.min(0.85, isFinite(ssd) ? ssd : 0));
  if (aspList) {
    for (var i = 0; i < nStrike; i++) {
      for (var j = 0; j < nDip; j++) {
        var w = 0.5; // baseline
        for (var ai = 0; ai < aspList.length; ai++) {
          var a = aspList[ai];
          var ci = (nStrike - 1) * (a.sFrac != null ? a.sFrac : 0.5);
          var cj = (nDip - 1) * (a.dFrac != null ? a.dFrac : 0.5);
          var di2 = (i - ci) / aspSigmaI, dj2 = (j - cj) / aspSigmaJ;
          w += (a.weight != null ? a.weight : 1) * Math.exp(-(di2 * di2 + dj2 * dj2) / 2);
        }
        w *= edgeTaper(i,j) * Math.exp(perturbation * correlatedPerturb((i+0.5)/nStrike, (j+0.5)/nDip));
        if (ssd > 0) w *= 1 - ssd * Math.exp(-((j + 0.5) / nDip) / 0.22);
        rawWeights.push(w); wSum += w;
      }
    }
  } else {
    for (var i = 0; i < nStrike; i++) {
      for (var j = 0; j < nDip; j++) {
        var di = (i - aspI) / aspSigmaI, dj = (j - aspJ) / aspSigmaJ;
        var w = 0.5 + 1.3 * Math.exp(-(di * di + dj * dj) / 2); // range ~0.5 to 1.8
        w *= edgeTaper(i,j) * Math.exp(perturbation * correlatedPerturb((i+0.5)/nStrike, (j+0.5)/nDip));
        if (ssd > 0) w *= 1 - ssd * Math.exp(-((j + 0.5) / nDip) / 0.22);
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

// v6.2 tier-2 — segmented bent faults for custom scenarios. A surface-trace
// polyline (>= 2 nodes) becomes a chain of connected rectangular planes:
// per-segment strike from the node bearings (or explicit), per-segment dip,
// ONE continuous von Kármán slip field over the global along-strike
// coordinate (no artificial cliff at bends — the edge taper only applies at
// the two chain ENDS and the down-dip edges), rupture times from true 3D
// distances to the hypocentre, listric per segment. Consumers (renderer,
// 3-D view, GMPE patch path, rupture card) read the same subs/cellCorner
// contract as planar geometries.
Physics.genSegmentedFault = function(nodes, mw, opts) {
  opts = opts || {};
  if (!Array.isArray(nodes) || nodes.length < 2) return null;
  if (!(mw >= 6.5)) return null;
  var P = Physics;
  var sourceType = opts.sourceType || 'crustal';
  var dims = P.faultDimensions(mw, sourceType);
  var nominalW = opts.widthKm != null ? Number(opts.widthKm) : dims.W;
  if (!(nominalW > 1)) return null;
  var rigidityGPa = Number(opts.rigidityGPa);
  if (!(rigidityGPa > 0)) rigidityGPa = sourceType === 'intraslab' ? 50 : (sourceType === 'interplate' ? 40 : 30);

  // ---- segment frame: strike + length + dip per node-to-node leg ----
  var segs = [];
  for (var k = 0; k < nodes.length - 1; k++) {
    var a = nodes[k], b = nodes[k + 1];
    var alat = Number(a.lat), alng = Number(a.lng), blat = Number(b.lat), blng = Number(b.lng);
    if (!isFinite(alat) || !isFinite(alng) || !isFinite(blat) || !isFinite(blng)) return null;
    var lenKm = Number(a.lengthKm);
    if (!(lenKm > 0)) lenKm = P.haversineDist(alat, alng, blat, blng);
    if (!(lenKm > 1)) continue; // degenerate leg (duplicate node) — skip it
    var strike;
    if (a.strikeDeg != null) strike = Number(a.strikeDeg);
    else strike = P.bearingRad(alat, alng, blat, blng) * 180 / Math.PI;
    var dip = Number(a.dipDeg != null ? a.dipDeg : opts.dipDeg);
    if (!isFinite(dip)) dip = 60;
    dip = Math.max(0.1, Math.min(90, dip));
    var rake = Number(a.rakeDeg != null ? a.rakeDeg : (opts.rakeDeg != null ? opts.rakeDeg : 90));
    segs.push({ lat: alat, lng: alng, strikeDeg: strike, dipDeg: dip, rakeDeg: rake, lenKm: lenKm, listric: Number(opts.listricDipDeg) || 0 });
  }
  var L = segs.reduce(function (s2, g) { return s2 + g.lenKm; }, 0);
  if (!(L > 2)) return null;

  // ---- grid: global nStrike proportional to leg length, shared nDip ----
  var targetPatchKm = Math.max(10, Math.min(16, Number(opts.targetPatchKm) || 14));
  var nStrikeTotal = Math.min(72, Math.max(6, Math.ceil(L / targetPatchKm)));
  var nDip = Math.min(20, Math.max(3, Math.ceil(nominalW / targetPatchKm)));
  var nStrikeAssigned = 0;
  for (k = 0; k < segs.length; k++) {
    var nS = (k === segs.length - 1)
      ? Math.max(2, nStrikeTotal - nStrikeAssigned)
      : Math.max(2, Math.round(segs[k].lenKm / L * nStrikeTotal));
    if (k < segs.length - 1) nStrikeAssigned += nS;
    segs[k].nStrike = nS;
  }
  nStrikeTotal = segs.reduce(function (s2, g) { return s2 + g.nStrike; }, 0);

  // ---- depths: uniform top edge + per-segment listric anchors ----
  var depthKm = Number(opts.depthKm);
  if (!isFinite(depthKm)) depthKm = Math.max(10, 0.35 * nominalW);
  var hpFrac = 0.35;
  var topDepth = Number(opts.topDepthKm);
  if (!isFinite(topDepth)) {
    topDepth = sourceType === 'interplate' ? 2 : Math.max(1, depthKm - 0.35 * nominalW);
  }
  topDepth = Math.min(topDepth, depthKm - 0.5);
  for (k = 0; k < segs.length; k++) {
    segs[k].anchors = P.dipRowAnchors(segs[k].dipDeg, segs[k].listric, nominalW, nDip);
  }

  // ---- ONE continuous slip field on the global normalized coordinates ----
  var perturbation = opts.slipPerturbation != null ? Number(opts.slipPerturbation)
    : ((typeof cfgGet === 'function') ? Number(cfgGet('slipPerturbation')) : 0.4);
  perturbation = Math.max(0, Math.min(1, isFinite(perturbation) ? perturbation : 0));
  var seedBase = (Number(opts.randomSeed) || 0) >>> 0;
  var perturbSeed = (Math.floor(Math.abs(nodes[0].lat * 1000 + nodes[0].lng * 100 + mw * 1000)) ^ seedBase) >>> 0;
  function perturbRand() { perturbSeed = (1664525 * perturbSeed + 1013904223) >>> 0; return perturbSeed / 4294967296; }
  var VK_HURST = 0.75, VK_AX = 0.50, VK_AY = 0.22;
  var perturbModes = [], perturbNorm = 0;
  for (var pkx = 0; pkx <= 6; pkx++) {
    for (var pky = 0; pky <= 6; pky++) {
      if (pkx === 0 && pky === 0) continue;
      var kDen = 1 + (pkx / VK_AX) * (pkx / VK_AX) + (pky / VK_AY) * (pky / VK_AY);
      var kAmp = Math.pow(kDen, -(VK_HURST + 1) / 2);
      perturbModes.push({ kx: pkx, ky: pky, phase: 2 * Math.PI * perturbRand(), amp: kAmp });
      perturbNorm += kAmp;
    }
  }
  function correlatedPerturb(x, y) {
    var value = 0;
    for (var pmi = 0; pmi < perturbModes.length; pmi++) {
      var mode = perturbModes[pmi];
      value += mode.amp * Math.cos(2 * Math.PI * (mode.kx * x + mode.ky * y) + mode.phase);
    }
    return perturbNorm > 0 ? value / perturbNorm : 0;
  }
  // global edge taper: chain ENDS only + down-dip edges (continuous through bends)
  function edgeTaperGlobal(iGlobal, j) {
    var tx = Math.sin(Math.PI * (iGlobal + 0.5) / nStrikeTotal);
    var ty = Math.sin(Math.PI * (j + 0.5) / nDip);
    return Math.pow(Math.max(0.001, tx * ty), 0.55);
  }
  var aspList = (opts.aspList && opts.aspList.length) ? opts.aspList : null;
  var aspSigmaI = nStrikeTotal * 0.35, aspSigmaJ = nDip * 0.4;
  var ssd = opts.shallowSlipDeficit != null ? Number(opts.shallowSlipDeficit)
    : ((typeof cfgGet === 'function') ? Number(cfgGet('shallowSlipDeficit')) : 0);
  ssd = Math.max(0, Math.min(0.85, isFinite(ssd) ? ssd : 0));

  // ---- hypocentre: patch nearest to a global along-fraction (default 0.35) ----
  var hypoFrac = opts.hypoAlongFrac != null ? Math.max(0.02, Math.min(0.98, opts.hypoAlongFrac)) : 0.35;
  var hypoDipFrac = opts.hypoDipFrac != null ? Math.max(0.05, Math.min(0.95, opts.hypoDipFrac)) : 0.35;
  var hypoIndexGlobal = Math.floor(hypoFrac * (nStrikeTotal - 1));

  // ---- patch synthesis ----
  var totalMoment = P.seismicMoment(mw);
  var rupSpeed = Math.max(0.5, Number(opts.rupSpeed) || 2.8);
  var velocityModel = opts.ruptureVelocityModel || 'slip-depth';
  var sourceTimeFunction = opts.sourceTimeFunction || 'half-cosine';
  var subs = [], rawWeights = [], wSum = 0;
  var iGlobal = 0;
  var patchFrames = []; // per global strike row: segment + local row geometry for cellCorner
  for (k = 0; k < segs.length; k++) {
    var seg = segs[k];
    var dL = seg.lenKm / seg.nStrike;
    var strikeRad = seg.strikeDeg * Math.PI / 180;
    var dipDirRad = strikeRad + Math.PI / 2;
    var cosLat = Math.max(0.0001, Math.cos(seg.lat * Math.PI / 180));
    function segPoint(alongKm, dipFracRow) {
      // interpolate the segment's listric anchors at fractional down-dip
      var jf = Math.max(0, Math.min(nDip, dipFracRow));
      var j0 = Math.min(nDip - 1, Math.floor(jf)), f = jf - j0;
      var a0 = seg.anchors[j0], a1 = seg.anchors[j0 + 1];
      var horiz = a0.horiz + f * (a1.horiz - a0.horiz);
      var depthOff = a0.depth + f * (a1.depth - a0.depth);
      var dLat = alongKm * Math.cos(strikeRad) / 111.32 + horiz * Math.cos(dipDirRad) / 111.32;
      var dLng = alongKm * Math.sin(strikeRad) / (111.32 * cosLat) + horiz * Math.sin(dipDirRad) / (111.32 * cosLat);
      return { lat: seg.lat + dLat, lng: seg.lng + dLng, depth: topDepth + depthOff, horiz: horiz };
    }
    for (var is = 0; is < seg.nStrike; is++, iGlobal++) {
      var alongKm = (is + 0.5) * dL;
      patchFrames.push({ seg: k, alongKm: alongKm, dL: dL });
      for (var j = 0; j < nDip; j++) {
        var xG = (iGlobal + 0.5) / nStrikeTotal;
        var yG = (j + 0.5) / nDip;
        var w;
        if (aspList) {
          w = 0.5;
          for (var ai = 0; ai < aspList.length; ai++) {
            var aa = aspList[ai];
            var ci = (nStrikeTotal - 1) * (aa.sFrac != null ? aa.sFrac : 0.5);
            var cj = (nDip - 1) * (aa.dFrac != null ? aa.dFrac : 0.5);
            var d2 = (iGlobal - ci) / aspSigmaI, e2 = (j - cj) / aspSigmaJ;
            w += (aa.weight != null ? aa.weight : 1) * Math.exp(-(d2 * d2 + e2 * e2) / 2);
          }
        } else {
          var ci2 = (nStrikeTotal - 1) * 0.55, cj2 = (nDip - 1) * 0.6;
          var di3 = (iGlobal - ci2) / aspSigmaI, dj3 = (j - cj2) / aspSigmaJ;
          w = 0.5 + 1.3 * Math.exp(-(di3 * di3 + dj3 * dj3) / 2);
        }
        w *= edgeTaperGlobal(iGlobal, j) * Math.exp(perturbation * correlatedPerturb(xG, yG));
        if (ssd > 0) w *= 1 - ssd * Math.exp(-yG / 0.22);
        rawWeights.push(w); wSum += w;
      }
    }
  }

  // hypocentre 3D position (approximated at its patch centre)
  function patchPos(iG, jG) {
    var pf = patchFrames[iG], sg = segs[pf.seg];
    var step = nominalW / nDip;
    return segPosOf(sg, pf.alongKm, (jG + 0.5) * step);
  }
  function segPosOf(sg, alongKm, downDip) {
    var strikeRad2 = sg.strikeDeg * Math.PI / 180;
    var dipDirRad2 = strikeRad2 + Math.PI / 2;
    var jf = Math.max(0, Math.min(nDip, downDip / (nominalW / nDip)));
    var j0 = Math.min(nDip - 1, Math.floor(jf)), f = jf - j0;
    var a0 = sg.anchors[j0], a1 = sg.anchors[j0 + 1];
    var horiz = a0.horiz + f * (a1.horiz - a0.horiz);
    var depthOff = a0.depth + f * (a1.depth - a0.depth);
    var cosLat2 = Math.max(0.0001, Math.cos(sg.lat * Math.PI / 180));
    var dLat = alongKm * Math.cos(strikeRad2) / 111.32 + horiz * Math.cos(dipDirRad2) / 111.32;
    var dLng = alongKm * Math.sin(strikeRad2) / (111.32 * cosLat2) + horiz * Math.sin(dipDirRad2) / (111.32 * cosLat2);
    return { lat: sg.lat + dLat, lng: sg.lng + dLng, depth: topDepth + depthOff };
  }
  var hypo = patchPos(hypoIndexGlobal, Math.floor(hypoDipFrac * (nDip - 1)));

  iGlobal = 0;
  var maxRT = 0, wi = 0;
  for (k = 0; k < segs.length; k++) {
    var seg2 = segs[k];
    var dL2 = seg2.lenKm / seg2.nStrike;
    for (var is2 = 0; is2 < seg2.nStrike; is2++, iGlobal++) {
      for (var j2 = 0; j2 < nDip; j2++, wi++) {
        var pos = patchPos(iGlobal, j2);
        var rawWeight = rawWeights[wi];
        var momentFraction = rawWeight / wSum;
        var patchMoment = totalMoment * momentFraction;
        var slipW = momentFraction * (nStrikeTotal * nDip);
        var surf = P.haversineDist(hypo.lat, hypo.lng, pos.lat, pos.lng);
        var dDepth = pos.depth - hypo.depth;
        var dist3D = Math.sqrt(surf * surf + dDepth * dDepth);
        var speedFactor = 1;
        if (velocityModel === 'slip-depth' || velocityModel === 'depth') {
          speedFactor = Math.max(0.65, Math.min(1.25, 0.82 + 0.18 * Math.sqrt(Math.max(0.1, slipW))));
        }
        var localSpeed = Math.max(0.5, rupSpeed * speedFactor);
        var rt = dist3D / localSpeed;
        var patchAreaM2 = dL2 * (nominalW / nDip) * 1e6;
        var slipM = patchMoment / (rigidityGPa * 1e9 * patchAreaM2);
        var riseTime = Math.max(0.5, Math.min(20, 0.8 * Math.sqrt(dL2 * (nominalW / nDip)) / rupSpeed * Math.sqrt(Math.max(0.2, slipW))));
        if (rt > maxRT) maxRT = rt;
        subs.push({
          lat: pos.lat, lng: pos.lng, depth: pos.depth,
          m: P.momentMagnitude(patchMoment), moment: patchMoment, momentFraction: momentFraction,
          slipWeight: slipW, slipM: slipM, areaKm2: dL2 * (nominalW / nDip),
          alongStrikeKm: cumulativeAlong(iGlobal), downDipKm: (j2 + 0.5) * (nominalW / nDip),
          strikeIndex: iGlobal, dipIndex: j2, segIndex: k,
          strikeDeg: seg2.strikeDeg, dipDeg: seg2.dipDeg, rakeDeg: seg2.rakeDeg,
          ruptureTime: rt, riseTime: riseTime, ruptureSpeedKmS: localSpeed,
          sourceTimeFunction: sourceTimeFunction
        });
      }
    }
  }
  function cumulativeAlong(iG) {
    var acc = 0;
    for (var q = 0; q < iG; q++) acc += patchFrames[q].dL;
    return acc + patchFrames[iG].dL * 0.5;
  }
  var geometry = {
    kind: 'synthetic-segmented',
    lat: nodes[0].lat, lng: nodes[0].lng, mw: mw, depth: depthKm,
    sourceType: sourceType,
    strikeDeg: segs[0].strikeDeg, dipDeg: segs[0].dipDeg,
    listricDipDeg: Number(opts.listricDipDeg) || 0,
    L: L, W: nominalW, nStrike: nStrikeTotal, nDip: nDip,
    segments: segs.map(function (g) {
      return { lat: g.lat, lng: g.lng, strikeDeg: g.strikeDeg, dipDeg: g.dipDeg, rakeDeg: g.rakeDeg, lenKm: g.lenKm, nStrike: g.nStrike };
    }),
    topDepth: topDepth,
    subs: subs, nSub: subs.length,
    maxRuptureTime: maxRT,
    totalMoment: totalMoment,
    rigidityGPa: rigidityGPa,
    averageSlipM: totalMoment / (rigidityGPa * 1e9 * L * nominalW * 1e6),
    maxSlipM: subs.reduce(function (mx, s3) { return Math.max(mx, s3.slipM); }, 0),
    maxSlipWeight: subs.reduce(function (mx, s3) { return Math.max(mx, s3.slipWeight); }, 0),
    hypocenter: hypo,
    hypocenterStrikeFrac: hypoFrac, hypocenterDipFrac: hypoDipFrac,
    ruptureSpeedKmS: rupSpeed,
    ruptureVelocityModel: velocityModel,
    sourceTimeFunction: sourceTimeFunction,
    // surface-trace polyline for map fallbacks
    corners: segs.map(function (g) { return [g.lat, g.lng]; }).concat([[nodes[nodes.length - 1].lat, nodes[nodes.length - 1].lng]]),
    cellCorner: function (i, j, alongFrac, dipFrac) {
      var pf = patchFrames[Math.max(0, Math.min(patchFrames.length - 1, i))];
      var sg = segs[pf.seg];
      var p = segPosOf(sg, (i - segRowStart(pf.seg)) * sg.lenKm / sg.nStrike + alongFrac * sg.lenKm / sg.nStrike, (j + dipFrac) * (nominalW / nDip));
      return [p.lat, p.lng];
    },
    cellPoint: function (i, j, alongFrac, dipFrac) {
      var c = this.cellCorner(i, j, alongFrac, dipFrac);
      return { lat: c[0], lng: c[1], depth: topDepth + segs[patchFrames[Math.max(0, Math.min(patchFrames.length - 1, i))].seg].anchors[Math.min(nDip, j + dipFrac)].depth };
    }
  };
  function segRowStart(segIdx) {
    var acc3 = 0;
    for (var q3 = 0; q3 < segIdx; q3++) acc3 += segs[q3].nStrike;
    return acc3;
  }
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

// v6.2 断层破裂详情 — rupture summary statistics for the info-panel card.
// Works for BOTH synthetic geometry (genSubSources subs) and imported
// finite-fault patches (observed-fault-models: slipM/ruptureTimeS/riseTimeS);
// field-name normalization is done here so callers pass patches as-is.
// Returns null when no usable patches are present.
Physics.faultRuptureStats = function(patches, geometry) {
  var subs = Array.isArray(patches) ? patches : (geometry && geometry.subs);
  if (!Array.isArray(subs) || !subs.length) return null;
  function num(v, fb) { v = Number(v); return isFinite(v) ? v : fb; }
  var n = 0, slipSum = 0, slipMax = 0, slipMin = Infinity;
  var areaSum = 0, asperityArea = 0, rtMax = 0, riseSum = 0, riseMax = 0;
  var velSum = 0, velMin = Infinity, velMax = 0, velN = 0;
  var momentSum = 0, bestSlip = null, depths = [], alongs = [];
  var items = [];
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    var slip = num(s.slipM, NaN);
    if (!isFinite(slip)) continue;
    var rt = num(s.ruptureTime, num(s.ruptureTimeS, 0));
    var rise = num(s.riseTime, num(s.riseTimeS, 0));
    var depth = num(s.depth, num(s.centerDepthKm, NaN));
    var along = num(s.alongStrikeKm, NaN);
    n++;
    slipSum += slip;
    if (slip > slipMax) { slipMax = slip; bestSlip = s; }
    if (slip < slipMin) slipMin = slip;
    var area = num(s.areaKm2, 0);
    areaSum += area;
    momentSum += num(s.moment, 0);
    if (rt > rtMax) rtMax = rt;
    riseSum += rise;
    if (rise > riseMax) riseMax = rise;
    if (depth === depth) depths.push(depth);
    if (along === along) alongs.push(along);
    var vel = num(s.ruptureSpeedKmS, NaN);
    if (vel === vel) { velSum += vel; velN++; if (vel < velMin) velMin = vel; if (vel > velMax) velMax = vel; }
    items.push({ slip: slip, area: area, rt: rt });
  }
  if (!n) return null;
  var meanSlip = slipSum / n;
  var aspThreshold = 1.5 * meanSlip;
  for (i = 0; i < items.length; i++) {
    if (items[i].slip >= aspThreshold) asperityArea += items[i].area;
  }
  // moment conservation check (synthetic subs carry exact fractions)
  var totalMoment = geometry && geometry.totalMoment;
  var momentRelErr = (isFinite(totalMoment) && totalMoment > 0 && momentSum > 0)
    ? Math.abs(momentSum - totalMoment) / totalMoment : null;
  return {
    patches: n,
    meanSlipM: meanSlip,
    maxSlipM: slipMax,
    minSlipM: slipMin,
    asperityAreaFraction: areaSum > 0 ? asperityArea / areaSum : null,
    ruptureDurationS: rtMax,
    meanRiseTimeS: riseSum / n,
    maxRiseTimeS: riseMax,
    ruptureVelKmS: velN ? { mean: velSum / velN, min: velMin, max: velMax } : null,
    momentRelErr: momentRelErr,
    depthRangeKm: depths.length ? { min: Math.min.apply(null, depths), max: Math.max.apply(null, depths) } : null,
    alongStrikeRangeKm: alongs.length ? { min: Math.min.apply(null, alongs), max: Math.max.apply(null, alongs) } : null,
    maxSlipAt: bestSlip ? {
      alongStrikeKm: num(bestSlip.alongStrikeKm, null),
      depthKm: num(bestSlip.depth, num(bestSlip.centerDepthKm, null)),
      ruptureTimeS: num(bestSlip.ruptureTime, num(bestSlip.ruptureTimeS, null))
    } : null
  };
};

// v6.2 断层破裂详情 — event moment-rate / cumulative-moment time series from
// the per-patch source-time functions (finite-difference of the cumulative
// released moment, reusing rupturePatchFraction so every STF flavour is
// honoured). Grid: dt seconds from 0 to endTime + one step.
Physics.momentRateSeries = function(patches, geometry, dt) {
  var subs = Array.isArray(patches) ? patches : (geometry && geometry.subs);
  if (!Array.isArray(subs) || !subs.length) return null;
  dt = Number(dt) > 0 ? Number(dt) : 0.25;
  var endTime = 0, totalWeight = 0, hasFraction = false;
  var i, s, rt, rise, mf;
  var weights = new Array(subs.length);
  for (i = 0; i < subs.length; i++) {
    s = subs[i];
    rt = Number(s.ruptureTime != null ? s.ruptureTime : s.ruptureTimeS) || 0;
    rise = Number(s.riseTime != null ? s.riseTime : s.riseTimeS) || 0;
    if (rt + rise > endTime) endTime = rt + rise;
    mf = Number(s.momentFraction);
    if (isFinite(mf) && mf > 0) {
      weights[i] = mf; totalWeight += mf; hasFraction = true;
    } else {
      // imported patches carry no momentFraction — fall back to a
      // slip×area proxy (relative units, labelled as such)
      weights[i] = (Number(s.slipM) || 0) * (Number(s.areaKm2) || 1);
      totalWeight += weights[i];
    }
  }
  if (!(endTime > 0) || !(totalWeight > 0)) return null;
  if (hasFraction && Math.abs(totalWeight - 1) > 1e-6) {
    // normalise any fractional shortfall so the curve always ends at 1
    for (i = 0; i < weights.length; i++) weights[i] /= totalWeight;
  } else if (!hasFraction) {
    for (i = 0; i < weights.length; i++) weights[i] /= totalWeight;
  }
  var nStep = Math.min(4000, Math.ceil((endTime + dt) / dt));
  var t = [], cum = [], rate = [];
  for (i = 0; i <= nStep; i++) {
    var tt = i * dt, c = 0;
    for (var k = 0; k < subs.length; k++) {
      var sub = subs[k];
      var frac = Physics.rupturePatchFraction(sub, tt);
      if (frac > 0) c += weights[k] * frac;
    }
    t.push(tt);
    cum.push(c);
    rate.push(i === 0 ? 0 : (c - cum[i - 1]) / dt);
  }
  var peakRate = 0, peakAt = 0;
  for (i = 0; i < rate.length; i++) if (rate[i] > peakRate) { peakRate = rate[i]; peakAt = t[i]; }
  return { t: t, cum: cum, rate: rate, dt: dt, endTime: endTime,
    peakRate: peakRate, peakRateAt: peakAt, finalCum: cum[cum.length - 1],
    weightUnits: hasFraction ? 'moment-fraction' : 'slip-area-proxy' };
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

// ================================================================
//  Bayless & Somerville (2013) full directivity model (v5.7 R4-1) — the
//  official update of Somerville et al. (1997), transcribed verbatim from
//  PEER Report 2013/09 ch.2 (archived .cache/papers/, local-only):
//    ln Sa_dir = ln Sa + f_D                                   (2.1)
//    f_D = (C0 + C1*fD_geo) * T_Rrup * T_M * T_Az              (2.2)
//    strike-slip fD_geo = log10(s)*(0.5cos2theta+0.5)          (2.3)
//    dip-slip     fD_geo = log10(d)*cos(Rx/W)                  (2.7)
//  with s = max(X*L, e), d = max(Y*W, 1), tapers per (2.4)/(2.5)/(2.8)/
//  (2.9)/(2.10) and Rx/W used as an ANGLE clamped to [-pi/2, 2pi/3].
//  Coefficient tables 2.1/2.2 (RotD50 / FN / FP x 10 periods) frozen below.
//  Application choice: our PGA prediction anchors at the T=0.5 s row (zero
//  by calibration — the model says directivity is a long-period effect),
//  PGV at the T=1.0 s row (PGV ~ Sa(1s)), RotD50 (our predictions are
//  component-averaged; FN/FP rows stay available for callers).
// ================================================================
Physics.BAYLESS_SOMMERVILLE_2013 = {
  periods: [0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10],
  strikeSlip: {
    rotD50: { c0: [0, 0, -0.12, -0.175, -0.21, -0.235, -0.255, -0.275, -0.29, -0.30], c1: [0, 0, 0.075, 0.09, 0.095, 0.099, 0.103, 0.108, 0.112, 0.115] },
    fn: { c0: [0, -0.08, -0.225, -0.30, -0.325, -0.365, -0.39, -0.41, -0.42, -0.425], c1: [0, 0.055, 0.11, 0.135, 0.16, 0.185, 0.205, 0.215, 0.22, 0.225] },
    fp: { c0: [0, 0, 0.015, 0.03, 0.05, 0.07, 0.08, 0.09, 0.1, 0.108], c1: [0, 0, 0, -0.025, -0.04, -0.045, -0.05, -0.06, -0.07, -0.071] }
  },
  dipSlip: {
    rotD50: { c0: [0, 0, 0, 0, 0, -0.033, -0.089, -0.133, -0.16, -0.176], c1: [0, 0, 0, 0, 0.034, 0.093, 0.128, 0.15, 0.165, 0.179] },
    fn: { c0: [0, 0, 0, 0, 0, -0.034, -0.092, -0.115, -0.122, -0.125], c1: [0, 0, 0, 0, 0.056, 0.12, 0.142, 0.16, 0.165, 0.17] },
    fp: { c0: [0, 0, 0, 0, 0, -0.034, -0.11, -0.175, -0.195, -0.2], c1: [0, 0, 0, 0, 0.03, 0.08, 0.12, 0.15, 0.17, 0.175] }
  }
};

// linear interpolation of (C0, C1) at period T, log-spaced between table rows
Physics._bsCoefficients = function(faultKind, component, T) {
  var tables = Physics.BAYLESS_SOMMERVILLE_2013;
  var group = faultKind === 'dip' ? tables.dipSlip : tables.strikeSlip;
  var tab = group[component] || group.rotD50;
  var per = tables.periods;
  if (!(T > 0)) T = 1;
  if (T <= per[0]) return { c0: tab.c0[0], c1: tab.c1[0] };
  var last = per.length - 1;
  if (T >= per[last]) return { c0: tab.c0[last], c1: tab.c1[last] };
  for (var i = 0; i < last; i++) {
    if (T >= per[i] && T <= per[i + 1]) {
      var f = (T - per[i]) / (per[i + 1] - per[i]);
      return { c0: tab.c0[i] + f * (tab.c0[i + 1] - tab.c0[i]), c1: tab.c1[i] + f * (tab.c1[i + 1] - tab.c1[i]) };
    }
  }
  return { c0: tab.c0[last], c1: tab.c1[last] };
};

// Geometric directivity predictor + tapers (equations 2.3-2.10 verbatim).
// g: {sKm, thetaRad, dKm, rxOverW, L, W, rrupKm, mw, azRad, dipSlip}
Physics.baylessSomervilleFD = function(g, faultKind, component, T) {
  if (!g) return { fD: 0, tapers: 0 };
  var geo;
  if (faultKind === 'dip') {
    var arg = Math.max(-Math.PI / 2, Math.min(2 * Math.PI / 3, g.rxOverW));
    geo = Math.log10(Math.max(g.dKm || 0, 1)) * Math.cos(arg);
  } else {
    geo = Math.log10(Math.max(g.sKm || 0, Math.E)) * (0.5 * Math.cos(2 * g.thetaRad) + 0.5);
  }
  // distance taper (2.4 / 2.8)
  var ratio = faultKind === 'dip' ? (g.W > 0 ? g.rrupKm / g.W : 9) : (g.L > 0 ? g.rrupKm / g.L : 9);
  var lo = faultKind === 'dip' ? 1.5 : 0.5, hi = faultKind === 'dip' ? 2.0 : 1.0;
  var tDist = ratio <= lo ? 1 : ratio >= hi ? 0 : 1 - (ratio - lo) / (hi - lo);
  // magnitude taper (2.5 / 2.9)
  var m = Number(g.mw) || 0;
  var tMag = m >= 6.5 ? 1 : m <= 5.0 ? 0 : 1 - (6.5 - m) / 1.5;
  // azimuth taper (2.6 / 2.10): unity for strike-slip, sin^2(Az) for dip-slip
  var tAz = 1;
  if (faultKind === 'dip') {
    var az = Math.abs((g.azRad == null ? 0 : g.azRad)) % Math.PI;
    tAz = Math.sin(az) * Math.sin(az);
  }
  var co = Physics._bsCoefficients(faultKind, component || 'rotD50', T);
  return { fD: (co.c0 + co.c1 * geo) * tDist * tMag * tAz, geo: geo, tDist: tDist, tMag: tMag, tAz: tAz };
};

// Site geometry (s, theta, d, Rx/W, Rrup, Az) from the same faultParams the
// Rrup code accepts (analytic rectangle or imported finite fault). Bilateral
// centered rupture: s = half of the fault on the site's side; d = width from
// the hypocenter to the edge on the site's downdip side.
Physics.baylessSomervilleGeometry = function(source, faultParams, staLat, staLng) {
  if (!faultParams || !source) return null;
  var out = { L: 0, W: 0, rrupKm: 0 };
  var strikeDeg = Number(faultParams.strikeDeg != null ? faultParams.strikeDeg : (source.strikeDeg != null ? source.strikeDeg : 0));
  var dipDeg = Number(faultParams.dipDeg != null ? faultParams.dipDeg : (source.dipDeg != null ? source.dipDeg : 60));
  var lat0 = Number(faultParams.lat != null ? faultParams.lat : source.lat);
  var lng0 = Number(faultParams.lng != null ? faultParams.lng : source.lng);
  var depth = Number(faultParams.depth != null ? faultParams.depth : source.depthKm);
  var L = Number(faultParams.L), W = Number(faultParams.W);
  var topOffset, hypoFrac;
  if (faultParams.kind === 'imported-finite-fault' && faultParams.subs && faultParams.subs.length) {
    // plane extents from the sub-fault centres; hypocenter mid-plane
    if (!(L > 0) || !(W > 0)) {
      var sr = strikeDeg * Math.PI / 180;
      var nAlong = 0, nAcross = 0;
      for (var i = 0; i < faultParams.subs.length; i++) {
        var sub = faultParams.subs[i];
        var dKm = Physics.haversineDist(lat0, lng0, sub.lat, sub.lng);
        var br = Physics.bearingRad(lat0, lng0, sub.lat, sub.lng);
        nAlong += dKm * Math.cos(br - sr);
        nAcross += dKm * Math.sin(br - sr);
      }
      nAlong /= faultParams.subs.length; nAcross /= faultParams.subs.length;
      var sAlong = 0, sAcross = 0;
      for (var j = 0; j < faultParams.subs.length; j++) {
        var sub2 = faultParams.subs[j];
        var dKm2 = Physics.haversineDist(lat0, lng0, sub2.lat, sub2.lng);
        var br2 = Physics.bearingRad(lat0, lng0, sub2.lat, sub2.lng);
        var a = dKm2 * Math.cos(br2 - sr) - nAlong, b = dKm2 * Math.sin(br2 - sr) - nAcross;
        sAlong += a * a; sAcross += b * b;
      }
      L = L > 0 ? L : 4 * Math.sqrt(sAlong / faultParams.subs.length);
      W = W > 0 ? W : 4 * Math.sqrt(sAcross / faultParams.subs.length);
    }
    topOffset = -(W / 2); hypoFrac = 0.5;
  } else {
    topOffset = faultParams.topOffset != null ? faultParams.topOffset
      : -((faultParams.hypocenterFrac != null ? faultParams.hypocenterFrac : 0.35) * (W || 1));
    hypoFrac = faultParams.hypocenterFrac != null ? faultParams.hypocenterFrac : 0.35;
  }
  var sr2 = strikeDeg * Math.PI / 180, dipRad = dipDeg * Math.PI / 180;
  var distKm = Physics.haversineDist(lat0, lng0, staLat, staLng);
  var brg = Physics.bearingRad(lat0, lng0, staLat, staLng);
  var xS = distKm * Math.cos(brg - sr2);   // + along strike
  var yS = distKm * Math.sin(brg - sr2);   // + down-dip side
  var halfL = (L || 1) / 2;
  // strike-slip: rupturing length toward the site, SSGA97 theta in [0,90deg]
  out.sKm = halfL;
  out.thetaRad = Math.acos(Math.max(0, Math.min(1, Math.abs(Math.cos(brg - sr2)))));
  // dip-slip: downdip coordinate of the site (same projection as rrupDistance)
  var sStar = yS * Math.cos(dipRad) - depth * Math.sin(dipRad);
  var bottomOffset = topOffset + (W || 1);
  var hypoDowndip = topOffset + hypoFrac * (W || 1);
  sStar = Math.max(topOffset, Math.min(bottomOffset, sStar));
  out.dKm = sStar > hypoDowndip ? (bottomOffset - hypoDowndip) : (hypoDowndip - topOffset);
  // Rx: horizontal distance from the SURFACE projection of the top edge,
  // positive on the down-dip side, expressed in fault widths and used as an
  // angle (clamped inside baylessSomervilleFD)
  var yTop = topOffset * Math.cos(dipRad);
  out.rxOverW = W > 0 ? (yS - yTop) / W : 0;
  out.L = L; out.W = W;
  out.rrupKm = Physics.rrupDistance(staLat, staLng, faultParams);
  if (!isFinite(out.rrupKm) || !(out.rrupKm > 0)) return null;
  out.azRad = brg - sr2;
  out.mw = source.mw;
  // mechanism routing (2.1: 0-30/150-180 strike-slip, 60-120 dip-slip;
  // oblique handled by the caller through rake weighting)
  var rake = Number(source.rakeDeg != null ? source.rakeDeg : 0);
  var absRake = Math.abs(rake) % 360; if (absRake > 180) absRake = 360 - absRake;
  if (absRake <= 30 || absRake >= 150) out.faultKind = 'strike';
  else if (absRake >= 60 && absRake <= 120) out.faultKind = 'dip';
  else out.faultKind = null; // oblique: rake-weighted blend by the caller
  return out;
};

// ================================================================
//  Near-fault directivity PULSE (v5.7 R4-2) — Shahi & Baker (2013/2015)
//  equations transcribed verbatim from PEER Report 2013/15 ch.2 (archived
//  .cache/papers/, local-only):
//    P(pulse|r,s)   = 1/(1+exp(0.642 + 0.167r - 0.075s))          (2.6, SS)
//    P(pulse|r,d,θ) = 1/(1+exp(0.128 + 0.055r - 0.061d + 0.036θ)) (2.7, non-SS)
//    ln Tp = -5.73 + 0.99M,  σ(lnTp) = 0.56                       (2.11/2.12)
//    P(pulse at α|pulse) = min[0.67, 0.67-0.0041(77.5-α)]         (2.8, SS)
//  r = closest distance to rupture (km), s = rupture length between
//  epicenter and the site-closest point (km), d = downdip width between
//  hypocenter and that point (km), θ in degrees; Tp < 0.6 s pulses are
//  rare and excluded per the report.
// ================================================================
Physics.pulseProbability = function(params) {
  if (!params) return 0;
  var r = Number(params.rKm);
  if (!(r >= 0)) return 0;
  if (params.sKm != null) {
    var s = Number(params.sKm);
    return 1 / (1 + Math.exp(0.642 + 0.167 * r - 0.075 * Math.max(0, s)));
  }
  if (params.dKm != null) {
    var d = Number(params.dKm), th = Number(params.thetaDeg) || 0;
    return 1 / (1 + Math.exp(0.128 + 0.055 * r - 0.061 * Math.max(0, d) + 0.036 * th));
  }
  return 0;
};

Physics.pulsePeriodSec = function(mw) {
  return Math.exp(-5.73 + 0.99 * (Number(mw) || 0));
};

Physics.pulseOrientationProb = function(alphaDeg, strikeSlip) {
  var a = Math.abs(Number(alphaDeg) || 0);
  var base = strikeSlip ? 0.67 : 0.53, ref = strikeSlip ? 77.5 : 70.2;
  return Math.min(base, base - 0.0041 * (ref - a));
};

// Mavroeidis & Papageorgiou (2003) analytical velocity pulse:
//   v(t) = Vp/2 * (1 + cos(ωp t)) * cos(ωp t + φ),  0 <= t <= γ/fp
// (the analytic acceleration is the exact derivative). γ controls the
// number of half cycles, φ the phase (π/2 gives the classic symmetric
// pulse); Vp in cm/s, Tp in s.
Physics.mavroeidisPulse = function(vpCms, tpSec, gamma, phaseRad, sampleRate) {
  var Tp = Math.max(0.05, Number(tpSec) || 1);
  var gam = Math.max(1, gamma == null ? 1.5 : Number(gamma));
  var phi = phaseRad == null ? Math.PI / 2 : Number(phaseRad);
  var w = 2 * Math.PI / Tp;
  var dur = gam * Tp;
  var rate = sampleRate || 50;
  var n = Math.max(4, Math.round(dur * rate));
  var t = 0, v = [], a = [];
  for (var i = 0; i <= n; i++) {
    t = i / rate;
    var env = 0.5 * (vpCms) * (1 + Math.cos(w * t));
    var vv = env * Math.cos(w * t + phi);
    // dv/dt = Vp/2 * [-w sin(wt) cos(wt+phi) - w (1+cos wt) sin(wt+phi)]
    var aa = 0.5 * (vpCms) * (-w * Math.sin(w * t) * Math.cos(w * t + phi)
      - w * (1 + Math.cos(w * t)) * Math.sin(w * t + phi));
    v.push(vv); a.push(aa);
  }
  return { v: v, a: a, sampleRate: rate, durationSec: dur, tp: Tp, vp: vpCms };
};

// Inject a directivity pulse into a synthesizeWaveform3C carrier: the
// velocity pulse is oriented fault-normal (decomposed onto the n/e axes),
// added around the S arrival (position frac of the strong-motion window),
// and the record carries a pulse descriptor for the UI. Deterministic
// threshold injection (documented): pulses appear when P(pulse) >= 0.5 —
// the framework's Bernoulli sampling belongs to the PSHA layer we do not run.
Physics.injectDirectivityPulse = function(synth, opts) {
  if (!synth || !synth.x || !opts || !(opts.prob >= 0.5) || !(opts.pgvCms > 0)) return synth;
  var Tp = Physics.pulsePeriodSec(opts.mw);
  if (Tp < 0.6) return synth; // rare short pulses excluded (report 2.3.3)
  var pulse = Physics.mavroeidisPulse(0.8 * opts.pgvCms, Tp, 1.5, Math.PI / 2, synth.sampleRate);
  var rate = synth.sampleRate, n = synth.x.length;
  var start = Math.max(0, Math.min(n - 2, Math.round((opts.startFrac == null ? 0.35 : opts.startFrac) * n)));
  // fault-normal unit vector in (n, e): n = north, e = east
  var az = Number(opts.faultNormalAzRad) || 0;
  var fnN = Math.cos(az), fnE = Math.sin(az);
  var injected = 0;
  for (var i = 0; i < pulse.a.length && start + i < n; i++) {
    // velocity-integrated acceleration offset — add the acceleration and
    // the velocity appears in any integration/intensity consumer
    synth.y[start + i] += pulse.a[i] * fnN;
    synth.x[start + i] += pulse.a[i] * fnE;
    injected++;
  }
  synth.pulse = {
    probability: +(opts.prob.toFixed(3)), tpSec: +Tp.toFixed(2),
    vpCms: +pulse.vp.toFixed(1), nSamples: injected,
    faultNormalAzRad: az
  };
  return synth;
};

// Full-model ln-space correction for our two intensity drivers:
// PGA at the T=0.5 s row (zero by calibration), PGV at the T=1.0 s row,
// RotD50. Oblique rakes blend the pure end members per section 2.7.2.
Physics.baylessSomervilleLn = function(source, faultParams, staLat, staLng) {
  var g = Physics.baylessSomervilleGeometry(source, faultParams, staLat, staLng);
  if (!g || (!g.L || !g.W)) return { lnPga: 0, lnPgv: 0 };
  function evalKind(kind, T) {
    var gg = { sKm: g.sKm, thetaRad: g.thetaRad, dKm: g.dKm, rxOverW: g.rxOverW, L: g.L, W: g.W, rrupKm: g.rrupKm, mw: g.mw, azRad: g.azRad };
    return Physics.baylessSomervilleFD(gg, kind, 'rotD50', T).fD;
  }
  var lnPga, lnPgv;
  if (g.faultKind === 'strike' || g.faultKind === 'dip') {
    lnPga = evalKind(g.faultKind, 0.5);
    lnPgv = evalKind(g.faultKind, 1.0);
  } else {
    // oblique (2.7.2): normalize rake into the first quadrant and blend
    var rake = Math.abs(Number(source.rakeDeg) || 0) % 360; if (rake > 180) rake = 360 - rake;
    if (rake > 90) rake = 180 - rake;
    var dipWeight = rake / 90;
    lnPga = (1 - dipWeight) * evalKind('strike', 0.5) + dipWeight * evalKind('dip', 0.5);
    lnPgv = (1 - dipWeight) * evalKind('strike', 1.0) + dipWeight * evalKind('dip', 1.0);
  }
  return { lnPga: lnPga, lnPgv: lnPgv, geometry: g };
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
    // BSSA14 is calibrated on Rjb: point sources take the epicentral
    // (horizontal) distance, finite faults the distance to the rupture's
    // surface projection (rjbDistance), and the patch composite the
    // horizontal distance to each patch centroid. Depth enters only via the
    // model's h pseudo-depth (documented on the model block). The check
    // resolves the auto route so region-mode 'auto' calls (crustal -> bssa14
    // inside calcPGA) use Rjb semantics too; usesRrup and the site-term
    // convention stay keyed on the LITERAL model, keeping the Japan auto path
    // byte-identical (reference-760 + external site amp for auto-routed
    // native-Vs30 models is the established convention).
    var usesRjb = (m === 'bssa14' || m === 'cy14' || m === 'cb14' || m === 'ask14') ||
      (m === 'auto' && Physics.resolveGmpModel('auto', source.sourceType, source.mw) === 'bssa14');
    var distanceKm = usesRrup ? Physics.rrupDistance(station.lat, station.lng, geometry)
      : (usesRjb ? (geometry ? Physics.rjbDistance(station.lat, station.lng, geometry) : horizontalKm) : rhypoKm);

    // Site-term convention (matches tools/scorecard-strong-motion.js predictStation
    // and the app forecast path _predictPrefectureShindosFor): zhao2006/kanno2006
    // carry native paper Vs30 site classes, so the station Vs30 is fed straight
    // into the GMPE and NO external amplification is applied on top. The
    // reference-site models (si-midorikawa / log) predict on a 760 m/s reference
    // and take the external vs30Amplification factor below.
    // bssa14 is likewise native-Vs30 (its linear + nonlinear site terms are
    // inside the GMPE, calibrated against the NGA-West2 reference 760 m/s).
    // ngasub (Parker 2022) too — its regional linear + nonlinear Vs30 terms
    // are inside the GMPE. cy14/cb14/ask14 (v7.x) the same (native Vs30 site
    // terms inside the NGA-West2 models).
    var nativeVsModel = (m === 'zhao2006' || m === 'kanno2006' || m === 'bssa14' || m === 'ngasub' || m === 'cy14' || m === 'cb14' || m === 'ask14');
    var gmpeVs30 = nativeVsModel ? vs30 : (context.gmpeVs30 || 760);

    function pointPga(distance) {
      return Physics.calcPGA(source.mw, distance, m, source.depthKm, null, source.mw,
        source.sourceType, attA, attB, attC, anelastic, gmpeVs30, source.rakeDeg, source.dipDeg);
    }
    function pointPgv(distance) {
      return Physics.calcPGV(source.mw, distance, m, source.depthKm, null, source.mw,
        source.sourceType, anelastic, gmpeVs30, source.rakeDeg, source.dipDeg);
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
        var patchEvalDist = usesRjb ? patchHorizontal : patchDistance;
        var patchPga = pointPga(patchEvalDist) * weight;
        var patchPgv = pointPgv(patchEvalDist) * weight;
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
        var evalDistF = usesRjb ? phF : pdF;
        var wF = Math.sqrt(Math.max(0, Number(subF.momentFraction) || 0));
        var pF = pointPga(evalDistF) * wF, vF = pointPgv(evalDistF) * wF;
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
      model:m, usesRrup:usesRrup, usesRjb:usesRjb, distanceKm:distanceKm, patches:patches,
      referencePga:referencePga, referencePgv:referencePgv,
      pointPga:pointPga(distanceKm), pointPgv:pointPgv(distanceKm),
      sitePga:sitePga, sitePgv:sitePgv
    };
  }

  var directivityFactor = 1, pgvDirectivityFactor = 1;
  if (opts.directivity === 'somerville1997' && geometry) {
    // Bayless & Somerville (2013) full model (v5.7 R4-1): PGA anchors at the
    // zero short-period row, PGV at the T=1 s row — replacing the legacy
    // 1+c·cos(Δaz) PGA-only simplification of the same option
    var bsLn = Physics.baylessSomervilleLn(source, geometry, station.lat, station.lng);
    directivityFactor = Math.exp(bsLn.lnPga);
    pgvDirectivityFactor = Math.exp(bsLn.lnPgv);
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
    pgv = Math.exp(meanLnPgv) * stationFactor * pgvDirectivityFactor;
    logicTree = {
      branches: branchRows,
      sigmaEpistemicPga: Math.sqrt(varPga),
      sigmaEpistemicPgv: Math.sqrt(varPgv)
    };
  } else {
    res = evaluateModel(model);
    pga = res.referencePga * res.sitePga * stationFactor * directivityFactor;
    pgv = res.referencePgv * res.sitePgv * stationFactor * pgvDirectivityFactor;
  }
  var intensity = Physics.calcJmaIntensity(pga, pgv);
  var out = {
    model:model, distanceMetric:res.usesRrup ? 'Rrup' : (res.usesRjb ? 'Rjb' : 'Rhypo'), distanceKm:res.distanceKm,
    horizontalKm:horizontalKm, rhypoKm:rhypoKm, referencePga:res.referencePga,
    referencePgv:res.referencePgv, pointPga:res.pointPga, pointPgv:res.pointPgv,
    pga:pga, pgv:pgv, intensity:intensity, shindo:Physics.intensityToShindo(intensity),
    sitePga:res.sitePga, sitePgv:res.sitePgv, stationFactor:stationFactor,
    directivityFactor:directivityFactor, pgvDirectivityFactor:pgvDirectivityFactor, patches:res.patches
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
Physics.findNearestWetCell = function(grid, lat, lng, maxRadius, wetMask) {
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
        // Optional open-ocean mask (Physics.oceanConnectedMask): excludes
        // enclosed inland basins that read as water in the terrain data.
        if(wetMask&&!wetMask[index])continue;
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

/**
 * Open-ocean eligibility mask for tsunami forecast-area control points
 * (regional grids, v6.5.1). A wet cell (data < 0 = water) is eligible only
 * when it is at least minDepthM deep AND connected to the open ocean through
 * cells that are all at least minDepthM deep. The open ocean enters through
 * grid edges whose cells are majority-deep — an edge that is mostly land is
 * never a seed (the California strip's east edge cuts through the Salton
 * Sea, so that edge must not "ocean-connect" the lake). Enclosed
 * below-sea-level basins (Salton Sea, Death Valley) and tidal channels the
 * grid cannot resolve (Sacramento–San Joaquin Delta at 0.05°) are excluded:
 * the wave solver cannot reach them either, so a forecast control there
 * would only ever see noise. minDepthM defaults to 10 — the shoaling
 * reference contour the alert chain already uses for its Green's-law step.
 * Returns null when no edge qualifies as open sea (the grid cannot
 * adjudicate connectivity; callers keep unmasked behavior).
 */
Physics.oceanConnectedMask = function(grid, minDepthM) {
  if(!grid||!grid.data||!grid.nx||!grid.ny||!(grid.res>0))return null;
  var nx=grid.nx,ny=grid.ny,n=nx*ny;
  var minDepth=(Number(minDepthM)>0)?Number(minDepthM):10;
  function isDeep(i){var v=Number(grid.data[i]);return isFinite(v)&&v<=-minDepth;}
  // Edge vote: an edge seeds only when at least half of its cells are deep
  // water — a land-dominated edge is not an ocean source.
  var wDeep=0,eDeep=0,sDeep=0,nDeep=0,x,y,i;
  for(y=0;y<ny;y++){if(isDeep(y*nx))wDeep++;if(isDeep(y*nx+nx-1))eDeep++;}
  for(x=0;x<nx;x++){if(isDeep(x))sDeep++;if(isDeep((ny-1)*nx+x))nDeep++;}
  var seedW=wDeep*2>=ny,seedE=eDeep*2>=ny,seedS=sDeep*2>=nx,seedN=nDeep*2>=nx;
  var mask=new Uint8Array(n),stack=[];
  function seed(sx,sy){var si=sy*nx+sx;if(!mask[si]&&isDeep(si)){mask[si]=1;stack.push(si);}}
  if(seedS)for(x=0;x<nx;x++)seed(x,0);
  if(seedN)for(x=0;x<nx;x++)seed(x,ny-1);
  if(seedW)for(y=0;y<ny;y++)seed(0,y);
  if(seedE)for(y=0;y<ny;y++)seed(nx-1,y);
  if(!stack.length)return null;
  while(stack.length){
    i=stack.pop();var ix=i%nx,iy=(i-ix)/nx;
    if(ix>0){var l=i-1;if(!mask[l]&&isDeep(l)){mask[l]=1;stack.push(l);}}
    if(ix<nx-1){var r=i+1;if(!mask[r]&&isDeep(r)){mask[r]=1;stack.push(r);}}
    if(iy>0){var u=i-nx;if(!mask[u]&&isDeep(u)){mask[u]=1;stack.push(u);}}
    if(iy<ny-1){var d=i+nx;if(!mask[d]&&isDeep(d)){mask[d]=1;stack.push(d);}}
  }
  return mask;
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
  // v5.8 R5-5: 'per-patch' replaces the whole-field × cumulative-moment-fraction
  // approximation with each subfault's own DC3D field applied over its
  // ruptureTime→+riseTime window (the Hayes/Goldberg models carry realistic
  // per-patch delays). Legacy 'cumulative' stays the default (byte-compatible).
  var perPatchTiming=dynamicDeformation&&options.dtopoTiming==='per-patch';
  var patchDeforms=null,patchApplied=null;
  if(perPatchTiming){
    // Replicates buildOkadaDeformation's per-patch preparation (slip, fault
    // geometry defaults, _dc3dPatchSize) so the per-patch DC3D fields match
    // the summed static deformation; each patch keeps its own sparse cell
    // list within a generous reach box instead of the whole grid.
    var subs=source.geometry.subs,geom=source.geometry;
    var ppoisson=options.poissonRatio==null?0.25:Math.max(0,Math.min(0.49,Number(options.poissonRatio)));
    var alpha=DC3D.alphaFromPoisson(ppoisson);
    patchDeforms=[];patchApplied=new Float32Array(subs.length);
    for(var pi=0;pi<subs.length;pi++){
      var sub=subs[pi];
      var slip=Number(sub.slipM);
      if(!(slip>=0))slip=(Number(source.averageSlipM)||0)*(Number(sub.slipWeight)||1);
      if(!(slip>0))continue;
      var strike=Number(sub.strikeDeg);if(!isFinite(strike))strike=Number(source.strikeDeg)||0;
      var dip=Number(sub.dipDeg);if(!isFinite(dip))dip=Number(source.dipDeg)||90;
      var rake=Number(sub.rakeDeg);if(!isFinite(rake))rake=Number(source.rakeDeg)||0;
      var strikeRad=strike*Math.PI/180,rakeRad=rake*Math.PI/180;
      var size=_dc3dPatchSize(sub,geom,grid),halfL=size.lengthKm/2,halfW=size.widthKm/2;
      var strikeSlip=slip*Math.cos(rakeRad),dipSlip=slip*Math.sin(rakeRad);
      var subLat=Number(sub.lat),subLng=Number(sub.lng),subDepth=Number(sub.depthKm!=null?sub.depthKm:sub.depth);
      if(!isFinite(subLat))subLat=Number(source.lat)||0;
      if(!isFinite(subLng))subLng=Number(source.lng)||0;
      if(!(subDepth>0))subDepth=Math.max(0.01,Number(source.depthKm)||1);
      var reachKm=Math.max(1.5*Math.sqrt(halfL*halfL+halfW*halfW)+2*subDepth+20,30);
      var cells=[];
      var loX=Math.max(1,Math.floor((subLng-reachKm/111.32/Math.max(0.1,Math.cos(subLat*Math.PI/180))-grid.origin[0])/grid.res)-1);
      var hiX=Math.min(nx-2,Math.ceil((subLng+reachKm/111.32/Math.max(0.1,Math.cos(subLat*Math.PI/180))-grid.origin[0])/grid.res)+1);
      var loY=Math.max(1,Math.floor((subLat-reachKm/111.32-grid.origin[1])/grid.res)-1);
      var hiY=Math.min(ny-2,Math.ceil((subLat+reachKm/111.32-grid.origin[1])/grid.res)+1);
      for(var py=loY;py<=hiY;py++)for(var px=loX;px<=hiX;px++){
        var pidx=py*nx+px;
        if(Number(grid.data[pidx])>=0)continue;
        var plat=grid.origin[1]+py*grid.res,plng=grid.origin[0]+px*grid.res;
        var north=(plat-subLat)*111.32,east=(plng-subLng)*111.32*Math.cos(subLat*Math.PI/180);
        var along=north*Math.cos(strikeRad)+east*Math.sin(strikeRad);
        var across=-north*Math.sin(strikeRad)+east*Math.cos(strikeRad);
        var disp=DC3D.surfaceDisplacement({alpha:alpha,x:along,y:-across,depth:subDepth,dip:dip,
          al1:-halfL,al2:halfL,aw1:-halfW,aw2:halfW,strikeSlip:strikeSlip,dipSlip:dipSlip,tensile:0});
        if(disp.success||!isFinite(disp.uz))continue;
        if(Math.abs(disp.uz)>1e-3)cells.push({i:pidx,uz:disp.uz});
      }
      if(cells.length)patchDeforms.push({patch:sub,cells:cells});
    }
  }
  var appliedSourceFraction=dynamicDeformation?Physics.ruptureState(source.geometry,0).releasedMomentFraction:1;
  if(perPatchTiming)appliedSourceFraction=0;
  var cumulativeSourceVolumeM3=0;
  var dy=grid.res*111320,dxRows=new Float64Array(ny),cellAreaRows=new Float64Array(ny),minCellSize=dy;
  for(var row=0;row<ny;row++){
    var rowLat=grid.origin[1]+row*grid.res;
    dxRows[row]=grid.res*111320*Math.max(0.1,Math.cos(rowLat*Math.PI/180));
    cellAreaRows[row]=dxRows[row]*dy;minCellSize=Math.min(minCellSize,dxRows[row]);
  }
  // v5.8 R5-4a: constant tide offset. The still water level sits at
  // tideOffsetM instead of 0 (datum shift): positive tide pre-wets land below
  // that elevation (mean-higher-water inundation scenario) and adds its depth
  // to every ocean column. 0 (default) is the prior MSL behaviour exactly.
  var tideOffset=isFinite(Number(options.tideOffsetM))?Math.max(-5,Math.min(5,Number(options.tideOffsetM))):0;
  // v5.8 R5-4b: optional per-cell Manning field (same length as the grid,
  // clamped [0.005,0.2]). Null keeps the scalar Manning path untouched.
  var manningField=(options.manningField&&options.manningField.length===n)?options.manningField:null;
  for(var i=0;i<n;i++){
    z[i]=Number(grid.data[i]);
    var stillDepth=Math.max(0,tideOffset-z[i]);
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
    coastDistanceM[i]=stillDepth>0?0:Infinity;
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
  // ---- Optional Peregrine-type Boussinesq dispersion (v5.8 R5-2) ----
  // The non-dispersive phase speed sqrt(gh) exceeds the exact celerity
  // c² = gh·tanh(kh)/(kh) once kh grows past ~0.3; over a 17000 km
  // trans-oceanic path that accumulates into visible far-field phase error.
  // Standard Boussinesq (Peregrine 1967) appends +(d²/3)∇(∇·(∂u/∂t)) to the
  // momentum equation. Writing w = ∂u/∂t and ψ = ∇·w, the system splits into
  // the scalar Helmholtz  ψ − (d²/3)∇²ψ = −g∇²η  followed by the acceleration
  // correction  w_disp = (d²/3)∇ψ, which reproduces the exact [0,2] Padé
  // dispersion c² = gh/(1+(kh)²/3) with no mixed space-time stencils — a
  // 0.15-0.25° ocean grid resolves kh up to ~0.6-1 where the correction is
  // 10-25% of the phase speed. The MUSCL step above already applied the
  // hydrostatic −gh∇η, so this block only adds dt·h·(h²/3)∇ψ to the new
  // momenta; a lake at rest has ψ≡0 and stays untouched, and dispersion:'off'
  // (the default) never enters this path at all. Frozen-coefficient form
  // (local depth, no ∇d terms — standard hybrid SWE-Boussinesq practice),
  // applied only where the whole 5-point stencil is clearly wet, which is the
  // regime where the dispersive physics is valid and the wet-dry front is not.
  // ψ is solved by warm-started red-black Gauss-Seidel/SOR: the correction is
  // ~10% of the dynamics and ψ changes slowly per step, so a 1e-3 relative
  // residual in ≤120 sweeps is ample; sweeps/residual are reported honestly.
  var dispersive=options.dispersion==='boussinesq';
  var psi=null,phi=null,psiRhs=null,psiCoef=null;
  var thomSub=null,thomDiag=null,thomSup=null,thomD=null,thomOut=null;
  if(dispersive){
    psi=new Float32Array(n);phi=new Float32Array(n);psiRhs=new Float32Array(n);psiCoef=new Float32Array(n);
    var w=Math.max(nx,ny);
    thomSub=new Float64Array(w);thomDiag=new Float64Array(w);thomSup=new Float64Array(w);
    thomD=new Float64Array(w);thomOut=new Float64Array(w);
  }
  // Thomas algorithm on a packed tridiagonal system of length count; the
  // solution lands in thomOut (caller copies it to the target buffer).
  function thomasSolve(count){
    var cp=thomOut; // reuse as the c' scratch (length >= count)
    cp[0]=thomSup[0]/thomDiag[0];
    thomD[0]=thomD[0]/thomDiag[0];
    for(var k=1;k<count;k++){
      var m=thomDiag[k]-thomSub[k]*cp[k-1];
      cp[k]=k<count-1?thomSup[k]/m:0;
      thomD[k]=(thomD[k]-thomSub[k]*thomD[k-1])/m;
    }
    thomOut[count-1]=thomD[count-1];
    for(var k2=count-2;k2>=0;k2--)thomOut[k2]=thomD[k2]-cp[k2]*thomOut[k2+1];
  }
  function solveDispersion(dt){
    var dy2=dy*dy,p;
    for(var y=1;y<ny-1;y++){
      var rx2=dxRows[y]*dxRows[y];
      for(var x=1;x<nx-1;x++){
        p=y*nx+x;
        // gate on the centre cell being clearly wet only: a whole-stencil gate
        // zeroes the rhs of cells one row away from land and the ADI y-pass
        // then attenuates the uniform-field solution (measured 0.48×). Dry or
        // shallow neighbours are instead simply EXCLUDED from the Laplacian —
        // their bed elevation must not masquerade as free-surface curvature —
        // which weakens the correction near coasts (conservative) while the
        // deep interior keeps the exact stencil.
        if(!(hn[p]>musclGate)){psiRhs[p]=0;psiCoef[p]=0;psi[p]=0;continue;}
        var eC=hn[p]+z[p];
        var lap=0;
        if(hn[p+1]>musclGate)lap+=((hn[p+1]+z[p+1])-eC)/rx2;
        if(hn[p-1]>musclGate)lap+=((hn[p-1]+z[p-1])-eC)/rx2;
        if(hn[p+nx]>musclGate)lap+=((hn[p+nx]+z[p+nx])-eC)/dy2;
        if(hn[p-nx]>musclGate)lap+=((hn[p-nx]+z[p-nx])-eC)/dy2;
        psiRhs[p]=-g*lap;
        psiCoef[p]=hn[p]*hn[p]/3;
      }
    }
    // ADI factorisation of the Helmholtz operator (1 − c∇²) ≈ (1 − c∂xx)(1 − c∂yy):
    // two exact tridiagonal (Thomas) passes instead of an iterative solve. A
    // Gauss-Seidel alternative under-converges exactly where the dispersion is
    // strongest (c/Δx² = (kh)²/3 → 1 makes the spectral radius approach 1),
    // silently shrinking the correction — the direct factorisation keeps the
    // [0,2] dispersion exact for 1-D wave trains and O((kh)⁴/9) accurate in
    // 2-D, with deterministic per-step cost. ψ = 0 outside the wet interior
    // (Dirichlet edges; outgoing waves are absorbed by the radiation sponge).
    if(nx>2&&ny>2){
      var cy=ny-2;
      // y-pass: (1 − c∂yy) φ = rhs, one tridiagonal per column. Off-diagonal
      // entries are NEGATIVE (−c·face): the operator is (1 − c∇²).
      for(var x=1;x<nx-1;x++){
        for(var k=0;k<cy;k++){
          var yk=k+1,i=yk*nx+x;
          var cW=k>0?0.5*(psiCoef[i]+psiCoef[i-nx])/dy2:0;
          var cE=k<cy-1?0.5*(psiCoef[i]+psiCoef[i+nx])/dy2:0;
          thomSub[k]=-cW;thomDiag[k]=1+cW+cE;thomSup[k]=-cE;thomD[k]=psiRhs[i];
        }
        thomasSolve(cy);
        for(var k2=0;k2<cy;k2++)phi[(k2+1)*nx+x]=thomOut[k2];
      }
      // x-pass: (1 − c∂xx) ψ = φ, one tridiagonal per row
      for(var y=1;y<ny-1;y++){
        var cx=nx-2,rx2b=dxRows[y]*dxRows[y];
        for(var k=0;k<cx;k++){
          var xk=k+1,i2=y*nx+xk;
          var cW2=k>0?0.5*(psiCoef[i2]+psiCoef[i2-1])/rx2b:0;
          var cE2=k<cx-1?0.5*(psiCoef[i2]+psiCoef[i2+1])/rx2b:0;
          thomSub[k]=-cW2;thomDiag[k]=1+cW2+cE2;thomSup[k]=-cE2;thomD[k]=phi[i2];
        }
        thomasSolve(cx);
        for(var k2=0;k2<cx;k2++)psi[y*nx+k2+1]=thomOut[k2];
      }
      // boundary rows/columns keep ψ = 0 (set during the gate pass)
    }
    // dispersive acceleration dt·h·(h²/3)∇ψ on the new momenta
    for(var y=1;y<ny-1;y++){
      var rowDx=dxRows[y];
      for(var x=1;x<nx-1;x++){
        p=y*nx+x;
        var c=psiCoef[p];
        if(!(c>0))continue;
        hun[p]+=dt*hn[p]*c*((psi[p+1]-psi[p-1])/(2*rowDx));
        hvn[p]+=dt*hn[p]*c*((psi[p+nx]-psi[p-nx])/(2*dy));
        if(!isFinite(hun[p])){hun[p]=0;nonFiniteCorrections++;}
        if(!isFinite(hvn[p])){hvn[p]=0;nonFiniteCorrections++;}
      }
    }
  }
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
    if(perPatchTiming){
      // v5.8 R5-5: each subfault's DC3D field rides its own
      // ruptureTime→+riseTime window; the sparse per-patch cell lists were
      // built at construction. Volume bookkeeping mirrors the legacy path.
      for(var ppi=0;ppi<patchDeforms.length;ppi++){
        var pd=patchDeforms[ppi];
        var frac=Physics.rupturePatchFraction(pd.patch,time+dt);
        var inc=frac-patchApplied[ppi];
        if(!(inc>0))continue;
        patchApplied[ppi]=frac;
        for(var pci=0;pci<pd.cells.length;pci++){
          var pc=pd.cells[pci];
          if(z[pc.i]>=0)continue;
          var before=h[pc.i];
          h[pc.i]=Math.max(0,before+pc.uz*inc);
          cumulativeSourceVolumeM3+=(h[pc.i]-before)*cellAreaRows[Math.floor(pc.i/nx)];
        }
      }
    } else if(dynamicDeformation&&appliedSourceFraction<1){
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
        // v5.8 R5-4b: per-cell roughness when a field is supplied (clamped);
        // the scalar Manning path is unchanged otherwise.
        var nManning=manningField?Math.max(0.005,Math.min(0.2,manningField[i])):manning;
        var drag=1+dt*g*nManning*nManning*vel/Math.pow(newH,4/3);
        if(!isFinite(drag)||!(drag>0)){nonFiniteCorrections++;mx=0;my=0;}
        else{mx/=drag;my/=drag;}
      }
      hn[i]=Math.max(0,newH);hun[i]=mx;hvn[i]=my;
    }
    if(dispersive)solveDispersion(dt);
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
    var out={timeSeconds:time,steps:stepCount,stableDtSeconds:stableDt,maxCfl:maxCfl,cflLimit:cflNumber,
      gridNx:nx,gridNy:ny,cellCount:n,
      initialWaterVolumeM3:initialWaterVolume,currentWaterVolumeM3:currentWaterVolume,
      dynamicDeformation:dynamicDeformation,sourceFraction:appliedSourceFraction,sourceVolumeM3:cumulativeSourceVolumeM3,
      massResidualM3:residual,massResidualFraction:initialWaterVolume?residual/initialWaterVolume:0,
      negativeDepthCorrections:negativeDepthCorrections,dryCellCorrections:dryCellCorrections,
      nonFiniteCorrections:nonFiniteCorrections,nonFiniteCells:nonFiniteCells,
      minWaterDepthM:minWaterDepth===Infinity?0:minWaterDepth,maxWaterDepthM:maxWaterDepth,
      coriolisEnabled:coriolisEnabled,boundary:boundary,minCellSizeM:minCellSize,maxCellSizeM:Math.max(dy,dxRows[0],dxRows[ny-1])};
    if(dispersive)out.dispersion={model:'peregrine-boussinesq-q02',enabled:true,solve:'adi-thomas'};
    // non-default v5.8 R5-4/R5-5 modes are reported explicitly; default runs
    // keep the prior diagnostics shape byte-identical
    if(tideOffset)out.tideOffsetM=tideOffset;
    if(manningField)out.manningField={cells:manningField.length,mode:'per-cell'};
    if(perPatchTiming)out.dtopoTiming={mode:'per-patch',patches:patchDeforms.length};
    return out;
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
    deformation:deformation,model:'nonlinearSWE',dryTolerance:dry,manning:manning,arrivalThreshold:arrivalThreshold,coriolis:coriolisEnabled,boundary:boundary,
    tideOffsetM:tideOffset,hasManningField:!!manningField,dtopoTiming:perPatchTiming?'per-patch':'cumulative'};
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
  // v5.8 R5-3: recursive multi-level AMR. Accepts either the legacy
  // (coarseGrid, fineGrid, source, options) pair or an array of grids from
  // coarsest to finest: (grids[], source, options). The two-level path keeps
  // the exact prior operation order, so legacy results are bit-identical.
  var grids;
  if(Array.isArray(coarseGrid)){
    // capture the third argument BEFORE reassigning `source`: this module is
    // not in strict mode, so named parameters are live-bound to `arguments`
    // and `source=fineGrid` would otherwise clobber arguments[2]
    var arrayOptions=arguments[2];
    grids=coarseGrid;
    source=fineGrid;
    options=arrayOptions||{};
  } else grids=[coarseGrid,fineGrid];
  options=options||{};
  if(grids.length<2)return null;
  var checks=[];
  for(var li=1;li<grids.length;li++){
    var pairCheck=Physics.validateNestedGrids(grids[li-1],grids[li]);
    if(!pairCheck.valid)return null;
    checks.push(pairCheck);
  }
  var ext=checks[checks.length-1].fineExtent;
  var ratios=checks.map(function(c){return c.ratio;});
  var ratio=ratios[0];
  var fineOpts={};
  for(var k in options)fineOpts[k]=options[k];
  fineOpts.boundary='nested';
  var levels=[];
  for(var si=0;si<grids.length;si++)
    levels.push(Physics.createNonlinearTsunamiSolver(grids[si],source,si===0?options:fineOpts));
  for(var ci=0;ci<levels.length;ci++)if(!levels[ci])return null;
  var coarse=levels[0],fine=levels[levels.length-1];
  var dry=fine.dryTolerance;
  // ---- One coupling (ghost prolongation + restriction) per (parent,child) pair
  function makeCoupling(parent,child){
    var cF=parent._fields(),fF=child._fields();
    var cNx=cF.nx,cNy=cF.ny,fNx=fF.nx,fNy=fF.ny;
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
    // parent t_n buffers for time interpolation of the ghost values
    var oldH=new Float32Array(cNx*cNy),oldHu=new Float32Array(cNx*cNy),oldHv=new Float32Array(cNx*cNy);
    function etaAt(h,z,i){return h[i]>dry?h[i]+z[i]:z[i];}
    function fillGhosts(tau){
      // The base solver swaps its h/hu/hv double buffers on every step, so the
      // live arrays must be re-fetched — captured references go stale.
      var cNow=parent._fields(),hC=cNow.h,huC=cNow.hu,hvC=cNow.hv,zC=cNow.z;
      var fNow=child._fields(),fNowH=fNow.h,fNowHu=fNow.hu,fNowHv=fNow.hv;
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
      var fNow=child._fields(),fH=fNow.h,fHu=fNow.hu,fHv=fNow.hv,fZ=fNow.z;
      var cNow=parent._fields(),cZ=cNow.z;
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
    function snapshotParent(){
      var cPre=parent._fields();
      oldH.set(cPre.h);oldHu.set(cPre.hu);oldHv.set(cPre.hv);
    }
    return {fillGhosts:fillGhosts,restrict:restrict,snapshotParent:snapshotParent,
      ratio:checks[levels.indexOf(child)-1].ratio,ghostCells:ghosts.length,restrictionCells:restrictMap.size};
  }
  var couplings=[null];
  for(var cIdx2=1;cIdx2<levels.length;cIdx2++)couplings.push(makeCoupling(levels[cIdx2-1],levels[cIdx2]));
  var time=0,coarseSteps=0,lastSubsteps=ratios.length?ratios[0]:1,lastSubstepsChain=ratios.map(function(){return 0;});
  var nLevels=levels.length;
  // Per-level step plan: each level's dt stays at or below its own stable dt
  // (K >= ratio AND K >= dt/childProbe per pair, exactly like the two-level
  // driver), so the deepest level never exceeds its CFL probe.
  var planDt=new Array(nLevels),planK=new Array(nLevels);
  function planStep(i,budget){
    planDt[i]=budget;
    if(i===nLevels-1)return budget;
    var childProbe=levels[i+1]._probeDt();
    var K=Math.max(ratios[i],Math.ceil(budget/childProbe-1e-9));
    var dt=Math.min(budget,K*childProbe);
    planDt[i]=dt;planK[i]=K;
    planStep(i+1,dt/K);
    return dt;
  }
  function advanceSubtree(i){
    if(i===nLevels-1){levels[i]._stepOnce(planDt[i],true);return;}
    couplings[i+1].snapshotParent();
    levels[i]._stepOnce(planDt[i],true);
    var K=planK[i];
    for(var k=1;k<=K;k++){
      couplings[i+1].fillGhosts(k/K);
      // level i+1 advances by planDt[i+1] — as a leaf step when finest,
      // otherwise recursively as a composite of its own
      advanceSubtree(i+1);
    }
    couplings[i+1].restrict();
    lastSubstepsChain[i]=K;
  }
  function advanceTo(target){
    target=Math.max(time,Number(target)||0);
    while(time+1e-6<target){
      var rem=target-time;
      var dtC0=Math.min(levels[0]._probeDt(),rem);
      var dtC=planStep(0,dtC0);
      advanceSubtree(0);
      time+=dtC;coarseSteps++;lastSubsteps=planK[0];
    }
    return time;
  }
  function insideFine(lat,lng){
    return lat>=ext[1]&&lat<=ext[3]&&lng>=ext[0]&&lng<=ext[2];
  }
  // deepest level whose extent contains the point (sampling precedence)
  function levelFor(lat,lng){
    for(var i=nLevels-1;i>=1;i--){
      var e=checks[i-1].fineExtent;
      if(lat>=e[1]&&lat<=e[3]&&lng>=e[0]&&lng<=e[2])return i;
    }
    return 0;
  }
  function diagnostics(){
    var ds=levels.map(function(l){return l.getDiagnostics();});
    var dc=ds[0],df=ds[nLevels-1];
    var corrections=0,nonFinCorr=0,nonFinCells=0,sourceVol=0;
    for(var i=0;i<nLevels;i++){
      corrections+=ds[i].negativeDepthCorrections+ds[i].nonFiniteCorrections;
      nonFinCorr+=ds[i].nonFiniteCorrections;nonFinCells+=ds[i].nonFiniteCells;
      sourceVol+=ds[i].sourceVolumeM3;
    }
    var dynAny=false;for(var j=0;j<nLevels;j++)if(ds[j].dynamicDeformation)dynAny=true;
    var maxCflAgg=0;for(var j2=0;j2<nLevels;j2++)maxCflAgg=Math.max(maxCflAgg,ds[j2].maxCfl);
    var out={timeSeconds:ds[0].timeSeconds,steps:dc.steps,cellCount:ds.reduce(function(a,d){return a+d.cellCount;},0),
      stableDtSeconds:dc.stableDtSeconds,maxCfl:maxCflAgg,cflLimit:dc.cflLimit,
      gridNx:df.gridNx,gridNy:df.gridNy,coarseGridNx:dc.gridNx,coarseGridNy:dc.gridNy,
      initialWaterVolumeM3:dc.initialWaterVolumeM3,currentWaterVolumeM3:dc.currentWaterVolumeM3,
      dynamicDeformation:dynAny,sourceFraction:df.sourceFraction,
      sourceVolumeM3:sourceVol,
      massResidualFraction:dc.massResidualFraction,fineMassResidualFraction:df.massResidualFraction,
      negativeDepthCorrections:corrections,nonFiniteCorrections:nonFinCorr,
      nonFiniteCells:nonFinCells,
      coriolisEnabled:dc.coriolisEnabled,boundary:dc.boundary,
      nested:{model:'two-way-amr',ratio:ratio,substeps:lastSubsteps,
        restrictionCells:couplings[nLevels-1].restrictionCells,ghostCells:couplings[nLevels-1].ghostCells},
      levels:null};
    if(nLevels===2)out.levels={coarse:ds[0],fine:ds[1]};
    else{out.nested.ratios=ratios.slice();out.nested.substepsChain=lastSubstepsChain.slice();
      out.nested.levelCount=nLevels;out.levels=ds;}
    return out;
  }
  var sourceInFine=source?insideFine(source.lat,source.lng):false;
  return {advanceTo:advanceTo,
    sample:function(lat,lng){var i=levelFor(lat,lng);return levels[i].sample(lat,lng);},
    samplePeak:function(lat,lng){var i=levelFor(lat,lng);return levels[i].samplePeak(lat,lng);},
    sampleWaterDepth:function(lat,lng){var i=levelFor(lat,lng);return levels[i].sampleWaterDepth(lat,lng);},
    sampleMaxDepth:function(lat,lng){var i=levelFor(lat,lng);return levels[i].sampleMaxDepth(lat,lng);},
    sampleState:function(lat,lng){var i=levelFor(lat,lng);return levels[i].sampleState(lat,lng);},
    getSnapshot:function(stride){
      // finest level first, then each coarser level outside the next finer
      // level's extent (checks[i].fineExtent is level i+1's coverage)
      var snaps=levels.map(function(l){return l.getSnapshot(stride);});
      var cells=snaps[nLevels-1].cells,zones=snaps[nLevels-1].inundationZones||[];
      for(var i=nLevels-2;i>=0;i--){
        var fe=checks[i].fineExtent;
        function insideNextFiner(lat,lng){
          return lat>=fe[1]&&lat<=fe[3]&&lng>=fe[0]&&lng<=fe[2];
        }
        cells=snaps[i].cells.filter(function(c){return !insideNextFiner(c.lat,c.lng);}).concat(cells);
        zones=(snaps[i].inundationZones||[]).filter(function(z){
          return !insideNextFiner(0.5*(z.bbox[1]+z.bbox[3]),0.5*(z.bbox[0]+z.bbox[2]));}).concat(zones);
      }
      var fs=snaps[nLevels-1],cs=snaps[0];
      var out={cells:cells,inundationZones:zones,time:Math.max(fs.time,cs.time),stride:stride,model:'nonlinearSWE-nested',
        maxRunup:Math.max(fs.maxRunup,cs.maxRunup),maxInundation:Math.max(fs.maxInundation,cs.maxInundation),
        maxEta:Math.max(fs.maxEta,cs.maxEta),maxSurfaceElevation:Math.max(fs.maxSurfaceElevation,cs.maxSurfaceElevation),
        maxWaveHeight:Math.max(fs.maxWaveHeight,cs.maxWaveHeight),maxVelocity:Math.max(fs.maxVelocity,cs.maxVelocity),
        maxHydroLoad:Math.max(fs.maxHydroLoad||0,cs.maxHydroLoad||0),
        inundatedAreaKm2:fs.inundatedAreaKm2+cs.inundatedAreaKm2,
        maxInundationDistanceKm:Math.max(fs.maxInundationDistanceKm||0,cs.maxInundationDistanceKm||0),
        arrivalThreshold:fs.arrivalThreshold,visualAggregationKm:fs.visualAggregationKm,
        deformation:(sourceInFine?fs:cs).deformation,deformationGrid:(sourceInFine?fs:cs).deformationGrid,
        quality:fs.quality,diagnostics:diagnostics(),nested:{ratio:ratio,fineExtent:ext}};
      if(nLevels>2){out.nested.ratios=ratios.slice();out.nested.levelCount=nLevels;}
      return out;
    },
    getDiagnostics:diagnostics,getTime:function(){return time;},getStableDt:function(){return levels[0]._probeDt();},
    deformation:(sourceInFine?fine:coarse).deformation,
    levels:levels.length===2?{coarse:coarse,fine:fine}:levels,
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

// R6-1: kinematic source energy/stress budget diagnostics (v6.0).
// Takes a normalized finite-fault model ({patches:[{slipM,areaKm2,
// rigidityGPa,momentNm,ruptureTime,riseTime,lat,lng,depthKm}], geometry:{L,W},
// mw, totalMomentNm}) and returns the stress-drop / radiated-energy /
// apparent-stress / radiation-efficiency budget with physicality flags.
//
// Method notes (deliberate scope choices, 2026-08-26):
// - Static stress drop: Eshelby circular shear crack Δτ = 7π/16·μ·D̄/r on the
//   area-equivalent radius; the mode-III strip variant 4μD̄/(πW) is reported
//   alongside as the elongated-fault bound (exact for anti-plane strips).
// - Radiated energy: Orowan/Brune estimate Er = M0·Δτ/(2μ) (apparent stress
//   τa = Δτ/2). A far-field spectrum integral of the kinematic moment-rate
//   was evaluated and deliberately NOT shipped: boxcar/triangle STFs make
//   ∫ω⁶|M̂|² diverge (M⃛ contains deltas) so the result is a function of the
//   sampling band, not of the source — a poor diagnostic.
// - Radiation efficiency η = Er/(M0·Δτ/μ) is exactly 0.5 by construction
//   here; the diagnostic value is the FLAG when the model's own moment/slip
//   rigidity bookkeeping is inconsistent (η recomputed from supplied M0 then
//   differs) plus the rise-time and rupture-speed plausibility gates.
Physics.sourceBudget = function(model, opts) {
  opts = opts || {};
  var patches = model && model.patches;
  if (!patches || !patches.length) return null;
  var totalA = 0, wSlip = 0, wMu = 0, M0 = 0, maxRT = 0, maxRise = 0, maxSlip = 0;
  var i, p;
  for (i = 0; i < patches.length; i++) {
    p = patches[i];
    var A = (p.areaKm2 || 0) * 1e6;
    if (!(A > 0)) continue;
    totalA += A;
    wSlip += (p.slipM || 0) * A;
    wMu += (p.rigidityGPa || 30) * A;
    M0 += (p.momentNm || 0);
    maxRT = Math.max(maxRT, p.ruptureTime || 0);
    maxRise = Math.max(maxRise, p.riseTime || 0);
    maxSlip = Math.max(maxSlip, p.slipM || 0);
  }
  if (!(totalA > 0)) return null;
  var avgSlip = wSlip / totalA;
  var muGPa = wMu / totalA;
  var mu = muGPa * 1e9;
  if (!(M0 > 0)) M0 = (model.totalMomentNm || 0);
  if (!(M0 > 0)) M0 = mu * totalA * avgSlip;
  var rEq = Math.sqrt(totalA / Math.PI);              // area-equivalent radius [m]
  var eshelby = (7 * Math.PI / 16) * mu * avgSlip / rEq; // [Pa]
  var W = (model.geometry && model.geometry.W) || 2 * rEq * 1e3; // km
  var Wm = Math.max(W * 1e3, avgSlip * 4);
  var strip = 4 * mu * avgSlip / (Math.PI * Wm);      // mode-III strip bound [Pa]
  var dropPa = eshelby;
  var m0FromSlip = mu * totalA * avgSlip;             // rigidity-weighted μ·A·D̄
  // Supplied-moment consistency: when the model carries its own M0 the
  // efficiency of the SUPPLIED moment against the slip-based available
  // energy becomes the real diagnostic (η≠0.5 flags moment/slip mismatch).
  var availJ = m0FromSlip * eshelby / mu;             // Δτ·A·D̄ ≡ M0_s·Δτ/μ [J]
  var erJ = M0 * dropPa / (2 * mu);                   // Orowan/Brune radiated [J]
  var tauA = mu * erJ / M0;                           // apparent stress [Pa]
  var eff = availJ > 0 ? erJ / availJ : NaN;
  // Corner frequency from the Eshelby drop (Madariaga constant path).
  var mw = model.mw != null ? model.mw : Physics.momentMagnitude(M0);
  var fc = Physics.cornerFrequency(mw, dropPa / 1e6);
  // Rupture-speed least-squares fit through the nucleation point.
  var nuc = null, ni;
  for (ni = 0; ni < patches.length; ni++) if (patches[ni].ruptureTime != null)
    if (!nuc || patches[ni].ruptureTime < nuc.ruptureTime) nuc = patches[ni];
  var vFit = null, r2 = null;
  if (nuc) {
    var sd = 0, st = 0, sTT = 0, sDD = 0, n = 0, sT = 0;
    for (i = 0; i < patches.length; i++) {
      p = patches[i];
      if (p.ruptureTime == null) continue;
      var dx = (p.lng - nuc.lng) * Math.PI / 180 * Physics.EARTH_R * Math.cos(nuc.lat * Math.PI / 180);
      var dy = (p.lat - nuc.lat) * Math.PI / 180 * Physics.EARTH_R;
      var dz = (p.depthKm || 0) - (nuc.depthKm || 0);
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz); // km
      var tt = (p.ruptureTime - nuc.ruptureTime);
      if (!(d > 1)) continue;
      n++; st += d * tt; sd += tt * tt; sDD += d * d; sT += tt;
    }
    if (n >= 5 && sd > 0) {
      vFit = st / sd;                                  // km/s through origin
      var ssr = 0, sst = 0, tMean = sT / n;
      for (i = 0; i < patches.length; i++) {
        p = patches[i];
        if (p.ruptureTime == null) continue;
        var dx2 = (p.lng - nuc.lng) * Math.PI / 180 * Physics.EARTH_R * Math.cos(nuc.lat * Math.PI / 180);
        var dy2 = (p.lat - nuc.lat) * Math.PI / 180 * Physics.EARTH_R;
        var dz2 = (p.depthKm || 0) - (nuc.depthKm || 0);
        var d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
        if (!(d2 > 1)) continue;
        var t2 = p.ruptureTime - nuc.ruptureTime;
        var pred = d2 / vFit;
        ssr += (t2 - pred) * (t2 - pred);
        sst += (t2 - tMean) * (t2 - tMean);
      }
      r2 = sst > 0 ? Math.max(0, 1 - ssr / sst) : 1;
    }
  }
  var vsKmS = Math.sqrt(mu / 2700) / 1e3;              // rigidity→shear speed
  var flags = [];
  if (isFinite(eff) && eff > 1.05) flags.push('radiation_efficiency_gt_1');
  if (eff < 0.2 && isFinite(eff)) flags.push('low_radiation_efficiency');
  if (vFit != null && vFit > 0.95 * vsKmS) flags.push('rupture_speed_supershear_vs_rigidity');
  if (maxRise > 0 && maxRise < 0.05 / Math.max(fc, 1e-3)) flags.push('rise_time_below_corner_period');
  if (avgSlip > 0 && maxSlip / avgSlip > 4) flags.push('slip_spike_ratio_gt_4');
  return {
    patches: patches.length, areaKm2: totalA / 1e6, avgSlipM: avgSlip,
    maxOverMeanSlip: avgSlip > 0 ? maxSlip / avgSlip : null,
    rigidityGPa: muGPa, eqRadiusKm: rEq / 1e3, faultWidthKm: W,
    momentNm: M0, momentFromSlipNm: m0FromSlip,
    stressDropMPa: eshelby / 1e6, stressDropStripMPa: strip / 1e6,
    bruneCornerHz: fc, radiatedEnergyJ: erJ, apparentStressMPa: tauA / 1e6,
    radiationEfficiency: eff, availableEnergyJ: availJ,
    ruptureSpeedKmS: vFit, ruptureSpeedR2: r2, shearSpeedKmS: vsKmS,
    durationS: maxRT + maxRise, flags: flags
  };
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
    var amp=Physics.fullSpectrum(f,Mw,distKm,stressDropMPa,siteAmp,
      (typeof cfgGet==='function')?cfgGet('faultQ0'):200,
      (typeof cfgGet==='function')?cfgGet('faultQeta'):0.7);
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
