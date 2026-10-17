import { describe, test, expect } from 'bun:test';
import { monthlyExpiry, nextMonthlyExpiry } from './monthlyExpiry';

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('monthlyExpiry', () => {
  test('ETF:第三个周五', () => {
    expect(iso(monthlyExpiry('equity', 2026, 10))).toBe('2026-11-20');
    expect(iso(monthlyExpiry('equity', 2026, 11))).toBe('2026-12-18');
    expect(iso(monthlyExpiry('equity', 2027, 0))).toBe('2027-01-15');
  });

  test('VIX:次月第三个周五往前 30 天的周三(与 VX 期货结算日一致)', () => {
    // 2026-11-18 / 2026-12-16 是 CBOE 公布的 VX 到期日(库里 VX:<到期日> 序列)。
    expect(iso(monthlyExpiry('vix', 2026, 10))).toBe('2026-11-18');
    expect(iso(monthlyExpiry('vix', 2026, 11))).toBe('2026-12-16');
    expect(monthlyExpiry('vix', 2026, 11).getUTCDay()).toBe(3);
  });
});

describe('nextMonthlyExpiry', () => {
  const today = new Date('2026-10-17T00:00:00Z');

  test('取第一个 DTE ≥ 60 的月度', () => {
    expect(nextMonthlyExpiry('equity', today, 60)).toBe('2026-12-18'); // 11-20 只有 34 天
    expect(nextMonthlyExpiry('vix', today, 60)).toBe('2026-12-16');
  });

  test('正好 minDte 天的月度不因当天钟点被跳过', () => {
    expect(nextMonthlyExpiry('vix', new Date('2026-10-17T15:30:00Z'), 60)).toBe('2026-12-16');
  });

  test('跨年', () => {
    expect(nextMonthlyExpiry('equity', new Date('2026-12-01T00:00:00Z'), 60)).toBe('2027-02-19');
  });
});
