import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development, Vite runs on :5173 and forwards /api calls to the Node server on :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
