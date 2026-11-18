/**
 * 独立的加密(BTC/Deribit)期权抓取入口,与美股 daily job 解耦。
 * - 跑 options_crypto + GPU 算力价(复用 runDailyJob 的注入式参数)。BTC 现货与链上 2026-11-17 起改读时现拉,不再落库。
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
import { updateComputableGpu } from './computableGpuSnapshot';
import { archiveRuns } from '../fetchers/snapshotArchive';

const CRYPTO_GROUPS: GroupTable = {
  options_crypto: () => ({
    cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
    cryptoOptionsClient: defaultDeribitOptionsClient(),
    // 只读不同步:launchd 和 daily 同一时刻触发,两个进程同时在存档目录里 fetch / reset / gc --prune=now 会弄坏仓库。
    // 同步交给 daily;这里读到的若是上一轮的旧存档也无妨,14 天窗口里下次会补上
    archiveRuns: () => archiveRuns(),
  }),
  computable_gpu: () => ({ computableGpuUpdater: updateComputableGpu }),
};

if (import.meta.main) {
  const db = openDb();
  migrate(db);

  if ((await runPendingGroups(db, CRYPTO_GROUPS)).length) console.log('Crypto job complete.');
  db.close();
}
