import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getPriceBars } from '../storage/repository';
import { updateBtcPrice } from './btcPrice';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('updateBtcPrice', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('写 BTC 日 bar 进 price_eod,source=deribit', async () => {
    const total = await updateBtcPrice(db, {
      deribit: async () => [
        { date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 },
        { date: '2026-06-28', open: 1.5, high: 2.5, low: 1, close: 2 },
      ],
    });
    expect(total).toBe(2);
    const bars = getPriceBars(db, 'BTC');
    expect(bars.map((b) => b.date)).toEqual(['2026-06-27', '2026-06-28']); // 含周末,无过滤
    expect(bars[1].close).toBe(2);
  });

  test('Deribit 抛错 → 降级 Yahoo,source=yahoo', async () => {
    const total = await updateBtcPrice(db, {
      deribit: async () => { throw new Error('Deribit 503'); },
      yahoo: async () => [{ date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 }],
    });
    expect(total).toBe(1);
    expect(getPriceBars(db, 'BTC')[0].close).toBe(1.5);
  });
});
