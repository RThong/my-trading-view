import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updateErisSnapshot } from './erisSnapshot';

describe('updateErisSnapshot', () => {
  it('把 Eris 曲线按 ERIS_OIS_{tenor} 存进 market_series', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const curve = { date: '2026-07-02', points: [{ tenor: '3M', rate: 3.7194 }, { tenor: '10Y', rate: 4.0647 }] };
    const { total } = await updateErisSnapshot(db, async () => curve);
    expect(total).toBe(2);
    const r = getMarketSeries(db, 'ERIS_OIS_3M');
    expect(r).toEqual([{ date: '2026-07-02', value: 3.7194 }]);
    db.close();
  });
});
