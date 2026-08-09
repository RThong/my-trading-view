import type { Database } from 'bun:sqlite';
import { insertSecFundamentals, getSecFundamentals } from '../storage/repository';
import { toCompanyFacts as packFacts } from '../fetchers/sec6k';
import {
  DartNoData,
  REPORTS,
  fetchDartReport,
  latestExpectedPeriod,
  type DartReport,
} from '../fetchers/dartFinancials';
import { extractFundamentals } from '../analytics/secFundamentals';
import { writeDerivedSecSeries } from './secFundamentals';
import { activeBySource, activeInSecTable, dartCorpCodeOf } from '../../shared/aiChain';

/**
 * dart 源:韩国 DART 的季度全表 → 四科目 → 落 `sec_fundamentals`(与 companyfacts / 6-K 同一张表、
 * 同一套派生),所以面板上它和别家长得一样,只是币种是韩元。
 *
 * **必须整年重算而不是只拉新的一期**:DART 给的是**年初至今累计**,单季靠相邻两期相减,
 * 而 extractFundamentals 是对整批 facts 做差分的。所以稳态下也要把当年已出的那几份都拉回来
 * (≤4 次调用,限额 20,000/日,可忽略)。
 *
 * 跳过判据:库里已经有「法定上该交出来的那个期末」的行 → 零请求。判 T+45 用 latestExpectedPeriod,
 * 不去问远端 —— 这个 API 没有便宜的「最新是哪期」查询,拿日期推比白拉一轮拿 013 划算。
 *
 * `--full` 从 FIRST_YEAR 重拉全历史(约 40 次调用),只在首次接入或改了 account_id 链时用。
 */

/** 四科目按 account_id 链齐全的下限。2015 只有年报无季报,再往前 DART 也不提供。 */
const FIRST_YEAR = 2016;

export type DartResult = {
  fetched: string[];
  skipped: string[];
  failed: string[];
  rowsWritten: number;
  seriesWritten: number;
};

export async function updateDartFinancials(
  db: Database,
  opts: { tickers?: string[]; force?: boolean; full?: boolean; apiKey?: string; now?: Date } = {},
): Promise<DartResult> {
  const tickers = opts.tickers ?? activeBySource('dart');
  const apiKey = (opts.apiKey ?? process.env.DART_API_KEY ?? '').trim().replace(/^["']|["']$/g, '');
  const now = opts.now ?? new Date();

  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let rowsWritten = 0;

  // 缺 key 不是故障,是没配 —— 整条线跳过,别把状态灯弄红(其它源不受影响)。
  if (tickers.length && !apiKey) {
    return { fetched, skipped: tickers.map((t) => `${t}:缺 DART_API_KEY`), failed, rowsWritten: 0, seriesWritten: 0 };
  }

  for (const ticker of tickers) {
    const corpCode = dartCorpCodeOf(ticker);
    // 名单打错字要立刻可见,不静默跳过 —— 配置错误和数据源故障要分开。
    if (!corpCode) {
      failed.push(`${ticker}: 名单里没有 dartCorpCode(它是不是走别的源?)`);
      continue;
    }

    const want = latestExpectedPeriod(now);
    const wantEnd = `${want.year}-${want.report.monthDay}`;
    const have = new Set(getSecFundamentals(db, ticker).map((r) => r.periodEnd));
    if (!opts.force && !opts.full && have.has(wantEnd)) {
      skipped.push(ticker);
      continue;
    }

    // 拉的范围:稳态只补当年(单季差分要同年的前几个累计检查点);--full 从 2016 起全量。
    const years = opts.full
      ? Array.from({ length: want.year - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i)
      : [want.year];

    const reports: DartReport[] = [];
    let notYet = 0; // 「那期还没交」的份数,只用来在报错时说清是不是全都还没到
    try {
      for (const year of years) {
        for (const report of REPORTS) {
          try {
            reports.push(await fetchDartReport(corpCode, year, report, apiKey));
          } catch (e) {
            // 「那期还没交」是正常状态(013),与真失败分开记 —— 否则每季度到下一份出来之前都是红灯。
            if (e instanceof DartNoData) notYet += 1;
            else failed.push(`${ticker} ${year}/${report.code}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      if (reports.length === 0) {
        // **全是 013 不算失败**:那只是「法定日到了但公司还没交」,是正常状态,过几天自己就有了。
        // 报 failed 会在每个季度的申报窗口里点一段红灯,正是要防的那类常驻告警。
        // 真失败(网络 / 状态码异常)已经在上面逐份记进 failed 了。
        if (notYet > 0) skipped.push(`${ticker}:${notYet} 份尚无数据`);
        else failed.push(`${ticker}: 一份报告都没拉到`);
        continue;
      }

      // 全部按**年初至今累计**打包(见 fetchDartReport 的 cumulative),单季由 toQuarters 相邻相减还原。
      // scale=1:DART 给的就是韩元原值,下游 deriveSeries 按基础货币单位除 1e6。
      const rows = extractFundamentals(ticker, packFacts(reports, 'ytd', 1));
      insertSecFundamentals(db, rows);
      rowsWritten += rows.length;

      const latest = getSecFundamentals(db, ticker).at(-1)?.periodEnd;
      fetched.push(`${ticker}(${reports.length} 份 → ${rows.length} 行,最新 ${latest ?? '无'})`);
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 派生量与 companyfacts / 6-K 那两侧共用一套:范围是落在 sec_fundamentals 里的全部启用标的。
  const { written, problems } = writeDerivedSecSeries(db, activeInSecTable(), tickers);
  // 只收自己源下那几家的体检结论:别的源的问题各有自己那条 job_run(见 C7)。
  const mine = new Set(activeBySource('dart'));
  failed.push(...problems.filter((p) => mine.has(p.ticker)).map((p) => p.message));

  return { fetched, skipped, failed, rowsWritten, seriesWritten: written };
}
