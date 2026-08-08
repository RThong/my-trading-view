import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertSecFundamentals, getSecFundamentals } from '../storage/repository';
import { createSecFetcher } from '../fetchers/secXbrl';
import {
  CONCEPTS,
  extractFundamentals,
  mergeFacts,
  parseXbrlInstance,
  type CompanyFacts,
  type Concept,
  type ExtensionMap,
} from '../analytics/secFundamentals';
import { ACTIVE_TICKERS, cikOf, extensionTags } from '../../shared/aiChain';

/**
 * **一次性回填**:companyfacts 缺的那几期,直接去读原始申报实例补。
 *
 * 为什么必须单独一个入口、不并进日常 job:
 *  · 病因是 `source_capability_gap` —— 公司拿**自定义(extension)概念**报的那几期,
 *    companyfacts 不聚合、直接消失且不报错(实测 NVDA FY2023 的 capex 标成
 *    `nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets`,FY2024 才换回 us-gaap)。
 *  · 这是**历史事实**,补一次就好。日常 job 每轮为几十份历史申报各拉 1~2MB 实例不划算,
 *    而且稳态下它本该是零请求(见 secFundamentals 的水位判据)。
 *
 * 后果值得补:NVDA 是这条链的中心标的,却因 FY2023 三个季度没有 capex 而 TTM 凑不满四季 →
 * 整段作废 → 再被断档裁剪砍掉,capex/FCF 线只剩 11 点(MSFT 有 69)。
 *
 * 只拉**真的缺**的那几份:按 submissions 的 reportDate 与库里已有期末比,缺才拉。
 * NVDA 实测因此只多打 2~3 个请求,不是几十个。
 *
 * 直接运行:bun run src/server/jobs/secBackfillInstances.ts NVDA [MORE...]
 */

export type BackfillResult = {
  ticker: string;
  /** 拉了哪几份实例(reportDate) */
  pulled: string[];
  /** 回填后新增/更新的行数 */
  rowsWritten: number;
  /** 补上之后仍然缺的科目期(说明这几期连实例里也没有) */
  stillMissing: string[];
  /** 缺口期在 submissions.recent 里找不到对应申报 —— 够不到那么早,不是补不了 */
  unreachable: string[];
  failed: string[];
};

type Fetcher = ReturnType<typeof createSecFetcher>;

/** ticker 的 extension 映射:元素全名 → 落到链里哪个 tag。 */
function extensionsFor(ticker: string): ExtensionMap {
  // capex 的 extension 借用链首那个 tag 名 —— 落库后 tag_used 显示它,真溯源看同行的 accn。
  const CANONICAL: Record<Concept, string> = {
    revenue: 'Revenues',
    cogs: 'CostOfRevenue',
    ocf: 'NetCashProvidedByUsedInOperatingActivities',
    capex: 'PaymentsToAcquirePropertyPlantAndEquipment',
  };

  return Object.fromEntries(
    CONCEPTS.flatMap((c) => extensionTags(ticker, c).map((element) => [element, CANONICAL[c]] as const)),
  );
}

export async function backfillFromInstances(
  db: Database,
  ticker: string,
  opts: { fetcher?: Fetcher; limit?: number } = {},
): Promise<BackfillResult> {
  const sec = opts.fetcher ?? createSecFetcher();
  const cik = cikOf(ticker);
  const pulled: string[] = [];
  const failed: string[] = [];

  if (!cik) {
    return {
      ticker,
      pulled,
      rowsWritten: 0,
      stillMissing: [],
      unreachable: [],
      failed: [`${ticker}: 不走 companyfacts 源`],
    };
  }

  const filings = await sec.periodicFilings(cik);
  const facts = await sec.companyFacts(cik);

  // 缺口 = 某个期末上,别的科目有行而这个科目没有。只对**这些**期末对应的申报拉实例。
  const rows = getSecFundamentals(db, ticker);
  const have = new Set(rows.map((r) => `${r.periodEnd}.${r.concept}`));
  const periods = [...new Set(rows.map((r) => r.periodEnd))];
  const holes = new Set(periods.filter((p) => CONCEPTS.some((c) => !have.has(`${p}.${c}`))));

  // 一份申报的 reportDate 就是它的期末;缺口期对应的那几份才值得拉(实例 1~2MB)。
  const wanted = filings.filter((f) => holes.has(f.periodEnd)).slice(-(opts.limit ?? 12));

  // ponytail: submissions 的 `filings.recent` 只装最近约 1000 条,**申报频繁的公司够不到早年**。
  // 实测 AMZN 的缺口在 2017-06-30,而它的 recent 到不了那么早 → 这里报「没有对应申报」而不是
  // 静默当作补不了。要够到更早得再读 `filings.files[]` 里那几个分页 JSON,为一个季度不值得;
  // 哪天买方合计线要往 2015 年推(现在起点 2018-06-30)再做。
  const covered = new Set(filings.map((f) => f.periodEnd));
  const unreachable = [...holes].filter((p) => !covered.has(p)).sort();

  const patches: CompanyFacts[] = [];
  for (const f of wanted) {
    try {
      const xml = await sec.filingInstance(cik, f.accn);
      patches.push(parseXbrlInstance(xml, { accn: f.accn, form: f.form, filed: f.filed }, extensionsFor(ticker)));
      pulled.push(f.periodEnd);
    } catch (e) {
      failed.push(`${ticker} ${f.periodEnd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // **必须与 companyfacts 合并再算**:实例多数只给累计,单季靠差分 —— 减掉的上一期在 companyfacts 里。
  const all = extractFundamentals(ticker, mergeFacts(facts, ...patches));
  insertSecFundamentals(db, all);

  const after = getSecFundamentals(db, ticker);
  const now = new Set(after.map((r) => `${r.periodEnd}.${r.concept}`));
  const stillMissing = [...new Set(after.map((r) => r.periodEnd))]
    .flatMap((p) => CONCEPTS.filter((c) => !now.has(`${p}.${c}`)).map((c) => `${p}.${c}`))
    .sort();

  return { ticker, pulled, rowsWritten: all.length, stillMissing, unreachable, failed };
}

if (import.meta.main) {
  const tickers = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!tickers.length) throw new Error('用法:bun run src/server/jobs/secBackfillInstances.ts TICKER [TICKER...]');

  const unknown = tickers.filter((t) => !ACTIVE_TICKERS.includes(t));
  if (unknown.length) throw new Error(`未启用或不存在的 ticker: ${unknown.join(', ')}`);

  const db = openDb();
  migrate(db);
  try {
    for (const t of tickers) {
      const r = await backfillFromInstances(db, t);
      console.log(
        `${r.ticker}: 拉了 ${r.pulled.length} 份实例 [${r.pulled}] → ${r.rowsWritten} 行;` +
          `仍缺 ${r.stillMissing.length} 处${r.stillMissing.length ? ` [${r.stillMissing.slice(0, 8)}…]` : ''}` +
          `${r.unreachable.length ? `;其中 ${r.unreachable.length} 处够不到(submissions.recent 装不下那么早)[${r.unreachable}]` : ''}` +
          `${r.failed.length ? ` 失败 [${r.failed}]` : ''}`,
      );
    }
    // 回填改的是原始行,派生序列要重算才看得见 —— 跑一次日常 job(会全 skip 但仍复算派生)。
    console.log('\n完成。派生序列需重算:bun run src/server/jobs/aiChainFundamentals.ts');
  } finally {
    db.close();
  }
}
