import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // 端口读项目根的 .env(WEB_PORT / API_PORT,多个 worktree 同时开 dev server 时错开);root 是 src/web,所以显式指根目录
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const apiPort = env.API_PORT ?? '3000';

  return {
    root: 'src/web',
    plugins: [react(), tailwindcss()],
    // 与 tsconfig 的 paths 对齐:shadcn CLI 生成的组件按 @web/... 引用
    resolve: { alias: { '@web': fileURLToPath(new URL('./src/web', import.meta.url)) } },
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      // 端口被占就报错,别悄悄换成下一个(render-chart 按 WEB_PORT 找页面)
      strictPort: true,
      proxy: {
        // 写死 IPv4:API 只监听 127.0.0.1,localhost 在 macOS 可能先解析成 ::1 而连不上
        '/api': `http://127.0.0.1:${apiPort}`,
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
  };
});
