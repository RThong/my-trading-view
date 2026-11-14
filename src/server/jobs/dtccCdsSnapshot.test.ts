import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { dtccCdsSeries, updateDtccCds } from './dtccCdsSnapshot';
import { accruedPts } from '../analytics/cdsTrades';
import type { DtccCdsDay } from '../fetchers/dtccCds';

const SBG = dtccCdsSeries('SBG');

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function day(trades: [id: string, date: string, u: number, ticker?: string][], cancelled: string[] = []): DtccCdsDay {
  return { trades: trades.map(([id, date, u, ticker = 'SBG']) => ({ id, ticker, date, u })), cancelled };
}

function seed(db: Database, seriesId: string, rows: [string, number][]) {
  insertMarketSeries(
    db,
    rows.map(([obsDate, value]) => ({ seriesId, obsDate, value })),
  );
}

// 软银 100bp 票息、买方付:价 = 100 − u − 应计
function sbgPrice(date: string, u: number) {
  return 100 - u - accruedPts(date, 100);
}

test('窗口内按成交日取中位数(扣应计);晚报到窗口外的成交不覆盖库里那天;源不保留的天(null)不删', async () => {
  const db = memDb();
  seed(db, SBG, [
    ['2026-10-01', 87],
    ['2026-11-12', 80],
  ]);
  const files: Record<string, DtccCdsDay | null> = {
    '2026-11-10': day([
      ['a', '2026-11-10', 14],
      ['b', '2026-11-10', 13],
    ]),
    // 晚报:11-11 的文件里带着 11-10 的一笔 + 窗口外 10-01 的一笔
    '2026-11-11': day([
      ['c', '2026-11-10', 15],
      ['d', '2026-10-01', 50],
    ]),
    '2026-11-12': null,
  };

  const r = await updateDtccCds(db, { today: '2026-11-12', fetchDay: async (d) => (d in files ? files[d] : day([])) });

  expect(r.failed).toEqual([]);
  const rows = getMarketSeries(db, SBG);
  expect(rows.map((p) => p.date)).toEqual(['2026-10-01', '2026-11-10', '2026-11-12']);
  expect(rows[0].value).toBe(87);
  expect(rows[1].value).toBeCloseTo(sbgPrice('2026-11-10', 14), 9);
  expect(rows[2].value).toBe(80);
});

test('被撤销的成交剔掉(撤销可在后几天的文件里);那天因此没有有效成交 → 删掉库里旧值', async () => {
  const db = memDb();
  seed(db, SBG, [['2026-11-05', 70]]);
  const files: Record<string, DtccCdsDay> = {
    '2026-11-05': day([['x', '2026-11-05', 30]]),
    '2026-11-09': day(
      [
        ['y', '2026-11-09', 16],
        ['z', '2026-11-09', 60],
      ],
      ['z'],
    ),
    '2026-11-10': day([], ['x']),
  };

  await updateDtccCds(db, { today: '2026-11-12', fetchDay: async (d) => files[d] ?? day([]) });

  const rows = getMarketSeries(db, SBG);
  expect(rows.map((p) => p.date)).toEqual(['2026-11-09']);
  expect(rows[0].value).toBeCloseTo(sbgPrice('2026-11-09', 16), 9);
});

test('文件拉失败 / 源已不保留(null)那天:不用补报的残缺成交覆盖库里的值,也不删;拉失败记失败', async () => {
  const db = memDb();
  seed(db, SBG, [
    ['2026-11-10', 86],
    ['2026-11-11', 85],
  ]);
  const r = await updateDtccCds(db, {
    today: '2026-11-12',
    fetchDay: async (d) => {
      if (d === '2026-11-11') throw new Error('500');
      if (d === '2026-11-10') return null;
      return d === '2026-11-12'
        ? day([
            ['late', '2026-11-11', 40],
            ['late2', '2026-11-10', 40],
          ])
        : day([]);
    },
  });

  expect(r.failed).toEqual(['2026-11-11: 500']);
  expect(getMarketSeries(db, SBG)).toEqual([
    { date: '2026-11-10', value: 86 },
    { date: '2026-11-11', value: 85 },
  ]);
});

test('两周一笔软银都没有 → 记失败(筛选条件可能失效)', async () => {
  const r = await updateDtccCds(memDb(), { today: '2026-11-12', fetchDay: async () => day([]) });

  expect(r.failed[0]).toContain('没筛出');
});

test('日常模式不碰美国公司;回填只补 ICE 第一天之前,从 ICE 结算价起锚往前选方向', async () => {
  const db = memDb();
  seed(db, 'ICE_CDS_METAPL', [
    ['2026-07-24', 100.5],
    ['2026-07-27', 100.4],
  ]);
  const files: Record<string, DtccCdsDay> = {
    '2026-07-22': day([['m2', '2026-07-22', 0.1, 'METAPL']]),
    '2026-07-23': day([['m3', '2026-07-23', 0.3, 'METAPL']]),
    // ICE 已有的日子不写
    '2026-07-24': day([['m4', '2026-07-24', 5, 'METAPL']]),
  };
  const fetchDay = async (d: string) => files[d] ?? day([]);

  await updateDtccCds(db, { today: '2026-07-25', fetchDay });
  expect(getMarketSeries(db, dtccCdsSeries('METAPL'))).toEqual([]);

  await updateDtccCds(db, { backfill: true, today: '2026-07-25', fetchDay });
  const rows = getMarketSeries(db, dtccCdsSeries('METAPL'));
  expect(rows.map((p) => p.date)).toEqual(['2026-07-22', '2026-07-23']);
  // 07-23 参照 ICE 100.5 → 卖方付,100 + 0.3 − 应计;07-22 参照 07-23 的价 → 仍是 100 + 0.1 − 应计(不是 99.9)
  expect(rows[1].value).toBeCloseTo(100.3 - accruedPts('2026-07-23', 100), 9);
  expect(rows[0].value).toBeCloseTo(100.1 - accruedPts('2026-07-22', 100), 9);
});

