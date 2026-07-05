import type { LegendCell, PaneDef } from './assetChart.hooks';

// 多 pane 堆叠图的通用展示壳:pane 工具条(↑↓ 换位 / ▾ 折叠)+ 竖线图例 + 容器 + loading/error。
// 与数据源无关——期权(AssetChart)与宏观(RegimeChart)共用,靠 props 注入 paneDefs/图例/命名/配色。
type Props = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  paneDefs: PaneDef[];
  paneCount: number;
  order: string[];
  collapsed: Set<string>;
  move: (key: string, dir: -1 | 1) => void;
  toggle: (key: string) => void;
  cells: Record<string, LegendCell>;
  hovering: boolean;
  tops: number[];
  seriesName: Record<string, string>;
  colors: Record<string, string>;
  isLoading: boolean;
  error?: Error;
  errorLabel?: string; // error 前缀(期权用标的名);宏观省略
  note?: string;       // 右上角提示(宏观用来标"某序列暂不可用")
};

export function PaneChartView({
  containerRef, paneDefs, paneCount, order, collapsed, move, toggle,
  cells, hovering, tops, seriesName, colors, isLoading, error, errorLabel, note,
}: Props) {
  return (
    <div className="relative flex h-full w-full flex-col">
      {/* 工具条按固定顺序排列(便于查找);↑↓ 只改 chart 里 pane 的显示位置,不改本行顺序。 */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {paneDefs.map(({ key, label: pl }) => {
          const pos = order.indexOf(key); // 该 pane 当前在图中的位置
          const isCollapsed = collapsed.has(key);
          // 唯一展开的那个不能再收(收了全员等权=没收起)。
          const lastExpanded = !isCollapsed && collapsed.size === paneCount - 1;
          const btn = 'px-1 text-neutral-300 disabled:cursor-not-allowed disabled:text-neutral-700';
          return (
            <div key={key} className="flex items-center gap-0.5 rounded border border-neutral-700 px-1 py-0.5 text-xs">
              <button onClick={() => move(key, -1)} disabled={pos === 0} title="上移" className={btn}>↑</button>
              <button onClick={() => move(key, 1)} disabled={pos === order.length - 1} title="下移" className={btn}>↓</button>
              <button onClick={() => toggle(key)} disabled={lastExpanded} title={lastExpanded ? '至少保留一个' : isCollapsed ? '展开' : '收起'} className={btn}>
                {isCollapsed ? '▸' : '▾'}
              </button>
              <span className={isCollapsed ? 'text-neutral-600' : 'text-neutral-300'}>{pl}</span>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {/* 每个 pane 顶部图例:指标名 + 竖线对应值。仅悬停时显示,不悬停不挡线
            (最新值看右轴原生 tag)。 */}
        {hovering && order.map((key, i) => {
          if (collapsed.has(key)) return null;
          const def = paneDefs.find((d) => d.key === key);
          if (!def) return null;
          return (
            <div key={key} className="pointer-events-none absolute left-2 z-10 text-xs leading-tight" style={{ top: (tops[i] ?? 0) + 2 }}>
              {def.series.map((sk) => {
                const c = cells[sk];
                const color = colors[sk];
                if (!c) return <div key={sk} style={{ color }}>{seriesName[sk]} —</div>;
                const dColor = c.delta == null ? undefined : c.delta > 0 ? '#22c55e' : c.delta < 0 ? '#ef4444' : undefined;
                const dTxt = c.delta == null ? null
                  : `${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(2)}${c.pct == null ? '' : ` (${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%)`}`;
                // O/H/L/C 字母保持中性,只有数字按涨跌上色(对齐 TradingView);线的值保持 series 原色。
                const num = (n: number) => <span style={{ color: dColor }}>{n.toFixed(2)}</span>;
                return (
                  <div key={sk} style={{ color }}>
                    {seriesName[sk]}{' '}
                    {c.kind === 'candle'
                      ? <>O {num(c.open)} H {num(c.high)} L {num(c.low)} C {num(c.close)}</>
                      : c.value.toFixed(2)}
                    {dTxt && <span style={{ color: dColor }}> {dTxt}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {note && <p className="absolute right-2 top-2 z-10 text-xs text-amber-500">{note}</p>}
        {isLoading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
        {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {errorLabel} {error.message}</p>}
      </div>
    </div>
  );
}
