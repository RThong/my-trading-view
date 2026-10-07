import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { getMarketSeries, getProvisionalDates, insertMarketSeries } from '../storage/repository';
import { fetchSupplyDensity, fetchUrpdDates } from '../fetchers/brkUrpd';

const SERIES_ID = 'BTC_SUPPLY_DENSITY';
/** 与 BTC 现货那格的起点对齐(2012-01 起)。 */
const START = '2012-01-01';
/**
 * 当天(UTC)的条目是盘中快照:抓取时刻早于「次日 0 点 + 这么多小时」的行都算盘中值,下次运行重拉。
 * 留 3 小时余量:区块时间戳可能比真实时间慢,次日凌晨刚出的块还可能算进前一天。
 * 不用「固定重拉最近 N 天」:job 连停 N 天以上,停机那天的盘中值会掉出窗口、永久留在库里。
 */
const PROVISIONAL_GRACE_HOURS = 3;
/** 源最新日期落后今天超过这么多天 = 停更。 */
const STALE_DAYS = 3;
const CONCURRENCY = 8;

export type SupplyDensityResult = {
  total: number;
  succeeded: number;
  failures: string[];
  latest: string | undefined;
  stale: boolean;
};

/**
 * BTC ±5% 已实现供应密度原始日值 → market_series 的 BTC_SUPPLY_DENSITY(7 日均线在读时派生)。
 * 增量:只拉库里没有的日期 + 盘中抓的(见 PROVISIONAL_GRACE_HOURS);首次运行即全量回填(~5400 天,8 路并发约 5 分钟)。
 * 每批写一次库 —— 长回填中途断了,已拉到的不白拉。幂等,重跑覆盖。
 * 直接运行:bun run src/server/jobs/supplyDensitySnapshot.ts
 */
export async function updateSupplyDensity(
  db: Database,
  deps: { fetchDates: () => Promise<string[]>; fetchValue: (date: string) => Promise<number> } = {
    fetchDates: fetchUrpdDates,
    fetchValue: fetchSupplyDensity,
  },
  now: Date = new Date(),
): Promise<SupplyDensityResult> {
  const stored = new Set(getMarketSeries(db, SERIES_ID).map((p) => p.date));
  const provisional = new Set(getProvisionalDates(db, SERIES_ID, PROVISIONAL_GRACE_HOURS));
  const dates = (await deps.fetchDates()).filter((d) => d >= START);
  const targets = dates.filter((d) => !stored.has(d) || provisional.has(d));

  const failures: string[] = [];
  let succeeded = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((d) => deps.fetchValue(d)));
    const rows = batch.flatMap((d, j) => {
      const r = settled[j];
      if (r.status === 'fulfilled') return [{ seriesId: SERIES_ID, obsDate: d, value: r.value }];
      failures.push(`${d}: ${(r.reason as Error)?.message ?? r.reason}`);
      return [];
    });
    insertMarketSeries(db, rows);
    succeeded += rows.length;
  }

  const latest = dates.at(-1);
  // 按 UTC 日历天数比:源最新 10-04、现在 10-07 任何时刻都算落后 3 天,不算停更。
  const stale = !latest || (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(latest)) / 86400_000 > STALE_DAYS;

  return { total: targets.length, succeeded, failures, latest, stale };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateSupplyDensity(db);
  db.close();
  console.log(
    `BTC supply density: ${r.succeeded}/${r.total} 天写入,源最新 ${r.latest}` +
      `${r.stale ? '(源疑似停更)' : ''}${r.failures.length ? `\n失败:${r.failures.slice(0, 10).join('; ')}` : ''}`,
  );
}
