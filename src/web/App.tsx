import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { AssetView } from './panels/AssetView';
import type { Interval } from './hooks/interval';

// 一个资产一个 tab,tab 名即资产名;该资产的所有期权指标都在这个 tab 内。
const TABS = [
  { id: 'spy', label: 'SPY' },
  { id: 'vix', label: 'VIX' },
  { id: 'btc', label: 'BTC' },
];

export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const [tab, setTab] = useState('spy');

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full w-full rounded border border-neutral-800 p-3">
          {tab === 'spy' && <AssetView interval={interval} underlying="SPY" vrpUnderlying="SPY" />}
          {tab === 'vix' && <AssetView interval={interval} underlying=".VIX" />}
          {tab === 'btc' && <AssetView interval={interval} underlying="BTC" vrpUnderlying="BTC" />}
        </div>
      </main>
    </div>
  );
}
