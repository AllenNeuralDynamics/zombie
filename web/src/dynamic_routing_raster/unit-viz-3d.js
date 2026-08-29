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

// Default cube-scale range for activity replay (a unit at rate 0 draws at
// ACTIVITY_MIN_SCALE; a unit at or above the reference rate draws at the
// current max-scale, see setActivityMaxScale()). ACTIVITY_MAX_SCALE is the
// starting value only -- exported so a caller's slider can default to it
// without duplicating the number.
export const ACTIVITY_MIN_SCALE = 0.6;
export const ACTIVITY_MAX_SCALE = 5;
const ACTIVITY_GAMMA = 0.6;

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

function colorGroupKey(unit, colorBy) {
  if (colorBy === 'acquisition') {
    return unit.acquisition ?? unit.assetName ?? unit.experiment ?? 'unknown acquisition';
  }
  return probeName(unit);
}

function colorGroupLabel(unit, colorBy) {
  return colorBy === 'acquisition'
    ? unit.acquisitionLabel ?? colorGroupKey(unit, colorBy)
    : colorGroupKey(unit, colorBy);
}

function colorForIndex(index) {
  if (index < ITEM_COLORS.length) return cssHexToThree(ITEM_COLORS[index]);
  // Keep acquisition colors distinct when an overview contains more groups
  // than the standard subject palette has entries.
  return new THREE.Color().setHSL((index * 0.61803398875) % 1, 0.72, 0.56).getHex();
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
 * Sample one unit's activity series at time `t` with linear interpolation.
 * `series.times` must be sorted ascending. Returns 0 outside the series' range
 * (no data recorded) rather than extrapolating.
 */
function sampleActivity(series, t) {
  const { times, rates } = series;
  const n = times.length;
  if (n === 0 || t < times[0] || t > times[n - 1]) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0 || times[lo] === t) return rates[lo];
  const i0 = lo - 1;
  const span = times[lo] - times[i0];
  const frac = span > 0 ? (t - times[i0]) / span : 0;
  return rates[i0] + (rates[lo] - rates[i0]) * frac;
}

/** Map a firing rate to a cube-scale multiplier, normalized against `refRate`. */
function scaleForRate(rate, refRate, maxScale) {
  if (!(refRate > 0)) return ACTIVITY_MIN_SCALE;
  const normalized = Math.min(1, Math.max(0, rate / refRate));
  return ACTIVITY_MIN_SCALE + (maxScale - ACTIVITY_MIN_SCALE) * normalized ** ACTIVITY_GAMMA;
}

/**
 * Create a 3D CCF view. The returned element exposes setUnits and
 * setSelectedUnit so the raster's controls can update it without rebuilding
 * the WebGL scene.
 */
