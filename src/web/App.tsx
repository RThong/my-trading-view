import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { AssetChart } from './panels/AssetChart';
import type { Interval } from './hooks/interval';

// 一个资产一个 tab,tab 名即资产名;该资产的所有期权指标都在这个 tab 内。
const TABS = [
  { id: 'spy', label: 'SPY', underlying: 'SPY', vrpUnderlying: 'SPY' },
  { id: 'vix', label: 'VIX', underlying: '.VIX' },
  { id: 'btc', label: 'BTC', underlying: 'BTC', vrpUnderlying: 'BTC' },
  // SOXX/IGV 只做 25Δ(无 VIX 式隐含波动率指数,不做 VRP)
  { id: 'soxx', label: 'SOXX', underlying: 'SOXX' },
  { id: 'igv', label: 'IGV', underlying: 'IGV' },
];

export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const [tab, setTab] = useState('spy');
  // keep-alive:访问过的 tab 各挂一个 AssetChart 不再卸载,切回来保留显隐/顺序/缩放等内存状态。
  const [seen, setSeen] = useState<Set<string>>(() => new Set(['spy']));
  const selectTab = (t: string) => {
    setTab(t);
    setSeen((s) => (s.has(t) ? s : new Set(s).add(t)));
  };

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <TabBar tabs={TABS} active={tab} onChange={selectTab} />
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full w-full rounded border border-neutral-800 p-3">
          {TABS.filter((t) => seen.has(t.id)).map((t) => (
            // 非活跃 tab 用 hidden 藏起来(实例和状态都还在,只是不渲染像素)。
            <div key={t.id} className={t.id === tab ? 'h-full' : 'hidden'}>
              <AssetChart interval={interval} underlying={t.underlying} vrpUnderlying={t.vrpUnderlying} />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
