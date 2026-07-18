import { StatusLight } from './StatusLight';
import type { Interval } from '../hooks/interval';

const INTERVALS: Interval[] = ['1D', '1W', '1M', '1Q', '1Y'];

type HeaderProps = {
  interval: Interval;
  onIntervalChange: (i: Interval) => void;
};

export function Header({ interval, onIntervalChange }: HeaderProps) {
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-6 py-3">
      <StatusLight />
      <h1 className="text-lg font-semibold">My Trading View</h1>
      <div className="ml-auto flex items-center gap-1">
        {INTERVALS.map((i) => (
          <button
            key={i}
            onClick={() => onIntervalChange(i)}
            className={
              'rounded px-3 py-1 text-sm ' +
              (i === interval ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-800')
            }
          >
            {i}
          </button>
        ))}
      </div>
    </header>
  );
}
