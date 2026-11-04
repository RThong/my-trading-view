// 编辑器自己的悬停图例(不用旧引擎那套):只管两件事 —— 十字线落在哪天、各格绘图区在容器里的像素位置。
// 各图层的数值在渲染时由 asOfValue 现算,不进 state。
import { type RefObject, useEffect, useState } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import { fmtDate, type LinePoint } from '../../lib/chart';
import type { ChartDoc } from './chartDoc';

/** 各格绘图区顶边 + 绘图区左边(开了左轴时要让开刻度),相对图表容器的像素。 */
export type LegendLayout = { tops: number[]; left: number };

function sameLayout(a: LegendLayout, b: LegendLayout) {
  return a.left === b.left && a.tops.length === b.tops.length && a.tops.every((x, i) => x === b.tops[i]);
}

export function useCrosshairLegend(
  containerRef: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>,
  doc: ChartDoc,
) {
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [layout, setLayout] = useState<LegendLayout>({ tops: [], left: 0 });

  // 十字线日期
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const onMove = (p: MouseEventParams) => setHoverTime(p.time === undefined ? null : fmtDate(p.time));
    chart.subscribeCrosshairMove(onMove);

    // 卸载时建图 hook 的清理先跑(声明在前),图已 remove、chartRef 已置空 → 不再碰已销毁的实例
    return () => {
      if (chartRef.current === chart) chart.unsubscribeCrosshairMove(onMove);
    };
  }, [chartRef]);

  // 各格位置:结构变化、容器尺寸变化、拖完分隔条后重新量。lw-charts 下一帧才排版,故放进 rAF。
  useEffect(() => {
    const el = containerRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;

    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const base = el.getBoundingClientRect().top;
        // getHTMLElement 是整行(含两侧刻度),只能取顶边;左边距用左轴自报的宽度(没开左轴时为 0)
        const next = {
          tops: chart.panes().map((p) => (p.getHTMLElement()?.getBoundingClientRect().top ?? base) - base),
          left: chart.priceScale('left').width(),
        };
        setLayout((prev) => (sameLayout(prev, next) ? prev : next));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 同 useEditorChart 的读回:分隔条可以拖出图外再松手,听 window 才不漏
    window.addEventListener('pointerup', measure);
    // 左轴宽度随刻度文字变(平移 / 缩放到另一个量级时),跟着重量;rAF + 等值比较保证不多渲染
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(measure);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointerup', measure);
      // 同上:图已销毁就不再碰
      if (chartRef.current === chart) ts.unsubscribeVisibleLogicalRangeChange(measure);
    };
    // doc 是触发型依赖:结构变了要重量,effect 体内不读它
  }, [containerRef, chartRef, doc]);

  return { hoverTime, layout };
}

/** time 当天或之前最近一点的值(周 / 月频序列在日线十字线上按「截至当日」读)。time 为 null = 最新值。 */
export function asOfValue(points: LinePoint[] | undefined, time: string | null): number | undefined {
  return asOfPoint(points, time)?.value;
}

/** 同 asOfValue,但返回整个点(平移过的图层要靠它的日期反推原始日期)。 */
export function asOfPoint(points: LinePoint[] | undefined, time: string | null): LinePoint | undefined {
  if (!points?.length) return undefined;
  if (time === null) return points.at(-1);

  return points.findLast((p) => p.time <= time);
}
