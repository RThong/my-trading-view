import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchSupplyDensitySeries, type DensityPoint } from '../fetchers/brkSupplyDensity';

const SERIES_ID = 'BTC_SUPPLY_DENSITY';
/** 与 BTC 现货那格的起点对齐(2012-01 起)。 */
const START = '2012-01-01';
/** 源最新日期落后今天超过这么多天 = 停更。 */
const STALE_DAYS = 3;

export type SupplyDensityResult = { written: number; latest: string | undefined; stale: boolean };

/**
 * BTC ±5% 已实现供应密度原始日值 → market_series 的 BTC_SUPPLY_DENSITY(7 日均线在读时派生)。
 * 每轮全量覆盖写(一次请求 ~6500 个数):当天的盘中值次日自动被收盘值盖掉,源事后修订也跟着更新。
 * 直接运行:bun run src/server/jobs/supplyDensitySnapshot.ts
 */
export async function updateSupplyDensity(
  db: Database,
  fetchSeries: () => Promise<DensityPoint[]> = fetchSupplyDensitySeries,
  now: Date = new Date(),
): Promise<SupplyDensityResult> {
  const points = (await fetchSeries()).filter((p) => p.date >= START);
  insertMarketSeries(
    db,
    points.map((p) => ({ seriesId: SERIES_ID, obsDate: p.date, value: p.value })),
  );

  const latest = points.at(-1)?.date;
  // 按 UTC 日历天数比:源最新 10-04、现在 10-07 任何时刻都算落后 3 天,不算停更。
  const stale = !latest || (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(latest)) / 86400_000 > STALE_DAYS;

  return { written: points.length, latest, stale };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateSupplyDensity(db);
  db.close();
  console.log(`BTC supply density: ${r.written} 天写入,源最新 ${r.latest}${r.stale ? '(源疑似停更)' : ''}`);
}
