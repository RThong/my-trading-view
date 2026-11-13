import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { SBG_CDS_SERIES, updateSbgCds } from './sbgCdsSnapshot';
import type { SbgCdsDay } from '../fetchers/dtccSbgCds';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function day(trades: [id: string, date: string, price: number][], cancelled: string[] = []): SbgCdsDay {
  return { trades: trades.map(([id, date, price]) => ({ id, date, price })), cancelled };
}

function seed(db: Database, rows: [string, number][]) {
  return insertMarketSeries(
    db,
    rows.map(([obsDate, value]) => ({ seriesId: SBG_CDS_SERIES, obsDate, value })),
  );
}

test('窗口内按成交日取中位数;晚报到窗口外的成交不覆盖库里那天;源不保留的天(null)不删', async () => {
  const db = memDb();
  seed(db, [
    ['2026-10-01', 87],
    ['2026-11-12', 80],
  ]);
  const files: Record<string, SbgCdsDay | null> = {
    '2026-11-10': day([
      ['a', '2026-11-10', 84],
      ['b', '2026-11-10', 86],
    ]),
    // 晚报:11-11 的文件里带着 11-10 的一笔 + 窗口外 10-01 的一笔
    '2026-11-11': day([
      ['c', '2026-11-10', 90],
      ['d', '2026-10-01', 50],
    ]),
    '2026-11-12': null,
  };

  const r = await updateSbgCds(db, { today: '2026-11-12', fetchDay: async (d) => (d in files ? files[d] : day([])) });

  expect(r.failed).toEqual([]);
  expect(getMarketSeries(db, SBG_CDS_SERIES)).toEqual([
    { date: '2026-10-01', value: 87 },
    { date: '2026-11-10', value: 86 },
    { date: '2026-11-12', value: 80 },
  ]);
});

test('被撤销的成交剔掉(撤销可在后几天的文件里);那天因此没有有效成交 → 删掉库里旧值', async () => {
  const db = memDb();
  seed(db, [['2026-11-05', 70]]);
  const files: Record<string, SbgCdsDay> = {
    '2026-11-05': day([['x', '2026-11-05', 70]]),
    '2026-11-09': day(
      [
        ['y', '2026-11-09', 84],
        ['z', '2026-11-09', 40],
      ],
      ['z'],
    ),
    '2026-11-10': day([], ['x']),
  };

  await updateSbgCds(db, { today: '2026-11-12', fetchDay: async (d) => files[d] ?? day([]) });

  expect(getMarketSeries(db, SBG_CDS_SERIES)).toEqual([{ date: '2026-11-09', value: 84 }]);
});

test('文件拉失败那天:不用补报的残缺成交覆盖库里的值,也不删;记失败', async () => {
  const db = memDb();
  seed(db, [['2026-11-11', 85]]);
  const r = await updateSbgCds(db, {
    today: '2026-11-12',
    fetchDay: async (d) => {
      if (d === '2026-11-11') throw new Error('500');
      return d === '2026-11-12' ? day([['late', '2026-11-11', 60]]) : day([]);
    },
  });

  expect(r.failed).toEqual(['2026-11-11: 500']);
  expect(getMarketSeries(db, SBG_CDS_SERIES)).toEqual([{ date: '2026-11-11', value: 85 }]);
});

test('两周一笔都没筛出 → 记失败(筛选条件可能失效)', async () => {
  const r = await updateSbgCds(memDb(), { today: '2026-11-12', fetchDay: async () => day([]) });

  expect(r.failed[0]).toContain('没筛出');
});
