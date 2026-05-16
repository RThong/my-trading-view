import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getQuotes } from '../storage/repository';

export const quotesRoute = new Hono()
  .get('/:symbol', (c) => {
    const symbol = c.req.param('symbol');
    const daysStr = c.req.query('days') ?? '180';
    const days = Math.min(Math.max(Number(daysStr) || 180, 1), 18250);
    const db = openDb();
    try {
      const bars = getQuotes(db, symbol, days);
      return c.json(bars);
    } finally {
      db.close();
    }
  });