export function createEphysUnitViz3D({
  units = [],
  selectedKey = null,
  colorBy = 'probe',
  showStructures = true,
  className = 'dr-raster-brain-viz',
} = {}) {
  const container = document.createElement('div');
  container.className = className;
  container.style.cssText =
    'position:relative;width:100%;height:100%;min-height:0;background:var(--surface-bg,#fff);' +
    'border-radius:8px;overflow:hidden';

  const legendEl = document.createElement('div');
  legendEl.className = 'dr-raster-brain-legend';
  container.appendChild(legendEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'dr-raster-brain-status';
  container.appendChild(statusEl);

  // Activity replay is off by default: state.activity is null until
  // setActivityData() supplies a per-unit {times, rates} lookup, and every unit
  // draws at its normal fixed size. See sampleActivity()/scaleForRate() above.
  const state = { units: [...units], selectedKey, activity: null, activityT: 0 };
  let renderUnits = () => {};
  let applyActivity = () => {};

  container.setUnits = (nextUnits) => {
    state.units = [...(nextUnits ?? [])];
    renderUnits();
  };
  container.setSelectedUnit = (nextKey) => {
    state.selectedKey = nextKey ?? null;
    renderUnits();
  };
  /**
   * Enable per-unit activity scaling. `byKey` maps a unit's `key` (the same key
   * used in the `units` array passed to setUnits/createEphysUnitViz3D) to
   * `{times, rates}` (ascending-sorted seconds + Hz). `refRate` is the
   * max-firing cutoff: a unit at or above this rate draws at the largest cube;
   * omit it to use the 99th percentile of every supplied rate so one outlier
   * burst doesn't wash out the whole scale. `maxScale` is the starting
   * cube-scale multiplier at refRate. Both can be adjusted afterward with
   * setActivityRefRate()/setActivityMaxScale() without reloading data.
   * Returns the resolved {refRate, maxScale} so a caller's sliders can start
   * at whatever value was actually applied (e.g. the auto-computed refRate).
   */
  container.setActivityData = (byKey, { refRate, maxScale = ACTIVITY_MAX_SCALE } = {}) => {
    const resolvedRefRate = refRate ?? _percentileRate(byKey, 0.99);
    state.activity = { byKey, refRate: resolvedRefRate, maxScale };
    renderUnits();
    return { refRate: resolvedRefRate, maxScale };
  };
  container.clearActivityData = () => {
    state.activity = null;
    renderUnits();
  };
  /** Scrub the activity clock to `t` seconds; cheap per-frame instance update, no rebuild. */
  container.setActivityTime = (t) => {
    state.activityT = t;
    applyActivity();
  };
  /** Adjust the cube-scale multiplier at refRate; cheap per-instance update, no rebuild. */
  container.setActivityMaxScale = (maxScale) => {
    if (!state.activity) return;
    state.activity.maxScale = maxScale;
    applyActivity();
  };
  /** Adjust the max-firing cutoff (Hz) that saturates to the largest cube; cheap, no rebuild. */
  container.setActivityRefRate = (refRate) => {
    if (!state.activity) return;
    state.activity.refRate = refRate;
    applyActivity();
  };

  _initUnitViz(container, legendEl, statusEl, state, { colorBy, showStructures })
    .then(({ render, applyActivityFrame }) => {
      renderUnits = render;
      applyActivity = applyActivityFrame;
      renderUnits();
    })
    .catch((error) => {
      statusEl.textContent = `3D viewer failed: ${error?.message ?? error}`;
      console.error('[DynamicRoutingUnitViz3D]', error);
    });

  return container;
}

/** 99th-percentile rate across every unit's series, used as the default activity reference. */
function _percentileRate(byKey, p) {
  const all = [];
  for (const series of byKey.values()) {
    for (const rate of series.rates) if (rate > 0) all.push(rate);
  }
  if (all.length === 0) return 1;
  all.sort((a, b) => a - b);
  return all[Math.min(all.length - 1, Math.floor(all.length * p))];
}

async function _initUnitViz(container, legendEl, statusEl, state, { colorBy, showStructures }) {
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

  // Per-instance records for the regular (non-selected) units in the most recent
  // render(), so applyActivityFrame() can rescale every cube in place on the
  // playback clock's tick without rebuilding any InstancedMesh.
  let unitRecords = [];
  const instanceScratch = new THREE.Matrix4();

  function activityScaleFor(unit) {
    if (!state.activity) return 1;
    const series = state.activity.byKey.get(unit.key);
    if (!series) return ACTIVITY_MIN_SCALE;
    return scaleForRate(sampleActivity(series, state.activityT), state.activity.refRate, state.activity.maxScale);
  }

  function applyActivityFrame() {
    if (!state.activity) return;
    const touched = new Set();
    for (const record of unitRecords) {
      const scale = activityScaleFor(record.unit);
      instanceScratch.makeScale(scale, scale, scale).setPosition(record.position);
      record.mesh.setMatrixAt(record.index, instanceScratch);
      touched.add(record.mesh);
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  }

  function updateLegend(colorGroups, structures) {
    legendEl.replaceChildren();
    for (const [index, group] of colorGroups.entries()) {
      const row = document.createElement('div');
      row.className = 'dr-raster-brain-legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'dr-raster-brain-legend-swatch';
      swatch.style.background = `#${colorForIndex(index).toString(16).padStart(6, '0')}`;
      row.append(swatch, document.createTextNode(group.label));
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
    if (!showStructures) return structures;
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
  }

  function render() {
    renderTargetedStructures();
    disposeUnitGroup(unitGroup);
    const colorGroups = [...new Map(state.units.map((unit) => {
      const key = colorGroupKey(unit, colorBy);
      return [key, { key, label: colorGroupLabel(unit, colorBy) }];
    })).values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const colors = new Map(colorGroups.map((group, index) => [
      group.key,
      colorForIndex(index),
    ]));
    const positionedByGroup = new Map();
    for (const unit of state.units) {
      const position = toCCFPosition(THREE, unit, CCF_MATRIX);
      if (!position) continue;
      const groupKey = colorGroupKey(unit, colorBy);
      if (!positionedByGroup.has(groupKey)) positionedByGroup.set(groupKey, []);
      positionedByGroup.get(groupKey).push({ unit, position });
    }

    const instanceMatrix = new THREE.Matrix4();
    unitRecords = [];
    for (const [groupKey, entries] of positionedByGroup) {
      const baseColor = colors.get(groupKey) ?? 0x00ccff;
      const regular = entries.filter(({ unit }) => unit.key !== state.selectedKey);
      if (regular.length) {
        const mesh = new THREE.InstancedMesh(
          cubeGeometry,
          new THREE.MeshPhongMaterial({ color: baseColor }),
          regular.length,
        );
        regular.forEach(({ unit, position }, index) => {
          const scale = activityScaleFor(unit);
          instanceMatrix.makeScale(scale, scale, scale).setPosition(position);
          mesh.setMatrixAt(index, instanceMatrix);
          if (state.activity) unitRecords.push({ unit, mesh, index, position });
        });
        mesh.instanceMatrix.needsUpdate = true;
        unitGroup.add(mesh);
      }

      for (const { unit, position } of entries) {
        if (unit.key !== state.selectedKey) continue;
        const mesh = new THREE.Mesh(
          cubeGeometry,
          new THREE.MeshPhongMaterial({ color: SELECTED_COLOR }),
        );
        mesh.position.copy(position);
        mesh.scale.setScalar(SELECTED_CUBE_SCALE);
        mesh.userData.baseColor = baseColor;
        mesh.userData.unitKey = unit.key;
        unitGroup.add(mesh);
      }
    }
    updateLegend(colorGroups, [...targetedStructures().values()]);
    const positioned = [...positionedByGroup.values()].reduce((sum, group) => sum + group.length, 0);
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

  return { render, applyActivityFrame };
}
