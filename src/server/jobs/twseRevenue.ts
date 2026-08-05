import type { Database } from 'bun:sqlite';
import { insertMarketSeries, getLatestMarketDate, getMarketSeries } from '../storage/repository';
import {
  fetchTwseMonthlyRevenue,
  fetchTwseQuarterlyIncome,
  twseSeriesId,
  twseYtdSeriesId,
} from '../fetchers/twseRevenue';
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
type FetchIncome = typeof fetchTwseQuarterlyIncome;

/**
 * 季度毛利率:源给的是**年初至今累计**营收/成本,所以库里存累计原始量(可审计留档),
 * 单季值靠相邻两季的累计相减 —— 与 SEC 那侧的 YTD 差分同一个套路。
 *
 * Q1 的累计就是单季本身(无需相减)。其余季度要求**上一季的累计也在库里**才出点:
 * 快照型源不可回填,首次接入那一季若不是 Q1 就得等下一季才有第一个毛利率点。
 * 宁可空着,也不能拿累计值当单季用 —— 半年累计毛利率是 Q1 与 Q2 的平均,会把转折抹平。
 */
function quarterlyGm(db: Database, ticker: string): Array<{ obsDate: string; value: number }> {
  const rev = new Map(getMarketSeries(db, twseYtdSeriesId(ticker, 'rev')).map((p) => [p.date, p.value]));
  const cogs = new Map(getMarketSeries(db, twseYtdSeriesId(ticker, 'cogs')).map((p) => [p.date, p.value]));

  // 台股季末固定这四天。Q1 映射到 null:它的累计就是单季,不去减上一年度的 Q4。
  const PREV_MMDD: Record<string, string | null> = {
    '03-31': null,
    '06-30': '03-31',
    '09-30': '06-30',
    '12-31': '09-30',
  };

  return [...rev.keys()].sort().flatMap((end) => {
    const r = rev.get(end);
    const c = cogs.get(end);
    const prevMmdd = PREV_MMDD[end.slice(5)];
    if (r === undefined || c === undefined || prevMmdd === undefined) return [];

    const prev = prevMmdd === null ? null : `${end.slice(0, 4)}-${prevMmdd}`;
    // Q1:累计即单季。其余季:上一季累计必须也在库里,否则不出点(见上方注释)。
    const [dr, dc] = prev === null ? [r, c] : [r - (rev.get(prev) ?? Number.NaN), c - (cogs.get(prev) ?? Number.NaN)];
    if (!Number.isFinite(dr) || !Number.isFinite(dc) || dr <= 0) return [];

    return [{ obsDate: end, value: ((dr - dc) / dr) * 100 }];
  });
}

export async function updateTwseRevenue(
  db: Database,
  opts: { tickers?: string[]; force?: boolean; fetcher?: Fetch; incomeFetcher?: FetchIncome } = {},
): Promise<TwseResult> {
  const tickers = opts.tickers ?? activeBySource('twse');
  const fetchOne = opts.fetcher ?? fetchTwseMonthlyRevenue;
  const fetchIncome = opts.incomeFetcher ?? fetchTwseQuarterlyIncome;

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

    // 月营收与季度损益是两个端点、两种频率,各自独立判跳过 —— 一个没出新数不该拦住另一个。
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

    try {
      const q = await fetchIncome(code);
      // null = 本季还没申报(同一季各公司陆续交,截止日是季后约 45 天)。正常状态,不是失败。
      if (q === null) {
        skipped.push(`${ticker}:季度损益(本季未申报)`);
      } else {
        const ytd = [
          { seriesId: twseYtdSeriesId(ticker, 'rev'), obsDate: q.periodEnd, value: q.revenueYtdTwdM },
          { seriesId: twseYtdSeriesId(ticker, 'cogs'), obsDate: q.periodEnd, value: q.cogsYtdTwdM },
        ];
        insertMarketSeries(db, ytd);

        // 毛利率每轮从库里整条重算(累计量可能被重述覆盖),写的是差分出来的单季值。
        const gm = quarterlyGm(db, ticker).map((p) => ({
          seriesId: twseSeriesId(ticker, 'gm'),
          obsDate: p.obsDate,
          value: p.value,
        }));
        insertMarketSeries(db, gm);

        written += ytd.length + gm.length;
        fetched.push(`${ticker}:季度损益 ${q.periodEnd}(毛利率 ${gm.length} 点)`);
      }
    } catch (e) {
      failed.push(`${ticker} 季度损益: ${e instanceof Error ? e.message : String(e)}`);
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
