import { useEffect, useState } from 'react';

/** Zombie sets `data-theme="light"|"dark"` on <html> (absent = follow the OS). */
function resolveDarkMode() {
  const theme = document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme');
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useDarkMode() {
  const [isDark, setIsDark] = useState(resolveDarkMode);

  useEffect(() => {
    const update = () => setIsDark(resolveDarkMode());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);

  return isDark;
}
