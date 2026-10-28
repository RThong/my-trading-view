/**
 * 独立的加密(BTC/Deribit)期权抓取入口,与美股 daily job 解耦。
 * - 跑 options_crypto + BTC 现货 + GPU 算力价 + BTC 供应密度(复用 runDailyJob 的注入式参数)。
 * - 按当前 UTC 日打戳(Deribit client.getTradingDate),BTC 24/7、含周末。
 * - 「当天成功即止」守卫按组判(见 runPendingGroups),与股票组互不影响。
 * - Deribit 公开 REST、无 OpenD 依赖,由 com.mtv.crypto 每天 JST 11/12/20/21/22 触发
 *   (与股票 job 共用 scripts/gen-cron.sh 的 HOURS)。
 *   直接运行 = 立即抓一次(今天已成功的组跳过):bun run src/server/jobs/cryptoDaily.ts
 */
import { openDb, migrate } from '../storage/db';
import { runPendingGroups, type GroupTable } from './daily';
import { DERIBIT_UNDERLYINGS } from '../config';
import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';
import { updateBtcPrice } from './btcPrice';
import { updateComputableGpu } from './computableGpuSnapshot';
import { updateSupplyDensity } from './supplyDensitySnapshot';

const CRYPTO_GROUPS: GroupTable = {
  options_crypto: () => ({
    cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
    cryptoOptionsClient: defaultDeribitOptionsClient(),
  }),
  btc_price: () => ({ btcPriceUpdater: updateBtcPrice }),
  computable_gpu: () => ({ computableGpuUpdater: updateComputableGpu }),
  btc_supply_density: () => ({ supplyDensityUpdater: updateSupplyDensity }),
};

if (import.meta.main) {
  const db = openDb();
  migrate(db);

  if ((await runPendingGroups(db, CRYPTO_GROUPS)).length) console.log('Crypto job complete.');
  db.close();
}
