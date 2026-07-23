/**
 * imaging-viz-3d.js — Three.js 3D viewer for ImagingConfig imaging planes.
 *
 * Renders:
 *   - Transparent grey brain surface (997.obj from Allen CCF v1.2)
 *   - Semi-transparent target structure meshes, coloured by CCF atlas palette
 *   - Semi-transparent rectangles representing imaging planes, positioned
 *     around the centre of the targeted structure at the correct depth spacing
 *
 * Coordinate system matches brain-viz-3d.js (three.js origin = Bregma, mm):
 *   x = ML  (right = positive)
 *   y = DV  (dorsal = positive, i.e. inverted from CCF)
 *   z = AP  (anterior = positive)
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  STRUCTURE_COLORS,
  TARGET_X, TARGET_Y, TARGET_Z,
  makeTemplateMatrix,
  loadBrainMesh,
} from './brain-viz-3d.js';
import { createOrbitControls } from '../lib/orbit-controls.js';
import { vizSceneBg, onVizThemeChange } from './viz-theme.js';
// hasImagingConfig / extractImagingData live in ./imaging-data.js (three.js-free)
// so the subject details panel can branch on imaging data without loading this
// 3D module. Re-exported here for backwards compatibility with existing importers.
import { extractImagingData } from './imaging-data.js';
export { hasImagingConfig, extractImagingData } from './imaging-data.js';
import CCF_STRUCTURE_CENTERS from './allen_mouse_100um_v1.2/ccf_structure_centers.json';

const MESH_BASE = 'https://allen-data-views.s3.amazonaws.com/data-asset-cache/meshes/';

// Plane colours by index (similar to ITEM_COLORS)
const PLANE_COLORS = [
  0x4e79a7, 0xf28e2b, 0xe15759, 0x76b7b2, 0x59a14f,
  0xedc948, 0xb07aa1, 0xff9da7, 0x9c755f, 0xbab0ac,
];

// ---------------------------------------------------------------------------
// Detail table
// ---------------------------------------------------------------------------

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the imaging details HTML panel (config info + planes table).
 *
 * @param {object} acquisitionData
 * @returns {HTMLElement}
 */
