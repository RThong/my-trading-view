import { describe, expect, test } from 'bun:test';
import { flowLayout } from './flowLayout';

describe('flowLayout', () => {
  test('放得下排一行,放不下换行;行宽不含行尾间距', () => {
    expect(flowLayout([30, 30, 30], 100, 10)).toEqual({
      items: [
        { x: 0, row: 0 },
        { x: 40, row: 0 },
        { x: 0, row: 1 },
      ],
      rowWidths: [70, 30],
    });
  });

  test('单项比一行还宽时独占一行;空数组没有行', () => {
    expect(flowLayout([150, 20], 100, 10).items).toEqual([
      { x: 0, row: 0 },
      { x: 0, row: 1 },
    ]);
    expect(flowLayout([], 100, 10)).toEqual({ items: [], rowWidths: [] });
  });
});
