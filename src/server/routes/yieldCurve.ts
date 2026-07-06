import { Hono } from 'hono';
import { createFredFetcher } from '../fetchers/fred';
import type { Point } from '../analytics/regime';
import { HISTORY_START_DATE } from '../config';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { ERIS_OIS_TENORS, FF_CONTRACTS, ffLabel, impliedFedRate } from '../analytics/rateCurves';

// 期限 → FRED 国债不变期限收益率 series id。数组顺序即曲线 x 轴顺序。
const TENORS: [string, string][] = [
  ['1M', 'DGS1MO'], ['3M', 'DGS3MO'], ['6M', 'DGS6MO'],
  ['1Y', 'DGS1'], ['2Y', 'DGS2'], ['3Y', 'DGS3'],
  ['5Y', 'DGS5'], ['7Y', 'DGS7'], ['10Y', 'DGS10'],
  ['20Y', 'DGS20'], ['30Y', 'DGS30'],
];

type CurveBody = { tenors: string[]; series: Record<string, Point[]>; unavailable: string[] };

/**
 * 美债收益曲线:11 个期限的 FRED 日频收益率,读时现拉、零存储(同 regime)。
 * 并行 + 优雅降级:单期限失败(FRED key 缺 / 序列 404)→ 归入 unavailable,其余照常返回。
 * 曲线的组装(取某日各期限值)在前端按需做,后端只回原始时间序列。前端 SWR 已做客户端缓存。
 */
async function buildTreasury(): Promise<CurveBody> {
  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const settled = await Promise.allSettled(TENORS.map(([, id]) => fred.fetchSeries(id, HISTORY_START_DATE)));

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  settled.forEach((s, i) => {
    const [tenor] = TENORS[i];
    if (s.status === 'fulfilled' && s.value.length) series[tenor] = s.value.map((r) => ({ date: r.obsDate, value: r.value }));
    else unavailable.push(tenor);
  });

  return { tenors: TENORS.map(([t]) => t), series, unavailable };
}

// 从 market_series 读一组 (label→symbol),按 xform 转值;缺行的 label 进 unavailable。
function buildFromDb(pairs: { label: string; symbol: string }[], xform: (v: number) => number): CurveBody {
  const db = openDb();
  try {
    // 一次查库,再声明式拆成 series(有数据)/ unavailable(缺数据)两组。
    const fetched = pairs.map((p) => ({ label: p.label, rows: getMarketSeries(db, p.symbol) }));
    const series = Object.fromEntries(
      fetched.filter((f) => f.rows.length).map((f) => [f.label, f.rows.map((r) => ({ date: r.date, value: xform(r.value) }))]),
    );
    const unavailable = fetched.filter((f) => !f.rows.length).map((f) => f.label);
    return { tenors: pairs.map((p) => p.label), series, unavailable };
  } finally {
    db.close();
  }
}

// Eris 的 FairCoupon 已是百分点 → 恒等 xform。
const buildOis = (): CurveBody =>
  buildFromDb(ERIS_OIS_TENORS.map((t) => ({ label: t, symbol: `ERIS_OIS_${t}` })), (v) => v);
const buildFedPath = (): CurveBody =>
  buildFromDb(FF_CONTRACTS.map((n) => ({ label: ffLabel(n), symbol: `FF${n}_Comdty` })), impliedFedRate);

export const yieldCurveRoute = new Hono().get('/', async (c) => {
  const source = c.req.query('source') ?? 'treasury';
  if (source === 'sofr_ois') return c.json(buildOis());
  if (source === 'fed_path') return c.json(buildFedPath());
  return c.json(await buildTreasury()); // 默认国债(FRED 现拉)
});
