// ================================================================
//  Earthquake Simulator — Simulation Engine
//  Local GeoJSON, local tile cache, all CDN-free
// ================================================================

// -- DOM refs --
var mapEl = document.getElementById('map');
var btnStart = document.getElementById('btn-start');
btnStart.disabled = true; // disabled until map data is loaded
var _mapReady = false;

// Debug flags (set to true for verbose console output)
var _debugEEW = false;    // EEW detection bulletin logs
// ---- Map loading progress bar ----
var _mapLoadSteps = [
  { pct: 5,  key: 'loading.start' },
  { pct: 15, key: 'loading.coastline' },
  { pct: 35, key: 'loading.bathy' },
  { pct: 50, key: 'loading.pref' },
  { pct: 65, key: 'loading.land' },
  { pct: 80, key: 'loading.stations' },
  { pct: 90, key: 'loading.seafloor' },
  { pct: 100, key: 'loading.done' }
];
var _mapLoadStepIdx = 0;
function updateMapLoadingProgress(pct, text) {
  var bar = document.getElementById('map-loading-bar');
  var pctEl = document.getElementById('map-loading-pct');
  var stepEl = document.getElementById('map-loading-step');
  if (bar) { bar.style.width = pct + '%'; }
  if (pctEl) { pctEl.textContent = pct + '%'; }
  if (stepEl && text) { stepEl.textContent = text; }
}

var btnReset = document.getElementById('btn-reset');
var epicenterInfo = document.getElementById('epicenter-info');
var magSlider = document.getElementById('magnitude');
var magVal = document.getElementById('mag-val');
var depthSlider = document.getElementById('depth');
var depthVal = document.getElementById('depth-val');
var strikeSlider = document.getElementById('strike');
var strikeVal = document.getElementById('strike-val');
var simSpeedEl = document.getElementById('sim-speed');
var soundModeEl = document.getElementById('sound-mode');
var timelineEl = document.getElementById('timeline');
var timeDisplay = document.getElementById('time-display');
var pRadiusEl = document.getElementById('p-radius');
var sRadiusEl = document.getElementById('s-radius');
var legendEl = document.getElementById('legend');
var maxPgaPanel = document.getElementById('max-pga-panel');
var maxPgaValue = document.getElementById('max-pga-value');
var maxShindoValue = document.getElementById('max-shindo-value');
var statusDot = document.getElementById('status-dot');
var statusText = document.getElementById('status-text');
var eewAlert = document.getElementById('eew-alert');
var eewCountdown = document.getElementById('eew-countdown');
var dipSlider = document.getElementById('dip');
var dipVal = document.getElementById('dip-val');
var rakeSlider = document.getElementById('rake');
var rakeVal = document.getElementById('rake-val');
var volSlider = document.getElementById('volume-slider');
var volVal = document.getElementById('vol-val');
var soundVolume = 0.8;
var _tsunamiEl = document.getElementById('tsunami-enable');
var _perfEl = document.getElementById('perf-mode');
// Cached EEW info-box elements (hot path: updateEEWInfoBox runs every frame)
var _eewBox = document.getElementById('eew-info-box');
var _eewShBox = document.getElementById('eew-shindo-box');
var _eewShVal = document.getElementById('eew-shindo-val');
var _eewBulText = document.getElementById('eew-bulletin-text');
var _eewMagText = document.getElementById('eew-mag-text');
var _eewDepthText = document.getElementById('eew-depth-text');
var _eewTimeText = document.getElementById('eew-time-text');
var _eewPredText = document.getElementById('eew-pred-text');
var _eewContainer = document.getElementById('eew-container');
var _eewTracks = document.getElementById('eew-tracks');
// EEW diagnostic panel cached refs
var _diagPanel = document.getElementById('eew-diag-panel');
var _diagEpi = document.getElementById('diag-epi');
var _diagUncert = document.getElementById('diag-uncert');
var _diagStations = document.getElementById('diag-stations');
var _diagBestUncert = document.getElementById('diag-best-uncert');
var _diagQuality = document.getElementById('diag-quality');
// Cached slider values (synced on input events, read in hot path to avoid DOM access)
var _liveMag = parseFloat(magSlider.value);
var _liveDepth = parseFloat(depthSlider.value);
if (volSlider) {
  soundVolume = volSlider.value / 100;
  volSlider.addEventListener('input', function() {
    soundVolume = this.value / 100;
    if (volVal) volVal.textContent = this.value + '%';
  });
}

// -- Security --
function escapeHTML(str) {
  return SimUtils.escapeHTML(str);
}

// -- Constants --
var EARTH_R = 6371;
function PW(depthKm) {
  if (depthKm > 30 && Physics.iasp91PVelocity) return Physics.iasp91PVelocity(depthKm);
  return cfgGet('pWaveSpeed');
}
function SW(depthKm) {
  if (depthKm > 30 && Physics.iasp91SVelocity) return Physics.iasp91SVelocity(depthKm);
  return cfgGet('sWaveSpeed');
}
function TSU_SPD() { return cfgGet('tsuSpeed'); } // tsunami 600 km/h
var SHINDO_FILL = {0:null,1:'#a0d2f0',2:'#6cb4ee',3:'#2ecc71',4:'#f1c40f','5-':'#e67e22','5+':'#e74c3c','6-':'#c0392b','6+':'#8e44ad',7:'#6c0f1f'};
// HiDPI canvas prep: size the backing store to device pixels and return the
// LOGICAL (CSS-px) draw size, with the 2-D transform pre-scaled. Chart code
// keeps drawing in CSS units; phones with devicePixelRatio 2-3 get crisp
// charts instead of an upscaled blur. Hidden canvases keep attribute size.
window.hidpiPrepCanvas = function(canvas) {
  var dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  var cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return {W: canvas.width, H: canvas.height};
  var W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return {W: cw, H: ch};
};
// Pre-parsed RGB for hot-path canvas rendering (avoids parseInt per frame per station)
var SHINDO_RGB = {0:null,1:[160,210,240],2:[108,180,238],3:[46,204,113],4:[241,196,15],'5-':[230,126,34],'5+':[231,76,60],'6-':[192,57,43],'6+':[142,68,173],7:[108,15,31]};
var GRID_CELL = 0.5, GRID_ORIGIN_LAT = 23.5, GRID_ORIGIN_LNG = 122, GRID_COLS = Math.ceil((150-122)/GRID_CELL);

// Soil province amplification [minLat,maxLat,minLng,maxLng,amp]
var SOIL_PROVINCES = [
  [35.0,36.6,139.0,140.8,1.65],[34.8,35.5,136.5,137.2,1.55],[34.3,35.0,135.0,135.8,1.55],
  [38.0,38.5,140.7,141.3,1.45],[42.7,43.3,141.1,141.8,1.45],[37.6,38.1,138.8,139.5,1.40],
  [36.5,36.9,137.1,137.5,1.35],[33.4,33.8,130.2,130.6,1.40],[33.4,33.7,133.4,133.7,1.35],
  [43.0,44.5,141.3,145.5,1.25],[35.2,35.6,136.8,137.0,1.30],[34.5,34.8,135.3,135.6,1.30],
  [35.5,36.0,138.9,139.4,1.25],[31.2,31.8,130.3,131.2,1.20],[26.0,27.0,127.6,128.3,1.30]
];

// -- State --
var epicenter = null, epicenterMarker = null, epicenterSrc = null, eventMw = null;
var isRunning = false, isPaused = false, isCountingDown = false;
var animationId = null, simElapsed = 0, lastFrameTime = null;
var pRadius = 0, sRadius = 0, pTravel = 0, sTravel = 0;
var rawLandGrid = [], landPoints = [], activeIndex = 0;
var _seafloorNetworkFilter = 'all';
function _stationNetworkVisible(station) {
  if (!station || !station.isSeafloor) return true;
  return _seafloorNetworkFilter === 'all' || station.network === _seafloorNetworkFilter;
}
var visibleCircles = [], activeShindoSounds = {};
// Once an event's S front has passed the farthest land station, its P/S rings
// would only sweep empty ocean. This many sim-seconds later the rings fade
// out (over WAVE_RETIRE_FADE s) and the event drops out of the auto-focus
// bounds (the epicenter marker stays). Prevents stale giant rings in long
// chain runs, which also used to blow up the overview camera fit.
var WAVE_RETIRE_GRACE = 20, WAVE_RETIRE_FADE = 8;
// Detect-mode magnitude saturation compression: above the pivot, raw
// point-source inversions of finite-fault near-field PGA run away to the
// M10 display cap. Compressing the high end keeps M9-class events reading
// in the low 9s (raw 10.2 → 9.2) without touching mid-range estimates.
var MAG_SAT_PIVOT = 8.5, MAG_SAT_SLOPE = 0.4;
var activeGridCells = {}, stationToCell = {};
function retainGridPeak(cells, cellIndex, shindo) {
  if (!cells || cellIndex == null || shindo === 0) return;
  var current = cells[cellIndex];
  if (current === undefined || Physics.shindoNum(shindo) > Physics.shindoNum(current)) cells[cellIndex] = shindo;
}
function clearActiveShakingGrid(redraw) {
  if (!Object.keys(activeGridCells).length) return false;
  activeGridCells = {};
  if (redraw && typeof drawFrame === 'function') drawFrame();
  return true;
}
var japanLandPolygons = null;
var _landPolygon = null; // japan.json MultiPolygon for accurate isOceanPoint checks
var _landBBox = null;    // bbox cache for _landPolygon
var _oceanPointCache = {}; // quantized lat/lng -> boolean, avoids repeated Turf checks
var _bathyGrid = null;    // bathymetry grid: {origin:[lng,lat], res, nx, ny, data:[...]}
// Regional high-resolution coastal grids (see _tsuGridForEvent). Declared
// up here because setEpicenter may prefetch before the tsunami section runs.
var REGIONAL_BATHY = [
  {id:'jp-sanriku',     bbox:[140.5,35.0,144.5,40.5]},
  {id:'jp-nankai',      bbox:[132.0,30.0,139.0,35.0]},
  {id:'jp-sagami',      bbox:[138.5,33.5,141.5,36.0]},
  {id:'jp-noto',        bbox:[135.5,35.5,139.5,38.5]},
  {id:'jp-hokkaido-sw', bbox:[137.5,40.5,141.5,43.5]}
];
var _regionalBathy = {};         // id -> grid (absent/false = not usable)
var _regionalBathyLoading = {};  // id -> in-flight promise

var _vs30Grid = null;     // optional J-SHIS/user research grid using the same raster schema
var _researchDataManifest = null, _researchCertification = null;
var _strongMotionPackageReady = false, _tsunamiObservationsReady = false;
var _historicalTsunamiData = null, _historicalTsunamiShow = false;
var _renderHistoricalTsunamiValidationDataset = null;
var _jmaTsunamiAreaData = null; // official JMA AreaTsunami forecast-area lines
var _tsuForecastAreas = [], _tsuForecastAreaByCode = Object.create(null);
var waveCanvas = null, waveCtx = null;
var audioCache = {};
var gridCells = [];
// Tsunami state
var isOceanEpicenter = false, tsunamiRadius = 0, tsunamiCircles = [];
// Detection mode
var detectMode = false, detectedEpicenter = null, detectedMag = 0;
var detectStationCount = 0, detectUncertainty = 200;
var tsunamiAlerted = false, detectFirstTime = 0;
var detectedT0 = 0, detectedPRadius = 0, detectedSRadius = 0;
var detectBulletin = 0, detectFinal = false, detectLockedEpicenter = null;
var detectStableSince = 0, detectLastEpicenter = null;
var detectHistory = [];           // [{time, lat, lng, mag, uncertainty, stations}]
var detectLastBulletinTime = 0;  // sim time of last bulletin
var detectLastBulletinStations = 0;
var detectBestEpicenter = null, detectBestUncertainty = Infinity;
var detectConverged = false;     // convergence flag for FINAL display
var _detectQuality = '?';               // quality rating S/A/B/C/D
// Waveform
var wfStation = null, wfSamples = [], wfCanvas = null, wfCtx = null;
// v5.2 chain: which display event the watched station follows, and the
// per-event signal list synthesized into the trace (see _wfBuildSignals).
var _wfEventIdx = 0, _wfSignals = null;
var wfMaxSample = 0, wfScrollOffset = 0;
// Leaflet fault plane + aftershock layers
var faultLayerGroup = null;       // L.layerGroup containing faultPolygon + aftershock markers
var _faultLayerGroups = [];       // all fault layer groups (for multi-event cleanup)
var faultPolygon = null;          // L.polygon or L.polyline
var aftershockLeafletMarkers = []; // L.circleMarker[]
var lastAftershockIdxRendered = -1; // track which aftershocks have been added to map
// Validation scorecard (compares sim vs real JMA Shindo for preset events)
var OBSERVED = null, currentPreset = '', peakShindoByName = {};
var _observedMomentTensor = null;
var _observedFaultPlaneSelection = null;
var _observedFiniteFault = null;
var _pendingFiniteFault = null;
var _polarityInversion = null;
var _polarityRecords = null;
// Shindo Report state
var _prefPopData = null;          // prefecture population data
var _prefGeoData = null;           // GeoJSON for all 47 prefectures
var _subareaGeoData = null;        // JMA 地震情報細分区域 (194 subdivisions)
var _prefLayer = null;             // L.geoJSON boundary layer
var _reportActive = false;         // true while report overlay is visible
var _reportTriggered = false;      // one-shot: prevents duplicate triggers
// v5.2 chain: per-event re-arm state for the shindo report and sound cues.
var _reportEventIdx = 0;
// v5.2 chain: delayed per-event survey trigger (lets shaking develop first).
var _reportRearmAt = 0;
// v5.2 chain: delayed per-event forecast+voice state. In detect mode the ~8 s
// delay simulates detection+association latency (blind multi-event
// association is out of scope — the detection display keeps tracking the
// first event); non-detect mode announces immediately.
var _chainFcAt = 0, _chainFcEv = null;
var _reportStartSimTime = 0;       // simElapsed when report began
var _reportHoldDuration = 10;      // seconds to display the report
var _reportLastDismissTime = 0;    // simElapsed when last report was dismissed (anti-loop guard)
var _reportAudioEl = null;         // active report Audio element (H10 fix)
var _globalMaxShindo = 0;          // highest curMaxSh seen this simulation
var _globalMaxPga = 0, _globalMaxPgv = 0;
var _currentExperiment = null, _lastResearchSnapshot = null;
var _currentScenarioSnapshot = null, _currentConfigSnapshot = null;
var _researchStationPeaks = Object.create(null);
var _eewSoundTimer1 = null;        // EEW1 deferred play handle
var _eewSoundTimer2 = null;        // EEW2 deferred play handle
var _eewTtsTimer = null;           // delayed SREV region announcement
var _eewTtsCtrl = null;            // cancellable dynamic TTS playback
var _srevAnnouncer = null;          // shared FIFO for every SREV-style message
var _srevLastEstimateBulletin = 0;
var _srevLastEstimatedShindo = null;
var _surveyState = 'idle';          // idle | collecting | complete
var _surveySnapshot = null;         // immutable per-prefecture peak snapshot
var _srevTsunamiSignature = '';
var _srevTsunamiIssuedLevels = Object.create(null); // per-level first-issuance memory for forecast speech
var _srevObservedTsunamiAreas = Object.create(null);
var _tsuEventAlertRank = Object.create(null); // per-event alert-sound memory — a newly warned event re-plays the chime even if another event already played that level
var _globalMaxCountdown = 0;       // seconds curMaxSh has been below _globalMaxShindo
var _reportPrefectureShindos = {}; // { prefectureId: maxShindo }
var _livePrefectureShindos = {};   // H21 fix: was implicit global
var _reportMarkers = [];           // L.marker[] for intensity boxes
var _reportHighlightLayer = null;  // L.geoJSON for prefecture fill colors
var _previousMapBounds = null;     // map bounds before report, for restore
var _previousZoom = null;          // map zoom before report, for restore
// JQuake-style EEW forecast state
var _prefCentroids = null;          // [{id, nam, nam_ja, lat, lng}]—precomputed once at map load
var _prefBBoxes = null;             // [turf.bbox, ...] for all 47 prefectures — cached for fast point-in-poly
var _predictedPrefectureShindos = {}; // {prefId: {id, nam, nam_ja, shindo}}—GMPE forecast
var _predictedMaxShindo = 0;        // maximum predicted Shindo across all prefectures
var _predictedMaxShindoI = -1;      // numeric JMA intensity behind _predictedMaxShindo (-1 = none)
var _eewWarranted = false;          // true when predicted max shindo >= '5-'
var _livePrefLayer = null;          // persistent L.geoJSON overlay for live prefecture coloring
var _livePrefColors = {};           // {prefId: shindoString} — current display colors
var _subareaCentroids = null;       // [{id:name, nam, nam_ja, lat, lng}] for the 194 JMA subdivisions
var _subareaBBoxes = null;          // cached bboxes matching _subareaGeoData.features
var _subareaForecast = {};          // {areaName: {id, nam, nam_ja, shindo}} — subdivision GMPE forecast
var _liveAreaColors = {};           // {areaName: shindoString} — current subdivision display colors
var _liveAreaShindos = {};          // {areaName: shindoString} — observed subdivision maxima
var _lastPrefUpdateSec = -1;        // last sim-second when live prefecture layer was updated
var _detectEEWTriggered = false;      // one-shot: EEW triggered from detection (detect mode only)
// Final Bulletin state (after all stations quiet)
var _finalBulletinTriggered = false; // one-shot for final bulletin
var _finalBulletinActive = false;    // true while final bulletin overlay is up
var _bulletinTime = null;            // Date object for bulletin time
var _bulletinMag = 0;               // magnitude for bulletin
var _bulletinDepth = 0;             // depth for bulletin
var _bulletinTsunamiLevel = 0;      // 0=none, 1=advisory, 2=warning, 3=major
var _bulletinSeqCtrl = null;        // controller for aborting bulletin TTS
// 2D fault plane
var currentDip = 60;
var currentRake = 0;
// Untouched geometry uses a visible source-class prior. Imported/preset or
// manually edited mechanisms remain authoritative.
var _dipExplicit = false;
// Optional mechanism: untouched rake=0 means unknown, not explicit strike slip.
var _rakeExplicit = false;
function refreshDipStateLabel(){
  if(dipVal)dipVal.textContent=Math.round(currentDip*10)/10+'°'+(_dipExplicit?'':' · '+t('rake.auto'));
}
function applyAutomaticDip(){
  if(_dipExplicit||typeof Physics==='undefined'||!Physics.recommendedFaultDip)return;
  currentDip=Physics.recommendedFaultDip(activeSrcType());
  if(dipSlider)dipSlider.value=currentDip;
  var dipNumber=document.getElementById('dip-num');if(dipNumber)dipNumber.value=currentDip;
  refreshDipStateLabel();
}
function refreshRakeStateLabel(){
  if(rakeVal)rakeVal.textContent=currentRake+'°'+(_rakeExplicit?'':' · '+t('rake.auto'));
}
refreshRakeStateLabel();
// Aftershock sequence
var aftershockEnabled = false;
var _eewCountdownIv = null; // EEW countdown interval (for cancel button)
var aftershockCatalog = [];   // [{time, lat, lng, mag, depth, id}]
var manualAftershocks = [];    // v5.5: user-defined entries {time (sim s), mag, depth, lat?, lng?}
var activeAftershocks = [];
var maxAftershockMag = 0;
// Multi-event support: large aftershocks become visible events
var activeEvents = [];           // EventState[] — mainshock + large aftershocks
var MAX_AFTERSHOCK_EVENTS = 5;
var AS_EVENT_MAG_THRESHOLD = 5.5;
var detectedAftershocks = [];    // detection-mode discovered aftershocks
// Detection mode multi-event tracks: one independent detection track per
// sub-event (its own arrivals, grid-search hypocenter, magnitude, bulletin
// sequence and FINAL) — mirrors how real EEW systems run concurrent event
// tracks. Track 0 is mirrored into the legacy detected* globals so all
// single-event UI keeps working unchanged.
var _detectTracks = [];
// Rupture animation state
var rupturePolyEntries = [];   // [{poly: L.polygon, ruptureTime: number, maxRT: number}]
// Intensity curve state
var intensitySamples = [];     // [{t: number, shindo: number|string}]
var intensityCanvas = null, intensityCtx = null;
var _chartSec = -1;            // throttle info-page charts (attenuation/spectrum/travel/azimuth)
var _lastAsDetectTime = 0;
var _lastDetectionSolveMs = -Infinity;
var _lastWaveRenderMs = -Infinity;
var _lastInfoRenderMs = -Infinity;
var _lastTableRenderMs = -Infinity;
var _lastChartRenderMs = -Infinity;
var _lastRuptureRenderMs = -Infinity;
var _lastMultiWaveRenderMs = -Infinity;
var _lastAftershockRenderMs = -Infinity;
var _visibleCircleById = Object.create(null);
var _wfAftershockSignals = [];
var _wfAftershockSignalsReady = false;
var faultPolygonEnabled = true;

function setTextIfChanged(el, value) {
  if (!el) return;
  var text = String(value);
  if (el.textContent !== text) el.textContent = text;
}

// --- Global error display ---
var _errorCount = 0;
window.addEventListener('error', function(e) {
  _errorCount++;
  var msg = e.message || String(e);
  var src = e.filename || '?';
  var line = e.lineno != null ? e.lineno : '?';
  var col = e.colno != null ? e.colno : '';
  showErrorOverlay('#' + _errorCount + ' ' + msg + '\n    at ' + src + ':' + line + (col ? ':' + col : ''));
});
window.addEventListener('unhandledrejection', function(e) {
  _errorCount++;
  var msg = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled Promise rejection';
  showErrorOverlay('#' + _errorCount + ' (Promise) ' + msg);
});

function showErrorOverlay(text) {
  var ov = document.getElementById('error-overlay');
  var body = document.getElementById('error-body');
  if (!ov || !body) return;
  ov.style.display = 'flex';
  // Append one element per error (textContent auto-escapes). Avoids re-parsing
  // and re-escaping the entire history on every new error that innerHTML += caused.
  var line = document.createElement('div');
  line.textContent = text;
  body.appendChild(line);
  while (body.childNodes.length > 50) body.removeChild(body.firstChild);
  // Auto-hide after 20s
  clearTimeout(_errorHideTimer);
  _errorHideTimer = setTimeout(function() {
    ov.style.display = 'none';
    body.textContent = '';
    _errorCount = 0;
  }, 20000);
}
var _errorHideTimer = 0;

// Bind error overlay close button (deferred — DOM not ready yet)
function bindErrorOverlay() {
  var btn = document.getElementById('error-close');
  if (!btn) return false;
  btn.addEventListener('click', function() {
    var ov = document.getElementById('error-overlay');
    var body = document.getElementById('error-body');
    if (ov) ov.style.display = 'none';
    if (body) body.textContent = '';
    _errorCount = 0;
  });
  return true;
}
var multiEventMode = false;
var customEvents = [];
var multiEventMarkers = []; // Leaflet markers for multi-event mode
// Building damage cache
var damageCache = null;
var damageCacheSec = -1;

// -- Map (local tile server) --
var map = L.map('map', {
  center: [36.2, 138.2], zoom: 6,
  zoomControl: true, zoomControlPosition: 'bottomright',
  attributionControl: true, maxZoom: 18,
  worldCopyJump: true
});

// --- Offline vector basemap (zero network dependency) ---
// Ocean background: full-world light-blue rectangle
var oceanBg = L.rectangle([[-90, -180], [90, 180]], {
  color: 'transparent', fillColor: '#d8e8f0', fillOpacity: 1, interactive: false
});
var offlineBasemap = L.layerGroup([oceanBg], {pane: 'tilePane'});

// --- Dark offline basemap (built lazily on first selection) ---
var _offlineDarkBuilt = false;
var _prefLayerDark = null;
var _hoveredPrefLayer = null;
var _hoveredPrefGroup = null;
var darkOceanBg = L.rectangle([[-90, -180], [90, 180]], {
  color: 'transparent', fillColor: '#0a1628', fillOpacity: 1, interactive: false
});
var offlineBasemapDark = L.layerGroup([darkOceanBg], {pane: 'tilePane'});

function clearPrefectureHover() {
  var layer = _hoveredPrefLayer, group = _hoveredPrefGroup;
  _hoveredPrefLayer = null;
  _hoveredPrefGroup = null;
  if (layer && group && typeof group.resetStyle === 'function') {
    try { group.resetStyle(layer); } catch(e) {}
  }
}

function setPrefectureHover(group, layer, style) {
  if (_hoveredPrefLayer === layer && _hoveredPrefGroup === group) return;
  clearPrefectureHover();
  _hoveredPrefLayer = layer;
  _hoveredPrefGroup = group;
  layer.setStyle(style);
}

// Leaflet can miss a path mouseout after rapid SVG transitions. Verify the
// actual DOM target on every pointer move and clear any stale highlight.
var _mapContainer = map.getContainer();
_mapContainer.addEventListener('pointermove', function(e) {
  if (_hoveredPrefLayer && e.target !== _hoveredPrefLayer._path) clearPrefectureHover();
});
_mapContainer.addEventListener('pointerleave', clearPrefectureHover);
window.addEventListener('blur', clearPrefectureHover);
map.on('dragstart zoomstart', clearPrefectureHover);

function buildDarkOfflineBasemap() {
  if (_offlineDarkBuilt) return;
  _offlineDarkBuilt = true;
  if (!japanLandPolygons) return;
  // Dark coastline: dim thick glow + thin border
  L.geoJSON(japanLandPolygons, {
    style: function() {
      var z = map.getZoom();
      var w = z <= 5 ? 30 : z <= 6 ? 22 : z <= 7 ? 16 : z <= 8 ? 10 : 6;
      return {color:'#3a4a5a', weight:w, fillOpacity:0, lineCap:'round', lineJoin:'round'};
    },
    interactive: false
  }).addTo(offlineBasemapDark);
  L.geoJSON(japanLandPolygons, {
    style: function() { return {color:'#2d4060', weight:1.2, fillOpacity:0}; },
    interactive: false
  }).addTo(offlineBasemapDark);
  // Dark prefecture fill
  if (_prefGeoData) {
    L.geoJSON(_prefGeoData, {
      style: function() { return {color:'transparent', weight:0, fillColor:'#1a1a2e', fillOpacity:1}; },
      interactive: false
    }).addTo(offlineBasemapDark);
    // Dark subdivision boundaries (under the prefecture borders)
    if (_subareaGeoData) {
      L.geoJSON(_subareaGeoData, {
        style: function() { return {color:'#4a3f68', weight:0.7, fillOpacity:0, opacity:0.45}; },
        interactive: false
      }).addTo(offlineBasemapDark);
    }
    // Dark prefecture boundaries (with hover highlight)
    _prefLayerDark = L.geoJSON(_prefGeoData, {
      style: function() { return {color:'#5a4590', weight:1.8, fillOpacity:0, dashArray:'6,4', opacity:0.6}; },
      onEachFeature: function(feature, layer) {
        var name = feature.properties.nam_ja || feature.properties.nam;
        layer.bindTooltip(name, {permanent:true, direction:'center', className:'pref-label', opacity:0.35});
        layer.on('mouseover', function() {
          setPrefectureHover(_prefLayerDark, layer, {color:'#8b6fc0', weight:4, dashArray:null, opacity:1});
        });
        layer.on('mouseout', function() {
          if (_hoveredPrefLayer === layer) clearPrefectureHover();
        });
      }
    }).addTo(offlineBasemapDark);
  } else if (typeof _landPolygon !== 'undefined' && _landPolygon) {
    // Fallback: 50m land in dark
    L.geoJSON({type:'FeatureCollection', features:[_landPolygon]}, {
      style: function() { return {color:'#3a5060', weight:1.0, fillColor:'#1a1a2e', fillOpacity:1}; },
      interactive: false
    }).addTo(offlineBasemapDark);
  }
  // Dark city markers
  var majorCities = [
    {name:'東京',lat:35.68,lng:139.76},{name:'大阪',lat:34.69,lng:135.50},
    {name:'名古屋',lat:35.18,lng:136.90},{name:'札幌',lat:43.06,lng:141.35},
    {name:'福岡',lat:33.59,lng:130.40},{name:'仙台',lat:38.27,lng:140.87},
    {name:'広島',lat:34.39,lng:132.46},{name:'那覇',lat:26.21,lng:127.68},
    {name:'新潟',lat:37.90,lng:139.04},{name:'静岡',lat:34.98,lng:138.38},
    {name:'金沢',lat:36.56,lng:136.66},{name:'高松',lat:34.34,lng:134.05}
  ];
  for (var ci = 0; ci < majorCities.length; ci++) {
    var ct = majorCities[ci];
    L.circleMarker([ct.lat, ct.lng], {
      radius: 3, color:'#666', fillColor:'#2a2a3e', fillOpacity:0.9, weight:1.5
    }).bindTooltip(ct.name, {permanent:true, direction:'right', className:'city-label', offset:[4,0]})
      .addTo(offlineBasemapDark);
  }
}

// Tiles: try local cache first, fallback to GSI Japan directly
var osmTileUrl = '/tiles/osm/{z}/{x}/{y}.png';
var gsiTileUrl = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';

var gsiTileLayer = L.tileLayer(gsiTileUrl, { attribution: 'GSI Japan', maxZoom: 18 });
var localTileLayer = L.tileLayer(osmTileUrl, { attribution: 'OSM (local)', maxZoom: 10 });

var tileDefs = {
  'tile.offline': offlineBasemap,
  'tile.offline_dark': offlineBasemapDark,
  'tile.gsi_std': gsiTileLayer,
  'tile.osm': localTileLayer,
  'tile.gsi_pale': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {attribution:'GSI Japan',maxZoom:18}),
  'tile.topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {attribution:'OpenTopoMap',maxZoom:17})
};

// Default: offline vector basemap (no network needed)
offlineBasemap.addTo(map);

// Tile error fallback: if online tiles fail, show a brief warning
var _tileWarnShown = false;
map.on('tileerror', function(e) {
  if (_tileWarnShown) return;
  _tileWarnShown = true;
  var w = document.createElement('div');
  w.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;'
    + 'background:rgba(200,40,20,.9);color:#fff;padding:8px 20px;border-radius:6px;'
    + 'font-size:.8em;font-weight:700;pointer-events:none;transition:opacity 1s';
  w.textContent = t('tile.warn');
  document.body.appendChild(w);
  setTimeout(function() { w.style.opacity = '0'; setTimeout(function() { w.remove(); }, 1000); }, 4000);
});

var layerNames = {};
for (var k in tileDefs) layerNames[t(k)] = tileDefs[k];
var layerControl = L.control.layers(layerNames, null, {position:'bottomright'}).addTo(map);

// Lazy-build dark offline basemap on first selection
map.on('baselayerchange', function(e) {
  clearPrefectureHover();
  if (e.name === t('tile.offline_dark') && !_offlineDarkBuilt) {
    buildDarkOfflineBasemap();
  }
});

function rebuildLayerControl() {
  map.removeControl(layerControl);
  var lc = {};
  for (var k in tileDefs) lc[t(k)] = tileDefs[k];
  layerControl = L.control.layers(lc, null, {position:'bottomright'}).addTo(map);
}

// -- Fixed station network generation --
var TOTAL_STATIONS = 0; // set after loading

async function loadRealStations() {
  try {
    var resp = await fetch('/geojson/stations.json');
    if (resp.ok) {
      var data = await resp.json();
      console.log('Loaded ' + data.length + ' real stations');
      return data;
    }
  } catch(e) { console.warn('Station JSON load failed:', e); }
  // Fallback: coarse grid
  return generateFallbackStations();
}

function generateFallbackStations() {
  var pts = [], step = 0.3;
  for (var lat = 24; lat <= 46; lat += step)
    for (var lng = 122; lng <= 150; lng += step)
      pts.push({lat:lat, lng:lng, id:pts.length});
  return pts;
}

// -- GeoJSON loading --
async function loadJapanGeoJSON() {
  statusText.textContent = t('status.loading');
  updateMapLoadingProgress(5, 'Fetching coastline data… / 加载海岸线数据…');
  try {
    // Try 1:10m high-res coastline first, fallback to 1:50m
    var resp = await fetch('/geojson/coastline_10m.json');
    if (!resp.ok) resp = await fetch('/geojson/coastline_50m.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    japanLandPolygons = await resp.json();
    if (typeof _quake3dPushGeo === 'function') _quake3dPushGeo(); // push coastline to 3D scene
    // Land fill: zoom-adaptive thick coastline stroke + 1:50m polygon fill
    var _coastThick = L.geoJSON(japanLandPolygons, {
      style: function() {
        var z = map.getZoom();
        var w = z <= 5 ? 30 : z <= 6 ? 22 : z <= 7 ? 16 : z <= 8 ? 10 : 6;
        return {color:"#e8e0d5", weight:w, fillOpacity:0, lineCap:"round", lineJoin:"round"};
      },
      interactive: false
    }).addTo(offlineBasemap);
    // Update thick stroke on zoom
    map.on('zoomend', function() {
      _coastThick.setStyle(function() {
        var z = map.getZoom();
        var w = z <= 5 ? 30 : z <= 6 ? 22 : z <= 7 ? 16 : z <= 8 ? 10 : 6;
        return {color:"#e8e0d5", weight:w, fillOpacity:0, lineCap:"round", lineJoin:"round"};
      });
    });
    // Coastline border: single crisp thin line
    L.geoJSON(japanLandPolygons, {
      style: function() { return {color:"#7a8a99", weight:1.2, fillOpacity:0}; },
      interactive: false
    }).addTo(offlineBasemap);
    buildCoastSegments();
    updateMapLoadingProgress(15, 'Coastline ready · 海岸線OK');
    // Start independent datasets together so network latency is paid once.
    var stationsPromise = loadRealStations();
    var terrainPromises = [
      fetch('/geojson/bathymetry.json').catch(function(){ return null; }),
      fetch('/geojson/vs30.json').catch(function(){ return null; }),
      fetch('/geojson/jma_tsunami_forecast_areas.json').catch(function(){ return null; }),
      fetch('/geojson/research_data_manifest.json').catch(function(){ return null; }),
      fetch('/geojson/historical_tsunami_observations.json').catch(function(){ return null; })
    ];
    // Optional GMPE calibration table (magnitude-binned intensity bias from
    // tools/calibrate-gmpe.js over server recordings). Absent table = identity.
    fetch('/geojson/gmpe-calibration.json').then(function(r){ return r.ok ? r.json() : null; })
      .then(function(t){ if (t && Physics.setGmpeCalibration) Physics.setGmpeCalibration(t); })
      .catch(function(){});
    var prefPromises = [
      fetch('/geojson/pref_population.json').catch(function(){ return null; }),
      fetch('/geojson/japan_prefectures.geojson').catch(function(){ return null; }),
      fetch('/geojson/jma_subareas.json').catch(function(){ return null; })
    ];
    // Load bathymetry data (seafloor depth grid)
    try {
      var terrainResponses = await Promise.all(terrainPromises);
      var bathyResp = terrainResponses[0];
      if (bathyResp && bathyResp.ok) {
        _bathyGrid = await bathyResp.json();
        var terrainCheck = Physics.validateResearchGrid(_bathyGrid, 'terrain');
        if (!terrainCheck.valid) throw new Error('Invalid terrain grid: ' + terrainCheck.errors.join(', '));
        console.log('Terrain loaded:', _bathyGrid.nx + 'x' + _bathyGrid.ny, 'resolution:', _bathyGrid.res + '°', terrainCheck.meta);
        var bathyRow = document.getElementById('bathy-row');
        if (bathyRow) bathyRow.style.display = '';
      }
    } catch(e) { _bathyGrid = null; /* bathymetry not available */ }
    try {
      var vs30Resp = terrainResponses && terrainResponses[1];
      if (vs30Resp && vs30Resp.ok) {
        var candidateVs30 = await vs30Resp.json();
        var vs30Check = Physics.validateResearchGrid(candidateVs30, 'vs30');
        if (vs30Check.valid) _vs30Grid = candidateVs30;
      }
    } catch(e) { _vs30Grid = null; }
    try {
      var tsunamiAreaResp = terrainResponses && terrainResponses[2];
      if (tsunamiAreaResp && tsunamiAreaResp.ok) _jmaTsunamiAreaData = await tsunamiAreaResp.json();
    } catch(e) { _jmaTsunamiAreaData = null; }
    try {
      var dataManifestResp = terrainResponses && terrainResponses[3];
      if (dataManifestResp && dataManifestResp.ok) _researchDataManifest = await dataManifestResp.json();
    } catch(e) { _researchDataManifest = null; }
    try {
      var historicalTsunamiResp = terrainResponses && terrainResponses[4];
      if (historicalTsunamiResp && historicalTsunamiResp.ok) {
        _historicalTsunamiData = await historicalTsunamiResp.json();
        var historicalCheck = TsunamiValidation.validate(_historicalTsunamiData);
        _tsunamiObservationsReady = historicalCheck.researchReady;
        if (typeof _renderHistoricalTsunamiValidationDataset === 'function') _renderHistoricalTsunamiValidationDataset();
        if (_historicalTsunamiShow && typeof drawFrame === 'function') drawFrame();
      }
    } catch(e) { _historicalTsunamiData = null; _tsunamiObservationsReady = false; }
    _updateResearchDataCertification();
    if (typeof _quake3dPushGeo === 'function') _quake3dPushGeo(); // push terrain to 3D scene
    updateMapLoadingProgress(35, 'Bathymetry loaded · 海底地形OK');
    // --- Japan prefecture data (used for land fill AND boundary lines) ---
    _prefGeoData = null;
    var prefResponses = await Promise.all(prefPromises);
    try {
      // Prefecture population data (optional, for affected pop estimate)
      var popResp = prefResponses[0];
      if (popResp && popResp.ok) _prefPopData = await popResp.json();
    } catch(e) { /* optional */ }
    try {
      var prefResp = prefResponses[1];
      if (prefResp && prefResp.ok) _prefGeoData = await prefResp.json();
    } catch(e) { /* prefecture file not available */ }
    try {
      var subareaResp = prefResponses[2];
      if (subareaResp && subareaResp.ok) _subareaGeoData = await subareaResp.json();
    } catch(e) { _subareaGeoData = null; /* subdivision map optional */ }
    updateMapLoadingProgress(50, 'Prefecture data loaded · 都道府県データOK');
    // Pre-compute prefecture centroids for fast GMPE forecast
    if (_prefGeoData && _prefGeoData.features) {
      _prefCentroids = [];
      for (var pi = 0; pi < _prefGeoData.features.length; pi++) {
        var f = _prefGeoData.features[pi];
        var c = turf.centroid(f);
        _prefCentroids.push({
          id: f.properties.id, nam: f.properties.nam,
          nam_ja: f.properties.nam_ja,
          lat: c.geometry.coordinates[1],
          lng: c.geometry.coordinates[0]
        });
      }
      // Pre-compute bboxes for fast point-in-polygon rejection (used by _computePrefectureShindos)
      _prefBBoxes = [];
      for (var pj = 0; pj < _prefGeoData.features.length; pj++) {
        _prefBBoxes.push(turf.bbox(_prefGeoData.features[pj]));
      }
    }
    // Pre-compute subdivision centroids/bboxes for the finer live coloring
    if (_subareaGeoData && _subareaGeoData.features) {
      _subareaCentroids = [];
      _subareaBBoxes = [];
      for (var sa = 0; sa < _subareaGeoData.features.length; sa++) {
        var sf = _subareaGeoData.features[sa];
        var sc = turf.centroid(sf).geometry.coordinates;
        _subareaCentroids.push({
          id: sf.properties.name, nam: sf.properties.name, nam_ja: sf.properties.name,
          lat: sc[1], lng: sc[0]
        });
        _subareaBBoxes.push(turf.bbox(sf));
      }
    }
    buildJmaTsunamiForecastAreas();
    // Land fill: filled prefecture polygons (no stroke) = precise land shape
    if (_prefGeoData) {
      L.geoJSON(_prefGeoData, {
        style: function() { return {color:'transparent', weight:0, fillColor:'#e8e0d5', fillOpacity:1}; },
        interactive: false
      }).addTo(offlineBasemap);
    } else {
      // Fallback: 1:50m land
      try {
        var landResp = await fetch('/geojson/ne_50m_land.geojson');
        if (landResp.ok) {
          L.geoJSON(await landResp.json(), {
            style: function() { return {color:'#7a8a99', weight:1.0, fillColor:'#e8e0d5', fillOpacity:1}; },
            interactive: false
          }).addTo(offlineBasemap);
        }
      } catch(e) { console.warn('Offline basemap add failed:', e); }
    }
    // JMA 地震情報細分区域 boundary lines (thin solid, UNDER the prefecture
    // borders) — Hokkaido & co. show their subdivisions on the base map
    if (_subareaGeoData) {
      L.geoJSON(_subareaGeoData, {
        style: function() { return {color:'#a89a90', weight:0.8, fillOpacity:0, opacity:0.55}; },
        interactive: false
      }).addTo(offlineBasemap);
    }
    // Japan prefecture boundary lines (dashed, with hover + labels)
    if (_prefGeoData) {
      _prefLayer = L.geoJSON(_prefGeoData, {
        style: function() { return {color:'#8b7f8f', weight:2.0, fillOpacity:0, dashArray:'6,4', opacity:0.85}; },
        onEachFeature: function(feature, layer) {
          var name = feature.properties.nam_ja || feature.properties.nam;
          layer.bindTooltip(name, {
            permanent: true, direction: 'center',
            className: 'pref-label', opacity: 0.6
          });
          layer.on('mouseover', function() {
            setPrefectureHover(_prefLayer, layer, {color:'#5a4080', weight:4, dashArray:null, opacity:1});
          });
          layer.on('mouseout', function() {
            if (_hoveredPrefLayer === layer) clearPrefectureHover();
          });
        }
      }).addTo(offlineBasemap);
    }
    // Major city markers
    var majorCities = [
      {name:'東京',lat:35.68,lng:139.76},{name:'大阪',lat:34.69,lng:135.50},
      {name:'名古屋',lat:35.18,lng:136.90},{name:'札幌',lat:43.06,lng:141.35},
      {name:'福岡',lat:33.59,lng:130.40},{name:'仙台',lat:38.27,lng:140.87},
      {name:'広島',lat:34.39,lng:132.46},{name:'那覇',lat:26.21,lng:127.68},
      {name:'新潟',lat:37.90,lng:139.04},{name:'静岡',lat:34.98,lng:138.38},
      {name:'金沢',lat:36.56,lng:136.66},{name:'高松',lat:34.34,lng:134.05}
    ];
    for (var ci = 0; ci < majorCities.length; ci++) {
      var ct = majorCities[ci];
      L.circleMarker([ct.lat, ct.lng], {
        radius: 3, color:'#555', fillColor:'#fff', fillOpacity:0.9, weight:1.5
      }).bindTooltip(ct.name, {permanent:true, direction:'right', className:'city-label', offset:[4,0]})
        .addTo(offlineBasemap);
    }
    // Load japan.json (for isOceanPoint land detection only)
    try {
      var lpResp = await fetch('/geojson/japan.json');
      if (lpResp.ok) {
        _landPolygon = (await lpResp.json()).features[0];
        try { _landBBox = turf.bbox(_landPolygon); } catch(e) { _landBBox = null; }
        _oceanPointCache = {};
      }
    } catch(e) { console.warn('japan.json load failed:', e); }
    updateMapLoadingProgress(65, 'Land data ready · 陸地データOK');
    // Load real seismic stations
    rawLandGrid = await stationsPromise;
    updateMapLoadingProgress(80, 'Stations loaded · 観測点データOK');
  } catch(e) {
    console.warn('GeoJSON failed:', e);
    rawLandGrid = generateFallbackStations();
    updateMapLoadingProgress(70, 'Using fallback stations · 代替データ使用中');
    statusText.textContent = t('status.land_fallback');
  }
  // Load the official NIED seafloor catalog (DONET, S-net, and N-net).
  try {
    var sfResp = await fetch('/geojson/seafloor_stations.json?v=eae183');
    if (sfResp.ok) {
      var sfData = await sfResp.json();
      for (var sfi = 0; sfi < sfData.length; sfi++) {
        sfData[sfi].isSeafloor = true;
        sfData[sfi].id = rawLandGrid.length + sfi;
      }
      rawLandGrid = rawLandGrid.concat(sfData);
      console.log('Loaded ' + sfData.length + ' official seafloor stations (DONET + S-net + N-net)');
    }
  } catch(e) { /* seafloor stations not available */ }
  updateMapLoadingProgress(90, 'Seafloor stations merged · 海底観測点OK');
  TOTAL_STATIONS = rawLandGrid.length;
  statusText.textContent = t('status.land_ok') + ' - ' + TOTAL_STATIONS + ' stations';
  buildGridCells();
  // Hide map loading overlay — map is ready for simulation
  updateMapLoadingProgress(100, 'Map ready! · 地図準備完了');
  var mapOverlay = document.getElementById('map-loading-overlay');
  if (mapOverlay) {
    // Brief delay so user sees 100% bar fill
    setTimeout(function() { mapOverlay.style.display = 'none'; }, 400);
    setTimeout(function() { mapOverlay.style.opacity = '0'; }, 200);
    mapOverlay.style.transition = 'opacity .4s ease';
  }
  _mapReady = true;
  if (mapEl) mapEl.setAttribute('aria-busy', 'false');
  if (btnStart) btnStart.disabled = false;
}

function buildGridCells() {
  gridCells = []; stationToCell = {};
  for (var lat = GRID_ORIGIN_LAT; lat < 46.5; lat += GRID_CELL)
    for (var lng = GRID_ORIGIN_LNG; lng < 150; lng += GRID_CELL)
      gridCells.push({minLat:lat, maxLat:lat+GRID_CELL, minLng:lng, maxLng:lng+GRID_CELL, onLand:false});
  // Map stations to cells using station id (not coordinate key)
  // Skip ocean stations (safety net: stations.json should already be land-filtered)
  for (var si = 0; si < rawLandGrid.length; si++) {
    var sp = rawLandGrid[si];
    if (japanLandPolygons && isOceanPoint(sp.lat, sp.lng)) continue;
    var ri = Math.floor((sp.lat - GRID_ORIGIN_LAT) / GRID_CELL);
    var ci = Math.floor((sp.lng - GRID_ORIGIN_LNG) / GRID_CELL);
    var idx = ri * GRID_COLS + ci;
    if (idx >= 0 && idx < gridCells.length) {
      gridCells[idx].onLand = true;
      stationToCell[sp.id] = idx;
    }
  }
}

// -- Ocean / Tsunami --
function _bboxContains(b, lat, lng) {
  return b && lng >= b[0] && lat >= b[1] && lng <= b[2] && lat <= b[3];
}

function _isLandByPolygons(lat, lng) {
  var pt = null;

  // Use actual prefecture polygons, not japanLandPolygons (that variable holds coastline lines).
  if (_prefGeoData && _prefGeoData.features) {
    var features = _prefGeoData.features;
    for (var i = 0; i < features.length; i++) {
      var bb = _prefBBoxes && _prefBBoxes[i];
      if (bb && !_bboxContains(bb, lat, lng)) continue;
      if (!pt) pt = turf.point([lng, lat]);
      try { if (turf.booleanPointInPolygon(pt, features[i])) return true; } catch(e) { /* degenerate geometry */ }
    }
  }

  if (_landPolygon) {
    if (!_landBBox) { try { _landBBox = turf.bbox(_landPolygon); } catch(e) { _landBBox = null; } }
    if (!_landBBox || _bboxContains(_landBBox, lat, lng)) {
      if (!pt) pt = turf.point([lng, lat]);
      try { if (turf.booleanPointInPolygon(pt, _landPolygon)) return true; }
      catch(e) { /* degenerate geometry */ }
    }
  }
  return false;
}

function isOceanPoint(lat, lng) {
  var key = Math.round(lat * 1000) + ',' + Math.round(lng * 1000);
  if (Object.prototype.hasOwnProperty.call(_oceanPointCache, key)) return _oceanPointCache[key];

  // Land polygons are authoritative for Japan. The approximate bathymetry grid is
  // useful for offshore depth, but it can mark inland cells as negative depth.
  if (_isLandByPolygons(lat, lng)) return (_oceanPointCache[key] = false);

  var wd = _waterDepth ? _waterDepth(lat, lng) : null;
  if (wd !== null && wd !== undefined) return (_oceanPointCache[key] = wd > 0);

  // No reliable land/ocean data: assume land (safe default for tsunami propagation).
  return (_oceanPointCache[key] = false);
}

// Bathymetry helpers (uses _bathyGrid for depth queries)
function _getDepth(lat, lng) {
  // Returns water depth in meters (negative = below sea level, positive = land elevation)
  // Returns null if no data available
  if (!_bathyGrid) return null;
  var col = (lng - _bathyGrid.origin[0]) / _bathyGrid.res;
  var row = (lat - _bathyGrid.origin[1]) / _bathyGrid.res;
  var ix = Math.floor(col), iy = Math.floor(row);
  if (ix < 0 || ix >= _bathyGrid.nx - 1 || iy < 0 || iy >= _bathyGrid.ny - 1) return null;
  // Bilinear interpolation
  var fx = col - ix, fy = row - iy;
  var d00 = _bathyGrid.data[iy * _bathyGrid.nx + ix];
  var d10 = _bathyGrid.data[iy * _bathyGrid.nx + ix + 1];
  var d01 = _bathyGrid.data[(iy + 1) * _bathyGrid.nx + ix];
  var d11 = _bathyGrid.data[(iy + 1) * _bathyGrid.nx + ix + 1];
  var d0 = d00 + (d10 - d00) * fx;
  var d1 = d01 + (d11 - d01) * fx;
  var depth = d0 + (d1 - d0) * fy;
  // Grid convention: positive = elevation above sea level, negative = water depth.
  // The bundled grid is synthetic and approximate, not an ETOPO/GEBCO product.
  return depth;
}

function _waterDepth(lat, lng) {
  // Returns positive water depth in meters (0 for land), null if no data
  var d = _getDepth(lat, lng);
  if (d === null) return null;
  if (d >= 0) return 0; // land
  return -d; // positive depth
}

function _sampleMeanDepth(lat1, lng1, lat2, lng2, numSamples) {
  // Sample water depth along a great-circle path, return mean of ocean points
  if (!_bathyGrid) return null;
  numSamples = numSamples || 20;
  var sum = 0, count = 0;
  for (var i = 0; i <= numSamples; i++) {
    var t = i / numSamples;
    var lat = lat1 + (lat2 - lat1) * t;
    var lng = lng1 + (lng2 - lng1) * t;
    var d = _waterDepth(lat, lng);
    if (d !== null && d > 0) { sum += d; count++; }
  }
  return count > 0 ? sum / count : null;
}

function calcTsunamiHeight(mag,distKm){return Physics.calcTsunamiHeight(mag,distKm,cfgGet("tsuCoefA"),cfgGet("tsuCoefB"));}

var TSUNAMI_WARN_COLORS = {
  'major': '#ee5a24', 'warn': '#ff9f43', 'adv': '#ffe066'
};

function tsunamiZoneId(zone,index) {
  if(zone&&zone.id!=null)return String(zone.id);
  return zone&&zone.bbox?'bbox:'+zone.bbox.map(function(v){return Number(v).toFixed(5);}).join(','):'zone:'+index;
}

function findTsunamiInundationZone(latlng) {
  if(!latlng||!_tsuResearchSnapshot||!_tsunamiEl||!_tsunamiEl.checked||cfgGet('tsunamiMapMode')!=='cityInundation')return null;
  var zones=_tsuResearchSnapshot.inundationZones||[],best=null,bestArea=Infinity;
  for(var i=0;i<zones.length;i++){
    var zone=zones[i],bbox=zone&&zone.bbox;
    if(!bbox||bbox.length<4||latlng.lng<bbox[0]||latlng.lng>bbox[2]||latlng.lat<bbox[1]||latlng.lat>bbox[3])continue;
    var area=Math.abs((bbox[2]-bbox[0])*(bbox[3]-bbox[1]));
    if(area<bestArea){bestArea=area;best={zone:zone,index:i,id:tsunamiZoneId(zone,i)};}
  }
  return best;
}

function renderTsunamiZoneDetails(zone,index) {
  var panel=document.getElementById('tsunami-zone-details'),body=document.getElementById('tsunami-zone-detail-body');
  if(!panel||!body||!zone)return;
  var bbox=zone.bbox||[0,0,0,0],centerLat=(Number(bbox[1])+Number(bbox[3]))/2,centerLng=(Number(bbox[0])+Number(bbox[2]))/2;
  var arrival=zone.arrivalTime==null?'—':Math.round(zone.arrivalTime)+' s ('+(Number(zone.arrivalTime)/60).toFixed(1)+' min)';
  var signature=[tsunamiZoneId(zone,index),zone.maxDepth,zone.maxSurface,zone.maxVelocity,zone.arrivalTime,zone.areaKm2,zone.cells,cl].join('|');
  if(_tsunamiZoneDetailSignature===signature&&!panel.hidden)return;
  _tsunamiZoneDetailSignature=signature;
  body.innerHTML=infoRow(escapeHTML(t('tsunami.zone.center')),centerLat.toFixed(3)+'°N '+centerLng.toFixed(3)+'°E')+
    infoRow(escapeHTML(t('tsunami.zone.max_depth')),Number(zone.maxDepth||0).toFixed(2)+' m')+
    infoRow(escapeHTML(t('tsunami.zone.max_surface')),Number(zone.maxSurface||0).toFixed(2)+' m')+
    infoRow(escapeHTML(t('tsunami.zone.max_velocity')),Number(zone.maxVelocity||0).toFixed(2)+' m/s')+
    infoRow(escapeHTML(t('tsunami.zone.arrival')),arrival)+
    infoRow(escapeHTML(t('tsunami.zone.area')),Number(zone.areaKm2||0).toFixed(2)+' km²')+
    infoRow(escapeHTML(t('tsunami.zone.cells')),Math.max(0,Number(zone.cells)||0));
  panel.hidden=false;
}

function clearTsunamiZoneSelection(redraw) {
  _tsunamiSelectedZoneId=null;_tsunamiHoveredZoneId=null;_tsunamiZoneDetailSignature='';
  var panel=document.getElementById('tsunami-zone-details');if(panel)panel.hidden=true;
  if(mapEl)mapEl.classList.remove('tsunami-zone-hover');
  if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
  if(redraw!==false&&typeof drawFrame==='function')drawFrame();
}

function tsunamiModeNeedsNonlinearSolver(mode) {
  return mode === 'maxInundation' || mode === 'cityInundation';
}

function syncAdvancedSelectValue(key,value) {
  var select=document.querySelector('.adv-row[data-cfg="'+key+'"] select');
  if(select)select.value=value;
}

function resetTsunamiSolverRuntime() {
  if (typeof TsunamiSolverHost !== 'undefined') TsunamiSolverHost.resetAll();
  _tsuWaveSolvers={};_tsuTravelFields={};_tsuLastUpdateMs=-Infinity;
  _tsuResearchSnapshot=null;_tsuResearchSnapshotKey='';
  clearTsunamiZoneSelection(false);
  if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
}

// Config keys read at solver/travel-field creation time. Changing one must
// rebuild the runtime, otherwise the running simulation keeps the old
// physics while the UI claims otherwise.
var TSU_RUNTIME_CFG_KEYS=['tsunamiManning','tsunamiDryTolerance','tsunamiArrivalThreshold',
  'tsunamiCoriolis','tsunamiAggregationKm','tsunamiBoundary','tsunamiDeformationModel',
  'tsunamiHorizontalSlope','tsuSpeed'];
function onTsunamiRuntimeConfigChanged() {
  resetTsunamiSolverRuntime();
  if(!isRunning)rebuildTsunamiResearchSnapshot();
  if(typeof drawFrame==='function')drawFrame();
}

function rebuildTsunamiResearchSnapshot() {
  var event=typeof mainEvent==='function'?mainEvent():null;
  if(!_bathyGrid||!event||!isOceanPoint(event.lat,event.lng))return false;
  try{
    var solver=_tsuSolverForEvent(event);
    if(!solver||!solver.getSnapshot)return false;
    solver.advanceTo(Math.max(0,simElapsed-Number(event.originTime||0)));
    var stride=map.getZoom()>=8?1:(map.getZoom()>=6?2:3);
    _tsuResearchSnapshot=solver.getSnapshot(stride);
    return true;
  }catch(error){console.warn('Tsunami snapshot rebuild failed.',error);return false;}
}

function ensureTsunamiMapModeCompatible(mode) {
  if(!tsunamiModeNeedsNonlinearSolver(mode)||cfgGet('tsunamiSolver')==='nonlinearSWE')return false;
  cfgSet('tsunamiSolver','nonlinearSWE');
  syncAdvancedSelectValue('tsunamiSolver','nonlinearSWE');
  resetTsunamiSolverRuntime();
  if(!isRunning)rebuildTsunamiResearchSnapshot();
  return true;
}

function applyTsunamiSolverCompatibility(solverMode) {
  resetTsunamiSolverRuntime();
  var mapMode=cfgGet('tsunamiMapMode');
  if(solverMode==='nonlinearSWE'||!tsunamiModeNeedsNonlinearSolver(mapMode))return;
  cfgSet('tsunamiMapMode','maxSurface');
  syncAdvancedSelectValue('tsunamiMapMode','maxSurface');
  var mapSelect=document.getElementById('tsunami-layer-select');if(mapSelect)mapSelect.value='maxSurface';
  if(typeof drawFrame==='function')drawFrame();
}

function selectTsunamiInundationZone(hit) {
  if(!hit)return false;
  var changed=_tsunamiSelectedZoneId!==hit.id;
  _tsunamiSelectedZoneId=hit.id;renderTsunamiZoneDetails(hit.zone,hit.index);
  if(changed&&typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
  if(changed&&!isRunning&&typeof drawFrame==='function')drawFrame();
  return true;
}

// Editable multi-event orchestration list: per-event origin-time inputs and
// delete buttons, replacing the old "Events: N" one-liner. markers[i] always
// corresponds to customEvents[i+1] (event 1 is the epicenter marker).
function _renderMultiEventList() {
  var info = document.getElementById('multi-event-info');
  if (!info) return;
  if (!multiEventMode || customEvents.length === 0) { info.style.display = 'none'; info.innerHTML = ''; return; }
  info.style.display = 'block';
  var html = '';
  for (var i = 0; i < customEvents.length; i++) {
    var ev = customEvents[i];
    html += '<div class="me-row">' +
      '<span class="me-n">#' + (i + 1) + '</span>' +
      '<span class="me-m">M' + ev.mag.toFixed(1) + '</span>' +
      '<span class="me-d">' + Math.round(ev.depth) + 'km</span>' +
      '<label class="me-t">t=<input type="number" class="me-time" data-idx="' + i + '" min="0" max="3600" step="1" value="' + Math.round(ev.time || 0) + '">s</label>' +
      (i > 0 ? '<button type="button" class="me-del" data-idx="' + i + '">&times;</button>' : '<span class="me-del-sp"></span>') +
    '</div>';
  }
  info.innerHTML = html;
  var times = info.querySelectorAll('.me-time');
  for (var ti = 0; ti < times.length; ti++) {
    times[ti].addEventListener('change', function() {
      var idx = +this.dataset.idx;
      var v = Math.max(0, Math.min(3600, +this.value || 0));
      if (customEvents[idx]) { customEvents[idx].time = v; this.value = v; updateEpicenterInfo(); }
    });
  }
  var dels = info.querySelectorAll('.me-del');
  for (var di = 0; di < dels.length; di++) {
    dels[di].addEventListener('click', function() {
      var idx = +this.dataset.idx;
      if (idx <= 0 || idx >= customEvents.length) return;
      customEvents.splice(idx, 1);
      var mk = multiEventMarkers[idx - 1];
      if (mk) { map.removeLayer(mk); multiEventMarkers.splice(idx - 1, 1); }
      // Renumber the remaining numbered markers (event 1 = epicenter marker).
      for (var ri = 0; ri < multiEventMarkers.length; ri++) {
        multiEventMarkers[ri].setIcon(L.divIcon({
          className: 'multi-event-marker',
          html: '<div style="background:#ff5032;color:#fff;border-radius:50%;width:20px;height:20px;text-align:center;line-height:20px;font-size:10px;font-weight:700">' + (ri + 2) + '</div>',
          iconSize: [20, 20], iconAnchor: [10, 10]
        }));
      }
      _renderMultiEventList();
      _syncChainMagToSliders();
      updateEpicenterInfo();
    });
  }
}

// --- v5.5: manual aftershock editor ----------------------------------------
// User-defined aftershocks {time (sim s after start), mag, depth}. Merged
// into the catalog at sim start; they shake stations, spawn wave-ring events
// (>= asyEventThr) and appear on the aftershock timeline like generated ones.
function _syncAsManualPanel() {
  var p = document.getElementById('aftershock-manual');
  var sw = document.getElementById('aftershock-enable');
  var show = !!(sw && sw.checked);
  if (p) p.style.display = show ? 'block' : 'none';
  if (!show) _asManPickSetArmed(false);
}
function _renderManualAftershocks() {
  var list = document.getElementById('as-manual-list');
  if (!list) return;
  if (!manualAftershocks.length) {
    list.innerHTML = '<div class="as-man-empty">' + t('aftershock.man_empty') + '</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < manualAftershocks.length; i++) {
    var a = manualAftershocks[i];
    var hasLoc = isFinite(+a.lat) && isFinite(+a.lng);
    html += '<div class="me-row">' +
      '<span class="me-m">M' + a.mag.toFixed(1) + '</span>' +
      '<span class="me-d"' + (hasLoc ? ' title="' + (+a.lat).toFixed(2) + ', ' + (+a.lng).toFixed(2) + '"' : '') + '>' + Math.round(a.depth) + 'km' + (hasLoc ? ' ⌖' : '') + '</span>' +
      '<label class="me-t">t=<input type="number" class="me-time as-man-time" data-idx="' + i + '" min="0" max="3600" step="1" value="' + Math.round(a.time) + '">s</label>' +
      '<button type="button" class="me-del as-man-del" data-idx="' + i + '">&times;</button>' +
    '</div>';
  }
  list.innerHTML = html;
  var times = list.querySelectorAll('.as-man-time');
  for (var ti = 0; ti < times.length; ti++) {
    times[ti].addEventListener('change', function() {
      var idx = +this.dataset.idx;
      var v = Math.max(0, Math.min(3600, +this.value || 0));
      if (manualAftershocks[idx]) { manualAftershocks[idx].time = v; this.value = v; }
    });
  }
  var dels = list.querySelectorAll('.as-man-del');
  for (var di = 0; di < dels.length; di++) {
    dels[di].addEventListener('click', function() {
      var idx = +this.dataset.idx;
      if (idx < 0 || idx >= manualAftershocks.length) return;
      manualAftershocks.splice(idx, 1);
      _renderManualAftershocks();
    });
  }
}

// One-shot map-pick for a manual aftershock's own epicenter. While armed the
// next map click is consumed as the pending location (see the map click
// handler) instead of moving the mainshock epicenter or adding a chain event.
var _asManPendingLoc = null;   // {lat, lng} for the next added entry, or null
var _asManPickArmed = false;
function _asManPickSetArmed(on) {
  _asManPickArmed = !!on;
  var btn = document.getElementById('as-man-loc');
  if (btn) btn.classList.toggle('armed', _asManPickArmed);
  if (document.body) document.body.classList.toggle('as-pick-armed', _asManPickArmed);
}
function _asManLocValShow() {
  var el = document.getElementById('as-man-loc-val');
  if (!el) return;
  if (_asManPendingLoc) {
    // Coordinates are data, not a language string — drop data-i18n so a
    // language switch does not clobber the readout.
    el.removeAttribute('data-i18n');
    el.textContent = _asManPendingLoc.lat.toFixed(2) + ', ' + _asManPendingLoc.lng.toFixed(2);
    el.classList.add('set');
  } else {
    el.setAttribute('data-i18n', 'aftershock.man_loc_default');
    el.textContent = t('aftershock.man_loc_default');
    el.classList.remove('set');
  }
}
function _asManClearPendingLoc() {
  _asManPendingLoc = null;
  _asManPickSetArmed(false);
  _asManLocValShow();
}

// --- Preset-to-chain orchestration -----------------------------------------
// Append any single-event preset (with its bundled fault model, if any) to
// the custom chain. The slider magnitude follows the chain's combined moment
// magnitude so the per-segment moment rescale stays ~1.0 (same convention as
// the bundled japanSinks preset).
function _chainCombinedMag() {
  if (!customEvents.length) return null;
  var m0 = 0;
  for (var i = 0; i < customEvents.length; i++) m0 += Physics.seismicMoment(customEvents[i].mag);
  return Physics.momentMagnitude(m0);
}
function _syncChainMagToSliders() {
  var combined = _chainCombinedMag();
  if (combined == null || !multiEventMode) return;
  _liveMag = +combined.toFixed(2);
  magSlider.value = _liveMag;
  magVal.textContent = 'M' + _liveMag.toFixed(1);
  var mn = document.getElementById('magnitude-num'); if (mn) mn.value = _liveMag;
}
function _addPresetToChain(key) {
  var p = PRESETS[key];
  if (!p || p.subEvents) return;
  var lastT = 0;
  for (var i = 0; i < customEvents.length; i++) lastT = Math.max(lastT, customEvents[i].time || 0);
  var ev = {lat: p.lat, lng: p.lng, mag: p.mag, depth: p.depth, strike: p.strike,
    dip: p.dip != null ? p.dip : 60, rake: p.rake != null ? p.rake : 90,
    mechanismKnown: true, faultModel: p.faultModel || null,
    time: customEvents.length === 0 ? 0 : lastT + 30};
  if (customEvents.length === 0) { setEpicenter(ev.lat, ev.lng); btnStart.disabled = false; }
  customEvents.push(ev);
  if (customEvents.length > 1) {
    var numIcon = L.divIcon({
      className: 'multi-event-marker',
      html: '<div style="background:#ff5032;color:#fff;border-radius:50%;width:20px;height:20px;text-align:center;line-height:20px;font-size:10px;font-weight:700">' + customEvents.length + '</div>',
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
    multiEventMarkers.push(L.marker([ev.lat, ev.lng], {icon: numIcon, zIndexOffset: 800 + customEvents.length}).addTo(map));
  }
  _syncChainMagToSliders();
  _renderMultiEventList();
  updateEpicenterInfo();
}

// -- Map interaction --
map.on('click', function(e) {
  // v5.5: an armed manual-aftershock location pick consumes this click — it
  // must not move the mainshock epicenter, add a chain event or open a zone.
  if (_asManPickArmed) {
    _asManPendingLoc = {lat: e.latlng.lat, lng: e.latlng.lng};
    _asManPickSetArmed(false);
    _asManLocValShow();
    return;
  }
  // v5.5: an armed realtime user-location pick consumes this click too.
  if (typeof RTEew !== 'undefined' && RTEew.isUserLocPickArmed && RTEew.isUserLocPickArmed()) {
    RTEew.completeUserLocPick(e.latlng.lat, e.latlng.lng);
    if (typeof RTData !== 'undefined' && RTData.syncUserLocRow) RTData.syncUserLocRow();
    return;
  }
  var zoneHit=findTsunamiInundationZone(e.latlng);
  if(zoneHit){selectTsunamiInundationZone(zoneHit);return;}
  if (isRunning || isCountingDown) return;
  if (multiEventMode) {
    // Multi-event: accumulate events with current slider params
    var ev = {
      lat: e.latlng.lat, lng: e.latlng.lng,
      mag: _liveMag,
      depth: _liveDepth,
      strike: parseFloat(strikeSlider.value),
      dip: currentDip,
      rake: currentRake,
      mechanismKnown: _rakeExplicit,
      time: (customEvents.length === 0) ? 0 : 30 * customEvents.length // t=0, then 30 s intervals (editable in the list)
    };
    customEvents.push(ev);
    // Editable orchestration list (per-event origin times + delete)
    _renderMultiEventList();
    // Create small marker on map
    if (!epicenterMarker) {
      setEpicenter(e.latlng.lat, e.latlng.lng);
      btnStart.disabled = false;
    } else {
      // Add numbered circle marker for additional events
      var numIcon = L.divIcon({
        className: 'multi-event-marker',
        html: '<div style=\"background:#ff5032;color:#fff;border-radius:50%;width:20px;height:20px;text-align:center;line-height:20px;font-size:10px;font-weight:700\">' + customEvents.length + '</div>',
        iconSize: [20,20], iconAnchor: [10,10]
      });
      var numMk = L.marker([e.latlng.lat, e.latlng.lng], {icon: numIcon, zIndexOffset: 800 + customEvents.length}).addTo(map);
      multiEventMarkers.push(numMk);
    }
    updateEpicenterInfo();
  } else {
    setEpicenter(e.latlng.lat, e.latlng.lng);
    customEvents = [];
  }
});

function setEpicenter(lat, lng) {
  _deactivateObservedFiniteFault('event-parameter-change');
  if (epicenterMarker) map.removeLayer(epicenterMarker);
  epicenter = {lat:lat, lng:lng};
  _canvasA11yState = null;
  epicenterSrc = null; eventMw = null; // manual placement → derive src from depth, slider M = Mw
  // Keep current dip/rake from sliders (user may have adjusted them)
  currentDip = parseFloat(dipSlider.value);
  currentRake = parseFloat(rakeSlider.value);
  isOceanEpicenter = isOceanPoint(lat, lng);
  if (isOceanEpicenter) _prefetchRegionalBathy(lat, lng);
  if (!_dipExplicit && typeof Physics !== 'undefined' && Physics.recommendedFaultDip) {
    currentDip = Physics.recommendedFaultDip(resolvedSourceType(_liveDepth, epicenterSrc, lat, lng, isOceanEpicenter));
    dipSlider.value=currentDip;
    var dipNumber=document.getElementById('dip-num');if(dipNumber)dipNumber.value=currentDip;
    refreshDipStateLabel();
  }
  var icon = L.divIcon({
    className: 'epicenter-marker',
    html: '<div class="epicenter-icon"><div class="cross-v"></div><div class="cross-h"></div><div class="epicenter-pulse"></div></div>',
    iconSize: [40,40], iconAnchor: [20,20]
  });
  epicenterMarker = L.marker([lat,lng], {icon:icon, zIndexOffset:1000}).addTo(map);
  epicenterMarker.bindTooltip(t('tooltip.epicenter'), {permanent:true, direction:'top', offset:[0,-25]}).openTooltip();
  updateEpicenterInfo();
  if (typeof _redrawInfoCharts === 'function') _redrawInfoCharts();
  if(typeof FiniteFaultEditor!=='undefined'&&FiniteFaultEditor.drawPreview)FiniteFaultEditor.drawPreview();
  btnStart.disabled = false;
}

function updateEpicenterInfo() {
  if (!epicenter) return;
  var m = _liveMag.toFixed(1), d = depthSlider.value;
  var cityName = (typeof nearestCityName === 'function') ? nearestCityName(epicenter.lat, epicenter.lng) : '';
  epicenterInfo.innerHTML =
    '<strong>' + escapeHTML(t('epicenter.set')) + (cityName ? ' — ' + escapeHTML(cityName) : '') + '</strong><br>' +
    escapeHTML(t('epicenter.lat')) + ': ' + epicenter.lat.toFixed(4) + '&deg;N  ' +
    escapeHTML(t('epicenter.lng')) + ': ' + epicenter.lng.toFixed(4) + '&deg;E<br>' +
    '<small>M' + escapeHTML(m) + ' / ' + escapeHTML(t('epicenter.depth')) + ' ' + escapeHTML(d) + ' km - ' + escapeHTML(t('epicenter.hint')) + '</small>';
  epicenterInfo.classList.add('set');
  updateSimulationSummary();
}

function updateSimulationSummary() {
  var el = document.getElementById('simulation-summary');
  if (!el) return;
  if (!epicenter) {
    el.classList.remove('ready');
    el.textContent = t('basic.summary_waiting');
    return;
  }
  var preset = document.getElementById('preset');
  var scenario = preset && preset.selectedIndex >= 0 ? preset.options[preset.selectedIndex].textContent : t('preset.custom');
  var flags = [];
  var tsu = document.getElementById('tsunami-enable');
  var det = document.getElementById('detect-mode');
  var asy = document.getElementById('aftershock-enable');
  var multi = document.getElementById('multi-event-mode');
  if (tsu && tsu.checked) flags.push(t('basic.flag_tsunami'));
  if (det && det.checked) flags.push(t('basic.flag_eew'));
  if (asy && asy.checked) flags.push(t('basic.flag_aftershock'));
  if (multi && multi.checked) flags.push(t('basic.flag_multi'));
  el.classList.add('ready');
  // v5.2: chain presets show the combined magnitude plus the sub-event count
  var _sumPreset = (typeof currentPreset !== 'undefined' && PRESETS[currentPreset]) ? PRESETS[currentPreset] : null;
  var _sumChain = (_sumPreset && _sumPreset.subEvents) ? _sumPreset.subEvents.length
    : ((typeof customEvents !== 'undefined' && customEvents.length > 1) ? customEvents.length : 0);
  el.innerHTML = '<b>M' + _liveMag.toFixed(1) + '</b>' + (_sumChain > 1 ? ' ×' + _sumChain : '') + ' · ' + Math.round(_liveDepth) + ' km · ' + escapeHTML(scenario) +
    (flags.length ? ' · ' + escapeHTML(flags.join(' / ')) : '');
}

// -- UI refresh (called from i18n.js) --
function refreshDynamicUI() {
  if (!isRunning && !isCountingDown && !epicenter) statusText.textContent = t('status.ready');
  if (epicenter && !isRunning && !isCountingDown) updateEpicenterInfo();
  if (isRunning || isCountingDown) btnStart.textContent = t('btn.start.running');
  else if (epicenter && simElapsed > 0) btnStart.textContent = t('btn.start.again');
  else btnStart.textContent = t('btn.start');
  if (epicenterMarker && epicenterMarker.getTooltip())
    epicenterMarker.setTooltipContent(t('tooltip.epicenter'));
  var legendTitle = document.querySelector('#legend h3');
  if (legendTitle) legendTitle.textContent = intensityScaleLabel() + (cfgGet('intensityScale') === 'shindo' ? '' : ' (display)');
  updateSimulationSummary();
  if (typeof advRefreshUI === 'function') advRefreshUI();
  refreshRakeStateLabel();
  refreshCanvasA11yDescriptions();
}

var _canvasA11yState = null;
var _scenarioCanvasIds = [
  'ff-preview', 'waveform-canvas', 'intensity-canvas', 'spectrum-canvas',
  'atten-canvas', 'gmpe-compare-canvas', 'azimuth-canvas', 'canvas-3d',
  'canvas-3d-mobile', 'source-spec-canvas', 'travel-canvas',
  'research-compare-waveform', 'focal-mechanism-canvas'
];
function setCanvasA11yDescription(id, description) {
  var canvas = document.getElementById(id);
  if (!canvas) return;
  var descId = id + '-scenario-description';
  var desc = document.getElementById(descId);
  if (!desc) {
    desc = document.createElement('p');
    desc.id = descId;
    desc.className = 'visually-hidden';
    canvas.insertAdjacentElement('afterend', desc);
  }
  if (desc.textContent !== description) desc.textContent = description;
  var describedBy = (canvas.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (describedBy.indexOf(descId) < 0) describedBy.push(descId);
  canvas.setAttribute('aria-describedby', describedBy.join(' '));
}
function refreshCanvasA11yDescriptions(curMaxPga, curMaxSh) {
  if (Number.isFinite(curMaxPga)) {
    _canvasA11yState = {pga:curMaxPga, shindo:curMaxSh};
  }
  var description = t('a11y.canvas.idle');
  if (epicenter) {
    var state = _canvasA11yState || {pga:0, shindo:'-'};
    var shindo = state.shindo == null || state.shindo === '' ? '-' : state.shindo;
    description = t('a11y.canvas.summary', {
      mag:Number(_liveMag || 0).toFixed(1),
      depth:Math.round(Number(_liveDepth || 0)),
      elapsed:Number(simElapsed || 0).toFixed(1),
      pga:Number(state.pga || 0).toFixed(1),
      shindo:String(shindo)
    });
  }
  for (var i = 0; i < _scenarioCanvasIds.length; i++) {
    setCanvasA11yDescription(_scenarioCanvasIds[i], description);
  }
}

// -- Audio --
function getSoundPath(name, lang) { return AudioManager.getSoundPath(name, lang); }

function preloadAudio() {
  var sounds = ['EEW_alert','PGA1','PGA2','Shindo0','Shindo1','Shindo2',
    'Shindo3','Shindo4','Shindo5','Shindo6','Shindo7',
    'Tsunami_1','Tsunami_2','Tsunami_3','Tsunami_lifted','EEW_canceled',
    'Bulletin_JMA','Bulletin_CENC','Bulletin_Other'];
  var lang = soundModeEl.value;
  if (lang === 'off') return;
  // Japanese EEW speech is synthesized as one complete sentence. EEW2 is the
  // legacy fixed voice and is retained only for the local EN/ZH modes.
  if (lang !== 'jp') sounds.push('EEW2');
  AudioManager.initContext();
  for (var i = 0; i < sounds.length; i++) {
    AudioManager.preloadBuffer(getSoundPath(sounds[i], lang));
  }
  // Japanese information speech is fully dynamic; local fragments are only
  // needed by the English and Chinese modes.
  if (lang === 'jp') return;
  // Also preload TTS info sounds
  var ttsNames = ['1','2','3','4','5-','5+','6-','6+','7','foreign'];
  for (var j = 0; j < ttsNames.length; j++) {
    AudioManager.preloadBuffer('sounds/' + lang + '/info/female/' + ttsNames[j] + '.wav');
  }
  // Preload bulletin TTS fragments (fixed phrases + intensity shorts)
  var bulPhrases = ['ph_hour','ph_min','ph_intro1','ph_intro2','ph_mag','ph_depth','ph_km','ph_decimal',
    'ph_tsu_major','ph_tsu_warning','ph_tsu_advisory','ph_affected'];
  var bulInts = ['int_0','int_1','int_2','int_3','int_4','int_5m','int_5p','int_6m','int_6p','int_7'];
  var bulNums = [];
  for (var n = 0; n < 100; n++) bulNums.push('num_' + String(n).padStart(2, '0'));
  var bulFrags = bulPhrases.concat(bulInts).concat(bulNums);
  for (var k = 0; k < bulFrags.length; k++) {
    // English rendering does not use explicit hour/minute classifier fragments.
    if (lang === 'en' && (bulFrags[k] === 'ph_hour' || bulFrags[k] === 'ph_min')) continue;
    AudioManager.preloadBuffer('sounds/' + lang + '/info/female/' + bulFrags[k] + '.wav');
  }
}

function _initAudio() { AudioManager.initContext(); }
// Resume AudioContext on EVERY user interaction (browsers suspend it aggressively on remote sites)
['click','touchstart','keydown'].forEach(function(evt){
  document.addEventListener(evt, function(){ _initAudio(); if(AudioManager._audioCtx && AudioManager._audioCtx.state==='suspended') AudioManager._audioCtx.resume().catch(function(){}); }, evt === 'touchstart' ? {passive:true} : false);
});
// Preload audio immediately on page load (not just at simulation start)
setTimeout(function(){ preloadAudio(); }, 1000);

function playSound(name) {
  var lang = soundModeEl.value;
  var ttsChk = document.getElementById('tts-enable');
  AudioManager.playSound(name, lang, ttsChk ? ttsChk.checked : true, soundVolume);
}

// v4.2: EEW alert sounds bypass TTS checkbox — they're emergency alerts, not speech
function playEEWSound(name) {
  var lang = soundModeEl.value;
  if (!lang || lang === 'off') { console.warn('EEW sound skipped: lang=' + lang); return; }
  // Emergency effects bypass the speech checkbox and wait for any active preload.
  return AudioManager.playSound(name, lang, true, soundVolume);
}

var _maxAnnouncedShindo = -1;
var _pgaCueName = null;
var _pgaCuePlayed = false;
// Auto-focus: keep P-wave in view
var _autoFocus = true;         // auto-focus mode active
var _lastAutoFocusTime = 0;    // simElapsed of last auto-focus
var _focusEventIdx = 0;        // v5.2: chain sub-event the viewport was last framed for
var _focusMode = 'overview';   // v5.2: 'event' = zoomed onto the firing sub-event, 'overview' = all fired events framed
var _focusEventAt = 0;         // v5.2: simElapsed when the current event zoom-in happened
var _focusTrackId = -1;        // v5.2: detection track the viewport is locked on (detect mode)
var _focusFitKm = 0;           // v5.2: radius (km) the event lock was last fitted to
var _focusLastFitAt = 0;       // v5.2: simElapsed of the last event-lock refit
var _userInteracted = false;   // user manually moved map
var _autoFocusMoving = false;  // auto-focus is currently animating map
// Frame an event lock: just the live P front plus a 6-second travel margin.
function _focusLockRadius(fLat, fLng, radiusKm) {
  var rDeg = Math.max(radiusKm, 30) / 111.32;
  var latCos = Math.max(0.5, Math.cos(fLat * Math.PI / 180));
  _autoFocusMoving = true;
  map.fitBounds([[fLat - rDeg, fLng - rDeg / latCos], [fLat + rDeg, fLng + rDeg / latCos]], _focusFitOptions());
  setTimeout(function() { _autoFocusMoving = false; }, 1000);
  _lastAutoFocusTime = simElapsed;
  _focusLastFitAt = simElapsed;
  _focusFitKm = radiusKm;
}
function playShindoAlert(level) {
  if (soundModeEl.value === 'off' || _maxAnnouncedShindo !== -1) return;
  var sn = AudioManager.getShindoSoundName(level);
  if (!sn) return;
  _maxAnnouncedShindo = level;
  // The final observed maximum is announced once per simulation.
  playEEWSound(sn);
}

function _preparePgaCue() {
  var expectedMaxPga = 0;
  for (var i = 0; i < landPoints.length; i++) {
    var point = landPoints[i];
    var stationMax = Number(point.peakPga) || 0;
    if (point.subEvents && point.subEvents.length) {
      for (var j = 0; j < point.subEvents.length; j++) {
        stationMax += Number(point.subEvents[j].peakPga) || 0;
      }
    }
    if (stationMax > expectedMaxPga) expectedMaxPga = stationMax;
  }
  _pgaCueName = AudioManager.getPgaSoundName(expectedMaxPga);
  _pgaCuePlayed = false;
}

function _maybePlayPgaCue(currentMaxPga) {
  if (_pgaCuePlayed || !_pgaCueName || soundModeEl.value === 'off') return;
  var threshold = _pgaCueName === 'PGA2' ? 80 : 1;
  if (Number(currentMaxPga) < threshold) return;
  _pgaCuePlayed = true;
  playEEWSound(_pgaCueName);
}

// -- Physics --
function hypoDist(lat,lng){return Physics.hypoDist(lat,lng,epicenter?epicenter.lat:null,epicenter?epicenter.lng:null,_liveDepth);}

// Source type defaults to event metadata/depth; the advanced override is explicit.
function resolvedSourceType(depthKm, eventSource, lat, lng, offshore) {
  if (lat == null && epicenter) lat=epicenter.lat;
  if (lng == null && epicenter) lng=epicenter.lng;
  if (offshore == null && lat != null && lng != null) offshore=(epicenter && lat===epicenter.lat && lng===epicenter.lng) ? isOceanEpicenter : isOceanPoint(lat,lng);
  return Physics.resolveSourceTypeAt(lat,lng,depthKm,eventSource,cfgGet('sourceTypeOverride'),offshore);
}
function activeSrcType() { return resolvedSourceType(_liveDepth, epicenterSrc, epicenter&&epicenter.lat, epicenter&&epicenter.lng, isOceanEpicenter); }

function _externalVs30Lookup(lat, lng) {
  var localValue = Physics.lookupResearchGrid(_vs30Grid, lat, lng);
  if (localValue && localValue > 0) return {value:localValue, source:(_vs30Grid.meta && _vs30Grid.meta.vs30SourceClass) || 'j-shis-grid', dataset:_vs30Grid.meta && _vs30Grid.meta.dataset};
  if (typeof window === 'undefined' || !window.VS30Grid || typeof window.VS30Grid.lookup !== 'function') return null;
  return window.VS30Grid.lookup(lat, lng);
}
function siteVs30Details(pt) {
  return Physics.lookupVs30Details(pt.lat, pt.lng, pt.vs30, _externalVs30Lookup, pt.vs30Source || 'station-estimate');
}
function intensityScaleLabel() {
  var scale = cfgGet('intensityScale') || 'shindo';
  return t('intensity.' + scale);
}
function formatIntensity(shindo) {
  var scale = cfgGet('intensityScale') || 'shindo';
  var value = Physics.convertIntensity(shindo, scale);
  return scale === 'shindo' ? String(value) : intensityScaleLabel() + ' ' + value;
}

// Si & Midorikawa is a MOMENT-magnitude model. Presets carry Mj on the slider (e.g. Kobe
// Mj7.3 = Mw6.9); when a true Mw is known (eventMw, set by presets) shift the supplied
// magnitude onto the Mw scale, preserving any finite-fault sub-source reduction. Free play:
// the slider M is treated as Mw. The legacy 'log' model keeps using the raw slider M.
function gmpMw(mag) {
  if (eventMw == null) return mag;
  return mag + (eventMw - _liveMag);
}

// Si & Midorikawa (1999) fault-type dummy terms (log10 units) — interplate/intraslab
// radiate more high-frequency energy than crustal at equal Mw/distance.
var SIMID_DS = { crustal: 0.00, interplate: 0.12, intraslab: 0.22 };

// --- Legacy hand-tuned log model (explicit 'log' option), retained for
//     reproducibility and model comparison. ---
function pgaLog(mag,Rkm){return Physics.pgaLog(mag,Rkm,cfgGet("attA"),cfgGet("attB"),cfgGet("attC"),cfgGet("anelastic"));}
function pgvLog(mag,Rkm){return Physics.pgvLog(mag,Rkm,cfgGet("anelastic"));}

// --- Si & Midorikawa (1999): published Japan GMPE with fault-type & depth terms,
//     near-source distance saturation, and built-in anelastic absorption.
//     Returns PGA in gal (cm/s^2) and PGV in cm/s on stiff/rock; coefficients per the
//     paper (verify before scientific use). X = closest fault distance (km).
//     CAVEATS:
//       * expects MOMENT magnitude Mw — the M slider/presets carry JMA magnitude (Mj)
//         for crustal events (e.g. Kobe Mj7.3 = Mw6.9), which inflates output ~1.7x.
//       * predicts on a rock reference; pair with Vs30 site amp (siteModel='vs30'),
//         NOT the soft-soil box model, to avoid double-counting site response.
//     Auto uses this published Japan model; legacy models remain selectable. ---
function pgaSiMid(mag,Rkm,depthKm,src){return Physics.pgaSiMid(mag,Rkm,depthKm,src);}
function pgvSiMid(mag,Rkm,depthKm,src){return Physics.pgvSiMid(mag,Rkm,depthKm,src);}

function calcPGA(mag,Rkm,vs30){return calcPGAFor(mag,Rkm,_liveDepth,activeSrcType(),vs30,eventMw,_liveMag);}
function calcPGV(mag,Rkm,vs30){return calcPGVFor(mag,Rkm,_liveDepth,activeSrcType(),vs30,eventMw,_liveMag);}
function calcPGAFor(mag,Rkm,depthKm,src,vs30,eventMwOverride,sliderMwOverride){return Physics.calcPGA(mag,Rkm,cfgGet("gmpModel"),depthKm,eventMwOverride,sliderMwOverride == null ? mag : sliderMwOverride,src,cfgGet("attA"),cfgGet("attB"),cfgGet("attC"),cfgGet("anelastic"),vs30);}
function calcPGVFor(mag,Rkm,depthKm,src,vs30,eventMwOverride,sliderMwOverride){return Physics.calcPGV(mag,Rkm,cfgGet("gmpModel"),depthKm,eventMwOverride,sliderMwOverride == null ? mag : sliderMwOverride,src,cfgGet("anelastic"),vs30);}

function calcJmaIntensity(pgaGal,pgvCms){return Physics.calcJmaIntensity(pgaGal,pgvCms);}

// Finer numeric scale for the validation scorecard, anchored to JMA instrumental
// intensity (I) midpoints so 5-/5+/6-/6+ are distinct (shindoNum collapses them).
// Handles both the modern scale (strings) and the pre-1996 integer scale (5,6).
var SHINDO_SCORE = {0:0,1:1,2:2,3:3,4:4,'5-':4.75,'5+':5.25,'6-':5.75,'6+':6.25,7:6.75,5:5.0,6:6.0};
function soilAmp(lat,lng,isSeafloor,stationFactor){
  if (isSeafloor) {
    var wd = _waterDepth(lat, lng);
    if (wd && wd > 2000) return cfgGet('siteHardMin');
    if (wd && wd > 200) return cfgGet('siteBase');
    return cfgGet('siteBase') * 1.2;
  }
  // Use station-level factor if available (from stations.json siteFactor field)
  if (stationFactor != null && typeof stationFactor === 'number') return stationFactor;
  // Fallback: province-box lookup
  return Physics.soilAmp(lat,lng,cfgGet("siteModel"),cfgGet("siteBase"),cfgGet("siteSoftMax"),cfgGet("siteHardMin"),Physics.SOIL_PROVINCES);
}

// Finite fault dimensions are resolved in Physics from source-specific
// Wells-Coppersmith / Strasser regressions and seismogenic-layer constraints.
// ================================================================
//  2D FINITE FAULT PLANE
// ================================================================

// Rrup: closest distance from a surface point to the rectangular fault plane
function _faultOpts(sourceType) {
  var opts = FiniteFaultEditor.getOpts() || {};
  opts.sourceType = sourceType || activeSrcType();
  opts.randomSeed = Research.normalizeSeed(cfgGet('randomSeed'));
  if (opts.hypocenterFrac == null) opts.hypocenterFrac = cfgGet('hypocenterFrac');
  if (opts.slipPerturbation == null) opts.slipPerturbation = cfgGet('slipPerturbation');
  opts.ruptureVelocityModel = cfgGet('ruptureVelocityModel');
  opts.sourceTimeFunction = cfgGet('sourceTimeFunction');
  opts.rigidityGPa = sourceType === 'intraslab' ? 50 : (sourceType === 'interplate' ? 40 : 30);
  return opts;
}

function buildSourceModel(params) {
  params = params || {};
  var sourceFiniteFault=params.finiteFault !== undefined ? params.finiteFault
    : (params.inheritObservedFiniteFault===false ? null : _observedFiniteFault);
  var sourceLat=params.lat != null ? params.lat : (epicenter ? epicenter.lat : 0);
  var sourceLng=params.lng != null ? params.lng : (epicenter ? epicenter.lng : 0);
  var sourceMag=params.mag != null ? params.mag : _liveMag;
  var sourceMw=params.mw != null ? params.mw : (eventMw != null ? eventMw : sourceMag);
  var sourceDepth=params.depth != null ? params.depth : _liveDepth;
  var sourceStrike=params.strike != null ? params.strike : parseFloat(strikeSlider.value);
  var sourceDip=params.dip != null ? params.dip : currentDip;
  if(sourceFiniteFault&&sourceFiniteFault.event){
    sourceLat=sourceFiniteFault.event.lat;sourceLng=sourceFiniteFault.event.lng;
    sourceDepth=sourceFiniteFault.event.depthKm;sourceMw=sourceFiniteFault.mw;sourceMag=sourceFiniteFault.mw;
  }
  var sourceType=resolvedSourceType(sourceDepth, params.sourceType || epicenterSrc, sourceLat, sourceLng);
  var faultOptions=_faultOpts(sourceType);
  var sourceTensor=params.momentTensor !== undefined ? params.momentTensor
    : (params.inheritObservedMomentTensor===false ? null : _observedMomentTensor);
  var selectedPlaneIndex=sourceTensor===_observedMomentTensor&&_observedFaultPlaneSelection
    ? _observedFaultPlaneSelection.index : params.faultPlaneIndex;
  return Physics.createSourceModel({
    lat:sourceLat,lng:sourceLng,mag:sourceMag,mw:sourceMw,depthKm:sourceDepth,
    strikeDeg:sourceStrike,dipDeg:sourceDip,
    rakeDeg:params.rake != null ? params.rake : currentRake,
    mechanismKnown:params.mechanismKnown != null ? !!params.mechanismKnown : _rakeExplicit,
    finiteFault:sourceFiniteFault,
    momentTensor:sourceTensor,
    mechanismProvenance:sourceTensor && sourceTensor.provenance,
    faultPlaneIndex:selectedPlaneIndex,
    sourceType:sourceType,faultOptions:faultOptions,generateSubSources:true,
    rupSpeed:cfgGet('rupSpeed'),originTime:params.originTime || 0
  });
}
function genSubSources(la,ln,mw,strikeDeg,dipDeg,depthKm,sourceType){
  return Physics.genSubSources(la,ln,mw,strikeDeg,dipDeg,depthKm,cfgGet("rupSpeed"),_faultOpts(sourceType));
}

// Compute fault plane surface projection corners as [[lat,lng],...] for Leaflet polygon
function getFaultCorners(lat,lng,mw,strikeDeg,dipDeg,depthKm,sourceType){
  return Physics.getFaultCorners(lat,lng,mw,strikeDeg,dipDeg,depthKm,_faultOpts(sourceType));
}

// Build irregular fault polygon from slip distribution
function buildIrregularFaultPolygon(fc,subs){return Physics.buildIrregularFaultPolygon(fc,subs);}

function tauShort(m){return Physics.tauShort(m,cfgGet("tauShortCoef"));}
// -- Leaflet fault plane + aftershock layers --
function createFaultLayer(lat, lng, mag, strDeg, dip, depthKm, originTime, mw, sourceType, sourceGeometry) {
  mw = mw != null ? mw : mag;
  var isImported=sourceGeometry&&sourceGeometry.kind==='imported-finite-fault';
  if (!lat || (mw < 6.5&&!isImported)) return;
  if (originTime == null) originTime = 0;
  // Reuse the event's canonical geometry so ground motion, map and 3-D never
  // diverge through a second stochastic slip-field build.
  var subData = sourceGeometry && sourceGeometry.subs ? sourceGeometry
    : genSubSources(lat, lng, mw, strDeg, dip, depthKm, sourceType);
  var fc = subData || getFaultCorners(lat, lng, mw, strDeg, dip, depthKm, sourceType);
  if (!fc) return;
  // Custom pane above canvas (z=500) so polygon is visible
  if (!map.getPane('faultPane')) {
    map.createPane('faultPane');
    map.getPane('faultPane').style.zIndex = 450;
  }
  var fg = L.layerGroup({pane: 'faultPane'}).addTo(map);
  if (!_faultLayerGroups) _faultLayerGroups = [];
  _faultLayerGroups.push(fg);
  if (!faultLayerGroup) faultLayerGroup = fg; // backward compat for first fault
  // A vertical plane has a line-shaped map projection, but remains a physical
  // 2-D surface in the solver and 3-D view. Render slip-weighted strike
  // segments instead of reverting the model itself to a legacy 1-D fault.
  var isVerticalProjection = !isImported&&Math.abs(Math.cos(fc.dipDeg*Math.PI/180))*fc.W < 0.8;
  if (isVerticalProjection || !faultPolygonEnabled) {
    faultPolygon = L.polyline([fc.corners[0], fc.corners[1]], {
      color: '#ff8060', weight: 4, opacity: 0.9, dashArray: isVerticalProjection ? null : '6, 4'
    }).addTo(fg);
    if (isVerticalProjection && subData && subData.subs) {
      for (var vsi=0;vsi<fc.nStrike;vsi++) {
        var strikeStart=fc.cellCorner(vsi,0,0,0),strikeEnd=fc.cellCorner(vsi,0,1,0);
        var weightSum=0,rtSum=0,riseSum=0;
        for(var vd=0;vd<fc.nDip;vd++){
          var verticalSub=subData.subs[vsi*fc.nDip+vd];
          weightSum+=verticalSub.slipWeight;rtSum+=verticalSub.ruptureTime*verticalSub.slipWeight;
          riseSum+=verticalSub.riseTime*verticalSub.slipWeight;
        }
        var segmentSlip=weightSum/Math.max(1,fc.nDip);
        var segment=L.polyline([strikeStart,strikeEnd],{color:'#301b28',weight:2+Math.min(5,segmentSlip*2),opacity:0.75,interactive:false}).addTo(fg);
        rupturePolyEntries.push({poly:segment,isLine:true,ruptureTime:rtSum/Math.max(weightSum,1e-9),
          riseTime:riseSum/Math.max(weightSum,1e-9),slipWeight:segmentSlip,maxRT:subData.maxRuptureTime,originTime:originTime});
      }
    }
    faultPolygon.bindTooltip('Fault map projection · '+Math.round(fc.L)+'×'+Math.round(fc.W)+' km · dip '+fc.dipDeg+'° · 3-D width retained');
    if(fc.hypocenter)L.circleMarker([fc.hypocenter.lat,fc.hypocenter.lng],{radius:5,color:'#7de3ff',weight:2,fillColor:'#071925',fillOpacity:0.9,interactive:false}).addTo(fg);
    return;
  }
  // Render every physical patch. The old slip-threshold contour cut low-slip
  // cells out of the fault and left implausible holes; opacity now carries slip.
  var maxRT = subData ? subData.maxRuptureTime : 30;
  for (var i = 0; i < fc.nStrike; i++) {
    for (var j = 0; j < fc.nDip; j++) {
      var sIdx=i*fc.nDip+j,sub=(subData&&subData.subs)?subData.subs[sIdx]:null;
      var slip=sub?sub.slipWeight:1;
      var poly = L.polygon([
        fc.cellCorner(i,j,0,0),fc.cellCorner(i,j,1,0),
        fc.cellCorner(i,j,1,1),fc.cellCorner(i,j,0,1)
      ], {
      color: '#5e3442', weight: 0.7, opacity: 0.45,
      fillColor: '#241522', fillOpacity: 0.08+Math.min(0.16,slip*0.05),
      interactive: false
    }).addTo(fg);
      rupturePolyEntries.push({poly:poly,ruptureTime:sub?sub.ruptureTime:0,riseTime:sub?sub.riseTime:1,
        slipWeight:slip,maxRT:maxRT,originTime:originTime});
    }
  }
  // Imported models may be segmented or curved. Their axis-aligned bounding
  // box is not a physical fault outline, so derive a convex surface footprint.
  var outerCorners=fc.corners;
  if(isImported&&fc.subs){
    var hullPoints=[];
    fc.subs.forEach(function(sub){(sub.corners||[]).forEach(function(c){hullPoints.push([Number(c.lng),Number(c.lat)]);});});
    hullPoints.sort(function(a,b){return a[0]-b[0]||a[1]-b[1];});
    var unique=[];hullPoints.forEach(function(p){if(!unique.length||p[0]!==unique[unique.length-1][0]||p[1]!==unique[unique.length-1][1])unique.push(p);});
    function hullCross(o,a,b){return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);}
    if(unique.length>=3){
      var lower=[],upper=[],hi;
      for(hi=0;hi<unique.length;hi++){while(lower.length>=2&&hullCross(lower[lower.length-2],lower[lower.length-1],unique[hi])<=0)lower.pop();lower.push(unique[hi]);}
      for(hi=unique.length-1;hi>=0;hi--){while(upper.length>=2&&hullCross(upper[upper.length-2],upper[upper.length-1],unique[hi])<=0)upper.pop();upper.push(unique[hi]);}
      lower.pop();upper.pop();outerCorners=lower.concat(upper).map(function(p){return [p[1],p[0]];});
    }
  }
  faultPolygon = L.polygon(outerCorners, {
    color: '#ff8060', weight: 2.5, opacity: 0.9,
    fillColor: '#ff5030', fillOpacity: 0.04,
    dashArray: null
  }).addTo(fg);
  var faultTooltip=isImported
    ? 'Imported finite fault · '+escapeHTML(String(fc.provenance&&fc.provenance.source||fc.modelId||'observed'))+' · '+fc.nSub+' patches'
    : 'Fault: ' + Math.round(fc.L) + '×' + Math.round(fc.W) + ' km · ' + fc.nStrike + '×' + fc.nDip + ' patches · dip ' + fc.dipDeg + '°';
  faultPolygon.bindTooltip(
    faultTooltip,
    {permanent: false, direction: 'center'}
  );
  if(fc.hypocenter)L.circleMarker([fc.hypocenter.lat,fc.hypocenter.lng],{radius:5,color:'#7de3ff',weight:2,fillColor:'#071925',fillOpacity:0.9,interactive:false}).addTo(fg);
}

function removeFaultLayer() {
  if (faultLayerGroup) { map.removeLayer(faultLayerGroup); faultLayerGroup = null; }
  if (_faultLayerGroups) {
    for (var fi = 0; fi < _faultLayerGroups.length; fi++) {
      if (_faultLayerGroups[fi] !== faultLayerGroup) map.removeLayer(_faultLayerGroups[fi]);
    }
    _faultLayerGroups = [];
  }
  faultPolygon = null;
  aftershockLeafletMarkers = [];
  lastAftershockIdxRendered = -1;
  rupturePolyEntries = [];
}

// Update sub-polygon colors based on rupture progress
function updateRuptureAnimation() {
  if (!rupturePolyEntries.length) return;
  for (var i = 0; i < rupturePolyEntries.length; i++) {
    var rp = rupturePolyEntries[i];
    var rpElapsed = simElapsed - (rp.originTime || 0);
    var ramp=Physics.rupturePatchFraction(rp,rpElapsed),frac=ramp;
    // Color: dark red (not ruptured) → bright orange (rupturing) → warm orange (ruptured)
    var r, g, b, a;
    if (ramp < 0.3) {
      // Not yet started: very dark
      r = 42; g = 30; b = 48; a = 0.10 + ramp * 0.18;
    } else if (ramp < 0.8) {
      // Actively rupturing: brightening orange
      var t = (ramp - 0.3) / 0.5;
      r = 42 + t * 213; g = 30 + t * 190; b = 48 - t * 20; a = 0.18 + t * 0.35;
    } else {
      // Ruptured: warm settled orange
      var slipTone=Math.min(1,Math.max(0.15,(rp.slipWeight||1)/2));
      r = 205+45*slipTone; g = 75+95*slipTone; b = 34; a = 0.22+0.28*slipTone;
    }
    r = Math.round(Math.min(255, Math.max(0, r)));
    g = Math.round(Math.min(255, Math.max(0, g)));
    b = Math.round(Math.min(255, Math.max(0, b)));
    a = Math.min(0.45, Math.max(0.05, a));
    var styleKey = r + ',' + g + ',' + b + ',' + Math.round(a * 100);
    if (rp._styleKey !== styleKey) {
      rp._styleKey = styleKey;
      if(rp.isLine)rp.poly.setStyle({color:'rgb('+r+','+g+','+b+')',opacity:Math.max(0.35,a),weight:2+Math.min(6,(rp.slipWeight||1)*2.2)});
      else rp.poly.setStyle({fillColor:'rgb('+r+','+g+','+b+')',fillOpacity:a,color:frac>0&&frac<1?'#ffe19a':'#6d3b43'});
    }
  }
}

// -- Multi-event support --
function mainEvent() { return activeEvents.length > 0 ? activeEvents[0] : null; }

// v5.2 multi-event display selector: single-event-designed UI surfaces (info
// panel, charts, beachballs, waveforms, cards) read uiDisplayParams() so chain
// presets present the currently-firing sub-event instead of freezing on the
// first one. Selection = latest chain event whose originTime has passed.
// Dynamically spawned aftershock events are excluded from the pool so the UI
// never jumps to an aftershock.
function _displayEventPool() {
  var chain = null;
  for (var i = 0; i < activeEvents.length; i++) {
    if (activeEvents[i].chainEvent) (chain = chain || []).push(activeEvents[i]);
  }
  // No chain events → single-event run: always the mainshock (index 0).
  return chain || activeEvents.slice(0, 1);
}
function displayEvent() {
  var pool = _displayEventPool();
  if (!pool.length) return null;
  return pool[Physics.activeEventIndex(pool, simElapsed)] || pool[0];
}
function uiDisplayParams() {
  var pool = _displayEventPool();
  if (!pool.length) return null;
  var idx = Physics.activeEventIndex(pool, simElapsed);
  var ev = pool[idx] || pool[0];
  var single = pool.length <= 1;
  var sm = ev.sourceModel || {};
  var sliderStrike = parseFloat(strikeSlider.value);
  return {
    ev: ev,
    idx: idx,
    count: pool.length,
    lat: ev.lat, lng: ev.lng,
    mag: single ? _liveMag : ev.mag,
    depth: single ? _liveDepth : ev.depth,
    strike: single ? sliderStrike : (ev.strike != null ? ev.strike : sliderStrike),
    dip: single ? currentDip : (ev.dip != null ? ev.dip : currentDip),
    rake: single ? currentRake : (ev.rake != null ? ev.rake : currentRake),
    srcType: ev.sourceType || activeSrcType(),
    mw: single ? (eventMw != null ? eventMw : _liveMag) : (sm.mw != null ? sm.mw : ev.mag),
    originTime: ev.originTime || 0,
    sourceModel: ev.sourceModel || null
  };
}
if (typeof window !== 'undefined') window.uiDisplayParams = uiDisplayParams;

// v5.2 chain auto-focus: bounds covering every chain sub-event so the
// viewport frames all of them at once instead of tracking only the
// mainshock. onlyFired=true restricts to events already firing (their live
// P-wave radii); returns null for single-event runs.
// Retired events (S front past every land station + WAVE_RETIRE_GRACE) keep
// their epicenter in frame at a fixed 80 km half-extent instead of their
// ever-growing ring radius — otherwise long chain runs end up framed on a
// multi-thousand-km stale circle with Japan shrunk to a postage stamp.
function _eventWavesRetired(ev) {
  return ev && ev.waveRetireAt != null && simElapsed > ev.waveRetireAt;
}
function _trackWavesRetired(tr) {
  if (tr.evIdx >= AS_TRACK_BASE) {
    var cat = aftershockCatalog[tr.evIdx - AS_TRACK_BASE];
    var evId = cat ? ('as_' + cat.id) : null;
    for (var _ti = 0; _ti < activeEvents.length; _ti++) if (activeEvents[_ti].id === evId) return _eventWavesRetired(activeEvents[_ti]);
    return true; // never spawned or already pruned
  }
  return _eventWavesRetired(activeEvents[tr.evIdx]);
}
function _chainFocusBounds(onlyFired) {
  var pool = _displayEventPool();
  if (pool.length <= 1) return null;
  var b = null;
  for (var i = 0; i < pool.length; i++) {
    var ev = pool[i];
    if (onlyFired && ev.originTime > simElapsed) continue;
    var rDeg = (_eventWavesRetired(ev) ? 80 : Math.max(ev.pRadius || 0, 80)) / 111.32;
    var latCos = Math.max(0.5, Math.cos(ev.lat * Math.PI / 180));
    var sw = [ev.lat - rDeg, ev.lng - rDeg / latCos], ne = [ev.lat + rDeg, ev.lng + rDeg / latCos];
    b = b ? b.extend(sw).extend(ne) : L.latLngBounds(sw, ne);
  }
  return b;
}
// Detect-mode overview bounds: frame every track's ESTIMATED epicenter (with
// its P-ring extent), never the true positions.
function _detectFocusBounds() {
  var b = null, n = 0;
  for (var i = 0; i < _detectTracks.length; i++) {
    var tr = _detectTracks[i];
    if (!tr.epi || tr.bulletin < 1) continue;
    n++;
    var rDeg = (_trackWavesRetired(tr) ? 80 : Math.max(tr.pR || 0, 80)) / 111.32;
    var latCos = Math.max(0.5, Math.cos(tr.epi.lat * Math.PI / 180));
    var sw = [tr.epi.lat - rDeg, tr.epi.lng - rDeg / latCos], ne = [tr.epi.lat + rDeg, tr.epi.lng + rDeg / latCos];
    b = b ? b.extend(sw).extend(ne) : L.latLngBounds(sw, ne);
  }
  return n ? b : null;
}
// v5.2 mobile adaptation: pixel padding scales with the viewport, and small
// screens get extra bottom padding so chain epicenters stay clear of the
// timeline/panel overlays that cover the lower map area.
function _focusFitOptions() {
  var w = mapEl.clientWidth || 800, h = mapEl.clientHeight || 600;
  var mobile = w < 768;
  var pad = Math.round(Math.min(w, h) * (mobile ? 0.12 : 0.06));
  var opts = {animate: true, duration: 0.8, padding: L.point(pad, pad)};
  if (mobile) opts.paddingBottomRight = L.point(pad, Math.round(h * 0.22));
  return opts;
}

// -- v5.2 Presenter (live/recording) mode --
// Hides the control sidebar and replaces it with an SREV-style info bar so
// the map fills the screen for streaming/recording. Entering or leaving never
// interrupts the simulation.
var _presenterEls = null;
function _presenterDom() {
  if (_presenterEls) return _presenterEls;
  _presenterEls = {
    panel: document.getElementById('presenter-panel'),
    tag: document.getElementById('presenter-event-tag'),
    maxSh: document.getElementById('presenter-max-shindo'),
    loc: document.getElementById('presenter-loc'),
    time: document.getElementById('presenter-time'),
    mag: document.getElementById('presenter-mag'),
    depth: document.getElementById('presenter-depth'),
    list: document.getElementById('presenter-pref-list')
  };
  return _presenterEls;
}
// Realtime-monitoring presenter support: the same info bar works over the
// live monitor when no sim is running.
function _presenterRtActive() {
  return typeof RTData !== 'undefined' && RTData.isActive && RTData.isActive();
}
var _presenterRtTimer = null;
function _stopPresenterRtTimer() {
  if (_presenterRtTimer) { clearInterval(_presenterRtTimer); _presenterRtTimer = null; }
}
function enterPresenterMode() {
  if (!_presenterDom().panel) return;
  document.body.classList.add('presenter-mode');
  // The flex layout reclaims the sidebar width — Leaflet must re-measure.
  setTimeout(function() { map.invalidateSize(); }, 60);
  _startPresenterRtTimer();
  updatePresenterPanel();
}
// Realtime mode: refresh the panel on a timer (no sim loop drives it).
function _startPresenterRtTimer() {
  _stopPresenterRtTimer();
  if (isRunning || !_presenterRtActive()) return;
  _presenterRtTimer = setInterval(function() {
    try {
      if (isRunning || !_presenterRtActive() || !document.body.classList.contains('presenter-mode')) {
        _stopPresenterRtTimer(); return;
      }
      updatePresenterPanel();
    } catch (e) { /* a bad tick must not kill the ticker */ }
  }, 2000);
}
function exitPresenterMode() {
  _stopPresenterRtTimer();
  if (!document.body.classList.contains('presenter-mode')) return;
  document.body.classList.remove('presenter-mode');
  setTimeout(function() { map.invalidateSize(); }, 60);
}
function updatePresenterPanel() {
  var els = _presenterDom();
  if (!els.panel || !document.body.classList.contains('presenter-mode')) return;
  // Sim running -> sim content below; otherwise realtime content when the live monitor is on.
  if (!isRunning && _presenterRtActive()) { _updatePresenterPanelRt(els); return; }
  var dp = uiDisplayParams();
  els.tag.textContent = (dp && dp.count > 1) ? t('info.event_of').replace('{i}', dp.idx + 1).replace('{n}', dp.count) : '';
  // Big max-shindo box (SREV style)
  var smax = _globalMaxShindo;
  var hasMax = smax != null && Physics.shindoNum(smax) > 0;
  els.maxSh.textContent = hasMax ? smax : '--';
  els.maxSh.style.background = hasMax ? (SHINDO_FILL[smax] || '#333') : '#333';
  els.maxSh.style.color = (smax === 4 || smax === '4') ? '#333' : '#fff';
  if (dp) {
    els.loc.textContent = nearestCityName(dp.lat, dp.lng) || (dp.lat.toFixed(2) + '°N ' + dp.lng.toFixed(2) + '°E');
    var presetTime = (currentPreset && PRESETS[currentPreset] && PRESETS[currentPreset].time) || null;
    els.time.textContent = (presetTime || new Date().toLocaleString()) + ' (+' + simElapsed.toFixed(0) + 's)';
    els.mag.textContent = 'M' + dp.mag.toFixed(1);
    els.depth.textContent = dp.depth + ' km';
  }
  // Per-prefecture shindo list, grouped 7 → 3 (live merged observed values)
  var prefNames = {};
  if (_prefGeoData && _prefGeoData.features) {
    for (var pi = 0; pi < _prefGeoData.features.length; pi++) {
      var fp = _prefGeoData.features[pi].properties;
      prefNames[fp.id] = fp.nam_ja || fp.nam;
    }
  }
  var groups = ['7', '6+', '6-', '5+', '5-', '4', '3'];
  var html = '';
  for (var q = 0; q < groups.length; q++) {
    var lv = groups[q], members = [];
    for (var pid in _livePrefectureShindos) {
      if (String(_livePrefectureShindos[pid]) === lv) members.push(prefNames[pid] || pid);
    }
    if (!members.length) continue;
    members.sort();
    var fill = SHINDO_FILL[lv] || '#666';
    html += '<div class="presenter-pref-group"><span class="presenter-pref-level" style="background:' + fill
      + ';color:' + (lv === '4' ? '#333' : '#fff') + '">' + lv + '</span><span class="presenter-pref-names">'
      + members.map(escapeHTML).join(' / ') + '</span></div>';
  }
  if (!html) html = '<div class="presenter-quiet">' + escapeHTML(t('presenter.quiet')) + '</div>';
  els.list.innerHTML = html;
}

// Realtime-monitoring content: newest active EEW report wins, then the kmoni
// period max for the big box and the newest realtime list event for the fields.
function _updatePresenterPanelRt(els) {
  els.tag.textContent = 'REALTIME';
  var eew = null;
  if (typeof RTEew !== 'undefined' && RTEew.getActive) {
    var acts = RTEew.getActive() || [];
    for (var ai = 0; ai < acts.length; ai++) {
      if (acts[ai].phase === 'active' && acts[ai].latest) { eew = acts[ai].latest; break; }
    }
  }
  var kst = (typeof RTKmoni !== 'undefined' && RTKmoni.getState) ? RTKmoni.getState() : null;
  var smax = (eew && eew.maxInt) ? eew.maxInt
    : ((kst && kst.periodMaxLevel > 0 && RTKmoni.levelToShindo) ? RTKmoni.levelToShindo(kst.periodMaxLevel) : '');
  els.maxSh.textContent = smax || '--';
  els.maxSh.style.background = smax ? (SHINDO_FILL[smax] || '#333') : '#333';
  els.maxSh.style.color = (smax === 4 || smax === '4') ? '#333' : '#fff';
  var ev = null;
  if (!eew && typeof RTData !== 'undefined' && RTData.getData) {
    var rtd = RTData.getData() || [];
    if (rtd.length) ev = rtd[0];
  }
  if (eew) {
    els.loc.textContent = eew.place || (eew.lat != null && eew.lng != null
      ? eew.lat.toFixed(2) + '°N ' + eew.lng.toFixed(2) + '°E' : '--');
    els.time.textContent = eew.originMs ? new Date(eew.originMs).toLocaleString() : '--';
    els.mag.textContent = (eew.mag != null && isFinite(eew.mag)) ? 'M' + eew.mag.toFixed(1) : '--';
    els.depth.textContent = (eew.depth != null) ? eew.depth + ' km' : '--';
  } else if (ev) {
    var evMag = Number(ev.mag), evDep = Number(ev.depth);
    els.loc.textContent = ev.place || '--';
    els.time.textContent = ev.time ? new Date(ev.time).toLocaleString() : '--';
    els.mag.textContent = (isFinite(evMag) && evMag > 0) ? 'M' + evMag.toFixed(1) : '--';
    els.depth.textContent = isFinite(evDep) ? evDep + ' km' : '--';
  } else {
    els.loc.textContent = els.time.textContent = els.mag.textContent = els.depth.textContent = '--';
  }
  // EEW warn areas grouped by shindo 7 → 3, same chips as the sim branch
  var groups = ['7', '6+', '6-', '5+', '5-', '4', '3'];
  var html = '';
  var areas = (eew && eew.warnAreas) || [];
  for (var q = 0; q < groups.length; q++) {
    var lv = groups[q], members = [];
    for (var wi = 0; wi < areas.length; wi++) {
      if ((areas[wi].shindo2 || areas[wi].shindo1 || '') === lv && areas[wi].name) members.push(areas[wi].name);
    }
    if (!members.length) continue;
    members.sort();
    var fill = SHINDO_FILL[lv] || '#666';
    html += '<div class="presenter-pref-group"><span class="presenter-pref-level" style="background:' + fill
      + ';color:' + (lv === '4' ? '#333' : '#fff') + '">' + lv + '</span><span class="presenter-pref-names">'
      + members.map(escapeHTML).join(' / ') + '</span></div>';
  }
  if (!html) html = '<div class="presenter-quiet">' + escapeHTML(t('presenter.quiet')) + '</div>';
  els.list.innerHTML = html;
}

// ================================================================
//  EEW dedicated page (realtime-monitor takeover, presenter-style layout)
// ================================================================
var _eewPageEls = null;
function _eewPageDom() {
  if (_eewPageEls) return _eewPageEls;
  _eewPageEls = {
    panel: document.getElementById('eew-page-panel'),
    tag: document.getElementById('eewpage-tag'),
    maxSh: document.getElementById('eewpage-max-shindo'),
    count: document.getElementById('eewpage-count'),
    countSub: document.getElementById('eewpage-count-sub'),
    loc: document.getElementById('eewpage-loc'),
    time: document.getElementById('eewpage-time'),
    mag: document.getElementById('eewpage-mag'),
    depth: document.getElementById('eewpage-depth'),
    areas: document.getElementById('eewpage-areas'),
    top: document.getElementById('eewpage-top'),
    hist: document.getElementById('eewpage-hist'),
    status: document.getElementById('eewpage-status')
  };
  return _eewPageEls;
}
var _eewPageTimer = null;
function eewPageActive() {
  return typeof document !== 'undefined' && document.body.classList.contains('eew-page-mode');
}
function _stopEewPageTimer() {
  if (_eewPageTimer) { clearInterval(_eewPageTimer); _eewPageTimer = null; }
}
function enterEewPage() {
  if (typeof RTData === 'undefined' || !RTData.isActive || !RTData.isActive()) {
    if (typeof RTData !== 'undefined' && RTData.toastQueued) RTData.toastQueued(t('eewpage.need_rt'));
    return false;
  }
  if (document.body.classList.contains('presenter-mode')) exitPresenterMode();
  document.body.classList.add('eew-page-mode');
  setTimeout(function() { map.invalidateSize(); }, 60);
  _stopEewPageTimer();
  _eewPageTimer = setInterval(function() {
    try { updateEewPage(); } catch (e) { /* a bad tick must not kill the ticker */ }
  }, 1000);
  updateEewPage();
  return true;
}
function exitEewPage() {
  _stopEewPageTimer();
  if (!document.body.classList.contains('eew-page-mode')) return;
  document.body.classList.remove('eew-page-mode');
  setTimeout(function() { map.invalidateSize(); }, 60);
}
function toggleEewPage() {
  if (eewPageActive()) { exitEewPage(); return false; }
  return enterEewPage();
}

// S-wave remain at the reference point (manual pin > geoIP > map center) for
// the currently displayed active EEW event. null when unavailable.
function _eewPageRemainSec(st) {
  if (!st || !st.latest || st.latest.lat == null || st.latest.lng == null) return null;
  if (typeof RTEew === 'undefined' || !RTEew.countdownRemainSec || typeof Physics === 'undefined') return null;
  var ref = (RTEew.getUserLocation && RTEew.getUserLocation()) ||
    (typeof map !== 'undefined' && map ? (function() { var c = map.getCenter(); return { lat: c.lat, lng: c.lng }; })() : null);
  if (!ref) return null;
  var depth = (st.latest.depth != null) ? st.latest.depth : 10;
  var sSpeed = (typeof cfgGet === 'function') ? Number(cfgGet('sWaveSpeed')) : NaN;
  if (!isFinite(sSpeed) || sSpeed <= 0) sSpeed = 3.3;
  return RTEew.countdownRemainSec(Physics.sTravelTime,
    RTEew.haversineKm(ref.lat, ref.lng, st.latest.lat, st.latest.lng),
    depth, sSpeed, RTEew.elapsedSec(st, Date.now()));
}

function updateEewPage() {
  var els = _eewPageDom();
  if (!els.panel || !eewPageActive()) { _stopEewPageTimer(); return; }
  if (typeof RTData === 'undefined' || !RTData.isActive || !RTData.isActive()) { exitEewPage(); return; }
  // current EEW event (active reports only — the page quiets down after final)
  var st = null;
  if (typeof RTEew !== 'undefined' && RTEew.getActive) {
    var acts = RTEew.getActive() || [];
    for (var ai = 0; ai < acts.length; ai++) {
      if (acts[ai].phase === 'active' && acts[ai].latest) { st = acts[ai]; break; }
    }
  }
  var kst = (typeof RTKmoni !== 'undefined' && RTKmoni.getState) ? RTKmoni.getState() : null;
  var latest = st ? st.latest : null;
  // big max-shindo block: EEW forecast wins, else the kmoni period max
  var smax = (latest && latest.maxInt) ? latest.maxInt
    : ((kst && kst.periodMaxLevel > 0 && typeof RTKmoni !== 'undefined' && RTKmoni.levelToShindo)
        ? RTKmoni.levelToShindo(kst.periodMaxLevel) : '');
  els.maxSh.textContent = smax || '--';
  els.maxSh.style.background = smax ? (SHINDO_FILL[smax] || '#333') : '#333';
  els.maxSh.style.color = (smax === 4 || smax === '4') ? '#333' : '#fff';
  // big S-wave countdown at the reference point
  var remain = _eewPageRemainSec(st);
  if (remain !== null && remain > 0) {
    els.count.textContent = Math.ceil(remain);
    els.countSub.textContent = t('realtime.mv_s_until') + ' (' + t('realtime.mv_sec') + ')';
    els.count.style.color = remain < 10 ? '#ff8a80' : '#fff';
  } else if (remain !== null) {
    els.count.textContent = t('realtime.mv_s_arrived');
    els.countSub.textContent = '';
    els.count.style.color = '#ffd75e';
  } else {
    els.count.textContent = '--';
    els.countSub.textContent = st ? '' : t('eewpage.quiet');
    els.count.style.color = '#fff';
  }
  // event fields (EEW event wins, else newest history row)
  var ev = null;
  if (!latest && typeof RTData !== 'undefined' && RTData.getData) {
    var rtd = RTData.getData() || [];
    if (rtd.length) ev = rtd[0];
  }
  if (latest) {
    els.tag.textContent = (latest.isWarn ? t('realtime.eew_warn') : t('realtime.eew_forecast')) +
      ' 第' + st.serial + '報' + (st.isTraining ? ' (' + t('realtime.eew_training') + ')' : '');
    els.loc.textContent = latest.place || '--';
    els.time.textContent = latest.originMs ? new Date(latest.originMs).toLocaleString() : '--';
    els.mag.textContent = (latest.mag != null && isFinite(latest.mag)) ? 'M' + Number(latest.mag).toFixed(1) : '--';
    els.depth.textContent = (latest.depth != null) ? latest.depth + ' km' : '--';
  } else if (ev) {
    els.tag.textContent = 'REALTIME';
    els.loc.textContent = ev.place || '--';
    els.time.textContent = ev.time ? new Date(ev.time).toLocaleString() : '--';
    els.mag.textContent = (isFinite(Number(ev.mag)) && Number(ev.mag) > 0) ? 'M' + Number(ev.mag).toFixed(1) : '--';
    els.depth.textContent = isFinite(Number(ev.depth)) ? Math.round(Number(ev.depth)) + ' km' : '--';
  } else {
    els.tag.textContent = 'REALTIME';
    els.loc.textContent = els.time.textContent = els.mag.textContent = els.depth.textContent = '--';
  }
  // warn areas grouped by shindo (presenter-style chips)
  var groups = ['7', '6+', '6-', '5+', '5-', '4', '3'];
  var html = '';
  var areas = (latest && latest.warnAreas) || [];
  for (var q = 0; q < groups.length; q++) {
    var lv = groups[q], members = [];
    for (var wi = 0; wi < areas.length; wi++) {
      if ((areas[wi].shindo2 || areas[wi].shindo1 || '') === lv && areas[wi].name) members.push(areas[wi].name);
    }
    if (!members.length) continue;
    members.sort();
    var fill = SHINDO_FILL[lv] || '#666';
    html += '<div class="presenter-pref-group"><span class="presenter-pref-level" style="background:' + fill
      + ';color:' + (lv === '4' ? '#333' : '#fff') + '">' + lv + '</span><span class="presenter-pref-names">'
      + members.map(escapeHTML).join(' / ') + '</span></div>';
  }
  els.areas.innerHTML = html;
  // strongest stations (kmoni engine ranking, top 5)
  var top = (kst && kst.top) || [];
  html = '';
  for (var ti = 0; ti < top.length && ti < 5; ti++) {
    if (top[ti].level < 1) break;
    var fine = RTKmoni.levelToShindoFine ? RTKmoni.levelToShindoFine(top[ti].level) : String(top[ti].level);
    html += '<div class="eewpage-top-row"><span class="eewpage-top-chip" style="background:' +
      (SHINDO_FILL[fine] || '#888') + '">' + escapeHTML(fine) +
      '</span><span>#' + (top[ti].idx + 1) + '</span><span class="eewpage-top-val">' +
      (top[ti].level / 10).toFixed(1) + '</span></div>';
  }
  els.top.innerHTML = html || '<div class="eewpage-quiet">' + escapeHTML(t('realtime.kmoni.top_quiet')) + '</div>';
  // mini history (top 6, agency + max shindo chip when present)
  var hist = (typeof RTData !== 'undefined' && RTData.getData) ? (RTData.getData() || []) : [];
  html = '';
  for (var hi = 0; hi < hist.length && hi < 6; hi++) {
    var it = hist[hi];
    var d = new Date(it.time);
    var hhmm = isNaN(d) ? '' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    html += '<div class="eewpage-hist-row">' +
      (it.maxShindo ? '<span class="eewpage-top-chip" style="background:' + (SHINDO_FILL[it.maxShindo] || '#888') + '">' + escapeHTML(String(it.maxShindo)) + '</span>' : '') +
      '<b>M' + Number(it.mag).toFixed(1) + '</b> <span class="eewpage-hist-place">' + escapeHTML(it.place || '') + '</span>' +
      '<span class="eewpage-hist-src">' + escapeHTML(it.source || '') + ' ' + hhmm + '</span></div>';
  }
  els.hist.innerHTML = html || '<div class="eewpage-quiet">' + escapeHTML(t('realtime.empty')) + '</div>';
  // footer: feed sources + kmoni state
  var srcs = (typeof RTData !== 'undefined' && RTData.getLiveSources) ? (RTData.getLiveSources() || []) : [];
  els.status.textContent = (srcs.length ? srcs.join(' · ') : t('realtime.no_sources')) +
    (kst && kst.stationCount ? ' · 強震 ' + kst.stationCount : '');
}

// [updateAftershockLeafletMarkers] moved to aftershock.js (alias override active)

// Spawn large aftershocks as visible events (cross markers + wave rings)
// [spawnAftershockEvents] moved to aftershock.js (alias override active)

// -- Canvas --
function initWaveCanvas() {
  waveCanvas = document.createElement('canvas');
  waveCanvas.setAttribute('aria-hidden', 'true');
  waveCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:500;';
  waveCanvas.width = mapEl.clientWidth;
  waveCanvas.height = mapEl.clientHeight;
  mapEl.appendChild(waveCanvas);
  waveCtx = waveCanvas.getContext("2d");
  // Station popup: canvas click -> nearest station detail (+ add-to-multi-wf button)
  mapEl.addEventListener('click', function(e) {
    var sp = document.getElementById('station-popup');
    if (!sp) {
      sp = document.createElement('div');
      sp.id = 'station-popup';
      sp.className = 'station-popup';
      sp.style.display = 'none';
      document.getElementById('map-container').appendChild(sp);
    }
    if (e.target.closest('button, .leaflet-control, #timeline, #legend, #max-pga-panel, .multi-wf-panel')) { sp.style.display = 'none'; return; }
    var containerPt = {x: e.clientX - mapEl.getBoundingClientRect().left, y: e.clientY - mapEl.getBoundingClientRect().top};
    var zoneHit=findTsunamiInundationZone(map.containerPointToLatLng([containerPt.x,containerPt.y]));
    if(zoneHit){sp.style.display='none';selectTsunamiInundationZone(zoneHit);return;}
    // In show-all-stations mode, allow clicking pre-simulation; otherwise require running.
    if (!showAllStations && !isRunning) { sp.style.display = 'none'; return; }
    // Find nearest station: prefer visibleCircles (rich data), fall back to rawLandGrid
    // when in show-all mode so pre-simulation / not-yet-arrived stations are pickable.
    var best = null, bestDist = 30;
    var searchSet = showAllStations ? rawLandGrid : visibleCircles;
    for (var i = 0; i < searchSet.length; i++) {
      var c = searchSet[i];
      if (!_stationNetworkVisible(c)) continue;
      var pt = map.latLngToContainerPoint([c.lat, c.lng]);
      var dx = pt.x - containerPt.x, dy = pt.y - containerPt.y;
      var d = Math.sqrt(dx*dx + dy*dy);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (!best) { sp.style.display = 'none'; return; }
    // In non-show-all mode, only pop up for shaking stations (legacy behavior).
    if (!showAllStations && best.shindo === 0) { sp.style.display = 'none'; return; }
    var typeTag = best.isSeafloor ? '🌊海底' : '🏔陆地';
    var hasShake = (best.shindo !== 0 && best.shindo != null) && isRunning;
    var distKm = epicenter ? Physics.haversineDist(epicenter.lat, epicenter.lng, best.lat, best.lng).toFixed(1) : '—';
    var lpgmTxt = (hasShake && best.lpgm && best.lpgm >= 1) ? '<br>LPGM: <span class="sp-val">Class ' + best.lpgm + '</span>' : '';
    var infoHtml;
    if (hasShake) {
      infoHtml = escapeHTML(t('info.estimated_intensity')) + ': <span class="sp-val" style="color:' + (SHINDO_FILL[best.shindo]||'#fff') + '">' + escapeHTML(formatIntensity(best.shindo)) + '</span>'
        + ' &nbsp; Dist: <span class="sp-val">' + distKm + ' km</span><br>'
        + 'PGA: <span class="sp-val">' + (best.displayPga >= 100 ? Math.round(best.displayPga) : (best.displayPga||0).toFixed(1)) + ' gal</span>'
        + ' &nbsp; PGV: <span class="sp-val">' + (best.pgv||0).toFixed(1) + ' cm/s</span><br>'
        + 'P: <span class="sp-val">' + (best.pArrive||0).toFixed(1) + 's</span> / '
        + 'S: <span class="sp-val">' + (best.sArrive||0).toFixed(1) + 's</span><br>'
        + escapeHTML(t('info.vs30')) + ': <span class="sp-val">' + Math.round(best.vs30Value || 700) + ' m/s (' + escapeHTML(best.vs30Source || 'fallback') + ')</span><br>'
        + escapeHTML(t('info.distance_metric')) + ': <span class="sp-val">' + escapeHTML(best.distanceMetric || 'Rhypo') + '</span> · GMPE: <span class="sp-val">' + escapeHTML(best.gmpeModel || cfgGet('gmpModel')) + '</span>'
        + lpgmTxt;
      var sigmaMode = cfgGet('sigmaDisplay');
      if (sigmaMode === 'pgaOnly' || sigmaMode === 'pgaPgv') {
        var pgaFactor = Math.pow(10, best.sigmaPga || 0);
        infoHtml += '<br>' + escapeHTML(t('info.sigma')) + ': <span class="sp-val">' + (best.sigmaPga || 0).toFixed(3) + '</span>'
          + ' · PGA 68%: <span class="sp-val">' + (best.peakPga / pgaFactor).toFixed(1) + '–' + (best.peakPga * pgaFactor).toFixed(1) + ' gal</span>';
        if (sigmaMode === 'pgaPgv') {
          var pgvFactor = Math.pow(10, best.sigmaPgv || best.sigmaPga || 0);
          infoHtml += '<br>PGV 68%: <span class="sp-val">' + (best.peakPgv / pgvFactor).toFixed(1) + '–' + (best.peakPgv * pgvFactor).toFixed(1) + ' cm/s</span>';
        }
      } else if (sigmaMode === 'exceedance') {
        var exceed = Physics.exceedanceProbability(best.peakPga, best.sigmaPga, 80) * 100;
        infoHtml += '<br>P(PGA ≥ 80 gal): <span class="sp-val">' + exceed.toFixed(1) + '%</span>';
      }
    } else {
      var pendingVs30 = siteVs30Details(best);
      infoHtml = escapeHTML(t('info.estimated_intensity')) + ': <span class="sp-val" style="color:#9ab">' + escapeHTML(t('mwf.pending')) + '</span>'
        + ' &nbsp; Dist: <span class="sp-val">' + distKm + ' km</span><br>'
        + '<span class="sp-val" style="color:#9ab">' + best.lat.toFixed(3) + '°N, ' + best.lng.toFixed(3) + '°E</span><br>'
        + escapeHTML(t('info.vs30')) + ': <span class="sp-val">' + Math.round(pendingVs30.value) + ' m/s (' + escapeHTML(pendingVs30.source) + ')</span>';
    }
    if (best.isSeafloor) {
      infoHtml += '<br>' + escapeHTML(t('station.network')) + ': <span class="sp-val">' + escapeHTML(best.network || '-') + '</span>'
        + ' · ' + escapeHTML(t('station.water_depth')) + ': <span class="sp-val">' + Math.round(best.depth || 0) + ' m</span><br>'
        + escapeHTML(t('station.catalog_status')) + ': <span class="sp-val">' + escapeHTML(t('station.status_' + (best.operationalStatus || 'not-provided'))) + '</span>';
    }
    // "Add to multi-station waveform" button state
    var alreadyAdded = false;
    for (var ai = 0; ai < _mwfSlots.length; ai++) { if (_mwfSlots[ai].station && _mwfSlots[ai].station.id === best.id) { alreadyAdded = true; break; } }
    var hasFree = _mwfFindFreeSlot() >= 0;
    var btnHtml;
    if (alreadyAdded) btnHtml = '<button class="sp-add-mwf" disabled style="opacity:.6">'+escapeHTML(t('mwf.added'))+'</button>';
    else if (!hasFree) btnHtml = '<button class="sp-add-mwf" disabled style="opacity:.6">'+escapeHTML(t('mwf.full'))+'</button>';
    else btnHtml = '<button class="sp-add-mwf" data-sta-id="'+best.id+'">＋ '+escapeHTML(t('mwf.add'))+'</button>';
    sp.innerHTML = '<div class="sp-name">' + escapeHTML(best.name || ('#'+best.id)) + ' <small style="opacity:.6">' + typeTag + '</small></div>'
      + infoHtml
      + '<div style="margin-top:6px">' + btnHtml + '</div>';
    sp.classList.add('sp-interactive');
    sp.style.display = 'block';
    sp.style.left = (containerPt.x + 15) + 'px';
    sp.style.top = (containerPt.y - 10) + 'px';
    // Wire the add button
    var addBtn = sp.querySelector('button.sp-add-mwf[data-sta-id]');
    if (addBtn) {
      addBtn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        _mwfAddStation(best);
        addBtn.disabled = true; addBtn.style.opacity = '.6'; addBtn.textContent = t('mwf.added');
      });
    }
    // Switch single-station waveform display to this station (only meaningful when running)
    if (hasShake) {
      wfStation = best; wfSamples = []; wfScrollOffset = 0; wfMaxSample = 0;
      _wfAftershockSignals = []; _wfAftershockSignalsReady = false;
    }
  });
  mapEl.addEventListener('mousemove', function(e) {
    var mapRect=mapEl.getBoundingClientRect();
    var zoneHit=findTsunamiInundationZone(map.containerPointToLatLng([e.clientX-mapRect.left,e.clientY-mapRect.top]));
    var nextZoneId=zoneHit?zoneHit.id:null;
    if(nextZoneId!==_tsunamiHoveredZoneId){
      _tsunamiHoveredZoneId=nextZoneId;mapEl.classList.toggle('tsunami-zone-hover',!!zoneHit);
      if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
      if(!isRunning&&typeof drawFrame==='function')drawFrame();
    }
    if (!isRunning) return;
    var sp = document.getElementById('station-popup');
    if (!sp || sp.style.display === 'none') return;
    if (e.target.closest('button, .leaflet-control, #timeline, #legend')) { sp.style.display = 'none'; }
  });
  mapEl.addEventListener('mouseleave',function(){
    if(_tsunamiHoveredZoneId==null)return;
    _tsunamiHoveredZoneId=null;mapEl.classList.remove('tsunami-zone-hover');
    if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
    if(!isRunning&&typeof drawFrame==='function')drawFrame();
  });
  // Resize the backing bitmap ONLY when the pixel size actually changes.
  // Assigning to canvas.width/height clears the canvas, and Leaflet fires 'move'
  // (with the size unchanged) continuously throughout a zoom/pan — resizing there
  // wiped the overlay every move and made it flicker. Size only changes on 'resize'.
  function rs() {
    var w = mapEl.clientWidth, h = mapEl.clientHeight;
    if (waveCanvas.width !== w || waveCanvas.height !== h) { waveCanvas.width = w; waveCanvas.height = h; }
    if (smCanvas) {
      var sw = Math.floor(w / 5), sh = Math.floor(h / 5);
      if (smCanvas.width !== sw || smCanvas.height !== sh) { smCanvas.width = sw; smCanvas.height = sh; }
    }
  }
  window.addEventListener('resize', rs);
  map.on('resize', rs);
  map.on('move zoom resize', function() {
    if (typeof Renderer !== 'undefined' && Renderer.invalidateCaches) Renderer.invalidateCaches();
  });
  // While a sim runs, the rAF loop redraws every frame. When idle, redraw once after
  // the map settles so a finished simulation's overlay tracks zoom/pan instead of
  // sticking at stale pixel positions.
  map.on('moveend zoomend', function(){ if (!isRunning) drawFrame(); });
}

// [toCanvas] moved to renderer.js (see window.toCanvas = Renderer.toCanvas)

// [kmToPx] moved to renderer.js (see window.kmToPx = Renderer.kmToPx)

// [drawFrame] moved to renderer.js (see window.drawFrame = Renderer.drawFrame)

// Draw P/S wave rings for a single event (all events use same mainshock style)
// [drawEventWaves] moved to renderer.js (see window.drawEventWaves = Renderer.drawEventWaves)

// [drawDepthBar] moved to renderer.js (see window.drawDepthBar = Renderer.drawDepthBar)


// [drawShakingGrid] moved to renderer.js (see window.drawShakingGrid = Renderer.drawShakingGrid)

// Coastline segments for tsunami warning drawing (built once from GeoJSON)
var coastSegments = []; // [{lat1,lng1,lat2,lng2}]
var _tsuCheckPoints = []; // every fifth coastline segment, built once

function buildCoastSegments() {
  coastSegments = [];
  _tsuCheckPoints = [];
  if (!japanLandPolygons) return;
  var ringId = 0;
  var features = japanLandPolygons.features || [japanLandPolygons];
  for (var fi = 0; fi < features.length; fi++) {
    var geom = features[fi].geometry;
    var coords = geom.coordinates;
    var type = geom.type;
    // Collect all point rings
    var rings = [];
    if (type === 'LineString') rings = [coords];
    else if (type === 'MultiLineString') rings = coords;
    else if (type === 'Polygon') rings = coords;
    else if (type === 'MultiPolygon') {
      for (var mi = 0; mi < coords.length; mi++)
        for (var ri = 0; ri < coords[mi].length; ri++)
          rings.push(coords[mi][ri]);
    }
    // Extract segments from each ring
    for (var ri = 0; ri < rings.length; ri++) {
      var ring = rings[ri];
      if (!ring || ring.length < 2) continue;
      for (var i = 0; i < ring.length - 1; i++) {
        var p1 = ring[i], p2 = ring[i+1];
        if (typeof p1[0] !== 'number' || typeof p2[0] !== 'number') continue;
        var dlat = p2[1] - p1[1], dlng = p2[0] - p1[0];
        var dist = Math.sqrt(dlat*dlat + dlng*dlng);
        if (dist > 0.05) {
          var steps = Math.ceil(dist / 0.03);
          for (var s = 0; s < steps; s++) {
            var t1 = s/steps, t2 = (s+1)/steps;
            coastSegments.push({
              lat1: p1[1] + dlat*t1, lng1: p1[0] + dlng*t1,
              lat2: p1[1] + dlat*t2, lng2: p1[0] + dlng*t2,
              ringId: ringId
            });
          }
        } else {
          coastSegments.push({lat1:p1[1], lng1:p1[0], lat2:p2[1], lng2:p2[0], ringId:ringId});
        }
      }
      ringId++;
    }
  }
  for (var ci = 0; ci < coastSegments.length; ci += 5) {
    var segment = coastSegments[ci];
    var checkLat = (segment.lat1 + segment.lat2) / 2;
    var checkLng = (segment.lng1 + segment.lng2) / 2;
    _tsuCheckPoints.push({
      lat: checkLat,
      lng: checkLng,
      key: checkLat.toFixed(2) + ',' + checkLng.toFixed(2),
      segmentIndex: ci,
      ringId: segment.ringId
    });
  }
  console.log('Coast segments: ' + coastSegments.length);
}

// Build fixed offshore control points from the official JMA AreaTsunami lines.
// Alerts are aggregated by these 66 forecast areas instead of by visual coast
// fragments. Every point is snapped once to a nearby wet raster cell, avoiding
// repeated and potentially opposite-coast nearest-cell searches during a run.
function buildJmaTsunamiForecastAreas() {
  _tsuForecastAreas = [];
  _tsuForecastAreaByCode = Object.create(null);
  if (!_jmaTsunamiAreaData || !_jmaTsunamiAreaData.features || !_bathyGrid) return;
  var allPoints = [];
  for (var fi = 0; fi < _jmaTsunamiAreaData.features.length; fi++) {
    var feature = _jmaTsunamiAreaData.features[fi];
    var props = feature.properties || {}, geometry = feature.geometry || {};
    var code = String(props.code || '').padStart(3, '0');
    if (!code || code === '000' || geometry.type !== 'MultiLineString') continue;
    var lines = geometry.coordinates || [], candidates = [], seenCells = Object.create(null);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line || line.length < 2) continue;
      for (var pi = 0; pi < line.length; pi++) candidates.push(line[pi]);
    }
    var controls = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var coord = candidates[ci];
      var wet = Physics.findNearestWetCell(_bathyGrid, coord[1], coord[0], 2);
      if (!wet || seenCells[wet.index]) continue;
      seenCells[wet.index] = true;
      controls.push({
        lat:wet.lat, lng:wet.lng, coastLat:coord[1], coastLng:coord[0],
        waterDepth:wet.depth, gridIndex:wet.index, areaCode:code,
        areaName:props.name || code, key:code + '|' + wet.index
      });
    }
    // Keep a uniform, bounded sample per forecast area. The official line is
    // retained in full for rendering, while numerical work stays predictable.
    if (controls.length > 80) {
      var reduced = [];
      for (var ri = 0; ri < 80; ri++) reduced.push(controls[Math.floor(ri * controls.length / 80)]);
      controls = reduced;
    }
    if (!controls.length) continue;
    var area = {code:code,name:props.name || code,nameKana:props.nameKana || '',
      basin:Physics.jmaTsunamiAreaBasin(code),lines:lines,checkPoints:controls};
    _tsuForecastAreas.push(area);
    _tsuForecastAreaByCode[code] = area;
    for (var ai = 0; ai < controls.length; ai++) allPoints.push(controls[ai]);
  }
  if (_tsuForecastAreas.length) _tsuCheckPoints = allPoints;
  // Solver proxies created before the coastline finished loading carry an
  // empty checkpoint set — push the fresh one (worker and local alike).
  for (var _cpk in _tsuWaveSolvers) {
    if (_tsuWaveSolvers[_cpk] && typeof _tsuWaveSolvers[_cpk].setCheckpoints === 'function') _tsuWaveSolvers[_cpk].setCheckpoints(_tsuCheckPoints);
  }
  console.log('JMA tsunami forecast areas: ' + _tsuForecastAreas.length +
    ', offshore controls: ' + _tsuCheckPoints.length);
}

function _nearestJmaTsunamiAreaCode(lat,lng) {
  var bestCode=null,bestDistance=Infinity;
  for(var ai=0;ai<_tsuForecastAreas.length;ai++){
    var controls=_tsuForecastAreas[ai].checkPoints;
    for(var ci=0;ci<controls.length;ci++){
      var distance=Physics.haversineDist(lat,lng,controls[ci].coastLat,controls[ci].coastLng);
      if(distance<bestDistance){bestDistance=distance;bestCode=_tsuForecastAreas[ai].code;}
    }
  }
  return bestCode;
}

var _tsuWarnFrame = 0;
var _tsuSegCache = [];
var _tsuSegDirty = true;
var _tsuWarningRenderSignature = '';
var tsunamiActual = []; // physically-propagated tsunami heights (separate from rapid warning)
var _tsuActualCache = []; // cached actual-height bar segments
var _tsuActualArrivalTimes = {};
var _tsuAreaPhysicalPeaks = {};
var _tsuTravelFields = {};
var _tsuWaveSolvers = {};
var TSU_FIELD_MAX_EVENTS = 8;
var TSU_SOLVER_MAX_EVENTS = 4;
var TSU_FIELD_MIN_MAG = 5.5;
var TSU_SOLVER_MIN_MAG = 6.5;

function _tsuEventKey(ev) {
  // Magnitude and depth belong in the key: two sub-events sharing a location
  // (multi-event mode gives them identical ids and originTimes) must never
  // reuse each other's solver or travel field.
  return [ev.id || 'event', Number(ev.originTime || 0).toFixed(2), ev.lat.toFixed(3), ev.lng.toFixed(3),
    Number(ev.mag || 0).toFixed(2), Number(ev.depth || 0).toFixed(1)].join(':');
}

// Drop cached solvers/fields whose event is no longer active, so a pruned
// aftershock cannot hold a slot forever and starve later large events.
function _tsuEvictInactive(cache) {
  var active = Object.create(null);
  for (var i = 0; i < activeEvents.length; i++) active[_tsuEventKey(activeEvents[i])] = true;
  for (var key in cache) if (cache[key] && !active[key]) {
    if (typeof cache[key].dispose === 'function') cache[key].dispose(); // worker-side solver cleanup
    delete cache[key];
  }
}
function _tsuAllocated(cache) {
  return Object.keys(cache).filter(function(k){ return !!cache[k]; }).length;
}

// Regional high-resolution coastal grids (GEBCO 2025 resamples, built by
// tools/build-bathymetry-regions.py). An ocean epicenter inside a region runs
// its tsunami solver and travel-time field on the regional 0.025° grid
// instead of the coarse 0.15° global grid — ria-coast shoaling resolves much
// better. The global grid still drives map rendering and forecast-area
// geometry, so a missing/failed regional fetch degrades gracefully.
function _regionalBathyRegionFor(lat, lng) {
  if (typeof REGIONAL_BATHY === 'undefined' || !REGIONAL_BATHY) return null;
  for (var i = 0; i < REGIONAL_BATHY.length; i++) {
    var b = REGIONAL_BATHY[i].bbox;
    if (lat >= b[1] && lat <= b[3] && lng >= b[0] && lng <= b[2]) return REGIONAL_BATHY[i];
  }
  return null;
}
function _prefetchRegionalBathy(lat, lng) {
  var R = _regionalBathyRegionFor(lat, lng);
  if (!R || _regionalBathy[R.id] || _regionalBathyLoading[R.id]) return;
  _regionalBathyLoading[R.id] = fetch('/geojson/grids/' + R.id + '.json')
    .then(function(r) { if (!r || !r.ok) throw new Error('http'); return r.json(); })
    .then(function(g) {
      var check = Physics.validateResearchGrid(g, 'terrain');
      _regionalBathy[R.id] = check.valid ? g : false;
      if (check.valid) console.log('Regional bathymetry loaded:', R.id, g.nx + 'x' + g.ny);
    })
    .catch(function() { _regionalBathy[R.id] = false; })
    .finally(function() { delete _regionalBathyLoading[R.id]; });
}
function _tsuGridForEvent(ev) {
  if (ev && typeof isOceanPoint === 'function' && isOceanPoint(ev.lat, ev.lng)) {
    var R = _regionalBathyRegionFor(ev.lat, ev.lng);
    if (R) {
      if (_regionalBathy[R.id]) return _regionalBathy[R.id];
      _prefetchRegionalBathy(ev.lat, ev.lng); // too late for this event, helps the next
    }
  }
  return _bathyGrid;
}

function _tsuFieldForEvent(ev) {
  if (!_bathyGrid || !ev) return null;
  var key = _tsuEventKey(ev);
  if (Object.prototype.hasOwnProperty.call(_tsuTravelFields, key)) return _tsuTravelFields[key] || null;
  if (!ev.isMainshock && Number(ev.mag) < TSU_FIELD_MIN_MAG) {
    _tsuTravelFields[key] = false;
    return null;
  }
  var allocated = _tsuAllocated(_tsuTravelFields);
  if (allocated >= TSU_FIELD_MAX_EVENTS) { _tsuEvictInactive(_tsuTravelFields); allocated = _tsuAllocated(_tsuTravelFields); }
  if (allocated >= TSU_FIELD_MAX_EVENTS) {
    _tsuTravelFields[key] = false;
    return null;
  }
  _tsuTravelFields[key] = Physics.buildTsunamiTravelTimeField(_tsuGridForEvent(ev),ev.lat,ev.lng,TSU_SPD()) || false;
  return _tsuTravelFields[key] || null;
}

function _tsuSolverForEvent(ev) {
  if (!_bathyGrid || !ev || cfgGet('tsunamiSolver') === 'travelTime') return null;
  var key=_tsuEventKey(ev);
  if (Object.prototype.hasOwnProperty.call(_tsuWaveSolvers, key)) return _tsuWaveSolvers[key] || null;
  if (!ev.isMainshock && Number(ev.mag) < TSU_SOLVER_MIN_MAG) {
    _tsuWaveSolvers[key] = false;
    return null;
  }
  var allocated = _tsuAllocated(_tsuWaveSolvers);
  if (allocated >= TSU_SOLVER_MAX_EVENTS) { _tsuEvictInactive(_tsuWaveSolvers); allocated = _tsuAllocated(_tsuWaveSolvers); }
  if (allocated >= TSU_SOLVER_MAX_EVENTS) {
    _tsuWaveSolvers[key] = false;
    return null;
  }
  {
    var source=ev.sourceModel||buildSourceModel({lat:ev.lat,lng:ev.lng,mag:ev.mag,mw:ev.mag,depth:ev.depth,
      strike:ev.strike,dip:ev.dip,rake:ev.rake,mechanismKnown:ev.mechanismKnown,sourceType:ev.sourceType,originTime:ev.originTime});
    if (cfgGet('tsunamiSolver') === 'nonlinearSWE') {
      var grid=_tsuGridForEvent(ev),solverOpts={manning:cfgGet('tsunamiManning'),dryTolerance:cfgGet('tsunamiDryTolerance'),
        arrivalThreshold:cfgGet('tsunamiArrivalThreshold'),coriolis:cfgGet('tsunamiCoriolis')!=='off',visualAggregationKm:cfgGet('tsunamiAggregationKm'),
        deformationModel:cfgGet('tsunamiDeformationModel'),horizontalSlopeCoupling:cfgGet('tsunamiHorizontalSlope')!=='off',boundary:cfgGet('tsunamiBoundary')};
      // Regional grid active -> run it as a fine level over the global grid
      // (two-way AMR) instead of a sealed single-grid box.
      // v5.5: stepping runs inside the tsunami worker when available
      // (TsunamiSolverHost, nested-grid cost off the UI thread); the host
      // falls back to the identical in-process engine otherwise.
      var _coarse=(_tsuNestedAllowed()&&grid&&_bathyGrid&&grid!==_bathyGrid)?_bathyGrid:null;
      if (typeof TsunamiSolverHost !== 'undefined') {
        _tsuWaveSolvers[key]=TsunamiSolverHost.create({key:key,grid:grid,coarseGrid:_coarse,source:source,
          options:solverOpts,checkpoints:_tsuCheckPoints||[]});
      } else {
        var nested=_coarse?Physics.createNestedTsunamiSolver(_bathyGrid,grid,source,solverOpts):null;
        _tsuWaveSolvers[key]=nested||Physics.createNonlinearTsunamiSolver(grid,source,solverOpts);
      }
    } else {
      _tsuWaveSolvers[key]=Physics.createLinearTsunamiSolver(_tsuGridForEvent(ev),source,{arrivalThreshold:cfgGet('tsunamiArrivalThreshold'),
        deformationModel:cfgGet('tsunamiDeformationModel'),horizontalSlopeCoupling:cfgGet('tsunamiHorizontalSlope')!=='off'});
    }
    if (!_tsuWaveSolvers[key]) _tsuWaveSolvers[key] = false;
  }
  return _tsuWaveSolvers[key] || null;
}

// Whether the two-level nested solver may run (tsunamiNested: auto/on/off).
function _tsuNestedAllowed() {
  var mode = cfgGet('tsunamiNested');
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  var cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return cores >= 4;
}

// Check if straight-line path from epicenter to coastal point crosses Japan landmass
// Samples points every 20km along the path — if any sample is land, path is blocked
function isPathBlockedByLand(epLat, epLng, ptLat, ptLng) {
  var dist = Physics.haversineDist(epLat, epLng, ptLat, ptLng);
  if (dist < 5) return false; // too close to matter
  var steps = Math.ceil(dist / 10); // sample every 10 km (was 20)
  for (var i = 1; i < steps; i++) {
    var t = i / steps;
    // Use great-circle interpolation for accurate path sampling
    var d = t * dist;
    var bearing = Math.atan2(
      Math.sin((ptLng - epLng) * Math.PI / 180) * Math.cos(ptLat * Math.PI / 180),
      Math.cos(epLat * Math.PI / 180) * Math.sin(ptLat * Math.PI / 180) -
      Math.sin(epLat * Math.PI / 180) * Math.cos(ptLat * Math.PI / 180) * Math.cos((ptLng - epLng) * Math.PI / 180)
    );
    var lat = Math.asin(
      Math.sin(epLat * Math.PI / 180) * Math.cos(d / 6371) +
      Math.cos(epLat * Math.PI / 180) * Math.sin(d / 6371) * Math.cos(bearing)
    ) * 180 / Math.PI;
    var lng = epLng + Math.atan2(
      Math.sin(bearing) * Math.sin(d / 6371) * Math.cos(epLat * Math.PI / 180),
      Math.cos(d / 6371) - Math.sin(epLat * Math.PI / 180) * Math.sin(lat * Math.PI / 180)
    ) * 180 / Math.PI;
    if (!isOceanPoint(lat, lng)) return true; // path crosses land
  }
  return false;
}

// Expensive step: assign each in-view coastline segment the color of its nearest
// tsunami warning. Recomputed only periodically (see drawTsunamiWarnings).
function computeTsuSegments() {
  var out = [];
  if (!tsunamiCircles.length) return out;
  var bounds = map.getBounds(), pad = 0.5;
  if (_tsuForecastAreas.length) {
    var levelByArea = Object.create(null);
    for (var wi = 0; wi < tsunamiCircles.length; wi++) {
      var warning = tsunamiCircles[wi];
      if (!warning.areaCode) continue;
      var previous = levelByArea[warning.areaCode];
      if (!previous || Physics.tsunamiWarningRank(warning.level) > Physics.tsunamiWarningRank(previous)) {
        levelByArea[warning.areaCode] = warning.level;
      }
    }
    for (var afi = 0; afi < _tsuForecastAreas.length; afi++) {
      var area = _tsuForecastAreas[afi], areaLevel = levelByArea[area.code];
      if (!areaLevel) continue;
      var areaColor = TSUNAMI_WARN_COLORS[areaLevel];
      var ar = parseInt(areaColor.slice(1,3),16), ag = parseInt(areaColor.slice(3,5),16), ab = parseInt(areaColor.slice(5,7),16);
      for (var ali = 0; ali < area.lines.length; ali++) {
        var line = area.lines[ali];
        for (var api = 1; api < line.length; api++) {
          var p1 = line[api-1], p2 = line[api];
          var mlat = (p1[1]+p2[1])*0.5, mlng = (p1[0]+p2[0])*0.5;
          if (mlat < bounds.getSouth()-pad || mlat > bounds.getNorth()+pad ||
              mlng < bounds.getWest()-pad || mlng > bounds.getEast()+pad) continue;
          out.push({lat1:p1[1],lng1:p1[0],lat2:p2[1],lng2:p2[0],color:areaColor,
            glow:'rgba('+ar+','+ag+','+ab+',0.3)',areaCode:area.code});
        }
      }
    }
    return out;
  }
  if (!coastSegments.length) return out;
  // Coast points are evaluated every five short segments. Close only a single
  // missing sample inside the same coastline ring, preserving wider quiet gaps.
  var segmentRingIds = new Array(coastSegments.length);
  for (var ri = 0; ri < coastSegments.length; ri++) segmentRingIds[ri] = coastSegments[ri].ringId;
  var coverage = Physics.buildCoastalWarningCoverage(tsunamiCircles, 3, 10, segmentRingIds);
  for (var si = 0; si < coastSegments.length; si++) {
    var seg = coastSegments[si];
    var mlat = (seg.lat1 + seg.lat2) / 2;
    var mlng = (seg.lng1 + seg.lng2) / 2;
    if (mlat < bounds.getSouth()-pad || mlat > bounds.getNorth()+pad ||
        mlng < bounds.getWest()-pad || mlng > bounds.getEast()+pad) continue;
    var covered = coverage[String(si)];
    var minLevel = covered && String(seg.ringId) === covered.ringId ? covered.level : null;
    if (minLevel) {
      var color = TSUNAMI_WARN_COLORS[minLevel];
      var hr = parseInt(color.slice(1,3),16), hg = parseInt(color.slice(3,5),16), hb = parseInt(color.slice(5,7),16);
      out.push({lat1:seg.lat1, lng1:seg.lng1, lat2:seg.lat2, lng2:seg.lng2,
                color:color, glow:'rgba('+hr+','+hg+','+hb+',0.3)'});
    }
  }
  return out;
}

// Focal mechanism beach ball diagram
// [drawBeachBall] moved to renderer.js (see window.drawBeachBall = Renderer.drawBeachBall)

// Seafloor bathymetry visualization (canvas overlay)
var _bathyShow = false; // toggle via #bathy-enable checkbox
var _vs30Show = false;
var _tsuResearchSnapshot = null;
var _tsuResearchSnapshotKey = ''; // event key that produced the snapshot; tracked so a pruned source event does not leave a frozen overlay
var _tsunamiSelectedZoneId = null, _tsunamiHoveredZoneId = null, _tsunamiZoneDetailSignature = '';
// [drawBathymetry] moved to renderer.js (see window.drawBathymetry = Renderer.drawBathymetry)

// [drawTsunamiWarnings] moved to renderer.js (see window.drawTsunamiWarnings = Renderer.drawTsunamiWarnings)

// Show-all-stations mode: draw every station (muted, no-shindo style) as a
// background layer so the user can pick observation stations before a quake.
var showAllStations = false;
// [drawAllStations] moved to renderer.js (see window.drawAllStations = Renderer.drawAllStations)

// [drawIntensityCircles] moved to renderer.js (see window.drawIntensityCircles = Renderer.drawIntensityCircles)

// -- Simulation --
function preComputeArrivals(params) {
  params = params || {};
  var mag = params.mag != null ? params.mag : _liveMag;
  var mw = params.mw != null ? params.mw : (eventMw != null ? eventMw : mag);
  var sliderMw = params.sliderMag != null ? params.sliderMag : mag;
  var strDeg = params.strike != null ? params.strike : parseFloat(strikeSlider.value);
  var dipDeg = params.dip != null ? params.dip : currentDip;
  var depthKm = params.depth != null ? params.depth : _liveDepth;
  var eventLat = params.lat != null ? params.lat : (epicenter && epicenter.lat);
  var eventLng = params.lng != null ? params.lng : (epicenter && epicenter.lng);
  var eventSource = params.sourceType || epicenterSrc;
  var rakeDeg = params.rake != null ? params.rake : currentRake;
  var mechanismKnown = params.mechanismKnown != null ? !!params.mechanismKnown : _rakeExplicit;
  var data = [];
  var _sourceResolved = resolvedSourceType(depthKm, eventSource, eventLat, eventLng);
  var canonicalSource = buildSourceModel({lat:eventLat,lng:eventLng,mag:mag,mw:mw,depth:depthKm,
    strike:strDeg,dip:dipDeg,rake:rakeDeg,mechanismKnown:mechanismKnown,sourceType:_sourceResolved,
    momentTensor:params.momentTensor,inheritObservedMomentTensor:params.inheritObservedMomentTensor,
    finiteFault:params.finiteFault,inheritObservedFiniteFault:params.inheritObservedFiniteFault});
  mw=canonicalSource.mw;strDeg=canonicalSource.strikeDeg;dipDeg=canonicalSource.dipDeg;
  var useFF = mw >= 6.5 || !!canonicalSource.finiteFault;
  var ff = useFF ? canonicalSource.geometry : null;
  var subs = ff&&ff.subs ? ff.subs : null;
  // Resolve auto once so browser and Node validation use the same median model.
  var _gmpResolved = cfgGet('gmpModel');
  if (_gmpResolved === 'auto') {
    _gmpResolved = Physics.resolveGmpModel(_gmpResolved, _sourceResolved, mw);
  }
  // v4.3: Compute GMPE sigma once (log10 std dev) — used for ±1σ display and LLH scoring
  var sigmaMw = mw;
  var _gmpSigma = Physics.getGmpSigma(cfgGet('gmpModel'), _sourceResolved, 'pga', sigmaMw);
  var _gmpSigmaPgv = Physics.getGmpSigma(cfgGet('gmpModel'), _sourceResolved, 'pgv', sigmaMw);
  if (cfgGet('sigmaOverride') > 0) _gmpSigma = cfgGet('sigmaOverride');
  if (cfgGet('sigmaOverride') > 0) _gmpSigmaPgv = cfgGet('sigmaOverride');
  var total = rawLandGrid.length, batch = 5000;
  var groundMotionContext = Physics.createGroundMotionContext({
    lat:canonicalSource.lat,lng:canonicalSource.lng,mag:canonicalSource.mag,mw:canonicalSource.mw,
    depthKm:canonicalSource.depthKm,strikeDeg:canonicalSource.strikeDeg,
    dipDeg:canonicalSource.dipDeg,sourceType:canonicalSource.sourceType
  }, {
    gmpModel:_gmpResolved,geometry:ff,finiteFault:useFF,rupSpeed:cfgGet('rupSpeed'),
    attA:cfgGet('attA'),attB:cfgGet('attB'),attC:cfgGet('attC'),anelastic:cfgGet('anelastic'),
    siteModel:cfgGet('siteModel'),siteBase:cfgGet('siteBase'),siteSoftMax:cfgGet('siteSoftMax'),
    siteHardMin:cfgGet('siteHardMin'),siteNonlinear:cfgGet('siteNonlinear'),
    directivity:cfgGet('directivity')
  });
  // The JMA filter is linear before the logarithmic intensity conversion.
  // Cache reference-PGA waveforms on a logarithmic distance grid and
  // interpolate them, reducing a full-Japan jma3c run from thousands of FFTs
  // to roughly 50 while keeping the distance response continuous.
  var jmaReferenceCache = {};
  var jmaDistanceStep = 0.15;
  var jmaSeed = Research.normalizeSeed(cfgGet('randomSeed')) ^ Math.floor((eventLat*1000+eventLng*1000+mw*100)*100);
  function jmaReferenceAtDistance(distanceKm) {
    var pos=Math.log(Math.max(1,distanceKm))/jmaDistanceStep;
    var lo=Math.floor(pos),hi=lo+1,frac=pos-lo;
    function at(bin){
      if(jmaReferenceCache[bin] == null){
        var binDist=Math.exp(bin*jmaDistanceStep);
        jmaReferenceCache[bin]=Physics.calcStochasticJmaIntensity(
          mw,binDist,100,cfgGet('stressDrop'),50,jmaSeed);
      }
      return jmaReferenceCache[bin];
    }
    return at(lo)*(1-frac)+at(hi)*frac;
  }
  // Pre-compute soil amp per point for speed
  var soilCache = [];
  for (var i = 0; i < total; i++) {
    var pt = rawLandGrid[i];
    var fl = 0.82 + Research.randomAt(cfgGet('randomSeed'),'station-factor:'+(pt.id!=null?pt.id:(pt.lat+','+pt.lng)),0) * 0.36;
    var vs30Details = siteVs30Details(pt);
    if (pt.vs30Source !== 'measured' && vs30Details.source === 'station') vs30Details.source = 'station-estimate';
    var siteModel = cfgGet('siteModel');
    var motionOverrides = {stationFactor:fl,siteModel:siteModel,siteNonlinear:cfgGet('siteNonlinear')};
    if (siteModel === 'geo') {
      motionOverrides.siteAmplificationPga = soilAmp(pt.lat, pt.lng, pt.isSeafloor, pt.siteFactor);
      motionOverrides.siteAmplificationPgv = motionOverrides.siteAmplificationPga;
    }
    var motion = Physics.predictStationMotion(groundMotionContext, {
      lat:pt.lat,lng:pt.lng,vs30:vs30Details.value,siteFactor:pt.siteFactor
    }, motionOverrides);
    var dist = motion.distanceKm, bp = motion.referencePga, bpv = motion.referencePgv;
    var sa = motion.sitePga, sv = motion.sitePgv, fd = motion.directivityFactor;
    var pga = motion.pga, pgv = motion.pgv, I = motion.intensity;
    var patchPga = [], patchPgv = [];
    var earliestP = Infinity, earliestS = Infinity, latestS = 0;
    for (var si = 0; si < motion.patches.length; si++) {
      var patch = motion.patches[si], s = patch.source;
      var patchP = s.ruptureTime + Physics.pTravelTime(patch.horizontalKm, s.depth, cfgGet('pWaveSpeed'));
      var patchS = s.ruptureTime + Physics.sTravelTime(patch.horizontalKm, s.depth, cfgGet('sWaveSpeed'));
      var patchEnd=patchS+(s.riseTime||0);
      patchPga.push({pArrive:patchP,sArrive:patchS,endArrive:patchEnd,riseTime:s.riseTime||1,
        sourceTimeFunction:s.sourceTimeFunction||'half-cosine',amp:patch.pga});
      patchPgv.push({pArrive:patchP,sArrive:patchS,endArrive:patchEnd,riseTime:s.riseTime||1,
        sourceTimeFunction:s.sourceTimeFunction||'half-cosine',amp:patch.pgv});
      earliestP=Math.min(earliestP,patchP);earliestS=Math.min(earliestS,patchS);latestS=Math.max(latestS,patchEnd);
    }
    var pointHorizontal = motion.horizontalKm;
    var pA = patchPga.length ? earliestP : Physics.pTravelTime(pointHorizontal,depthKm,cfgGet('pWaveSpeed'));
    var sA = patchPga.length ? earliestS : Physics.sTravelTime(pointHorizontal,depthKm,cfgGet('sWaveSpeed'));
    if (cfgGet('intensityMethod') === 'jma3c') {
      I = pga > 0 ? Math.max(0,jmaReferenceAtDistance(dist)+2*Math.log10(pga/100)) : 0;
    }
    var sh = Physics.intensityToShindo(I);
    if (sh !== 0 || pga >= 0.8) {
      var lp = Physics.calcLPGM(mw, dist, pga, sa);
      var cellIdx = stationToCell[pt.id];
      data.push({
        lat:pt.lat, lng:pt.lng, id:pt.id, name:pt.name, pArrive:pA, sArrive:sA,
        peakPga:pga, pga:pga, peakPgv:pgv, pgv:pgv, displayPga:0, jitterOffset:0, lastJitterSec:-1,
        pointPga: motion.pointPga, maxRupTime: ff ? ff.maxRuptureTime : 0,
        patchPga:patchPga.length ? patchPga : null, patchPgv:patchPgv.length ? patchPgv : null, latestPatchS:latestS || sA,
        intensity:I, shindo:sh, lpgm:lp, cellIdx:cellIdx,
        active:false, decayed:false, aftershocks: [], subEvents: [],
        isSeafloor: !!pt.isSeafloor,
        // v4.3: aleatory variability and nonlinear site amplification
        sigmaPga: _gmpSigma, sigmaPgv:_gmpSigmaPgv, siteAmpNL: sa,
        vs30Value:vs30Details.value, vs30Source:vs30Details.source,
        gmpeModel:_gmpResolved, sourceType:_sourceResolved,
        distanceMetric:motion.distanceMetric,
        sourceModel:canonicalSource
      });
    }
  }
  data.sort(function(a,b){return a.pArrive - b.pArrive;});
  return data;
}

// -- JQuake-style GMPE Forecast: predict max Shindo for all 47 prefectures --
// centroids override (v5.3): pass _subareaCentroids to forecast the 194 JMA
// subdivisions instead — same physics, finer geography.
function _predictPrefectureShindosFor(lat, lng, mag, depthKm, strDeg, dipDeg, srcOverride, eventMwOverride, sliderMwOverride, centroids) {
  var results = {};
  var cents = centroids || _prefCentroids;
  if (!cents) return results;
  var geometryMw = eventMwOverride != null ? eventMwOverride : mag;
  var useFF = geometryMw >= 6.5;
  // Build faultParams for Rrup calculation (same logic as preComputeArrivals)
  var ff = null, faultParams = null;
  if (useFF) {
    ff = genSubSources(lat, lng, geometryMw, strDeg, dipDeg, depthKm, srcOverride);
    if (ff) faultParams = ff;
  }
  // Resolve GMPE model once
  var _gmpResolved = cfgGet('gmpModel');
  if (_gmpResolved === 'auto') {
    var src2 = resolvedSourceType(depthKm, srcOverride, lat, lng);
    _gmpResolved = Physics.resolveGmpModel(_gmpResolved, src2, eventMwOverride != null ? eventMwOverride : mag);
  }
  for (var i = 0; i < cents.length; i++) {
    var pc = cents[i];
    var dist;
    if (faultParams && (_gmpResolved === 'si-midorikawa' || _gmpResolved === 'log-ff')) {
      dist = Physics.rrupDistance(pc.lat, pc.lng, faultParams);
    } else {
      var surfDist = Physics.haversineDist(lat, lng, pc.lat, pc.lng);
      dist = Math.sqrt(surfDist * surfDist + depthKm * depthKm);
    }
    if (dist < 0.5) dist = 0.5;
    var predSrc = resolvedSourceType(depthKm, srcOverride, lat, lng);
    var predVs = (cfgGet('siteModel') === 'vs30') ? Physics.lookupVs30(pc.lat, pc.lng) : 0;
    // Zhao/Kanno carry native Vs30 site terms: feed the real Vs30 instead of
    // rock-reference output + external power-law amp (the old mix double-
    // counted Zhao's site class and referenced the amp to the wrong base).
    var nativeSite = predVs > 0 && (_gmpResolved === 'zhao2006' || _gmpResolved === 'kanno2006');
    var refVs = nativeSite ? predVs : (_gmpResolved === 'zhao2006' ? 1200 : (_gmpResolved === 'kanno2006' ? 800 : 760));
    var pga = calcPGAFor(mag, dist, depthKm, predSrc, refVs, eventMwOverride, sliderMwOverride);
    var pgv = calcPGVFor(mag, dist, depthKm, predSrc, refVs, eventMwOverride, sliderMwOverride);
    if (predVs > 0 && !nativeSite) {
      // si-mid/log models have no site term. siteNonlinear='ss14' applies the
      // Seyhan-Stewart nonlinear correction, same as the station waveform path.
      if (cfgGet('siteNonlinear') === 'ss14') {
        pga *= Physics.vs30AmplificationNL(predVs, 'pga', pga);
        pgv *= Physics.vs30AmplificationNL(predVs, 'pgv', pga);
      } else {
        pga *= Physics.vs30Amplification(predVs, 'pga');
        pgv *= Physics.vs30Amplification(predVs, 'pgv');
      }
    }
    var I = Physics.calcJmaIntensity(pga, pgv);
    if (Physics.calibrateIntensity) I = Physics.calibrateIntensity(I, geometryMw, {model: _gmpResolved, distKm: dist});
    var sh = Physics.intensityToShindo(I);
    // Long-period class rides the same forecast field (station path has its
    // own via calcLPGM): M-aware corner + Q-path on the forecast PGA.
    var lp = Physics.calcLongPeriodSv ? Physics.calcLongPeriodSv(geometryMw, dist, pga).lpcClass : 0;
    results[pc.id] = {id: pc.id, nam: pc.nam, nam_ja: pc.nam_ja, shindo: sh, i: I, lpgm: lp};
  }
  return results;
}

function _predictPrefectureShindos() {
  if (!epicenter) return {};
  return _predictPrefectureShindosFor(
    epicenter.lat, epicenter.lng, _liveMag, _liveDepth,
    parseFloat(strikeSlider.value), currentDip, epicenterSrc, eventMw, _liveMag
  );
}

// Subdivision-level forecast: same GMPE call, evaluated at the 194 JMA
// subdivision centroids. Feeds the live area coloring layer; prefecture-level
// forecasts remain the reporting unit.
function _predictSubareaShindos() {
  if (!epicenter || !_subareaCentroids) return {};
  return _predictPrefectureShindosFor(
    epicenter.lat, epicenter.lng, _liveMag, _liveDepth,
    parseFloat(strikeSlider.value), currentDip, epicenterSrc, eventMw, _liveMag,
    _subareaCentroids
  );
}

// --- PLUM (Propagation of Local Undamped Motion) ---------------------------
// JMA's second EEW method (operational since 2018): extrapolate each
// station's CURRENT observed intensity outward with pure geometric decay —
// no hypocenter, no magnitude, hence immune to magnitude saturation and fast
// in the near field. Intensity decay follows the GMPE's own slope:
// I ∝ 2.23·log10(PGA), PGA ∝ R^-1.2 → ΔI = 2.68·log10(R2/R1).
var _plumDecayCoef = 2.68;
// Stations whose CURRENT observed intensity qualifies as a PLUM source.
// Exposed per track (tr.plumSrcs) so the map layer and the prefecture
// forecast share exactly one source list.
function _plumSourcesForTrack(tr) {
  var srcs = [];
  for (var i = 0; i < tr.stns.length; i++) {
    var pt = tr.stns[i].pt;
    if (pt && pt.intensity >= 3.5) srcs.push({lat: pt.lat, lng: pt.lng, I: pt.intensity});
  }
  return srcs;
}
function _plumPrefectureShindos(tr, centroids) {
  var cents = centroids || _prefCentroids;
  if (!cents || !tr.stns.length) return null;
  var srcs = tr.plumSrcs || _plumSourcesForTrack(tr);
  if (!srcs.length) return null;
  var out = {};
  for (var pi = 0; pi < cents.length; pi++) {
    var pc = cents[pi], best = 0;
    for (var si = 0; si < srcs.length; si++) {
      var s = srcs[si];
      var r = Physics.haversineDist(s.lat, s.lng, pc.lat, pc.lng);
      var predI = s.I - _plumDecayCoef * Math.log10(Math.max(r, 30) / 30);
      if (predI > best) best = predI;
    }
    if (best >= 3.0) out[pc.id] = {id: pc.id, nam: pc.nam, nam_ja: pc.nam_ja, shindo: Physics.intensityToShindo(best)};
  }
  return out;
}

// Detect-mode EEW: triggered by station P-wave detections (not known epicenter)
// Waits for 2nd bulletin (detectBulletin >= 2) for stable magnitude estimate before alerting
var _detectLastCheckedBulletin = 0; // track which bulletin we already evaluated
var _detectLastCheckedMag = 0;       // magnitude at last EEW check (re-check when mag improves)
var _detectLastCheckedTime = 0;      // sim-time of last EEW check

function _triggerDetectEEWAlert() {
  if (_detectEEWTriggered) return;
  _eewWarranted = true;
  _detectEEWTriggered = true;
  eewAlert.style.display = 'block';
  eewCountdown.textContent = '!';
  AudioManager.initContext();
  if (AudioManager._audioCtx && AudioManager._audioCtx.state === 'suspended') {
    AudioManager._audioCtx.resume();
  }
  if (_eewSoundTimer1) clearTimeout(_eewSoundTimer1);
  if (_eewSoundTimer2) clearTimeout(_eewSoundTimer2);
  _eewSoundTimer1 = setTimeout(function() { playEEWSound('EEW_alert'); }, 80);
  _eewSoundTimer2 = setTimeout(function() {
    eewAlert.style.display = 'none';
    if (soundModeEl.value !== 'jp') playEEWSound('EEW2');
    _scheduleSrevEEWVoice(200);
  }, 1200);
}

function _stopEEWTTS() {
  if (_eewTtsTimer) { clearTimeout(_eewTtsTimer); _eewTtsTimer = null; }
  if (_srevAnnouncer && typeof _srevAnnouncer.cancelMatching === 'function') {
    _srevAnnouncer.cancelMatching(function(group) { return group.id.indexOf('eew-') === 0; }, true);
  } else if (_eewTtsCtrl) {
    _eewTtsCtrl.abort();
  }
  _eewTtsCtrl = null;
}

function _srevSpeechEnabled() {
  if (soundModeEl.value !== 'jp' || typeof TTSTextBuilder === 'undefined' ||
      typeof SrevAnnouncer === 'undefined' || typeof AudioManager.playRemoteTTS !== 'function') return false;
  var ttsChk = document.getElementById('tts-enable');
  return !ttsChk || ttsChk.checked;
}

function _ensureSrevAnnouncer() {
  if (_srevAnnouncer || !_srevSpeechEnabled()) return _srevAnnouncer;
  _srevAnnouncer = SrevAnnouncer.create({
    maxLength:TTSTextBuilder.SREV_CHUNK_LENGTH || 128,
    maxGroups:8,
    speak:function(text, onEnd, onError) {
      var url = '/api/tts/synthesize?text=' + encodeURIComponent(text) +
        '&voice=' + encodeURIComponent(TTSTextBuilder.DEFAULT_VOICE);
      return AudioManager.playRemoteTTS(url, soundVolume, onEnd, onError);
    }
  });
  return _srevAnnouncer;
}

function _enqueueSrevSpeech(messages, hooks) {
  var announcer = _ensureSrevAnnouncer();
  if (!announcer) return null;
  return announcer.enqueue(messages, hooks || {});
}

function _cancelSrevSpeech() {
  if (_srevAnnouncer) _srevAnnouncer.cancelAll();
  _srevAnnouncer = null;
  _eewTtsCtrl = null;
}

function _scheduleSrevEEWVoice(delayMs) {
  _stopEEWTTS();
  if (!_srevSpeechEnabled()) return;
  _eewTtsTimer = setTimeout(function() {
    _eewTtsTimer = null;
    var areas = [];
    var candidates = [];
    for (var pid in _predictedPrefectureShindos) {
      var item = _predictedPrefectureShindos[pid];
      if (!item || Physics.shindoNum(item.shindo) < Physics.shindoNum('5-')) continue;
      candidates.push({ name: item.nam_ja || item.nam, score: Physics.shindoScore(item.shindo) });
    }
    candidates.sort(function(a, b) { return b.score - a.score; });
    for (var i = 0; i < candidates.length && areas.length < 12; i++) areas.push(candidates[i].name);
    var text = TTSTextBuilder.buildEEW({ areas: areas });
    var messages = [text];
    if (!detectMode && _srevLastEstimateBulletin === 0) {
      messages.push(TTSTextBuilder.buildEstimatedIntensity({location:'震源付近',maxShindo:_predictedMaxShindo,update:false}));
      _srevLastEstimateBulletin = 1;
      _srevLastEstimatedShindo = _predictedMaxShindo;
    }
    _eewTtsCtrl = _enqueueSrevSpeech(messages, {id:'eew-warning',replace:true,priority:30,onError:function(error) {
      console.warn('Dynamic EEW TTS unavailable; alert effects were retained.', error);
    }});
  }, Math.max(0, delayMs || 0));
}

function _checkDetectEEW() {
  if (!detectMode || !_detectTracks.length) return;
  var previouslyWarranted = _eewWarranted;
  var anyTrack = false;

  // Per-track: forecast refresh, estimate voice, alert issuance (SREV-style —
  // every concurrent event warning is tracked and announced independently).
  for (var ti = 0; ti < _detectTracks.length; ti++) {
    var tr = _detectTracks[ti];
    if (!tr.epi || tr.mag <= 0 || tr.bulletin < 1) continue;
    anyTrack = true;
    // Recompute every new bulletin so estimate updates remain audible.
    var magImproved = tr.mag > tr.lastCheckedMag + 0.4;
    var timeSinceLastCheck = simElapsed - tr.lastCheckedTime;
    if (tr.bulletin <= tr.lastCheckedBul && !magImproved && timeSinceLastCheck < 1.5) continue;
    tr.lastCheckedBul = tr.bulletin;
    tr.lastCheckedMag = tr.mag;
    tr.lastCheckedTime = simElapsed;

    // Predict with detected values (no global override — H8 fix)
    tr.fc = _predictPrefectureShindosFor(
      tr.epi.lat, tr.epi.lng, tr.mag, tr.epi.depth || _liveDepth,
      parseFloat(strikeSlider.value), 90, null, null, tr.mag  // assume vertical fault (point source)
    );
    // PLUM merge: the IPF forecast above needs a magnitude (which saturates
    // and is slow to converge); PLUM propagates each station's CURRENT
    // observed intensity outward with geometric decay only. Per prefecture,
    // keep whichever method predicts worse — exactly the dual-track behavior
    // of the operational JMA system.
    tr.plumSrcs = _plumSourcesForTrack(tr);
    var fcPlum = _plumPrefectureShindos(tr);
    if (fcPlum) {
      for (var pp in fcPlum) {
        // Running per-track PLUM peak (verification + future UI badge)
        if (Physics.shindoNum(fcPlum[pp].shindo) > Physics.shindoNum(tr.plumMax || 0)) tr.plumMax = fcPlum[pp].shindo;
        if (!tr.fc[pp] || Physics.shindoNum(fcPlum[pp].shindo) > Physics.shindoNum(tr.fc[pp].shindo)) tr.fc[pp] = fcPlum[pp];
      }
    }
    tr.fcMax = 0;
    for (var pid in tr.fc) {
      var psh = tr.fc[pid].shindo;
      if (Physics.shindoNum(psh) > Physics.shindoNum(tr.fcMax)) tr.fcMax = psh;
    }
    // Subdivision-level twin of the forecast above (map coloring only) —
    // same GMPE + PLUM merge evaluated at the 194 subdivision centroids
    if (_subareaCentroids) {
      tr.fcArea = _predictPrefectureShindosFor(
        tr.epi.lat, tr.epi.lng, tr.mag, tr.epi.depth || _liveDepth,
        parseFloat(strikeSlider.value), 90, null, null, tr.mag, _subareaCentroids
      );
      var fcPlumArea = _plumPrefectureShindos(tr, _subareaCentroids);
      if (fcPlumArea) {
        for (var pa in fcPlumArea) {
          if (!tr.fcArea[pa] || Physics.shindoNum(fcPlumArea[pa].shindo) > Physics.shindoNum(tr.fcArea[pa].shindo)) tr.fcArea[pa] = fcPlumArea[pa];
        }
      }
    }

    // Per-track estimate speech (first estimate, then on bulletin/shindo change)
    if (tr.bulletin > tr.lastEstBul || String(tr.fcMax) !== String(tr.lastEstShindo)) {
      var estimateText = TTSTextBuilder.buildEstimatedIntensity({
        location:'震源付近', maxShindo:tr.fcMax,
        update:tr.lastEstBul > 0
      });
      _enqueueSrevSpeech(estimateText, {id:'eew-estimate-t' + tr.id, replace:true, priority:20});
      tr.lastEstBul = tr.bulletin;
      tr.lastEstShindo = tr.fcMax;
    }

    // New warning: the first warranting track runs the legacy full alert;
    // later concurrent events replay the chime + voice like a fresh SREV warning.
    if (Physics.shindoNum(tr.fcMax) >= Physics.shindoNum('5-') && !tr.alerted) {
      tr.alerted = true;
      if (!_detectEEWTriggered) {
        _triggerDetectEEWAlert();
      } else {
        playEEWSound('EEW_alert');
        _scheduleSrevEEWVoice(1200);
      }
    }
    // Delayed per-event survey in detect mode too: the decay-based trigger
    // never fires mid-chain (merged shaking keeps rising).
    if (Physics.shindoNum(tr.fcMax) >= Physics.shindoNum('4')) _reportRearmAt = simElapsed + 8;
  }
  if (!anyTrack) return;

  // Merged forecast: per-prefecture max across all tracked events — concurrent
  // EEW warnings superpose, a prefecture under two warnings shows the worse.
  var merged = {};
  var mergedArea = {};
  for (var ti2 = 0; ti2 < _detectTracks.length; ti2++) {
    var tr2 = _detectTracks[ti2];
    if (!tr2.fc || tr2.bulletin < 1) continue;
    for (var pid2 in tr2.fc) {
      var item = tr2.fc[pid2];
      if (!merged[pid2] || Physics.shindoNum(item.shindo) > Physics.shindoNum(merged[pid2].shindo)) merged[pid2] = item;
    }
    if (tr2.fcArea) {
      for (var aid in tr2.fcArea) {
        var aitem = tr2.fcArea[aid];
        if (!mergedArea[aid] || Physics.shindoNum(aitem.shindo) > Physics.shindoNum(mergedArea[aid].shindo)) mergedArea[aid] = aitem;
      }
    }
  }
  _predictedPrefectureShindos = merged;
  _subareaForecast = mergedArea;
  _predictedMaxShindo = 0;
  _predictedMaxShindoI = -1;
  for (var pid3 in merged) {
    var msh = merged[pid3].shindo;
    if (Physics.shindoNum(msh) > Physics.shindoNum(_predictedMaxShindo)) {
      _predictedMaxShindo = msh;
      _predictedMaxShindoI = merged[pid3].i != null ? merged[pid3].i : -1;
    }
  }
  _eewWarranted = Physics.shindoNum(_predictedMaxShindo) >= Physics.shindoNum('5-');
  if (previouslyWarranted && !_eewWarranted && _detectEEWTriggered) {
    _enqueueSrevSpeech(TTSTextBuilder.buildEEWCancellation(), {id:'eew-cancellation',replace:true,priority:40});
    _detectEEWTriggered = false;
    // Allow a genuinely new event to raise a fresh alert after cancellation.
    for (var ci = 0; ci < _detectTracks.length; ci++) _detectTracks[ci].alerted = false;
  }

  // Initialize observation peaks once; later estimate revisions must not erase
  // already measured prefecture maxima.
  if (!_livePrefectureShindos || !Object.keys(_livePrefectureShindos).length) {
    _livePrefectureShindos = {};
    for (var pid4 in _predictedPrefectureShindos) _livePrefectureShindos[pid4] = 0;
  }

  // Merge the (multi-track) forecast into the live prefecture layer — a full
  // re-init here wiped observed maxima and caused visible flicker once
  // several detection tracks were refreshing forecasts concurrently.
  _applyForecastToLivePrefLayer();

  if (_eewWarranted) {
    // Show forecast in EEW info box (track 0 values via the mirrored globals)
    if (_eewBox) {
      _eewContainer.style.display = 'flex';
      _eewBox.classList.add('eew-forecast');
      _eewBox.classList.remove('eew-observed');
      var predSh = _predictedMaxShindo;
      _eewShVal.textContent = (predSh !== undefined && predSh !== 0) ? predSh : '?';
      _eewShBox.style.background = SHINDO_FILL[predSh] || '#888';
      _eewBulText.textContent = t('eew.forecast');
      _eewBulText.style.color = '#fa0';
      _eewMagText.textContent = 'M' + detectedMag.toFixed(1);
      _eewDepthText.textContent = (detectedEpicenter.depth || _liveDepth) + 'km';
      if (_eewPredText) _eewPredText.textContent = t('eew.pred_shindo') + ': ' + (predSh || '?') + (predSh ? _predShindoRangeSuffix() : '');
    }
  }
}

// ±1σ model-uncertainty suffix for the predicted-max-shindo readouts,
// e.g. " (4~6-)". Empty when no numeric GMPE intensity is tracked.
function _predShindoRangeSuffix() {
  if (typeof Physics === 'undefined' || !Physics.shindoUncertaintyRange) return '';
  if (!(_predictedMaxShindoI > 0)) return '';
  var r = Physics.shindoUncertaintyRange(_predictedMaxShindoI);
  return r ? ' (' + r.lowLabel + '~' + r.highLabel + ')' : '';
}

function startCountdown() {
  if (isRunning || isCountingDown) return;
  if (!epicenter) {
    if (detectMode) {
      statusText.textContent = t('detect.need_epicenter') || 'Please click the map to set an epicenter first (it will be hidden during simulation)';
      statusText.style.color = '#e74c3c';
      setTimeout(function() { statusText.style.color = ''; statusText.textContent = t('status.ready'); }, 3000);
    }
    return;
  }
  isCountingDown = true; btnStart.disabled = true;
  var mag = _liveMag, depth = depthSlider.value;
  // Sync dip/rake from slider
  currentDip = parseFloat(dipSlider.value);
  currentRake = parseFloat(rakeSlider.value);
  // Reset aftershock/cache/Leaflet/events state
  removeFaultLayer();
  // Clean up old aftershock event markers
  for (var aei = 1; aei < activeEvents.length; aei++) {
    if (activeEvents[aei].marker) map.removeLayer(activeEvents[aei].marker);
  }
  activeEvents = [];
  aftershockCatalog = []; activeAftershocks = []; maxAftershockMag = 0;
  damageCache = null; damageCacheSec = -1;
  var atl = document.getElementById('aftershock-timeline');
  if (atl) atl.style.display = 'none';
  // Check for multi-events: preset subEvents > customEvents > single event
  var preset = PRESETS[currentPreset];
  var subEvents = null;
  if (preset && preset.subEvents) subEvents = preset.subEvents;
  else if (customEvents.length > 0) subEvents = customEvents;
  _subEventActivation = []; _subEventActivationIndex = 0;
  _asDetectActivation = []; _asDetectActivationIndex = 0;
  if (subEvents && subEvents.length > 0) {
    // Multi-segment rupture: pass immutable parameters to each calculation.
    var mainMoment = Physics.seismicMoment(eventMw != null ? eventMw : mag);
    var rawSegmentMoment = 0;
    for (var smi = 0; smi < subEvents.length; smi++) rawSegmentMoment += Physics.seismicMoment(subEvents[smi].mag);
    var momentScale = mainMoment / rawSegmentMoment;
    function segmentParams(se) {
      var segmentMw = Physics.momentMagnitude(Physics.seismicMoment(se.mag) * momentScale);
      return {
        lat:se.lat, lng:se.lng, mag:segmentMw, mw:segmentMw, sliderMag:segmentMw,
        depth:se.depth, strike:se.strike != null ? se.strike : parseFloat(strikeSlider.value),
        dip:se.dip != null ? se.dip : currentDip,
        mechanismKnown:se.mechanismKnown != null ? !!se.mechanismKnown : _rakeExplicit,
        sourceType:resolvedSourceType(se.depth, se.src || epicenterSrc, se.lat, se.lng),
        // Chain sub-events may carry their own bundled fault model (e.g. the
        // Hayes 2017 Tohoku slip model inside japanSinks) — without it the
        // synthetic source under-produces the near-field Shindo-7 pockets the
        // real events are known for.
        finiteFault:se.faultModel ? _chainFaultModel(se.faultModel) : null,
        inheritObservedMomentTensor:false,inheritObservedFiniteFault:false
      };
    }
    var firstParams = segmentParams(subEvents[0]);
    var firstEvent = Physics.createEventState(firstParams.lat, firstParams.lng, firstParams.mag, firstParams.depth, subEvents[0].time || 0, true);
    firstEvent.strike = firstParams.strike; firstEvent.dip = firstParams.dip; firstEvent.rake = subEvents[0].rake != null ? subEvents[0].rake : currentRake; firstEvent.mechanismKnown=firstParams.mechanismKnown; firstEvent.sourceType = firstParams.sourceType;
    firstEvent.chainEvent = true; // v5.2: displayEvent pool membership (excludes spawned aftershocks)
    firstEvent.sourceModel = buildSourceModel(Object.assign({}, firstParams, {rake:firstEvent.rake,mechanismKnown:firstEvent.mechanismKnown,originTime:firstEvent.originTime}));
    activeEvents.push(firstEvent);
    landPoints = preComputeArrivals(firstParams); activeIndex = 0; visibleCircles = []; _visibleCircleById = Object.create(null);
    // Ring retirement: S-front arrival at the farthest land station + grace.
    var firstMaxS = 0;
    for (var fmi = 0; fmi < landPoints.length; fmi++) if (landPoints[fmi].sArrive > firstMaxS) firstMaxS = landPoints[fmi].sArrive;
    firstEvent.waveRetireAt = firstEvent.originTime + firstMaxS + WAVE_RETIRE_GRACE;
    // Pre-compute additional sub-events
    for (var sei = 1; sei < subEvents.length; sei++) {
      var se = subEvents[sei];
      var seParams = segmentParams(se);
      var seMag = seParams.mag, seDepth = seParams.depth;
      var seArrivals = preComputeArrivals(seParams);
      var seMaxS = 0;
      for (var smi2 = 0; smi2 < seArrivals.length; smi2++) if (seArrivals[smi2].sArrive > seMaxS) seMaxS = seArrivals[smi2].sArrive;
      var seMap = {};
      for (var si = 0; si < seArrivals.length; si++) seMap[seArrivals[si].id] = seArrivals[si];
      for (var li = 0; li < landPoints.length; li++) {
        var lp = landPoints[li];
        var sePt = seMap[lp.id];
        if (sePt && sePt.peakPga > 0.2) {
          if (!lp.subEvents) lp.subEvents = [];
          lp.subEvents.push({
            pArrive: se.time + sePt.pArrive,
            sArrive: se.time + sePt.sArrive,
            peakPga: sePt.peakPga, peakPgv:sePt.peakPgv,
            mag: seMag,
            // v5.2: per-contribution distance and event index so charts and
            // waveforms can attribute each contribution to its own sub-event.
            dist: Physics.hypoDist(lp.lat, lp.lng, se.lat, se.lng, seDepth),
            evIdx: sei
          });
          _subEventActivation.push({t: se.time + sePt.pArrive, pt: lp, evIdx: sei, pga: sePt.peakPga});
        }
      }
      var segmentEvent = Physics.createEventState(se.lat, se.lng, seMag, seDepth, se.time, false);
      segmentEvent.strike = seParams.strike; segmentEvent.dip = seParams.dip; segmentEvent.rake = se.rake != null ? se.rake : currentRake; segmentEvent.mechanismKnown=seParams.mechanismKnown; segmentEvent.sourceType = seParams.sourceType;
      segmentEvent.chainEvent = true; // v5.2: displayEvent pool membership
      segmentEvent.sourceModel = buildSourceModel(Object.assign({}, seParams, {rake:segmentEvent.rake,mechanismKnown:segmentEvent.mechanismKnown,originTime:se.time}));
      segmentEvent.waveRetireAt = se.time + seMaxS + WAVE_RETIRE_GRACE;
      activeEvents.push(segmentEvent);
    }
    // Chain scenarios shake stations long after the first event's waves have
    // decayed (and circles culled). Keep a P-arrival-sorted reactivation
    // schedule so activateCircles() can bring each station back when the next
    // sub-event actually reaches it.
    _subEventActivation.sort(function(a,b){return a.t-b.t;});
  } else {
    // Standard single-event
    var mainState = Physics.createEventState(epicenter.lat, epicenter.lng, eventMw != null ? eventMw : mag, depth, 0, true);
    mainState.strike = parseFloat(strikeSlider.value); mainState.dip = currentDip; mainState.rake = currentRake; mainState.mechanismKnown=_rakeExplicit; mainState.momentTensor=_observedMomentTensor; mainState.sourceType = activeSrcType();
    mainState.sourceModel = buildSourceModel({mechanismKnown:mainState.mechanismKnown,originTime:0});
    activeEvents.push(mainState);
    landPoints = preComputeArrivals(); activeIndex = 0; visibleCircles = []; _visibleCircleById = Object.create(null);
    var mainMaxS = 0;
    for (var mmi = 0; mmi < landPoints.length; mmi++) if (landPoints[mmi].sArrive > mainMaxS) mainMaxS = landPoints[mmi].sArrive;
    mainState.waveRetireAt = mainMaxS + WAVE_RETIRE_GRACE;
  }
  // Generate aftershock catalog if enabled
  if (aftershockEnabled) {
    var aftershockSource=mainEvent()&&mainEvent().sourceModel;
    var mwForAS = aftershockSource ? aftershockSource.mw : (eventMw != null ? eventMw : _liveMag);
    var _asAutoEl = document.getElementById('aftershock-auto');
    aftershockCatalog = (!_asAutoEl || _asAutoEl.checked) ? generateAftershockCatalog(mwForAS, epicenter.lat, epicenter.lng,
      parseFloat(strikeSlider.value), currentDip, _liveDepth, activeSrcType()) : [];
    // v5.5: merge user-defined manual aftershocks (time = sim seconds after
    // start, placed at the mainshock epicenter), then sync the module state so
    // timeline ticks, map markers, event spawns and detect-mode all see them.
    aftershockCatalog = Physics.mergeManualAftershocks(aftershockCatalog, manualAftershocks, epicenter.lat, epicenter.lng, Aftershock.getTimeScale());
    maxAftershockMag = 0;
    for (var _ami = 0; _ami < aftershockCatalog.length; _ami++) if (aftershockCatalog[_ami].mag > maxAftershockMag) maxAftershockMag = aftershockCatalog[_ami].mag;
    Aftershock.setCatalog(aftershockCatalog);
    Aftershock.setMaxMag(maxAftershockMag);
    preComputeAftershockArrivals();
    // v5.5: large aftershocks (the ones that spawn visible events) get their
    // own EEW detection tracks in detect mode — a real network re-detects and
    // re-broadcasts each significant aftershock.
    if (detectMode) {
      var _asThr = Number(cfgGet('asyEventThr')) || 5.5;
      for (var _li = 0; _li < landPoints.length; _li++) {
        var _lp2 = landPoints[_li];
        if (!_lp2.aftershocks) continue;
        for (var _ai2 = 0; _ai2 < _lp2.aftershocks.length; _ai2++) {
          var _asc = _lp2.aftershocks[_ai2];
          if (aftershockCatalog[_asc.idx] && aftershockCatalog[_asc.idx].mag >= _asThr) {
            _asDetectActivation.push({t: _asc.pArrive, pt: _lp2, asIdx: _asc.idx, pga: _asc.peakPga});
          }
        }
      }
      _asDetectActivation.sort(function(a, b) { return a.t - b.t; });
    }
  } else {
    aftershockCatalog = [];
  }
  activeAftershocks = [];
  _preparePgaCue();
  activeGridCells = {}; activeShindoSounds = {}; peakShindoByName = {};
  _reportActive = false; _reportTriggered = false; _reportStartSimTime = 0; _reportLastDismissTime = 0;
  _reportEventIdx = 0; _reportRearmAt = 0; _chainFcAt = 0; _chainFcEv = null;
  _globalMaxShindo = 0; _globalMaxCountdown = 0; _maxAnnouncedShindo = -1; _reportPrefectureShindos = {};
  _surveyState = 'idle'; _surveySnapshot = null;
  _dismissShindoReport();
  if (typeof TsunamiSolverHost !== 'undefined') TsunamiSolverHost.resetAll();
  tsunamiCircles = []; tsunamiRadius = 0; _tsuSoundPlayed = {}; _tsuWarnIssued = false; _tsuWarnFrame = 0; _tsuLastUpdateMs = -Infinity; _tsuSegCache = []; _tsuSegDirty = true; _tsuWarningRenderSignature = ''; tsunamiActual = []; _tsuActualArrivalTimes = {}; _tsuAreaPhysicalPeaks = {}; _tsuTravelFields = {}; _tsuWaveSolvers = {}; _tsuEtaCache = Object.create(null); _tsuResearchSnapshot = null; _tsuResearchSnapshotKey = '';
  clearTsunamiZoneSelection(false);
  detectedEpicenter = null; detectedMag = 0; detectStationCount = 0;
  detectUncertainty = 200; tsunamiAlerted = false; detectFirstTime = 0;
  detectedT0 = 0; detectedPRadius = 0; detectedSRadius = 0; _detectTracks = [];
  detectBulletin = 0; detectFinal = false; detectLockedEpicenter = null; _detectLastCheckedBulletin = 0; _detectLastCheckedMag = 0; _detectLastCheckedTime = 0;
  detectStableSince = 0; detectLastEpicenter = null;
  detectHistory = []; detectLastBulletinTime = 0; detectLastBulletinStations = 0;
  detectBestEpicenter = null; detectBestUncertainty = Infinity;
  detectConverged = false; _detectQuality = '?';
  simElapsed = 0; pRadius = 0; sRadius = 0; pTravel = 0; sTravel = 0;
  // Hide replay UI
  _replayData = []; _replayMode = false;
  var btnReplay2 = document.getElementById('btn-replay');
  if (btnReplay2) btnReplay2.style.display = 'none';
  var replayBar2 = document.getElementById('replay-bar');
  if (replayBar2) replayBar2.style.display = 'none';
  // --- Set up final bulletin state ---
  _finalBulletinTriggered = false; _finalBulletinActive = false; _quietSince = 0;
  _stopBulletinTTS();
  _stopEEWTTS();
  _cancelSrevSpeech();
  _srevLastEstimateBulletin = 0; _srevLastEstimatedShindo = null;
  _srevTsunamiSignature = '';
  _srevTsunamiIssuedLevels = Object.create(null);
  _srevObservedTsunamiAreas = Object.create(null);
  _tsuEventAlertRank = Object.create(null);
  _bulletinMag = eventMw || _liveMag;
  _bulletinDepth = _liveDepth;
  _bulletinTsunamiLevel = 0;
  // Resolve bulletin time: preset uses occurrence time, custom uses current system time
  var preset = PRESETS[currentPreset];
  if (preset && preset.time) {
    _bulletinTime = new Date(preset.time.replace(/\//g, '-') + '+09:00');
  } else {
    _bulletinTime = new Date();
  }
  preloadAudio();
  // --- JQuake-style GMPE forecast ---
  // Non-detect mode: predict from KNOWN epicenter (user set it)
  // Detect mode: defer to station detections — do NOT use known epicenter
  if (!detectMode) {
    _predictedPrefectureShindos = _predictPrefectureShindos();
    _subareaForecast = _predictSubareaShindos();
    _predictedMaxShindo = 0;
    for (var pid in _predictedPrefectureShindos) {
      var psh = _predictedPrefectureShindos[pid].shindo;
      if (Physics.shindoNum(psh) > Physics.shindoNum(_predictedMaxShindo)) {
        _predictedMaxShindo = psh;
        _predictedMaxShindoI = _predictedPrefectureShindos[pid].i != null ? _predictedPrefectureShindos[pid].i : -1;
      }
    }
    _eewWarranted = Physics.shindoNum(_predictedMaxShindo) >= Physics.shindoNum('5-');
  } else {
    // Detect mode: wait for station P-wave detections → _checkDetectEEW()
    _predictedPrefectureShindos = {};
    _subareaForecast = {};
    _predictedMaxShindo = 0;
    _predictedMaxShindoI = -1;
    _eewWarranted = false;
    _detectEEWTriggered = false;
  }
  // Reset live per-prefecture tracking
  _livePrefectureShindos = {};
  for (var pid2 in _predictedPrefectureShindos) {
    _livePrefectureShindos[pid2] = 0;
  }
  _livePrefColors = {};
  _liveAreaColors = {};
  _liveAreaShindos = {};
  _lastPrefUpdateSec = -1;
  statusText.textContent = t('status.countdown') + ' - M' + mag.toFixed(1) + ' ' + depth + 'km';
  statusDot.classList.add('running'); btnStart.textContent = t('btn.start.running');
  if (_eewWarranted) {
    // Full EEW alert: countdown chime, then dynamic Japanese speech or local EN/ZH voice.
    eewAlert.style.display = 'block';
    var eewCount2 = _rtSkipCountdown ? 1 : 3; _rtSkipCountdown = false;
    eewCountdown.textContent = eewCount2;
    // Show forecast in EEW info box during countdown
    if (_eewBox) {
      _eewContainer.style.display = 'flex';
      _eewBox.classList.add('eew-forecast');
      _eewBox.classList.remove('eew-observed');
      var predSh = _predictedMaxShindo;
      _eewShVal.textContent = (predSh !== undefined && predSh !== 0) ? predSh : '?';
      _eewShBox.style.background = SHINDO_FILL[predSh] || '#888';
      _eewBulText.textContent = '予測';
      _eewBulText.style.color = '#fa0';
      _eewMagText.textContent = 'M' + _liveMag.toFixed(1);
      _eewDepthText.textContent = _liveDepth + 'km';
      if (_eewPredText) _eewPredText.textContent = t('eew.pred_shindo') + ': ' + (predSh || '?') + (predSh ? _predShindoRangeSuffix() : '');
    }
    playEEWSound('EEW_alert');
    _eewCountdownIv = setInterval(function(){
      eewCount2--;
      if (eewCount2 <= 0) {
        clearInterval(_eewCountdownIv); _eewCountdownIv = null;
        eewAlert.style.display = 'none'; isCountingDown = false;
        // Don't hide EEW info box yet — it transitions to observation phase
        if (soundModeEl.value !== 'jp') playEEWSound('EEW2');
        _scheduleSrevEEWVoice(200); startSimulation();
      }
      else { eewCountdown.textContent = eewCount2; }
    }, 1000);
  } else {
    // No EEW warranted: silent minimal delay, no EEW sounds
    eewAlert.style.display = 'none';
    if (_eewBox) _eewContainer.style.display = 'none';
    var skipTicks = _rtSkipCountdown ? 0 : 1;
    _rtSkipCountdown = false;
    if (skipTicks <= 0) {
      isCountingDown = false; startSimulation();
    } else {
      isCountingDown = true;
      eewCountdown.textContent = '';
      _eewCountdownIv = setInterval(function(){
        clearInterval(_eewCountdownIv); _eewCountdownIv = null;
        isCountingDown = false; startSimulation();
      }, 1000);
    }
  }
}

function startSimulation() {
  if (!epicenter || isRunning) return;
  isRunning = true;
  _globalMaxPga = 0; _globalMaxPgv = 0; _lastResearchSnapshot = null; _researchStationPeaks = Object.create(null);
  _beginResearchExperiment();
  _lastDetectionSolveMs = _lastWaveRenderMs = _lastInfoRenderMs = _lastTableRenderMs = -Infinity;
  _lastChartRenderMs = _lastRuptureRenderMs = _lastMultiWaveRenderMs = _lastAftershockRenderMs = -Infinity;
  var m = _liveMag, d = depthSlider.value;
  if (detectMode && epicenterMarker) { epicenterMarker.setOpacity(0); }
  // Init waveform: find nearest station
  wfStation = null; wfSamples = []; wfScrollOffset = 0; wfMaxSample = 0;
  _wfEventIdx = 0; _wfSignals = null;
  _wfAftershockSignals = []; _wfAftershockSignalsReady = false;
  wfCanvas = document.getElementById('waveform-canvas');
  if (wfCanvas) { wfCanvas.width = 320; wfCanvas.height = 100; wfCtx = wfCanvas.getContext('2d'); }
  // Init intensity curve
  intensitySamples = [];
  intensityCanvas = document.getElementById('intensity-canvas');
  if (intensityCanvas) { intensityCanvas.width = 320; intensityCanvas.height = 80; intensityCtx = intensityCanvas.getContext('2d'); }
  if (rawLandGrid.length > 0 && epicenter) {
    var minD = Infinity;
    for (var i = 0; i < rawLandGrid.length; i++) {
      var nd = hypoDist(rawLandGrid[i].lat, rawLandGrid[i].lng);
      if (nd < minD) { minD = nd; wfStation = rawLandGrid[i]; }
    }
  }
  timelineEl.classList.add('show'); legendEl.classList.add('show'); maxPgaPanel.classList.add('show');
  // Init live prefecture coloring layer (JQuake-style forecast → observation)
  // In detect mode, defer to _checkDetectEEW() after stations detect waves
  if (!detectMode) _initLivePrefLayer();
  // Show auto-focus button, reset state
  _autoFocus = true; _lastAutoFocusTime = -999; _userInteracted = false; _focusEventIdx = 0; _focusMode = 'overview'; _focusEventAt = 0; _focusTrackId = -1; _focusFitKm = 0; _focusLastFitAt = 0;
  // v5.2 presenter mode: swap the sidebar for the SREV-style info bar
  var presenterChk = document.getElementById('presenter-mode');
  if (presenterChk && presenterChk.checked) enterPresenterMode(); else exitPresenterMode();
  var baf = document.getElementById('btn-autofocus'); var afl = document.getElementById('autofocus-label'); if (baf) { baf.style.display='flex'; baf.classList.add('active'); } if (afl) afl.style.display='block';
  // Immediate auto-focus on epicenter (non-detect mode only)
  if (!detectMode && _autoFocus) {
    var initZoom = m >= 8 ? 6 : m >= 7 ? 7 : m >= 6 ? 8 : 9;
    _autoFocusMoving = true;
    // v5.2 chain: frame every sub-event epicenter from the very start
    var chainB0 = _chainFocusBounds(false);
    if (chainB0) {
      map.fitBounds(chainB0, _focusFitOptions());
    } else {
      map.setView([epicenter.lat, epicenter.lng], initZoom, {animate: true, duration: 0.6});
    }
    setTimeout(function() { _autoFocusMoving = false; }, 800);
  }
  // Create Leaflet fault plane layers for all events (only when not in detection mode)
  if (!detectMode) {
    for (var ei = 0; ei < activeEvents.length; ei++) {
      var ev = activeEvents[ei];
      if (ev.mag >= 6.5 || ev.sourceModel&&ev.sourceModel.finiteFault) {
        createFaultLayer(ev.lat, ev.lng, ev.mag,
          ev.strike != null ? ev.strike : parseFloat(strikeSlider.value),
          ev.dip != null ? ev.dip : currentDip, ev.depth, ev.originTime, ev.mag, ev.sourceType,
          ev.sourceModel && ev.sourceModel.geometry);
      }
      // Epicenter marker for non-mainshock events (mainshock uses global epicenterMarker)
      if (!ev.isMainshock) {
        var evIcon = L.divIcon({
          className: 'epicenter-marker',
          html: '<div class="epicenter-icon"><div class="cross-v"></div><div class="cross-h"></div><div class="epicenter-pulse"></div></div>',
          iconSize: [40, 40], iconAnchor: [20, 20]
        });
        ev.marker = L.marker([ev.lat, ev.lng], {icon: evIcon, zIndexOffset: 999}).addTo(map);
        ev.marker.bindTooltip('M' + ev.mag.toFixed(1) + ' ' + ev.depth + 'km', {permanent: true, direction: 'top', offset: [0, -25]}).openTooltip();
      }
    }
  }
  statusText.textContent = t('status.running') + ' - M' + m.toFixed(1) + ' ' + d + 'km';
  btnStart.textContent = t('btn.start.running'); btnStart.disabled = true;
  lastFrameTime = performance.now();
  animationId = requestAnimationFrame(simLoop);
}

function simLoop(timestamp) {
  if (!isRunning) return;
  if (!lastFrameTime) lastFrameTime = timestamp;
  if (isPaused) { lastFrameTime = timestamp; animationId = requestAnimationFrame(simLoop); return; }
  var realDt = (timestamp - lastFrameTime) / 1000; lastFrameTime = timestamp;
  // Cap realDt at 1.0s to prevent frame-rate death spiral:
  // If a frame takes too long, simElapsed jumps, causing more work
  // next frame (waveform samples, active circles), causing a freeze.
  if (realDt > 1.0) realDt = 1.0;
  var speed = parseFloat(simSpeedEl.value);
  simElapsed += realDt * speed;
  // Wave radii for all active events (mainshock + large aftershocks)
  var dp = _liveDepth;
  var tsunamiEnabled = _tsunamiEl && _tsunamiEl.checked;
  for (var ei = 0; ei < activeEvents.length; ei++) {
    var ev = activeEvents[ei];
    var evDp = ev.isMainshock ? dp : ev.depth;
    var evElapsed = simElapsed - ev.originTime;
    if (evElapsed < 0) evElapsed = 0;
    ev.pTravel = evElapsed * PW(evDp);
    ev.sTravel = evElapsed * SW(evDp);
    ev.pRadius = ev.pTravel > evDp ? Math.sqrt(ev.pTravel * ev.pTravel - evDp * evDp) : 0;
    ev.sRadius = ev.sTravel > evDp ? Math.sqrt(ev.sTravel * ev.sTravel - evDp * evDp) : 0;
    // Remember the ring size at retirement so camera fits stop growing with it
    if (ev._retirePRadius == null && _eventWavesRetired(ev)) ev._retirePRadius = ev.pRadius || 0;
    // Tsunami radius per event (ocean epicenters only, depth-dependent speed)
    if (tsunamiEnabled && isOceanPoint(ev.lat, ev.lng)) {
      var evAvgDepth = _waterDepth(ev.lat, ev.lng);
      if (evAvgDepth === null || evAvgDepth < 5) evAvgDepth = 4000; // default deep ocean
      var evTsuSpeed = Math.sqrt(9.8 * evAvgDepth) * 3.6; // km/h
      ev.tsunamiRadius = evElapsed * (evTsuSpeed / 3600);
      ev.tsunamiSpeedKmS = evTsuSpeed / 3600;
    } else {
      ev.tsunamiRadius = 0;
    }
  }
  // Backward-compat globals (from mainshock)
  var mev = mainEvent();
  pTravel = mev ? mev.pTravel : 0; sTravel = mev ? mev.sTravel : 0;
  pRadius = mev ? mev.pRadius : 0; sRadius = mev ? mev.sRadius : 0;
  tsunamiRadius = mev ? (mev.tsunamiRadius || 0) : 0;
  // Auto-focus state machine (v5.2 chain): when a new sub-event fires, cut in
  // and LOCK onto its epicenter; if no new event fires for ~10 s, zoom back
  // out so every fired event fits on screen; repeat. Single-event runs keep
  // the legacy mainshock-circle fit. Detect mode never uses true positions —
  // the camera follows each detection track's bulletin #1 (see
  // _detectSolveTrack) and the overview frames the estimated epicenters.
  var _afPool = _displayEventPool();
  var _afIdx = Physics.activeEventIndex(_afPool, simElapsed);
  var _afChainNew = (!detectMode && _afPool.length > 1 && _afIdx !== _focusEventIdx);
  if (_afChainNew) { _focusEventIdx = _afIdx; _focusMode = 'event'; _focusEventAt = simElapsed; }
  if (_autoFocus && mev) {
    if (_afChainNew) {
      // Cut to the newly-fired sub-event and lock on: frame just its live P
      // front plus a 6-second travel margin (tight at origin, grows below).
      var nev = _afPool[_afIdx];
      _focusTrackId = -1;
      _focusLockRadius(nev.lat, nev.lng,
        (nev.pRadius || 0) + 6 * PW(nev.isMainshock ? _liveDepth : nev.depth));
    } else if (_focusMode === 'event') {
      // While locked, follow the expanding P front (throttled, only on
      // meaningful growth) so the wavefront never leaves the frame.
      if (simElapsed - _focusLastFitAt > 2) {
        var ft = null, fr = 0, fRetired = false;
        if (detectMode) {
          var ftr = (_focusTrackId >= 0 && _focusTrackId < _detectTracks.length) ? _detectTracks[_focusTrackId] : null;
          if (ftr && ftr.epi) {
            ft = ftr.epi;
            fr = (ftr.pR || 0) + 6 * PW(ftr.epi.depth || _liveDepth);
            fRetired = _trackWavesRetired(ftr);
          }
        } else if (_afPool.length > 1 && _afPool[_focusEventIdx]) {
          var fev = _afPool[_focusEventIdx];
          ft = fev;
          fr = (fev.pRadius || 0) + 6 * PW(fev.isMainshock ? _liveDepth : fev.depth);
          fRetired = _eventWavesRetired(fev);
        }
        // A retired event's ring is gone — stop growing the frame around it
        // (the 10 s quiet timer below moves the camera to the overview).
        if (!fRetired && ft && fr > Math.max(_focusFitKm, 30) * 1.15) _focusLockRadius(ft.lat, ft.lng, fr);
      }
      // Quiet for ~10 s → zoom back out to frame every fired/tracked event
      if (simElapsed - _focusEventAt > 10) {
        var quietBounds = detectMode ? _detectFocusBounds() : (_afPool.length > 1 ? _chainFocusBounds(true) : null);
        _focusMode = 'overview';
        if (quietBounds) {
          _autoFocusMoving = true;
          map.fitBounds(quietBounds, _focusFitOptions());
          setTimeout(function() { _autoFocusMoving = false; }, 1000);
          _lastAutoFocusTime = simElapsed;
        }
      }
    } else if (pRadius > 10 && simElapsed - _lastAutoFocusTime > 15) {
      // Periodic refresh: chain overview grows with the P-circles; single
      // events keep the legacy mainshock-circle fit. Detect mode must frame
      // the ESTIMATED epicenters — true ones would leak the answer.
      var chainBF = (!detectMode && _afPool.length > 1 && _focusMode === 'overview') ? _chainFocusBounds(true) : null;
      var detBF = (detectMode && _focusMode === 'overview') ? _detectFocusBounds() : null;
      _autoFocusMoving = true;
      if (chainBF) {
        map.fitBounds(chainBF, _focusFitOptions());
      } else if (detBF) {
        map.fitBounds(detBF, _focusFitOptions());
      } else {
        var focLat = (detectMode && detectedEpicenter) ? detectedEpicenter.lat : mev.lat;
        var focLng = (detectMode && detectedEpicenter) ? detectedEpicenter.lng : mev.lng;
        // Once the mainshock ring retires, stop letting the fit grow with it.
        var fitPR = (mev._retirePRadius != null) ? Math.min(pRadius, mev._retirePRadius) : pRadius;
        var rDeg = fitPR / 111.32;
        var pad = rDeg * 0.4;
        if (pad < 0.5) pad = 0.5;
        map.fitBounds([
          [focLat - rDeg - pad, focLng - rDeg - pad],
          [focLat + rDeg + pad, focLng + rDeg + pad]
        ], {animate: true, duration: 0.8});
      }
      setTimeout(function() { _autoFocusMoving = false; }, 1000);
      _lastAutoFocusTime = simElapsed;
    }
  }
  // Tsunami warnings (uses main event's tsunami state for backward compat)
  var tsunamiEnabled2 = _tsunamiEl && _tsunamiEl.checked;
  if (tsunamiEnabled2) {
    activateTsunamiWarnings();
  } else { tsunamiRadius = 0; }
  activateCircles();

  var mag = _liveMag, holdTime = mag * 2.5;
  var ts = tauShort(mag), tm = Physics.tauMid(mag), tl = Physics.tauLong(mag);
  var curSec = Math.floor(simElapsed), curMaxPga = 0, curMaxSh = 0;
  // Keep the event-maximum intensity in each map cell. Rebuilding this object
  // every frame made threshold-adjacent cells disappear and reappear as the
  // one-second station jitter changed their current intensity.

  function patchEnvelope(parts, now) {
    if (!parts || !parts.length) return 1;
    var active2 = 0, total2 = 0;
    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi], a = part.amp || 0;
      total2 += a * a;
      if (now < part.pArrive) continue;
      var frac;
      if(now<part.sArrive)frac=0.05+0.10*(now-part.pArrive)/Math.max(part.sArrive-part.pArrive,0.1);
      else if(now<(part.endArrive||part.sArrive)){
        var sourceRise=Math.max(0,Math.min(1,(now-part.sArrive)/Math.max(part.riseTime||1,0.01)));
        frac=0.15+0.85*Physics.rupturePatchFraction({ruptureTime:0,riseTime:1,
          sourceTimeFunction:part.sourceTimeFunction||'half-cosine'},sourceRise);
      }else frac=1;
      active2 += a * a * Math.max(0, Math.min(1, frac));
    }
    return total2 > 0 ? Math.sqrt(active2 / total2) : 1;
  }

  for (var i = visibleCircles.length - 1; i >= 0; i--) {
    var c = visibleCircles[i];
    var finishS = c.latestPatchS || c.sArrive;
    if (c.patchPga && c.patchPga.length) {
      c.pga = c.peakPga * patchEnvelope(c.patchPga, simElapsed);
      c.pgv = c.peakPgv * patchEnvelope(c.patchPgv, simElapsed);
      c.decayed = false;
      if (simElapsed < c.sArrive) { // P-phase ceiling (~I4.5) — see Physics.wavePhaseEnvelope
        if (c.pga > Physics.P_PHASE_MAX_PGA) c.pga = Physics.P_PHASE_MAX_PGA;
        if (c.pgv > Physics.P_PHASE_MAX_PGV) c.pgv = Physics.P_PHASE_MAX_PGV;
      }
      if (simElapsed > finishS + holdTime) {
        c.decayed = true;
        var patchDecay = Math.exp(-(simElapsed - finishS - holdTime) / ts);
        c.pga *= patchDecay; c.pgv *= patchDecay;
      }
    } else {
      var sRamp = Physics.waveSRampDur(mag);
      var env = Physics.wavePhaseEnvelope(simElapsed, c.pArrive, c.sArrive, mag);
      c.pga = c.peakPga * env; c.pgv = c.peakPgv * env; c.decayed = false;
      if (simElapsed < c.sArrive) { // P-phase ceiling (~I4.5)
        if (c.pga > Physics.P_PHASE_MAX_PGA) c.pga = Physics.P_PHASE_MAX_PGA;
        if (c.pgv > Physics.P_PHASE_MAX_PGV) c.pgv = Physics.P_PHASE_MAX_PGV;
      } else if (simElapsed >= c.sArrive + sRamp + holdTime) {
        c.decayed = true; var tD = simElapsed - c.sArrive - sRamp - holdTime;
        var dcy = Math.exp(-tD / ts); c.pga *= dcy; c.pgv *= dcy;
      }
    }
    // Add cached aftershock PGA (computed once per sim-second below, reused every frame)
    if (aftershockEnabled && c._cachedAsPga) c.pga += c._cachedAsPga;
    // Add sub-event PGA (multi-event mode, unconditional — not tied to aftershockEnabled)
    if (c.subEvents && c.subEvents.length > 0) {
      var sePga = 0, sePgv = 0;
      for (var sei = 0; sei < c.subEvents.length; sei++) {
        var se = c.subEvents[sei];
        if (simElapsed < se.pArrive) continue;
        var seElapsed = simElapsed - se.pArrive;
        var seHold = se.mag * cfgGet('holdCoef');
        var sePtoS = se.sArrive - se.pArrive;
        var seSRamp = Physics.waveSRampDur(se.mag);
        var seP, seV;
        if (seElapsed < sePtoS + seSRamp + seHold) {
          var seEnv = Physics.wavePhaseEnvelope(simElapsed, se.pArrive, se.sArrive, se.mag);
          seP = se.peakPga * seEnv; seV = (se.peakPgv || 0) * seEnv;
          if (simElapsed < se.sArrive) { // P-phase ceiling (~I4.5)
            if (seP > Physics.P_PHASE_MAX_PGA) seP = Physics.P_PHASE_MAX_PGA;
            if (seV > Physics.P_PHASE_MAX_PGV) seV = Physics.P_PHASE_MAX_PGV;
          }
        } else {
          var seDecay = Math.exp(-(seElapsed - sePtoS - seSRamp - seHold) / tauShort(se.mag));
          seP = se.peakPga * seDecay; seV = (se.peakPgv || 0) * seDecay;
        }
        sePga += seP; sePgv += seV;
      }
      c.pga += sePga; c.pgv += sePgv;
    }
    // Per-second: aftershock recompute + jitter + display snapshot + shindo recalc
    if (!c.lastJitterSec) c.lastJitterSec = curSec - 1;
    if (curSec > c.lastJitterSec) {
      // --- Aftershock contributions (expensive: O(aftershocks) per circle, once/sec) ---
      // Skip stations too far to feel any shaking (peakPga < 0.5 gal ≈ shindo 0);
      // v5.5: but a strong aftershock nearby must count even when the
      // mainshock peak at this station is below the threshold.
      if (aftershockEnabled && c.aftershocks && c.aftershocks.length > 0 && (c.peakPga > 0.5 || (c.aftershockPeakPga || 0) > 0.5)) {
        var asPgaSec = 0;
        for (var ai = 0; ai < c.aftershocks.length; ai++) {
          var asc = c.aftershocks[ai];
          if (simElapsed < asc.pArrive) break;
          var asElapsed2 = simElapsed - asc.pArrive;
          var asHold2 = aftershockCatalog[asc.idx].mag * 2.5;
          var asPtoS2 = asc.sArrive - asc.pArrive;
          var asSRamp2 = Physics.waveSRampDur(aftershockCatalog[asc.idx].mag);
          if (asElapsed2 < asPtoS2 + asSRamp2 + asHold2) {
            var asEnv2 = Physics.wavePhaseEnvelope(simElapsed, asc.pArrive, asc.sArrive, aftershockCatalog[asc.idx].mag);
            var asP2 = asc.peakPga * asEnv2;
            if (simElapsed < asc.sArrive && asP2 > Physics.P_PHASE_MAX_PGA) asP2 = Physics.P_PHASE_MAX_PGA;
            asPgaSec += asP2;
          } else {
            asPgaSec += asc.peakPga * Math.exp(-(asElapsed2 - asPtoS2 - asSRamp2 - asHold2) / ts);
          }
        }
        c._cachedAsPga = asPgaSec;
      }
      var jitterId = c.id != null ? c.id : (c.name || (c.lat + ',' + c.lng));
      var jitterRandom = Research.randomAt(cfgGet('randomSeed'), 'station-jitter:' + jitterId, curSec);
      c.jitterOffset += (jitterRandom - 0.5) * 2 * 0.08 * c.peakPga; c.jitterOffset *= 0.5;
      var mj = 0.12 * c.peakPga; c.jitterOffset = Math.max(-mj, Math.min(mj, c.jitterOffset)); c.lastJitterSec = curSec;
      c.displayPga = Math.max(0, c.pga + c.jitterOffset);
      var ci = calcJmaIntensity(c.displayPga, c.pgv); c.shindo = Physics.intensityToShindo(ci); c.intensity = ci;
    }
    // Max/grid/removal use last snapshot (stable 1Hz display)
    if (c.shindo !== 0 && c.displayPga > curMaxPga) { curMaxPga = c.displayPga; curMaxSh = c.shindo; }
    if (c.displayPga > _globalMaxPga) _globalMaxPga = c.displayPga;
    if ((c.pgv || 0) > _globalMaxPgv) _globalMaxPgv = c.pgv || 0;
    var researchKey = String(c.id != null ? c.id : (c.name || (c.lat + ',' + c.lng)));
    var researchPeak = _researchStationPeaks[researchKey];
    if (!researchPeak) {
      researchPeak = _researchStationPeaks[researchKey] = {id:c.id,name:c.name,lat:c.lat,lng:c.lng,peakPga:0,peakPgv:0,intensity:0,shindo:0,lpgm:0};
    }
    if (c.displayPga > researchPeak.peakPga) researchPeak.peakPga = c.displayPga;
    if ((c.pgv || 0) > researchPeak.peakPgv) researchPeak.peakPgv = c.pgv || 0;
    if ((c.intensity || 0) > researchPeak.intensity) { researchPeak.intensity=c.intensity || 0;researchPeak.shindo=c.shindo; }
    if ((c.lpgm || 0) > researchPeak.lpgm) researchPeak.lpgm=c.lpgm || 0;
    // Track peak Shindo per named city for the validation scorecard (monotonic, survives circle removal)
    if (c.name && c.shindo !== 0) {
      var _pv = peakShindoByName[c.name];
      if (_pv === undefined || Physics.shindoScore(c.shindo) > Physics.shindoScore(_pv)) peakShindoByName[c.name] = c.shindo;
    }
    if (c.shindo !== 0 && c.pga >= 0.8 && c.cellIdx != null) {
      retainGridPeak(activeGridCells, c.cellIdx, c.shindo);
    }
    // Do not cull while an S arrival is still pending: the v5.4 phase envelope
    // keeps P-coda PGA near zero for mid/far points, and once culled a point
    // never re-enters (the activation index has already marched past it), so
    // its S peak would never be computed or recorded. 20 s covers the ramp.
    var _sPending = simElapsed <= (c.sArrive || 0) + 20;
    if (!_sPending && c.subEvents) {
      for (var _si = 0; _si < c.subEvents.length; _si++) {
        if (simElapsed <= c.subEvents[_si].sArrive + 20) { _sPending = true; break; }
      }
    }
    // Aftershock arrivals are sorted by pArrive; the last entry is the latest
    // one. A circle culled before it would never receive that contribution.
    if (!_sPending && aftershockEnabled && c.aftershocks && c.aftershocks.length) {
      var _lastAs = c.aftershocks[c.aftershocks.length - 1];
      if (simElapsed <= _lastAs.sArrive + 60) _sPending = true;
    }
    if (c.pga < 0.3 && !_sPending) {
      c._inCircles = false;
      if (c.id != null) delete _visibleCircleById[String(c.id)];
      visibleCircles.splice(i, 1);
    }
  }

  _maybePlayPgaCue(curMaxPga);

  // --- Shindo Report trigger detection ---
  // v5.2 chain: ONE per-frame place that reacts to a new sub-event firing.
  // (The previous home inside updateEEWInfoBox only ran in detect mode,
  // which is why later events never re-forecast and never announced.)
  var _rrd = uiDisplayParams();
  if (_rrd && _rrd.count > 1 && _rrd.idx !== _reportEventIdx) {
    _reportEventIdx = _rrd.idx;
    // Sound cues re-arm (30 s anti-loop guard still applies; an active
    // survey is never interrupted) — works in every mode.
    if (_reportTriggered && !_reportActive) { _reportTriggered = false; _globalMaxShindo = 0; _globalMaxCountdown = 0; }
    _maxAnnouncedShindo = -1;
    _pgaCuePlayed = false;
    _chainFcEv = _rrd;
    // Detect mode: sub-event forecast/voice/survey are owned by the detection
    // tracks (each event is genuinely triangulated with its own bulletins), so
    // the true-parameter re-forecast below only runs outside detect mode.
    _chainFcAt = detectMode ? 0 : simElapsed;
  }
  // Per-sub-event forecast + voice + survey scheduling (non-detect modes).
  if (_chainFcAt && simElapsed >= _chainFcAt && _chainFcEv) {
    var fce = _chainFcEv;
    _chainFcAt = 0; _chainFcEv = null;
    _predictedPrefectureShindos = _predictPrefectureShindosFor(
      fce.lat, fce.lng, fce.mag, fce.depth, fce.strike, fce.dip, fce.srcType, fce.mw, fce.mag);
    _subareaForecast = _subareaCentroids ? _predictPrefectureShindosFor(
      fce.lat, fce.lng, fce.mag, fce.depth, fce.strike, fce.dip, fce.srcType, fce.mw, fce.mag,
      _subareaCentroids) : {};
    _predictedMaxShindo = 0;
    _predictedMaxShindoI = -1;
    for (var fpid in _predictedPrefectureShindos) {
      var fpsh = _predictedPrefectureShindos[fpid].shindo;
      if (Physics.shindoNum(fpsh) > Physics.shindoNum(_predictedMaxShindo)) {
        _predictedMaxShindo = fpsh;
        _predictedMaxShindoI = _predictedPrefectureShindos[fpid].i != null ? _predictedPrefectureShindos[fpid].i : -1;
      }
    }
    // Every chain sub-event gets its own EEW voice announcement
    // (_scheduleSrevEEWVoice cancels the previous event's pending speech,
    // so rapid segments cannot stack up in the FIFO).
    if (Physics.shindoNum(_predictedMaxShindo) >= Physics.shindoNum('5-')) {
      _srevLastEstimateBulletin = 0;
      _scheduleSrevEEWVoice(0);
    }
    // Delayed per-event survey: the decay-based trigger below never fires
    // during a chain (merged shaking keeps rising), so schedule one ~8 s
    // after the forecast — late enough for the waves to develop.
    if (Physics.shindoNum(_predictedMaxShindo) >= Physics.shindoNum('4')) _reportRearmAt = simElapsed + 8;
  }
  if (_reportRearmAt && simElapsed >= _reportRearmAt) {
    _reportRearmAt = 0;
    if (!_reportTriggered && !_reportActive && Physics.shindoNum(curMaxSh) >= 3) _triggerShindoReport();
  }
  if (Physics.shindoScore(curMaxSh) > Physics.shindoScore(_globalMaxShindo)) {
    _globalMaxShindo = curMaxSh;
    _globalMaxCountdown = 0;
  }
  if (!_reportTriggered && Physics.shindoScore(curMaxSh) < Physics.shindoScore(_globalMaxShindo)) {
    _globalMaxCountdown += realDt * speed;
    var _srChk = document.getElementById('shindo-report-enable');
    if (_globalMaxCountdown >= 2.0 && Physics.shindoNum(_globalMaxShindo) >= 3 && (!_srChk || _srChk.checked)) {
      _triggerShindoReport();
    }
  } else if (Physics.shindoScore(curMaxSh) >= Physics.shindoScore(_globalMaxShindo)) {
    _globalMaxCountdown = 0;
  }
  // --- Report dismissal check ---
  if (_reportActive && _surveyState !== 'collecting' && (simElapsed - _reportStartSimTime) >= _reportHoldDuration) {
    _dismissShindoReport();
  }
  // --- Countdown update ---
  if (_reportActive) {
    var cdEl = document.getElementById('shindo-report-countdown');
    if (cdEl) {
      if (_surveyState === 'collecting') cdEl.textContent = t('report.collecting');
      else {
        var remaining = Math.ceil(_reportHoldDuration - (simElapsed - _reportStartSimTime));
        cdEl.textContent = (remaining > 0 ? remaining : 0) + 's';
      }
    }
  }

  var perfMode = !!(_perfEl && _perfEl.checked);
  // Detection mode: progressive epicenter estimation
  if (detectMode) {
    var detectIntervalMs = perfMode ? 500 : 250;
    if (timestamp - _lastDetectionSolveMs >= detectIntervalMs) {
      _lastDetectionSolveMs = timestamp;
      updateDetection();
    } else if (detectedEpicenter && detectedT0 !== 0) {
      var detectedDt = Math.max(0, simElapsed - detectedT0);
      var detectedDepth = detectedEpicenter.depth || _liveDepth;
      var detectedPTravel = detectedDt * PW(detectedDepth);
      var detectedSTravel = detectedDt * SW(detectedDepth);
      // Monotonic display: estimated fronts never retreat between solves.
      var betweenPR = detectedPTravel > detectedDepth ? Math.sqrt(detectedPTravel * detectedPTravel - detectedDepth * detectedDepth) : 0;
      var betweenSR = detectedSTravel > detectedDepth ? Math.sqrt(detectedSTravel * detectedSTravel - detectedDepth * detectedDepth) : 0;
      if (betweenPR > detectedPRadius) detectedPRadius = betweenPR;
      if (betweenSR > detectedSRadius) detectedSRadius = betweenSR;
    }
    _checkDetectEEW();
  }
  // Waveform generation (always try if canvas exists)
  var waveIntervalMs = perfMode ? 100 : 50;
  if (wfCanvas && timestamp - _lastWaveRenderMs >= waveIntervalMs) {
    _lastWaveRenderMs = timestamp;
    updateWaveform();
  }
  drawFrame(); updateMaxPgaPanel(curMaxPga, curMaxSh);
  // Performance mode: lower the cadence of DOM and secondary canvas updates.
  var curSec2 = Math.floor(simElapsed);
  try {
    var infoIntervalMs = perfMode ? 1000 : 250;
    if (timestamp - _lastInfoRenderMs >= infoIntervalMs) {
      _lastInfoRenderMs = timestamp;
      updateInfoPanel(curMaxPga, curMaxSh);
      updatePresenterPanel();
    }
  } catch(e) { /* rendering error must not crash simLoop */ }
  // Live prefecture coloring: update once per simulated second
  if (curSec2 !== _lastPrefUpdateSec && _livePrefLayer) {
    _updateLivePrefLayer(); _lastPrefUpdateSec = curSec2;
  }
  var tableIntervalMs = perfMode ? 1000 : 500;
  if (timestamp - _lastTableRenderMs >= tableIntervalMs) {
    _lastTableRenderMs = timestamp;
    updateIntensityTable();
    updatePrefForecastTable();
  }
  var chartIntervalMs = perfMode ? 1000 : 500;
  var chartDue = timestamp - _lastChartRenderMs >= chartIntervalMs;
  var chartsVisible = chartDue && infoChartsVisible();
  if (chartDue) {
    _lastChartRenderMs = timestamp;
    if (chartsVisible) {
      updateIntensityCurve();
      drawResponseSpectrum();
    }
  }
  var ruptureIntervalMs = perfMode ? 250 : 100;
  if (timestamp - _lastRuptureRenderMs >= ruptureIntervalMs) {
    _lastRuptureRenderMs = timestamp;
    updateRuptureAnimation();
  }
  try {
    if (chartsVisible && (!perfMode || curSec2 !== _chartSec)) {
      drawAttenuationCurve(); drawGMPECompare(); drawSourceSpectrum(); drawTravelTimeCurve(); drawAzimuthDirectivity();
      _chartSec = curSec2;
    }
  } catch(e) { console.warn('Chart render failed:', e); }
  try {
    var multiWaveIntervalMs = perfMode ? 100 : 50;
    if (timestamp - _lastMultiWaveRenderMs >= multiWaveIntervalMs) {
      _lastMultiWaveRenderMs = timestamp;
      updateMultiWaveform();
    }
  } catch(e) { console.warn('Waveform update failed:', e); }
  if (typeof captureReplayFrame === 'function') captureReplayFrame();
  // Aftershock timeline + Leaflet markers + spawn visual events
  if (aftershockEnabled && aftershockCatalog.length > 0) {
    var aftershockIntervalMs = perfMode ? 1000 : 250;
    if (timestamp - _lastAftershockRenderMs >= aftershockIntervalMs) {
      _lastAftershockRenderMs = timestamp;
      updateAftershockTimeline();
      updateAftershockLeafletMarkers();
    }
    spawnAftershockEvents();
  }
  // Prune spawned-aftershock events once their waves have fully passed.
  // Chain events must NOT be pruned: their epicenter markers stay meaningful
  // for the whole run (their rings retire via waveRetireAt instead), and
  // detection tracks index into activeEvents by chain position — splicing a
  // chain event shifts every later track's evIdx onto the wrong event.
  for (var ei = activeEvents.length - 1; ei >= 1; ei--) {
    var pev = activeEvents[ei];
    if (pev.chainEvent) continue;
    // v5.5: a large ocean aftershock keeps propagating its own tsunami long
    // after its seismic waves pass — keep the event alive (warnings, solver
    // advancement, ETA panel) for the same propagation window the mainshock
    // gets; its seismic rings still retire visually via waveRetireAt.
    if (_tsunamiEl && _tsunamiEl.checked && Number(pev.mag) >= TSU_SOLVER_MIN_MAG &&
        isOceanPoint(pev.lat, pev.lng) && simElapsed < (pev.originTime || 0) + 3600) continue;
    if ((pev.waveRetireAt != null && simElapsed > pev.waveRetireAt) || pev.sRadius > 2500) {
      if (pev.marker) map.removeLayer(pev.marker);
      activeEvents.splice(ei, 1);
    }
  }
  var ts2 = simElapsed, m2 = Math.floor(ts2/60), s2 = ts2%60;
  setTextIfChanged(timeDisplay, String(m2).padStart(2,'0') + ':' + s2.toFixed(1).padStart(4,'0'));
  var dp = _liveDepth;
  setTextIfChanged(pRadiusEl, pRadius > 0 ? Math.round(pRadius) : (pTravel > 0 ? '...' : '0'));
  setTextIfChanged(sRadiusEl, sRadius > 0 ? Math.round(sRadius) : (sTravel > 0 ? '...' : '0'));
  var tsuEnabled = isOceanEpicenter && _tsunamiEl && _tsunamiEl.checked;
  var hasTsunami = tsuEnabled && tsunamiCircles.length > 0;
  // Final bulletin: all ground-motion stations quiet → trigger prefecture map + TTS
  if (!_finalBulletinTriggered && _allStationsQuiet()) {
    _triggerFinalBulletin();
  }
  // Non-tsunami: terminate after waves pass ~1500km — trigger bulletin first if skipped
  if (!tsuEnabled && pTravel > 1500 && sTravel > 1500 && simElapsed > 1500/SW() + 30 && _subEventActivationIndex >= _subEventActivation.length) {
    if (!_finalBulletinTriggered) _triggerFinalBulletin();
    endSimulation(); return;
  }
  // Tsunami: run longer — wait for waves to reach all coasts (min 600s, max 3600s)
  // v5.5: a late large ocean aftershock gets its own 3600 s propagation window
  // (capped at 7200 s total) instead of being cut off by the mainshock's gate.
  if (hasTsunami && simElapsed > _tsunamiSimEndTime() && visibleCircles.length < 10) {
    if (!_finalBulletinTriggered) _triggerFinalBulletin();
    endSimulation(); return;
  }
  if (tsuEnabled && !hasTsunami && simElapsed > 1800) {
    if (!_finalBulletinTriggered) _triggerFinalBulletin();
    endSimulation(); return;
  }
  animationId = requestAnimationFrame(simLoop);
}

// v5.5: effective tsunami-phase end time — the mainshock's 3600 s window
// extended for each late large ocean event (e.g. a manual aftershock), so its
// tsunami finishes propagating before the sim ends (hard cap 7200 s).
function _tsunamiSimEndTime() {
  var end = 3600;
  for (var ei = 0; ei < activeEvents.length; ei++) {
    var ev = activeEvents[ei];
    if (ev.isMainshock) continue;
    if (Number(ev.mag) >= TSU_SOLVER_MIN_MAG && isOceanPoint(ev.lat, ev.lng)) {
      end = Math.max(end, (ev.originTime || 0) + 3600);
    }
  }
  return Math.min(end, 7200);
}

function activateCircles() {
  // Only activate points whose P-wave has actually arrived (time-based, not batch-based)
  while (activeIndex < landPoints.length && landPoints[activeIndex].pArrive <= simElapsed) {
    var pt = landPoints[activeIndex];
    pt.active = true;
    if (!pt._inCircles) {
      pt._inCircles = true;
      visibleCircles.push(pt);
      if (pt.id != null) _visibleCircleById[String(pt.id)] = pt;
    }
    if (detectMode) _detectArrival(pt, pt.pArrive, 0, pt.peakPga);
    activeIndex++;
  }
  // Multi-event chains: a later sub-event's P can arrive at a station whose
  // circle already decayed and was culled (or that the first event has not
  // reached yet). Reactivate it from the precomputed schedule, otherwise only
  // the first event ever affects stations.
  while (_subEventActivationIndex < _subEventActivation.length && _subEventActivation[_subEventActivationIndex].t <= simElapsed) {
    var ra = _subEventActivation[_subEventActivationIndex++];
    var rp = ra.pt;
    if (!rp._inCircles) {
      rp._inCircles = true; rp.active = true;
      visibleCircles.push(rp);
      if (rp.id != null) _visibleCircleById[String(rp.id)] = rp;
    }
    if (detectMode) _detectArrival(rp, ra.t, ra.evIdx, ra.pga);
  }
  // v5.5: aftershock detection tracks — same machinery as chain sub-events.
  while (_asDetectActivationIndex < _asDetectActivation.length && _asDetectActivation[_asDetectActivationIndex].t <= simElapsed) {
    var _ad = _asDetectActivation[_asDetectActivationIndex++];
    if (detectMode) _detectArrival(_ad.pt, _ad.t, AS_TRACK_BASE + _ad.asIdx, _ad.pga);
  }
  // Cap total circles (keep highest shindo). The full sort is O(n log n); only
  // enforce the cap ~once per second instead of every frame while stations are
  // still activating beyond the cap. Briefly exceeding the cap by a few hundred
  // for <1s is harmless and avoids per-frame sorting.
  if (visibleCircles.length > TOTAL_STATIONS) {
    _capCheckCounter = (_capCheckCounter || 0) + 1;
    if (_capCheckCounter >= 60) {  // ~1×/s at 60fps
      _capCheckCounter = 0;
      visibleCircles.sort(function(a,b){return Physics.shindoNum(b.shindo)-Physics.shindoNum(a.shindo);});
      for (var ci = TOTAL_STATIONS; ci < visibleCircles.length; ci++) visibleCircles[ci]._inCircles = false;
      visibleCircles.splice(TOTAL_STATIONS);
      _visibleCircleById = Object.create(null);
      for (var vi = 0; vi < visibleCircles.length; vi++) {
        if (visibleCircles[vi].id != null) _visibleCircleById[String(visibleCircles[vi].id)] = visibleCircles[vi];
      }
    }
  }
}
var _capCheckCounter = 0;
var _subEventActivation = [], _subEventActivationIndex = 0;
var _asDetectActivation = [], _asDetectActivationIndex = 0;
var AS_TRACK_BASE = 10000; // detect-track evIdx offset for aftershock tracks (chain positions stay 0..n)

// Detect aftershocks in detection mode: synthetic noisy P-arrival times at stations,
// then grid-search triangulate each qualifying aftershock
// [detectAftershocks] moved to aftershock.js (alias override active)

function updateDetection() {
  if (!epicenter) return;
  if (!_detectTracks.length) { detectStationCount = 0; return; }
  // Solve every active detection track independently (multi-event EEW).
  for (var ti = 0; ti < _detectTracks.length; ti++) _detectSolveTrack(_detectTracks[ti]);
  // Mirror track 0 into the legacy globals — renderer, EEW box, diag panel,
  // info panel and the tsunami/aftershock logic below all read them.
  var tr0 = _detectTracks[0];
  detectStationCount = tr0.stns.length;
  detectFirstTime = tr0.firstTime;
  detectedEpicenter = tr0.epi; detectedMag = tr0.mag; detectedT0 = tr0.t0;
  detectUncertainty = tr0.unc; detectedPRadius = tr0.pR; detectedSRadius = tr0.sR;
  detectBulletin = tr0.bulletin; detectFinal = tr0.final; detectConverged = tr0.converged;
  detectBestEpicenter = tr0.bestEpi; detectBestUncertainty = tr0.bestUnc;
  detectLockedEpicenter = tr0.lockedEpi; _detectQuality = tr0.quality;
  detectLastBulletinTime = tr0.lastBulTime; detectLastBulletinStations = tr0.lastBulCount;
  detectHistory = tr0.history;
  if (!detectedEpicenter) return;
  // Tsunami alert: only if original epicenter is ocean AND tsunami checkbox enabled
  // Wait for stable detection: ≥5 bulletins + ≥30s after first detection
  var tsuEnabled = isOceanEpicenter && document.getElementById('tsunami-enable') &&
    document.getElementById('tsunami-enable').checked;
  if (detectedMag >= 6.5 && !tsunamiAlerted && tsuEnabled && _bulletinTsunamiLevel > 0 &&
      detectBulletin >= 5 && simElapsed - detectFirstTime > 30) {
    tsunamiAlerted = true;
    // Respect the per-event guard: when the 60 s rapid issuance already
    // played this event's alert, don't double it (and vice versa).
    var dtr = _bulletinTsunamiLevel >= 3 ? 3 : _bulletinTsunamiLevel >= 2 ? 2 : 1;
    var dme = mainEvent();
    var dKey = dme ? _tsuEventKey(dme) : '';
    var alreadyPlayed = dKey && (_tsuEventAlertRank[dKey] || 0) >= dtr;
    if (dKey) _tsuEventAlertRank[dKey] = Math.max(_tsuEventAlertRank[dKey] || 0, dtr);
    if (dtr >= 2) _tsuSoundPlayed[dtr >= 3 ? 'Tsunami_3' : 'Tsunami_2'] = true;
    // Use the currently supported tsunami level; do not announce an advisory
    // when neither the rapid estimate nor the physical model supports one.
    if (!alreadyPlayed) {
      if (_bulletinTsunamiLevel >= 3) playEEWSound('Tsunami_3');
      else if (_bulletinTsunamiLevel >= 2) playEEWSound('Tsunami_2');
      else playEEWSound('Tsunami_1');
    }
  }
  // Aftershock detection: run every 2s to avoid thrashing
  if (aftershockEnabled && detectStationCount >= 10 &&
      (!_lastAsDetectTime || simElapsed - _lastAsDetectTime > 2.0)) {
    _lastAsDetectTime = simElapsed;
    detectedAftershocks = detectAftershocks();
  }
  // JQuake-style EEW info box + diagnostic panel
  updateEEWInfoBox();
  _updateEEWDiagPanel();
}

// --- Multi-track detection core -------------------------------------------
// Each sub-event gets its own detection track: arrivals routed by the
// precomputed per-event P schedule (simulating the ideal waveform
// association real EEW systems approximate), an independent grid-search
// hypocenter, magnitude inversion, bulletin sequence and FINAL convergence —
// the behavior SREV/JMA show for concurrent events. Track 0 is the legacy
// single-event path byte-for-byte; later tracks use their own swept depth.
function _detectNewTrack(evIdx, t) {
  var tr = {
    id: _detectTracks.length, evIdx: evIdx, firstTime: t,
    stns: [], stnSet: Object.create(null),
    epi: null, mag: 0, magRaw: 0, t0: 0, unc: 200, pR: 0, sR: 0,
    depthStable: null, depthErr: null,
    bulletin: 0, lastBulTime: 0, lastBulCount: 0,
    history: [], bestUnc: Infinity, bestEpi: null,
    final: false, converged: false, lockedEpi: null, quality: '?',
    fc: null, fcMax: 0, alerted: false, plumMax: 0,
    lastEstBul: 0, lastEstShindo: 0
  };
  _detectTracks.push(tr);
  return tr;
}

function _detectArrival(pt, t, evIdx, pga) {
  var tr = null;
  for (var i = 0; i < _detectTracks.length; i++) {
    if (_detectTracks[i].evIdx === evIdx) { tr = _detectTracks[i]; break; }
  }
  if (!tr) tr = _detectNewTrack(evIdx, t);
  var sid = (pt.id != null) ? String(pt.id) : (pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4));
  if (tr.stnSet[sid]) return;
  var rec = { id: sid, lat: pt.lat, lng: pt.lng, t: t, pt: pt, pga: pga };
  tr.stnSet[sid] = rec;
  tr.stns.push(rec);
}

// Numeric inversion of the FORWARD GMPE (bisection; calcPGA is monotone in
// M). The detect-mode magnitude estimate must invert the same model the
// simulation predicts with — the legacy code inverted the bare log GMPE
// while the forward resolves to Si & Midorikawa, which reads several times
// more PGA at regional distances and inflated every estimate by 1.5-3 M.
function _invertMagFromPga(pga, d, depthKm, src) {
  var lo = 3.0, hi = 10.0;
  for (var it = 0; it < 20; it++) {
    var mid = (lo + hi) / 2;
    var p = Physics.calcPGA(mid, d, cfgGet('gmpModel'), depthKm, null, mid, src,
      cfgGet('attA'), cfgGet('attB'), cfgGet('attC'), cfgGet('anelastic'), 760);
    if (p < pga) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// --- Magnitude-from-PGA inversion core (detect mode) -----------------------
// Extracted from _detectSolveTrack so the FINAL bulletin can re-invert at the
// LOCKED epicenter with the full frozen-peak set (the last live solve runs at
// the pre-lock estimate; JMA likewise recomputes for the final report).
// Returns the pre-bulletin-lift magnitude estimate; callers apply the lift.
function _detectMagInversion(tr, trCount, trDepth, epiLat, epiLng) {
  // Use stations in 30-200km range (sweet spot: close enough for signal, far enough to avoid saturation).
  // Sample EVENLY across all arrivals, not the first N: arrival order is
  // near-to-far, so a prefix is all near-field finite-fault patch peaks and
  // the inversion ran 1-2 M hot for every M6.5+ event.
  var _dbgInv = (typeof _debugMagInv !== 'undefined') && _debugMagInv;
  var _dbgSamples = _dbgInv ? [] : null;
  var _dbgMinD = 0, _dbgMaxD = 0;
  var magVals = [], magValsDone = [], magWeights = [];
  var magStep = Math.max(1, Math.ceil(trCount / 120));
  var minD = 3, maxD = 500;
  if (trCount >= 10) {
    var narrowDone = 0;
    for (var pi = 0; pi < trCount; pi += magStep) {
      var pc = tr.stns[pi];
      var pd = Physics.haversineDist(epiLat, epiLng, pc.lat, pc.lng);
      pd = Math.sqrt(pd * pd + trDepth * trDepth);
      if (pd < 30 || pd > 200) continue;
      if (tr.evIdx === 0 && pc.pga) {
        var pPtoS = Math.max(2, pd * 0.1133);
        if ((simElapsed - pc.t) / pPtoS < 1) continue;
      }
      narrowDone++;
    }
    if (narrowDone >= 8) { minD = 30; maxD = 200; }
  }
  for (var i = 0; i < trCount; i += magStep) {
    var c = tr.stns[i];
    // Track 0 reads LIVE displayPga — which DECAYS after the wave passes, so
    // freeze every station at its peak-so-far (nowcast-limited mid-ramp).
    if (!tr._peakPga) tr._peakPga = Object.create(null);
    var cLive = (tr.evIdx === 0 && c.pt) ? c.pt.displayPga : c.pga;
    if (tr.evIdx === 0 && c.pga > 0 && cLive > c.pga) cLive = c.pga;
    var cPga = Math.max(tr._peakPga[c.id] || 0, cLive || 0);
    var d = Physics.haversineDist(epiLat, epiLng, c.lat, c.lng);
    d = Math.sqrt(d*d + trDepth*trDepth);
    if (d < 1) d = 1;
    var rampDone = true;
    if (tr.evIdx === 0 && c.pga) {
      var estPtoS = Math.max(2, d * 0.1133);
      var rampF = Math.min(1, Math.max(0.15, (simElapsed - c.t) / estPtoS));
      if (c.pga * rampF > cPga) cPga = c.pga * rampF;
      rampDone = rampF >= 1;
    }
    tr._peakPga[c.id] = cPga;
    if (!cPga || cPga < 2) continue;
    var stripAmp = 1;
    if (cfgGet('siteModel') === 'vs30') stripAmp = Physics.vs30Amplification(Physics.lookupVs30(c.lat, c.lng), 'pga');
    cPga /= stripAmp;
    if (trCount > 0) {
      var nearestD = Infinity;
      for (var ni = 0; ni < Math.min(trCount, 10); ni++) {
        var nd = Physics.haversineDist(epiLat, epiLng, tr.stns[ni].lat, tr.stns[ni].lng);
        nd = Math.sqrt(nd*nd + trDepth*trDepth);
        if (nd < nearestD) nearestD = nd;
      }
      if (nearestD > 100) maxD = Math.max(maxD, 400);
    }
    if (d < minD || d > maxD) continue;
    var estM = _invertMagFromPga(cPga, d, trDepth,
      resolvedSourceType(trDepth, null, epiLat, epiLng));
    var estMPre = estM;
    if (estM > MAG_SAT_PIVOT) estM = MAG_SAT_PIVOT + (estM - MAG_SAT_PIVOT) * MAG_SAT_SLOPE;
    if (_dbgSamples) { _dbgMinD = minD; _dbgMaxD = maxD;
      _dbgSamples.push({id: c.id, d: +d.toFixed(1), pga: +cPga.toFixed(3), strip: +stripAmp.toFixed(3),
        mPre: +estMPre.toFixed(3), m: +estM.toFixed(3)}); }
    if (estM > 3 && estM < 12) {
      var w = 1 / Math.sqrt(d);
      magVals.push({m:estM, w:w});
      if (rampDone) magValsDone.push({m:estM, w:w});
      magWeights.push(w);
    }
  }
  var useVals = (magValsDone.length >= 3 && trCount >= 10) ? magValsDone : magVals;
  var _magBranch = 'none', _magMed = null, _magMean = null, _magTop = null, _magLift = false;
  var _invMag = null;
  if (useVals.length >= 5) {
    useVals.sort(function(a,b){return a.m - b.m;});
    var nTrim2 = Math.max(1, Math.floor(useVals.length * 0.1));
    var mid = useVals.slice(nTrim2, useVals.length - nTrim2);
    var medM = mid[Math.floor(mid.length / 2)].m;
    _magBranch = 'median'; _magMed = medM;
    if (_dbgSamples) { var s1 = 0; for (var mv = 0; mv < useVals.length; mv++) s1 += useVals[mv].m;
      _magMean = s1 / useVals.length; }
    var topM = mid[mid.length - 1].m;
    _magTop = topM;
    var medPreLift = medM;
    medM = SimUtils.eewGiantEventLift(medM, topM, useVals.length);
    _magLift = medM > medPreLift;
    _invMag = Math.min(10, medM);
  } else if (useVals.length > 0) {
    var s2 = 0; for (var mk = 0; mk < useVals.length; mk++) s2 += useVals[mk].m;
    _invMag = Math.min(10, s2 / useVals.length);
    _magBranch = 'mean'; _magMean = _invMag;
  } else if (trCount > 0) {
    var fallbackM = 6.0;
    var stationScale = Math.min(1, trCount / 20);
    _invMag = Math.min(9, fallbackM * (0.65 + 0.35 * stationScale));
    _magBranch = 'fallback';
  }
  if (_dbgSamples) tr._dbg = {t: +simElapsed.toFixed(2), branch: _magBranch, nVals: useVals.length, nDone: magValsDone.length,
    med: _magMed, mean: _magMean, top: _magTop, spreadLift: _magLift, minD: _dbgMinD, maxD: _dbgMaxD,
    magRaw: _invMag != null ? +_invMag.toFixed(3) : null, magCor: null, samples: _dbgSamples};
  return {mag: _invMag, branch: _magBranch};
}

function _detectSolveTrack(tr) {
  var trCount = tr.stns.length;
  if (trCount === 0) return;

  // FINAL — lock and stop updating this track's epicenter estimate
  if (tr.final) {
    if (tr.t0 !== 0) {
      var fdt = simElapsed - tr.t0; if (fdt < 0) fdt = 0;
      var fdp = (tr.epi && tr.epi.depth) || (tr.evIdx === 0 ? _liveDepth : (tr.depthStable || _liveDepth));
      var fPT = fdt * PW(fdp), fST = fdt * SW(fdp);
      // Estimated wavefronts never retreat (monotonic display)
      var fPR = fPT > fdp ? Math.sqrt(fPT*fPT - fdp*fdp) : 0;
      var fSR = fST > fdp ? Math.sqrt(fST*fST - fdp*fdp) : 0;
      if (fPR > tr.pR) tr.pR = fPR;
      if (fSR > tr.sR) tr.sR = fSR;
    }
    return;
  }

  // Depth basis for this track: track 0 keeps the legacy mainshock-slider
  // depth (exact single-event parity); later tracks use their own swept depth
  // after debounce (the raw sweep hops between trial depths frame to frame,
  // which made the detected wave rings pulse).
  var trDepth = (tr.evIdx === 0) ? _liveDepth
    : (tr.depthStable != null ? tr.depthStable : ((tr.epi && tr.epi.depth) || _liveDepth));
  var vP = (tr.evIdx === 0) ? PW() : PW(trDepth);
  var vS = (tr.evIdx === 0) ? SW() : SW(trDepth);
  // --- Grid-search triangulation from this track's P-wave arrival times ---
  if (trCount >= 3) {
    var nUse = Math.min(trCount, 50);
    var stns = [];
    for (var i = 0; i < nUse; i++) {
      var c = tr.stns[i];
      stns.push({lat: c.lat, lng: c.lng, t: c.t});
    }
    // Grid search with depth sweep for shallow events
    var bestLat = 36, bestLng = 138, bestDepth = 30, bestErr = Infinity;
    var depthBestErr = {}; // per-trial-depth best RMS this solve (for the EMA below)
    var searchStep = trCount < 10 ? 0.5 : trCount < 20 ? 0.2 : trCount < 50 ? 0.1 : 0.05;
    var searchRange = trCount < 10 ? 8 : trCount < 20 ? 3 : trCount < 50 ? 1.5 : 1.0;
    var centerLat = 0, centerLng = 0;
    for (var i = 0; i < nUse; i++) { centerLat += stns[i].lat; centerLng += stns[i].lng; }
    centerLat /= nUse; centerLng /= nUse;
    // Recursive refinement: once the track is established, search around the
    // previous estimate instead of the station centroid. With 2+ events the
    // centroid keeps migrating as stations join, which made the estimate hop
    // between grid minima.
    if (tr.epi && trCount >= 10) { centerLat = tr.epi.lat; centerLng = tr.epi.lng; }
    // Depth sweep: try multiple depths for better triangulation
    var depthTry = [5, 15, 30, 50, 80, 120];
    for (var di = 0; di < depthTry.length; di++) {
      var tryDepth = depthTry[di];
      for (var dlat = -searchRange; dlat <= searchRange; dlat += searchStep) {
        for (var dlng = -searchRange; dlng <= searchRange; dlng += searchStep) {
          var tLat = centerLat + dlat, tLng = centerLng + dlng;
          var times = [];
          for (var si = 0; si < stns.length; si++) {
            var d = Physics.haversineDist(tLat, tLng, stns[si].lat, stns[si].lng);
            d = Math.sqrt(d*d + tryDepth*tryDepth);
            times.push(stns[si].t - d/vP);
          }
          times.sort(function(a,b){return a-b;});
          var t0 = times[Math.floor(times.length/2)];
          // Weighted RMS: earlier arrivals get higher weight
          var err = 0, wSum = 0;
          for (var si = 0; si < stns.length; si++) {
            var d = Physics.haversineDist(tLat, tLng, stns[si].lat, stns[si].lng);
            d = Math.sqrt(d*d + tryDepth*tryDepth);
            var pred = t0 + d/vP;
            var w = 1.0 / Math.max(si + 1, 1); // weight decreases with arrival order
            err += w * (pred - stns[si].t) * (pred - stns[si].t);
            wSum += w;
          }
          err = Math.sqrt(err / wSum);
          if (err < (depthBestErr[tryDepth] != null ? depthBestErr[tryDepth] : Infinity)) depthBestErr[tryDepth] = err;
          if (err < bestErr) { bestErr = err; bestLat = tLat; bestLng = tLng; bestDepth = tryDepth; }
        }
      }
    }
    // Clamp per-solve movement so competing grid minima cannot make the
    // displayed estimate jump — tighter once bulletins are flowing (early
    // estimates may need big corrections, later ones only refine).
    if (tr.epi && trCount >= 10) {
      var maxStep = tr.bulletin >= 3 ? 0.25 : 0.6;
      var mvLat = bestLat - tr.epi.lat, mvLng = bestLng - tr.epi.lng;
      var mv = Math.sqrt(mvLat * mvLat + mvLng * mvLng);
      if (mv > maxStep) { var mf = maxStep / mv; bestLat = tr.epi.lat + mvLat * mf; bestLng = tr.epi.lng + mvLng * mf; }
    }
    // Depth selection: EMA of each trial depth's best RMS across solves, then
    // argmin. Converges to the depth that consistently fits the arrivals —
    // the old first-solve seeding + flip-flop debounce could lock a shallow
    // crustal event at 120 km, which silently inflated the magnitude
    // inversion (deep hypocenter → inflated slant distances → +1.5 M).
    if (!tr.depthErr) tr.depthErr = {};
    for (var dk in depthBestErr) {
      tr.depthErr[dk] = (tr.depthErr[dk] != null) ? tr.depthErr[dk] * 0.7 + depthBestErr[dk] * 0.3 : depthBestErr[dk];
    }
    // Shallow-source prior: P-arrival-only triangulation trades depth off
    // against origin time, and for one-sided (far-offshore) networks two
    // minima fit almost equally well, so the pick flapped run to run and the
    // magnitude read ±1 M. Most Japanese events are shallow crustal/interface
    // — a deep pick must fit CLEARLY better (err/(1+d/400)) to win.
    var selDepth = bestDepth, selErr = Infinity;
    for (var dk2 in tr.depthErr) {
      var dErrPen = tr.depthErr[dk2] * (1 + (+dk2) / 400);
      if (dErrPen < selErr) { selErr = dErrPen; selDepth = +dk2; }
    }
    tr.depthStable = selDepth;
    tr.epi = {lat: bestLat, lng: bestLng, depth: tr.evIdx === 0 ? bestDepth : tr.depthStable};
    // Uncertainty smoothing: EMA once bulletins start, so the uncertainty
    // circle shrinks steadily instead of jittering with per-solve RMS noise.
    var newUnc = Math.max(3, bestErr * vP * 0.8);
    tr.unc = tr.bulletin >= 1 ? Math.max(3, tr.unc * 0.6 + newUnc * 0.4) : newUnc;

    // Track best estimate by lowest uncertainty (only after reliable triangulation: >=10 stations)
    if (tr.unc < tr.bestUnc && trCount >= 10) {
      tr.bestUnc = tr.unc;
      tr.bestEpi = {lat: bestLat, lng: bestLng, depth: bestDepth};
    }

    // Save origin time for detected wave rings
    var ttimes = [];
    for (var si = 0; si < stns.length; si++) {
      var dd = Physics.haversineDist(bestLat, bestLng, stns[si].lat, stns[si].lng);
      dd = Math.sqrt(dd*dd + trDepth*trDepth);
      ttimes.push(stns[si].t - dd/vP);
    }
    ttimes.sort(function(a,b){return a-b;});
    tr.t0 = ttimes[Math.floor(ttimes.length/2)];
    // Compute detected wave radii — monotonic: an estimated front never
    // retreats even when the t0/epicenter solution revises.
    var dt = simElapsed - tr.t0;
    var dPTravel = dt * vP, dSTravel = dt * vS;
    var newPR = dPTravel > trDepth ? Math.sqrt(dPTravel*dPTravel - trDepth*trDepth) : 0;
    var newSR = dSTravel > trDepth ? Math.sqrt(dSTravel*dSTravel - trDepth*trDepth) : 0;
    if (newPR > tr.pR) tr.pR = newPR;
    if (newSR > tr.sR) tr.sR = newSR;

    // Magnitude from PGA attenuation inversion
    // Use stations in 30-200km range (sweet spot: close enough for signal, far enough to avoid saturation).
    // Sample EVENLY across all arrivals, not the first N: arrival order is
    // near-to-far, so a prefix is all near-field finite-fault patch peaks and
    // the inversion ran 1-2 M hot for every M6.5+ event.
    var _magRes = _detectMagInversion(tr, trCount, trDepth, tr.epi.lat, tr.epi.lng);
    // First-report bias correction (measured: tools/data/eew-mag-bias-report.json):
    // bulletin 1 reads 0.8-1.1 M below the track's own converged estimate (early
    // stations still ramping); lift early bulletins, decaying to zero by #5.
    // tr.bulletin + 1 = the bulletin this solve's estimate will publish under.
    if (_magRes.mag != null) tr.magRaw = _magRes.mag; else tr.magRaw = tr.mag;
    tr.mag = SimUtils.eewMagBulletinCorrection(tr.magRaw, tr.bulletin + 1, trCount);
    if (tr._dbg) { tr._dbg.magRaw = +tr.magRaw.toFixed(3); tr._dbg.magCor = +tr.mag.toFixed(3); }
  }

  // --- Record to history every frame for convergence analysis ---
  if (tr.epi) {
    tr.history.push({
      time: simElapsed,
      lat: tr.epi.lat, lng: tr.epi.lng,
      mag: tr.mag,
      uncertainty: tr.unc,
      stations: trCount
    });
    // Keep last 20 seconds of history
    while (tr.history.length > 0 && simElapsed - tr.history[0].time > 20) {
      tr.history.shift();
    }
  }

  // --- Bulletin issuance: every update = new bulletin ---
  // Trigger: at least 1.5s since last bulletin AND 4 new stations (or first bulletin at 5)
  var BULLETIN_MIN_INTERVAL = 1.5;   // seconds between bulletins
  var BULLETIN_STATION_DELTA = 4;     // new stations needed for next bulletin
  var BULLETIN1_MIN_STATIONS = 5;     // v5.5: was 3 — with 3-4 stations the
  // bulletin-1 raw inversion swung ±0.7 M run-to-run depending on which
  // stations happened to be mid-ramp in the first solve (probe: m50 #1 read
  // 5.1 vs 5.8 on identical scenarios). Five stations stabilise it (~1 s
  // later than before on small events).
  var shouldIssue = false;

  if (tr.epi && tr.bulletin === 0 && trCount >= BULLETIN1_MIN_STATIONS) {
    shouldIssue = true; // 第1報
    // Auto-focus on the newly detected event's estimated epicenter (any
    // track): lock onto its detected P front + 6 s margin; the simLoop state
    // machine follows the growing front and zooms back out after ~10 s quiet.
    if (_autoFocus) {
      _focusMode = 'event'; _focusEventAt = simElapsed; _focusTrackId = tr.id;
      _focusLockRadius(tr.epi.lat, tr.epi.lng, (tr.pR || 0) + 6 * PW(trDepth));
    }
  } else if (tr.epi && tr.bulletin > 0 && !tr.final) {
    var timeSinceLast = simElapsed - tr.lastBulTime;
    // Station delta within this track's own arrival list (chronological).
    var stationsSinceLast = trCount - tr.lastBulCount;
    if (timeSinceLast >= BULLETIN_MIN_INTERVAL && stationsSinceLast >= BULLETIN_STATION_DELTA) {
      shouldIssue = true;
    }
  }

  if (shouldIssue) {
    tr.bulletin++;
    tr.lastBulTime = simElapsed;
    tr.lastBulCount = trCount;
    if (_debugEEW) console.log('EEW' + (tr.id > 0 ? ' [track ' + tr.id + '/ev' + tr.evIdx + ']' : '') + ' 第' + tr.bulletin + '報: M' + tr.mag.toFixed(1) +
      ' ±' + Math.round(tr.unc) + 'km  stations:' + trCount);
  }

  // --- FINAL determination: multi-factor convergence ---
  if (tr.epi && !tr.final && tr.history.length >= 5) {
    var timeSinceFirst = simElapsed - tr.firstTime;
    var MIN_STATIONS = 30;
    var MIN_TIME = 25;          // seconds since first detection
    var CONV_WINDOW = 10;       // look-back window for convergence (seconds)
    var MAX_DRIFT = 4;
    var MAX_UNCERTAINTY = 25;
    var MAX_MAG_DRIFT = 0.3;
    var TIMEOUT = 120;
    var PLATEAU_WINDOW = 8;       // seconds to check for improvement stall
    var PLATEAU_IMPROVEMENT = 0.10; // <10% improvement = stalled
    var PLATEAU_MIN_TIME = 30;
    var MIN_BULLETINS = 4;    // don't check plateau before this many seconds

    // Get history from last CONV_WINDOW seconds
    var recent = [];
    for (var hi = tr.history.length - 1; hi >= 0; hi--) {
      if (simElapsed - tr.history[hi].time <= CONV_WINDOW) {
        recent.push(tr.history[hi]);
      } else break;
    }

    if (recent.length >= 3) {
      // Compute centroid drift (max distance between oldest and newest in window)
      var oldest = recent[recent.length - 1];
      var newest = recent[0];
      var drift = Physics.haversineDist(oldest.lat, oldest.lng, newest.lat, newest.lng);
      var magDrift = Math.abs(newest.mag - oldest.mag);

      // Check if best uncertainty has plateaued (stopped improving)
      // Only after PLATEAU_MIN_TIME to avoid early false positives
      var plateaued = false;
      if (tr.history.length >= 10 && timeSinceFirst >= PLATEAU_MIN_TIME) {
        var oldBest = Infinity, newBest = Infinity;
        for (var hi3 = 0; hi3 < tr.history.length; hi3++) {
          var h = tr.history[hi3];
          if (simElapsed - h.time <= PLATEAU_WINDOW && h.uncertainty < newBest) newBest = h.uncertainty;
          if (simElapsed - h.time > PLATEAU_WINDOW && simElapsed - h.time <= PLATEAU_WINDOW * 2 && h.uncertainty < oldBest) oldBest = h.uncertainty;
        }
        if (oldBest < Infinity && newBest < Infinity) {
          plateaued = (newBest >= oldBest * (1 - PLATEAU_IMPROVEMENT));
        }
      }

      // Check criteria — either full convergence, or plateau + relaxed uncertainty
      var fullConverged = (
        trCount >= MIN_STATIONS &&
        timeSinceFirst >= MIN_TIME &&
        tr.bulletin >= MIN_BULLETINS &&
        drift < MAX_DRIFT &&
        tr.unc < MAX_UNCERTAINTY &&
        magDrift < MAX_MAG_DRIFT
      );
      var plateauConverged = (
        plateaued &&
        trCount >= MIN_STATIONS &&
        tr.bulletin >= MIN_BULLETINS &&
        timeSinceFirst >= MIN_TIME + 5 &&
        tr.unc < MAX_UNCERTAINTY * 1.5  // relaxed to 45 km
      );
      var shouldFinal = fullConverged || plateauConverged || timeSinceFirst > TIMEOUT;

      if (shouldFinal) {
        tr.final = true;
        tr.converged = fullConverged || plateauConverged;
        // Lock to the best estimate seen so far (lowest uncertainty)
        if (tr.bestEpi) {
          tr.lockedEpi = {lat: tr.bestEpi.lat, lng: tr.bestEpi.lng};
          tr.epi = tr.lockedEpi;
        } else {
          tr.lockedEpi = {lat: tr.epi.lat, lng: tr.epi.lng};
        }
        tr.unc = tr.bestUnc;
        tr.bulletin++; // final one
        // Re-invert at the LOCKED position with the full frozen-peak set: the
        // last live solve ran at the pre-lock estimate, and more stations have
        // completed their ramps by FINAL. FINAL carries the uncorrected value:
        // the early-bulletin lift has decayed to zero by #5.
        var _finRes = _detectMagInversion(tr, trCount, trDepth, tr.lockedEpi.lat, tr.lockedEpi.lng);
        if (_finRes.mag != null) tr.magRaw = _finRes.mag;
        if (tr.magRaw != null) tr.mag = tr.magRaw;
        var reason = fullConverged ? 'converged' : (plateauConverged ? 'plateau' : 'timeout');
        // Quality Rating: S/A/B/C/D (stations/uncertainty/drift/mag-drift)
        var qStns = trCount, qUnc = tr.unc, qDrift = drift, qMagD = magDrift;
        if (qStns >= 50 && qUnc < 10 && qDrift < 2 && qMagD < 0.15) tr.quality = 'S';
        else if (qStns >= 30 && qUnc < 15 && qDrift < 3 && qMagD < 0.25) tr.quality = 'A';
        else if (qStns >= 20 && qUnc < 25 && qDrift < 4 && qMagD < 0.35) tr.quality = 'B';
        else if (qStns >= 10 && qUnc < 45 && qDrift < 6) tr.quality = 'C';
        else tr.quality = 'D';
        if (_debugEEW) console.log('EEW' + (tr.id > 0 ? ' [track ' + tr.id + '/ev' + tr.evIdx + ']' : '') + ' FINAL #' + tr.bulletin + ': M' + tr.mag.toFixed(1) +
          ' +-' + Math.round(tr.unc) + 'km  stns:' + trCount +
          ' [' + reason + ']  quality:' + tr.quality);
      }
    }
  }

  // Update detected wave radii every frame (monotonic — fronts never retreat)
  if (tr.epi && tr.t0 !== 0) {
    var dt2 = simElapsed - tr.t0; if (dt2 < 0) dt2 = 0;
    var dpv2 = tr.epi.depth || (tr.evIdx === 0 ? _liveDepth : (tr.depthStable || _liveDepth));
    var dPT2 = dt2 * PW(dpv2), dST2 = dt2 * SW(dpv2);
    var tailPR = dPT2 > dpv2 ? Math.sqrt(dPT2*dPT2 - dpv2*dpv2) : 0;
    var tailSR = dST2 > dpv2 ? Math.sqrt(dST2*dST2 - dpv2*dpv2) : 0;
    if (tailPR > tr.pR) tr.pR = tailPR;
    if (tailSR > tr.sR) tr.sR = tailSR;
  }
}

// SREV-style concurrent-warning list: one compact row per active detection
// track (shown only when 2+ events are being tracked in detect mode).
function _renderDetectTracks() {
  if (!_eewTracks) return;
  if (!detectMode || _detectTracks.length < 2) {
    _eewTracks.style.display = 'none';
    if (_eewTracks.innerHTML) _eewTracks.innerHTML = '';
    return;
  }
  var html = '';
  for (var i = 0; i < _detectTracks.length; i++) {
    var tr = _detectTracks[i];
    if (!tr.epi || tr.bulletin < 1) continue;
    var sh = tr.fcMax || 0;
    var col = SHINDO_FILL[sh] || '#888';
    var bl = tr.final ? ('FINAL #' + tr.bulletin) : ('#' + tr.bulletin);
    html += '<div class="eew-track-row">' +
      '<span class="eew-track-dot" style="background:' + col + '"></span>' +
      '<span class="eew-track-mag">M' + tr.mag.toFixed(1) + '</span>' +
      '<span class="eew-track-bl' + (tr.final ? ' final' : '') + '">' + bl + '</span>' +
      (sh ? '<span class="eew-track-sh">' + sh + '</span>' : '') +
      '</div>';
  }
  _eewTracks.innerHTML = html;
  _eewTracks.style.display = html ? 'flex' : 'none';
}

function updateEEWInfoBox() {
  if (!_eewBox || !_eewShVal || !_eewShBox || !_eewBulText || !_eewMagText || !_eewDepthText || !_eewTimeText) return;
  _renderDetectTracks();

  // Determine whether to show the box
  var inDetectPhase = detectMode && detectedEpicenter;
  var showBox = inDetectPhase || _eewWarranted;
  if (!showBox) { _eewContainer.style.display = 'none'; return; }
  _eewContainer.style.display = 'flex';

  // v5.2 chain: the box follows the display event; the per-event re-forecast
  // and voice announcements live in the simLoop chain tick (all modes).
  var _ed = (typeof uiDisplayParams === 'function') ? uiDisplayParams() : null;

  // --- Compute actual observed max Shindo from live prefecture data ---
  // This matches the map coloring and replaces the old trivial mag→Shindo lookup
  var liveObsMax = 0;
  if (_livePrefectureShindos) {
    for (var pid in _livePrefectureShindos) {
      var s = _livePrefectureShindos[pid];
      if (Physics.shindoNum(s) > Physics.shindoNum(liveObsMax)) liveObsMax = s;
    }
  }

  if (!_detectEEWTriggered && detectMode) {
    var predWarn = _predictedMaxShindo && Physics.shindoNum(_predictedMaxShindo) >= Physics.shindoNum('5-');
    var obsWarn = liveObsMax && Physics.shindoNum(liveObsMax) >= Physics.shindoNum('5-');
    if (predWarn || obsWarn) _triggerDetectEEWAlert();
  }

  if (inDetectPhase) {
    // --- Observation phase: EEW detection + live station data ---
    _eewBox.classList.add('eew-observed');
    _eewBox.classList.remove('eew-forecast');
    // Main Shindo: observed max from stations, fall back to GMPE prediction
    var displaySh = (liveObsMax && Physics.shindoNum(liveObsMax) > 0) ? liveObsMax : _predictedMaxShindo;
    _eewShVal.textContent = (displaySh !== undefined && Physics.shindoNum(displaySh) > 0) ? displaySh : '?';
    _eewShBox.style.background = SHINDO_FILL[displaySh] || '#888';
    _eewBulText.textContent = detectFinal ? ('FINAL #' + detectBulletin + ' [' + _detectQuality + ']') : (detectBulletin > 0 ? '#' + detectBulletin : '');
    _eewBulText.style.color = detectFinal ? '#2ecc71' : '#fa0';
    _eewMagText.textContent = 'M' + detectedMag.toFixed(1);
    _eewDepthText.textContent = (detectedEpicenter.depth || depthSlider.value) + 'km';
    // Show forecast vs observed comparison (both from GMPE/station data, NOT magnitude lookup)
    if (_eewPredText) {
      var pSh = (_predictedMaxShindo && Physics.shindoNum(_predictedMaxShindo) > 0) ? _predictedMaxShindo : null;
      var oSh = (liveObsMax && Physics.shindoNum(liveObsMax) > 0) ? liveObsMax : null;
      if (pSh && oSh && pSh !== oSh) {
        _eewPredText.textContent = t('eew.forecast') + ': ' + pSh + ' / ' + t('eew.observed') + ': ' + oSh;
      } else if (pSh) {
        _eewPredText.textContent = t('eew.pred_shindo') + ': ' + pSh + _predShindoRangeSuffix();
      } else if (oSh) {
        _eewPredText.textContent = t('eew.obs_shindo') + ': ' + oSh;
      } else {
        _eewPredText.textContent = '';
      }
    }
  } else {
    // --- Forecast phase: GMPE prediction (non-detect) or before detection ---
    _eewBox.classList.add('eew-forecast');
    _eewBox.classList.remove('eew-observed');
    // Show observed if available (stations activated), otherwise GMPE prediction
    var hasObs = liveObsMax && Physics.shindoNum(liveObsMax) > 0;
    var predSh = hasObs ? liveObsMax : _predictedMaxShindo;
    _eewShVal.textContent = (predSh !== undefined && Physics.shindoNum(predSh) > 0) ? predSh : '?';
    _eewShBox.style.background = SHINDO_FILL[predSh] || '#888';
    _eewBulText.textContent = hasObs ? t('eew.observed') : t('eew.forecast');
    _eewBulText.style.color = hasObs ? '#fff' : '#fa0';
    // v5.2 chain: show the currently-firing sub-event, not the combined magnitude
    _eewMagText.textContent = 'M' + (_ed ? _ed.mag : _liveMag).toFixed(1);
    _eewDepthText.textContent = (_ed ? _ed.depth : _liveDepth) + 'km';
    if (_eewPredText) {
      _eewPredText.textContent = _predictedMaxShindo ? t('eew.pred_shindo') + ': ' + _predictedMaxShindo + _predShindoRangeSuffix() : '';
    }
  }

  // Time: preset historical or current
  var timeStr;
  if (currentPreset && PRESETS[currentPreset] && PRESETS[currentPreset].time) {
    timeStr = PRESETS[currentPreset].time;
  } else {
    var now = new Date();
    timeStr = now.getFullYear() + '/' +
      String(now.getMonth() + 1).padStart(2, '0') + '/' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
  }
  _eewTimeText.textContent = timeStr;
}

// EEW diagnostic panel — shows detection algorithm internals below the info box
function _updateEEWDiagPanel() {
  if (!_diagPanel) return;
  if (!detectMode || !detectedEpicenter) { _diagPanel.style.display = 'none'; return; }
  _diagPanel.style.display = 'block';
  // Ensure container is visible when diag panel is
  if (_eewContainer) _eewContainer.style.display = 'flex';
  if (_diagEpi) {
    _diagEpi.textContent = detectedEpicenter.lat.toFixed(2) + '°, ' +
      detectedEpicenter.lng.toFixed(2) + '° / ' + (detectedEpicenter.depth || '?') + 'km';
  }
  if (_diagUncert) {
    _diagUncert.textContent = detectUncertainty < 200 ? '±' + Math.round(detectUncertainty) + ' km' : '--';
  }
  if (_diagStations) _diagStations.textContent = detectStationCount;
  if (_diagBestUncert) {
    _diagBestUncert.textContent = detectBestUncertainty < Infinity ? '±' + Math.round(detectBestUncertainty) + ' km' : '--';
  }
  if (_diagQuality) _diagQuality.textContent = detectConverged ? _detectQuality : '...';
}

var _tsuLastUpdateMs = -Infinity;
var _tsuSoundPlayed = {};
var _tsuWarnIssued = false;

function _forecastJmaAreasForEvent(ev) {
  var signature=[cfgGet('tsuCoefA'),cfgGet('tsuCoefB'),cfgGet('tsunamiAlertBias'),
    ev.mag,ev.depth,ev.strike,ev.dip,ev.rake,ev.mechanismKnown].join('|');
  if (ev._jmaRapidAreas && ev._jmaRapidSignature === signature) return ev._jmaRapidAreas;
  var field = _tsuFieldForEvent(ev), eventKey = _tsuEventKey(ev);
  var source = ev.sourceModel || buildSourceModel({lat:ev.lat,lng:ev.lng,mag:ev.mag,mw:ev.mag,
    depth:ev.depth,strike:ev.strike,dip:ev.dip,rake:ev.rake,mechanismKnown:ev.mechanismKnown,sourceType:ev.sourceType,originTime:ev.originTime});
  var sourceDepth = _waterDepth(ev.lat,ev.lng), byArea = Object.create(null);
  var sourceAreaCode=ev._jmaSourceAreaCode||_nearestJmaTsunamiAreaCode(ev.lat,ev.lng);
  ev._jmaSourceAreaCode=sourceAreaCode;
  for (var i = 0; i < _tsuCheckPoints.length; i++) {
    var point = _tsuCheckPoints[i];
    if (!point.areaCode) continue;
    var directDistance = Physics.haversineDist(ev.lat,ev.lng,point.lat,point.lng);
    if (directDistance > 1200) continue;
    var meta = field && field.lookupMeta ? field.lookupMeta(point.lat,point.lng) : null;
    if (field && (!meta || !isFinite(meta.travelTime))) continue;
    // The wet-cell eikonal field already encodes land barriers.  Deriving the
    // direct-path flag from its detour ratio avoids tens of thousands of Turf
    // point-in-polygon calls when all 66 regions are forecast at once.
    var blocked = meta ? meta.detourRatio>1.08 : isPathBlockedByLand(ev.lat,ev.lng,point.lat,point.lng);
    if (!field && blocked) continue;
    var spreadDistance = meta ? Math.max(directDistance,meta.pathDistance) : directDistance;
    var height = Physics.tsunamiWaveContribution(source,Math.max(1,spreadDistance),sourceDepth,
      cfgGet('tsuCoefA'),cfgGet('tsuCoefB'));
    if (meta) height *= Physics.tsunamiPathAttenuation(meta.detourRatio,blocked);
    height *= Physics.jmaTsunamiBasinTransmission(sourceAreaCode,point.areaCode,directDistance);
    // Resolve the final shelf amplification from this area's fixed offshore
    // control depth, never from the source-cell water depth.
    height *= Physics.greenLawAmplification(point.waterDepth,10,5);
    var current = byArea[point.areaCode];
    if (!current || height > current.height) byArea[point.areaCode] = {height:height,point:point};
  }
  var warnings = [];
  for (var code in byArea) {
    var entry = byArea[code];
    // JMA initial bulletins use a conservative scenario envelope. Keep that
    // envelope separate from both the physical height and manual uplift.
    var forecast = Physics.jmaTsunamiForecast(entry.height,cfgGet('tsunamiAlertBias'),1.35);
    if (!forecast.level) continue;
    var p = entry.point;
    warnings.push({lat:p.coastLat,lng:p.coastLng,height:forecast.physicalHeight,
      alertHeight:forecast.alertHeight,announcedHeight:forecast.announcedHeight,
      level:forecast.level,key:code,areaCode:code,areaName:p.areaName,
      provisional:true,status:'forecast',sourceAreaCode:sourceAreaCode,eventKey:eventKey});
  }
  ev._jmaRapidAreas = warnings;
  ev._jmaRapidSignature = signature;
  return warnings;
}

function _tsunamiHeightSpeech(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') return (Math.round(value * 10) / 10) + 'メートル';
  // JMA's ">10m" category must be spoken as "10メートル超" — a bare ">" glyph
  // is dropped by Japanese TTS and would be heard as exactly 10 m.
  var over = /^\s*>/.test(String(value));
  var text = String(value).replace(/^\s*>\s*/, '').replace(/\s*m$/i, 'メートル').replace(/m/gi, 'メートル');
  return over ? text + '超' : text;
}

function _announceSrevTsunamiUpdates(warnings, actuals) {
  if (!_srevSpeechEnabled() || !_tsuForecastAreas.length) return;
  warnings = Array.isArray(warnings) ? warnings : [];
  actuals = Array.isArray(actuals) ? actuals : [];
  var signature = warnings.map(function(item) {
    return item.areaCode + ':' + item.level + ':' + (item.announcedHeight || '');
  }).sort().join('|');
  if (signature && signature !== _srevTsunamiSignature) {
    var byLevel = {major:[],warn:[],adv:[]};
    var heightByLevel = {major:'',warn:'',adv:''};
    for (var i = 0; i < warnings.length; i++) {
      var warning = warnings[i];
      if (!byLevel[warning.level]) continue;
      if (byLevel[warning.level].indexOf(warning.areaName) < 0) byLevel[warning.level].push(warning.areaName);
      if (!heightByLevel[warning.level] && warning.announcedHeight) {
        heightByLevel[warning.level] = _tsunamiHeightSpeech(warning.announcedHeight);
      }
    }
    ['major','warn','adv'].forEach(function(level) {
      if (!byLevel[level].length) return;
      // First issuance is announced as such; later signature changes are updates.
      var isUpdate = !!_srevTsunamiIssuedLevels[level];
      _srevTsunamiIssuedLevels[level] = true;
      // Earliest first-wave ETA across this level's areas (first issuance only).
      var etaMin = null;
      if (!isUpdate) {
        for (var wi = 0; wi < warnings.length; wi++) {
          var ww = warnings[wi];
          if (ww.level !== level || !ww.areaCode) continue;
          for (var wei = 0; wei < activeEvents.length; wei++) {
            var wev = activeEvents[wei];
            if (wev.originTime > simElapsed || !isOceanPoint(wev.lat, wev.lng)) continue;
            var wEta = _tsuAreaEta(wev, ww.areaCode);
            if (wEta == null) continue;
            var remMin = (wEta - simElapsed) / 60;
            if (etaMin === null || remMin < etaMin) etaMin = remMin;
          }
        }
      }
      _enqueueSrevSpeech(TTSTextBuilder.buildTsunamiForecast({
        level:level,areas:byLevel[level],height:heightByLevel[level],updated:isUpdate,etaMin:etaMin
      }), {id:'tsunami-forecast-' + level,replace:true,priority:30});
    });
    _srevTsunamiSignature = signature;
  }

  var newAreas = [], maxObserved = 0;
  for (var ai = 0; ai < actuals.length; ai++) {
    var actual = actuals[ai];
    if (!actual.areaCode || _srevObservedTsunamiAreas[actual.areaCode]) continue;
    _srevObservedTsunamiAreas[actual.areaCode] = true;
    if (actual.areaName && newAreas.indexOf(actual.areaName) < 0) newAreas.push(actual.areaName);
    maxObserved = Math.max(maxObserved, Number(actual.height) || 0);
  }
  if (newAreas.length) {
    _enqueueSrevSpeech(TTSTextBuilder.buildTsunamiObservation({
      areas:newAreas,height:_tsunamiHeightSpeech(maxObserved),updated:true
    }), {id:'tsunami-observation'});
  }
}

// --- First-wave arrival ETA (per forecast area) ----------------------------
// JMA tsunami bulletins lead with 大波の到達予想時刻 — the estimated first-wave
// arrival per area. For each warned area we take the earliest travel time of
// its coastline check points (per ocean event, cached; travel fields are
// static per event) and render a live countdown next to the tsunami layer
// panel. Areas whose wave already arrived sink to the bottom as 到達.
var _tsuEtaCache = Object.create(null); // eventKey|areaCode -> absolute sim time
function _tsuAreaEta(ev, areaCode) {
  var ck = _tsuEventKey(ev) + '|' + areaCode;
  if (_tsuEtaCache[ck] !== undefined) return _tsuEtaCache[ck];
  var field = _tsuFieldForEvent(ev);
  var best = Infinity;
  for (var pi = 0; pi < _tsuCheckPoints.length; pi++) {
    var point = _tsuCheckPoints[pi];
    if (point.areaCode !== areaCode) continue;
    var tt;
    if (field) {
      var meta = field.lookupMeta ? field.lookupMeta(point.lat, point.lng) : null;
      if (!meta || !isFinite(meta.travelTime)) continue;
      tt = meta.travelTime;
    } else {
      tt = Physics.tsunamiTravelTime(ev.lat, ev.lng, point.lat, point.lng, _waterDepth, TSU_SPD(), 20);
    }
    if (tt < best) best = tt;
  }
  var eta = best === Infinity ? null : ev.originTime + best;
  _tsuEtaCache[ck] = eta;
  return eta;
}
function _tsuEtaRows() {
  var rows = [];
  for (var i = 0; i < tsunamiCircles.length; i++) {
    var w = tsunamiCircles[i];
    if (!w.areaCode) continue;
    var bestEta = Infinity;
    for (var ei = 0; ei < activeEvents.length; ei++) {
      var ev = activeEvents[ei];
      if (ev.originTime > simElapsed || !isOceanPoint(ev.lat, ev.lng)) continue;
      var eta = _tsuAreaEta(ev, w.areaCode);
      if (eta != null && eta < bestEta) bestEta = eta;
    }
    if (bestEta === Infinity) continue;
    rows.push({name: w.areaName || w.areaCode, level: w.level, remain: bestEta - simElapsed});
  }
  // Pending arrivals first (soonest first), arrived areas last.
  rows.sort(function(a, b) {
    var pa = a.remain > 0 ? 0 : 1, pb = b.remain > 0 ? 0 : 1;
    return pa - pb || a.remain - b.remain;
  });
  return rows;
}
var _tsuEtaBlock = null, _tsuEtaList = null;
function _updateTsunamiEtaPanel() {
  if (!_tsuEtaBlock) {
    _tsuEtaBlock = document.getElementById('tsunami-eta-block');
    _tsuEtaList = document.getElementById('tsunami-eta-list');
  }
  if (!_tsuEtaBlock || !_tsuEtaList) return;
  var rows = _tsuEtaRows();
  if (!isRunning || !rows.length) { _tsuEtaBlock.hidden = true; return; }
  var html = '';
  for (var r = 0; r < Math.min(rows.length, 6); r++) {
    var row = rows[r];
    var timeText, arrived = row.remain <= 0;
    if (arrived) timeText = t('tsunami.eta.arrived');
    else {
      var s = Math.ceil(row.remain);
      timeText = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }
    html += '<div class="tsunami-eta-row lvl-' + row.level + (arrived ? ' eta-arrived' : '') + '">' +
      '<span class="eta-area"><span class="eta-dot"></span>' + escapeHTML(row.name) + '</span>' +
      '<span class="eta-time">' + timeText + '</span></div>';
  }
  _tsuEtaList.innerHTML = html;
  _tsuEtaBlock.hidden = false;
}

function _activateJmaTsunamiWarnings() {
  var provisional = [], arrivedEventAreas = Object.create(null);
  var physicalByArea = Object.create(null), currentMaxRank = 0;
  for (var ei = 0; ei < activeEvents.length; ei++) {
    var ev = activeEvents[ei];
    if (!isOceanPoint(ev.lat,ev.lng)) continue;
    var elapsed = simElapsed - ev.originTime, eventKey = _tsuEventKey(ev);
    var sourceAreaCode=ev._jmaSourceAreaCode||_nearestJmaTsunamiAreaCode(ev.lat,ev.lng);
    ev._jmaSourceAreaCode=sourceAreaCode;
    if (elapsed >= 60) {
      var rapid = _forecastJmaAreasForEvent(ev);
      for (var rw = 0; rw < rapid.length; rw++) provisional.push(rapid[rw]);
      if (!ev._tsuWarnIssued) {
        ev._tsuWarnIssued = true;
        // Per-event first issuance: a newly warned event re-plays the alert
        // chime even if an earlier event already played that level — real
        // systems append each new event's warnings with a fresh alert.
        var evRank = 0, evKey2 = _tsuEventKey(ev);
        for (var rk = 0; rk < rapid.length; rk++) evRank = Math.max(evRank, Physics.tsunamiWarningRank(rapid[rk].level));
        if (evRank >= 2 && evRank > (_tsuEventAlertRank[evKey2] || 0)) {
          _tsuEventAlertRank[evKey2] = evRank;
          var evSound = evRank >= 3 ? 'Tsunami_3' : 'Tsunami_2';
          _tsuSoundPlayed[evSound] = true; // dedup the escalation gate below
          playEEWSound(evSound);
        }
      }
    }
    var solver = _tsuSolverForEvent(ev), field = _tsuFieldForEvent(ev);
    var source = ev.sourceModel || buildSourceModel({lat:ev.lat,lng:ev.lng,mag:ev.mag,mw:ev.mag,
      depth:ev.depth,strike:ev.strike,dip:ev.dip,rake:ev.rake,mechanismKnown:ev.mechanismKnown,sourceType:ev.sourceType,originTime:ev.originTime});
    if (solver) {
      solver.advanceTo(Math.max(0,elapsed));
      // Prefer the mainshock, but a land mainshock has no solver at all; let
      // the first ocean event with a solver feed the research layers then.
      if (solver.getSnapshot && (ev.isMainshock || !_tsuResearchSnapshot || _tsuResearchSnapshotKey===eventKey)) {
        var stride = map.getZoom() >= 8 ? 1 : (map.getZoom() >= 6 ? 2 : 3);
        _tsuResearchSnapshot = solver.getSnapshot(stride);
        _tsuResearchSnapshotKey = eventKey;
      }
    }
    for (var pi = 0; pi < _tsuCheckPoints.length; pi++) {
      var point = _tsuCheckPoints[pi];
      if (!point.areaCode) continue;
      var meta = field && field.lookupMeta ? field.lookupMeta(point.lat,point.lng) : null;
      if (field && (!meta || !isFinite(meta.travelTime))) continue;
      var blocked = !solver && isPathBlockedByLand(ev.lat,ev.lng,point.lat,point.lng);
      if (!field && blocked) continue;
      var directDistance = Math.max(1,Physics.haversineDist(ev.lat,ev.lng,point.lat,point.lng));
      var arrival = field ? meta.travelTime : Physics.tsunamiTravelTime(ev.lat,ev.lng,
        point.lat,point.lng,_waterDepth,TSU_SPD(),20);
      if (elapsed < arrival) continue;
      arrivedEventAreas[eventKey+'|'+point.areaCode] = true;
      var height = 0;
      if (solver) {
        height = Physics.tsunamiCoastalHeight(solver,point.lat,point.lng,10,5);
      } else {
        var effectiveDistance = meta ? Math.max(directDistance,meta.pathDistance) : directDistance;
        height = Physics.tsunamiWaveContribution(source,effectiveDistance,_waterDepth(ev.lat,ev.lng),
          cfgGet('tsuCoefA'),cfgGet('tsuCoefB'));
        height *= Physics.greenLawAmplification(point.waterDepth,10,5);
        if (meta) height *= Physics.tsunamiPathAttenuation(meta.detourRatio,blocked);
      }
      height *= Physics.jmaTsunamiBasinTransmission(sourceAreaCode,point.areaCode,directDistance);
      var areaValue = physicalByArea[point.areaCode];
      if (!areaValue || Math.abs(height) > areaValue.height) {
        physicalByArea[point.areaCode] = {height:Math.abs(height),point:point};
      }
    }
  }

  var nextCircles = [];
  // A JMA warning is not cancelled merely because the first wave has reached
  // one control point.  Keep the latest source-based forecast active and mark
  // its arrival state; cancellation requires a later source revision or reset.
  for (var pr = 0; pr < provisional.length; pr++) {
    var predicted = Object.assign({},provisional[pr]);
    predicted.provisional=!arrivedEventAreas[predicted.eventKey+'|'+predicted.areaCode];
    predicted.status=predicted.provisional?'forecast':'arrived';
    nextCircles.push(predicted);
  }
  var nextActual = [];
  for (var code in physicalByArea) {
    var actual = physicalByArea[code];
    if(!_tsuAreaPhysicalPeaks[code]||actual.height>_tsuAreaPhysicalPeaks[code].height)
      _tsuAreaPhysicalPeaks[code]=actual;
    actual=_tsuAreaPhysicalPeaks[code];
    var decision = Physics.jmaTsunamiForecast(actual.height,cfgGet('tsunamiAlertBias'),1);
    if (!decision.level) continue;
    var control = actual.point;
    var record = {lat:control.coastLat,lng:control.coastLng,height:decision.physicalHeight,
      alertHeight:decision.alertHeight,announcedHeight:decision.announcedHeight,
      level:decision.level,key:code,areaCode:code,areaName:control.areaName,provisional:false,status:'modeled'};
    nextCircles.push(record);
    if (_tsuActualArrivalTimes[code] == null) _tsuActualArrivalTimes[code] = simElapsed;
    nextActual.push(Object.assign({},record,{key:code+'_act',arriveTime:_tsuActualArrivalTimes[code]}));
  }
  var mergedByArea = Object.create(null);
  for (var mi = 0; mi < nextCircles.length; mi++) {
    var candidate = nextCircles[mi], existing = mergedByArea[candidate.areaCode];
    var candidateRank = Physics.tsunamiWarningRank(candidate.level);
    var existingRank = existing ? Physics.tsunamiWarningRank(existing.level) : 0;
    if (!existing || candidateRank > existingRank ||
        (candidateRank === existingRank && (candidate.alertHeight||candidate.height) > (existing.alertHeight||existing.height))) {
      mergedByArea[candidate.areaCode] = candidate;
    }
  }
  tsunamiCircles = Object.keys(mergedByArea).map(function(areaCode){return mergedByArea[areaCode];});
  tsunamiActual = nextActual;
  var renderSignature=tsunamiCircles.map(function(item){return item.areaCode+':'+item.level;}).sort().join('|');
  if(renderSignature!==_tsuWarningRenderSignature){
    _tsuWarningRenderSignature=renderSignature;
    _tsuSegDirty=true;
  }
  for (var bi = 0; bi < tsunamiCircles.length; bi++) {
    currentMaxRank = Math.max(currentMaxRank,Physics.tsunamiWarningRank(tsunamiCircles[bi].level));
  }
  _bulletinTsunamiLevel = currentMaxRank;
  var soundKey = currentMaxRank >= 3 ? 'Tsunami_3' : currentMaxRank >= 2 ? 'Tsunami_2' : null;
  if (soundKey && !_tsuSoundPlayed[soundKey]) {_tsuSoundPlayed[soundKey]=true;playEEWSound(soundKey);}
  _announceSrevTsunamiUpdates(tsunamiCircles, tsunamiActual);
  _updateTsunamiEtaPanel();
}

function activateTsunamiWarnings() {
  var nowMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  var intervalMs = _perfEl && _perfEl.checked ? 500 : 200;
  if (nowMs - _tsuLastUpdateMs < intervalMs) return;
  _tsuLastUpdateMs = nowMs;
  if (_tsuResearchSnapshotKey) {
    // A pruned source event must not leave its last snapshot frozen on the map.
    var snapshotEventAlive = false;
    for (var sei = 0; sei < activeEvents.length; sei++)
      if (_tsuEventKey(activeEvents[sei]) === _tsuResearchSnapshotKey) { snapshotEventAlive = true; break; }
    if (!snapshotEventAlive) { _tsuResearchSnapshot = null; _tsuResearchSnapshotKey = ''; }
  }
  if (_tsuForecastAreas.length) {
    _activateJmaTsunamiWarnings();
    return;
  }

  for (var ei = 0; ei < activeEvents.length; ei++) {
    var ev = activeEvents[ei];
    if (!isOceanPoint(ev.lat, ev.lng)) continue;
    var evElapsed = simElapsed - ev.originTime;
    var evMag = ev.mag;
    var evLat = ev.lat, evLng = ev.lng;

    // Rapid warning at t=60s. Penalize routes forced around the archipelago.
    if (!ev._tsuWarnIssued && evElapsed >= 60) {
      ev._tsuWarnIssued = true;
      var rapidField = _tsuFieldForEvent(ev);
      var rapidEventKey = _tsuEventKey(ev);
      var rapidSource = ev.sourceModel || buildSourceModel({lat:evLat,lng:evLng,mag:evMag,mw:evMag,
        depth:ev.depth,strike:ev.strike,dip:ev.dip,rake:ev.rake,mechanismKnown:ev.mechanismKnown,sourceType:ev.sourceType,originTime:ev.originTime});
      var rapidSourceDepth = _waterDepth(evLat, evLng);
      var existingRapid = Object.create(null);
      for (var exi = 0; exi < tsunamiCircles.length; exi++) {
        existingRapid[tsunamiCircles[exi].eventKey + '|' + tsunamiCircles[exi].key] = true;
      }
      for (var ci = 0; ci < _tsuCheckPoints.length; ci++) {
        var ptR = _tsuCheckPoints[ci];
        var dR = Physics.haversineDist(evLat, evLng, ptR.lat, ptR.lng);
        if (dR < 1) dR = 1;
        if (dR > 800) continue;
        var pathMeta = rapidField && rapidField.lookupMeta ? rapidField.lookupMeta(ptR.lat,ptR.lng) : null;
        if (rapidField && (!pathMeta || !isFinite(pathMeta.travelTime))) continue;
        var directBlocked = isPathBlockedByLand(evLat, evLng, ptR.lat, ptR.lng);
        if (!rapidField && directBlocked) continue;
        var kR = ptR.key;
        var spreadDistance = pathMeta ? Math.max(dR, pathMeta.pathDistance) : dR;
        var HR = Physics.tsunamiWaveContribution(rapidSource, spreadDistance, rapidSourceDepth, cfgGet('tsuCoefA'), cfgGet('tsuCoefB'));
        if (pathMeta) HR *= Physics.tsunamiPathAttenuation(pathMeta.detourRatio, directBlocked);
        // Green's law: shallow water amplification, resolved from the
        // checkpoint's offshore depth like the JMA path — never from the
        // source-cell water depth, which over-amplifies deep-ocean sources.
        var rapidCoastDepth = ptR.waterDepth != null ? ptR.waterDepth : _waterDepth(ptR.lat, ptR.lng);
        if (!(rapidCoastDepth > 0)) rapidCoastDepth = rapidSourceDepth;
        if (rapidCoastDepth && rapidCoastDepth > 10) {
          // Coastline points on the regional grid are often still in deep
          // offshore cells. Forecast the final shoaling to the 10 m contour.
          HR *= Physics.greenLawAmplification(rapidCoastDepth, 10, 5);
        }
        var lR = Physics.tsunamiWarningLevel(HR, cfgGet('tsunamiAlertBias'));
        if (lR && !existingRapid[rapidEventKey + '|' + kR]) {
          tsunamiCircles.push({lat:ptR.lat, lng:ptR.lng, height:HR, level:lR, key:kR,
            segmentIndex:ptR.segmentIndex, ringId:ptR.ringId, provisional:true, eventKey:rapidEventKey});
          existingRapid[rapidEventKey + '|' + kR] = true;
        }
      }
      if (tsunamiCircles.length > 0) {
        // Rank of THIS event's newly issued circles — the per-event alert
        // re-plays even if an earlier event already played that level.
        var rapidAlertRank = 0;
        for (var j2 = 0; j2 < tsunamiCircles.length; j2++) {
          if (tsunamiCircles[j2].eventKey !== rapidEventKey) continue;
          rapidAlertRank = Math.max(rapidAlertRank, Physics.tsunamiWarningRank(tsunamiCircles[j2].level));
        }
        var sk2 = rapidAlertRank >= 3 ? 'Tsunami_3' : rapidAlertRank >= 2 ? 'Tsunami_2' : null;
        if (sk2 && rapidAlertRank > (_tsuEventAlertRank[rapidEventKey] || 0)) {
          _tsuEventAlertRank[rapidEventKey] = rapidAlertRank;
          _tsuSoundPlayed[sk2] = true;
          playEEWSound(sk2);
        }
        // Track the conservative warning level; the displayed height remains physical.
        var tsuLev = rapidAlertRank;
        if (tsuLev > _bulletinTsunamiLevel) _bulletinTsunamiLevel = tsuLev;
      }
      continue;
    }
  }

  // Physical arrival for all ocean events (with bathymetry-enhanced physics)
  var checkPoints = _tsuCheckPoints;

  // Numerical peak amplitudes are authoritative. The empirical fallback is used
  // only when no wave solver is available.
  var pointHeights = {}, pointInfo = {}, resolvedRapid = {};
  for (var ei2 = 0; ei2 < activeEvents.length; ei2++) {
    var ev2 = activeEvents[ei2];
    if (!isOceanPoint(ev2.lat, ev2.lng)) continue;
    var ev2Elapsed = simElapsed - ev2.originTime;
    var ev2Mag = ev2.mag;
    var ev2Lat = ev2.lat, ev2Lng = ev2.lng;
    var ev2Key = _tsuEventKey(ev2);
    var waveSolver = _tsuSolverForEvent(ev2);
    var travelField = _tsuFieldForEvent(ev2);
    var physicalSource = ev2.sourceModel || buildSourceModel({lat:ev2Lat,lng:ev2Lng,mag:ev2Mag,mw:ev2Mag,
      depth:ev2.depth,strike:ev2.strike,dip:ev2.dip,rake:ev2.rake,mechanismKnown:ev2.mechanismKnown,sourceType:ev2.sourceType,originTime:ev2.originTime});
    if(waveSolver) {
      waveSolver.advanceTo(Math.max(0,ev2Elapsed));
      // Prefer the mainshock, but a land mainshock has no solver at all; let
      // the first ocean event with a solver feed the research layers then.
      if (waveSolver.getSnapshot && (ev2.isMainshock || !_tsuResearchSnapshot || _tsuResearchSnapshotKey===ev2Key)) {
        var stride = map.getZoom() >= 8 ? 1 : (map.getZoom() >= 6 ? 2 : 3);
        _tsuResearchSnapshot = waveSolver.getSnapshot(stride);
        _tsuResearchSnapshotKey = ev2Key;
      }
    }

    for (var i = 0; i < checkPoints.length; i++) {
      var pt = checkPoints[i];
      var dist = Physics.haversineDist(ev2Lat, ev2Lng, pt.lat, pt.lng);
      var travelMeta = travelField && travelField.lookupMeta ? travelField.lookupMeta(pt.lat,pt.lng) : null;
      if (travelField && (!travelMeta || !isFinite(travelMeta.travelTime))) continue;
      var physicalBlocked = !waveSolver && isPathBlockedByLand(ev2Lat, ev2Lng, pt.lat, pt.lng);
      if (!travelField && physicalBlocked) continue;
      if (dist < 1) dist = 1;
      var tsArrive = travelField ? travelMeta.travelTime
        : Physics.tsunamiTravelTime(ev2Lat, ev2Lng, pt.lat, pt.lng, _waterDepth, TSU_SPD(), 20);
      var key = pt.key;
      if (ev2Elapsed >= tsArrive) {
        resolvedRapid[ev2Key + '|' + key] = true;
        pointInfo[key] = pt;
        if(waveSolver){
          // A modeled near-zero peak means no warning; do not restore the larger
          // empirical estimate on a coast shielded by land. Multiple events are
          // superimposed by peak magnitude, matching the JMA path's per-area max.
          pointHeights[key] = Math.max(pointHeights[key] || 0, Math.abs(Physics.tsunamiCoastalHeight(waveSolver,pt.lat,pt.lng,10,5)));
        } else {
          // Only the empirical fallback needs the path-average water depth.
          var avgDepth = _sampleMeanDepth(ev2Lat, ev2Lng, pt.lat, pt.lng, 20);
          var effectiveDistance = travelMeta ? Math.max(dist, travelMeta.pathDistance) : dist;
          var H = Physics.tsunamiWaveContribution(physicalSource, effectiveDistance, avgDepth, cfgGet('tsuCoefA'), cfgGet('tsuCoefB'));
          H *= Physics.greenLawAmplification(avgDepth, 10, 5);
          if (travelMeta) H *= Physics.tsunamiPathAttenuation(travelMeta.detourRatio, physicalBlocked);
          pointHeights[key] = Math.max(pointHeights[key] || 0, Math.abs(H * Physics.tsunamiPhase(physicalSource,pt.lat,pt.lng)));
        }
      }
    }
  }

  // Remove provisional predictions as their event reaches each point, then
  // rebuild physical warnings so downgrades and cancellations are visible.
  var nextCircles = [];
  for (var ci2 = 0; ci2 < tsunamiCircles.length; ci2++) {
    var oldCircle = tsunamiCircles[ci2];
    if (oldCircle.provisional && !resolvedRapid[oldCircle.eventKey + '|' + oldCircle.key]) {
      oldCircle.level = Physics.tsunamiWarningLevel(oldCircle.height, cfgGet('tsunamiAlertBias'));
      if (oldCircle.level) nextCircles.push(oldCircle);
    }
  }
  var nextActual = [];
  for (var key in pointHeights) {
    var totalH = Math.abs(pointHeights[key]);
    var level = Physics.tsunamiWarningLevel(totalH, cfgGet('tsunamiAlertBias'));
    if (level) {
      var info = pointInfo[key], parts = key.split(',');
      var lat = info ? info.lat : parseFloat(parts[0]), lng = info ? info.lng : parseFloat(parts[1]);
      var segmentIndex = info ? info.segmentIndex : null;
      nextCircles.push({lat:lat, lng:lng, height:totalH, level:level, key:key,
        segmentIndex:segmentIndex, ringId:info ? info.ringId : null, provisional:false});
      if (_tsuActualArrivalTimes[key] == null) _tsuActualArrivalTimes[key] = simElapsed;
      nextActual.push({lat:lat, lng:lng, height:totalH, level:level, key:key + '_act',
        segmentIndex:segmentIndex, ringId:info ? info.ringId : null, arriveTime:_tsuActualArrivalTimes[key]});
    }
  }
  tsunamiCircles = nextCircles;
  tsunamiActual = nextActual;
  _tsuSegDirty = true;
  var currentBulletinLevel = 0;
  for (var bi = 0; bi < tsunamiCircles.length; bi++) {
    var currentLevel = tsunamiCircles[bi].level === 'major' ? 3 : tsunamiCircles[bi].level === 'warn' ? 2 : 1;
    if (currentLevel > currentBulletinLevel) currentBulletinLevel = currentLevel;
  }
  _bulletinTsunamiLevel = currentBulletinLevel;
  if (tsunamiCircles.length > 500) tsunamiCircles.splice(0, tsunamiCircles.length - 500);
  if (tsunamiActual.length > 500) tsunamiActual.splice(0, tsunamiActual.length - 500);
}

function updateMaxPgaPanel(curMaxPga, curMaxSh) {
  if (curMaxPga <= 0) return;
  var pgaText = curMaxPga >= 100 ? Math.round(curMaxPga) : curMaxPga.toFixed(1);
  var shindoText = formatIntensity(curMaxSh);
  var color = SHINDO_FILL[curMaxSh] || '#ff6b6b';
  setTextIfChanged(maxPgaValue, pgaText);
  setTextIfChanged(maxShindoValue, shindoText);
  if (maxPgaValue._qsColor !== color) { maxPgaValue._qsColor = color; maxPgaValue.style.color = color; }
  if (maxShindoValue._qsColor !== color) { maxShindoValue._qsColor = color; maxShindoValue.style.color = color; }
}

// ================================================================
//  Live Prefecture Coloring (JQuake-style forecast → observation)
// ================================================================

// Band-scaled fill alpha (v5.5 haze fix): the dark 6-/6+/7 colors veil the
// basemap much harder than the light bands, so they run a lower opacity.
// Used by ALL three styling paths below — _applyForecastToLivePrefLayer used
// to carry stale 0.5/0.8 constants from before the first haze fix, which is
// why detect mode kept its heavy veil.
function _shindoFillAlpha(sh, observed) {
  var n = Physics.shindoNum(sh);
  if (observed) return n >= Physics.shindoNum('6-') ? 0.24 : 0.30;
  return n >= Physics.shindoNum('6-') ? 0.16 : 0.22;
}

function _initLivePrefLayer() {
  // Remove previous layer if any
  if (_livePrefLayer) { map.removeLayer(_livePrefLayer); _livePrefLayer = null; }
  // Display granularity: JMA subdivisions when available, prefectures as fallback
  var useAreas = !!(_subareaGeoData && _subareaGeoData.features);
  var geo = useAreas ? _subareaGeoData : _prefGeoData;
  if (!geo) return;
  var keyProp = useAreas ? 'name' : 'id';
  var forecast = useAreas ? _subareaForecast : _predictedPrefectureShindos;
  // Rebuild the active color table (the layer's style fn reads the globals)
  if (useAreas) { _liveAreaColors = {}; } else { _livePrefColors = {}; }
  var colors = useAreas ? _liveAreaColors : _livePrefColors;
  // Initialize colors from forecast (only show Shindo >= 4)
  // Always init all features to 0 so _updateLivePrefLayer can fill from observations
  var feats = geo.features;
  for (var fi = 0; fi < feats.length; fi++) { colors[feats[fi].properties[keyProp]] = 0; }
  for (var pid in forecast) {
    var sh = forecast[pid].shindo;
    if (Physics.shindoNum(sh) >= Physics.shindoNum(4)) colors[pid] = sh;
  }
  // Create persistent GeoJSON layer
  _livePrefLayer = L.geoJSON(geo, {
    style: function(feature) {
      var cur = (_subareaGeoData && _subareaGeoData.features) ? _liveAreaColors : _livePrefColors;
      var sh = cur[feature.properties[(_subareaGeoData && _subareaGeoData.features) ? 'name' : 'id']] || 0;
      if (sh === 0 || sh === '0') return { fillOpacity: 0, color: 'transparent', weight: 0, interactive: false };
      var fill = SHINDO_FILL[sh] || '#888';
      // Forecast phase: band-scaled alpha; observation phase will increase
      return { fillColor: fill, fillOpacity: _shindoFillAlpha(sh, false), color: fill, weight: 1.5, opacity: 0.4, interactive: false };
    },
    interactive: false
  }).addTo(map);
}

// Merge the current (merged multi-track) forecast into the live prefecture
// layer WITHOUT wiping observed maxima. _initLivePrefLayer resets all colors
// to forecast-only — calling it on every estimate refresh made observed
// prefectures blink back to forecast colors once several tracks were active.
function _applyForecastToLivePrefLayer() {
  var useAreas = !!(_subareaGeoData && _subareaGeoData.features);
  if (!useAreas && !_prefGeoData) return;
  if (!_livePrefLayer) { _initLivePrefLayer(); return; }
  var keyProp = useAreas ? 'name' : 'id';
  var forecast = useAreas ? _subareaForecast : _predictedPrefectureShindos;
  var colors = useAreas ? _liveAreaColors : _livePrefColors;
  var observedBook = useAreas ? _liveAreaShindos : _livePrefectureShindos;
  var changed = false;
  for (var pid in forecast) {
    var sh = forecast[pid].shindo;
    if (Physics.shindoNum(sh) >= Physics.shindoNum('4') &&
        Physics.shindoNum(sh) > Physics.shindoNum(colors[pid] || 0)) {
      colors[pid] = sh;
      changed = true;
    }
  }
  if (!changed) return;
  _livePrefLayer.eachLayer(function(layer) {
    var pid = layer.feature.properties[keyProp];
    var sh = colors[pid] || 0;
    if (sh === 0 || sh === '0') { layer.setStyle({ fillOpacity: 0, color: 'transparent', weight: 0 }); return; }
    var fill = SHINDO_FILL[sh] || '#888';
    var observed = Physics.shindoNum(observedBook[pid] || 0) >= Physics.shindoNum('4');
    // v5.5 haze fix: this path used to keep the pre-fix 0.5/0.8 constants —
    // the heavy detect-mode veil came from here.
    layer.setStyle(observed
      ? { fillColor: fill, fillOpacity: _shindoFillAlpha(sh, true), color: fill, weight: 2.0, opacity: 0.55 }
      : { fillColor: fill, fillOpacity: _shindoFillAlpha(sh, false), color: fill, weight: 1.5, opacity: 0.6 });
  });
}

function _updateLivePrefLayer() {
  if (!_livePrefLayer) return;
  var useAreas = !!(_subareaGeoData && _subareaGeoData.features);
  if (!useAreas && !_prefGeoData) return;
  // Prefecture-level bookkeeping for reports/TTS stays prefecture-grained
  var curPrefShindos = _computePrefectureShindos();
  for (var pid2 in curPrefShindos) {
    if (Physics.shindoNum(curPrefShindos[pid2]) > Physics.shindoNum(_livePrefectureShindos[pid2] || 0)) {
      _livePrefectureShindos[pid2] = curPrefShindos[pid2];
    }
  }
  // Display colors aggregate at subdivision granularity when available
  var cur = useAreas ? _computeSubareaShindos() : curPrefShindos;
  var colors = useAreas ? _liveAreaColors : _livePrefColors;
  var changed = false;
  // Merge: keep max of predicted (forecast) and observed; only increase
  for (var pid in cur) {
    var obsSh = cur[pid] || 0;
    var prevSh = colors[pid] || 0;
    if (Physics.shindoNum(obsSh) > Physics.shindoNum(prevSh)) {
      colors[pid] = obsSh;
      changed = true;
    }
  }
  if (useAreas) {
    for (var pid3 in cur) {
      if (Physics.shindoNum(cur[pid3]) > Physics.shindoNum(_liveAreaShindos[pid3] || 0)) {
        _liveAreaShindos[pid3] = cur[pid3];
      }
    }
  }
  if (!changed) return;
  // Restyle changed features (only Shindo >= 4 get colored)
  var keyProp = useAreas ? 'name' : 'id';
  _livePrefLayer.eachLayer(function(layer) {
    var pid = layer.feature.properties[keyProp];
    var sh = colors[pid] || 0;
    if (sh === 0 || sh === '0') {
      layer.setStyle({ fillOpacity: 0, color: 'transparent', weight: 0 });
    } else {
      var fill = SHINDO_FILL[sh] || '#888';
      layer.setStyle({ fillColor: fill, fillOpacity: _shindoFillAlpha(sh, true), color: fill, weight: 2.0, opacity: 0.55 });
    }
  });
}

// ================================================================
//  SHINDO REPORT — triggered when global max Shindo starts declining
// ================================================================

function _computePrefectureShindos() {
  var prefShindos = {};
  if (!_prefGeoData || !_prefGeoData.features) return prefShindos;
  var features = _prefGeoData.features;
  for (var i = 0; i < features.length; i++) {
    prefShindos[features[i].properties.id] = 0;
  }
  // Use pre-cached bboxes (computed once at map load) for fast rejection
  var featureBBoxes = _prefBBoxes;
  if (!featureBBoxes) {
    featureBBoxes = [];
    for (var i = 0; i < features.length; i++) {
      featureBBoxes.push(turf.bbox(features[i]));
    }
  }
  for (var si = 0; si < visibleCircles.length; si++) {
    var c = visibleCircles[si];
    if (c.shindo === 0) continue;
    // BBox early rejection
    for (var pi = 0; pi < features.length; pi++) {
      var bb = featureBBoxes[pi];
      if (c.lng < bb[0] || c.lng > bb[2] || c.lat < bb[1] || c.lat > bb[3]) continue;
      try {
        if (turf.booleanPointInPolygon(turf.point([c.lng, c.lat]), features[pi])) {
          var pid = features[pi].properties.id;
          if (Physics.shindoNum(c.shindo) > Physics.shindoNum(prefShindos[pid] || 0)) {
            prefShindos[pid] = c.shindo;
          }
          break;
        }
      } catch(e) {}
    }
  }
  return prefShindos;
}

// Same aggregation over the 194 JMA subdivisions (keyed by area name) —
// the display granularity of the live coloring layer.
function _computeSubareaShindos() {
  var out = {};
  if (!_subareaGeoData || !_subareaGeoData.features) return out;
  var features = _subareaGeoData.features;
  for (var i = 0; i < features.length; i++) out[features[i].properties.name] = 0;
  var bboxes = _subareaBBoxes;
  if (!bboxes) {
    bboxes = [];
    for (var j = 0; j < features.length; j++) bboxes.push(turf.bbox(features[j]));
  }
  for (var si = 0; si < visibleCircles.length; si++) {
    var c = visibleCircles[si];
    if (c.shindo === 0) continue;
    for (var pi = 0; pi < features.length; pi++) {
      var bb = bboxes[pi];
      if (c.lng < bb[0] || c.lng > bb[2] || c.lat < bb[1] || c.lat > bb[3]) continue;
      try {
        if (turf.booleanPointInPolygon(turf.point([c.lng, c.lat]), features[pi])) {
          var nm = features[pi].properties.name;
          if (Physics.shindoNum(c.shindo) > Physics.shindoNum(out[nm] || 0)) out[nm] = c.shindo;
          break;
        }
      } catch(e) {}
    }
  }
  return out;
}

// Freeze the monotonic observed peaks accumulated during the whole shaking
// phase. The final bulletin must not rescan visibleCircles because that list is
// intentionally empty once the ground-motion phase has completed.
function _snapshotPrefecturePeaks() {
  var current = _computePrefectureShindos();
  var features = _prefGeoData && _prefGeoData.features ? _prefGeoData.features : [];
  var ids = features.map(function(feature) { return feature.properties.id; });
  var snapshot = SrevAnnouncer.freezeIntensitySnapshot(_livePrefectureShindos, current, ids);
  for (var i = 0; i < ids.length; i++) _livePrefectureShindos[ids[i]] = snapshot[ids[i]];
  return snapshot;
}

function _zoomToAffectedPrefectures() {
  var features = _prefGeoData.features;
  var shindos = _reportPrefectureShindos;
  var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, any = false;
  for (var i = 0; i < features.length; i++) {
    var sh = shindos[features[i].properties.id] || 0;
    if (sh === 0 || sh === '0') continue;
    var bb = turf.bbox(features[i]);
    if (bb[0] < minLng) minLng = bb[0];
    if (bb[1] < minLat) minLat = bb[1];
    if (bb[2] > maxLng) maxLng = bb[2];
    if (bb[3] > maxLat) maxLat = bb[3];
    any = true;
  }
  if (!any) return;
  var padLat = Math.max(0.5, (maxLat - minLat) * 0.2);
  var padLng = Math.max(0.5, (maxLng - minLng) * 0.2);
  map.fitBounds([[minLat - padLat, minLng - padLng], [maxLat + padLat, maxLng + padLng]], {
    animate: true, duration: 0.8, padding: [40, 40]
  });
}

function _playReportSound() {
  var lang = soundModeEl.value;
  if (lang === 'off') return;
  AudioManager.initContext();
  if (AudioManager._audioCtx && AudioManager._audioCtx.state === 'suspended')
    AudioManager._audioCtx.resume();
  // Map global max shindo to intensity-specific TTS file
  // _globalMaxShindo may be a string ("5+","6-") or number; use exact matching
  var smax = _globalMaxShindo;
  var fname;
  if (smax === '7' || smax === 7) fname = '7';
  else if (smax === '6+') fname = '6+';
  else if (smax === '6-' || smax === 6.5) fname = '6-';
  else if (smax === '5+') fname = '5+';
  else if (smax === '5-') fname = '5-';
  else if (smax === 6) fname = '6+';
  else if (smax === 5) fname = '5+';
  else if (smax === 4 || smax === '4') fname = '4';
  else if (smax === 3 || smax === '3') fname = '3';
  else fname = 'foreign';
  var path = 'sounds/' + lang + '/info/female/' + fname + '.wav';
  // Fallback to foreign.wav if the specific file isn't cached
  var fallbackPath = 'sounds/' + lang + '/info/female/foreign.wav';
  var cached = AudioManager._bufferCache && AudioManager._bufferCache[path];
  if (!cached || cached === 'loading') path = fallbackPath;
  // Stop any previous report audio to avoid overlapping playback
  if (_reportAudioEl) { try { _reportAudioEl.pause(); _reportAudioEl.remove(); } catch(e) {} }
  var a = new Audio(path);
  _reportAudioEl = a;
  a.volume = Math.min(1, soundVolume);
  if (AudioManager._audioCtx && AudioManager._masterGain && AudioManager._audioCtx.state !== 'closed') {
    try {
      var src = AudioManager._audioCtx.createMediaElementSource(a);
      src.connect(AudioManager._masterGain);
      a._mediaSrcConnected = true;
    } catch(e) {}
  }
  var p = a.play();
  if (p) p.catch(function(e){ console.warn('Report sound play failed:', path, e); });
  a.addEventListener('ended', function(){ a.remove(); if (_reportAudioEl === a) _reportAudioEl = null; });
}

function _renderReportPrefectures() {
  if (_reportHighlightLayer) map.removeLayer(_reportHighlightLayer);
  for (var i = 0; i < _reportMarkers.length; i++) map.removeLayer(_reportMarkers[i]);
  _reportMarkers = [];
  var shindos = _reportPrefectureShindos;
  _reportHighlightLayer = L.geoJSON(_prefGeoData, {
    style: function(feature) {
      var sh = shindos[feature.properties.id] || 0;
      if (sh === 0 || sh === '0') return { fillOpacity: 0, color: 'transparent', weight: 0 };
      var fill = SHINDO_FILL[sh];
      return { fillColor: fill, fillOpacity: 0.5, color: fill, weight: 2.5, opacity: 0.85 };
    },
    interactive: false
  }).addTo(map);
  var features = _prefGeoData.features;
  for (var i = 0; i < features.length; i++) {
    var sh = shindos[features[i].properties.id] || 0;
    if (sh === 0 || sh === '0') continue;
    try {
      var centroid = turf.centroid(features[i]);
      var coords = centroid.geometry.coordinates;
      var fill = SHINDO_FILL[sh];
      var textColor = (sh === 4 || sh === '4') ? '#333' : '#fff';
      var iconHtml = '<div style="width:36px;height:36px;background:' + fill
        + ';border:3px solid #fff;border-radius:6px;display:flex;align-items:center;'
        + 'justify-content:center;color:' + textColor
        + ';font-weight:900;font-size:16px;font-family:Consolas,monospace;'
        + 'box-shadow:0 2px 8px rgba(0,0,0,0.5);">' + sh + '</div>';
      var marker = L.marker([coords[1], coords[0]], {
        icon: L.divIcon({ className: 'shindo-report-icon', html: iconHtml, iconSize: [36, 36], iconAnchor: [18, 18] }),
        interactive: false
      }).addTo(map);
      _reportMarkers.push(marker);
    } catch(e) {}
  }
}

function _triggerShindoReport() {
  if (_reportTriggered || _reportActive || !_prefGeoData) return;
  // Require at least 15s between dismissal and re-trigger (prevents looping)
  if (_reportLastDismissTime > 0 && simElapsed - _reportLastDismissTime < 30) return;
  _reportTriggered = true;
  _reportActive = true;
  _globalMaxCountdown = 0; // consume the countdown so it won't re-trigger after dismiss
  _reportStartSimTime = simElapsed;
  _surveyState = 'collecting';
  _surveySnapshot = _snapshotPrefecturePeaks();
  _reportPrefectureShindos = _surveySnapshot;
  _previousMapBounds = map.getBounds();
  _previousZoom = map.getZoom();
  var overlay = document.getElementById('shindo-report-overlay');
  if (overlay) overlay.style.display = 'block';
  var titleEl = document.querySelector('#shindo-report-overlay [data-i18n="report.title"]');
  if (titleEl) titleEl.textContent = t('report.surveying');
  var subEl = document.querySelector('#shindo-report-overlay [data-i18n="report.subtitle"]');
  if (subEl) subEl.textContent = t('report.survey_subtitle');
  var cdEl = document.getElementById('shindo-report-countdown');
  if (cdEl) cdEl.textContent = t('report.collecting');
  if (_srevSpeechEnabled()) {
    var surveyQueued = _enqueueSrevSpeech(TTSTextBuilder.buildIntensitySurvey(), {
      id:'intensity-survey',
      onComplete:function() {
        if (_surveyState === 'collecting' && _reportActive && !_finalBulletinActive) {
          _surveyState = 'announced';
          _dismissShindoReport();
        }
      },
      onError:function(error) {
        console.warn('Dynamic intensity-survey TTS unavailable.', error);
        if (_surveyState === 'collecting' && _reportActive && !_finalBulletinActive) {
          _surveyState = 'announced';
          _dismissShindoReport();
        }
      }
    });
    if (!surveyQueued) _surveyState = 'announced';
  } else {
    // Without dynamic Japanese speech, retain the normal timed survey panel.
    _surveyState = 'announced';
  }
  // Hide max-shindo bar (only for final bulletin)
  var maxEl = document.getElementById('shindo-report-max');
  if (maxEl) maxEl.style.display = 'none';
  _renderReportPrefectures();
  _zoomToAffectedPrefectures();
}

function _dismissShindoReport() {
  var wasReportActive = _reportActive;
  _reportActive = false; // NOTE: do NOT reset _reportTriggered here - it's a one-shot per simulation
  if (wasReportActive) _reportLastDismissTime = simElapsed; // anti-loop: prevent immediate re-trigger
  for (var i = 0; i < _reportMarkers.length; i++) map.removeLayer(_reportMarkers[i]);
  _reportMarkers = [];
  if (_reportHighlightLayer) { map.removeLayer(_reportHighlightLayer); _reportHighlightLayer = null; }
  var overlay = document.getElementById('shindo-report-overlay');
  if (overlay) overlay.style.display = 'none';
  if (_previousZoom != null && _previousMapBounds) {
    map.fitBounds(_previousMapBounds, { animate: true, duration: 0.6, maxZoom: _previousZoom });
  }
}

// -- Final Bulletin (all stations quiet) --

// Check if all land points have finished shaking (ground motion phase over).
// Requires ALL stations activated, ALL circles removed (pga<0.3), and a 2s quiet buffer.
var _quietSince = 0; // simElapsed when _allStationsQuiet first became true
function _allStationsQuiet() {
  if (!landPoints.length) { _quietSince = 0; return false; }
  if (activeIndex < landPoints.length) { _quietSince = 0; return false; }
  if (_subEventActivationIndex < _subEventActivation.length) { _quietSince = 0; return false; }
  if (visibleCircles.length > 0) { _quietSince = 0; return false; }
  if (simElapsed < 8) { _quietSince = 0; return false; }
  if (!_quietSince) _quietSince = simElapsed;
  // Must stay quiet for 2 seconds before triggering
  return (simElapsed - _quietSince) >= 2.0;
}

// Trigger the final bulletin: prefecture map + TTS announcement
function _triggerFinalBulletin() {
  if (_finalBulletinTriggered || _finalBulletinActive) return;
  if (!_prefGeoData) return;
    _stopEEWTTS();
    _cancelSrevSpeech();
  _finalBulletinTriggered = true;
  _finalBulletinActive = true;

  // If mid-simulation report is still active, dismiss it
  if (_reportActive) _dismissShindoReport();

  // Freeze the complete peak survey before the active station list is empty.
  _surveyState = 'complete';
  _surveySnapshot = _snapshotPrefecturePeaks();
  _reportPrefectureShindos = _surveySnapshot;
  // Monotonic grid peaks prevent in-event flicker, but the grid is not a
  // final-result layer and must disappear when ground shaking is complete.
  clearActiveShakingGrid(false);
  playShindoAlert(_globalMaxShindo);

  // Save map state for restore
  _previousMapBounds = map.getBounds();
  _previousZoom = map.getZoom();

  // Update overlay title for final bulletin
  var titleEl = document.querySelector('#shindo-report-overlay [data-i18n="report.title"]');
  if (titleEl) titleEl.textContent = t('bulletin.title');
  var subEl = document.querySelector('#shindo-report-overlay [data-i18n="report.subtitle"]');
  if (subEl) subEl.textContent = t('bulletin.subtitle');
  // Show max shindo value
  var maxEl = document.getElementById('shindo-report-max');
  if (maxEl) {
    maxEl.style.display = 'block';
    var smaxVal = _globalMaxShindo;
    var smaxText = (typeof smaxVal === 'string') ? smaxVal : String(smaxVal);
    maxEl.textContent = t('info.max_shindo') + ': ' + smaxText;
    var fillColor = SHINDO_FILL[smaxVal] || '#888';
    maxEl.style.background = fillColor;
    maxEl.style.color = (smaxVal === '4' || smaxVal === 4) ? '#333' : '#fff';
  }
  var cdEl = document.getElementById('shindo-report-countdown');
  if (cdEl) cdEl.textContent = t('bulletin.broadcasting');
  var skipBtn = document.getElementById('btn-report-skip');
  if (skipBtn) skipBtn.textContent = t('bulletin.close');
  var replayBtn = document.getElementById('btn-bulletin-replay');
  if (replayBtn) replayBtn.style.display = 'inline-block';

  // Show overlay
  var overlay = document.getElementById('shindo-report-overlay');
  if (overlay) overlay.style.display = 'block';

  // Render prefecture map
  _renderReportPrefectures();
  _zoomToAffectedPrefectures();

  // Play TTS announcement
  _playFinalBulletinTTS();
}

// Build and play the concatenated TTS bulletin sequence
function _playFinalBulletinTTS() {
  var lang = soundModeEl.value;
  if (lang === 'off') { bulletinFinished(); return; }
  var ttsEnabled = document.getElementById('tts-enable');
  if (ttsEnabled && !ttsEnabled.checked) { bulletinFinished(); return; }

  // Build the sequence of audio fragments
  var seq = [];

  // Helper: add a bulletin fragment
  function add(name, vol) {
    seq.push({ path: 'sounds/' + lang + '/info/female/' + name + '.wav', vol: vol || 1 });
  }

  // --- 1. Time ---
  var bt = _bulletinTime;
  if (bt) {
    var hh = bt.getHours(), mm = bt.getMinutes();
    add('num_' + String(hh).padStart(2, '0'));
    if (lang === 'jp' || lang === 'zh') add('ph_hour');
    if (mm > 0) {
      add('num_' + String(mm).padStart(2, '0'));
      if (lang === 'jp' || lang === 'zh') add('ph_min');
    } else if (lang === 'jp' || lang === 'zh') {
      // "0分" in Japanese for exact hour
      add('num_00'); add('ph_min');
    }
  }

  // --- 2. Intensity intro ---
  add('ph_intro1');
  var smax = _globalMaxShindo;
  var iname;
  if (smax === '7' || smax === 7) iname = 'int_7';
  else if (smax === '6+' || smax === 6.5) iname = 'int_6p';
  else if (smax === '6-') iname = 'int_6m';
  else if (smax === '5+' || smax === 5.5) iname = 'int_5p';
  else if (smax === '5-') iname = 'int_5m';
  else if (smax === 6) iname = 'int_6p';
  else if (smax === 5) iname = 'int_5p';
  else if (smax === 4 || smax === '4') iname = 'int_4';
  else if (smax === 3 || smax === '3') iname = 'int_3';
  else iname = 'int_0';
  add(iname);
  add('ph_intro2');

  // --- 3. Magnitude ---
  add('ph_mag');
  var mag = _bulletinMag;
  var magInt = Math.floor(mag);
  var magDec = Math.round((mag - magInt) * 10);
  add('num_' + String(magInt).padStart(2, '0'));
  if (magDec > 0) {
    add('ph_decimal');
    add('num_' + String(magDec).padStart(2, '0'));
  }

  // --- 4. Depth ---
  add('ph_depth');
  var dep = Math.round(_bulletinDepth);
  if (dep < 100) {
    add('num_' + String(dep).padStart(2, '0'));
  } else {
    // Split into digits for deep earthquakes (e.g. 150 → 1, 5, 0)
    var depStr = String(dep);
    for (var di = 0; di < depStr.length; di++) {
      add('num_0' + depStr[di]);
    }
  }
  add('ph_km');

  // --- 5. Tsunami (voice only for warning/major; advisory is silent) ---
  if (_bulletinTsunamiLevel >= 3) add('ph_tsu_major');
  else if (_bulletinTsunamiLevel >= 2) add('ph_tsu_warning');

  // --- 6. Affected prefectures ---
  var prefs = [];
  for (var pid = 1; pid <= 47; pid++) {
    var sh = _reportPrefectureShindos[pid] || 0;
    if (Physics.shindoNum(sh) >= 3) prefs.push({ id: pid, shindo: sh, score: Physics.shindoScore(sh) });
  }
  prefs.sort(function(a, b) { return b.score - a.score; });

  if (prefs.length > 0) {
    add('ph_affected');
    for (var i = 0; i < prefs.length; i++) {
      var p = prefs[i];
      add('pref_' + String(p.id).padStart(2, '0'));
      // Map raw shindo value (0-7, "5-", "5+", "6-", "6+") to intensity short name
      var sval = p.shindo;
      var siname;
      if (sval === '7' || sval === 7) siname = 'int_7';
      else if (sval === '6+' || sval === 6.5) siname = 'int_6p';
      else if (sval === '6-') siname = 'int_6m';
      else if (sval === '5+' || sval === 5.5) siname = 'int_5p';
      else if (sval === '5-') siname = 'int_5m';
      else if (sval === 6) siname = 'int_6p';
      else if (sval === 5) siname = 'int_5p';
      else if (sval === 4 || sval === '4') siname = 'int_4';
      else siname = 'int_3';
      add(siname, 0.85);
    }
  }

  function bulletinFinished() {
    _bulletinSeqCtrl = null;
    _finalBulletinActive = false;
    _dismissShindoReport();
  }

  function playLocalFallback() {
    if (!_finalBulletinActive) return;
    _bulletinSeqCtrl = AudioManager.playSequence(seq, bulletinFinished);
  }

  // Japanese mode follows the SREV information-product sequence. The shared
  // announcer serializes 震度速報 -> 震源情報 -> 震源・震度情報 and splits
  // every speak-and-wait request at SREV's 128-character boundary.
  if (lang === 'jp' && _srevSpeechEnabled()) {
    var maxPrefNames = [];
    var targetScore = Physics.shindoScore(_globalMaxShindo);
    for (var prefIndex = 0; _prefCentroids && prefIndex < _prefCentroids.length; prefIndex++) {
      var pref = _prefCentroids[prefIndex];
      var prefShindo = _reportPrefectureShindos[pref.id] || 0;
      if (Physics.shindoScore(prefShindo) === targetScore) {
        maxPrefNames.push(pref.nam_ja || pref.nam);
      }
    }
    var bulletinOptions = {
      time: _bulletinTime,
      epicenter: TTSTextBuilder.getEpicenterName(currentPreset, isOceanEpicenter),
      maxShindo: _globalMaxShindo,
      maxAreas: maxPrefNames,
      depth: _bulletinDepth,
      magnitude: _bulletinMag,
      tsunamiStatus: _bulletinTsunamiLevel > 0 ? 'active' : 'none',
      veryShallow: _bulletinDepth <= 0
    };
    var bulletinMessages = [
      TTSTextBuilder.buildIntensityBulletin(bulletinOptions),
      TTSTextBuilder.buildHypocenterBulletin(bulletinOptions),
      TTSTextBuilder.buildCombinedBulletin(bulletinOptions)
    ];
    var queued = _enqueueSrevSpeech(bulletinMessages, {id:'final-earthquake-information',replace:true,priority:100,onComplete:bulletinFinished,onError:function(error) {
      _bulletinSeqCtrl = null;
      console.warn('Dynamic bulletin TTS unavailable.', error);
      _cancelSrevSpeech();
      bulletinFinished();
    }});
    if (queued) _bulletinSeqCtrl = {abort:_cancelSrevSpeech};
    else bulletinFinished();
    return;
  }

  playLocalFallback();
}

// Stop the bulletin TTS if playing
function _stopBulletinTTS() {
  if (_bulletinSeqCtrl) {
    _bulletinSeqCtrl.abort();
    _bulletinSeqCtrl = null;
  }
  _cancelSrevSpeech();
}

function endSimulation() {
  isRunning = false;
  clearActiveShakingGrid(false);
  if (_reportActive && !_finalBulletinActive) _dismissShindoReport();
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  if (_eewCountdownIv) { clearInterval(_eewCountdownIv); _eewCountdownIv = null; }
  btnStart.disabled = false; btnStart.textContent = t('btn.start.again');
  // Show replay button if timeline data captured
  var btnReplay = document.getElementById('btn-replay');
  if (btnReplay && _replayData.length > 3) btnReplay.style.display = 'inline-block';
  var replayBar = document.getElementById('replay-bar');
  if (replayBar && _replayData.length > 3) { replayBar.style.display = 'flex';
    var rSlider = document.getElementById('replay-slider');
    if (rSlider) { rSlider.max = _replayData.length - 1; rSlider.value = _replayData.length - 1; }
    var rTime = document.getElementById('replay-time');
    if (rTime && _replayData.length > 0) rTime.textContent = Math.round(_replayData[_replayData.length-1].t) + 's';
  }
  statusDot.classList.remove('running'); statusText.textContent = t('status.complete');
  _lastResearchSnapshot = _captureResearchSnapshot();
  if (_lastResearchSnapshot) _saveResearchSnapshot(_lastResearchSnapshot);
  var baf2 = document.getElementById('btn-autofocus'); var afl2 = document.getElementById('autofocus-label'); if (baf2) { baf2.style.display='none'; baf2.classList.remove('active'); } if (afl2) afl2.style.display='none';
  var etaB = document.getElementById('tsunami-eta-block'); if (etaB) etaB.hidden = true;
  var pfcEnd = document.getElementById('pref-forecast-card'); if (pfcEnd) pfcEnd.style.display = 'none';
  if (waveCtx) drawFrame();
}

function resetSimulation() {
  _deactivateObservedFiniteFault('reset');
  exitPresenterMode(); // v5.2: leaving presenter mode restores the sidebar
  if (isRunning) { isRunning = false; if (animationId) { cancelAnimationFrame(animationId); animationId = null; } }
  isCountingDown = false; eewAlert.style.display = 'none';
  if (_eewSoundTimer1) { clearTimeout(_eewSoundTimer1); _eewSoundTimer1 = null; }
  if (_eewSoundTimer2) { clearTimeout(_eewSoundTimer2); _eewSoundTimer2 = null; }
  _stopEEWTTS();
  if (_eewCountdownIv) { clearInterval(_eewCountdownIv); _eewCountdownIv = null; }
  simElapsed = 0; pRadius = 0; sRadius = 0; pTravel = 0; sTravel = 0;
  // Hide replay UI
  _replayData = []; _replayMode = false;
  var btnReplay2 = document.getElementById('btn-replay');
  if (btnReplay2) btnReplay2.style.display = 'none';
  var replayBar2 = document.getElementById('replay-bar');
  if (replayBar2) replayBar2.style.display = 'none';
  landPoints = []; activeIndex = 0; visibleCircles = []; _visibleCircleById = Object.create(null); activeGridCells = {}; activeShindoSounds = {};
  _reportActive = false; _reportTriggered = false; _reportStartSimTime = 0; _reportLastDismissTime = 0;
  _reportEventIdx = 0; _reportRearmAt = 0; _chainFcAt = 0; _chainFcEv = null;
  _globalMaxShindo = 0; _globalMaxCountdown = 0; _reportPrefectureShindos = {};
  _pgaCueName = null; _pgaCuePlayed = false;
  _surveyState = 'idle'; _surveySnapshot = null;
  _globalMaxPga = 0; _globalMaxPgv = 0; _researchStationPeaks = Object.create(null); _currentExperiment = null; _currentScenarioSnapshot = null; _currentConfigSnapshot = null;
  _dismissShindoReport(); _previousMapBounds = null; _previousZoom = null;
  // Final bulletin reset
  _finalBulletinTriggered = false; _finalBulletinActive = false; _quietSince = 0;
  _stopBulletinTTS();
  AudioManager.stopAll(); // instantly cut all sound effects + TTS
  _bulletinTime = null; _bulletinTsunamiLevel = 0;
  // Restore overlay title for mid-simulation report
  var titleEl = document.querySelector('#shindo-report-overlay [data-i18n="report.title"]');
  if (titleEl) titleEl.textContent = t('report.title');
  var subEl = document.querySelector('#shindo-report-overlay [data-i18n="report.subtitle"]');
  if (subEl) subEl.textContent = t('report.subtitle');
  var cdEl = document.getElementById('shindo-report-countdown');
  if (cdEl) cdEl.textContent = '';
  var skipBtn = document.getElementById('btn-report-skip');
  if (skipBtn) skipBtn.textContent = t('btn.skip');
  var replayBtn = document.getElementById('btn-bulletin-replay');
  if (replayBtn) replayBtn.style.display = 'none';
  var maxEl2 = document.getElementById('shindo-report-max');
  if (maxEl2) maxEl2.style.display = 'none';
  if (typeof TsunamiSolverHost !== 'undefined') TsunamiSolverHost.resetAll();
  tsunamiCircles = []; tsunamiRadius = 0; _tsuLastUpdateMs = -Infinity; _tsuSegCache = []; _tsuSegDirty = true; _tsuWarningRenderSignature = ''; tsunamiActual = []; _tsuActualArrivalTimes = {}; _tsuAreaPhysicalPeaks = {}; _tsuTravelFields = {}; _tsuWaveSolvers = {}; _tsuEtaCache = Object.create(null); _tsuResearchSnapshot = null; _tsuResearchSnapshotKey = '';
  clearTsunamiZoneSelection(false);
  _srevTsunamiSignature = ''; _srevTsunamiIssuedLevels = Object.create(null); _srevObservedTsunamiAreas = Object.create(null); _tsuEventAlertRank = Object.create(null);
  _srevLastEstimateBulletin = 0; _srevLastEstimatedShindo = null;
  if (waveCtx) waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  // Hide EEW info box
  var eewBox = document.getElementById('eew-info-box');
  if (_eewContainer) _eewContainer.style.display = 'none';
  if (eewBox) { eewBox.classList.remove('eew-forecast'); eewBox.classList.remove('eew-observed'); }
  if (_diagPanel) _diagPanel.style.display = 'none';
  if (epicenterMarker) { epicenterMarker.setOpacity(1); map.removeLayer(epicenterMarker); epicenterMarker = null; }
  epicenter = null; btnStart.disabled = true; btnStart.textContent = t('btn.start');
  _canvasA11yState = null;
  refreshCanvasA11yDescriptions();
  timelineEl.classList.remove('show'); legendEl.classList.remove('show'); maxPgaPanel.classList.remove('show');
  var baf3 = document.getElementById('btn-autofocus'); var afl3 = document.getElementById('autofocus-label'); if (baf3) { baf3.style.display='none'; baf3.classList.remove('active'); } if (afl3) afl3.style.display='none';
  statusDot.classList.remove('running'); statusText.textContent = t('status.ready');
  epicenterInfo.innerHTML = t('epicenter.placeholder'); epicenterInfo.classList.remove('set');
  updateSimulationSummary();
  var overview = document.querySelector('.info-overview-card'); if (overview) overview.classList.remove('has-results');
  var infoTab = document.getElementById('tab-info'); if (infoTab) infoTab.classList.remove('has-results');
  ['info-summary-shindo','info-summary-pga','info-summary-pgv','info-summary-waves'].forEach(function(id){ var el=document.getElementById(id); if(el){el.textContent='—';el.style.color='';} });
  var liveState = document.getElementById('info-live-state'); if (liveState) { liveState.textContent=t('info.waiting'); liveState.classList.remove('running'); }
  var infoBlock = document.getElementById('info-quake'); if (infoBlock) infoBlock.innerHTML='';
  var infoStatus = document.getElementById('info-tab-status'); if (infoStatus) infoStatus.hidden=true;
  pRadiusEl.textContent = '0'; sRadiusEl.textContent = '0'; timeDisplay.textContent = '00:00.0';
  // Reset aftershock state
  aftershockCatalog = []; activeAftershocks = []; maxAftershockMag = 0;
  damageCache = null; damageCacheSec = -1;
  // Reset dip/rake to defaults
  currentDip = 60; currentRake = 0; _dipExplicit = false; _rakeExplicit = false;
  dipSlider.value = 60; document.getElementById('dip-num').value = 60; refreshDipStateLabel();
  rakeSlider.value = 0; document.getElementById('rake-num').value = 0; refreshRakeStateLabel();
  // Remove Leaflet fault + aftershock layers + event markers
  removeFaultLayer();
  // Remove multi-event markers
  for (var mei = 0; mei < multiEventMarkers.length; mei++) map.removeLayer(multiEventMarkers[mei]);
  multiEventMarkers = [];
  customEvents = [];
  var meInfo = document.getElementById('multi-event-info');
  if (meInfo) meInfo.style.display = 'none';
  for (var aei2 = 1; aei2 < activeEvents.length; aei2++) {
    if (activeEvents[aei2].marker) map.removeLayer(activeEvents[aei2].marker);
  }
  activeEvents = [];
  detectedAftershocks = [];
  intensitySamples = [];
  rupturePolyEntries = [];
  _wfAftershockSignals = []; _wfAftershockSignalsReady = false;
  _lastDetectionSolveMs = _lastWaveRenderMs = _lastInfoRenderMs = _lastTableRenderMs = -Infinity;
  _lastChartRenderMs = _lastRuptureRenderMs = _lastMultiWaveRenderMs = _lastAftershockRenderMs = -Infinity;
  _maxAnnouncedShindo = -1; _chartSec = -1;
  _lastPrefUpdateSec = -1;
  // Remove live prefecture layer
  if (_livePrefLayer) { map.removeLayer(_livePrefLayer); _livePrefLayer = null; }
  _livePrefColors = {};
  _liveAreaColors = {}; _liveAreaShindos = {};
  // Reset EEW forecast state
  _predictedPrefectureShindos = {}; _subareaForecast = {}; _predictedMaxShindo = 0; _predictedMaxShindoI = -1; _eewWarranted = false; _detectEEWTriggered = false;
  var pfcRst = document.getElementById('pref-forecast-card');
  if (pfcRst) pfcRst.style.display = 'none';
  var pftRst = document.getElementById('pref-forecast-table');
  if (pftRst) { pftRst.innerHTML = ''; pftRst._renderedHtml = ''; }
  _livePrefectureShindos = {};
  // Clear intensity canvas
  if (intensityCtx && intensityCanvas) intensityCtx.clearRect(0, 0, intensityCanvas.width, intensityCanvas.height);
  // Clear multi-station waveform slots
  for (var _mi = 0; _mi < _mwfSlots.length; _mi++) _mwfRemoveSlot(_mi);
  var _mwfP = document.getElementById('multi-wf-panel'); if (_mwfP) _mwfP.style.display = 'none';
  // Hide aftershock timeline
  var atl = document.getElementById('aftershock-timeline');
  if (atl) atl.style.display = 'none';
}

// -- Events --
var PRESETS = {
  // 2011 Tohoku-Oki: bundled observed finite-fault model (USGS Hayes 2017,
  // 3-segment 625 km rupture, 325 patches) replaces the earlier synthetic
  // 4-subsource approximation — four overlapping Strasser-scaled planes
  // (226-582 km each) smeared the shaking footprint and tsunami source.
  tohoku:  {lat:38.10,lng:142.86,mag:9.1,depth:24,strike:193,time:'2011/03/11 14:46',faultModel:'tohoku'},
  // Hypothetical future Nankai Trough megathrust scenario (Cabinet Office
  // 2012 Mw 9.0 framework): bundled synthetic 4-segment finite-fault model
  // (Tokai/Tonankai/Nankai/Hyuga, 217 patches, 大すべり域 20 m / 超大すべり域
  // 40 m, nucleation south of the Kii Peninsula). No `time`: bulletins use
  // the current clock because the event has not occurred.
  nankaiM9: {lat:33.93,lng:136.41,mag:9.0,depth:16,strike:247,faultModel:'nankaiM9'},
  tokyoInland: {lat:35.62,lng:139.75,mag:7.3,depth:17,strike:135,dip:60,rake:120,mechanismKnown:true}, // hypothetical Tokyo-inland (都心南部直下-class) M7.3 scenario
  // Hypothetical "Japan Sinks" (日本沈没) chain: the 2011 Tohoku-Oki earthquake
  // followed by every earthquake with JMA maximum Shindo 6-/6+/7 of the last ten
  // years (2016-2026), striking in chronological sequence, then two hypothetical
  // megathrust scenarios appended after the catalog: a Nankai Trough M9.0
  // (Cabinet Office 2012 framework, bundled 4-segment model) and a
  // Kuril-trench Hokkaido-east-offshore M8.4. Foreshock sequences
  // are collapsed to their mainshock, so the 2016 Kumamoto M6.5/M6.4 foreshocks
  // are dropped and only the M7.3 mainshock stays. `mag` 9.27 is the combined
  // moment magnitude of the 19 sub-events, so the multi-segment moment rescale
  // factor stays ~1.0 and each event keeps its own magnitude. `time` offsets
  // are sim-seconds with random compressed intervals of 25-75 s (mulberry32
  // seed 20260804, gap = 25 + round(50*r)), frozen here so runs and shared URLs
  // remain reproducible. Mechanisms follow F-net/JMA where published; the
  // 2025-2026 events use provisional plate-boundary/crustal estimates pending
  // official CMT solutions, and the two hypothetical events use assumed
  // interplate mechanisms. Tohoku, Kumamoto 2016, Noto 2024, Fukushima-oki
  // 2022, Hyuga-nada 2024 and the Nankai scenario run on their bundled
  // finite-fault models (Hayes 2017, USGS Hayes 2018, USGS Goldberg 2024,
  // USGS Goldberg 2022, USGS Goldberg 2024, and the synthetic 4-segment
  // model); the remaining catalog events use synthetic Strasser-scaled planes.
  japanSinks: {lat:38.10,lng:142.86,mag:9.27,depth:24,strike:193,subEvents:[
    {lat:38.10,lng:142.86,mag:9.1,depth:24,strike:193,dip:15,rake:90,mechanismKnown:true,time:0,faultModel:'tohoku'},    // 2011-03-11 Tohoku-Oki M9.1 (Shindo 7) — Hayes 2017 observed slip model
    {lat:32.75,lng:130.76,mag:7.3,depth:12,strike:226,dip:65,rake:-140,mechanismKnown:true,time:43,faultModel:'kumamoto2016'},  // 2016-04-16 Kumamoto M7.3 (Shindo 7) — USGS Hayes 2018 observed slip model
    {lat:41.90,lng:141.00,mag:5.3,depth:11,strike:150,dip:80,rake:0,mechanismKnown:true,time:82},    // 2016-06-16 Uchiura Bay M5.3 (6-)
    {lat:35.38,lng:133.86,mag:6.6,depth:11,strike:160,dip:80,rake:0,mechanismKnown:true,time:109},   // 2016-10-21 Tottori Chubu M6.6 (6-)
    {lat:34.85,lng:135.62,mag:6.1,depth:13,strike:130,dip:60,rake:90,mechanismKnown:true,time:178},  // 2018-06-18 Northern Osaka M6.1 (6-)
    {lat:42.69,lng:142.01,mag:6.7,depth:37,strike:0,dip:70,rake:90,mechanismKnown:true,time:208},    // 2018-09-06 Eastern Iburi M6.7 (Shindo 7)
    {lat:38.61,lng:139.53,mag:6.7,depth:14,strike:30,dip:55,rake:90,mechanismKnown:true,time:247},   // 2019-06-18 Yamagata-oki M6.7 (6+)
    {lat:37.73,lng:141.70,mag:7.3,depth:55,strike:25,dip:55,rake:90,mechanismKnown:true,time:275},   // 2021-02-13 Fukushima-oki M7.3 (6+)
    {lat:37.70,lng:141.60,mag:7.4,depth:57,strike:30,dip:55,rake:90,mechanismKnown:true,time:325,faultModel:'fukushima2022'},   // 2022-03-16 Fukushima-oki M7.4 (6+) — USGS Goldberg 2022 observed slip model
    {lat:37.54,lng:137.31,mag:6.5,depth:12,strike:55,dip:50,rake:90,mechanismKnown:true,time:386},   // 2023-05-05 Noto M6.5 (6+)
    {lat:37.50,lng:137.27,mag:7.6,depth:16,strike:45,dip:45,rake:90,mechanismKnown:true,time:431,faultModel:'noto2024'},   // 2024-01-01 Noto Hanto-oki M7.6 (Shindo 7) — USGS Goldberg 2024 observed slip model
    {lat:33.20,lng:132.40,mag:6.6,depth:39,strike:150,dip:80,rake:0,mechanismKnown:true,time:456},   // 2024-04-17 Bungo Channel M6.6 (6-)
    {lat:31.75,lng:131.70,mag:7.1,depth:30,strike:200,dip:15,rake:90,mechanismKnown:true,time:508,faultModel:'hyuganada2024'},  // 2024-08-08 Hyuga-nada M7.1 (6-) — USGS Goldberg 2024 observed slip model
    {lat:41.00,lng:142.50,mag:7.5,depth:54,strike:200,dip:20,rake:90,mechanismKnown:true,time:578},  // 2025-12-08 Aomori-oki M7.5 (6+)
    {lat:39.85,lng:142.30,mag:6.9,depth:50,strike:195,dip:20,rake:90,mechanismKnown:true,time:636},  // 2026-06-25 Iwate-oki M6.9 (6+)
    {lat:35.52,lng:138.78,mag:5.6,depth:20,strike:150,dip:70,rake:0,mechanismKnown:true,time:697},   // 2026-06-26 Yamanashi Fuji Five Lakes M5.6 (6-)
    {lat:32.58,lng:130.68,mag:7.1,depth:10,strike:205,dip:65,rake:-135,mechanismKnown:true,time:734}, // 2026-07-28 Kumamoto M7.1 (Shindo 7)
    {lat:33.93,lng:136.41,mag:9.0,depth:16,strike:247,dip:15,rake:90,mechanismKnown:true,time:797,faultModel:'nankaiM9'},   // Hypothetical Nankai Trough M9.0 (Cabinet Office 2012 framework) — bundled 4-segment scenario model
    {lat:43.00,lng:147.30,mag:8.4,depth:25,strike:225,dip:20,rake:90,mechanismKnown:true,time:865}    // Hypothetical Hokkaido-east-offshore (Kuril trench) M8.4
  ]},
  kobe:    {lat:34.58,lng:135.02,mag:7.3,depth:16,strike:233,time:'1995/01/17 05:46'},
  kumamoto:{lat:32.75,lng:130.76,mag:7.0,depth:12,strike:226,time:'2016/04/16 01:25',faultModel:'kumamoto2016'},
  kanto:   {lat:35.33,lng:139.14,mag:7.9,depth:23,strike:290,time:'1923/09/01 11:58'},
  chuetsu: {lat:37.29,lng:138.87,mag:6.8,depth:13,strike:36,time:'2004/10/23 17:56'},
  iburihigashi: {lat:42.69,lng:142.01,mag:6.7,depth:37,strike:0,time:'2018/09/06 03:08'},
  noto2024:     {lat:37.50,lng:137.27,mag:7.6,depth:16,strike:45,time:'2024/01/01 16:10',faultModel:'noto2024'},
  tokachi2003:  {lat:41.81,lng:143.91,mag:8.3,depth:27,strike:240,time:'2003/09/26 04:50',faultModel:'tokachi2003'}, // USGS Hayes 2014 observed slip model (425 patches)
  fukushima2022:{lat:37.70,lng:141.59,mag:7.2,depth:63,strike:184,time:'2022/03/16 23:36',faultModel:'fukushima2022'}, // USGS Goldberg 2022 observed slip model (399 patches, intraslab)
  hyuganada2024:{lat:31.72,lng:131.53,mag:7.1,depth:25,strike:203,time:'2024/08/08 16:43',faultModel:'hyuganada2024'}, // USGS Goldberg 2024 observed slip model (225 patches)
  iwate2008:   {lat:39.03,lng:140.88,mag:7.2,depth:8,strike:198,time:'2008/06/14 08:43'},
  noto2007:    {lat:37.22,lng:136.69,mag:6.9,depth:11,strike:40,time:'2007/03/25 09:42'},
  fukuoka2005: {lat:33.74,lng:130.18,mag:7.0,depth:9,strike:300,time:'2005/03/20 10:53'},
  fukushima2011:{lat:36.95,lng:140.67,mag:7.0,depth:6,strike:150,time:'2011/04/11 17:16'},
  tottori2016: {lat:35.38,lng:133.86,mag:6.6,depth:11,strike:160,time:'2016/10/21 14:07'},
  yamagata2019:{lat:38.61,lng:139.53,mag:6.7,depth:14,strike:30,time:'2019/06/18 22:22'},
  fukushima2021:{lat:37.73,lng:141.70,mag:7.3,depth:55,strike:25,time:'2021/02/13 23:07'},
  kushiro1993:{lat:42.92,lng:144.35,mag:7.5,depth:103,strike:133,time:'1993/01/15 20:06'},
  tonankai1944:{lat:33.57,lng:136.18,mag:7.9,depth:30,strike:225,time:'1944/12/07 13:35'},
  nankai1946:{lat:32.93,lng:135.85,mag:8.0,depth:24,strike:225,time:'1946/12/21 04:19'},
  niigata1964:{lat:38.37,lng:139.22,mag:7.5,depth:34,strike:30,time:'1964/06/16 13:01'}
};
document.getElementById('preset').addEventListener('change', function(){
  _deactivateObservedFiniteFault('event-parameter-change');
  currentPreset = this.value;
  var p = PRESETS[this.value];
  if (!p) {
    // Custom: reset dip/rake to defaults
    currentDip = 60; currentRake = 0; _dipExplicit = false; _rakeExplicit = false;
    dipSlider.value = 60; document.getElementById('dip-num').value = 60; refreshDipStateLabel();
    rakeSlider.value = 0; document.getElementById('rake-num').value = 0; refreshRakeStateLabel();
    epicenterSrc = null; eventMw = null;
    return;
  }
  setEpicenter(p.lat, p.lng);
  epicenterSrc = (OBSERVED && OBSERVED[this.value] && OBSERVED[this.value].src) || p.src || null;
  eventMw = (OBSERVED && OBSERVED[this.value] && OBSERVED[this.value].mw != null) ? OBSERVED[this.value].mw : null;
  // Read dip/rake from observed.json if available
  if (OBSERVED && OBSERVED[this.value]) {
    currentDip = (OBSERVED[this.value].dip != null) ? OBSERVED[this.value].dip : Physics.recommendedFaultDip(activeSrcType());
    currentRake = (OBSERVED[this.value].rake != null) ? OBSERVED[this.value].rake : 0;
    _dipExplicit = OBSERVED[this.value].dip != null;
    _rakeExplicit = OBSERVED[this.value].rake != null;
  } else {
    currentDip = Physics.recommendedFaultDip(activeSrcType()); currentRake = 0; _dipExplicit = false; _rakeExplicit = false;
  }
  dipSlider.value = currentDip; document.getElementById('dip-num').value = currentDip; refreshDipStateLabel();
  rakeSlider.value = currentRake; document.getElementById('rake-num').value = currentRake; refreshRakeStateLabel();
  magSlider.value = p.mag; document.getElementById('magnitude-num').value = p.mag; magVal.textContent = 'M'+p.mag.toFixed(1);
  _liveMag=p.mag;
  depthSlider.value = p.depth; document.getElementById('depth-num').value = p.depth; depthVal.textContent = p.depth+' km';
  _liveDepth=p.depth;
  strikeSlider.value = p.strike; document.getElementById('strike-num').value = p.strike; strikeVal.textContent = p.strike+'°';
  // A preset with a bundled observed finite-fault model (2011 Tohoku) activates
  // it here, overriding the slider-derived source parameters with the model's.
  if (p.faultModel) _activatePresetFaultModel(p.faultModel);
  map.setView([p.lat, p.lng], 7);
  updateEpicenterInfo();
  if (typeof FiniteFaultEditor !== 'undefined' && FiniteFaultEditor.updateVisibility) FiniteFaultEditor.updateVisibility();
});
btnStart.addEventListener('click', startCountdown);
btnReset.addEventListener('click', resetSimulation);
document.getElementById('detect-mode').addEventListener('change', function(){
  detectMode = this.checked;
});
document.getElementById('aftershock-enable').addEventListener('change', function(){
  aftershockEnabled = this.checked;
  _syncAsManualPanel();
});
var _asManAddBtn = document.getElementById('as-man-add');
if (_asManAddBtn) _asManAddBtn.addEventListener('click', function(){
  var te = document.getElementById('as-man-time'), me = document.getElementById('as-man-mag'), de = document.getElementById('as-man-depth');
  var tv = Math.max(0, Math.min(3600, +te.value || 0));
  var mv = Math.max(3, Math.min(9.5, +me.value || 6));
  var dv = Math.max(0, Math.min(700, +de.value || 0));
  te.value = tv; me.value = mv; de.value = dv;
  var entry = {time: tv, mag: mv, depth: dv};
  if (_asManPendingLoc) { entry.lat = _asManPendingLoc.lat; entry.lng = _asManPendingLoc.lng; }
  manualAftershocks.push(entry);
  manualAftershocks.sort(function(a, b) { return a.time - b.time; });
  _asManClearPendingLoc();
  _renderManualAftershocks();
});
var _asManLocBtn = document.getElementById('as-man-loc');
if (_asManLocBtn) _asManLocBtn.addEventListener('click', function(){
  _asManPickSetArmed(!_asManPickArmed);
});
_syncAsManualPanel();
_renderManualAftershocks();
_asManLocValShow();
document.getElementById('fault-polygon-enable').addEventListener('change', function(){
  faultPolygonEnabled = this.checked;
  if (isRunning && !detectMode) {
    removeFaultLayer();
    for (var ei = 0; ei < activeEvents.length; ei++) {
      var ev = activeEvents[ei];
      if (ev.mag >= 6.5 || ev.sourceModel&&ev.sourceModel.finiteFault) {
        createFaultLayer(ev.lat, ev.lng, ev.mag,
          ev.strike != null ? ev.strike : parseFloat(strikeSlider.value),
          ev.dip != null ? ev.dip : currentDip, ev.depth, ev.originTime, ev.mag, ev.sourceType,
          ev.sourceModel && ev.sourceModel.geometry);
      }
    }
  }
});
// EEW countdown cancel button
var btnEewCancel = document.getElementById('btn-eew-cancel');
if (btnEewCancel) {
  btnEewCancel.addEventListener('click', function() {
    if (_eewCountdownIv) { clearInterval(_eewCountdownIv); _eewCountdownIv = null; }
    eewAlert.style.display = 'none'; isCountingDown = false;
    btnStart.disabled = false; btnStart.textContent = t('btn.start');
    statusDot.classList.remove('running'); statusText.textContent = t('status.ready');
  });
}
// Shindo Report skip button
var btnReportSkip = document.getElementById('btn-report-skip');
if (btnReportSkip) {
  btnReportSkip.addEventListener('click', function() {
    if (_finalBulletinActive) {
      _finalBulletinActive = false;
      _stopBulletinTTS();
      _dismissShindoReport();
    } else if (_reportActive) {
      _dismissShindoReport();
    }
  });
}
// Bulletin replay button
var btnBulletinReplay = document.getElementById('btn-bulletin-replay');
if (btnBulletinReplay) {
  btnBulletinReplay.addEventListener('click', function() {
    if (_finalBulletinActive) {
      _stopBulletinTTS();
      _playFinalBulletinTTS();
    }
  });
}
// Bathymetry toggle
var bathyCheckbox = document.getElementById('bathy-enable');
if (bathyCheckbox) {
  bathyCheckbox.addEventListener('change', function() {
    _bathyShow = this.checked;
  });
}
var vs30Checkbox = document.getElementById('vs30-enable');
if (vs30Checkbox) vs30Checkbox.addEventListener('change', function() { _vs30Show = this.checked; });

(function initObservedMotionImport(){
  var input=document.getElementById('observed-3c-file'),rateInput=document.getElementById('observed-3c-rate');
  var output=document.getElementById('observed-3c-result');if(!input||!output)return;
  function showResult(motion,quality){
    var result=Physics.analyzeObservedMotion3C(motion);
    if(!result)throw new Error('invalid three-component record');
    var state=quality&&quality.researchReady?t('info.waveform_research_ready'):t('info.waveform_not_certified');
    output.innerHTML='<strong>JMA I = '+result.intensity.toFixed(2)+'</strong><span>PGA3C '+result.pgaVectorGal.toFixed(1)+' gal</span><span>'+result.samples+' samples @ '+result.sampleRate.toFixed(2)+' Hz</span><small>'+escapeHTML(result.source)+'</small><small>'+escapeHTML(state)+'</small>';
  }
  input.addEventListener('change',function(){
    var file=input.files&&input.files[0];if(!file)return;
    var reader=new FileReader();reader.onload=function(){
      try{
        if(/\.json$/i.test(file.name)||/^\s*\{/.test(String(reader.result||''))){
          if(typeof WaveformData==='undefined')throw new Error('waveform package parser unavailable');
          var payload=JSON.parse(String(reader.result||'')),validation=WaveformData.validate(payload);
          if(!validation.valid)throw new Error(validation.errors.join(', '));
          showResult(WaveformData.toObservedMotion(payload),validation);return;
        }
        var lines=String(reader.result||'').trim().split(/\r?\n/),x=[],y=[],z=[],times=[];
        for(var i=0;i<lines.length;i++){
          var cols=lines[i].trim().split(/[;,\t ]+/).map(Number);if(cols.some(function(v){return !isFinite(v);}))continue;
          if(cols.length>=4){times.push(cols[0]);x.push(cols[1]);y.push(cols[2]);z.push(cols[3]);}
          else if(cols.length>=3){x.push(cols[0]);y.push(cols[1]);z.push(cols[2]);}
        }
        var rate=Number(rateInput&&rateInput.value)||100;
        if(times.length>2){var duration=times[times.length-1]-times[0];if(duration>0)rate=(times.length-1)/duration;}
        showResult({sampleRate:rate,components:{x:x,y:y,z:z},source:file.name},{researchReady:false});
      }catch(e){output.textContent=t('info.observed_3c_error')+': '+e.message;}
    };reader.readAsText(file);
  });
  // Bundled frozen K-NET/KiK-net waveform packages (frozen by
  // tools/fetch-kyoshin-waveforms.js with a registered NIED account).
  var pkgEvent=document.getElementById('observed-pkg-event'),pkgStation=document.getElementById('observed-pkg-station');
  var pkgRow=document.getElementById('observed-pkg-row'),pkgLoad=document.getElementById('observed-pkg-load');
  if(typeof StrongMotionWaveforms!=='undefined'&&pkgEvent&&pkgStation){
    var pkgCache=Object.create(null);
    StrongMotionWaveforms.fetchBundledIndex().then(function(idx){
      if(!idx.valid||!idx.events.length)return; // bundled directory absent/empty: keep the manual import only
      pkgRow.hidden=false;
      idx.events.forEach(function(e){
        var opt=document.createElement('option');opt.value=e.id;
        opt.textContent=(e.origintime||e.id)+(e.mag?' M'+e.mag:'')+' · '+e.stations+' st.';
        pkgEvent.appendChild(opt);
      });
      function fillStations(pkg){
        var rows=StrongMotionWaveforms.packageSummary(pkg).slice(0,24);
        pkgStation.innerHTML='';
        rows.forEach(function(r){
          var opt=document.createElement('option');opt.value=r.id;
          opt.textContent=r.id+' · PGA '+r.pga3cGal.toFixed(0)+' gal'+(isFinite(r.intensity)?' · I '+r.intensity.toFixed(1):'');
          pkgStation.appendChild(opt);
        });
      }
      function loadPackage(id){
        return pkgCache[id]?Promise.resolve(pkgCache[id]):StrongMotionWaveforms.fetchPackage(id).then(function(pkg){
          var check=StrongMotionWaveforms.validatePackage(pkg);
          if(!check.valid)throw new Error(check.errors.join(', '));
          pkgCache[id]=pkg;return pkg;
        });
      }
      pkgEvent.addEventListener('change',function(){
        var id=pkgEvent.value;if(!id)return;
        loadPackage(id).then(fillStations).catch(function(e){output.textContent=t('info.observed_3c_error')+': '+e.message;});
      });
      pkgLoad.addEventListener('click',function(){
        var id=pkgEvent.value;if(!id)return;
        loadPackage(id).then(function(pkg){
          var station=pkg.stations.filter(function(s){return s.station&&s.station.id===pkgStation.value;})[0];
          if(!station)throw new Error('station unavailable');
          var validation=WaveformData.validate(station);
          if(!validation.valid)throw new Error(validation.errors.join(', '));
          showResult(WaveformData.toObservedMotion(station),validation);
        }).catch(function(e){output.textContent=t('info.observed_3c_error')+': '+e.message;});
      });
    }).catch(function(){/* offline or not bundled: manual import stays */});
  }
})();
// Import a verified single grid or a deployed multi-resolution package. The
// selected terrain is immediately reused by tsunami physics and map layers.
(function initResearchGridImport(){
  var terrainInput=document.getElementById('research-terrain-file'),vsInput=document.getElementById('research-vs30-file');
  var output=document.getElementById('research-grid-result'),loadButton=document.getElementById('research-package-load');
  function activate(kind,grid,label){
    var validation=Physics.validateResearchGrid(grid,kind);if(!validation.valid)throw new Error(validation.errors.join(', '));
    if(kind==='terrain'){
      _bathyGrid=grid;
      // Solvers, travel fields and the grid-snapped forecast control points
      // all derive from the previous terrain; rebuild them on the new grid.
      resetTsunamiSolverRuntime();
      buildJmaTsunamiForecastAreas();
    }else _vs30Grid=grid;
    _updateResearchDataCertification();if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
    if(typeof _quake3dPushGeo==='function'&&kind==='terrain')_quake3dPushGeo();
    if(output)output.innerHTML='<strong>'+escapeHTML(grid.meta&&grid.meta.dataset||label)+'</strong><br>'+grid.nx+' × '+grid.ny+' @ '+grid.res+'° · '+escapeHTML(grid.meta&&grid.meta.quality||'unknown');
    if(typeof drawFrame==='function')drawFrame();
  }
  function bindFile(input,kind){if(!input)return;input.addEventListener('change',function(){var file=input.files&&input.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(){try{activate(kind,JSON.parse(String(reader.result||'')),file.name);}catch(e){if(output)output.textContent=t('research.grid_error')+': '+e.message;}};reader.readAsText(file);});}
  bindFile(terrainInput,'terrain');bindFile(vsInput,'vs30');
  if(loadButton)loadButton.addEventListener('click',async function(){
    var kind=document.getElementById('research-package-kind').value,url=document.getElementById('research-package-url').value.trim();
    var target=Number(document.getElementById('research-package-resolution').value)||0.05,b=map.getBounds(),bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()];
    loadButton.disabled=true;if(output)output.textContent=t('status.loading');
    try{var loaded=await ResearchGridPackage.loadBounds(url,bbox,target,fetch);activate(kind,loaded.grid,loaded.manifest.meta.dataset);}
    catch(e){if(output)output.textContent=t('research.grid_error')+': '+e.message;}
    finally{loadButton.disabled=false;}
  });
})();
// Import a frozen K-NET/KiK-net event package and expose all supported
// engineering-motion metrics without treating an unpaired package as certified.
(function initStrongMotionEventImport(){
  var input=document.getElementById('strong-motion-event-file'),output=document.getElementById('strong-motion-event-result');
  if(!input||!output)return;
  input.addEventListener('change',function(){
    var file=input.files&&input.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(){
      try{
        var payload=JSON.parse(String(reader.result||'')),validation=StrongMotionData.validate(payload);
        if(!validation.valid)throw new Error(validation.errors.join(', '));
        var analysis=StrongMotionData.analyze(payload,Physics),maxPga=0,maxPgv=0,maxI=-Infinity,maxDuration=0;
        analysis.records.forEach(function(row){maxPga=Math.max(maxPga,row.pgaVectorGal);maxPgv=Math.max(maxPgv,row.pgvVectorCms);maxI=Math.max(maxI,row.intensity);maxDuration=Math.max(maxDuration,row.duration5to95Sec);});
        _strongMotionPackageReady=validation.researchReady;_updateResearchDataCertification();
        output.innerHTML='<strong>'+escapeHTML(payload.event.id)+' · '+analysis.records.length+' '+escapeHTML(t('info.strong_motion_records'))+'</strong>'
          +'<span>'+analysis.pairs+' '+escapeHTML(t('info.strong_motion_pairs'))+'</span><span>JMA I '+maxI.toFixed(2)+' · PGA '+maxPga.toFixed(1)+' gal · PGV '+maxPgv.toFixed(2)+' cm/s</span>'
          +'<span>D5-95 '+maxDuration.toFixed(2)+' s · '+escapeHTML(validation.researchReady?t('info.waveform_research_ready'):t('info.waveform_not_certified'))+'</span>';
      }catch(e){_strongMotionPackageReady=false;_updateResearchDataCertification();output.textContent=t('info.strong_motion_error')+': '+e.message;}
    };reader.readAsText(file);
  });
})();
// Compare imported simulation results against the frozen historical tsunami
// schema without mixing tide-gauge, offshore, run-up, and inundation metrics.
(function initTsunamiValidationImport(){
  var input=document.getElementById('tsunami-validation-predictions'),output=document.getElementById('tsunami-validation-result');
  if(!input||!output)return;
  function renderDataset(){if(!_historicalTsunamiData)return;var check=TsunamiValidation.validate(_historicalTsunamiData);output.innerHTML='<strong>'+check.eventCount+' '+escapeHTML(t('info.tsunami_events'))+' · '+check.observationCount+' '+escapeHTML(t('info.tsunami_observations'))+' · '+check.areaCount+' '+escapeHTML(t('info.tsunami_area_labels'))+'</strong><br>'+escapeHTML(check.researchReady?t('info.waveform_research_ready'):t('info.waveform_not_certified'));}
  _renderHistoricalTsunamiValidationDataset=renderDataset;
  input.addEventListener('change',function(){var file=input.files&&input.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(){try{if(!_historicalTsunamiData)throw new Error('historical dataset unavailable');var report=TsunamiValidation.evaluate(_historicalTsunamiData,JSON.parse(String(reader.result||''))),m=report.confusionMatrix.matrix,labels=report.confusionMatrix.labels;var table='<table class="research-diff-table"><thead><tr><th>Obs / Pred</th>'+labels.map(function(x){return '<th>'+escapeHTML(x)+'</th>';}).join('')+'</tr></thead><tbody>'+m.map(function(row,i){return '<tr><th>'+escapeHTML(labels[i])+'</th>'+row.map(function(value){return '<td>'+value+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table>';output.innerHTML='<strong>Hit '+(report.classification.hitRate==null?'—':(report.classification.hitRate*100).toFixed(1)+'%')+' · Miss '+report.classification.misses+' · False '+report.classification.falseAlarms+'</strong>'+table+'<small>'+escapeHTML(t('info.tsunami_metric_separation'))+(report.missingEvents.length+report.missingObservations?' Missing events: '+report.missingEvents.length+', missing observations: '+report.missingObservations+'.':'')+'</small>';}catch(e){output.textContent=t('info.tsunami_validation_error')+': '+e.message;}};reader.readAsText(file);});
  setTimeout(renderDataset,0);
})();
// Import a StationXML-derived catalog. This is metadata only: no missing
// response, Vs30, or waveform values are silently synthesized.
(function initStationCatalogImport(){
  var input=document.getElementById('station-catalog-file'), output=document.getElementById('station-catalog-result'), useButton=document.getElementById('station-catalog-use'), imported=null;
  if(!input||!output)return;
  input.addEventListener('change',function(){
    var file=input.files&&input.files[0];if(!file)return;
    var reader=new FileReader();reader.onload=function(){
      try{
        var catalog=JSON.parse(String(reader.result||''));
        if(catalog._schema!=='quake-sim-station-catalog-v1'||!Array.isArray(catalog.stations))throw new Error('unsupported station catalog schema');
        var ids=Object.create(null),channels=0,responses=0,valid=0;
        catalog.stations.forEach(function(st){
          if(!st.id||!isFinite(Number(st.lat))||!isFinite(Number(st.lng)))throw new Error('invalid station coordinates: '+(st.id||'?'));
          if(ids[st.id])throw new Error('duplicate station id: '+st.id); ids[st.id]=1; valid++;
          if(!Array.isArray(st.channels))throw new Error('channels missing: '+st.id);
          st.channels.forEach(function(ch){channels++;if(ch.hasResponse)responses++;});
        });
        imported=catalog; if(useButton)useButton.disabled=!valid;
        output.innerHTML='<strong>'+valid+' '+t('info.station_catalog_stations')+'</strong><span>'+channels+' '+t('info.station_catalog_channels')+'</span><span>'+responses+' '+t('info.station_catalog_responses')+'</span><small>'+escapeHTML(catalog._sourceUrl||catalog._source||file.name)+'</small>';
      }catch(e){output.textContent=t('info.station_catalog_error')+': '+e.message;}
    };reader.readAsText(file);
  });
  if(useButton)useButton.addEventListener('click',function(){
    if(!imported||!Array.isArray(imported.stations)||!imported.stations.length)return;
    rawLandGrid=imported.stations.map(function(st,i){return {id:st.id||i,name:st.name||st.station,network:st.network,lat:Number(st.lat),lng:Number(st.lng),elevation:st.elevation_m,stationSource:'StationXML',channels:st.channels||[]};});
    TOTAL_STATIONS=rawLandGrid.length; buildGridCells();
    if(statusText)statusText.textContent=t('status.land_ok')+' - '+TOTAL_STATIONS+' '+t('info.station_catalog_stations');
    output.innerHTML+='<small>'+t('info.station_catalog_active')+'</small>'; useButton.disabled=true;
  });
})();
// Import an observed moment tensor and use it as the authoritative mechanism.
(function initMomentTensorImport(){
  var input=document.getElementById('moment-tensor-file'), out=document.getElementById('moment-tensor-result');
  if(!input||!out||typeof MomentTensor==='undefined') return;
  input.addEventListener('change',function(){
    var file=input.files&&input.files[0]; if(!file)return;
    var reader=new FileReader(); reader.onload=function(){
      try {
        var raw=String(reader.result||''), parsed=MomentTensor.parse(raw,{source:file.name});
        _deactivateObservedFiniteFault('mechanism-import');
        _observedMomentTensor=parsed; _polarityInversion=null;
        var fm=parsed.tensor&&Physics.focalMechanismFromTensor?Physics.focalMechanismFromTensor(parsed):null;
        if(!fm && parsed.plane1) fm=Physics.focalMechanism({strike:parsed.plane1.strike,dip:parsed.plane1.dip,rake:parsed.plane1.rake,mw:_liveMag});
        var selected=fm&&Physics.selectFaultPlane?Physics.selectFaultPlane(fm,{
          lat:epicenter&&epicenter.lat,lng:epicenter&&epicenter.lng,sourceType:activeSrcType()
        }):null;
        _observedFaultPlaneSelection=selected;
        var physicalPlane=selected?selected.plane:(fm&&fm.plane1);
        if(fm){
          currentRake=physicalPlane.rakeDeg; currentDip=physicalPlane.dipDeg;
          strikeSlider.value=physicalPlane.strikeDeg; strikeVal.textContent=physicalPlane.strikeDeg.toFixed(0)+'°';
          dipSlider.value=currentDip; if(dipVal) dipVal.textContent=currentDip.toFixed(0)+'°';
          rakeSlider.value=currentRake; if(rakeVal) rakeVal.textContent=currentRake.toFixed(0)+'°';
          var sn=document.getElementById('strike-num'),dn=document.getElementById('dip-num'),rn=document.getElementById('rake-num');
          if(sn)sn.value=physicalPlane.strikeDeg.toFixed(2); if(dn)dn.value=currentDip.toFixed(2); if(rn)rn.value=currentRake.toFixed(2);
          _dipExplicit=true;_rakeExplicit=true;
        }
        var quality=parsed.quality||{grade:'?',warnings:[]};
        out.innerHTML='<strong>'+escapeHTML(parsed.provenance.source||'observed')+' · '+escapeHTML(quality.grade)+'</strong><span>'+escapeHTML(parsed.provenance.eventId||file.name)+'</span><span>'+escapeHTML(parsed.provenance.coordinateSystemOriginal||'NED')+' → NED · '+escapeHTML(parsed.provenance.unitsOriginal||'Nm')+' → Nm</span>'
          +(selected?'<span>'+t('info.fault_plane_selected')+': NP'+selected.index+' · '+t('info.fault_plane_method_'+selected.method.replace(/-/g,'_'))+' · '+t('info.confidence_'+selected.confidence)+(selected.ambiguous?' · '+t('info.fault_plane_ambiguous'):'')+'</span>':'')
          +(quality.warnings&&quality.warnings.length?'<small>'+escapeHTML(quality.warnings.join(', '))+'</small>':'');
        renderFocalMechanismPanel({strike:physicalPlane?physicalPlane.strikeDeg:0,dip:physicalPlane?physicalPlane.dipDeg:90,rake:physicalPlane?physicalPlane.rakeDeg:0,mw:_liveMag,momentNm:parsed.momentNm||1,mechanismKnown:true,momentTensor:parsed});
        updateSimulationSummary();
      } catch(e) { _observedMomentTensor=null; _observedFaultPlaneSelection=null; out.textContent='Import error: '+e.message; }
    }; reader.readAsText(file);
  });
})();
function _finiteFaultWarningLabel(code){
  if(/^patch_\d+_corners_inferred$/.test(String(code||'')))code='patch_corners_inferred';
  if(/^patch_\d+_moment_slip_mismatch$/.test(String(code||'')))code='patch_moment_slip_mismatch';
  var key='info.finite_fault_warning_'+String(code||'').replace(/[^a-zA-Z0-9]+/g,'_');
  var translated=t(key);return translated===key?String(code):translated;
}
function _renderFiniteFaultImport(model,error){
  var out=document.getElementById('finite-fault-result'),useButton=document.getElementById('finite-fault-use'),clearButton=document.getElementById('finite-fault-clear');
  if(useButton)useButton.disabled=!model||!!error||isRunning;
  if(clearButton)clearButton.disabled=!_observedFiniteFault;
  if(!out)return;
  if(error){out.textContent=t('info.finite_fault_error')+': '+error;return;}
  if(!model){out.textContent='';return;}
  var g=model.geometry,q=model.quality||{},warnings=q.warnings||[],duration=(g.maxRuptureTime||0)+(model.patches.reduce(function(v,p){return Math.max(v,Number(p.riseTime)||0);},0));
  var residual=q.momentResidualFraction;
  out.innerHTML='<strong>'+escapeHTML(model.provenance.source||model.id)+' · '+escapeHTML(model.provenance.format||model.schema)+'</strong>'
    +(_observedFiniteFault===model?'<span class="finite-fault-active">'+escapeHTML(t('info.finite_fault_active'))+'</span>':'<span>'+escapeHTML(t('info.finite_fault_staged'))+'</span>')
    +'<span>'+escapeHTML(t('info.finite_fault_event'))+': '+escapeHTML(model.event.id||model.id)+'</span>'
    +'<span>'+model.patches.length+' '+escapeHTML(t('info.finite_fault_patches'))+'</span>'
    +'<span>Mw '+model.mw.toFixed(3)+' · M0 '+model.totalMomentNm.toExponential(4)+' Nm</span>'
    +'<span>'+escapeHTML(t('info.finite_fault_slip'))+': '+g.averageSlipM.toFixed(3)+' / '+g.maxSlipM.toFixed(3)+' m</span>'
    +'<span>'+escapeHTML(t('info.finite_fault_duration'))+': '+duration.toFixed(2)+' s</span>'
    +'<span>'+escapeHTML(t('info.finite_fault_residual'))+': '+(model.suppliedMomentNm>0?(residual*100).toFixed(2)+'%':'—')+'</span>'
    +'<span>'+escapeHTML(t('info.finite_fault_quality'))+': '+escapeHTML(q.researchReady?t('info.finite_fault_research_ready'):t('info.finite_fault_degraded'))+' ('+escapeHTML(q.grade||'?')+')</span>'
    +'<span>'+escapeHTML(model.provenance.url||t('info.finite_fault_url_missing'))+'</span>'
    +'<span>'+escapeHTML(model.provenance.license||t('info.finite_fault_license_missing'))+'</span>'
    +(warnings.length?'<small>'+warnings.map(_finiteFaultWarningLabel).map(escapeHTML).join(' · ')+'</small>':'');
}
function _deactivateObservedFiniteFault(reason){
  if(!_observedFiniteFault)return;
  _observedFiniteFault=null;
  _renderFiniteFaultImport(_pendingFiniteFault,null);
  if(reason&&statusText)statusText.textContent=t('info.finite_fault_deactivated');
}
// Activate a bundled observed finite-fault model for a preset (currently the
// 2011 Tohoku Hayes 2017 model). Mirrors the manual import "use" flow but
// keeps currentPreset intact so validation and bulletins stay preset-aware.
var _presetFaultModelCache = {};
// Resolve a bundled observed/scenario fault model by id for chain sub-events
// (shared cache with _activatePresetFaultModel; returns null when missing).
function _chainFaultModel(id){
  if(typeof ObservedFaultModels==='undefined'||typeof FiniteFault==='undefined')return null;
  var raw=ObservedFaultModels.get(id);
  if(!raw)return null;
  if(!_presetFaultModelCache[id])_presetFaultModelCache[id]=FiniteFault.parse(raw);
  return _presetFaultModelCache[id];
}
function _activatePresetFaultModel(id){
  if(typeof ObservedFaultModels==='undefined'||typeof FiniteFault==='undefined')return;
  var raw=ObservedFaultModels.get(id);
  if(!raw)return;
  try{
    var model=_presetFaultModelCache[id];
    if(!model){model=FiniteFault.parse(raw);_presetFaultModelCache[id]=model;}
    var event=model.event,plane=model.representativePlane;
    // The moment-weighted representative strike is axial (strike 198 reported
    // as 18); use the modal patch strike so the displayed plane stays
    // consistent with the patches' actual dip direction.
    var strikeVotes={},modalStrike=plane.strikeDeg,bestVotes=0;
    for(var vi=0;vi<model.patches.length;vi++){
      var patchStrike=model.patches[vi].strikeDeg;
      strikeVotes[patchStrike]=(strikeVotes[patchStrike]||0)+1;
      if(strikeVotes[patchStrike]>bestVotes){bestVotes=strikeVotes[patchStrike];modalStrike=patchStrike;}
    }
    setEpicenter(event.lat,event.lng);
    _observedFiniteFault=model;_pendingFiniteFault=model;
    _observedMomentTensor=null;_observedFaultPlaneSelection=null;_polarityInversion=null;
    _liveMag=model.mw;eventMw=model.mw;_liveDepth=event.depthKm;epicenterSrc=event.sourceType||null;
    currentDip=plane.dipDeg;currentRake=plane.rakeDeg;_dipExplicit=true;_rakeExplicit=true;
    magSlider.value=model.mw;depthSlider.value=event.depthKm;strikeSlider.value=modalStrike;
    dipSlider.value=plane.dipDeg;rakeSlider.value=plane.rakeDeg;
    var mn=document.getElementById('magnitude-num'),dn=document.getElementById('depth-num'),
        sn=document.getElementById('strike-num'),din=document.getElementById('dip-num'),rn=document.getElementById('rake-num');
    if(mn)mn.value=model.mw.toFixed(2);if(dn)dn.value=event.depthKm;if(sn)sn.value=modalStrike;
    if(din)din.value=plane.dipDeg.toFixed(1);if(rn)rn.value=plane.rakeDeg.toFixed(1);
    magVal.textContent='Mw'+model.mw.toFixed(2);depthVal.textContent=event.depthKm+' km';strikeVal.textContent=modalStrike.toFixed(1)+'°';
    if(dipVal)dipVal.textContent=plane.dipDeg.toFixed(1)+'°';if(rakeVal)rakeVal.textContent=plane.rakeDeg.toFixed(1)+'°';
    refreshDipStateLabel();refreshRakeStateLabel();updateEpicenterInfo();updateSimulationSummary();_redrawInfoCharts();
    if(typeof FiniteFaultEditor!=='undefined')FiniteFaultEditor.updateVisibility();
    renderFocalMechanismPanel({strike:modalStrike,dip:plane.dipDeg,rake:plane.rakeDeg,mw:model.mw,momentNm:model.totalMomentNm,mechanismKnown:true});
    _renderFiniteFaultImport(model,null);
    if(statusText)statusText.textContent=t('info.finite_fault_active');
  }catch(error){console.warn('preset fault model activation failed:',error);}
}
// Import an observed finite-fault model and use its exact patches as the
// authoritative source shared by Rrup, rupture animation, tsunami and 3-D.
(function initFiniteFaultImport(){
  var input=document.getElementById('finite-fault-file'),useButton=document.getElementById('finite-fault-use'),clearButton=document.getElementById('finite-fault-clear');
  if(!input||typeof FiniteFault==='undefined')return;
  var rawText='',fileName='';
  function provenance(){
    var out={},source=(document.getElementById('finite-fault-source')||{}).value,url=(document.getElementById('finite-fault-url')||{}).value,license=(document.getElementById('finite-fault-license')||{}).value;
    if(source&&source.trim())out.source=source.trim();if(url&&url.trim())out.url=url.trim();if(license&&license.trim())out.license=license.trim();return out;
  }
  function parseCurrent(){
    if(!rawText)return;
    try{
      _pendingFiniteFault=FiniteFault.parse(rawText,{provenance:provenance()});
      _renderFiniteFaultImport(_pendingFiniteFault,null);
    }catch(error){_pendingFiniteFault=null;_renderFiniteFaultImport(null,error.message);}
  }
  input.addEventListener('change',function(){var file=input.files&&input.files[0];if(!file)return;fileName=file.name;var reader=new FileReader();reader.onload=function(){rawText=String(reader.result||'');parseCurrent();};reader.readAsText(file);});
  ['finite-fault-source','finite-fault-url','finite-fault-license'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('change',parseCurrent);});
  if(useButton)useButton.addEventListener('click',function(){
    if(!_pendingFiniteFault||isRunning)return;
    var model=_pendingFiniteFault,event=model.event,plane=model.representativePlane;
    setEpicenter(event.lat,event.lng);
    _observedFiniteFault=model;_observedMomentTensor=null;_observedFaultPlaneSelection=null;_polarityInversion=null;
    currentPreset='';var preset=document.getElementById('preset');if(preset)preset.value='';
    _liveMag=model.mw;eventMw=model.mw;_liveDepth=event.depthKm;epicenterSrc=event.sourceType||null;
    currentDip=plane.dipDeg;currentRake=plane.rakeDeg;_dipExplicit=true;_rakeExplicit=true;
    magSlider.value=model.mw;depthSlider.value=event.depthKm;strikeSlider.value=plane.strikeDeg;dipSlider.value=plane.dipDeg;rakeSlider.value=plane.rakeDeg;
    var mn=document.getElementById('magnitude-num'),dn=document.getElementById('depth-num'),sn=document.getElementById('strike-num'),din=document.getElementById('dip-num'),rn=document.getElementById('rake-num');
    if(mn)mn.value=model.mw.toFixed(3);if(dn)dn.value=event.depthKm;if(sn)sn.value=plane.strikeDeg.toFixed(2);if(din)din.value=plane.dipDeg.toFixed(2);if(rn)rn.value=plane.rakeDeg.toFixed(2);
    magVal.textContent='Mw'+model.mw.toFixed(2);depthVal.textContent=event.depthKm+' km';strikeVal.textContent=plane.strikeDeg.toFixed(1)+'°';if(dipVal)dipVal.textContent=plane.dipDeg.toFixed(1)+'°';if(rakeVal)rakeVal.textContent=plane.rakeDeg.toFixed(1)+'°';
    refreshDipStateLabel();refreshRakeStateLabel();updateEpicenterInfo();updateSimulationSummary();_redrawInfoCharts();
    if(typeof FiniteFaultEditor!=='undefined')FiniteFaultEditor.updateVisibility();
    renderFocalMechanismPanel({strike:plane.strikeDeg,dip:plane.dipDeg,rake:plane.rakeDeg,mw:model.mw,momentNm:model.totalMomentNm,mechanismKnown:true});
    _renderFiniteFaultImport(model,null);statusText.textContent=t('info.finite_fault_active');
  });
  if(clearButton)clearButton.addEventListener('click',function(){_deactivateObservedFiniteFault('manual');});
})();
// Import first-motion polarity observations and estimate a DC mechanism locally.
(function initPolarityInversion(){
  var input=document.getElementById('polarity-inversion-file'), out=document.getElementById('polarity-inversion-result');
  if(!input||!out||!Physics.invertFocalMechanismPolarity) return;
  function parseCsv(raw){
    var lines=raw.replace(/^\uFEFF/,'').split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean); if(!lines.length)return [];
    var first=lines[0].split(/[,;\t]/).map(function(x){return x.trim().toLowerCase();}), hasHeader=first.some(function(x){return /azimuth|takeoff|polarity|first/.test(x);});
    var keys=hasHeader?first:['azimuth','takeoff','polarity','weight','station'], rows=[];
    for(var i=hasHeader?1:0;i<lines.length;i++){var vals=lines[i].split(/[,;\t]/).map(function(x){return x.trim();}), obj={}; for(var j=0;j<vals.length;j++)obj[keys[j]||('v'+j)]=vals[j]; rows.push(obj);} return rows;
  }
  function parse(raw,name){
    if(/\.json$/i.test(name)||/^\s*[\[{]/.test(raw)){var j=JSON.parse(raw); return Array.isArray(j)?j:(j.records||j.observations||j.polarities||[]);}
    return parseCsv(raw);
  }
  input.addEventListener('change',function(){var file=input.files&&input.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(){
    try{
      var rows=parse(String(reader.result||''),file.name), convention=(document.getElementById('polarity-takeoff-convention')||{}).value||'down', step=Number((document.getElementById('polarity-grid-step')||{}).value)||10; _polarityRecords=rows;
      var result=Physics.invertFocalMechanismPolarity(rows,{takeoffConvention:convention,coarseStep:step}); _deactivateObservedFiniteFault('mechanism-import'); _polarityInversion=result; _observedMomentTensor=null; _observedFaultPlaneSelection=null;
      currentRake=result.rakeDeg; currentDip=result.dipDeg; if(strikeSlider)strikeSlider.value=result.strikeDeg; if(dipSlider)dipSlider.value=result.dipDeg; if(rakeSlider)rakeSlider.value=result.rakeDeg;
      if(strikeVal)strikeVal.textContent=result.strikeDeg.toFixed(0)+'°'; if(dipVal)dipVal.textContent=result.dipDeg.toFixed(0)+'°'; if(rakeVal)rakeVal.textContent=result.rakeDeg.toFixed(0)+'°'; _rakeExplicit=true;
      out.innerHTML='<strong>'+t('info.polarity_solution')+'</strong><span>NP1 '+result.strikeDeg.toFixed(1)+'° · '+result.dipDeg.toFixed(1)+'° · '+result.rakeDeg.toFixed(1)+'°</span><span>'+t('info.polarity_fit')+': '+(100*(1-result.mismatchRate)).toFixed(1)+'% · '+result.usedRecords+'/'+(result.usedRecords+result.rejectedRecords)+' '+t('info.polarity_records')+'</span><span>'+t('info.polarity_confidence')+': '+result.confidence.level+' · ±'+result.confidence.radiusDeg.toFixed(1)+'°</span><small>'+t('info.polarity_limit')+'</small>';
      renderFocalMechanismPanel({strike:result.strikeDeg,dip:result.dipDeg,rake:result.rakeDeg,mw:_liveMag,momentNm:Physics.seismicMoment(_liveMag),mechanismKnown:true,polarityResult:result}); updateSimulationSummary();
    }catch(e){_polarityInversion=null;out.textContent=t('info.polarity_error')+': '+e.message;}
  };reader.readAsText(file);});
})();
document.getElementById('btn-help').addEventListener('click', function(){
  var ov = document.getElementById('help-overlay');
  if (ov) {
    var opening = ov.style.display !== 'flex';
    if (opening) openAccessibleModal('help-overlay', '#btn-help-close');
    else closeAccessibleModal('help-overlay');
    // v4.2: lazy-load help i18n on first help-open
    if (opening && typeof loadHelpI18n === 'function') loadHelpI18n();
  }
});
var btnFormulas = document.getElementById('btn-formulas');
if (btnFormulas) btnFormulas.addEventListener('click', function(){
  var ov = document.getElementById('formulas-overlay');
  if (ov) {
    var opening = ov.style.display !== 'flex';
    if (opening) openFormulaModal(); else closeFormulaModal();
    if (opening && typeof loadHelpI18n === 'function') loadHelpI18n();
  }
});
// Auto-focus button
var btnAF = document.getElementById('btn-autofocus');
if (btnAF) {
  btnAF.addEventListener('click', function() {
    var rtOn = (typeof RTData !== 'undefined' && RTData.isActive && RTData.isActive());
    if (!isRunning && !rtOn) return;
    _autoFocus = true; _userInteracted = false; _lastAutoFocusTime = 0;
    btnAF.classList.add('active');
    // realtime mode: kick the rt-data focus driver immediately
    if (!isRunning && rtOn && typeof RTData !== 'undefined' && RTData.refocusNow) RTData.refocusNow();
  });
}
// Map interaction: exit auto-focus (unless triggered by auto-focus itself)
map.on('movestart', function() { if (!_autoFocusMoving && _autoFocus) { _autoFocus = false; _userInteracted = true; if (btnAF) btnAF.classList.remove('active'); } });
var btnPresenterExit = document.getElementById('btn-presenter-exit');
if (btnPresenterExit) btnPresenterExit.addEventListener('click', exitPresenterMode);
var btnEewPageExit = document.getElementById('btn-eewpage-exit');
if (btnEewPageExit) btnEewPageExit.addEventListener('click', exitEewPage);
// Live toggle: over realtime monitoring the checkbox enters/exits immediately
// (while a sim runs, sim start/end owns presenter mode instead).
var presenterModeChk = document.getElementById('presenter-mode');
if (presenterModeChk) presenterModeChk.addEventListener('change', function() {
  if (isRunning) return;
  if (this.checked) { if (_presenterRtActive()) enterPresenterMode(); }
  else exitPresenterMode();
});

// --- Presenter tab recording (MediaRecorder over getDisplayMedia) ----------
// Records the whole tab — map, overlays and presenter panel included — to a
// downloadable .webm. This is what makes 直播/录制模式 an actual recorder.
var _recorder = null, _recChunks = [], _recStream = null, _recBtn = null;
function _presenterRecordSupported() {
  return typeof navigator !== 'undefined' && navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function' && typeof MediaRecorder !== 'undefined';
}
function _stopPresenterRecording(save) {
  if (!_recorder) return;
  var rec = _recorder;
  _recorder = null;
  rec.onstop = function() {
    if (_recStream) { _recStream.getTracks().forEach(function(tr) { tr.stop(); }); _recStream = null; }
    if (save && _recChunks.length) {
      var blob = new Blob(_recChunks, {type: rec.mimeType || 'video/webm'});
      var a = document.createElement('a');
      var stamp = new Date().toISOString().replace(/[:T]/g, '').replace(/\..*$/, '');
      a.href = URL.createObjectURL(blob);
      a.download = 'quakesim-' + stamp + '.webm';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function() { URL.revokeObjectURL(a.href); }, 5000);
    }
    _recChunks = [];
    if (_recBtn) { _recBtn.textContent = t('presenter.record'); _recBtn.classList.remove('recording'); }
  };
  try { rec.stop(); } catch (e) { rec.onstop(); }
}
function _togglePresenterRecording() {
  if (_recorder) { _stopPresenterRecording(true); return; }
  if (!_presenterRecordSupported()) { statusText.textContent = t('presenter.record_unsupported'); return; }
  navigator.mediaDevices.getDisplayMedia({video: {frameRate: 30}, audio: false}).then(function(stream) {
    _recStream = stream;
    var mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    _recChunks = [];
    _recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 6000000});
    _recorder.ondataavailable = function(e) { if (e.data && e.data.size) _recChunks.push(e.data); };
    // User ended the share from the browser UI → finalize the download.
    stream.getVideoTracks()[0].addEventListener('ended', function() { _stopPresenterRecording(true); });
    _recorder.start(1000);
    if (_recBtn) { _recBtn.textContent = t('presenter.record_stop'); _recBtn.classList.add('recording'); }
  }).catch(function() { /* user dismissed the picker — no-op */ });
}
_recBtn = document.getElementById('btn-presenter-record');
if (_recBtn) {
  if (_presenterRecordSupported()) _recBtn.hidden = false;
  _recBtn.addEventListener('click', _togglePresenterRecording);
}
map.on('zoomstart', function() { if (!_autoFocusMoving && _autoFocus) { _autoFocus = false; _userInteracted = true; if (btnAF) btnAF.classList.remove('active'); } });

// ---- Real-time earthquake monitoring mode ----
// ---- Real-time monitoring (unified USGS + P2PQuake) ----
var _rtMode = false, _rtTimer = null, _rtData = [], _rtSeen = {}, _rtSeenKeys = [];
var _rtUSGSLast = 0, _rtP2PLast = 0, _rtLiveSources = null, _p2pSource = null, _p2pReconnectTimeout = null, _p2pRetries = 0;
var _rtSkipCountdown = false, _rtRenderTimer = null, _rtFetching = false;
var _rtMapLayer = null, _rtMapMarkers = [];
var RT_MAX_SEEN = 200, RT_MAX_ITEMS = 15;
var RT_SRC_COLORS = {P2P:'#2ecc71', USGS:'#888', Wolfx:'#4af', WOLFX_EQ:'#4af', WOLFX_CENC:'#fa4',
  JMA:'#af4', 'JMA-Feed':'#fa4', EMSC:'#f80', P2PQUAKE:'#2ecc71',
  GEOFON:'#e74c3c', GEONET:'#1abc9c', CWA:'#f39c12'};

// Unified event format: {id, mag, lat, lng, depth, place, time, source, raw}
// All normalization, upsert, mark, delegation, and rendering functions are in rt-data.js

document.getElementById('btn-realtime').addEventListener('click', function() {
  if (typeof RTData === 'undefined' || typeof RTData.toggle !== 'function') {
    showScriptError('Real-time data module is unavailable');
    return;
  }
  _rtMode = RTData.toggle();
  this.classList.toggle('pulse', _rtMode);
  // Realtime stopped: drop the presenter bar too (unless a sim owns it).
  if (!_rtMode && !isRunning) exitPresenterMode();
});

// RT global state (used by rt-data.js)
var _rtLastHTML = '';
var _rtDelegated = false;
var RT_MAG_COLORS = ['#ffff00','#ffcc00','#ff9900','#ff6600','#ff3300','#ff0000','#cc0000','#990000'];

// Modal buttons: bind immediately when markup exists, otherwise after DOM ready.
function bindHelpModal(){
  var btnClose = document.getElementById('btn-help-close');
  var overlay = document.getElementById('help-overlay');
  if (btnClose && overlay && overlay.getAttribute('data-bound') !== '1') {
    overlay.setAttribute('data-bound', '1');
    btnClose.addEventListener('click', function(){ closeAccessibleModal('help-overlay'); });
    overlay.addEventListener('click', function(e){ if (e.target === overlay) closeAccessibleModal('help-overlay'); });
    overlay.addEventListener('keydown', function(e){ trapAccessibleModalKey(e, overlay, function(){ closeAccessibleModal('help-overlay'); }); });
    return true;
  }
  return false;
}
var _accessibleModalLastFocus = Object.create(null);
function openAccessibleModal(id, preferredSelector) {
  var overlay = document.getElementById(id);
  if (!overlay) return;
  _accessibleModalLastFocus[id] = document.activeElement;
  overlay.style.display = 'flex';
  setTimeout(function() {
    var preferred = preferredSelector ? overlay.querySelector(preferredSelector) : null;
    var panel = overlay.querySelector('[tabindex="-1"]');
    if (preferred) preferred.focus();
    else if (panel) panel.focus();
  }, 0);
}
function closeAccessibleModal(id) {
  var overlay = document.getElementById(id);
  if (!overlay || overlay.style.display === 'none') return;
  overlay.style.display = 'none';
  var previous = _accessibleModalLastFocus[id];
  if (previous && typeof previous.focus === 'function') previous.focus();
  delete _accessibleModalLastFocus[id];
}
function trapAccessibleModalKey(e, overlay, closeFn) {
  if (e.key === 'Escape') { e.preventDefault(); closeFn(); return; }
  if (e.key !== 'Tab') return;
  var nodes = overlay.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])');
  var focusable = Array.prototype.filter.call(nodes, function(node) {
    return node.offsetParent !== null && node.getAttribute('aria-hidden') !== 'true';
  });
  if (!focusable.length) { e.preventDefault(); return; }
  var first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
var _formulaLastFocus = null;
function setFormulaMode(mode) {
  var overlay = document.getElementById('formulas-overlay');
  if (!overlay) return;
  mode = mode === 'full' ? 'full' : 'basic';
  overlay.classList.toggle('formula-mode-full', mode === 'full');
  overlay.classList.toggle('formula-mode-basic', mode !== 'full');
  var buttons = overlay.querySelectorAll('.formula-mode-btn');
  for (var i = 0; i < buttons.length; i++) {
    var active = buttons[i].getAttribute('data-formula-mode') === mode;
    buttons[i].classList.toggle('active', active);
    buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  try { localStorage.setItem('qs-formula-mode', mode); } catch(e) {}
}
function openFormulaModal() {
  var overlay = document.getElementById('formulas-overlay');
  if (!overlay) return;
  _formulaLastFocus = document.activeElement;
  overlay.style.display = 'flex';
  var savedMode = 'basic';
  try { savedMode = localStorage.getItem('qs-formula-mode') || 'basic'; } catch(e) {}
  setFormulaMode(savedMode);
  setTimeout(function() {
    var panel = overlay.querySelector('.formulas-panel');
    if (panel) panel.focus();
  }, 0);
}
function closeFormulaModal() {
  var overlay = document.getElementById('formulas-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  overlay.style.display = 'none';
  if (_formulaLastFocus && typeof _formulaLastFocus.focus === 'function') _formulaLastFocus.focus();
  _formulaLastFocus = null;
}
function bindFormulaModal() {
  var overlay = document.getElementById('formulas-overlay');
  if (!overlay || overlay.getAttribute('data-bound') === '1') return false;
  overlay.setAttribute('data-bound', '1');
  var closeBtn = document.getElementById('btn-formulas-close');
  if (closeBtn) closeBtn.addEventListener('click', closeFormulaModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeFormulaModal();
  });
  var modeButtons = overlay.querySelectorAll('.formula-mode-btn');
  for (var i = 0; i < modeButtons.length; i++) {
    modeButtons[i].addEventListener('click', function() { setFormulaMode(this.getAttribute('data-formula-mode')); });
  }
  var tocLinks = overlay.querySelectorAll('.formula-toc a');
  for (var j = 0; j < tocLinks.length; j++) {
    tocLinks[j].addEventListener('click', function(e) {
      e.preventDefault();
      var target = document.querySelector(this.getAttribute('href'));
      if (!target) return;
      target.open = true;
      target.scrollIntoView({behavior:'smooth', block:'start'});
    });
  }
  var copyButtons = overlay.querySelectorAll('.formula-copy');
  for (var k = 0; k < copyButtons.length; k++) {
    copyButtons[k].addEventListener('click', function() {
      var code = document.getElementById(this.getAttribute('data-copy-target'));
      if (!code) return;
      var button = this, value = code.textContent;
      function copied() {
        button.textContent = t('formulas.copied');
        button.classList.add('copied');
        setTimeout(function() {
          button.textContent = t('formulas.copy');
          button.classList.remove('copied');
        }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(copied).catch(function(){ fallbackCopy(value, copied); });
      } else fallbackCopy(value, copied);
    });
  }
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeFormulaModal(); return; }
    if (e.key !== 'Tab') return;
    var focusable = overlay.querySelectorAll('button:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  return true;
}
function fallbackCopy(value, onDone) {
  var area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { if (document.execCommand('copy')) onDone(); } catch(e) {}
  document.body.removeChild(area);
}
if (!bindHelpModal()) window.addEventListener('DOMContentLoaded', bindHelpModal);
if (!bindFormulaModal()) window.addEventListener('DOMContentLoaded', bindFormulaModal);
if (!bindErrorOverlay()) window.addEventListener('DOMContentLoaded', bindErrorOverlay);
document.getElementById('multi-event-mode').addEventListener('change', function(){
  multiEventMode = this.checked;
  var presetRow = document.getElementById('me-preset-row');
  if (presetRow) presetRow.style.display = multiEventMode ? 'flex' : 'none';
  if (!multiEventMode) {
    customEvents = [];
    var info = document.getElementById('multi-event-info');
    if (info) { info.style.display = 'none'; info.innerHTML = ''; }
  } else {
    var info = document.getElementById('multi-event-info');
    if (info) { info.style.display = 'block'; info.textContent = 'Click map to add events (0 added)'; }
    _renderMultiEventList();
  }
});
// Populate the preset-to-chain picker (single-event presets only — chain
// presets are already complete scenarios).
(function initMePresetPicker() {
  var sel = document.getElementById('me-preset-select');
  if (!sel || typeof PRESETS === 'undefined') return;
  var mainSel = document.getElementById('preset');
  var html = '';
  for (var key in PRESETS) {
    if (PRESETS[key].subEvents) continue;
    var opt = mainSel ? mainSel.querySelector('option[value="' + key + '"]') : null;
    html += '<option value="' + key + '">' + escapeHTML(opt ? opt.textContent : key) + '</option>';
  }
  sel.innerHTML = html;
  var addBtn = document.getElementById('me-preset-add');
  if (addBtn) addBtn.addEventListener('click', function() { _addPresetToChain(sel.value); });
})();
document.getElementById('btn-pause').addEventListener('click', function(){
  if (!isRunning) return;
  isPaused = !isPaused;
  this.textContent = isPaused ? '▶' : '⏯';
  if (!isPaused) lastFrameTime = performance.now();
});
document.getElementById('btn-step').addEventListener('click', function(){
  if (!isRunning || !isPaused) return;
  simElapsed += 5;
  if (!lastFrameTime) lastFrameTime = performance.now();
});
// v4.3: Enhanced export — CSV + JSON + PNG via simple prompt
function _exportResults(format) {
  var snapshot = _lastResearchSnapshot || _captureResearchSnapshot();
  var exportStations = snapshot && snapshot.stations && snapshot.stations.length ? snapshot.stations : visibleCircles;
  if ((!exportStations || !exportStations.length) && format !== 'png') return;
  var ts = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  if (format === 'csv') {
    var hdr = 'name,lat,lng,peakPga,peakPgv,shindo,intensity,lpgm,pArrive,sArrive,sigmaPga,distKm\n';
    var rows = '';
    for (var i = 0; i < exportStations.length; i++) {
      var c = exportStations[i];
      var dist = epicenter ? Physics.haversineDist(epicenter.lat, epicenter.lng, c.lat, c.lng) : 0;
      rows += [(c.name||c.id), c.lat.toFixed(4), c.lng.toFixed(4), c.peakPga.toFixed(1),
        (c.peakPgv||0).toFixed(2), c.shindo, (c.intensity||0).toFixed(1), c.lpgm||0,
        (c.pArrive||0).toFixed(1), (c.sArrive||0).toFixed(1), (c.sigmaPga||0).toFixed(2),
        dist.toFixed(1)].join(',') + '\n';
    }
    var blob = new Blob([hdr+rows], {type:'text/csv'});
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'quake-sim-' + ts + '.csv'; a.click();
  } else if (format === 'json') {
    if (!snapshot) return;
    var blob2 = new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});
    var a2 = document.createElement('a'); a2.href = URL.createObjectURL(blob2);
    a2.download = (snapshot.experiment && snapshot.experiment.id || ('quake-sim-' + ts)) + '.json'; a2.click();
  } else {
    if (!waveCanvas) return;
    try {
      var pngData = waveCanvas.toDataURL('image/png');
      var a3 = document.createElement('a'); a3.href = pngData;
      a3.download = 'quake-sim-map-' + ts + '.png'; a3.click();
    } catch(e) { console.warn('PNG export failed:', e); }
  }
}
document.getElementById('btn-export').addEventListener('click', function(){
  var fmt = prompt((typeof t==='function'?t('export.prompt'):'Export format: csv / json / png'), 'csv');
  if (fmt) _exportResults(fmt.toLowerCase());
});

  // Catalog search button
  var btnCatSearch = document.getElementById('btn-catalog-search');
  if (btnCatSearch) btnCatSearch.addEventListener('click', searchCatalog);
  var btnLiveCat = document.getElementById('btn-live-catalog');
  if (btnLiveCat) btnLiveCat.addEventListener('click', function() {
    var list = document.getElementById('catalog-list');
    if (list) list.innerHTML = '<div style="color:#ff9900;text-align:center;padding:12px">加载中...</div>';
    var catMinMag = document.getElementById('cat-minmag');
    var minMag = catMinMag ? catMinMag.value : '4';
    fetch('/api/live-quakes?minMag=' + minMag + '&hours=168&limit=50')
      .then(function(r){return r.json();}).then(function(data){
        if (!data.ok || !data.data || !data.data.length) {
          if (list) list.innerHTML = '<div style="color:#888;text-align:center;padding:8px">暂无数据</div>'; return;
        }
        var h = '';
        for (var i = 0; i < Math.min(data.data.length, 30); i++) {
          var eq = data.data[i];
          var eqLat = Number(eq.lat), eqLng = Number(eq.lng), eqMag = Number(eq.mag);
          var eqDepth = Number(eq.depth == null ? 30 : eq.depth);
          if (!isFinite(eqLat) || !isFinite(eqLng) || !isFinite(eqMag) || !isFinite(eqDepth) ||
              eqLat < -90 || eqLat > 90 || eqLng < -180 || eqLng > 180) continue;
          var eqTime = Number(eq.time);
          var t = new Date(isFinite(eqTime) ? eqTime * 1000 : 0);
          var ts = (t.getMonth()+1)+'/'+t.getDate()+' '+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
          var srcs = Array.isArray(eq.sources) ? eq.sources.map(function(src){ return String(src); }).join(',') : '';
          h += '<div class="cat-item" style="padding:2px 4px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.06)" data-lat="'+eqLat+'" data-lng="'+eqLng+'" data-mag="'+eqMag+'" data-depth="'+eqDepth+'">'
            + '<b style="color:'+(eqMag>=7?'#f44':eqMag>=5?'#f90':'#ff0')+'">M'+eqMag.toFixed(1)+'</b> '
            + escapeHTML(eq.place || '') + ' <span style="color:#888;font-size:.85em">'+escapeHTML(ts)+'</span>'
            + '<span style="color:#4af;font-size:.7em;float:right">'+escapeHTML(srcs)+'</span></div>';
        }
        if (list) list.innerHTML = h;
        if (list) list.querySelectorAll('.cat-item').forEach(function(el){
          el.addEventListener('click', function(){
            setEpicenter(parseFloat(this.dataset.lat), parseFloat(this.dataset.lng));
            magSlider.value = this.dataset.mag; document.getElementById('magnitude-num').value = this.dataset.mag;
            magVal.textContent = 'M' + parseFloat(this.dataset.mag).toFixed(1);
            depthSlider.value = this.dataset.depth; depthVal.textContent = this.dataset.depth + ' km';
            map.setView([parseFloat(this.dataset.lat), parseFloat(this.dataset.lng)], 6);
            updateEpicenterInfo();
          });
        });
      }).catch(function(){ if (list) list.innerHTML = '<div style="color:#e74c3c;text-align:center;padding:8px">加载失败</div>'; });
  });
  // Replay button bindings
  var btnReplayBind = document.getElementById('btn-replay');
  if (btnReplayBind) {
    btnReplayBind.addEventListener('click', function(){ enterReplayMode(); });
  }
  var replaySlider = document.getElementById('replay-slider');
  if (replaySlider) {
    replaySlider.addEventListener('input', function(){
      updateReplayFrame(parseInt(this.value));
    });
  }
  var btnReplayExit = document.getElementById('btn-replay-exit');
  if (btnReplayExit) {
    btnReplayExit.addEventListener('click', function(){ exitReplayMode(); });
  }

// Slider → number sync
magSlider.addEventListener('input', function(){
  _deactivateObservedFiniteFault('event-parameter-change');
  document.getElementById('magnitude-num').value = magSlider.value;
  _liveMag = parseFloat(magSlider.value);
  // A manual magnitude edit turns the historical preset into a scenario
  // variant; do not keep using its hidden observed Mw for fault geometry.
  eventMw = null;
  magVal.textContent = 'M'+ _liveMag.toFixed(1);
  updateEpicenterInfo(); updateSimulationSummary(); _redrawInfoCharts();
});
depthSlider.addEventListener('input', function(){
  _deactivateObservedFiniteFault('event-parameter-change');
  document.getElementById('depth-num').value = depthSlider.value;
  _liveDepth = parseFloat(depthSlider.value);
  depthVal.textContent = depthSlider.value+' km';
  applyAutomaticDip();
  updateEpicenterInfo(); updateSimulationSummary(); _redrawInfoCharts();
  if(typeof FiniteFaultEditor!=='undefined'&&FiniteFaultEditor.drawPreview)FiniteFaultEditor.drawPreview();
});
strikeSlider.addEventListener('input', function(){
  _deactivateObservedFiniteFault('event-parameter-change');
  document.getElementById('strike-num').value = strikeSlider.value;
  strikeVal.textContent = strikeSlider.value+'°';
  updateEpicenterInfo(); _redrawInfoCharts();
  if(typeof FiniteFaultEditor!=='undefined'&&FiniteFaultEditor.drawPreview)FiniteFaultEditor.drawPreview();
});
dipSlider.addEventListener('input', function(){
  _deactivateObservedFiniteFault('event-parameter-change');
  document.getElementById('dip-num').value = dipSlider.value;
  currentDip = parseFloat(dipSlider.value);
  _dipExplicit = true; refreshDipStateLabel();
  updateEpicenterInfo();
  if(typeof FiniteFaultEditor!=='undefined'&&FiniteFaultEditor.drawPreview)FiniteFaultEditor.drawPreview();
});
rakeSlider.addEventListener('input', function(){
  _deactivateObservedFiniteFault('event-parameter-change');
  document.getElementById('rake-num').value = rakeSlider.value;
  currentRake = parseFloat(rakeSlider.value);
  _rakeExplicit = true;
  refreshRakeStateLabel();
  updateEpicenterInfo(); _redrawInfoCharts();
});
// Apply button → sync slider
function makeApply(rangeId, numId, valId, fmt){
  var r = document.getElementById(rangeId);
  var n = document.getElementById(numId);
  var disp = document.getElementById(valId);
  function setDisp(v){ disp.textContent = (typeof fmt === 'function') ? fmt(v) : fmt; }
  function clamp(v){ return Math.max(parseFloat(r.min), Math.min(parseFloat(r.max), v)); }
  // Live sync while typing: move the slider but don't rewrite the box mid-edit
  function live(){
    var v = parseFloat(n.value); if (isNaN(v)) return;
    _deactivateObservedFiniteFault('event-parameter-change');
    v = clamp(v);
    r.value = v; setDisp(v);
    if (rangeId === 'magnitude') { _liveMag = v; eventMw = null; }
    else if (rangeId === 'depth') _liveDepth = v;
    else if (rangeId === 'dip') { currentDip = v; _dipExplicit = true; refreshDipStateLabel(); }
    else if (rangeId === 'rake') { currentRake = v; _rakeExplicit = true; }
    updateEpicenterInfo(); updateSimulationSummary();
  }
  // Commit on blur / Enter / Apply button: normalize the box too
  function commit(){
    var v = parseFloat(n.value);
    if (isNaN(v)) { n.value = r.value; return; }
    _deactivateObservedFiniteFault('event-parameter-change');
    v = clamp(v);
    r.value = v; n.value = v; setDisp(v);
    if (rangeId === 'magnitude') { _liveMag = v; eventMw = null; }
    else if (rangeId === 'depth') _liveDepth = v;
    else if (rangeId === 'dip') { currentDip = v; _dipExplicit = true; refreshDipStateLabel(); }
    else if (rangeId === 'rake') { currentRake = v; _rakeExplicit = true; }
    updateEpicenterInfo(); updateSimulationSummary(); _redrawInfoCharts();
    if(rangeId==='magnitude'&&typeof FiniteFaultEditor!=='undefined')FiniteFaultEditor.updateVisibility();
  }
  n.addEventListener('input', live);
  n.addEventListener('change', commit);
  n.addEventListener('keydown', function(e){ if (e.key === 'Enter') commit(); });
  var btn = document.querySelector('.apply-btn[data-for="' + rangeId + '"]');
  if (btn) btn.addEventListener('click', commit);
}
makeApply('magnitude','magnitude-num','mag-val',function(v){return 'M'+parseFloat(v).toFixed(1);});
makeApply('depth','depth-num','depth-val',function(v){return v+' km';});
makeApply('strike','strike-num','strike-val',function(v){return v+'°';});
makeApply('dip','dip-num','dip-val',function(v){return v+'°';});
makeApply('rake','rake-num','rake-val',function(v){return v+'°';});
soundModeEl.addEventListener('change', function(){
  _stopEEWTTS(); _stopBulletinTTS();
  for(var k in audioCache)delete audioCache[k];
  preloadAudio();
});
var _ttsToggle = document.getElementById('tts-enable');
if (_ttsToggle) _ttsToggle.addEventListener('change', function(){
  if (!this.checked) { _stopEEWTTS(); _stopBulletinTTS(); }
});
document.addEventListener('keydown', function(e){
  if (e.code === 'Space' && !isRunning && !isCountingDown && epicenter) { e.preventDefault(); startCountdown(); }
  if (e.code === 'KeyR' && !isRunning && !isCountingDown) { e.preventDefault(); resetSimulation(); }
  if (e.code === 'Equal' || e.code === 'NumpadAdd') simSpeedEl.selectedIndex = Math.min(simSpeedEl.options.length-1, simSpeedEl.selectedIndex+1);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') simSpeedEl.selectedIndex = Math.max(0, simSpeedEl.selectedIndex-1);
});

document.getElementById('lang-select').addEventListener('change', function(){applyLanguage(this.value);});
['tsunami-enable','detect-mode','aftershock-enable','multi-event-mode'].forEach(function(id) {
  var el = document.getElementById(id); if (el) el.addEventListener('change', updateSimulationSummary);
});
var presetSummaryEl = document.getElementById('preset'); if (presetSummaryEl) presetSummaryEl.addEventListener('change', updateSimulationSummary);

// -- Tab switching --
(function(){
  var btns = document.querySelectorAll('.tab-btn');
  var content = document.getElementById('sidebar-content');
  var positions = {};
  function activate(btn, focus) {
    var current = document.querySelector('.tab-btn.active');
    if (current && content) positions[current.dataset.tab] = content.scrollTop;
    var panels = document.querySelectorAll('.tab-panel');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.remove('active'); btns[j].setAttribute('aria-selected', 'false'); btns[j].tabIndex = -1;
    }
    for (var k = 0; k < panels.length; k++) panels[k].classList.remove('active');
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); btn.tabIndex = 0;
    var panel = document.getElementById('tab-' + btn.dataset.tab);
    if (panel) panel.classList.add('active');
    try { localStorage.setItem('qs-sidebar-tab', btn.dataset.tab); } catch(e) {}
    if (content) requestAnimationFrame(function() { content.scrollTop = positions[btn.dataset.tab] || 0; });
    if (btn.dataset.tab === 'info' && typeof activateInfoView === 'function') activateInfoView();
    if (focus) btn.focus();
  }
  for (var i = 0; i < btns.length; i++) {
    btns[i].tabIndex = btns[i].classList.contains('active') ? 0 : -1;
    btns[i].addEventListener('click', function() { activate(this, false); });
    btns[i].addEventListener('keydown', function(e) {
      var idx = Array.prototype.indexOf.call(btns, this), next = idx;
      if (e.key === 'ArrowRight') next = (idx + 1) % btns.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = btns.length - 1;
      else return;
      e.preventDefault(); activate(btns[next], true);
    });
  }
  var saved = null;
  try { saved = localStorage.getItem('qs-sidebar-tab'); } catch(e) {}
  var savedBtn = saved && document.querySelector('.tab-btn[data-tab="' + saved + '"]');
  if (savedBtn) activate(savedBtn, false);
})();

// -- Advanced panel binding --
var _advMode = 'recommended', _advModifiedOnly = false;
var ADV_RECOMMENDED = {
  pWaveSpeed:1,sWaveSpeed:1,stressDrop:1,rupSpeed:1,ruptureVelocityModel:1,sourceTimeFunction:1,sourceTypeOverride:1,randomSeed:1,gmpModel:1,directivity:1,regionalQ:1,
  sigmaDisplay:1,sigmaOverride:1,siteModel:1,siteNonlinear:1,intensityScale:1,intensityMethod:1,updateHz:1,asyEventThr:1,
  maxAsEvents:1,etasEnable:1,etasAlpha:1,tsunamiSolver:1,tsunamiDeformationModel:1,tsunamiHorizontalSlope:1,tsunamiBoundary:1,tsunamiNested:1,tsunamiManning:1,tsunamiDryTolerance:1,tsunamiArrivalThreshold:1,tsunamiCoriolis:1,tsunamiAggregationKm:1,tsunamiAlertBias:1,tsunamiMapMode:1,alertMinMag:1,alertMaxDist:1,alertMinShindo:1
};
var ADV_OPTION_LABELS = {
  auto:'adv.opt.auto',crustal:'adv.opt.crustal',interplate:'adv.opt.interplate',intraslab:'adv.opt.intraslab',
  log:'adv.opt.log','si-midorikawa':'adv.opt.si','log-ff':'adv.opt.logff',kanno2006:'adv.opt.kanno',zhao2006:'adv.opt.zhao',
  vs30:'adv.opt.vs30',geo:'adv.opt.geo',none:'adv.opt.none',off:'adv.opt.off',on:'adv.opt.on',ss14:'adv.opt.ss14',
  somerville1997:'adv.opt.somerville',pgaOnly:'adv.opt.pga',pgaPgv:'adv.opt.pgagv',exceedance:'adv.opt.exceedance',
  shindo:'intensity.shindo',mmi:'intensity.mmi',ems98:'intensity.ems98',bilateral:'ff.bilateral',unilateral:'ff.unilateral',
  empirical:'adv.opt.empirical',jma3c:'adv.opt.jma3c',nonlinearSWE:'adv.opt.nonlinearSWE',linearSWE:'adv.opt.linearSWE',travelTime:'adv.opt.travelTime',
  dc3d:'adv.opt.dc3d',legacy:'adv.opt.legacy',radiation:'adv.opt.radiation',wall:'adv.opt.wall',
  'slip-depth':'adv.opt.slipDepth',depth:'adv.opt.depthVelocity',constant:'adv.opt.constantVelocity',
  'half-cosine':'adv.opt.halfCosine',triangle:'adv.opt.triangle',brune:'adv.opt.brune',boxcar:'adv.opt.boxcar',
  waveField:'adv.opt.waveField',maxSurface:'adv.opt.maxSurface',arrivalTime:'adv.opt.arrivalTime',maxVelocity:'adv.opt.maxVelocity',
  maxInundation:'adv.opt.maxInundation',cityInundation:'adv.opt.cityInundation',seafloorDeformation:'adv.opt.seafloorDeformation'
};
function advOptionText(value) { var key = ADV_OPTION_LABELS[value]; return key ? t(key) : value; }
function advIsModified(key) { return CFG_DEFAULTS[key] && cfgGet(key) !== CFG_DEFAULTS[key].v; }
function advDependencyEnabled(key) {
  if (['attA','attB','attC','pgvA','pgvB','pgvC'].indexOf(key) >= 0) return ['log','log-ff'].indexOf(cfgGet('gmpModel')) >= 0;
  if (['dsInter','dsIntra'].indexOf(key) >= 0) return ['auto','si-midorikawa'].indexOf(cfgGet('gmpModel')) >= 0;
  if (key === 'sigmaOverride') return cfgGet('sigmaDisplay') !== 'off';
  if (['siteSoftMax','siteHardMin','siteBase','siteNonlinear'].indexOf(key) >= 0) return cfgGet('siteModel') !== 'none';
  if (key === 'etasAlpha' || key === 'catalogCap') return Number(cfgGet('etasEnable')) === 1;
  if (['tsunamiManning','tsunamiDryTolerance','tsunamiArrivalThreshold','tsunamiCoriolis','tsunamiAggregationKm','tsunamiBoundary','tsunamiNested'].indexOf(key)>=0) return cfgGet('tsunamiSolver') === 'nonlinearSWE';
  if (['tsunamiDeformationModel','tsunamiHorizontalSlope'].indexOf(key)>=0) return cfgGet('tsunamiSolver') !== 'travelTime';
  return true;
}
function advRefreshUI() {
  var queryEl = document.getElementById('adv-search');
  var query = queryEl ? queryEl.value.trim().toLowerCase() : '';
  var modifiedCount = 0, visibleSections = 0;
  document.querySelectorAll('.adv-section').forEach(function(section) {
    var sectionModified = 0, visibleRows = 0;
    section.querySelectorAll('.adv-row[data-cfg]').forEach(function(row) {
      var key = row.dataset.cfg, modified = advIsModified(key);
      if (modified) { modifiedCount++; sectionModified++; }
      row.classList.toggle('modified', modified);
      var dependencyEnabled = advDependencyEnabled(key);
      row.classList.toggle('dependency-disabled', !dependencyEnabled);
      var label = row.querySelector('span:first-child');
      var text = ((label ? label.textContent : '') + ' ' + key).toLowerCase();
      var show = (!_advModifiedOnly || modified) && (_advMode === 'expert' || ADV_RECOMMENDED[key]) && (!query || text.indexOf(query) >= 0);
      row.hidden = !show;
      if (show) visibleRows++;
      var slider = row.querySelector('input[type="range"],input[type="number"]');
      if (slider) {
        slider.disabled = !dependencyEnabled;
        if (slider.type === 'range') {
          var pct = (Number(slider.value) - Number(slider.min)) / Math.max(.00001, Number(slider.max) - Number(slider.min)) * 100;
          slider.style.setProperty('--range-progress', Math.max(0, Math.min(100, pct)) + '%');
        }
      }
      var reset = row.querySelector('.adv-rst');
      if (reset) { reset.setAttribute('aria-label', t('adv.reset_one')); reset.title = t('adv.reset_one'); }
      var select = row.querySelector('select');
      if (select) { select.disabled = !dependencyEnabled; for (var oi=0; oi<select.options.length; oi++) select.options[oi].textContent = advOptionText(select.options[oi].value); }
    });
    var badge = section.querySelector('.adv-section-count');
    if (badge) { badge.textContent = sectionModified ? sectionModified : ''; badge.hidden = !sectionModified; }
    section.hidden = visibleRows === 0;
    if (visibleRows) visibleSections++;
  });
  var status = document.getElementById('adv-tab-status');
  if (status) { status.textContent = modifiedCount; status.hidden = modifiedCount === 0; }
  var empty = document.querySelector('.adv-empty');
  if (empty) empty.style.display = visibleSections ? 'none' : 'block';
}
function advFmtVal(def, key) {
  if (def.opts) return advOptionText(cfgGet(key));
  var v = cfgGet(key);
  if (key === 'tsunamiAlertBias') return Math.round(v) === 0 ? t('adv.tsunamiAlertBiasNone') : ('+' + Math.round(v) + ' ' + t('adv.tsunamiAlertBiasUnit'));
  return def.fmt.replace('%.1f', v.toFixed(1)).replace('%.2f', v.toFixed(2)).replace('%.0f', Math.round(v)).replace('%.4f', v.toFixed(4));
}
function advBind() {
  document.querySelectorAll('.adv-section').forEach(function(section, index) {
    var title = section.querySelector('.adv-title');
    if (!title) return;
    var titleKey = title.getAttribute('data-i18n'), titleText = title.textContent;
    title.removeAttribute('data-i18n'); title.textContent = '';
    var titleLabel = document.createElement('span'); titleLabel.className = 'adv-title-label'; titleLabel.textContent = titleText;
    if (titleKey) titleLabel.setAttribute('data-i18n', titleKey);
    title.appendChild(titleLabel);
    var body = document.createElement('div'); body.className = 'adv-section-body';
    while (title.nextSibling) body.appendChild(title.nextSibling);
    section.appendChild(body);
    var badge = document.createElement('span'); badge.className = 'adv-section-count'; badge.hidden = true; title.appendChild(badge);
    title.tabIndex = 0; title.setAttribute('role','button'); title.setAttribute('aria-expanded', index < 3 ? 'true' : 'false');
    if (index < 3) section.classList.add('open');
    function toggle() { section.classList.toggle('open'); title.setAttribute('aria-expanded', section.classList.contains('open') ? 'true' : 'false'); }
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  document.querySelectorAll('.adv-row[data-cfg]').forEach(function(row) {
    if (_advMode === 'recommended' && !ADV_RECOMMENDED[row.dataset.cfg]) row.hidden = true;
  });
  var empty = document.createElement('div'); empty.className = 'adv-empty'; empty.setAttribute('data-i18n','adv.no_results'); empty.textContent = t('adv.no_results');
  var resetAll = document.getElementById('adv-reset-all'); if (resetAll) resetAll.parentNode.insertBefore(empty, resetAll);
  document.querySelectorAll('.adv-row[data-cfg]').forEach(function(row) {
    var key = row.dataset.cfg;
    var valEl = row.querySelector('.adv-val');
    var rstBtn = row.querySelector('.adv-rst');
    var def = CFG_DEFAULTS[key];
    if (!def) return;
    var sel = row.querySelector('select');
    if (sel) {
      // Dropdown row (e.g. gmpModel, siteModel): populate from def.opts once
      if (!sel.options.length && def.opts)
        for (var oi = 0; oi < def.opts.length; oi++) {
          var o = document.createElement('option'); o.value = def.opts[oi]; o.textContent = advOptionText(def.opts[oi]); sel.appendChild(o);
        }
      sel.value = cfgGet(key);
      if (valEl) valEl.textContent = '';
      sel.addEventListener('change', function() {
        cfgSet(key, sel.value);
        if (key === 'sourceTypeOverride') applyAutomaticDip();
        if (key === 'sourceTypeOverride' && typeof FiniteFaultEditor!=='undefined') FiniteFaultEditor.drawPreview();
        if (key === 'tsunamiMapMode') {
          ensureTsunamiMapModeCompatible(sel.value);
          var mapSelect=document.getElementById('tsunami-layer-select');if(mapSelect)mapSelect.value=sel.value;
          if(sel.value!=='cityInundation')clearTsunamiZoneSelection(false);
          if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();if(typeof drawFrame==='function')drawFrame();
        }
        if (key === 'tsunamiSolver') applyTsunamiSolverCompatibility(sel.value);
        if (TSU_RUNTIME_CFG_KEYS.indexOf(key) >= 0) onTsunamiRuntimeConfigChanged();
        if (key === 'intensityScale') refreshDynamicUI();
        if (typeof redrawInfoCharts === 'function') redrawInfoCharts();
        advRefreshUI();
      });
      if (rstBtn) rstBtn.addEventListener('click', function() { cfgReset(key); sel.value = cfgGet(key); if(key==='tsunamiMapMode'){ensureTsunamiMapModeCompatible(sel.value);var mapSelect=document.getElementById('tsunami-layer-select');if(mapSelect)mapSelect.value=sel.value;if(sel.value!=='cityInundation')clearTsunamiZoneSelection(false);}if(key==='tsunamiSolver')applyTsunamiSolverCompatibility(sel.value);if(TSU_RUNTIME_CFG_KEYS.indexOf(key)>=0)onTsunamiRuntimeConfigChanged();advRefreshUI(); });
      return;
    }
    var slider = row.querySelector('input[type="range"],input[type="number"]');
    if (!slider) return;
    slider.min = def.min; slider.max = def.max; slider.step = def.step;
    slider.value = cfgGet(key);
    if (valEl) valEl.textContent = advFmtVal(def, key);
    slider.addEventListener('input', function() {
      cfgSet(key, parseFloat(slider.value));
      if (valEl) valEl.textContent = advFmtVal(def, key);
      advRefreshUI();
    });
    // Rebuilding solvers re-integrates from t=0, so do it once on release,
    // not on every 'input' tick while the slider is being dragged.
    slider.addEventListener('change', function() {
      if (TSU_RUNTIME_CFG_KEYS.indexOf(key) >= 0) onTsunamiRuntimeConfigChanged();
    });
    if (rstBtn) rstBtn.addEventListener('click', function() {
      cfgReset(key); slider.value = cfgGet(key);
      if (valEl) valEl.textContent = advFmtVal(def, key);
      if (TSU_RUNTIME_CFG_KEYS.indexOf(key) >= 0) onTsunamiRuntimeConfigChanged();
      advRefreshUI();
    });
  });
  document.getElementById('adv-reset-all').addEventListener('click', function() {
    if (!confirm(t('adv.confirm_reset'))) return;
    cfgResetAll();
    document.querySelectorAll('.adv-row[data-cfg]').forEach(function(row) {
      var key = row.dataset.cfg;
      var def = CFG_DEFAULTS[key];
      if (!def) return;
      var sel = row.querySelector('select');
      if (sel) { sel.value = cfgGet(key); return; }
      var slider = row.querySelector('input[type="range"],input[type="number"]');
      if (slider) slider.value = cfgGet(key);
      var valEl = row.querySelector('.adv-val');
      if (valEl) valEl.textContent = advFmtVal(def, key);
    });
    applyTsunamiSolverCompatibility(cfgGet('tsunamiSolver'));
    onTsunamiRuntimeConfigChanged();
    advRefreshUI();
  });
  document.querySelectorAll('.adv-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _advMode = btn.dataset.advMode;
      document.querySelectorAll('.adv-mode-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
      advRefreshUI();
    });
  });
  var search = document.getElementById('adv-search'); if (search) search.addEventListener('input', advRefreshUI);
  var modifiedBtn = document.getElementById('adv-modified-only');
  if (modifiedBtn) modifiedBtn.addEventListener('click', function() { _advModifiedOnly = !_advModifiedOnly; modifiedBtn.classList.toggle('active', _advModifiedOnly); modifiedBtn.setAttribute('aria-pressed', _advModifiedOnly ? 'true' : 'false'); advRefreshUI(); });
  var exportBtn = document.getElementById('adv-export');
  if (exportBtn) exportBtn.addEventListener('click', function() {
    var data = {}; for (var key in CFG_DEFAULTS) if (advIsModified(key)) data[key] = cfgGet(key);
    var blob = new Blob([JSON.stringify({version:1,settings:data}, null, 2)], {type:'application/json'});
    var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'quake-sim-settings.json'; a.click(); setTimeout(function(){URL.revokeObjectURL(url);},1000);
  });
  var importFile = document.getElementById('adv-import-file');
  if (importFile) importFile.addEventListener('change', function() {
    var file = importFile.files && importFile.files[0]; if (!file) return;
    var reader = new FileReader(); reader.onload = function() {
      try { var payload = JSON.parse(reader.result), settings = payload.settings || payload; for (var key in settings) if (CFG_DEFAULTS[key]) cfgSet(key, settings[key]); location.reload(); }
      catch(e) { alert(t('adv.import_invalid')); }
    }; reader.readAsText(file); importFile.value = '';
  });
  advRefreshUI();
}

// ShakeMap IDW interpolation
var smCanvas = null, smCtx = null, smLastTime = 0;

// [initShakeMap] removed — dead code (not called anywhere)

// [renderShakeMap] removed — dead code (not called anywhere)

// [drawShakeMapOverlay] removed — dead code (not called anywhere)

// Waveform synthesis + rendering
// v5.2: waveform signal model — one entry per sub-event that shakes a station
// (chain presets), or a single entry for single-event runs. Each entry carries
// its own arrivals/magnitude/peak so the synthesized trace reflects every
// event that actually reaches the station.
function _wfFindLandPoint(st) {
  if (!st || st.id == null) return null;
  var sid = String(st.id);
  for (var i = 0; i < landPoints.length; i++) {
    if (String(landPoints[i].id) === sid) return landPoints[i];
  }
  return null;
}
function _wfBuildSignals(st) {
  var lp = _wfFindLandPoint(st);
  var sigs = [];
  if (lp) {
    sigs.push({mag:(lp.sourceModel && lp.sourceModel.mw != null) ? lp.sourceModel.mw : _liveMag,
      pArrive:lp.pArrive, sArrive:lp.sArrive, peakPga:lp.peakPga});
    if (lp.subEvents) {
      for (var si = 0; si < lp.subEvents.length; si++) {
        var se = lp.subEvents[si];
        sigs.push({mag:se.mag, pArrive:se.pArrive, sArrive:se.sArrive, peakPga:se.peakPga});
      }
    }
  } else {
    // Station outside the computed grid (weak motion) — analytic fallback.
    var dist = hypoDist(st.lat, st.lng);
    sigs.push({mag:_liveMag, pArrive:dist / PW(), sArrive:dist / SW(), peakPga:calcPGA(_liveMag, dist)});
  }
  return sigs;
}
function _wfEnv(sig, tt) {
  if (tt < sig.pArrive) return 0;
  if (tt < sig.sArrive) return 0.1 + 0.9 * ((tt - sig.pArrive) / Math.max(sig.sArrive - sig.pArrive, 0.01));
  var ht = sig.mag * cfgGet('holdCoef'), ts2 = tauShort(sig.mag), tD = tt - sig.sArrive;
  if (tD < ht) return 1.0;
  var damp = cfgGet('waveformDamping') || 0.7;
  return Math.exp(-(tD - ht) / (ts2 * damp));
}
function _wfSynthAmp(signals, tt, noiseMag, useCache) {
  // Incoherent (SRSS) envelope superposition × Brune carrier — identical to
  // the legacy single-signal formula when signals.length === 1.
  var envSq = 0;
  for (var i = 0; i < signals.length; i++) {
    var env = _wfEnv(signals[i], tt);
    if (env > 0) { var a = signals[i].peakPga * env; envSq += a * a; }
  }
  if (envSq <= 0) return 0;
  return Math.sqrt(envSq) * _bruneSynthesize(tt, noiseMag, useCache);
}

function updateWaveform() {
  if (!wfCanvas) { wfCanvas = document.getElementById('waveform-canvas'); if (!wfCanvas) return; }
  if (!wfCtx) { wfCanvas.width = 320; wfCanvas.height = 100; wfCtx = wfCanvas.getContext('2d'); if (!wfCtx) return; }
  if (typeof _computeBruneCache === 'function') _computeBruneCache(wfStation);
  var _whp = window.hidpiPrepCanvas(wfCanvas), W = _whp.W, H = _whp.H;
  if (!wfStation) { wfCtx.fillStyle = '#000'; wfCtx.fillRect(0,0,W,H); wfCtx.fillStyle = '#666'; wfCtx.font = '10px monospace'; wfCtx.fillText('No station nearby', 10, H/2); return; }
  // v5.2 chain: retune the watched station to the currently-firing sub-event
  // (sample history resets — a fresh seismogram for the new event).
  var _wfd = uiDisplayParams();
  if (_wfd && _wfd.count > 1 && _wfd.idx !== _wfEventIdx) {
    _wfEventIdx = _wfd.idx;
    var bestD = Infinity; wfStation = null;
    for (var wi = 0; wi < rawLandGrid.length; wi++) {
      var wnd = Physics.hypoDist(rawLandGrid[wi].lat, rawLandGrid[wi].lng, _wfd.lat, _wfd.lng, _wfd.depth);
      if (wnd < bestD) { bestD = wnd; wfStation = rawLandGrid[wi]; }
    }
    wfSamples = []; wfMaxSample = 0; _wfSignals = null;
    if (!wfStation) { wfCtx.fillStyle = '#000'; wfCtx.fillRect(0,0,W,H); wfCtx.fillStyle = '#666'; wfCtx.font = '10px monospace'; wfCtx.fillText('No station nearby', 10, H/2); return; }
  }
  if (!_wfSignals) _wfSignals = _wfBuildSignals(wfStation);
  var dist = hypoDist(wfStation.lat, wfStation.lng);
  var t = simElapsed;
  // Find this station's circle data in visibleCircles
  var sc = wfStation.id != null ? (_visibleCircleById[String(wfStation.id)] || null) : null;
  var curPga = sc ? (sc.displayPga || sc.pga) : 0;

  // Generate samples since last frame (capped at 2000 to prevent death spiral)
  var sampRate = 50; // samples per simulated second
  var lastT = wfSamples.length > 0 ? wfSamples[wfSamples.length-1].t : 0;
  var newSampleStart = wfSamples.length;
  var dt = 1 / sampRate;
  var maxNewSamples = 2000;
  var _wfNoiseMag = _wfd ? _wfd.mag : _liveMag;
  while (lastT < t && maxNewSamples > 0) {
    lastT += dt; maxNewSamples--;
    // v5.2: SRSS superposition of every sub-event signal reaching the station
    // (single-event runs reduce to the legacy one-signal formula).
    var amp = _wfSynthAmp(_wfSignals, lastT, _wfNoiseMag, true);
    if (Math.abs(amp) > wfMaxSample) wfMaxSample = Math.abs(amp);
    wfSamples.push({t: lastT, a: amp});
  }
  // Superpose aftershock signals only on newly-created samples. Re-applying the
  // same aftershock to the retained 20-second window caused both O(N*M) work and
  // an artificial amplitude increase on every render.
  if (detectMode && aftershockEnabled && aftershockCatalog.length > 0) {
    var AS_TIME_SCALE_WF = 21600;
    if (!_wfAftershockSignalsReady) {
      _wfAftershockSignalsReady = true;
      var stationAmp = soilAmp(wfStation.lat, wfStation.lng);
      for (var ai = 0; ai < Math.min(aftershockCatalog.length, 30); ai++) {
        var as2 = aftershockCatalog[ai];
        var asSimTime = as2.time / AS_TIME_SCALE_WF;
        var asSurfaceDist = Physics.haversineDist(wfStation.lat, wfStation.lng, as2.lat, as2.lng);
        var asDist = Math.sqrt(asSurfaceDist * asSurfaceDist + as2.depth * as2.depth);
        var asPeakPga = calcPGA(as2.mag, asDist) * 0.82 * stationAmp;
        if (asPeakPga < 0.5) continue;
        _wfAftershockSignals.push({
          mag: as2.mag,
          pArrive: asSimTime + asDist / PW(),
          sArrive: asSimTime + asDist / SW(),
          peakPga: asPeakPga
        });
      }
    }
    for (var si2 = newSampleStart; si2 < wfSamples.length; si2++) {
      var st2 = wfSamples[si2].t;
      for (var ai2 = 0; ai2 < _wfAftershockSignals.length; ai2++) {
        var asSignal = _wfAftershockSignals[ai2];
        if (st2 < asSignal.pArrive) continue;
        var asEnv;
        if (st2 < asSignal.sArrive) {
          asEnv = 0.1 + 0.9 * ((st2 - asSignal.pArrive) / Math.max(asSignal.sArrive - asSignal.pArrive, 0.01));
        } else {
          var asHt2 = asSignal.mag * 2.5;
          var asTs2 = tauShort(asSignal.mag);
          var asTd2 = st2 - asSignal.sArrive;
          asEnv = asTd2 < asHt2 ? 1.0 : Math.exp(-(asTd2 - asHt2) / asTs2);
        }
        var asNoise = _bruneSynthesize(st2, asSignal.mag, false);
        wfSamples[si2].a += asSignal.peakPga * asEnv * asNoise * 0.35;
      }
    }
    // Recompute max sample
    wfMaxSample = 0;
    for (var si3 = 0; si3 < wfSamples.length; si3++) {
      var absA = Math.abs(wfSamples[si3].a);
      if (absA > wfMaxSample) wfMaxSample = absA;
    }
  }
  // Keep last 20 seconds of samples
  var cutoff = t - 20;
  var wfTrim = 0;
  while (wfTrim < wfSamples.length && wfSamples[wfTrim].t < cutoff) wfTrim++;
  if (wfTrim > 0) wfSamples.splice(0, wfTrim);

  // Draw (W, H already set above)
  wfCtx.fillStyle = '#000'; wfCtx.fillRect(0, 0, W, H);
  if (wfSamples.length < 2) { wfCtx.fillStyle = '#666'; wfCtx.font = '10px monospace'; wfCtx.fillText('Waiting for P-wave...', 10, H/2); return; }

  // Grid
  wfCtx.strokeStyle = '#222'; wfCtx.lineWidth = 0.5;
  wfCtx.beginPath(); wfCtx.moveTo(0, H/2); wfCtx.lineTo(W, H/2); wfCtx.stroke();

  // Waveform
  var tMin = wfSamples[0].t, tMax = wfSamples[wfSamples.length-1].t;
  var tRange = Math.max(tMax - tMin, 1);
  var scale = wfMaxSample > 0 ? (H/2 - 8) / wfMaxSample : 1;
  wfCtx.strokeStyle = '#4da6ff'; wfCtx.lineWidth = 1.2;
  wfCtx.beginPath();
  for (var i = 0; i < wfSamples.length; i++) {
    var sx = (wfSamples[i].t - tMin) / tRange * W;
    var sy = H/2 - wfSamples[i].a * scale;
    if (i === 0) wfCtx.moveTo(sx, sy); else wfCtx.lineTo(sx, sy);
  }
  wfCtx.stroke();

  // v5.2: P/S arrival ticks for every contributing sub-event (chain runs)
  if (_wfSignals && _wfSignals.length > 1) {
    wfCtx.lineWidth = 1;
    for (var wti = 0; wti < _wfSignals.length; wti++) {
      var tickTimes = [_wfSignals[wti].pArrive, _wfSignals[wti].sArrive];
      var tickColors = ['rgba(77,166,255,0.55)', 'rgba(255,159,67,0.55)'];
      for (var wtk = 0; wtk < 2; wtk++) {
        var tt2 = tickTimes[wtk];
        if (tt2 < tMin || tt2 > tMax) continue;
        var tx2 = (tt2 - tMin) / tRange * W;
        wfCtx.strokeStyle = tickColors[wtk];
        wfCtx.beginPath(); wfCtx.moveTo(tx2, 0); wfCtx.lineTo(tx2, 12); wfCtx.stroke();
      }
    }
  }

  // Labels
  wfCtx.fillStyle = '#888'; wfCtx.font = '9px monospace';
  wfCtx.fillText('PGA:'+(curPga>=100?Math.round(curPga):curPga.toFixed(1))+'gal', 4, 10);
  wfCtx.fillText('t='+t.toFixed(1)+'s', W-55, 10);
  wfCtx.fillText(wfStation.name || ('Sta#'+wfStation.id), 4, H-4);
}

// Intensity table: JMA-style Shindo report for major cities
function updateIntensityTable() {
  var tbl = document.getElementById('intensity-table');
  if (!tbl || !isRunning) return;
  // Collect cities with shindo data
  var cities = [];
  for (var i = 0; i < visibleCircles.length; i++) {
    var c = visibleCircles[i];
    if (c.name && c.shindo !== 0) cities.push({name:c.name, shindo:c.shindo, pga:c.displayPga||c.pga});
  }
  if (!cities.length) { tbl.classList.remove('show'); return; }
  // Sort by shindo descending, take top 20
  cities.sort(function(a,b){ return Physics.shindoScore(b.shindo)-Physics.shindoScore(a.shindo); });
  cities = cities.slice(0, 20);
  // Build table
  var h = '<table><tr><th>' + t('info.city') + '</th><th>' + t('info.shindo') + '</th><th>PGA</th></tr>';
  for (var i = 0; i < cities.length; i++) {
    var ct = cities[i];
    var fill = SHINDO_FILL[ct.shindo] || '#888';
    h += '<tr><td>' + escapeHTML(ct.name) + '</td>'
      + '<td><span class="shindo-cell" style="background:' + fill + ';color:#fff">' + ct.shindo + '</span></td>'
      + '<td>' + (ct.pga >= 100 ? Math.round(ct.pga) : ct.pga.toFixed(1)) + ' gal</td></tr>';
  }
  h += '</table>';
  if (tbl._renderedHtml !== h) {
    tbl._renderedHtml = h;
    tbl.innerHTML = h;
  }
  tbl.classList.add('show');
}

// Per-prefecture forecast table: top ~20 prefectures by predicted shindo from
// the live GMPE forecast (_predictedPrefectureShindos — already merged across
// detect tracks), each row with the ±1σ model-uncertainty band. PLUM-merged
// rows carry no numeric intensity (.i), so their range cell stays empty.
// Visible only while a sim runs with a non-empty forecast.
function updatePrefForecastTable() {
  var card = document.getElementById('pref-forecast-card');
  var tbl = document.getElementById('pref-forecast-table');
  if (!card || !tbl) return;
  var rows = [];
  if (isRunning) {
    for (var pid in _predictedPrefectureShindos) rows.push(_predictedPrefectureShindos[pid]);
  }
  if (!rows.length) {
    if (tbl._renderedHtml !== '') { tbl._renderedHtml = ''; tbl.innerHTML = ''; }
    card.style.display = 'none';
    return;
  }
  // Sort by shindo descending, take top 20
  rows.sort(function(a,b){ return Physics.shindoScore(b.shindo)-Physics.shindoScore(a.shindo); });
  rows = rows.slice(0, 20);
  var h = '<table><tr><th>' + t('info.pref') + '</th><th>' + t('info.shindo') + '</th><th>' + t('info.range_1sigma') + '</th><th>' + t('info.lpgm') + '</th></tr>';
  for (var i = 0; i < rows.length; i++) {
    var it = rows[i];
    var fill = SHINDO_FILL[it.shindo] || '#888';
    var range = '';
    if (it.i != null && typeof Physics.shindoUncertaintyRange === 'function') {
      var ur = Physics.shindoUncertaintyRange(it.i);
      if (ur) range = '(' + ur.lowLabel + '~' + ur.highLabel + ')';
    }
    // Forecast rows carry lpgm from _predictPrefectureShindosFor; PLUM-merged
    // rows have no forecast field and show a dash, same as the range cell.
    h += '<tr><td>' + escapeHTML(it.nam_ja || it.nam) + '</td>'
      + '<td><span class="shindo-cell" style="background:' + fill + ';color:#fff">' + it.shindo + '</span></td>'
      + '<td>' + range + '</td>'
      + '<td>' + (it.lpgm >= 1 ? 'L' + it.lpgm : '—') + '</td></tr>';
  }
  h += '</table>';
  if (tbl._renderedHtml !== h) {
    tbl._renderedHtml = h;
    tbl.innerHTML = h;
  }
  card.style.display = '';
}

// Intensity curve: real-time Shindo vs time for nearest station
function updateIntensityCurve() {
  if (!intensityCanvas) { intensityCanvas = document.getElementById('intensity-canvas'); if (!intensityCanvas) return; }
  if (!intensityCtx) { intensityCanvas.width = 320; intensityCanvas.height = 80; intensityCtx = intensityCanvas.getContext('2d'); if (!intensityCtx) return; }
  var W = intensityCanvas.width, H = intensityCanvas.height;
  if (!wfStation) { intensityCtx.fillStyle = '#000'; intensityCtx.fillRect(0, 0, W, H); intensityCtx.fillStyle = '#666'; intensityCtx.font = '10px monospace'; intensityCtx.fillText('No station nearby', 10, H/2); return; }

  // Sample current shindo for nearest station (once per sim-second)
  var curSec = Math.floor(simElapsed);
  if (intensitySamples.length === 0 || intensitySamples[intensitySamples.length - 1].t < curSec) {
    var curCircle = wfStation.id != null ? _visibleCircleById[String(wfStation.id)] : null;
    var curSh = curCircle ? curCircle.shindo : 0;
    intensitySamples.push({ t: curSec, shindo: curSh });
    // Keep last 90 seconds
    while (intensitySamples.length > 0 && intensitySamples[0].t < curSec - 90) intensitySamples.shift();
  }

  // Draw
  intensityCtx.fillStyle = '#000'; intensityCtx.fillRect(0, 0, W, H);
  if (intensitySamples.length < 2) { intensityCtx.fillStyle = '#666'; intensityCtx.font = '10px monospace'; intensityCtx.fillText('Waiting for P-wave...', 10, H/2); return; }

  // Horizontal grid lines for shindo levels
  var levels = [1, 2, 3, 4, 5, 6, 7];
  var fills = [null, '#a0d2f0', '#6cb4ee', '#2ecc71', '#f1c40f', '#e74c3c', '#8e44ad', '#6c0f1f'];
  for (var li = 0; li < levels.length; li++) {
    var lv = levels[li];
    var gy = H - 4 - (lv / 7) * (H - 16);
    intensityCtx.strokeStyle = fills[lv] || '#444'; intensityCtx.lineWidth = 0.5; intensityCtx.globalAlpha = 0.35;
    intensityCtx.beginPath(); intensityCtx.moveTo(0, gy); intensityCtx.lineTo(W, gy); intensityCtx.stroke();
    intensityCtx.globalAlpha = 1;
    intensityCtx.fillStyle = fills[lv] || '#888'; intensityCtx.font = '7px monospace';
    intensityCtx.fillText(lv, 2, gy - 2);
  }

  // Plot curve
  var tMin = intensitySamples[0].t, tMax = intensitySamples[intensitySamples.length - 1].t;
  var tRange = Math.max(tMax - tMin, 1);
  var barW = Math.max(1, W / intensitySamples.length);
  for (var i = 0; i < intensitySamples.length; i++) {
    var s = intensitySamples[i];
    var sh = s.shindo;
    if (sh === 0) continue;
    var sx = (s.t - tMin) / tRange * W;
    var shNum = typeof sh === 'number' ? sh : Physics.shindoScore(sh);
    var sy = H - 4 - (shNum / 7) * (H - 16);
    var fill = SHINDO_FILL[sh] || '#a0d2f0';
    intensityCtx.fillStyle = fill;
    intensityCtx.fillRect(sx - barW/2, sy - barW/2, barW, barW);
  }

  // Connect dots with line
  var firstPt = true;
  intensityCtx.strokeStyle = 'rgba(255,255,255,0.6)'; intensityCtx.lineWidth = 1;
  intensityCtx.beginPath();
  for (var i = 0; i < intensitySamples.length; i++) {
    var s = intensitySamples[i];
    var shNum = typeof s.shindo === 'number' ? s.shindo : Physics.shindoScore(s.shindo);
    var sx = (s.t - tMin) / tRange * W;
    var sy = H - 4 - (shNum / 7) * (H - 16);
    if (firstPt) { intensityCtx.moveTo(sx, sy); firstPt = false; }
    else intensityCtx.lineTo(sx, sy);
  }
  intensityCtx.stroke();

  // Labels
  var last = intensitySamples[intensitySamples.length - 1];
  intensityCtx.fillStyle = '#888'; intensityCtx.font = '9px monospace';
  intensityCtx.fillText(t('info.intensity_curve') + ': ' + last.shindo, 4, 10);
  intensityCtx.fillText('t=' + last.t + 's', W - 55, 10);
}

// --- Info-panel formatting helpers ---
var _SUP={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻'};
function infoRow(label,val){ return '<div class="info-row"><span class="info-label">'+label+'</span><span class="info-val">'+val+'</span></div>'; }

// Info panel update (called from simLoop)
function updateInfoPanel(curMaxPga, curMaxSh) {
  if (!isRunning) return;
  refreshCanvasA11yDescriptions(curMaxPga, curMaxSh);
  var html = '';

  // --- Source parameters ---
  if (epicenter) {
    // v5.2: chain presets present the currently-firing sub-event via
    // uiDisplayParams(); single-event runs resolve to the live globals,
    // so behavior is unchanged.
    var dp=uiDisplayParams()||{lat:epicenter.lat,lng:epicenter.lng,mag:_liveMag,depth:_liveDepth,
      strike:parseFloat(strikeSlider.value),dip:currentDip,rake:currentRake,srcType:activeSrcType(),
      mw:(eventMw!=null?eventMw:_liveMag),originTime:0,idx:0,count:1,ev:null,sourceModel:null};
    var mS = dp.mag, infoMain=dp.ev||mainEvent(), infoSource=dp.sourceModel||(infoMain&&infoMain.sourceModel);
    var mw = infoSource ? infoSource.mw : dp.mw;
    var M0 = infoSource ? infoSource.momentNm : Physics.seismicMoment(mw);
    renderFocalMechanismPanel({strike:infoSource?infoSource.strikeDeg:dp.strike,
      dip:infoSource?infoSource.dipDeg:dp.dip,rake:infoSource?infoSource.rakeDeg:dp.rake,
      mw:mw,momentNm:M0,
      mechanismKnown:(dp.ev&&dp.ev.mechanismKnown!=null)?dp.ev.mechanismKnown:_rakeExplicit,
      momentTensor:(dp.count>1)?(dp.ev&&dp.ev.momentTensor)||null:_observedMomentTensor,
      faultPlaneSelection:infoSource&&infoSource.faultPlaneSelection,
      eventTag:dp.count>1?(t('info.event_of').replace('{i}',dp.idx+1).replace('{n}',dp.count)+' · M'+dp.mag.toFixed(1)+' · t='+Math.round(dp.originTime)+'s'):null});
    var eJ = Math.pow(10, 1.5*mw + 4.8); // radiated-energy proxy (J)
    html += '<div class="info-hdr">' + t('info.source') + '</div>';
    html += infoRow(t('info.epicenter'), dp.lat.toFixed(2)+'°N '+dp.lng.toFixed(2)+'°E');
    html += infoRow(t('info.depth'), dp.depth+' km · '+dp.srcType);
    html += infoRow(t('info.magnitude'), 'M'+mS.toFixed(1) + (Math.abs(mw-mS)>0.05 ? ' <span style="color:var(--text-secondary)">(Mw '+mw.toFixed(2)+')</span>' : ''));
    html += infoRow(t('info.strike'), (infoSource?infoSource.strikeDeg.toFixed(1):dp.strike)+'°');
    html += infoRow(t('info.seismic_moment'), Physics.fmtSci(M0)+' N·m');
    html += infoRow(t('info.energy'), Physics.fmtSci(eJ)+' J · '+Physics.fmtTNT(eJ/4.184e9)+' TNT');
    if(infoSource&&infoSource.faultPlaneSelection){var fps=infoSource.faultPlaneSelection;
      html += infoRow(t('info.fault_plane_selected'),'NP'+fps.index+' · '+t('info.fault_plane_method_'+fps.method.replace(/-/g,'_'))+' · '+t('info.confidence_'+fps.confidence));}
    if (mw >= 6.5) {
      var infoGeom=infoSource&&infoSource.geometry;
      if(!infoGeom)infoGeom=Physics.genSubSources(dp.lat,dp.lng,mw,
        dp.strike,dp.dip,dp.depth,cfgGet('rupSpeed'),_faultOpts(dp.srcType));
      if (infoGeom) {
        html += infoRow(t('info.rupture'), Math.round(infoGeom.L)+'×'+Math.round(infoGeom.W)+' km · '+Math.round(infoGeom.L*infoGeom.W).toLocaleString()+' km²');
        html += infoRow(t('info.dip_rake'), dp.dip+'°'+((dp.count>1||_dipExplicit)?'':' ('+t('rake.auto')+')')+' / '+dp.rake+'°'+((dp.count>1||_rakeExplicit)?'':' ('+t('rake.auto')+')'));
        html += infoRow(t('info.subsources'), infoGeom.nStrike+'×'+infoGeom.nDip+' · '+infoGeom.nSub+' patches · '+(infoGeom.L/infoGeom.nStrike).toFixed(1)+'×'+(infoGeom.W/infoGeom.nDip).toFixed(1)+' km');
        html += infoRow(t('info.fault_scaling'),escapeHTML(infoGeom.scalingRelation));
        html += infoRow(t('info.fault_slip'),infoGeom.averageSlipM.toFixed(2)+' / '+infoGeom.maxSlipM.toFixed(2)+' m');
        html += infoRow(t('info.fault_aspect'),infoGeom.aspectRatio.toFixed(2));
        if(infoGeom.widthTruncated)html += infoRow(t('info.fault_quality'),'<span class="science-warning">'+t('ff.depth_limited')+' · '+Math.round(infoGeom.widthRatio*100)+'%</span>');
      }
    }
    html += infoRow(t('info.elapsed'), simElapsed.toFixed(1)+' s');
    // --- Fault rupture progress (M≥6.5 only) ---
    if (mw >= 6.5 && rupturePolyEntries.length > 0) {
      var ruptureState=Physics.ruptureState(infoGeom,Math.max(0,simElapsed-dp.originTime)),maxRT=ruptureState.endTime,
        ruptured=ruptureState.activePatches,releasedMoment=ruptureState.releasedMomentFraction,
        ruptureSubs=infoGeom&&infoGeom.subs?infoGeom.subs:[],rupPct=100*releasedMoment;
      html += '<br><div class="info-hdr">' + t('info.fault_rupture') + '</div>';
      html += infoRow(t('info.rupture_progress'),
        '<span style="display:inline-block;width:80px;height:8px;background:#333;border-radius:3px;vertical-align:middle">' +
        '<span style="display:inline-block;width:'+Math.round(rupPct*0.8)+'px;height:100%;background:' +
        (rupPct < 30 ? '#e74c3c' : rupPct < 80 ? '#f1c40f' : '#2ecc71') + ';border-radius:3px"></span></span> ' +
        Math.round(rupPct)+'%');
      html += infoRow(t('info.active_subsources'), ruptured + ' / ' + ruptureSubs.length);
      html += infoRow(t('info.max_rupture_time'), maxRT.toFixed(1) + ' s');
      html += infoRow(t('info.hypocenter_pos'), Math.round(infoGeom.hypocenterStrikeFrac*100)+'% / '+Math.round(infoGeom.hypocenterDipFrac*100)+'%');
      html += infoRow(t('info.rupture_ramp'), releasedMoment.toFixed(3)+' M₀');
    }
  }

  // --- single pass over active stations for all aggregates ---
  var _sdp = uiDisplayParams();
  if (_sdp && _sdp.count > 1) {
    // v5.2 chain: status bar follows the currently-firing sub-event
    statusText.textContent = t('status.running') + ' - ' +
      t('info.event_of').replace('{i}', _sdp.idx + 1).replace('{n}', _sdp.count) +
      ' M' + _sdp.mag.toFixed(1) + ' ' + _sdp.depth + 'km';
  }
  var dist={}, totalActive=0, maxPgv=0, maxLpgm=0, maxCity='—', maxScore=-1, nStrong=0, nSevere=0;
  for (var i=0;i<visibleCircles.length;i++){
    var c=visibleCircles[i], s=c.shindo;
    if (c.pgv>maxPgv) maxPgv=c.pgv;
    if (c.lpgm>maxLpgm) maxLpgm=c.lpgm;
    if (s!==0){
      dist[s]=(dist[s]||0)+1; totalActive++;
      var sk=Physics.shindoScore(s);
      if (sk>=4.75) nStrong++;          // ≥ Shindo 5-
      if (sk>=5.75) nSevere++;          // ≥ Shindo 6-
      if (sk>maxScore){ maxScore=sk; maxCity=c.name||('#'+c.id); }
    }
  }

  // --- Ground motion (peak) ---
  html += '<br><div class="info-hdr">' + t('info.ground_motion') + '</div>';
  html += infoRow(t('info.max_pga'), (curMaxPga>=100?Math.round(curMaxPga):curMaxPga.toFixed(1))+' gal');
  html += infoRow(t('info.max_pgv'), maxPgv.toFixed(1)+' cm/s');
  html += infoRow(t('info.estimated_intensity'), '<span style="color:'+(SHINDO_FILL[curMaxSh]||'#fff')+';font-weight:700">'+escapeHTML(formatIntensity(curMaxSh))+'</span> @ '+maxCity);
  html += infoRow(t('info.max_lpgm'), maxLpgm>0 ? ('class '+maxLpgm) : '—');

  // --- Wave front ---
  html += '<br><div class="info-hdr">' + t('info.wave_front') + '</div>';
  html += infoRow(t('info.p_radius'), (pRadius>0?Math.round(pRadius):0)+' km');
  html += infoRow(t('info.s_radius'), (sRadius>0?Math.round(sRadius):0)+' km');
  html += infoRow(t('info.warning_band'), Math.max(0,Math.round(pRadius-sRadius))+' km (P arrived, S pending)');

  // --- Intensity distribution (bars) ---
  html += '<br><div class="info-hdr">' + t('info.intensity') + '</div>';
  var levels=[7,'6+','6-','5+','5-',4,3,2,1], maxCnt=0;
  for (var li=0;li<levels.length;li++){ var c2=dist[levels[li]]||0; if(c2>maxCnt)maxCnt=c2; }
  for (var li=0;li<levels.length;li++){
    var lv=levels[li], cnt=dist[lv]||0, fill=SHINDO_FILL[lv]||'#888';
    var barW=maxCnt>0?Math.round(cnt/maxCnt*110):0;
    html += '<div style="display:flex;align-items:center;gap:4px;margin:1px 0;font-size:.9em">'
         +  '<span style="width:24px;text-align:right;color:#fff;font-weight:700">'+lv+'</span>'
         +  '<span style="display:inline-block;width:'+barW+'px;height:12px;background:'+fill+';border-radius:2px"></span>'
         +  '<span style="color:var(--text-secondary);font-size:.85em">'+cnt+'</span></div>';
  }
  html += infoRow(t('info.felt'), totalActive+' cities');
  html += infoRow(t('info.strong'), nStrong+' cities');
  html += infoRow(t('info.severe'), nSevere+' cities');

  // --- Coverage / area ---
  var cellKm=0.5*111.0, cellArea=cellKm*cellKm*Math.cos((epicenter?epicenter.lat:36)*Math.PI/180);
  var cells=Object.keys(activeGridCells).length;
  html += '<br><div class="info-hdr">' + t('info.coverage') + '</div>';
  html += infoRow(t('info.shaking_cells'), cells);
  html += infoRow(t('info.strong_area'), '≈ '+Math.round(cells*cellArea).toLocaleString()+' km²');
  html += infoRow(t('info.tsunami_points'), tsunamiCircles.length);

  // --- EEW detection (detect mode only) ---
  if (detectMode && detectedEpicenter && epicenter) {
    var locErr = Physics.haversineDist(detectedEpicenter.lat, detectedEpicenter.lng, epicenter.lat, epicenter.lng);
    var magErr = detectedMag - _liveMag;
    var blabel = detectFinal
      ? ('FINAL #' + detectBulletin + (detectConverged ? '' : ' (timeout)'))
      : (detectBulletin > 0 ? ('#' + detectBulletin) : '—');
    // Convergence progress
    var convPct = 0;
    if (!detectFinal && detectStationCount >= 3) {
      var critMet = 0, critTotal = 5;
      if (detectStationCount >= 20) critMet++;
      if (simElapsed - detectFirstTime >= 15) critMet++;
      if (detectUncertainty < 15) critMet++;
      // Check drift and mag drift from history
      var rec = [];
      for (var hi2 = detectHistory.length - 1; hi2 >= 0; hi2--) {
        if (simElapsed - detectHistory[hi2].time <= 10) rec.push(detectHistory[hi2]); else break;
      }
      if (rec.length >= 3) {
        var oo = rec[rec.length - 1], nn = rec[0];
        if (Physics.haversineDist(oo.lat, oo.lng, nn.lat, nn.lng) < 5) critMet++;
        if (Math.abs(nn.mag - oo.mag) < 0.5) critMet++;
      }
      convPct = Math.round(critMet / critTotal * 100);
    }
    var convBar = !detectFinal && detectStationCount >= 3
      ? '<div style="display:inline-block;width:60px;height:8px;background:#333;border-radius:3px;vertical-align:middle;margin-left:4px"><div style="width:'+convPct+'%;height:100%;background:'+(convPct>=80?'#2ecc71':convPct>=40?'#f1c40f':'#e74c3c')+';border-radius:3px"></div></div><span style="font-size:.75em;color:var(--text-secondary);margin-left:4px">'+convPct+'%</span>'
      : '';
    html += '<br><div class="info-hdr">' + t('info.eew') + '</div>';
    html += infoRow(t('info.bulletin'), '<span style="color:'+(detectFinal?(detectConverged?'#2ecc71':'#ff0'):'#fa0')+'">'+blabel+'</span>');
    html += infoRow(t('info.est_epicenter'), detectedEpicenter.lat.toFixed(2)+'°N '+detectedEpicenter.lng.toFixed(2)+'°E');
    html += infoRow(t('info.location_error'), locErr.toFixed(1)+' km');
    html += infoRow(t('info.est_magnitude'), 'M'+detectedMag.toFixed(1)+' <span style="color:var(--text-secondary)">('+(magErr>=0?'+':'')+magErr.toFixed(1)+')</span>');
    html += infoRow(t('info.uncertainty'), '±'+Math.round(detectUncertainty)+' km');
    html += infoRow(t('info.stations_used'), detectStationCount);
    if (convBar) html += '<div style="margin-top:3px"><span style="color:var(--text-secondary);font-size:.75em">' + t('info.convergence') + '</span>' + convBar + '</div>';
    if (detectFinal) {
      html += infoRow(t('info.best_uncertainty'), '±'+Math.round(detectBestUncertainty)+' km');
      html += infoRow(t('info.total_bulletins'), detectBulletin);
    }
  }

  // --- Multi-Event info (when more than mainshock is active) ---
  if (activeEvents.length > 1) {
    html += '<br><div class="info-hdr">' + t('info.multi_event') + '</div>';
    html += infoRow(t('info.active_events'), activeEvents.length);
    for (var ei2 = 0; ei2 < activeEvents.length; ei2++) {
      var ev2 = activeEvents[ei2];
      var eType = ev2.isMainshock ? t('info.event_mainshock') : t('info.event_aftershock');
      html += infoRow('  ' + eType,
        'M' + ev2.mag.toFixed(1) + ' · ' + Number(ev2.depth||0).toFixed(0) + 'km · ' +
        't=' + ev2.originTime.toFixed(0) + 's · ' +
        'P=' + Math.round(ev2.pRadius) + 'km');
    }
  }

  // --- Tsunami ---
  if (tsunamiCircles.length || tsunamiActual.length || _tsuResearchSnapshot) {
    var tmax=0, alertMax=0, announcedMax='—', announcedRank=0, tcnt={adv:0,warn:0,major:0}, areaNames=[];
    var forecastCount=0,arrivedCount=0;
    for (var i=0;i<tsunamiCircles.length;i++){
      var w=tsunamiCircles[i];
      if(w.height>tmax)tmax=w.height;
      if((w.alertHeight||w.height)>alertMax)alertMax=w.alertHeight||w.height;
      var wr=Physics.tsunamiWarningRank(w.level);
      if(wr>announcedRank){announcedRank=wr;announcedMax=w.announcedHeight||'—';}
      if(tcnt[w.level]!=null)tcnt[w.level]++;
      if(w.status==='arrived'||w.status==='modeled')arrivedCount++;else forecastCount++;
      if(w.areaName&&areaNames.indexOf(w.areaName)<0)areaNames.push(w.areaName);
    }
    var amax=0, acnt={adv:0,warn:0,major:0};
    for (var i=0;i<tsunamiActual.length;i++){ var a=tsunamiActual[i]; if(a.height>amax)amax=a.height; if(acnt[a.level]!=null)acnt[a.level]++; }
    html += '<br><div class="info-hdr">' + t('info.tsunami') + '</div>';
    if (tsunamiCircles.length) {
      html += infoRow(t('info.tsunami_method'),_tsuForecastAreas.length?('JMA AreaTsunami · '+_tsuForecastAreas.length):'coast fallback');
      var sourceEvent=mainEvent(),sourceArea=sourceEvent&&_tsuForecastAreaByCode[sourceEvent._jmaSourceAreaCode];
      if(sourceArea)html += infoRow(t('info.tsunami_source_area'),escapeHTML(sourceArea.name)+' ('+escapeHTML(t('tsunami.basin.'+sourceArea.basin))+')');
      html += infoRow(t('info.tsunami_predicted'), tmax.toFixed(1)+' m <span style=\"color:var(--text-secondary);font-size:.85em\">(' + t('info.experimental_tsunami') + ', ' + t('info.at_60s') + ')</span>');
      html += infoRow(t('info.tsunami_alert_height'), alertMax.toFixed(1)+' m → '+escapeHTML(announcedMax));
      html += infoRow(t('info.tsunami_status'),forecastCount+' '+t('info.tsunami_forecast')+' / '+arrivedCount+' '+t('info.arrived'));
      html += infoRow(t('info.tsunami_levels'), '<span style="color:#ee5a24">'+tcnt.major+'</span> / <span style="color:#ff9f43">'+tcnt.warn+'</span> / <span style="color:#ffe066">'+tcnt.adv+'</span>');
      if(areaNames.length)html += infoRow(t('info.tsunami_areas'),areaNames.slice(0,6).map(escapeHTML).join('、')+(areaNames.length>6?' +'+(areaNames.length-6):''));
    }
    if (tsunamiActual.length) {
      html += infoRow(t('info.tsunami_actual'), amax.toFixed(1)+' m <span style=\"color:var(--text-secondary);font-size:.85em\">(' + t('info.experimental_tsunami') + ', ' + t('info.arrived') + ')</span>');
      if (acnt.major+acnt.warn+acnt.adv > 0)
        html += infoRow(t('info.tsunami_actual_levels'), '<span style="color:#ee5a24">'+acnt.major+'</span> / <span style="color:#ff9f43">'+acnt.warn+'</span> / <span style="color:#ffe066">'+acnt.adv+'</span>');
    }
    html += infoRow(t('info.tsunami_radius'), Math.round(tsunamiRadius)+' km');
    var mevEta=mainEvent(),mevEtaSpeed=mevEta&&mevEta.tsunamiSpeedKmS;
    html += infoRow(t('info.tsunami_wave_eta'), tsunamiRadius > 0 && mevEtaSpeed ? (Math.round(tsunamiRadius / mevEtaSpeed) + 's ago') : '—');
    if(_tsuResearchSnapshot&&_tsuResearchSnapshot.diagnostics){
      var tsuDiag=_tsuResearchSnapshot.diagnostics;
      function finiteFixed(value,digits){value=Number(value);return isFinite(value)?value.toFixed(digits):'—';}
      function finiteSci(value){value=Number(value);return isFinite(value)?Physics.fmtSci(value):'—';}
      var tsuHealth=Physics.assessTsunamiNumericalHealth?Physics.assessTsunamiNumericalHealth(tsuDiag):{level:'pending',reasons:[]};
      var healthLabel=t('tsunami.health.'+tsuHealth.level),healthReasons=(tsuHealth.reasons||[]).map(function(reason){return t('tsunami.health.reason.'+reason);});
      var residualPct=tsuHealth.massResidualPercent==null?'—':((tsuHealth.massResidualPercent>=0?'+':'')+tsuHealth.massResidualPercent.toExponential(3)+'%');
      var gridNx=Number(tsuDiag.gridNx)||(_bathyGrid&&_bathyGrid.nx)||0,gridNy=Number(tsuDiag.gridNy)||(_bathyGrid&&_bathyGrid.ny)||0;
      var gridRes=_bathyGrid&&Number(_bathyGrid.res)>0?(' · '+(_bathyGrid.res*111.32).toFixed(_bathyGrid.res*111.32<1?2:1)+' km'):'';
      if(tsuDiag.nested&&tsuDiag.levels){
        // Two-level run: show the AMR ratio and the coarse cell count feeding it.
        var coarseNx=(tsuDiag.levels.coarse&&tsuDiag.levels.coarse.gridNx)||0;
        gridRes=' · AMR ×'+(tsuDiag.nested.ratio||1)+' ('+coarseNx+'→'+gridNx+')';
      }
      html += '<div class="tsunami-health-heading"><span>'+escapeHTML(t('tsunami.health.title'))+'</span><strong class="tsunami-health-badge '+escapeHTML(tsuHealth.level)+'">'+escapeHTML(healthLabel)+'</strong></div>';
      if(healthReasons.length)html += '<div class="tsunami-health-reasons">'+healthReasons.map(escapeHTML).join(' · ')+'</div>';
      html += infoRow(t('tsunami.health.model_grid'),escapeHTML(_tsuResearchSnapshot.model||'—')+' · '+gridNx+'×'+gridNy+gridRes);
      html += infoRow(t('tsunami.health.cfl'),finiteFixed(tsuDiag.maxCfl,4)+' / '+finiteFixed(tsuDiag.cflLimit,2));
      html += infoRow(t('tsunami.health.timestep'),(isFinite(Number(tsuDiag.stableDtSeconds))?Number(tsuDiag.stableDtSeconds).toFixed(2)+' s':'—')+' · '+Math.round(Number(tsuDiag.steps)||0)+' '+t('tsunami.health.steps'));
      html += infoRow(t('tsunami.health.mass'),residualPct+' · '+finiteSci(tsuDiag.massResidualM3)+' m³');
      if(tsuDiag.dynamicDeformation){
        html += infoRow(t('tsunami.health.source_progress'),
          finiteFixed(Math.max(0,Math.min(1,Number(tsuDiag.sourceFraction)||0))*100,1)+'% · '+
          finiteSci(tsuDiag.sourceVolumeM3)+' m³');
      }
      html += infoRow(t('tsunami.health.depth_range'),finiteFixed(tsuDiag.minWaterDepthM,3)+' – '+finiteFixed(tsuDiag.maxWaterDepthM,1)+' m');
      html += infoRow(t('tsunami.health.corrections'),
        (Number(tsuDiag.negativeDepthCorrections)||0)+' '+t('tsunami.health.negative')+' / '+
        (Number(tsuDiag.dryCellCorrections)||0)+' '+t('tsunami.health.dry')+' / '+
        (Number(tsuDiag.nonFiniteCorrections)||0)+' '+t('tsunami.health.nonfinite')+' · '+
        (Number(tsuHealth.correctionRate||0)*100).toExponential(2)+'%');
      html += infoRow(t('tsunami.health.nonfinite_cells'),Number(tsuDiag.nonFiniteCells)||0);
      html += infoRow(t('tsunami.health.coriolis'),tsuDiag.coriolisEnabled?t('adv.opt.on'):t('adv.opt.off'));
      html += infoRow(t('tsunami.health.zones'),(_tsuResearchSnapshot.inundationZones||[]).length);
      var deformation=_tsuResearchSnapshot.deformation;
      if(deformation){
        html += infoRow(t('tsunami.health.deformation'),finiteFixed(deformation.maxUplift,3)+' / '+finiteFixed(deformation.maxSubsidence,3)+' m · '+escapeHTML(deformation.method||'—'));
        html += infoRow(t('tsunami.health.deformation_balance'),finiteSci(deformation.volumeResidual)+' m '+t('tsunami.health.grid_sum')+' · '+Math.round(Number(deformation.patches)||0)+' '+t('tsunami.health.patches'));
        if(deformation.method==='okada-dc3d-1992-surface'){
          html += infoRow(t('tsunami.health.horizontal'),finiteFixed(deformation.maxHorizontalDisplacement,3)+' m · '+t('tsunami.health.slope_term')+' '+finiteFixed(deformation.maxHorizontalSlopeContribution,3)+' m');
          html += infoRow(t('tsunami.health.boundary'),escapeHTML(tsuDiag.boundary||'wall')+' · '+escapeHTML(deformation.applicability||''));
        }
      }
    }
  }

  // --- Aftershock sequence ---
  if (aftershockEnabled && aftershockCatalog.length > 0) {
    var AS_TIME_SCALE = 21600;
    var asOccurred = 0;
    for (var ai2 = 0; ai2 < aftershockCatalog.length; ai2++) {
      if (aftershockCatalog[ai2].time / AS_TIME_SCALE <= simElapsed) asOccurred++;
    }
    html += '<br><div class="info-hdr">' + t('aftershock.enable') + '</div>';
    html += infoRow(t('aftershock.count'), aftershockCatalog.length + ' (' + asOccurred + ' ' + t('aftershock.active').toLowerCase() + ')');
    html += infoRow(t('aftershock.largest'), 'M' + maxAftershockMag.toFixed(1));
    html += infoRow(t('aftershock.duration'), '30 days (compressed)');
    html += infoRow(t('info.aftershock_params'),
      'K=' + cfgGet('asyK').toFixed(0) + '  ' +
      t('info.as_p') + '=' + cfgGet('asyP').toFixed(2) + '  ' +
      t('info.as_c') + '=' + cfgGet('asyC').toFixed(2) + '  ' +
      t('info.as_b') + '=' + cfgGet('asyB').toFixed(2));
    // Count promoted aftershocks (those that became visible events)
    var promotedCount = 0;
    for (var ai3 = 0; ai3 < activeEvents.length; ai3++) {
      if (!activeEvents[ai3].isMainshock) promotedCount++;
    }
    html += infoRow(t('info.aftershock_promoted'), promotedCount + ' / ' + cfgGet('maxAsEvents').toFixed(0) + ' max (≥M' + cfgGet('asyEventThr').toFixed(1) + ')');
  }

  // --- Building damage ---
  if (isRunning && totalActive > 0) {
    var curSec = Math.floor(simElapsed);
    if (!damageCache || curSec !== damageCacheSec) {
      damageCache = aggregateBuildingDamage(visibleCircles);
      damageCacheSec = curSec;
    }
    var dmg = damageCache;
    html += '<br><div class="info-hdr">' + t('damage.title') + '</div>';
    html += '<div style="font-size:.85em">';
    html += '<div style="color:#e6b422;margin-bottom:2px;font-weight:700">' + t('damage.wooden') + '</div>';
    html += infoRow(t('damage.total_collapse'), Math.round(dmg.wooden_total).toLocaleString() + ' ' + t('damage.units'));
    html += infoRow(t('damage.partial_damage'), Math.round(dmg.wooden_partial).toLocaleString() + ' ' + t('damage.units'));
    html += '<div style="color:#6cb4ee;margin-bottom:2px;font-weight:700">' + t('damage.rc') + '</div>';
    html += infoRow(t('damage.total_collapse'), Math.round(dmg.rc_total).toLocaleString() + ' ' + t('damage.units'));
    html += infoRow(t('damage.partial_damage'), Math.round(dmg.rc_partial).toLocaleString() + ' ' + t('damage.units'));
    html += '</div>';
  }

  // --- Computation ---
  html += '<br><div class="info-hdr">' + t('info.computation') + '</div>';
  if (cfgGet('gmpModel') === 'auto') {
    html += infoRow(t('info.gmpe'), 'Auto -> Si &amp; Midorikawa (1999), ' + activeSrcType());
  } else if (cfgGet('gmpModel') === 'si-midorikawa')
    html += infoRow(t('info.gmpe'), 'Si &amp; Midorikawa (1999), '+activeSrcType());
  else if (cfgGet('gmpModel') === 'kanno2006')
    html += infoRow(t('info.gmpe'), 'Kanno et al. (2006), Vs30');
  else if (cfgGet('gmpModel') === 'zhao2006')
    html += infoRow(t('info.gmpe'), 'Zhao et al. (2006), '+activeSrcType());
  else if (cfgGet('gmpModel') === 'log-ff')
    html += infoRow(t('info.gmpe'), 'log-FF (Rrup+src+M[w]) ='+cfgGet('attA').toFixed(2)+'M-'+cfgGet('attB').toFixed(2)+'logR+'+cfgGet('attC').toFixed(2));
  else
    html += infoRow(t('info.gmpe'), 'log(PGA)='+cfgGet('attA').toFixed(2)+'M-'+cfgGet('attB').toFixed(2)+'logR+'+cfgGet('attC').toFixed(2));
  var resolvedModel = Physics.resolveGmpModel(cfgGet('gmpModel'), activeSrcType(), eventMw != null ? eventMw : _liveMag);
  var sigmaInfo = Physics.getGmpSigmaComponents(cfgGet('gmpModel'), activeSrcType(), 'pga', eventMw != null ? eventMw : _liveMag);
  if (cfgGet('sigmaOverride') > 0) sigmaInfo.sigmaT = cfgGet('sigmaOverride');
  html += infoRow(t('info.source_type'), activeSrcType() + (cfgGet('sourceTypeOverride') !== 'auto' ? ' (override)' : ''));
  html += infoRow(t('info.distance_metric'), resolvedModel === 'log-ff' || resolvedModel === 'si-midorikawa' ? 'Rrup (finite fault when available)' : 'Rhypo');
  html += infoRow(t('info.sigma'), sigmaInfo.sigmaT.toFixed(3));
  html += infoRow(t('info.intensity_formula'), 'I=max(PGA, PGV empirical) · ' + t('info.empirical_jma_note'));
  html += infoRow(t('info.stations'), rawLandGrid.length.toLocaleString());
  html += infoRow(t('info.p_s_speed'), cfgGet('pWaveSpeed').toFixed(1)+' / '+cfgGet('sWaveSpeed').toFixed(1)+' km/s');
  // Validation scorecard: sim peak Shindo vs observed JMA Shindo (preset runs only)
  if (currentPreset && OBSERVED && OBSERVED[currentPreset]) {
    var ev = OBSERVED[currentPreset], obs = ev.obs || {};
    var rows = '', sum = 0, sum2 = 0, n = 0;
    for (var city in obs) {
      var ov = obs[city], sv = peakShindoByName[city];
      var on = Physics.shindoScore(ov);
      var dTxt, col, svTxt = (sv === undefined ? '—' : sv);
      if (sv === undefined) { dTxt = '—'; col = '#888'; }
      else {
        var d = Physics.shindoScore(sv) - on; sum += d; sum2 += d*d; n++;
        var ad = Math.abs(d);
        col = ad < 0.5 ? '#2ecc71' : (ad < 1.0 ? '#f1c40f' : '#e74c3c');
        dTxt = (d > 0 ? '+' : '') + d.toFixed(1);
      }
      rows += '<div style="display:flex;gap:4px;font-size:.85em;margin:1px 0">'
           +  '<span style="flex:1;color:var(--text-secondary)">' + escapeHTML(city) + '</span>'
           +  '<span style="width:26px;text-align:center;color:#fff">' + ov + '</span>'
           +  '<span style="width:26px;text-align:center;color:#fff">' + svTxt + '</span>'
           +  '<span style="width:32px;text-align:right;color:' + col + ';font-weight:700">' + dTxt + '</span></div>';
    }
    var bias = n ? sum / n : 0, rms = n ? Math.sqrt(sum2 / n) : 0;
    html += '<br><div class="info-hdr">' + t('info.validation') + (ev.estimated ? ' (est.)' : '') + '</div>';
    html += '<div style="display:flex;gap:4px;font-size:.78em;color:var(--text-secondary);border-bottom:1px solid var(--border);margin-bottom:2px">'
         +  '<span style="flex:1">City</span><span style="width:26px;text-align:center">Obs</span>'
         +  '<span style="width:26px;text-align:center">Sim</span><span style="width:32px;text-align:right">&Delta;</span></div>';
    html += rows;
    html += '<div style="margin-top:3px;font-size:.85em"><span class="info-label">Bias:</span> <span class="info-val">' + (bias > 0 ? '+' : '') + bias.toFixed(2) + '</span> '
         +  '<span class="info-label">RMS:</span> <span class="info-val">' + rms.toFixed(2) + '</span> '
         +  '<span style="color:var(--text-secondary)">(n=' + n + ')</span></div>';
  }
  document.getElementById('info-quake').innerHTML = html;
  var overview = document.querySelector('.info-overview-card');
  if (overview) overview.classList.add('has-results');
  var infoTab = document.getElementById('tab-info'); if (infoTab) infoTab.classList.add('has-results');
  var shSummary = document.getElementById('info-summary-shindo');
  var pgaSummary = document.getElementById('info-summary-pga');
  var pgvSummary = document.getElementById('info-summary-pgv');
  var waveSummary = document.getElementById('info-summary-waves');
  if (shSummary) { shSummary.textContent = formatIntensity(curMaxSh); shSummary.style.color = SHINDO_FILL[curMaxSh] || 'var(--text)'; }
  if (pgaSummary) pgaSummary.textContent = (curMaxPga >= 100 ? Math.round(curMaxPga) : curMaxPga.toFixed(1)) + ' gal';
  if (pgvSummary) pgvSummary.textContent = maxPgv.toFixed(1) + ' cm/s';
  if (waveSummary) waveSummary.textContent = 'P ' + Math.round(pRadius) + ' / S ' + Math.round(sRadius) + ' km';
  var liveState = document.getElementById('info-live-state');
  if (liveState) { liveState.textContent = t('info.updating'); liveState.classList.add('running'); }
  var infoStatus = document.getElementById('info-tab-status'); if (infoStatus) infoStatus.hidden = false;
}

function renderFocalMechanismPanel(params) {
  var canvas=document.getElementById('focal-mechanism-canvas'), detail=document.getElementById('focal-mechanism-details');
  if (!canvas || !window.Renderer || !Physics.focalMechanism) return;
  var fm=params.momentTensor&&Physics.focalMechanismFromTensor ? Physics.focalMechanismFromTensor(params.momentTensor) : Physics.focalMechanism(params);
  var polarityResult=params.polarityResult||_polarityInversion;
  Renderer.drawFocalMechanismDiagram(canvas,fm,{observations:polarityResult&&polarityResult.observations,takeoffConvention:polarityResult&&polarityResult.takeoffConvention});
  var p=fm.plane1, q=fm.plane2, axes=fm.axes, selection=params.faultPlaneSelection||(_observedMomentTensor===params.momentTensor?_observedFaultPlaneSelection:null);
  var pLabel='NP1'+(selection&&selection.index===1?' ['+t('info.fault_plane_selected')+']':''),qLabel='NP2'+(selection&&selection.index===2?' ['+t('info.fault_plane_selected')+']':'');
  function angle(v){return v.azimuthDeg.toFixed(0)+'° / '+v.plungeDeg.toFixed(0)+'°';}
  var imported=params.momentTensor&&params.momentTensor.provenance, decomp=fm.decomposition, uncertainty=fm.uncertainty, quality=fm.quality;
  detail.innerHTML=(params.eventTag?'<div class="focal-mechanism-source"><b>'+escapeHTML(params.eventTag)+'</b></div>':'')
    +'<div class="focal-mechanism-source">'+t('info.focal_status')+': '+(polarityResult?t('info.polarity_solution'):(imported?escapeHTML(imported.source||'observed'):(params.mechanismKnown?t('info.focal_explicit'):t('info.focal_auto'))))+(quality?' · Q'+escapeHTML(quality.grade):'')+'</div>'
    +'<div class="focal-mechanism-grid"><span>'+pLabel+'</span><b>'+p.strikeDeg.toFixed(0)+'° · '+p.dipDeg.toFixed(0)+'° · '+p.rakeDeg.toFixed(0)+'°</b><span>'+qLabel+'</span><b>'+q.strikeDeg.toFixed(0)+'° · '+q.dipDeg.toFixed(0)+'° · '+q.rakeDeg.toFixed(0)+'°</b>'
    +'<span>P / T / B</span><b>'+angle(axes.P)+' · '+angle(axes.T)+' · '+angle(axes.B)+'</b>'
    +(decomp?'<span>DC / CLVD / ISO</span><b>'+(decomp.dcFraction*100).toFixed(1)+'% · '+(decomp.clvdFraction*100).toFixed(1)+'% · '+(decomp.isoFraction*100).toFixed(1)+'%</b>':'')
    +(uncertainty?'<span>± axis / plane</span><b>P '+uncertainty.axisDeg.P.toFixed(1)+'° · T '+uncertainty.axisDeg.T.toFixed(1)+'° / '+uncertainty.planeDeg.toFixed(1)+'°</b>':'')
    +(selection?'<span>'+t('info.fault_plane_method')+'</span><b>'+t('info.fault_plane_method_'+selection.method.replace(/-/g,'_'))+' · '+t('info.confidence_'+selection.confidence)+(selection.ambiguous?' · '+t('info.fault_plane_ambiguous'):'')+'</b>':'')
    +(imported?'<span>Provenance</span><b>'+escapeHTML(imported.eventId||'no event ID')+' · '+escapeHTML(imported.hash||'no hash')+'</b>':'')
    +(polarityResult?'<span>'+t('info.polarity_fit')+'</span><b>'+(100*(1-polarityResult.mismatchRate)).toFixed(1)+'% · '+t('info.polarity_confidence')+' '+polarityResult.confidence.level+'</b>':'')+'</div>';
  var desc='NP1 strike '+p.strikeDeg.toFixed(0)+' dip '+p.dipDeg.toFixed(0)+' rake '+p.rakeDeg.toFixed(0)+'. P, T and B axes are shown in NED coordinates.';
  setCanvasA11yDescription('focal-mechanism-canvas',desc);
}

// ================================================================
//  AFTERSHOCK SEQUENCE (Feature A1)
// ================================================================

// [generateAftershockCatalog] moved to aftershock.js (alias override active)

// [preComputeAftershockArrivals] moved to aftershock.js (alias override active)

// [updateAftershockTimeline] moved to aftershock.js (alias override active)

// ================================================================
//  BUILDING DAMAGE ESTIMATION (Feature A2)
// ================================================================

// Fragility curves: {totalCollapse: ratio, partialDamage: ratio} per shindo
var FRAGILITY_WOODEN = {
  4:   {total:0.00, partial:0.01},
  '5-':{total:0.005, partial:0.05},
  '5+':{total:0.01, partial:0.10},
  '6-':{total:0.05, partial:0.20},
  '6+':{total:0.15, partial:0.35},
  7:   {total:0.30, partial:0.50}
};
var FRAGILITY_RC = {
  4:   {total:0.00, partial:0.00},
  '5-':{total:0.00, partial:0.005},
  '5+':{total:0.00, partial:0.01},
  '6-':{total:0.005, partial:0.03},
  '6+':{total:0.02, partial:0.10},
  7:   {total:0.08, partial:0.25}
};

// City building tier lookup (key Japanese cities)
var CITY_TIERS = {
  '東京都千代田区':1,'東京都':1,'横浜市':1,'大阪市':1,'名古屋市':1,
  '札幌市':2,'福岡市':2,'仙台市':2,'広島市':2,'京都市':2,'神戸市':2,
  'さいたま市':2,'川崎市':2,'新潟市':2,'静岡市':2,'浜松市':2,
  '北九州市':2,'堺市':2,'千葉市':2,'相模原市':2,'岡山市':2,
  '熊本市':2,'鹿児島市':2,'那覇市':2,'宇都宮市':2,'松山市':2
};
var TIER_BUILDINGS = [0, 800000, 200000, 50000, 10000]; // index = tier

function estimateBuildingsForStation(name){return Physics.estimateBuildingsForStation(name);}

function aggregateBuildingDamage(circles){return Physics.aggregateBuildingDamage(circles);}

// -- URL params parsing --
function getUrlParams() {
  return SimUtils.parseQueryString(window.location.search);
}
function applyUrlParams() {
  var p = getUrlParams();
  // Language first
  if (p.lang && ['ja','en','zh'].indexOf(p.lang) >= 0) {
    cl = p.lang; applyLanguage(cl);
  }
  // Preset
  if (p.preset && document.getElementById('preset')) {
    var presetSel = document.getElementById('preset');
    for (var i = 0; i < presetSel.options.length; i++)
      if (presetSel.options[i].value === p.preset) { presetSel.value = p.preset; presetSel.dispatchEvent(new Event('change')); break; }
  }
  // Individual params (override preset)
  if (p.mag) { magSlider.value = p.mag; magSlider.dispatchEvent(new Event('input')); }
  if (p.depth) { depthSlider.value = p.depth; depthSlider.dispatchEvent(new Event('input')); }
  if (p.strike) { strikeSlider.value = p.strike; document.getElementById('strike-num').value = p.strike; strikeVal.textContent = p.strike+'°'; }
  if (p.dip) { dipSlider.value = p.dip; document.getElementById('dip-num').value = p.dip; currentDip = parseFloat(p.dip); _dipExplicit=true; refreshDipStateLabel(); }
  if (p.rake != null) { rakeSlider.value = p.rake; document.getElementById('rake-num').value = p.rake; rakeVal.textContent = p.rake+'°'; currentRake = parseFloat(p.rake); }
  if (p.mech === '1') _rakeExplicit = true;
  else if (p.mech === '0') _rakeExplicit = false;
  refreshRakeStateLabel();
  if (p.speed) { simSpeedEl.value = p.speed; }
  if (p.sound) { soundModeEl.value = p.sound; }
  if (p.tsunami === '0') { document.getElementById('tsunami-enable').checked = false; }
  if (p.detect === '1') { document.getElementById('detect-mode').checked = true; detectMode = true; }
  if (p.aftershock === '1') { document.getElementById('aftershock-enable').checked = true; aftershockEnabled = true; _syncAsManualPanel(); }
  // Epicenter coordinates
  if (p.lat && p.lng) {
    var la = parseFloat(p.lat), ln = parseFloat(p.lng);
    if (!isNaN(la) && !isNaN(ln) && la >= 24 && la <= 46 && ln >= 122 && ln <= 150) {
      setEpicenter(la, ln);
      if (p.zoom) map.setView([la, ln], parseInt(p.zoom) || 7);
    }
  }
  // Multi-event scenario encoded in scn= (overrides single-epicenter params).
  // A single-event scn applies too when it carries manual aftershocks (asman).
  if (p.scn) {
    var full = SimUtils.decodeScenario(p.scn);
    if (full && full.events && (full.events.length > 1 || (full.manualAftershocks && full.manualAftershocks.length))) {
      full.name = 'Shared';
      full.version = 1;
      ScenarioManager.deserialize(full);
    }
  }
}
// Build shareable URL from current state
function buildShareUrl() {
  var params = [];
  // Multi-event scenarios are encoded compactly in a `scn` param (URL-safe base64).
  // v5.5: the scn envelope also carries manual aftershocks (asman), so a
  // single-event share with manual entries wraps its one event the same way.
  var scnEvents = null;
  if (multiEventMode && customEvents.length > 1) scnEvents = customEvents;
  else if (manualAftershocks.length && epicenter) {
    scnEvents = [{lat:epicenter.lat, lng:epicenter.lng, mag:_liveMag, depth:parseFloat(depthSlider.value),
      strike:parseFloat(strikeSlider.value), dip:currentDip, rake:currentRake, mechanismKnown:_rakeExplicit, time:0}];
  }
  if (scnEvents) {
    var flags = { detect: detectMode, aftershock: aftershockEnabled,
      tsunami: !!(document.getElementById('tsunami-enable') && document.getElementById('tsunami-enable').checked) };
    try {
      params.push('scn=' + SimUtils.encodeScenario(scnEvents, flags, FiniteFaultEditor.getState(), manualAftershocks));
    } catch(e) {}
  }
  if (epicenter) { params.push('lat='+epicenter.lat.toFixed(4)); params.push('lng='+epicenter.lng.toFixed(4)); }
  params.push('mag='+_liveMag.toFixed(1));
  params.push('depth='+depthSlider.value);
  params.push('strike='+strikeSlider.value);
  params.push('dip='+dipSlider.value);
  params.push('rake='+rakeSlider.value);
  params.push('mech='+(_rakeExplicit?'1':'0'));
  params.push('lang='+cl);
  if (currentPreset) params.push('preset='+currentPreset);
  if (detectMode) params.push('detect=1');
  if (aftershockEnabled) params.push('aftershock=1');
  if (!document.getElementById('tsunami-enable').checked) params.push('tsunami=0');
  if (epicenter) params.push('zoom='+map.getZoom());
  return window.location.origin + window.location.pathname + '?' + params.join('&');
}
// Share button handler
function copyShareLink() {
  var url = buildShareUrl();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() {
      showShareToast();
    }).catch(function() { prompt('Copy this link:', url); });
  } else {
    // Fallback for older browsers
    var ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showShareToast(); } catch(e) { prompt('Copy this link:', url); }
    document.body.removeChild(ta);
  }
}
function showShareToast() {
  var toast = document.getElementById('share-toast');
  if (!toast) return;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2000);
}
// Mobile menu toggle
function initMobileToggle() {
  var btn = document.getElementById('btn-mobile-toggle');
  var sidebar = document.getElementById('sidebar');
  if (!btn || !sidebar) return;
  var isMobile = window.matchMedia('(max-width:768px)').matches;
  if (isMobile) {
    btn.classList.add('show');
    sidebar.classList.add('collapsed'); // start collapsed on mobile
    // First-visit guide: pulse the hamburger button
    if (!localStorage.getItem('qs-mobile-guided')) {
      btn.classList.add('mobile-guide');
      btn.title = t('mobile.guide') || '轻触展开控制面板';
      localStorage.setItem('qs-mobile-guided', '1');
    }
  }
  btn.addEventListener('click', function() {
    sidebar.classList.toggle('collapsed');
    map.invalidateSize();
  });
  // Listen for resize to show/hide toggle button
  window.matchMedia('(max-width:768px)').addEventListener('change', function(e) {
    if (e.matches) {
      btn.classList.add('show');
      sidebar.classList.add('collapsed');
    } else {
      btn.classList.remove('show');
      sidebar.classList.remove('collapsed');
    }
    map.invalidateSize();
  });
}

function initTsunamiLayerControl(){
  var select=document.getElementById('tsunami-layer-select');if(!select)return;
  select.value=cfgGet('tsunamiMapMode');
  ensureTsunamiMapModeCompatible(select.value);
  select.addEventListener('change',function(){
    cfgSet('tsunamiMapMode',select.value);
    ensureTsunamiMapModeCompatible(select.value);
    if(select.value!=='cityInundation')clearTsunamiZoneSelection(false);
    var advanced=document.querySelector('.adv-row[data-cfg="tsunamiMapMode"] select');if(advanced)advanced.value=select.value;
    if(typeof Renderer!=='undefined'&&Renderer.invalidateCaches)Renderer.invalidateCaches();
    if(typeof drawFrame==='function')drawFrame();
  });
  var close=document.getElementById('tsunami-zone-detail-close');
  if(close)close.addEventListener('click',function(e){e.stopPropagation();clearTsunamiZoneSelection();});
}

// -- Init --
async function init() {
  // Apply URL params before anything else
  applyUrlParams();
  initWaveCanvas();
  document.getElementById('lang-select').value = cl;
  applyLanguage(cl);
  // Non-critical UI binding: never let an Advanced-panel error block station loading / the map.
  try { advBind(); } catch (e) { console.error('advBind failed (Advanced panel disabled):', e); }
  initTsunamiLayerControl();
  var observedPromise = fetch('/geojson/observed.json').catch(function(){ return null; });
  await loadJapanGeoJSON();
  // URL-param epicenters were placed before the land polygons existed
  // (isOceanPoint defaulted to land); now that geography is available, fire
  // the regional bathymetry prefetch for ocean epicenters.
  if (epicenter && isOceanPoint(epicenter.lat, epicenter.lng)) _prefetchRegionalBathy(epicenter.lat, epicenter.lng);
  try { var orsp = await observedPromise; if (orsp && orsp.ok) OBSERVED = await orsp.json(); }
  catch(e) { console.warn('observed.json load failed:', e); }
  preloadAudio();
  // Audio loading indicator on map (disappears once all sounds are cached)
  try {
    var audioLoadingEl = document.getElementById('audio-loading');
    var audioProgressEl = document.getElementById('audio-progress');
    var audioTotalPreload = AudioManager._pendingLoads;
    if (audioLoadingEl && audioTotalPreload > 0) {
      audioLoadingEl.style.display = '';
      var audioCheckTimer = setInterval(function() {
        var done = audioTotalPreload - AudioManager._pendingLoads;
        if (audioProgressEl) audioProgressEl.textContent = done + '/' + audioTotalPreload;
        if (AudioManager._pendingLoads <= 0) {
          clearInterval(audioCheckTimer);
          audioLoadingEl.style.transition = 'opacity .5s';
          audioLoadingEl.style.opacity = '0';
          setTimeout(function() { audioLoadingEl.style.display = 'none'; }, 600);
        }
      }, 500);
    }
  } catch (e) { /* audio loading indicator non-critical */ }
  drawFrame();
  statusText.textContent = t('status.ready');
  // Share button
  var btnShare = document.getElementById('btn-share');
  if (btnShare) btnShare.addEventListener('click', copyShareLink);
  // Mobile toggle
  initMobileToggle();
  // Register service worker for offline PWA support (non-critical)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=468847').catch(function(e) {
      console.warn('SW registration failed (non-critical):', e);
    });
  }
}
// init() is invoked at the end of this file, after all UI-enhancement modules
// (e.g. ScenarioManager) are defined, so applyUrlParams() can use them.

// ================================================================
//  UI ENHANCEMENTS (loaded after DOM ready)
// ================================================================

// --- Finite-fault slip distribution editor (M>=6.5) ---
var FiniteFaultEditor = (function(){
  // State. asperities: [{sFrac,dFrac,weight}]. When empty/default + custom off,
  // genSubSources uses the cfg Gaussian default → identical to prior behavior.
  var asperities = [{ sFrac: 0.55, dFrac: 0.6, weight: 1.3 }];
  var hypoS = 0.5, hypoD = 0.35, mode = 'bilateral', custom = false;
  function tr(k){ return (typeof t === 'function') ? t(k) : k; }
  function edited(){_deactivateObservedFiniteFault('fault-editor-change');}

  // Build the opts object passed to Physics.genSubSources. null when custom off.
  function getOpts() {
    if (!custom) return null;
    return {
      aspList: asperities.map(function(a){ return {sFrac:a.sFrac, dFrac:a.dFrac, weight:a.weight}; }),
      hypoStrike: hypoS, hypoDip: hypoD, ruptureMode: mode
    };
  }
  function getState(){ return { asperities: asperities.map(function(a){return {sFrac:a.sFrac,dFrac:a.dFrac,weight:a.weight};}), hypoS:hypoS, hypoD:hypoD, mode:mode, custom:custom }; }
  function setState(s){
    if (!s) { custom=false; return; }
    asperities = (s.asperities && s.asperities.length) ? s.asperities.map(function(a){return {sFrac:a.sFrac,dFrac:a.dFrac,weight:a.weight};}) : [{sFrac:0.55,dFrac:0.6,weight:1.3}];
    hypoS = s.hypoS!=null?s.hypoS:0.5; hypoD = s.hypoD!=null?s.hypoD:0.35; mode = s.mode||'bilateral'; custom = !!s.custom;
    syncUI();
  }

  function drawPreview() {
    var cv = document.getElementById('ff-preview'); if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0,0,W,H);
    if(_observedFiniteFault&&_observedFiniteFault.geometry){
      var imported=_observedFiniteFault.geometry,points=[];
      imported.subs.forEach(function(sub){(sub.corners||[]).forEach(function(p){points.push(p);});});
      if(points.length){
        var meanLat=points.reduce(function(s,p){return s+p.lat;},0)/points.length,cosLat=Math.max(0.1,Math.cos(meanLat*Math.PI/180));
        var xs=points.map(function(p){return p.lng*cosLat;}),ys=points.map(function(p){return p.lat;});
        var minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs),minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys);
        var margin=22,spanX=Math.max(1e-7,maxX-minX),spanY=Math.max(1e-7,maxY-minY),scale=Math.min((W-margin*2)/spanX,(H-margin*2)/spanY);
        var ox=(W-spanX*scale)/2,oy=(H-spanY*scale)/2,maxSlip=Math.max(imported.maxSlipM||0,1e-9);
        function px(p){return ox+(p.lng*cosLat-minX)*scale;}function py(p){return H-(oy+(p.lat-minY)*scale);}
        imported.subs.forEach(function(sub){
          var slip=Math.max(0,Math.min(1,(sub.slipM||0)/maxSlip)),r=Math.round(48+207*slip),g=Math.round(36+142*slip),b=Math.round(64+42*(1-slip));
          ctx.beginPath();(sub.corners||[]).forEach(function(p,i){if(i)ctx.lineTo(px(p),py(p));else ctx.moveTo(px(p),py(p));});ctx.closePath();
          ctx.fillStyle='rgba('+r+','+g+','+b+',0.72)';ctx.fill();ctx.strokeStyle='rgba(255,190,135,0.55)';ctx.lineWidth=.7;ctx.stroke();
        });
        var hp=imported.hypocenter;if(hp){ctx.beginPath();ctx.arc(px(hp),py(hp),5,0,Math.PI*2);ctx.fillStyle='#071925';ctx.fill();ctx.strokeStyle='#7de3ff';ctx.lineWidth=2;ctx.stroke();}
        ctx.fillStyle='#cad2e5';ctx.font='11px sans-serif';ctx.textAlign='left';ctx.fillText(t('info.finite_fault_import')+' · '+imported.nSub,8,14);
      }
      var importedDiag=document.getElementById('ff-diagnostics');if(importedDiag){importedDiag.className='ff-diagnostics healthy';importedDiag.innerHTML='<strong>'+escapeHTML(t('info.finite_fault_active'))+'</strong><span>'+imported.nSub+' '+escapeHTML(t('info.finite_fault_patches'))+'</span><span>'+escapeHTML(t('ff.slip'))+' '+imported.averageSlipM.toFixed(2)+' / '+imported.maxSlipM.toFixed(2)+' m</span><span>'+escapeHTML(imported.provenance&&imported.provenance.source||imported.modelId)+'</span>';}
      return;
    }
    var mag = _liveMag, geometryMw=eventMw != null ? eventMw : mag;
    if (geometryMw < 6.5) {
      ctx.fillStyle = '#667'; ctx.font='11px sans-serif'; ctx.fillText(tr('ff.preview'), 10, H/2);
      var hiddenDiag=document.getElementById('ff-diagnostics');if(hiddenDiag)hiddenDiag.innerHTML='';
      return;
    }
    var opts=_faultOpts(activeSrcType());
    if(custom){opts.aspList=asperities.map(function(a){return {sFrac:a.sFrac,dFrac:a.dFrac,weight:a.weight};});opts.hypoStrike=hypoS;opts.hypoDip=hypoD;opts.ruptureMode=mode;}
    var previewGeom = Physics.genSubSources(epicenter ? epicenter.lat : 35,
      epicenter ? epicenter.lng : 140, geometryMw,
      parseFloat(strikeSlider.value), currentDip, _liveDepth,cfgGet('rupSpeed'),opts);
    if(!previewGeom){var emptyDiag=document.getElementById('ff-diagnostics');if(emptyDiag)emptyDiag.innerHTML='';return;}
    var nS=previewGeom.nStrike,nD=previewGeom.nDip,maxSlip=Math.max(previewGeom.maxSlipM,1e-9);
    var margin={l:38,r:14,t:25,b:30},availW=W-margin.l-margin.r,availH=H-margin.t-margin.b;
    var physicalRatio=previewGeom.L/previewGeom.W,plotW=availW,plotH=plotW/physicalRatio;
    if(plotH>availH){plotH=availH;plotW=plotH*physicalRatio;}
    var ox=margin.l+(availW-plotW)/2,oy=margin.t+(availH-plotH)/2,cw=plotW/nS,ch=plotH/nD;
    function slipColor(v){
      v=Math.max(0,Math.min(1,v));
      var stops=[[24,24,45],[64,48,96],[180,55,82],[244,128,55],[255,226,126]],p=v*(stops.length-1),q=Math.min(stops.length-2,Math.floor(p)),f=p-q;
      return 'rgb('+Math.round(stops[q][0]*(1-f)+stops[q+1][0]*f)+','+Math.round(stops[q][1]*(1-f)+stops[q+1][1]*f)+','+Math.round(stops[q][2]*(1-f)+stops[q+1][2]*f)+')';
    }
    for(var i=0;i<nS;i++)for(var j=0;j<nD;j++){
      var sub=previewGeom.subs[i*nD+j],v=sub.slipM/maxSlip;
      ctx.fillStyle=slipColor(v);ctx.fillRect(ox+i*cw,oy+j*ch,Math.max(0.5,cw-0.35),Math.max(0.5,ch-0.35));
    }
    ctx.strokeStyle='#ffb178';ctx.lineWidth=1.5;ctx.strokeRect(ox,oy,plotW,plotH);
    var hx=ox+previewGeom.hypocenterStrikeFrac*plotW,hy=oy+previewGeom.hypocenterDipFrac*plotH;
    ctx.strokeStyle='#7de3ff';ctx.fillStyle='#071925';ctx.lineWidth=2;ctx.beginPath();ctx.arc(hx,hy,5,0,2*Math.PI);ctx.fill();ctx.stroke();
    ctx.fillStyle='#cad2e5';ctx.font='11px monospace';ctx.textAlign='left';
    ctx.fillText(Math.round(previewGeom.L)+' km',ox,16);
    ctx.save();ctx.translate(14,oy+plotH);ctx.rotate(-Math.PI/2);ctx.fillText(Math.round(previewGeom.W)+' km',0,0);ctx.restore();
    ctx.textAlign='right';ctx.fillStyle='#8994aa';ctx.fillText('0',ox+plotW, H-10);
    ctx.fillStyle=slipColor(1);ctx.fillRect(ox+plotW-70,H-21,18,7);ctx.fillStyle='#cad2e5';ctx.fillText(previewGeom.maxSlipM.toFixed(1)+' m',ox+plotW,H-10);
    var diag=document.getElementById('ff-diagnostics');
    if(diag){
      var quality=previewGeom.widthTruncated?'warning':'healthy';
      diag.className='ff-diagnostics '+quality;
      diag.innerHTML='<strong>'+Math.round(previewGeom.L)+' × '+Math.round(previewGeom.W)+' km</strong><span>'+previewGeom.nStrike+' × '+previewGeom.nDip+' · '+previewGeom.subs.length+' patches</span><span>'+t('ff.slip')+' '+previewGeom.averageSlipM.toFixed(2)+' / '+previewGeom.maxSlipM.toFixed(2)+' m</span><span>'+previewGeom.scalingRelation+'</span>'+(previewGeom.widthTruncated?'<small>'+t('ff.depth_limited')+' '+Math.round(previewGeom.widthRatio*100)+'%</small>':'');
    }
  }

  function renderAspList() {
    var list = document.getElementById('ff-asp-list'); if (!list) return;
    list.innerHTML = '';
    for (var i = 0; i < asperities.length; i++) {
      (function(idx){
        var row = document.createElement('div'); row.className='ff-asp';
        var ls=document.createElement('label'); ls.textContent=tr('ff.aspS');
        var ss=document.createElement('input'); ss.type='range'; ss.min=0; ss.max=100; ss.value=Math.round(asperities[idx].sFrac*100);
        ss.addEventListener('input',function(){ edited();asperities[idx].sFrac=+ss.value/100; drawPreview(); });
        var ld=document.createElement('label'); ld.textContent=tr('ff.aspD');
        var sd=document.createElement('input'); sd.type='range'; sd.min=0; sd.max=100; sd.value=Math.round(asperities[idx].dFrac*100);
        sd.addEventListener('input',function(){ edited();asperities[idx].dFrac=+sd.value/100; drawPreview(); });
        var lw=document.createElement('label'); lw.textContent=tr('ff.aspW');
        var nw=document.createElement('input'); nw.type='number'; nw.min=0; nw.max=5; nw.step=0.1; nw.value=asperities[idx].weight;
        nw.addEventListener('input',function(){ edited();var v=parseFloat(nw.value); if(!isNaN(v)) asperities[idx].weight=v; drawPreview(); });
        var del=document.createElement('button'); del.className='ff-asp-del'; del.textContent='×'; del.title=tr('scn.delete');
        del.addEventListener('click',function(){ if(asperities.length>1){edited(); asperities.splice(idx,1); renderAspList(); drawPreview(); } });
        row.appendChild(ls); row.appendChild(ss); row.appendChild(ld); row.appendChild(sd); row.appendChild(lw); row.appendChild(nw); row.appendChild(del);
        list.appendChild(row);
      })(i);
    }
  }

  function syncUI() {
    var chk=document.getElementById('ff-custom'); if(chk) chk.checked=custom;
    var hs=document.getElementById('ff-hypo-s'); if(hs){ hs.value=Math.round(hypoS*100); }
    var hsv=document.getElementById('ff-hypo-s-val'); if(hsv) hsv.textContent=Math.round(hypoS*100);
    var hd=document.getElementById('ff-hypo-d'); if(hd){ hd.value=Math.round(hypoD*100); }
    var hdv=document.getElementById('ff-hypo-d-val'); if(hdv) hdv.textContent=Math.round(hypoD*100);
    var md=document.getElementById('ff-mode'); if(md) md.value=mode;
    renderAspList(); drawPreview();
  }

  function updateVisibility() {
    var panel=document.getElementById('ff-panel'); if(!panel) return;
    var geometryMw=eventMw != null ? eventMw : _liveMag;
    panel.style.display = (geometryMw>=6.5) ? 'block' : 'none';
    if (geometryMw>=6.5) drawPreview();
    else {var diag=document.getElementById('ff-diagnostics');if(diag)diag.innerHTML='';}
  }

  function init() {
    var toggle=document.getElementById('ff-toggle'), panel=document.querySelector('.ff-panel');
    if (toggle && panel) toggle.addEventListener('click', function(){ panel.classList.toggle('collapsed'); });
    var chk=document.getElementById('ff-custom');
    if (chk) chk.addEventListener('change', function(){ edited();custom=chk.checked; drawPreview(); });
    var addBtn=document.getElementById('ff-add-asp');
    if (addBtn) addBtn.addEventListener('click', function(){ edited();asperities.push({sFrac:0.5,dFrac:0.5,weight:1}); renderAspList(); drawPreview(); });
    var hs=document.getElementById('ff-hypo-s');
    if (hs) hs.addEventListener('input', function(){ edited();hypoS=+hs.value/100; var v=document.getElementById('ff-hypo-s-val'); if(v)v.textContent=hs.value; drawPreview(); });
    var hd=document.getElementById('ff-hypo-d');
    if (hd) hd.addEventListener('input', function(){ edited();hypoD=+hd.value/100; var v=document.getElementById('ff-hypo-d-val'); if(v)v.textContent=hd.value; drawPreview(); });
    var md=document.getElementById('ff-mode');
    if (md) md.addEventListener('change', function(){ edited();mode=md.value; drawPreview(); });
    // Re-evaluate visibility when magnitude changes
    magSlider.addEventListener('input', updateVisibility);
    updateVisibility();
  }
  return { init:init, getOpts:getOpts, getState:getState, setState:setState, drawPreview:drawPreview, updateVisibility:updateVisibility };
})();

// Reproducible experiment metadata and compact result snapshots.
var RESEARCH_RESULTS_KEY = 'qs-research-results-v1';
var RESEARCH_DISPLAY_IDS = ['rt-map-enable','bathy-enable','vs30-enable','fault-polygon-enable','3d-enable',
  'isoseismal-enable','plates-enable','hist-quakes-enable','beachball-enable','mwf-enable','show-all-stations','perf-mode'];

function _researchVersions() {
  var resources = Research.collectResourceVersions(document);
  return {data:{stations:'stations.json:'+rawLandGrid.length,
    bathymetry:_bathyGrid?Research.hash({origin:_bathyGrid.origin,res:_bathyGrid.res,nx:_bathyGrid.nx,ny:_bathyGrid.ny}):'unavailable',
    vs30:_vs30Grid?Research.hash({origin:_vs30Grid.origin,res:_vs30Grid.res,nx:_vs30Grid.nx,ny:_vs30Grid.ny}):'fallback',
    jmaTsunamiAreas:'AreaTsunami:'+_tsuForecastAreas.length,
    certification:_researchCertification?_researchCertification.certification:'manifest-unavailable'},
    model:{app:resources['app.js']||'unknown',physics:resources['physics.js']||'unknown',research:resources['research.js']||'unknown',
      gmpe:cfgGet('gmpModel'),tsunamiSolver:cfgGet('tsunamiSolver'),intensityMethod:cfgGet('intensityMethod')}};
}

function _researchDisplayState() {
  var layers={};
  RESEARCH_DISPLAY_IDS.forEach(function(id){var el=document.getElementById(id);if(el)layers[id]=!!el.checked;});
  var center=map&&map.getCenter?map.getCenter():null;
  return {layers:layers,language:cl,speed:Number(simSpeedEl.value),theme:document.documentElement.classList.contains('light')?'light':'dark',
    uiScale:Number(localStorage.getItem('qs-ui-scale')||100),map:center?{lat:center.lat,lng:center.lng,zoom:map.getZoom()}:null};
}

function _researchScenarioForHash() {
  var scenario=ScenarioManager&&ScenarioManager.serialize?ScenarioManager.serialize('runtime'):{events:[]};
  delete scenario.created;delete scenario.experiment;return scenario;
}

function _beginResearchExperiment() {
  _updateResearchDataCertification();
  var versions=_researchVersions(),scenario=_researchScenarioForHash();
  _currentScenarioSnapshot=JSON.parse(JSON.stringify(scenario));_currentConfigSnapshot=JSON.parse(JSON.stringify(CFG));
  _currentExperiment=Research.createExperiment({seed:cfgGet('randomSeed'),scenario:_currentScenarioSnapshot,config:_currentConfigSnapshot,dataVersions:versions.data,modelVersions:versions.model});
  _currentExperiment.dataCertification=JSON.parse(JSON.stringify(_researchCertification||{certification:'unavailable',researchReady:false,blockers:['manifest']}));
  _renderResearchMetadata();
}

function _captureResearchSnapshot() {
  if(!_currentExperiment)return null;
  var maxTsu=0,regions=[];
  tsunamiCircles.forEach(function(area){var height=Number(area.height)||0;if(height>maxTsu)maxTsu=height;regions.push({code:area.areaCode||area.key,name:area.areaName||'',height:height,
    alertHeight:Number(area.alertHeight)||height,announcedHeight:area.announcedHeight||'',level:area.level,status:area.status||''});});
  var researchSummary=_tsuResearchSnapshot?{time:_tsuResearchSnapshot.time,maxEta:_tsuResearchSnapshot.maxEta,maxRunup:_tsuResearchSnapshot.maxRunup,
    maxInundation:_tsuResearchSnapshot.maxInundation,diagnostics:_tsuResearchSnapshot.diagnostics||null}:null;
  return Research.createSnapshot({experiment:_currentExperiment,scenario:_currentScenarioSnapshot||_researchScenarioForHash(),config:_currentConfigSnapshot||CFG,
    summary:{duration:simElapsed,maxPga:_globalMaxPga,maxPgv:_globalMaxPgv,maxShindo:_globalMaxShindo,maxShindoScore:Physics.shindoScore(_globalMaxShindo),maxTsunamiHeight:maxTsu,preset:currentPreset||'custom'},
    waveform:wfSamples,intensitySeries:intensitySamples,stations:Object.keys(_researchStationPeaks).map(function(k){return _researchStationPeaks[k];}),maxStations:1500,
    tsunami:{regions:regions,research:researchSummary},dataCertification:_researchCertification,
    diagnostics:{physics:Physics.getDiagnostics?Physics.getDiagnostics():null,damage:damageCache,aftershockCount:aftershockCatalog.length}});
}

function _updateResearchDataCertification() {
  if (typeof ResearchDataCatalog === 'undefined' || !_researchDataManifest) {
    _researchCertification={valid:false,researchReady:false,certification:'degraded',blockers:['manifest']};
  } else {
    _researchCertification=ResearchDataCatalog.assessRuntime(_researchDataManifest, {
      terrain:_bathyGrid,vs30:_vs30Grid,strongMotionReady:_strongMotionPackageReady,tsunamiObservationsReady:_tsunamiObservationsReady
    });
  }
  var badge=document.getElementById('research-certification-badge'),out=document.getElementById('research-data-status');
  if(badge){badge.textContent=_researchCertification.researchReady?'RESEARCH READY':'DEGRADED';badge.classList.toggle('is-ready',_researchCertification.researchReady);badge.classList.toggle('is-degraded',!_researchCertification.researchReady);}
  if(out){
    var labels={terrain:'GEBCO/ETOPO terrain','coastal-elevation':'GSI coastal elevation',vs30:'J-SHIS Vs30','strong-motion':'K-NET/KiK-net','tsunami-observations':'Historical tsunami observations',manifest:'Data manifest'};
    var blockers=_researchCertification.blockers||[];
    out.innerHTML='<strong>'+escapeHTML(_researchCertification.researchReady?t('research.certified'):t('research.not_certified'))+'</strong>'
      +(blockers.length?'<ul>'+blockers.map(function(role){return '<li>'+escapeHTML(labels[role]||role)+'</li>';}).join('')+'</ul>':'');
  }
  return _researchCertification;
}

function _researchLibrary() {
  try{var raw=localStorage.getItem(RESEARCH_RESULTS_KEY);if(!raw||raw.length>4*1024*1024)return [];var parsed=JSON.parse(raw);return Array.isArray(parsed)?parsed:[];}catch(e){return [];}
}

function _saveResearchSnapshot(snapshot) {
  if(!snapshot||!snapshot.experiment)return;
  var library=_researchLibrary().filter(function(item){return item&&item.experiment&&item.experiment.id!==snapshot.experiment.id;});
  library.unshift(snapshot);if(library.length>4)library.length=4;
  try{localStorage.setItem(RESEARCH_RESULTS_KEY,JSON.stringify(library));}catch(e){try{localStorage.setItem(RESEARCH_RESULTS_KEY,JSON.stringify(library.slice(0,2)));}catch(ignore){}}
  _lastResearchSnapshot=snapshot;_renderResearchMetadata();_renderResearchRunSelectors();
}

function _renderResearchMetadata() {
  var exp=_currentExperiment||(_lastResearchSnapshot&&_lastResearchSnapshot.experiment);
  var fields={'research-seed':exp?exp.seed:'—','research-experiment-id':exp?exp.id:'—','research-config-hash':exp?exp.hashes.config:'—',
    'research-model-hash':exp?(exp.hashes.model.slice(0,8)+' / '+exp.hashes.data.slice(0,8)):'—'};
  Object.keys(fields).forEach(function(id){var el=document.getElementById(id);if(el){el.textContent=fields[id];el.title=String(fields[id]);}});
}

function _renderResearchRunSelectors() {
  var library=_researchLibrary(),selects=[document.getElementById('research-run-a'),document.getElementById('research-run-b')];
  selects.forEach(function(sel,si){if(!sel)return;var previous=sel.value;sel.innerHTML='';
    if(!library.length){var empty=document.createElement('option');empty.value='';empty.textContent=t('research.no_results');sel.appendChild(empty);return;}
    library.forEach(function(item){var option=document.createElement('option');option.value=item.experiment.id;option.textContent=(item.summary&&item.summary.preset||'custom')+' · '+item.experiment.id.slice(-8);sel.appendChild(option);});
    if(previous&&library.some(function(item){return item.experiment.id===previous;}))sel.value=previous;else sel.selectedIndex=Math.min(si,library.length-1);});
}

function _drawResearchWaveform(a,b) {
  var canvas=document.getElementById('research-compare-waveform');if(!canvas)return;var ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='rgba(0,0,0,.18)';ctx.fillRect(0,0,w,h);var all=(a.waveform||[]).concat(b.waveform||[]),max=1;
  all.forEach(function(p){max=Math.max(max,Math.abs(Number(p.a)||0));});
  function line(samples,color){if(!samples||samples.length<2)return;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.5;for(var i=0;i<samples.length;i++){var x=i*(w-8)/(samples.length-1)+4,y=h/2-(Number(samples[i].a)||0)*(h*.42)/max;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);}ctx.stroke();}
  ctx.strokeStyle='rgba(255,255,255,.2)';ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();line(a.waveform,'#4da6ff');line(b.waveform,'#ff6b6b');ctx.fillStyle='#4da6ff';ctx.fillText('A',6,12);ctx.fillStyle='#ff6b6b';ctx.fillText('B',22,12);
}

function _runResearchComparison() {
  var aEl=document.getElementById('research-run-a'),bEl=document.getElementById('research-run-b'),out=document.getElementById('research-comparison');if(!aEl||!bEl||!out)return;
  var aId=aEl.value,bId=bEl.value;if(!aId||!bId||aId===bId){out.textContent=t('research.select_two');return;}var library=_researchLibrary(),a=null,b=null;
  library.forEach(function(item){if(item.experiment.id===aId)a=item;if(item.experiment.id===bId)b=item;});if(!a||!b){out.textContent=t('research.select_two');return;}
  var diff=Research.compareSnapshots(a,b),changedStations=diff.stations.filter(function(row){return row.status!=='matched'||Math.abs(row.peakPga.delta||0)>.01;}).length;
  var changedTsu=diff.tsunamiRegions.filter(function(row){return row.status!=='matched'||Math.abs(row.height.delta||0)>.01||row.level.a!==row.level.b;}).length;
  function value(v,digits,unit){return v==null||!isFinite(Number(v))?'—':Number(v).toFixed(digits)+(unit||'');}
  function cell(v){var text=String(v==null?'—':v);if(text.length>30)text=text.slice(0,27)+'...';return '<td title="'+escapeHTML(String(v==null?'—':v))+'">'+escapeHTML(text)+'</td>';}
  function table(title,rows){return '<details class="research-compare-detail"><summary>'+escapeHTML(title)+'</summary><table class="research-diff-table"><thead><tr><th></th><th>A</th><th>B</th><th>Δ</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></details>';}
  var summaryRows=[['PGA',diff.summary.maxPga,2,' gal'],['PGV',diff.summary.maxPgv,2,' cm/s'],['Shindo',diff.summary.maxShindoScore,1,''],['Tsunami',diff.summary.maxTsunamiHeight,2,' m']]
    .map(function(item){return '<tr><th>'+item[0]+'</th>'+cell(value(item[1].a,item[2],item[3]))+cell(value(item[1].b,item[2],item[3]))+cell(value(item[1].delta,item[2],item[3]))+'</tr>';});
  var parameterRows=diff.parameterDiff.slice(0,12).map(function(row){return '<tr><th>'+escapeHTML(row.key)+'</th>'+cell(row.a)+cell(row.b)+cell('')+'</tr>';});
  var stationRows=diff.stations.slice().sort(function(x,y){return Math.abs((y.peakPga&&y.peakPga.delta)||0)-Math.abs((x.peakPga&&x.peakPga.delta)||0);}).slice(0,12)
    .map(function(row){return '<tr><th>'+escapeHTML(row.key)+'</th>'+cell(value(row.peakPga.a,1))+cell(value(row.peakPga.b,1))+cell(value(row.peakPga.delta,1))+'</tr>';});
  var tsunamiRows=diff.tsunamiRegions.slice().sort(function(x,y){return Math.abs((y.height&&y.height.delta)||0)-Math.abs((x.height&&x.height.delta)||0);}).slice(0,12)
    .map(function(row){return '<tr><th>'+escapeHTML(row.key)+'</th>'+cell(value(row.height.a,2))+cell(value(row.height.b,2))+cell(value(row.height.delta,2))+'</tr>';});
  out.innerHTML='<div class="research-compare-summary">'+escapeHTML(t('research.parameter_changes'))+': '+diff.parameterDiff.length+' · '+escapeHTML(t('research.station_changes'))+': '+changedStations+'/'+diff.stations.length+' · '+escapeHTML(t('research.tsunami_changes'))+': '+changedTsu+'/'+diff.tsunamiRegions.length+' · '+escapeHTML(t('research.waveform_rmse'))+': '+(diff.waveform.rmse==null?'—':diff.waveform.rmse.toFixed(4))+'</div>'+
    table('A / B',summaryRows)+table(t('research.parameter_changes'),parameterRows)+table(t('research.station_changes')+' (PGA gal)',stationRows)+table(t('research.tsunami_changes')+' (m)',tsunamiRows);
  _drawResearchWaveform(a,b);
}

function _downloadResearchSnapshot() {
  var snapshot=_lastResearchSnapshot||_captureResearchSnapshot();if(!snapshot)return;var blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=(snapshot.experiment.id||'quake-sim-result')+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
}

function _initResearchWorkbench() {
  var save=document.getElementById('research-save-result');if(save)save.addEventListener('click',function(){var snap=_captureResearchSnapshot()||_lastResearchSnapshot;if(snap){_saveResearchSnapshot(snap);statusText.textContent=t('research.saved');}});
  var exp=document.getElementById('research-export-result');if(exp)exp.addEventListener('click',_downloadResearchSnapshot);var compare=document.getElementById('research-compare');if(compare)compare.addEventListener('click',_runResearchComparison);
  _renderResearchMetadata();_renderResearchRunSelectors();
}

var ScenarioManager = (function(){
  var LS_KEY = 'qs-scenarios';
  function library() { try { var raw=localStorage.getItem(LS_KEY);if(!raw||raw.length>2*1024*1024)return [];var value=JSON.parse(raw);return Array.isArray(value)?value:[]; } catch(e) { return []; } }
  function persist(arr) { try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(-30))); } catch(e) {} }
  function tr(k) { return (typeof t === 'function') ? t(k) : k; }

  // Build a serializable scenario from current UI state.
  function serialize(name) {
    var flags = {
      tsunami: document.getElementById('tsunami-enable') ? document.getElementById('tsunami-enable').checked : true,
      detect: detectMode,
      aftershock: aftershockEnabled,
      multiEvent: multiEventMode
    };
    var events;
    if (multiEventMode && customEvents.length > 0) {
      events = customEvents.map(function(e){ return {lat:e.lat,lng:e.lng,mag:e.mag,depth:e.depth,strike:e.strike,dip:e.dip,rake:(e.rake!=null?e.rake:currentRake),mechanismKnown:e.mechanismKnown!=null?!!e.mechanismKnown:_rakeExplicit,time:e.time,faultModel:e.faultModel||null}; });
    } else if (epicenter) {
      events = [{lat:epicenter.lat,lng:epicenter.lng,mag:_liveMag,depth:_liveDepth,
                 strike:parseFloat(strikeSlider.value),dip:currentDip,rake:currentRake,mechanismKnown:_rakeExplicit,time:0}];
    } else { events = []; }
    var versions=_researchVersions();
    // v5.5: manual aftershocks persist with the scenario (plain data copy;
    // lat/lng only when the entry has its own map-picked epicenter).
    var manAs = manualAftershocks.map(function(a){
      var e = {time:+a.time||0, mag:+a.mag||0, depth:+a.depth||0};
      if (isFinite(+a.lat) && isFinite(+a.lng)) { e.lat = +a.lat; e.lng = +a.lng; }
      return e;
    });
    return { schema:Research.SCENARIO_SCHEMA,name:name || tr('scn.untitled'),version:2,appVersion:'v5.4',
             seed:Research.normalizeSeed(cfgGet('randomSeed')),events:events,flags:flags,config:JSON.parse(JSON.stringify(CFG)),
             faultOpts:FiniteFaultEditor.getState(),manualAftershocks:manAs,display:_researchDisplayState(),dataVersions:versions.data,modelVersions:versions.model,
             experiment:_currentExperiment,created:(function(){try{return new Date().toISOString();}catch(e){return '';}})() };
  }

  // Apply a scenario to the UI (must not be running).
  function deserialize(scn) {
    scn=Research.migrateScenario(scn);
    if (isRunning || isCountingDown) resetSimulation();
    var evs = scn.events || [];
    if (!evs.length) return;
    // Set sliders to first event's params
    var e0 = evs[0];
    function setSliders(e) {
      magSlider.value = e.mag; document.getElementById('magnitude-num').value = e.mag; magVal.textContent = 'M'+parseFloat(e.mag).toFixed(1);
      depthSlider.value = e.depth; document.getElementById('depth-num').value = e.depth; depthVal.textContent = e.depth+' km';
      strikeSlider.value = e.strike; document.getElementById('strike-num').value = e.strike; strikeVal.textContent = e.strike+'°';
      currentDip = e.dip != null ? e.dip : 60; _dipExplicit=e.dip!=null; dipSlider.value = currentDip; document.getElementById('dip-num').value = currentDip; refreshDipStateLabel();
      currentRake = e.rake != null ? e.rake : 0; _rakeExplicit=e.mechanismKnown===true; rakeSlider.value = currentRake; document.getElementById('rake-num').value = currentRake; refreshRakeStateLabel();
    }
    // Clear any existing multi-event markers
    for (var mi = 0; mi < multiEventMarkers.length; mi++) map.removeLayer(multiEventMarkers[mi]);
    multiEventMarkers = []; customEvents = [];

    if (evs.length > 1) {
      var meChk = document.getElementById('multi-event-mode');
      if (!meChk.checked) { meChk.checked = true; meChk.dispatchEvent(new Event('change')); }
      // Replicate map-click logic: first event = epicenter, rest = numbered markers
      setSliders(evs[0]);
      setEpicenter(evs[0].lat, evs[0].lng);
      customEvents.push({lat:e0.lat,lng:e0.lng,mag:e0.mag,depth:e0.depth,strike:e0.strike,dip:e0.dip,rake:e0.rake,mechanismKnown:e0.mechanismKnown===true,time:e0.time||0,faultModel:e0.faultModel||null});
      for (var i = 1; i < evs.length; i++) {
        var e = evs[i];
        customEvents.push({lat:e.lat,lng:e.lng,mag:e.mag,depth:e.depth,strike:e.strike,dip:e.dip,rake:e.rake,mechanismKnown:e.mechanismKnown===true,time:e.time||(30*i),faultModel:e.faultModel||null});
        var numIcon = L.divIcon({
          className: 'multi-event-marker',
          html: '<div style="background:#ff5032;color:#fff;border-radius:50%;width:20px;height:20px;text-align:center;line-height:20px;font-size:10px;font-weight:700">' + customEvents.length + '</div>',
          iconSize: [20,20], iconAnchor: [10,10]
        });
        multiEventMarkers.push(L.marker([e.lat, e.lng], {icon: numIcon, zIndexOffset: 800 + customEvents.length}).addTo(map));
      }
      var meInfo = document.getElementById('multi-event-info');
      if (meInfo) { meInfo.style.display = 'block'; }
      _renderMultiEventList();
    } else {
      // Single event
      var meChk2 = document.getElementById('multi-event-mode');
      if (meChk2.checked) { meChk2.checked = false; meChk2.dispatchEvent(new Event('change')); }
      setSliders(e0);
      setEpicenter(e0.lat, e0.lng);
    }
    // Restore model, solver, policy, and reproducibility settings.
    if(scn.config)for(var cfgKey in scn.config)if(CFG_DEFAULTS[cfgKey])cfgSet(cfgKey,scn.config[cfgKey]);
    cfgSet('randomSeed',scn.seed);
    // Flags
    if (document.getElementById('tsunami-enable')) document.getElementById('tsunami-enable').checked = scn.flags && scn.flags.tsunami !== false;
    var dChk = document.getElementById('detect-mode'); if (dChk) { dChk.checked = !!(scn.flags && scn.flags.detect); detectMode = dChk.checked; }
    var aChk = document.getElementById('aftershock-enable'); if (aChk) { aChk.checked = !!(scn.flags && scn.flags.aftershock); aftershockEnabled = aChk.checked; }
    // v5.5: restore manual aftershocks (older scenarios lack the field -> []).
    manualAftershocks = (Array.isArray(scn.manualAftershocks) ? scn.manualAftershocks : []).map(function(m){
      var e = {time:Math.max(0,Math.min(3600,+m.time||0)), mag:Math.max(3,Math.min(9.5,+m.mag||6)), depth:Math.max(0,Math.min(700,+m.depth||0))};
      if (isFinite(+m.lat) && isFinite(+m.lng)) { e.lat = +m.lat; e.lng = +m.lng; }
      return e;
    });
    manualAftershocks.sort(function(a, b) { return a.time - b.time; });
    _asManClearPendingLoc();
    _renderManualAftershocks();
    _syncAsManualPanel();
    if(scn.display&&scn.display.layers)for(var layerId in scn.display.layers){var layerEl=document.getElementById(layerId);if(layerEl&&layerEl.checked!==!!scn.display.layers[layerId]){layerEl.checked=!!scn.display.layers[layerId];layerEl.dispatchEvent(new Event('change'));}}
    if(scn.display&&isFinite(Number(scn.display.speed)))simSpeedEl.value=Number(scn.display.speed);
    if(scn.display&&(scn.display.theme==='light'||scn.display.theme==='dark')){document.documentElement.classList.toggle('light',scn.display.theme==='light');localStorage.setItem('qs-theme',scn.display.theme);}
    if(scn.display&&isFinite(Number(scn.display.uiScale))){var scale=Math.max(80,Math.min(140,Number(scn.display.uiScale)));document.documentElement.style.fontSize=(scale/100*19.2)+'px';localStorage.setItem('qs-ui-scale',scale);var scaleSlider=document.getElementById('ui-scale-slider'),scaleVal=document.getElementById('ui-scale-val');if(scaleSlider)scaleSlider.value=scale;if(scaleVal)scaleVal.textContent=scale+'%';}
    if(scn.display&&scn.display.map&&isFinite(Number(scn.display.map.lat))&&isFinite(Number(scn.display.map.lng)))map.setView([Number(scn.display.map.lat),Number(scn.display.map.lng)],Number(scn.display.map.zoom)||7);
    else map.setView([e0.lat, e0.lng], 7);
    if (scn.faultOpts) FiniteFaultEditor.setState(scn.faultOpts);
    document.querySelectorAll('.adv-row[data-cfg]').forEach(function(row){var key=row.dataset.cfg,control=row.querySelector('select,input[type="range"],input[type="number"]'),value=row.querySelector('.adv-val');if(control)control.value=cfgGet(key);if(value&&CFG_DEFAULTS[key])value.textContent=advFmtVal(CFG_DEFAULTS[key],key);});
    if(typeof advRefreshUI==='function')advRefreshUI();
    updateEpicenterInfo(); _redrawInfoCharts();
  }

  function renderList() {
    var list = document.getElementById('scn-list'); if (!list) return;
    var lib = library();
    list.innerHTML = '';
    if (!lib.length) { var empty = document.createElement('div'); empty.className = 'scn-empty'; empty.textContent = tr('scn.empty'); list.appendChild(empty); return; }
    for (var i = 0; i < lib.length; i++) {
      (function(idx, item){
        var row = document.createElement('div'); row.className = 'scn-item';
        var nm = document.createElement('span'); nm.className = 'scn-name'; nm.textContent = item.name; nm.title = item.name;
        nm.addEventListener('click', function(){ deserialize(item); });
        var del = document.createElement('button'); del.className = 'scn-del'; del.textContent = '×'; del.title = tr('scn.delete');
        del.addEventListener('click', function(){
          if (!confirm(tr('scn.confirmDel'))) return;
          var arr = library(); arr.splice(idx, 1); persist(arr); renderList();
        });
        row.appendChild(nm); row.appendChild(del); list.appendChild(row);
      })(i, lib[i]);
    }
  }

  function save() {
    if (!epicenter && !(multiEventMode && customEvents.length)) { return; }
    var nameInput = document.getElementById('scn-name');
    var name = (nameInput && nameInput.value.trim()) || tr('scn.untitled');
    var scn = serialize(name);
    var lib = library(); lib.push(scn); persist(lib);
    if (nameInput) nameInput.value = '';
    renderList();
    if (typeof statusText !== 'undefined' && statusText) {
      try { statusText.textContent = tr('scn.saved'); } catch(e){}
    }
  }

  function exportFile() {
    if (!epicenter && !(multiEventMode && customEvents.length)) { return; }
    var nameInput = document.getElementById('scn-name');
    var name = (nameInput && nameInput.value.trim());
    if (!name) {
      // Fall back to the most recently saved scenario's name, if any.
      var lib = library();
      if (lib.length) name = lib[lib.length - 1].name;
    }
    var scn = serialize(name || tr('scn.untitled'));
    var blob = new Blob([JSON.stringify(scn, null, 2)], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = (scn.name.replace(/[^\w一-鿿\-]/g,'_') || 'scenario') + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function(){
      try {
        if(reader.result.length>1024*1024)throw new Error('oversized');
        var scn = Research.migrateScenario(JSON.parse(reader.result));
        deserialize(scn);
        // also add to library
        var lib = library(); lib.push(scn); persist(lib); renderList();
      } catch(e) { alert(tr('scn.invalid')); }
    };
    reader.readAsText(file);
  }

  function init() {
    var toggle = document.getElementById('scn-toggle');
    var panel = document.querySelector('.scn-panel');
    if (toggle && panel) toggle.addEventListener('click', function(){ panel.classList.toggle('collapsed'); });
    var sv = document.getElementById('scn-save'); if (sv) sv.addEventListener('click', save);
    var ex = document.getElementById('scn-export'); if (ex) ex.addEventListener('click', exportFile);
    var fi = document.getElementById('scn-file');
    if (fi) fi.addEventListener('change', function(){ if (fi.files && fi.files[0]) importFile(fi.files[0]); fi.value=''; });
    renderList();
  }
  return { init: init, serialize: serialize, deserialize: deserialize, library: library };
})();
ScenarioManager.init();
_initResearchWorkbench();
FiniteFaultEditor.init();
(function(){
  var grp = document.getElementById('speed-group');
  var sel = document.getElementById('sim-speed');
  if (!grp || !sel) return;
  var btns = grp.querySelectorAll('.speed-btn');
  btns.forEach(function(btn){
    btn.addEventListener('click', function(){
      btns.forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      sel.value = btn.getAttribute('data-speed');
      sel.dispatchEvent(new Event('change'));
    });
  });
  var calibrate=document.getElementById('polarity-calibrate');
  if(calibrate) calibrate.addEventListener('click',function(){
    try {
      if(!_polarityRecords||!_polarityRecords.length) throw new Error(t('info.polarity_need_file'));
      var ref={strike:Number(document.getElementById('polarity-ref-strike').value),dip:Number(document.getElementById('polarity-ref-dip').value),rake:Number(document.getElementById('polarity-ref-rake').value),provenance:{source:'user-supplied-reference',eventId:(document.getElementById('polarity-ref-event')||{}).value||null,url:(document.getElementById('polarity-ref-url')||{}).value||null}};
      if(!ref.provenance.eventId||!/^https?:\/\//i.test(ref.provenance.url||'')) throw new Error(t('info.calibration_provenance_required'));
      var cal=Physics.calibratePolarityRecords(_polarityRecords,ref,{takeoffConvention:(document.getElementById('polarity-takeoff-convention')||{}).value||'down',provenance:ref.provenance});
      var corrected=Physics.invertFocalMechanismPolarity(cal.correctedRecords,{takeoffConvention:cal.takeoffConvention,coarseStep:Number((document.getElementById('polarity-grid-step')||{}).value)||10}); _polarityInversion=corrected;
      out.innerHTML='<strong>'+t('info.calibration_done')+'</strong><span>'+t('info.calibration_before')+': '+(100*(1-cal.before.mismatchRate)).toFixed(1)+'%</span><span>'+t('info.calibration_global')+': '+(100*(1-cal.afterGlobal.mismatchRate)).toFixed(1)+'% · Δaz '+cal.globalOffset.azimuthDeg.toFixed(1)+'° · Δtakeoff '+cal.globalOffset.takeoffDeg.toFixed(1)+'°</span><span>'+t('info.calibration_after')+': '+(100*(1-cal.afterStationFlip.mismatchRate)).toFixed(1)+'% · '+cal.flippedStations.length+' '+t('info.calibration_stations')+'</span><small>'+t('info.calibration_limit')+'</small>';
      renderFocalMechanismPanel({strike:corrected.strikeDeg,dip:corrected.dipDeg,rake:corrected.rakeDeg,mw:_liveMag,momentNm:Physics.seismicMoment(_liveMag),mechanismKnown:true,polarityResult:corrected});
    } catch(e) { out.textContent=t('info.polarity_error')+': '+e.message; }
  });
})();

// --- Slider fill color ---
(function(){
  function updateSliderFill(slider, color) {
    var pct = (slider.value - slider.min) / (slider.max - slider.min) * 100;
    slider.style.background = 'linear-gradient(90deg,' + color + ' ' + pct + '%,#333 ' + pct + '%)';
  }
  var magSlider = document.getElementById('magnitude');
  function magColor(v) { return v > 7 ? '#e74c3c' : v > 5 ? '#f39c12' : '#2ecc71'; }
  if (magSlider) {
    magSlider.addEventListener('input', function(){ updateSliderFill(magSlider, magColor(_liveMag)); });
    updateSliderFill(magSlider, magColor(_liveMag));
  }
  var depthSlider = document.getElementById('depth');
  if (depthSlider) {
    depthSlider.addEventListener('input', function(){ updateSliderFill(depthSlider, '#4da6ff'); });
    updateSliderFill(depthSlider, '#4da6ff');
  }
  var volSlider = document.getElementById('volume-slider');
  if (volSlider) {
    volSlider.addEventListener('input', function(){ updateSliderFill(volSlider, '#2ecc71'); });
    updateSliderFill(volSlider, '#2ecc71');
  }
})();

// --- Right-click context menu ---
(function(){
  var menu = document.getElementById('ctx-menu');
  var mapEl = document.getElementById('map');
  if (!menu || !mapEl) return;
  var _ctxLat = 0, _ctxLng = 0;
  var _keyboardOpened = false;
  function menuItems() { return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')); }
  function closeMenu(restoreFocus) {
    if (menu.style.display === 'none') return;
    menu.style.display = 'none';
    if (restoreFocus && _keyboardOpened) mapEl.focus();
    _keyboardOpened = false;
  }
  function openMenu(latlng, point, keyboardOpened) {
    _ctxLat = latlng.lat; _ctxLng = latlng.lng;
    menu.style.display = 'block';
    var maxLeft = Math.max(0, mapEl.clientWidth - menu.offsetWidth - 4);
    var maxTop = Math.max(0, mapEl.clientHeight - menu.offsetHeight - 4);
    menu.style.left = Math.max(0, Math.min(point.x, maxLeft)) + 'px';
    menu.style.top = Math.max(0, Math.min(point.y, maxTop)) + 'px';
    _keyboardOpened = !!keyboardOpened;
    if (_keyboardOpened) {
      var items = menuItems();
      if (items.length) items[0].focus();
    }
  }
  mapEl.addEventListener('contextmenu', function(e){
    e.preventDefault();
    var rect = mapEl.getBoundingClientRect();
    var point = {x:e.clientX - rect.left, y:e.clientY - rect.top};
    openMenu(map.containerPointToLatLng([point.x, point.y]), point, false);
  });
  mapEl.addEventListener('keydown', function(e) {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      e.stopPropagation();
      var center = map.getCenter();
      var point = map.latLngToContainerPoint(center);
      openMenu(center, point, true);
    }
  });
  document.addEventListener('click', function(e){ if (!menu.contains(e.target)) closeMenu(false); });
  menu.addEventListener('keydown', function(e) {
    var items = menuItems();
    var idx = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    if (!items.length || !['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = items.length - 1;
    else if (e.key === 'ArrowDown') idx = (idx + 1 + items.length) % items.length;
    else idx = (idx - 1 + items.length) % items.length;
    items[idx].focus();
  });
  menu.addEventListener('click', function(e){
    var item = e.target.closest('[data-action]');
    if (!item) return;
    var action = item.getAttribute('data-action');
    if (action === 'epicenter') { setEpicenter(_ctxLat, _ctxLng); }
    else if (action === 'multi') {
      document.getElementById('multi-event-mode').checked = true;
      document.getElementById('multi-event-mode').dispatchEvent(new Event('change'));
    }
    else if (action === 'coords') { alert(_ctxLat.toFixed(4) + '°N, ' + _ctxLng.toFixed(4) + '°E'); }
    closeMenu(_keyboardOpened);
  });
})();

// --- Keyboard shortcuts overlay ---
(function(){
  var ov = document.getElementById('shortcuts-overlay');
  if (!ov) return;
  var previousFocus = null;
  function closeShortcuts() {
    ov.style.display = 'none';
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    previousFocus = null;
  }
  document.addEventListener('keydown', function(e){
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '?') {
      e.preventDefault();
      if (ov.style.display === 'flex') closeShortcuts();
      else {
        previousFocus = document.activeElement;
        ov.style.display = 'flex';
        var panel = ov.querySelector('[tabindex="-1"]');
        if (panel) panel.focus();
      }
      return;
    } else if (ov.style.display === 'flex' && e.key === 'Escape') {
      e.preventDefault(); closeShortcuts(); return;
    } else if (ov.style.display === 'flex' && e.key === 'Tab') {
      e.preventDefault();
      var panel2 = ov.querySelector('[tabindex="-1"]');
      if (panel2) panel2.focus();
      return;
    }
    // Theme toggle with T key
    if (e.key === 't' || e.key === 'T') { toggleTheme(); }
  });
  ov.addEventListener('click', function(e){ if (e.target === ov) closeShortcuts(); });
})();

// --- Theme toggle --- v4.2: auto-detect OS preference on first visit
function toggleTheme() {
  document.documentElement.classList.toggle('light');
  localStorage.setItem('qs-theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
}
(function(){
  var btn = document.getElementById('btn-theme');
  if (btn) btn.addEventListener('click', toggleTheme);
  // Restore saved theme, or auto-detect OS preference on first visit
  var saved = localStorage.getItem('qs-theme');
  if (saved === 'light') {
    document.documentElement.classList.add('light');
  } else if (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    document.documentElement.classList.add('light');
  }
})();

// --- UI scale slider (basic tab, below checkboxes) ---
(function(){
  var slider = document.getElementById('ui-scale-slider');
  var valEl = document.getElementById('ui-scale-val');
  if (!slider) return;
  function applyScale(pct) {
    // Root font-size drives all em/rem-based sizing (text, layout widths, padding, etc.)
    // Baseline is 19.2px at 100% (≈120% of browser default) so the default UI is comfortably readable on desktop.
    document.documentElement.style.fontSize = (pct / 100 * 19.2) + 'px';
    // The sidebar width change affects the map container; tell Leaflet to recompute its size.
    if (typeof map !== 'undefined' && map && map.invalidateSize) {
      setTimeout(function() { map.invalidateSize(); }, 50);
    }
    if (valEl) valEl.textContent = pct + '%';
    slider.value = pct;
    localStorage.setItem('qs-ui-scale', pct);
  }
  slider.addEventListener('input', function() { applyScale(parseInt(this.value)); });
  var saved = localStorage.getItem('qs-ui-scale');
  if (saved) applyScale(parseInt(saved));
})();

// --- Reverse geocoding (nearest city name) ---
var _geoCities = [
  {name:'東京',lat:35.68,lng:139.76},{name:'大阪',lat:34.69,lng:135.50},{name:'名古屋',lat:35.18,lng:136.90},
  {name:'札幌',lat:43.06,lng:141.35},{name:'福岡',lat:33.59,lng:130.40},{name:'仙台',lat:38.27,lng:140.87},
  {name:'広島',lat:34.39,lng:132.46},{name:'那覇',lat:26.21,lng:127.68},{name:'新潟',lat:37.90,lng:139.04},
  {name:'静岡',lat:34.98,lng:138.38},{name:'金沢',lat:36.56,lng:136.66},{name:'高松',lat:34.34,lng:134.05},
  {name:'横浜',lat:35.44,lng:139.64},{name:'神戸',lat:34.69,lng:135.19},{name:'京都',lat:35.01,lng:135.77},
  {name:'千葉',lat:35.61,lng:140.12},{name:'さいたま',lat:35.86,lng:139.65},{name:'北九州',lat:33.88,lng:130.88},
  {name:'熊本',lat:32.79,lng:130.74},{name:'鹿児島',lat:31.60,lng:130.56},{name:'長崎',lat:32.75,lng:129.88},
  {name:'宮崎',lat:31.91,lng:131.42},{name:'松山',lat:33.84,lng:132.77},{name:'盛岡',lat:39.70,lng:141.15},
  {name:'秋田',lat:39.72,lng:140.10},{name:'青森',lat:40.82,lng:140.74},{name:'函館',lat:41.77,lng:140.73},
  {name:'釧路',lat:42.97,lng:144.38},{name:'帯広',lat:42.92,lng:143.20},{name:'旭川',lat:43.77,lng:142.37},
  {name:'福島',lat:37.75,lng:140.47},{name:'水戸',lat:36.34,lng:140.45},{name:'宇都宮',lat:36.57,lng:139.88},
  {name:'前橋',lat:36.39,lng:139.06},{name:'甲府',lat:35.66,lng:138.57},{name:'長野',lat:36.23,lng:138.18},
  {name:'富山',lat:36.70,lng:137.21},{name:'福井',lat:36.06,lng:136.22},{name:'岐阜',lat:35.42,lng:136.76},
  {name:'津',lat:34.73,lng:136.51},{name:'大津',lat:35.00,lng:135.87},{name:'奈良',lat:34.69,lng:135.80},
  {name:'和歌山',lat:34.23,lng:135.17},{name:'鳥取',lat:35.50,lng:134.24},{name:'松江',lat:35.47,lng:133.05},
  {name:'岡山',lat:34.66,lng:133.93},{name:'山口',lat:34.19,lng:131.47},{name:'徳島',lat:34.07,lng:134.56},
  {name:'高知',lat:33.56,lng:133.53},{name:'佐賀',lat:33.25,lng:130.30},{name:'大分',lat:33.24,lng:131.61}
];
// --- Brune ω² waveform cache ---
var _bruneCache = {stationId: null, freqs: [], amps: [], phases: []};

// Shared Brune ω² carrier synthesis (used by updateWaveform, _mwfComputeSamples, aftershock fallback)
function _bruneSynthesize(t, mag, addNoiseFloor) {
  var noise = 0;
  if (_bruneCache && _bruneCache.freqs && _bruneCache.freqs.length > 0) {
    for (var bi = 0; bi < _bruneCache.freqs.length; bi++) {
      noise += _bruneCache.amps[bi] * Math.sin(2 * Math.PI * _bruneCache.freqs[bi] * t + _bruneCache.phases[bi]);
    }
    if (addNoiseFloor) {
      var nf = cfgGet('waveformNoise') || 0;
      if (nf > 0) noise += (Research.randomAt(cfgGet('randomSeed'), 'waveform-noise:' + (_bruneCache.stationId || 'none'), Math.round(t * 1000)) - 0.5) * nf * 2;
    }
  } else {
    var freq = 10 - mag * 0.7;
    if (freq < 1) freq = 1;
    noise = Math.sin(t * freq * Math.PI * 2) * 0.6 +
            Math.sin(t * freq * 1.7 * Math.PI * 2) * 0.3 +
            (Research.randomAt(cfgGet('randomSeed'), 'waveform-fallback:' + (_bruneCache.stationId || 'none'), Math.round(t * 1000)) - 0.5) * 0.3;
  }
  return noise;
}

function _computeBruneCache(station) {
  if (!station || !epicenter) return;
  if (_bruneCache.stationId === station.id) return; // already cached
  _bruneCache.stationId = station.id;
  var mag = _liveMag;
  var dist = Physics.haversineDist(epicenter.lat, epicenter.lng, station.lat, station.lng);
  var depth = _liveDepth;
  dist = Math.sqrt(dist * dist + depth * depth);
  var sd = cfgGet('stressDrop');
  var sa = soilAmp(station.lat, station.lng, station.isSeafloor);
  var nFreq = Math.round(cfgGet('spectrumBins')), fMin = cfgGet('spectrumFMin'), fMax = cfgGet('spectrumFMax');
  var logFMin = Math.log(fMin), logFMax = Math.log(fMax);
  var freqs = [], amps = [], phases = [], maxA = 0;
  for (var i = 0; i < nFreq; i++) {
    var f = Math.exp(logFMin + (logFMax - logFMin) * i / (nFreq - 1));
    var q0 = (cfgGet('regionalQ') === 'on') ? Physics.lookupQ0(station.lat, station.lng) : cfgGet('faultQ0');
    var A = Physics.fullSpectrum(f, mag, dist, sd, sa, q0, cfgGet('faultQeta'));
    freqs.push(f); amps.push(A); phases.push(Research.randomAt(cfgGet('randomSeed'), 'brune-phase:' + station.id, i) * Math.PI * 2);
    if (A > maxA) maxA = A;
  }
  if (maxA > 0) for (var i = 0; i < nFreq; i++) amps[i] /= maxA;
  _bruneCache.freqs = freqs; _bruneCache.amps = amps; _bruneCache.phases = phases;
  _bruneCache.duration = Physics.physicalDuration(mag, dist, sd);
  var synth = Physics.synthesizeWaveform3C(mag, dist, sd, sa, _bruneCache.duration, 50,
    Research.normalizeSeed(cfgGet('randomSeed')) ^ Math.floor((station.lat*1000 + station.lng*1000 + mag*100) * 100));
  _bruneCache.components = synth;
}

// --- Response spectrum chart ---
function drawResponseSpectrum() {
  var canvas = document.getElementById('spectrum-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!isRunning || !wfStation || !epicenter) {
    ctx.fillStyle = '#666'; ctx.font = '10px monospace';
    ctx.fillText('Response Spectrum — waiting...', 10, H / 2);
    return;
  }
  var mag = _liveMag;
  var sc = wfStation.id != null ? (_visibleCircleById[String(wfStation.id)] || null) : null;
  var pga = sc ? sc.displayPga : 100;
  var sa = soilAmp(wfStation.lat, wfStation.lng, wfStation.isSeafloor);
  // Compute PSA at periods 0.01 to 5.0s
  var periods = [], psaVals = [], maxPSA = 0;
  for (var i = 0; i < 30; i++) {
    var T = Math.exp(Math.log(0.01) + (Math.log(5.0) - Math.log(0.01)) * i / 29);
    periods.push(T);
  }
  var response = [];
  if (_bruneCache.components && _bruneCache.components.x) {
    var carrier = _bruneCache.components.x, carrierPeak = 0;
    for (var ci=0;ci<carrier.length;ci++) carrierPeak=Math.max(carrierPeak,Math.abs(carrier[ci]));
    var scaled = carrier.map(function(v){return carrierPeak>0?v/carrierPeak*pga:0;});
    response = Physics.sdofResponseSpectrum(scaled, _bruneCache.components.sampleRate || 50, periods, 0.05);
  }
  for (var i = 0; i < periods.length; i++) {
    var psa = response[i] ? response[i].psaGal : Physics.calcResponseSpectrum(pga, sa, periods[i]);
    psaVals.push(psa);
    if (psa > maxPSA) maxPSA = psa;
  }
  if (maxPSA <= 0) return;
  // Draw axes
  ctx.strokeStyle = '#333'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(30, 5); ctx.lineTo(30, H - 15); ctx.lineTo(W - 5, H - 15); ctx.stroke();
  // Draw spectrum curve
  ctx.beginPath(); ctx.strokeStyle = '#e94560'; ctx.lineWidth = 2;
  for (var i = 0; i < 30; i++) {
    var x = 30 + (Math.log(periods[i]) - Math.log(0.01)) / (Math.log(5.0) - Math.log(0.01)) * (W - 40);
    var y = (H - 20) - (psaVals[i] / maxPSA) * (H - 30);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Labels
  ctx.fillStyle = '#888'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
  ctx.fillText('0.01s', 32, H - 3); ctx.fillText('0.1s', 30 + (W-40)*0.33, H - 3);
  ctx.fillText('1s', 30 + (W-40)*0.66, H - 3); ctx.fillText('5s', W - 8, H - 3);
  ctx.textAlign = 'left'; ctx.fillStyle = '#aaa'; ctx.font = '9px monospace';
  ctx.fillText('PSA(T) ' + Math.round(maxPSA) + ' gal', 34, 12);
  ctx.fillText('5% damping', W - 70, 12);
}

// --- Info-page charts: attenuation, source spectrum, travel-time, azimuth directivity ---

// Redraw all info-page charts (used on slider input / epicenter set, when sim
// may not be running).
function _redrawInfoCharts() {
  if (!infoChartsVisible()) return;
  try {
    drawAttenuationCurve(); drawGMPECompare(); drawSourceSpectrum();
    drawTravelTimeCurve(); drawAzimuthDirectivity();
  } catch(e) {}
}

// Info sub-navigation and chart utilities. Canvas renderers keep their existing
// IDs; opening a hidden group triggers a redraw after layout is available.
function activateInfoView(name) {
  var target = name || 'overview';
  var activeBtn = document.querySelector('.info-subnav-btn.active');
  if (!name && activeBtn) target = activeBtn.dataset.infoView;
  document.querySelectorAll('.info-subnav-btn').forEach(function(btn) { var active=btn.dataset.infoView === target; btn.classList.toggle('active', active); btn.setAttribute('aria-selected', active ? 'true' : 'false'); });
  document.querySelectorAll('.info-view').forEach(function(panel) { panel.classList.toggle('active', panel.dataset.infoPanel === target); });
  if (target === 'charts') requestAnimationFrame(function() {
    _redrawInfoCharts(); drawResponseSpectrum(); updateIntensityCurve();
    if (typeof Quake3D !== 'undefined' && Quake3D.resize) Quake3D.resize();
  });
}
function infoChartsVisible() {
  var panel = document.querySelector('[data-info-panel="charts"].active');
  return !!(panel && document.getElementById('tab-info').classList.contains('active'));
}
(function initInfoUI() {
  document.querySelectorAll('.info-subnav-btn').forEach(function(btn) { btn.addEventListener('click', function(){ activateInfoView(btn.dataset.infoView); }); });
  document.querySelectorAll('.info-card').forEach(function(card) { card.addEventListener('toggle', function(){ if (card.open) requestAnimationFrame(function(){ _redrawInfoCharts(); drawResponseSpectrum(); if (typeof Quake3D !== 'undefined' && Quake3D.resize) Quake3D.resize(); }); }); });
  document.querySelectorAll('.chart-block').forEach(function(block) {
    var header = block.querySelector('.info-mini-hdr'), download = block.querySelector('.chart-download');
    if (!header || !download) return;
    var actions = document.createElement('span'); actions.className = 'chart-actions';
    var expand = document.createElement('button'); expand.type = 'button'; expand.className = 'chart-action chart-expand'; expand.textContent = '⛶'; expand.setAttribute('aria-label', t('info.expand_chart'));
    header.removeChild(download); actions.appendChild(expand); actions.appendChild(download); header.appendChild(actions);
    expand.addEventListener('click', function() {
      block.classList.toggle('expanded'); expand.setAttribute('aria-label', t(block.classList.contains('expanded') ? 'info.close_chart' : 'info.expand_chart'));
      requestAnimationFrame(function(){ _redrawInfoCharts(); drawResponseSpectrum(); updateIntensityCurve(); });
    });
  });
document.querySelectorAll('.chart-download').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var canvas = document.getElementById(btn.dataset.canvas); if (!canvas) return;
      try { var a=document.createElement('a'); a.href=canvas.toDataURL('image/png'); a.download='quake-sim-'+btn.dataset.canvas+'.png'; a.click(); } catch(e) {}
  });
});
var focalDownload=document.getElementById('focal-mechanism-download');
if (focalDownload) focalDownload.addEventListener('click',function(){
  var canvas=document.getElementById('focal-mechanism-canvas'); if (!canvas) return;
  var a=document.createElement('a'); a.href=canvas.toDataURL('image/png'); a.download='quake-sim-focal-mechanism.png'; a.click();
});
  var view = document.getElementById('info-3d-view');
  if (view) view.addEventListener('change', function() { var legacy=document.getElementById('btn-3d-'+view.value); if (legacy) legacy.click(); });
})();

// Chart 1: PGA vs distance attenuation curve + station scatter
function drawAttenuationCurve() {
  var canvas = document.getElementById('atten-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var ML = 34, MR = 6, MT = 14, MB = 18;
  var PW = W - ML - MR, PH = H - MT - MB;
  if (!epicenter) {
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('设置震源后显示衰减曲线', W / 2, H / 2);
    return;
  }
  var mag = _liveMag;
  var Rmin = 1, Rmax = 800;
  var logMin = Math.log10(Rmin), logMax = Math.log10(Rmax);
  // sample curve
  var pts = [], maxPga = 0;
  for (var i = 0; i <= 60; i++) {
    var R = Math.pow(10, logMin + (logMax - logMin) * i / 60);
    var pga = calcPGA(mag, R);
    pts.push({R: R, pga: pga});
    if (pga > maxPga) maxPga = pga;
  }
  var pgaMax = Math.max(maxPga, 1);
  var pLogMin = Math.log10(Math.max(0.1, pgaMax / 1000)), pLogMax = Math.log10(pgaMax * 1.2);
  // axes
  ctx.strokeStyle = '#334'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, H - MB); ctx.lineTo(W - MR, H - MB); ctx.stroke();
  // grid + x labels (1,10,100,800)
  ctx.fillStyle = '#678'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [1, 10, 100, 800].forEach(function(r) {
    var x = ML + (Math.log10(r) - logMin) / (logMax - logMin) * PW;
    ctx.strokeStyle = '#1a2233'; ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, H - MB); ctx.stroke();
    ctx.fillText(r + 'km', x, H - MB + 2);
  });
  // y labels
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [pgaMax, pgaMax / 10, pgaMax / 100].forEach(function(p) {
    if (p < 0.1) return;
    var y = MT + PH - (Math.log10(p) - pLogMin) / (pLogMax - pLogMin) * PH;
    ctx.fillText(p >= 100 ? Math.round(p) : p.toFixed(1), ML - 3, y);
  });
  ctx.save(); ctx.translate(9, MT + PH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('PGA(gal)', 0, 0); ctx.restore();
  // curve
  ctx.strokeStyle = '#4da6ff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (var i = 0; i < pts.length; i++) {
    var x = ML + (Math.log10(pts[i].R) - logMin) / (logMax - logMin) * PW;
    var y = MT + PH - (Math.log10(Math.max(0.1, pts[i].pga)) - pLogMin) / (pLogMax - pLogMin) * PH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // station scatter
  for (var i = 0; i < visibleCircles.length; i++) {
    var c = visibleCircles[i];
    if (!c.displayPga || c.displayPga < 0.1) continue;
    var d = hypoDist(c.lat, c.lng);
    if (d < Rmin || d > Rmax) continue;
    var x = ML + (Math.log10(d) - logMin) / (logMax - logMin) * PW;
    var y = MT + PH - (Math.log10(Math.max(0.1, c.displayPga)) - pLogMin) / (pLogMax - pLogMin) * PH;
    var col = SHINDO_FILL[c.shindo] || '#888';
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#9ab'; ctx.font = '8px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('M' + mag.toFixed(1) + ' ' + cfgGet('gmpModel'), ML + 2, 2);
}

// Chart 2: Brune source spectrum + corner frequency
function drawSourceSpectrum() {
  var canvas = document.getElementById('source-spec-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var ML = 34, MR = 6, MT = 14, MB = 18;
  var PW = W - ML - MR, PH = H - MT - MB;
  if (!epicenter) {
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('设置震源后显示震源谱', W / 2, H / 2);
    return;
  }
  if (typeof Physics === 'undefined' || !Physics.bruneSpectrum) return;
  var mw = (eventMw != null ? eventMw : _liveMag);
  var sd = cfgGet('stressDrop') || 10;
  var beta = 3.5;
  var f0 = Physics.cornerFrequency(mw, sd, beta);
  var fMin = 0.1, fMax = 20;
  var logFMin = Math.log10(fMin), logFMax = Math.log10(fMax);
  var pts = [], maxV = 0;
  for (var i = 0; i <= 80; i++) {
    var f = Math.pow(10, logFMin + (logFMax - logFMin) * i / 80);
    var v = Physics.bruneSpectrum(f, mw, sd, beta);
    pts.push({f: f, v: v});
    if (v > maxV) maxV = v;
  }
  if (maxV <= 0) return;
  var vLogMin = Math.log10(maxV / 1000), vLogMax = Math.log10(maxV * 1.2);
  // axes
  ctx.strokeStyle = '#334'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, H - MB); ctx.lineTo(W - MR, H - MB); ctx.stroke();
  ctx.fillStyle = '#678'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [0.1, 1, 10, 20].forEach(function(f) {
    var x = ML + (Math.log10(f) - logFMin) / (logFMax - logFMin) * PW;
    if (x < ML || x > W - MR) return;
    ctx.strokeStyle = '#1a2233'; ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, H - MB); ctx.stroke();
    ctx.fillText(f + 'Hz', x, H - MB + 2);
  });
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [maxV, maxV / 100].forEach(function(v) {
    var y = MT + PH - (Math.log10(Math.max(1e-30, v)) - vLogMin) / (vLogMax - vLogMin) * PH;
    ctx.fillText(v >= 100 ? Math.round(v) : v.toExponential(1), ML - 3, y);
  });
  // curve
  ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (var i = 0; i < pts.length; i++) {
    var x = ML + (Math.log10(pts[i].f) - logFMin) / (logFMax - logFMin) * PW;
    var y = MT + PH - (Math.log10(Math.max(1e-30, pts[i].v)) - vLogMin) / (vLogMax - vLogMin) * PH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // corner frequency vertical line
  if (f0 > fMin && f0 < fMax) {
    var xf = ML + (Math.log10(f0) - logFMin) / (logFMax - logFMin) * PW;
    ctx.strokeStyle = '#e94560'; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(xf, MT); ctx.lineTo(xf, H - MB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e94560'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('f₀=' + f0.toFixed(2) + 'Hz', Math.min(xf + 2, W - 60), MT + 1);
  }
  ctx.fillStyle = '#9ab'; ctx.font = '8px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('Mw' + mw.toFixed(1) + ' Δσ=' + sd + 'MPa', ML + 2, 2);
}

// --- GMPE Model Comparison Chart ---
function drawGMPECompare() {
  var canvas = document.getElementById('gmpe-compare-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var ML = 36, MR = 6, MT = 12, MB = 18;
  var PW = W - ML - MR, PH = H - MT - MB;
  if (!epicenter) {
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('设置震源后显示GMPE对比', W / 2, H / 2);
    return;
  }
  var mag = _liveMag;
  var depth = _liveDepth;
  var src = resolvedSourceType(depth, epicenterSrc);
  var attA = cfgGet('attA'), attB = cfgGet('attB'), attC = cfgGet('attC'), anel = cfgGet('anelastic');
  var mw = (eventMw != null ? eventMw : mag);
  var models = [
    { name: 'log', color: '#4da6ff', dash: [] },
    { name: 'Si-Midorikawa', color: '#ff9f43', dash: [4, 3] },
    { name: 'log-FF', color: '#2ecc71', dash: [8, 3] }
  ];
  var Rmin = 1, Rmax = 800;
  var logMin = Math.log10(Rmin), logMax = Math.log10(Rmax);
  var allPts = [], globalMax = 0;
  for (var mi = 0; mi < models.length; mi++) {
    var m = models[mi];
    var pts = [];
    for (var i = 0; i <= 80; i++) {
      var R = Math.pow(10, logMin + (logMax - logMin) * i / 80);
      var pga;
      if (m.name === 'log') pga = Physics.pgaLog(mw, R, attA, attB, attC, anel);
      else if (m.name === 'Si-Midorikawa') pga = Physics.pgaSiMid(mw, R, depth, src);
      else pga = Physics.pgaLog(mw, R, attA, attB, attC, anel) * Math.pow(10, (Physics.SIMID_DS[src] || 0));
      pts.push({ R: R, pga: pga });
      if (pga > globalMax) globalMax = pga;
    }
    allPts.push(pts);
  }
  var pgaMax = Math.max(globalMax, 10);
  var pLogMin = Math.log10(Math.max(0.1, pgaMax / 1000)), pLogMax = Math.log10(pgaMax * 1.2);
  ctx.strokeStyle = '#334'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, H - MB); ctx.lineTo(W - MR, H - MB); ctx.stroke();
  ctx.fillStyle = '#678'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [1, 10, 100, 800].forEach(function(r) {
    var x = ML + (Math.log10(r) - logMin) / (logMax - logMin) * PW;
    ctx.strokeStyle = '#1a2233'; ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, H - MB); ctx.stroke();
    ctx.fillText(r + 'km', x, H - MB + 2);
  });
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(pgaMax) + 'g', ML - 2, MT);
  ctx.save(); ctx.translate(9, MT + PH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('PGA(gal)', 0, 0); ctx.restore();
  for (var mi = 0; mi < models.length; mi++) {
    var m = models[mi];
    ctx.strokeStyle = m.color; ctx.lineWidth = 1.5;
    ctx.setLineDash(m.dash);
    ctx.beginPath();
    var pts = allPts[mi];
    for (var i = 0; i < pts.length; i++) {
      var x = ML + (Math.log10(pts[i].R) - logMin) / (logMax - logMin) * PW;
      var y = MT + PH - (Math.log10(Math.max(0.1, pts[i].pga)) - pLogMin) / (pLogMax - pLogMin) * PH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  var lx = ML + 8, ly = MT + 2;
  ctx.font = '7px monospace';
  for (var mi = 0; mi < models.length; mi++) {
    var m = models[mi];
    ctx.fillStyle = m.color;
    ctx.fillRect(lx, ly + mi * 12, 10, 2);
    ctx.fillText(m.name, lx + 14, ly + mi * 12 + 2);
  }
  ctx.fillStyle = '#888'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(src, W - MR, MT + 2);
}
// Chart 3: P/S wave travel-time curves
function drawTravelTimeCurve() {
  var canvas = document.getElementById('travel-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var ML = 34, MR = 6, MT = 14, MB = 18;
  var pW = W - ML - MR, pH = H - MT - MB;
  if (!epicenter) {
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('设置震源后显示走时曲线', W / 2, H / 2);
    return;
  }
  var _ttd = uiDisplayParams();
  var depth = _ttd ? _ttd.depth : _liveDepth;
  var vp = PW(depth), vs = SW(depth);
  var Rmax = 800, tMax = Rmax / vs * 1.05; // S slower -> governs max time
  // axes
  ctx.strokeStyle = '#334'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, H - MB); ctx.lineTo(W - MR, H - MB); ctx.stroke();
  ctx.fillStyle = '#678'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [0, 200, 400, 600, 800].forEach(function(r) {
    var x = ML + r / Rmax * pW;
    ctx.strokeStyle = '#1a2233'; ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, H - MB); ctx.stroke();
    ctx.fillText(r + 'km', x, H - MB + 2);
  });
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (var tt = 0; tt <= tMax; tt += Math.ceil(tMax / 4)) {
    var y = MT + pH - tt / tMax * pH;
    ctx.fillText(tt + 's', ML - 3, y);
  }
  // P line
  function tline(v, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(ML, MT);
    for (var r = 0; r <= Rmax; r += 10) {
      var t = r / v;
      var x = ML + r / Rmax * pW;
      var y = MT + pH - t / tMax * pH;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  tline(vp, '#4da6ff'); tline(vs, '#ff9f43');
  // current simElapsed horizontal line
  if (isRunning) {
    var ty = MT + pH - Math.min(simElapsed, tMax) / tMax * pH;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(ML, ty); ctx.lineTo(W - MR, ty); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ccc'; ctx.font = '7px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('t=' + simElapsed.toFixed(0) + 's', W - MR, ty - 1);
  }
  // station scatter (pArrive)
  for (var i = 0; i < landPoints.length; i++) {
    var c = landPoints[i];
    var d = hypoDist(c.lat, c.lng), pArr = c.pArrive;
    if (_ttd && _ttd.count > 1) {
      // v5.2: in chain runs, scatter the display event's own arrivals and
      // distances instead of the first event's.
      d = Physics.hypoDist(c.lat, c.lng, _ttd.lat, _ttd.lng, _ttd.depth);
      pArr = -1;
      if (_ttd.idx === 0) pArr = c.pArrive;
      else if (c.subEvents) {
        for (var tsi = 0; tsi < c.subEvents.length; tsi++) {
          if (c.subEvents[tsi].evIdx === _ttd.idx) { pArr = c.subEvents[tsi].pArrive; break; }
        }
      }
      if (pArr < 0) continue;
    }
    if (d > Rmax) continue;
    var x = ML + d / Rmax * pW;
    var y = MT + pH - pArr / tMax * pH;
    ctx.fillStyle = 'rgba(77,166,255,0.5)'; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#4da6ff'; ctx.font = '8px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('P Vp=' + vp.toFixed(1), ML + 2, 2);
  ctx.fillStyle = '#ff9f43'; ctx.fillText('S Vs=' + vs.toFixed(1), ML + 78, 2);
}

// Chart 4: Azimuthal PGA directivity (polar)
function drawAzimuthDirectivity() {
  var canvas = document.getElementById('azimuth-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!epicenter) {
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('设置震源后显示方向性', W / 2, H / 2);
    return;
  }
  var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 14;
  var _azd = uiDisplayParams();
  var mag = _azd ? _azd.mag : _liveMag;
  var strike = (_azd ? _azd.strike : parseFloat(strikeSlider.value)) * Math.PI / 180;
  var basePga = calcPGA(mag, 50); // reference at 50km
  // rings
  ctx.strokeStyle = '#1f2a40'; ctx.lineWidth = 0.6;
  for (var rr = 0.25; rr <= 1.001; rr += 0.25) {
    ctx.beginPath(); ctx.arc(cx, cy, R * rr, 0, Math.PI * 2); ctx.stroke();
  }
  // axes (N/E/S/W)
  ctx.strokeStyle = '#2a3550';
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  // isotropic reference circle (point source, no directivity)
  var isoR = R * 0.6;
  ctx.strokeStyle = 'rgba(150,170,200,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(cx, cy, isoR, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  // directivity curve: factor 1 + 0.35*cos(az - strike)
  ctx.strokeStyle = '#e94560'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (var deg = 0; deg <= 360; deg += 3) {
    var az = deg * Math.PI / 180;
    var fac = 1 + 0.35 * Math.cos(az - strike);
    var rad = isoR * fac / 1.35; // normalize so max (~1.35) maps to isoR
    // 0° = North (up). Screen: x = cx + sin(az)*rad, y = cy - cos(az)*rad
    var x = cx + Math.sin(az) * rad;
    var y = cy - Math.cos(az) * rad;
    if (deg === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.stroke();
  // strike direction arrow
  var sx = cx + Math.sin(strike) * R, sy = cy - Math.cos(strike) * R;
  ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sx, sy); ctx.stroke();
  // labels
  ctx.fillStyle = '#678'; ctx.font = '8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 5); ctx.fillText('S', cx, cy + R + 5);
  ctx.fillText('E', cx + R + 5, cy); ctx.fillText('W', cx - R - 5, cy);
  ctx.fillStyle = '#ff9f43'; ctx.textAlign = 'left';
  ctx.fillText('走向 ' + (_azd ? _azd.strike : parseFloat(strikeSlider.value)) + '°', 4, 10);
}

// --- Multi-station waveform overlay (3 selectable stations, top-left of map) ---
var MWF_SLOTS = 3;
var _mwfSlots = []; // [{station, samples, maxSample, color, canvas, ctx, el}]
var _mwfColors = ['#4da6ff', '#2ecc71', '#e67e22'];
function _mwfInitSlots() {
  _mwfSlots = [];
  var panel = document.getElementById('multi-wf-panel');
  if (!panel) return;
  var slotEls = panel.querySelectorAll('.multi-wf-slot');
  for (var i = 0; i < MWF_SLOTS; i++) {
    var el = slotEls[i];
    var cv = el ? el.querySelector('.mwf-canvas') : null;
    if (cv && !cv.id) cv.id = 'mwf-canvas-' + i;
    _mwfSlots.push({
      station: null, samples: [], maxSample: 0,
      color: _mwfColors[i % _mwfColors.length],
      canvas: cv, ctx: cv ? cv.getContext('2d') : null, el: el
    });
  }
}
function _mwfFindFreeSlot() {
  for (var i = 0; i < _mwfSlots.length; i++) if (!_mwfSlots[i].station) return i;
  return -1;
}
function _mwfRenderSlotLabel(slot, idx) {
  if (!slot.el) return;
  var lbl = slot.el.querySelector('.mwf-label');
  if (slot.station) {
    slot.el.classList.add('filled'); slot.el.classList.remove('empty');
    var nm = slot.station.name || ('Sta#' + slot.station.id);
    if (lbl) lbl.textContent = (idx + 1) + '. ' + nm;
    if (slot.canvas) slot.canvas.setAttribute('aria-label', t('a11y.canvas.multi') + ': ' + nm);
  } else {
    slot.el.classList.remove('filled'); slot.el.classList.add('empty');
    if (lbl) lbl.textContent = '';
    var st2 = slot.el.querySelector('.mwf-stats'); if (st2) st2.textContent = '';
    if (slot.canvas) {
      slot.canvas.setAttribute('aria-label', t('a11y.canvas.multi'));
      slot.canvas.removeAttribute('aria-describedby');
    }
  }
}
// Build the detail stats text for a slot: shindo / PGA / PGV / dist / P·S arrival.
function _mwfUpdateDetail(slot) {
  if (!slot.el) return;
  var stEl = slot.el.querySelector('.mwf-stats');
  if (!stEl) return;
  var sta = slot.station;
  if (!sta) { stEl.textContent = ''; return; }
  var dist = epicenter ? Physics.haversineDist(epicenter.lat, epicenter.lng, sta.lat, sta.lng) : 0;
  var pA = dist > 0 ? dist / PW() : 0, sA = dist > 0 ? dist / SW() : 0;
  // Look up live circle data (shindo/PGA) if available
  var sc = sta.id != null ? (_visibleCircleById[String(sta.id)] || null) : null;
  var shindo = sc ? sc.shindo : (sta.shindo || 0);
  var pga = sc ? (sc.displayPga || sc.pga || 0) : 0;
  var pgv = sc ? (sc.pgv || 0) : 0;
  var shCol = SHINDO_FILL[shindo] || '#9ab';
  var pgaTxt = pga >= 100 ? Math.round(pga) : pga.toFixed(1);
  var html = '<span style="color:' + shCol + '">震度 ' + escapeHTML(String(shindo || '-')) + '</span>'
    + ' &nbsp;<b>' + pgaTxt + '</b>gal'
    + ' &nbsp;<b>' + pgv.toFixed(1) + '</b>cm/s<br>'
    + 'Δ<b>' + dist.toFixed(0) + '</b>km'
    + ' &nbsp;P<b>' + pA.toFixed(1) + 's</b>/S<b>' + sA.toFixed(1) + 's</b>';
  stEl.innerHTML = html;
  if (slot.canvas) {
    var nm = sta.name || ('Sta#' + sta.id);
    setCanvasA11yDescription(slot.canvas.id || ('mwf-canvas-' + _mwfSlots.indexOf(slot)),
      nm + '. ' + stEl.textContent.replace(/\s+/g, ' ').trim());
  }
}
function _mwfAddStation(sta) {
  if (!sta) return;
  for (var i = 0; i < _mwfSlots.length; i++) {
    if (_mwfSlots[i].station && _mwfSlots[i].station.id === sta.id) return;
  }
  var idx = _mwfFindFreeSlot();
  if (idx < 0) return;
  _mwfSlots[idx].station = sta;
  _mwfSlots[idx].samples = [];
  _mwfSlots[idx].maxSample = 0;
  _mwfSlots[idx].signals = null;
  _mwfRenderSlotLabel(_mwfSlots[idx], idx);
  _mwfUpdateDetail(_mwfSlots[idx]);
  _mwfDrawSlot(_mwfSlots[idx]);
  _mwfShowPanel();
}
function _mwfRemoveSlot(idx) {
  if (idx < 0 || idx >= _mwfSlots.length) return;
  _mwfSlots[idx].station = null;
  _mwfSlots[idx].samples = [];
  _mwfSlots[idx].maxSample = 0;
  _mwfSlots[idx].signals = null;
  _mwfRenderSlotLabel(_mwfSlots[idx], idx);
  _mwfDrawSlot(_mwfSlots[idx]);
}
function _mwfShowPanel() {
  var p = document.getElementById('multi-wf-panel');
  if (!p) return;
  var any = false;
  for (var i = 0; i < _mwfSlots.length; i++) if (_mwfSlots[i].station) { any = true; break; }
  p.style.display = any ? 'block' : 'none';
}
function _mwfComputeSamples(slot, t) {
  var sta = slot.station; if (!sta || !epicenter) return;
  // v5.2: per-station signal list — one entry per sub-event in chain runs
  // (cached on the slot; reset when the slot's station changes). Single-event
  // runs get the legacy one-signal list via the analytic fallback.
  if (!slot.signals) slot.signals = _wfBuildSignals(sta);
  var _md = uiDisplayParams();
  var noiseMag = _md ? _md.mag : _liveMag;
  var sampRate = 50, dt = 1 / sampRate, maxNew = 2000;
  var lastT = slot.samples.length > 0 ? slot.samples[slot.samples.length - 1].t : 0;
  while (lastT < t && maxNew > 0) {
    lastT += dt; maxNew--;
    var amp = _wfSynthAmp(slot.signals, lastT, noiseMag, false);
    if (Math.abs(amp) > slot.maxSample) slot.maxSample = Math.abs(amp);
    slot.samples.push({t: lastT, a: amp});
  }
  var cutoff = t - 20;
  var trimCount = 0;
  while (trimCount < slot.samples.length && slot.samples[trimCount].t < cutoff) trimCount++;
  if (trimCount > 0) slot.samples.splice(0, trimCount);
}
function _mwfDrawSlot(slot) {
  if (!slot.canvas || !slot.ctx) return;
  var W = slot.canvas.width, H = slot.canvas.height;
  var ctx = slot.ctx;
  // Plot area with margins: left for gal axis, bottom for time axis
  var ML = 28, MR = 2, MT = 4, MB = 12;
  var PW = W - ML - MR, PH = H - MT - MB;
  var cy = MT + PH / 2;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!slot.station) return;
  // Grid + zero line
  ctx.strokeStyle = '#1c2740'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(ML, cy); ctx.lineTo(W - MR, cy); ctx.stroke();
  // Y axis: gal scale (symmetric around zero, ±maxSample)
  var peak = slot.maxSample > 0 ? slot.maxSample : 1;
  var scale = (PH / 2 - 2) / peak;
  ctx.strokeStyle = '#2a3a55'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, H - MB); ctx.lineTo(W - MR, H - MB); ctx.stroke();
  ctx.fillStyle = '#6f86a8'; ctx.font = '7px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(peak) + '', ML - 2, MT + 2);
  ctx.fillText('0', ML - 2, cy);
  ctx.fillText('-' + Math.round(peak), ML - 2, H - MB - 2);
  ctx.textAlign = 'left'; ctx.fillStyle = '#566b8a';
  ctx.fillText('gal', ML - 22, MT - 1);
  if (slot.samples.length < 2) {
    ctx.fillStyle = '#445'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(typeof t === 'function' ? t('mwf.pending') : '待模拟', ML + PW / 2, cy);
    return;
  }
  var tMin = slot.samples[0].t, tMax = slot.samples[slot.samples.length - 1].t;
  var tRange = Math.max(tMax - tMin, 1);
  // Waveform
  ctx.strokeStyle = slot.color; ctx.lineWidth = 1;
  ctx.beginPath();
  for (var i = 0; i < slot.samples.length; i++) {
    var sx = ML + (slot.samples[i].t - tMin) / tRange * PW;
    var sy = cy - slot.samples[i].a * scale;
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.stroke();
  // X axis: time ticks (s)
  ctx.fillStyle = '#6f86a8'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var tStart = Math.ceil(tMin), tEnd = Math.floor(tMax);
  var step = tRange > 15 ? 5 : (tRange > 8 ? 2 : 1);
  for (var ts = tStart; ts <= tEnd; ts++) {
    if (ts % step !== 0 && ts !== tEnd) continue;
    var tx = ML + (ts - tMin) / tRange * PW;
    if (tx < ML || tx > W - MR) continue;
    ctx.strokeStyle = '#23304a'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(tx, MT); ctx.lineTo(tx, H - MB); ctx.stroke();
    ctx.fillText(ts + 's', tx, H - MB + 1);
  }
}
function updateMultiWaveform() {
  if (!_mwfSlots.length) _mwfInitSlots();
  var t = simElapsed;
  var any = false;
  for (var i = 0; i < _mwfSlots.length; i++) {
    if (_mwfSlots[i].station) { _mwfComputeSamples(_mwfSlots[i], t); _mwfDrawSlot(_mwfSlots[i]); _mwfUpdateDetail(_mwfSlots[i]); any = true; }
  }
  if (!any) { var p = document.getElementById('multi-wf-panel'); if (p) p.style.display = 'none'; }
}
(function() {
  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  // One-time user gesture → init AudioContext for browser autoplay policy
  (function() {
    var done = false;
    function gesture() { if (done) return; done = true; AudioManager.initContext(); }
    document.addEventListener('click', gesture, {once: true});
    document.addEventListener('touchstart', gesture, {once: true});
    document.addEventListener('keydown', gesture, {once: true});
  })();
  ready(function() {
    _mwfInitSlots();
    var chk = document.getElementById('mwf-enable');
    var panel = document.getElementById('multi-wf-panel');
    var mapEl = document.getElementById('map');
    if (panel) {
      panel.style.display = 'none';
      var clearBtn = panel.querySelector('#mwf-clear');
      if (clearBtn) clearBtn.addEventListener('click', function() {
        for (var i = 0; i < _mwfSlots.length; i++) _mwfRemoveSlot(i);
      });
      var rms = panel.querySelectorAll('.mwf-rm');
      for (var k = 0; k < rms.length; k++) {
        rms[k].addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(this.getAttribute('data-slot'), 10);
          _mwfRemoveSlot(idx);
        });
      }
    }
    if (mapEl) {
      mapEl.addEventListener('click', function(e) {
        var c = document.getElementById('mwf-enable');
        if (!c || !c.checked) return;
        if (showAllStations) return; // show-all mode uses the popup add-button instead
        if (!isRunning) return;
        if (e.target.closest('button, .leaflet-control, #timeline, #legend, #max-pga-panel, .multi-wf-panel')) return;
        var rect = mapEl.getBoundingClientRect();
        var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        var best = null, bestDist = 30;
        for (var i = 0; i < visibleCircles.length; i++) {
          var cc = visibleCircles[i];
          var pt = map.latLngToContainerPoint([cc.lat, cc.lng]);
          var dx = pt.x - cx, dy = pt.y - cy;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < bestDist) { bestDist = d; best = cc; }
        }
        if (best && best.shindo !== 0) {
          _mwfAddStation(best);
          e.stopPropagation();
        }
      }, true);
    }
    if (chk) {
      chk.addEventListener('change', function() {
        if (this.checked) _mwfShowPanel();
        else { var p = document.getElementById('multi-wf-panel'); if (p) p.style.display = 'none'; }
      });
    }
    // Show-all-stations toggle: redraw immediately so the layer appears/disappears.
    var saChk = document.getElementById('show-all-stations');
    if (saChk) {
      saChk.addEventListener('change', function() {
        showAllStations = this.checked;
        if (typeof drawFrame === 'function') drawFrame();
      });
    }
    var sfFilter = document.getElementById('seafloor-network-filter');
    if (sfFilter) {
      sfFilter.addEventListener('change', function() {
        _seafloorNetworkFilter = this.value;
        if (typeof Renderer !== 'undefined' && Renderer.invalidateCaches) Renderer.invalidateCaches();
        if (typeof drawFrame === 'function') drawFrame();
      });
    }
    var historicalTsunamiChk = document.getElementById('historical-tsunami-enable');
    if (historicalTsunamiChk) historicalTsunamiChk.addEventListener('change', function() {
      _historicalTsunamiShow = this.checked;
      if (typeof Renderer !== 'undefined' && Renderer.invalidateCaches) Renderer.invalidateCaches();
      if (typeof drawFrame === 'function') drawFrame();
    });
  });
})();

// --- 3D Visualization Integration (immersive Japan + strata + fault) ---
// Helper to push geographic data into the 3D scene once available.
function _quake3dPushGeo() {
  if (typeof Quake3D === 'undefined' || !Quake3D.setGeo) return;
  var geo = {};
  if (japanLandPolygons) geo.coastline = japanLandPolygons;
  if (_platesData) geo.plates = _platesData;
  if (_bathyGrid) geo.bathy = _bathyGrid;
  Quake3D.setGeo(geo);
}
(function() {
  var _3dInited = false;          // renderer initialized on the inline preview canvas
  var _3dFullscreenInited = false; // renderer initialized on the fullscreen canvas
  var isMobile3D = window.matchMedia('(max-width:768px)').matches;
  var _3dLastFocus = null;

  function loadScript(src, cb) {
    var s = document.createElement('script'); s.src = src;
    s.onload = cb; document.head.appendChild(s);
  }

  // v4.2: Three.js always lazy-loaded on demand
  function ensure3DScripts(cb) {
    if (typeof Quake3D !== 'undefined') { cb(null); return; }
    if (window._loadThreeJS) {
      window._loadThreeJS(function(err) {
        if (err) console.warn('3D scripts failed to load:', err.message || err);
        cb(err || null);
      });
    } else { cb(new Error('3D loader unavailable')); }
  }

  function init3DOnCanvas(canvas) {
    if (!canvas || typeof Quake3D === 'undefined' || !Quake3D.init) return;
    Quake3D.init(canvas);
    _quake3dPushGeo();
  }

  function ensureInlinePreview() {
    if (_3dInited || isMobile3D) return;
    var canvas = document.getElementById('canvas-3d');
    var enabled = document.getElementById('3d-enable');
    if (!canvas || !enabled || !enabled.checked) return;
    ensure3DScripts(function(err) {
      if (err) return;
      setTimeout(function() { init3DOnCanvas(canvas); _3dInited = true; }, 80);
    });
  }

  function show3DFullscreen() {
    var ov = document.getElementById('3d-fullscreen-overlay');
    if (!ov) return;
    _3dLastFocus = document.activeElement;
    ov.style.display = 'flex';
    setTimeout(function(){
      var first = ov.querySelector('button:not([disabled])');
      if (first) first.focus();
    }, 0);
    ensure3DScripts(function(err) {
      if (err) return;
      if (!_3dFullscreenInited) {
        var c = document.getElementById('canvas-3d-mobile');
        init3DOnCanvas(c);
        _3dFullscreenInited = true;
      }
      if (typeof Quake3D !== 'undefined') Quake3D.resize();
      // The flex canvas may not have its final size on the first layout pass
      // (especially on mobile); resize again after the browser paints.
      setTimeout(function() { if (typeof Quake3D !== 'undefined') Quake3D.resize(); }, 120);
    });
  }

  function close3DFullscreen() {
    var ov = document.getElementById('3d-fullscreen-overlay');
    if (!ov || ov.style.display === 'none') return;
    ov.style.display = 'none';
    // Restore the inline desktop preview renderer after fullscreen used it.
    if (!isMobile3D && typeof Quake3D !== 'undefined' && Quake3D.init) {
      var inline = document.getElementById('canvas-3d');
      if (inline) { Quake3D.init(inline); _quake3dPushGeo(); }
      _3dFullscreenInited = false;
    }
    if (_3dLastFocus && typeof _3dLastFocus.focus === 'function') _3dLastFocus.focus();
    _3dLastFocus = null;
  }

  function bind3DUI() {
    // Desktop inline preview canvas — lazy-init when 3D enabled
    var canvas3d = document.getElementById('canvas-3d');
    if (canvas3d && !isMobile3D) {
      var chk3dInit = document.getElementById('3d-enable');
      var sourceCard = canvas3d.closest ? canvas3d.closest('.info-card') : null;
      if (sourceCard) sourceCard.addEventListener('toggle', function() { if (sourceCard.open) ensureInlinePreview(); });
      if (chk3dInit && chk3dInit.checked && sourceCard && sourceCard.open && canvas3d.offsetParent) ensureInlinePreview();
    }

    // Desktop "open fullscreen 3D" entry button.
    var btnFsOpen = document.getElementById('btn-3d-fullscreen');
    if (btnFsOpen) btnFsOpen.addEventListener('click', show3DFullscreen);

    // Mobile "view 3D" button (lazy-loads scripts then opens fullscreen).
    var mBtn = document.getElementById('btn-3d-mobile');
    if (mBtn) mBtn.addEventListener('click', function() {
      var orig = (typeof t === 'function' && t('3d.fullscreen')) || '全屏3D演示';
      mBtn.textContent = (typeof t === 'function' && t('3d.loading')) || '加载中...';
      show3DFullscreen();
      // Restore the button label once scripts are ready (ensure3DScripts is async).
      ensure3DScripts(function() { mBtn.textContent = '🌐 ' + orig; });
    });

    // Fullscreen close button (overlay HTML sits after this script, so this
    // must run after DOMContentLoaded — see the ready guard below).
    var btnClose = document.getElementById('btn-3d-fs-close');
    if (btnClose) btnClose.addEventListener('click', close3DFullscreen);
    var fsOverlay = document.getElementById('3d-fullscreen-overlay');
    if (fsOverlay) fsOverlay.addEventListener('keydown', function(e) {
      trapAccessibleModalKey(e, fsOverlay, close3DFullscreen);
    });

    // Legacy cross/terrain mode buttons -> no-op (single unified scene now).
    ['btn-3d-cross','btn-3d-terrain','btn-3d-fs-cross','btn-3d-fs-terrain'].forEach(function(id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', function() { /* unified scene */ });
    });

    // 3D enable/disable checkbox (toggles inline preview visibility on desktop).
    var chk3d = document.getElementById('3d-enable');
    if (chk3d) {
      chk3d.addEventListener('change', function() {
        var desk = document.getElementById('3d-desktop');
        var mBtn2 = document.getElementById('btn-3d-mobile');
        if (this.checked) {
          if (!isMobile3D && desk) desk.style.display = '';
          if (isMobile3D && mBtn2) mBtn2.style.display = 'block';
          if (!isMobile3D && desk && desk.offsetParent) ensureInlinePreview();
        } else {
          if (desk) desk.style.display = 'none';
          if (mBtn2) mBtn2.style.display = 'none';
        }
      });
      if (isMobile3D) {
        var desk = document.getElementById('3d-desktop');
        if (desk) desk.style.display = 'none';
        if (mBtn) mBtn.style.display = 'block';
      }
    }

    // View angle preset buttons (desktop inline + fullscreen).
    ['top','side','below','front','oblique'].forEach(function(v) {
      var btn = document.getElementById('btn-3d-' + v);
      if (btn) btn.addEventListener('click', function() {
        if (typeof Quake3D !== 'undefined') Quake3D.setViewAngle(v);
      });
      var fsBtn = document.getElementById('btn-3d-fs-' + v);
      if (fsBtn) fsBtn.addEventListener('click', function() {
        if (typeof Quake3D !== 'undefined') Quake3D.setViewAngle(v);
      });
    });
  }

  // The 3D fullscreen overlay HTML is parsed AFTER this <script> tag, so bind
  // UI only once the full DOM is available.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind3DUI);
  } else {
    bind3DUI();
  }

  // Resize handler
  window.addEventListener('resize', function() {
    if (typeof Quake3D !== 'undefined') Quake3D.resize();
  });
})();

// Hook into simLoop to update 3D each frame (guard re-checked every tick so the
// mobile lazy-loaded scene also receives updates after scripts arrive).
var _3dUpdateInterval = setInterval(function() {
  if (typeof Quake3D === 'undefined' || !Quake3D.update) return;
  if (!isRunning && !_replayMode) return;
  var chk = document.getElementById('3d-enable');
  if (chk && !chk.checked) return;
  // v4.2: pass shallow copies to avoid race with simLoop splice on activeEvents
  var ev = (activeEvents && activeEvents.length)
    ? activeEvents.slice()
    : (epicenter ? [{
        lat: epicenter.lat, lng: epicenter.lng, mag: _liveMag,
        depth: _liveDepth, originTime: 0, isMainshock: true,
        pTravel: pTravel, sTravel: sTravel, pRadius: pRadius, sRadius: sRadius,
        id: 'event_main'
      }] : []);
  Quake3D.update({
    simElapsed: simElapsed,
    events: ev,
    epicenter: epicenter,
    strike: parseFloat(strikeSlider.value),
    dip: currentDip,
    sourceType: activeSrcType(),
    rupSpeed: cfgGet('rupSpeed'),
    stations: visibleCircles.slice()
  });
}, 50); // 20fps for 3D (lighter than 60fps)

// ================================================================
//  VISUALIZATION ENHANCEMENTS v3.0
// ================================================================

// --- Plate boundaries ---
var _platesData = null;
(function() {
  fetch('/geojson/plates.json').then(function(r){return r.json();}).then(function(d){_platesData=d; if(typeof _quake3dPushGeo==='function') _quake3dPushGeo();}).catch(function(e){ console.warn('Plates data fetch failed:', e.message); });
})();
// [drawPlateBoundaries] moved to renderer.js (see window.drawPlateBoundaries = Renderer.drawPlateBoundaries)

// --- Historical earthquakes background ---
var _histQuakes = null;
(function() {
  fetch('/geojson/historical_quakes.json').then(function(r){return r.json();}).then(function(d){_histQuakes=d;}).catch(function(e){ console.warn('Historical quakes fetch failed:', e.message); });
})();
// [drawHistoricalQuakes] moved to renderer.js (see window.drawHistoricalQuakes = Renderer.drawHistoricalQuakes)

// --- P-wave ground flash ---
function _isReducedMotion() {
  var chk = document.getElementById('reduce-motion');
  return chk && chk.checked;
}
// [drawPWaveFlash] moved to renderer.js (see window.drawPWaveFlash = Renderer.drawPWaveFlash)

// --- Wave particles ---
var _waveParticles = [];
// [spawnWaveParticles] moved to renderer.js (see window.spawnWaveParticles = Renderer.spawnWaveParticles)
// [drawWaveParticles] moved to renderer.js (see window.drawWaveParticles = Renderer.drawWaveParticles)

// --- Isoseismal lines (contour) ---
// [drawIsoseismalLines] moved to renderer.js (see window.drawIsoseismalLines = Renderer.drawIsoseismalLines)

// --- Building damage heatmap ---
// [drawDamageHeatmap] moved to renderer.js (see window.drawDamageHeatmap = Renderer.drawDamageHeatmap)

// --- Affected population estimate ---
// Coarse city populations retained only as a fallback when prefecture data is unavailable.
var _popData = [
  {lat:35.68,lng:139.76,pop:14000000},{lat:34.69,lng:135.50,pop:8800000},
  {lat:35.18,lng:136.90,pop:7500000},{lat:43.06,lng:141.35,pop:5200000},
  {lat:33.59,lng:130.40,pop:5100000},{lat:38.27,lng:140.87,pop:2300000},
  {lat:34.39,lng:132.46,pop:2800000},{lat:35.44,lng:139.64,pop:9200000},
  {lat:34.69,lng:135.19,pop:5500000},{lat:35.01,lng:135.77,pop:2600000},
  {lat:35.61,lng:140.12,pop:6300000},{lat:35.86,lng:139.65,pop:7300000},
  {lat:32.79,lng:130.74,pop:1740000},{lat:36.57,lng:139.88,pop:1950000},
  {lat:37.90,lng:139.04,pop:2200000},{lat:34.98,lng:138.38,pop:3600000}
];
function calcAffectedPopulation() {
  // Weight each prefecture's population by the fraction of its simulated
  // stations reaching Shindo 1+. This is a network-coverage proxy, not a
  // population mesh, but avoids counting an entire prefecture from one peak.
  if (_reportPrefectureShindos && _prefPopData && _prefGeoData && landPoints.length &&
      Object.keys(_reportPrefectureShindos).length > 0) {
    var stationTotals = {}, affectedStations = {};
    var features = _prefGeoData.features || [];
    for (var si = 0; si < landPoints.length; si++) {
      var station = landPoints[si];
      for (var fi = 0; fi < features.length; fi++) {
        var bbox = _prefBBoxes && _prefBBoxes[fi];
        if (bbox && (station.lng < bbox[0] || station.lng > bbox[2] || station.lat < bbox[1] || station.lat > bbox[3])) continue;
        try {
          if (!turf.booleanPointInPolygon(turf.point([station.lng, station.lat]), features[fi])) continue;
          var stationPid = features[fi].properties.id;
          stationTotals[stationPid] = (stationTotals[stationPid] || 0) + 1;
          if (Physics.shindoNum(station.shindo) >= 1) {
            affectedStations[stationPid] = (affectedStations[stationPid] || 0) + 1;
          }
          break;
        } catch(e) {}
      }
    }
    var total = 0;
    for (var pid = 1; pid <= 47; pid++) {
      if (!stationTotals[pid]) continue;
      var coverage = (affectedStations[pid] || 0) / stationTotals[pid];
      total += (_prefPopData[pid] || 0) * 1000 * coverage;
    }
    return Math.round(total);
  }
  // Fallback: city-level estimate
  if (!isRunning || visibleCircles.length < 3) return 0;
  var total = 0;
  for (var pi = 0; pi < _popData.length; pi++) {
    var p = _popData[pi];
    var bestSh = 0;
    for (var si = 0; si < visibleCircles.length; si++) {
      var c = visibleCircles[si];
      var d = (c.lat - p.lat) * (c.lat - p.lat) + (c.lng - p.lng) * (c.lng - p.lng);
      if (d < 0.5 && Physics.shindoScore(c.shindo) > Physics.shindoScore(bestSh)) bestSh = c.shindo;
    }
    if (Physics.shindoNum(bestSh) >= 1) total += p.pop;
  }
  return total;
}

// --- Timeline replay ---
var _replayData = []; // [{simElapsed, pRadius, sRadius, circleSnapshot}]
var _replayMode = false;
var _replayIdx = 0;
var _replayTimer = null; // replay auto-play interval
var _replaySpeed = 1;   // v4.2: replay speed multiplier
function captureReplayFrame() {
  if (!isRunning || _replayMode) return;
  if (_replayData.length > 1200) return; // cap at 1200 frames (~20min at 1fps)
  if (simElapsed - (_replayData.length > 0 ? _replayData[_replayData.length - 1].t : -1) < 0.5) return;
  _replayData.push({t: simElapsed, pR: pRadius, sR: sRadius, maxSh: _globalMaxShindo});
}

function nearestCityName(lat, lng) {
  var best = null, minD = Infinity;
  for (var i = 0; i < _geoCities.length; i++) {
    var c = _geoCities[i];
    var d = (c.lat - lat) * (c.lat - lat) + (c.lng - lng) * (c.lng - lng);
    if (d < minD) { minD = d; best = c; }
  }
  var distKm = Math.sqrt(minD) * 111.32;
  if (distKm > 200) return '';
  return best.name + (distKm > 30 ? '沖' : '付近');
}

// Boot the app after all modules (incl. ScenarioManager) are defined.

// --- Timeline Replay --- v4.2: auto-play with speed control
function enterReplayMode() {
  if (_replayData.length < 2) return;
  _replayMode = true; isRunning = false;
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  var slider = document.getElementById('replay-slider');
  if (slider) { slider.max = _replayData.length - 1; slider.value = _replayData.length - 1; }
  _replayIdx = _replayData.length - 1;
  updateReplayFrame(_replayIdx);
  // Show replay bar with play/speed controls
  var replayBar = document.getElementById('replay-bar');
  if (replayBar) replayBar.style.display = 'flex';
  var replayCtrls = document.getElementById('replay-controls');
  if (replayCtrls) replayCtrls.style.display = 'flex';
}

function _replayAutoPlay() {
  if (!_replayMode || _replayTimer) return;
  _replayIdx = 0; // start from beginning
  var btn = document.getElementById('replay-play-btn');
  if (btn) btn.textContent = '⏸';
  _replayTimer = setInterval(function() {
    if (!_replayMode) { clearInterval(_replayTimer); _replayTimer = null; return; }
    _replayIdx++;
    if (_replayIdx >= _replayData.length) {
      clearInterval(_replayTimer); _replayTimer = null;
      var btn2 = document.getElementById('replay-play-btn');
      if (btn2) btn2.textContent = '▶';
      return;
    }
    updateReplayFrame(_replayIdx);
  }, Math.round(200 / _replaySpeed));
}

function _replayStopAutoPlay() {
  if (_replayTimer) { clearInterval(_replayTimer); _replayTimer = null; }
  var btn = document.getElementById('replay-play-btn');
  if (btn) btn.textContent = '▶';
}

function _replayTogglePlay() {
  if (_replayTimer) { _replayStopAutoPlay(); return; }
  _replayAutoPlay();
}

function _replaySetSpeed(speed) {
  _replaySpeed = speed;
  var wasPlaying = !!_replayTimer;
  if (wasPlaying) { _replayStopAutoPlay(); _replayAutoPlay(); }
}

function exitReplayMode() {
  _replayMode = false;
  _replayStopAutoPlay();
  var btnReplay = document.getElementById('btn-replay');
  if (btnReplay) btnReplay.style.display = 'none';
  var replayBar = document.getElementById('replay-bar');
  if (replayBar) replayBar.style.display = 'none';
  var replayCtrls = document.getElementById('replay-controls');
  if (replayCtrls) replayCtrls.style.display = 'none';
}

function updateReplayFrame(idx) {
  if (idx < 0 || idx >= _replayData.length) return;
  _replayIdx = idx;
  var f = _replayData[idx];
  // Update displayed metrics
  pRadius = f.pR; sRadius = f.sR;
  var pEl = document.getElementById('p-radius');
  if (pEl) pEl.textContent = Math.round(f.pR);
  var sEl = document.getElementById('s-radius');
  if (sEl) sEl.textContent = Math.round(f.sR);
  // Update max shindo display
  var maxShEl = document.getElementById('max-shindo-value');
  if (maxShEl && f.maxSh != null) maxShEl.textContent = f.maxSh;
  // Update time display
  var rTime = document.getElementById('replay-time');
  if (rTime) rTime.textContent = Math.round(f.t) + 's';
  var slider = document.getElementById('replay-slider');
  if (slider) slider.value = idx;
  // Redraw the frame
  simElapsed = f.t;
  if (typeof drawFrame === 'function') drawFrame();
}


// --- Earthquake Catalog Browser ---
var _catData = [];
function searchCatalog() {
  var listEl = document.getElementById('catalog-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="color:#888;text-align:center;padding:8px">' + t('catalog.loading') + '</div>';
  var dateFrom = document.getElementById('cat-date-from').value;
  var dateTo = document.getElementById('cat-date-to').value;
  var minMag = document.getElementById('cat-minmag').value;
  var params = [];
  if (dateFrom) params.push('starttime=' + encodeURIComponent(dateFrom));
  if (dateTo) params.push('endtime=' + encodeURIComponent(dateTo + 'T23:59:59'));
  params.push('minmag=' + minMag);
  fetch('/api/catalog?' + params.join('&'))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _catData = (data.features || []).map(function(f) {
        var p = f.properties, c = f.geometry.coordinates;
        return { id: f.id, mag: p.mag||0, lat: c[1], lng: c[0], depth: Math.round(c[2]||10),
          place: p.place||'', time: p.time, raw: f };
      });
      _catData.sort(function(a,b) { return b.mag - a.mag; });
      renderCatalog();
    })
    .catch(function() {
      listEl.innerHTML = '<div style="color:#c44;text-align:center;padding:8px">Error loading catalog</div>';
    });
}
function renderCatalog() {
  var listEl = document.getElementById('catalog-list');
  if (!listEl) return;
  if (!_catData.length) {
    listEl.innerHTML = '<div style="color:#888;text-align:center;padding:8px">' + t('catalog.empty') + '</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < _catData.length; i++) {
    var eq = _catData[i];
    var magColor = eq.mag >= 7 ? '#ff6b6b' : eq.mag >= 6 ? '#ff9f43' : eq.mag >= 5 ? '#feca57' : '#aaa';
    var dateStr = new Date(eq.time);
    var ds = isNaN(dateStr) ? '' : (dateStr.getMonth()+1)+'/'+dateStr.getDate()+' ';
    h += '<div class="cat-item" data-idx="' + i + '" style="padding:3px 6px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:6px">'
      + '<span style="color:' + magColor + ';font-weight:700;min-width:36px">M' + eq.mag.toFixed(1) + '</span>'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHTML(eq.place||'') + '</span>'
      + '<span style="color:#888;font-size:.85em">' + ds + eq.depth + 'km</span></div>';
  }
  listEl.innerHTML = h;
  // Click handlers
  listEl.querySelectorAll('.cat-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var eq = _catData[parseInt(this.dataset.idx)];
      if (!eq) return;
      _dipExplicit=false; setEpicenter(eq.lat, eq.lng);
      magSlider.value = eq.mag; document.getElementById('magnitude-num').value = eq.mag;
      magVal.textContent = 'M' + eq.mag.toFixed(1);
      depthSlider.value = eq.depth; document.getElementById('depth-num').value = eq.depth;
      depthVal.textContent = eq.depth + ' km';
      currentRake = 0; _rakeExplicit=false; rakeSlider.value = 0; document.getElementById('rake-num').value = 0; refreshRakeStateLabel();
      epicenterSrc = null; eventMw = null;
      currentPreset = ''; document.getElementById('preset').value = '';
      map.setView([eq.lat, eq.lng], 7);
      updateEpicenterInfo();
      // Switch to Basic tab
      document.querySelector('.tab-btn[data-tab="basic"]').click();
    });
  });
}
// Initialize date fields with defaults
(function() {
  var now = new Date();
  var df = document.getElementById('cat-date-from');
  var dt = document.getElementById('cat-date-to');
  if (df && !df.value) { var d30 = new Date(now - 30*86400000); df.value = d30.toISOString().slice(0,10); }
  if (dt && !dt.value) dt.value = now.toISOString().slice(0,10);
})();


// --- Real-time Waveform Display ---
var _wfData = null, _wfLoadTimer = null;
function fetchWaveform() {
  var sel = document.getElementById('wf-station-sel');
  var parts = (sel ? sel.value : 'IU,MAJO,BHZ').split(',');
  var canvas = document.getElementById('realtime-wf-canvas');
  if (canvas) {
    var ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('加载中...', canvas.width/2, canvas.height/2);
    setCanvasA11yDescription('realtime-wf-canvas', t('a11y.canvas.realtime_loading'));
  }
  var qualityEl=document.getElementById('realtime-wf-quality');
  if(qualityEl)qualityEl.textContent=t('info.waveform_loading');
  fetch('/api/waveform?network=' + parts[0] + '&station=' + parts[1] + '&channel=' + parts[2] + '&components=3&purpose=analysis&durationSeconds=300')
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.error) { console.warn('Waveform:', data.error);if(qualityEl)qualityEl.textContent=t('info.observed_3c_error')+': '+data.error;return; }
      _wfData = data;
      drawRealtimeWaveform();
      if(qualityEl&&typeof WaveformData!=='undefined'){
        try{
          var validation=WaveformData.validate(data),motion=WaveformData.toObservedMotion(data);
          var analysis=Physics.analyzeObservedMotion3C(motion);
          qualityEl.innerHTML='<strong>'+(analysis?'JMA I = '+analysis.intensity.toFixed(2):'--')+'</strong><span>'+(validation.researchReady?t('info.waveform_research_ready'):t('info.waveform_not_certified'))+'</span><small>'+escapeHTML((data.provenance&&data.provenance.provider)||'FDSN')+' · '+escapeHTML(data.units||'')+'</small>';
        }catch(e){qualityEl.textContent=t('info.waveform_not_certified')+': '+e.message;}
      }
    })
    .catch(function(e){ console.warn('Waveform fetch failed:', e);if(qualityEl)qualityEl.textContent=t('info.observed_3c_error'); });
}
function drawRealtimeWaveform() {
  var canvas = document.getElementById('realtime-wf-canvas');
  if (!canvas || !_wfData || !_wfData.data || !_wfData.data.length) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var trace = typeof WaveformData!=='undefined'?WaveformData.legacyTrace(_wfData):_wfData.data[0];
  if(!trace)return;
  var samples = trace.samples;
  if (!samples || samples.length < 2) {
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('无波形数据', W/2, H/2);
    setCanvasA11yDescription('realtime-wf-canvas', t('a11y.canvas.realtime_empty'));
    return;
  }
  // Find max amplitude for scaling
  var absMax = 0;
  for (var i = 0; i < samples.length; i++) { var a = Math.abs(samples[i]); if (a > absMax) absMax = a; }
  if (absMax < 1e-9) absMax = 1;
  var scale = (H * 0.42) / absMax;
  // Draw zero line
  ctx.strokeStyle = '#333'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
  // Draw waveform
  ctx.strokeStyle = '#4da6ff'; ctx.lineWidth = 0.8;
  ctx.beginPath();
  var step = Math.max(1, Math.floor(samples.length / W));
  for (var i = 0; i < W && i * step < samples.length; i++) {
    var idx = i * step;
    var x = i;
    var y = H/2 - samples[idx] * scale;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Labels
  ctx.fillStyle = '#888'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
  ctx.fillText(trace.id, 4, 10);
  var unit=trace.unit||_wfData.units||'';
  ctx.fillText('max:' + absMax.toFixed(unit==='gal'?2:6) + unit + '  ' + trace.sampling_rate + 'Hz  ' + trace.npts + 'spl', 4, H - 4);
  ctx.textAlign = 'right';
  ctx.fillText(trace.starttime ? trace.starttime.slice(0,19).replace('T',' ') : '', W - 4, 10);
  setCanvasA11yDescription('realtime-wf-canvas', t('a11y.canvas.realtime_summary', {
    station:trace.id || '-', max:(absMax*1e6).toFixed(0), rate:trace.sampling_rate, count:trace.npts
  }));
}
// Auto-load on Info tab switch or click
var _wfCanvasEl = document.getElementById('realtime-wf-canvas');
if (_wfCanvasEl) {
  _wfCanvasEl.addEventListener('click', fetchWaveform);
}
var _wfRefreshBtn = document.getElementById('btn-wf-refresh');
if (_wfRefreshBtn) {
  _wfRefreshBtn.addEventListener('click', fetchWaveform);
}

init().then(function(){ refreshCanvasA11yDescriptions(); }).catch(function(e){console.error('Init error:', e);});
// Failsafe: hide map loading overlay after 12s even if init() stalls
setTimeout(function(){
  var mo = document.getElementById('map-loading-overlay');
  if (mo && mo.style.display !== 'none') {
    updateMapLoadingProgress(100, 'Timeout — falling back · タイムアウト');
    setTimeout(function() { mo.style.display = 'none'; }, 400);
    _mapReady = true;
    if (mapEl) mapEl.setAttribute('aria-busy', 'false');
    if (btnStart) btnStart.disabled = false;
  }
}, 12000);
