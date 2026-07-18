import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { PERSPECTIVES } from './perspectives';
import { usePerspectiveNavigation } from './hooks/usePerspectiveNavigation';
import type { Interval } from './hooks/interval';

// 外壳:Header + 竖 tab(视角)+ 横 tab + keep-alive 内容区。视角/tab 配置见 perspectives.tsx,
// 导航状态见 usePerspectiveNavigation;App 只负责组装与渲染。
export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const { perspId, persp, activeTab, seen, selectPersp, selectTab } = usePerspectiveNavigation(PERSPECTIVES);

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <div className="flex flex-1 min-h-0">
        <TabBar tabs={PERSPECTIVES} active={perspId} onChange={selectPersp} vertical />
        <div className="flex flex-1 flex-col min-h-0">
          <TabBar tabs={persp.tabs} active={activeTab} onChange={selectTab} />
          <main className="flex-1 p-4 min-h-0">
            <div className="h-full w-full rounded border border-neutral-800 p-3">
              {PERSPECTIVES.flatMap((p) =>
                p.tabs
                  .filter((t) => seen.has(`${p.id}:${t.id}`))
                  .map((t) => {
                    const key = `${p.id}:${t.id}`;
                    // 非活跃的用 hidden 藏起来(实例和状态都还在,只是不渲染像素)。
                    return (
                      <div key={key} className={key === `${perspId}:${activeTab}` ? 'h-full' : 'hidden'}>
                        {t.render(interval)}
                      </div>
                    );
                  }),
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
