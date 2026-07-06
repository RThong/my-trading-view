import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchErisForDate, type ErisCurve } from '../fetchers/eris';

// 遍历 sinceDate..today 的每个日历日,逐日抓 Eris EOD 曲线;非交易日(两处都 404)返回 null,跳过。
// 幂等 upsert(可重复跑续填)。today 由参数注入以便测试;CLI 用真实今天。
// 单日出错(如早年该文件装的是 LIBOR 互换、解析不出 SOFR 行;或瞬时网络)不该中断整段回填 ——
// 长跨度扫描必然遇到边角,catch 后计入 skipped 继续。回填是 best-effort 且可重跑,漏的下次补。
export async function backfillEris(
  db: Database,
  sinceDate: string,
  fetchForDate: (d: string) => Promise<ErisCurve | null> = fetchErisForDate,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ days: number; total: number; skipped: number }> {
  let days = 0, total = 0, skipped = 0;
  for (let d = new Date(sinceDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    let curve: ErisCurve | null;
    try {
      curve = await fetchForDate(iso);
    } catch {
      skipped += 1;
      continue;
    }
    if (!curve) continue;
    insertMarketSeries(db, curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })));
    days += 1;
    total += curve.points.length;
  }
  return { days, total, skipped };
}

if (import.meta.main) {
  // 默认回填近 3 年;传参可更早,如 bun run src/server/jobs/erisBackfill.ts 2019-01-01
  const arg = process.argv[2];
  const since = arg ?? (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 3); return d.toISOString().slice(0, 10); })();
  const db = openDb();
  migrate(db);
  const { days, total, skipped } = await backfillEris(db, since);
  db.close();
  console.log(`Eris backfill from ${since}: ${days} trading days, ${total} rows, ${skipped} skipped(错误/早年 LIBOR 格式).`);
}
