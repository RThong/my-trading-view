/**
 * 独立的加密(BTC/Deribit)期权抓取入口,与美股 daily job 解耦。
 * - 只跑 options_crypto 组(复用 runDailyJob 的注入式 crypto 参数)。
 * - 按当前 UTC 日打戳(Deribit client.getTradingDate),BTC 24/7、含周末。
 * - 「当天成功即止」守卫只看 options_crypto,与股票组互不影响。
 * - Deribit 公开 REST、无 OpenD 依赖,由 com.mtv.crypto 每天 08/11/14/17/20 触发。
 *   直接运行 = 立即抓一次:bun run src/server/jobs/cryptoDaily.ts
 */
import { openDb, migrate } from '../storage/db';
import { getTodaySucceededJobs } from '../storage/repository';
import { runDailyJob } from './daily';
import { DERIBIT_UNDERLYINGS } from '../config';
import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';
import { updateBtcPrice } from './btcPrice';

if (import.meta.main) {
  const db = openDb();
  migrate(db);

  const REQUIRED = ['options_crypto', 'btc_price'];
  if (REQUIRED.every((j) => getTodaySucceededJobs(db).includes(j))) {
    console.log('今天 加密期权 + BTC 现货 均已成功,跳过本次运行。');
  } else {
    await runDailyJob({
      db,
      cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
      cryptoOptionsClient: defaultDeribitOptionsClient(),
      btcPriceUpdater: updateBtcPrice,
    });
    console.log('Crypto job complete.');
  }
  db.close();
}
