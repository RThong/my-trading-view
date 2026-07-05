import { test, expect } from 'bun:test';
import { metrics, episodes } from './metrics';
import type { EquityPoint } from './engine';
import type { DayState } from './signal';

test('CAGR:1 年翻倍 → 100%', () => {
  // 252 个交易日,净值从 1 到 2
  const eq: EquityPoint[] = Array.from({ length: 253 }, (_, i) => ({ date: `d${i}`, value: 1 * 2 ** (i / 252) }));
  expect(metrics(eq).cagr).toBeCloseTo(1.0, 3);
});

test('MDD:峰值 1.5 回落到 1.2 → -20%', () => {
  const eq: EquityPoint[] = [1, 1.5, 1.2, 1.3].map((v, i) => ({ date: `d${i}`, value: v }));
  expect(metrics(eq).mdd).toBeCloseTo(-0.2, 6);
});

test('episode 计数:false→true 的次数', () => {
  const s: DayState[] = [false, true, true, false, false, true].map((p) => ({ date: '', panic: p, greed: false }));
  expect(episodes(s, 'panic')).toEqual({ days: 3, episodes: 2 });
});
