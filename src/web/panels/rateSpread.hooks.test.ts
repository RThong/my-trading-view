import { describe, expect, it } from 'bun:test';
import { spreadSeries } from './rateSpread.hooks';

const long = [
  { date: '2026-01-01', value: 4.5 },
  { date: '2026-01-02', value: 4.6 }, // short 缺此日 → 贴 01-01
  { date: '2026-01-05', value: 4.4 }, // short 贴 01-03
];
const short = [
  { date: '2026-01-01', value: 4.0 },
  { date: '2026-01-03', value: 3.9 },
];

describe('spreadSeries', () => {
  it('按日期对齐相减,short 向前贴处理缺口', () => {
    const r = spreadSeries(long, short);
    expect(r.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-05']);
    expect(r[0].value).toBeCloseTo(0.5); // 4.5-4.0
    expect(r[1].value).toBeCloseTo(0.6); // 4.6-4.0(贴 01-01)
    expect(r[2].value).toBeCloseTo(0.5); // 4.4-3.9(贴 01-03)
  });

  it('long 早于 short 首个观测的点被跳过(贴不到)', () => {
    const long2 = [{ date: '2025-12-31', value: 4.0 }, { date: '2026-01-01', value: 4.5 }];
    expect(spreadSeries(long2, short).map((p) => p.date)).toEqual(['2026-01-01']);
  });

  it('任一序列缺失 → 空数组', () => {
    expect(spreadSeries(undefined, short)).toEqual([]);
    expect(spreadSeries(long, undefined)).toEqual([]);
  });
});
