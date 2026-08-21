// Simplified OrbitControls for Three.js (no ESM dependency)
// Supports: mouse drag rotation, scroll zoom, touch pinch
(function() {
  if (typeof THREE === 'undefined') return;

  THREE.OrbitControls = function(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.target = new THREE.Vector3(0, 0, 0);
    this.enableDamping = true;
    this.dampingFactor = 0.08;
    this.rotateSpeed = 0.8;
    this.zoomSpeed = 1.2;
    this.minDistance = 20;
    this.maxDistance = 500;
    this.minPolarAngle = 0.1;
    this.maxPolarAngle = Math.PI - 0.1;

    var scope = this;
    var spherical = new THREE.Spherical();
    var sphericalDelta = new THREE.Spherical();
    var scale = 1;
    var isDragging = false;
    var prevMouse = {x: 0, y: 0};

    // Initialize spherical from camera position
    var offset = new THREE.Vector3().copy(camera.position).sub(this.target);
    spherical.setFromVector3(offset);

    function onMouseDown(e) {
      if (e.button !== 0 && e.button !== 2) return;
      isDragging = true;
      prevMouse.x = e.clientX;
      prevMouse.y = e.clientY;
      e.preventDefault();
    }
    function onMouseMove(e) {
      if (!isDragging) return;
      var dx = e.clientX - prevMouse.x;
      var dy = e.clientY - prevMouse.y;
      prevMouse.x = e.clientX;
      prevMouse.y = e.clientY;
      sphericalDelta.theta -= dx * scope.rotateSpeed * 0.01;
      sphericalDelta.phi -= dy * scope.rotateSpeed * 0.01;
    }
    function onMouseUp() { isDragging = false; }
    function onWheel(e) {
      e.preventDefault();
      if (e.deltaY > 0) scale *= (1 + scope.zoomSpeed * 0.1);
      else scale *= (1 - scope.zoomSpeed * 0.1);
      scale = Math.max(0.1, Math.min(10, scale));
    }

    // Touch support
    var touchStart = {x:0, y:0, dist:0};
    function onTouchStart(e) {
      if (e.touches.length === 1) {
        isDragging = true;
        prevMouse.x = e.touches[0].clientX;
        prevMouse.y = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        var dx = e.touches[1].clientX - e.touches[0].clientX;
        var dy = e.touches[1].clientY - e.touches[0].clientY;
        touchStart.dist = Math.sqrt(dx*dx + dy*dy);
      }
      e.preventDefault();
    }
    function onTouchMove(e) {
      if (e.touches.length === 1 && isDragging) {
        var dx = e.touches[0].clientX - prevMouse.x;
        var dy = e.touches[0].clientY - prevMouse.y;
        prevMouse.x = e.touches[0].clientX;
        prevMouse.y = e.touches[0].clientY;
        sphericalDelta.theta -= dx * scope.rotateSpeed * 0.01;
        sphericalDelta.phi -= dy * scope.rotateSpeed * 0.01;
      } else if (e.touches.length === 2) {
        var dx2 = e.touches[1].clientX - e.touches[0].clientX;
        var dy2 = e.touches[1].clientY - e.touches[0].clientY;
        var dist = Math.sqrt(dx2*dx2 + dy2*dy2);
        if (touchStart.dist > 0) {
          scale *= touchStart.dist / dist;
          scale = Math.max(0.1, Math.min(10, scale));
        }
        touchStart.dist = dist;
      }
      e.preventDefault();
    }
    function onTouchEnd() { isDragging = false; touchStart.dist = 0; }
    function onContextMenu(e) { e.preventDefault(); }

    domElement.addEventListener('mousedown', onMouseDown);
    domElement.addEventListener('mousemove', onMouseMove);
    domElement.addEventListener('mouseup', onMouseUp);
    domElement.addEventListener('mouseleave', onMouseUp);
    domElement.addEventListener('wheel', onWheel, {passive: false});
    domElement.addEventListener('touchstart', onTouchStart, {passive: false});
    domElement.addEventListener('touchmove', onTouchMove, {passive: false});
    domElement.addEventListener('touchend', onTouchEnd);
    domElement.addEventListener('contextmenu', onContextMenu);

    this.update = function() {
      // Apply damping
      spherical.theta += sphericalDelta.theta * (scope.enableDamping ? scope.dampingFactor : 1);
      spherical.phi += sphericalDelta.phi * (scope.enableDamping ? scope.dampingFactor : 1);
      // Clamp polar angle
      spherical.phi = Math.max(scope.minPolarAngle, Math.min(scope.maxPolarAngle, spherical.phi));
      // Apply zoom
      spherical.radius *= scale;
      spherical.radius = Math.max(scope.minDistance, Math.min(scope.maxDistance, spherical.radius));
      scale = 1;
      // Dampen delta
      if (scope.enableDamping) {
        sphericalDelta.theta *= (1 - scope.dampingFactor);
        sphericalDelta.phi *= (1 - scope.dampingFactor);
      } else {
        sphericalDelta.set(0, 0, 0);
      }
      // Update camera
      offset.setFromSpherical(spherical);
      camera.position.copy(scope.target).add(offset);
      camera.lookAt(scope.target);
    };

    // Re-derive internal spherical from the current camera position + target.
    // Call this after programmatically moving the camera (e.g. setViewAngle /
    // resetView), otherwise update() would snap it back to the old spherical.
    this.resync = function() {
      offset.copy(camera.position).sub(scope.target);
      spherical.setFromVector3(offset);
      sphericalDelta.set(0, 0, 0);
      scale = 1;
    };

    // Recompute the internal spherical from a desired camera position + target.
    // Used by Quake3D.setViewAngle so the controller does not overwrite the
    // programmatically set camera pose on the next update().
    this.setPose = function(targetPos, targetLook) {
      if (targetLook) scope.target.copy(targetLook);
      offset.copy(targetPos).sub(scope.target);
      spherical.setFromVector3(offset);
      sphericalDelta.set(0, 0, 0);
      scale = 1;
      camera.position.copy(scope.target).add(offset);
      camera.lookAt(scope.target);
    };

    this.dispose = function() {
      domElement.removeEventListener('mousedown', onMouseDown);
      domElement.removeEventListener('mousemove', onMouseMove);
      domElement.removeEventListener('mouseup', onMouseUp);
      domElement.removeEventListener('mouseleave', onMouseUp);
      domElement.removeEventListener('wheel', onWheel);
      domElement.removeEventListener('touchstart', onTouchStart);
      domElement.removeEventListener('touchmove', onTouchMove);
      domElement.removeEventListener('touchend', onTouchEnd);
      domElement.removeEventListener('contextmenu', onContextMenu);
    };
  };
})();
