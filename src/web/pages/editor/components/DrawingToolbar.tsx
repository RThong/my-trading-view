// 画线的界面:图左边一条竖向工具栏(同 TradingView 左栏:单按钮 + 工具组)+ 选中一条画线后图上方的小浮条。
// 状态与交互见 hooks/useDrawings。
import {
  ChevronRight,
  Eye,
  EyeOff,
  type LucideIcon,
  MessageSquare,
  Minus,
  MousePointer2,
  SeparatorVertical,
  MoveUpRight,
  Pencil,
  RectangleHorizontal,
  Type,
  Ruler,
  Equal,
  ArrowRightFromLine,
  Slash,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { cn } from '../../../lib/utils';
import { allDrawings, type ChartDoc, type Drawing } from '../../../views/chartDoc/chartDoc';
import { layerLabel } from '../../../views/chartDoc/layerLabel';
import { type PluginControls, POINT_PLUGINS } from '../drawingPlugins';
import type { PointPlugin } from '../drawingPlugins/types';
import type { DrawingTool } from '../hooks/useDrawings';

const OWNER_HINT = '画在这一格里选中的那条线上(先点一下线),没选中就画在这一格第一条线上';
const TOOL: Record<DrawingTool, { icon: LucideIcon; name: string; hint: string }> = {
  cursor: { icon: MousePointer2, name: '光标', hint: '光标:点画线选中,拖端点 / 线身调整,Delete 删除(Esc)' },
  trend: { icon: Slash, name: '趋势线', hint: `趋势线:点两下,或按住拖。${OWNER_HINT}` },
  ray: {
    icon: MoveUpRight,
    name: '射线',
    hint: `射线:点两下(起点、方向),从起点穿过第二点一直延伸。${OWNER_HINT}`,
  },
  text: {
    icon: Type,
    name: '文字',
    hint: `文字:点一下就地打字,回车换行,Esc / 点别处写完;双击文字再改,加框在下方浮条。${OWNER_HINT}`,
  },
  callout: {
    icon: MessageSquare,
    name: '标注气泡',
    hint: `标注气泡:点一下定指针尖,再点一下放文字框,就地打字;拖框只挪框、拖尖改指向,双击再改字。${OWNER_HINT}`,
  },
  rect: {
    icon: RectangleHorizontal,
    name: '矩形',
    hint: `矩形:点两下(对角两点),或按住拖,框出一段时间 × 价格区间;下方浮条可勾「向右延伸」。${OWNER_HINT}`,
  },
  measure: {
    icon: Ruler,
    name: '测量',
    hint: '测量:点一下定起点,再点一下定住,看这段涨跌多少、隔几根几天;再点一下或 Esc 收起。光标下按住 Shift 点图也能直接量',
  },
  channel: {
    icon: Equal,
    name: '平行通道',
    hint: `平行通道:点两下画底边,再点一下定宽度(平行线穿过这一点)。${OWNER_HINT}`,
  },
  hray: { icon: ArrowRightFromLine, name: '水平射线', hint: `水平射线:点一下,从这一点往右延伸。${OWNER_HINT}` },
  hline: { icon: Minus, name: '水平线', hint: `水平线:点一下。${OWNER_HINT}` },
  vline: { icon: SeparatorVertical, name: '竖线', hint: `竖线:点一下,默认贯穿所有格。${OWNER_HINT}` },
};
const KIND_NAME: Record<Drawing['kind'], string> = {
  trend: '趋势线',
  ray: '射线',
  hline: '水平线',
  hray: '水平射线',
  vline: '竖线',
  channel: '平行通道',
  text: '文字',
  callout: '标注气泡',
  rect: '矩形',
};

/** 工具组(同 TradingView 左栏的一格):按钮显示这组上次用的工具,点它直接用;点右缘小三角弹出整组 */
type ToolGroupDef = { id: string; name: string; sections: { title: string; tools: DrawingTool[] }[] };
const GROUPS: ToolGroupDef[] = [
  // 线条组(信息线不做:能留在图上的只有涨跌 / 天数,测量尺随时能量,要长期标注用文字 / 气泡)
  {
    id: 'lines',
    name: '线条',
    sections: [
      { title: '线', tools: ['trend', 'ray', 'hline', 'hray', 'vline'] },
      { title: '通道', tools: ['channel'] },
    ],
  },
  // 标注组(同 TradingView 的 Annotation tools;路标不做:被标注气泡覆盖)
  {
    id: 'annotate',
    name: '标注',
    sections: [
      { title: '文字', tools: ['text', 'callout'] },
      { title: '形状', tools: ['rect'] },
    ],
  },
];

// 各组上次用的工具,跨刷新记住(只是偏好,读写失败就用组里第一个)
const LAST_KEY = 'mtv:drawingToolbar:last';

function loadLast(): Record<string, DrawingTool> {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveLast(last: Record<string, DrawingTool>) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last));
  } catch {
    /* 隐私模式存不上:本次会话照常 */
  }
}

