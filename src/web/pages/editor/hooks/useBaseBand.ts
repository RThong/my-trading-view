// 叠加图层的基准段在图上标成浅色竖带:一眼看出比例是按哪段定的,自动选的段选得合不合理由人看图把关。
// lw-charts 没有「时间区间底色」:用一条铺满整格高度的面积图代替(独占一根不显示的轴,值恒为 1、轴固定 0~1、上下留白 0,
// 线本身不画)。不用柱状图:柱与柱之间有缝,深色底上只剩一排细竖纹,看不出是一整段。
import { type RefObject, useEffect } from 'react';
import { AreaSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { ChartDoc } from '../../../views/chartDoc/chartDoc';
import type { LayerData } from './layerPoints';

// 暖色:和蓝 / 绿等线色都拉得开,深色底上一眼能分出段内段外
const BAND_COLOR = 'rgba(250, 204, 21, 0.1)';

export function useBaseBand(chartRef: RefObject<IChartApi | null>, doc: ChartDoc, data: Record<string, LayerData>) {
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const bands = doc.panes.flatMap((pane, paneIndex) =>
      pane.layers.flatMap((l) => {
        if (!l.fit) return [];
        const { target, start, end } = l.fit;
        // 用 A 画在图上的日期,不凭空给时间轴添点
        const times = (data[target]?.display ?? []).filter((p) => p.time >= start && p.time <= end).map((p) => p.time);
        if (times.length === 0) return [];

        const scaleId = `band-${l.id}`;
        const s: ISeriesApi<'Area'> = chart.addSeries(
          AreaSeries,
          {
            priceScaleId: scaleId,
            topColor: BAND_COLOR,
            bottomColor: BAND_COLOR,
            lineVisible: false,
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: false,
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }),
          },
          paneIndex,
        );
        s.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
        s.setData(times.map((time) => ({ time, value: 1 })));
        // 压在所有线下面
        s.setSeriesOrder(0);
        return [s];
      }),
    );

    return () => {
      // 卸载时建图 hook 的清理先跑、图已销毁(同 useVisibleRange):再 removeSeries 会抛错、整页白屏
      if (chartRef.current !== chart) return;
      bands.forEach((s) => {
        chart.removeSeries(s);
      });
    };
  }, [chartRef, doc, data]);
}
