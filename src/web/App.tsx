import { useState } from 'react';
import { Header } from './components/Header';
import { VolatilityPanel } from './panels/VolatilityPanel';
import { MacroPanel } from './panels/MacroPanel';
import { IndicesPanel } from './panels/IndicesPanel';
import { AssetsPanel } from './panels/AssetsPanel';

export function App() {
  const [days, setDays] = useState(180);
  return (
    <div className="min-h-screen">
      <Header days={days} onDaysChange={setDays} />
      <main className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
        <VolatilityPanel days={days} />
        <MacroPanel days={days} />
        <IndicesPanel days={days} />
        <AssetsPanel days={days} />
      </main>
    </div>
  );
}
