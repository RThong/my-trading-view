import { useState } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { VolatilityPanel } from './panels/VolatilityPanel';
import { MacroPanel } from './panels/MacroPanel';
import { IndicesPanel } from './panels/IndicesPanel';
import { AssetsPanel } from './panels/AssetsPanel';

const TABS = [
  { id: 'volatility', label: 'Volatility' },
  { id: 'macro',      label: 'Macro / Rates' },
  { id: 'indices',    label: 'Indices' },
  { id: 'assets',     label: 'Other Assets' },
];

export function App() {
  const [days, setDays] = useState(1825);
  const [tab, setTab] = useState('volatility');

  return (
    <div className="flex h-screen flex-col">
      <Header days={days} onDaysChange={setDays} />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full w-full rounded border border-neutral-800 p-3">
          {tab === 'volatility' && <VolatilityPanel days={days} />}
          {tab === 'macro'      && <MacroPanel days={days} />}
          {tab === 'indices'    && <IndicesPanel days={days} />}
          {tab === 'assets'     && <AssetsPanel days={days} />}
        </div>
      </main>
    </div>
  );
}
