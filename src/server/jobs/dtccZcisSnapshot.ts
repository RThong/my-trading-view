import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, deleteMarketSeriesDates } from '../storage/repository';
import { fetchDtccZcisDay, ZCIS_TENORS, type ZcisTenor, type ZcisTrade } from '../fetchers/dtccZcis';
import { percentile } from '../../shared/calc/stats';

/**
 * 美元零息通胀掉期 1Y / 2Y(DTCC 成交)→ market_series 的 DTCC_ZCIS_{1Y,2Y},值 = 当天即期起息成交固定利率的中位数(%)。
 * 源只保留约 2 年、头部每天在丢 → 必须落库。日常每轮重拉最近 WINDOW_DAYS 天整段覆盖:晚报的成交会出现在后几天的文件里,
 * 关机 / 漏跑不超过这么多天也能自动补上;更久的跑 --backfill。
 * 回填:bun run src/server/jobs/dtccZcisSnapshot.ts --backfill(约 750 个文件、每个 ~1.4MB,4 并发十来分钟)。
 */
export function zcisSeries(tenor: ZcisTenor): string {
  return `DTCC_ZCIS_${tenor}`;
}

const WINDOW_DAYS = 14;
// 源最早可下的大约日期(2026-11 实测 2024-11-10);更早的天回 null,不算失败
const BACKFILL_FROM = '2024-10-01';
// 一天少于这么多笔不出点:单笔、两笔的中位数会被一笔离谱单带走(工作日通常十几到几十笔,2026-11 实测 1Y 6~43、2Y 9~23;美国假日变稀甚至为 0)
const MIN_TRADES = 3;
const TENORS = Object.keys(ZCIS_TENORS) as ZcisTenor[];
const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

function isWeekday(iso: string): boolean {
  const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

// 文件次日 00:15 UTC 才发:今天、昨天回 403 是还没发,不算缺失(daily 触发点最早 JST 11:00 = 02:00 UTC)
const PUBLISH_LAG_DAYS = 1;

function calendarDays(from: string, to: string): string[] {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

export type ZcisResult = { written: number; failed: string[] };

export async function updateDtccZcis(
  db: Database,
  opts: { backfill?: boolean; fetchDay?: typeof fetchDtccZcisDay; today?: string } = {},
): Promise<ZcisResult> {
  const fetchDay = opts.fetchDay ?? fetchDtccZcisDay;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const days = calendarDays(opts.backfill ? BACKFILL_FROM : addDays(today, -(WINDOW_DAYS - 1)), today);
  const batches = Array.from({ length: Math.ceil(days.length / 4) }, (_, i) => days.slice(i * 4, (i + 1) * 4));

  const failed: string[] = [];
  const fetchedDays = new Set<string>();
  const missingDays: string[] = [];
  // 每份文件筛出了几笔(不分期限):工作日的文件一笔都没有 = 识别规则可能失效,见下面 emptyDays
  const perFile = new Map<string, number>();
  const trades: ZcisTrade[] = [];
  const cancelled = new Set<string>();
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((d) => fetchDay(d)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') failed.push(`${batch[i]}: ${(r.reason as Error).message}`);
      else if (!r.value) missingDays.push(batch[i]);
      else {
        fetchedDays.add(batch[i]);
        perFile.set(batch[i], r.value.trades.length);
        trades.push(...r.value.trades);
        r.value.cancelled.forEach((id) => {
          cancelled.add(id);
        });
      }
    });
  }

  // 日常窗口里早该发布的文件回 403 / 404 = 源侧缺失(周末也有文件),记失败让当天后续触发点重跑;
  // 回填时源头部本来就过期,不算
  if (!opts.backfill)
    failed.push(
      ...missingDays
        .filter((d) => d < addDays(today, -PUBLISH_LAG_DAYS))
        .map((d) => `${d}: 源回 403/404(该发布的文件缺失)`),
    );

  // 工作日的文件一笔 ZCIS 都没筛出:那天不删库里的值(可能是改版而不是真没成交);
  // 最近两个工作日的文件都这样 → 多半是识别规则失效,记失败(美国单日假日不会连着两个工作日)
  const emptyDays = new Set([...perFile].filter(([d, n]) => n === 0 && isWeekday(d)).map(([d]) => d));
  const lastTwoWeekdays = [...perFile.keys()].filter(isWeekday).sort().slice(-2);
  if (lastTwoWeekdays.length === 2 && lastTwoWeekdays.every((d) => emptyDays.has(d)))
    failed.push(`ZCIS: 最近两个工作日(${lastTwoWeekdays.join('、')})的文件都筛不出成交(识别规则可能失效)`);

  // 剔两类:事后被撤销的;成交日自己那天的文件没拿到(拉失败 / 源不保留)的 —— 那天只剩后几天补报的几笔,不完整。
  // 后者也挡住了窗口外的成交日(日常模式只拉了窗口内的文件)
  const live = trades.filter((t) => !cancelled.has(t.id) && fetchedDays.has(t.date));

  const written = TENORS.map((tenor) => {
    const mine = live.filter((t) => t.tenor === tenor);
    // 拉到了文件却一笔都没筛出:多半是识别规则失效(FISN / 标的名 / 表头改了)或源成了空壳。
    // 照常走会把拉到的日子当「没成交」整段删掉 → 跳过这个期限,不写不删
    if (!mine.length && fetchedDays.size) {
      failed.push(`ZCIS ${tenor}: 一笔成交都没筛出(识别规则可能失效),本轮不写不删`);
      return 0;
    }
    const prices = [...Map.groupBy(mine, (t) => t.date)]
      .filter(([, ts]) => ts.length >= MIN_TRADES)
      .map(([date, ts]) => ({
        date,
        value: percentile(
          ts.map((t) => t.rate),
          50,
        ),
      }));

    insertMarketSeries(
      db,
      prices.map((p) => ({ seriesId: zcisSeries(tenor), obsDate: p.date, value: p.value })),
    );
    // 文件拉到了、那天却已不够笔数(撤销 / 晚报修正后)→ 删掉之前写的值。
    // 不删:源不保留的天(null,不在 fetchedDays);文件筛不出任何成交的工作日(emptyDays,可能是改版)
    const priced = new Set(prices.map((p) => p.date));
    deleteMarketSeriesDates(
      db,
      zcisSeries(tenor),
      [...fetchedDays].filter((d) => !priced.has(d) && !emptyDays.has(d)),
    );

    return prices.length;
  });

  return { written: written.reduce((a, b) => a + b, 0), failed };
}

// CLI:bun run src/server/jobs/dtccZcisSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateDtccZcis(db, { backfill: process.argv.includes('--backfill') });
  db.close();
  console.log(`写入 ${r.written} 天;失败 ${r.failed.length} 项`);
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
}
