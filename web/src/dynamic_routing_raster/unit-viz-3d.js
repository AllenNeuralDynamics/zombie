/**
 * 3D CCF view for Dynamic Routing ecephys units.
 *
 * This reuses the standard subject brain mesh, CCF transform, orbit controls,
 * and theme handling. Unit locations are the NWB-Zarr ccf_ap/ccf_dv/ccf_ml
 * fields; cubes are colored by electrode group (probe).
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  makeCCFMatrix,
  makeTemplateMatrix,
  loadBrainMesh,
  STRUCTURE_COLORS,
  TARGET_X,
  TARGET_Y,
  TARGET_Z,
  cssHexToThree,
  resolveCCFStructure,
} from '../subject/brain-viz-3d.js';
import { ITEM_COLORS } from '../subject/brain-viz.js';
import { unitArea } from './data.js';
import { createOrbitControls } from '../lib/orbit-controls.js';
import { vizSceneBg, onVizThemeChange } from '../subject/viz-theme.js';

const MESH_BASE = 'https://allen-data-views.s3.amazonaws.com/data-asset-cache/meshes/';
const UNIT_CUBE_MM = 0.07;
const SELECTED_CUBE_SCALE = 2.8;
const SELECTED_COLOR = cssHexToThree('#ef2929');

function finite(value) {
  return Number.isFinite(Number(value));
}

function toCCFPosition(THREE_NS, unit, matrix) {
  if (!finite(unit.ccfAp) || !finite(unit.ccfDv) || !finite(unit.ccfMl)) return null;
  // makeCCFMatrix expects the atlas volume order [AP, DV, ML]. The unit
  // fields are named explicitly, so do not pass them in the UI/scene order.
  return new THREE_NS.Vector3(
    Number(unit.ccfAp),
    Number(unit.ccfDv),
    Number(unit.ccfMl),
  ).applyMatrix4(matrix);
}

function probeName(unit) {
  return unit.probeName ?? unit.deviceName ?? 'unknown probe';
}

function disposeUnitGroup(group) {
  for (const mesh of group.children) mesh.material?.dispose();
  group.clear();
}

function disposeStructureRecord(record) {
  record.group.traverse((child) => child.geometry?.dispose());
  record.material.dispose();
  record.group.clear();
}

/**
 * Create a 3D CCF view. The returned element exposes setUnits and
 * setSelectedUnit so the raster's controls can update it without rebuilding
 * the WebGL scene.
 */
