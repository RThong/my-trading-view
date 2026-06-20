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
    expect(sel.callStrike).toBeGreaterThan(SAMPLE_CHAIN.underlyingPrice);  // 虚值 call
    expect(sel.putStrike).toBeLessThan(SAMPLE_CHAIN.underlyingPrice);  // 虚值 put
    expect(sel.skew).toBeCloseTo(sel.putIv - sel.callIv, 8);
  });
});

describe('runOptionsSnapshot', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('writes one row per underlying with is_mock=0', async () => {
    const mock: OptionsChainClient = {
      fetchChain: async () => SAMPLE_CHAIN,
    };

    const written = await runOptionsSnapshot({
      db,
      underlyings: ['SPY'],
      client: mock,
    });

    expect(written).toHaveLength(1);

    const spyRows = getOptions25Delta(db, 'SPY', 7);
    expect(spyRows).toHaveLength(1);
    expect(spyRows[0].isMock).toBe(false);
  });
});
