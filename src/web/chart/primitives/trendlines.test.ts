import { expect, test } from 'bun:test';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { TrendLine } from '../trendlines';
import { TrendLinePrimitive } from './trendlines';
import { recordingCanvas } from './recordingCanvas.testutil';

// 假的坐标换算:logical × 10 = x(负的算在可视区外 → null),y = 100 − price
const chart = {
  timeScale: () => ({ logicalToCoordinate: (l: number) => (l < 0 ? null : l * 10) }),
} as unknown as IChartApi;
const series = { priceToCoordinate: (p: number) => 100 - p } as unknown as ISeriesApi<SeriesType>;

const ON: TrendLine = { a: { logical: 1, price: 10 }, b: { logical: 5, price: 30 } };
const OFF: TrendLine = { a: { logical: -1, price: 10 }, b: { logical: 5, price: 30 } };

function draw(setup: (p: TrendLinePrimitive) => void) {
  const prim = new TrendLinePrimitive(chart, series);
  setup(prim);
  const canvas = recordingCanvas();
  prim.paneViews()[0].renderer()?.draw(canvas.target);

  return canvas;
}

test('锚点 (logical, price) 投影成像素画线;有一端在可视区外的整条不画', () => {
  const c = draw((p) => p.setLines([ON, OFF], null));
  expect(c.argsOf('moveTo')).toEqual([[10, 90]]);
  expect(c.argsOf('lineTo')).toEqual([[50, 70]]);
});

test('设了手柄的那条线两端画实心圆;画线中的预览另画一段虚线', () => {
  const c = draw((p) => {
    p.setLines([ON], 0);
    p.setHandles(0);
    p.setPreview({ a: { logical: 2, price: 0 }, b: { logical: 3, price: 50 } });
  });
  expect(c.argsOf('arc').map(([x, y]) => [x, y])).toEqual([
    [10, 90],
    [50, 70],
  ]);
  expect(c.argsOf('moveTo')).toContainEqual([20, 100]);
  expect(c.argsOf('setLineDash')).toContainEqual([[4, 4]]);
});
