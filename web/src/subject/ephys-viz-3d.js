/**
 * ephys-viz-3d.js — Three.js CCF 3D brain viewer for ephys assembly configs.
 *
 * Renders:
 *   - Transparent grey brain surface (997.obj from Allen CCF v1.2)
 *   - Ephys probe cylinders (70 µm diameter) positioned and oriented via their
 *     transform chains from acquisition.data_streams[*].configurations
 *   - Semi-transparent target structure meshes, colored by CCF atlas palette
 *
 * Coordinate conventions match brain-viz-3d.js (three.js origin = Bregma, mm):
 *   x = ML  (right = positive)
 *   y = DV  (dorsal = positive)
 *   z = AP  (anterior = positive)
 *
 * Probe orientation: each probe starts vertical (tip at bregma, pointing in +Y).
 * The transform chain (Rotation/Translation objects) is applied sequentially using
 * extrinsic right-hand-rule rotations (world axes). Translations are in mm.
 * The PROBE_RUFD coordinate system (X=ML, Y=DV, Z=AP) maps directly to three.js.
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  STRUCTURE_COLORS,
  TARGET_X, TARGET_Y, TARGET_Z,
  makeCCFMatrix,
  cssHexToThree,
  surfaceY,
  loadBrainMesh,
} from './brain-viz-3d.js';
import { ITEM_COLORS } from './brain-viz.js';
import { parseTranslation, computeProbeDirection } from '../lib/coord-systems.js';

// Probe cylinder diameter: 70 µm = 0.07 mm
const PROBE_DIAMETER_MM = 0.07;
const PROBE_RADIUS_MM   = PROBE_DIAMETER_MM / 2;

// Default probe length drawn above the tip (mm).  Long enough to be visible.
const PROBE_LENGTH_MM = 10;

// CDN base for OBJ meshes
const MESH_BASE = 'https://allen-data-views.s3.amazonaws.com/data-asset-cache/meshes/';

// ── Probe extraction ──────────────────────────────────────────────────────

/**
 * Extract all ephys probes from an acquisition data object.
 * Only processes the first data stream that has an "Ephys assembly config"
 * to avoid showing the same probe twice (some acquisitions have a
 * "surface finding" stream that duplicates the recording stream configs).
 *
 * @param {object} acquisitionData - The raw acquisition object.
 * @returns {Array<object>} Probe info objects.
 */
export function extractEphysProbes(acquisitionData) {
  const probes = [];

  for (const stream of (acquisitionData?.data_streams ?? [])) {
    const cfgs = (stream?.configurations ?? []).filter(
      (c) => c?.object_type === 'Ephys assembly config',
    );
    if (!cfgs.length) continue;

    for (const cfg of cfgs) {
      for (const probe of (cfg?.probes ?? [])) {
        const coordSys  = probe?.coordinate_system ?? null;
        const transforms = probe?.transform ?? [];

        // Last translation in the chain gives the tip position in PROBE_RUFD coords.
        // PROBE_RUFD: X=Left_to_right (ML), Y=Down_to_up (DV), Z=Back_to_front (AP), [3]=depth.
        const allTranslations = transforms.filter((t) => t?.object_type === 'Translation');
        const lastTranslation = allTranslations.at(-1) ?? null;
        const { ap, ml, depth } = parseTranslation(coordSys, lastTranslation?.translation ?? []);

        // Probe direction from cumulative rotations.
        const probeDir = computeProbeDirection(transforms);

        // Targeted structures
        const primary = probe?.primary_targeted_structure ?? null;
        const others  = [].concat(probe?.other_targeted_structure ?? []).filter(Boolean);
        const structureIds = [
          primary?.id != null ? String(primary.id) : null,
          ...others.map((s) => (s?.id != null ? String(s.id) : null)),
        ].filter(Boolean);

        probes.push({
          name:            probe?.device_name ?? cfg?.device_name ?? 'Unknown',
          dye:             probe?.dye ?? null,
          notes:           probe?.notes ?? null,
          ap,
          ml,
          depth:           depth ?? 0,
          probeDir,
          modules:         cfg?.modules ?? [],
          primaryStructure: primary,
          otherStructures:  others,
          structureIds,
        });
      }
    }

    // Only use the first stream that has ephys configs (skip duplicated surface-finding stream)
    if (probes.length) break;
  }

  return probes;
}

