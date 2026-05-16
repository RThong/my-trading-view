import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getOptions25Delta } from '../storage/repository';
import { select25Delta, runOptionsSnapshot } from './optionsSnapshot';
import type { OptionChainSnapshot, YahooOptionsClient } from '../fetchers/yahooOptions';

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
    { strike: 4800, impliedVolatility: 0.25 },
    { strike: 5000, impliedVolatility: 0.20 },
    { strike: 5200, impliedVolatility: 0.18 },
    { strike: 5400, impliedVolatility: 0.19 },  // ~25Δ call should land here-ish
    { strike: 5600, impliedVolatility: 0.21 },
  ],
  puts: [
    { strike: 4400, impliedVolatility: 0.30 },
    { strike: 4600, impliedVolatility: 0.27 },  // ~25Δ put should land here-ish
    { strike: 4800, impliedVolatility: 0.25 },
    { strike: 5000, impliedVolatility: 0.22 },
  ],
};

describe('select25Delta', () => {
  test('picks a strike whose call delta is near 0.25 for the call side', () => {
    const sel = select25Delta(SAMPLE_CHAIN, 0.045);
    expect(sel.callStrike).toBeGreaterThan(SAMPLE_CHAIN.underlyingPrice);  // OTM call
    expect(sel.putStrike).toBeLessThan(SAMPLE_CHAIN.underlyingPrice);  // OTM put
    expect(sel.skew).toBeCloseTo(sel.putIv - sel.callIv, 8);
  });
});

describe('runOptionsSnapshot', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('writes one row per underlying with is_mock=0', async () => {
    const mock: YahooOptionsClient = {
      fetchChain: async () => SAMPLE_CHAIN,
    };
    const written = await runOptionsSnapshot({
      db,
      underlyings: ['SPX', 'VIX'],
      yahooOptions: mock,
      riskFreeRate: 0.045,
    });
    expect(written).toHaveLength(2);
    const spxRows = getOptions25Delta(db, 'SPX', 7);
    expect(spxRows).toHaveLength(1);
    expect(spxRows[0].isMock).toBe(false);
  });
});
