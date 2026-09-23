import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // TLUXE's own ports. strictPort: fail loudly instead of drifting to a port another app may use.
  // open: false: never launch a browser automatically; open http://localhost:5181 yourself.
  server: { host: true, port: 5181, strictPort: true, open: false },
  preview: { host: true, port: 4181, strictPort: true, open: false },
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
