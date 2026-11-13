import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries, deleteMarketSeriesDates } from '../storage/repository';
import { percentile } from '../../shared/calc/stats';
import { fetchSbgCdsDay, type SbgCdsTrade } from '../fetchers/dtccSbgCds';

/**
 * 软银 5Y CDS(DTCC 成交披露)→ market_series 的 DTCC_CDS_SBG,值 = 当天各笔成交「价」的中位数
 * (平价 100,与 ICE_CDS_* 同口径;bp 换算在读时做,见 yieldCurve 路由)。没成交的日子不写,图上留空。
 *
 * 源只保留约 2 年多、头部每天在丢 → 必须每天落库。日常每轮重拉最近 WINDOW_DAYS 天的文件、整段覆盖:
 * 晚报的成交会出现在后几天的文件里,重拉能把那天的中位数补全。
 * 首次接入跑一次回填:bun run src/server/jobs/sbgCdsSnapshot.ts --backfill(约 800 个文件、每个 ~120KB,4 并发几分钟)。
 */
export const SBG_CDS_SERIES = 'DTCC_CDS_SBG';
const WINDOW_DAYS = 14;
// 源最早可下的大约日期(2026-11 实测 2024-09-10 能下、2024-06-11 已 403);更早的天回 null,不算失败
const BACKFILL_FROM = '2024-06-01';

export type SbgCdsResult = { written: number; trades: number; failed: string[]; latest: string | null };

const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

function calendarDays(from: string, to: string): string[] {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

export async function updateSbgCds(
  db: Database,
  opts: { backfill?: boolean; fetchDay?: typeof fetchSbgCdsDay; today?: string } = {},
): Promise<SbgCdsResult> {
  const fetchDay = opts.fetchDay ?? fetchSbgCdsDay;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const floor = opts.backfill ? BACKFILL_FROM : addDays(today, -(WINDOW_DAYS - 1));
  const days = calendarDays(floor, today);
  const concurrency = opts.backfill ? 4 : 2;
  const batches = Array.from({ length: Math.ceil(days.length / concurrency) }, (_, i) =>
    days.slice(i * concurrency, (i + 1) * concurrency),
  );

  const failed: string[] = [];
  const failedDays = new Set<string>();
  const fetchedDays: string[] = [];
  const trades: SbgCdsTrade[] = [];
  const cancelled = new Set<string>();
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((d) => fetchDay(d)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(`${batch[i]}: ${(r.reason as Error).message}`);
        failedDays.add(batch[i]);
      } else if (r.value) {
        fetchedDays.push(batch[i]);
        trades.push(...r.value.trades);
        r.value.cancelled.forEach((id) => {
          cancelled.add(id);
        });
      }
    });
  }

  // 剔掉三类:事后被撤销的成交;文件拉失败那天的成交(那天的单大多在它自己的文件里,只剩后几天补报的几笔,
  // 中位数不完整,别盖掉库里的);日常模式下窗口外的成交日(同理,只拉到了一部分文件)
  const live = trades.filter(
    (t) => !cancelled.has(t.id) && !failedDays.has(t.date) && (opts.backfill || t.date >= floor),
  );
  const byDate = Map.groupBy(live, (t) => t.date);
  insertMarketSeries(
    db,
    [...byDate].map(([date, ts]) => ({
      seriesId: SBG_CDS_SERIES,
      obsDate: date,
      value: percentile(
        ts.map((t) => t.price),
        50,
      ),
    })),
  );

  // 文件拉到了、那天却已没有有效成交(唯一那笔被撤销)→ 删掉之前写的值。
  // 只看拉到了的那些天:源已不保留的天(null)不能删,那是库里独有的历史
  deleteMarketSeriesDates(
    db,
    SBG_CDS_SERIES,
    fetchedDays.filter((d) => !byDate.has(d)),
  );

  // 两周一笔都没有:软银成交再稀也不至于,多半是筛选条件对不上了(标识 / 表头改版)
  if (!opts.backfill && !trades.length && !failed.length)
    failed.push(`最近 ${WINDOW_DAYS} 天没筛出一笔软银成交(筛选条件可能失效)`);

  return {
    written: byDate.size,
    trades: live.length,
    failed,
    latest: getMarketSeries(db, SBG_CDS_SERIES).at(-1)?.date ?? null,
  };
}

// CLI:bun run src/server/jobs/sbgCdsSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateSbgCds(db, { backfill: process.argv.includes('--backfill') });
  db.close();
  console.log(`写入 ${r.written} 天(${r.trades} 笔成交),最新 ${r.latest};失败 ${r.failed.length} 个文件`);
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
}
