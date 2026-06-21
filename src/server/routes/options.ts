import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getOptions25Delta } from '../storage/repository';
import { ALL_OPTION_UNDERLYINGS } from '../config';
import type { OptionIVPoint } from '../../shared/types';

export const optionsRoute = new Hono()
  .get('/25delta/:underlying', (c) => {
    const u = c.req.param('underlying').toUpperCase();
    if (!ALL_OPTION_UNDERLYINGS.includes(u)) {
      return c.json({ error: `unknown underlying: ${u}` }, 400);
    }
    const daysStr = c.req.query('days') ?? '1825';
    const days = Math.min(Math.max(Number(daysStr) || 1825, 1), 3650);
    const db = openDb();
    try {
      const rows = getOptions25Delta(db, u, days);
      const out: OptionIVPoint[] = rows.map(r => ({
        date: r.snapshotDate,
        callIv: r.callIv,
        putIv: r.putIv,
        skew: r.skew,
      }));
      return c.json(out);
    } finally {
      db.close();
    }
  });
