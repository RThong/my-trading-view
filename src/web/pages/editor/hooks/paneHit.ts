// 鼠标 → 第几格、格内绘图区坐标(选线拖轴 useLineDrag 与画线 useDrawings 共用)。
// 横坐标从绘图区左边算起(不含左轴刻度):lw-charts 的时间轴坐标就是这么算的,按容器算的话开了左轴会整体右偏一个轴宽
import type { IChartApi, IPaneApi, Time } from 'lightweight-charts';

type At = { clientX: number; clientY: number };

function plotLeft(el: HTMLElement, chart: IChartApi): number {
  return el.getBoundingClientRect().left + chart.priceScale('left').width();
}

/** 鼠标在第 index 格绘图区里的坐标;可以落在格外(拖动途中出了格照样跟手)。那一格不在了 → undefined */
export function paneCoords(el: HTMLElement, chart: IChartApi, index: number, e: At) {
  const top = chart.panes()[index]?.getHTMLElement()?.getBoundingClientRect().top;
  return top === undefined ? undefined : { x: e.clientX - plotLeft(el, chart), y: e.clientY - top };
}

/** 鼠标落在哪一格的绘图区(不含两侧刻度、不含时间轴);不在任何一格里 → undefined */
export function paneAt(
  el: HTMLElement,
  chart: IChartApi,
  e: At,
): { index: number; api: IPaneApi<Time>; x: number; y: number } | undefined {
  const box = el.getBoundingClientRect();
  if (e.clientX < plotLeft(el, chart) || e.clientX > box.right - chart.priceScale('right').width()) return undefined;

  const panes = chart.panes();
  const index = panes.findIndex((p) => {
    const r = p.getHTMLElement()?.getBoundingClientRect();
    return r && e.clientY >= r.top && e.clientY <= r.bottom;
  });
  const at = index < 0 ? undefined : paneCoords(el, chart, index, e);

  return at && { index, api: panes[index], ...at };
}
