// 只读图(DocChart)上显示 ChartDoc 里存的画线:每个 lw 格挂一个只画不认鼠标的 DrawingsPrimitive。
// 画、选、拖都在编辑器(pages/editor 的 useDrawings);这里只把同一套像素换算(drawingShapes)画出来。
import { type RefObject, useEffect, useRef } from 'react';
import type { IChartApi, IPaneApi, Time } from 'lightweight-charts';
import { timeAxis, type TimeAxis } from '../../chart/drawings';
import { fmtDate } from '../../chart/core';
import { DrawingsPrimitive } from '../../chart/primitives/drawings';
import { CHART_CHROME, getTheme } from '../../hooks/theme';
import { allDrawings, type ChartDoc } from './chartDoc';
import { makeShapeCtx, paneShapes } from './drawingShapes';
import type { LayerData } from './layerPoints';
import type { LayerSeries } from './useDocChart';

export function useDrawingsView(
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<LayerSeries>,
  doc: ChartDoc,
  data: Record<string, LayerData>,
) {
  // 只在图元绘制时读,不参与渲染
  const docRef = useRef(doc);
  const axisRef = useRef<TimeAxis>(timeAxis([]));
  const primsRef = useRef(new Map<IPaneApi<Time>, DrawingsPrimitive>());

  // 文档同步进 ref 并请求重画(眼睛按钮隐藏图层后线要跟着消失)
  useEffect(() => {
    docRef.current = doc;
    primsRef.current.forEach((p) => {
      p.update();
    });
  }, [doc]);

  // 时间轴取图上真有的 series 灌进去的点(同编辑器:data 里还有图上不画的源线,算进来下标会错位)
  useEffect(() => {
    axisRef.current = timeAxis([...seriesRef.current.values()].flatMap((s) => s.data().map((p) => fmtDate(p.time))));
    primsRef.current.forEach((p) => {
      p.update();
    });
  }, [seriesRef, doc, data]);

  // 每个 lw 格挂上图元(加格后新格要挂,删掉的格丢掉)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const prims = primsRef.current;
    const panes = chart.panes();

    [...prims.keys()]
      .filter((api) => !panes.includes(api))
      .forEach((api) => {
        prims.delete(api);
      });
    panes
      .filter((api) => !prims.has(api))
      .forEach((api) => {
        const prim = new DrawingsPrimitive(() => {
          const ctx = makeShapeCtx(chart, seriesRef.current, axisRef.current);
          // 所属图层被图例眼睛按钮隐藏的不画(同编辑器)
          const entries = allDrawings(docRef.current).filter((e) => !e.layer.hidden);
          const ink = CHART_CHROME[getTheme()];

          return {
            shapes: ctx ? paneShapes(ctx, entries, api.paneIndex()) : [],
            selected: null,
            ink: { text: ink.ink, bg: ink.bg },
          };
        }, false);

        api.attachPrimitive(prim);
        prims.set(api, prim);
      });
    prims.forEach((p) => {
      p.update();
    });
  }, [chartRef, seriesRef, doc]);
}
