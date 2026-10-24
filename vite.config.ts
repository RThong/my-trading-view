import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // 写死 IPv4:API 只监听 127.0.0.1,localhost 在 macOS 可能先解析成 ::1 而连不上
      '/api': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
