import { describe, test, expect } from 'bun:test';
import { changeStats, needsLogScale, clampPriceRange, clampAutoscaleProvider, type Bar } from './chart';

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

describe('needsLogScale', () => {
  const bars = (lows: number[], highs: number[]): Bar[] =>
    lows.map((low, i) => ({ time: `2026-01-0${i + 1}`, open: low, high: highs[i], low, close: highs[i] }));

  test('跨两个数量级以上 → 对数', () => {
    expect(needsLogScale(bars([4, 60000], [5, 124785]))).toBe(true); // BTC:29500 倍
  });

  test('本站其余标的最宽只有 9 倍 → 线性', () => {
    expect(needsLogScale(bars([17, 140], [20, 153]))).toBe(false); // USO
    expect(needsLogScale(bars([136, 700], [140, 745]))).toBe(false); // QQQ
  });

  // 脏数据:非正的 low 进了 Math.min 会让比值变 0 或负,判据失效。
  test('非正 low 被忽略,不影响判定', () => {
    expect(needsLogScale(bars([0, 4, 60000], [1, 5, 124785]))).toBe(true);
    expect(needsLogScale(bars([0], [1]))).toBe(false); // 全是脏数据 → 不切对数
  });
});

test('clampPriceRange:数据在框内时不动(求交不是覆盖)', () => {
  expect(clampPriceRange({ minValue: -1.2, maxValue: 2.4 }, [-5, 5])).toEqual({ minValue: -1.2, maxValue: 2.4 });
});

test('clampPriceRange:极值撑破框时只夹被撑破的那一侧', () => {
  expect(clampPriceRange({ minValue: -27.3, maxValue: 4.1 }, [-5, 5])).toEqual({ minValue: -5, maxValue: 4.1 });
  expect(clampPriceRange({ minValue: -2, maxValue: 60 }, [-15, 15])).toEqual({ minValue: -2, maxValue: 15 });
});

test('clampPriceRange:可视窗口整段落在框外 → 退回原范围,不能让那格空掉', () => {
  // 缩放到 Uri 那几周:全部数据都 < −5,夹出来会倒挂(min −5 > max −20)。
  expect(clampPriceRange({ minValue: -27.3, maxValue: -20 }, [-5, 5])).toEqual({ minValue: -27.3, maxValue: -20 });
  // 退化成一点(min === max)同样不可用 → 退回。
  expect(clampPriceRange({ minValue: -27.3, maxValue: -5 }, [-5, 5])).toEqual({ minValue: -27.3, maxValue: -5 });
});

test('clampAutoscaleProvider:priceRange 为 null 时原样退回,不去夹不存在的范围', () => {
  const provider = clampAutoscaleProvider<{ priceRange: { minValue: number; maxValue: number } | null }>([-5, 5]);

  expect(provider(() => null)).toBeNull();
  const noRange = { priceRange: null };
  expect(provider(() => noRange)).toBe(noRange); // 原对象退回,不是新造一个
});

test('clampAutoscaleProvider:有范围时按 clampPriceRange 求交,且保留其余字段', () => {
  const provider = clampAutoscaleProvider<{
    priceRange: { minValue: number; maxValue: number } | null;
    margins?: { above: number; below: number };
  }>([-5, 5]);

  const info = { priceRange: { minValue: -27.3, maxValue: 4.1 }, margins: { above: 10, below: 10 } };
  expect(provider(() => info)).toEqual({
    priceRange: { minValue: -5, maxValue: 4.1 },
    margins: { above: 10, below: 10 }, // margins 不能被丢掉
  });
});
