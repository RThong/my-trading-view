// src/web/panels/TenorHistoryPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { useYieldCurve } from './yieldCurve.hooks';
import { PALETTE } from './YieldCurvePanel';
import { tenorSeriesData, pickDefaultTenors, useTenorChart, type TenorSpec } from './tenorHistory.hooks';
import type { Interval } from '../hooks/interval';

// 时间横轴 × 每条线一个期限:单期限完整历史。数据/存储不改,纯复用收益率曲线序列。
export function TenorHistoryPanel({ source, interval }: { source: string; interval: Interval }) {
  const { data, isLoading, error, maxDate } = useYieldCurve(source);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 数据到位后首次种入默认勾选(按 source)。
  useEffect(() => {
    if (maxDate && selected.size === 0) setSelected(new Set(pickDefaultTenors(source, data.tenors)));
  }, [maxDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 期限固定配色:按 tenors 序号取色(勾/取消不改色)。
  const colorOf = (tenor: string) => PALETTE[data.tenors.indexOf(tenor) % PALETTE.length];

  const specs: TenorSpec[] = data.tenors
    .filter((t) => selected.has(t))
    .map((t) => ({ tenor: t, color: colorOf(t), data: tenorSeriesData(data.series[t], interval) }));

  useTenorChart(containerRef, specs);

  if (error) return <div className="flex h-full items-center justify-center text-red-400">加载失败:{error.message}</div>;
  if (isLoading) return <div className="flex h-full items-center justify-center text-neutral-500">加载中…</div>;
  if (!maxDate) return (
    <div className="flex h-full items-center justify-center text-amber-500">
      暂无收益率数据{data.unavailable.length ? `(全部期限缺失:${data.unavailable.join(', ')})` : ''}
    </div>
  );

  const toggle = (t: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 期限 chip 多选:颜色 = 线色 */}
      <div className="flex flex-wrap gap-1.5">
        {data.tenors.map((t) => {
          const on = selected.has(t);
          return (
            <button
              key={t}
              onClick={() => toggle(t)}
              className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${on ? 'border-neutral-500 text-neutral-200' : 'border-neutral-800 text-neutral-600'}`}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: on ? colorOf(t) : '#3f3f46' }} />
              {t}
            </button>
          );
        })}
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
