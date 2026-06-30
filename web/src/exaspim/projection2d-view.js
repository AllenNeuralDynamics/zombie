/**
 * exaspim/projection2d-view.js — Three.js renderer for the 2D morphology
 * projection view.
 *
 * A "dumb" 2D line renderer: it takes pre-projected screen-space line segments
 * (built by `projection2d.js`) and draws them with an orthographic camera.
 * Pan = drag, zoom = wheel. The plane choice and geometry projection live in
 * the integrator (morphology.js); this view only knows about 2D segments.
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * @returns {{
 *   el: HTMLElement,
 *   render: (items: Array<{positions: Float32Array, color: string, opacity?: number}>) => void,
 *   frameBounds: (b: {minX:number,minY:number,maxX:number,maxY:number}) => void,
 *   setStatus: (text: string) => void,
 *   resize: () => void,
 *   dispose: () => void,
 * }}
 */
export function createProjection2DView() {
  const el = document.createElement('div');
  el.className = 'morph-2d';

  const status = document.createElement('div');
  status.className = 'morph-2d-status';
  el.appendChild(status);

  const scene = new THREE.Scene();

  function syncBackground() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--surface-bg').trim();
    scene.background = new THREE.Color(raw || '#f3f4f5');
  }
  syncBackground();

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.z = 10;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  el.appendChild(renderer.domElement);

  // View state: world centre (µm) + units-per-pixel (zoom).
  let cx = 0;
  let cy = 0;
  let upp = 20; // µm per CSS pixel
  let width = 1;
  let height = 1;

  const lineObjs = [];
  const fatMaterials = []; // LineMaterials needing a `resolution` on resize.

  function applyCamera() {
    const hw = (width / 2) * upp;
    const hh = (height / 2) * upp;
    camera.left = cx - hw;
    camera.right = cx + hw;
    camera.top = cy + hh;
    camera.bottom = cy - hh;
    camera.updateProjectionMatrix();
  }

  let raf = null;
  function requestRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; renderer.render(scene, camera); });
  }

  function resize() {
    width = el.clientWidth || 600;
    height = el.clientHeight || 500;
    renderer.setSize(width, height);
    for (const m of fatMaterials) m.resolution.set(width, height);
    applyCamera();
    requestRender();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  function clearLines() {
    for (const o of lineObjs) {
      scene.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    lineObjs.length = 0;
    fatMaterials.length = 0;
  }

  function render(items) {
    syncBackground();
    clearLines();
    for (const it of items) {
      if (!it.positions || it.positions.length === 0) continue;
      const color = new THREE.Color(it.color || '#000000');
      const transparent = it.opacity != null && it.opacity < 1;
      const opacity = it.opacity ?? 1;
      const lw = it.lineWidth ?? 1;
      if (lw > 1) {
        // Fat lines (LineSegments2): the only way to get >1px strokes in WebGL.
        const g = new LineSegmentsGeometry();
        g.setPositions(it.positions);
        const m = new LineMaterial({ color, transparent, opacity, linewidth: lw, worldUnits: false });
        m.resolution.set(width, height);
        const seg = new LineSegments2(g, m);
        scene.add(seg);
        lineObjs.push(seg);
        fatMaterials.push(m);
      } else {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(it.positions, 3));
        const m = new THREE.LineBasicMaterial({ color, transparent, opacity });
        const seg = new THREE.LineSegments(g, m);
        scene.add(seg);
        lineObjs.push(seg);
      }
    }
    requestRender();
  }

  function frameBounds(b) {
    if (!b) return;
    // Re-measure: framing may be requested right after the view becomes
    // visible, before the ResizeObserver has reported a real size.
    width = el.clientWidth || width;
    height = el.clientHeight || height;
    renderer.setSize(width, height);
    for (const m of fatMaterials) m.resolution.set(width, height);
    cx = (b.minX + b.maxX) / 2;
    cy = (b.minY + b.maxY) / 2;
    const spanX = (b.maxX - b.minX) || 1;
    const spanY = (b.maxY - b.minY) || 1;
    const margin = 1.08;
    upp = Math.max(spanX / Math.max(width, 1), spanY / Math.max(height, 1)) * margin;
    applyCamera();
    requestRender();
  }

  function setStatus(text) {
    status.textContent = text || '';
    status.style.display = text ? '' : 'none';
  }

  // ── Pan / zoom ────────────────────────────────────────────────────────────
  const dom = renderer.domElement;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  dom.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
    dom.classList.add('is-grabbing');
  });
  dom.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    cx -= dx * upp;
    cy += dy * upp;
    applyCamera();
    requestRender();
  });
  const endDrag = () => { dragging = false; dom.classList.remove('is-grabbing'); };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointercancel', endDrag);
  dom.addEventListener('pointerleave', endDrag);

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = dom.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // World point under cursor (keep it fixed across the zoom).
    const wx = cx + (mx - width / 2) * upp;
    const wy = cy + (height / 2 - my) * upp;
    const factor = Math.exp(e.deltaY * 0.0012);
    upp = Math.min(200, Math.max(0.2, upp * factor));
    cx = wx - (mx - width / 2) * upp;
    cy = wy - (height / 2 - my) * upp;
    applyCamera();
    requestRender();
  }, { passive: false });

  // First layout once attached to the DOM.
  requestAnimationFrame(resize);

  return {
    el,
    render,
    frameBounds,
    setStatus,
    resize,
    dispose() {
      ro.disconnect();
      clearLines();
      renderer.dispose();
    },
  };
}
