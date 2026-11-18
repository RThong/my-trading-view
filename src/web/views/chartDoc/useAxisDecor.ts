// 纵轴的补充:① 刻度颜色跟线(轴上只挂一条线时用它的色,多条 / 蜡烛用默认灰);② 数字上万的轴按单位缩、轴顶写「×1,000」;
// ③ 独立轴勾了「显示刻度」(Scale.show)的,画成右轴外侧的第 3、4 根轴,能拖动缩放、双击复位(右键菜单见编辑器的 useAxisMenu)。
// 画都在图表库的纵轴画布上(chart/axisDecor 的插件),所以多格、导出图片自然带上;本 hook 只管算该画什么、挂到哪条线上。
// 编辑器、固定面板、出图页都挂它,紧跟在 useDocChart 后面调用(要在它建好 series 之后再改选项)
import { type RefObject, useEffect, useRef } from 'react';
import { type IChartApi, type ISeriesApi, PriceScaleMode, type SeriesType } from 'lightweight-charts';
import {
  type AxisDecor,
  AxisDecorPrimitive,
  axisUnit,
  HEAD_H,
  STRIP_W,
  type Strip,
  unitPriceFormat,
} from '../../chart/axisDecor';
import { CHART_CHROME, useTheme } from '../../hooks/theme';
import { type ChartDoc, isFitTarget, type Layer, onItsScale, type Pane } from './chartDoc';
import { expandIndicators, isVolumePlot, type LayerData } from './layerPoints';
import { drawnKind } from './registry';
import type { LayerSeries } from './useDocChart';

/** 鼠标落在第几格的哪根多出来的轴上 */
export type StripHit = { paneIndex: number; paneId: string; scaleId: string };

type Layout = { slots: number; panes: { id: string; strips: string[] }[] };
const NO_LAYOUT: Layout = { slots: 0, panes: [] };
// 原生右轴刻度文字两侧的留白(图表库刻度短线 + 内外边距);多出来的轴从这之后开始,不压字
const NATIVE_PAD = 22;
// 在多出来的轴上上下拖:每像素缩放的比例(同原生轴的手感:往下拖 = 范围变大 = 线压扁)
const DRAG_RATE = 0.006;

/** 真画在这根轴上、要算单位和颜色的线(标记图层、成交量柱各挂自己的隐形轴,不算) */
function onScale(pane: Pane, scaleId: string): Layer[] {
  return pane.layers.filter((l) => l.scale === scaleId && onItsScale(l) && !isVolumePlot(l));
}

/**
 * 这一格多出来的轴画不画得出:靠挂在右轴某条线上的插件画,右轴没线就画不出。
 * 按展开指标后的格判断(同渲染),卡片上的提示也用它,免得和实际画不画对不上
 */
export function stripsDrawable(doc: ChartDoc, paneId: string): boolean {
  const pane = expandIndicators(doc).panes.find((p) => p.id === paneId);
  return !!pane && onScale(pane, 'right').length > 0;
}

