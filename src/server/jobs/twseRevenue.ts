import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getLatestMarketDate, getMarketSeries } from '../storage/repository';
import { fetchTwseMonthlyRevenue, twseSeriesId } from '../fetchers/twseRevenue';
import { fetchRevenueReports, type RevenueReport } from '../fetchers/tsmcRevenue6k';
import { activeBySource, sec6kCikOf, twseCodeOf } from '../../shared/aiChain';

/**
 * TWSE 月营收更新(目前只有 TSM)。**只管月营收那两格** —— TSM 的毛利率/FCF 走 sec6k 源
 * (它交给 EDGAR 的季度合并财报),见 jobs/sec6kReports。曾经也从 TWSE 的季度综合损益表
 * 取过毛利率,后来退掉了:那是 6-K 的子集(无现金流)、历史还只能靠攒,留着就成了
 * 同一批数字的第二个真相源。
 *
 * 为什么同比取源给的、不自己算:源在同一条记录里给了「去年同月增减(%)」,
 * 而我们攒的历史可能缺去年那个月(快照型源,见 fetchers/twseRevenue)。用源的值,
 * 首月就有同比,且不会因为我们缺一格而算不出来。
 *
 * 跳过判据:库里最新月末 >= 远端最新月末 → 本月没出新数,零写入。月频源一个月才动一次,
 * 而 job 天天跑,所以稳态下这里天天都该是 skip。
 *
 * 缺月由 SEC 上的营收公告 6-K 补(fetchers/tsmcRevenue6k):TWSE 只给最新一个月,job 漏跑两个月以上就缺一段
 * (2025-11 ~ 2026-04 缺过)。每轮看最近 12 个月有没有缺,有才去 EDGAR 取;只补缺、不覆盖 TWSE 已有的点
 * (6-K 取整到百万,TWSE 精确到千元,2025~2026 重叠 11 个月最多差 0.92)。
 * 2016 起的历史:bun run src/server/jobs/twseRevenue.ts --backfill(2026-11-18 已回填,2014-12 起)。
 */

const BACKFILL_SINCE = '2016-01-01';
// 回填后应连续的起点:2016-01 起申报的第一份报的是 2015-12(更早的月份只来自「去年当月」一栏,同比从这里才有)
const BACKFILL_CHECK_FROM = '2015-12-31';

function monthIndex(monthEnd: string): number {
  return Number(monthEnd.slice(0, 4)) * 12 + Number(monthEnd.slice(5, 7)) - 1;
}

function monthEndOf(index: number): string {
  return new Date(Date.UTC(Math.floor(index / 12), (index % 12) + 1, 0)).toISOString().slice(0, 10);
}

/**
 * 今天按理已经发布到哪个月(月末):TWSE 与 6-K 都在次月 10 日前后发,15 日起算上个月,之前算上上个月。
 * 缺口按它算而不按库里最新月:TWSE 接口连续坏几个月时库里最新月不动,按库里算就看不出缺口、6-K 也不补
 */
export function expectedLatest(now: Date): string {
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth();

  return monthEndOf(index - (now.getUTCDate() >= 15 ? 1 : 2));
}

/** from ~ last(都是月末,含两端)之间,dates 里缺哪几个月(升序)。 */
export function missingMonths(dates: string[], from: string, last: string): string[] {
  const have = new Set(dates);
  const n = Math.max(0, monthIndex(last) - monthIndex(from) + 1);

  return Array.from({ length: n }, (_, i) => monthEndOf(monthIndex(from) + i)).filter((d) => !have.has(d));
}

/**
 * 公告 → 要补的行(只补库里没有的月份)。营收:各份的「当月」最权威,「上月 / 去年当月」只补没有任何一份
 * 报它当月的那几个月(某份公告没取到或解析失败时,下一份的「上月」正好是它)。
 * 同比:用公告给的;公告没覆盖的月份按营收现算(要有去年同月)。
 */
export function rowsFrom6k(
  reports: RevenueReport[],
  existingRev: { date: string; value: number }[],
  existingYoy: string[],
  ids: { rev: string; yoy: string },
): { seriesId: string; obsDate: string; value: number }[] {
  const reported = new Map<string, number>([
    ...reports.flatMap((r): [string, number][] => [
      [monthEndOf(monthIndex(r.monthEnd) - 12), r.lastYearRevenue],
      [monthEndOf(monthIndex(r.monthEnd) - 1), r.prevRevenue],
    ]),
    ...reports.map((r): [string, number] => [r.monthEnd, r.revenue]),
  ]);
  const haveRev = new Set(existingRev.map((p) => p.date));
  const newRev = [...reported].filter(([d]) => !haveRev.has(d));

  // 现算同比时 TWSE 已有的点优先(更精确)
  const rev = new Map([...reported, ...existingRev.map((p): [string, number] => [p.date, p.value])]);
  const yoy = new Map(reports.map((r): [string, number] => [r.monthEnd, r.yoyPct]));
  const haveYoy = new Set(existingYoy);
  const newYoy = [...rev.keys()].flatMap((d): [string, number][] => {
    if (haveYoy.has(d)) return [];
    const given = yoy.get(d);
    const base = rev.get(monthEndOf(monthIndex(d) - 12));
    if (given !== undefined) return [[d, given]];

    return base ? [[d, (rev.get(d)! / base - 1) * 100]] : [];
  });

  return [
    ...newRev.map(([obsDate, value]) => ({ seriesId: ids.rev, obsDate, value })),
    ...newYoy.map(([obsDate, value]) => ({ seriesId: ids.yoy, obsDate, value })),
  ];
}

