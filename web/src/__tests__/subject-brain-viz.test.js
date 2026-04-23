/**
 * subject-brain-viz.test.js — Unit tests for coordinate math in subject-brain-viz.js.
 *
 * Only tests the pure, Node-safe helpers (calculateImageBounds, mmToCanvas).
 * Canvas rendering (drawBrainViz, createBrainVizCanvas) requires a browser and
 * is not tested here.
 */

import { describe, it, expect } from 'vitest';
import {
  BREGMA_LAMBDA_DISTANCE_MM,
  BREGMA_PIXEL,
  LAMBDA_PIXEL,
  SKULL_IMAGE_VERTICAL_OFFSET_MM,
  calculateImageBounds,
  mmToCanvas,
} from '../subject/brain-viz.js';

// ---------------------------------------------------------------------------
// calculateImageBounds
// ---------------------------------------------------------------------------

describe('calculateImageBounds', () => {
  // Known pixel distance between Bregma and Lambda:
  //   sqrt((412-412)^2 + (1020-816)^2) = 204 px
  // => scale = 4.2 / 204 ≈ 0.020588 mm/px

  const PX_DIST = Math.sqrt(
    (LAMBDA_PIXEL[0] - BREGMA_PIXEL[0]) ** 2 +
    (LAMBDA_PIXEL[1] - BREGMA_PIXEL[1]) ** 2,
  );
  const EXPECTED_SCALE = BREGMA_LAMBDA_DISTANCE_MM / PX_DIST;

  it('returns the correct scaleFactor', () => {
    const { scaleFactor } = calculateImageBounds(824, 1200);
    expect(scaleFactor).toBeCloseTo(EXPECTED_SCALE, 8);
  });

  it('x-axis: Bregma is at x=0 (xMin = -bregmaX_mm)', () => {
    const { xMin } = calculateImageBounds(824, 1200);
    const expectedXMin = -BREGMA_PIXEL[0] * EXPECTED_SCALE;
    expect(xMin).toBeCloseTo(expectedXMin, 6);
  });

  it('y-axis: Bregma is offset by SKULL_IMAGE_VERTICAL_OFFSET_MM', () => {
    const { yMax } = calculateImageBounds(824, 1200);
    const bregmaYMm = BREGMA_PIXEL[1] * EXPECTED_SCALE;
    expect(yMax).toBeCloseTo(bregmaYMm + SKULL_IMAGE_VERTICAL_OFFSET_MM, 6);
  });

  it('image width in mm = imgWidthPx * scaleFactor', () => {
    const W = 824;
    const { xMin, xMax, scaleFactor } = calculateImageBounds(W, 1200);
    expect(xMax - xMin).toBeCloseTo(W * scaleFactor, 6);
  });

  it('image height in mm = imgHeightPx * scaleFactor', () => {
    const H = 1200;
    const { yMin, yMax, scaleFactor } = calculateImageBounds(824, H);
    expect(yMax - yMin).toBeCloseTo(H * scaleFactor, 6);
  });
});

// ---------------------------------------------------------------------------
// mmToCanvas
// ---------------------------------------------------------------------------

describe('mmToCanvas', () => {
  const bounds = { xMin: -5, xMax: 5, yMin: -10, yMax: 5 };
  const W = 200, H = 300;

  it('maps xMin to left edge (x=0)', () => {
    const [px] = mmToCanvas(-5, 0, bounds, W, H);
    expect(px).toBeCloseTo(0);
  });

  it('maps xMax to right edge (x=W)', () => {
    const [px] = mmToCanvas(5, 0, bounds, W, H);
    expect(px).toBeCloseTo(W);
  });

  it('maps yMax (anterior) to top of canvas (y=0)', () => {
    const [, py] = mmToCanvas(0, 5, bounds, W, H);
    expect(py).toBeCloseTo(0);
  });

  it('maps yMin (posterior) to bottom of canvas (y=H)', () => {
    const [, py] = mmToCanvas(0, -10, bounds, W, H);
    expect(py).toBeCloseTo(H);
  });

  it('maps midpoint to canvas centre', () => {
    // midX = 0, midY = -2.5
    const [px, py] = mmToCanvas(0, -2.5, bounds, W, H);
    expect(px).toBeCloseTo(W / 2);
    expect(py).toBeCloseTo(H / 2);
  });
});
