import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getPriceBars, insertPriceEod } from '../storage/repository';
import { updateBtcPrice } from './btcPrice';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close });

describe('updateBtcPrice', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('空库从 2012-01-01 全量拉 Bitstamp,source=bitstamp', async () => {
    const asked: string[] = [];
    const total = await updateBtcPrice(db, {
      bitstamp: async (from) => {
        asked.push(from);
        return [bar('2012-01-01', 5), bar('2012-01-02', 5.2)];
      },
    });

    expect(asked).toEqual(['2012-01-01']);
    expect(total).toBe(2);
    expect(getPriceBars(db, 'BTC').map((b) => b.date)).toEqual(['2012-01-01', '2012-01-02']);
  });

  test('增量从库里最新那天(含)续抓,覆盖当天的盘中值', async () => {
    insertPriceEod(db, [
      { underlying: 'BTC', obsDate: '2026-10-05', open: 1, high: 1, low: 1, close: 1, source: 'bitstamp' },
    ]);
    const asked: string[] = [];
    await updateBtcPrice(db, {
      bitstamp: async (from) => {
        asked.push(from);
        return [bar('2026-10-05', 85755), bar('2026-10-06', 86170)];
      },
    });

    expect(asked).toEqual(['2026-10-05']);
    expect(getPriceBars(db, 'BTC').map((b) => b.close)).toEqual([85755, 86170]);
  });

  test('Bitstamp 抛错(含没拉全)→ 降级 Yahoo,同一起点', async () => {
    let yahooSince = '';
    const total = await updateBtcPrice(db, {
      bitstamp: async () => {
        throw new Error('Bitstamp 502');
      },
      yahoo: async (since) => {
        yahooSince = since;
        return [bar('2026-06-27', 1.5)];
      },
    });

    expect(yahooSince).toBe('2012-01-01');
    expect(total).toBe(1);
    expect(getPriceBars(db, 'BTC')[0].close).toBe(1.5);
  });

  test('起点只认 bitstamp 行:Yahoo 降级 / 旧 Deribit 写进来的行会在 Bitstamp 恢复后被覆盖', async () => {
    insertPriceEod(db, [
      { underlying: 'BTC', obsDate: '2018-08-13', open: 1, high: 1, low: 1, close: 1, source: 'bitstamp' },
      { underlying: 'BTC', obsDate: '2026-10-06', open: 1, high: 1, low: 1, close: 1, source: 'yahoo' },
    ]);
    const asked: string[] = [];
    await updateBtcPrice(db, {
      bitstamp: async (from) => {
        asked.push(from);
        return [];
      },
    });

    expect(asked).toEqual(['2018-08-13']);
  });
});
