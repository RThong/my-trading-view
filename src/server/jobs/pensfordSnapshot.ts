import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchPensfordQuotes } from '../fetchers/pensford';

/**
 * 抓 Pensford 当天快照 → 只存 Fed 路径所需的 FF 期货 + FEDFUNDS 锚(OIS 已改用 Eris,Term SOFR/美债/SOFRSWAP 冗余)。
 * Pensford 无历史,每天存一份(obs_date=快照日),逐日攒;upsert 幂等,同日重跑不重复。
 * 直接运行 = 立即抓一次:bun run src/server/jobs/pensfordSnapshot.ts
 */
export async function updatePensfordSnapshot(
  db: Database,
  doFetch?: (url: string) => Promise<Response>,
): Promise<{ total: number }> {
  const snap = await fetchPensfordQuotes(doFetch);
  // 只留 Fed 路径所需:FF 期货 strip + 隔夜 FEDFUNDS 锚(OIS 已改用 Eris,Term SOFR/美债冗余)。
  const keep = snap.quotes.filter((q) => q.symbol.startsWith('FF') || q.symbol === 'FEDFUNDS');
  insertMarketSeries(db, keep.map((q) => ({ seriesId: q.symbol, obsDate: snap.quoteDate, value: q.value })));
  return { total: keep.length };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updatePensfordSnapshot(db);
  db.close();
  console.log(`Pensford snapshot stored: ${total} series.`);
}
