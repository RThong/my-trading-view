// 选中哪条线就拖哪条线(只挪那条线所挂的纵轴,同格其它线不动)。
// lw-charts 原生的格内拖动只挪这一格的「默认轴」(右轴上有线就是右轴),而且只在那根轴已被手动缩放过时才挪
// —— 所以拖左轴 / 独立轴上的线、或拖还没缩放过的线,都拖不动。这里统一接手竖直方向:
//  · 点一下线 = 选中(线保持加粗);之后在这一格任意位置上下拖,挪的都是选中那条线的轴。在线上按住直接拖也行。
//  · 点一下空白处(没拖动)或按 Esc = 取消选中,回到原生行为。
//  · 左 / 右轴的线:转手动 + 临时把默认轴切到那一侧,交给原生拖(对数 / 倒轴原生自己算);
//    独立轴的线:拖动期间关掉原生拖动,上下挪独立轴、左右平移时间由我们做。
// 双击格内 = 这一格所有纵轴恢复自动缩放(独立轴没有刻度可双击,靠这个复位)。
import { type RefObject, useEffect, useRef } from 'react';
import {
  type IChartApi,
  type IPriceScaleApi,
  type ISeriesApi,
  MismatchDirection,
  PriceScaleMode,
} from 'lightweight-charts';
import { fmtDate } from '../../../chart/core';
import { findLayer, type ChartDoc, type Pane } from '../../../views/chartDoc/chartDoc';
import type { LayerSeries } from './useEditorChart';

// 鼠标离线多近算抓住(像素)
const GRAB_PX = 15;
// 命中检测看鼠标左右各几像素(一个像素里可能挤好几根日线)
const HIT_HALF_PX = 4;
// 缩得很小时一个窗口里根数太多,只看前这么多根
const MAX_HIT_BARS = 200;
const PROBE_PX = 100;
// 按下到松开移动不超过这么多像素,算「点一下」而不是拖
const CLICK_PX = 3;
const HIGHLIGHT_WIDTH = 3;

type Range = { from: number; to: number };
/**
 * 拖动中的状态。
 *  · native:左 / 右轴的线 —— 交给原生拖,只记下是否临时切过默认轴(松手要切回)。
 *  · overlay:独立轴的线 —— 原生拖动临时关掉,上下挪独立轴、左右平移时间都由我们做。
 */
type Drag =
  | { kind: 'native'; switched: boolean; ps: IPriceScaleApi; wasAuto: boolean }
  | {
      kind: 'overlay';
      x0: number;
      y0: number;
      ps: IPriceScaleApi;
      /** 对数独立轴不挪上下(见 shiftRange 的说明) */
      start: Range | null;
      perPx: number;
      logical0: { from: number; to: number } | null;
      barSpacing: number;
      /** 移动已超过点击门槛、开始挪了(之前不碰轴:setVisibleRange 会把轴转成手动,点一下手抖就永久手动) */
      moving: boolean;
    };

/** 原生拖动会挪的那根:右轴上有图层就是右轴,否则左轴(同 lw-charts 的 defaultPriceScale)。 */
export function nativeScale(pane: Pane): 'right' | 'left' {
  return pane.layers.some((l) => l.scale === 'right') ? 'right' : 'left';
}

/**
 * 按像素位移平移(线性)纵轴范围:内容跟着手往下走 dy 像素。perPx = 往下 1px 数值减少多少(倒轴为负)。
 * 只给线性轴用:lw-charts 5.2 的 priceScale.setVisibleRange 在对数轴上不做换算(getVisibleRange 会换算),
 * 传真实价格进去会被当对数值,算出 Infinity —— 对数轴一律交给原生拖。
 */
export function shiftRange(t: Range & { perPx: number }, dy: number): Range {
  const d = t.perPx * dy;
  return { from: t.from + d, to: t.to + d };
}

/** 某条线在逻辑下标 [from, to] 内各点的屏幕 y(最多 MAX_HIT_BARS 根;窗口外 / 没数据的跳过)。 */
function lineYs(s: ISeriesApi<'Line'>, from: number, to: number): number[] {
  const last = Math.min(to, from + MAX_HIT_BARS);
  return Array.from({ length: Math.max(0, last - from + 1) }, (_, i) => from + i).flatMap((idx) => {
    const pt = s.dataByIndex(idx, MismatchDirection.NearestLeft);
    const py = pt && 'value' in pt ? s.priceToCoordinate(pt.value) : null;
    return py == null ? [] : [py];
  });
}

