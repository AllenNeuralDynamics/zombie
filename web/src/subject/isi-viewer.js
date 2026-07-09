/**
 * subject/isi-viewer.js — Interactive ISI (Intrinsic Signal Imaging) viewer.
 *
 * Renders an interactive canvas viewer for ISI processed assets, showing
 * target_map.png as background with sign_map.png or region-mask overlays.
 * Region labels and metrics are loaded from region_metrics.json.
 */

import { arrowTableToRows } from '../lib/arrow.js';

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabebe', '#469990',
];

export function isISIAcquisition(event) {
  return (event.modalities ?? []).includes('ISI');
}

function s3UriToHttps(uri) {
  if (!uri || !uri.startsWith('s3://')) return null;
  const withoutScheme = uri.slice(5);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) return null;
  const bucket = withoutScheme.slice(0, slashIdx);
  const key = withoutScheme.slice(slashIdx + 1).replace(/\/$/, '');
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

async function findProcessedLocation(assetName, coordinator) {
  if (!coordinator || !assetName) return null;
  const safe = assetName.replace(/'/g, "''");
  try {
    const result = await coordinator.query(
      `SELECT name, location FROM asset_basics WHERE name LIKE '${safe}_processed_%' ORDER BY name DESC LIMIT 1`,
    );
    const rows = arrowTableToRows(result);
    return rows[0]?.location ?? null;
  } catch {
    return null;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function createISIViewer(event, coordinator) {
  const container = document.createElement('div');
  container.className = 'isi-viewer';

  const loading = document.createElement('p');
  loading.className = 'detail-loading';
  loading.textContent = 'Loading ISI viewer\u2026';
  container.appendChild(loading);

  const assetName = event.data?._assetName ?? null;

  _buildViewer(container, assetName, coordinator).catch((err) => {
    container.innerHTML = `<p class="detail-empty">ISI viewer unavailable: ${err.message}</p>`;
  });

  return container;
}

async function _buildViewer(container, assetName, coordinator) {
  const processedLoc = await findProcessedLocation(assetName, coordinator);

  if (!processedLoc) {
    container.innerHTML = '<p class="detail-empty">No processed ISI segmentation data found for this acquisition.</p>';
    return;
  }

  const base = s3UriToHttps(processedLoc);
  if (!base) {
    container.innerHTML = '<p class="detail-empty">Unable to resolve S3 location.</p>';
    return;
  }

  const seg = `${base}/segmentation`;
  const urls = {
    target: `${seg}/target_map.png`,
    sign: `${seg}/sign_map.png`,
    labels: `${seg}/label_map_ids.png`,
    metrics: `${seg}/region_metrics.json`,
  };

  let targetImg, signImg, labelImg, metrics;
  try {
    [targetImg, signImg, labelImg, metrics] = await Promise.all([
      loadImage(urls.target),
      loadImage(urls.sign),
      loadImage(urls.labels),
      fetch(urls.metrics).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch (err) {
    container.innerHTML = `<p class="detail-empty">Failed to load ISI images: ${err.message}</p>`;
    return;
  }

  // Canvas is sized to the target map (background). Overlays and label-map
  // coordinates are scaled into this space at render/lookup time.
  const W = targetImg.naturalWidth;
  const H = targetImg.naturalHeight;
  const LW = labelImg.naturalWidth;
  const LH = labelImg.naturalHeight;

  const offscreen = document.createElement('canvas');
  offscreen.width = LW;
  offscreen.height = LH;
  const octx = offscreen.getContext('2d', { willReadFrequently: true });
  octx.drawImage(labelImg, 0, 0);
  const labelPixels = octx.getImageData(0, 0, LW, LH).data;

  const pixelId = new Uint8Array(LW * LH);
  for (let i = 0; i < LW * LH; i++) {
    pixelId[i] = labelPixels[i * 4];
  }

  const idToRegion = {};
  const regionNames = Object.keys(metrics ?? {});
  for (const name of regionNames) {
    const m = metrics[name];
    const x = Math.round(m.x_centroid);
    const y = Math.round(m.y_centroid);
    if (x >= 0 && x < LW && y >= 0 && y < LH) {
      const id = pixelId[y * LW + x];
      if (id > 0) idToRegion[id] = name;
    }
  }

  const uniqueIds = [...new Set(Object.values(idToRegion).map((n) => {
    const entry = Object.entries(idToRegion).find(([, v]) => v === n);
    return entry ? Number(entry[0]) : null;
  }).filter((id) => id !== null))];

  const colorMap = {};
  uniqueIds.forEach((id, i) => {
    colorMap[id] = hexToRgb(PALETTE[i % PALETTE.length]);
  });

  const maskImageData = new ImageData(LW, LH);
  for (let i = 0; i < LW * LH; i++) {
    const id = pixelId[i];
    if (id > 0 && colorMap[id]) {
      const [r, g, b] = colorMap[id];
      maskImageData.data[i * 4] = r;
      maskImageData.data[i * 4 + 1] = g;
      maskImageData.data[i * 4 + 2] = b;
      maskImageData.data[i * 4 + 3] = 180;
    }
  }

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = LW;
  maskCanvas.height = LH;
  maskCanvas.getContext('2d').putImageData(maskImageData, 0, 0);

  container.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'isi-toolbar';
  toolbar.innerHTML = `
    <span class="isi-toolbar-label">Overlay:</span>
    <label class="isi-radio-label"><input type="radio" name="isi-overlay" value="none" checked> None</label>
    <label class="isi-radio-label"><input type="radio" name="isi-overlay" value="sign"> Sign map</label>
    <label class="isi-radio-label"><input type="radio" name="isi-overlay" value="mask"> Region masks</label>
    <span class="isi-opacity-wrap">
      <span class="isi-toolbar-label">Opacity:</span>
      <input type="range" min="10" max="100" value="60" class="isi-opacity-slider">
    </span>
  `;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.className = 'isi-canvas';

  const tooltip = document.createElement('div');
  tooltip.className = 'isi-tooltip';
  tooltip.style.display = 'none';

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'isi-canvas-wrap';
  canvasWrap.appendChild(canvas);
  canvasWrap.appendChild(tooltip);

  const ctx = canvas.getContext('2d');
  let currentOverlay = 'none';
  let currentOpacity = 0.6;

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(targetImg, 0, 0, W, H);

    if (currentOverlay === 'sign') {
      ctx.globalAlpha = currentOpacity;
      ctx.drawImage(signImg, 0, 0, W, H);
      ctx.globalAlpha = 1;
    } else if (currentOverlay === 'mask') {
      ctx.globalAlpha = currentOpacity;
      ctx.drawImage(maskCanvas, 0, 0, W, H);
      ctx.globalAlpha = 1;

      if (metrics) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 11px sans-serif';
        for (const [name, m] of Object.entries(metrics)) {
          const cx = m.x_centroid * (W / LW);
          const cy = m.y_centroid * (H / LH);
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(name, cx, cy);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(name, cx, cy);
        }
      }
    }
  }

  render();

  toolbar.querySelectorAll('input[name="isi-overlay"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      currentOverlay = radio.value;
      render();
    });
  });

  toolbar.querySelector('.isi-opacity-slider').addEventListener('input', (e) => {
    currentOpacity = Number(e.target.value) / 100;
    render();
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (W / rect.width);
    const canvasY = (e.clientY - rect.top) * (H / rect.height);
    const px = Math.floor(canvasX * (LW / W));
    const py = Math.floor(canvasY * (LH / H));

    if (px < 0 || py < 0 || px >= LW || py >= LH) {
      tooltip.style.display = 'none';
      return;
    }

    const id = pixelId[py * LW + px];
    const regionName = idToRegion[id];

    if (regionName && metrics?.[regionName]) {
      const m = metrics[regionName];
      tooltip.textContent = `${regionName}  |  az: ${m.azimuth_bias?.toFixed(1)}°  |  alt: ${m.altitude_bias?.toFixed(1)}°  |  ecc: ${m.eccentricity_at_centroid?.toFixed(1)}°`;
      tooltip.style.display = 'block';
      const tipLeft = e.clientX - rect.left + 12;
      const tipTop = e.clientY - rect.top - 28;
      tooltip.style.left = `${tipLeft}px`;
      tooltip.style.top = `${tipTop}px`;
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  let metricsSection = null;
  if (metrics && Object.keys(metrics).length) {
    metricsSection = document.createElement('div');
    metricsSection.className = 'isi-metrics';

    const reverseMap = {};
    for (const [id, name] of Object.entries(idToRegion)) {
      reverseMap[name] = Number(id);
    }

    const rowsHtml = Object.entries(metrics).map(([name, m]) => {
      const id = reverseMap[name];
      const rgb = id != null && colorMap[id] ? colorMap[id] : null;
      const swatch = rgb
        ? `<span class="isi-swatch" style="background:rgb(${rgb.join(',')})"></span>`
        : '';
      return `<tr>
        <td>${swatch}${name}</td>
        <td>${m.azimuth_min?.toFixed(1)} – ${m.azimuth_max?.toFixed(1)}</td>
        <td>${m.altitude_min?.toFixed(1)} – ${m.altitude_max?.toFixed(1)}</td>
        <td>${m.eccentricity_at_centroid?.toFixed(1)}</td>
      </tr>`;
    }).join('');

    metricsSection.innerHTML = `
      <h5 class="isi-metrics-title">Region Metrics</h5>
      <div class="isi-metrics-table-wrap">
        <table class="detail-table">
          <thead><tr>
            <th>Region</th>
            <th>Azimuth range (°)</th>
            <th>Altitude range (°)</th>
            <th>Eccentricity at centroid (°)</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
  }

  container.appendChild(toolbar);

  const contentRow = document.createElement('div');
  contentRow.className = 'isi-content-row';
  contentRow.appendChild(canvasWrap);
  if (metricsSection) contentRow.appendChild(metricsSection);
  container.appendChild(contentRow);
}
