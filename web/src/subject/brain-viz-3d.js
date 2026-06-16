/**
 * brain-viz-3d.js — Three.js CCF 3D brain viewer for the subject details panel.
 *
 * Renders:
 *   - Transparent grey brain surface (997.obj from Allen CCF v1.2)
 *   - Fiber probe cylinders at BREGMA_ARID coordinates
 *   - Semi-transparent target structure meshes, colored by CCF atlas palette
 *
 * Three.js is loaded dynamically from CDN to avoid adding it to the npm bundle.
 *
 * Coordinate system (three.js, origin = Bregma, units = mm):
 *   x = ML  (right = positive)
 *   y = DV  (dorsal = positive, i.e. inverted from CCF)
 *   z = AP  (anterior = positive)
 *
 * BREGMA_ARID transform → three.js:
 *   three.x = ML,   three.y = -Depth,   three.z = AP
 *
 * CCF → three.js (µm → mm):
 *   x = (ccf_ML  - 5700) / 1000
 *   y = (332     - ccf_DV) / 1000
 *   z = (5400    - ccf_AP) / 1000
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import structuresData from './allen_mouse_100um_v1.2/structures.json';
import surfaceDepthData from './allen_mouse_100um_v1.2/surface_depth.json';
import { parseTranslation } from '../lib/coord-systems.js';
import { ITEM_COLORS } from './brain-viz.js';
import { createOrbitControls } from '../lib/orbit-controls.js';

// ── Surface depth lookup ──────────────────────────────────────────────────
// surface_depth.json: depth_um[AP_idx][ML_idx] = DV µm of first brain voxel
// Bregma voxel: AP=5400µm→idx54, ML=5700µm→idx57; resolution=100µm
const _SURF_RES = surfaceDepthData.resolution_um;  // 100
const _SURF_MAP = surfaceDepthData.depth_um;

/**
 * Return the three.js Y coordinate of the brain surface for a probe at
 * (AP_mm, ML_mm) in BREGMA_ARID space (origin = bregma, anterior/right positive).
 * Returns null if outside the atlas volume.
 */
export function surfaceY(AP_mm, ML_mm) {
  // CCF µm: AP = 5400 - AP_mm*1000 (anterior → smaller CCF AP)
  //         ML = 5700 - ML_mm*1000 (right-positive ML_mm; atlas axis-2 is Right→Left so right = smaller CCF ML)
  const ccfAP = 5400 - AP_mm * 1000;
  const ccfML = 5700 - ML_mm * 1000;
  const apIdx = Math.round(ccfAP / _SURF_RES);
  const mlIdx = Math.round(ccfML / _SURF_RES);
  const row = _SURF_MAP[apIdx];
  if (!row) return null;
  const surfDV = row[mlIdx];
  if (surfDV == null) return null;
  // three.js Y uses same CCF transform as mesh vertices: (332 - ccfDV) / 1000
  return (332 - surfDV) / 1000;
}

// ── Structure colour lookup (id → [r, g, b]) ──────────────────────────────
export const STRUCTURE_COLORS = Object.fromEntries(
  structuresData.map(s => [String(s.id), s.rgb_triplet]).filter(([, v]) => v),
);

/** Convert a CSS hex color string like '#FF6B6B' to a three.js hex number. */
export function cssHexToThree(cssHex) {
  return parseInt(cssHex.replace('#', ''), 16);
}

// ── Physical CCF box centre in three.js coords ────────────────────────────
// CCF box: AP 0–13200, DV 0–8000, ML 0–11400 µm; Bregma at (5400, 332, 5700)
// Centre AP=6600 → z=(5400-6600)/1000=-1.2; DV=4000 → y=(332-4000)/1000≈-3.668; ML=5700 → x=0
export const TARGET_X = 0, TARGET_Y = -3.668, TARGET_Z = -1.2;

// ── CCF → three.js affine matrix (µm → mm, origin = Bregma) ─────────────
//  row-major: [ x_out = (ccf_z - 5700)/1000, y_out = (332 - ccf_y)/1000,
//               z_out = (5400 - ccf_x)/1000 ]
export function makeCCFMatrix(THREE) {
  return new THREE.Matrix4().set(
     0,        0,     1/1000, -5.7,
     0,    -1/1000,   0,       0.332,
    -1/1000,  0,      0,       5.4,
     0,        0,     0,       1,
  );
}

// ── Probe extraction ──────────────────────────────────────────────────────

/**
 * Extract all fiber probes from a Surgery procedure record.
 * Returns objects with { name, AP, ML, Depth, length, diameterMm, structureId, structureAcronym, structureName }.
 */
