// 取色器(图层卡片的线色、画线浮条的颜色共用),照 TradingView:点色块弹层,固定色板点一下就选、弹层关掉。
// 系统原生取色器靠拖,每次取的线色都差一点;固定色板同一格永远是同一个值。
// 顶上一行是这张图在用的颜色(见 usedColors),底下是自己加过的颜色(存 localStorage,只是偏好)
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { SWATCH_ROWS } from '../../../chart/palette';
import { cn } from '../../../lib/utils';

const CUSTOM_KEY = 'mtv:colorPicker:custom';
// 同 TV 自定义那一行:一行 10 格,新加的排最前、挤掉最旧的
const MAX_CUSTOM = 10;
const HEX = /^#[0-9a-f]{6}$/i;

function loadCustom(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c) => typeof c === 'string' && HEX.test(c)) : [];
  } catch {
    return [];
  }
}

function saveCustom(list: string[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式存不上:本次会话照常 */
  }
}

function Swatch({ color, on, onPick }: { color: string; on: boolean; onPick: (c: string) => void }) {
  return (
    <button
      type="button"
      title={color}
      aria-label={color}
      onClick={() => onPick(color)}
      style={{ background: color }}
      className={cn(
        'h-4 w-4 rounded-sm ring-1 ring-neutral-700 hover:scale-125',
        on && 'outline-2 outline-offset-1 outline-neutral-100',
      )}
    />
  );
}

function Row({ colors, value, onPick }: { colors: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <div className="grid grid-cols-10 gap-1.5">
      {colors.map((c) => (
        <Swatch key={c} color={c} on={c === value} onPick={onPick} />
      ))}
    </div>
  );
}

function Label({ children }: { children: string }) {
  return <div className="text-[11px] text-neutral-500">{children}</div>;
}

type Props = {
  value: string;
  onChange: (color: string) => void;
  /** 这张图在用的颜色(见 usedColors),排在最上面 */
  used: string[];
  /** 弹层在色块哪一侧:浮条在图底部就往上弹 */
  side?: 'top' | 'bottom';
};

export function ColorPicker({ value, onChange, used, side = 'bottom' }: Props) {
  const [open, setOpen] = useState(false);
  // 正在输入的自定义颜色;null = 没展开「+」
  const [draft, setDraft] = useState<string | null>(null);
  // 每次渲染现读、不放 state:页面上同时挂着好几个取色器(每张图层卡片一个 + 浮条),
  // 各自挂载时读一份的话,这个加的颜色那个看不到,那个再加还会整份写回、把这个加的覆盖掉
  const custom = open ? loadCustom() : [];
  const current = value.toLowerCase();
  const valid = draft !== null && HEX.test(draft);

  const pick = (c: string) => {
    onChange(c.toLowerCase());
    setOpen(false);
  };

  const add = () => {
    if (!valid) return;

    const c = draft.toLowerCase();
    const next = [c, ...loadCustom().filter((x) => x !== c)].slice(0, MAX_CUSTOM);

    saveCustom(next);
    setDraft(null);
    pick(c);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setDraft(null);
      }}
    >
      <PopoverTrigger
        title="颜色"
        aria-label="颜色"
        style={{ background: value }}
        className="h-4 w-4 shrink-0 cursor-pointer rounded ring-1 ring-neutral-600"
      />
      <PopoverContent side={side} sideOffset={6} className="w-auto gap-2 p-2.5">
        {used.length > 0 && (
          <>
            <Label>本图在用</Label>
            <Row colors={used.slice(0, 10)} value={current} onPick={pick} />
          </>
        )}
        <Row colors={SWATCH_ROWS[0]} value={current} onPick={pick} />
        <Row colors={SWATCH_ROWS[1]} value={current} onPick={pick} />
        <div className="mt-1 flex flex-col gap-1.5">
          {SWATCH_ROWS.slice(2).map((r) => (
            <Row key={r[0]} colors={r} value={current} onPick={pick} />
          ))}
        </div>
        <div className="mt-1 border-t border-neutral-800 pt-2">
          {draft === null ? (
            <div className="flex items-center gap-1.5">
              {custom.length > 0 && <Row colors={custom} value={current} onPick={pick} />}
              <button
                type="button"
                title="添加自定义颜色"
                aria-label="添加自定义颜色"
                onClick={() => setDraft(current)}
                className="flex h-4 w-4 items-center justify-center rounded-sm text-neutral-400 hover:text-neutral-100"
              >
                <Plus size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={valid ? draft.toLowerCase() : current}
                onChange={(e) => setDraft(e.target.value)}
                className="h-6 w-6 shrink-0 cursor-pointer appearance-none rounded border-0 bg-transparent p-0"
                title="拖着选"
              />
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Enter' && add()}
                aria-invalid={!valid}
                className="h-6 w-24 px-1.5 font-mono text-xs"
                autoFocus
              />
              <Button size="2xs" disabled={!valid} onClick={add}>
                添加
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
