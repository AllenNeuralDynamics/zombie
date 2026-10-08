import { describe, it, expect, vi } from 'vitest';
import { selectFiberTips, loadFiberTips } from '../subject/fiber-tip-data.js';
import { queryRows } from '../lib/arrow.js';
import { ensureTable } from '../lib/registry.js';
import { ccfIndexToBuild5 } from '../subject/ccf-build5-affine.js';
import { buildFiberTipMarkers } from '../subject/brain-viz-3d.js';
import { fiberColorByName } from '../subject/brain-viz.js';

vi.mock('../lib/registry.js', () => ({ ensureTable: vi.fn().mockResolvedValue('platform_smartspim_fiber_ccf') }));
vi.mock('../lib/arrow.js', () => ({ queryRows: vi.fn().mockResolvedValue([]) }));

describe('fiber tip annotations', () => {
  it('skips missing coordinates and picks the latest complete row per fiber', () => {
    const old = { fiber: 'Fiber 0', ap: 194, ml: 167, dv: 230, status_timestamp: '2026-10-01' };
    const latest = { ...old, ap: 180, status_timestamp: '2026-10-02' };
    const other = { ...old, fiber: 'Fiber 1' };
    expect(selectFiberTips([
      old, latest, other, { ...latest, ap: null, status_timestamp: '2026-10-03' },
      { ...latest, ap: NaN }, { ...latest, ap: -1 }, { ...latest, ap: 1.5 },
    ])).toEqual([latest, other]);
  });

  it('supports surgery views without a coordinator', async () => {
    expect(await loadFiberTips(null, '775743')).toEqual([]);
  });

  it('loads the subject annotations and converts Arrow int64 indices', async () => {
    const coordinator = {};
    queryRows.mockResolvedValueOnce([{ fiber: 'Fiber 0', ap: 194n, dv: 230n, ml: 167n }]);
    expect(await loadFiberTips(coordinator, '775743')).toEqual([{ fiber: 'Fiber 0', ap: 194, dv: 230, ml: 167 }]);
    expect(ensureTable).toHaveBeenCalledWith(coordinator, 'platform_smartspim_fiber_ccf');
    expect(queryRows).toHaveBeenCalledWith(coordinator, expect.stringContaining("WHERE subject_id = '775743'"));
  });
});

describe('measured tip placement', () => {
  it('maps 25 µm CCF indices through the fitted affine and template scene orientation', () => {
    const tip = { fiber: 'Fiber 0', ap: 194, dv: 230, ml: 167 };
    const template = ccfIndexToBuild5(tip);
    expect(template[0]).toBeCloseTo(1.54400645);
    expect(template[1]).toBeCloseTo(-1.07320552);
    expect(template[2]).toBeCloseTo(-4.74877953);
    const markers = buildFiberTipMarkers([{ name: 'Fiber_0' }], [tip]);
    const marker = markers.children[0];
    expect(marker.position.x).toBeCloseTo(-1.54400645);
    expect(marker.position.y).toBeCloseTo(-4.74877953);
    expect(marker.position.z).toBeCloseTo(1.07320552);
    expect(`#${marker.material.color.getHexString()}`.toLowerCase()).toBe(fiberColorByName('Fiber_0').toLowerCase());
    expect(marker.geometry.parameters.radius).toBe(0.16);
  });

  it('omits incomplete annotations and fibers from other surgeries', () => {
    expect(ccfIndexToBuild5({ ap: null, dv: 1, ml: 1 })).toBeNull();
    const markers = buildFiberTipMarkers([{ name: 'Fiber 0' }], [
      { fiber: 'Fiber 0', ap: 194, dv: null, ml: 167 },
      { fiber: 'Fiber 1', ap: 342, dv: 179, ml: 206 },
    ]);
    expect(markers.children).toHaveLength(0);
  });
});
