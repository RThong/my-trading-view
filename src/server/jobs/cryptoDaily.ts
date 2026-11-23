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
import { archiveRuns, syncArchive } from '../fetchers/snapshotArchive';

/**
 * 这天存档由不由 crypto 自己同步:daily 只在 JST 周二~周六跑(scripts/gen-cron.sh 的 EQUITY_WEEKDAYS),那几天由它同步 ——
 * 两个 job 同一时刻触发,两个进程同时在存档目录里 fetch / reset / gc --prune=now 会弄坏仓库。
 * 周日、周一 daily 不跑,没人同步,美东周六、周日收盘后那两份 BTC 存档要拖到周二才进库 → 这两天 crypto 自己同步。
 * ponytail: 星期写死,和 EQUITY_WEEKDAYS 手动保持一致;改了 daily 的星期这里要跟着改
 */
export function cryptoOwnsArchiveSync(now: Date): boolean {
  const jstDay = new Date(now.getTime() + 9 * 3600_000).getUTCDay();
  return jstDay === 0 || jstDay === 1;
}

const CRYPTO_GROUPS: GroupTable = {
  options_crypto: () => {
    if (cryptoOwnsArchiveSync(new Date())) {
      const err = syncArchive();
      if (err) console.warn(err);
    }
    return {
      cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
      cryptoOptionsClient: defaultDeribitOptionsClient(),
      // 周二~周六只读、不同步(见 cryptoOwnsArchiveSync);读到上一轮的旧存档也无妨,每轮会把 14 天存档整段重放
      archiveRuns: () => archiveRuns(),
    };
  },
  computable_gpu: () => ({ computableGpuUpdater: updateComputableGpu }),
};

if (import.meta.main) {
  const db = openDb();
  migrate(db);

  if ((await runPendingGroups(db, CRYPTO_GROUPS)).length) console.log('Crypto job complete.');
  db.close();
}
