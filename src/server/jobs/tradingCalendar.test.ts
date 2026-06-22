import { describe, test, expect } from 'bun:test';
import { lastClosedTradingDate, lastClosedFrom } from './tradingCalendar';

describe('lastClosedTradingDate', () => {
  test('Sunday rolls back to Friday', () => {
    // 2026-05-17 周日,任意 UTC 时刻 → 周五 2026-05-15
    expect(lastClosedTradingDate(new Date('2026-05-17T05:00:00Z'))).toBe('2026-05-15');
    expect(lastClosedTradingDate(new Date('2026-05-17T18:00:00Z'))).toBe('2026-05-15');
    expect(lastClosedTradingDate(new Date('2026-05-17T23:59:00Z'))).toBe('2026-05-15');
  });

  test('Saturday rolls back to Friday', () => {
    expect(lastClosedTradingDate(new Date('2026-05-16T12:00:00Z'))).toBe('2026-05-15');
  });

  test('Friday after close → Friday', () => {
    // 周五 2026-05-15 16:00 ET = 20:00 UTC(夏令时:ET = UTC-4)
    expect(lastClosedTradingDate(new Date('2026-05-15T20:30:00Z'))).toBe('2026-05-15');
  });

  test('Friday before close → Thursday', () => {
    // 周五 2026-05-15 10:00 ET = 14:00 UTC
    expect(lastClosedTradingDate(new Date('2026-05-15T14:00:00Z'))).toBe('2026-05-14');
  });

  test('Monday after close → Monday', () => {
    // 周一 2026-05-18 17:00 ET = 21:00 UTC
    expect(lastClosedTradingDate(new Date('2026-05-18T21:00:00Z'))).toBe('2026-05-18');
  });

  test('Monday before close → Friday (skipping weekend)', () => {
    // 周一 2026-05-18 10:00 ET = 14:00 UTC
    expect(lastClosedTradingDate(new Date('2026-05-18T14:00:00Z'))).toBe('2026-05-15');
  });

  test('JST 8 AM = previous day 7 PM ET (after close)', () => {
    // 周二 JST 上午 8 点 2026-05-19 = 周一 UTC 晚 11 点 = 周一 ET 晚 7 点。周一下午 4 点已收盘。
    // 所以最近一个已收盘的交易日 = 周一 2026-05-18。
    expect(lastClosedTradingDate(new Date('2026-05-18T23:00:00Z'))).toBe('2026-05-18');
  });

  test('JST 8 AM Mon = Sunday 7 PM ET → Friday', () => {
    // 周一 JST 上午 8 点 2026-05-18 = 周日 23:00 UTC = 周日 ET 晚 7 点
    expect(lastClosedTradingDate(new Date('2026-05-17T23:00:00Z'))).toBe('2026-05-15');
  });
});

describe('lastClosedFrom(权威交易日列表)', () => {
  // 06-19 是 Juneteenth 休市,所以不在权威列表里。
  const days = ['2026-06-16', '2026-06-17', '2026-06-18']; // 二/三/四

  test('跳过休市日:周日 → 06-18(而非按日历猜的周五 06-19)', () => {
    expect(lastClosedFrom(days, new Date('2026-06-21T12:00:00Z'))).toBe('2026-06-18');
  });

  test('今日在列表且已收盘(ET≥16:00)→ 今日', () => {
    // 06-18 20:30Z = 16:30 ET,已收盘
    expect(lastClosedFrom(days, new Date('2026-06-18T20:30:00Z'))).toBe('2026-06-18');
  });

  test('今日在列表但未收盘(ET<16:00)→ 前一交易日', () => {
    // 06-18 14:00Z = 10:00 ET,未收盘
    expect(lastClosedFrom(days, new Date('2026-06-18T14:00:00Z'))).toBe('2026-06-17');
  });

  test('空列表 → null(上层回退本地推算)', () => {
    expect(lastClosedFrom([], new Date('2026-06-21T12:00:00Z'))).toBeNull();
  });
});
