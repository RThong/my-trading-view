import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updatePensfordSnapshot } from './pensfordSnapshot';

describe('updatePensfordSnapshot', () => {
  it('把 Pensford 快照按 symbol 存进 market_series', async () => {
    const db = new Database(':memory:');
    migrate(db);
    // 注入假 fetch(返回两天快照,验证逐日攒历史 + 幂等;只存 FF* 和 FEDFUNDS,SOFRSWAP 丢弃)
    const xml = (d: string) => `<TFCrecords timeStamp="${d} 06:00:01 PM">
      <record><symbol>SOFRSWAP Y5</symbol><quoteDate>${d}</quoteDate><quote>0.039</quote></record>
      <record><symbol>FF2_Comdty</symbol><quoteDate>${d}</quoteDate><quote>96.3</quote></record>
      <record><symbol>FEDFUNDS</symbol><quoteDate>${d}</quoteDate><quote>0.0363</quote></record></TFCrecords>`;

    const { total } = await updatePensfordSnapshot(db, async () => new Response(xml('07/02/2026')));
    expect(total).toBe(2); // 只存 FF2_Comdty + FEDFUNDS
    expect(getMarketSeries(db, 'SOFRSWAP Y5')).toEqual([]); // SOFRSWAP 不入库
    expect(getMarketSeries(db, 'FF2_Comdty').length).toBe(1);

    await updatePensfordSnapshot(db, async () => new Response(xml('07/03/2026')));

    const ff2 = getMarketSeries(db, 'FF2_Comdty');
    expect(ff2.map((r) => r.date)).toEqual(['2026-07-02', '2026-07-03']); // 逐日攒
    expect(ff2[1].value).toBe(96.3);

    // 幂等检验:同日重跑
    await updatePensfordSnapshot(db, async () => new Response(xml('07/03/2026')));
    expect(getMarketSeries(db, 'FF2_Comdty').length).toBe(2); // 幂等:仍是 2 天,不重复
    db.close();
  });
});
