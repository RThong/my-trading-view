import type { Database } from 'bun:sqlite';
import { insertSecFundamentals, getLatestSecFiled, type SecFundamentalRow } from '../storage/repository';
import {
  createTsmcFetcher,
  parseEarningsRelease,
  parseTsmcReport,
  releaseToCompanyFacts,
  toCompanyFacts,
  type TsmcRelease,
} from '../fetchers/tsmcReports';
import { ASML_SCALE, createAsmlFetcher, parseAsmlReport } from '../fetchers/asmlReports';
import { toCompanyFacts as packFacts, type FsFiling, type Sec6kValues } from '../fetchers/sec6k';
import type { CompanyFacts } from '../analytics/secFundamentals';
import { extractFundamentals } from '../analytics/secFundamentals';
import { writeDerivedSecSeries } from './secFundamentals';
import { activeBySource, activeInSecTable, sec6kCikOf } from '../../shared/aiChain';

/**
 * sec6k 源:外国私人发行人(FPI)交给 EDGAR 的**季报 6-K** → 四科目 → 落 `sec_fundamentals`
 * (与 companyfacts 那条同一张表、同一套派生),所以面板上它们和别家长得一样,只是币种不同。
 *
 * 为什么非走这条不可:FPI 豁免 10-Q,季报以 6-K 形式提交且**不强制 XBRL 标记** ——
 * 实测 TSM 13 份季报 6-K 里 0 份带 XBRL,ASML 46 份里 0 份。companyfacts 因此只有年频。
 *
 * **各家的文档命名与报表措辞都不同**,故解析器一家一个,这里用 ADAPTERS 查表分派。
 * 加一家的动作:写它的解析器 → 在 ADAPTERS 补一行 → 名单里给它 `sources: ['sec6k']`。
 *
 * **必须整段重算而不是只拉新的一期**:累计口径那家(TSM)的单季值靠相邻两期相减,
 * 而 extractFundamentals 是对**整批 facts** 做差分的。好在这个源可回填、总量只有几十份。
 *
 * 跳过判据:远端最新一份的 filed <= 库里该 ticker 的 MAX(filed) → 没新季报,零请求正文。
 */

/**
 * 一家的 6-K 适配器。**只有这三件事因家而异**:哪些申报算季报、正文怎么取、怎么解析;
 * 期间口径与单位的差别收在 toFacts 里(见 sec6k 的 PeriodBasis)。
 *
 * quickPatch 是可选的更快补充源(目前只有 TSM:财报稿 T+16 对报表 T+45)。拆成
 * **listFilings + apply 两半**是因为水位判定要在 skip 之前、解析要在 skip 之后 ——
 * 合成一个函数就得把清单拉两遍,而且循环里会写死某一家的 fetcher(抽象直接漏)。
 */
type Sec6kAdapter = {
  listFilings: (cik: string) => Promise<FsFiling[]>;
  parseFiling: (cik: string, f: FsFiling) => Promise<Sec6kValues>;
  toFacts: (rows: Array<{ filing: FsFiling; values: Sec6kValues }>) => CompanyFacts;
  quickPatch?: {
    listFilings: (cik: string) => Promise<FsFiling[]>;
    apply: (ctx: QuickPatchCtx) => Promise<{ rows: SecFundamentalRow[]; checked: string | null }>;
  };
};

type QuickPatchCtx = {
  cik: string;
  ticker: string;
  /** 本轮**解析成功**的报表行。只用来做值比对(有值才比得了)。 */
  statements: SecFundamentalRow[];
  /** 远端**存在报表**的期末全集。占位判据用它,不用 statements —— 见 releaseFallback 的说明。 */
  statementPeriods: Set<string>;
  /**
   * 补充源的申报清单;**null = 这一轮压根没拉到**(与「拉到了但是空的」是两回事,
   * 诊断方向完全不同:前者是网络/接口问题,后者才是封面命名可能变了)。
   * 由水位那一步拉好后传进来 —— apply 内部**不再拉一遍**
   * (也因此循环里不必写死某一家的 fetcher)。
   * ponytail: 补充源与报表两条 listQuarterly6K 仍各拉一次同一份 submissions JSON
   * (几百 KB、一天一次、只有 TSM 有补充源)。真要省就让 listQuarterly6K 一次吃多个 pattern;
   * 别用模块级缓存 —— 那会在测试之间串味,也让注入的 doFetch 桩失效。
   */
  filings: FsFiling[] | null;
  failed: string[];
};

export type Sec6kResult = {
  fetched: string[];
  skipped: string[];
  failed: string[];
  rowsWritten: number;
  seriesWritten: number;
};

