// renderer.js v5.0 — Map overlay canvas rendering subsystem with view-aware caches
// Extracted from app.js by tools/extract-renderer.js
// All drawing functions that operate on waveCtx/waveCanvas
(function(root) {
  'use strict';
  var Renderer = {};
  var _projectionCache = new Map();
  var _kmScaleCache = new Map();
  var _renderRevision = 0;
  var _layerCaches = Object.create(null);

  function layerCache(name) {
    var cache = _layerCaches[name];
    if (!cache) {
      var canvas = document.createElement('canvas');
      cache = _layerCaches[name] = { canvas: canvas, ctx: canvas.getContext('2d'), key: '' };
    }
    if (cache.canvas.width !== waveCanvas.width || cache.canvas.height !== waveCanvas.height) {
      cache.canvas.width = waveCanvas.width;
      cache.canvas.height = waveCanvas.height;
      cache.key = '';
    }
    return cache;
  }

  function releaseLayerCache(name) {
    var cache = _layerCaches[name];
    if (!cache || (cache.canvas.width <= 1 && cache.canvas.height <= 1)) return;
    cache.canvas.width = 1;
    cache.canvas.height = 1;
    cache.key = '';
  }

  Renderer.invalidateCaches = function() {
    _renderRevision++;
    _projectionCache.clear();
    _kmScaleCache.clear();
    for (var name in _layerCaches) _layerCaches[name].key = '';
    if (typeof _tsuSegDirty !== 'undefined') _tsuSegDirty = true;
  };

  // ---- Coordinate Helpers (bound to Renderer for external use) ----
  Renderer.toCanvas = function(lat, lng) {
    var lngCache = _projectionCache.get(lat);
    if (!lngCache) { lngCache = new Map(); _projectionCache.set(lat, lngCache); }
    var cached = lngCache.get(lng);
    if (cached) return cached;
    var p = map.latLngToContainerPoint([lat,lng]);
    cached = {x:p.x, y:p.y};
    lngCache.set(lng, cached);
    return cached;
  }

  Renderer.kmToPx = function(km, event) {
  var ref = event || epicenter;
  if (!ref) return 0;
  var scaleKey = ref.lat + '|' + ref.lng;
  var cachedScale = _kmScaleCache.get(scaleKey);
  if (cachedScale != null) return km * cachedScale;
  var d = 0.08;
  var rkm = Physics.haversineDist(ref.lat, ref.lng, ref.lat+d, ref.lng);
  var p1 = map.latLngToContainerPoint([ref.lat, ref.lng]);
  var p2 = map.latLngToContainerPoint([ref.lat+d, ref.lng]);
  cachedScale = Math.abs(p2.y-p1.y) / rkm;
  _kmScaleCache.set(scaleKey, cachedScale);
  return km * cachedScale;
}

  Renderer.drawFrame = function() {
  if (!waveCtx) return;
  waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  // Show-all-stations layer renders even before an epicenter is set, so the
  // user can pick observation stations pre-simulation.
  drawAllStations();
  if (!epicenter) return;

  // Detection mode: never show system wave rings — only station circles.
  // The estimated-epicenter overlays (crosses + detected rings) are drawn at
  // the very end of this frame so station circles never cover them.
  var showWaves = !detectMode;

    // Bottom layer: grid, circles, warnings, fault
  if (!_reportActive) {
    drawShakingGrid();
    drawIntensityCircles();
  }
  drawPlateBoundaries();
  drawHistoricalQuakes();
  drawHistoricalTsunamiObservations();
  drawBathymetry();
  drawVs30Field();
  drawResearchTsunami();
  drawTsunamiWarnings();
  drawIsoseismalLines();
  // v5.5 haze fix round 2: drawDamageHeatmap removed — its 15-30 px red discs
  // only appeared around shindo 6+/7 stations and read as the "震度7 圆圈在
  // 发光" halo; the intensity circles already carry that information.
  drawPWaveFlash();
  spawnWaveParticles();
  drawWaveParticles();
  // Fault plane now drawn as Leaflet polygon — see createFaultLayer()

  // Depth progress bars for all active events (hidden in detection mode)
  if (!detectMode && simElapsed > 0) {
    var barH2 = 60, barW2 = 7, barGap2 = 5;
    for (var dei = 0; dei < activeEvents.length; dei++) {
      var dev = activeEvents[dei];
      var devDepth = dev.isMainshock ? _liveDepth : dev.depth;
      if (devDepth <= 10) continue;
      var devP = toCanvas(dev.lat, dev.lng);
      var dpElapsed = simElapsed - dev.originTime;
      var dpPProg = Math.min(1, dev.pTravel / devDepth);
      var dpSProg = Math.min(1, dev.sTravel / devDepth);
      var dpBarY = devP.y - barH2 / 2;
      var devBarX0 = devP.x + 26 + dei * (barW2 * 2 + barGap2 + 8);
      drawDepthBar(devBarX0, dpBarY, barW2, barH2, dpPProg, '#4da6ff', 'P');
      drawDepthBar(devBarX0 + barW2 + barGap2, dpBarY, barW2, barH2, dpSProg, '#ff9f43', 'S');
    }
  }

  // Beach ball focal mechanism at each epicenter (visible for 20s after event start)
  var _bbChk = document.getElementById('beachball-enable');
  if (!detectMode && simElapsed > 0 && (!_bbChk || _bbChk.checked)) {
    var bbR = Math.max(12, Math.min(25, 8 * Math.pow(2, (map.getZoom()-6)/3)));
    for (var bei = 0; bei < activeEvents.length; bei++) {
      var bev = activeEvents[bei];
      var bevAge = simElapsed - bev.originTime;
      if (bevAge < 0 || bevAge > 20) continue;
      // Fade out in last 3 seconds
      var bbAlpha = bevAge > 17 ? (20 - bevAge) / 3 : 1;
      waveCtx.globalAlpha = bbAlpha;
      var bpt = toCanvas(bev.lat, bev.lng);
      // v5.2: chain presets draw each sub-event's own mechanism (the slider
      // only describes the single-event case). Gated on chainEvent so spawned
      // aftershocks don't switch the mainshock off the live sliders.
      var bbMulti = activeEvents.length > 1 && !!activeEvents[0].chainEvent;
      var bStrike = (bbMulti && bev.strike != null) ? bev.strike : parseFloat(strikeSlider.value);
      var bDip = (bbMulti && bev.dip != null) ? bev.dip : (bev.isMainshock ? currentDip : (bev.dip || currentDip));
      var bRake = (bbMulti && bev.rake != null) ? bev.rake : (bev.isMainshock ? currentRake : (bev.rake || currentRake));
      drawBeachBall(waveCtx, bpt.x, bpt.y - bbR - 18, bbR, bStrike, bDip, bRake);
      waveCtx.globalAlpha = 1;
    }
  }
  // PLUM propagation field (detect mode): each qualifying station's CURRENT
  // observed intensity spread outward along the PLUM decay law — the live,
  // magnitude-free prediction footprint, drawn beneath the wave rings.
  if (detectMode && typeof _detectTracks !== 'undefined') drawPlumField();
  // Top layer: wave rings for all active events (hidden during Shindo Report)
  if (showWaves && !_reportActive) {
    for (var ei = 0; ei < activeEvents.length; ei++) {
      drawEventWaves(activeEvents[ei]);
    }
  }
  // Detection-mode overlays (estimated crosses + detected rings) ride above
  // the station circles and every other canvas layer.
  if (detectMode) drawDetectOverlays();
  // Aftershock markers now drawn as Leaflet circleMarkers — see updateAftershockLeafletMarkers()
}

  // PLUM field rendering: radial-gradient discs per source station, radius =
  // the distance at which the PLUM prediction decays to intensity 3.0, color
  // = the station's current shindo. Strongest 150 sources only (frame cost).
  function _plumColorA(hex, a) {
    var h = String(hex || '#fa0').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function drawPlumField() {
    var srcs = [];
    for (var pi = 0; pi < _detectTracks.length; pi++) {
      var s = _detectTracks[pi].plumSrcs;
      if (!s) continue;
      for (var pj = 0; pj < s.length; pj++) srcs.push(s[pj]);
    }
    if (!srcs.length) return;
    srcs.sort(function(a, b) { return b.I - a.I; });
    // v5.5: spatial thinning first (strongest source per ~0.25° cell) — dense
    // networks otherwise stack dozens of overlapping discs into a solid halo.
    var _plumSeen = Object.create(null), thinned = [];
    for (var ti = 0; ti < srcs.length; ti++) {
      var tk = Math.round(srcs[ti].lat / 0.25) + ',' + Math.round(srcs[ti].lng / 0.25);
      if (_plumSeen[tk]) continue;
      _plumSeen[tk] = 1; thinned.push(srcs[ti]);
    }
    srcs = thinned;
    if (srcs.length > 150) srcs.length = 150;
    // v5.5: cap the disc radius (PLUM is a near-field spread; 300 km discs are
    // not "near-field" anything) and bleed the alpha out as the field
    // densifies — unbounded discs saturated into a giant halo.
    // v5.5 haze fix round 2: the global 40/n scale is not enough — in dense
    // near-fields the 45 km discs overlap ~10 deep and stack into the glowing
    // blob users reported. Divide each disc's alpha by its local near-neighbor
    // count so the cumulative field plateaus instead of saturating.
    var plumAlphaScale = Math.min(1, 40 / srcs.length);
    var plumR = [];
    for (var pri = 0; pri < srcs.length; pri++) {
      plumR.push(Math.min(45, 8 * Math.pow(10, (srcs[pri].I - 3.0) / 2.68)));
    }
    for (var i = 0; i < srcs.length; i++) {
      var src = srcs[i];
      var rKm = plumR[i];
      var rPx = kmToPx(rKm, src);
      if (!(rPx > 4) || rPx > waveCanvas.width * 2) continue;
      // local overlap: neighbors whose discs reach this center (equirectangular
      // approx — plenty for <100 km reaches)
      var nbr = 0;
      var cosLat = Math.cos(src.lat * Math.PI / 180);
      for (var nj = 0; nj < srcs.length; nj++) {
        if (nj === i) continue;
        var reach2 = (rKm + plumR[nj]) * 0.5;
        var dLat = (srcs[nj].lat - src.lat) * 111.32;
        if (dLat > reach2 || dLat < -reach2) continue;
        var dLng = (srcs[nj].lng - src.lng) * 111.32 * cosLat;
        if (dLng > reach2 || dLng < -reach2) continue;
        if (dLat * dLat + dLng * dLng < reach2 * reach2) nbr++;
      }
      var dens = 1 / (1 + nbr * 0.6);
      var c = toCanvas(src.lat, src.lng);
      var col = (typeof SHINDO_FILL !== 'undefined' && SHINDO_FILL[Physics.intensityToShindo(src.I)]) || '#fa0';
      var g = waveCtx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rPx);
      g.addColorStop(0, _plumColorA(col, 0.16 * plumAlphaScale * dens));
      g.addColorStop(0.65, _plumColorA(col, 0.06 * plumAlphaScale * dens));
      g.addColorStop(1, _plumColorA(col, 0));
      waveCtx.fillStyle = g;
      waveCtx.beginPath(); waveCtx.arc(c.x, c.y, rPx, 0, Math.PI * 2); waveCtx.fill();
    }
  }

  // Estimated epicenter crosses + detected wave rings (detection mode). Kept
  // as the top-most canvas content so station intensity circles can never
  // hide them, in either detect or normal mode.
  // Ring fade for a track: mirrors the true event's wave retirement (timing
  // only — no position leak), so stale detected rings vanish too.
  // v5.5: aftershock tracks (evIdx >= AS_TRACK_BASE) have no stable position
  // in activeEvents (spawned events get pruned) — resolve them by event id;
  // unresolved (pruned) means long retired, so fade them out instead of
  // leaving ever-growing stale rings on the map.
  function _detectRingFade(evIdx) {
    var fev;
    if (typeof AS_TRACK_BASE !== 'undefined' && evIdx >= AS_TRACK_BASE) {
      fev = null;
      var cat = (typeof aftershockCatalog !== 'undefined') ? aftershockCatalog[evIdx - AS_TRACK_BASE] : null;
      var evId = cat ? ('as_' + cat.id) : null;
      for (var fi = 0; fi < activeEvents.length; fi++) {
        if (activeEvents[fi].id === evId) { fev = activeEvents[fi]; break; }
      }
      if (!fev) return 0;
    } else {
      fev = activeEvents[evIdx];
    }
    if (!fev || fev.waveRetireAt == null || simElapsed <= fev.waveRetireAt) return 1;
    var f = 1 - (simElapsed - fev.waveRetireAt) / WAVE_RETIRE_FADE;
    return f > 0 ? f : 0;
  }
  function drawDetectOverlays() {
  // Primary tracked event (track 0, via the mirrored legacy globals)
  if (detectedEpicenter) {
    var dep = toCanvas(detectedEpicenter.lat, detectedEpicenter.lng);
    var fade0 = _detectRingFade(0);
    if (fade0 > 0) {
    waveCtx.globalAlpha = fade0;
    // Detected P-wave ring
    if (detectedPRadius > 0) {
      var drP = kmToPx(detectedPRadius);
      if (drP > 0 && drP < waveCanvas.width*2) {
        waveCtx.beginPath(); waveCtx.arc(dep.x, dep.y, drP, 0, Math.PI*2);
        waveCtx.strokeStyle = 'rgba(77,166,255,0.20)'; waveCtx.lineWidth = 8; waveCtx.stroke();
        waveCtx.beginPath(); waveCtx.arc(dep.x, dep.y, drP, 0, Math.PI*2);
        waveCtx.strokeStyle = 'rgba(77,166,255,0.9)'; waveCtx.lineWidth = 3;
        waveCtx.setLineDash([6,3]); waveCtx.stroke(); waveCtx.setLineDash([]);
      }
    }
    // Detected S-wave ring
    if (detectedSRadius > 0) {
      var drS = kmToPx(detectedSRadius);
      if (drS > 0 && drS < waveCanvas.width*2) {
        waveCtx.beginPath(); waveCtx.arc(dep.x, dep.y, drS, 0, Math.PI*2);
        waveCtx.strokeStyle = 'rgba(255,159,67,0.22)'; waveCtx.lineWidth = 10; waveCtx.stroke();
        waveCtx.beginPath(); waveCtx.arc(dep.x, dep.y, drS, 0, Math.PI*2);
        waveCtx.strokeStyle = 'rgba(255,159,67,0.92)'; waveCtx.lineWidth = 3.2;
        waveCtx.setLineDash([10,5]); waveCtx.stroke(); waveCtx.setLineDash([]);
      }
    }
    waveCtx.globalAlpha = 1;
    }
    // Uncertainty region: ellipse for large events (fault-aligned), circle for small
    var ur = kmToPx(detectUncertainty);
    if (ur > 0) {
      if (detectedMag >= 7) {
        // Strike-aligned ellipse for large ruptures
        var strRad = parseFloat(strikeSlider.value) * Math.PI / 180;
        var a = ur * 1.5; // semi-major (along strike)
        var b = ur * 0.7; // semi-minor (perpendicular)
        waveCtx.save();
        waveCtx.translate(dep.x, dep.y);
        waveCtx.rotate(strRad - Math.PI/2); // align major axis with strike
        waveCtx.beginPath();
        waveCtx.ellipse(0, 0, a, b, 0, 0, Math.PI*2);
        waveCtx.strokeStyle = 'rgba(255,165,0,0.4)'; waveCtx.lineWidth = 2;
        waveCtx.setLineDash([4,4]); waveCtx.stroke(); waveCtx.setLineDash([]);
        waveCtx.restore();
      } else {
        waveCtx.beginPath(); waveCtx.arc(dep.x, dep.y, ur, 0, Math.PI*2);
        waveCtx.strokeStyle = 'rgba(255,165,0,0.4)'; waveCtx.lineWidth = 2;
        waveCtx.setLineDash([4,4]); waveCtx.stroke(); waveCtx.setLineDash([]);
      }
    }
    // Estimated epicenter cross
    waveCtx.strokeStyle = 'rgba(255,140,0,0.9)'; waveCtx.lineWidth = 2;
    var cs = 12;
    waveCtx.beginPath(); waveCtx.moveTo(dep.x-cs, dep.y-cs); waveCtx.lineTo(dep.x+cs, dep.y+cs); waveCtx.stroke();
    waveCtx.beginPath(); waveCtx.moveTo(dep.x+cs, dep.y-cs); waveCtx.lineTo(dep.x-cs, dep.y+cs); waveCtx.stroke();
    // Label with bulletin
    waveCtx.save(); waveCtx.font = 'bold 10px sans-serif'; waveCtx.fillStyle = detectFinal ? (detectConverged ? '#0f0' : '#ff0') : '#fa0';
    waveCtx.textAlign = 'left';
    var blabel = detectFinal
      ? ('FINAL #' + detectBulletin + (detectConverged ? '' : ' (timeout)'))
      : (detectBulletin > 0 ? '#' + detectBulletin : '');
    if (blabel) waveCtx.fillText(blabel, dep.x+15, dep.y-15);
    waveCtx.fillText('M'+detectedMag.toFixed(1)+'  ±'+Math.round(detectUncertainty)+'km', dep.x+15, dep.y-2);
    waveCtx.fillText(detectStationCount+' stns', dep.x+15, dep.y+11);
    waveCtx.restore();
  }

  // Later sub-events: each concurrent detection track gets its own estimated
  // cross, dashed P/S rings and uncertainty circle (SREV-style).
  if (typeof _detectTracks !== 'undefined' && _detectTracks.length > 1) {
    for (var dci = 1; dci < _detectTracks.length; dci++) {
      var dce = _detectTracks[dci];
      if (!dce.epi || dce.bulletin < 1) continue;
      var dcp = toCanvas(dce.epi.lat, dce.epi.lng);
      if (!dcp) continue;
      var dceRef = {lat: dce.epi.lat, lng: dce.epi.lng};
      var fadeN = _detectRingFade(dce.evIdx);
      if (fadeN > 0) {
      waveCtx.globalAlpha = fadeN;
      if (dce.pR > 0) {
        var dcrP = kmToPx(dce.pR, dceRef);
        if (dcrP > 0 && dcrP < waveCanvas.width * 2) {
          waveCtx.beginPath(); waveCtx.arc(dcp.x, dcp.y, dcrP, 0, Math.PI * 2);
          waveCtx.strokeStyle = 'rgba(77,166,255,0.17)'; waveCtx.lineWidth = 7; waveCtx.stroke();
          waveCtx.beginPath(); waveCtx.arc(dcp.x, dcp.y, dcrP, 0, Math.PI * 2);
          waveCtx.strokeStyle = 'rgba(77,166,255,0.85)'; waveCtx.lineWidth = 2.6;
          waveCtx.setLineDash([6, 3]); waveCtx.stroke(); waveCtx.setLineDash([]);
        }
      }
      if (dce.sR > 0) {
        var dcrS = kmToPx(dce.sR, dceRef);
        if (dcrS > 0 && dcrS < waveCanvas.width * 2) {
          waveCtx.beginPath(); waveCtx.arc(dcp.x, dcp.y, dcrS, 0, Math.PI * 2);
          waveCtx.strokeStyle = 'rgba(255,159,67,0.19)'; waveCtx.lineWidth = 9; waveCtx.stroke();
          waveCtx.beginPath(); waveCtx.arc(dcp.x, dcp.y, dcrS, 0, Math.PI * 2);
          waveCtx.strokeStyle = 'rgba(255,159,67,0.88)'; waveCtx.lineWidth = 2.8;
          waveCtx.setLineDash([10, 5]); waveCtx.stroke(); waveCtx.setLineDash([]);
        }
      }
      waveCtx.globalAlpha = 1;
      }
      var dcu = kmToPx(dce.unc, dceRef);
      if (dcu > 2 && dcu < waveCanvas.width * 2) {
        waveCtx.beginPath(); waveCtx.arc(dcp.x, dcp.y, dcu, 0, Math.PI * 2);
        waveCtx.strokeStyle = 'rgba(255,165,0,0.4)'; waveCtx.lineWidth = 1.6;
        waveCtx.setLineDash([4, 4]); waveCtx.stroke(); waveCtx.setLineDash([]);
      }
      waveCtx.strokeStyle = 'rgba(255,140,0,0.9)'; waveCtx.lineWidth = 2;
      var cs2 = 10;
      waveCtx.beginPath(); waveCtx.moveTo(dcp.x - cs2, dcp.y - cs2); waveCtx.lineTo(dcp.x + cs2, dcp.y + cs2); waveCtx.stroke();
      waveCtx.beginPath(); waveCtx.moveTo(dcp.x + cs2, dcp.y - cs2); waveCtx.lineTo(dcp.x - cs2, dcp.y + cs2); waveCtx.stroke();
      waveCtx.save(); waveCtx.font = 'bold 10px sans-serif';
      waveCtx.fillStyle = dce.final ? (dce.converged ? '#0f0' : '#ff0') : '#fa0';
      waveCtx.textAlign = 'left';
      waveCtx.fillText('M' + (dce.mag || 0).toFixed(1) + '  ±' + Math.round(dce.unc) + 'km', dcp.x + 13, dcp.y - 8);
      waveCtx.fillText(dce.final ? ('FINAL #' + dce.bulletin) : ('#' + dce.bulletin), dcp.x + 13, dcp.y + 5);
      waveCtx.restore();
    }
  }

  // Detected aftershocks
  if (detectedAftershocks.length > 0) {
    for (var dai = 0; dai < detectedAftershocks.length; dai++) {
      var da = detectedAftershocks[dai];
      if (da.time > simElapsed + 30) continue;
      var dap2 = toCanvas(da.lat, da.lng);
      if (!dap2) continue;
      // Small orange cross
      waveCtx.strokeStyle = 'rgba(255,130,40,0.7)'; waveCtx.lineWidth = 1.5;
      var cs3 = 7;
      waveCtx.beginPath(); waveCtx.moveTo(dap2.x - cs3, dap2.y - cs3);
      waveCtx.lineTo(dap2.x + cs3, dap2.y + cs3); waveCtx.stroke();
      waveCtx.beginPath(); waveCtx.moveTo(dap2.x + cs3, dap2.y - cs3);
      waveCtx.lineTo(dap2.x - cs3, dap2.y + cs3); waveCtx.stroke();
      // Dashed uncertainty circle
      var ur3 = kmToPx(da.uncertainty, da);
      if (ur3 > 2 && ur3 < waveCanvas.width * 2) {
        waveCtx.beginPath(); waveCtx.arc(dap2.x, dap2.y, ur3, 0, Math.PI * 2);
        waveCtx.strokeStyle = 'rgba(255,150,60,0.3)'; waveCtx.lineWidth = 1.2;
        waveCtx.setLineDash([2, 3]); waveCtx.stroke(); waveCtx.setLineDash([]);
      }
      // Label
      waveCtx.save(); waveCtx.font = 'bold 8px sans-serif'; waveCtx.fillStyle = '#fa0';
      waveCtx.textAlign = 'left';
      waveCtx.fillText('AS M' + da.mag.toFixed(1), dap2.x + 9, dap2.y - 4);
      waveCtx.restore();
    }
  }
}


  Renderer.drawEventWaves = function(event) {
  if (!event) return;
  var mag = event.mag;
  var depth = event.isMainshock ? _liveDepth : event.depth;
  var waveLat = event.lat, waveLng = event.lng;
  var epP = toCanvas(waveLat, waveLng);
  var geometry=event.sourceModel&&event.sourceModel.geometry;
  // Retired event (S front past every land station + grace): fade the P/S and
  // patch rings out over WAVE_RETIRE_FADE s, then stop drawing them. The
  // tsunami ring below and the epicenter marker live on their own schedules.
  var waveFade = 1;
  if (event.waveRetireAt != null && simElapsed > event.waveRetireAt) {
    waveFade = 1 - (simElapsed - event.waveRetireAt) / WAVE_RETIRE_FADE;
    if (waveFade < 0) waveFade = 0;
  }
  if (waveFade > 0) {
  waveCtx.globalAlpha = waveFade;
  if(mag>=6.5&&geometry&&geometry.subs&&geometry.subs.length){
    var subs=geometry.subs,limit=14,stride=Math.max(1,Math.floor(subs.length/limit)),selected=[];
    var maxSub=subs[0],nucleationSub=subs[0];for(var ms=1;ms<subs.length;ms++){if(subs[ms].slipWeight>maxSub.slipWeight)maxSub=subs[ms];if(subs[ms].ruptureTime<nucleationSub.ruptureTime)nucleationSub=subs[ms];}
    selected.push(nucleationSub);if(maxSub!==nucleationSub)selected.push(maxSub);
    for(var si=0;si<subs.length&&selected.length<limit;si+=stride)if(subs[si]!==maxSub)selected.push(subs[si]);
    var elapsed=simElapsed-(event.originTime||0),pSpeed=cfgGet('pWaveSpeed'),sSpeed=cfgGet('sWaveSpeed');
    for(var fi=0;fi<selected.length;fi++){
      var sub=selected[fi],age=elapsed-sub.ruptureTime;if(age<=0)continue;
      var center=toCanvas(sub.lat,sub.lng),maxSlipWeight=geometry.maxSlipWeight||
        geometry.maxSlipM/Math.max(geometry.averageSlipM,1e-9),
        slipAlpha=0.16+0.24*Math.min(1,(sub.slipWeight||1)/Math.max(1,maxSlipWeight));
      var pTravel=age*pSpeed,pRadius=pTravel>sub.depth?Math.sqrt(pTravel*pTravel-sub.depth*sub.depth):0;
      var sTravel=age*sSpeed,sRadius=sTravel>sub.depth?Math.sqrt(sTravel*sTravel-sub.depth*sub.depth):0;
      if(pRadius>0){var pr=kmToPx(pRadius,sub);if(pr>0&&pr<waveCanvas.width*2){waveCtx.beginPath();waveCtx.arc(center.x,center.y,pr,0,Math.PI*2);waveCtx.strokeStyle='rgba(77,166,255,'+slipAlpha.toFixed(3)+')';waveCtx.lineWidth=1.6;waveCtx.stroke();}}
      if(sRadius>0){var sr=kmToPx(sRadius,sub);if(sr>0&&sr<waveCanvas.width*2){waveCtx.beginPath();waveCtx.arc(center.x,center.y,sr,0,Math.PI*2);waveCtx.strokeStyle='rgba(255,159,67,'+Math.min(.48,slipAlpha+.06).toFixed(3)+')';waveCtx.lineWidth=2;waveCtx.stroke();}}
    }
  }
  // P-wave ring (blue, same style for all events)
  // The hypocentral front remains the readable event-scale envelope. Finite-
  // fault patch fronts add rupture detail but must not replace this main ring.
  if (event.pRadius > 0 && event.pTravel > depth) {
    var displayPRadius = event.pRadius;
    var r = kmToPx(displayPRadius, {lat: waveLat, lng: waveLng});
    if (r > 0 && r < waveCanvas.width * 2) {
      waveCtx.beginPath(); waveCtx.arc(epP.x, epP.y, r, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba(77,166,255,0.20)'; waveCtx.lineWidth = 9; waveCtx.stroke();
      waveCtx.beginPath(); waveCtx.arc(epP.x, epP.y, r, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba(77,166,255,0.95)'; waveCtx.lineWidth = 3.2;
      waveCtx.setLineDash([8, 4]); waveCtx.stroke(); waveCtx.setLineDash([]);
      if (r > 40) {
        waveCtx.save(); waveCtx.font = 'bold 11px sans-serif';
        waveCtx.fillStyle = '#4da6ff'; waveCtx.shadowColor = 'rgba(0,0,0,.8)'; waveCtx.shadowBlur = 4;
        waveCtx.fillText('P', epP.x + 6, epP.y - r + 14);
        waveCtx.restore();
      }
    }
  }
  // S-wave ring (orange, same style for all events)
  if (event.sRadius > 0 && event.sTravel > depth) {
    var displaySRadius = event.sRadius;
    var r2 = kmToPx(displaySRadius, {lat: waveLat, lng: waveLng});
    if (r2 > 0 && r2 < waveCanvas.width * 2) {
      waveCtx.beginPath(); waveCtx.arc(epP.x, epP.y, r2, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba(255,159,67,0.22)'; waveCtx.lineWidth = 12; waveCtx.stroke();
      waveCtx.beginPath(); waveCtx.arc(epP.x, epP.y, r2, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba(255,159,67,0.96)'; waveCtx.lineWidth = 3.6;
      waveCtx.setLineDash([12, 6]); waveCtx.stroke(); waveCtx.setLineDash([]);
      if (r2 > 40) {
        waveCtx.save(); waveCtx.font = 'bold 11px sans-serif';
        waveCtx.fillStyle = '#ff9f43'; waveCtx.shadowColor = 'rgba(0,0,0,.8)'; waveCtx.shadowBlur = 4;
        waveCtx.fillText('S', epP.x + 6, epP.y - r2 + 14);
        waveCtx.restore();
      }
    }
  }
  waveCtx.globalAlpha = 1;
  }
  // Tsunami ring for ocean events
  if (event.tsunamiRadius > 0) {
    var r3 = kmToPx(event.tsunamiRadius, event);
    if (r3 > 0 && r3 < waveCanvas.width * 2) {
      waveCtx.beginPath(); waveCtx.arc(epP.x, epP.y, r3, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba(0,210,210,0.25)'; waveCtx.lineWidth = 12; waveCtx.stroke();
      waveCtx.beginPath(); waveCtx.arc(epP.x, epP.y, r3, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba(0,220,220,0.65)'; waveCtx.lineWidth = 3;
      waveCtx.setLineDash([16, 8]); waveCtx.stroke(); waveCtx.setLineDash([]);
      if (r3 > 50) {
        waveCtx.save(); waveCtx.font = 'bold 12px sans-serif'; waveCtx.fillStyle = '#0dc';
        waveCtx.shadowColor = 'rgba(0,0,0,.8)'; waveCtx.shadowBlur = 4;
        waveCtx.fillText(t('tsunami.wave'), epP.x + 6, epP.y - r3 + 14); waveCtx.restore();
      }
    }
  }
}

  Renderer.drawDepthBar = function(x, y, w, h, progress, color, label) {
  // Background
  waveCtx.fillStyle = 'rgba(0,0,0,0.6)'; waveCtx.fillRect(x-1, y-1, w+2, h+2);
  // Empty
  waveCtx.fillStyle = 'rgba(255,255,255,0.15)'; waveCtx.fillRect(x, y, w, h);
  // Filled from bottom
  var fh = h * progress;
  waveCtx.fillStyle = color; waveCtx.fillRect(x, y + h - fh, w, fh);
  // Label on top
  waveCtx.save(); waveCtx.font = 'bold 9px sans-serif'; waveCtx.fillStyle = color;
  waveCtx.textAlign = 'center'; waveCtx.fillText(label, x + w/2, y - 6);
  if (progress < 1) waveCtx.fillText(Math.round(progress*100)+'%', x + w/2, y + h + 13);
  else waveCtx.fillText('OK', x + w/2, y + h + 13);
  waveCtx.restore();
}

  Renderer.drawShakingGrid = function() {
  // At national scale the station layer switches to compact solid dots.
  // Suppress the rectangular grid so it does not obscure that overview.
  if (map.getZoom() < cfgGet('blendZoom')) return;
  var keys = Object.keys(activeGridCells); if (!keys.length) return;
  var bounds = map.getBounds(), pad = 0.3;
  // Debug: log shindo distribution of grid cells (once per second)
  if (!drawShakingGrid._lastLog || Date.now() - drawShakingGrid._lastLog > 2000) {
    var dist = {};
    for (var dk in activeGridCells) { var ds = activeGridCells[dk]; dist[ds] = (dist[ds]||0)+1; }
    // Debug: grid cell shindo distribution (verbose — uncomment to debug)
    // console.log('Grid cells by shindo:', JSON.stringify(dist));
    drawShakingGrid._lastLog = Date.now();
  }
  for (var k in activeGridCells) {
    var c = gridCells[parseInt(k)];
    if (!c || !c.onLand) continue;
    if (c.maxLat < bounds.getSouth()-pad || c.minLat > bounds.getNorth()+pad ||
        c.minLng < bounds.getWest()-pad || c.maxLng > bounds.getEast()+pad) continue;
    var sh = activeGridCells[k];
    // v5.5 haze fix: shindo 1-2 cells carry no actionable information (the
    // stations already show it) and their pale-blue blocks used to veil the
    // whole map in a grey wash ("灰蒙蒙的色块"). Grid blocks start at 3.
    if (Physics.shindoNum(sh) < Physics.shindoNum(3)) continue;
    var fill = SHINDO_FILL[sh];
    if (!fill) continue;
    var fR = parseInt(fill.slice(1,3),16), fG = parseInt(fill.slice(3,5),16), fB = parseInt(fill.slice(5,7),16);
    var tl = toCanvas(c.maxLat, c.minLng), br = toCanvas(c.minLat, c.maxLng);
    // v5.5 haze fix round 2: 0.40/0.12 -> 0.22/0.07 — the 0.5° blocks tinted
    // whole regions; they only need to hint the cell max, not paint it.
    waveCtx.strokeStyle = 'rgba('+fR+','+fG+','+fB+',0.22)'; waveCtx.lineWidth = 1;
    waveCtx.strokeRect(tl.x, tl.y, br.x-tl.x, br.y-tl.y);
    waveCtx.fillStyle = 'rgba('+fR+','+fG+','+fB+',0.07)';
    waveCtx.fillRect(tl.x, tl.y, br.x-tl.x, br.y-tl.y);
  }
}

  function projectFocalVector(v, r) {
    var z = Math.max(0, Math.min(1, v.z));
    var theta = Math.acos(z);
    var rho = Math.sqrt(2) * Math.sin(theta / 2);
    var h = Math.sqrt(Math.max(1e-12, v.x*v.x + v.y*v.y));
    return {x:r * rho * (v.y / h), y:r * rho * (v.x / h)};
  }

  // Standard lower-hemisphere equal-area beach ball. Black is compression
  // (positive radiation), white is dilatation; the nodal curves emerge from
  // the same moment tensor used by the physics engine.
  Renderer.drawBeachBall = function(ctx, cx, cy, r, strikeDeg, dipDeg, rakeDeg, options) {
    options = options || {};
    var fm = options.mechanism || (typeof Physics !== 'undefined' && Physics.focalMechanism
      ? Physics.focalMechanism({strike:strikeDeg,dip:dipDeg,rake:rakeDeg,momentNm:1}) : null);
    ctx.save(); ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.clip();
    ctx.fillStyle = options.background || 'rgba(245,245,245,0.96)';
    ctx.fillRect(-r-1,-r-1,2*r+2,2*r+2);
    if (fm && fm.tensor) {
      var side = Math.max(1,Math.ceil(2*r+2)), pixelCanvas=document.createElement('canvas');
      pixelCanvas.width=side; pixelCanvas.height=side;
      var pixelCtx=pixelCanvas.getContext('2d'), image=pixelCtx.createImageData(side,side);
      var data=image.data, radius=r;
      for (var py=0; py<side; py++) for (var px=0; px<side; px++) {
        var sx=px-side/2+0.5, sy=py-side/2+0.5, rr=Math.sqrt(sx*sx+sy*sy);
        if (rr>radius) continue;
        var q=rr/radius, theta=2*Math.asin(Math.min(1,q/Math.sqrt(2))), az=Math.atan2(sx,sy);
        var v={x:Math.sin(theta)*Math.cos(az),y:Math.sin(theta)*Math.sin(az),z:Math.cos(theta)};
        var m=fm.tensor, rad=m.xx*v.x*v.x+m.yy*v.y*v.y+m.zz*v.z*v.z+2*(m.xy*v.x*v.y+m.xz*v.x*v.z+m.yz*v.y*v.z);
        if (rad>0) { var off=(py*side+px)*4; data[off]=45; data[off+1]=45; data[off+2]=50; data[off+3]=235; }
      }
      pixelCtx.putImageData(image,0,0);
      ctx.drawImage(pixelCanvas,-Math.floor(side/2),-Math.floor(side/2));
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.strokeStyle=options.border||'rgba(40,40,45,0.95)'; ctx.lineWidth=1.5; ctx.stroke();
  };

  // Larger annotated diagram for the Info page. P/T/B arrows use the same
  // lower-hemisphere projection as the black/white radiation pattern.
  Renderer.drawFocalMechanismDiagram = function(canvas, fm, options) {
    if (!canvas || !fm) return;
    options = options || {};
    var ctx=canvas.getContext('2d'), w=canvas.width, h=canvas.height, r=Math.min(w,h)*0.34;
    ctx.clearRect(0,0,w,h); ctx.fillStyle=getComputedStyle(canvas).getPropertyValue('--panel-bg')||'transparent';
    ctx.fillRect(0,0,w,h);
    Renderer.drawBeachBall(ctx,w*0.38,h*0.48,r,0,90,0,{mechanism:fm});
    // Project the two nodal great circles from their plane normals.
    [fm.plane1, fm.plane2].forEach(function(plane, planeIndex) {
      if (!plane || !plane.normal) return;
      var n=plane.normal, ref=Math.abs(n.z)<0.9?{x:0,y:0,z:1}:{x:1,y:0,z:0};
      var a={x:n.y*ref.z-n.z*ref.y,y:n.z*ref.x-n.x*ref.z,z:n.x*ref.y-n.y*ref.x};
      var al=Math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z); a.x/=al;a.y/=al;a.z/=al;
      var b={x:n.y*a.z-n.z*a.y,y:n.z*a.x-n.x*a.z,z:n.x*a.y-n.y*a.x};
      ctx.save(); ctx.strokeStyle=planeIndex?'rgba(70,170,230,.9)':'rgba(245,166,35,.95)'; ctx.lineWidth=1.4; ctx.setLineDash([5,3]); ctx.beginPath();
      var drawing=false;
      for(var i=0;i<=180;i++){var th=i*Math.PI/90,v={x:a.x*Math.cos(th)+b.x*Math.sin(th),y:a.y*Math.cos(th)+b.y*Math.sin(th),z:a.z*Math.cos(th)+b.z*Math.sin(th)};if(v.z<0){drawing=false;continue;}var q=projectFocalVector(v,r),x=w*.38+q.x,y=h*.48+q.y;if(!drawing){ctx.moveTo(x,y);drawing=true;}else ctx.lineTo(x,y);} ctx.stroke(); ctx.restore();
    });
    var axes=fm.axes||{};
    Object.keys(axes).forEach(function(name){
      var p=projectFocalVector(axes[name].vector,r), x=w*0.38+p.x, y=h*0.48+p.y;
      ctx.strokeStyle=name==='P'?'#4c78a8':(name==='T'?'#e45756':'#54a24b'); ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(w*0.38,h*0.48);ctx.lineTo(x,y);ctx.stroke();
      ctx.fillStyle=ctx.strokeStyle;ctx.font='bold 12px sans-serif';ctx.fillText(name,x+4,y-3);
    });
    // Plot imported first-motion observations on the same lower-hemisphere
    // projection. Filled circles are compressional; open circles are dilatational.
    if (Array.isArray(options.observations)) options.observations.forEach(function(obs) {
      var az = Number(obs.azimuthDeg), tk = Number(obs.takeoffDeg);
      if (!isFinite(az) || !isFinite(tk)) return;
      var ar=az*Math.PI/180, tr=Math.max(0,Math.min(180,tk))*Math.PI/180, z=Math.cos(tr);
      if (String(options.takeoffConvention||'down').toLowerCase()==='up') z=-z;
      var v={x:Math.sin(tr)*Math.cos(ar),y:Math.sin(tr)*Math.sin(ar),z:z};
      // Radiation is antipodally symmetric; fold upper rays into the lower
      // hemisphere for a conventional beachball display.
      if (v.z<0) { v.x=-v.x; v.y=-v.y; v.z=-v.z; }
      var op=projectFocalVector(v,r), ox=w*.38+op.x, oy=h*.48+op.y, positive=Number(obs.observedPolarity||obs.polarity)>0;
      ctx.save(); ctx.beginPath(); ctx.arc(ox,oy,4,0,Math.PI*2); ctx.lineWidth=1.2;
      ctx.fillStyle=positive?'#222':'#f7f7f7'; ctx.strokeStyle=positive?'#f7f7f7':'#222';
      if (!positive) ctx.setLineDash([2,1]); ctx.fill(); ctx.stroke(); ctx.restore();
    });
    ctx.fillStyle='#aab4c8';ctx.font='bold 11px sans-serif';
    ctx.fillText('N',w*.38-4,h*.48-r-7);ctx.fillText('S',w*.38-4,h*.48+r+15);
    ctx.fillText('E',w*.38+r+8,h*.48+4);ctx.fillText('W',w*.38-r-15,h*.48+4);
    ctx.fillStyle='#aab4c8';ctx.font='11px sans-serif';ctx.fillText('NED · black = compression',w*0.04,h-8);
  };

  Renderer.drawBathymetry = function() {
  if (!_bathyGrid || !_bathyShow) { releaseLayerCache('bathymetry'); return; }
  var z = map.getZoom();
  if (z < 5) return; // too far out to be useful
  var cache = layerCache('bathymetry');
  var cacheKey = _renderRevision + '|' + z + '|' + _bathyGrid.nx + 'x' + _bathyGrid.ny + '@' + _bathyGrid.res;
  if (cache.key === cacheKey) { waveCtx.drawImage(cache.canvas, 0, 0); return; }
  var targetCtx = cache.ctx;
  targetCtx.clearRect(0, 0, cache.canvas.width, cache.canvas.height);
  var bounds = map.getBounds();
  var sw = map.latLngToContainerPoint(bounds.getSouthWest());
  var ne = map.latLngToContainerPoint(bounds.getNorthEast());
  var pixelW = ne.x - sw.x, pixelH = sw.y - ne.y;
  var res = _bathyGrid.res;
  var ox = _bathyGrid.origin[0], oy = _bathyGrid.origin[1];
  var nx = _bathyGrid.nx, ny = _bathyGrid.ny;
  var d = _bathyGrid.data;

  // Cell size in pixels (approximate at current zoom)
  var cellDegPerPix = (bounds.getEast() - bounds.getWest()) / pixelW;
  var drawStride = Math.max(1, Math.floor(cellDegPerPix / res * 0.7));
  var cellPix = Math.max(2, Math.floor(res / cellDegPerPix));

  // Find visible grid range
  var sLat = bounds.getSouth(), nLat = bounds.getNorth();
  var wLng = bounds.getWest(), eLng = bounds.getEast();
  var ix0 = Math.max(0, Math.floor((wLng - ox) / res));
  var iy0 = Math.max(0, Math.floor((sLat - oy) / res));
  var ix1 = Math.min(nx - 1, Math.ceil((eLng - ox) / res));
  var iy1 = Math.min(ny - 1, Math.ceil((nLat - oy) / res));

  var opacity = 0.18; // very subtle overlay

  for (var iy = iy0; iy <= iy1; iy += drawStride) {
    for (var ix = ix0; ix <= ix1; ix += drawStride) {
      var depthM = d[iy * nx + ix];
      if (depthM >= 0) continue; // skip land
      var absD = -depthM; // positive depth in meters
      // Color: deep blue (deep) → light blue (shallow)
      var r, g, b;
      if (absD > 4000)      { r = 10;  g = 30;  b = 100; }
      else if (absD > 2000) { var t2 = (absD - 2000) / 2000; r = Math.round(10 + t2 * 20);  g = Math.round(30 + t2 * 80);  b = Math.round(100 + t2 * 120); }
      else if (absD > 500)  { var t1 = (absD - 500) / 1500;  r = Math.round(30 + t1 * 50);  g = Math.round(110 + t1 * 90); b = Math.round(220 + t1 * 35); }
      else if (absD > 100)  { var t0 = (absD - 100) / 400;   r = Math.round(80 + t0 * 100); g = Math.round(200 + t0 * 40); b = Math.round(255); }
      else                   { r = 180; g = 230; b = 255; }
      var color = 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
      var lngC = ox + ix * res, latC = oy + iy * res;
      var cp = map.latLngToContainerPoint([latC, lngC]);
      var cs = cellPix * drawStride;
      targetCtx.fillStyle = color;
      targetCtx.fillRect(cp.x - cs/2, cp.y - cs/2, cs, cs);
    }
  }
  cache.key = cacheKey;
  waveCtx.drawImage(cache.canvas, 0, 0);
}

  Renderer.drawTsunamiWarnings = function() {
  if (!tsunamiCircles.length || !_tsunamiEl || !_tsunamiEl.checked) return;
  _tsuWarnFrame++;
  // Warning updates mark the segment cache dirty. Between updates, reuse it so
  // coastline classification is not repeated on every animation frame.
  if (_tsuSegDirty) {
    _tsuSegCache = computeTsuSegments();
    _tsuSegDirty = false;
  }
  var bounds = map.getBounds(), pad = 0.5;

  // Coastal colored lines (cached geometry, redrawn every frame at the current zoom)
  for (var i = 0; i < _tsuSegCache.length; i++) {
    var s = _tsuSegCache[i];
    var p1 = toCanvas(s.lat1, s.lng1);
    var p2 = toCanvas(s.lat2, s.lng2);
    waveCtx.strokeStyle = s.glow; waveCtx.lineWidth = 14; waveCtx.lineCap = 'round';
    waveCtx.beginPath(); waveCtx.moveTo(p1.x, p1.y); waveCtx.lineTo(p2.x, p2.y); waveCtx.stroke();
    waveCtx.strokeStyle = s.color; waveCtx.lineWidth = 8;
    waveCtx.beginPath(); waveCtx.moveTo(p1.x, p1.y); waveCtx.lineTo(p2.x, p2.y); waveCtx.stroke();
  }

  // Triangles and bars only at sufficient zoom (>=8) to avoid clutter
  var showMarkers = map.getZoom() >= 8;
  if (showMarkers) {
  // 60-120s: draw triangle markers (predicted values)
  if (simElapsed >= 60 && simElapsed < 120) {
    for (var i = 0; i < tsunamiCircles.length; i++) {
      var c = tsunamiCircles[i];
      if (c.lat < bounds.getSouth()-pad || c.lat > bounds.getNorth()+pad ||
          c.lng < bounds.getWest()-pad || c.lng > bounds.getEast()+pad) continue;
      var pt = toCanvas(c.lat, c.lng);
      var color = TSUNAMI_WARN_COLORS[c.level] || '#aaa';
      var R = 16 + (c.level === 'major' ? 10 : c.level === 'warn' ? 8 : 6);
      waveCtx.save();
      waveCtx.fillStyle = color; waveCtx.strokeStyle = 'rgba(255,255,255,0.7)'; waveCtx.lineWidth = 1.5;
      waveCtx.beginPath();
      waveCtx.moveTo(pt.x, pt.y - R);
      waveCtx.lineTo(pt.x - R*0.87, pt.y + R*0.5);
      waveCtx.lineTo(pt.x + R*0.87, pt.y + R*0.5);
      waveCtx.closePath(); waveCtx.fill(); waveCtx.stroke();
      waveCtx.font = 'bold 11px monospace'; waveCtx.fillStyle = '#fff';
      waveCtx.textAlign = 'center'; waveCtx.textBaseline = 'middle';
      waveCtx.shadowColor = 'rgba(0,0,0,0.8)'; waveCtx.shadowBlur = 2;
      waveCtx.fillText(c.announcedHeight || (c.height.toFixed(1) + 'm'), pt.x, pt.y + R*0.15);
      waveCtx.restore();
    }
  }

  // 120s+: draw actual height bars only for physically-arrived waves
  if (simElapsed >= 120) {
    for (var i = 0; i < tsunamiActual.length; i++) {
      var a = tsunamiActual[i];
      if (a.lat < bounds.getSouth()-pad || a.lat > bounds.getNorth()+pad ||
          a.lng < bounds.getWest()-pad || a.lng > bounds.getEast()+pad) continue;
      if (a.arriveTime > simElapsed) continue; // wave not yet arrived
      var ap = toCanvas(a.lat, a.lng);
      var aColor = TSUNAMI_WARN_COLORS[a.level] || '#aaa';
      var barH = Math.min(80, Math.max(8, a.height * 10));
      waveCtx.fillStyle = aColor;
      waveCtx.globalAlpha = 0.85;
      waveCtx.fillRect(ap.x - 4, ap.y - barH, 8, barH);
      waveCtx.strokeStyle = 'rgba(255,255,255,0.6)'; waveCtx.lineWidth = 1;
      waveCtx.strokeRect(ap.x - 4, ap.y - barH, 8, barH);
      waveCtx.globalAlpha = 1;
      waveCtx.save();
      waveCtx.font = 'bold 9px monospace'; waveCtx.fillStyle = '#fff';
      waveCtx.textAlign = 'left'; waveCtx.textBaseline = 'middle';
      waveCtx.shadowColor = 'rgba(0,0,0,0.9)'; waveCtx.shadowBlur = 3;
      waveCtx.fillText(a.height.toFixed(1), ap.x + 6, ap.y - barH / 2);
      waveCtx.restore();
    }
  }
  } // end showMarkers
}

  Renderer.drawResearchTsunami = function() {
  var legend = document.getElementById('research-layer-legend');
  var control = document.getElementById('tsunami-layer-control');
  if (!_tsuResearchSnapshot || !_bathyGrid || !_tsunamiEl || !_tsunamiEl.checked || _replayMode) {
    releaseLayerCache('researchTsunami');
    if (legend) legend.hidden = true;
    if (control) control.hidden = true;
    var unavailableZoneDetails=document.getElementById('tsunami-zone-details');if(unavailableZoneDetails)unavailableZoneDetails.hidden=true;
    return;
  }
  var mode = cfgGet('tsunamiMapMode') || 'cityInundation';
  var snapshot = _tsuResearchSnapshot, stride = snapshot.stride || 1;
  var quality = document.getElementById('research-data-quality');
  if (control) {
    control.hidden=false;
    var controlSelect=document.getElementById('tsunami-layer-select');if(controlSelect&&controlSelect.value!==mode)controlSelect.value=mode;
    var controlTime=document.getElementById('tsunami-layer-time');if(controlTime)controlTime.textContent='t='+Math.round(snapshot.time)+'s';
  }
  if (mode === 'off') {
    releaseLayerCache('researchTsunami');
    if (legend) legend.hidden = true;
    var offStats=document.getElementById('tsunami-layer-stats');if(offStats)offStats.textContent=t('adv.opt.off');
    var offZoneDetails=document.getElementById('tsunami-zone-details');if(offZoneDetails)offZoneDetails.hidden=true;
    return;
  }
  if(mode!=='cityInundation'){
    var inactiveZoneDetails=document.getElementById('tsunami-zone-details');if(inactiveZoneDetails)inactiveZoneDetails.hidden=true;
  }
  var modeMeta={
    waveField:{key:'adv.opt.waveField',gradient:'linear-gradient(90deg,#2864dc,#e8f4ff 50%,#e83d4f)',scale:['-2 m','0','+2 m']},
    maxSurface:{key:'adv.opt.maxSurface',gradient:'linear-gradient(90deg,#55d8e5,#16a6ca 35%,#ffc33d 70%,#e53e45)',scale:['0.03 m','1 m','3+ m']},
    arrivalTime:{key:'adv.opt.arrivalTime',gradient:'linear-gradient(90deg,#ff4d62,#ffd447 45%,#426fe8)',scale:['0 min',Math.round(snapshot.time/120)+' min',Math.round(snapshot.time/60)+' min']},
    maxVelocity:{key:'adv.opt.maxVelocity',gradient:'linear-gradient(90deg,#53d1cb,#ffc83d 35%,#f57d30 70%,#d9364f)',scale:['0.03 m/s','1 m/s','3+ m/s']},
    hydroLoad:{key:'adv.opt.hydroLoad',gradient:'linear-gradient(90deg,#6fd66f,#ffc83d 40%,#f57d30 72%,#d9364f)',scale:['0.1 m²/s','3 m²/s','10+ m²/s']},
    maxInundation:{key:'adv.opt.maxInundation',gradient:'linear-gradient(90deg,#55d8e5,#16a6ca 35%,#ffc33d 70%,#e53e45)',scale:['0.03 m','1 m','3+ m']},
    cityInundation:{key:'adv.opt.cityInundation',gradient:'linear-gradient(90deg,#55d8e5,#16a6ca 35%,#ffc33d 70%,#e53e45)',scale:['0.03 m','1 m','3+ m']},
    seafloorDeformation:{key:'adv.opt.seafloorDeformation',gradient:'linear-gradient(90deg,#367be8,#eef5ff 50%,#ef4353)',scale:['subsidence','0','uplift']}
  };
  var meta=modeMeta[mode]||modeMeta.cityInundation;
  if (legend) legend.hidden = false;
  if (control) {
    var stats=document.getElementById('tsunami-layer-stats');if(stats)stats.textContent=
      t('tsunami.stat.runup')+' '+Number(snapshot.maxRunup||0).toFixed(2)+' m · '+
      t('tsunami.stat.area')+' '+Number(snapshot.inundatedAreaKm2||0).toFixed(1)+' km² · '+
      t('tsunami.stat.inland')+' '+Number(snapshot.maxInundationDistanceKm||0).toFixed(1)+' km · '+
      t('tsunami.stat.velocity')+' '+Number(snapshot.maxVelocity||0).toFixed(2)+' m/s · '+
      t('tsunami.stat.load')+' '+Number(snapshot.maxHydroLoad||0).toFixed(2)+' m²/s';
    if(stats&&mode==='cityInundation'){
      if(String(snapshot.model||'').indexOf('nonlinearSWE')!==0)stats.textContent+=' · '+t('tsunami.city.requires_nlswe');
      else if(!(snapshot.inundationZones&&snapshot.inundationZones.length))stats.textContent+=' · '+t('tsunami.city.pending');
    }
  }
  if (quality) {
    var dataset = _bathyGrid.meta && _bathyGrid.meta.dataset ? _bathyGrid.meta.dataset : 'Unlabelled terrain';
    var resolutionKm=_bathyGrid.res*111.32;
    var qualityText = dataset + ' · ' + t(meta.key) + ' · '+resolutionKm.toFixed(resolutionKm<1?2:1)+' km';
    if(mode==='cityInundation')qualityText+=' · '+Number(snapshot.visualAggregationKm||15).toFixed(0)+' km '+t('tsunami.aggregate');
    if (quality.textContent !== qualityText) quality.textContent = qualityText;
  }
  if(legend){
    var gradient=legend.querySelector('.research-gradient');if(gradient)gradient.style.background=meta.gradient;
    var scales=legend.querySelectorAll('.research-scale span');for(var si=0;si<scales.length;si++)scales[si].textContent=meta.scale[si]||'';
  }
  var cache=layerCache('researchTsunami');
  var cacheKey=_renderRevision+'|'+mode+'|'+stride+'|'+Number(snapshot.time||0).toFixed(3)+'|'+Number(snapshot.maxRunup||0).toFixed(3)+'|'+Number(snapshot.maxVelocity||0).toFixed(3)+'|'+Number(snapshot.maxHydroLoad||0).toFixed(3)+'|'+(_tsunamiSelectedZoneId||'')+'|'+(_tsunamiHoveredZoneId||'');
  if(cache.key===cacheKey){waveCtx.drawImage(cache.canvas,0,0);return;}
  var outputCtx=waveCtx;
  waveCtx=cache.ctx;
  waveCtx.clearRect(0,0,cache.canvas.width,cache.canvas.height);
  try {
  function color(value, kind) {
    var a=Math.min(0.82,0.20+Math.log10(1+Math.abs(value)*20)*0.28);
    if(kind==='deformation'||kind==='wave')return value>=0?'rgba(239,67,83,'+a+')':'rgba(54,123,232,'+a+')';
    if(kind==='arrival'){
      var ratio=Math.max(0,Math.min(1,value/Math.max(1,snapshot.time))),hue=Math.round(5+220*ratio);
      return'hsla('+hue+',82%,56%,.66)';
    }
    if(kind==='velocity')return value<0.3?'rgba(83,209,203,'+a+')':value<1?'rgba(255,200,61,'+a+')':value<3?'rgba(245,125,48,'+a+')':'rgba(217,54,79,'+a+')';
    if(kind==='load')return value<1?'rgba(111,214,111,'+a+')':value<3?'rgba(255,200,61,'+a+')':value<10?'rgba(245,125,48,'+a+')':'rgba(217,54,79,'+a+')';
    return value<0.2?'rgba(85,216,229,'+a+')':value<1?'rgba(22,166,202,'+a+')':value<3?'rgba(255,195,61,'+a+')':'rgba(229,62,69,'+a+')';
  }
  function cellRect(x,y,cellStride,fill,anchor) {
    // anchor (absolute cell centre + resolution) lets mixed-grid snapshots
    // draw correctly; the _bathyGrid fallback covers legacy single-grid runs.
    var r=anchor&&anchor.res||_bathyGrid.res;
    var lat0=anchor?anchor.lat-0.5*r:_bathyGrid.origin[1]+(y-0.5)*_bathyGrid.res;
    var lng0=anchor?anchor.lng-0.5*r:_bathyGrid.origin[0]+(x-0.5)*_bathyGrid.res;
    var lat1=lat0+r*cellStride,lng1=lng0+r*cellStride;
    var p0=toCanvas(lat0,lng0),p1=toCanvas(lat1,lng1);
    waveCtx.fillStyle=fill;waveCtx.fillRect(Math.min(p0.x,p1.x),Math.min(p0.y,p1.y),Math.max(1,Math.abs(p1.x-p0.x)+1),Math.max(1,Math.abs(p1.y-p0.y)+1));
  }
  function bboxRect(bbox,fill,emphasis){
    var p0=toCanvas(bbox[1],bbox[0]),p1=toCanvas(bbox[3],bbox[2]);
    var left=Math.min(p0.x,p1.x),top=Math.min(p0.y,p1.y),width=Math.max(2,Math.abs(p1.x-p0.x)),height=Math.max(2,Math.abs(p1.y-p0.y));
    waveCtx.fillStyle=fill;waveCtx.fillRect(left,top,width,height);
    waveCtx.strokeStyle=emphasis==='selected'?'rgba(255,224,92,.98)':(emphasis==='hover'?'rgba(255,255,255,.95)':'rgba(255,255,255,.58)');
    waveCtx.lineWidth=emphasis==='selected'?3:(emphasis==='hover'?2:1);
    waveCtx.strokeRect(left+.5,top+.5,Math.max(1,width-1),Math.max(1,height-1));
  }
  if(mode==='seafloorDeformation'&&snapshot.deformation&&snapshot.deformation.data){
    var data=snapshot.deformation.data;
    var dg=snapshot.deformationGrid||_bathyGrid;
    for(var y=0;y<dg.ny;y+=stride)for(var x=0;x<dg.nx;x+=stride){
      var value=data[y*dg.nx+x];if(Math.abs(value)<0.01)continue;
      cellRect(x,y,stride,color(value,'deformation'),{lat:dg.origin[1]+y*dg.res,lng:dg.origin[0]+x*dg.res,res:dg.res});
    }
  }else if(mode==='cityInundation'){
    var zones=snapshot.inundationZones||[],selectedFound=false;
    for(var zi=0;zi<zones.length;zi++){
      var zone=zones[zi];if(!(zone.maxDepth>0.03))continue;
      var zoneId=typeof tsunamiZoneId==='function'?tsunamiZoneId(zone,zi):(zone.id!=null?String(zone.id):'zone:'+zi);
      var emphasis=zoneId===_tsunamiSelectedZoneId?'selected':(zoneId===_tsunamiHoveredZoneId?'hover':'');
      bboxRect(zone.bbox,color(zone.maxDepth,'inundation'),emphasis);
      if(zoneId===_tsunamiSelectedZoneId){selectedFound=true;if(typeof renderTsunamiZoneDetails==='function')renderTsunamiZoneDetails(zone,zi);}
    }
    if(_tsunamiSelectedZoneId&&!selectedFound){
      _tsunamiSelectedZoneId=null;_tsunamiZoneDetailSignature='';
      var staleZoneDetails=document.getElementById('tsunami-zone-details');if(staleZoneDetails)staleZoneDetails.hidden=true;
    }
  }else{
    for(var i=0;i<snapshot.cells.length;i++){
      var c=snapshot.cells[i],value=0,kind='inundation';
      if(mode==='waveField'){value=c.eta;kind='wave';if(Math.abs(value)<0.015)continue;}
      else if(mode==='maxSurface'){value=c.maxEta;if(!(value>=0.03))continue;}
      else if(mode==='arrivalTime'){value=c.arrivalTime;kind='arrival';if(value==null)continue;}
      else if(mode==='maxVelocity'){value=c.maxVelocity;kind='velocity';if(!(value>=0.03))continue;}
      else if(mode==='hydroLoad'){value=Number(c.maxLoad)||0;kind='load';if(!(value>=0.1))continue;}
      else {value=Math.max(c.maxDepth,c.estDepth||0);if(c.terrain<0||!(value>0.03))continue;}
      cellRect(c.x,c.y,stride,color(value,kind),c);
    }
  }
  waveCtx.save();waveCtx.font='bold 11px sans-serif';waveCtx.fillStyle='rgba(255,255,255,.92)';
  var modelLabel=snapshot.model==='linearSWE'?'LSWE':'NLSWE';
  waveCtx.shadowColor='rgba(0,0,0,.9)';waveCtx.shadowBlur=4;waveCtx.fillText(modelLabel+' · '+t(meta.key)+' · t=' + Math.round(snapshot.time) + 's',12,waveCanvas.height-58);waveCtx.restore();
  } finally {
    waveCtx=outputCtx;
  }
  cache.key=cacheKey;
  waveCtx.drawImage(cache.canvas,0,0);
}

  Renderer.drawVs30Field = function() {
  if(!_vs30Show){releaseLayerCache('vs30');return;}
  var bounds=map.getBounds(),zoom=map.getZoom(),points=rawLandGrid;
  var cache=layerCache('vs30');
  var cacheKey=_renderRevision+'|'+zoom+'|'+points.length+'|'+(_vs30Grid&&_vs30Grid.meta?_vs30Grid.meta.dataset:'zone');
  if(cache.key===cacheKey){waveCtx.drawImage(cache.canvas,0,0);return;}
  var targetCtx=cache.ctx;targetCtx.clearRect(0,0,cache.canvas.width,cache.canvas.height);
  var stride=zoom>=8?1:(zoom>=6?3:6),size=zoom>=8?7:10;
  function color(v){var t0=Math.max(0,Math.min(1,(v-150)/850));var r=Math.round(230*(1-t0)+45*t0),g=Math.round(72*(1-t0)+164*t0),b=Math.round(60*(1-t0)+210*t0);return'rgba('+r+','+g+','+b+',0.48)';}
  for(var i=0;i<points.length;i+=stride){var p=points[i];if(p.lat<bounds.getSouth()||p.lat>bounds.getNorth()||p.lng<bounds.getWest()||p.lng>bounds.getEast())continue;
    var details=siteVs30Details(p),c=toCanvas(p.lat,p.lng);targetCtx.fillStyle=color(details.value);targetCtx.fillRect(c.x-size/2,c.y-size/2,size,size);}
  targetCtx.save();targetCtx.font='bold 11px sans-serif';targetCtx.fillStyle='rgba(255,255,255,.92)';targetCtx.shadowColor='rgba(0,0,0,.9)';targetCtx.shadowBlur=4;
  targetCtx.fillText(_vs30Grid&&_vs30Grid.meta?_vs30Grid.meta.dataset:'Vs30 station/zone estimates',12,waveCanvas.height-74);targetCtx.restore();
  cache.key=cacheKey;waveCtx.drawImage(cache.canvas,0,0);
}

  Renderer.drawAllStations = function() {
  if (!showAllStations || !waveCtx) { releaseLayerCache('allStations'); return; }
  var bounds = map.getBounds(), pad = 0.5;
  var zoom = map.getZoom();
  var CIR_R = Math.max(cfgGet("cirRMin"), Math.min(cfgGet("cirRMax"), 10 * Math.pow(2, (zoom-6)/2)));
  var cache=layerCache('allStations');
  var cacheKey=_renderRevision+'|'+zoom+'|'+rawLandGrid.length+'|'+CIR_R.toFixed(2)+'|'+_seafloorNetworkFilter;
  if(cache.key===cacheKey){waveCtx.drawImage(cache.canvas,0,0);return;}
  var targetCtx=cache.ctx;targetCtx.clearRect(0,0,cache.canvas.width,cache.canvas.height);
  var r3 = Math.max(2, CIR_R * 0.35);
  for (var i = 0; i < rawLandGrid.length; i++) {
    var s = rawLandGrid[i];
    if (!_stationNetworkVisible(s)) continue;
    if (s.lat < bounds.getSouth()-pad || s.lat > bounds.getNorth()+pad ||
        s.lng < bounds.getWest()-pad || s.lng > bounds.getEast()+pad) continue;
    var pt = toCanvas(s.lat, s.lng);
    if (s.isSeafloor) {
      var networkColor = s.network === 'N-net' ? '92,210,166' : s.network === 'S-net' ? '94,166,230' : '202,142,230';
      targetCtx.fillStyle = 'rgba('+networkColor+',0.38)';
      targetCtx.fillRect(pt.x - r3, pt.y - r3, r3*2, r3*2);
      targetCtx.strokeStyle = 'rgba(140,180,220,0.20)'; targetCtx.lineWidth = 0.6;
      targetCtx.strokeRect(pt.x - r3, pt.y - r3, r3*2, r3*2);
    } else {
      targetCtx.beginPath(); targetCtx.arc(pt.x, pt.y, r3, 0, Math.PI*2);
      targetCtx.fillStyle = 'rgba(180,180,200,0.30)'; targetCtx.fill();
      targetCtx.strokeStyle = 'rgba(200,200,220,0.20)'; targetCtx.lineWidth = 0.6; targetCtx.stroke();
    }
  }
  cache.key=cacheKey;waveCtx.drawImage(cache.canvas,0,0);
}

  Renderer.drawIntensityCircles = function() {
  var bounds = map.getBounds(), pad = 0.5;
  var zoom = map.getZoom();
  var CIR_R = Math.max(cfgGet("cirRMin"), Math.min(cfgGet("cirRMax"), 10 * Math.pow(2, (zoom-6)/2)));
  var fs = CIR_R / 10;
  var showNumber = zoom >= 8, showText = zoom >= 9, showLpgm = zoom >= 11;
  var compactMode = zoom < cfgGet("blendZoom");

  // v5.5 declutter: dense networks (Kanto ~10-15 km spacing) make the circles
  // overlap into one solid dark blob at strong shindo — the "震度7 发光 /
  // 周围染色" report. Draw strongest first and keep one circle per ~2.2-radius
  // screen cell (JQuake overview-style) at blob-prone zooms; compact mode
  // already renders tiny dots, and zoom 10+ is sparse enough to overlap
  // gracefully.
  var order = visibleCircles;
  var dcGrid = null, dcCell = 0;
  if (!compactMode && zoom <= 9 && visibleCircles.length > 40) {
    order = visibleCircles.slice().sort(function(a, b) {
      return Physics.shindoNum(b.shindo) - Physics.shindoNum(a.shindo);
    });
    dcGrid = {};
    dcCell = Math.max(28, CIR_R * 2.2);
  }

  for (var i = 0; i < order.length; i++) {
    var c = order[i];
    if (!_stationNetworkVisible(c)) continue;
    if (c.lat < bounds.getSouth()-pad || c.lat > bounds.getNorth()+pad ||
        c.lng < bounds.getWest()-pad || c.lng > bounds.getEast()+pad) continue;
    var pt = toCanvas(c.lat, c.lng);
    if (dcGrid) {
      var dcKey = Math.floor(pt.x / dcCell) + ',' + Math.floor(pt.y / dcCell);
      if (dcGrid[dcKey]) continue;
      dcGrid[dcKey] = 1;
    }

    if (c.shindo === 0) {
      var r3 = Math.max(3, CIR_R*0.4);
      if (c.isSeafloor) {
        waveCtx.fillStyle = 'rgba(120,160,200,0.35)';
        waveCtx.fillRect(pt.x - r3, pt.y - r3, r3*2, r3*2);
        waveCtx.strokeStyle = 'rgba(140,180,220,0.25)'; waveCtx.lineWidth = 0.8;
        waveCtx.strokeRect(pt.x - r3, pt.y - r3, r3*2, r3*2);
      } else {
        waveCtx.beginPath(); waveCtx.arc(pt.x, pt.y, r3, 0, Math.PI*2);
        waveCtx.fillStyle = 'rgba(180,180,200,0.35)'; waveCtx.fill();
        waveCtx.strokeStyle = 'rgba(200,200,220,0.25)'; waveCtx.lineWidth = 0.8; waveCtx.stroke();
      }
      continue;
    }
    var rgb = SHINDO_RGB[c.shindo]; if (!rgb) continue;
    var rgbStr = 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
    if (compactMode) {
      var compactRadius = Math.max(3, CIR_R * 0.6);
      waveCtx.beginPath(); waveCtx.arc(pt.x, pt.y, compactRadius, 0, Math.PI*2);
      waveCtx.fillStyle = rgbStr; waveCtx.fill();
      continue;
    }
    if (c.isSeafloor) {
      var sq = CIR_R;
      waveCtx.fillStyle = 'rgba(0,0,0,0.35)'; waveCtx.fillRect(pt.x-sq-2, pt.y-sq-2, sq*2+4, sq*2+4);
      waveCtx.fillStyle = rgbStr; waveCtx.fillRect(pt.x-sq, pt.y-sq, sq*2, sq*2);
      waveCtx.strokeStyle = 'rgba(255,255,255,0.8)'; waveCtx.lineWidth = 1.5;
      waveCtx.strokeRect(pt.x-sq, pt.y-sq, sq*2, sq*2);
    } else {
      waveCtx.beginPath(); waveCtx.arc(pt.x, pt.y, CIR_R+3, 0, Math.PI*2);
      // v5.5: 0.35 -> 0.22 — the dark under-disc stacked into a penumbra
      // around dense strong-shindo clusters
      waveCtx.fillStyle = 'rgba(0,0,0,0.22)'; waveCtx.fill();
      waveCtx.beginPath(); waveCtx.arc(pt.x, pt.y, CIR_R, 0, Math.PI*2);
      waveCtx.fillStyle = rgbStr; waveCtx.fill();
      waveCtx.strokeStyle = 'rgba(255,255,255,0.8)'; waveCtx.lineWidth = 1.5; waveCtx.stroke();
    }
    if (showNumber) {
      var lb = String(c.shindo);
      waveCtx.save(); waveCtx.font = 'bold '+Math.round((lb.length>2?7:9)*fs)+'px sans-serif';
      waveCtx.fillStyle = '#fff'; waveCtx.textAlign = 'center'; waveCtx.textBaseline = 'middle';
      waveCtx.fillText(lb, pt.x, pt.y); waveCtx.restore();
    }
    // PGA
    if (showText) {
      var dp = c.displayPga, tx = dp >= 100 ? Math.round(dp) : dp.toFixed(1);
      waveCtx.save(); waveCtx.font = 'bold '+Math.round(8*fs)+'px monospace';
      waveCtx.fillStyle = 'rgba(255,255,255,0.85)'; waveCtx.textAlign = 'center'; waveCtx.textBaseline = 'top';
      waveCtx.shadowColor = 'rgba(0,0,0,0.8)'; waveCtx.shadowBlur = 2;
      waveCtx.fillText(tx, pt.x, pt.y+CIR_R+4); waveCtx.shadowBlur = 0; waveCtx.restore();
    }
    // LPGM
    if (showLpgm && c.lpgm >= 1) {
      waveCtx.save(); waveCtx.font = 'bold '+Math.round(7*fs)+'px sans-serif';
      waveCtx.fillStyle = 'rgba(200,200,255,0.75)'; waveCtx.textAlign = 'center'; waveCtx.textBaseline = 'top';
      waveCtx.shadowColor = 'rgba(0,0,0,0.8)'; waveCtx.shadowBlur = 2;
      waveCtx.fillText('L'+c.lpgm, pt.x, pt.y+CIR_R+4+Math.round(10*fs));
      waveCtx.shadowBlur = 0; waveCtx.restore();
    }
    // P-wave arrival pulse (expanding ring for 1.5s after activation)
    var pAge = simElapsed - c.pArrive;
    if (pAge >= 0 && pAge < 1.5 && c.shindo !== 0) {
      var pFrac = pAge / 1.5;
      var pulseR = CIR_R * (1.5 + pFrac * 2.5);
      var pulseAlpha = 0.6 * (1 - pFrac);
      waveCtx.beginPath(); waveCtx.arc(pt.x, pt.y, pulseR, 0, Math.PI * 2);
      waveCtx.strokeStyle = 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+pulseAlpha.toFixed(2)+')';
      waveCtx.lineWidth = 2.5 * (1 - pFrac * 0.5); waveCtx.stroke();
    }
  }
}

  Renderer.drawPlateBoundaries = function() {
  var chk = document.getElementById('plates-enable');
  if (chk && !chk.checked) { releaseLayerCache('plates'); return; }
  if (!_platesData || !_platesData.features) { releaseLayerCache('plates'); return; }
  var cache=layerCache('plates');
  var cacheKey=_renderRevision+'|'+_platesData.features.length;
  if(cache.key===cacheKey){waveCtx.drawImage(cache.canvas,0,0);return;}
  var targetCtx=cache.ctx;targetCtx.clearRect(0,0,cache.canvas.width,cache.canvas.height);
  targetCtx.save();
  targetCtx.strokeStyle = 'rgba(255,100,50,0.4)';
  targetCtx.lineWidth = 2;
  targetCtx.setLineDash([8, 5]);
  for (var fi = 0; fi < _platesData.features.length; fi++) {
    var coords = _platesData.features[fi].geometry.coordinates;
    targetCtx.beginPath();
    for (var ci = 0; ci < coords.length; ci++) {
      var pt = toCanvas(coords[ci][1], coords[ci][0]);
      if (ci === 0) targetCtx.moveTo(pt.x, pt.y); else targetCtx.lineTo(pt.x, pt.y);
    }
    targetCtx.stroke();
  }
  targetCtx.setLineDash([]);
  targetCtx.restore();
  cache.key=cacheKey;waveCtx.drawImage(cache.canvas,0,0);
}

  Renderer.drawHistoricalQuakes = function() {
  var chk = document.getElementById('hist-quakes-enable');
  if (chk && !chk.checked) return;
  if (!_histQuakes || isRunning) return; // only show when idle
  for (var i = 0; i < _histQuakes.length; i++) {
    var q = _histQuakes[i];
    var pt = toCanvas(q.lat, q.lng);
    var r = Math.max(3, (q.mag - 5) * 4);
    waveCtx.beginPath(); waveCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    waveCtx.fillStyle = 'rgba(255,80,40,0.15)'; waveCtx.fill();
    waveCtx.strokeStyle = 'rgba(255,80,40,0.3)'; waveCtx.lineWidth = 1; waveCtx.stroke();
    if (map.getZoom() >= 7) {
      waveCtx.fillStyle = 'rgba(255,200,150,0.5)'; waveCtx.font = '9px sans-serif'; waveCtx.textAlign = 'center';
      waveCtx.fillText('M' + q.mag + ' ' + q.year, pt.x, pt.y + r + 10);
    }
  }
}

  Renderer.drawHistoricalTsunamiObservations = function() {
  if (!_historicalTsunamiShow || !_historicalTsunamiData || !_historicalTsunamiData.events) return;
  var bounds=map.getBounds(),zoom=map.getZoom();
  for(var ei=0;ei<_historicalTsunamiData.events.length;ei++){
    var event=_historicalTsunamiData.events[ei],observations=event.observations||[];
    for(var oi=0;oi<observations.length;oi++){
      var obs=observations[oi];if(!bounds.contains([obs.lat,obs.lng]))continue;var pt=toCanvas(obs.lat,obs.lng),r=Math.max(4,Math.min(12,3+Math.sqrt(Number(obs.peakHeightM)||0)*1.4));
      waveCtx.save();waveCtx.fillStyle=obs.type==='runup'?'rgba(255,95,75,.82)':'rgba(40,195,225,.85)';waveCtx.strokeStyle='rgba(255,255,255,.9)';waveCtx.lineWidth=1.2;
      if(obs.type==='runup'){waveCtx.beginPath();waveCtx.moveTo(pt.x,pt.y-r);waveCtx.lineTo(pt.x+r,pt.y+r);waveCtx.lineTo(pt.x-r,pt.y+r);waveCtx.closePath();waveCtx.fill();waveCtx.stroke();}
      else{waveCtx.beginPath();waveCtx.rect(pt.x-r,pt.y-r,r*2,r*2);waveCtx.fill();waveCtx.stroke();}
      if(zoom>=8){waveCtx.font='bold 9px sans-serif';waveCtx.textAlign='left';waveCtx.fillStyle='rgba(255,255,255,.94)';waveCtx.shadowColor='rgba(0,0,0,.9)';waveCtx.shadowBlur=3;waveCtx.fillText(event.id+' '+obs.peakHeightM+'m',pt.x+r+3,pt.y+3);}
      waveCtx.restore();
    }
  }
}

  Renderer.drawPWaveFlash = function() {
  if (_isReducedMotion()) return;
  if (!isRunning || !epicenter) return;
  var mev = mainEvent();
  if (!mev || mev.pRadius < 5) return;
  // Draw a bright arc at the P-wave front on the ground surface
  var r = kmToPx(mev.pRadius, {lat: epicenter.lat, lng: epicenter.lng});
  if (r < 10 || r > waveCanvas.width * 2) return;
  var ep = toCanvas(epicenter.lat, epicenter.lng);
  var age = simElapsed; // flash intensity decreases over time
  var alpha = Math.max(0, 0.3 - age * 0.005);
  if (alpha <= 0) return;
  waveCtx.beginPath(); waveCtx.arc(ep.x, ep.y, r, 0, Math.PI * 2);
  waveCtx.strokeStyle = 'rgba(200,230,255,' + alpha.toFixed(2) + ')';
  waveCtx.lineWidth = 6; waveCtx.stroke();
}

  Renderer.spawnWaveParticles = function() {
  if (_isReducedMotion()) return;
  if (!isRunning || !epicenter) return;
  var mev = mainEvent();
  if (!mev || mev.pRadius < 3) return;
  // Spawn a few particles per frame along the P-wave front
  var particleTick = Math.floor(simElapsed * 20);
  var particleSeed = typeof cfgGet === 'function' ? cfgGet('randomSeed') : 0;
  if (Research.randomAt(particleSeed, 'wave-particle-throttle', particleTick) > 0.3) return;
  var angle = Research.randomAt(particleSeed, 'wave-particle-angle', particleTick) * Math.PI * 2;
  var r = mev.pRadius;
  var lat = epicenter.lat + (r / 111.32) * Math.cos(angle);
  var lng = epicenter.lng + (r / (111.32 * Math.cos(epicenter.lat * Math.PI / 180))) * Math.sin(angle);
  _waveParticles.push({lat: lat, lng: lng, age: 0, maxAge: 1.5, vr: 0.02 + Research.randomAt(particleSeed, 'wave-particle-speed', particleTick) * 0.01});
}

  Renderer.drawWaveParticles = function() {
  var speed = parseFloat(simSpeedEl.value);
  for (var i = _waveParticles.length - 1; i >= 0; i--) {
    var p = _waveParticles[i];
    p.age += 0.016 * speed;
    if (p.age > p.maxAge) { _waveParticles.splice(i, 1); continue; }
    // Move outward
    var angle2 = Math.atan2(p.lng - epicenter.lng, p.lat - epicenter.lat);
    p.lat += Math.cos(angle2) * p.vr * speed;
    p.lng += Math.sin(angle2) * p.vr * speed;
    var pt = toCanvas(p.lat, p.lng);
    var alpha = 1 - p.age / p.maxAge;
    var sz = 2 + alpha * 2;
    waveCtx.fillStyle = 'rgba(100,180,255,' + (alpha * 0.6).toFixed(2) + ')';
    waveCtx.fillRect(pt.x - sz/2, pt.y - sz/2, sz, sz);
  }
  if (_waveParticles.length > 100) _waveParticles.splice(0, _waveParticles.length - 100);
}

  Renderer.drawIsoseismalLines = function() {
  var chk = document.getElementById('isoseismal-enable');
  if (chk && !chk.checked) return;
  if (!isRunning || visibleCircles.length < 10) return;
  if (!epicenter) return;
  var zoom = map.getZoom();
  if (zoom < 6) return;
  var ep = toCanvas(epicenter.lat, epicenter.lng);
  // Draw approximate isoseismal circles for shindo levels 3,4,5-,6-,7
  var levels = [3, 4, '5-', '6-', 7];
  var colors = ['#2ecc71', '#f1c40f', '#e67e22', '#c0392b', '#6c0f1f'];
  var isoKey = Math.floor(simElapsed) + '|' + visibleCircles.length + '|' + epicenter.lat + '|' + epicenter.lng;
  if (Renderer._isoKey !== isoKey) {
    Renderer._isoKey = isoKey;
    Renderer._isoDistances = [];
    for (var ci = 0; ci < levels.length; ci++) {
      var cachedMax = 0, cachedCount = 0;
      for (var csi = 0; csi < visibleCircles.length; csi++) {
        var cachedCircle = visibleCircles[csi];
        if (Physics.shindoScore(cachedCircle.shindo) >= Physics.shindoScore(levels[ci])) {
          var cachedDistance = Physics.haversineDist(epicenter.lat, epicenter.lng, cachedCircle.lat, cachedCircle.lng);
          if (cachedDistance > cachedMax) cachedMax = cachedDistance;
          cachedCount++;
        }
      }
      Renderer._isoDistances.push(cachedCount >= 2 ? cachedMax : 0);
    }
  }
  for (var li = 0; li < levels.length; li++) {
    var maxDist = Renderer._isoDistances[li] || 0;
    if (maxDist < 5) continue;
    var r = kmToPx(maxDist, {lat: epicenter.lat, lng: epicenter.lng});
    if (r < 10 || r > waveCanvas.width * 3) continue;
    waveCtx.beginPath(); waveCtx.arc(ep.x, ep.y, r, 0, Math.PI * 2);
    waveCtx.strokeStyle = colors[li]; waveCtx.lineWidth = 1.5;
    waveCtx.setLineDash([4, 4]); waveCtx.globalAlpha = 0.5;
    waveCtx.stroke(); waveCtx.setLineDash([]); waveCtx.globalAlpha = 1;
  }
}

  // Expose
  if (typeof module !== 'undefined' && module.exports) module.exports = Renderer;
  else root.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : this);

// ---- Backward-compat aliases (so app.js callers use original names) ----
window.toCanvas = Renderer.toCanvas;
window.kmToPx = Renderer.kmToPx;
window.drawFrame = Renderer.drawFrame;
window.drawEventWaves = Renderer.drawEventWaves;
window.drawDepthBar = Renderer.drawDepthBar;
window.drawShakingGrid = Renderer.drawShakingGrid;
window.drawBeachBall = Renderer.drawBeachBall;
window.drawBathymetry = Renderer.drawBathymetry;
window.drawTsunamiWarnings = Renderer.drawTsunamiWarnings;
window.drawResearchTsunami = Renderer.drawResearchTsunami;
window.drawVs30Field = Renderer.drawVs30Field;
window.drawAllStations = Renderer.drawAllStations;
window.drawIntensityCircles = Renderer.drawIntensityCircles;
window.drawPlateBoundaries = Renderer.drawPlateBoundaries;
window.drawHistoricalQuakes = Renderer.drawHistoricalQuakes;
window.drawHistoricalTsunamiObservations = Renderer.drawHistoricalTsunamiObservations;
window.drawPWaveFlash = Renderer.drawPWaveFlash;
window.spawnWaveParticles = Renderer.spawnWaveParticles;
window.drawWaveParticles = Renderer.drawWaveParticles;
window.drawIsoseismalLines = Renderer.drawIsoseismalLines;