export function createEphysUnitViz3D({ units = [], selectedKey = null } = {}) {
  const container = document.createElement('div');
  container.className = 'dr-raster-brain-viz';
  container.style.cssText =
    'position:relative;width:100%;height:100%;min-height:0;background:var(--surface-bg,#fff);' +
    'border-radius:8px;overflow:hidden';

  const legendEl = document.createElement('div');
  legendEl.className = 'dr-raster-brain-legend';
  container.appendChild(legendEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'dr-raster-brain-status';
  container.appendChild(statusEl);

  const state = { units: [...units], selectedKey };
  let renderUnits = () => {};

  container.setUnits = (nextUnits) => {
    state.units = [...(nextUnits ?? [])];
    renderUnits();
  };
  container.setSelectedUnit = (nextKey) => {
    state.selectedKey = nextKey ?? null;
    renderUnits();
  };

  _initUnitViz(container, legendEl, statusEl, state)
    .then((render) => {
      renderUnits = render;
      renderUnits();
    })
    .catch((error) => {
      statusEl.textContent = `3D viewer failed: ${error?.message ?? error}`;
      console.error('[DynamicRoutingUnitViz3D]', error);
    });

  return container;
}

async function _initUnitViz(container, legendEl, statusEl, state) {
  const CCF_MATRIX = makeCCFMatrix(THREE);
  const BRAIN_MATRIX = makeTemplateMatrix(THREE);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(vizSceneBg());

  const width = container.clientWidth || 720;
  const height = container.clientHeight || 360;
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 300);
  camera.position.set(TARGET_X, TARGET_Y + 22, TARGET_Z);
  camera.up.set(0, 0, 1);
  camera.lookAt(TARGET_X, TARGET_Y, TARGET_Z);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(new THREE.Color(vizSceneBg()), 1);
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 0.75);
  key.position.set(4, 12, 14);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdde0ff, 0.3);
  fill.position.set(-8, -4, -8);
  scene.add(fill);

  const brainMaterial = new THREE.MeshPhongMaterial({
    color: 0x737373,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
    shininess: 20,
  });
  const loader = new OBJLoader();
  loadBrainMesh(loader, `${MESH_BASE}997_b5.obj`, (group) => {
    group.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.applyMatrix4(BRAIN_MATRIX);
      child.material = brainMaterial;
      child.renderOrder = 1;
    });
    scene.add(group);
  });

  const structureGroup = new THREE.Group();
  scene.add(structureGroup);
  const structureMeshes = new Map();
  const pendingStructureIds = new Set();

  const unitGroup = new THREE.Group();
  scene.add(unitGroup);
  const cubeGeometry = new THREE.BoxGeometry(UNIT_CUBE_MM, UNIT_CUBE_MM, UNIT_CUBE_MM);

  function updateLegend(probeNames, structures) {
    legendEl.replaceChildren();
    for (const [index, name] of probeNames.entries()) {
      const row = document.createElement('div');
      row.className = 'dr-raster-brain-legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'dr-raster-brain-legend-swatch';
      swatch.style.background = ITEM_COLORS[index % ITEM_COLORS.length];
      row.append(swatch, document.createTextNode(name));
      legendEl.appendChild(row);
    }
    if (structures.length) {
      const heading = document.createElement('div');
      heading.className = 'dr-raster-brain-legend-title';
      heading.textContent = 'Targeted areas';
      legendEl.appendChild(heading);
      for (const structure of structures) {
        const row = document.createElement('div');
        row.className = 'dr-raster-brain-legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'dr-raster-brain-legend-swatch dr-raster-brain-area-swatch';
        swatch.style.background = `rgb(${structure.rgb.join(', ')})`;
        row.append(swatch, document.createTextNode(structure.acronym || structure.name));
        legendEl.appendChild(row);
      }
    }
  }

  function targetedStructures() {
    const structures = new Map();
    for (const unit of state.units) {
      const structure = resolveCCFStructure(unitArea(unit));
      if (!structure?.id || !STRUCTURE_COLORS[String(structure.id)]) continue;
      structures.set(String(structure.id), {
        ...structure,
        rgb: STRUCTURE_COLORS[String(structure.id)],
      });
    }
    return structures;
  }

  function renderTargetedStructures() {
    const structures = targetedStructures();
    const ids = new Set(structures.keys());
    for (const [id, record] of structureMeshes) {
      if (ids.has(id)) continue;
      structureGroup.remove(record.group);
      disposeStructureRecord(record);
      structureMeshes.delete(id);
    }
    for (const [id, structure] of structures) {
      if (structureMeshes.has(id) || pendingStructureIds.has(id)) continue;
      const rgb = STRUCTURE_COLORS[id];
      const material = new THREE.MeshPhongMaterial({
        color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255),
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
        shininess: 30,
      });
      pendingStructureIds.add(id);
      loadBrainMesh(loader, `${MESH_BASE}${id}_b5.obj`, (group) => {
        pendingStructureIds.delete(id);
        if (!targetedStructures().has(id)) {
          group.traverse((child) => child.geometry?.dispose());
          material.dispose();
          return;
        }
        group.traverse((child) => {
          if (!child.isMesh) return;
          child.geometry.applyMatrix4(BRAIN_MATRIX);
          child.material = material;
          child.renderOrder = 2;
        });
        structureGroup.add(group);
        structureMeshes.set(id, { group, material });
      });
    }
    updateLegend(
      [...new Set(state.units.map(probeName))].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })),
      [...structures.values()],
    );
  }

  function render() {
    renderTargetedStructures();
    disposeUnitGroup(unitGroup);
    const probeNames = [...new Set(state.units.map(probeName))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }));
    const colors = new Map(probeNames.map((name, index) => [
      name,
      cssHexToThree(ITEM_COLORS[index % ITEM_COLORS.length]),
    ]));
    let positioned = 0;
    for (const unit of state.units) {
      const position = toCCFPosition(THREE, unit, CCF_MATRIX);
      if (!position) continue;
      const baseColor = colors.get(probeName(unit)) ?? 0x00ccff;
      const selected = unit.key === state.selectedKey;
      const mesh = new THREE.Mesh(
        cubeGeometry,
        new THREE.MeshPhongMaterial({ color: selected ? SELECTED_COLOR : baseColor }),
      );
      mesh.position.copy(position);
      mesh.scale.setScalar(selected ? SELECTED_CUBE_SCALE : 1);
      mesh.userData.baseColor = baseColor;
      mesh.userData.unitKey = unit.key;
      unitGroup.add(mesh);
      positioned += 1;
    }
    statusEl.textContent = positioned ? '' : 'No CCF unit locations available';
    statusEl.hidden = Boolean(positioned);
  }

  const target = new THREE.Vector3(TARGET_X, TARGET_Y, TARGET_Z);
  const initCameraUp = camera.up.clone();
  createOrbitControls(camera, target, initCameraUp, renderer.domElement, {
    rotateSpeed: 0.007,
  });

  const resizeObserver = new ResizeObserver(() => {
    const nextWidth = container.clientWidth;
    const nextHeight = container.clientHeight;
    if (!nextWidth || !nextHeight) return;
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(nextWidth, nextHeight);
  });
  resizeObserver.observe(container);

  let alive = true;
  (function animate() {
    if (!alive) return;
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }());

  const disconnectTheme = onVizThemeChange(() => {
    const background = new THREE.Color(vizSceneBg());
    scene.background = background;
    renderer.setClearColor(background, 1);
  });

  const mutationObserver = new MutationObserver(() => {
    if (!document.contains(container)) {
      alive = false;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      disconnectTheme();
      disposeUnitGroup(unitGroup);
      for (const record of structureMeshes.values()) disposeStructureRecord(record);
      structureMeshes.clear();
      structureGroup.clear();
      cubeGeometry.dispose();
      brainMaterial.dispose();
      renderer.dispose();
    }
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  return render;
}
