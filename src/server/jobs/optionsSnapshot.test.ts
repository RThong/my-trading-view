import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getOptions25Delta } from '../storage/repository';
import {
  select25Delta,
  runOptionsSnapshot,
  type OptionsChainClient,
  type OptionChainSnapshot,
} from './optionsSnapshot';

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
    {
      contractSymbol: 'TEST',
      strike: 4800,
      expiration: '2026-06-15',
      impliedVolatility: 0.25,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: 0.7,
    },
    {
      contractSymbol: 'TEST',
      strike: 5000,
      expiration: '2026-06-15',
      impliedVolatility: 0.2,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: 0.5,
    },
    {
      contractSymbol: 'TEST',
      strike: 5200,
      expiration: '2026-06-15',
      impliedVolatility: 0.18,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: 0.33,
    },
    {
      contractSymbol: 'TEST',
      strike: 5400,
      expiration: '2026-06-15',
      impliedVolatility: 0.19,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: 0.24,
    }, // ~25Δ call
    {
      contractSymbol: 'TEST',
      strike: 5600,
      expiration: '2026-06-15',
      impliedVolatility: 0.21,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: 0.15,
    },
  ],
  puts: [
    {
      contractSymbol: 'TEST',
      strike: 4400,
      expiration: '2026-06-15',
      impliedVolatility: 0.3,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: -0.12,
    },
    {
      contractSymbol: 'TEST',
      strike: 4600,
      expiration: '2026-06-15',
      impliedVolatility: 0.27,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: -0.26,
    }, // ~25Δ put
    {
      contractSymbol: 'TEST',
      strike: 4800,
      expiration: '2026-06-15',
      impliedVolatility: 0.25,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: -0.4,
    },
    {
      contractSymbol: 'TEST',
      strike: 5000,
      expiration: '2026-06-15',
      impliedVolatility: 0.22,
      bid: null,
      ask: null,
      lastPrice: null,
      volume: null,
      openInterest: null,
      inTheMoney: false,
      lastTradeDate: null,
      delta: -0.52,
    },
  ],
};

describe('select25Delta', () => {
  test('picks a strike whose call delta is near 0.25 for the call side', () => {
    const sel = select25Delta(SAMPLE_CHAIN);
    const spot = SAMPLE_CHAIN.underlyingPrice!;
    expect(sel.callStrike).toBeGreaterThan(spot); // 虚值 call
    expect(sel.putStrike).toBeLessThan(spot); // 虚值 put
    expect(sel.skew).toBeCloseTo(sel.putIv - sel.callIv, 8);
  });

  test('忽略 delta 为 0 的未报价合约', () => {
    // 有效合约离 ±0.25 比 delta=0 更远,不剔掉就会选中未报价那张
    const unquoted = { ...SAMPLE_CHAIN.calls[0], strike: 9999, delta: 0, impliedVolatility: 0 };
    const sel = select25Delta({
      ...SAMPLE_CHAIN,
      calls: [...SAMPLE_CHAIN.calls.filter((c) => c.delta === 0.7), unquoted],
      puts: [...SAMPLE_CHAIN.puts.filter((c) => c.delta === -0.52), unquoted],
    });

    expect(sel).toMatchObject({ callStrike: 4800, callIv: 0.25, putStrike: 5000, putIv: 0.22 });
  });

  test('忽略 delta 正常但 IV 为 0 的合约', () => {
    const noIv = { ...SAMPLE_CHAIN.calls[0], strike: 9999, impliedVolatility: 0 };
    const sel = select25Delta({
      ...SAMPLE_CHAIN,
      calls: [...SAMPLE_CHAIN.calls, { ...noIv, delta: 0.25 }],
      puts: [...SAMPLE_CHAIN.puts, { ...noIv, delta: -0.25 }],
    });

    expect(sel).toMatchObject({ callStrike: 5400, callIv: 0.19, putStrike: 4600, putIv: 0.27 });
  });

  test('整条链都没报价(全 0)就抛错,不写 0', () => {
    const zero = (c: (typeof SAMPLE_CHAIN.calls)[number]) => ({ ...c, delta: 0, impliedVolatility: 0 });
    expect(() =>
      select25Delta({ ...SAMPLE_CHAIN, calls: SAMPLE_CHAIN.calls.map(zero), puts: SAMPLE_CHAIN.puts.map(zero) }),
    ).toThrow();
  });
});

describe('runOptionsSnapshot', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

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
    const raw = db.query(`SELECT source FROM option_chain_raw WHERE underlying = 'SPY'`).all() as Array<{
      source: string;
    }>;
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
    const raw = db.query(`SELECT source FROM option_chain_raw WHERE underlying = 'BTC'`).all() as Array<{
      source: string;
    }>;
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

  test('链全为 0 的标的进 failures、两张表都不落库', async () => {
    const zero = (c: (typeof SAMPLE_CHAIN.calls)[number]) => ({ ...c, delta: 0, impliedVolatility: 0 });
    const mock: OptionsChainClient = {
      fetchChain: async () => ({
        ...SAMPLE_CHAIN,
        calls: SAMPLE_CHAIN.calls.map(zero),
        puts: SAMPLE_CHAIN.puts.map(zero),
      }),
    };

    const { rows, failures } = await runOptionsSnapshot({ db, source: 'moomoo', underlyings: ['.VIX'], client: mock });

    expect(rows).toHaveLength(0);
    expect(failures[0]).toContain('.VIX');
    expect(getOptions25Delta(db, '.VIX', 7)).toHaveLength(0);
    expect(db.query(`SELECT 1 FROM option_chain_raw WHERE underlying = '.VIX'`).all()).toHaveLength(0);
  });
});
