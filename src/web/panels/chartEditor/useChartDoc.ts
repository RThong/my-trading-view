// 编辑状态:一份 ChartDoc + 一组编辑动作。动作全部走 chartDoc.ts 的纯函数(updater 形式,不依赖闭包里的旧 doc)。
import { useState } from 'react';
import { SERIES_COLORS } from '../../lib/palette';
import {
  EMPTY_DOC,
  addLayer,
  applyLayerFit,
  clearLayerFit,
  moveLayer,
  nextColor,
  removeLayer,
  removeSeries,
  setLayerColor,
  setLayerScale,
  setLayerShift,
  setScaleInvert,
  setScaleLog,
  setStretches,
  type ChartDoc,
  type Fit,
  type PaneTarget,
  type ScaleChoice,
} from './chartDoc';

export function useChartDoc() {
  const [doc, setDoc] = useState<ChartDoc>(EMPTY_DOC);

  return {
    doc,
    load: setDoc,
    /** 下拉框勾选 / 取消勾选:在图上的就整条拿掉,不在的加到第 0 格 */
    toggleSeries: (series: string) =>
      setDoc((d) =>
        d.panes.some((p) => p.layers.some((l) => l.series === series))
          ? removeSeries(d, series)
          : addLayer(d, series, nextColor(d, SERIES_COLORS)),
      ),
    remove: (layerId: string) => setDoc((d) => removeLayer(d, layerId)),
    move: (layerId: string, target: PaneTarget, before?: string) =>
      setDoc((d) => moveLayer(d, layerId, target, before)),
    setScale: (layerId: string, choice: ScaleChoice) => setDoc((d) => setLayerScale(d, layerId, choice)),
    setColor: (layerId: string, color: string) => setDoc((d) => setLayerColor(d, layerId, color)),
    setStretches: (stretches: number[]) => setDoc((d) => setStretches(d, stretches)),
    setShift: (layerId: string, shift: number) => setDoc((d) => setLayerShift(d, layerId, shift)),
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
