import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import type { JsdaJgbiDay } from '../fetchers/jsdaJgbi';
import { JGBI_SERIES, expectedQuoteDate, staleProblem, updateJgbi } from './jgbiSnapshot';

const H = new Set(['2026-11-23']);
// JST = UTC + 9
function jst(iso: string) {
  return new Date(`${iso}+09:00`);
}

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function day(settle: string, price: number | null): JsdaJgbiDay {
  return {
    settle,
    jgbi: { no: 31, maturity: '2036-03-10', coupon: 0.6, price },
    nominal: { name: '長期国債 382', yield: 2.743 },
  };
}

test('expectedQuoteDate:营业日 19 点后算当天,之前算上一营业日', () => {
  expect(expectedQuoteDate(jst('2026-11-20T20:00:00'), H)).toBe('2026-11-20');
  expect(expectedQuoteDate(jst('2026-11-20T11:00:00'), H)).toBe('2026-11-19');
  expect(expectedQuoteDate(jst('2026-11-24T11:00:00'), H)).toBe('2026-11-20'); // 隔周末 + 祝日
  expect(expectedQuoteDate(jst('2026-11-21T20:00:00'), H)).toBe('2026-11-20'); // 周六
});

test('staleProblem:落后 ≥3 个营业日才报', () => {
  expect(staleProblem('2026-11-18', '2026-11-20', H)).toBeNull();
  expect(staleProblem('2026-11-17', '2026-11-20', H)).toContain('落后');
  expect(staleProblem('2026-11-19', '2026-11-24', H)).toBeNull(); // 隔周末 + 祝日:只落后 11-20、11-24 两个
  expect(staleProblem(undefined, '2026-11-20', H)).toContain('--backfill-bb');
});

test('updateJgbi:只打一次 JSDA,拉窗口里最新缺的那天;受渡日 = 下一营业日;算实际 / BEI;还缺的列出来', async () => {
  const db = freshDb();
  insertMarketSeries(
    db,
    ['2026-11-17', '2026-11-18'].map((d) => ({ seriesId: JGBI_SERIES.nominal, obsDate: d, value: 2.8 })),
  );
  const asked: string[] = [];
  const r = await updateJgbi(db, {
    now: jst('2026-11-21T11:00:00'),
    holidays: H,
    fetchDay: async (s) => {
      asked.push(s);
      return day(s, 96.8);
    },
  });

  expect(asked).toEqual(['2026-11-24']); // 报价日 11-20 → 受渡日 11-24
  expect(r.fetched).toBe('2026-11-20');
  expect(r.missing).toContain('2026-11-19');
  expect(r.missing).not.toContain('2026-11-20');
  expect(getMarketSeries(db, JGBI_SERIES.real)).toEqual([{ date: '2026-11-20', value: 0.96 }]);
  expect(getMarketSeries(db, JGBI_SERIES.bei)).toEqual([{ date: '2026-11-20', value: 1.783 }]);
});

test('updateJgbi:JGBi 不公表价格那天只写名义(之后不再重拉);404 / 抛错记失败', async () => {
  const db = freshDb();
  const now = jst('2026-11-20T20:00:00');
  await updateJgbi(db, { now, holidays: H, fetchDay: async (s) => day(s, null) });
  expect(getMarketSeries(db, JGBI_SERIES.nominal).map((p) => p.date)).toEqual(['2026-11-20']);
  expect(getMarketSeries(db, JGBI_SERIES.real)).toEqual([]);

  const notYet = await updateJgbi(db, { now, holidays: H, fetchDay: async () => null });
  expect(notYet.failed).toContain('404'); // 拉的是 11-19(11-20 已有)
  const limited = await updateJgbi(db, {
    now,
    holidays: H,
    fetchDay: async () => {
      throw new Error('HTTP 429');
    },
  });
  expect(limited.failed).toContain('429');
  expect(limited.fetched).toBeNull();
});
