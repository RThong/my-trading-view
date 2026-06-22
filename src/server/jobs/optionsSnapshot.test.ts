import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getOptions25Delta } from '../storage/repository';
import { select25Delta, runOptionsSnapshot, type OptionsChainClient, type OptionChainSnapshot } from './optionsSnapshot';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

const SAMPLE_CHAIN: OptionChainSnapshot = {
  underlyingSymbol: '^SPX',
  underlyingPrice: 5000,
  expirationDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
  calls: [
    { contractSymbol: 'TEST', strike: 4800, expiration: '2026-06-15', impliedVolatility: 0.25, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: 0.70 },
    { contractSymbol: 'TEST', strike: 5000, expiration: '2026-06-15', impliedVolatility: 0.20, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: 0.50 },
    { contractSymbol: 'TEST', strike: 5200, expiration: '2026-06-15', impliedVolatility: 0.18, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: 0.33 },
    { contractSymbol: 'TEST', strike: 5400, expiration: '2026-06-15', impliedVolatility: 0.19, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: 0.24 },  // ~25Δ call
    { contractSymbol: 'TEST', strike: 5600, expiration: '2026-06-15', impliedVolatility: 0.21, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: 0.15 },
  ],
  puts: [
    { contractSymbol: 'TEST', strike: 4400, expiration: '2026-06-15', impliedVolatility: 0.30, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: -0.12 },
    { contractSymbol: 'TEST', strike: 4600, expiration: '2026-06-15', impliedVolatility: 0.27, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: -0.26 },  // ~25Δ put
    { contractSymbol: 'TEST', strike: 4800, expiration: '2026-06-15', impliedVolatility: 0.25, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: -0.40 },
    { contractSymbol: 'TEST', strike: 5000, expiration: '2026-06-15', impliedVolatility: 0.22, bid: null, ask: null, lastPrice: null, volume: null, openInterest: null, inTheMoney: false, lastTradeDate: null, delta: -0.52 },
  ],
};

describe('select25Delta', () => {
  test('picks a strike whose call delta is near 0.25 for the call side', () => {
    const sel = select25Delta(SAMPLE_CHAIN);
    const spot = SAMPLE_CHAIN.underlyingPrice!;
    expect(sel.callStrike).toBeGreaterThan(spot);  // 虚值 call
    expect(sel.putStrike).toBeLessThan(spot);  // 虚值 put
    expect(sel.skew).toBeCloseTo(sel.putIv - sel.callIv, 8);
  });
});

describe('runOptionsSnapshot', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('writes one row per underlying, stamped with the source', async () => {
    const mock: OptionsChainClient = {
      fetchChain: async () => SAMPLE_CHAIN,
    };

    const { rows: written } = await runOptionsSnapshot({
      db,
      source: 'moomoo',
      underlyings: ['SPY'],
      client: mock,
    });

    expect(written).toHaveLength(1);

    const spyRows = getOptions25Delta(db, 'SPY', 7);
    expect(spyRows).toHaveLength(1);
    expect(spyRows[0].source).toBe('moomoo');

    // 归档表 option_chain_raw 也要带上同一 source(无 getter,直接查)。
    const raw = db.query(`SELECT source FROM option_chain_raw WHERE underlying = 'SPY'`).all() as Array<{ source: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].source).toBe('moomoo');
  });

  test('用 client 的权威交易日打戳(getTradingDate)', async () => {
    const mock: OptionsChainClient = {
      fetchChain: async () => SAMPLE_CHAIN,
      getTradingDate: async () => '2026-06-18', // 权威日历(假期已扣)
    };
    await runOptionsSnapshot({ db, source: 'moomoo', underlyings: ['SPY'], client: mock });
    expect(getOptions25Delta(db, 'SPY', 3650)[0].snapshotDate).toBe('2026-06-18');
  });

  test('source 原样落库:deribit 组写 deribit', async () => {
    const mock: OptionsChainClient = { fetchChain: async () => SAMPLE_CHAIN };

    await runOptionsSnapshot({ db, source: 'deribit', underlyings: ['BTC'], client: mock });

    expect(getOptions25Delta(db, 'BTC', 7)[0].source).toBe('deribit');
    const raw = db.query(`SELECT source FROM option_chain_raw WHERE underlying = 'BTC'`).all() as Array<{ source: string }>;
    expect(raw[0].source).toBe('deribit');
  });

  test('一个标的失败不连累另一个:成功的照常落库,失败的进 failures', async () => {
    // SPY 正常返回,.VIX 抓取抛错——只有 .VIX 应进 failures,SPY 仍要落库。
    const mock: OptionsChainClient = {
      fetchChain: async (symbol) => {
        if (symbol === '.VIX') throw new Error('暂不支持美股指数');
        return SAMPLE_CHAIN;
      },
    };

    const { rows, failures } = await runOptionsSnapshot({
      db,
      source: 'moomoo',
      underlyings: ['SPY', '.VIX'],
      client: mock,
    });

    expect(rows).toHaveLength(1);
    expect(getOptions25Delta(db, 'SPY', 7)).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('.VIX');
  });
});
