import type { Database } from 'bun:sqlite';
import { insertMarketSeries, getLatestMarketDate, getMarketSeries } from '../storage/repository';
import { fetchTwseMonthlyRevenue, twseSeriesId } from '../fetchers/twseRevenue';
import { activeBySource, twseCodeOf } from '../../shared/aiChain';

/**
 * TWSE 月营收更新(目前只有 TSM)。**和 SEC 那侧是两套流程,不共用 writeDerived** ——
 * SEC 给四科目、算 TTM 派生量;这里源只给营收,写的就是营收本身和源自己算的同比。
 *
 * 为什么同比取源给的、不自己算:源在同一条记录里给了「去年同月增减(%)」,
 * 而我们攒的历史可能缺去年那个月(快照型源,见 fetchers/twseRevenue)。用源的值,
 * 首月就有同比,且不会因为我们缺一格而算不出来。
 *
 * 跳过判据:库里最新月末 >= 远端最新月末 → 本月没出新数,零写入。月频源一个月才动一次,
 * 而 job 天天跑,所以稳态下这里天天都该是 skip。
 */

export type TwseResult = { fetched: string[]; skipped: string[]; failed: string[]; written: number };

type Fetch = typeof fetchTwseMonthlyRevenue;

export async function updateTwseRevenue(
  db: Database,
  opts: { tickers?: string[]; force?: boolean; fetcher?: Fetch } = {},
): Promise<TwseResult> {
  const tickers = opts.tickers ?? activeBySource('twse');
  const fetchOne = opts.fetcher ?? fetchTwseMonthlyRevenue;

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
        skipped.push(ticker);
        continue;
      }

      // 一次拿三个月(当月/上月/去年当月),全部 upsert —— 首次接入就有三个点。
      const rows = r.points.map((p) => ({ seriesId: revId, obsDate: p.monthEnd, value: p.revenueTwdM }));
      if (r.yoyPct !== null) {
        rows.push({ seriesId: twseSeriesId(ticker, 'revYoy'), obsDate: r.latestMonthEnd, value: r.yoyPct });
      }

      insertMarketSeries(db, rows);
      written += rows.length;
      fetched.push(`${ticker}(${r.latestMonthEnd}${r.note ? ` · ${r.note}` : ''})`);
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
