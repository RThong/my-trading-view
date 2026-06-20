import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { optionsRoute } from './routes/options';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/options', optionsRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
