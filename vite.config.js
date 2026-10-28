import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, API calls go to the Express server (npm run dev:server).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } }
});
