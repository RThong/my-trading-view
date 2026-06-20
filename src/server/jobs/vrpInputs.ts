/**
 * 更新 VRP 输入序列到 market_series:
 *   VIX  (CBOE)      — SPY VRP 的隐含腿
 *   SPX  (^GSPC)     — SPY VRP 的 RV 腿(SPY≈SPX)
 *   BTC  (BTC-USD)   — BTC VRP 的 RV 腿
 *   DVOL (Deribit)   — BTC VRP 的隐含腿
 *
 * `updateVrpInputs` 增量更新(按各序列已存最新日期续抓),既用于 daily job,
 * 也用于首次全量回填(库空时自动从 HISTORY_START_DATE / DVOL 上线日拉起)。
 * upsert 幂等,可重复跑。
 *
 * 直接运行 = 立即更新一次:bun run src/server/jobs/vrpInputs.ts
 */
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getLatestMarketDate } from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchDvolHistory } from '../fetchers/deribitDvol';
import { HISTORY_START_DATE } from '../config';

const DVOL_START = '2021-01-01'; // DVOL(BTC)上线约 2021 年

export type VrpInputsResult = {
  total: number;
  succeeded: number;
  /** 失败的源,形如 'DVOL: <原因>';由上层 job 据此记 success/partial/failed。 */
  failures: string[];
};

export async function updateVrpInputs(db: Database): Promise<VrpInputsResult> {
  let total = 0;
  let succeeded = 0;
  const failures: string[] = [];

  const add = (id: string, rows: Array<{ obsDate: string; value: number }>) => {
    insertMarketSeries(db, rows.map((r) => ({ seriesId: id, obsDate: r.obsDate, value: r.value })));
    total += rows.length;
  };

  // 每个源独立容错:一个源失败(抓取/解析出错)只记下来,不中断其它源。
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      succeeded++;
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  };

  // VIX(CBOE 指数 CSV)
  await run('VIX', async () => {
    const vix = await fetchCboeIndexAsQuotes({ cboeSymbol: 'VIX', storedSymbol: 'VIX', afterDate: getLatestMarketDate(db, 'VIX') ?? undefined });
    add('VIX', vix.map((r) => ({ obsDate: r.tradeDate, value: r.close })));
  });

  // SPX(^GSPC)、BTC(BTC-USD):Yahoo EOD,取 close
  const yahoo = createYahooFetcher();
  for (const [id, sym] of [['SPX', '^GSPC'], ['BTC', 'BTC-USD']] as const) {
    await run(id, async () => {
      const latest = getLatestMarketDate(db, id);
      const since = latest ? new Date(latest + 'T00:00:00Z') : new Date(HISTORY_START_DATE);
      const bars = await yahoo.fetchDailyBars(sym, since);
      add(id, bars.map((r) => ({ obsDate: r.tradeDate, value: r.close })));
    });
  }

  // DVOL(Deribit 波动率指数)
  await run('DVOL', async () => {
    const dvolLatest = getLatestMarketDate(db, 'DVOL');
    const dvolStart = dvolLatest ? new Date(dvolLatest + 'T00:00:00Z').getTime() : new Date(DVOL_START).getTime();
    const dvol = await fetchDvolHistory('BTC', dvolStart, Date.now());
    add('DVOL', dvol.map((d) => ({ obsDate: d.date, value: d.value })));
  });

  return { total, succeeded, failures };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total, failures } = await updateVrpInputs(db);
  db.close();
  console.log(`VRP inputs updated: ${total} rows upserted.${failures.length ? ` 失败源: ${failures.join('; ')}` : ''}`);
}
