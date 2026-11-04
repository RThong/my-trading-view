import { StatusLight } from './StatusLight';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
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
      {/* Base UI 的 ToggleGroup 是多值数组语义:再点已选中的那个会清成空数组。周期必须有一个,空值直接忽略 */}
      <ToggleGroup
        aria-label="K 线周期"
        spacing={1}
        className="ml-auto"
        value={[interval]}
        onValueChange={(v) => v[0] && onIntervalChange(v[0] as Interval)}
      >
        {INTERVALS.map((i) => (
          <ToggleGroupItem
            key={i}
            value={i}
            className="h-auto min-w-0 rounded px-3 py-1 font-normal text-neutral-400 hover:bg-neutral-800 hover:text-white aria-pressed:bg-neutral-700 aria-pressed:text-white aria-pressed:hover:bg-neutral-700"
          >
            {i}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </header>
  );
}
