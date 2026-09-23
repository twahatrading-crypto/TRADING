import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5180 },
  preview: { host: true, port: 4180 },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          chart: ['lightweight-charts'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
