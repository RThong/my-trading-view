import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getOptions25Delta, getJobHealth, insertMarketSeries } from '../storage/repository';
import { runDailyJob, staleFreshnessProbes, pendingGroups, groupsForStaleProbes, runPendingGroups } from './daily';
import type { OptionsChainClient, OptionChainSnapshot } from './optionsSnapshot';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

const CHAIN: OptionChainSnapshot = {
  underlyingSymbol: 'X',
  underlyingPrice: 100,
  expirationDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
  calls: [
    {
      contractSymbol: 'c',
      strike: 110,
      expiration: '2026-06-15',
      impliedVolatility: 0.2,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: 0.25,
    },
  ],
  puts: [
    {
      contractSymbol: 'p',
      strike: 90,
      expiration: '2026-06-15',
      impliedVolatility: 0.25,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: -0.25,
    },
  ],
};

describe('daily job (options-only)', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('writes options rows and records the options job success', async () => {
    const client: OptionsChainClient = { fetchChain: async () => CHAIN };
    await runDailyJob({ db, optionsUnderlyings: ['SPY'], optionsClient: client });

    expect(getOptions25Delta(db, 'SPY', 36500)).toHaveLength(1);
    expect(getJobHealth(db).find((h) => h.name === 'options')?.status).toBe('success');
  });

  test('partial: one underlying fails, the other still lands', async () => {
    const client: OptionsChainClient = {
      fetchChain: async (s) => {
        if (s === '.VIX') throw new Error('暂不支持美股指数');
        return CHAIN;
      },
    };
    await runDailyJob({ db, optionsUnderlyings: ['SPY', '.VIX'], optionsClient: client });

    expect(getOptions25Delta(db, 'SPY', 36500)).toHaveLength(1);
    const h = getJobHealth(db).find((h) => h.name === 'options')!;
    expect(h.status).toBe('partial');
    expect(h.error).toContain('.VIX');
  });

  test('vx_term_structure: 注入的 updater 跑完记一条 success', async () => {
    await runDailyJob({
      db,
      vxUpdater: async () => ({ total: 7 }),
    });
    const h = getJobHealth(db).find((h) => h.name === 'vx_term_structure');
    expect(h?.status).toBe('success');
  });

  test('ism: 没有新月报是常态 → success;某扇区停更 → failed,即使另一扇区这一轮拉到了新数', async () => {
    const ism = (r: Partial<{ fetched: string[]; failed: string[]; stale: string[] }>) => async () => ({
      fetched: [],
      skipped: 17,
      failed: [],
      stale: [],
      written: 0,
      ...r,
    });

    await runDailyJob({ db, ismUpdater: ism({}) });
    expect(getJobHealth(db).find((h) => h.name === 'ism')?.status).toBe('success');

    // threeState 会把「有成功 + 有问题」判成 partial(黄灯);停更不会自愈,必须是红灯。
    await runDailyJob({ db, ismUpdater: ism({ fetched: ['mfg:2026-09'], stale: ['svc 最新报告月 2026-07 落后'] }) });
    const h = getJobHealth(db).find((h) => h.name === 'ism')!;
    expect(h.status).toBe('failed');
    expect(h.error).toContain('svc');
  });

  test('move: 拿到 meta 快照点记 success', async () => {
    await runDailyJob({
      db,
      moveUpdater: async () => ({
        total: 2126,
        latest: '2026-07-31',
        metaDate: '2026-07-31',
        gotMetaPoint: true,
        stalled: false,
      }),
    });
    const h = getJobHealth(db).find((h) => h.name === 'move');
    expect(h?.status).toBe('success');
    expect(h?.error).toBeNull();
  });

  test('move: meta 缺快照点记 failed(历史 bars 再多也不算成功,当天要重试)', async () => {
    await runDailyJob({
      db,
      moveUpdater: async () => ({
        total: 2126,
        latest: '2026-07-17',
        metaDate: null,
        gotMetaPoint: false,
        stalled: false,
      }),
    });
    const h = getJobHealth(db).find((h) => h.name === 'move');
    expect(h?.status).toBe('failed');
    expect(h?.error).toContain('无可用收盘快照');
  });

  test('move: 源冻结只挂告警,仍记 success(partial 会卡住当天守卫)', async () => {
    await runDailyJob({
      db,
      moveUpdater: async () => ({
        total: 2126,
        latest: '2026-07-31',
        metaDate: '2026-07-31',
        gotMetaPoint: true,
        stalled: true,
      }),
    });
    const h = getJobHealth(db).find((h) => h.name === 'move');
    expect(h?.status).toBe('success'); // 必须是 success,否则这组当天每个触发点都白重跑
    expect(h?.error).toContain('未前进');
  });

  test('vx_term_structure: updater 抛错记 failed', async () => {
    await runDailyJob({
      db,
      vxUpdater: async () => {
        throw new Error('CBOE down');
      },
    });
    const h = getJobHealth(db).find((h) => h.name === 'vx_term_structure');
    expect(h?.status).toBe('failed');
    expect(h?.error).toContain('CBOE down');
  });
});

