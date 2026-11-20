import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { updateSpxSkew, SPX_SKEW_SERIES } from './spxSkewSnapshot';
import { NotTradingDayError, type Spx25 } from '../fetchers/cboeVixDecomp';
import { weekdaysBetween } from './putCallSnapshot';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

const V: Spx25 = { putIv: 24.15, callIv: 16.8, skew: 7.35 };

/** 库里先放好 30 天窗口里 until 之前的天,只留测试关心的那几天是缺的 */
function seeded(from: string, to: string) {
  const db = freshDb();
  insertMarketSeries(
    db,
    weekdaysBetween(from, to).map((d) => ({ seriesId: SPX_SKEW_SERIES.skew, obsDate: d, value: 7 })),
  );
  return db;
}

/** 假源:holidays 里的天出现在任何一对里都报「非交易日」;unpublished 里的天(未发布 / 缺利率数据)让整对回空 */
function fakeSource(holidays: string[], unpublished: string[] = []) {
  const asked: string[] = [];
  const fetchPair = async (a: string, b: string) => {
    asked.push(`${a}~${b}`);
    if (a >= b) throw new Error('date1 要早于 date2');
    if ([a, b].some((d) => holidays.includes(d)))
      throw new NotTradingDayError('One or both dates are not trading days.');
    if ([a, b].some((d) => unpublished.includes(d))) return new Map<string, Spx25>();
    return new Map([
      [a, V],
      [b, V],
    ]);
  };
  return { asked, fetchPair };
}

test('updateSpxSkew:假日连累的那一对第二轮各配已知交易日重问;真假日跳过不算失败;三条序列都写', async () => {
  const db = seeded('2025-10-20', '2025-11-20');
  // 11-27 感恩节:第一轮 (11-26, 11-27) 一起失败,第二轮 11-26 配已知交易日拿到,11-27 仍报 → 假日
  const { fetchPair } = fakeSource(['2025-11-27']);
  const r = await updateSpxSkew(db, { until: '2025-11-28', politeMs: 0, fetchPair });

  const dates = getMarketSeries(db, SPX_SKEW_SERIES.skew).map((p) => p.date);
  expect(dates.filter((d) => d > '2025-11-19')).toEqual([
    '2025-11-20',
    '2025-11-21',
    '2025-11-24',
    '2025-11-25',
    '2025-11-26',
    '2025-11-28',
  ]);
  expect(r.failed).toEqual([]);
  expect(r.fetched).not.toContain('2025-11-27');
  expect(getMarketSeries(db, SPX_SKEW_SERIES.putIv).at(-1)).toEqual({ date: '2025-11-28', value: 24.15 });
});

test('updateSpxSkew:最新一天还没发布不连累别的天;其它错误记失败', async () => {
  const db = seeded('2026-10-15', '2026-11-13');
  const { asked, fetchPair } = fakeSource([], ['2026-11-18']);
  const r = await updateSpxSkew(db, { until: '2026-11-18', politeMs: 0, fetchPair });

  expect(asked).toEqual(['2026-11-16~2026-11-17', '2026-11-13~2026-11-18']);
  expect(r.fetched).toEqual(['2026-11-16', '2026-11-17']);
  expect(r.latest).toBe('2026-11-17');

  const boom = async () => {
    throw new Error('HTTP 500');
  };
  const r2 = await updateSpxSkew(freshDb(), { until: '2026-11-18', politeMs: 0, fetchPair: boom });
  expect(r2.failed.length).toBeGreaterThan(0);
  expect(r2.stale[0]).toContain('spxSkewSnapshot.ts --backfill');
});

test('updateSpxSkew:两天都缺的一对因其中一天没数整对回空,另一天第二轮单独配已知日拿到,不会被永远拖住', async () => {
  const db = seeded('2026-10-15', '2026-11-11');
  // 第一轮 (11-12, 11-13) 因 11-13 没数整对回空;第二轮 11-12 配已知日拿到,11-13 仍空 → 不算失败
  const { asked, fetchPair } = fakeSource([], ['2026-11-13']);
  const r = await updateSpxSkew(db, { until: '2026-11-16', politeMs: 0, fetchPair });

  expect(asked).toEqual([
    '2026-11-12~2026-11-13',
    '2026-11-11~2026-11-16',
    '2026-11-11~2026-11-12',
    '2026-11-11~2026-11-13', // 第二轮的「已知日」是第一轮后的库:11-11 比 11-16 近
  ]);
  expect(r.fetched).toEqual(['2026-11-16', '2026-11-12']);
  expect(r.failed).toEqual([]);
});
