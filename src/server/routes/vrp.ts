import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries, getPriceBars } from '../storage/repository';
import { realizedVol, computeVrp } from '../analytics/vrp';
import { vrpRecipes } from '../../shared/marketCatalog';

// VRP 配方(隐含腿 / RV 现货腿 / RV 窗口 / 年化周期)由标的目录派生,与前端 IV_INDEX 同源。
// periodsPerYear:美股 ETF/指数一律 252(USO 是 NYSE 时段 ETF,也 252);只有 BTC(24/7)用 365。
const RECIPE = vrpRecipes();

export const vrpRoute = new Hono().get('/:underlying', (c) => {
  const u = c.req.param('underlying').toUpperCase();
  const r = RECIPE[u];
  if (!r) return c.json({ error: `no VRP recipe for: ${u}` }, 400);

  const db = openDb();
  try {
    const iv = getMarketSeries(db, r.iv); // 隐含腿:波动率指数
    const rv = realizedVol(
      getPriceBars(db, r.spot).map((b) => ({ date: b.date, value: b.close })),
      r.window,
      r.periodsPerYear,
    ); // RV 腿:标的现货 close
    return c.json(computeVrp(iv, rv));
  } finally {
    db.close();
  }
});