function extractProbes(surgeryData, proceduresCoordSys = null) {
  const probes = [];
  const coordSys = surgeryData?.coordinate_system ?? proceduresCoordSys;
  for (const proc of (surgeryData?.procedures ?? [])) {
    if (proc?.object_type !== 'Probe implant' || !proc.device_config) continue;
    const cfg     = proc.device_config;
    const implant = proc.implanted_device ?? {};

    // Use the most specific coordinate system available (surgery-level preferred over procedures-level)
    const translation = (cfg.transform ?? []).find(t => t?.object_type === 'Translation')?.translation ?? [];
    const { ap: AP, ml: ML, depth: Depth } = parseTranslation(coordSys, translation);

    let angle = 0;
    for (const t of cfg.transform ?? []) {
      if (t?.object_type === 'Rotation') {
        const r = t.angles ?? t.rotation ?? [];
        if (r.length >= 1) angle = Number(r[0]) || 0;
      }
    }

    const length     = Number(implant.total_length) || 5.0;      // mm
    const diameterMm = (Number(implant.core_diameter) || 200) / 1000; // µm → mm

    const structure = cfg.primary_targeted_structure ?? {};
    probes.push({
      name: cfg.device_name ?? 'Unknown',
      AP, ML, Depth: Depth ?? 0,
      angle,
      length,
      diameterMm,
      structureId:     String(structure.id ?? ''),
      structureAcronym: structure.acronym ?? '',
      structureName:   structure.name ?? '',
    });
  }
  return probes;
}

/** Return unique targeted structures (id, acronym, name) from a probe list. */
function uniqueStructures(probes) {
  const seen = new Set();
  return probes
    .filter(p => p.structureId && !seen.has(p.structureId) && seen.add(p.structureId))
    .map(p => ({ id: p.structureId, acronym: p.structureAcronym, name: p.structureName }));
}

