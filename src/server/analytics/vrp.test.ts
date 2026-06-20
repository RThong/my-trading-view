import { describe, test, expect } from 'bun:test';
import { realizedVol, computeVrp, type Point } from './vrp';

describe('realizedVol', () => {
  test('恒定对数收益 → 样本标准差 0 → RV 0', () => {
    // 每步翻倍:log 收益恒为 ln2,窗口内方差为 0。
    const prices: Point[] = [
      { date: '2026-01-01', value: 1 },
      { date: '2026-01-02', value: 2 },
      { date: '2026-01-03', value: 4 },
      { date: '2026-01-04', value: 8 },
    ];
    const rv = realizedVol(prices, 2, 252);
    expect(rv).toHaveLength(2); // rets 有 3 个,window=2 → 输出 2 个
    expect(rv[0].date).toBe('2026-01-03');
    for (const p of rv) expect(p.value).toBeCloseTo(0, 9);
  });

  test('跳过非正价格,不产生 NaN', () => {
    const prices: Point[] = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 0 },   // 脏数据:应被跳过
      { date: '2026-01-03', value: 110 },
      { date: '2026-01-04', value: 121 },
    ];
    const rv = realizedVol(prices, 2, 252);
    for (const p of rv) expect(Number.isFinite(p.value)).toBe(true);
  });

  test('数据不足一个窗口 → 返回空,不崩', () => {
    expect(realizedVol([{ date: '2026-01-01', value: 1 }], 21, 252)).toHaveLength(0);
  });
});

describe('computeVrp', () => {
  test('iv−rv,按日期 inner join(只留两边都有的日)', () => {
    const iv: Point[] = [
      { date: '2026-01-01', value: 20 },
      { date: '2026-01-02', value: 22 },
      { date: '2026-01-03', value: 25 },
    ];
    const rv: Point[] = [
      { date: '2026-01-02', value: 15 },
      { date: '2026-01-03', value: 18 },
      { date: '2026-01-04', value: 19 }, // iv 无此日 → 丢弃
    ];
    const out = computeVrp(iv, rv);
    expect(out.map((p) => p.date)).toEqual(['2026-01-02', '2026-01-03']);
    expect(out[0]).toEqual({ date: '2026-01-02', iv: 22, rv: 15, vrp: 7 });
    expect(out[1].vrp).toBe(7);
  });
});
