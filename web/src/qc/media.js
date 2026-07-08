import { resolveReference } from './data.js';

const PUBLIC_BUCKET = 'aind-open-data';
const PRESIGN_BASE = 'https://qc.allenneuraldynamics.org/get-signed-reference';

function needsPresign(reference, s3Bucket, type) {
  if (s3Bucket === PUBLIC_BUCKET) return false;
  if (type === 'link' || type === 'text' || type === 'multi') return false;
  if (reference.startsWith('http') && !reference.includes('s3://')) return false;
  return true;
}

async function fetchPresignedUrl(assetName, reference) {
  const url = `${PRESIGN_BASE}/${encodeURIComponent(assetName)}?reference=${encodeURIComponent(reference)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Presign failed: ${resp.status}`);
  const text = await resp.text();
  try {
    const data = JSON.parse(text);
    if (!data.url) throw new Error('No url in response');
    return data.url;
  } catch (e) {
    throw new Error(`Presign returned invalid response: ${text.slice(0, 100)}`);
  }
}

function applyPresignedUrl(el, tagName, assetName, reference) {
  fetchPresignedUrl(assetName, reference)
    .then(signed => { el.src = signed; })
    .catch((e) => {
      console.error('Presign error for', reference, e);
      const err = document.createElement('p');
      err.className = 'qc-media-error';
      err.textContent = 'Failed to load media (access denied or not found).';
      el.replaceWith(err);
    });
}

export function renderMedia(reference, s3Bucket, s3Prefix, assetName, rawS3Loc = '') {
  if (!reference) {
    const empty = document.createElement('div');
    return empty;
  }

  if (reference.includes(';')) {
    const parts = reference.split(';').map(s => s.trim()).filter(Boolean);
    // Two-image comparisons render as a swipe/slider overlay (matches Panel's pn.layout.Swipe).
    if (parts.length === 2) {
      const resolved = parts.map(p => resolveReference(p, s3Bucket, s3Prefix, rawS3Loc));
      if (resolved.every(r => r.type === 'image')) {
        return buildSwipe(parts, resolved, s3Bucket, assetName);
      }
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'qc-media-multi';
    for (const part of parts) {
      wrapper.appendChild(renderMedia(part, s3Bucket, s3Prefix, assetName, rawS3Loc));
    }
    return wrapper;
  }

  const { url, type } = resolveReference(reference, s3Bucket, s3Prefix, rawS3Loc);
  const presign = needsPresign(reference, s3Bucket, type);

  const wrapper = document.createElement('div');
  wrapper.className = 'qc-media';

  if (type === 'image') {
    const img = document.createElement('img');
    img.src = presign ? '' : url;
    img.loading = 'lazy';
    img.alt = reference;
    wrapper.appendChild(img);
    wrapper.appendChild(buildFullscreenBtn(img));
    if (presign) applyPresignedUrl(img, 'img', assetName, reference);
  } else if (type === 'video') {
    const video = document.createElement('video');
    video.src = presign ? '' : url;
    video.controls = true;
    wrapper.appendChild(video);
    wrapper.appendChild(buildFullscreenBtn(video));
    if (presign) applyPresignedUrl(video, 'video', assetName, reference);
  } else if (type === 'pdf' || type === 'iframe') {
    const iframe = document.createElement('iframe');
    iframe.src = presign ? '' : url;
    iframe.setAttribute('allowfullscreen', '');
    wrapper.appendChild(iframe);
    wrapper.appendChild(buildFullscreenBtn(iframe));
    if (presign) applyPresignedUrl(iframe, 'iframe', assetName, reference);
  } else if (type === 'h5') {
    // Volumetric HDF5 data: the Panel app has an interactive z-slice viewer; the read-only
    // web view shows a message plus a link to the file.
    const msg = document.createElement('p');
    msg.className = 'qc-media-h5';
    msg.textContent = 'Volumetric data (HDF5) — open in edit mode to view slices. ';
    const a = document.createElement('a');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Download file';
    if (presign) {
      a.href = '#';
      fetchPresignedUrl(assetName, reference).then(signed => { a.href = signed; }).catch(() => { a.textContent = 'File unavailable'; });
    } else {
      a.href = url;
    }
    msg.appendChild(a);
    wrapper.appendChild(msg);
  } else if (type === 'link') {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open reference';
    wrapper.appendChild(a);
  } else {
    const p = document.createElement('p');
    p.textContent = reference;
    wrapper.appendChild(p);
  }

  return wrapper;
}

function buildFullscreenBtn(el) {
  const btn = document.createElement('button');
  btn.className = 'qc-fullscreen-btn';
  btn.title = 'Full screen';
  btn.textContent = '⛶';
  btn.addEventListener('click', () => {
    if (el.requestFullscreen) el.requestFullscreen();
  });
  return btn;
}

/**
 * Draggable image-comparison overlay for a two-image (semicolon-separated) reference,
 * matching the Panel app's pn.layout.Swipe.
 */
function buildSwipe(references, resolved, s3Bucket, assetName) {
  const wrapper = document.createElement('div');
  wrapper.className = 'qc-media qc-swipe';

  const imgs = resolved.map((r, i) => {
    const img = document.createElement('img');
    const presign = needsPresign(references[i], s3Bucket, r.type);
    img.src = presign ? '' : r.url;
    img.loading = 'lazy';
    img.alt = references[i];
    if (presign) applyPresignedUrl(img, 'img', assetName, references[i]);
    return img;
  });

  // imgs[0] is the base (fills flow and defines size); imgs[1] overlays it, clipped from the left.
  imgs[0].className = 'qc-swipe-base';
  imgs[1].className = 'qc-swipe-overlay';

  const handle = document.createElement('div');
  handle.className = 'qc-swipe-handle';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.className = 'qc-swipe-slider';

  const setPos = (pct) => {
    imgs[1].style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    handle.style.left = `${pct}%`;
  };
  slider.addEventListener('input', () => setPos(Number(slider.value)));

  wrapper.appendChild(imgs[0]);
  wrapper.appendChild(imgs[1]);
  wrapper.appendChild(handle);
  wrapper.appendChild(slider);
  setPos(50);
  return wrapper;
}
