import { Hono } from 'hono';
import { createYahooLookup, isYahooSymbol, type YahooHistory, type YahooSearchHit } from '../fetchers/yahooLookup';

/**
 * 图表编辑器的「任意 Yahoo 代码」:
 *  · GET /search?q=     → 代码搜索(股票 / ETF / 期货 / 指数 / 汇率 / 加密)
 *  · GET /history/:sym  → 该代码 1970 起的日线收盘
 * 读时现拉、不落库;内存里按 TTL 缓存,同一代码不反复打 Yahoo。失败不缓存,下次请求再试。
 */
const HISTORY_SINCE = '1970-01-01';
const SEARCH_TTL_MS = 60 * 60 * 1000;
// EOD 数据一天变一次;6 小时足够,也让收盘后的新一根能在当天进来
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function ttlCache<T>(ttlMs: number) {
  const store = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;

    // 并发请求共用同一个 promise;失败就从缓存里删掉,不把错误粘住
    const value = load().catch((e) => {
      store.delete(key);
      throw e;
    });
    if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!);
    store.set(key, { at: Date.now(), value });
    return value;
  };
}

const lookup = createYahooLookup();
const searchCache = ttlCache<YahooSearchHit[]>(SEARCH_TTL_MS);
const historyCache = ttlCache<YahooHistory>(HISTORY_TTL_MS);

export const yahooRoute = new Hono()
  .get('/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0 || q.length > 40) return c.json([]);

    try {
      return c.json(await searchCache(q.toLowerCase(), () => lookup.search(q)));
    } catch (e) {
      // Yahoo 对它不认的关键字(比如中文)直接报这句;对用户就是「没搜到」,不是故障
      if (/Invalid Search Query/i.test((e as Error).message)) return c.json([]);
      return c.json({ error: `search failed: ${(e as Error).message}` }, 502);
    }
  })
  .get('/history/:symbol', async (c) => {
    const symbol = c.req.param('symbol').toUpperCase();
    if (!isYahooSymbol(symbol)) return c.json({ error: `invalid symbol: ${symbol}` }, 400);

    try {
      return c.json(await historyCache(symbol, () => lookup.history(symbol, HISTORY_SINCE)));
    } catch (e) {
      // 代码不存在 / 没有日线时 yahoo-finance2 直接抛;对前端就是「这条取不到」
      return c.json({ error: `history failed: ${(e as Error).message}` }, 404);
    }
  });