test('回填美国公司只留成交够密的那段:更早的稀疏月截掉,库里旧值一并删', async () => {
  const db = memDb();
  seed(db, 'ICE_CDS_ORCLE', [['2026-07-24', 95]]);
  // 上次回填留下的稀疏期旧值;其中 02-02 那天的源文件现在已拿不到(fetchDay 回 null),也要删
  seed(db, dtccCdsSeries('ORCLE'), [
    ['2026-02-02', 97],
    ['2026-03-02', 96],
  ]);
  // 3 月只有 1 天(稀疏),4~6 月每月 10 天,7 月是残月
  const dense = ['04', '05', '06'].flatMap((m) =>
    Array.from({ length: 10 }, (_, i) => `2026-${m}-${String(i + 1).padStart(2, '0')}`),
  );
  const tradeDays = ['2026-03-02', ...dense, '2026-07-01'];
  const files = Object.fromEntries(tradeDays.map((d) => [d, day([[`o${d}`, d, 5, 'ORCLE']])]));

  await updateDtccCds(db, {
    backfill: true,
    today: '2026-07-25',
    fetchDay: async (d) => (d === '2026-02-02' ? null : (files[d] ?? day([]))),
  });

  const rows = getMarketSeries(db, dtccCdsSeries('ORCLE'));
  expect(rows[0].date).toBe('2026-04-01');
  expect(rows).toHaveLength(31);
});

test('回填时有文件拉取失败:整轮不碰美国公司(不写不删),记失败;软银照常', async () => {
  const db = memDb();
  seed(db, 'ICE_CDS_ORCLE', [['2026-07-24', 95]]);
  seed(db, dtccCdsSeries('ORCLE'), [['2026-06-01', 96]]);
  const files: Record<string, DtccCdsDay> = {
    '2026-06-02': day([['o1', '2026-06-02', 5, 'ORCLE']]),
    '2026-06-03': day([['s1', '2026-06-03', 14]]),
  };

  const r = await updateDtccCds(db, {
    backfill: true,
    today: '2026-07-25',
    fetchDay: async (d) => {
      if (d === '2026-06-10') throw new Error('500');
      return files[d] ?? day([]);
    },
  });

  expect(r.failed.some((f) => f.includes('跳过美国公司'))).toBe(true);
  expect(getMarketSeries(db, dtccCdsSeries('ORCLE'))).toEqual([{ date: '2026-06-01', value: 96 }]);
  expect(getMarketSeries(db, SBG).map((p) => p.date)).toEqual(['2026-06-03']);
});

test('回填:库里有、源已不保留的点也算进密度 —— 源起点越过现有段时不截掉不删', async () => {
  const db = memDb();
  seed(db, 'ICE_CDS_ORCLE', [['2026-07-24', 95]]);
  // 4 月上旬的旧值在库里,源从 4 月中旬起才拿得到(之前回 null)
  const early = Array.from({ length: 5 }, (_, i) => `2026-04-0${i + 1}`);
  seed(
    db,
    dtccCdsSeries('ORCLE'),
    early.map((d) => [d, 96]),
  );
  const later = ['04', '05', '06'].flatMap((m) =>
    Array.from({ length: 10 }, (_, i) => `2026-${m}-${String(i + 15).padStart(2, '0')}`),
  );
  const files = Object.fromEntries(later.map((d) => [d, day([[`o${d}`, d, 5, 'ORCLE']])]));

  const r = await updateDtccCds(db, {
    backfill: true,
    today: '2026-07-25',
    fetchDay: async (d) => (d < '2026-04-15' ? null : (files[d] ?? day([]))),
  });

  expect(r.failed).toEqual([]);
  const rows = getMarketSeries(db, dtccCdsSeries('ORCLE'));
  expect(rows[0]).toEqual({ date: '2026-04-01', value: 96 });
  expect(rows).toHaveLength(35);
});

test('回填:某家一笔都没筛出(识别规则可能失效)→ 跳过不写不删,记失败', async () => {
  const db = memDb();
  seed(db, 'ICE_CDS_ORCLE', [['2026-07-24', 95]]);
  seed(db, dtccCdsSeries('ORCLE'), [['2026-06-01', 96]]);

  const r = await updateDtccCds(db, { backfill: true, today: '2026-07-25', fetchDay: async () => day([]) });

  expect(r.failed.some((f) => f.startsWith('ORCLE'))).toBe(true);
  expect(getMarketSeries(db, dtccCdsSeries('ORCLE'))).toEqual([{ date: '2026-06-01', value: 96 }]);
});
