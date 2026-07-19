import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { SOX_FNG_SERIES, SOX_FNG_RAW_SERIES, SOX_FNG_MOM_LINES } from '../jobs/soxFng';

// 半导体恐贪指数:纯读 market_series(daily job sox_fng 维护),零外拉、零存储副作用。
// series = 6 条 0-100 归一分(徽标/复合);raw = 6 条原生值;momLines = 动量图的价+均线两条。
// 前端各腿按 at(-1) 自行判断有无,故不返回 unavailable 汇总。
export const soxFngRoute = new Hono().get('/', (c) => {
  const db = openDb();
  try {
    const read = (ids: Record<string, string>) =>
      Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, getMarketSeries(db, id)]));
    return c.json({ series: read(SOX_FNG_SERIES), raw: read(SOX_FNG_RAW_SERIES), momLines: read(SOX_FNG_MOM_LINES) });
  } finally {
    db.close();
  }
});
