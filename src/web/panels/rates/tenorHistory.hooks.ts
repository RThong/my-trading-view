// 期限走势图数据层:把某一期限的历史序列喂给图,按全局 interval 聚合。
// 纯函数在此,图表实例管理见下方 useTenorChart。
import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { aggregate, CHART_OPTIONS, type LinePoint } from '../../lib/chart';
import type { YPoint } from './yieldCurve.hooks';
import type { Interval } from '../../hooks/interval';
import { useStable } from '../../hooks/useStable';

// 各 source 的默认勾选期限(短/前端/中/长各取锚点)。
// treasury 前端用信息量更大的 2Y;OIS 档位对齐 Eris 真实点,12M 而非 1Y。
export const DEFAULT_TENORS: Record<string, string[]> = {
  treasury: ['3M', '1Y', '2Y', '5Y', '10Y', '30Y'],
  sofr_ois: ['1M', '3M', '6M', '12M', '2Y', '10Y'],
  bei: ['5Y', '10Y', '30Y'],
  jgb: ['2Y', '10Y', '30Y'],
  // AI CDS:默认展示除 Broadcom/Dell/Intel 外的 7 家(这三条较次要,留 chip 按需勾)。
  // 须与 rateCurves.ts AI_CDS 的 core 名单一致(core 缺失会让每日 job failed 告警)。
  ai_cds: ['Oracle', 'Microsoft', 'Alphabet', 'Amazon', 'Apple', 'Nvidia', 'Meta'],
};

/** 某期限的 {date,value}[] → 图用的 {time,value}[],按 interval 聚合。缺该期限 → []。 */
export function tenorSeriesData(rows: YPoint[] | undefined, interval: Interval): LinePoint[] {
  if (!rows) return [];
  return aggregate(
    rows.map((p) => ({ time: p.date, value: p.value })),
    interval,
  );
}

/** 默认勾选:取表内该 source 的期限并过滤到真实可用;无表则回退前 4 个可用期限。 */
export function pickDefaultTenors(source: string, available: string[]): string[] {
  const table = DEFAULT_TENORS[source];
  if (!table) return available.slice(0, 4);
  return table.filter((t) => available.includes(t));
}

// ── 图表实例:单图,每个选中期限一条线 ────────────────────────────
export type TenorSpec = { tenor: string; color: string; data: LinePoint[] };

export type SpreadSpec = { label: string; color: string; data: LinePoint[] };

/** 建图挂 containerRef;期限线 → pane 0;spread 非 null → pane 1 一条利差线 + 0 基线(共享时间轴、联动)。
 *  spread 传 null = 收起差值 pane(不重建图,故缩放/平移保留)。 */
export function useTenorChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  rawSpecs: TenorSpec[],
  rawSpread: SpreadSpec | null,
) {
  // 引用稳定化在 hook 内部扛:调用方传新数组字面量不该让 sync effect 每帧重跑 fitContent。
  const specs = useStable(rawSpecs);
  const spread = useStable(rawSpread);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const spreadRef = useRef<ISeriesApi<'Line'> | null>(null);
  const showSpread = spread !== null;

  // 挂载建一次,卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    const seriesMap = seriesRef.current; // 同一 Map(useRef 只建一次),捕获供 cleanup 用
    // 重建/卸载时清理:seriesMap 用捕获的局部;spreadRef 置空供重建时重新识别。
    return () => {
      chart.remove();
      seriesMap.clear();
      chartRef.current = null;
      spreadRef.current = null;
    };
  }, [containerRef]);

  // 差值 pane(2:1 高)随显隐增删。单独一个 effect:挂在建图 effect 上会让每次切换重建整张图、丢缩放。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !showSpread) return;

    chart.addPane();
    chart.panes()[0].setStretchFactor(2);
    chart.panes()[1].setStretchFactor(1);

    return () => {
      // 卸载时建图 effect 的 cleanup 先跑过、chart 已销毁 → 用 ref 判活,别用捕获的局部。
      const alive = chartRef.current;
      // removePane 只是把 pane 从数组里 splice 掉,不销毁 pane 内的 series(v5.2 实现如此)
      // → 必须自己先 removeSeries,否则反复显隐会把旧差值线连 0 基线一起攒在 chart 里。
      if (alive && spreadRef.current) alive.removeSeries(spreadRef.current);
      spreadRef.current = null;
      if (alive && alive.panes().length > 1) alive.removePane(1);
    };
  }, [showSpread]);

  // 期限线(pane 0)同步。fitContent 留在这里:期限勾选 / interval 变化才重取视窗。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const keysNow = new Set(specs.map((s) => s.tenor));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) {
        chart.removeSeries(s);
        seriesRef.current.delete(k);
      }
    }
    for (const spec of specs) {
      let s = seriesRef.current.get(spec.tenor);
      if (!s) {
        s = chart.addSeries(LineSeries, {
          color: spec.color,
          title: spec.tenor,
          lineWidth: 2,
          priceLineVisible: false,
        });
        seriesRef.current.set(spec.tenor, s);
      }
      s.setData(spec.data);
    }

    chart.timeScale().fitContent();
  }, [specs]);

  // 差值线(pane 1)同步。独立于期限线:这里不碰 timeScale,否则显隐差值会把用户的缩放/平移 fit 掉。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !spread) return;

    if (!spreadRef.current) {
      spreadRef.current = chart.addSeries(
        LineSeries,
        { color: spread.color, title: spread.label, lineWidth: 2, priceLineVisible: false },
        1,
      );
      // 穿 0 = 倒挂。只在建线时加一次。
      spreadRef.current.createPriceLine({
        price: 0,
        color: '#71717a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: '',
      });
    }
    spreadRef.current.setData(spread.data);
  }, [spread]);
}
