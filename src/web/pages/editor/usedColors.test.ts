import { expect, test } from 'bun:test';
import { DRAWING_COLOR } from '../../chart/drawings';
import type { ChartDoc } from '../../views/chartDoc/chartDoc';
import { usedColors } from './usedColors';

test('usedColors:线色 + 画线颜色(没设 = 默认黄),去重小写;蜡烛 / 指标的图层颜色不算', () => {
  const pt = { time: '2025-11-20', value: 1 };
  const doc: ChartDoc = {
    v: 1,
    panes: [
      {
        id: 'p',
        stretch: 2,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'a',
            scale: 'right',
            color: '#3987E5',
            series: 'vix',
            drawings: [{ id: 'd1', kind: 'hline', value: 1 }],
          },
          {
            id: 'b',
            scale: 'right',
            color: '#199e70',
            series: 'yh:SPY',
            render: { kind: 'candle' },
            drawings: [{ id: 'd2', kind: 'callout', a: pt, b: pt, text: 'x', color: '#3987e5' }],
          },
        ],
      },
    ],
  };

  expect(usedColors(doc)).toEqual(['#3987e5', DRAWING_COLOR]);
});
