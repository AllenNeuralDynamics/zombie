/** Assets used only by the BCI task-state animation. */

export function loadMouseSprite(url = '/images/df/mouse_head_dorsal.png') {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      console.warn('[BCI] mouse sprite failed to load');
      resolve(null);
    };
    image.src = url;
  });
}
