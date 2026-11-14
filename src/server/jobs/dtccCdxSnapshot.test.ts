import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { backfillDtccCdx, dtccCdxSeries } from './dtccCdxSnapshot';
import type { DtccCdxDay } from '../fetchers/dtccCdx';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function day(trades: [id: string, date: string, price: number, index?: 'IG' | 'HY'][], cancelled: string[] = []) {
  return { trades: trades.map(([id, date, price, index = 'IG']) => ({ id, index, date, price })), cancelled };
}

test('按成交日取中位数;只补 ICE 第一天之前;撤销剔掉;拉失败 / null 那天的补报不用', async () => {
  const db = memDb();
  insertMarketSeries(db, [{ seriesId: 'ICE_CDX_IG', obsDate: '2026-11-13', value: 101 }]);
  const files: Record<string, DtccCdxDay | null> = {
    '2026-11-10': day([
      ['a', '2026-11-10', 102],
      ['b', '2026-11-10', 102.2],
      ['c', '2026-11-10', 102.4],
      ['h', '2026-11-10', 106, 'HY'],
    ]),
    // 补报:成交日 11-11 的文件拉失败、11-12 的文件源已不保留 → 这两笔都不用
    '2026-11-13': day(
      [
        ['d', '2026-11-11', 99],
        ['e', '2026-11-12', 99],
        ['f', '2026-11-13', 101.5], // ICE 已有的日子不写
      ],
      ['c'],
    ),
    '2026-11-12': null,
  };

  const r = await backfillDtccCdx(db, {
    today: '2026-11-14',
    fetchDay: async (d) => {
      if (d === '2026-11-11') throw new Error('500');
      return d in files ? files[d] : day([]);
    },
  });

  expect(r.failed).toEqual(['2026-11-11: 500']);
  expect(getMarketSeries(db, dtccCdxSeries('IG'))).toEqual([{ date: '2026-11-10', value: 102.1 }]);
  // HY 的 ICE 还没开始存 → 补到今天
  expect(getMarketSeries(db, dtccCdxSeries('HY'))).toEqual([{ date: '2026-11-10', value: 106 }]);
});

test('ICE 开始存之后:上次回填补到今天的 DTCC 旧值删掉', async () => {
  const db = memDb();
  insertMarketSeries(db, [
    { seriesId: dtccCdxSeries('IG'), obsDate: '2026-11-10', value: 102 },
    { seriesId: dtccCdxSeries('IG'), obsDate: '2026-11-13', value: 101.5 },
    { seriesId: 'ICE_CDX_IG', obsDate: '2026-11-13', value: 101.6 },
  ]);

  await backfillDtccCdx(db, { today: '2026-11-14', fetchDay: async () => null });

  expect(getMarketSeries(db, dtccCdxSeries('IG')).map((p) => p.date)).toEqual(['2026-11-10']);
});

test('库里 ICE 混进空日期:不当成起点,DTCC 历史不被删', async () => {
  const db = memDb();
  insertMarketSeries(db, [
    { seriesId: dtccCdxSeries('IG'), obsDate: '2026-11-10', value: 102 },
    { seriesId: 'ICE_CDX_IG', obsDate: '', value: 101.6 },
  ]);

  await backfillDtccCdx(db, { today: '2026-11-14', fetchDay: async () => null });

  expect(getMarketSeries(db, dtccCdxSeries('IG')).map((p) => p.date)).toEqual(['2026-11-10']);
});

test('某个指数一笔都没筛出(识别规则失效 / 空壳文件):不写不删、记失败;另一个照常', async () => {
  const db = memDb();
  insertMarketSeries(db, [{ seriesId: dtccCdxSeries('IG'), obsDate: '2024-08-02', value: 102 }]);

  const r = await backfillDtccCdx(db, {
    today: '2024-08-05',
    fetchDay: async (d) => (d === '2024-08-05' ? day([['h', '2024-08-05', 106, 'HY']]) : day([])),
  });

  expect(r.failed.some((f) => f.startsWith('CDX IG'))).toBe(true);
  expect(getMarketSeries(db, dtccCdxSeries('IG'))).toEqual([{ date: '2024-08-02', value: 102 }]);
  expect(getMarketSeries(db, dtccCdxSeries('HY'))).toEqual([{ date: '2024-08-05', value: 106 }]);
});

test('库里 ICE 混进过早的日期:不当成起点', async () => {
  const db = memDb();
  insertMarketSeries(db, [
    { seriesId: dtccCdxSeries('IG'), obsDate: '2024-08-05', value: 102 },
    { seriesId: 'ICE_CDX_IG', obsDate: '0001-01-01', value: 101.6 },
  ]);

  await backfillDtccCdx(db, { today: '2024-08-09', fetchDay: async () => null });

  expect(getMarketSeries(db, dtccCdxSeries('IG')).map((p) => p.date)).toEqual(['2024-08-05']);
});