/** Return unique targeted structures (id, name) across all probes. */
function _uniqueStructures(probes) {
  const seen = new Set();
  const out  = [];
  for (const p of probes) {
    for (const id of p.structureIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const struct =
        (id === String(p.primaryStructure?.id) ? p.primaryStructure : null) ??
        p.otherStructures.find((s) => String(s.id) === id) ??
        null;
      if (struct) out.push({ id, acronym: struct.acronym ?? '', name: struct.name ?? '' });
    }
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a self-contained 3D CCF brain viewer for an acquisition's ephys assemblies.
 *
 * @param {object} acquisitionData - The raw acquisition object.
 * @returns {HTMLElement}
 */
export function createEphysViz3D(acquisitionData) {
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

  _initEphys3D(container, statusEl, infoEl, acquisitionData).catch((err) => {
    statusEl.textContent = '3D viewer failed: ' + (err.message ?? err);
    console.error('[EphysViz3D]', err);
  });

  return container;
}

// ── Internal initialiser ──────────────────────────────────────────────────

async function _initEphys3D(container, statusEl, infoEl, acquisitionData) {
  const CCF_MATRIX = makeCCFMatrix(THREE);

  // ── Scene ────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  // ── Camera ──────────────────────────────────────────────────────────────
  const w = container.clientWidth  || 600;
  const h = container.clientHeight || 600;
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 300);
  camera.position.set(TARGET_X, TARGET_Y + 22, TARGET_Z);
  camera.up.set(0, 0, 1);
  camera.lookAt(TARGET_X, TARGET_Y, TARGET_Z);

  // ── Renderer ────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0xffffff, 1);
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  // ── Lights ──────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 0.75);
  key.position.set(4, 12, 14);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdde0ff, 0.3);
  fill.position.set(-8, -4, -8);
  scene.add(fill);

  // ── Bregma marker ───────────────────────────────────────────────────────
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xaaa39f }),
  ));

  // ── Ephys probes ─────────────────────────────────────────────────────────
  const probes = extractEphysProbes(acquisitionData);
  _buildEphysProbes(THREE, scene, probes);

  // ── Legend ───────────────────────────────────────────────────────────────
  const legendLines = probes.map((p, i) => {
    const css = ITEM_COLORS[i % ITEM_COLORS.length];
    const target = p.primaryStructure
      ? `${p.primaryStructure.name} (${p.primaryStructure.acronym})`
      : 'Unknown';
    return `<span style="color:${css}">■</span> ${p.name} → ${target}`;
  });
  legendLines.push('<span style="color:#aaa39f">●</span> Bregma');
  infoEl.innerHTML = legendLines.join('<br>');

  // ── Brain surface (997.obj) ─────────────────────────────────────────────
  const brainMat = new THREE.MeshPhongMaterial({
    color: 0x737373,
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
    depthWrite: false,
    shininess: 20,
  });

  const loader = new OBJLoader();

  loadBrainMesh(loader, MESH_BASE + '997.obj', (group) => {
    group.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.applyMatrix4(CCF_MATRIX);
      child.material = brainMat;
      child.renderOrder = 1;
    });
    scene.add(group);
    statusEl.textContent = 'Drag to rotate · Scroll to zoom';
  });

  // ── Structure meshes ────────────────────────────────────────────────────
  for (const struct of _uniqueStructures(probes)) {
    const rgb = STRUCTURE_COLORS[struct.id];
    if (!rgb) continue;
    const color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    const mat = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity: 0.40,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 30,
    });
    loadBrainMesh(loader, MESH_BASE + struct.id + '.obj', (group) => {
      group.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.applyMatrix4(CCF_MATRIX);
        child.material = mat;
        child.renderOrder = 2;
      });
      scene.add(group);
    });
  }

  // ── Camera orbit controls ────────────────────────────────────────────────
  const TARGET_V     = new THREE.Vector3(TARGET_X, TARGET_Y, TARGET_Z);
  const ROTATE_SPEED = 0.007;
  const axisZ = new THREE.Vector3(0, 0, 1);
  const axisX = new THREE.Vector3(1, 0, 0);

  let dragging = false;
  let startDragX = 0, startDragY = 0;
  const startCamOffset = new THREE.Vector3();
  const startCamUp    = new THREE.Vector3();

  function startDrag(cx, cy) {
    dragging = true;
    startDragX = cx; startDragY = cy;
    startCamOffset.copy(camera.position).sub(TARGET_V);
    startCamUp.copy(camera.up);
  }
  function stopDrag() { dragging = false; }
  function moveDrag(cx, cy) {
    if (!dragging) return;
    const dx = cx - startDragX;
    const dy = cy - startDragY;
    const qRoll  = new THREE.Quaternion().setFromAxisAngle(axisZ, -dx * ROTATE_SPEED);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(axisX,  dy * ROTATE_SPEED);
    const q = qRoll.multiply(qPitch);
    camera.position.copy(TARGET_V).add(startCamOffset.clone().applyQuaternion(q));
    camera.up.copy(startCamUp).applyQuaternion(q);
    camera.lookAt(TARGET_V);
  }

  renderer.domElement.addEventListener('mousedown', (e) => startDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));

  renderer.domElement.addEventListener('touchstart', (e) => {
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchend', stopDrag);
  window.addEventListener('touchmove', (e) => {
    e.preventDefault();
    moveDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir  = camera.position.clone().sub(TARGET_V).normalize();
    const dist = camera.position.distanceTo(TARGET_V);
    const nd   = Math.max(3, Math.min(80, dist + e.deltaY * 0.03));
    camera.position.copy(TARGET_V).addScaledVector(dir, nd);
    camera.lookAt(TARGET_V);
  }, { passive: false });

  // ── Resize ───────────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth;
    const nh = container.clientHeight;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
  });
  ro.observe(container);

  // ── Render loop ──────────────────────────────────────────────────────────
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

