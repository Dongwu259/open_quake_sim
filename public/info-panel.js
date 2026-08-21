// ================================================================
//  Earthquake Simulator Pro v4.3 — Info Panel / Charts Subsystem
//  Canvas-based chart rendering for the Info tab
//  Load after: physics.js, config.js, i18n.js
//  Load before: app.js
// ================================================================
var InfoPanel = (function() {
  // --- multi-waveform state ---
  var MWF_SLOTS = 3;
  var mwfSlots = [];
  var mwfColors = ['#ff6b6b', '#4da6ff', '#2ecc71'];

  // --- waveform chart state ---
  var chartSec = -1;

  function cfg(k) { return (typeof cfgGet !== 'undefined') ? cfgGet(k) : undefined; }
  function t(k) { return (typeof window.t === 'function') ? window.t(k) : k; }
  // v5.2: display-event params provided by app.js — chain presets follow the
  // currently-firing sub-event; null when unavailable (tests, early load).
  function dp() {
    return (typeof window !== 'undefined' && typeof window.uiDisplayParams === 'function') ? window.uiDisplayParams() : null;
  }

  // ================================================================
  //  UTILITY
  // ================================================================

  function infoRow(label, val) {
    return '<span class="info-label">' + label + ':</span> <span class="info-val">' + val + '</span><br>';
  }

  // ================================================================
  //  INFO PANEL (called every frame from simLoop)
  // ================================================================

  function updateInfoPanel(curMaxPga, curMaxSh) {
    var el = document.getElementById('info-quake');
    if (!el) return;
    if (typeof isRunning === 'undefined' || typeof epicenter === 'undefined') return;

    var html = '';
    var mag = (typeof _liveMag !== 'undefined') ? _liveMag : 0;
    var depth = (typeof depthSlider !== 'undefined') ? parseInt(depthSlider.value) : 30;

    if (!isRunning) {
      html += infoRow(t('epicenter.lat'), (typeof epicenter !== 'undefined' && epicenter ? epicenter.lat.toFixed(4) : '—'));
      html += infoRow(t('epicenter.lng'), (typeof epicenter !== 'undefined' && epicenter ? epicenter.lng.toFixed(4) : '—'));
      html += infoRow(t('epicenter.depth'), depth + ' km');
      html += infoRow(t('mag.label'), 'M' + mag.toFixed(1));
      el.innerHTML = html; return;
    }

    html += infoRow(t('mag.label'), 'M' + mag.toFixed(1));
    html += infoRow(t('epicenter.depth'), depth + ' km');
    if (typeof eventMw !== 'undefined') html += infoRow('Mw', eventMw.toFixed(1));

    var src = (typeof activeSrcType === 'function') ? activeSrcType() : 'crustal';
    html += infoRow('Source Type', src);

    var gmp = cfg('gmpModel') || 'auto';
    html += infoRow('GMPE', gmp);
    html += infoRow('Max PGA', curMaxPga.toFixed(0) + ' gal');
    html += infoRow('Max Shindo', curMaxSh);

    if (typeof simElapsed !== 'undefined') {
      var min = Math.floor(simElapsed / 60);
      var sec = Math.floor(simElapsed % 60);
      html += infoRow('Sim Time', min + ':' + String(sec).padStart(2, '0'));
    }

    el.innerHTML = html;
  }

  // ================================================================
  //  SINGLE WAVEFORM (called from drawFrame)
  // ================================================================

  function updateWaveform() {
    if (typeof wfCanvas === 'undefined' || !wfCanvas) return;
    var ctx = (typeof wfCtx !== 'undefined') ? wfCtx : null;
    if (!ctx) { wfCanvas.width = 400; wfCanvas.height = 100; ctx = wfCanvas.getContext('2d'); if (typeof wfCtx !== 'undefined') wfCtx = ctx; }
    // (full function would be too long; keeping in app.js — this is a placeholder)
  }

  // HiDPI prep shared with app.js (fallback for standalone/test use).
  var _hidpiPrep = function(canvas) {
    if (typeof window !== 'undefined' && typeof window.hidpiPrepCanvas === 'function') return window.hidpiPrepCanvas(canvas);
    return {W: canvas.width, H: canvas.height};
  };

  // ================================================================
  //  INTENSITY TABLE & CURVE
  // ================================================================

  function updateIntensityTable() {
    var tbl = document.getElementById('intensity-table');
    if (!tbl || typeof isRunning === 'undefined' || !isRunning) return;
    if (typeof visibleCircles === 'undefined' || typeof SHINDO_FILL === 'undefined') return;
    tbl.classList.add('show');
    var counts = {};
    for (var i = 0; i < visibleCircles.length; i++) {
      var sh = visibleCircles[i].shindo;
      if (!sh) continue;
      counts[sh] = (counts[sh] || 0) + 1;
    }
    var levels = [7, '6+', '6-', '5+', '5-', 4, 3, 2, 1, 0];
    var rows = '';
    for (var li = 0; li < levels.length; li++) {
      var lv = levels[li], cnt = counts[lv] || 0;
      if (cnt === 0) continue;
      rows += '<tr><td style="background:' + (SHINDO_FILL[lv] || '#888') + ';width:12px"></td><td>' + lv + '</td><td>' + cnt + ' stns</td></tr>';
    }
    tbl.innerHTML = rows || '<tr><td>' + t('catalog.empty') + '</td></tr>';
  }

  function updateIntensityCurve() {
    if (typeof intensityCanvas === 'undefined' || !intensityCanvas) return;
    var canvas = intensityCanvas, ctx = (typeof intensityCtx !== 'undefined') ? intensityCtx : null;
    if (!ctx) { ctx = canvas.getContext('2d'); if (typeof intensityCtx !== 'undefined') intensityCtx = ctx; }
    var _hp = _hidpiPrep(canvas), W = _hp.W, H = _hp.H;
    ctx.clearRect(0, 0, W, H);
    if (typeof simElapsed === 'undefined' || typeof isRunning === 'undefined' || !isRunning) return;
    // accumulate sample
    if (typeof visibleCircles !== 'undefined' && typeof intensitySamples !== 'undefined') {
      var maxS = 0;
      for (var i = 0; i < visibleCircles.length; i++) {
        var sh = visibleCircles[i].shindo;
        if (typeof Physics !== 'undefined' && Physics.shindoScore(sh) > Physics.shindoScore(maxS)) maxS = sh;
      }
      intensitySamples.push({ t: simElapsed, sh: maxS });
      if (intensitySamples.length > 300) intensitySamples.shift();
      // draw
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var si = 0; si < intensitySamples.length; si++) {
        var sx = (intensitySamples[si].t / simElapsed) * W;
        var sy = H - (Physics.shindoNum(intensitySamples[si].sh) / 7) * H;
        if (si === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    // v4.3: Axis labels and shindo reference lines
    var icCtx = ctx; var icW = W, icH = H;
    for (var sl = 1; sl <= 6; sl++) {
      icCtx.strokeStyle = 'rgba(255,255,255,0.08)'; icCtx.lineWidth = 0.5;
      icCtx.beginPath(); icCtx.moveTo(0, icH - (sl/7)*icH); icCtx.lineTo(icW, icH - (sl/7)*icH); icCtx.stroke();
    }
    icCtx.fillStyle = 'rgba(255,255,255,0.45)'; icCtx.font = '9px sans-serif';
    icCtx.fillText((typeof t==='function'?t('chart.time_s'):'Time (s)'), icW/2-20, icH-4);
    icCtx.save(); icCtx.translate(8, icH/2); icCtx.rotate(-Math.PI/2);
    icCtx.fillText((typeof t==='function'?t('chart.shindo'):'JMA Shindo'), 0, 0); icCtx.restore();
  }

  // ================================================================
  //  RESPONSE SPECTRUM
  // ================================================================

  function drawResponseSpectrum() {
    var canvas = document.getElementById('spectrum-canvas');
    if (!canvas || typeof isRunning === 'undefined' || !isRunning) return;
    var ctx = canvas.getContext('2d');
    var _hp = _hidpiPrep(canvas), W = _hp.W, H = _hp.H;
    ctx.clearRect(0, 0, W, H);
    if (typeof wfStation === 'undefined' || !wfStation || typeof epicenter === 'undefined' || !epicenter) return;
    var _d = dp();
    var mag = _d ? _d.mag : ((typeof _liveMag !== 'undefined') ? _liveMag : 7);
    var _epiLat = _d ? _d.lat : epicenter.lat, _epiLng = _d ? _d.lng : epicenter.lng;
    var _evDepth = _d ? _d.depth : ((typeof depthSlider !== 'undefined') ? parseInt(depthSlider.value) : 30);
    var dist = (typeof Physics !== 'undefined') ? Physics.haversineDist(_epiLat, _epiLng, wfStation.lat, wfStation.lng) : 100;
    dist = Math.sqrt(dist * dist + _evDepth * _evDepth);
    var pga = (typeof calcPGA === 'function') ? calcPGA(mag, dist, 400) : 100;
    var amp = (typeof soilAmp === 'function') ? soilAmp(wfStation.lat, wfStation.lng) : 1;
    ctx.strokeStyle = '#4da6ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var ti = 0; ti <= 40; ti++) {
      var T = 0.1 + ti * 0.1;
      var Sa = (typeof Physics !== 'undefined') ? Physics.calcResponseSpectrum(pga, amp, T) : pga;
      var sx = (Math.log(T / 0.1) / Math.log(4)) * W;
      var sy = H - (Sa / 500) * H;
      if (sy < 0) sy = 0; if (sy > H) sy = H;
      if (ti === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    // v4.3: Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '9px sans-serif';
    ctx.fillText((typeof t==='function'?t('chart.period_s'):'Period T (s)'), W/2-30, H-4);
    ctx.save(); ctx.translate(8, H/2); ctx.rotate(-Math.PI/2);
    ctx.fillText((typeof t==='function'?t('chart.sa_gal'):'Sa (gal)'), 0, 0); ctx.restore();
  }

  // ================================================================
  //  GMPE COMPARE CHART
  // ================================================================

  function drawGMPECompare() {
    var canvas = document.getElementById('gmpe-compare-canvas');
    if (!canvas || typeof epicenter === 'undefined' || !epicenter) return;
    var ctx = canvas.getContext('2d');
    var _hp = _hidpiPrep(canvas), W = _hp.W, H = _hp.H;
    ctx.clearRect(0, 0, W, H);
    var _d = dp();
    var mag = _d ? _d.mag : ((typeof _liveMag !== 'undefined') ? _liveMag : 7);
    if (typeof Physics === 'undefined') return;
    var chartDepth = _d ? _d.depth : (typeof depthSlider !== 'undefined' ? parseInt(depthSlider.value) : 30);
    var chartSrc = _d ? _d.srcType : ((typeof activeSrcType === 'function') ? activeSrcType() : Physics.resolveSourceType(chartDepth, (typeof epicenterSrc !== 'undefined' ? epicenterSrc : null), 'auto'));
    var models = [
      {name: 'log', fn: function(d) { return Physics.pgaLog(mag, d, cfg('attA'), cfg('attB'), cfg('attC'), cfg('anelastic')); }, color: '#4da6ff'},
      {name: 'Si-Mid', fn: function(d) { return Physics.pgaSiMid(mag, d, chartDepth, chartSrc); }, color: '#2ecc71'},
      {name: 'Kanno', fn: function(d) { return Physics.pgaKannoShallow(mag, d, chartDepth, 400); }, color: '#f1c40f'},
      {name: 'Zhao', fn: function(d) { return Physics.pgaZhao2006(mag, d, chartDepth, chartSrc, 400); }, color: '#e74c3c'}
    ];
    // Draw grid
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.5;
    for (var gi = 1; gi < 5; gi++) { ctx.beginPath(); ctx.moveTo(gi * W / 4, 0); ctx.lineTo(gi * W / 4, H); ctx.stroke(); }
    // v4.3: Get sigma for ±1σ envelope (log10 units)
    var showSigma = (typeof cfgGet === 'function') ? cfgGet('sigmaDisplay') : 'off';
    var simSrc = chartSrc;
    var simSigma = (typeof Physics !== 'undefined' && typeof cfgGet === 'function') ? Physics.getGmpSigma(cfgGet('gmpModel'), simSrc, 'pga', mag) : 0.30;
    if (typeof cfgGet === 'function' && cfgGet('sigmaOverride') > 0) simSigma = cfgGet('sigmaOverride');

    var activeKey = (typeof cfgGet === 'function') ? cfgGet('gmpModel') : 'log';
    if (activeKey === 'auto' && typeof Physics !== 'undefined') activeKey = Physics.resolveGmpModel(activeKey, simSrc, mag);
    var activeChartName = activeKey === 'si-midorikawa' ? 'Si-Mid' : activeKey === 'kanno2006' ? 'Kanno' : activeKey === 'zhao2006' ? 'Zhao' : 'log';
    for (var mi = 0; mi < models.length; mi++) {
      ctx.strokeStyle = models[mi].color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var di = 0; di <= 50; di++) {
        var dist = 1 + di * 6;
        var pga = models[mi].fn(dist);
        var dx = (Math.log(dist) / Math.log(300)) * W;
        var dy = H - Math.min(1, (pga / 500)) * H;
        if (dy < 0) dy = 0; if (dy > H) dy = H;
        if (di === 0) ctx.moveTo(dx, dy); else ctx.lineTo(dx, dy);
      }
      ctx.stroke();
      // v4.3: ±1σ envelope for active model (dashed)
      if (showSigma !== 'off' && models[mi].name === activeChartName) {
        var sigmaMulHi = Math.pow(10, simSigma);
        var sigmaMulLo = Math.pow(10, -simSigma);
        ctx.strokeStyle = models[mi].color.replace(')', ',0.3)').replace('rgb', 'rgba');
        if (models[mi].color.indexOf('#') === 0) {
          // Convert hex color to rgba with low alpha
          var hex = models[mi].color;
          var r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
          ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.25)';
        }
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 5]);
        // Upper bound
        ctx.beginPath();
        for (var di2 = 0; di2 <= 50; di2++) {
          var dist2 = 1 + di2 * 6;
          var pgaHi = models[mi].fn(dist2) * sigmaMulHi;
          var dx2 = (Math.log(dist2) / Math.log(300)) * W;
          var dy2 = H - Math.min(1, (pgaHi / 500)) * H;
          if (dy2 < 0) dy2 = 0;
          if (di2 === 0) ctx.moveTo(dx2, dy2); else ctx.lineTo(dx2, dy2);
        }
        ctx.stroke();
        // Lower bound
        ctx.beginPath();
        for (var di3 = 0; di3 <= 50; di3++) {
          var dist3 = 1 + di3 * 6;
          var pgaLo = models[mi].fn(dist3) * sigmaMulLo;
          var dx3 = (Math.log(dist3) / Math.log(300)) * W;
          var dy3 = H - Math.min(1, (pgaLo / 500)) * H;
          if (dy3 < 0) dy3 = 0;
          if (di3 === 0) ctx.moveTo(dx3, dy3); else ctx.lineTo(dx3, dy3);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // Sigma label
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px sans-serif';
        ctx.fillText('±1σ', W - 60, H - 8);
      }
      ctx.fillStyle = models[mi].color;
      ctx.font = '10px sans-serif';
      ctx.fillText(models[mi].name, W - 60, 14 + mi * 14);
    }
    // v4.3: Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '9px sans-serif';
    ctx.fillText((typeof t==='function'?t('chart.dist_km'):'Distance (km)'), W/2-30, H-4);
    ctx.save(); ctx.translate(8, H/2); ctx.rotate(-Math.PI/2);
    ctx.fillText((typeof t==='function'?t('chart.pga_gal'):'PGA (gal)'), 0, 0); ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '8px sans-serif';
    for (var ti=1; ti<5; ti++) { var tv=Math.round(ti*125); ctx.fillText(tv, 2, H-ti*H/4+3); }
    ctx.fillText('1', 4, 10); ctx.fillText('10', W/4-10, 10); ctx.fillText('100', W/2-10, 10); ctx.fillText('300', W-25, 10);
  }

  // ================================================================
  //  RESOURCE SPECTRUM CHART
  // ================================================================

  function drawSourceSpectrum() {
    var canvas = document.getElementById('source-spec-canvas');
    if (!canvas || typeof epicenter === 'undefined' || !epicenter) return;
    var ctx = canvas.getContext('2d');
    var _hp = _hidpiPrep(canvas), W = _hp.W, H = _hp.H;
    ctx.clearRect(0, 0, W, H);
    if (typeof Physics === 'undefined') return;
    var _d = dp();
    var mag = _d ? _d.mw : ((typeof eventMw !== 'undefined') ? eventMw : ((typeof _liveMag !== 'undefined') ? _liveMag : 7));
    var fc = Physics.cornerFrequency(mag);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.strokeStyle = '#f1c40f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var fi = 0; fi <= 60; fi++) {
      var f = 0.05 * Math.pow(10, fi * 0.05);
      if (f > 10) f = 10;
      var spec = Physics.bruneSpectrum(f, mag);
      var fx = (Math.log(f / 0.05) / Math.log(200)) * W;
      var fy = H - 20 - (spec * 4);
      if (fy < 0) fy = 0;
      if (fi === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
    }
    ctx.stroke();
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    var fcx = (Math.log(fc / 0.05) / Math.log(200)) * W;
    ctx.beginPath(); ctx.moveTo(fcx, 0); ctx.lineTo(fcx, H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e74c3c';
    ctx.font = '10px sans-serif';
    ctx.fillText('fc=' + fc.toFixed(2) + 'Hz', fcx + 4, 14);
    // v4.3: Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '9px sans-serif';
    ctx.fillText((typeof t==='function'?t('chart.freq_hz'):'Frequency (Hz)'), W/2-35, H-4);
    ctx.save(); ctx.translate(8, H/2); ctx.rotate(-Math.PI/2);
    ctx.fillText((typeof t==='function'?t('chart.amplitude'):'Amplitude'), 0, 0); ctx.restore();
  }

  // ================================================================
  //  ATTENUATION CURVE
  // ================================================================

  function drawAttenuationCurve() {
    var canvas = document.getElementById('atten-canvas');
    if (!canvas || typeof epicenter === 'undefined' || !epicenter) return;
    var ctx = canvas.getContext('2d');
    var _hp = _hidpiPrep(canvas), W = _hp.W, H = _hp.H;
    ctx.clearRect(0, 0, W, H);
    if (typeof visibleCircles === 'undefined' || typeof Physics === 'undefined') return;
    var _d = dp();
    var mag = _d ? _d.mag : ((typeof _liveMag !== 'undefined') ? _liveMag : 7);
    for (var i = 0; i < visibleCircles.length; i++) {
      var c = visibleCircles[i];
      var dist = (typeof hypoDist === 'function') ? hypoDist(c.lat, c.lng) : Physics.haversineDist(epicenter.lat, epicenter.lng, c.lat, c.lng);
      // v5.2 chain: attribute each station to the sub-event contributing the
      // most PGA (per-contribution distances recorded at sim start).
      if (_d && _d.count > 1 && c.subEvents && c.subEvents.length) {
        var domPga = (c.peakPga != null) ? c.peakPga : c.pga;
        for (var dsi = 0; dsi < c.subEvents.length; dsi++) {
          var dsc = c.subEvents[dsi];
          if (dsc.dist != null && dsc.peakPga > domPga) { domPga = dsc.peakPga; dist = dsc.dist; }
        }
      }
      var dx = (Math.log(dist) / Math.log(500)) * W;
      var dy = H - (c.pga / 1500) * H;
      if (dy < 0) dy = 0;
      var fill = (typeof SHINDO_FILL !== 'undefined') ? (SHINDO_FILL[c.shindo] || '#888') : '#888';
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(dx, dy, 3, 0, Math.PI * 2); ctx.fill();
    }
    // Theoretical curve
    ctx.strokeStyle = '#4da6ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var di = 0; di <= 50; di++) {
      var distKm = 2 + di * 10;
      var pga = (typeof calcPGA === 'function') ? calcPGA(mag, distKm, 400) : 100;
      var dx = (Math.log(distKm) / Math.log(500)) * W;
      var dy = H - (pga / 1500) * H;
      if (dy < 0) dy = 0;
      if (di === 0) ctx.moveTo(dx, dy); else ctx.lineTo(dx, dy);
    }
    ctx.stroke();
    // v4.3: ±1σ envelope (dashed)
    var attShowSigma = (typeof cfgGet === 'function') ? cfgGet('sigmaDisplay') : 'off';
    if (attShowSigma !== 'off') {
      var attDepth = _d ? _d.depth : (typeof depthSlider !== 'undefined' ? parseInt(depthSlider.value) : 30);
      var attSrc = _d ? _d.srcType : ((typeof activeSrcType === 'function') ? activeSrcType() : Physics.resolveSourceType(attDepth, (typeof epicenterSrc !== 'undefined' ? epicenterSrc : null), 'auto'));
      var attSigma = (typeof Physics !== 'undefined' && typeof cfgGet === 'function') ? Physics.getGmpSigma(cfgGet('gmpModel'), attSrc, 'pga', mag) : 0.30;
      if (typeof cfgGet === 'function' && cfgGet('sigmaOverride') > 0) attSigma = cfgGet('sigmaOverride');
      var sHi = Math.pow(10, attSigma), sLo = Math.pow(10, -attSigma);
      ctx.strokeStyle = 'rgba(77,166,255,0.25)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      for (var dj = 0; dj <= 50; dj++) {
        var dkHi = 2 + dj * 10;
        var pHi = ((typeof calcPGA === 'function') ? calcPGA(mag, dkHi, 400) : 100) * sHi;
        var dxH = (Math.log(dkHi) / Math.log(500)) * W;
        var dyH = H - Math.min(1, (pHi / 1500)) * H;
        if (dyH < 0) dyH = 0;
        if (dj === 0) ctx.moveTo(dxH, dyH); else ctx.lineTo(dxH, dyH);
      }
      ctx.stroke();
      ctx.beginPath();
      for (var dk = 0; dk <= 50; dk++) {
        var dkLo = 2 + dk * 10;
        var pLo = ((typeof calcPGA === 'function') ? calcPGA(mag, dkLo, 400) : 100) * sLo;
        var dxL = (Math.log(dkLo) / Math.log(500)) * W;
        var dyL = H - Math.min(1, (pLo / 1500)) * H;
        if (dyL < 0) dyL = 0;
        if (dk === 0) ctx.moveTo(dxL, dyL); else ctx.lineTo(dxL, dyL);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // v4.3: Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '9px sans-serif';
    ctx.fillText((typeof t==='function'?t('chart.dist_km'):'Distance (km)'), W/2-30, H-4);
    ctx.save(); ctx.translate(8, H/2); ctx.rotate(-Math.PI/2);
    ctx.fillText((typeof t==='function'?t('chart.pga_gal'):'PGA (gal)'), 0, 0); ctx.restore();
    // Legend
    ctx.fillStyle = '#4da6ff'; ctx.fillRect(W-90, H-36, 8, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '8px sans-serif';
    ctx.fillText('Theoretical', W-78, H-28);
    ctx.fillStyle = '#888'; ctx.fillRect(W-90, H-22, 8, 8);
    ctx.fillText('Observed', W-78, H-14);
  }
  function redrawInfoCharts() {
    drawAttenuationCurve();
    drawGMPECompare();
    drawSourceSpectrum();
    // Travel time and azimuth curves reference local functions in app.js
    if (typeof drawTravelTimeCurve === 'function') drawTravelTimeCurve();
    if (typeof drawAzimuthDirectivity === 'function') drawAzimuthDirectivity();
  }

  // ================================================================
  //  REALTIME WAVEFORM (API-fetched)
  // ================================================================

  function drawRealtimeWaveform(data) {
    var canvas = document.getElementById('realtime-wf-canvas');
    if (!canvas || !data || !data.samples) return;
    var ctx = canvas.getContext('2d');
    var _hp = _hidpiPrep(canvas), W = _hp.W, H = _hp.H;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#4da6ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < data.samples.length; i++) {
      var x = (i / data.samples.length) * W;
      var y = H / 2 - (data.samples[i] / (data.maxAmp || 1)) * (H / 2 - 5);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // v4.3: Axis labels and zero-line
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '9px sans-serif';
    ctx.fillText((typeof t==='function'?t('chart.time'):'Time'), W/2-15, H-4);
    ctx.save(); ctx.translate(8, H/2+10); ctx.rotate(-Math.PI/2);
    ctx.fillText((typeof t==='function'?t('chart.amplitude'):'Amplitude'), 0, 0); ctx.restore();
  }

  // ================================================================
  //  CHART THROTTLE RESET
  // ================================================================

  function resetChartSec() { chartSec = -1; }
  function getChartSec() { return chartSec; }
  function setChartSec(v) { chartSec = v; }

  return {
    // info panel
    infoRow: infoRow,
    updateInfoPanel: updateInfoPanel,
    updateWaveform: updateWaveform,
    // charts
    updateIntensityTable: updateIntensityTable,
    updateIntensityCurve: updateIntensityCurve,
    drawResponseSpectrum: drawResponseSpectrum,
    drawAttenuationCurve: drawAttenuationCurve,
    drawGMPECompare: drawGMPECompare,
    drawSourceSpectrum: drawSourceSpectrum,
    redrawInfoCharts: redrawInfoCharts,
    drawRealtimeWaveform: drawRealtimeWaveform,
    // throttle
    resetChartSec: resetChartSec,
    getChartSec: getChartSec,
    setChartSec: setChartSec
  };
})();

// ---- v4.2: Backward-compat aliases REMOVED ----
// The full implementations remain in app.js (updateWaveform, updateInfoPanel, etc.).
// InfoPanel.xxx methods delegate to the global functions if they exist.
// Loading info-panel.js no longer overrides the canonical app.js implementations.
// v4.3: The uncertainty-aware chart implementations are now canonical.
window.drawAttenuationCurve = InfoPanel.drawAttenuationCurve;
window.drawGMPECompare = InfoPanel.drawGMPECompare;