export function createImagingDetailsPanel(acquisitionData) {
  const container = document.createElement('div');
  const { configs, planes } = extractImagingData(acquisitionData);

  if (!configs.length) {
    container.innerHTML = '<p class="detail-empty">No imaging configuration found.</p>';
    return container;
  }

  // Config summary cards
  const configCards = configs.map(cfg => {
    const fr = cfg.sampling_strategy?.frame_rate;
    const frUnit = cfg.sampling_strategy?.frame_rate_unit ?? '';
    return `
      <div class="detail-card">
        <h4>Imaging Config: ${esc(cfg.device_name ?? 'Unknown')}</h4>
        <dl>
          ${fr != null ? `<dt>Frame rate</dt><dd>${fr} ${esc(frUnit)}</dd>` : ''}
          <dt>Image planes</dt><dd>${cfg.images?.length ?? 0} planar images</dd>
          <dt>Channels</dt><dd>${[...new Set((cfg.channels ?? []).map(c => c.channel_name).concat(
            (cfg.images ?? []).map(i => i.channel_name)
          ).filter(Boolean))].join(', ') || 'N/A'}</dd>
        </dl>
      </div>`;
  }).join('');

  // Planes table
  const planesTable = planes.length ? `
    <table class="detail-table">
      <thead><tr>
        <th>#</th><th>Channel</th><th>Depth</th>
        <th>Dimensions</th><th>Power</th><th>Target</th>
      </tr></thead>
      <tbody>${planes.map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(p.channelName)}</td>
        <td>${p.depth} ${esc(p.depthUnit)}</td>
        <td>${p.dimX != null ? `${p.dimX} × ${p.dimY} ${esc(p.dimUnit)}` : 'N/A'}</td>
        <td>${p.power != null ? `${p.power} ${esc(p.powerUnit)}` : 'N/A'}</td>
        <td>${esc(p.structureName)}${p.structureAcronym ? ` (${esc(p.structureAcronym)})` : ''}</td>
      </tr>`).join('')}</tbody>
    </table>` : '';

  container.innerHTML = configCards + planesTable;

  // 3D viewer below the table
  const viz3d = createImagingViz3D(acquisitionData);
  viz3d.style.marginTop = '12px';
  container.appendChild(viz3d);

  return container;
}

// ---------------------------------------------------------------------------
// 3D Visualisation
// ---------------------------------------------------------------------------

/**
 * Create a self-contained 3D brain viewer showing imaging planes as
 * semi-transparent rectangles near the targeted brain structure.
 *
 * @param {object} acquisitionData
 * @returns {HTMLElement}
 */
export function createImagingViz3D(acquisitionData) {
  const container = document.createElement('div');
  container.className = 'brain-viz-3d-container';
  container.style.cssText =
    'position:relative;width:100%;height:600px;background:var(--surface-bg,#fff);border-radius:4px;overflow:hidden';

  const statusEl = document.createElement('div');
  statusEl.style.cssText =
    'position:absolute;bottom:12px;left:12px;color:var(--text-primary,#444);font:11px monospace;' +
    'pointer-events:none;z-index:10;line-height:1.6';
  statusEl.textContent = 'Loading 3D brain…';
  container.appendChild(statusEl);

  const infoEl = document.createElement('div');
  infoEl.style.cssText =
    'position:absolute;top:12px;right:12px;color:var(--text-primary,#333);font:11px monospace;' +
    'pointer-events:none;z-index:10;text-align:right;line-height:1.6';
  container.appendChild(infoEl);

  _initImaging3D(container, statusEl, infoEl, acquisitionData).catch((err) => {
    statusEl.textContent = '3D viewer failed: ' + (err.message ?? err);
    console.error('[ImagingViz3D]', err);
  });

  return container;
}

async function _initImaging3D(container, statusEl, infoEl, acquisitionData) {
  const CCF_MATRIX = makeTemplateMatrix(THREE);
  const { planes, structures } = extractImagingData(acquisitionData);

  if (!planes.length) {
    statusEl.textContent = 'No imaging planes found.';
    return;
  }

  // ── Scene ────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(vizSceneBg());

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
  renderer.setClearColor(new THREE.Color(vizSceneBg()), 1);
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

  // Track structure mesh centres for placing imaging planes
  const structureCentres = new Map(); // structureId → THREE.Vector3
  let structureMeshesLoaded = 0;
  const totalStructureMeshes = structures.filter(s => STRUCTURE_COLORS[String(s.id)]).length;

  // Load brain surface
  loadBrainMesh(loader, MESH_BASE + '997_b5.obj', (group) => {
    group.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.applyMatrix4(CCF_MATRIX);
      child.material = brainMat;
      child.renderOrder = 1;
    });
    scene.add(group);
    if (totalStructureMeshes === 0) {
      // No structure meshes to load; place planes using a fallback
      _placePlanesWithoutStructure(scene, planes);
      statusEl.textContent = 'Drag to rotate · Scroll to zoom';
    }
  });

  // ── Structure meshes ────────────────────────────────────────────────────
  for (const struct of structures) {
    const id = String(struct.id);
    const rgb = STRUCTURE_COLORS[id];
    if (!rgb) continue;

    const color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    const mat = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity: 0.30,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 30,
    });

    loadBrainMesh(loader, MESH_BASE + id + '_b5.obj', (group) => {
      // Compute centre of the structure mesh in three.js coords
      const box = new THREE.Box3();
      group.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.applyMatrix4(CCF_MATRIX);
        child.material = mat;
        child.renderOrder = 2;
        child.geometry.computeBoundingBox();
        box.expandByObject(child);
      });
      scene.add(group);

      // Prefer the annotation-derived left-hemisphere centroid over the bilateral
      // mesh bounding-box centre (which lands on the midline for symmetric meshes).
      let centre;
      const precomputed = CCF_STRUCTURE_CENTERS[id];
      if (precomputed) {
        centre = new THREE.Vector3(precomputed[0], precomputed[1], precomputed[2]);
      } else {
        centre = new THREE.Vector3();
        box.getCenter(centre);
      }
      structureCentres.set(id, centre);

      structureMeshesLoaded++;
      if (structureMeshesLoaded >= totalStructureMeshes) {
        // All structure meshes loaded — place imaging planes
        _placeImagingPlanes(scene, planes, structureCentres);
        statusEl.textContent = 'Drag to rotate · Scroll to zoom';
      }
    });
  }

  // ── Legend ───────────────────────────────────────────────────────────────
  const legendLines = [];
  // Group planes by structure
  const structNames = new Map();
  for (const p of planes) {
    if (p.structureId && !structNames.has(p.structureId)) {
      structNames.set(p.structureId, p.structureName || p.structureAcronym);
    }
  }
  for (const [sid, name] of structNames) {
    const rgb = STRUCTURE_COLORS[sid];
    const cssColor = rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : '#999';
    legendLines.push(`<span style="color:${cssColor}">■</span> ${name}`);
  }
  const depthRange = planes.length
    ? `${planes[0].depth}–${planes[planes.length - 1].depth} ${planes[0].depthUnit}`
    : '';
  if (depthRange) legendLines.push(`Depth: ${depthRange}`);
  legendLines.push(`${planes.length} imaging plane(s)`);
  legendLines.push('<span style="color:#aaa39f">●</span> Bregma');
  infoEl.innerHTML = legendLines.join('<br>');

  // ── Camera orbit controls ────────────────────────────────────────────────
  const TARGET_V = new THREE.Vector3(TARGET_X, TARGET_Y, TARGET_Z);
  const initCamUp = camera.up.clone();
  createOrbitControls(camera, TARGET_V, initCamUp, renderer.domElement, {
    rotateSpeed: 0.007,
  });

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

  // Re-theme the WebGL scene when the colour scheme changes.
  const disconnectTheme = onVizThemeChange(() => {
    const bg = new THREE.Color(vizSceneBg());
    scene.background = bg;
    renderer.setClearColor(bg, 1);
  });

  // Clean up when container is removed from DOM
  const mo = new MutationObserver(() => {
    if (!document.contains(container)) {
      alive = false;
      ro.disconnect();
      mo.disconnect();
      disconnectTheme();
      renderer.dispose();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Plane geometry helpers
// ---------------------------------------------------------------------------

/**
 * Place imaging plane rectangles in the scene, centred on the target structure.
 *
 * Each plane is a semi-transparent rectangle. The planes are stacked vertically
 * (along the DV axis / three.js Y) spaced by their depth values. The centre
 * X/Z position comes from the structure mesh centre.
 *
 * Plane physical size: we use a 0.5 mm square as a default since the pixel
 * dimensions don't directly translate to physical size without magnification info.
 * This gives a visible rectangle near the structure.
 */
function _placeImagingPlanes(scene, planes, structureCentres) {
  if (!planes.length) return;

  // Find the primary structure centre — use the first plane's structure.
  // The centres in structureCentres come from the CCF annotation left-hemisphere
  // centroid (or mesh bounding box as fallback). If the plane's relativePosition
  // indicates the right hemisphere, mirror the x-axis to move it to the right.
  let centre = null;
  let isRight = false;
  for (const p of planes) {
    if (p.structureId && structureCentres.has(p.structureId)) {
      centre = structureCentres.get(p.structureId);
      // "right" in any form → mirror to right hemisphere (negate x)
      if (p.relativePosition?.includes('right')) isRight = true;
      break;
    }
  }
  if (!centre) {
    // Fallback to brain centre
    _placePlanesWithoutStructure(scene, planes);
    return;
  }

  const useCentre = isRight
    ? new THREE.Vector3(-centre.x, centre.y, centre.z)
    : centre;
  _buildPlaneGeometry(scene, planes, useCentre);
}

/**
 * Fallback: place planes near the brain's centre when no structure mesh is available.
 */
function _placePlanesWithoutStructure(scene, planes) {
  const centre = new THREE.Vector3(TARGET_X, TARGET_Y, TARGET_Z);
  _buildPlaneGeometry(scene, planes, centre);
}

/**
 * Build and add plane rectangle meshes to the scene.
 *
 * @param {THREE.Scene} scene
 * @param {Array} planes - Extracted plane data.
 * @param {THREE.Vector3} centre - Centre point of the target structure.
 */
function _buildPlaneGeometry(scene, planes, centre) {
  // Imaging plane size in mm. Without magnification/pixel-size info, use a
  // reasonable default that's visible against the structure mesh.
  const PLANE_SIZE_MM = 0.6;

  // Compute depth range for vertical positioning
  const depths = planes.map(p => p.depth); // in µm
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const midDepth = (minDepth + maxDepth) / 2;

  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    const color = PLANE_COLORS[i % PLANE_COLORS.length];

    // Depth offset from the centre (µm → mm), relative to the midpoint
    const depthOffset = (p.depth - midDepth) / 1000;

    // Position: centred on structure, offset in Y (dorsoventral) by depth
    const planeX = centre.x;
    const planeY = centre.y - depthOffset; // deeper = lower Y in three.js
    const planeZ = centre.z;

    // Create a horizontal plane (XZ plane)
    const geo = new THREE.PlaneGeometry(PLANE_SIZE_MM, PLANE_SIZE_MM);
    const mat = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      shininess: 10,
    });

    const mesh = new THREE.Mesh(geo, mat);
    // PlaneGeometry faces +Z by default; rotate to face +Y (horizontal)
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(planeX, planeY, planeZ);
    mesh.renderOrder = 3;
    scene.add(mesh);

    // Add a thin wireframe border for visibility
    const edges = new THREE.EdgesGeometry(geo);
    const lineMat = new THREE.LineBasicMaterial({ color, linewidth: 1 });
    const wireframe = new THREE.LineSegments(edges, lineMat);
    wireframe.rotation.x = -Math.PI / 2;
    wireframe.position.set(planeX, planeY, planeZ);
    wireframe.renderOrder = 4;
    scene.add(wireframe);
  }
}
