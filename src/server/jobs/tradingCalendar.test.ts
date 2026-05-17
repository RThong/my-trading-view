import { describe, test, expect } from 'bun:test';
import { lastClosedTradingDate } from './tradingCalendar';

describe('lastClosedTradingDate', () => {
  test('Sunday rolls back to Friday', () => {
    // 2026-05-17 Sun, any UTC hour → Friday 2026-05-15
    expect(lastClosedTradingDate(new Date('2026-05-17T05:00:00Z'))).toBe('2026-05-15');
    expect(lastClosedTradingDate(new Date('2026-05-17T18:00:00Z'))).toBe('2026-05-15');
    expect(lastClosedTradingDate(new Date('2026-05-17T23:59:00Z'))).toBe('2026-05-15');
  });

  test('Saturday rolls back to Friday', () => {
    expect(lastClosedTradingDate(new Date('2026-05-16T12:00:00Z'))).toBe('2026-05-15');
  });

  test('Friday after close → Friday', () => {
    // Friday 2026-05-15 16:00 ET = 20:00 UTC (DST: ET = UTC-4)
    expect(lastClosedTradingDate(new Date('2026-05-15T20:30:00Z'))).toBe('2026-05-15');
  });

  test('Friday before close → Thursday', () => {
    // Friday 2026-05-15 10:00 ET = 14:00 UTC
    expect(lastClosedTradingDate(new Date('2026-05-15T14:00:00Z'))).toBe('2026-05-14');
  });

  test('Monday after close → Monday', () => {
    // Monday 2026-05-18 17:00 ET = 21:00 UTC
    expect(lastClosedTradingDate(new Date('2026-05-18T21:00:00Z'))).toBe('2026-05-18');
  });

  test('Monday before close → Friday (skipping weekend)', () => {
    // Monday 2026-05-18 10:00 ET = 14:00 UTC
    expect(lastClosedTradingDate(new Date('2026-05-18T14:00:00Z'))).toBe('2026-05-15');
  });

  test('JST 8 AM = previous day 7 PM ET (after close)', () => {
    // 8 AM Tue JST 2026-05-19 = 11 PM Mon UTC = 7 PM Mon ET. Market closed at 4 PM Mon.
    // So most recent closed trading day = Monday 2026-05-18.
    expect(lastClosedTradingDate(new Date('2026-05-18T23:00:00Z'))).toBe('2026-05-18');
  });

  test('JST 8 AM Mon = Sunday 7 PM ET → Friday', () => {
    // 8 AM Mon JST 2026-05-18 = Sun 23:00 UTC = Sun 7 PM ET
    expect(lastClosedTradingDate(new Date('2026-05-17T23:00:00Z'))).toBe('2026-05-15');
  });
});
