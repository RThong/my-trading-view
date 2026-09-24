import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updateIsm, ISM_SERIES, staleSectors } from './ismSnapshot';
import type { IsmCandidate, IsmRelease } from '../fetchers/ismPrn';

const freshDb = () => {
  const db = new Database(':memory:');
  migrate(db);
  return db;
};

const rel = (month: string, prevMonth: string, cur: number, prev: number): IsmRelease => ({
  sector: 'mfg',
  month,
  prevMonth,
  pmi: { cur, prev },
  prices: { cur: cur + 10, prev: prev + 10 },
});

/** 假 fetcher:pages[i] 是第 i+1 页的候选;bodies 按 path 给解析结果;记下拉过哪些正文。 */
const fake = (pages: IsmCandidate[][], bodies: Record<string, IsmRelease | null>) => {
  const pulled: string[] = [];
  return {
    pulled,
    fetcher: {
      listReleases: async (page: number) => pages[page - 1] ?? [],
      fetchRelease: async (path: string) => {
        pulled.push(path);
        return bodies[path] ?? null;
      },
    },
  };
};

test('updateIsm:按报告月升序写,后发布的「上月值」覆盖先发布的「当月值」(季节因子重估靠它带回来)', async () => {
  const db = freshDb();
  // 页面顺序是新 → 旧;2 月那篇里的 1 月(51.0)是修订后的,1 月那篇自己报的是 50.0。
  const { fetcher } = fake(
    [
      [
        { path: '/feb', hint: null },
        { path: '/jan', hint: null },
      ],
    ],
    { '/feb': rel('2026-02-01', '2026-01-01', 52, 51), '/jan': rel('2026-01-01', '2025-12-01', 50, 49) },
  );

  const r = await updateIsm(db, { fetcher });

  expect(getMarketSeries(db, ISM_SERIES.mfg.pmi)).toEqual([
    { date: '2025-12-01', value: 49 },
    { date: '2026-01-01', value: 51 }, // 修订值胜出;按页面顺序(新→旧)写就会被 50 盖回去
    { date: '2026-02-01', value: 52 },
  ]);
  expect(getMarketSeries(db, ISM_SERIES.mfg.prices).at(-1)).toEqual({ date: '2026-02-01', value: 62 });
  expect(r.failed).toEqual([]);
});

test('updateIsm:slug 已带(扇区, 月)且库里有 → 不拉正文;稳态每次只打一次列表页', async () => {
  const db = freshDb();
  const aug: IsmCandidate = { path: '/aug', hint: { sector: 'mfg', month: '2026-08-01' } };
  const first = fake([[aug]], { '/aug': rel('2026-08-01', '2026-07-01', 54.6, 55.6) });
  await updateIsm(db, { fetcher: first.fetcher });

  const again = fake([[aug]], {});
  const r = await updateIsm(db, { fetcher: again.fetcher });

  expect(again.pulled).toEqual([]);
  expect(r.skipped).toBe(1);
});

test('updateIsm:第一页一篇月报都认不出来 → 抛错(否则 job 天天 success、面板永远停住)', async () => {
  const { fetcher } = fake([[]], {});
  await expect(updateIsm(freshDb(), { fetcher })).rejects.toThrow('一篇月报都没认出来');
});

test('updateIsm:候选解析不出 → 记 failed 不静默跳过;其余照写', async () => {
  const db = freshDb();
  const { fetcher } = fake(
    [
      [
        { path: '/broken', hint: null },
        { path: '/ok', hint: null },
      ],
    ],
    { '/ok': rel('2026-08-01', '2026-07-01', 54.6, 55.6) },
  );

  const r = await updateIsm(db, { fetcher });

  expect(r.failed.length).toBe(1);
  expect(r.failed[0]).toContain('/broken');
  expect(getMarketSeries(db, ISM_SERIES.mfg.pmi).length).toBe(2);
});