export type TwseResult = { fetched: string[]; skipped: string[]; failed: string[]; written: number };

type Fetch = typeof fetchTwseMonthlyRevenue;
type Fetch6k = (cik: string, since: string) => Promise<RevenueReport[]>;
export async function updateTwseRevenue(
  db: Database,
  opts: {
    tickers?: string[];
    force?: boolean;
    fetcher?: Fetch;
    reports6k?: Fetch6k;
    backfill?: boolean;
    now?: Date;
  } = {},
): Promise<TwseResult> {
  const tickers = opts.tickers ?? activeBySource('twse');
  const fetchOne = opts.fetcher ?? fetchTwseMonthlyRevenue;
  const fetch6k = opts.reports6k ?? ((cik: string, since: string) => fetchRevenueReports(cik, since));

  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let written = 0;

  for (const ticker of tickers) {
    const code = twseCodeOf(ticker);
    // 名单打错字要立刻炸,不是静默跳过 —— 配置错误和数据源故障要分开。
    if (!code) {
      failed.push(`${ticker}: 名单里没有 twseCode(它是不是走别的源?)`);
      continue;
    }

    try {
      const r = await fetchOne(code);
      const revId = twseSeriesId(ticker, 'revM');
      const local = getLatestMarketDate(db, revId);

      if (!opts.force && local && local >= r.latestMonthEnd) {
        skipped.push(`${ticker}:月营收`);
      } else {
        // 一次拿三个月(当月/上月/去年当月),全部 upsert —— 首次接入就有三个点。
        const rows = r.points.map((p) => ({ seriesId: revId, obsDate: p.monthEnd, value: p.revenueTwdM }));
        if (r.yoyPct !== null) {
          rows.push({ seriesId: twseSeriesId(ticker, 'revYoy'), obsDate: r.latestMonthEnd, value: r.yoyPct });
        }

        insertMarketSeries(db, rows);
        written += rows.length;
        fetched.push(`${ticker}:月营收 ${r.latestMonthEnd}${r.note ? `(${r.note})` : ''}`);
      }
    } catch (e) {
      failed.push(`${ticker} 月营收: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 缺月补洞:近 12 个月营收或同比有缺(或 --backfill)才去 EDGAR 取 6-K。失败只记一条,TWSE 那步照样算数
  await tickers.reduce(async (prev, ticker) => {
    await prev;
    const cik = sec6kCikOf(ticker);
    const ids = { rev: twseSeriesId(ticker, 'revM'), yoy: twseSeriesId(ticker, 'revYoy') };
    const existingRev = getMarketSeries(db, ids.rev);
    // 库里最新月与「今天按理该有的月」取晚的那个(库里偶尔比推算的新:月中前 TWSE 已发)
    const last = [existingRev.at(-1)?.date ?? '', expectedLatest(opts.now ?? new Date())].sort().at(-1)!;
    if (!cik) return;
    // 平时查最近 12 个月,回填查全段;营收与同比都查 —— 漏跑一个月时 TWSE 下月会带回上月营收、但不带上月同比
    const from = opts.backfill ? BACKFILL_CHECK_FROM : monthEndOf(monthIndex(last) - 11);
    const gaps = () =>
      [ids.rev, ids.yoy].flatMap((id) =>
        missingMonths(
          getMarketSeries(db, id).map((p) => p.date),
          from,
          last,
        ).map((d) => ({ id, d })),
      );
    const missing = gaps();
    if (!opts.backfill && !missing.length) return;

    // 公告在所报月份的次月交,从最早那个缺月的月初起取就够
    const earliest = missing.map((m) => m.d).sort()[0];
    const since = opts.backfill || !earliest ? BACKFILL_SINCE : `${earliest.slice(0, 8)}01`;
    try {
      const reports = await fetch6k(cik, since);
      const existingYoy = getMarketSeries(db, ids.yoy).map((p) => p.date);
      const rows = rowsFrom6k(reports, existingRev, existingYoy, ids);
      insertMarketSeries(db, rows);
      written += rows.length;
      if (rows.length) fetched.push(`${ticker}:6-K 补 ${rows.length} 行(${reports.length} 份公告)`);
      const still = gaps().map((m) => `${m.id === ids.yoy ? '同比' : '营收'} ${m.d}`);
      if (still.length) failed.push(`${ticker}: ${from} 起仍缺 ${still.join(', ')}(TWSE 与 6-K 都没有)`);
    } catch (e) {
      failed.push(`${ticker} 6-K 补月营收: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, Promise.resolve());

  // 同比是逐月单点写入的,历史靠攒 —— 缺月是正常的(源不可回填),但**营收有值却同比整条空**
  // 说明源那个字段变了,那就永远不会有同比线而没人知道。
  failed.push(
    ...tickers.flatMap((t) =>
      getMarketSeries(db, twseSeriesId(t, 'revM')).length > 0 &&
      getMarketSeries(db, twseSeriesId(t, 'revYoy')).length === 0
        ? [`${t}: 有月营收但同比一个点都没有(源的「去年同月增減(%)」字段可能改名了)`]
        : [],
    ),
  );

  return { fetched, skipped, failed, written };
}

// CLI:bun run src/server/jobs/twseRevenue.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateTwseRevenue(db, { backfill: process.argv.includes('--backfill') });
  db.close();
  console.log(JSON.stringify(r, null, 2));
}
