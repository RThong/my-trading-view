import { useState } from 'react';
import { CalendarIcon } from 'lucide-react';
import { Calendar } from './ui/calendar';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

// YYYY-MM-DD <-> Date(本地日历日,避免 UTC 偏移)。
function toISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromISO(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

type Props = {
  value: string; // YYYY-MM-DD
  presets: { label: string; date: string }[];
  min: string;
  max: string;
  snap: (target: string) => string | null; // 贴到最近交易日
  onChange: (date: string) => void;
};

/** 融合「预设 + 日历」的日期选择器:一个弹层里左预设、右日历(shadcn Popover + Calendar)。 */
export function DatePickerWithPresets({ value, presets, min, max, snap, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const preset = presets.find((p) => p.date === value);
  const selected = fromISO(value);

  const pick = (iso: string | null) => {
    if (iso) {
      onChange(iso);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200 hover:bg-neutral-800">
        <CalendarIcon className="h-3.5 w-3.5 text-neutral-400" />
        <span className="whitespace-nowrap">{preset ? `${preset.label} · ${value}` : value}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto flex-row gap-1 p-2">
        <div className="flex flex-col gap-0.5">
          {presets.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="xs"
              onClick={() => pick(p.date)}
              className={`justify-start ${p.date === value ? 'bg-muted text-white hover:bg-muted' : ''}`}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="border-l border-neutral-800 pl-1">
          <Calendar
            mode="single"
            captionLayout="dropdown"
            fixedWeeks
            selected={selected}
            defaultMonth={selected}
            startMonth={fromISO(min)}
            endMonth={fromISO(max)}
            disabled={{ before: fromISO(min), after: fromISO(max) }}
            onSelect={(d) => d && pick(snap(toISO(d)))}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
