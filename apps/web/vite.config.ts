/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_URL || 'http://localhost:3000';
const sinkTarget = process.env.VITE_SINK_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/v1': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/readyz': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/healthz': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/sink': {
        target: sinkTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sink/, ''),
      },
    },
  },
});
