import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api and /uploads to the backend so the client uses same-origin URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    // Dedicated port for CRMCTS so it never collides with other local apps
    // (e.g. the Spares-IMS project uses 5173). strictPort makes the URL stable.
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4100', changeOrigin: true },
      '/uploads': { target: 'http://localhost:4100', changeOrigin: true },
    },
  },
});
