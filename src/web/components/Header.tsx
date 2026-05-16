import { StatusLight } from './StatusLight';

const RANGES = [
  { label: '90D',  days: 90 },
  { label: '180D', days: 180 },
  { label: '1Y',   days: 365 },
  { label: 'All',  days: 1825 },
];

type HeaderProps = {
  days: number;
  onDaysChange: (d: number) => void;
};

export function Header({ days, onDaysChange }: HeaderProps) {
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-6 py-3">
      <StatusLight />
      <h1 className="text-lg font-semibold">My Trading View</h1>
      <div className="ml-auto flex items-center gap-1">
        {RANGES.map(r => (
          <button
            key={r.label}
            onClick={() => onDaysChange(r.days)}
            className={
              'rounded px-3 py-1 text-sm ' +
              (r.days === days
                ? 'bg-neutral-700 text-white'
                : 'text-neutral-400 hover:text-white hover:bg-neutral-800')
            }
          >
            {r.label}
          </button>
        ))}
      </div>
    </header>
  );
}
