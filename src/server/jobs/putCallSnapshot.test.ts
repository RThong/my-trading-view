import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updatePutCall, weekdaysBetween, staleProblems, PUT_CALL_SERIES } from './putCallSnapshot';
import type { PutCallDay } from '../fetchers/cboePutCall';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function day(eqPut: number): PutCallDay {
  return {
    equity: { call: 1000, put: eqPut },
    index: { call: 1000, put: 1070 },
    total: { call: 2000, put: 1900 },
  };
}

test('staleProblems:连休(≤5 个工作日)不报;末尾落后 / 中间断档超过 5 个工作日各报一条;空库报', () => {
  // 圣诞 + 元旦那种连休:12-24 → 12-29 中间只缺 12-25、12-26 两个工作日
  expect(staleProblems(['2025-12-24', '2025-12-29', '2026-11-06'], '2026-11-06')).toEqual([
    '库里 2025-12-29 ~ 2026-11-06 之间断档(停机超过 30 天?跑 --backfill)',
  ]);
  expect(staleProblems(['2026-10-26', '2026-11-06'], '2026-11-06')).toHaveLength(1); // 中间缺 8 个工作日
  expect(staleProblems(['2026-10-30', '2026-11-06'], '2026-11-06')).toEqual([]); // 中间缺 4 个
  expect(staleProblems(['2026-10-28'], '2026-11-06')[0]).toContain('落后');
  expect(staleProblems(['2026-10-30'], '2026-11-06')).toEqual([]);
  expect(staleProblems([], '2026-11-06')[0]).toContain('--backfill');
});

test('weekdaysBetween:只跳周末(假日交给源返回 null)', () => {
  expect(weekdaysBetween('2026-11-05', '2026-11-10')).toEqual(['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10']);
  expect(weekdaysBetween('2026-11-07', '2026-11-08')).toEqual([]);
});

test('updatePutCall:比值 = 认沽 ÷ 认购(4 位小数);源给 null 的日子跳过;失败的天记下来、其余照写', async () => {
  const db = freshDb();
  const pulled: string[] = [];
  const r = await updatePutCall(db, {
    until: '2026-11-09',
    politeMs: 0,
    fetchDay: async (d) => {
      pulled.push(d);
      if (d === '2026-11-06') throw new Error('timeout');
      return d === '2026-11-05' ? day(894) : d === '2026-11-09' ? day(590) : null;
    },
  });

  expect(pulled.at(-1)).toBe('2026-10-12'); // 空库、非回填:最多往回补 30 天(新的在前)
  expect(getMarketSeries(db, PUT_CALL_SERIES.equity)).toEqual([
    { date: '2026-11-05', value: 0.894 },
    { date: '2026-11-09', value: 0.59 },
  ]);
  expect(getMarketSeries(db, PUT_CALL_SERIES.index).at(-1)?.value).toBe(1.07);
  expect(r).toMatchObject({ written: 6, fetched: ['2026-11-09', '2026-11-05'], latest: '2026-11-09' });
  expect(r.failed).toEqual(['2026-11-06: timeout']);
});

test('updatePutCall 日常:窗口里库里缺的天都补 —— 中间失败过、后面已拉到的那天也补回来;回填从源头最早一天起', async () => {
  const db = freshDb();
  const pulled: string[] = [];
  let failOn = '2026-11-04';
  const fetchDay = async (d: string) => {
    pulled.push(d);
    if (d === failOn) throw new Error('timeout');
    return day(500);
  };
  await updatePutCall(db, { until: '2026-11-05', politeMs: 0, fetchDay });
  failOn = '';
  pulled.length = 0;
  await updatePutCall(db, { until: '2026-11-09', politeMs: 0, fetchDay });
  expect(pulled).toEqual(['2026-11-09', '2026-11-06', '2026-11-04']);

  pulled.length = 0;
  await updatePutCall(freshDb(), { backfill: true, until: '2019-10-08', politeMs: 0, fetchDay });
  expect(pulled).toEqual(['2019-10-08', '2019-10-07']);
});

test('updatePutCall 回填:只补库里缺的天,新的在前(中途断了再跑接着补)', async () => {
  const db = freshDb();
  const pulled: string[] = [];
  const fetchDay = async (d: string) => {
    pulled.push(d);
    return d === '2019-10-09' ? null : day(500);
  };
  await updatePutCall(db, { until: '2019-10-08', politeMs: 0, fetchDay, backfill: true });
  pulled.length = 0;
  await updatePutCall(db, { until: '2019-10-11', politeMs: 0, fetchDay, backfill: true });
  expect(pulled).toEqual(['2019-10-11', '2019-10-10', '2019-10-09']);
});
