/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// GitHub Pages serves the app from /SHED/; locally and in tests it lives at /.
// The deploy workflow sets SHED_BASE=/SHED/.
export default defineConfig({
  base: process.env.SHED_BASE ?? '/',
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
