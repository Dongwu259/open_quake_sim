// ================================================================
//  Earthquake Simulator Pro v4.3 — Aftershock Subsystem
//  Omori-Utsu + Gutenberg-Richter aftershock sequence management
//  Load after: physics.js, config.js
//  Load before: app.js
// ================================================================
var Aftershock = (function() {
  var AS_TIME_SCALE = 21600; // 30 real days compressed to 120 sim-seconds

  // --- state ---
  var enabled = false;
  var catalog = [];
  var maxMag = 0;
  var leafletMarkers = [];
  var lastIdxRendered = 0;

  // --- helpers ---
  function cfg(k) { return (typeof cfgGet !== 'undefined') ? cfgGet(k) : undefined; }

  function calcPgaAt(mag, distKm, lat, lng, depthKm) {
    // v5.5: depth-aware — the calcPGA shim silently used the mainshock depth
    // (_liveDepth) for every aftershock.
    if (typeof calcPGAFor === 'function') return calcPGAFor(mag, distKm, depthKm || 10, null, 400, null, mag);
    return (typeof calcPGA === 'function') ? calcPGA(mag, distKm, 400) : 0;
  }
  function ampAt(lat, lng) { return (typeof soilAmp === 'function') ? soilAmp(lat, lng) : 1; }
  function pw(d) { return (typeof PW === 'function') ? PW(d) : 6; }
  function sw(d) { return (typeof SW === 'function') ? SW(d) : 3.5; }

  // ================================================================
  //  PUBLIC API
  // ================================================================

  /** Generate aftershock catalog from mainshock parameters */
  function generate(mainMw, mainLat, mainLng, mainStrike, mainDip, mainDepth, mainSourceType) {
    // v4.3: pass ETAS params + catalogCap
    catalog = Physics.generateAftershockCatalog(mainMw, mainLat, mainLng, mainStrike, mainDip, mainDepth,
      cfg('asyK'), cfg('asyC'), cfg('asyP'), cfg('asyB'), 30,
      cfg('etasEnable'), cfg('etasAlpha'), cfg('catalogCap') || 50, mainSourceType, cfg('randomSeed'));
    maxMag = 0;
    for (var j = 0; j < catalog.length; j++) {
      if (catalog[j].mag > maxMag) maxMag = catalog[j].mag;
    }
    return catalog;
  }

  /** Pre-compute P/S arrival times and peak PGA for every land grid point */
  function preComputeArrivals(landPoints) {
    // v5.5: always clear stale schedules first — an empty catalog (auto
    // catalog off / manual-only) must not inherit the previous run's arrivals.
    for (var i = 0; i < landPoints.length; i++) {
      landPoints[i].aftershocks = [];
      landPoints[i].aftershockPeakPga = 0;
    }
    if (!catalog.length) return;
    var MAX_PER_STATION = 15;
    for (var ai = 0; ai < catalog.length; ai++) {
      var as = catalog[ai];
      for (var pi = 0; pi < landPoints.length; pi++) {
        var pt = landPoints[pi];
        var surfDist = Physics.haversineDist(pt.lat, pt.lng, as.lat, as.lng);
        var dist = Math.sqrt(surfDist * surfDist + as.depth * as.depth);
        if (dist > 400) continue;
        var pga = calcPgaAt(as.mag, dist, pt.lat, pt.lng, as.depth) * 0.82 * ampAt(pt.lat, pt.lng);
        if (pga < 0.8) continue;
        var asSimOrigin = as.time / AS_TIME_SCALE;
        pt.aftershocks.push({
          idx: ai,
          pArrive: asSimOrigin + dist / pw(as.depth),
          sArrive: asSimOrigin + dist / sw(as.depth),
          peakPga: pga
        });
      }
    }
    // Sort each station's aftershocks by peak PGA descending, keep strongest N
    for (var pi2 = 0; pi2 < landPoints.length; pi2++) {
      landPoints[pi2].aftershocks.sort(function(a, b) { return b.peakPga - a.peakPga; });
      if (landPoints[pi2].aftershocks.length > MAX_PER_STATION) {
        landPoints[pi2].aftershocks.length = MAX_PER_STATION;
      }
      // v5.5: strongest scheduled contribution — app.js uses this so stations
      // whose MAINSHOCK peak is tiny still compute aftershock shaking.
      landPoints[pi2].aftershockPeakPga = landPoints[pi2].aftershocks.length ? landPoints[pi2].aftershocks[0].peakPga : 0;
      landPoints[pi2].aftershocks.sort(function(a, b) { return a.pArrive - b.pArrive; });
    }
  }

  /** Draw timeline bar of aftershock tick-marks */
  function updateTimeline(simElapsed) {
    var bar = document.getElementById('aftershock-timeline');
    if (!bar || !catalog.length) return;
    bar.style.display = 'block';
    var maxTime = catalog[catalog.length - 1].time / AS_TIME_SCALE;
    if (maxTime < simElapsed) maxTime = simElapsed;
    var barW = bar.clientWidth;
    if (barW < 10) return;
    var occurred = 0;
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].time / AS_TIME_SCALE <= simElapsed) occurred++;
    }
    var html = '';
    var ticksToShow = Math.min(50, catalog.length);
    var step = Math.max(1, Math.floor(catalog.length / ticksToShow));
    for (var i = 0; i < catalog.length; i += step) {
      var asTime = catalog[i].time / AS_TIME_SCALE;
      var xPct = (asTime / maxTime) * 100;
      if (xPct > 100) xPct = 100;
      var color = asTime <= simElapsed ? '#ff6b6b' : 'rgba(255,255,255,0.2)';
      var h = 4 + (catalog[i].mag - 4) * 2;
      html += '<span style="position:absolute;left:' + xPct.toFixed(1) + '%;bottom:0;width:2px;height:' + h + 'px;background:' + color + ';transform:translateX(-1px)"></span>';
    }
    var nowPct = Math.min(100, (simElapsed / maxTime) * 100);
    html += '<span style="position:absolute;left:' + nowPct.toFixed(1) + '%;top:0;bottom:0;width:2px;background:#fff;transform:translateX(-1px)"></span>';
    bar.innerHTML = html;
  }

  /** Add/update Leaflet circle markers for newly-occurred aftershocks */
  function updateLeafletMarkers(simElapsed, faultLayerGroup) {
    if (!enabled || !catalog.length || !faultLayerGroup) return;
    for (var ai = lastIdxRendered + 1; ai < catalog.length; ai++) {
      var as = catalog[ai];
      var asSimTime = as.time / AS_TIME_SCALE;
      if (asSimTime > simElapsed) break;
      var radius = 3 + (as.mag - 4) * 2;
      if (radius < 3) radius = 3;
      var marker = L.circleMarker([as.lat, as.lng], {
        radius: radius,
        color: '#ff641e',
        fillColor: '#ffb43c',
        fillOpacity: 0.75,
        weight: 1,
        interactive: false
      }).addTo(faultLayerGroup);
      marker.bindTooltip('M' + as.mag.toFixed(1), {permanent: false, direction: 'top', offset: [0, -5]});
      leafletMarkers.push({marker: marker, simTime: asSimTime, mag: as.mag});
      lastIdxRendered = ai;
    }
    for (var mi = leafletMarkers.length - 1; mi >= 0; mi--) {
      var am = leafletMarkers[mi];
      var age = simElapsed - am.simTime;
      if (age > 180) {
        if (faultLayerGroup) faultLayerGroup.removeLayer(am.marker);
        leafletMarkers.splice(mi, 1);
      } else if (age > 60) {
        var alpha = Math.max(0.15, 0.75 * (1 - (age - 60) / 120));
        am.marker.setStyle({fillOpacity: alpha, opacity: alpha * 0.7});
      }
    }
  }

  /** Spawn large aftershocks as visible events (cross markers + wave rings) */
  function spawnEvents(simElapsed, activeEvents, map) {
    if (!catalog.length) return;
    // v5.5: count only spawned aftershock events — chain sub-events also live
    // in activeEvents and used to exhaust the cap, so no aftershock event ever
    // spawned during a chain run.
    var spawned = 0;
    for (var ei0 = 0; ei0 < activeEvents.length; ei0++) {
      var eid0 = activeEvents[ei0].id;
      if (eid0 && String(eid0).indexOf('as_') === 0) spawned++;
    }
    if (spawned >= cfg('maxAsEvents')) return;
    for (var ai = 0; ai < catalog.length; ai++) {
      var as = catalog[ai];
      var asSimTime = as.time / AS_TIME_SCALE;
      if (asSimTime > simElapsed) break;
      if (as.mag < cfg('asyEventThr')) continue;
      var already = false;
      for (var ei = 0; ei < activeEvents.length; ei++) {
        if (activeEvents[ei].id === ('as_' + as.id)) { already = true; break; }
      }
      if (already) continue;
      var ev = Physics.createEventState(as.lat, as.lng, as.mag, as.depth, asSimTime, false);
      ev.id = 'as_' + as.id;
      // Spawned aftershocks have no per-station arrival schedule — retire
      // their rings on the network-span fallback so they cannot linger.
      ev.waveRetireAt = asSimTime + 2300 / SW(as.depth) + WAVE_RETIRE_GRACE;
      var icon = L.divIcon({
        className: 'epicenter-marker',
        html: '<div class="epicenter-icon" style="transform:scale(0.55);opacity:0.8"><div class="cross-v" style="background:#ff8c00"></div><div class="cross-h" style="background:#ff8c00"></div></div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
      });
      ev.marker = L.marker([as.lat, as.lng], {icon: icon, zIndexOffset: 500 + activeEvents.length}).addTo(map);
      ev.marker.bindTooltip('AS M' + as.mag.toFixed(1), {permanent: false, direction: 'top', offset: [0, -3]});
      activeEvents.push(ev);
      spawned++;
      if (spawned >= cfg('maxAsEvents')) break;
    }
  }

  /** Detect-mode: triangulate aftershock locations from station P-arrivals */
  function detect(detectMode, detectStationCount, simElapsed, visibleCircles) {
    if (!detectMode || !enabled || detectStationCount < 10) return [];
    var results = [];
    for (var ai = 0; ai < catalog.length; ai++) {
      var as = catalog[ai];
      var asSimTime = as.time / AS_TIME_SCALE;
      if (asSimTime > simElapsed) break;
      if (as.mag < 5.0) continue;
      if (as.mag >= (cfg('asyEventThr') || 5.5)) continue; // v5.5: these get full EEW detection tracks
      var stnTimes = [];
      for (var si = 0; si < Math.min(detectStationCount, 40); si++) {
        var stn = visibleCircles[si];
        var d = Math.sqrt(
          Math.pow(Physics.haversineDist(stn.lat, stn.lng, as.lat, as.lng), 2) +
          as.depth * as.depth
        );
        var trueArrival = asSimTime + d / pw(as.depth);
        if (trueArrival <= simElapsed) {
          var noiseKey = 'aftershock-detect:' + as.id + ':' + (stn.id || stn.name || si);
          var noise = (Research.randomAt(cfg('randomSeed'), noiseKey, 0) + Research.randomAt(cfg('randomSeed'), noiseKey, 1) + Research.randomAt(cfg('randomSeed'), noiseKey, 2)) / 3 - 0.5;
          noise *= 2.0;
          stnTimes.push({lat: stn.lat, lng: stn.lng, t: trueArrival + noise});
        }
      }
      if (stnTimes.length < 4) continue;
      var bestLat = as.lat, bestLng = as.lng, bestErr = Infinity;
      var searchStep = 0.15, searchRange = 1.2;
      var centerLat = 0, centerLng = 0;
      for (var wi = 0; wi < stnTimes.length; wi++) { centerLat += stnTimes[wi].lat; centerLng += stnTimes[wi].lng; }
      centerLat /= stnTimes.length; centerLng /= stnTimes.length;
      for (var dlat = -searchRange; dlat <= searchRange; dlat += searchStep) {
        for (var dlng = -searchRange; dlng <= searchRange; dlng += searchStep) {
          var tLat = centerLat + dlat, tLng = centerLng + dlng;
          var err = 0;
          var t0s = [];
          for (var wi2 = 0; wi2 < stnTimes.length; wi2++) {
            var wd = Math.sqrt(
              Math.pow(Physics.haversineDist(tLat, tLng, stnTimes[wi2].lat, stnTimes[wi2].lng), 2) +
              as.depth * as.depth
            );
            t0s.push(stnTimes[wi2].t - wd / pw(as.depth));
          }
          t0s.sort(function(a,b){return a-b;});
          var t0 = t0s[Math.floor(t0s.length/2)];
          for (var wi3 = 0; wi3 < stnTimes.length; wi3++) {
            var wd2 = Math.sqrt(
              Math.pow(Physics.haversineDist(tLat, tLng, stnTimes[wi3].lat, stnTimes[wi3].lng), 2) +
              as.depth * as.depth
            );
            err += Math.pow(stnTimes[wi3].t - (t0 + wd2 / pw(as.depth)), 2);
          }
          err = Math.sqrt(err / stnTimes.length);
          if (err < bestErr) { bestErr = err; bestLat = tLat; bestLng = tLng; }
        }
      }
      var uncertainty = Math.max(8, bestErr * pw(as.depth) * 0.8);
      results.push({
        lat: bestLat, lng: bestLng, mag: as.mag,
        uncertainty: uncertainty, time: asSimTime,
        depth: as.depth, id: 'det_as_' + ai
      });
      if (results.length >= 5) break;
    }
    return results;
  }

  // --- state accessors used by app.js ---
  function isEnabled() { return enabled; }
  function getCatalog() { return catalog; }
  function getMaxMag() { return maxMag; }
  function resetState() {
    enabled = false;
    catalog = [];
    maxMag = 0;
    leafletMarkers = [];
    lastIdxRendered = 0;
  }
  function initState(enableFlag) { enabled = enableFlag; }
  function setCatalog(c) { catalog = c; }
  function setMaxMag(m) { maxMag = m; }
  function getMarkers() { return leafletMarkers; }
  function getLastIdx() { return lastIdxRendered; }
  function setLastIdx(v) { lastIdxRendered = v; }
  function getTimeScale() { return AS_TIME_SCALE; }

  return {
    // core
    generate: generate,
    preComputeArrivals: preComputeArrivals,
    updateTimeline: updateTimeline,
    updateLeafletMarkers: updateLeafletMarkers,
    spawnEvents: spawnEvents,
    detect: detect,
    // state accessors
    isEnabled: isEnabled,
    getCatalog: getCatalog,
    getMaxMag: getMaxMag,
    resetState: resetState,
    initState: initState,
    setCatalog: setCatalog,
    setMaxMag: setMaxMag,
    getMarkers: getMarkers,
    getLastIdx: getLastIdx,
    setLastIdx: setLastIdx,
    getTimeScale: getTimeScale
  };
})();

// ---- backward-compat aliases (so app.js callers use old names) ----
window.generateAftershockCatalog = Aftershock.generate;
window.preComputeAftershockArrivals = function() { Aftershock.preComputeArrivals(landPoints); };
window.updateAftershockTimeline = function() { Aftershock.updateTimeline(simElapsed); };
window.updateAftershockLeafletMarkers = function() { Aftershock.updateLeafletMarkers(simElapsed, faultLayerGroup); };
window.spawnAftershockEvents = function() { Aftershock.spawnEvents(simElapsed, activeEvents, map); };
window.detectAftershocks = function() { return Aftershock.detect(detectMode, detectStationCount, simElapsed, visibleCircles); };
