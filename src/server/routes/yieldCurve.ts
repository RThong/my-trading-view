import { Hono } from 'hono';
import { createFredFetcher } from '../fetchers/fred';
import type { Point } from '../analytics/regime';
import { HISTORY_START_DATE } from '../config';

// 期限 → FRED 国债不变期限收益率 series id。数组顺序即曲线 x 轴顺序。
const TENORS: [string, string][] = [
  ['1M', 'DGS1MO'], ['3M', 'DGS3MO'], ['6M', 'DGS6MO'],
  ['1Y', 'DGS1'], ['2Y', 'DGS2'], ['3Y', 'DGS3'],
  ['5Y', 'DGS5'], ['7Y', 'DGS7'], ['10Y', 'DGS10'],
  ['20Y', 'DGS20'], ['30Y', 'DGS30'],
];

/**
 * 美债收益曲线:11 个期限的 FRED 日频收益率,读时现拉、零存储(同 regime)。
 * 并行 + 优雅降级:单期限失败(FRED key 缺 / 序列 404)→ 归入 unavailable,其余照常返回。
 * 曲线的组装(取某日各期限值)在前端按需做,后端只回原始时间序列。前端 SWR 已做客户端缓存。
 */
export const yieldCurveRoute = new Hono().get('/', async (c) => {
  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const settled = await Promise.allSettled(TENORS.map(([, id]) => fred.fetchSeries(id, HISTORY_START_DATE)));

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  settled.forEach((s, i) => {
    const [tenor] = TENORS[i];
    if (s.status === 'fulfilled' && s.value.length) series[tenor] = s.value.map((r) => ({ date: r.obsDate, value: r.value }));
    else unavailable.push(tenor);
  });

  return c.json({ tenors: TENORS.map(([t]) => t), series, unavailable });
});
