import { describe, expect, it } from 'bun:test';
import { etInstant, projectDividends, quoted, windowDividendYield } from './repairMoomooOptions';

describe('repairMoomooOptions 的日期 / 分红 / 报价判定', () => {
  it('美东时刻按当天的冬令 / 夏令时换算(跨切换日也对)', () => {
    expect(new Date(etInstant('2026-07-15', '16:00')).toISOString()).toBe('2026-07-15T20:00:00.000Z'); // 夏令 UTC−4
    expect(new Date(etInstant('2026-11-13', '16:00')).toISOString()).toBe('2026-11-13T21:00:00.000Z'); // 冬令 UTC−5
    expect(new Date(etInstant('2026-11-02', '16:00')).toISOString()).toBe('2026-11-02T21:00:00.000Z'); // 11-01 切回冬令后
  });

  it('分红窗口 = (快照日, 到期日]:快照日当天除息的不算,到期日当天的算', () => {
    const divs = [
      { date: '2026-11-02', amount: 0.3 },
      { date: '2026-12-01', amount: 0.33 },
      { date: '2026-12-11', amount: 0.1 },
    ];
    expect(windowDividendYield(divs, '2026-11-02', '2026-12-11', 80, 0.1)).toBeCloseTo((0.33 + 0.1) / 80 / 0.1, 12);
  });

  it('源里没有的未来除息按最后金额补到每月第一个工作日,只补到截止日', () => {
    const got = projectDividends([{ date: '2026-11-02', amount: 0.34 }], '2027-02-01');
    // 12-01 周二;2027-01-01 周五(元旦不在这里处理,ponytail 近似);2027-02-01 周一
    expect(got.map((d) => d.date)).toEqual(['2026-11-02', '2026-12-01', '2027-01-01', '2027-02-01']);
    expect(got.at(-1)?.amount).toBe(0.34);
  });

  it('有效报价:买卖都 > 0 且价差 ≤ 中间价的 50%(刚好 50% 算有效)', () => {
    const c = (bid: number, ask: number) => ({ bid, ask }) as never;
    expect(quoted(c(0.8, 1.2))).toBe(true); // 价差 0.4 = 中间价 1.0 的 40%
    expect(quoted(c(0.6, 1.0))).toBe(true); // 0.4 / 0.8 = 50%
    expect(quoted(c(0.5, 1.8))).toBe(false); // 夜盘那种宽报价
    expect(quoted(c(0, 1.8))).toBe(false);
  });
});
