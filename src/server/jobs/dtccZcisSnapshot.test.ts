import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { updateDtccZcis, zcisSeries } from './dtccZcisSnapshot';
import type { ZcisDay } from '../fetchers/dtccZcis';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function day(trades: [id: string, date: string, rate: number, tenor?: '1Y' | '2Y'][], cancelled: string[] = []) {
  return { trades: trades.map(([id, date, rate, tenor = '1Y']) => ({ id, tenor, date, rate })), cancelled };
}

test('按成交日取中位数;不足 3 笔不出点并删旧值;撤销剔掉;拉失败 / null 那天的补报不用', async () => {
  const db = memDb();
  insertMarketSeries(db, [
    { seriesId: zcisSeries('1Y'), obsDate: '2026-11-04', value: 2.5 }, // 源已不保留 → 不删
    { seriesId: zcisSeries('1Y'), obsDate: '2026-11-09', value: 2.5 }, // 这次只剩 2 笔 → 删
  ]);
  const files: Record<string, ZcisDay | null> = {
    '2026-11-04': null,
    '2026-11-09': day([
      ['a', '2026-11-09', 2.0],
      ['b', '2026-11-09', 2.1],
    ]),
    '2026-11-10': day(
      [
        ['c', '2026-11-10', 2.0],
        ['d', '2026-11-10', 2.1],
        ['e', '2026-11-10', 2.2],
        ['x', '2026-11-10', 9.9], // 被撤销
        ['f', '2026-11-11', 5.0], // 补报:11-11 的文件拉失败 → 不用
        ['g', '2026-11-04', 5.0], // 补报:11-04 源已不保留 → 不用
        ['h', '2026-11-10', 2.3, '2Y'],
        ['i', '2026-11-10', 2.3, '2Y'],
        ['j', '2026-11-10', 2.4, '2Y'],
      ],
      ['x'],
    ),
  };

  const r = await updateDtccZcis(db, {
    today: '2026-11-12',
    fetchDay: async (d) => {
      if (d === '2026-11-11') throw new Error('500');
      return d in files ? files[d] : day([]);
    },
  });

  // 11-04 在日常窗口里且早该发布 → 文件缺失也记失败(当天后续触发点重跑)
  expect(r.failed).toEqual(['2026-11-11: 500', '2026-11-04: 源回 403/404(该发布的文件缺失)']);
  expect(getMarketSeries(db, zcisSeries('1Y'))).toEqual([
    { date: '2026-11-04', value: 2.5 },
    { date: '2026-11-10', value: 2.1 },
  ]);
  expect(getMarketSeries(db, zcisSeries('2Y'))).toEqual([{ date: '2026-11-10', value: 2.3 }]);
});

test('拉到了文件却一笔都没筛出(识别规则失效):不写不删、记失败', async () => {
  const db = memDb();
  insertMarketSeries(db, [{ seriesId: zcisSeries('1Y'), obsDate: '2026-11-10', value: 2.1 }]);

  const r = await updateDtccZcis(db, { today: '2026-11-12', fetchDay: async () => day([]) });

  expect(r.failed.some((f) => f.startsWith('ZCIS 1Y'))).toBe(true);
  expect(getMarketSeries(db, zcisSeries('1Y'))).toEqual([{ date: '2026-11-10', value: 2.1 }]);
});

test('今天 / 昨天的文件还没发布(403)不算失败', async () => {
  const r = await updateDtccZcis(memDb(), {
    today: '2026-11-12',
    fetchDay: async (d) =>
      d >= '2026-11-11'
        ? null
        : day([
            ['a', d, 2.0],
            ['b', d, 2.1],
            ['c', d, 2.2],
            ['e', d, 2.3, '2Y'],
            ['f', d, 2.3, '2Y'],
            ['g', d, 2.3, '2Y'],
          ]),
  });

  expect(r.failed).toEqual([]);
});

test('工作日的文件筛不出任何成交:那天不删库里的值;最近两个工作日都这样 → 记失败', async () => {
  const db = memDb();
  insertMarketSeries(db, [
    { seriesId: zcisSeries('1Y'), obsDate: '2026-11-11', value: 2.1 },
    { seriesId: zcisSeries('1Y'), obsDate: '2026-11-12', value: 2.2 },
  ]);
  const full = (d: string) =>
    day([
      [`a${d}`, d, 2.0],
      [`b${d}`, d, 2.1],
      [`c${d}`, d, 2.2],
      [`e${d}`, d, 2.3, '2Y'],
      [`f${d}`, d, 2.3, '2Y'],
      [`g${d}`, d, 2.3, '2Y'],
    ]);

  const r = await updateDtccZcis(db, {
    today: '2026-11-13',
    fetchDay: async (d) => (d === '2026-11-11' || d === '2026-11-12' || d === '2026-11-13' ? day([]) : full(d)),
  });

  expect(r.failed.some((f) => f.includes('最近两个工作日'))).toBe(true);
  expect(getMarketSeries(db, zcisSeries('1Y')).map((p) => p.date)).toContain('2026-11-11');
  expect(getMarketSeries(db, zcisSeries('1Y')).map((p) => p.date)).toContain('2026-11-12');
});

test('回填:源头部已过期的天回 null 不算失败', async () => {
  const r = await updateDtccZcis(memDb(), {
    backfill: true,
    today: '2024-11-20',
    fetchDay: async (d) =>
      d < '2024-11-10'
        ? null
        : day([
            [`a${d}`, d, 2.0],
            [`b${d}`, d, 2.1],
            [`c${d}`, d, 2.2],
            [`e${d}`, d, 2.3, '2Y'],
            [`f${d}`, d, 2.3, '2Y'],
            [`g${d}`, d, 2.3, '2Y'],
          ]),
  });

  expect(r.failed).toEqual([]);
});
