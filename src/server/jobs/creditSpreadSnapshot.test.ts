import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { CREDIT_SPREAD_IDS, updateCreditSpreads } from './creditSpreadSnapshot';

describe('updateCreditSpreads', () => {
  it('按 FRED id 落库;窗口挪走的旧日子留在库里,修订值被覆盖;失败 / 零行都记进 failures', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const row = (id: string, obsDate: string, value: number) => ({ seriesId: id, obsDate, value });

    // 第一轮:FRED 窗口从 11-13 起
    await updateCreditSpreads(db, async (id) => [row(id, '2023-11-13', 4.03), row(id, '2023-11-14', 3.92)]);

    // 第二轮:窗口往前挪了一天(11-13 掉出),11-14 被 ICE 修订;一条源报错、一条 200 但零行
    const [broken, empty] = CREDIT_SPREAD_IDS.slice(-2);
    const res = await updateCreditSpreads(db, async (id) => {
      if (id === broken) throw new Error('HTTP 500');
      return id === empty ? [] : [row(id, '2023-11-14', 3.95), row(id, '2023-11-15', 3.89)];
    });

    expect(getMarketSeries(db, 'BAMLH0A0HYM2')).toEqual([
      { date: '2023-11-13', value: 4.03 },
      { date: '2023-11-14', value: 3.95 },
      { date: '2023-11-15', value: 3.89 },
    ]);
    expect(res.succeeded).toBe(CREDIT_SPREAD_IDS.length - 2);
    expect(res.failures).toEqual([`${broken}: HTTP 500`, `${empty}: 无数据`]);

    db.close();
  });
});
