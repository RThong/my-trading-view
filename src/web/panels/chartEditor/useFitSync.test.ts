import { expect, test } from 'bun:test';
import { mapRange } from './useFitSync';

test('mapRange:A 轴范围按 a = alpha + beta × b 反解成 B 轴范围,反向时上下互换', () => {
  // 黄金 ≈ 2000 − 400 × 实际利率:黄金轴 1200~2400 ↔ 实际利率 −1~2
  expect(mapRange({ from: 1200, to: 2400 }, { alpha: 2000, beta: -400 })).toEqual({ from: -1, to: 2 });
  expect(mapRange({ from: 10, to: 30 }, { alpha: 0, beta: 10 })).toEqual({ from: 1, to: 3 });
});