/** Hex color for a probe based on its structure, or a default cyan. */
function probeHexColor(probe) {
  const rgb = STRUCTURE_COLORS[probe.structureId];
  if (!rgb) return 0x00ccff;
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Create a self-contained 3D CCF brain viewer element for a Surgery event.
 *
 * @param {object} surgeryData - The raw Surgery `data` object from a timeline event.
 * @returns {HTMLElement}
 */
export function createBrainViz3D(surgeryData, proceduresCoordSys = null) {
  const container = document.createElement('div');
  container.className = 'brain-viz-3d-container';
  container.style.cssText =
    'position:relative;width:100%;height:600px;background:#fff;border-radius:4px;overflow:hidden';

  const statusEl = document.createElement('div');
  statusEl.style.cssText =
    'position:absolute;bottom:12px;left:12px;color:#444;font:11px monospace;' +
    'pointer-events:none;z-index:10;line-height:1.6';
  statusEl.textContent = 'Loading 3D brain…';
  container.appendChild(statusEl);

  const infoEl = document.createElement('div');
  infoEl.style.cssText =
    'position:absolute;top:12px;right:12px;color:#333;font:11px monospace;' +
    'pointer-events:none;z-index:10;text-align:right;line-height:1.6';
  container.appendChild(infoEl);

  _init3D(container, statusEl, infoEl, surgeryData, proceduresCoordSys).catch((err) => {
    statusEl.textContent = '3D viewer failed: ' + (err.message ?? err);
    console.error('[BrainViz3D]', err);
  });

  return container;
}

// ── Internal initialiser ─────────────────────────────────────────────────

async function _init3D(container, statusEl, infoEl, surgeryData, proceduresCoordSys) {
  const CCF_MATRIX = makeCCFMatrix(THREE);

  // ── Scene ──────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  // ── Camera ────────────────────────────────────────────────────────────
  const w = container.clientWidth  || 600;
  const h = container.clientHeight || 600;
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 300);
  camera.position.set(TARGET_X, TARGET_Y + 22, TARGET_Z);
  camera.up.set(0, 0, 1);
  camera.lookAt(TARGET_X, TARGET_Y, TARGET_Z);

  // ── Renderer ──────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0xffffff, 1);
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  // ── Lights ────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 0.75);
  key.position.set(4, 12, 14);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdde0ff, 0.3);
  fill.position.set(-8, -4, -8);
  scene.add(fill);

  // ── Bregma marker ─────────────────────────────────────────────────────
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xaaa39f }), // RGB 170/163/159
  ));

  // ── Fiber probes (colored by index to match 2D brain-viz) ────────────────
  const probes = extractProbes(surgeryData, proceduresCoordSys);
  _buildProbes(THREE, scene, probes);

  // ── Legend ────────────────────────────────────────────────────
  const legendLines = probes.map((p, i) => {
    const cssHex = ITEM_COLORS[i % ITEM_COLORS.length];
    return `<span style="color:${cssHex}">■</span> ${p.name} → ${p.structureName || p.structureAcronym || 'unknown'}`;
  });
  legendLines.push('<span style="color:#aaa39f">●</span> Bregma');
  infoEl.innerHTML = legendLines.join('<br>');

  // ── Brain surface (997.obj) ───────────────────────────────────────────
  const brainMat = new THREE.MeshPhongMaterial({
    color: 0x737373, // RGB 115/115/115
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
    depthWrite: false,
    shininess: 20,
  });

  const loader = new OBJLoader();
  const meshBase = 'https://allen-data-views.s3.amazonaws.com/data-asset-cache/meshes/';

  // Load brain surface
  _loadOBJ(loader, meshBase + '997.obj', (group) => {
    group.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.applyMatrix4(CCF_MATRIX);
      child.material = brainMat;
      child.renderOrder = 1;
    });
    scene.add(group);
    statusEl.textContent = 'Drag to rotate · Scroll to zoom';
  });

  // ── Structure meshes ──────────────────────────────────────────────────
  for (const struct of uniqueStructures(probes)) {
    if (!struct.id) continue;
    const rgb = STRUCTURE_COLORS[struct.id];
    if (!rgb) continue;
    const color = new THREE.Color(rgb[0]/255, rgb[1]/255, rgb[2]/255);
    const mat = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity: 0.40,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 30,
    });
    _loadOBJ(loader, meshBase + struct.id + '.obj', (group) => {
      group.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.applyMatrix4(CCF_MATRIX);
        child.material = mat;
        child.renderOrder = 2;
      });
      scene.add(group);
    });
  }

  // ── Camera orbit controls ─────────────────────────────────────────────
  const TARGET_V = new THREE.Vector3(TARGET_X, TARGET_Y, TARGET_Z);
  const initCamUp = camera.up.clone();
  createOrbitControls(camera, TARGET_V, initCamUp, renderer.domElement, {
    rotateSpeed: 0.007,
  });

  // ── Resize ────────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth;
    const nh = container.clientHeight;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
  });
  ro.observe(container);

  // ── Render loop ───────────────────────────────────────────────────────
  let alive = true;
  (function animate() {
    if (!alive) return;
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  })();

  // Clean up when container is removed from DOM
  const mo = new MutationObserver(() => {
    if (!document.contains(container)) {
      alive = false;
      ro.disconnect();
      mo.disconnect();
      renderer.dispose();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// ── Geometry helpers ─────────────────────────────────────────────────────

function _buildProbes(THREE, scene, probes) {
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    const { AP, ML, Depth, angle, length, diameterMm } = probe;
    const color = cssHexToThree(ITEM_COLORS[i % ITEM_COLORS.length]);
    const radius = diameterMm / 2;

    // Negate ML so right hemisphere is on screen-right (camera looks from above, screen-right = -X world)
    const threeX = -ML;
    const threeZ = AP;

    // Cylinder runs from brain surface (top) down to tip.
    const sY = surfaceY(AP, ML);
    const topY = sY !== null ? sY : 0;
    const tipY = topY - Depth;

    // Pivot group at the probe tip — rotation around Z (AP axis) tilts the probe in the ML-DV plane.
    // Right-hand rule: positive angle rotates the probe base toward -X (= +ML, right hemisphere).
    const pivot = new THREE.Group();
    pivot.position.set(threeX, tipY, threeZ);
    pivot.rotation.z = (angle ?? 0) * Math.PI / 180;

    // Cylinder: centered at (0, length/2, 0) in pivot space so its base is at the tip
    const geo = new THREE.CylinderGeometry(radius, radius, length, 12, 1);
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.9, shininess: 40 });
    const cylMesh = new THREE.Mesh(geo, mat);
    cylMesh.position.set(0, length / 2, 0);
    pivot.add(cylMesh);

    // Tip sphere at pivot origin (= probe tip)
    const tipMesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.3, 10, 10),
      new THREE.MeshPhongMaterial({ color, shininess: 60 }),
    );
    pivot.add(tipMesh);

    scene.add(pivot);
  }
}

function _loadOBJ(loader, url, onLoad) {
  loader.load(url, onLoad, undefined, (err) => {
    // Silently skip missing mesh files (not all structures may have meshes)
    console.warn('[BrainViz3D] Could not load mesh:', url, err?.message ?? err);
  });
}

/** Load a brain OBJ mesh from the CDN, silently ignoring missing files. */
export function loadBrainMesh(loader, url, onLoad) {
  return _loadOBJ(loader, url, onLoad);
}
