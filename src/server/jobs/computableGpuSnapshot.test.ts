import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updateComputableGpu } from './computableGpuSnapshot';
import type { CgiSku } from '../fetchers/computableGpu';

const TODAY = '2026-09-01';

describe('updateComputableGpu', () => {
  it('按 SKU 存进 market_series 的 CGI_{sku},核心 SKU 今天都有点 → missing 空', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const data: Record<CgiSku, { date: string; value: number }[]> = {
      H100: [{ date: TODAY, value: 3.5 }],
      H200: [{ date: TODAY, value: 4.2 }],
      B200: [{ date: TODAY, value: 6.7 }],
      B300: [{ date: TODAY, value: 7.8 }],
    };
    const { total, missing } = await updateComputableGpu(db, async (sku) => data[sku], TODAY);
    expect(total).toBe(4);
    expect(missing).toEqual([]);
    expect(getMarketSeries(db, 'CGI_H100')).toEqual([{ date: TODAY, value: 3.5 }]);
    expect(getMarketSeries(db, 'CGI_B300')).toEqual([{ date: TODAY, value: 7.8 }]);
    db.close();
  });

  it('B300 单独抓空不算 missing(experimental,允许缺);核心 SKU 缺才报', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const { total, missing } = await updateComputableGpu(
      db,
      async (sku) => (sku === 'B300' ? [] : [{ date: TODAY, value: 1 }]),
      TODAY,
    );
    expect(total).toBe(3);
    expect(missing).toEqual([]);
    expect(getMarketSeries(db, 'CGI_B300')).toEqual([]);
    db.close();
  });

  it('核心 SKU(如 H100)抓失败 → 进 missing,别的 SKU 照常写', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const { missing } = await updateComputableGpu(
      db,
      async (sku) => {
        if (sku === 'H100') throw new Error('network');
        return [{ date: TODAY, value: 1 }];
      },
      TODAY,
    );
    expect(missing).toEqual(['H100']);
    expect(getMarketSeries(db, 'CGI_H200').length).toBe(1);
    db.close();
  });

  it('源当天停更但历史里还有旧日均值(rows 非空)→ 核心 SKU 仍算 missing,不能只看 rows.length', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const { total, missing } = await updateComputableGpu(
      db,
      async (sku) => (sku === 'H100' ? [{ date: '2026-08-30', value: 3.5 }] : [{ date: TODAY, value: 1 }]),
      TODAY,
    );
    expect(missing).toEqual(['H100']); // rows 非空(有旧值)但没有今天的点 → 仍报 missing
    expect(total).toBe(4); // 旧值照样写库(幂等覆盖不受影响,只是 job 成败判定要看今天)
    expect(getMarketSeries(db, 'CGI_H100')).toEqual([{ date: '2026-08-30', value: 3.5 }]);
    db.close();
  });
});
