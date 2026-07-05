import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { optionsRoute } from './routes/options';
import { vrpRoute } from './routes/vrp';
import { priceRoute } from './routes/price';
import { regimeRoute } from './routes/regime';
import { yieldCurveRoute } from './routes/yieldCurve';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/options', optionsRoute)
  .route('/vrp', vrpRoute)
  .route('/price', priceRoute)
  .route('/regime', regimeRoute)
  .route('/yield-curve', yieldCurveRoute);

export default {
  port: 3000,
  fetch: app.fetch,
};
