import { Hono } from 'hono';
import { healthRoute } from './routes/health';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
