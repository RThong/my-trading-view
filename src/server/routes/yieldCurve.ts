import { Hono } from 'hono';
import { resolve } from 'node:path';
import { createSwrCache } from './swrCache';
import { createFredFetcher } from '../fetchers/fred';
import type { Point } from '../analytics/regime';
import { HISTORY_START_DATE, PROJECT_ROOT } from '../config';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import {
  ERIS_OIS_TENORS,
  CREDIT_RATING,
  CREDIT_TERM,
  BEI_TENORS,
  computeBeiCurve,
  AI_CDS,
  cdsPriceToSpreadBp,
} from '../analytics/rateCurves';
import { fetchJgbCurve } from '../fetchers/mofJgb';
import { fetchTreasuryCurve, UST_TENORS } from '../fetchers/usTreasuryPar';

type CurveBody = {
  tenors: string[];
  series: Record<string, Point[]>;
  unavailable: string[];
  /** 本次现拉失败、沿用上一份成功数据顶上的期限(见 fillFromPrev)。 */
  fallback?: string[];
};

/**
 * 通用 FRED 曲线构建:一组 (tenor→series) 读时现拉全历史,并行 + 优雅降级。
 * 单序列失败(FRED key 缺 / 序列 404)→ 归入 unavailable,其余照常返回。
 * 值已是百分点,原样透传。服务端缓存见下方 liveCaches(swrCache)。
 */
async function buildFredCurve(pairs: { tenor: string; series: string }[]): Promise<CurveBody> {
  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const settled = await Promise.allSettled(pairs.map((p) => fred.fetchSeries(p.series, HISTORY_START_DATE)));

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  settled.forEach((s, i) => {
    const { tenor } = pairs[i];
    if (s.status === 'fulfilled' && s.value.length)
      series[tenor] = s.value.map((r) => ({ date: r.obsDate, value: r.value }));
    else unavailable.push(tenor);
  });

  return { tenors: pairs.map((p) => p.tenor), series, unavailable };
}

/**
 * 美债收益曲线:美国财政部每日 par yield 直发源(当天出,比 FRED DGS 快 1-2 天;FRED 本就搬这份)。
 * 按年拉 HISTORY_START_DATE 的年份 → 今年并行;任一年失败整体抛(由 swrCache 的 load 兜成「全缺 + 沿用上次」)。某档全程无数据 → unavailable。
 * 读时现拉、不落库;服务端缓存见下方 liveCaches(swrCache)。
 */
async function buildTreasury(): Promise<CurveBody> {
  const series = await fetchTreasuryCurve();

  const avail = Object.fromEntries(UST_TENORS.flatMap((t) => (series[t]?.length ? [[t, series[t]]] : [])));
  const unavailable = UST_TENORS.filter((t) => !series[t]?.length);

  return { tenors: UST_TENORS, series: avail, unavailable };
}

// 从 market_series 读一组 (label→symbol),按 xform 转值;缺行的 label 进 unavailable。
// xform 逐名给(缺省恒等):如 CDS 各名票息不同。
function buildFromDb(pairs: { label: string; symbol: string; xform?: (v: number) => number }[]): CurveBody {
  const db = openDb();
  try {
    // 一次查库,再声明式拆成 series(有数据)/ unavailable(缺数据)两组。
    const fetched = pairs.map((p) => ({
      label: p.label,
      xform: p.xform ?? ((v: number) => v),
      rows: getMarketSeries(db, p.symbol),
    }));
    const series = Object.fromEntries(
      fetched
        .filter((f) => f.rows.length)
        .map((f) => [
          f.label,
          // xform 无解(NaN,如 CDS 价 ≤ 回收价)的点丢掉,不吐 null 给前端
          f.rows.map((r) => ({ date: r.date, value: f.xform(r.value) })).filter((p) => Number.isFinite(p.value)),
        ]),
    );
    const unavailable = fetched.filter((f) => !f.rows.length).map((f) => f.label);
    return { tenors: pairs.map((p) => p.label), series, unavailable };
  } finally {
    db.close();
  }
}

// BEI 通胀曲线:各档拉 名义(DGS)+ TIPS 实际(DFII),现算 名义 − 实际(见 computeBeiCurve)。
// 单腿失败 → null,由 computeBeiCurve 归入 unavailable(FRED 无现成多档 breakeven,故自拼)。
async function buildBei(): Promise<CurveBody> {
  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const leg = (id: string): Promise<Point[] | null> =>
    fred
      .fetchSeries(id, HISTORY_START_DATE)
      .then((rows) => rows.map((r) => ({ date: r.obsDate, value: r.value })))
      .catch(() => null);

  const legs = await Promise.all(
    BEI_TENORS.map(async (t) => ({ tenor: t.tenor, nominal: await leg(t.nominal), real: await leg(t.real) })),
  );
  return computeBeiCurve(legs);
}

// JGB 收益曲线(MOF 官方 CSV,2018 起,15 档含 2Y)。缺档进 unavailable。
const buildJgb = async (): Promise<CurveBody> => {
  const c = await fetchJgbCurve('2018-01-01');
  const unavailable = c.tenors.filter((t) => !c.series[t]?.length);
  return { tenors: c.tenors, series: c.series, unavailable };
};