/**
 * 这条线的数据是否覆盖到这个日期(首点 ~ 末点之间)。日期取不到 = 鼠标在所有数据右边的空白区,
 * 任何线都不在那里;放行的话 dataByIndex(NearestLeft) 会拿末值去比,末值高度附近处处「点得中」。
 */
function coversTime(s: ISeriesApi<'Line'>, time: string | null): boolean {
  if (time === null) return false;
  const data = s.data();
  const first = data[0];
  const last = data.at(-1);
  return !!first && !!last && fmtDate(first.time) <= time && time <= fmtDate(last.time);
}

/** 鼠标 y 到一段竖条 [min(ys), max(ys)] 的距离;落在竖条里为 0。 */
export function distToSpan(y: number, ys: number[]): number {
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return y < top ? top - y : y > bottom ? y - bottom : 0;
}

/** 一组候选里离鼠标最近、且在 GRAB_PX 以内的那个;都太远 → undefined。 */
export function nearest<T>(cands: { item: T; dist: number }[]): T | undefined {
  const best = cands.filter((c) => c.dist <= GRAB_PX).sort((a, b) => a.dist - b.dist)[0];
  return best?.item;
}

export function useLineDrag(
  containerRef: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<LayerSeries>,
  doc: ChartDoc,
) {
  // 监听器只挂一次,文档读最新的(不参与渲染)
  const docRef = useRef(doc);
  // 当前选中的图层 id(不参与渲染,高亮直接改 series 线宽)。放 ref 而不是监听器闭包里:
  // 文档变了要能清掉它 —— 选中的线被删后,nextId 可能把同一个 id 发给新加的线,不清就会「继承」选中
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    docRef.current = doc;
    if (selectedRef.current && !findLayer(doc, selectedRef.current)) selectedRef.current = null;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let drag: Drag | null = null;
    // 这次按下的位置、是否按在线上(松开时判断「点空白 = 取消选中」)
    let down: { x: number; y: number; onLine: boolean } | null = null;

    const select = (layerId: string | null) => {
      const selected = selectedRef.current;
      if (selected === layerId) return;
      // 旧的那条可能已被删掉(series 不在了),查不到就不管
      if (selected) seriesRef.current.get(selected)?.applyOptions({ lineWidth: 2 });
      if (layerId) seriesRef.current.get(layerId)?.applyOptions({ lineWidth: HIGHLIGHT_WIDTH });
      selectedRef.current = layerId;
    };

    /** 鼠标落在哪一格的绘图区(不含两侧刻度、不含时间轴)。 */
    const hitPane = (e: MouseEvent) => {
      const chart = chartRef.current;
      if (!chart) return undefined;
      const box = el.getBoundingClientRect();
      const plotLeft = box.left + chart.priceScale('left').width();
      if (e.clientX < plotLeft) return undefined;
      if (e.clientX > box.right - chart.priceScale('right').width()) return undefined;

      const panes = chart.panes();
      const i = panes.findIndex((p) => {
        const r = p.getHTMLElement()?.getBoundingClientRect();
        return r && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      const pane = docRef.current.panes[i];
      const top = panes[i]?.getHTMLElement()?.getBoundingClientRect().top;
      return pane && top !== undefined
        ? // 时间轴坐标从绘图区左边算起(不含左轴刻度);按容器算的话开了左轴就整体右偏一个轴宽,永远点不中
          { chart, api: panes[i], pane, x: e.clientX - plotLeft, y: e.clientY - top }
        : undefined;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = hitPane(e);
      if (!hit) return;
      const { chart, api, pane, x, y } = hit;

      // 鼠标左右 HIT_HALF_PX 像素内各条线画出来的竖直范围(日线一个像素挤好几根,线在屏幕上是一段竖条),
      // 鼠标离这段竖条的距离;只看正下方那一根会把「明明点在线上」判成点空白
      const ts = chart.timeScale();
      const t = ts.coordinateToTime(x);
      const cursorTime = t === null ? null : fmtDate(t);
      const lo = ts.coordinateToLogical(x - HIT_HALF_PX);
      const hi = ts.coordinateToLogical(x + HIT_HALF_PX);
      const picked =
        lo === null || hi === null
          ? undefined
          : nearest(
              // 叠加中的线轴跟着 A 走,拖了也会弹回:不让拖;隐藏的线看不见,点不中
              pane.layers
                .filter((l) => !l.fit && !l.hidden)
                .flatMap((l) => {
                  const s = seriesRef.current.get(l.id);
                  // 鼠标落在这条线的数据范围外(比如别的线右移后延伸出的未来段):不算点中。
                  // dataByIndex(NearestLeft) 不管多远都返回左边最近一点,不挡的话末值高度上处处「点得中」
                  if (!s || !coversTime(s, cursorTime)) return [];
                  const ys = lineYs(s, Math.floor(lo), Math.ceil(hi));
                  return ys.length ? [{ item: l, dist: distToSpan(y, ys) }] : [];
                }),
            );
      down = { x: e.clientX, y: e.clientY, onLine: !!picked };
      if (picked) select(picked.id);

      // 要拖的:按到的那条;没按到线就拖本格里已选中的那条;都没有 → 不接管
      // 叠加中的线不接管(和上面的点选同一条规则):它若在叠加前就被选中,空白处拖也不能挪它的轴
      const layer = picked ?? pane.layers.find((l) => l.id === selectedRef.current && !l.fit && !l.hidden);
      const series = layer && seriesRef.current.get(layer.id);
      if (!layer || !series) return;

      const ps = api.priceScale(layer.scale);
      const side = layer.scale === 'right' || layer.scale === 'left' ? layer.scale : undefined;

      // 左 / 右轴:先转手动(原生只挪手动的轴;不改范围),再把默认轴切到这一侧,交给原生拖。
      // 对数、倒轴都由原生自己算;另一根轴原生根本不碰,不用复位。
      if (side) {
        // 原生只挪手动的轴,得在拖动开始前就转;只是点一下(没拖)的话松手时再转回自动,见 onUp
        const wasAuto = ps.options().autoScale;
        ps.setAutoScale(false);
        const switched = side !== nativeScale(pane);
        if (switched) chart.applyOptions({ defaultVisiblePriceScaleId: side });
        drag = { kind: 'native', switched, ps, wasAuto };
        return;
      }

      // 独立轴:原生挪不了 → 拖动期间关掉原生拖动(否则它会挪默认轴),上下左右都由我们做
      const p0 = series.coordinateToPrice(0);
      const p1 = series.coordinateToPrice(PROBE_PX);
      const range = ps.getVisibleRange();
      const linear = ps.options().mode !== PriceScaleMode.Logarithmic;
      chart.applyOptions({ handleScroll: { pressedMouseMove: false } });
      drag = {
        kind: 'overlay',
        x0: e.clientX,
        y0: e.clientY,
        ps,
        start: linear && range ? range : null,
        perPx: p0 != null && p1 != null ? (p0 - p1) / PROBE_PX : 0,
        logical0: chart.timeScale().getVisibleLogicalRange(),
        barSpacing: chart.timeScale().options().barSpacing,
        moving: false,
      };
    };

    const onMove = (e: MouseEvent) => {
      if (drag?.kind !== 'overlay' || !(e.buttons & 1)) return;
      const { x0, y0, ps, start, perPx, logical0, barSpacing } = drag;
      if (!drag.moving && Math.hypot(e.clientX - x0, e.clientY - y0) <= CLICK_PX) return;
      drag.moving = true;
      if (start) ps.setVisibleRange(shiftRange({ ...start, perPx }, e.clientY - y0));
      // 左右平移时间:往右拖 = 看更早的,逻辑区间整体减 dx / 柱宽
      const shift = (e.clientX - x0) / barSpacing;
      if (logical0) {
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: logical0.from - shift, to: logical0.to - shift });
      }
    };

    const onUp = (e: PointerEvent) => {
      const chart = chartRef.current;
      // 默认轴要等这次松手的事件全处理完再切回:pointerup 先于 mouseup,lw-charts 在 mouseup 里给「当前默认轴」收尾拖动,
      // 这里马上切回的话它会去收尾右轴,左轴的拖动状态残留,下次拖左轴时抛 Value is null(实测复现)
      if (drag?.kind === 'native' && drag.switched) {
        setTimeout(() => chartRef.current?.applyOptions({ defaultVisiblePriceScaleId: 'right' }), 0);
      }
      if (drag?.kind === 'overlay') chart?.applyOptions({ handleScroll: { pressedMouseMove: true } });
      const clicked = !!down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_PX;
      // 只是点选 / 取消选中(没真拖):原本自动缩放的轴转回自动,别让一次点击把它永久变成手动
      if (clicked && drag?.kind === 'native' && drag.wasAuto) drag.ps.setAutoScale(true);
      // 点一下空白处(没拖动)= 取消选中
      if (clicked && !down?.onLine) select(null);
      down = null;
      drag = null;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };

    const onDblClick = (e: MouseEvent) => {
      const hit = hitPane(e);
      if (!hit) return;
      const ids = new Set(['right', 'left', ...hit.pane.scales.map((sc) => sc.id)]);
      ids.forEach((id) => {
        hit.api.priceScale(id).setAutoScale(true);
      });
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('dblclick', onDblClick);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [containerRef, chartRef, seriesRef]);
}
