import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';


const BACKEND_TARGET = process.env.VITE_BACKEND_URL || 'http://localhost:5000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: BACKEND_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
