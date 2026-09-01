// Config — All tunable simulation parameters
// Persisted to localStorage under 'qs-config'

var CFG_DEFAULTS = {
  // Source
  pWaveSpeed:   { v:5.8,  min:3.0, max:8.0,  step:0.1, fmt:'%.1f km/s',  cat:'source' },
  sWaveSpeed:   { v:3.3,  min:1.5, max:5.0,  step:0.1, fmt:'%.1f km/s',  cat:'source' },
  stressDrop:   { v:10,   min:1,   max:50,   step:1,   fmt:'%.0f MPa',   cat:'source' },
  rupSpeed:     { v:2.8,  min:1.5, max:4.5,  step:0.1, fmt:'%.1f km/s',  cat:'source' },
  ruptureVelocityModel:{v:'slip-depth',opts:['slip-depth','depth','constant'],cat:'source'},
  sourceTimeFunction:{v:'half-cosine',opts:['half-cosine','triangle','brune','boxcar'],cat:'source'},
  sourceTypeOverride:{ v:'auto', opts:['auto','crustal','interplate','intraslab'], cat:'source' },
  // Travel-time model (v5.7 R3): jivsm = station-side JIVSM velocity columns
  // composed onto the IASP91 stack (basin delays; needs jivsm-columns.json),
  // iasp91 = legacy layered stack everywhere.
  travelModel:  { v:'iasp91', opts:['iasp91','jivsm'], cat:'source' },
  randomSeed:   { v:20260725, min:0, max:4294967295, step:1, fmt:'%.0f', cat:'source' },

  // Attenuation
  gmpModel:     { v:'auto', opts:['auto','logic-tree','log','si-midorikawa','log-ff','kanno2006','zhao2006'], cat:'atten' },
  // Subdivision uncertainty overlay: dashed outline whose width scales with
  // the Monte Carlo ensemble spread (P10-P90)/2 — runs ensembleIntensityField
  // on every forecast change while enabled (~0.5 s for 97 centroids x 40 members).
  subareaUncertainty: { v:'off', opts:['off','on'], cat:'atten' },
  // Monte Carlo members for the subdivision uncertainty overlay (v5.7 tail):
  // 40 = synchronous main thread (~90 ms, param-keyed cache); >=100 runs in
  // a Worker (ensemble-solver-host.js; measured 423 ms at 97x200 main-thread)
  ensembleMembers: { v:40, min:10, max:500, step:10, fmt:'%.0f', cat:'atten' },
  // v6.1 P2: PSHA return period (years) for the info-tab hazard/UHS card;
  // also driven by the in-card #psha-rp-select (same cfg key)
  pshaReturnPeriod: { v:475, opts:[475, 1000, 2500, 5000], fmt:'%.0f', cat:'atten' },
  attA:         { v:0.42, min:0.10, max:1.50, step:0.01, fmt:'%.2f',      cat:'atten' },
  attB:         { v:1.34, min:0.50, max:2.50, step:0.01, fmt:'%.2f',      cat:'atten' },
  attC:         { v:0.31, min:-1.0, max:2.00, step:0.01, fmt:'%.2f',      cat:'atten' },
  anelastic:    { v:0.001,min:0,    max:0.010,step:0.0001,fmt:'%.4f 1/km',cat:'atten' },
  pgvA:         { v:0.48, min:0.20, max:0.80, step:0.01, fmt:'%.2f',      cat:'atten' },
  pgvB:         { v:1.46, min:0.80, max:2.00, step:0.01, fmt:'%.2f',      cat:'atten' },
  pgvC:         { v:-1.20,min:-2.50,max:0.00, step:0.01, fmt:'%.2f',      cat:'atten' },
  dsInter:      { v:0.124,min:0.00, max:0.30, step:0.001,fmt:'%.3f',      cat:'atten' },
  dsIntra:      { v:0.221,min:0.05, max:0.40, step:0.001,fmt:'%.3f',      cat:'atten' },

  // Site amplification
  siteModel:    { v:'vs30', opts:['vs30','eqlin-1d','geo','none'], cat:'site' },
  intensityScale:{ v:'shindo', opts:['shindo','mmi','ems98'], cat:'display' },
  intensityMethod:{ v:'empirical', opts:['empirical','jma3c'], cat:'display' },
  directivity:  { v:'off', opts:['off','somerville1997'], cat:'atten' },
  siteBase:     { v:1.00, min:0.50, max:2.00, step:0.01, fmt:'%.2f',      cat:'site' },
  siteSoftMax:  { v:1.65, min:1.00, max:3.00, step:0.01, fmt:'%.2f',      cat:'site' },
  siteHardMin:  { v:1.00, min:0.40, max:1.50, step:0.01, fmt:'%.2f',      cat:'site' },
  siteNonlinear:{ v:'off', opts:['off','ss14'], cat:'site' },

  // Aleatory variability (sigma)
  sigmaDisplay: { v:'off', opts:['off','pgaOnly','pgaPgv','exceedance'], cat:'atten' },
  sigmaOverride:{ v:0.0,  min:0.0, max:1.00, step:0.01, fmt:'%.2f',      cat:'atten' },

  // Duration
  holdCoef:     { v:2.5,  min:0.5, max:10.0, step:0.1, fmt:'%.1f s/M',   cat:'time' },
  tauShortCoef: { v:5.0,  min:1.0, max:20.0, step:0.1, fmt:'%.1f s',     cat:'time' },
  tauLongCoef:  { v:6.0,  min:1.0, max:30.0, step:0.1, fmt:'%.1f s',     cat:'time' },

  // Tsunami
  tsuSpeed:     { v:600,  min:200, max:900,  step:10,  fmt:'%.0f km/h',  cat:'tsunami' },
  tsuCoefA:     { v:0.50, min:0.10,max:1.00, step:0.01, fmt:'%.2f',      cat:'tsunami' },
  tsuCoefB:     { v:3.30, min:1.00,max:5.00, step:0.01, fmt:'%.2f',      cat:'tsunami' },
  tsunamiSolver:{ v:'nonlinearSWE', opts:['nonlinearSWE','linearSWE','travelTime'], cat:'tsunami' },
  tsunamiDeformationModel:{v:'dc3d',opts:['dc3d','legacy'],cat:'tsunami'},
  tsunamiHorizontalSlope:{v:'on',opts:['on','off'],cat:'tsunami'},
  tsunamiBoundary:{v:'radiation',opts:['radiation','wall'],cat:'tsunami'},
  // Two-level nested-grid tsunami solver: the 0.15° global grid runs as the
  // coarse level under the auto-selected 0.025° regional grids (two-way AMR,
  // ratio 6), so regional runs stop sealing their outer boundary. 'auto'
  // engages it whenever a regional grid is active and the device has >=4
  // cores; 'on' forces it, 'off' restores the single-grid regional run.
  tsunamiNested:{v:'auto',opts:['auto','on','off'],cat:'tsunami'},
  // v5.8 R5-2: optional Peregrine-type Boussinesq dispersion (exact [0,2]
  // Padé phase speed c²=gh/(1+(kh)²/3) via an ADI Helmholtz correction).
  // 'off' (default) keeps the non-dispersive SWE path byte-identical; the
  // correction matters for trans-oceanic propagation on the coarse grid.
  tsunamiDispersion:{v:'off',opts:['off','boussinesq'],cat:'tsunami'},
  // v5.8 R5-4a: constant tide offset in metres (datum shift; positive tide
  // pre-wets land below that elevation). 0 = mean sea level, byte-identical.
  tsunamiTideOffsetM:{v:0,min:-1,max:2,step:0.1,fmt:'%.1f m',cat:'tsunami'},
  // v5.8 R5-4b: per-cell roughness from the land-use pack
  // (geojson/landuse-manning.json); falls back to the scalar when absent.
  tsunamiRoughness:{v:'uniform',opts:['uniform','landuse'],cat:'tsunami'},
  // v5.8 R5-5: 'per-patch' applies each subfault's DC3D field over its own
  // rupture window; 'cumulative' (default) keeps the legacy whole-field
  // moment-fraction scaling.
  tsunamiDtopoTiming:{v:'cumulative',opts:['cumulative','per-patch'],cat:'tsunami'},
  tsunamiManning:{ v:0.025,min:0.010,max:0.080,step:0.005,fmt:'%.3f', cat:'tsunami' },
  tsunamiDryTolerance:{ v:0.05,min:0.01,max:0.50,step:0.01,fmt:'%.2f m', cat:'tsunami' },
  tsunamiArrivalThreshold:{ v:0.03,min:0.01,max:0.50,step:0.01,fmt:'%.2f m', cat:'tsunami' },
  tsunamiCoriolis:{ v:'on',opts:['on','off'],cat:'tsunami' },
  tsunamiAggregationKm:{ v:15,min:5,max:50,step:5,fmt:'%.0f km',cat:'tsunami' },
  // JMA-style regional mode already applies an uncertainty envelope. Manual
  // uplift is opt-in so a small advisory is not universally promoted.
  tsunamiAlertBias:{ v:0,min:0,max:2,step:1,fmt:'%.0f', cat:'tsunami' },
  tsunamiMapMode:{ v:'cityInundation', opts:['off','waveField','maxSurface','arrivalTime','maxVelocity','hydroLoad','maxInundation','cityInundation','seafloorDeformation'], cat:'tsunami' },

  // Display
  updateHz:     { v:1.0,  min:0.2, max:10.0, step:0.1, fmt:'%.1f Hz',   cat:'display' },
  cirRMin:      { v:7,    min:3,   max:20,   step:1,   fmt:'%.0f px',    cat:'display' },
  cirRMax:      { v:24,   min:10,  max:50,   step:1,   fmt:'%.0f px',    cat:'display' },
  blendZoom:    { v:5,    min:3,   max:14,   step:1,   fmt:'%.0f',       cat:'display' },

  // Aftershock
  asyK:         { v:150,  min:30,  max:500,  step:10,  fmt:'%.0f',       cat:'aftershock' },
  asyP:         { v:1.1,  min:1.01,max:2.0,  step:0.01,fmt:'%.2f',       cat:'aftershock' },
  asyC:         { v:0.1,  min:0.01,max:1.0,  step:0.01,fmt:'%.2f',       cat:'aftershock' },
  asyB:         { v:0.9,  min:0.5, max:1.5,  step:0.05,fmt:'%.2f',       cat:'aftershock' },
  asyEventThr:  { v:5.5,  min:4.0, max:7.0,  step:0.1, fmt:'%.1f M',     cat:'aftershock' },
  maxAsEvents:  { v:5,    min:1,   max:15,   step:1,   fmt:'%.0f',       cat:'aftershock' },
  etasEnable:   { v:0,    min:0,   max:1,     step:1,   fmt:'%.0f',       cat:'aftershock' },
  // Calibrated on USGS sequences (tools/data/etas-calibration-report.json):
  // 0.809 log10 productivity slope * ln(10). Slider max widened to 2.5 to
  // cover Ogata-style alpha up to the supercritical regime.
  etasAlpha:    { v:1.86, min:0.5, max:2.5,   step:0.05,fmt:'%.2f',       cat:'aftershock' },
  catalogCap:   { v:200,  min:50,  max:500,   step:10,  fmt:'%.0f',       cat:'aftershock' },

  // Regional heterogeneity
  regionalQ:    { v:'off', opts:['off','on'], cat:'atten' },

  // Finite-fault / slip distribution (defaults reproduce prior hardcoded behavior)
  faultQ0:        { v:200,  min:50,  max:500,  step:5,   fmt:'%.0f',  cat:'fault' },
  faultQeta:      { v:0.7,  min:0.3, max:1.2,  step:0.01,fmt:'%.2f',  cat:'fault' },
  aspPosStrike:   { v:0.55, min:0,   max:1,    step:0.01,fmt:'%.2f',  cat:'fault' },
  aspPosDip:      { v:0.6,  min:0,   max:1,    step:0.01,fmt:'%.2f',  cat:'fault' },
  aspSigmaI:      { v:0.35, min:0.1, max:0.8,  step:0.01,fmt:'%.2f',  cat:'fault' },
  aspSigmaJ:      { v:0.4,  min:0.1, max:0.8,  step:0.01,fmt:'%.2f',  cat:'fault' },
  hypocenterFrac: { v:0.35, min:0,   max:0.7,  step:0.01,fmt:'%.2f',  cat:'fault' },
  slipPerturbation:{v:0.4, min:0,    max:1,    step:0.01,fmt:'%.2f',  cat:'fault' },
  slipThreshold:  { v:0.30, min:0.1, max:0.6,  step:0.01,fmt:'%.2f',  cat:'fault' },
  ruptureMode:    { v:'bilateral', opts:['bilateral','unilateral'],     cat:'fault' },

  // Waveform spectral synthesis
  spectrumBins:   { v:64,   min:16,  max:128,  step:4,   fmt:'%.0f',  cat:'spectrum' },
  spectrumFMin:   { v:0.5,  min:0.1, max:2,    step:0.05,fmt:'%.2f Hz',cat:'spectrum' },
  spectrumFMax:   { v:20,   min:10,  max:40,   step:0.5, fmt:'%.1f Hz',cat:'spectrum' },
  waveformNoise:  { v:0.05, min:0,   max:0.3,  step:0.01,fmt:'%.2f',    cat:'spectrum' },
  waveformDamping:{ v:0.7,  min:0.3, max:1.0,  step:0.05,fmt:'%.2f',    cat:'spectrum' },

	// Real-time alert thresholds (auto-sim + EEW notifications)
	alertMinMag:    { v:5.0,  min:3.0, max:9.0,  step:0.1, fmt:'%.1f M',   cat:'alert' },
	alertMaxDist:   { v:1500, min:200, max:3000, step:50,  fmt:'%.0f km',  cat:'alert' },
	alertMinShindo: { v:3,    min:1,   max:7,    step:1,   fmt:'%.0f',     cat:'alert' },
};

