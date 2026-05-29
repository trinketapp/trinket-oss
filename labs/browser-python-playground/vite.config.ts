import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 3100
  },
  preview: {
    host: '127.0.0.1',
    port: 3100
  }
});
