// quake3d.js v3 — Immersive Japan + strata + fault 3D visualization
// Top-down: Japan outline + seafloor terrain. Rotate underneath: crust strata +
// the dipping fault plane (real strike/dip/size from Physics.genSubSources).
// P/S wave shells expand from the hypocenter using the same travel distances
// computed in app.js (PW/SW + IASP91). All physics reused, none reimplemented.
var Quake3D = (function() {
  'use strict';
  if (typeof THREE === 'undefined') return {
    init:function(){}, update:function(){}, setMode:function(){}, resize:function(){},
    resetView:function(){}, setViewAngle:function(){}, loadBathymetry:function(){},
    setGeo:function(){}
  };

  var scene, camera, renderer, controls, canvas3d, animId;
  var initialized = false, _visible = true, _needsRender = true;
  var _visibilityObserver = null;
  var _motionMedia = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var _reducedMotion = !!(_motionMedia && _motionMedia.matches);

  function removeControlRenderListeners(canvas) {
    if (!canvas) return;
    ['mousemove','wheel','touchmove'].forEach(function(type) {
      canvas.removeEventListener(type, requestRender);
    });
  }
  function addControlRenderListeners(canvas) {
    if (!canvas) return;
    ['mousemove','wheel','touchmove'].forEach(function(type) {
      canvas.addEventListener(type, requestRender, {passive:true});
    });
  }

  // --- Equirectangular projection: scene unit = 1 km, origin at Japan center ---
  var CENTER = {lat: 36.2, lng: 138.2};
  var _cosLat = Math.cos(CENTER.lat * Math.PI / 180);
  function project(lat, lng) {
    return {
      x: (lng - CENTER.lng) * _cosLat * 111.32,
      z: -(lat - CENTER.lat) * 111.32
    };
  }
  var TERRAIN_EXAG = 40;   // vertical exaggeration for surface relief only (thin shell near Y=0)
  var DEPTH_RISE = 2.5;    // seconds for a fault cell to fully light up after rupture front arrives

  var _geo = {coastline: null, plates: null, bathy: null};
  var _data = {simElapsed: 0, events: [], epicenter: null, strike: 0, dip: 90, rupSpeed: 2.8, stations: []};
  // Orbit center: follows the hypocenter (or epicenter) so the user rotates
  // around the earthquake source, not the map center.
  var _focusTarget = new THREE.Vector3(0, -40, 0);
  var _focusActive = false; // false until we have a real event/epicenter to follow

  // Scene object handles
  var terrainMesh = null, coastLines = null, plateLines = null, surfaceGrid = null;
  var strataGroup = null, depthScale = null;
  var dynGroup = null;                 // cleared + rebuilt each update (hypocenters, waves, markers)
  var faultGroup = null;
  var mechanismGroup = null; // nodal planes and P/T/B axes for the active event
  var _faultCache = {};                // key -> {mesh, edges, geom, colors, subs, nS, nD}
  var _stationPool = null;             // fixed pool of bar meshes

  function init(canvasEl) {
    if (!canvasEl) return;
    var oldCanvas = canvas3d;
    if (oldCanvas) oldCanvas.removeEventListener('dblclick', resetView);
    removeControlRenderListeners(oldCanvas);
    if (_visibilityObserver) { _visibilityObserver.disconnect(); _visibilityObserver = null; }
    if (controls && controls.dispose) { try { controls.dispose(); } catch(e) {} }
    canvas3d = canvasEl;
    initialized = false;
    _visible = true;
    // v4.2: Clean up old renderer + animation before creating new one
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (renderer) {
      try { renderer.dispose(); } catch(e) {}
      renderer = null;
    }
    // Clear old caches so rebuildDynamics creates fresh meshes
    Object.keys(_dynCache).forEach(function(k) { disposeDynEntry(_dynCache[k]); });
    _dynCache = {};
    Object.keys(_faultCache).forEach(function(k) {
      var fc = _faultCache[k];
      if (fc.mesh) { faultGroup.remove(fc.mesh); fc.geom.dispose(); fc.mesh.material.dispose(); fc.edges.geometry.dispose(); fc.edges.material.dispose(); }
    });
    _faultCache = {};
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060c);

    var W = canvas3d.clientWidth || 320, H = canvas3d.clientHeight || 200;
    camera = new THREE.PerspectiveCamera(45, W / H, 1, 20000);
    camera.position.set(1500, 1300, 1500);

    renderer = new THREE.WebGLRenderer({canvas: canvas3d, antialias: true});
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Three.js setSize writes an inline width that overrides CSS width:100%;
    // clear it so the canvas fills its container like the other info canvases.
    canvas3d.style.width = '';

    controls = new THREE.OrbitControls(camera, canvas3d);
    controls.minDistance = 60;
    controls.maxDistance = 8000;
    controls.minPolarAngle = 0.03;
    controls.maxPolarAngle = Math.PI - 0.03;  // allow looking from underneath
    controls.enableDamping = !_reducedMotion;
    // Sync the controller's internal spherical with the desired initial pose.
    if (controls.setPose) controls.setPose(camera.position.clone(), new THREE.Vector3(0, -40, 0));

    scene.add(new THREE.AmbientLight(0x90a0c0, 0.9));
    var dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(800, 1200, 600); scene.add(dir);
    var dir2 = new THREE.DirectionalLight(0x6688cc, 0.4);
    dir2.position.set(-500, -400, -600); scene.add(dir2);

    buildStrata();
    buildSurfaceGrid();
    buildStationPool();

    dynGroup = new THREE.Group(); scene.add(dynGroup);
    faultGroup = new THREE.Group(); scene.add(faultGroup);
    mechanismGroup = new THREE.Group(); scene.add(mechanismGroup);

    if (_geo.bathy) buildTerrain(_geo.bathy);
    if (_geo.coastline) buildCoastlines(_geo.coastline);
    if (_geo.plates) buildPlates(_geo.plates);

    canvas3d.addEventListener('dblclick', resetView);
    addControlRenderListeners(canvas3d);
    if (typeof IntersectionObserver !== 'undefined') {
      _visibilityObserver = new IntersectionObserver(function(entries) {
        if (!entries.length || entries[0].target !== canvas3d) return;
        _visible = entries[0].isIntersecting;
        if (_visible) requestRender();
      }, {threshold: 0.05});
      _visibilityObserver.observe(canvas3d);
    }

    initialized = true;
    startAnimation();
  }

  // --- Strata planes (visible from below) ---
  function buildStrata() {
    strataGroup = new THREE.Group();
    var layers = [
      {y: -35, color: 0x3a6688, op: 0.10},
      {y: -120, color: 0x884422, op: 0.08},
      {y: -410, color: 0xaa5500, op: 0.06}
    ];
    layers.forEach(function(l) {
      var g = new THREE.PlaneGeometry(3200, 3200);
      var m = new THREE.MeshBasicMaterial({color: l.color, transparent: true, opacity: l.op, side: THREE.DoubleSide, depthWrite: false});
      var mesh = new THREE.Mesh(g, m);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = l.y;
      strataGroup.add(mesh);
    });
    scene.add(strataGroup);

    depthScale = new THREE.Group();
    var lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1700, 0, 0), new THREE.Vector3(-1700, 0, -450)
    ]);
    depthScale.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({color: 0x99aabb})));
    [0, -35, -120, -410].forEach(function(y) {
      var tick = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1720, y, 0), new THREE.Vector3(-1680, y, 0)
      ]);
      depthScale.add(new THREE.Line(tick, new THREE.LineBasicMaterial({color: 0xaabbcc})));
    });
    scene.add(depthScale);
  }

  function buildSurfaceGrid() {
    surfaceGrid = new THREE.GridHelper(3200, 32, 0x334455, 0x1a2233);
    surfaceGrid.position.y = 0.5;
    scene.add(surfaceGrid);
  }

  // --- Japan + seafloor terrain from bathymetry grid ---
  function buildTerrain(bathy) {
    if (!bathy || !bathy.data || !bathy.nx || !bathy.ny) return;
    if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); }
    var nx = bathy.nx, ny = bathy.ny, res = bathy.res || 0.15;
    var oLng = bathy.origin[0], oLat = bathy.origin[1];
    var nV = nx * ny;
    var positions = new Float32Array(nV * 3);
    var colors = new Float32Array(nV * 3);
    var maxDepth = bathy.maxDepth || 50, minDepth = bathy.minDepth || -8000;
    for (var iy = 0; iy < ny; iy++) {
      for (var ix = 0; ix < nx; ix++) {
        var idx = iy * nx + ix;
        var lat = oLat + iy * res, lng = oLng + ix * res;
        var p = project(lat, lng);
        var dM = bathy.data[idx]; // meters; + land, - ocean
        var yKm = (dM / 1000) * TERRAIN_EXAG;
        positions[idx * 3] = p.x;
        positions[idx * 3 + 1] = yKm;
        positions[idx * 3 + 2] = p.z;
        var r, g, b;
        if (dM > 0) {
          var t = Math.min(1, dM / maxDepth);
          r = 0.45 + t * 0.25; g = 0.50 + t * 0.15; b = 0.30;
        } else {
          var f = Math.min(1, (-dM) / (-minDepth));
          r = 0.04 + (1 - f) * 0.10; g = 0.10 + (1 - f) * 0.18; b = 0.22 + (1 - f) * 0.30;
        }
        colors[idx * 3] = r; colors[idx * 3 + 1] = g; colors[idx * 3 + 2] = b;
      }
    }
    var indices = [];
    for (iy = 0; iy < ny - 1; iy++) {
      for (ix = 0; ix < nx - 1; ix++) {
        var a = iy * nx + ix, b = a + 1, c = a + nx, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mat = new THREE.MeshPhongMaterial({vertexColors: true, side: THREE.DoubleSide, flatShading: true, shininess: 4});
    terrainMesh = new THREE.Mesh(geo, mat);
    scene.add(terrainMesh);
    requestRender();
  }


  // --- Coastline outline (LineSegments to allow gaps between features) ---
  function buildCoastlines(geojson) {
    if (coastLines) { scene.remove(coastLines); coastLines.geometry.dispose(); coastLines.material.dispose(); }
    var feats = geojson.features || [geojson];
    var pts = [];
    function pushSeg(coords) {
      for (var i = 0; i < coords.length - 1; i++) {
        var p1 = project(coords[i][1], coords[i][0]);
        var p2 = project(coords[i + 1][1], coords[i + 1][0]);
        pts.push(p1.x, 0.2, p1.z, p2.x, 0.2, p2.z);
      }
    }
    feats.forEach(function(f) {
      var g = f.geometry; if (!g) return;
      if (g.type === 'LineString') pushSeg(g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(pushSeg);
      else if (g.type === 'Polygon') g.coordinates.forEach(pushSeg);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(function(poly) { poly.forEach(pushSeg); });
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    var mat = new THREE.LineBasicMaterial({color: 0xeaf2ff, transparent: true, opacity: 0.9});
    coastLines = new THREE.LineSegments(geo, mat);
    scene.add(coastLines);
    requestRender();
  }

  // --- Plate boundaries (dashed look via short segments) ---
  function buildPlates(geojson) {
    if (plateLines) { scene.remove(plateLines); plateLines.geometry.dispose(); plateLines.material.dispose(); }
    var feats = geojson.features || [geojson];
    var pts = [];
    feats.forEach(function(f) {
      var coords = (f.geometry && f.geometry.coordinates) || [];
      if (f.geometry && f.geometry.type === 'MultiLineString') {
        coords.forEach(function(c) { segDash(c, pts); });
      } else segDash(coords, pts);
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    var mat = new THREE.LineBasicMaterial({color: 0xff5577, transparent: true, opacity: 0.7});
    plateLines = new THREE.LineSegments(geo, mat);
    scene.add(plateLines);
    requestRender();
  }
  function segDash(coords, pts) {
    if (!coords || coords.length < 2) return;
    for (var i = 0; i < coords.length - 1; i++) {
      var p1 = project(coords[i][1], coords[i][0]);
      var p2 = project(coords[i + 1][1], coords[i + 1][0]);
      var dx = p2.x - p1.x, dz = p2.z - p1.z;
      var len = Math.sqrt(dx * dx + dz * dz);
      var steps = Math.max(1, Math.floor(len / 40));
      for (var s = 0; s < steps; s += 2) {
        var t1 = s / steps, t2 = Math.min(1, (s + 1) / steps);
        if (t2 <= t1) continue;
        pts.push(p1.x + dx * t1, 0.3, p1.z + dz * t1, p1.x + dx * t2, 0.3, p1.z + dz * t2);
      }
    }
  }

  // --- Station PGA bars: fixed pool, repositioned each update ---
  function buildStationPool() {
    _stationPool = [];
    var N = 80; // larger pool so low-shindo (blue/green) bars are shown alongside high ones
    for (var i = 0; i < N; i++) {
      var geo = new THREE.BoxGeometry(6, 1, 6);
      var mat = new THREE.MeshPhongMaterial({color: 0x6cb4ee, emissive: 0x6cb4ee, emissiveIntensity: 0.25, transparent: true, opacity: 0.8});
      var bar = new THREE.Mesh(geo, mat);
      bar.visible = false;
      scene.add(bar);
      _stationPool.push(bar);
    }
  }
  // Full JMA Shindo color scale (0=gray-blue … 7=dark red). Distinct hues for the
  // low end so blue/green bars are visible alongside the red/orange high end.
  function shindoColor(s) {
    if (s === 7) return 0x6c0f1f;
    if (s === '6+') return 0x8e44ad;
    if (s === '6-') return 0xc0392b;
    if (s === '5+') return 0xe74c3c;
    if (s === '5-') return 0xe67e22;
    if (s === 4) return 0xf1c40f;
    if (s === 3) return 0x2ecc71;
    if (s === 2) return 0x3a9bdc;
    if (s === 1) return 0x6cb4ee;
    return 0x9fb8d8; // shindo 0 — pale blue-gray
  }
  function updateStations(stations) {
    if (!_stationPool) return;
    _stationPool.forEach(function(b) { b.visible = false; });
    if (!stations || !stations.length) return;
    // Show a wide intensity range: sort by PGA but keep low-PGA stations too.
    var sorted = stations.slice().sort(function(a, b) { return (b.displayPga || 0) - (a.displayPga || 0); });
    var n = Math.min(_stationPool.length, sorted.length);
    for (var i = 0; i < n; i++) {
      var s = sorted[i];
      if (!s.displayPga || s.displayPga < 0.5) continue; // include even faint shaking
      var bar = _stationPool[i];
      var p = project(s.lat, s.lng);
      // Power-law height so low-PGA bars are still visible, high ones capped.
      var h = Math.min(140, Math.max(3, Math.pow(s.displayPga, 0.6) * 2.0));
      bar.scale.y = Math.max(1, h);
      bar.position.set(p.x, h / 2, p.z);
      bar.material.color.setHex(shindoColor(s.shindo));
      bar.material.emissive.setHex(shindoColor(s.shindo));
      bar.visible = true;
    }
  }

  // --- Fault plane for an event (cached, rebuilt if geometry changes) ---
  function faultKey(ev, strike, dip, rupSpeed) {
    var canonical=ev.sourceModel&&ev.sourceModel.geometry;
    if(canonical)return [ev.id,canonical.L,canonical.W,canonical.nStrike,canonical.nDip,
      canonical.hypocenterStrikeFrac,canonical.hypocenterDipFrac,canonical.modelHash||'generated'].join('|');
    var editor='';
    try{if(typeof FiniteFaultEditor!=='undefined'&&FiniteFaultEditor.getState)editor=JSON.stringify(FiniteFaultEditor.getState());}catch(e){}
    var seed=(typeof cfgGet==='function')?cfgGet('randomSeed'):0;
    return [ev.id,ev.mag,ev.depth,strike,dip,rupSpeed,ev.sourceType||'auto',seed,editor].join('|');
  }
  function buildFault(ev, strike, dip, rupSpeed) {
    if (typeof Physics === 'undefined' || !Physics.genSubSources) return null;
    var ff=ev.sourceModel&&ev.sourceModel.geometry;
    if (ev.mag < 6.5 && !(ff&&ff.kind==='imported-finite-fault')) return null;
    if(!ff){
      var ffOpts = (typeof FiniteFaultEditor !== 'undefined' && FiniteFaultEditor.getOpts) ? (FiniteFaultEditor.getOpts() || {}) : {};
      ffOpts.sourceType = ev.sourceType || _data.sourceType;
      if(typeof cfgGet==='function'){ffOpts.randomSeed=cfgGet('randomSeed');ffOpts.slipPerturbation=cfgGet('slipPerturbation');}
      ff = Physics.genSubSources(ev.lat, ev.lng, ev.mag, strike, dip, ev.depth, rupSpeed, ffOpts);
    }
    if (!ff || !ff.subs || !ff.subs.length) return null;
    var nS = ff.nStrike, nD = ff.nDip, subs = ff.subs;
    // Duplicate the four vertices of every cell. Shared vertices forced one
    // patch's slip colour onto its neighbours and made asperities blocky.
    var nV = nS*nD*4;
    var positions = new Float32Array(nV * 3);
    var colors = new Float32Array(nV * 3);
    var indices = [];
    for(var i=0;i<nS;i++){
      for(var j=0;j<nD;j++){
        var cell=i*nD+j,base=cell*4;
        var corners=[ff.cellPoint(i,j,0,0),ff.cellPoint(i,j,1,0),ff.cellPoint(i,j,1,1),ff.cellPoint(i,j,0,1)];
        for(var q=0;q<4;q++){
          var p=project(corners[q].lat,corners[q].lng),idx=base+q;
          positions[idx*3]=p.x;positions[idx*3+1]=-corners[q].depth;positions[idx*3+2]=p.z;
        }
        indices.push(base,base+1,base+2,base,base+2,base+3);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mat = new THREE.MeshBasicMaterial({vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false});
    var mesh = new THREE.Mesh(geo, mat);
    faultGroup.add(mesh);
    var edges = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({color: 0xffa06f, transparent: true, opacity: 0.24}));
    faultGroup.add(edges);
    var hp=ff.hypocenter||{lat:ev.lat,lng:ev.lng,depth:ev.depth},hpp=project(hp.lat,hp.lng);
    var hypocenter=new THREE.Mesh(new THREE.SphereGeometry(3.2,12,8),new THREE.MeshBasicMaterial({color:0x7de3ff}));
    hypocenter.position.set(hpp.x,-hp.depth,hpp.z);faultGroup.add(hypocenter);
    // Rupture-time bounds for the color-update gate (see updateFault).
    var rtMin = Infinity, rtMax = 0;
    var maxRise=0,maxSlip=0;
    for (var k = 0; k < subs.length; k++) {
      var rtk = subs[k].ruptureTime || 0;
      if (rtk < rtMin) rtMin = rtk;
      if (rtk > rtMax) rtMax = rtk;
      maxRise=Math.max(maxRise,subs[k].riseTime||DEPTH_RISE);maxSlip=Math.max(maxSlip,subs[k].slipWeight||0);
    }
    return {mesh:mesh,edges:edges,hypocenter:hypocenter,geom:geo,colors:colors,subs:subs,nS:nS,nD:nD,maxSlip:maxSlip,
            rtMin:rtMin,rtDone:rtMax+maxRise,colorFinal:false};
  }
  function updateFault(fc, originTime, simElapsed) {
    if (!fc) return;
    var elapsed = simElapsed - (originTime || 0);
    var vis = elapsed > -2;
    fc.mesh.visible = vis; fc.edges.visible = vis;if(fc.hypocenter)fc.hypocenter.visible=vis;
    // Once rupture is fully lit, colors are static — skip the per-cell recompute + GPU upload.
    // Self-correct on restart/rewind (elapsed drops below rtDone): re-animate.
    if (fc.colorFinal && fc.rtDone != null && elapsed < fc.rtDone) fc.colorFinal = false;
    if (fc.colorFinal) return;
    var colors = fc.colors, subs = fc.subs, nS = fc.nS, nD = fc.nD;
    for (var i = 0; i < nS; i++) {
      for (var j = 0; j < nD; j++) {
        var cell=i*nD+j,s=subs[cell];
        var rt = s.ruptureTime || 0;
        var frac=Physics.rupturePatchFraction?Physics.rupturePatchFraction(s,elapsed):Math.max(0,Math.min(1,(elapsed-rt)/Math.max(0.01,s.riseTime||DEPTH_RISE)));
        var intensity=Math.max(0.08,Math.min(1,(s.slipWeight||1)/Math.max(fc.maxSlip,1e-9)));
        for(var q=0;q<4;q++){
          var idx=(cell*4+q)*3;
          colors[idx]=0.12+(0.83*intensity)*frac;
          colors[idx+1]=0.10+(0.62*intensity)*frac;
          colors[idx+2]=0.18-(0.10*intensity)*frac;
        }
      }
    }
    fc.geom.attributes.color.array.set(colors);
    fc.geom.attributes.color.needsUpdate = true;
    if (fc.rtDone != null && elapsed >= fc.rtDone) fc.colorFinal = true;
  }
  function rebuildFaults(data) {
    var strike = data.strike || 0, dip = data.dip || 90, rup = data.rupSpeed || 2.8;
    var events = data.events || [];
    var seen = {};
    events.forEach(function(ev) {
      if (!ev || ev.mag == null || (ev.mag < 6.5&&!(ev.sourceModel&&ev.sourceModel.finiteFault))) return;
      var eventStrike = ev.strike != null ? ev.strike : strike;
      var eventDip = ev.dip != null ? ev.dip : dip;
      var key = faultKey(ev, eventStrike, eventDip, rup);
      seen[key] = true;
      if (!_faultCache[key]) {
        var fc = buildFault(ev, eventStrike, eventDip, rup);
        if (fc) _faultCache[key] = fc;
      }
      if (_faultCache[key]) updateFault(_faultCache[key], ev.originTime, data.simElapsed);
    });
    Object.keys(_faultCache).forEach(function(k) {
      if (!seen[k]) {
        var fc = _faultCache[k];
        faultGroup.remove(fc.mesh); faultGroup.remove(fc.edges);if(fc.hypocenter)faultGroup.remove(fc.hypocenter);
        fc.geom.dispose(); fc.mesh.material.dispose(); fc.edges.geometry.dispose(); fc.edges.material.dispose();
        if(fc.hypocenter){fc.hypocenter.geometry.dispose();fc.hypocenter.material.dispose();}
        delete _faultCache[k];
      }
    });
  }

  // --- Focal mechanism geometry (NED -> scene coordinates) ---
  function nedToWorld(v) {
    // Physics uses NED: x=north, y=east, z=down. The scene uses x=east,
    // y=up, z=south, so depth remains visually below the surface.
    return new THREE.Vector3(v.y, -v.z, -v.x);
  }
  function addMechanismPlane(center, plane, length, color, opacity) {
    if (!plane || !plane.strikeVector || !plane.dipVector) return;
    var s = nedToWorld(plane.strikeVector).normalize();
    var d = nedToWorld(plane.dipVector).normalize();
    var half = length * 0.5, width = Math.max(12, length * 0.32);
    var pts = [
      center.clone().addScaledVector(s, -half).addScaledVector(d, -width * 0.5),
      center.clone().addScaledVector(s, half).addScaledVector(d, -width * 0.5),
      center.clone().addScaledVector(s, half).addScaledVector(d, width * 0.5),
      center.clone().addScaledVector(s, -half).addScaledVector(d, width * 0.5)
    ];
    var arr = [];
    for (var i = 0; i < 4; i++) { var a = pts[i], b = pts[(i + 1) % 4]; arr.push(a.x,a.y,a.z,b.x,b.y,b.z); }
    var geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    var line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({color:color, transparent:true, opacity:opacity}));
    mechanismGroup.add(line);
  }
  function addAxis(center, axis, color, label) {
    if (!axis || !axis.vector) return;
    var dir = nedToWorld(axis.vector).normalize();
    var len = 80;
    var arrow = new THREE.ArrowHelper(dir, center, len, color, 14, 8);
    mechanismGroup.add(arrow);
  }
  function rebuildMechanisms(data) {
    if (!mechanismGroup || typeof Physics === 'undefined' || !Physics.focalMechanism) return;
    while (mechanismGroup.children.length) {
      var obj = mechanismGroup.children.pop();
      obj.traverse(function(child) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    var events = data.events || [];
    // v5.2: draw every event's mechanism so chain presets show each
    // sub-event's faulting; the mainshock stays emphasized (full size +
    // P/T/B axes), sub-events smaller and dimmer. Previously only the
    // mainshock (or first event) was rendered.
    for (var mi = 0; mi < events.length; mi++) {
      var ev = events[mi];
      if (!ev || ev.lat == null || ev.strike == null) continue;
      var isMain = !!ev.isMainshock;
      var fm = Physics.focalMechanism({strike:ev.strike,dip:ev.dip != null ? ev.dip : 90,rake:ev.rake != null ? ev.rake : 0,mw:ev.mag});
      var p = project(ev.lat, ev.lng), center = new THREE.Vector3(p.x, -(ev.depth || 0), p.z);
      var size = Math.max(80, Math.min(420, Math.pow(10, (ev.mag || 6) - 5.5) * 35)) * (isMain ? 1 : 0.6);
      addMechanismPlane(center, fm.plane1, size, 0xffaa33, isMain ? 0.9 : 0.45);
      addMechanismPlane(center, fm.plane2, size, 0x66ccff, isMain ? 0.7 : 0.35);
      if (isMain) {
        addAxis(center, fm.axes.P, 0x4c78a8, 'P');
        addAxis(center, fm.axes.T, 0xe45756, 'T');
        addAxis(center, fm.axes.B, 0x54a24b, 'B');
      }
    }
  }

  // --- Hypocenters, epicenter markers, P/S wave shells (persistent, updated each frame) ---
  // Objects are created once per event and only their transforms/opacity are
  // updated each frame. This avoids per-frame geometry/material allocation that
  // caused GC churn (which made the 2D intensity chart flicker).
  var _dynCache = {};          // evKey -> entry (persistent meshes)
  var _sharedSphereGeo = null; // unit sphere shared by all hypocenters/glows/shells
  function sharedSphereGeo() {
    if (!_sharedSphereGeo) _sharedSphereGeo = new THREE.SphereGeometry(1, 20, 14);
    return _sharedSphereGeo;
  }
  function dynKey(ev) {
    return ev.id != null ? ('e' + ev.id) : ('e_' + (ev.lat||0) + '_' + (ev.lng||0));
  }
  function buildDynEntry(ev) {
    var isMain = !!ev.isMainshock;
    var entry = {};
    entry.cone = new THREE.Mesh(
      new THREE.ConeGeometry(isMain ? 14 : 8, isMain ? 40 : 24, 12),
      new THREE.MeshBasicMaterial({color: isMain ? 0xff3030 : 0xff8855})
    );
    entry.coneIsMain = isMain;
    dynGroup.add(entry.cone);
    entry.stemGeo = new THREE.BufferGeometry();
    entry.stemGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    entry.stem = new THREE.Line(entry.stemGeo, new THREE.LineBasicMaterial({color: 0xff5533, transparent: true, opacity: 0.4}));
    dynGroup.add(entry.stem);
    var sg = sharedSphereGeo();
    entry.hypo = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({color: 0xff2200, transparent: true, opacity: 0.9, depthWrite: false}));
    dynGroup.add(entry.hypo);
    entry.glow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({color: 0xff5500, transparent: true, opacity: 0.18, depthWrite: false}));
    dynGroup.add(entry.glow);
    entry.pShell = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({color: 0x4da6ff, transparent: true, opacity: 0.13, wireframe: true, depthWrite: false}));
    entry.pGlow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({color: 0x4da6ff, transparent: true, opacity: 0.03, depthWrite: false}));
    dynGroup.add(entry.pShell); dynGroup.add(entry.pGlow);
    entry.sShell = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({color: 0xff9f43, transparent: true, opacity: 0.16, wireframe: true, depthWrite: false}));
    entry.sGlow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({color: 0xff9f43, transparent: true, opacity: 0.04, depthWrite: false}));
    dynGroup.add(entry.sShell); dynGroup.add(entry.sGlow);
    return entry;
  }
  function disposeDynEntry(entry) {
    var keys = ['cone','stem','hypo','glow','pShell','pGlow','sShell','sGlow'];
    for (var i = 0; i < keys.length; i++) {
      var o = entry[keys[i]]; if (!o) continue;
      dynGroup.remove(o);
      if (keys[i] === 'cone' && o.geometry) o.geometry.dispose(); // cone has its own geo; spheres share the shared geo (do not dispose)
      if (o.material) o.material.dispose();
    }
    if (entry.stemGeo) entry.stemGeo.dispose();
  }
  function setShell(shell, glow, x, y, z, radius, baseOp, elapsed, freq) {
    if (!radius || radius < 1) { shell.visible = false; glow.visible = false; return; }
    var r = Math.max(1, radius);
    shell.visible = true; glow.visible = true;
    shell.position.set(x, y, z); glow.position.set(x, y, z);
    shell.scale.setScalar(r); glow.scale.setScalar(r * 0.98);
    var pulse = _reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(elapsed * freq);
    var op = Math.max(0.03, baseOp - r * 0.00004 + pulse * 0.03);
    shell.material.opacity = op;
    glow.material.opacity = Math.max(0.01, op * 0.25);
  }
  function updateDynEntry(entry, ev, simElapsed) {
    var isMain = !!ev.isMainshock;
    var p = project(ev.lat, ev.lng);
    var depth = ev.depth || 30;
    if (isMain !== entry.coneIsMain) {
      entry.cone.geometry.dispose();
      entry.cone.geometry = new THREE.ConeGeometry(isMain ? 14 : 8, isMain ? 40 : 24, 12);
      entry.cone.material.color.setHex(isMain ? 0xff3030 : 0xff8855);
      entry.coneIsMain = isMain;
    }
    entry.cone.position.set(p.x, 20, p.z);
    var sp = entry.stemGeo.attributes.position.array;
    sp[0] = p.x; sp[1] = 0; sp[2] = p.z; sp[3] = p.x; sp[4] = -depth; sp[5] = p.z;
    entry.stemGeo.attributes.position.needsUpdate = true;
    entry.stem.visible = depth > 1;
    var hR = isMain ? 18 : 10;
    entry.hypo.position.set(p.x, -depth, p.z);
    entry.hypo.scale.setScalar(hR);
    entry.hypo.material.opacity = _reducedMotion ? 0.9 : 0.85 + 0.1 * Math.sin(simElapsed * 5);
    entry.glow.position.copy(entry.hypo.position);
    entry.glow.scale.setScalar(hR * 2.2);
    entry.glow.material.opacity = _reducedMotion ? 0.16 : 0.12 + 0.08 * Math.sin(simElapsed * 5);
    setShell(entry.pShell, entry.pGlow, p.x, -depth, p.z, ev.pTravel, 0.13, simElapsed, 4);
    setShell(entry.sShell, entry.sGlow, p.x, -depth, p.z, ev.sTravel, 0.16, simElapsed, 3.5);
  }
  function rebuildDynamics(data) {
    var events = (data.events && data.events.length) ? data.events
      : (data.epicenter ? [{id: 'idle', lat: data.epicenter.lat, lng: data.epicenter.lng, depth: 0, isMainshock: false, pTravel: 0, sTravel: 0}] : []);
    var seen = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev || ev.lat == null) continue;
      var key = dynKey(ev);
      seen[key] = true;
      if (!_dynCache[key]) _dynCache[key] = buildDynEntry(ev);
      updateDynEntry(_dynCache[key], ev, data.simElapsed);
    }
    Object.keys(_dynCache).forEach(function(k) {
      if (!seen[k]) { disposeDynEntry(_dynCache[k]); delete _dynCache[k]; }
    });
  }

  // --- Main update entrypoint ---
  function update(data) {
    if (!initialized) return;
    _data = data || _data;
    requestRender();
    rebuildDynamics(_data);
    rebuildFaults(_data);
    rebuildMechanisms(_data);
    updateStations(_data.stations);
    updateFocusTarget(_data);
  }

  // Determine the orbit center: the mainshock hypocenter (projected to its
  // depth), else the epicenter on the surface.
  function updateFocusTarget(data) {
    var fx = null, fy = -40, fz = null;
    var events = data.events || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev && ev.lat != null && ev.isMainshock) {
        var p = project(ev.lat, ev.lng);
        fx = p.x; fz = p.z; fy = -(ev.depth || 30);
        break;
      }
    }
    if (fx === null && events.length && events[0] && events[0].lat != null) {
      var ev0 = events[0];
      var p0 = project(ev0.lat, ev0.lng);
      fx = p0.x; fz = p0.z; fy = -(ev0.depth || 30);
    }
    if (fx === null && data.epicenter) {
      var pe = project(data.epicenter.lat, data.epicenter.lng);
      fx = pe.x; fz = pe.z; fy = 0;
    }
    if (fx !== null) {
      _focusTarget.set(fx, fy, fz);
      _focusActive = true;
    }
  }

  // Each frame, smoothly move the orbit target's horizontal position toward the
  // focus point, keeping the camera's relative offset so the view doesn't jump
  // when the center moves. Vertical (depth) target is left to setViewAngle /
  // resetView so manual view choices aren't fought.
  function tickFocusTarget() {
    if (!_focusActive || !controls) return;
    var cur = controls.target;
    var dx = _focusTarget.x - cur.x, dz = _focusTarget.z - cur.z;
    if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return;
    var k = _reducedMotion ? 1 : 0.12; // reduced motion jumps to the target
    var nx = cur.x + dx * k, nz = cur.z + dz * k;
    camera.position.x += (nx - cur.x);
    camera.position.z += (nz - cur.z);
    cur.x = nx; cur.z = nz;
    if (controls.resync) controls.resync();
    requestRender();
  }

  function setGeo(g) {
    if (g.coastline) { _geo.coastline = g.coastline; if (initialized) buildCoastlines(g.coastline); }
    if (g.plates) { _geo.plates = g.plates; if (initialized) buildPlates(g.plates); }
    if (g.bathy) { _geo.bathy = g.bathy; if (initialized) buildTerrain(g.bathy); }
  }
  function loadBathymetry(bathy) { setGeo({bathy: bathy}); }

  function setMode() {} // no-op (single unified scene now)

  function resetView() {
    if (!camera || !controls) return;
    var t = _focusActive ? _focusTarget : new THREE.Vector3(0, -40, 0);
    // Place the camera at an oblique offset relative to the focus center.
    camera.position.set(t.x + 1500, 1300, t.z + 1500);
    controls.target.copy(t);
    if (controls.resync) controls.resync();
    requestRender();
  }
  function setViewAngle(a) {
    if (!camera || !controls) return;
    var c = _focusActive ? _focusTarget : new THREE.Vector3(0, -40, 0);
    var off, depthOff;
    if (a === 'top') { off = [0, 3500, 0.1]; depthOff = 0; }
    else if (a === 'side') { off = [3200, 300, 0]; depthOff = -10; }
    else if (a === 'below') { off = [0, -1800, 0.1]; depthOff = -80; }
    else if (a === 'front') { off = [0, 400, 3200]; depthOff = -10; }
    else { off = [1500, 1300, 1500]; depthOff = 0; } // oblique
    controls.target.set(c.x, c.y + depthOff, c.z);
    camera.position.set(c.x + off[0], off[1], c.z + off[2]);
    if (controls.resync) controls.resync();
    requestRender();
  }

  function resize() {
    if (!canvas3d || !renderer || !camera) return;
    var W = canvas3d.clientWidth, H = canvas3d.clientHeight;
    if (W < 10 || H < 10) return;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
    canvas3d.style.width = ''; // keep CSS width:100% in control
    requestRender();
  }

  function renderScene() {
    if (!initialized || !_visible || !renderer || !scene || !camera) return;
    tickFocusTarget();
    controls.update();
    renderer.render(scene, camera);
    _needsRender = false;
  }
  function animate() {
    animId = null;
    if (_reducedMotion) return;
    renderScene();
    if (initialized && !_reducedMotion) animId = requestAnimationFrame(animate);
  }
  function startAnimation() {
    if (!initialized) return;
    if (_reducedMotion) { requestRender(); return; }
    if (!animId) animId = requestAnimationFrame(animate);
  }
  function requestRender() {
    _needsRender = true;
    if (!initialized || !_reducedMotion || animId) return;
    animId = requestAnimationFrame(function() {
      animId = null;
      if (_needsRender) renderScene();
    });
  }
  function handleMotionPreference(e) {
    _reducedMotion = !!e.matches;
    if (controls) controls.enableDamping = !_reducedMotion;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (_reducedMotion) requestRender();
    else startAnimation();
  }

  if (_motionMedia) {
    if (_motionMedia.addEventListener) _motionMedia.addEventListener('change', handleMotionPreference);
    else if (_motionMedia.addListener) _motionMedia.addListener(handleMotionPreference);
  }

  return {
    init: init,
    update: update,
    setMode: setMode,
    resize: resize,
    resetView: resetView,
    setViewAngle: setViewAngle,
    setGeo: setGeo,
    loadBathymetry: loadBathymetry,
    getDiagnostics: function() {
      return {
        initialized: initialized,
        visible: _visible,
        reducedMotion: _reducedMotion,
        continuousAnimation: !!animId && !_reducedMotion
      };
    }
  };
})();
