import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist' },
});
