import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries, listMarketSeriesIds } from '../storage/repository';

/**
 * 库里 market_series 的原样读取(图表编辑器用):别的接口没发、但库里攒着的序列
 * (VVIX / GVZ / OVX / VX 各月合约…)。值原样给,不做换算 —— 要换算的(如 ICE CDS 价 → bp)走各自接口。
 *  · GET /api/series?prefix=VX:  → 该前缀下的 series_id 清单
 *  · GET /api/series/:id         → [{ date, value }],没有这条 = 空数组
 */
export const seriesRoute = new Hono()
  .get('/', (c) => {
    const prefix = c.req.query('prefix');
    if (!prefix) return c.json({ error: 'prefix required' }, 400);

    const db = openDb();
    try {
      return c.json(listMarketSeriesIds(db, prefix));
    } finally {
      db.close();
    }
  })
  .get('/:id', (c) => {
    const db = openDb();
    try {
      return c.json(getMarketSeries(db, c.req.param('id')));
    } finally {
      db.close();
    }
  });