// ── Geometry helpers ──────────────────────────────────────────────────────

/**
 * Build and add probe cylinder meshes to the scene.
 *
 * Each probe starts pointing anterior (+Z in PROBE_RUFD/three.js) before any rotations.
 * The computed probe direction from the transform chain is used to orient it.
 * The AP/ML position from the last translation and the depth from the brain
 * surface determine the tip location.
 *
 * @param {THREE} THREE - The Three.js namespace.
 * @param {THREE.Scene} scene
 * @param {Array} probes - Output of extractEphysProbes().
 */
function _buildEphysProbes(THREE, scene, probes) {
  // Three.js CylinderGeometry is natively aligned with +Y; we rotate from +Y to probeAxis.
  const cylinderAxis = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < probes.length; i++) {
    const p     = probes[i];
    const color = cssHexToThree(ITEM_COLORS[i % ITEM_COLORS.length]);

    // Tip position in three.js space:
    // PROBE_RUFD X(ML) maps to three.js X; Y(DV) maps to three.js Y; Z(AP) maps to three.js Z.
    // Use the brain surface DV for the tip, then go down by depth.
    const threeX = p.ml;   // ML right+ matches three.js X
    const threeZ = p.ap;   // AP anterior+ matches three.js Z
    const sY     = surfaceY(p.ap, p.ml);
    const tipY   = (sY !== null ? sY : 0) - p.depth;

    const tipPos = new THREE.Vector3(threeX, tipY, threeZ);

    // Probe direction (from PROBE_RUFD rotations — same axes as three.js)
    const [dirX, dirY, dirZ] = p.probeDir;
    const probeAxis = new THREE.Vector3(dirX, dirY, dirZ).normalize();
    // Fall back to anterior (+Z) if direction is degenerate
    if (probeAxis.lengthSq() < 0.01) probeAxis.set(0, 0, 1);

    // Quaternion to rotate the Three.js cylinder axis (+Y) to the probe direction
    const quat = new THREE.Quaternion().setFromUnitVectors(cylinderAxis, probeAxis);

    // Cylinder geometry: center at half-length, so tip is at local y=0
    const geo = new THREE.CylinderGeometry(PROBE_RADIUS_MM, PROBE_RADIUS_MM, PROBE_LENGTH_MM, 12, 1);
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.9, shininess: 40 });
    const mesh = new THREE.Mesh(geo, mat);

    // Create a group: tip at group origin, cylinder extending in probe direction
    const group = new THREE.Group();
    mesh.position.y = PROBE_LENGTH_MM / 2; // shift cylinder so its base (tip end) is at group origin
    group.add(mesh);

    // Tip sphere
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(PROBE_RADIUS_MM * 2, 10, 10),
      new THREE.MeshPhongMaterial({ color, shininess: 60 }),
    );
    group.add(tip); // tip sphere at group origin

    // Apply probe orientation, then place group at tip position
    group.quaternion.copy(quat);
    group.position.copy(tipPos);

    scene.add(group);
  }
}
