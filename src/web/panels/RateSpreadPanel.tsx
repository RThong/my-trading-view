// src/web/panels/RateSpreadPanel.tsx
import { useRef } from 'react';
import { useYieldCurve } from './yieldCurve.hooks';
import { PALETTE } from './YieldCurvePanel';
import { useTenorChart, type TenorSpec } from './tenorHistory.hooks';
import { spreadSeries } from './rateSpread.hooks';
import { aggregate } from '../lib/chart';
import type { Interval } from '../hooks/interval';

// 利差随时间的单线图(long − short),带 0 基准线。数据与上方曲线图共享 SWR 缓存。
export function RateSpreadPanel({ source, long, short, label, interval }:
  { source: string; long: string; short: string; label: string; interval: Interval }) {
  const { data, isLoading, error, maxDate } = useYieldCurve(source);
  const containerRef = useRef<HTMLDivElement>(null);

  const rows = spreadSeries(data.series[long], data.series[short]);
  const spec: TenorSpec = {
    tenor: label,
    color: PALETTE[0],
    data: aggregate(rows.map((p) => ({ time: p.date, value: p.value })), interval),
  };
  useTenorChart(containerRef, [spec], 0);

  // 容器常驻,三态作浮层(提前 return 会卸载 ref → 图建不出)。
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {error && <p className="absolute left-2 top-2 text-xs text-red-400">加载失败:{error.message}</p>}
        {isLoading && <p className="absolute left-2 top-2 text-xs text-neutral-500">加载中…</p>}
        {!isLoading && !error && !maxDate && <p className="absolute left-2 top-2 text-xs text-amber-500">暂无数据</p>}
      </div>
    </div>
  );
}
