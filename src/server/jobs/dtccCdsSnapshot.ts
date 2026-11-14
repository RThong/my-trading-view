import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries, deleteMarketSeriesDates } from '../storage/repository';
import { fetchDtccCdsDay, DTCC_CDS_TICKERS, type DtccCdsTrade } from '../fetchers/dtccCds';
import { chainDayPrices, denseFrom } from '../analytics/cdsTrades';
import { JPY_CDS, USD_CDS } from '../analytics/rateCurves';
import { AI_CDS } from '../../shared/rateCurveDefs';

/**
 * DTCC 单名 CDS 成交 → market_series 的 DTCC_CDS_{ticker},值 = 当天的「价」(平价 100,与 ICE_CDS_* 同口径;
 * 定价见 analytics/cdsTrades,bp 换算在读时做,见 yieldCurve 路由)。没成交的日子不写,图上留空。
 *
 * 两类名字:
 * - 软银(SBG):ICE 不清算,只有这条源。源只保留约 2 年多、头部每天在丢 → 日常每轮重拉最近 WINDOW_DAYS 天、
 *   整段覆盖(晚报的成交会出现在后几天的文件里,重拉能把那天补全)。daily 分组名沿用 `sbg_cds`。
 * - ICE 那几家美国公司:只补 ICE 开始存数**之前**的日子(ICE 结算价是主数据,读时以它为准),只在回填时跑。
 *   从 ICE 第一天的结算价起锚往前逐日定价;只留成交够密的那段(稀疏段几个月一个点、多是单笔,不可信)。
 *
 * 回填:bun run src/server/jobs/dtccCdsSnapshot.ts --backfill(约 900 个文件、每个 ~150KB,4 并发几分钟)。
 */
export function dtccCdsSeries(ticker: string): string {
  return `DTCC_CDS_${ticker}`;
}
const SBG = 'SBG';
const WINDOW_DAYS = 14;
// 源最早可下的大约日期(2026-11 实测 2024-09-02 起能下、2024-08-01 已 403);更早的天回 null,不算失败
const BACKFILL_FROM = '2024-06-01';
// 软银库里还没有值时的起始参照价。它的利差远高于 100bp 票息、价远低于 100,方向选择对参照价不敏感
const SBG_FALLBACK_ANCHOR = 85;

export type DtccCdsResult = { written: number; trades: number; failed: string[]; latest: string | null };

const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

