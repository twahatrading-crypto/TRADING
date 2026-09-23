import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 5181/4181: TLUXE's own ports (5180 belongs to another project). strictPort: fail loudly instead of drifting.
  server: { host: true, port: 5181, strictPort: true },
  preview: { host: true, port: 4181, strictPort: true },
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
