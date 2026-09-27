import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `--mode cloud` (npm run build:cloud / dev:cloud) builds the gateway-served bundle: every backend call goes to the
// TLUXE gateway on the same origin (see src/config/deployment.ts). The default mode is the unchanged local setup.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: mode === 'cloud' ? { 'import.meta.env.VITE_TLUXE_DEPLOYMENT': JSON.stringify('cloud') } : {},
  // TLUXE's own ports. strictPort: fail loudly instead of drifting to a port another app may use.
  // open: false: never launch a browser automatically; open http://localhost:5182 yourself.
  server: {
    host: true,
    port: 5182,
    strictPort: true,
    open: false,
    // dev:cloud only: a locally running gateway (127.0.0.1:8780) behind the same origin, like production.
    ...(mode === 'cloud' ? { proxy: { '/api': { target: 'http://127.0.0.1:8780', ws: true, changeOrigin: false } } } : {}),
  },
  preview: { host: true, port: 4181, strictPort: true, open: false },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          chart: ['lightweight-charts'],
          react: ['react', 'react-dom', 'react-dom/client', 'scheduler'],
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
}));
