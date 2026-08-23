import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getPriceBars } from '../storage/repository';
import { updateBtcPrice } from './btcPrice';

// 回填腿必须注入:不注入就会去打 Bitstamp 真网(单测不联网)。
const noBackfill = async () => [];

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('updateBtcPrice', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('写 BTC 日 bar 进 price_eod,source=deribit', async () => {
    const total = await updateBtcPrice(db, {
      deribit: async () => [
        { date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 },
        { date: '2026-06-28', open: 1.5, high: 2.5, low: 1, close: 2 },
      ],
      bitstamp: noBackfill,
    });
    expect(total).toBe(2);
    const bars = getPriceBars(db, 'BTC');
    expect(bars.map((b) => b.date)).toEqual(['2026-06-27', '2026-06-28']); // 含周末,无过滤
    expect(bars[1].close).toBe(2);
  });

  test('Deribit 抛错 → 降级 Yahoo,source=yahoo', async () => {
    const total = await updateBtcPrice(db, {
      deribit: async () => {
        throw new Error('Deribit 503');
      },
      yahoo: async () => [{ date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 }],
      bitstamp: noBackfill,
    });
    expect(total).toBe(1);
    expect(getPriceBars(db, 'BTC')[0].close).toBe(1.5);
  });

  test('回填区间写死,不覆盖 Deribit 的行', async () => {
    const asked: string[] = [];
    const total = await updateBtcPrice(db, {
      deribit: async () => [{ date: '2018-08-14', open: 6000, high: 6300, low: 5900, close: 6200 }],
      bitstamp: async (from, to) => {
        asked.push(from, to);
        return [{ date: '2012-01-01', open: 4.58, high: 5, low: 4.58, close: 5 }];
      },
    });

    expect(asked).toEqual(['2012-01-01', '2018-08-13']); // 上界 = Deribit 第一天 −1
    expect(total).toBe(2);
    expect(getPriceBars(db, 'BTC').map((b) => b.date)).toEqual(['2012-01-01', '2018-08-14']);
  });

  // 这条守的是「分段不随当天增量的结果漂」:边界若取自库里最早那天,Deribit 回空(空库)
  // 会让 Bitstamp 一路写到今天、把 Deribit 该管的整段占掉,而且之后再也不会被修回来。
  test('Deribit 回空数组也不让回填越过 Deribit 边界', async () => {
    const asked: string[] = [];
    await updateBtcPrice(db, {
      deribit: async () => [],
      yahoo: async () => [],
      bitstamp: async (from, to) => {
        asked.push(from, to);
        return [];
      },
    });

    expect(asked).toEqual(['2012-01-01', '2018-08-13']);
  });

  // 同理:降级到 Yahoo(只到 2014-09)不该把 Bitstamp 段截短。
  test('Deribit 降级 Yahoo 后回填区间不变', async () => {
    const asked: string[] = [];
    await updateBtcPrice(db, {
      deribit: async () => {
        throw new Error('Deribit 503');
      },
      yahoo: async () => [{ date: '2014-09-17', open: 450, high: 460, low: 440, close: 455 }],
      bitstamp: async (from, to) => {
        asked.push(from, to);
        return [];
      },
    });

    expect(asked).toEqual(['2012-01-01', '2018-08-13']);
  });

  test('已补到起点 → 不再请求 Bitstamp', async () => {
    await updateBtcPrice(db, {
      deribit: async () => [{ date: '2012-01-01', open: 4.58, high: 5, low: 4.58, close: 5 }],
      bitstamp: noBackfill,
    });

    let called = false;
    await updateBtcPrice(db, {
      deribit: async () => [],
      bitstamp: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
  });

  test('Bitstamp 失败不影响增量', async () => {
    const total = await updateBtcPrice(db, {
      deribit: async () => [{ date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 }],
      bitstamp: async () => {
        throw new Error('Bitstamp 502');
      },
    });
    expect(total).toBe(1);
    expect(getPriceBars(db, 'BTC')).toHaveLength(1);
  });
});