function calendarDays(from: string, to: string): string[] {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

// 一个名字这次要写哪段、从哪个参照价起、往哪个方向逐日定价;
// denseUntil = 只留成交够密的那段,值为回填段的截止日(ICE 第一天,不含;见 denseFrom),不截则 null
type Scope = {
  ticker: string;
  inScope: (d: string) => boolean;
  anchor: number;
  order: 'asc' | 'desc';
  denseUntil: string | null;
};

// usBackfill = 回填且本轮没有文件拉失败:缺一天的成交可能让刚好够密的月份变稀、把整月旧值截掉删掉,
// 所以有失败就整轮不碰美国公司,等重跑
function scopes(db: Database, floor: string, usBackfill: boolean): Scope[] {
  const sbgBefore = getMarketSeries(db, dtccCdsSeries(SBG)).filter((p) => p.date < floor);
  const sbg: Scope = {
    ticker: SBG,
    inScope: (d) => d >= floor,
    anchor: sbgBefore.at(-1)?.value ?? SBG_FALLBACK_ANCHOR,
    order: 'asc',
    // 软银只有这一个源,稀疏段也留着(图上说明里写了成交稀)
    denseUntil: null,
  };
  if (!usBackfill) return [sbg];

  // 美国公司:ICE 还没开始存的公司没法起锚,跳过
  const us = DTCC_CDS_TICKERS.filter((t) => t !== SBG).flatMap((ticker): Scope[] => {
    const first = getMarketSeries(db, `ICE_CDS_${ticker}`)[0];
    return first
      ? [{ ticker, inScope: (d) => d < first.date, anchor: first.value, order: 'desc', denseUntil: first.date }]
      : [];
  });

  return [sbg, ...us];
}

export async function updateDtccCds(
  db: Database,
  opts: { backfill?: boolean; fetchDay?: typeof fetchDtccCdsDay; today?: string } = {},
): Promise<DtccCdsResult> {
  const fetchDay = opts.fetchDay ?? fetchDtccCdsDay;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const floor = opts.backfill ? BACKFILL_FROM : addDays(today, -(WINDOW_DAYS - 1));
  const days = calendarDays(floor, today);
  const concurrency = opts.backfill ? 4 : 2;
  const batches = Array.from({ length: Math.ceil(days.length / concurrency) }, (_, i) =>
    days.slice(i * concurrency, (i + 1) * concurrency),
  );

  const failed: string[] = [];
  const fetchedDays = new Set<string>();
  const trades: DtccCdsTrade[] = [];
  const cancelled = new Set<string>();
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((d) => fetchDay(d)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(`${batch[i]}: ${(r.reason as Error).message}`);
      } else if (r.value) {
        fetchedDays.add(batch[i]);
        trades.push(...r.value.trades);
        r.value.cancelled.forEach((id) => {
          cancelled.add(id);
        });
      }
    });
  }

  // 剔掉两类:事后被撤销的成交;成交日自己那天的文件没拿到(拉失败,或源已不保留回 null)的成交 ——
  // 那天的单大多在它自己的文件里,只剩后几天补报的几笔,中位数不完整,别盖掉库里的
  // (窗口外的成交日也落在这类:日常模式下只拉了窗口内的文件)
  const live = trades.filter((t) => !cancelled.has(t.id) && fetchedDays.has(t.date));

  if (opts.backfill && failed.length) failed.push('有文件拉取失败,本轮跳过美国公司的回填(不写不删),重跑即可');

  const written = scopes(db, floor, !!opts.backfill && !failed.length).map((s) => {
    const def = AI_CDS.find((c) => c.ticker === s.ticker);
    const mine = live.filter((t) => t.ticker === s.ticker && s.inScope(t.date));
    // 美国公司回填一笔都没筛出:多半是识别规则对不上了(源改版),照常走会把这家的历史整段删掉 → 跳过
    if (s.denseUntil && !mine.length) {
      failed.push(`${s.ticker}: 回填没筛出一笔成交(识别规则可能失效),本轮不写不删`);
      return { days: 0, trades: 0 };
    }
    const byDate = [...Map.groupBy(mine, (t) => t.date)]
      .map(([date, ts]) => ({ date, us: ts.map((t) => t.u) }))
      .sort((a, b) => (s.order === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
    const chained = chainDayPrices(byDate, s.anchor, def?.coupon ?? 100, def?.jpy ? JPY_CDS : USD_CDS);
    const stored = getMarketSeries(db, dtccCdsSeries(s.ticker))
      .map((p) => p.date)
      .filter(s.inScope);
    // 密度按完整信息判:库里有、本轮源已拿不到的点也算(源只滚动保留约 2 年,起点越过现有段时
    // 最早那个月只剩半截,只看本轮会被判稀疏、把源已不保留的历史截掉删掉)
    const from = s.denseUntil
      ? denseFrom([...chained.map((p) => p.date), ...stored.filter((d) => !fetchedDays.has(d))], s.denseUntil)
      : '';
    const prices = chained.filter((p) => p.date >= from);

    insertMarketSeries(
      db,
      prices.map((p) => ({ seriesId: dtccCdsSeries(s.ticker), obsDate: p.date, value: p.price })),
    );
    // 文件拉到了、那天却已没有有效成交(唯一那笔被撤销),或落在稀疏段被截掉 → 删掉之前写的值。
    // 只看拉到了的那些天:源已不保留的天(null)不能删,那是库里独有的历史
    const priced = new Set(prices.map((p) => p.date));
    // 美国公司截断点之前的旧值一律删(含源已不保留的):截断点已把它们算进密度,仍判稀疏 = 孤点
    const beforeDense = s.denseUntil ? stored.filter((d) => d < from) : [];
    deleteMarketSeriesDates(db, dtccCdsSeries(s.ticker), [
      ...[...fetchedDays].filter((d) => s.inScope(d) && !priced.has(d)),
      ...beforeDense,
    ]);

    return { days: prices.length, trades: mine.length };
  });

  // 两周一笔软银都没有:成交再稀也不至于,多半是筛选条件对不上了(标识 / 表头改版)
  if (!opts.backfill && !live.some((t) => t.ticker === SBG) && !failed.length)
    failed.push(`最近 ${WINDOW_DAYS} 天没筛出一笔软银成交(筛选条件可能失效)`);

  return {
    written: written.reduce((n, w) => n + w.days, 0),
    trades: written.reduce((n, w) => n + w.trades, 0),
    failed,
    latest: getMarketSeries(db, dtccCdsSeries(SBG)).at(-1)?.date ?? null,
  };
}

// CLI:bun run src/server/jobs/dtccCdsSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateDtccCds(db, { backfill: process.argv.includes('--backfill') });
  db.close();
  console.log(`写入 ${r.written} 天(${r.trades} 笔成交),软银最新 ${r.latest};失败 ${r.failed.length} 项`);
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
}
