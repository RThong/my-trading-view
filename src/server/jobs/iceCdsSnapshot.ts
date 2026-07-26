import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { missingCoreCds } from '../analytics/rateCurves';
import { fetchIceCds, type CdsSnapshot } from '../fetchers/iceCds';

/**
 * 抓 ICE 单名 CDS 当日 EOD 结算价 → market_series 的 ICE_CDS_{ticker}。
 * 存原始价(真值源);spread(bp)换算在读时做(见 yieldCurve 路由 cdsPriceToSpreadBp)。
 * 端点仅当日单快照、无历史 → 靠每天跑一次积累时间序列。幂等,同日重跑覆盖。
 * missing = 缺失的 core 标的(默认展示的 7 家),供 daily 决定 success/failed。
 * 直接运行:bun run src/server/jobs/iceCdsSnapshot.ts
 */
export async function updateIceCds(
  db: Database,
  fetchSnap: () => Promise<CdsSnapshot> = fetchIceCds,
): Promise<{ total: number; missing: string[] }> {
  const snap = await fetchSnap();
  insertMarketSeries(
    db,
    snap.points.map((p) => ({ seriesId: `ICE_CDS_${p.ticker}`, obsDate: snap.date, value: p.price })),
  );
  return { total: snap.points.length, missing: missingCoreCds(new Set(snap.points.map((p) => p.ticker))) };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updateIceCds(db);
  db.close();
  console.log(`ICE CDS snapshot stored: ${total} names.`);
}
