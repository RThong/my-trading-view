import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import {
  fetchBtcValuation,
  fetchSupplyDensitySeries,
  type BtcValuation,
  type DensityPoint,
} from '../fetchers/brkSupplyDensity';

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

/**
 * 2012 起那段必须从 2012-01-01 开始、逐日连续:解析层会跳过 null,源回 200 + 空数组 / 截短 / 中间出 null 时
 * 只能在这里发现。不满足就抛,让这组记 failed —— 别把断档的线当完整的写进库。
 */
function checkedFrom2012(id: string, points: DensityPoint[]): DensityPoint[] {
  const kept = points.filter((p) => p.date >= START);
  const gap = kept.find(
    (p, i) => Date.parse(p.date) - Date.parse(i ? kept[i - 1].date : START) !== (i ? 86400_000 : 0),
  );
  if (!kept.length || gap) throw new Error(`BRK ${id}:2012 起不完整(${gap?.date ?? '0 个点'})`);

  return kept;
}

/**
 * BTC 链上估值 MVRV / AVIV → market_series 的 BTC_MVRV / BTC_AVIV,同样全量覆盖写、2012 起。返回写入点数。
 */
export async function updateBtcValuation(
  db: Database,
  fetchValuation: () => Promise<BtcValuation> = fetchBtcValuation,
): Promise<number> {
  const { mvrv, aviv } = await fetchValuation();
  const rows = [
    ...checkedFrom2012('BTC_MVRV', mvrv).map((p) => ({ seriesId: 'BTC_MVRV', obsDate: p.date, value: p.value })),
    ...checkedFrom2012('BTC_AVIV', aviv).map((p) => ({ seriesId: 'BTC_AVIV', obsDate: p.date, value: p.value })),
  ];
  insertMarketSeries(db, rows);

  return rows.length;
}

/**
 * btc_supply_density 分组实际跑的:供应密度 + 估值两件,同一个源(BRK)。组名沿用旧的,job 历史不断。
 * 两件互不拖累:估值序列被改名(404)时密度照写,写完再把估值的错抛出来让这组记 failed。
 */
export async function updateBtcOnchain(
  db: Database,
  fetchDensity: () => Promise<DensityPoint[]> = fetchSupplyDensitySeries,
  fetchValuation: () => Promise<BtcValuation> = fetchBtcValuation,
): Promise<SupplyDensityResult> {
  const [density, valuation] = await Promise.allSettled([
    updateSupplyDensity(db, fetchDensity),
    updateBtcValuation(db, fetchValuation),
  ]);
  if (density.status === 'rejected') throw density.reason;
  if (valuation.status === 'rejected') throw valuation.reason;

  return density.value;
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateBtcOnchain(db);
  db.close();
  console.log(`BTC supply density: ${r.written} 天写入,源最新 ${r.latest}${r.stale ? '(源疑似停更)' : ''}`);
}
