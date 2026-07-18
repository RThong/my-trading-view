import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getJobHealth } from '../storage/repository';
import type { HealthResponse } from '../../shared/types';

export const healthRoute = new Hono().get('/', (c) => {
  const db = openDb();
  try {
    const jobs = getJobHealth(db);
    return c.json<HealthResponse>({ jobs });
  } finally {
    db.close();
  }
});
