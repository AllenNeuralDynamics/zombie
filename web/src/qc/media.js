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

export function renderMedia(reference, s3Bucket, s3Prefix, assetName) {
  if (!reference) {
    const empty = document.createElement('div');
    return empty;
  }

  if (reference.includes(';')) {
    const parts = reference.split(';').map(s => s.trim()).filter(Boolean);
    const wrapper = document.createElement('div');
    wrapper.className = 'qc-media-multi';
    for (const part of parts) {
      wrapper.appendChild(renderMedia(part, s3Bucket, s3Prefix, assetName));
    }
    return wrapper;
  }

  const { url, type } = resolveReference(reference, s3Bucket, s3Prefix);
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
    if (presign) applyPresignedUrl(video, 'video', assetName, reference);
  } else if (type === 'pdf' || type === 'iframe') {
    const iframe = document.createElement('iframe');
    iframe.src = presign ? '' : url;
    iframe.setAttribute('allowfullscreen', '');
    wrapper.appendChild(iframe);
    if (presign) applyPresignedUrl(iframe, 'iframe', assetName, reference);
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

function buildFullscreenBtn(img) {
  const btn = document.createElement('button');
  btn.className = 'qc-fullscreen-btn';
  btn.title = 'Full screen';
  btn.textContent = '⛶';
  btn.addEventListener('click', () => {
    if (img.requestFullscreen) img.requestFullscreen();
  });
  return btn;
}
