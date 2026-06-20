import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { realizedVol, computeVrp } from '../analytics/vrp';

// 各标的的 VRP 配方:隐含腿、RV 腿(现货)、RV 窗口、年化周期数。
// VIX 跳过(对波动率指数算 VRP 概念别扭)。
const RECIPE: Record<string, { iv: string; spot: string; window: number; periodsPerYear: number }> = {
  SPY: { iv: 'VIX',  spot: 'SPX', window: 21, periodsPerYear: 252 },
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
