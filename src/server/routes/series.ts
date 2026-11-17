import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries, listMarketSeriesIds } from '../storage/repository';
import { volIndex } from '../live/market';
import { vrpRecipes } from '../../shared/marketCatalog';

// 原先 vrp_inputs 组写进 market_series 的波动率指数,2026-11-17 起改现拉。VRP 隐含腿从标的目录派生(目录加一条就跟着走)
const LIVE_VOL = new Set([...Object.values(vrpRecipes()).map((r) => r.iv), 'VVIX', 'SKEW']);

/**
 * 库里 market_series 的原样读取(图表编辑器用):别的接口没发、但库里攒着的序列
 * (VX 各月合约…);VVIX / GVZ / OVX 等波动率指数例外,改读时现拉。值原样给,不做换算 —— 要换算的(如 ICE CDS 价 → bp)走各自接口。
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
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    // 波动率指数已改读时现拉(见 live/market),库里旧行不再更新
    if (LIVE_VOL.has(id)) {
      try {
        return c.json((await volIndex(id)).value);
      } catch (e) {
        return c.json({ error: `${id} 取数失败: ${(e as Error).message}` }, 502);
      }
    }

    const db = openDb();
    try {
      return c.json(getMarketSeries(db, id));
    } finally {
      db.close();
    }
  });
