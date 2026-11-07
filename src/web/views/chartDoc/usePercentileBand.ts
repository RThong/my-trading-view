// 分位背景带:图层配了 percentile.riskTail 时,值落在 P5 / P95 之外的日子整格高染色(风险端红、另一端绿),
// 同固定面板。用一条独占隐形轴(0~1、上下不留白)、值恒为 1 的面积图画,段外的点透明;压在所有线下面。
// 用面积图不用柱状图:柱与柱之间有缝,放大或周 / 月线下一段极端期会碎成一排竖纹(同 useBaseBand 的取舍)。
// 每次文档 / 数据变了整套重建(同 useBaseBand):色带随分位阈值变,增量对账不划算。
import { type RefObject, useEffect } from 'react';
import { AreaSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { FULL_HEIGHT_AREA, fullHeightScale } from '../../chart/core';
import { isMarkLayer, type ChartDoc } from './chartDoc';
import { layerMarks, type LayerData } from './layerPoints';

export function usePercentileBand(
  chartRef: RefObject<IChartApi | null>,
  doc: ChartDoc,
  data: Record<string, LayerData>,
) {
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const bands = doc.panes.flatMap((pane, paneIndex) => {
      // 一格只染一层:两层半透明叠起来,红绿混成褐色,分不清是哪条线触发的。取卡片列表里最上面那条(画在最上层的线)
      const owner = pane.layers
        .filter((l) => !l.hidden && !isMarkLayer(l))
        .map((l) => ({ l, band: layerMarks(l, data[l.id]?.display ?? []).band }))
        .find((x) => x.band);
      if (!owner?.band) return [];

      const s: ISeriesApi<'Area'> = chart.addSeries(
        AreaSeries,
        {
          ...FULL_HEIGHT_AREA,
          priceScaleId: `pctl-${pane.id}`,
        },
        paneIndex,
      );
      fullHeightScale(s);
      s.setData(owner.band.map((p) => ({ time: p.time, value: p.value, topColor: p.color, bottomColor: p.color })));
      s.setSeriesOrder(0);
      return [s];
    });

    return () => {
      // 卸载时建图 hook 的清理先跑、图已销毁(同 useBaseBand):再 removeSeries 会抛错、整页白屏
      if (chartRef.current !== chart) return;
      bands.forEach((s) => {
        chart.removeSeries(s);
      });
    };
  }, [chartRef, doc, data]);
}
