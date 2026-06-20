import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { OptionsPanel } from './panels/OptionsPanel';
import type { Interval } from './hooks/interval';

const TABS = [
  { id: 'options-spy', label: 'SPY Options (25Δ)' },
  { id: 'options-vix', label: 'VIX Options (25Δ)' },
  { id: 'options-btc', label: 'BTC Options (25Δ)' },
];

export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const [tab, setTab] = useState('options-spy');

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full w-full rounded border border-neutral-800 p-3">
          {tab === 'options-spy' && <OptionsPanel interval={interval} underlying="SPY" />}
          {tab === 'options-vix' && <OptionsPanel interval={interval} underlying=".VIX" />}
          {tab === 'options-btc' && <OptionsPanel interval={interval} underlying="BTC" />}
        </div>
      </main>
    </div>
  );
}
