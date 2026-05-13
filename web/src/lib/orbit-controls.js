/**
 * orbit-controls.js — Simple mouse/touch orbit camera controller.
 *
 * Accumulates pitch and roll angles separately, then reconstructs the
 * quaternion each frame. This ensures clean, predictable rotation with no
 * gimbal lock or axis coupling.
 */

import * as THREE from 'three';

/**
 * Create and attach an orbit camera controller.
 *
 * @param {THREE.Camera} camera - The camera to control.
 * @param {THREE.Vector3} target - The world point to orbit around.
 * @param {THREE.Vector3} initCamUp - The initial camera up vector.
 * @param {HTMLElement} domElement - The renderer DOM element.
 * @param {object} options - Configuration options.
 *   - rotateSpeed: rotation speed factor (default 0.007)
 *   - zoomSpeed: zoom speed factor (default 0.03)
 *   - minRadius: minimum camera distance (default 3)
 *   - maxRadius: maximum camera distance (default 80)
 * @returns {object} Controller object with no public methods (manages itself).
 */
export function createOrbitControls(camera, target, initCamUp, domElement, options = {}) {
  const ROTATE_SPEED = options.rotateSpeed ?? 0.007;
  const ZOOM_SPEED = options.zoomSpeed ?? 0.03;
  const MIN_RADIUS = options.minRadius ?? 3;
  const MAX_RADIUS = options.maxRadius ?? 80;

  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);

  const initCamDir = camera.position.clone().sub(target).normalize();
  let camRadius = camera.position.distanceTo(target);

  let totalPitch = 0, totalRoll = 0;
  let dragging = false, sx = 0, sy = 0;

  function updateCamera() {
    const qRoll = new THREE.Quaternion().setFromAxisAngle(axisZ, totalRoll);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(axisX, totalPitch);
    const totalQ = new THREE.Quaternion().multiplyQuaternions(qRoll, qPitch);

    camera.position.copy(target).addScaledVector(initCamDir.clone().applyQuaternion(totalQ), camRadius);
    camera.up.copy(initCamUp).applyQuaternion(totalQ);
    camera.lookAt(target);
  }

  function startDrag(x, y) {
    dragging = true;
    sx = x;
    sy = y;
  }

  function stopDrag() {
    dragging = false;
  }

  function doDrag(x, y) {
    if (!dragging) return;
    totalPitch += (y - sy) * ROTATE_SPEED;
    totalRoll -= (x - sx) * ROTATE_SPEED;
    sx = x;
    sy = y;
    updateCamera();
  }

  function doZoom(delta) {
    camRadius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, camRadius + delta * ZOOM_SPEED));
    updateCamera();
  }

  // Mouse events
  domElement.addEventListener('mousedown', (e) => startDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('mousemove', (e) => doDrag(e.clientX, e.clientY));

  // Touch events
  domElement.addEventListener(
    'touchstart',
    (e) => {
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: true },
  );
  window.addEventListener('touchend', stopDrag);
  window.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      doDrag(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: false },
  );

  // Wheel zoom
  domElement.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      doZoom(e.deltaY);
    },
    { passive: false },
  );

  return {
    updateCamera,
    dispose: () => {
      // Clean up listeners if needed
    },
  };
}