var CFG = {};
var CFG_CATS = {
  source: 'Source', atten: 'Attenuation', site: 'Site Amp',
  time: 'Duration', tsunami: 'Tsunami', display: 'Display', aftershock: 'Aftershock',
  fault: 'Finite Fault', spectrum: 'Spectrum', alert: 'Alert'
};

// Increment when config schema changes incompatibly (e.g. key renamed, type changed)
var CONFIG_SCHEMA_VERSION = 3;

function cfgLoad() {
  var saved;
  try { saved = localStorage.getItem('qs-config'); } catch(e) { cfgResetAll(); return; }
  if (saved) {
    // Reject oversized payloads (>100KB) to prevent localStorage abuse
    if (saved.length > 100 * 1024) { cfgResetAll(); return; }
    try {
      var s = JSON.parse(saved);
      // Schema version check: reset if saved config is from a future version
      if (s._schemaVer && s._schemaVer > CONFIG_SCHEMA_VERSION) { cfgResetAll(); return; }
      var savedSchema = s._schemaVer || 0;
      if (savedSchema < 2 && s.siteModel === 'geo') {
        s.siteModel = CFG_DEFAULTS.siteModel.v;
      }
      if (savedSchema < 3) {
        // v5 preview previously stored +1 as the default, causing broad
        // over-warning. Migrate once to the JMA-style neutral default.
        s.tsunamiAlertBias = 0;
      }
      for (var k in CFG_DEFAULTS) {
        var raw = s[k], def = CFG_DEFAULTS[k];
        if (raw === undefined) { CFG[k] = def.v; continue; }
        // Validate type matches default
        if (typeof def.v === 'number') {
          var n = Number(raw);
          if (isNaN(n)) { CFG[k] = def.v; continue; }
          // Range validation: clamp to min/max at load time
          if (n < def.min) n = def.min;
          if (n > def.max) n = def.max;
          CFG[k] = n;
        } else if (typeof def.v === 'string') {
          var sv = typeof raw === 'string' ? raw : def.v;
          // If this key has an options list, validate the value is valid
          if (def.opts && def.opts.indexOf(sv) === -1) sv = def.v;
          CFG[k] = sv;
        } else {
          CFG[k] = raw;
        }
      }
      return;
    } catch(e) { /* corrupt JSON → reset to defaults below */ }
  }
  cfgResetAll();
}

