import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { VolatilityPanel } from './panels/VolatilityPanel';
import { MacroPanel } from './panels/MacroPanel';
import { IndicesPanel } from './panels/IndicesPanel';
import { AssetsPanel } from './panels/AssetsPanel';
import { OptionsPanel } from './panels/OptionsPanel';
import type { Interval } from './hooks/useChartData';

const TABS = [
  { id: 'volatility', label: 'Volatility' },
  { id: 'macro',      label: 'Macro / Rates' },
  { id: 'indices',    label: 'Indices' },
  { id: 'assets',     label: 'Other Assets' },
  { id: 'options-spy', label: 'SPY Options (25Δ)' },
  { id: 'options-vix', label: 'VIX Options (25Δ)' },
  { id: 'options-btc', label: 'BTC Options (25Δ)' },
];

export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const [tab, setTab] = useState('volatility');

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full w-full rounded border border-neutral-800 p-3">
          {tab === 'volatility' && <VolatilityPanel interval={interval} />}
          {tab === 'macro'      && <MacroPanel interval={interval} />}
          {tab === 'indices'    && <IndicesPanel interval={interval} />}
          {tab === 'assets'     && <AssetsPanel interval={interval} />}
          {tab === 'options-spy' && <OptionsPanel interval={interval} underlying="SPY" />}
          {tab === 'options-vix' && <OptionsPanel interval={interval} underlying=".VIX" />}
          {tab === 'options-btc' && <OptionsPanel interval={interval} underlying="BTC" />}
        </div>
      </main>
    </div>
  );
}
