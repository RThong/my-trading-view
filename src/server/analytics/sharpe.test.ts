import { describe, test, expect } from 'bun:test';
import { rollingSharpe } from './sharpe';
import type { Point } from './vrp';

const px = (vals: number[]): Point[] =>
  vals.map((value, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value }));

describe('rollingSharpe', () => {
  test('零波动窗口被丢弃,不出 Infinity', () => {
    // 每步翻倍:log 收益恒为 ln2 → 窗口内 sd=0 → 该点不应出现(否则 mean/0 = Infinity)。
    expect(rollingSharpe(px([1, 2, 4, 8]), 2, 365)).toHaveLength(0);
  });

  test('对称涨跌 → 均值 0 → 夏普 0', () => {
    const out = rollingSharpe(px([100, 110, 100, 110, 100]), 2, 365);

    expect(out).toHaveLength(3);
    for (const p of out) expect(p.value).toBeCloseTo(0, 9);
  });

  test('年化因子按 periodsPerYear 缩放', () => {
    const prices = px([100, 105, 103, 112, 108, 120]);
    const a = rollingSharpe(prices, 3, 365);
    const b = rollingSharpe(prices, 3, 1);

    expect(a).toHaveLength(b.length);
    expect(a[0].value).toBeCloseTo(b[0].value * Math.sqrt(365), 9);
  });
});