function cfgSave() {
  try {
    var o = JSON.parse(JSON.stringify(CFG)); // shallow clone
    o._schemaVer = CONFIG_SCHEMA_VERSION;
    localStorage.setItem('qs-config', JSON.stringify(o));
  } catch(e) {}
}

function cfgResetAll() {
  for (var k in CFG_DEFAULTS) CFG[k] = CFG_DEFAULTS[k].v;
  cfgSave();
}

function cfgReset(key) { if (!CFG_DEFAULTS[key]) return; CFG[key] = CFG_DEFAULTS[key].v; cfgSave(); }

function cfgGet(key) { return CFG[key] !== undefined ? CFG[key] : (CFG_DEFAULTS[key] ? CFG_DEFAULTS[key].v : undefined); }

function cfgSet(key, val) {
  var d = CFG_DEFAULTS[key]; if (!d) return;
  if (typeof d.v === 'number') {
    var n = Number(val);
    if (!isFinite(n)) return;
    if (typeof d.step === 'number') {
      if (d.step < 1) n = parseFloat(n.toFixed(4));
      else if (d.step >= 1) n = Math.round(n);
    }
    if (n < d.min) n = d.min; if (n > d.max) n = d.max;
    CFG[key] = n; cfgSave();
    return;
  }
  if (typeof d.v === 'string') {
    var s = typeof val === 'string' ? val : String(val);
    if (d.opts && d.opts.length && d.opts.indexOf(s) === -1) return;
    CFG[key] = s; cfgSave();
    return;
  }
  CFG[key] = val; cfgSave();
}

function cfgLabel(key) { return key; }

cfgLoad();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CFG_DEFAULTS: CFG_DEFAULTS,
    CFG: CFG,
    cfgLoad: cfgLoad,
    cfgSave: cfgSave,
    cfgResetAll: cfgResetAll,
    cfgReset: cfgReset,
    cfgGet: cfgGet,
    cfgSet: cfgSet,
    cfgLabel: cfgLabel
  };
}