// 选中态:亮底亮字(button 的 ghost 只有悬停态)
const ACTIVE = 'bg-neutral-800 text-neutral-100';
const IDLE = 'text-neutral-500 hover:text-neutral-200';

/**
 * 按钮右缘的小三角 + 右侧弹出的子菜单(同 TradingView:悬停整格时小三角滑入,点它才弹出;打开期间保持高亮并翻转)。
 * 工具组和插件按钮共用。children 拿到 close,选完一项自己关
 */
function Flyout({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn(
          'absolute inset-y-0 right-0 flex w-2.5 items-center justify-center rounded-sm text-neutral-500',
          'translate-x-0.5 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-200',
          'group-hover/tool:translate-x-0 group-hover/tool:opacity-100 focus-visible:opacity-100',
          'data-popup-open:translate-x-0 data-popup-open:bg-neutral-800 data-popup-open:opacity-100 disabled:hidden',
        )}
      >
        <ChevronRight size={10} className={cn('transition-transform', open && 'rotate-180')} />
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={6} className="w-44 gap-0 p-1 text-xs">
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

function MenuSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-2 pt-1.5 pb-1 text-[11px] text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  name,
  hint,
  active,
  onClick,
}: {
  icon?: LucideIcon;
  name: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={hint}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-neutral-300 hover:bg-neutral-800',
        active && 'bg-neutral-800 text-neutral-100',
      )}
    >
      {Icon && <Icon size={14} />}
      {name}
    </button>
  );
}

function ToolGroup({
  group,
  tool,
  last,
  onPick,
  disabled,
}: {
  group: ToolGroupDef;
  tool: DrawingTool;
  last: DrawingTool | undefined;
  onPick: (t: DrawingTool) => void;
  disabled: boolean;
}) {
  const tools = group.sections.flatMap((s) => s.tools);
  // 正在用这组的工具就显示它;否则显示上次用的(存档里的值不在组里就当没有)
  const remembered = last && tools.includes(last) ? last : tools[0];
  const shown = tools.includes(tool) ? tool : remembered;
  const { icon: Icon, hint } = TOOL[shown];

  return (
    // group/tool:悬停整格时小三角滑入(同 TradingView,平时藏着不占眼)
    <div className="group/tool relative flex w-full justify-center">
      <Button
        variant="ghost"
        size="icon-sm"
        title={hint}
        aria-pressed={tools.includes(tool)}
        disabled={disabled}
        onClick={() => onPick(shown)}
        className={tools.includes(tool) ? ACTIVE : IDLE}
      >
        <Icon />
      </Button>
      <Flyout label={group.name} disabled={disabled}>
        {(close) =>
          group.sections.map((sec) => (
            <MenuSection key={sec.title} title={sec.title}>
              {sec.tools.map((t) => (
                <MenuItem
                  key={t}
                  {...TOOL[t]}
                  active={t === tool}
                  onClick={() => {
                    onPick(t);
                    close();
                  }}
                />
              ))}
            </MenuSection>
          ))
        }
      </Flyout>
    </div>
  );
}

