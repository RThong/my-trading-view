import type { Database } from 'bun:sqlite';
import { insertSecFundamentals, getLatestSecFiled } from '../storage/repository';
import {
  createTsmcFetcher,
  parseTsmcReport,
  toCompanyFacts,
  type FsFiling,
  type TsmcYtd,
} from '../fetchers/tsmcReports';
import { extractFundamentals } from '../analytics/secFundamentals';
import { writeDerivedSecSeries } from './secFundamentals';
import { activeBySource, activeInSecTable, sec6kCikOf } from '../../shared/aiChain';

/**
 * sec6k 源:TSM 的季度合并财报 6-K → 单季四科目 → 落 `sec_fundamentals`(与 companyfacts
 * 那条同一张表、同一套派生),所以面板上它和别家长得一样,只是币种是新台币。
 *
 * **必须整段重算而不是只拉新的一期**:单季值靠「同一年内相邻两期累计相减」还原,
 * 而 extractFundamentals 是对**整批 facts** 做差分的。只喂最新一期会得不到差分基准。
 * 好在这个源可回填、总量只有十几份,整段重拉一次约十几 MB,一年才发生四次。
 *
 * 跳过判据:远端最新一份的 filed <= 库里该 ticker 的 MAX(filed) → 没新季报,零请求正文。
 */

export type Sec6kResult = {
  fetched: string[];
  skipped: string[];
  failed: string[];
  rowsWritten: number;
  seriesWritten: number;
};

type Fetcher = ReturnType<typeof createTsmcFetcher>;

export async function updateSec6kReports(
  db: Database,
  opts: { tickers?: string[]; force?: boolean; fetcher?: Fetcher } = {},
): Promise<Sec6kResult> {
  const tickers = opts.tickers ?? activeBySource('sec6k');
  const sec = opts.fetcher ?? createTsmcFetcher();

  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let rowsWritten = 0;

  for (const ticker of tickers) {
    const cik = sec6kCikOf(ticker);
    if (!cik) {
      failed.push(`${ticker}: 名单里没声明 sec6k 源或缺 cik`);
      continue;
    }

    try {
      const filings = await sec.listFsFilings(cik);
      // 一份都没有 ≠ 正常跳过:TSM 每季必交,拿不到说明 submissions 结构或命名约定变了。
      if (filings.length === 0) {
        failed.push(`${ticker}: submissions 里没有 tsm-fs* 的季报 6-K(命名约定可能变了),未拉正文`);
        continue;
      }

      const remoteFiled = filings.at(-1)!.filed;
      const localFiled = getLatestSecFiled(db, ticker);
      if (!opts.force && localFiled && remoteFiled <= localFiled) {
        skipped.push(ticker);
        continue;
      }

      // 逐份串行拉正文:每份 4MB 级,并发没意义而且是外国发行人目录(SEC 限速 10 req/s)。
      const parsed: Array<{ filing: FsFiling; ytd: TsmcYtd }> = [];
      const badly: string[] = [];
      for (const filing of filings) {
        try {
          parsed.push({ filing, ytd: parseTsmcReport(await sec.fetchReport(cik, filing.accn)) });
        } catch (e) {
          // 单份解析失败不该让整段作废(老报告的排版可能不同)——记下来,其余照常差分。
          badly.push(`${filing.periodEnd}(${e instanceof Error ? e.message : String(e)})`);
        }
      }
      if (badly.length) failed.push(`${ticker}: ${badly.length}/${filings.length} 份没解析出来 —— ${badly.join('; ')}`);
      if (parsed.length === 0) {
        failed.push(`${ticker}: 一份都没解析出来,水位不前进 → 下次仍会重拉`);
        continue;
      }

      const rows = extractFundamentals(ticker, toCompanyFacts(parsed));
      insertSecFundamentals(db, rows);
      rowsWritten += rows.length;

      const advanced = (getLatestSecFiled(db, ticker) ?? '') >= remoteFiled;
      if (!advanced) {
        failed.push(`${ticker}: 拉到了 ${parsed.length} 份但水位没推到 ${remoteFiled}(差分可能全被跨年规则挡住)`);
        continue;
      }

      fetched.push(`${ticker}(${parsed.length} 份 → ${rows.length} 行,最新 ${filings.at(-1)!.periodEnd})`);
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 派生量与 companyfacts 那侧共用一套:范围是**落在 sec_fundamentals 表里的全部启用标的**,
  // 不只是本轮抓的那家 —— 否则单跑 TSM 时它的 TTM/毛利率线永远不出。
  const { written, problems } = writeDerivedSecSeries(db, activeInSecTable(), tickers);
  failed.push(...problems);

  return { fetched, skipped, failed, rowsWritten, seriesWritten: written };
}
