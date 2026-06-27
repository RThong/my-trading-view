import { Hono } from 'hono';
import { fetchSimPositions } from '../fetchers/moomooPositions';
import type { PositionsResponse } from '../../shared/types';

// moomoo 模拟账户当前持仓(只读、实时读一次)。OpenD 未起/登录失败 → 503,不让 app 崩。
export const positionsRoute = new Hono()
  .get('/', async (c) => {
    try {
      const { accId, positions } = await fetchSimPositions();
      return c.json<PositionsResponse>({ accId, asOf: new Date().toISOString(), positions });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });
