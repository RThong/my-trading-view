import { Hono } from 'hono';
import { createFredFetcher } from '../fetchers/fred';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchFearGreed } from '../fetchers/cnnFearGreed';
import { subtractAligned, type Point } from '../analytics/regime';
import { computeSpread } from '../analytics/termStructure';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';

type RegimeBody = { series: Record<string, Point[]>; unavailable: string[] };

// 内存 TTL 缓存:现拉全部外部源约 1.3s,重复打开走缓存瞬时返回。
// 只缓存全成功的响应(降级响应不缓存,下次刷新重试),避免瞬时反爬失败被粘住。
// EOD 日频数据盘中不变,TTL 取 6h 安全。进程级单例,dev/prod 长驻进程共享。
const TTL_MS = 6 * 60 * 60 * 1000;
let cache: { at: number; body: RegimeBody } | null = null;

/**
 * 宏观 / regime 指标:现拉外部源(零存储,见 spec),并行 + 优雅降级 + 内存 TTL 缓存。
 * 单源失败(FRED key 缺 / CBOE 符号 404 / CNN 反爬)→ 归入 unavailable,其余照常返回,不整体 500。
 * 净流动性 / 回购利差为读时派生(前向填充对齐后线性组合)。
 */
export const regimeRoute = new Hono().get('/', async (c) => {
  if (cache && Date.now() - cache.at < TTL_MS) return c.json(cache.body);

  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const fredSeries = (id: string): Promise<Point[]> =>
    fred.fetchSeries(id, HISTORY_START_DATE).then((rows) => rows.map((r) => ({ date: r.obsDate, value: r.value })));
  const cboeSeries = (sym: string): Promise<Point[]> =>
    fetchCboeIndexAsQuotes({ cboeSymbol: sym, storedSymbol: sym }).then((rows) => rows.map((r) => ({ date: r.tradeDate, value: r.close })));

  // 并行拉全部原始源。key 为内部名,后面映射到对外序列名。
  const src = {
    walcl: fredSeries('WALCL'), wtregen: fredSeries('WTREGEN'), rrp: fredSeries('RRPONTSYD'),
    rpo: fredSeries('RPONTSYD'), sofr: fredSeries('SOFR'), iorb: fredSeries('IORB'),
    hyOas: fredSeries('BAMLH0A0HYM2'),
    cor1m: cboeSeries('COR1M'), vixeq: cboeSeries('VIXEQ'),
    fng: fetchFearGreed(),
  };
  const names = Object.keys(src) as (keyof typeof src)[];
  const settled = await Promise.allSettled(Object.values(src));
  const raw: Partial<Record<keyof typeof src, Point[]>> = {};
  settled.forEach((s, i) => { if (s.status === 'fulfilled') raw[names[i]] = s.value; });

  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];

  // 有值 → 落对外序列;否则记入 unavailable。收敛 5 处「存在性分支」,读时一目了然。
  // (传 undefined 表示该序列缺失/为空;直接源用存在性、派生/库源用长度决定是否传值。)
  const put = (name: string, value: Point[] | undefined) => {
    if (value) series[name] = value;
    else unavailable.push(name);
  };

  // 直接对外的序列(对外名 → 原始源名)。
  const direct: Record<string, keyof typeof src> = {
    hyOas: 'hyOas', cor1m: 'cor1m', vixeq: 'vixeq', fng: 'fng',
    reverseRepo: 'rrp', repoUsage: 'rpo',
  };
  for (const [out, s] of Object.entries(direct)) put(out, raw[s]);

  // 派生:分量齐才算,缺则整条进 unavailable。
  put('netLiquidity', raw.walcl && raw.wtregen && raw.rrp ? subtractAligned([raw.walcl, raw.wtregen, raw.rrp]) : undefined);
  put('repoStress', raw.iorb && raw.sofr ? subtractAligned([raw.iorb, raw.sofr]) : undefined);

  // VIX / VXN 已在库里(market_series,daily job 维护)→ 直接读,不外拉。
  const db = openDb();
  try {
    for (const [out, sym] of [['vix', 'VIX'], ['vxn', 'VXN']] as const) {
      const rows = getMarketSeries(db, sym);
      put(out, rows.length ? rows : undefined);
    }
    // VX1−V3 期限结构价差(读 VX1/VX3 现算),给情绪视角画符号柱状图。
    const spread = computeSpread(getMarketSeries(db, 'VX1'), getMarketSeries(db, 'VX3'));
    put('vxTermSpread', spread.length ? spread.map((r) => ({ date: r.date, value: r.spread })) : undefined);
  } finally {
    db.close();
  }

  const body: RegimeBody = { series, unavailable };
  if (unavailable.length === 0) cache = { at: Date.now(), body }; // 只缓存全成功
  return c.json(body);
});
