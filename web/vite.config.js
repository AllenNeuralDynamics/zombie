import { defineConfig } from 'vite';

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
      // Forward /data-asset-cache/* to the public S3 bucket (avoids CORS
      // in development; production uses the direct S3 URL).
      '/data-asset-cache': {
        target: 'https://allen-data-views.s3.us-west-2.amazonaws.com',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: '../dist',
    emptyOutDir: true,
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
