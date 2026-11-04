import { expect, test } from 'bun:test';
import type { Pane } from './chartDoc';
import { distToSpan, nativeScale, nearest, shiftRange } from './useLineDrag';

function pane(scales: string[]): Pane {
  return {
    id: 'p1',
    stretch: 1,
    scales: [],
    layers: scales.map((scale, i) => ({ id: `l${i}`, series: 'SPY', scale, color: '#000000' })),
  };
}

test('nativeScale:右轴有线就是右轴,否则左轴', () => {
  expect(nativeScale(pane(['left', 'right']))).toBe('right');
  expect(nativeScale(pane(['left', 's1']))).toBe('left');
});

test('nearest:取 15px 以内最近的;都太远 → undefined', () => {
  expect(
    nearest([
      { item: 'a', dist: 9 },
      { item: 'b', dist: 3 },
      { item: 'c', dist: 30 },
    ]),
  ).toBe('b');
  expect(nearest([{ item: 'a', dist: 16 }])).toBeUndefined();
  expect(nearest([])).toBeUndefined();
});

test('shiftRange:内容往下走 = 区间整体加 perPx × dy;倒轴 perPx 为负', () => {
  expect(shiftRange({ from: 0, to: 100, perPx: 0.2 }, 50)).toEqual({ from: 10, to: 110 });
  expect(shiftRange({ from: 0, to: 100, perPx: -0.2 }, 50)).toEqual({ from: -10, to: 90 });
});

test('distToSpan:落在竖条里为 0,否则到最近一端的距离', () => {
  expect(distToSpan(50, [40, 70, 55])).toBe(0);
  expect(distToSpan(30, [40, 70])).toBe(10);
  expect(distToSpan(80, [40, 70])).toBe(10);
});
