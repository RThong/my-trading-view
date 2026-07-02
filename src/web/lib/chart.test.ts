import { describe, test, expect } from 'bun:test';
import { changeStats } from './chart';

describe('changeStats', () => {
  test('正常涨幅', () => {
    const r = changeStats(6.32, 5.86)!;
    expect(r.delta).toBeCloseTo(0.46, 2);
    expect(r.pct!).toBeCloseTo(7.85, 1);
  });

  test('负基数:值涨则 % 为正(分母用 |prev|)', () => {
    expect(changeStats(-1, -2)).toEqual({ delta: 1, pct: 50 });
  });

  test('前值为 0:有 Δ,无 %(除零)', () => {
    expect(changeStats(3, 0)).toEqual({ delta: 3, pct: null });
  });

  test('无前值(第一根):返回 null', () => {
    expect(changeStats(3, undefined)).toBeNull();
  });
});
