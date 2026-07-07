// 期限走势图数据层:把某一期限的历史序列喂给图,按全局 interval 聚合。
// 纯函数在此,图表实例管理见下方 useTenorChart。
import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { aggregate, CHART_OPTIONS, type LinePoint } from '../lib/chart';
import type { YPoint } from './yieldCurve.hooks';
import type { Interval } from '../hooks/interval';

// 各 source 的默认勾选期限(短/前端/中/长各取锚点)。
// treasury 前端用信息量更大的 2Y;OIS 档位较粗,前端用 1Y。
export const DEFAULT_TENORS: Record<string, string[]> = {
  treasury: ['3M', '1Y', '2Y', '5Y', '10Y', '30Y'],
  sofr_ois: ['3M', '1Y', '10Y', '30Y'],
};

/** 某期限的 {date,value}[] → 图用的 {time,value}[],按 interval 聚合。缺该期限 → []。 */
export function tenorSeriesData(rows: YPoint[] | undefined, interval: Interval): LinePoint[] {
  if (!rows) return [];
  return aggregate(rows.map((p) => ({ time: p.date, value: p.value })), interval);
}

/** 默认勾选:取表内该 source 的期限并过滤到真实可用;无表则回退前 4 个可用期限。 */
export function pickDefaultTenors(source: string, available: string[]): string[] {
  const table = DEFAULT_TENORS[source];
  if (!table) return available.slice(0, 4);
  return table.filter((t) => available.includes(t));
}

// ── 图表实例:单图,每个选中期限一条线 ────────────────────────────
export type TenorSpec = { tenor: string; color: string; data: LinePoint[] };

/** 建图挂 containerRef;specs 变化时同步 line series(缺的删、没有的建、有的 setData)。 */
export function useTenorChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  specs: TenorSpec[],
) {
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  // 挂载建一次,卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current.clear(); };
  }, [containerRef]);

  // specs 变化时增删/更新线。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const keysNow = new Set(specs.map((s) => s.tenor));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) { chart.removeSeries(s); seriesRef.current.delete(k); }
    }
    for (const spec of specs) {
      let s = seriesRef.current.get(spec.tenor);
      if (!s) {
        s = chart.addSeries(LineSeries, { color: spec.color, title: spec.tenor, lineWidth: 2, priceLineVisible: false });
        seriesRef.current.set(spec.tenor, s);
      }
      s.setData(spec.data);
    }
    chart.timeScale().fitContent();
  }, [specs]);
}
