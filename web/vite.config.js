import { defineConfig } from 'vite';
import { resolve, basename } from 'path';
import react from '@vitejs/plugin-react';
import { PAGES, renderHeader, renderThemeInit } from './build/header-template.js';
import { ROUTES } from './build/routes.js';

/**
 * Inject shared page-shell fragments — the app header and the pre-paint
 * theme initializer — into pages that contain the corresponding placeholder,
 * so this markup lives in one source file instead of being hand-copied into
 * every HTML page. Runs in both dev and build.
 */
function sharedHeaderPlugin() {
  return {
    name: 'shared-header',
    transformIndexHtml(html, ctx) {
      let out = html;
      if (out.includes('<!--THEME_INIT-->')) {
        out = out.replace('<!--THEME_INIT-->', renderThemeInit());
      }
      if (out.includes('<!--APP_HEADER-->')) {
        // Try the relative path first (e.g. 'migrate/submit.html'), fall back
        // to basename to keep existing top-level pages working.
        const rel = ctx.path.replace(/^\/+/, '');
        const page = PAGES[rel] ?? PAGES[basename(ctx.path)];
        if (page) out = out.replace('<!--APP_HEADER-->', renderHeader(page));
      }
      return out;
    },
  };
}

export default defineConfig({
  // The React plugin is scoped to .jsx/.tsx only so it never runs Babel over the
  // Preact + htm (.js) code that makes up the rest of the app.
  plugins: [sharedHeaderPlugin(), react({ include: /\.(jsx|tsx)$/ })],
  // Serve the `web/` directory as the project root during dev
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Forward /metadata-service/* → docdb_proxy.py, which calls
      // https://aind-metadata-service/* (internal-only, self-signed cert).
      '/metadata-service': {
        target: 'http://localhost:3001',
      },
      // Forward /log-server/* → docdb_proxy.py, which connects to
      // the eng-logtools MySQL server.
      '/log-server': {
        target: 'http://localhost:3001',
      },
      // Forward /s3-list → docdb_proxy.py, which lists images under a public
      // S3 prefix for the /analysis-framework dashboard. (The DocDB query is
      // made directly from the browser; only S3 listing needs a proxy because
      // those buckets have no CORS policy.)
      '/s3-list': {
        target: 'http://localhost:3001',
      },
      '/qc-presign': {
        target: 'https://qc.allenneuraldynamics.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/qc-presign/, ''),
      },
      // Forward /metadata-viz/* to the aind-metadata-viz Tornado server on :8000.
      '/metadata-viz': {
        target: 'http://localhost:8000',
        rewrite: (path) => path.replace(/^\/metadata-viz/, ''),
      },
      // Dev proxy for metadata portal upgrade endpoint.
      // Remove this entry before deploying; nginx handles it in production.
      '/metadata-portal': {
        target: 'http://localhost:5006',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/metadata-portal/, ''),
      },
      // Janelia MouseLight API proxy (ExaSPIM morphology viewer). The browser
      // can't call ml-neuronbrowser.janelia.org directly — its /tracings
      // endpoint omits CORS headers — so we proxy /mouselight/* here (dev) and
      // in nginx (prod), stripping the prefix before forwarding.
      '/mouselight': {
        target: 'https://ml-neuronbrowser.janelia.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mouselight/, ''),
      },
    },
  },

  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      // Build targets are derived from the route manifest (build/routes.js)
      // instead of being hand-maintained here, so adding a page only means
      // adding one manifest entry.
      input: Object.fromEntries(
        ROUTES.map((r) => [r.inputKey, resolve(__dirname, r.html)]),
      ),
    },
  },

  test: {
    // Vitest config lives here so we don't need a separate vitest.config.js
    // Pure-function tests (metadata, constants) don't require DOM APIs.
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      exclude: ['src/app.js'],       // app.js wires DOM; tested via e2e, not unit
    },
  },
});
