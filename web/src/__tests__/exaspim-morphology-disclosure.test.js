// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createExaSpimMorphologySection } from '../exaspim/morphology.js';
vi.mock('../exaspim/projection2d-view.js', () => ({
  createProjection2DView: () => ({ el: document.createElement('div') }),
}));
afterEach(() => {
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
