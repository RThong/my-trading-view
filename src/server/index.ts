import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { optionsRoute } from './routes/options';
import { vrpRoute } from './routes/vrp';
import { priceRoute } from './routes/price';
import { termStructureRoute } from './routes/termStructure';
import { positionsRoute } from './routes/positions';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/options', optionsRoute)
  .route('/vrp', vrpRoute)
  .route('/price', priceRoute)
  .route('/term-structure', termStructureRoute)
  .route('/positions', positionsRoute);

export default {
  port: 3000,
  fetch: app.fetch,
};
