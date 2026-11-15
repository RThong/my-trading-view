import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, deleteMarketSeriesDates, getMarketSeries } from '../storage/repository';
import { fetchDtccFxOptionsDay, type FxOptionTrade } from '../fetchers/dtccFxOptions';
import { createYahooFetcher } from '../fetchers/yahoo';
import { dailyAtmVol } from '../analytics/fxImpliedVol';

/**
 * 美元/日元 1 个月平值隐含波动率(DTCC 场外期权成交反推)→ market_series 的 DTCC_USDJPY_IV1M(%)。
 * 同 dtccZcisSnapshot:源只保留约 2 年、头部每天在丢 → 必须落库。日常每轮重拉最近 WINDOW_DAYS 天整段覆盖
 * (晚报的成交出现在后几天的文件里;关机 / 漏跑不超过这么多天也能自动补上);更久的跑 --backfill。
 * 反推要当天 USD/JPY 收盘(Yahoo JPY=X)和美元 1 个月利率(库里 Eris ERIS_OIS_1M),见 analytics/fxImpliedVol。
 * 回填:bun run src/server/jobs/dtccFxVolSnapshot.ts --backfill(约 740 个文件、每个 1~2MB,4 并发十来分钟)。
 */
export const FX_VOL_SERIES = 'DTCC_USDJPY_IV1M';

const WINDOW_DAYS = 14;
// 源最早可下的大约日期(2026-11 实测 2024-11-02);更早的天回 null,不算失败
const BACKFILL_FROM = '2024-10-01';
const DAY_MS = 86_400_000;
// 文件次日 00:15 UTC 才发:今天、昨天回 403 是还没发,不算缺失
const PUBLISH_LAG_DAYS = 1;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

function isWeekday(iso: string): boolean {
  const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

function calendarDays(from: string, to: string): string[] {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

/** 当天或之前最近一个值;一个都没有返回 undefined。 */
function asOf(points: { date: string; value: number }[], date: string): number | undefined {
  return points.findLast((p) => p.date <= date)?.value;
}

export type FxVolDeps = {
  fetchDay: typeof fetchDtccFxOptionsDay;
  /** USD/JPY 日收盘(日期 → 日元 / 美元) */
  fetchSpot: (from: string) => Promise<Map<string, number>>;
};

async function yahooSpot(from: string): Promise<Map<string, number>> {
  const bars = await createYahooFetcher().fetchDailyBars('JPY=X', new Date(from));

  return new Map(bars.map((b) => [b.tradeDate, b.close]));
}

export type FxVolResult = { written: number; failed: string[] };

export async function updateDtccFxVol(
  db: Database,
  opts: { backfill?: boolean; today?: string; deps?: Partial<FxVolDeps> } = {},
): Promise<FxVolResult> {
  const fetchDay = opts.deps?.fetchDay ?? fetchDtccFxOptionsDay;
  const fetchSpot = opts.deps?.fetchSpot ?? yahooSpot;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const days = calendarDays(opts.backfill ? BACKFILL_FROM : addDays(today, -(WINDOW_DAYS - 1)), today);
  const batches = Array.from({ length: Math.ceil(days.length / 4) }, (_, i) => days.slice(i * 4, (i + 1) * 4));

  // 汇率 / 利率缺了反推不了:整轮失败,不写不删(别把「没收盘价」当「那天没成交」把库里的值删掉)
  const spot = await fetchSpot(addDays(days[0], -7));
  if (!spot.size) return { written: 0, failed: ['USD/JPY 收盘一根都没拿到,本轮不写不删'] };
  const usd1m = getMarketSeries(db, 'ERIS_OIS_1M');
  if (!usd1m.length) return { written: 0, failed: ['库里没有 ERIS_OIS_1M(美元 1 个月利率),本轮不写不删'] };
  // 只取当天或之前的值:成交日早于利率序列起点的那天没有利率 → 不出点(绝不拿未来的利率反推历史)
  const usdRate = (date: string) => {
    const v = asOf(usd1m, date);
    return v === undefined ? undefined : v / 100;
  };

  const failed: string[] = [];
  const fetchedDays = new Set<string>();
  const missingDays: string[] = [];
  const perFile = new Map<string, number>();
  const trades: FxOptionTrade[] = [];
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

  // 日常窗口里早该发布的文件回 403 / 404 = 源侧缺失,记失败让当天后续触发点重跑;回填时源头部本来就过期,不算
  if (!opts.backfill)
    failed.push(
      ...missingDays
        .filter((d) => d < addDays(today, -PUBLISH_LAG_DAYS))
        .map((d) => `${d}: 源回 403/404(该发布的文件缺失)`),
    );

  // 工作日的文件一笔都没筛出:那天不删库里的值(可能是改版);最近两个工作日都这样 → 识别规则多半失效
  const emptyDays = new Set([...perFile].filter(([d, n]) => n === 0 && isWeekday(d)).map(([d]) => d));
  const lastTwoWeekdays = [...perFile.keys()].filter(isWeekday).sort().slice(-2);
  if (lastTwoWeekdays.length === 2 && lastTwoWeekdays.every((d) => emptyDays.has(d)))
    failed.push(`USD/JPY 期权:最近两个工作日(${lastTwoWeekdays.join('、')})的文件都筛不出成交(识别规则可能失效)`);
  if (!trades.length && fetchedDays.size) {
    failed.push('USD/JPY 期权:一笔成交都没筛出(识别规则可能失效),本轮不写不删');
    return { written: 0, failed };
  }

  // 剔两类:事后被撤销的;成交日自己那天的文件没拿到的(那天只剩后几天补报的几笔,不完整)
  const live = trades.filter((t) => !cancelled.has(t.id) && fetchedDays.has(t.date));
  const points = dailyAtmVol(live, spot, usdRate);
  insertMarketSeries(
    db,
    points.map((p) => ({ seriesId: FX_VOL_SERIES, obsDate: p.date, value: p.value })),
  );
  // 文件拉到了、那天却出不了点(撤销 / 晚报修正后笔数不够)→ 删掉之前写的值。
  // 不删:源不保留的天;文件筛不出任何成交的工作日(可能是改版);没有收盘价 / 美元利率的天(反推不了,不是没成交)
  const priced = new Set(points.map((p) => p.date));
  deleteMarketSeriesDates(
    db,
    FX_VOL_SERIES,
    [...fetchedDays].filter((d) => !priced.has(d) && !emptyDays.has(d) && spot.has(d) && usdRate(d) !== undefined),
  );

  return { written: points.length, failed };
}

// CLI:bun run src/server/jobs/dtccFxVolSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateDtccFxVol(db, { backfill: process.argv.includes('--backfill') });
  db.close();
  console.log(`写入 ${r.written} 天;失败 ${r.failed.length} 项`);
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
}
