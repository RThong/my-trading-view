import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { quotesRoute } from './routes/quotes';
import { macroRoute } from './routes/macro';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/quotes', quotesRoute)
  .route('/macro', macroRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
