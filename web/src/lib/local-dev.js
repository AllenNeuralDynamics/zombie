const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalDevelopment({
  hostname = typeof window === 'undefined' ? '' : window.location.hostname,
  devMode = import.meta.env.DEV,
} = {}) {
  const normalizedHostname = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  const isLocalhost = LOCAL_HOSTNAMES.has(normalizedHostname)
    || normalizedHostname.endsWith('.localhost');
  return Boolean(devMode && isLocalhost);
}
