import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { AssetChart } from './panels/AssetChart';
import type { Interval } from './hooks/interval';

// 一个资产一个 tab,tab 名即资产名;该资产的所有期权指标都在这个 tab 内。
const TABS = [
  { id: 'spy', label: 'SPY' },
  { id: 'vix', label: 'VIX' },
  { id: 'btc', label: 'BTC' },
  { id: 'soxx', label: 'SOXX' },
  { id: 'igv', label: 'IGV' },
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
          {tab === 'spy' && <AssetChart interval={interval} underlying="SPY" vrpUnderlying="SPY" />}
          {tab === 'vix' && <AssetChart interval={interval} underlying=".VIX" />}
          {tab === 'btc' && <AssetChart interval={interval} underlying="BTC" vrpUnderlying="BTC" />}
          {/* SOXX/IGV 只做 25Δ(无 VIX 式隐含波动率指数,不做 VRP) */}
          {tab === 'soxx' && <AssetChart interval={interval} underlying="SOXX" />}
          {tab === 'igv' && <AssetChart interval={interval} underlying="IGV" />}
        </div>
      </main>
    </div>
  );
}