// Eris 的 FairCoupon 已是百分点 → 恒等 xform。
const buildOis = (): CurveBody => buildFromDb(ERIS_OIS_TENORS.map((t) => ({ label: t, symbol: `ERIS_OIS_${t}` })));

// AI 巨头 + 甲骨文 + CoreWeave 单名 CDS:读库原始价,xform 成约定 spread(bp)。"tenor" 复用为公司名。
// 非真曲线(公司无序),但复用 CurveBody 走 TenorHistoryPanel 的时间序列视图(每名一条线)。
// 票息按名不同(CoreWeave 500bp 档),故逐名给 xform。
const buildAiCds = (): CurveBody =>
  buildFromDb(
    AI_CDS.map((c) => ({
      label: c.name,
      symbol: `ICE_CDS_${c.ticker}`,
      xform: (v: number) => cdsPriceToSpreadBp(v, c.coupon),
    })),
  );

// 现拉外部源的曲线(FRED / 财政部 / MOF,冷拉 1~6s)。走 swrCache:有旧值先回、过期后台刷新,
// 完整结果落盘 → 服务端重启后也是先回盘上那份(见 swrCache)。
const LIVE_BUILDERS: Record<string, () => Promise<CurveBody>> = {
  treasury: buildTreasury, // 默认国债(财政部直发)
  credit_rating: () => buildFredCurve(CREDIT_RATING),
  credit_term: () => buildFredCurve(CREDIT_TERM),
  bei: buildBei, // 通胀预期(BEI = DGS − DFII 现算)
  // 实际收益率曲线(TIPS)。DFII 各档本就是 BEI 的减数腿、buildBei 每次都在拉,
  // 这里只是把它单独暴露出来 —— 与 bei 同档位,便于 名义 / 实际 / 通胀 三条对读。
  // ⚠️ ACM / Kim-Wright 期限溢价模型只发到 10Y,30Y 段的成分拆解只能靠这条实际收益率
  //(注意方向:面板上 real 是 DFII 直读,反倒是 bei 由 DGS − DFII 现算 —— 别写成「名义 − BEI」)。
  real: () => buildFredCurve(BEI_TENORS.map((t) => ({ tenor: t.tenor, series: t.real }))),
  jgb: buildJgb, // 日本国债收益曲线(MOF)
};

// 读库的曲线每次直读、不缓存:库由 daily job(别的进程)写,进程内缓存看不到,反而会把新数据挡住。
const DB_BUILDERS: Record<string, () => CurveBody> = {
  sofr_ois: buildOis,
  ai_cds: buildAiCds, // AI 巨头 + 甲骨文 + CoreWeave 单名 CDS(ICE 结算价读时换算 spread bp)
};

/** 本次现拉失败的期限用上一份顶上,记入 `fallback`;上一份也没有的照旧 unavailable。 */
export function fillFromPrev(body: CurveBody, prev: CurveBody | null): CurveBody {
  const fill = body.unavailable.filter((t) => prev?.series[t]?.length);
  if (!prev || !fill.length) return body;

  return {
    ...body,
    series: { ...body.series, ...Object.fromEntries(fill.map((t) => [t, prev.series[t]])) },
    unavailable: body.unavailable.filter((t) => !fill.includes(t)),
    fallback: fill,
  };
}

// 每个 source 一份缓存。TTL / 重试间隔与 regime 同(EOD 日频,6h 安全;降级结果 10 分钟后重试)。
const liveCaches = Object.fromEntries(
  Object.entries(LIVE_BUILDERS).map(([source, build]) => [
    source,
    createSwrCache<CurveBody>({
      ttlMs: 6 * 60 * 60 * 1000,
      retryMs: 10 * 60 * 1000,
      snapshotPath: resolve(PROJECT_ROOT, 'data', 'cache', `yield-${source}.json.gz`),
      load: async (prev) => {
        // 构造器整个抛(如 MOF CSV 挂了)= 全部期限都没拉到:按「全缺」降级,而不是让真冷请求 500。
        const tenors = prev?.tenors ?? [];
        const body = await build().catch((e: unknown) => {
          console.warn(`[yield-curve] ${source} 现拉失败,本次全部期限 unavailable: ${(e as Error).message}`);
          return { tenors, series: {}, unavailable: tenors };
        });
        return { value: fillFromPrev(body, prev), complete: body.tenors.length > 0 && !body.unavailable.length };
      },
    }),
  ]),
);

export const yieldCurveRoute = new Hono().get('/', async (c) => {
  // 缺 source → 默认 treasury;给了无效 source → 400(不静默兜底成国债,否则拼错的 source 会伪装成合理数据)。
  const source = c.req.query('source') ?? 'treasury';

  // 只认自有属性:`source=toString` / `__proto__` 会顺着原型链命中,随后抛成 500 而不是 400。
  if (Object.hasOwn(liveCaches, source)) {
    const { value, refreshing, partial } = await liveCaches[source].get();
    return c.json({ ...value, refreshing, partial });
  }
  if (Object.hasOwn(DB_BUILDERS, source)) return c.json(DB_BUILDERS[source]());
  return c.json({ error: `unknown source: ${source}` }, 400);
});
