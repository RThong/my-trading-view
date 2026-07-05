import { test, expect } from 'bun:test';
import { computeStates, type SpreadPoint, type SignalConfig } from './signal';

const cfg = (over: Partial<SignalConfig> = {}): SignalConfig => ({
  warmup: 3, panicEntry: 'C', panicEnterRank: 85, panicExitRank: 50, greedEnterRank: 10, greedExitRank: 30, ...over,
});

const mkSpread = (vals: number[]): SpreadPoint[] =>
  vals.map((v, i) => ({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, value: v }));

test('无未来函数:追加未来数据,历史某天状态不变', () => {
  const base = mkSpread([-3, -2, -1, 0.5, -1, -2, 5, -1]);
  const extended = mkSpread([-3, -2, -1, 0.5, -1, -2, 5, -1, 8, -4, 9]); // 末尾追加
  const s1 = computeStates(base, cfg());
  const s2 = computeStates(extended, cfg());
  // base 的每一天,在 extended 里状态必须完全一致(rank 只用截至当天的数据)
  for (let t = 0; t < base.length; t++) {
    expect(s2[t]).toEqual(s1[t]);
  }
});

test('预热期内无信号', () => {
  const s = computeStates(mkSpread([5, 5, 5, -5]), cfg({ warmup: 3 }));
  expect(s.slice(0, 3).every((d) => !d.panic && !d.greed)).toBe(true);
});

test('入场变体 A(仅 backwardation)vs B(仅 rank)不同', () => {
  // 远期有高 spread 抬高分布;近几天转负(panic 保持 false),末天略正(backwardation)但 rank 仅 ~50。
  const vals = [15, 12, 10, -1, -2, -1, 0.5];
  const a = computeStates(mkSpread(vals), cfg({ warmup: 3, panicEntry: 'A' }));
  const b = computeStates(mkSpread(vals), cfg({ warmup: 3, panicEntry: 'B' }));
  expect(a[6].panic).toBe(true);   // A:0.5>0 backwardation → 入场
  expect(b[6].panic).toBe(false);  // B:rank≈50 < 85 → 不入场
});

test('互斥:变体 A 下 backwardation + 低 rank 也不会同日 panic&greed', () => {
  // 远期高 spread 抬高分布;末天 0.5>0(A 触发 panic)但 rank 极低(本会触发 greed)。
  const vals = [...Array.from({ length: 20 }, (_, i) => 100 - i), -5, 0.5];
  const s = computeStates(mkSpread(vals), cfg({ warmup: 3, panicEntry: 'A' }));
  expect(s.every((d) => !(d.panic && d.greed))).toBe(true); // 全程不同时为真
  expect(s[s.length - 1].panic).toBe(true);                  // 末天 backwardation → panic 优先
  expect(s[s.length - 1].greed).toBe(false);                 // greed 被压掉
});

test('滞后:恐慌进入后在 exit 阈值以上保持,不抽搐', () => {
  // 先冲高触发 panic,再回落到 50~85 之间应保持 panic
  const vals = [-3, -2, -1, 12, 6, 5]; // day3 大幅 backwardation 触发;后面回落但 rank 仍 > 50
  const s = computeStates(mkSpread(vals), cfg({ warmup: 3, panicEntry: 'B' }));
  expect(s[3].panic).toBe(true);
  // day4/5 rank 仍在中高位(> 50)→ 保持
  expect(s[4].panic).toBe(true);
});
