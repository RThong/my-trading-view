import { describe, expect, test } from 'bun:test';
import { seriesHealth, trailingFlat, weekdaysBetween } from './freshness';

function pts(entries: [string, number][]) {
  return entries.map(([time, value]) => ({ time, value }));
}

describe('weekdaysBetween / trailingFlat', () => {
  test('两端不含、跳过周末', () => {
    // 2026-11-13 周五 → 11-16 周一:中间只有周末
    expect(weekdaysBetween('2026-11-13', '2026-11-16')).toBe(0);
    expect(weekdaysBetween('2026-11-11', '2026-11-16')).toBe(2);
    expect(weekdaysBetween('2026-11-16', '2026-11-16')).toBe(0);
  });

  test('末尾连续相同值个数', () => {
    expect(trailingFlat([1, 2, 2, 2])).toBe(3);
    expect(trailingFlat([1, 2])).toBe(1);
    expect(trailingFlat([])).toBe(0);
  });
});

describe('seriesHealth', () => {
  const today = '2026-11-16';

  test('日频:按工作日判偏晚 / 过期', () => {
    expect(seriesHealth(pts([['2026-11-13', 1]]), '日', today)).toEqual({ status: 'ok', latest: '2026-11-13', lag: 0 });
    expect(seriesHealth(pts([['2026-11-11', 1]]), '日', today).status).toBe('late');
    expect(seriesHealth(pts([['2026-11-06', 1]]), '日', today).status).toBe('stale');
  });

  test('日频:末尾 5 点完全相同 = 疑似填平;flatOk 跳过;日期已过期时报过期', () => {
    const flat = pts([
      ['2026-11-06', 2],
      ['2026-11-09', 3],
      ['2026-11-10', 3],
      ['2026-11-11', 3],
      ['2026-11-12', 3],
      ['2026-11-13', 3],
    ]);
    expect(seriesHealth(flat, '日', today).status).toBe('flat');
    expect(seriesHealth(flat, '日', today, { flatOk: true }).status).toBe('ok');
    expect(seriesHealth(flat, '日', '2026-12-01').status).toBe('stale');
  });

  test('月频按日历天;可单条覆盖门槛;不定只报最新日期;没点 = empty', () => {
    expect(seriesHealth(pts([['2026-10-01', 1]]), '月', today).status).toBe('ok');
    // 11-16 还只有 9 月的数:慢的源(内閣府 CI)10 月的要 12 月上旬才发,不算晚
    expect(seriesHealth(pts([['2026-09-01', 1]]), '月', today).status).toBe('ok');
    expect(seriesHealth(pts([['2026-07-01', 1]]), '月', today).status).toBe('late');
    expect(seriesHealth(pts([['2026-06-01', 1]]), '月', today).status).toBe('stale');
    expect(seriesHealth(pts([['2026-06-01', 1]]), '月', today, { rule: { late: 200, stale: 250 } }).status).toBe('ok');
    expect(seriesHealth(pts([['2020-01-01', 1]]), '不定', today)).toEqual({ status: 'unknown', latest: '2020-01-01' });
    expect(seriesHealth(pts([['2026-12-31', 1]]), '季', today)).toEqual({ status: 'unknown', latest: '2026-12-31' });
    expect(seriesHealth([], '日', today)).toEqual({ status: 'empty' });
  });
});
