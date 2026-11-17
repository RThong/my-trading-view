import { Hono } from 'hono';
import { spotBars } from '../live/market';
import { ALL_OPTION_UNDERLYINGS, PRICE_ONLY_UNDERLYINGS } from '../config';

/**
 * 标的现货日 OHLC(给前端现货蜡烛图)。tab 用 underlying 键(.VIX 等),源用裸符号(VIX),故去掉前导点映射。
 * 读时现拉(见 live/market):ETF 走 Yahoo、VIX 走 CBOE、BTC 走 Bitstamp。
 */
export const priceRoute = new Hono().get('/:underlying', async (c) => {
  const u = c.req.param('underlying').toUpperCase();
  if (![...ALL_OPTION_UNDERLYINGS, ...PRICE_ONLY_UNDERLYINGS].includes(u)) {
    return c.json({ error: `unknown underlying: ${u}` }, 400);
  }

  try {
    return c.json((await spotBars(u.replace(/^\./, ''))).value);
  } catch (e) {
    return c.json({ error: `现货取数失败: ${(e as Error).message}` }, 502);
  }
});
