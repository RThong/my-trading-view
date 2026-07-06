import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { backfillEris } from './erisBackfill';

describe('backfillEris', () => {
  it('遍历日期,存交易日、跳 null(非交易日)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    // 07-04/07-05 周末返回 null;07-03、07-06 有数据
    const fake = async (date: string) =>
      date === '2026-07-03' || date === '2026-07-06'
        ? { date, points: [{ tenor: '3M', rate: 3.7 }] }
        : null;
    const { days } = await backfillEris(db, '2026-07-03', fake, '2026-07-06');
    expect(days).toBe(2); // 只有两天有数据
    expect(getMarketSeries(db, 'ERIS_OIS_3M').map((r) => r.date)).toEqual(['2026-07-03', '2026-07-06']);
    db.close();
  });

  it('单日抛错(如早年 LIBOR 格式解析失败)跳过,不中断整段', async () => {
    const db = new Database(':memory:');
    migrate(db);
    // 07-04 抛错(模拟老格式解析失败),07-03/07-05 有数据 → 应跳 1、存 2,不整段崩
    const fake = async (date: string) => {
      if (date === '2026-07-04') throw new Error('Eris CSV: 无有效数据行');
      return { date, points: [{ tenor: '3M', rate: 3.7 }] };
    };
    const { days, skipped } = await backfillEris(db, '2026-07-03', fake, '2026-07-05');
    expect(days).toBe(2);
    expect(skipped).toBe(1);
    db.close();
  });
});