// 守卫只看「当天 success 过」会被数据源晚发布坑:过早那次 success 但没拿到上一交易日那根,
// 当天其余触发点全被跳过(2026-10-20 实测)。探针滞后时守卫不放行。
describe('staleFreshnessProbes', () => {
  const putVx1 = (db: Database, obsDate: string) => insertMarketSeries(db, [{ seriesId: 'VX1', obsDate, value: 20 }]);
  const putPc = (db: Database, obsDate: string) =>
    insertMarketSeries(db, [{ seriesId: 'CBOE_PC_EQUITY', obsDate, value: 0.6 }]);
  const upTo = (date: string) => {
    const db = freshDb();
    putVx1(db, date);
    putPc(db, date);
    return db;
  };

  test('全部到上一交易日 → 空;旧行不影响(看的是最新一天)', () => {
    const db = upTo('2026-10-19');
    putVx1(db, '2026-10-16');
    expect(staleFreshnessProbes(db, '2026-10-19')).toEqual([]);
  });

  test('只有一条滞后 → 只列它', () => {
    const db = upTo('2026-10-19');
    putPc(db, '2026-10-20');
    expect(staleFreshnessProbes(db, '2026-10-20')).toEqual(['VX1']);
  });

  test('全部滞后 / 空库 → 全列', () => {
    expect(staleFreshnessProbes(upTo('2026-10-19'), '2026-10-20')).toEqual(['VX1', 'CBOE_PC_EQUITY']);
    expect(staleFreshnessProbes(freshDb(), '2026-10-19')).toEqual(['VX1', 'CBOE_PC_EQUITY']);
  });
});

// 守卫按组判:一组失败只重跑它自己,已成功的组(尤其期权快照)不被后续触发点覆盖。
describe('按组的成功即止守卫', () => {
  test('pendingGroups:剔掉今天已成功的;force 的不论成败都跑', () => {
    const groups = ['options', 'vx_term_structure', 'computable_gpu'];
    expect(pendingGroups(groups, [])).toEqual(groups);
    expect(pendingGroups(groups, ['options', 'vx_term_structure'])).toEqual(['computable_gpu']);
    expect(pendingGroups(groups, groups)).toEqual([]);
    expect(pendingGroups(groups, groups, ['vx_term_structure'])).toEqual(['vx_term_structure']);
  });

  test('groupsForStaleProbes:VX1 → vx_term_structure,认沽认购比 → put_call', () => {
    expect(groupsForStaleProbes([])).toEqual([]);
    expect(groupsForStaleProbes(['VX1'])).toEqual(['vx_term_structure']);
    expect(groupsForStaleProbes(['VX1', 'CBOE_PC_EQUITY'])).toEqual(['vx_term_structure', 'put_call']);
  });

  test('runPendingGroups:失败的组下一轮单独重跑,成功的组不再跑;全绿后整轮跳过', async () => {
    const db = freshDb();
    const calls: string[] = [];
    let gpuUp = false;
    const table = {
      vx_term_structure: () => ({
        vxUpdater: async () => {
          calls.push('vx');
          return { total: 1 };
        },
      }),
      computable_gpu: () => ({
        computableGpuUpdater: async () => {
          calls.push('gpu');
          return gpuUp ? { total: 1, missing: [], errors: [] } : { total: 0, missing: ['H100'], errors: ['503'] };
        },
      }),
    };

    expect(await runPendingGroups(db, table)).toEqual(['vx_term_structure', 'computable_gpu']);
    expect(calls).toEqual(['vx', 'gpu']);

    gpuUp = true;
    expect(await runPendingGroups(db, table)).toEqual(['computable_gpu']);
    expect(calls).toEqual(['vx', 'gpu', 'gpu']);

    expect(await runPendingGroups(db, table)).toEqual([]);
    expect(await runPendingGroups(db, table, ['vx_term_structure'])).toEqual(['vx_term_structure']);
    expect(calls).toEqual(['vx', 'gpu', 'gpu', 'vx']);
  });
});
