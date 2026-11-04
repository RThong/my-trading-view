import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  // 与 tsconfig 的 paths 对齐:shadcn CLI 生成的组件按 @web/... 引用
  resolve: { alias: { '@web': fileURLToPath(new URL('./src/web', import.meta.url)) } },
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
    // 首屏必用的第三方库按库拆成独立文件:总量不变,但主包降到告警线下,改业务代码时这几块的缓存不失效。
    // 只点名首屏和懒加载 chunk 都要用的大库。分组会把命中的模块全部吸进来,不管是谁在用:
    // 写 /node_modules/ 会把懒加载的日历(react-day-picker / date-fns)拉回首屏;
    // 再加一组 UI 库(@base-ui / lucide)实测首屏 +50KB —— 编辑器专用的 combobox、图标被提前加载了。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'charts', test: /node_modules[\\/](lightweight-charts|fancy-canvas)[\\/]/ },
          ],
        },
      },
    },
  },
});
