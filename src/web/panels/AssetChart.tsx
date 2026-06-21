import { useMemo, useRef } from 'react';
import type { Interval } from '../hooks/interval';
import {
  COLORS, buildSpecs, paneConfig, useAssetData, usePaneChart, usePaneLayout, useCrosshairLegend,
} from './assetChart.hooks';

// 一个资产的全部期权指标,放进同一个 chart 的多个 pane(共享时间轴):
//   pane0 25Δ call/put IV · pane1 skew · pane2 隐含vs已实现RV · pane3 VRP
// VRP 仅有免费波动率指数的标的有(SPY/QQQ/GLD/USO/BTC,vrpUnderlying 给定时,4 pane);
// 无对应指数的(.VIX/TLT)只有前两个 pane。
// 各横向功能(取数/引擎/布局/图例)拆进 ./assetChart.hooks,本组件只拼装 + JSX。
// 实例与标的绑定一辈子(App keep-alive),故无需按标的 reset。
export function AssetChart({
  interval,
  underlying,
  vrpUnderlying,
}: {
  interval: Interval;
  underlying: string;
  vrpUnderlying?: string;
}) {
  const label = underlying.replace(/^\./, '');
  // 引用稳定(只随 vrpUnderlying 变,而它每实例固定),供下游 effect/memo 依赖。
  const { seriesName, paneDefs, paneCount } = useMemo(() => paneConfig(vrpUnderlying), [vrpUnderlying]);
  const containerRef = useRef<HTMLDivElement>(null);

  const { opt, vrp, error, isLoading } = useAssetData(underlying, vrpUnderlying);
  const specs = useMemo(
    () => buildSpecs(opt, vrp, interval, vrpUnderlying, seriesName),
    [opt, vrp, interval, vrpUnderlying, seriesName],
  );
  const { chartRef, seriesRef } = usePaneChart(containerRef, paneCount, specs);
  const { order, collapsed, move, toggle } = usePaneLayout(paneDefs, paneCount, chartRef, seriesRef);
  const { vals, hovering, tops } = useCrosshairLegend(chartRef, seriesRef, containerRef, order, collapsed);

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
                const v = vals[sk];
                return (
                  <div key={sk} style={{ color: COLORS[sk as keyof typeof COLORS] }}>
                    {seriesName[sk]} {v == null ? '—' : v.toFixed(2)}
                  </div>
                );
              })}
            </div>
          );
        })}
        {isLoading && <p className="absolute left-2 top-2 text-xs text-neutral-500">Loading…</p>}
        {error && <p className="absolute left-2 top-2 text-xs text-red-400">Error: {label} {error.message}</p>}
      </div>
    </div>
  );
}
