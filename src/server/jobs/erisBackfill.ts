import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchErisHistory, type ErisCurve } from '../fetchers/eris';

// 一次下载全历史宽表文件(~5.7 年),按 ERIS_OIS_{tenor} 全量 upsert(幂等,可重跑续填)。
// 比逐日抓省 ~1500 次请求。
export async function backfillEris(
  db: Database,
  fetchHistory: () => Promise<ErisCurve[]> = fetchErisHistory,
): Promise<{ days: number; total: number }> {
  const curves = await fetchHistory();
  let total = 0;
  for (const curve of curves) {
    insertMarketSeries(
      db,
      curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })),
    );
    total += curve.points.length;
  }
  return { days: curves.length, total };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { days, total } = await backfillEris(db);
  db.close();
  console.log(`Eris backfill(全历史单文件): ${days} trading days, ${total} rows.`);
}
