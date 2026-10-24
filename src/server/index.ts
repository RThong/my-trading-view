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
  // 只监听本机:Bun 默认绑 0.0.0.0,同一局域网的人能直连 API(个人看盘无需对外)
  hostname: '127.0.0.1',
  fetch: app.fetch,
  // Bun 默认 10s 无收发就断连接,处理函数在等上游也算空闲。/api/regime 冷拉要现拉十几个外部源
  // (2026-10-17 实测 15s;最慢一腿是 EIA,超时 40s,见 fetchers/eia),10s 时客户端被直接 reset。
  // 取最慢一腿超时的 3 倍留余量;Bun 上限 255。
  idleTimeout: 120,
};
