import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getPriceBars } from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import { ALL_OPTION_UNDERLYINGS, PRICE_ONLY_UNDERLYINGS, HISTORY_START_DATE } from '../config';
import { isLivePrice } from '../../shared/marketCatalog';

type Bar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

/**
 * 现拉那几个标的的内存缓存。
 *
 * 必须有:这条路由**每开一次面板就调一次**,而 Yahoo 有反爬 —— 没缓存等于每次切 tab 都去敲它。
 * (落库的那几个不需要,读库本来就是瞬时的。)
 * TTL 取 6h 与 regime 路由一致:日线 EOD 数据盘中不变。
 */
const TTL_MS = 6 * 60 * 60 * 1000;
const liveCache = new Map<string, { at: number; bars: Bar[] }>();

async function liveBars(symbol: string): Promise<Bar[]> {
  const hit = liveCache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bars;

  const rows = await createYahooFetcher().fetchDailyBars(symbol, new Date(HISTORY_START_DATE));
  const bars = rows.map((r) => ({
    date: r.tradeDate,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));

  // 空结果不进缓存:Yahoo 反爬/断供时会回空,缓存住就等于把「今天没数据」粘住 6 小时。
  if (bars.length) liveCache.set(symbol, { at: Date.now(), bars });
  return bars;
}

/**
 * 标的现货日 OHLC(给前端现货蜡烛图)。tab 用 underlying 键(.VIX 等),
 * price_eod 存的是裸符号(VIX),故去掉前导点映射。
 *
 * 两条取数路径,由标的目录决定(见 marketCatalog 的 `price`),**不由这里判断**:
 *  · 默认 —— 读 price_eod(daily job 维护)。期权标的的现货腿、VRP 的 RV 腿都要它。
 *  · `price: 'live'` —— 读时现拉 Yahoo,零存储。股票日线随时能整段重取,
 *    存一份只是白占一个会腐坏的副本(同 DATA_SOURCES.md 的既定原则)。
 * 落库那条**不带 volume 字段**(price_eod 没这一列)。前端的 PriceBar.volume 是可选的,
 * 缺字段与「有字段但为 null」在下游同样被当作「没有量」处理(见 spotVolume 的守卫),
 * 所以不必为了形状对齐去补一个 null —— 那是每请求两千多次白造对象。
 */
export const priceRoute = new Hono().get('/:underlying', async (c) => {
  const u = c.req.param('underlying').toUpperCase();
  if (![...ALL_OPTION_UNDERLYINGS, ...PRICE_ONLY_UNDERLYINGS].includes(u)) {
    return c.json({ error: `unknown underlying: ${u}` }, 400);
  }

  if (isLivePrice(u)) {
    try {
      return c.json(await liveBars(u));
    } catch (e) {
      // 单个标的的源挂了**不返 5xx**:这一格是参照腿,它没了不该让整条路由算失败。
      // 但**必须留痕** —— 空结果和「真的没数据」在响应里长得一样,不打日志就没人知道 Yahoo 挂过。
      // (同 vrpInputs 降级时的做法。)
      console.warn(`[price] ${u} 现拉失败,本次返回空: ${(e as Error).message}`);
      return c.json([]);
    }
  }

  const db = openDb();
  try {
    return c.json(getPriceBars(db, u.replace(/^\./, '')));
  } finally {
    db.close();
  }
});
