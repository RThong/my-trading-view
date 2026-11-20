import { test, expect } from 'bun:test';
import { planPairs, nearestKnown } from './tradingDayPairs';

test('planPairs:其余两两配对;最新一天和单出来的天各配库里最近的已知交易日,没有就配前一天', () => {
  expect(planPairs(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], ['2026-11-09'])).toEqual([
    ['2026-11-10', '2026-11-11'],
    ['2026-11-09', '2026-11-12'],
    ['2026-11-09', '2026-11-13'],
  ]);
  expect(planPairs(['2026-11-13'], [])).toEqual([['2026-11-12', '2026-11-13']]);
  expect(planPairs([], ['2026-11-09'])).toEqual([]);
});

test('nearestKnown:不含自己,前后取最近', () => {
  expect(nearestKnown('2026-11-12', ['2026-11-05', '2026-11-12', '2026-11-13'])).toBe('2026-11-13');
  expect(nearestKnown('2026-11-12', [])).toBeUndefined();
});
