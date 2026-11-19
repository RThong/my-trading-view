import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { PERSPECTIVES } from './perspectives';
import { usePerspectiveNavigation } from './hooks/usePerspectiveNavigation';
import { useOpenInEditor } from './views/chartDoc/openInEditor';
import { useBackGuard } from './hooks/useBackGuard';
import { CustomTabBar } from './pages/custom/CustomTabBar';
import { CustomTabPage } from './pages/custom/CustomTabPage';
import { useCustomTabs } from './pages/custom/useCustomTabs';
import type { Interval } from './hooks/interval';

// 外壳:Header + 竖 tab(视角)+ 横 tab + keep-alive 内容区。视角/tab 配置见 pages/<视角>/index(perspectives.tsx 组装),
// 导航状态见 usePerspectiveNavigation;自建 tab(界面上增删改的)见 pages/custom,竖栏里接在内置的下面。App 只负责组装与渲染。
export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const { perspId, persp, activeTab, seen, selectPersp, selectTab } = usePerspectiveNavigation(PERSPECTIVES);
  const custom = useCustomTabs();
  const pickBuiltin = (id: string) => {
    custom.leave();
    selectPersp(id);
  };
  // 固定面板点了「在编辑器中打开」:跳到图表编辑页(图由编辑器自己接)
  useOpenInEditor(() => pickBuiltin('editor'));
  // 浏览器后退(触摸板左滑等)先弹窗确认,不直接离开看板
  useBackGuard();

  const builtinKey = custom.persp ? null : `${perspId}:${activeTab}`;

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-none flex-col gap-1 overflow-y-auto border-r border-neutral-800 px-2 py-3">
          <TabBar tabs={PERSPECTIVES} active={custom.persp ? '' : perspId} onChange={pickBuiltin} vertical />
          <div className="border-t border-neutral-800 pt-1">
            <CustomTabBar
              vertical
              noun="视角"
              items={custom.store.perspectives}
              active={custom.persp?.id}
              onSelect={custom.selectPersp}
              onAdd={custom.addPersp}
              onRename={custom.renamePersp}
              onRemove={custom.removePersp}
            />
          </div>
        </div>
        <div className="flex flex-1 flex-col min-h-0">
          {custom.persp ? (
            <div className="border-b border-neutral-800 px-6 py-2">
              <CustomTabBar
                noun="标签"
                items={custom.persp.tabs}
                active={custom.activeTab}
                onSelect={custom.selectTab}
                onAdd={custom.addTab}
                onRename={custom.renameTab}
                onRemove={custom.removeTab}
              />
            </div>
          ) : (
            <TabBar tabs={persp.tabs} active={activeTab} onChange={selectTab} />
          )}
          <main className="flex-1 p-4 min-h-0">
            <div className="h-full w-full rounded border border-neutral-800 p-3">
              {PERSPECTIVES.flatMap((p) =>
                p.tabs
                  .filter((t) => seen.has(`${p.id}:${t.id}`))
                  .map((t) => {
                    const key = `${p.id}:${t.id}`;
                    // 非活跃的用 hidden 藏起来(实例和状态都还在,只是不渲染像素)。
                    return (
                      <div key={key} className={key === builtinKey ? 'h-full' : 'hidden'}>
                        {t.render(interval)}
                      </div>
                    );
                  }),
              )}
              {custom.store.perspectives.flatMap((p) =>
                p.tabs
                  .filter((t) => custom.mounted(t.id))
                  .map((t) => (
                    <div key={t.id} className={t.id === custom.activeTab ? 'h-full' : 'hidden'}>
                      <CustomTabPage tab={t} interval={interval} onChange={(fn) => custom.editTab(p.id, t.id, fn)} />
                    </div>
                  )),
              )}
              {custom.persp?.tabs.length === 0 && (
                <p className="text-sm text-neutral-500">这个视角还没有标签,点上方 + 新建。</p>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
