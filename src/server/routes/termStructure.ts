import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { computeSpread } from '../analytics/termStructure';

// VIX 期限结构 VX1−VX3:读 market_series 的 VX1/VX3,inner join 现算价差。
// 仅 VIX 有此指标,路径硬编 vix。
export const termStructureRoute = new Hono()
  .get('/vix', (c) => {
    const db = openDb();
    try {
      return c.json(computeSpread(getMarketSeries(db, 'VX1'), getMarketSeries(db, 'VX3')));
    } finally {
      db.close();
    }
  });
