import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { realizedVol, computeVrp } from '../analytics/vrp';

// 各标的的 VRP 配方:隐含腿、RV 腿(基准现货)、RV 窗口、年化周期数。
// ponytail: iv 字段 = web/panels/assetChart.hooks.ts 的 IV_INDEX 同一份映射,改一处必同步另一处。
// periodsPerYear 按交易时段:美股 ETF/指数一律 252(USO 是 NYSE 时段 ETF,不是 24/7
// 商品,也用 252);只有 BTC(24/7)用 365。
const RECIPE: Record<string, { iv: string; spot: string; window: number; periodsPerYear: number }> = {
  SPY: { iv: 'VIX',  spot: 'SPX', window: 21, periodsPerYear: 252 },
  QQQ: { iv: 'VXN',  spot: 'NDX', window: 21, periodsPerYear: 252 },
  GLD: { iv: 'GVZ',  spot: 'GLD', window: 21, periodsPerYear: 252 },
  USO: { iv: 'OVX',  spot: 'USO', window: 21, periodsPerYear: 252 },
  BTC: { iv: 'DVOL', spot: 'BTC', window: 30, periodsPerYear: 365 },
};

export const vrpRoute = new Hono()
  .get('/:underlying', (c) => {
    const u = c.req.param('underlying').toUpperCase();
    const r = RECIPE[u];
    if (!r) return c.json({ error: `no VRP recipe for: ${u}` }, 400);

    const db = openDb();
    try {
      const iv = getMarketSeries(db, r.iv);
      const rv = realizedVol(getMarketSeries(db, r.spot), r.window, r.periodsPerYear);
      return c.json(computeVrp(iv, rv));
    } finally {
      db.close();
    }
  });
