import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getOptions25Delta, getJobHealth } from '../storage/repository';
import { runDailyJob } from './daily';
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
    expect(h?.status).toBe('success'); // 必须是 success,否则 REQUIRED_JOBS 守卫当天永远不绿
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
