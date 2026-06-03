import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: true,
  minify: false,
  sourcemap: false,
  // Bundle everything into one file so the shipped CLI has no relative-import
  // extension issues and runs straight from dist/index.js.
  bundle: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
