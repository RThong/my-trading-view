import { Component, type ReactNode, Suspense } from 'react';
import { Button } from './ui/button';

// 懒加载块(React.lazy)的外壳:Suspense 管「还在加载」,错误边界管「加载失败」。
// 没有错误边界时,chunk 下载失败(页面开着时重新 vite build 删了旧文件、断网)会让 React 卸载整棵树 —— 整页白屏。
// 失败后只能整页刷新:React.lazy 会缓存那次失败的 import,原地重试拿到的还是同一个失败。
export function LazyBoundary({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}

class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-neutral-400">
        这部分没加载出来(可能刚重新构建过,或网络断了)。
        <Button variant="outline" size="xs" onClick={() => location.reload()}>
          刷新页面
        </Button>
      </div>
    );
  }
}