test('updateIsm:回填翻到展示起点之前就停,起点前的点不入库', async () => {
  const db = freshDb();
  const { fetcher, pulled } = fake(
    [
      [{ path: '/p1', hint: null }],
      [{ path: '/p2', hint: null }], // 2017-12 那篇:翻到这页就该停
      [{ path: '/p3', hint: null }], // 不该被拉
    ],
    {
      '/p1': rel('2018-02-01', '2018-01-01', 60, 59),
      '/p2': rel('2017-12-01', '2017-11-01', 58, 57),
    },
  );

  await updateIsm(db, { fetcher, backfill: true, politeMs: 0 });

  expect(pulled).toEqual(['/p1', '/p2']);
  expect(getMarketSeries(db, ISM_SERIES.mfg.pmi).map((p) => p.date)).toEqual(['2018-01-01', '2018-02-01']);
});

test('updateIsm:回填在同一页里遇到第一篇起点前的月报就停,不把本页剩下更老的正文拉完', async () => {
  const db = freshDb();
  const { fetcher, pulled } = fake(
    [
      [
        { path: '/new', hint: null },
        { path: '/old', hint: null }, // 2017-12:到这里就停
        { path: '/older1', hint: null },
        { path: '/older2', hint: null },
      ],
    ],
    {
      '/new': rel('2018-01-01', '2017-12-01', 59, 58),
      '/old': rel('2017-12-01', '2017-11-01', 58, 57),
    },
  );

  await updateIsm(db, { fetcher, backfill: true, politeMs: 0 });

  expect(pulled).toEqual(['/new', '/old']);
  expect(getMarketSeries(db, ISM_SERIES.mfg.pmi).map((p) => p.date)).toEqual(['2018-01-01']);
});

test('updateIsm:同扇区同月两篇(更正件)→ 页面上更新的那篇胜,与稳定排序无关', async () => {
  const db = freshDb();
  // 页面新 → 旧:先是更正件(55.0),后是原件(54.0)
  const { fetcher } = fake(
    [
      [
        { path: '/fix', hint: null },
        { path: '/orig', hint: null },
      ],
    ],
    { '/fix': rel('2026-08-01', '2026-07-01', 55, 50), '/orig': rel('2026-08-01', '2026-07-01', 54, 50) },
  );

  await updateIsm(db, { fetcher });

  expect(getMarketSeries(db, ISM_SERIES.mfg.pmi).at(-1)).toEqual({ date: '2026-08-01', value: 55 });
});

test('staleSectors:按月报节奏判停更 —— 落后 2 个月正常,3 个月报;两个扇区各判各的', () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  // 10/3:9 月服务业还没发(10/5 才发),最新仍是 8 月 = 落后 2 个月,正常
  expect(staleSectors({ mfg: '2026-09-01', svc: '2026-08-01' }, at('2026-10-03'))).toEqual([]);
  // 11/2:服务业还停在 8 月 = 整整一期(9 月)没进来 → 只报服务业,制造业照常
  const r = staleSectors({ mfg: '2026-10-01', svc: '2026-08-01' }, at('2026-11-02'));
  expect(r.length).toBe(1);
  expect(r[0]).toStartWith('svc');
  // 跨年
  expect(staleSectors({ mfg: '2026-11-01', svc: '2026-11-01' }, at('2027-01-04'))).toEqual([]);
  // 库里没数 → 提示去回填
  expect(staleSectors({ mfg: null, svc: '2026-08-01' }, at('2026-09-24'))[0]).toContain('--backfill');
});

test('updateIsm:停更单独进 stale(不混进抓取失败),数据照写', async () => {
  const db = freshDb();
  const { fetcher } = fake([[{ path: '/aug', hint: null }]], { '/aug': rel('2026-08-01', '2026-07-01', 54.6, 55.6) });

  // 只有制造业,且「现在」是 12 月 → 制造业落后 4 个月、服务业一个点都没有
  const r = await updateIsm(db, { fetcher, now: new Date('2026-12-10T00:00:00Z') });

  expect(r.stale.map((f) => f.slice(0, 3)).sort()).toEqual(['mfg', 'svc']);
  expect(r.failed).toEqual([]);
  expect(getMarketSeries(db, ISM_SERIES.mfg.pmi).length).toBe(2);
});
