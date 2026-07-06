import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchPensfordQuotes } from '../fetchers/pensford';

/**
 * 抓 Pensford 当天快照 → 把全部序列(OIS/FF 期货/Term SOFR/美债/SOFR 均值)按 symbol 存 market_series。
 * Pensford 无历史,每天存一份(obs_date=快照日),逐日攒;upsert 幂等,同日重跑不重复。
 * 直接运行 = 立即抓一次:bun run src/server/jobs/pensfordSnapshot.ts
 */
export async function updatePensfordSnapshot(
  db: Database,
  doFetch?: (url: string) => Promise<Response>,
): Promise<{ total: number }> {
  const snap = await fetchPensfordQuotes(doFetch);
  insertMarketSeries(db, snap.quotes.map((q) => ({ seriesId: q.symbol, obsDate: snap.quoteDate, value: q.value })));
  return { total: snap.quotes.length };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updatePensfordSnapshot(db);
  db.close();
  console.log(`Pensford snapshot stored: ${total} series.`);
}