export function useAxisDecor(
  container: RefObject<HTMLElement | null>,
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<LayerSeries>,
  doc: ChartDoc,
  data: Record<string, LayerData>,
) {
  const view = expandIndicators(doc);
  const theme = useTheme();
  const primsRef = useRef(new Map<string, { s: ISeriesApi<SeriesType>; prim: AxisDecorPrimitive }>());
  const layoutRef = useRef<Layout>(NO_LAYOUT);
  // 每根多出来的轴读谁的刻度(格 id + 轴 id → 那条线的 series),拖动时用
  const stripSeriesRef = useRef(new Map<string, ISeriesApi<SeriesType>>());

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const { fontSize, fontFamily, background } = chart.options().layout;
    const font = `${fontSize}px ${fontFamily}`;
    const bg = 'color' in background ? background.color : background.topColor;
    const plain = CHART_CHROME[theme].text;
    const series = (l: Layer) => seriesRef.current.get(l.id);

    // 一根轴:哪几条线、单位(按显示中的线的最大绝对值)、刻度颜色(只挂一条非蜡烛的线才跟线色)
    const axisOf = (pane: Pane, scaleId: string) => {
      const layers = onScale(pane, scaleId);
      const shown = layers.filter((l) => !l.hidden);
      const maxAbs = (shown.length ? shown : layers)
        .flatMap((l) => data[l.id]?.display ?? [])
        .reduce((m, p) => Math.max(m, Math.abs(p.value)), 0);
      const color = shown.length === 1 && drawnKind(shown[0]) !== 'candle' ? shown[0].color : plain;
      return { layers, unit: axisUnit(maxAbs), color };
    };

    const panes = view.panes.map((pane, i) => {
      // 百分比 / 起点 100 的轴:刻度、标签走图表库自带的格式、不读线的价格格式,单位缩不了 —— 不出单位。
      // 读轴上实际生效的模式(有 ≤0 值时 useDocChart 会退回普通坐标,那时照常给单位)
      const relative = [PriceScaleMode.Percentage, PriceScaleMode.IndexedTo100];
      const sides = (['left', 'right'] as const).map((side) => {
        const a = axisOf(pane, side);
        const mode = chart.priceScale(side, i).options().mode;

        return { side, ...a, unit: relative.includes(mode) ? undefined : a.unit };
      });
      sides
        .filter((a) => a.layers.length)
        .forEach((a) => {
          chart.priceScale(a.side, i).applyOptions({ textColor: a.color });
        });
      const extras = pane.scales
        .filter((sc) => sc.side === 'overlay' && sc.show)
        .map((sc) => ({ id: sc.id, ...axisOf(pane, sc.id) }))
        .filter((a) => a.layers.length);
      // 带单位的轴:这根轴上各条线的刻度、最新值、十字线标签都按单位缩;
      // 左右轴的原生刻度落进轴顶单位字样那一截(整行放不下)的不写字。多出来的轴刻度自己画,另有处理
      const inHeadOf = (s: ISeriesApi<SeriesType> | undefined) => (p: number) => {
        const y = s?.priceToCoordinate(p);
        return y != null && y < HEAD_H + fontSize / 2;
      };
      sides.forEach((a) => {
        const inHead = inHeadOf(a.layers.map(series).find(Boolean));
        a.layers.forEach((l) => {
          series(l)?.applyOptions({ priceFormat: unitPriceFormat(a.unit, inHead) });
        });
      });
      extras.forEach((a) => {
        a.layers.forEach((l) => {
          series(l)?.applyOptions({ priceFormat: unitPriceFormat(a.unit) });
        });
      });
      // 多出来的轴画在右轴画布上、靠挂在右轴某条线上的插件:这一格右轴没有线就画不出来,也就不留位置、不判命中
      // (卡片上会提示);画出来的去掉原生最新值色块(它挤在原生右轴里、和这根轴对不上),改在这根轴上自己画
      const right = sides.find((a) => a.side === 'right');
      const drawable = right?.layers.some((l) => series(l)) ? extras : [];
      drawable.forEach((a) => {
        a.layers.forEach((l) => {
          series(l)?.applyOptions({ lastValueVisible: false });
        });
      });
      const strips: (Strip & { id: string; locked: boolean })[] = drawable.flatMap((a) => {
        const s = series(a.layers[0]);
        // 叠加对比的两头每帧被对齐(useFitSync),拖了会被立刻改回去:这样的轴不响应拖动 / 双击(同右键菜单锁住)
        const locked = a.layers.some((l) => !!l.fit || isFitTarget(view, l.id));
        // 最新值色块:取这根轴第一条线(刻度也按它换算,值在画的时候按可视区取),隐藏了就不画;
        // 蜡烛按涨跌上色、图层色不出现在图上:色块用这根轴的刻度色,免得像是别的线
        const head = a.layers[0];
        const tag = head.hidden ? undefined : drawnKind(head) === 'candle' ? a.color : head.color;

        return s ? [{ id: a.id, series: s, color: a.color, unit: a.unit, tag, locked }] : [];
      });
      return { pane, i, sides, strips };
    });
    // 图表库各格的右轴等宽:按最多的那格留位置
    const slots = Math.max(0, ...panes.map((p) => p.strips.length));

    const wanted = new Map(
      panes.flatMap(({ pane, sides, strips }) =>
        sides.flatMap((a) => {
          const host = a.layers.map(series).find((s) => s !== undefined);
          const decor: AxisDecor = {
            side: a.side,
            ...(a.unit && { head: { text: a.unit.label, color: a.color } }),
            strips: a.side === 'right' ? strips : [],
            slots,
            font,
            fontSize,
            bg,
          };
          const needed = !!a.unit || decor.strips.length > 0;
          return host && needed ? [[`${pane.id}:${a.side}` as string, { host, decor }] as const] : [];
        }),
      ),
    );
    const prims = primsRef.current;
    [...prims].forEach(([key, { s, prim }]) => {
      const next = wanted.get(key);
      if (next?.host === s) return;
      if (seriesRef.current && [...seriesRef.current.values()].includes(s)) s.detachPrimitive(prim);
      prims.delete(key);
    });
    wanted.forEach(({ host, decor }, key) => {
      const hit = prims.get(key) ?? { s: host, prim: new AxisDecorPrimitive() };
      if (!prims.has(key)) {
        host.attachPrimitive(hit.prim);
        prims.set(key, hit);
      }
      hit.prim.setDecor(decor);
    });

    layoutRef.current = { slots, panes: panes.map((p) => ({ id: p.pane.id, strips: p.strips.map((s) => s.id) })) };
    stripSeriesRef.current = new Map(
      panes.flatMap((p) => p.strips.filter((s) => !s.locked).map((s) => [`${p.pane.id}:${s.id}`, s.series])),
    );
  }, [view, data, theme, chartRef, seriesRef]);

  // 右轴留出多出来那几根轴的位置:原生刻度文字的宽度 + 根数 × 每根宽。刻度文字随缩放变长变短,所以跟着横轴变化重算
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ctx = document.createElement('canvas').getContext('2d');

    const sync = () => {
      const { slots, panes } = layoutRef.current;
      panes.forEach((_, i) => {
        const ps = chart.priceScale('right', i);
        const want = slots ? nativeWidth(chart, ps, i, ctx) + slots * STRIP_W : 0;
        if (ps.options().minimumWidth !== want) ps.applyOptions({ minimumWidth: want });
      });
    };
    sync();
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(sync);
    return () => {
      if (chartRef.current === chart) ts.unsubscribeVisibleLogicalRangeChange(sync);
    };
  }, [view, data, chartRef]);

  /** 鼠标落在哪一格的哪根多出来的轴上(它们画在右轴最外侧那几截里) */
  const stripAt = (e: { clientX: number; clientY: number }): StripHit | undefined => {
    const chart = chartRef.current;
    const el = container.current;
    const { slots, panes } = layoutRef.current;
    if (!chart || !el || !slots) return undefined;
    const box = el.getBoundingClientRect();
    const blockLeft = box.right - slots * STRIP_W;
    if (e.clientX < blockLeft || e.clientX > box.right) return undefined;

    const paneIndex = chart.panes().findIndex((p) => {
      const r = p.getHTMLElement()?.getBoundingClientRect();
      return r && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    const pane = panes[paneIndex];
    const scaleId = pane?.strips[Math.floor((e.clientX - blockLeft) / STRIP_W)];

    return pane && scaleId ? { paneIndex, paneId: pane.id, scaleId } : undefined;
  };
  const stripAtRef = useRef(stripAt);
  useEffect(() => {
    stripAtRef.current = stripAt;
  });

  // 在多出来的轴上:上下拖 = 缩放这根轴(同原生轴),双击 = 恢复自动缩放。
  // 捕获阶段先截下:这截在图表库的右轴里,不截的话会被当成拖右轴
  useEffect(() => {
    const el = container.current;
    if (!el) return;

    // 落在多出来的轴上:截下这一下(不截就成了拖右轴);叠加锁住的轴截下但不做事(拿不到 series)
    const seriesAt = (e: MouseEvent) => {
      const hit = stripAtRef.current(e);
      return hit && { s: stripSeriesRef.current.get(`${hit.paneId}:${hit.scaleId}`) };
    };
    const onDown = (e: PointerEvent) => {
      const hit = e.button === 0 ? seriesAt(e) : undefined;
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      const s = hit.s;
      if (!s) return;
      const ps = s.priceScale();
      const range = ps.getVisibleRange();
      if (!range) return;
      // 对数轴在对数空间里缩放,上下才对称
      const log = ps.options().mode === PriceScaleMode.Logarithmic;
      const [fwd, back] = log ? [Math.log, Math.exp] : [(v: number) => v, (v: number) => v];
      const [lo, hi] = [fwd(Math.min(range.from, range.to)), fwd(Math.max(range.from, range.to))];
      const y0 = e.clientY;

      const onMove = (m: PointerEvent) => {
        const half = ((hi - lo) / 2) * Math.exp((m.clientY - y0) * DRAG_RATE);
        const mid = (lo + hi) / 2;
        ps.setAutoScale(false);
        ps.setVisibleRange({ from: back(mid - half), to: back(mid + half) });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    // 图表库自己听 mousedown 起拖右轴:同一下也要截掉
    const swallow = (e: MouseEvent) => {
      if (e.button === 0 && seriesAt(e)) e.stopPropagation();
    };
    const onDblClick = (e: MouseEvent) => {
      const hit = seriesAt(e);
      if (!hit) return;
      e.stopPropagation();
      hit.s?.priceScale().setAutoScale(true);
    };

    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('mousedown', swallow, true);
    el.addEventListener('dblclick', onDblClick, true);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('mousedown', swallow, true);
      el.removeEventListener('dblclick', onDblClick, true);
    };
  }, [container]);

  return { stripAt: (e: { clientX: number; clientY: number }) => stripAtRef.current(e) };
}

/**
 * 原生右轴刻度文字要多宽:按右轴当前显示范围两端的价格、用这根轴上的价格格式量字宽。
 * 刻度值都在两端之间,最长的通常就是两端之一(位数最多的那头)
 */
function nativeWidth(
  chart: IChartApi,
  ps: ReturnType<IChartApi['priceScale']>,
  paneIndex: number,
  ctx: CanvasRenderingContext2D | null,
): number {
  const range = ps.getVisibleRange();
  const host = chart
    .panes()
    [paneIndex]?.getSeries()
    .find((s) => s.options().priceScaleId === 'right');
  if (!range || !host || !ctx) return 0;
  const { fontSize, fontFamily } = chart.options().layout;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const fmt = host.priceFormatter();
  const widest = Math.max(...[range.from, range.to].map((v) => ctx.measureText(fmt.format(v)).width));

  return Math.ceil(widest) + NATIVE_PAD;
}
