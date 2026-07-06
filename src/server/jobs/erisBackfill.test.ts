import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { backfillEris } from './erisBackfill';

describe('backfillEris(全历史单文件)', () => {
  it('把全历史每行按 ERIS_OIS_{tenor} 存入,幂等', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const hist = async () => [
      { date: '2026-07-01', points: [{ tenor: '3M', rate: 3.73 }] },
      { date: '2026-07-02', points: [{ tenor: '3M', rate: 3.72 }] },
    ];
    const { days } = await backfillEris(db, hist);
    expect(days).toBe(2);
    await backfillEris(db, hist); // 重跑幂等
    expect(getMarketSeries(db, 'ERIS_OIS_3M').map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02']);
    db.close();
  });
});
