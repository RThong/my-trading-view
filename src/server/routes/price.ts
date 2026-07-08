import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getPriceBars } from '../storage/repository';
import { ALL_OPTION_UNDERLYINGS, PRICE_ONLY_UNDERLYINGS } from '../config';

// 标的现货日 OHLC(给前端现货蜡烛图)。tab 用 underlying 键(.VIX 等),
// price_eod 存的是裸符号(VIX),故去掉前导点映射。
export const priceRoute = new Hono()
  .get('/:underlying', (c) => {
    const u = c.req.param('underlying').toUpperCase();
    if (![...ALL_OPTION_UNDERLYINGS, ...PRICE_ONLY_UNDERLYINGS].includes(u)) {
      return c.json({ error: `unknown underlying: ${u}` }, 400);
    }
    const db = openDb();
    try {
      return c.json(getPriceBars(db, u.replace(/^\./, '')));
    } finally {
      db.close();
    }
  });
