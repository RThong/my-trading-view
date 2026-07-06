import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchErisForDate, type ErisCurve } from '../fetchers/eris';

// 遍历 sinceDate..today 的每个日历日,逐日抓 Eris EOD 曲线;非交易日(两处都 404)返回 null,跳过。
// 幂等 upsert(可重复跑续填)。today 由参数注入以便测试;CLI 用真实今天。
export async function backfillEris(
  db: Database,
  sinceDate: string,
  fetchForDate: (d: string) => Promise<ErisCurve | null> = fetchErisForDate,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ days: number; total: number }> {
  let days = 0, total = 0;
  for (let d = new Date(sinceDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const curve = await fetchForDate(iso);
    if (!curve) continue;
    insertMarketSeries(db, curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })));
    days += 1;
    total += curve.points.length;
  }
  return { days, total };
}

if (import.meta.main) {
  // 默认回填近 3 年;传参可更早,如 bun run src/server/jobs/erisBackfill.ts 2019-01-01
  const arg = process.argv[2];
  const since = arg ?? (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 3); return d.toISOString().slice(0, 10); })();
  const db = openDb();
  migrate(db);
  const { days, total } = await backfillEris(db, since);
  db.close();
  console.log(`Eris backfill from ${since}: ${days} trading days, ${total} rows.`);
}