/** 不成组的单个工具按钮(光标、测量) */
function ToolButton({
  t,
  tool,
  onTool,
  disabled,
}: {
  t: DrawingTool;
  tool: DrawingTool;
  onTool: (t: DrawingTool) => void;
  disabled: boolean;
}) {
  const { icon: Icon, hint } = TOOL[t];

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={hint}
      aria-pressed={tool === t}
      disabled={disabled}
      onClick={() => onTool(t)}
      className={tool === t ? ACTIVE : IDLE}
    >
      <Icon />
    </Button>
  );
}

/** 锚点插件(磁吸等)的开关:点按钮开 / 关,小三角里选模式(选了顺带打开)。按插件声明渲染,不认识具体插件 */
function PluginButton({
  plugin,
  controls,
  disabled,
}: {
  plugin: PointPlugin;
  controls: PluginControls;
  disabled: boolean;
}) {
  const on = controls.isOn(plugin);
  const mode = controls.modeOf(plugin);
  const modeName = plugin.modes.find((m) => m.id === mode)?.name ?? plugin.name;
  const Icon = plugin.icon;

  return (
    <div className="group/tool relative flex w-full justify-center">
      <Button
        variant="ghost"
        size="icon-sm"
        title={on ? `${modeName}(开,点一下关)` : `${plugin.name}(关,点一下开:${modeName})`}
        aria-pressed={on}
        disabled={disabled}
        onClick={() => controls.toggle(plugin)}
        className={on ? ACTIVE : IDLE}
      >
        <Icon />
      </Button>
      {plugin.modes.length > 1 && (
        <Flyout label={plugin.name} disabled={disabled}>
          {(close) =>
            plugin.modes.map((m) => (
              <MenuItem
                key={m.id}
                name={m.name}
                hint={m.hint}
                active={on && m.id === mode}
                onClick={() => {
                  controls.setMode(plugin, m.id);
                  close();
                }}
              />
            ))
          }
        </Flyout>
      )}
    </div>
  );
}

export function DrawingToolbar({
  tool,
  onTool,
  hidden,
  onToggleHidden,
  count,
  onClear,
  disabled,
  plugins,
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
  plugins: PluginControls;
}) {
  const [last, setLast] = useState(loadLast);

  const pickInGroup = (groupId: string, t: DrawingTool) => {
    const next = { ...last, [groupId]: t };
    setLast(next);
    saveLast(next);
    onTool(t);
  };

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 pr-1">
      <ToolButton t="cursor" tool={tool} onTool={onTool} disabled={disabled} />
      {GROUPS.map((g) => (
        <ToolGroup
          key={g.id}
          group={g}
          tool={tool}
          last={last[g.id]}
          onPick={(t) => pickInGroup(g.id, t)}
          disabled={disabled}
        />
      ))}
      <ToolButton t="measure" tool={tool} onTool={onTool} disabled={disabled} />
      <div className="my-1 h-px w-5 bg-neutral-800" />
      {POINT_PLUGINS.map((pl) => (
        <PluginButton key={pl.id} plugin={pl} controls={plugins} disabled={disabled} />
      ))}
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
  onEditText,
}: {
  doc: ChartDoc;
  selected: string | null;
  onUpdate: (d: Drawing) => void;
  onRemove: (id: string) => void;
  /** 文字 / 气泡:就地改字(同双击) */
  onEditText: (id: string) => void;
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
      {d.kind === 'text' && (
        <label className="flex cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={!!d.box}
            onCheckedChange={(on) => {
              const { box: _drop, ...rest } = d;
              onUpdate(on ? { ...rest, box: true } : rest);
            }}
          />
          加框
        </label>
      )}
      {(d.kind === 'text' || d.kind === 'callout') && (
        <Button
          variant="ghost"
          size="icon-2xs"
          title="编辑文字(双击文字也行)"
          onClick={() => onEditText(d.id)}
          className="text-neutral-500 hover:text-neutral-200"
        >
          <Pencil />
        </Button>
      )}
      {d.kind === 'rect' && (
        <label className="flex cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={!!d.extend}
            onCheckedChange={(on) => {
              const { extend: _drop, ...rest } = d;
              onUpdate(on ? { ...rest, extend: true } : rest);
            }}
          />
          向右延伸
        </label>
      )}
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
