import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * SharedArrayBuffer is what lets the mesher workers read neighbouring chunks
 * directly, which in turn is what makes cross-chunk light propagation correct
 * without copying a padded neighbourhood per job. It requires cross-origin
 * isolation, hence the two headers below.
 *
 * The engine falls back to a time-sliced single-threaded pipeline when SAB is
 * unavailable (for example when the built output is opened over file://), so
 * these headers are an optimisation, not a hard requirement.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        // The material contact sheet is a development tool, but it has to
        // survive the build to be usable against a preview server.
        main: resolve(__dirname, 'index.html'),
        materials: resolve(__dirname, 'materials.html'),
      },
    },
  },
});
