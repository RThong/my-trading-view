import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries, deleteMarketSeriesDates } from '../storage/repository';
import { fetchDtccCdxDay, type CdxKey, type DtccCdxTrade } from '../fetchers/dtccCdx';
import { percentile } from '../../shared/calc/stats';
import { ICE_CDX_START } from '../fetchers/iceCds';

/**
 * 回填 CDX 北美 IG / HY 在 ICE 开始存结算价**之前**的历史 → market_series 的 DTCC_CDX_{IG,HY},
 * 值 = 当天主力 5Y 全部成交价的中位数(平价 100,与 ICE_CDX_* 同口径;bp 换算在读时做)。
 * 之后的日子归 ICE(每天由 ice_cds 分组顺带存),读时 ICE 为准、DTCC 只接在 ICE 第一天之前。
 * 指数每天几百笔成交,中位数足够稳,不需要单名那套选方向 / 断团 / 密度截断(见 dtccCdsSnapshot)。
 *
 * 只在需要时手动跑:bun run src/server/jobs/dtccCdxSnapshot.ts(约 800 个文件、每个 ~100KB,4 并发几分钟)。
 * 某天文件拉失败只少那一天(那天的成交不用),重跑即补;源已不保留的天(null)不碰库里的值。
 */
export function dtccCdxSeries(index: CdxKey): string {
  return `DTCC_CDX_${index}`;
}

const INDEXES: CdxKey[] = ['IG', 'HY'];
// 源最早可下的大约日期(2026-11 实测 2024-09-03 起能下);更早的天回 null,不算失败
const BACKFILL_FROM = '2024-08-01';
const DAY_MS = 86_400_000;

function calendarDays(from: string, to: string): string[] {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
  return Array.from({ length: n + 1 }, (_, i) => new Date(Date.parse(from) + i * DAY_MS).toISOString().slice(0, 10));
}

export type DtccCdxResult = { written: number; failed: string[] };

export async function backfillDtccCdx(
  db: Database,
  opts: { fetchDay?: typeof fetchDtccCdxDay; today?: string } = {},
): Promise<DtccCdxResult> {
  const fetchDay = opts.fetchDay ?? fetchDtccCdxDay;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  // 每个指数只补到它 ICE 第一天之前;ICE 还没存过就补到今天
  // 只认合法且不早于 ICE_CDX_START 的日期:万一库里混进空日期或过早的日期,拿它当起点会让 inScope 全假、
  // 整条 DTCC 历史被删光(源只留约 2 年,删了补不回)
  const iceFirst = new Map(
    INDEXES.map((k) => [
      k,
      getMarketSeries(db, `ICE_CDX_${k}`).find((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date >= ICE_CDX_START)
        ?.date ?? '9999',
    ]),
  );
  const days = calendarDays(BACKFILL_FROM, today);
  const batches = Array.from({ length: Math.ceil(days.length / 4) }, (_, i) => days.slice(i * 4, (i + 1) * 4));

  const failed: string[] = [];
  const fetchedDays = new Set<string>();
  const trades: DtccCdxTrade[] = [];
  const cancelled = new Set<string>();
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((d) => fetchDay(d)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') failed.push(`${batch[i]}: ${(r.reason as Error).message}`);
      else if (r.value) {
        fetchedDays.add(batch[i]);
        trades.push(...r.value.trades);
        r.value.cancelled.forEach((id) => {
          cancelled.add(id);
        });
      }
    });
  }

  // 成交日自己的文件没拿到(拉失败 / 源不保留)的成交不用:那天的单大多在它自己的文件里,剩下的补报不完整
  const live = trades.filter((t) => !cancelled.has(t.id) && fetchedDays.has(t.date));

  const written = INDEXES.map((k) => {
    const inScope = (d: string) => d < iceFirst.get(k)!;
    const mine = live.filter((t) => t.index === k && inScope(t.date));
    // 拉到了该补的文件却一笔都没筛出:多半是识别规则失效(FISN / 票息 / notation 写法变了)或源文件成了空壳。
    // 照常走会把所有拉到的日子当「没有有效成交」整段删掉 → 跳过这个指数,不写不删(同单名 dtccCdsSnapshot)
    if (!mine.length && [...fetchedDays].some(inScope)) {
      failed.push(`CDX ${k}: 回填没筛出一笔成交(识别规则可能失效),本轮不写不删`);
      return 0;
    }
    const byDate = Map.groupBy(mine, (t) => t.date);
    const prices = [...byDate].map(([date, ts]) => ({
      date,
      value: percentile(
        ts.map((t) => t.price),
        50,
      ),
    }));

    insertMarketSeries(
      db,
      prices.map((p) => ({ seriesId: dtccCdxSeries(k), obsDate: p.date, value: p.value })),
    );
    // 删两类:文件拉到了、那天却已没有有效成交(全被撤销);以及 ICE 开始存之后的旧值
    // (上次回填时 ICE 还没数据、补到了今天 —— 那段现在归 ICE)
    deleteMarketSeriesDates(db, dtccCdxSeries(k), [
      ...[...fetchedDays].filter((d) => inScope(d) && !byDate.has(d)),
      ...getMarketSeries(db, dtccCdxSeries(k))
        .map((p) => p.date)
        .filter((d) => !inScope(d)),
    ]);

    return prices.length;
  });

  return { written: written.reduce((a, b) => a + b, 0), failed };
}

// CLI:bun run src/server/jobs/dtccCdxSnapshot.ts
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await backfillDtccCdx(db);
  db.close();
  console.log(`写入 ${r.written} 天;失败 ${r.failed.length} 个文件`);
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
}
