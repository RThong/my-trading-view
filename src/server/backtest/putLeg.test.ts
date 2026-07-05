import { test, expect } from 'bun:test';
import { overlayPut, type PutConfig, type PutDay } from './putLeg';
import type { EquityPoint } from './engine';

const cfg: PutConfig = { protectedNotional: 0.2, premiumBudgetAnnual: 0.02, moneyness: 1, tenorDays: 21, skewMarkup: 1.1 };

// 由 QQQ 价格序列造 base(纯 QQQ 净值)+ PutDay 序列。
const build = (qqqPath: number[], vxn: number, greed: boolean[]) => {
  const base: EquityPoint[] = qqqPath.map((q, i) => ({ date: `d${i}`, value: q / qqqPath[0] }));
  const days: PutDay[] = qqqPath.map((q, i) => ({ date: `d${i}`, qqq: q, vxn, greed: greed[i] }));
  return { base, days };
};

test('非贪婪期:叠加层 == base(putValue 恒 0)', () => {
  const q = [100, 101, 99, 102, 100];
  const { base, days } = build(q, 20, q.map(() => false));
  const out = overlayPut(base, days, cfg);
  out.forEach((p, i) => expect(p.value).toBeCloseTo(base[i].value, 10));
});

test('贪婪 + QQQ 平静:时间衰减(theta)拖累,末值略低于 base(=1)', () => {
  const q = Array(30).fill(100); // QQQ 全程不动
  const { base, days } = build(q, 20, q.map(() => true));
  const out = overlayPut(base, days, cfg);
  expect(out[out.length - 1].value).toBeLessThan(1);       // 权利金被 theta 烧掉一点
  expect(out[out.length - 1].value).toBeGreaterThan(0.97); // 但只是小拖累(预算 2%/年量级)
});

test('贪婪 + 大跌:put 赔付使叠加 NAV 高于纯下跌 base', () => {
  const q = [100, 100, 100, 70]; // 末日 QQQ 暴跌 30%
  const { base, days } = build(q, 20, q.map(() => true));
  const out = overlayPut(base, days, cfg);
  expect(out[out.length - 1].value).toBeGreaterThan(base[base.length - 1].value); // 凸性护住
});

test('权利金预算上限:预算越小,平静期拖累越小(份数被缩)', () => {
  const q = Array(30).fill(100);
  const { base, days } = build(q, 20, q.map(() => true));
  const big = overlayPut(base, days, { ...cfg, premiumBudgetAnnual: 0.05 });
  const small = overlayPut(base, days, { ...cfg, premiumBudgetAnnual: 0.005 });
  expect(small[small.length - 1].value).toBeGreaterThan(big[big.length - 1].value); // 小预算 → 少买 → 少拖累
});
