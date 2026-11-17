import { Hono } from 'hono';
import { closedBars, volIndex } from '../live/market';
import { realizedVol, computeVrp } from '../analytics/vrp';
import { vrpRecipes } from '../../shared/marketCatalog';

// VRP 配方(隐含腿 / RV 现货腿 / RV 窗口 / 年化周期)由标的目录派生,与前端 IV_INDEX 同源。
// periodsPerYear:美股 ETF/指数一律 252(USO 是 NYSE 时段 ETF,也 252);只有 BTC(24/7)用 365。
const RECIPE = vrpRecipes();

export const vrpRoute = new Hono().get('/:underlying', async (c) => {
  const u = c.req.param('underlying').toUpperCase();
  const r = RECIPE[u];
  if (!r) return c.json({ error: `no VRP recipe for: ${u}` }, 400);

  try {
    // 隐含腿:波动率指数;RV 腿:标的现货 close,只用已收盘的 bar(BTC 当天盘中那根会把短窗 RV 拉低)
    const [iv, bars] = await Promise.all([volIndex(r.iv), closedBars(r.spot)]);
    const rv = realizedVol(
      bars.value.map((b) => ({ date: b.date, value: b.close })),
      r.window,
      r.periodsPerYear,
    );
    return c.json(computeVrp(iv.value, rv));
  } catch (e) {
    return c.json({ error: `VRP 取数失败: ${(e as Error).message}` }, 502);
  }
});
