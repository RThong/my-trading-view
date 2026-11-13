// 编辑状态:一份 ChartDoc + 一组编辑动作 + 撤销 / 重做。动作全部走 chartDoc.ts 的纯函数(updater 形式,不依赖闭包里的旧 doc),
// 每个动作带一个中文名记进历史(见 docHistory)。最后一次显示的图存在 localStorage,刷新 / 切页回来接着用;历史不落盘。
import { useEffect, useState } from 'react';
import { EDITOR_STORAGE_KEY, pendingDoc, useOpenInEditor } from '../../../views/chartDoc/openInEditor';
import { SERIES_COLORS } from '../../../chart/palette';
import type { IndicatorId } from '../../../chart/indicatorDefs';
import { commit, drawingEditLabel, initHistory, redo, undo, type History } from '../docHistory';
import {
  EMPTY_DOC,
  allDrawings,
  addDrawing,
  addLayer,
  clearDrawings,
  removeDrawing,
  updateDrawing,
  applyLayerFit,
  clearLayerFit,
  moveLayer,
  nextColor,
  removeLayer,
  removeSeries,
  addIndicator,
  setIndicatorPeriods,
  setLayerCalc,
  setLayerColor,
  setLayerScale,
  setLayerHidden,
  setLayerRender,
  setLayerShift,
  setScaleInvert,
  setScaleLog,
  parseChartDoc,
  setStretches,
  type Calc,
  type ChartDoc,
  type Drawing,
  type Fit,
  type LayerRender,
  type PaneTarget,
  type ScaleChoice,
} from '../../../views/chartDoc/chartDoc';

// 存档键与「在编辑器中打开」共用(固定面板把图写进这里,编辑器挂载时读到)
const STORAGE_KEY = EDITOR_STORAGE_KEY;

/**
 * 存档原文 → 图:没有 / 坏 JSON / 校验不过(比如格式改过版)一律当空图,绝不抛(localStorage 内容不可信)。
 * 打不开的存档不另留备份:随后的自动保存会把空图写回去,等于连同原存档一起清掉(负责人 2026-11 定的)。
 */