const tsmc = createTsmcFetcher();
const asml = createAsmlFetcher();

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
 * ⚠️ 「哪些季度算报表已覆盖」必须按**远端存在哪些报表**判(statementPeriods),
 * 不能按「本轮解析成功的行」判。单份报表解析失败是被容忍的(见主循环的 badly),
 * 若拿本轮结果当判据,那一季就会重新落进 pending → 财报稿行按主键 upsert 回去
 * → **未核阅的管理层数覆盖掉已核阅的报表值**,而且静默(failed 里只说「N 份没解析出来」)。
 * 报表存在就归报表管;这一轮没解析出来就保持库里原样,不由财报稿顶上。
 *
 * 拉不到不算失败:它是加速手段,少了只是慢回 T+45,不该让整轮变红。
 */
async function releaseFallback({
  cik,
  ticker,
  statements,
  statementPeriods,
  filings: releases,
  failed,
}: QuickPatchCtx): Promise<{ rows: SecFundamentalRow[]; checked: string | null }> {
  const empty = { rows: [], checked: null };
  try {
    // null = 清单压根没拉到,上游已经记过 failed(网络/接口),别在这里再补一条把人引去查命名。
    if (releases === null) return empty;

    // 拉到了却是空的 ≠ 正常。TSM 每季必发,而挑选判据(TSM_RELEASE_DOC)是**精确文件名**,
    // 比主源那个前缀正则脆得多 —— 封面一改名就变成空列表,毛利率静默退回 T+45,
    // 连 B4 那条「拿财报稿和已核阅季度比对」的守卫也一并停摆,而 job 全程绿灯。比照主源记 failed。
    if (releases.length === 0) {
      failed.push(`${ticker}: 一份财报稿 6-K 都没挑出来(封面命名可能变了)—— 毛利率退回报表时效,比对守卫停摆`);
      return empty;
    }

    const pending = releases.filter((f) => !statementPeriods.has(f.periodEnd));
    // 校验样本:最近一个**本轮真的解析出报表行**的季度 —— 没有值就无从比对。
    const comparable = new Set(statements.map((r) => r.periodEnd));
    const verify = releases.filter((f) => comparable.has(f.periodEnd)).at(-1);

    const parse = async (filing: FsFiling): Promise<{ filing: FsFiling; rel: TsmcRelease } | null> => {
      try {
        return { filing, rel: parseEarningsRelease(await tsmc.fetchRelease(cik, filing.accn), filing.periodEnd) };
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

    // 比对那一份只用来核对,不落库。解析失败上面已记 failed —— 此时 checked 必须留 null,
    // 否则日志会拼出「已对 2026-06-30」,声称做过一次实际没做的比对。
    const verified = verify ? await parse(verify) : null;
    if (verified) {
      failed.push(...divergences(statements, extractFundamentals(ticker, releaseToCompanyFacts([verified])), ticker));
    }

    return {
      rows: toWrite.length ? extractFundamentals(ticker, releaseToCompanyFacts(toWrite)) : [],
      checked: verified ? verify!.periodEnd : null,
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

/**
 * ticker → 它那一家的 6-K 适配器。查表而非分支:名单里声明了 sec6k 却漏写解析器时,
 * 上面的循环会立刻报「ADAPTERS 里没有它」,而不是静默不出数据。
 */
const ADAPTERS: Record<string, Sec6kAdapter> = {
  TSM: {
    listFilings: (cik) => tsmc.listFsFilings(cik),
    parseFiling: async (cik, f) => parseTsmcReport(await tsmc.fetchReport(cik, f.accn)),
    // 累计口径:报表只给年初至今,单季由 toQuarters 相邻相减还原。单位千元新台币。
    toFacts: (rows) => toCompanyFacts(rows.map(({ filing, values }) => ({ filing, ytd: values }))),
    quickPatch: { listFilings: (cik) => tsmc.listEarningsReleases(cik), apply: releaseFallback },
  },
  ASML: {
    listFilings: (cik) => asml.listFilings(cik),
    parseFiling: async (cik, f) => parseAsmlReport(await asml.fetchReport(cik, f.accn)),
    // 季度口径:报表直接给单季(那一列),不进差分。单位百万欧元。
    toFacts: (rows) => packFacts(rows, 'quarter', ASML_SCALE),
  },
};

export async function updateSec6kReports(
  db: Database,
  // adapters 只为测试留口:真实解析器要打网络,测试换成桩。
  opts: { tickers?: string[]; force?: boolean; adapters?: Record<string, Sec6kAdapter> } = {},
): Promise<Sec6kResult> {
  const tickers = opts.tickers ?? activeBySource('sec6k');

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

    const adapter = (opts.adapters ?? ADAPTERS)[ticker];
    // 名单声明了 sec6k 却没写解析器 = 配置错误,不是数据源故障,要立刻可见。
    if (!adapter) {
      failed.push(`${ticker}: 声明了 sec6k 源但 ADAPTERS 里没有它的解析器`);
      continue;
    }

    try {
      const filings = await adapter.listFilings(cik);
      // 一份都没有 ≠ 正常跳过:这几家每季必交,拿不到说明 submissions 结构或命名约定变了。
      if (filings.length === 0) {
        failed.push(`${ticker}: submissions 里找不到季报 6-K(命名约定可能变了),未拉正文`);
        continue;
      }

      // 水位要比**所有能带来新数据的申报**。TSM 还有财报稿那一路,只比报表的话,
      // 新一季的财报稿(07-16)比上一季报表(05-15)新却会被判成「没更新」,T+16 就等于没接。
      // 清单拉不到必须记 failed:吞掉的话这一路会静默退回报表时效,而这一轮照样记 success。
      // null = 没拉到(下面已记 failed);[] = 拉到了但一份都没挑出来 —— 两种诊断方向不同,
      // 别合成一个值,否则网络抖动会被下游再报一条「封面命名可能变了」,把人引错方向。
      let patchFilings: FsFiling[] | null = null;
      if (adapter.quickPatch) {
        try {
          patchFilings = await adapter.quickPatch.listFilings(cik);
        } catch (e) {
          failed.push(
            `${ticker}: 补充源申报清单拉不到(毛利率退回报表时效): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const remoteFiled = [filings.at(-1)!.filed, patchFilings?.at(-1)?.filed].filter(Boolean).sort().at(-1)!;
      const localFiled = getLatestSecFiled(db, ticker);
      if (!opts.force && localFiled && remoteFiled <= localFiled) {
        skipped.push(ticker);
        continue;
      }

      // 逐份串行拉正文:TSM 那份 4MB 级,并发没意义而且 SEC 限速 10 req/s。
      const parsed: Array<{ filing: FsFiling; values: Sec6kValues }> = [];
      const badly: string[] = [];
      for (const filing of filings) {
        try {
          parsed.push({ filing, values: await adapter.parseFiling(cik, filing) });
        } catch (e) {
          // 单份解析失败不该让整段作废(老报告的排版可能不同)——记下来,其余照常算。
          badly.push(`${filing.periodEnd}(${e instanceof Error ? e.message : String(e)})`);
        }
      }
      if (badly.length) failed.push(`${ticker}: ${badly.length}/${filings.length} 份没解析出来 —— ${badly.join('; ')}`);
      if (parsed.length === 0) {
        failed.push(`${ticker}: 一份都没解析出来,水位不前进 → 下次仍会重拉`);
        continue;
      }

      const rows = extractFundamentals(ticker, adapter.toFacts(parsed));

      // 可选的更快补充源(TSM 的财报稿:把毛利率从 T+45 提到 T+16)。
      const patch = adapter.quickPatch
        ? await adapter.quickPatch.apply({
            cik,
            ticker,
            statements: rows,
            // 远端存在报表的期末全集 —— 含本轮解析失败的那几季,它们仍归报表管。
            statementPeriods: new Set(filings.map((f) => f.periodEnd)),
            filings: patchFilings,
            failed,
          })
        : { rows: [] as SecFundamentalRow[], checked: null };
      const all = [...rows, ...patch.rows];

      insertSecFundamentals(db, all);
      rowsWritten += all.length;

      const advanced = (getLatestSecFiled(db, ticker) ?? '') >= remoteFiled;
      if (!advanced) {
        failed.push(`${ticker}: 拉到了 ${parsed.length} 份但水位没推到 ${remoteFiled}(差分可能全被跨年规则挡住)`);
        continue;
      }

      const patchNote = patch.rows.length ? `,补充源 ${patch.rows.length} 行` : '';
      fetched.push(
        `${ticker}(${parsed.length} 份 → ${rows.length} 行${patchNote}${patch.checked ? `,已对 ${patch.checked}` : ''},最新 ${filings.at(-1)!.periodEnd})`,
      );
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 派生量与 companyfacts 那侧共用一套:范围是**落在 sec_fundamentals 表里的全部启用标的**,
  // 不只是本轮抓的那家 —— 否则单跑 TSM 时它的 TTM/毛利率线永远不出。
  const { written, problems } = writeDerivedSecSeries(db, activeInSecTable(), tickers);
  // **只收 sec6k 这几家的体检结论**:companyfacts 那侧(MSFT/ORCL…)的问题各有自己那条 job_run,
  // 混进来会让两盏灯长期同时黄 —— 而体检按设计每轮复发,黄起来就不会自己灭。
  const mine = new Set(activeBySource('sec6k'));
  failed.push(...problems.filter((p) => mine.has(p.ticker)).map((p) => p.message));

  return { fetched, skipped, failed, rowsWritten, seriesWritten: written };
}
