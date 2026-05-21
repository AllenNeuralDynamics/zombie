import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Serve the `web/` directory as the project root during dev
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Forward /docdb/* to the local Python proxy on :3001 (avoids CORS;
      // the proxy reaches the internal-network AIND API server-side).
      '/docdb': {
        target: 'http://localhost:3001',
        rewrite: (path) => path.replace(/^\/docdb/, ''),
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
    },
  },

  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        explore: resolve(__dirname, 'explore.html'),
        assets: resolve(__dirname, 'assets.html'),
        contributions: resolve(__dirname, 'contributions.html'),
        subject: resolve(__dirname, 'subject.html'),
        project: resolve(__dirname, 'project.html'),
        smartspim: resolve(__dirname, 'smartspim.html'),
        coordinate_system_builder: resolve(__dirname, 'coordinate_system_builder.html'),
        sessions: resolve(__dirname, 'sessions.html'),
        quality_control: resolve(__dirname, 'quality_control.html'),
        fiber_photometry: resolve(__dirname, 'fiber_photometry.html'),
      },
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
