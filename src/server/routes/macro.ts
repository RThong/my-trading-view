import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMacroSeries } from '../storage/repository';

export const macroRoute = new Hono()
  .get('/:seriesId', (c) => {
    const seriesId = c.req.param('seriesId');
    const daysStr = c.req.query('days') ?? '180';
    const days = Math.min(Math.max(Number(daysStr) || 180, 1), 1825);
    const db = openDb();
    try {
      const points = getMacroSeries(db, seriesId, days);
      return c.json(points);
    } finally {
      db.close();
    }
  });
