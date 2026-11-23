import { expect, test } from 'bun:test';
import type { IChartApi } from 'lightweight-charts';
import { chartTimeAxis } from './drawingShapes';
import { timelineSlotsOf } from './useDocChart';

// 只模拟 chartTimeAxis 用到的那点 API:各格的 series 与它们灌进去的点
function fakeChart(seriesTimes: string[][]): IChartApi {
  const series = seriesTimes.map((times) => ({ data: () => times.map((time) => ({ time })) }));
  return { panes: () => [{ getSeries: () => series }] } as unknown as IChartApi;
}

test('chartTimeAxis:下标 = 交易日序列 + 含周末的日历日序列 + 占位格的并集(和 lw 时间轴一致)', () => {
  // 交易日序列缺 11-24(假日);日历日序列有周六 11-22;11-24 只在占位格里
  const chart = fakeChart([
    ['2025-11-20', '2025-11-21', '2025-11-25'],
    ['2025-11-21', '2025-11-22'],
  ]);
  timelineSlotsOf.set(chart, ['2025-11-20', '2025-11-21', '2025-11-24', '2025-11-25']);
  const axis = chartTimeAxis(chart);

  // 并集:11-20, 11-21, 11-22, 11-24, 11-25
  expect(axis.toLogical('2025-11-22')).toBe(2);
  expect(axis.toLogical('2025-11-24')).toBe(3);
  expect(axis.toLogical('2025-11-25')).toBe(4);
});
