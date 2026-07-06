import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchLatestEris, type ErisCurve } from '../fetchers/eris';

/**
 * 抓 Eris 最新 EOD SOFR par 曲线(24 档含短端)→ market_series 的 ERIS_OIS_{tenor}。
 * FairCoupon 已是百分点,原样存;obs_date = 曲线的 EvaluationDate。幂等,同日重跑覆盖。
 * 直接运行:bun run src/server/jobs/erisSnapshot.ts
 */
export async function updateErisSnapshot(
  db: Database,
  fetchCurve: () => Promise<ErisCurve> = fetchLatestEris,
): Promise<{ total: number }> {
  const curve = await fetchCurve();
  insertMarketSeries(
    db,
    curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })),
  );
  return { total: curve.points.length };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updateErisSnapshot(db);
  db.close();
  console.log(`Eris OIS snapshot stored: ${total} tenors.`);
}
