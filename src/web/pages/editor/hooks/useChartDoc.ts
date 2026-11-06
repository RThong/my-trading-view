// 编辑状态:一份 ChartDoc + 一组编辑动作。动作全部走 chartDoc.ts 的纯函数(updater 形式,不依赖闭包里的旧 doc)。
// 最后一次显示的图存在 localStorage,刷新 / 切页回来接着用。
import { useEffect, useState } from 'react';
import { SERIES_COLORS } from '../../../chart/palette';
import {
  EMPTY_DOC,
  addLayer,
  applyLayerFit,
  clearLayerFit,
  moveLayer,
  nextColor,
  removeLayer,
  removeSeries,
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
  type Fit,
  type LayerRender,
  type PaneTarget,
  type ScaleChoice,
} from '../../../views/chartDoc/chartDoc';
import { seriesDef } from '../../../views/chartDoc/registry';

const STORAGE_KEY = 'mtv:chartEditor:doc';

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
  try {
    return parseSaved(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_DOC;
  }
}

// 事件日期(发布日)加进来直接画竖线,其余折线。背景色带(0 / 1 标记)暂不从下拉加,只在 JSON 里写
function defaultRender(series: string): LayerRender | undefined {
  return seriesDef(series)?.events ? { kind: 'events' } : undefined;
}

export function useChartDoc() {
  const [doc, setDoc] = useState<ChartDoc>(loadSaved);

  // 文档每变一次就落盘(文档只经编辑动作或校验过的导入改变,存下来的一定是能显示的图)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch {
      /* 隐私模式 / 配额满时 setItem 会抛:存不上不影响编辑 */
    }
  }, [doc]);

  return {
    doc,
    load: setDoc,
    /** 下拉框勾选 / 取消勾选:在图上的就整条拿掉,不在的加到第 0 格 */
    toggleSeries: (series: string) =>
      setDoc((d) =>
        // 只看普通图层:A − B 不算「A 在图上」(计算图层在卡片上单独删)
        d.panes.some((p) => p.layers.some((l) => l.series === series && !l.calc))
          ? removeSeries(d, series)
          : addLayer(d, series, nextColor(d, SERIES_COLORS), defaultRender(series)),
      ),
    remove: (layerId: string) => setDoc((d) => removeLayer(d, layerId)),
    move: (layerId: string, target: PaneTarget, before?: string) =>
      setDoc((d) => moveLayer(d, layerId, target, before)),
    setScale: (layerId: string, choice: ScaleChoice) => setDoc((d) => setLayerScale(d, layerId, choice)),
    setColor: (layerId: string, color: string) => setDoc((d) => setLayerColor(d, layerId, color)),
    setStretches: (stretches: number[]) => setDoc((d) => setStretches(d, stretches)),
    setShift: (layerId: string, shift: number) => setDoc((d) => setLayerShift(d, layerId, shift)),
    setHidden: (layerId: string, hidden: boolean) => setDoc((d) => setLayerHidden(d, layerId, hidden)),
    setRender: (layerId: string, render: LayerRender | undefined) => setDoc((d) => setLayerRender(d, layerId, render)),
    setCalc: (layerId: string, calc: Calc | undefined) => setDoc((d) => setLayerCalc(d, layerId, calc)),
    setInvert: (paneId: string, scaleId: string, invert: boolean) =>
      setDoc((d) => setScaleInvert(d, paneId, scaleId, invert)),
    setLog: (paneId: string, scaleId: string, log: boolean) => setDoc((d) => setScaleLog(d, paneId, scaleId, log)),
    /** 叠加对比:先按找到的偏移平移,再挂自己的轴叠到 fit.target 上(invert = 这根轴要不要倒) */
    overlay: (layerId: string, shift: number, fit: Fit, invert: boolean) =>
      setDoc((d) => applyLayerFit(setLayerShift(d, layerId, shift), layerId, fit, invert)),
    clearFit: (layerId: string) => setDoc((d) => clearLayerFit(d, layerId)),
  };
}

export type ChartDocActions = ReturnType<typeof useChartDoc>;
