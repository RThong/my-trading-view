import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import { insertMarketSeries, getMarketSeries } from './repository';

describe('migrate 保留 VX 期限结构序列', () => {
  test('每次 migrate 的全量 DELETE 不清掉 VX1/VX3', () => {
    const db = new Database(':memory:');
    migrate(db);
    insertMarketSeries(db, [
      { seriesId: 'VX1', obsDate: '2026-06-01', value: 18.5 },
      { seriesId: 'VX3', obsDate: '2026-06-01', value: 19.2 },
    ]);
    migrate(db); // daily job 每次启动都会再跑一次 migrate

    expect(getMarketSeries(db, 'VX1')).toHaveLength(1);
    expect(getMarketSeries(db, 'VX3')).toHaveLength(1);
  });
});
