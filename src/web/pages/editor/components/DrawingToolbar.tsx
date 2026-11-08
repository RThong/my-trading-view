// 画线的界面:图左边一条竖向工具栏(同 TradingView 左栏,第一批只有三种线)+ 选中一条画线后图上方的小浮条。
// 状态与交互见 hooks/useDrawings。
import { Eye, EyeOff, type LucideIcon, Minus, MousePointer2, SeparatorVertical, Slash, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/checkbox';
import { cn } from '../../../lib/utils';
import { allDrawings, type ChartDoc, type Drawing } from '../../../views/chartDoc/chartDoc';
import { layerLabel } from '../../../views/chartDoc/layerLabel';
import type { DrawingTool } from '../hooks/useDrawings';

const OWNER_HINT = '画在这一格里选中的那条线上(先点一下线),没选中就画在这一格第一条线上';
const TOOLS: { id: DrawingTool; icon: LucideIcon; title: string }[] = [
  { id: 'cursor', icon: MousePointer2, title: '光标:点画线选中,拖端点 / 线身调整,Delete 删除(Esc)' },
  { id: 'trend', icon: Slash, title: `趋势线:点两下,或按住拖。${OWNER_HINT}` },
  { id: 'hline', icon: Minus, title: `水平线:点一下。${OWNER_HINT}` },
  { id: 'vline', icon: SeparatorVertical, title: `竖线:点一下,默认贯穿所有格。${OWNER_HINT}` },
];
const KIND_NAME: Record<Drawing['kind'], string> = { trend: '趋势线', hline: '水平线', vline: '竖线' };

// 选中态:亮底亮字(button 的 ghost 只有悬停态)
const ACTIVE = 'bg-neutral-800 text-neutral-100';
const IDLE = 'text-neutral-500 hover:text-neutral-200';

export function DrawingToolbar({
  tool,
  onTool,
  hidden,
  onToggleHidden,
  count,
  onClear,
  disabled,
}: {
  tool: DrawingTool;
  onTool: (t: DrawingTool) => void;
  hidden: boolean;
  onToggleHidden: () => void;
  /** 图上有几条画线(没有就不给隐藏 / 删除) */
  count: number;
  onClear: () => void;
  /** 空图:没有线可挂,整排禁用 */
  disabled: boolean;
}) {
  return (
    <div className="flex w-8 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 pr-1">
      {TOOLS.map(({ id, icon: Icon, title }) => (
        <Button
          key={id}
          variant="ghost"
          size="icon-sm"
          title={title}
          aria-pressed={tool === id}
          disabled={disabled}
          onClick={() => onTool(id)}
          className={tool === id ? ACTIVE : IDLE}
        >
          <Icon />
        </Button>
      ))}
      <div className="my-1 h-px w-5 bg-neutral-800" />
      <Button
        variant="ghost"
        size="icon-sm"
        title={hidden ? '显示全部画线' : '隐藏全部画线'}
        aria-pressed={hidden}
        disabled={disabled || count === 0}
        onClick={onToggleHidden}
        className={hidden ? ACTIVE : IDLE}
      >
        {hidden ? <EyeOff /> : <Eye />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="删除全部画线"
        disabled={disabled || count === 0}
        onClick={() => {
          if (window.confirm(`删除图上全部 ${count} 条画线?`)) onClear();
        }}
        className={IDLE}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/**
 * 选中一条画线时浮在图下方(时间轴上面,上方是图例、会压住读数):是什么线、挂在哪条线上、竖线的「延伸到所有格」、删除
 */
export function DrawingBar({
  doc,
  selected,
  onUpdate,
  onRemove,
}: {
  doc: ChartDoc;
  selected: string | null;
  onUpdate: (d: Drawing) => void;
  onRemove: (id: string) => void;
}) {
  const entry = selected ? allDrawings(doc).find((e) => e.drawing.id === selected) : undefined;
  if (!entry) return null;
  const { drawing: d, layer } = entry;

  return (
    <div
      className={cn(
        'absolute bottom-9 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded border border-neutral-700',
        'bg-neutral-900/95 px-2 py-1 text-xs text-neutral-300',
      )}
    >
      <span>
        {KIND_NAME[d.kind]}
        <span className="text-neutral-500"> · 挂在 {layerLabel(doc, layer)}</span>
      </span>
      {d.kind === 'vline' && (
        <label className="flex cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={!d.paneOnly}
            onCheckedChange={(on) => {
              const { paneOnly: _drop, ...rest } = d;
              onUpdate(on ? rest : { ...rest, paneOnly: true });
            }}
          />
          延伸到所有格
        </label>
      )}
      <Button
        variant="ghost"
        size="icon-2xs"
        title="删除这条(Delete)"
        onClick={() => onRemove(d.id)}
        className="text-neutral-500 hover:text-red-400"
      >
        <Trash2 />
      </Button>
    </div>
  );
}