export function parseSaved(raw: string | null): ChartDoc {
  try {
    return (raw && parseChartDoc(JSON.parse(raw))) || EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}

function loadSaved(): ChartDoc {
  // 固定面板刚点了「在编辑器中打开」、编辑器这才第一次挂载:先拿那份(存档可能没写进去)
  const handed = pendingDoc();
  if (handed) return handed;
  try {
    return parseSaved(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_DOC;
  }
}

export function useChartDoc() {
  // 用 state 不用 ref:撤销 / 重做按钮能不能点、提示写什么要跟着重渲染
  const [hist, setHist] = useState<History>(() => initHistory(loadSaved()));
  const { doc } = hist;

  /** 改文档并记一步;label 可按改之前的文档现定(如勾选序列是加还是减);mergeKey 见 docHistory.commit */
  const edit = (label: string | ((d: ChartDoc) => string), fn: (d: ChartDoc) => ChartDoc, mergeKey?: string) => {
    const now = Date.now();
    setHist((h) => commit(h, fn(h.doc), typeof label === 'string' ? label : label(h.doc), now, mergeKey));
  };
  /** 整张换图(示例图、导入 JSON、清空、在编辑器中打开)也算一步:误换了能撤回 */
  const load = (next: ChartDoc, label = '载入图表') => edit(label, () => next);

  // 固定面板点了「在编辑器中打开」:已挂载的编辑器直接换成那张图(没挂载的,挂载时从存档读到)
  useOpenInEditor((d) => load(d, '在编辑器中打开'));

  // 文档每变一次就落盘(文档只经编辑动作或校验过的导入改变,存下来的一定是能显示的图)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch {
      /* 隐私模式 / 配额满时 setItem 会抛:存不上不影响编辑 */
    }
  }, [doc]);

  // 只看普通图层:A − B 不算「A 在图上」(计算图层在卡片上单独删)
  const onChart = (d: ChartDoc, series: string) =>
    d.panes.some((p) => p.layers.some((l) => l.series === series && !l.calc));

  return {
    doc,
    load,
    undo: () => setHist(undo),
    redo: () => setHist(redo),
    /** 撤销 / 重做各自会撤掉 / 重做哪一步;没有可撤的为 undefined */
    undoLabel: hist.past.at(-1)?.label,
    redoLabel: hist.future[0]?.label,
    /** 下拉框勾选 / 取消勾选:在图上的就整条拿掉,不在的加到第 0 格 */
    toggleSeries: (series: string) =>
      edit(
        (d) => (onChart(d, series) ? '移除序列' : '添加序列'),
        (d) => (onChart(d, series) ? removeSeries(d, series) : addLayer(d, series, nextColor(d, SERIES_COLORS))),
      ),
    remove: (layerId: string) => edit('删除图层', (d) => removeLayer(d, layerId)),
    move: (layerId: string, target: PaneTarget, before?: string) =>
      edit('移动图层', (d) => moveLayer(d, layerId, target, before)),
    setScale: (layerId: string, choice: ScaleChoice) => edit('换轴', (d) => setLayerScale(d, layerId, choice)),
    // 取色器拖动时连续触发:并成一步
    setColor: (layerId: string, color: string) =>
      edit('改线条颜色', (d) => setLayerColor(d, layerId, color), `layer-color:${layerId}`),
    setStretches: (stretches: number[]) => edit('调整格高', (d) => setStretches(d, stretches)),
    setShift: (layerId: string, shift: number) => edit('平移', (d) => setLayerShift(d, layerId, shift)),
    setHidden: (layerId: string, hidden: boolean) =>
      edit(hidden ? '隐藏线' : '显示线', (d) => setLayerHidden(d, layerId, hidden)),
    setRender: (layerId: string, render: LayerRender | undefined) =>
      edit('改画法', (d) => setLayerRender(d, layerId, render)),
    setCalc: (layerId: string, calc: Calc | undefined) => edit('改计算', (d) => setLayerCalc(d, layerId, calc)),
    addIndicator: (layerId: string, id: IndicatorId) => edit('加指标', (d) => addIndicator(d, layerId, id)),
    setPeriods: (layerId: string, periods: number[] | undefined) =>
      edit('改指标周期', (d) => setIndicatorPeriods(d, layerId, periods)),
    setInvert: (paneId: string, scaleId: string, invert: boolean) =>
      edit(invert ? '倒轴' : '取消倒轴', (d) => setScaleInvert(d, paneId, scaleId, invert)),
    setLog: (paneId: string, scaleId: string, log: boolean) =>
      edit(log ? '对数坐标' : '取消对数坐标', (d) => setScaleLog(d, paneId, scaleId, log)),
    /** 叠加对比:先按找到的偏移平移,再挂自己的轴叠到 fit.target 上(invert = 这根轴要不要倒) */
    overlay: (layerId: string, shift: number, fit: Fit, invert: boolean) =>
      edit('叠加对比', (d) => applyLayerFit(setLayerShift(d, layerId, shift), layerId, fit, invert)),
    clearFit: (layerId: string) => edit('取消叠加', (d) => clearLayerFit(d, layerId)),
    addDrawing: (layerId: string, drawing: Drawing) => edit('新建画线', (d) => addDrawing(d, layerId, drawing)),
    // 改的是哪儿按改之前的那条比出来(见 drawingEditLabel)
    updateDrawing: (drawing: Drawing) => {
      const now = Date.now();
      setHist((h) => {
        const prev = allDrawings(h.doc).find((e) => e.drawing.id === drawing.id)?.drawing;
        const { label, mergeKey } = drawingEditLabel(prev, drawing);
        return commit(h, updateDrawing(h.doc, drawing), label, now, mergeKey);
      });
    },
    removeDrawing: (id: string) => edit('删除画线', (d) => removeDrawing(d, id)),
    clearDrawings: (keepLocked: boolean) =>
      edit(keepLocked ? '删除未锁定的画线' : '删除全部画线', (d) => clearDrawings(d, { keepLocked })),
  };
}

export type ChartDocActions = ReturnType<typeof useChartDoc>;
