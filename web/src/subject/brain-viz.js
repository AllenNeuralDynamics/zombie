/**
 * subject-brain-viz.js — Canvas-based brain scatter visualization.
 *
 * Draws procedure locations (fiber implants / injections) on a top-down
 * mouse skull image using HTML Canvas.
 *
 * Skull image: /images/mouse_skull.png  (served from web/public/images/)
 *
 * Coordinate math matches brain_visualization.py exactly:
 *   - Origin: Bregma landmark (at 0,0 in mm-space)
 *   - X-axis: Medial-Lateral (ML), mm, positive = lateral
 *   - Y-axis: Anterior-Posterior (AP), mm, positive = anterior
 */

// ---------------------------------------------------------------------------
// Constants (from brain_visualization.py)
// ---------------------------------------------------------------------------

/** Anatomical distance between Bregma and Lambda in mm. */
export const BREGMA_LAMBDA_DISTANCE_MM = 4.2;

/** Shifts the skull image vertically relative to Bregma (negative = down/posterior). */
export const SKULL_IMAGE_VERTICAL_OFFSET_MM = -2.5;

/** Bregma landmark in source-image pixel space. */
export const BREGMA_PIXEL = [412, 816];

/** Lambda landmark in source-image pixel space. */
export const LAMBDA_PIXEL = [412, 1020];

/** Default color palette for multiple scatter items. */
export const ITEM_COLORS = [
  '#6464FF', // RGB 100/100/255
  '#CD0F55', // RGB 205/15/85
  '#00A59B', // RGB 0/165/155
  '#8246FF', // RGB 130/70/255
  '#CDEB05', // RGB 205/235/5
  '#FF00FF', // RGB 255/0/255
  '#FF6E00', // RGB 255/110/0
  '#DC9600', // RGB 220/150/0
  '#FFEB23', // RGB 255/235/35
];

// ---------------------------------------------------------------------------
// Pure coordinate helpers (no DOM — fully testable in Node)
// ---------------------------------------------------------------------------

/**
 * Calculate mm-space bounds of the skull image given its pixel dimensions.
 *
 * Replicates brain_visualization.py:calculate_image_bounds().
 *
 * @param {number} imgWidthPx
 * @param {number} imgHeightPx
 * @returns {{ xMin: number, yMin: number, xMax: number, yMax: number, scaleFactor: number }}
 */
export function calculateImageBounds(imgWidthPx, imgHeightPx) {
  const dx = LAMBDA_PIXEL[0] - BREGMA_PIXEL[0];
  const dy = LAMBDA_PIXEL[1] - BREGMA_PIXEL[1];
  const pixelDistance = Math.sqrt(dx * dx + dy * dy);
  const scaleFactor = BREGMA_LAMBDA_DISTANCE_MM / pixelDistance;

  const imgWidthMm = imgWidthPx * scaleFactor;
  const imgHeightMm = imgHeightPx * scaleFactor;

  const bregmaXFromLeft = BREGMA_PIXEL[0] * scaleFactor;
  const bregmaYFromTop = BREGMA_PIXEL[1] * scaleFactor;

  const xMin = -bregmaXFromLeft;
  const xMax = xMin + imgWidthMm;

  const offset = SKULL_IMAGE_VERTICAL_OFFSET_MM;
  const yMax = bregmaYFromTop + offset;
  const yMin = yMax - imgHeightMm;

  return { xMin, yMin, xMax, yMax, scaleFactor };
}

/**
 * Map mm-space coordinates to canvas pixel coordinates.
 *
 * The Y axis is flipped: higher AP (anterior, positive) maps toward the top of the canvas.
 *
 * @param {number} xMm - ML coordinate in mm
 * @param {number} yMm - AP coordinate in mm (already adjusted with vertical offset)
 * @param {{ xMin: number, xMax: number, yMin: number, yMax: number }} bounds
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {[number, number]} [canvasPixelX, canvasPixelY]
 */
export function mmToCanvas(xMm, yMm, bounds, canvasW, canvasH) {
  const { xMin, xMax, yMin, yMax } = bounds;
  const px = ((xMm - xMin) / (xMax - xMin)) * canvasW;
  const py = ((yMax - yMm) / (yMax - yMin)) * canvasH;
  return [px, py];
}

// ---------------------------------------------------------------------------
// Canvas drawing (browser-only)
// ---------------------------------------------------------------------------

/**
 * Draw brain scatter points on a canvas element.
 *
 * Loads the skull image from /images/mouse_skull.png, draws it semi-transparently,
 * then overlays scatter points and labels at AP/ML coordinates.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<[number, number]>} points - Array of [ml, ap] pairs in mm
 * @param {string[]} labels - Label for each point
 * @param {object} [opts]
 * @param {string[]} [opts.colors] - Per-point colors (cycles through ITEM_COLORS by default)
 * @param {string}   [opts.title]
 * @returns {Promise<void>} Resolves once drawing is complete.
 */
export async function drawBrainViz(canvas, points, labels, opts = {}) {
  const { colors = ITEM_COLORS, title = 'Brain Locations (Top View)' } = opts;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Load skull image
  const img = new Image();
  img.src = '/images/mouse_skull.png';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });

  const bounds = calculateImageBounds(img.naturalWidth, img.naturalHeight);

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Skull image (semi-transparent)
  ctx.globalAlpha = 0.6;
  ctx.drawImage(img, 0, 0, W, H);
  ctx.globalAlpha = 1.0;

  // Bregma cross marker
  const [bx, by] = mmToCanvas(0, SKULL_IMAGE_VERTICAL_OFFSET_MM, bounds, W, H);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  const cs = 6;
  ctx.beginPath();
  ctx.moveTo(bx - cs, by - cs); ctx.lineTo(bx + cs, by + cs);
  ctx.moveTo(bx + cs, by - cs); ctx.lineTo(bx - cs, by + cs);
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Bregma', bx, by + 16);

  // Scatter points + labels
  points.forEach(([ml, ap], i) => {
    const color = colors[i % colors.length];
    const [px, py] = mmToCanvas(ml, ap + SKULL_IMAGE_VERTICAL_OFFSET_MM, bounds, W, H);

    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(labels[i] ?? `Point ${i}`, px, py - 10);
  });

  // Title
  ctx.fillStyle = '#333';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, 16);
}

/**
 * Create and return an HTMLCanvasElement with a brain visualization.
 *
 * The canvas is sized immediately; drawing is async (skull image load).
 * The returned `ready` promise resolves (or silently catches errors) once done.
 *
 * @param {Array<[number, number]>} points - Array of [ml, ap] in mm
 * @param {string[]} labels
 * @param {object} [opts]
 * @param {number}   [opts.width=360]
 * @param {number}   [opts.height=600]
 * @param {string}   [opts.title]
 * @param {string[]} [opts.colors]
 * @returns {{ canvas: HTMLCanvasElement, ready: Promise<void> }}
 */
export function createBrainVizCanvas(points, labels, opts = {}) {
  const { width = 360, height = 600, ...drawOpts } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `width:${width}px;height:${height}px;max-width:100%;`;

  const ready = drawBrainViz(canvas, points, labels, drawOpts).catch((err) => {
    // Fallback: show error text on canvas
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#888';
    ctx.font = '12px sans-serif';
    ctx.fillText(`Could not load skull image: ${err.message}`, 8, 24);
  });

  return { canvas, ready };
}
