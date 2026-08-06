import type { Database } from 'bun:sqlite';
import { insertSecFundamentals, getLatestSecFiled, type SecFundamentalRow } from '../storage/repository';
import {
  createTsmcFetcher,
  parseEarningsRelease,
  parseTsmcReport,
  releaseToCompanyFacts,
  toCompanyFacts,
  type FsFiling,
  type TsmcRelease,
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

/** 财报稿与报表在同一季度上的相对差。超过这个就不是舍入了(财报稿只精确到百万)。 */
const DIVERGENCE_TOLERANCE = 0.005; // 0.5%

/**
 * 财报稿(T+16)那一路。做两件事:
 *  · **补**报表还没覆盖到的季度 → 毛利率提前约一个月。
 *  · **验**最近一个报表已覆盖的季度 → 每轮都拿它和核阅后的报表对一次,确认解析器还没漂。
 *
 * 为什么只补未覆盖的、不让财报稿参与已覆盖季度的取值:财报稿是**未经会计师核阅、未经董事会
 * 通过**的管理层数。而下游的「直接单季行优先于 YTD 差分」会让财报稿那条**永久压住**报表 ——
 * 那就是让未核阅的数盖住核阅后的,方向正好反了。所以取值上让报表独占,财报稿只在报表空白处补位。
 *
 * 拉不到不算失败:它是加速手段,少了只是慢回 T+45,不该让整轮变红。
 */
async function releaseFallback(
  sec: Fetcher,
  cik: string,
  ticker: string,
  statements: SecFundamentalRow[],
  failed: string[],
): Promise<{ rows: SecFundamentalRow[]; latestFiled: string | null; checked: string | null }> {
  const empty = { rows: [], latestFiled: null, checked: null };
  try {
    const releases = await sec.listEarningsReleases(cik);
    if (releases.length === 0) return empty;

    const covered = new Set(statements.map((r) => r.periodEnd));
    const pending = releases.filter((f) => !covered.has(f.periodEnd));
    // 校验样本:最近一个**报表也有**的季度。只多拉一份,换来每轮一次真实比对。
    const verify = releases.filter((f) => covered.has(f.periodEnd)).at(-1);

    const parse = async (filing: FsFiling): Promise<{ filing: FsFiling; rel: TsmcRelease } | null> => {
      try {
        return { filing, rel: parseEarningsRelease(await sec.fetchRelease(cik, filing.accn), filing.periodEnd) };
      } catch (e) {
        failed.push(`${ticker} 财报稿 ${filing.periodEnd}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };

    const toWrite: Array<{ filing: FsFiling; rel: TsmcRelease }> = [];
    for (const f of pending) {
      const p = await parse(f);
      if (p) toWrite.push(p);
    }

    // 比对那一份只用来核对,不落库。
    if (verify) {
      const v = await parse(verify);
      if (v) failed.push(...divergences(statements, extractFundamentals(ticker, releaseToCompanyFacts([v])), ticker));
    }

    return {
      rows: toWrite.length ? extractFundamentals(ticker, releaseToCompanyFacts(toWrite)) : [],
      // 水位要算进财报稿:否则下一季的财报稿(比上一季报表新)会被 skip 判据挡住,
      // 白等到那一季的报表出来 —— T+16 这条就等于没接。
      latestFiled: releases.at(-1)!.filed,
      checked: verify?.periodEnd ?? null,
    };
  } catch (e) {
    failed.push(`${ticker} 财报稿兜底整体失败(毛利率会退回 T+45): ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}

/** 同一 (期末, 科目) 上两条来源的值差得超过容差 → 报出来。财报稿只精确到百万,故容差不能为 0。 */
function divergences(fromStatements: SecFundamentalRow[], fromRelease: SecFundamentalRow[], ticker: string): string[] {
  const byKey = new Map(fromStatements.map((r) => [`${r.periodEnd}:${r.concept}`, r.value]));

  return fromRelease.flatMap((r) => {
    const other = byKey.get(`${r.periodEnd}:${r.concept}`);
    if (other === undefined || other === 0) return [];

    const rel = Math.abs(r.value - other) / Math.abs(other);
    return rel > DIVERGENCE_TOLERANCE
      ? [
          `${ticker}: ${r.periodEnd} 的 ${r.concept} 两条来源差 ${(rel * 100).toFixed(1)}% ` +
            `(财报稿 ${r.value} vs 合并报表 ${other})—— 可能是重述,或财报稿那张表的列/单位变了`,
        ]
      : [];
  });
}

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

      // 水位要比**两条路的最新申报**(报表 + 财报稿)。只比报表的话,新一季的财报稿
      // (07-16)比上一季报表(05-15)新却会被判成「没更新」,T+16 那条就等于没接。
      const releases = await sec.listEarningsReleases(cik).catch(() => [] as FsFiling[]);
      const remoteFiled = [filings.at(-1)!.filed, releases.at(-1)?.filed].filter(Boolean).sort().at(-1)!;
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

      // 财报稿兜底:把毛利率从 T+45 提到 T+16(只补报表空白处 + 顺手校验一份,见 releaseFallback)。
      const rel = await releaseFallback(sec, cik, ticker, rows, failed);
      const all = [...rows, ...rel.rows];

      insertSecFundamentals(db, all);
      rowsWritten += all.length;

      const advanced = (getLatestSecFiled(db, ticker) ?? '') >= remoteFiled;
      if (!advanced) {
        failed.push(`${ticker}: 拉到了 ${parsed.length} 份但水位没推到 ${remoteFiled}(差分可能全被跨年规则挡住)`);
        continue;
      }

      const relNote = rel.rows.length ? `,财报稿补 ${rel.rows.length} 行(最新 ${releases.at(-1)?.periodEnd})` : '';
      fetched.push(
        `${ticker}(报表 ${parsed.length} 份 → ${rows.length} 行${relNote}${rel.checked ? `,已对 ${rel.checked}` : ''})`,
      );
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
