// 趋势线交互 + 持久化:
//  - 画线:开启后点两点成线(带预览橡皮筋),第二点落定后自动退出画线模式
//  - hover 到线:显示两端点手柄;在手柄上按下可拖拽端点(拖拽时禁掉图表平移)
//  - 点击线:选中(高亮),按 Delete 删除
// 每 pane 的线同步给挂在该 pane 主 series 上的 TrendLinePrimitive。仅 enabled + series 就绪后接线。
//
// exhaustive-deps 洁净:事件 effect 只引用 ref(biome 视为稳定)与 enabled;闭包存进 ref;
// series 句柄与图元存进 entriesRef,cleanup 只碰 ref。坐标一律用 crosshair 的 param.point(准、免手算多 pane 偏移)。
import { useEffect, useRef, useState } from 'react';
import type { IChartApi, Logical, MouseEventParams } from 'lightweight-charts';
import {
  TrendLinePrimitive,
  serializeLines,
  parseLines,
  pointToSegmentDistance,
  type Anchor,
  type TrendLine,
} from './trendlines';
import type { PaneDef, AnySeries } from './paneChart.types';
import { useStable } from '../../hooks/useStable';

const HIT_PX = 6; // 命中线(hover/选中)阈值
const HANDLE_PX = 9; // 命中端点手柄(拖拽)阈值
// v2:锚点用 logical(线能画进空白区),旧 time 格式不兼容,换 key。
const keyOf = (base: string, paneKey: string) => `mtv:trendlines2:${base}:${paneKey}`;

type Hot = { paneKey: string; index: number; end: 'a' | 'b' };

type UseTrendlinesParams = {
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<Map<string, AnySeries>>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  paneDefs: PaneDef[];
  order: string[];
  storageKey: string;
  enabled: boolean;
  seriesVersion: number;
};

type Entry = { prim: TrendLinePrimitive; series: AnySeries };

