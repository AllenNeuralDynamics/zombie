// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createExaSpimMorphologySection } from '../exaspim/morphology.js';
vi.mock('../exaspim/projection2d-view.js', () => ({
  createProjection2DView: () => ({ el: document.createElement('div') }),
}));
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it('starts collapsed, initializes only on opening, and keeps the viewer when reopened', () => {
  const fetchMock = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController();
  const section = createExaSpimMorphologySection({ signal: controller.signal });
  expect(section.tagName).toBe('DETAILS');
  expect(section.open).toBe(false);
  expect(section.querySelector('iframe')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  section.open = true;
  section.dispatchEvent(new Event('toggle'));
  const iframe = section.querySelector('iframe');
  expect(iframe).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  section.open = false;
  section.dispatchEvent(new Event('toggle'));
  section.open = true;
  section.dispatchEvent(new Event('toggle'));
  expect(section.querySelector('iframe')).toBe(iframe);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  controller.abort();
});

it('restores both open and closed states across page visits', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const first = createExaSpimMorphologySection(options);
  first.open = true;
  first.dispatchEvent(new Event('toggle'));
  const restored = createExaSpimMorphologySection(options);
  expect(restored.open).toBe(true);
  expect(restored.querySelector('iframe')).not.toBeNull();
  restored.open = false;
  restored.dispatchEvent(new Event('toggle'));
  const closed = createExaSpimMorphologySection(options);
  expect(closed.open).toBe(false);
  expect(closed.querySelector('iframe')).toBeNull();
  controller.abort();
});

it('defaults closed for invalid or unavailable storage and still allows opening', () => {
  localStorage.setItem('zombie.exaspim.morphologyExpanded', 'invalid');
  expect(createExaSpimMorphologySection().open).toBe(false);
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const controller = new AbortController();
  const section = createExaSpimMorphologySection({ signal: controller.signal });
  expect(section.open).toBe(false);
  section.open = true;
  expect(() => section.dispatchEvent(new Event('toggle'))).not.toThrow();
  expect(section.querySelector('iframe')).not.toBeNull();
  controller.abort();
});