export function useTrendlines({
  chartRef,
  seriesRef,
  containerRef,
  paneDefs: rawPaneDefs,
  order,
  storageKey,
  enabled,
  seriesVersion,
}: UseTrendlinesParams) {
  const paneDefs = useStable(rawPaneDefs);

  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  drawingRef.current = drawing;

  // 选中线后浮动操作条的位置(容器相对像素);null = 无选中不显示。
  const [selection, setSelection] = useState<{ x: number; y: number } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 }); // 最近一次按下的容器相对坐标(定位弹窗)

  const entriesRef = useRef<Map<string, Entry>>(new Map());
  const linesRef = useRef<Map<string, TrendLine[]>>(new Map());
  const selectedRef = useRef<{ paneKey: string; index: number } | null>(null);
  const pendingRef = useRef<{ paneKey: string; anchor: Anchor } | null>(null); // 画线第一点
  const previewPaneRef = useRef<string | null>(null);
  const handlesPaneRef = useRef<string | null>(null); // 当前显示手柄的 pane
  const hotHandleRef = useRef<Hot | null>(null); // 光标正悬停在哪个端点手柄上(可拖)
  const draggingRef = useRef<Hot | null>(null); // 正在拖拽的端点
  const skipClickRef = useRef(false); // 拖动过 → 抑制随后的 click 选中
  const scrollOffRef = useRef(false); // 是否已禁掉图表平移(悬停手柄时)
  const orderRef = useRef(order);
  orderRef.current = order;

  // 光标像素 → 自由锚点(logical,price)。coordinateToLogical 在空白区也有效。
  const pointAtRef = useRef<(paneKey: string, x: number, y: number) => Anchor | null>(() => null);
  pointAtRef.current = (paneKey, x, y) => {
    const chart = chartRef.current;
    const entry = entriesRef.current.get(paneKey);
    if (!chart || !entry) return null;
    const price = entry.series.coordinateToPrice(y);
    const logical = chart.timeScale().coordinateToLogical(x);
    if (price == null || logical == null) return null;
    return { logical, price };
  };

  // 锚点 → 像素;越界 null。
  const anchorPxRef = useRef<(paneKey: string, a: Anchor) => { x: number; y: number } | null>(() => null);
  anchorPxRef.current = (paneKey, a) => {
    const chart = chartRef.current;
    const entry = entriesRef.current.get(paneKey);
    if (!chart || !entry) return null;
    const x = chart.timeScale().logicalToCoordinate(a.logical as Logical);
    const y = entry.series.priceToCoordinate(a.price);
    if (x == null || y == null) return null;
    return { x, y };
  };

  // 命中检测:返回该 pane 距 point 最近且 ≤HIT_PX 的线下标,无则 null。click 选中与 hover 出手柄共用。
  const pickLineRef = useRef<(paneKey: string, point: { x: number; y: number }) => number | null>(() => null);
  pickLineRef.current = (paneKey, point) => {
    const lines = linesRef.current.get(paneKey) ?? [];
    let hit: number | null = null;
    let best = HIT_PX;
    lines.forEach((ln, i) => {
      const a = anchorPxRef.current(paneKey, ln.a);
      const b = anchorPxRef.current(paneKey, ln.b);
      if (!a || !b) return;
      const d = pointToSegmentDistance(point.x, point.y, a.x, a.y, b.x, b.y);
      if (d <= best) {
        best = d;
        hit = i;
      }
    });
    return hit;
  };

  const syncRef = useRef<(paneKey: string) => void>(() => {});
  syncRef.current = (paneKey: string) => {
    const lines = linesRef.current.get(paneKey) ?? [];
    const sel = selectedRef.current?.paneKey === paneKey ? selectedRef.current.index : null;
    entriesRef.current.get(paneKey)?.prim.setLines(lines, sel);
    // 写侧兜底:Safari 隐私模式 / 配额满时 setItem 会抛,别让异常冒进事件回调。
    try {
      localStorage.setItem(keyOf(storageKey, paneKey), serializeLines(lines));
    } catch {
      /* 落盘失败不阻断交互 */
    }
  };

  // 设置某 pane 显示手柄的线(切 pane 时清旧 pane)。
  const setHandlesRef = useRef<(paneKey: string | null, index: number | null) => void>(() => {});
  setHandlesRef.current = (paneKey, index) => {
    const prevPane = handlesPaneRef.current;
    if (prevPane && prevPane !== paneKey) entriesRef.current.get(prevPane)?.prim.setHandles(null);
    if (paneKey) entriesRef.current.get(paneKey)?.prim.setHandles(index);
    handlesPaneRef.current = index == null ? null : paneKey;
  };

  // 删当前选中线,收起手柄与操作条。供 Delete 键与浮动操作条共用。
  const deleteSelectedRef = useRef<() => void>(() => {});
  deleteSelectedRef.current = () => {
    const sel = selectedRef.current;
    if (!sel) return;
    const lines = linesRef.current.get(sel.paneKey) ?? [];
    lines.splice(sel.index, 1);
    linesRef.current.set(sel.paneKey, lines);
    selectedRef.current = null;
    setHandlesRef.current(null, null);
    setSelection(null);
    syncRef.current(sel.paneKey);
  };

  const clearPreviewRef = useRef<() => void>(() => {});
  clearPreviewRef.current = () => {
    const p = previewPaneRef.current;
    if (p) {
      entriesRef.current.get(p)?.prim.setPreview(null);
      previewPaneRef.current = null;
    }
  };

  // 悬停手柄时禁图表平移/缩放,离开恢复(只在状态变化时 applyOptions)。
  const setScrollRef = useRef<(off: boolean) => void>(() => {});
  setScrollRef.current = (off) => {
    if (off === scrollOffRef.current) return;
    scrollOffRef.current = off;
    chartRef.current?.applyOptions({ handleScroll: !off, handleScale: !off });
  };

  // 挂图元 + 读回历史线。幂等。
  useEffect(() => {
    if (!enabled) return;
    const chart = chartRef.current;
    if (!chart) return;
    for (const def of paneDefs) {
      if (entriesRef.current.has(def.key)) continue;
      const series = seriesRef.current?.get(def.series[0]);
      if (!series) continue;
      const saved = parseLines(localStorage.getItem(keyOf(storageKey, def.key)));
      linesRef.current.set(def.key, saved);
      const prim = new TrendLinePrimitive(chart, series);
      series.attachPrimitive(prim);
      prim.setLines(saved, null);
      entriesRef.current.set(def.key, { prim, series });
    }
  }, [enabled, seriesVersion, chartRef, seriesRef, paneDefs, storageKey]);

  // 生命周期 cleanup。
  useEffect(() => {
    if (!enabled) return;
    const entries = entriesRef.current;
    return () => {
      // chart.remove()(usePaneChart 先声明,cleanup 先跑)已连带拆掉 primitive,
      // 此处 detach 可能作用在已销毁的 chart 上 → 兜底吞异常,只为 enabled 翻转时的干净卸载。
      for (const { prim, series } of entries.values()) {
        try {
          series.detachPrimitive?.(prim);
        } catch {
          /* chart 已销毁,忽略 */
        }
      }
      entries.clear();
      linesRef.current.clear();
      selectedRef.current = null;
      pendingRef.current = null;
      previewPaneRef.current = null;
      handlesPaneRef.current = null;
      hotHandleRef.current = null;
      draggingRef.current = null;
    };
  }, [enabled]);

  // 点击:画线放点(第二点落定后自动退出画线);否则命中选中(供 Delete)。
  useEffect(() => {
    if (!enabled) return;
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: MouseEventParams) => {
      if (param.point == null || param.paneIndex == null) return;
      const point = param.point;
      const paneKey = orderRef.current[param.paneIndex];
      const entry = paneKey ? entriesRef.current.get(paneKey) : undefined;
      if (!paneKey || !entry) return;
      containerRef.current?.focus({ preventScroll: true });

      if (drawingRef.current) {
        const a = pointAtRef.current(paneKey, point.x, point.y);
        if (!a) return;
        const pending = pendingRef.current;
        if (!pending || pending.paneKey !== paneKey) {
          clearPreviewRef.current(); // 换 pane 重开第一点:先清旧 pane 残留的橡皮筋
          pendingRef.current = { paneKey, anchor: a };
          return;
        }
        const lines = linesRef.current.get(paneKey) ?? [];
        lines.push({ a: pending.anchor, b: a });
        linesRef.current.set(paneKey, lines);
        pendingRef.current = null;
        clearPreviewRef.current();
        syncRef.current(paneKey);
        setDrawing(false); // 两点落定 → 自动退出画线模式
        return;
      }

      // 刚拖完(mousedown 起了拖拽)不当选中处理:draggingRef 已在 mouseup 清,若曾拖动则 skipClickRef 标记。
      if (skipClickRef.current) {
        skipClickRef.current = false;
        return;
      }

      // 命中选中(供 Delete)。
      const hit = pickLineRef.current(paneKey, point);
      const prev = selectedRef.current;
      selectedRef.current = hit == null ? null : { paneKey, index: hit };
      setSelection(hit == null ? null : lastPointerRef.current); // 命中 → 在按下处弹操作条;未命中 → 关
      if (prev && prev.paneKey !== paneKey) syncRef.current(prev.paneKey);
      syncRef.current(paneKey);
    };
    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [enabled, chartRef, containerRef]);

  // 十字线移动:拖拽端点实时跟手;画线预览;否则 hover 命中出手柄 + 记录热手柄。
  useEffect(() => {
    if (!enabled) return;
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (param: MouseEventParams) => {
      // 光标离开图表(point 为空):非拖拽时收起悬停态并恢复平移,否则禁平移会带到下次显示。
      if (param.point == null) {
        if (!draggingRef.current) {
          setHandlesRef.current(null, null);
          hotHandleRef.current = null;
          setScrollRef.current(false);
        }
        return;
      }
      const point = param.point;

      // 拖拽中:更新该端点。
      const drag = draggingRef.current;
      if (drag) {
        const a = pointAtRef.current(drag.paneKey, point.x, point.y);
        const ln = linesRef.current.get(drag.paneKey)?.[drag.index];
        if (a && ln) {
          ln[drag.end] = a;
          skipClickRef.current = true;
          syncRef.current(drag.paneKey);
        }
        return;
      }

      // 画线预览。
      const pending = pendingRef.current;
      if (drawingRef.current && pending) {
        const b = pointAtRef.current(pending.paneKey, point.x, point.y);
        if (b) {
          entriesRef.current.get(pending.paneKey)?.prim.setPreview({ a: pending.anchor, b });
          previewPaneRef.current = pending.paneKey;
        }
        return;
      }
      clearPreviewRef.current();
      if (drawingRef.current) {
        setHandlesRef.current(null, null);
        return;
      }

      // hover:命中线 → 出手柄;近端点 → 记热手柄(可拖),并禁平移。
      const paneKey = param.paneIndex == null ? null : orderRef.current[param.paneIndex];
      if (!paneKey || !entriesRef.current.has(paneKey)) {
        setHandlesRef.current(null, null);
        hotHandleRef.current = null;
        setScrollRef.current(false);
        return;
      }
      const hit = pickLineRef.current(paneKey, point);
      setHandlesRef.current(paneKey, hit);
      // 热手柄:悬停线的某端点附近
      let hot: Hot | null = null;
      if (hit != null) {
        const ln = (linesRef.current.get(paneKey) ?? [])[hit];
        for (const end of ['a', 'b'] as const) {
          const h = anchorPxRef.current(paneKey, ln[end]);
          if (h && Math.hypot(point.x - h.x, point.y - h.y) <= HANDLE_PX) {
            hot = { paneKey, index: hit, end };
            break;
          }
        }
      }
      hotHandleRef.current = hot;
      setScrollRef.current(hot != null); // 悬停手柄禁平移,便于拖拽
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [enabled, chartRef]);

  // 裸鼠标:在热手柄上按下 → 开始拖拽;松开 → 结束。用 crosshair 的坐标更新,故此处只管起止。
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    const onDown = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      lastPointerRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }; // 容器相对坐标,给弹窗定位
      skipClickRef.current = false; // 每次新交互重置,防上次拖拽的残留标记误伤本次 click 选中
      if (drawingRef.current) return;
      const hot = hotHandleRef.current;
      if (!hot) return; // 不在手柄上:交给图表平移 / click 选中
      draggingRef.current = hot;
    };
    const onUp = () => {
      const drag = draggingRef.current;
      if (!drag) return;
      draggingRef.current = null;
      syncRef.current(drag.paneKey); // 落盘最终位置
    };
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
    };
  }, [enabled, containerRef]);

  // Delete/Backspace 删选中线。
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      deleteSelectedRef.current();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [enabled, containerRef]);

  const toggleDrawing = () => {
    setDrawing((d) => {
      if (!d) {
        // 进画线模式:清掉选中态与操作条,避免与画线交互打架
        const prev = selectedRef.current;
        selectedRef.current = null;
        setHandlesRef.current(null, null);
        setSelection(null);
        if (prev) syncRef.current(prev.paneKey); // 同步旧 pane primitive,消掉高亮残影
      } else {
        pendingRef.current = null;
        clearPreviewRef.current();
      }
      return !d;
    });
  };

  const deleteSelected = () => deleteSelectedRef.current();

  return { drawing, toggleDrawing, selection, deleteSelected };
}
