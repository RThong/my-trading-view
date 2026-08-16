import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertSecFundamentals, getSecFundamentals } from '../storage/repository';
import { createSecFetcher } from '../fetchers/secXbrl';
import {
  CONCEPTS,
  extractFundamentals,
  mergeFacts,
  parseXbrlInstance,
  segmentCumulativeFill,
  type CompanyFacts,
  type Concept,
  type CoreConcept,
  type ExtensionMap,
} from '../analytics/secFundamentals';
import { ACTIVE_TICKERS, cikOf, extensionTags, segmentFactsOf } from '../../shared/aiChain';

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
  const CANONICAL: Record<CoreConcept, string> = {
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

  /**
   * 某个期末该有哪些科目。四个合并科目**每期都该有**;分部科目只从它开始披露那一期起才该有
   * (见 SEGMENT_FACTS.from)。
   *
   * ⚠️ 不带这个下界的话回填工具**永不收敛**:GOOGL 库里 48 个期末,2019-12-31 及更早的 22 个
   * 永远拿不到 cloudRev(那时 Cloud 还没单列)。它们会被算成缺口 → 每轮都去拉对应的十几份实例
   * (1~3MB 一份)→ 对这一档一行贡献都没有 → 下一轮原样再拉一遍,而 `stillMissing` 恒 ≥ 22。
   * 这正是本仓库反复在避的「永久黄灯 + 每轮白拉」形态。
   */
  const conceptsAt = (periodEnd: string): Concept[] => [
    ...CONCEPTS,
    ...segmentFactsOf(ticker).flatMap((s) => (periodEnd >= s.from ? [s.concept] : [])),
  ];

  // 缺口 = 某个期末上,别的科目有行而这个科目没有。只对**这些**期末对应的申报拉实例。
  const rows = getSecFundamentals(db, ticker);
  const have = new Set(rows.map((r) => `${r.periodEnd}.${r.concept}`));
  const periods = [...new Set(rows.map((r) => r.periodEnd))];
  const holes = new Set(periods.filter((p) => conceptsAt(p).some((c) => !have.has(`${p}.${c}`))));

  // 一份申报的 reportDate 就是它的期末;缺口期对应的那几份才值得拉(实例 1~2MB)。
  //
  // ⚠️ 这个「缺口期 → 同期末那份申报」的映射对**分部起点那几季不成立**:实测 GOOGL 的
  // 2020Q1~Q3 cloudRev 全部来自**次年同季 10-Q 的比较期**(2020 年那三份自己还没把 Cloud
  // 放上分部轴)。默认 12 与推荐的 24 都能让「次年那几份」落在同一批里,所以照样补得上;
  // 但 `--limit` 小到把两者切开时,最早那两三季会永远补不上。别为省几份实例把它调得太小。
  const wanted = filings.filter((f) => holes.has(f.periodEnd)).slice(-(opts.limit ?? 12));

  // 够不到的期:periodicFilings 已经把 `filings.files[]` 分页也读了(实测 GOOGL 的分页覆盖
  // 2015-10 起),所以剩下的是**真的早于 SEC 分页覆盖范围**的那些 —— 报出来而不是静默当作补不了。
  const covered = new Set(filings.map((f) => f.periodEnd));
  const unreachable = [...holes].filter((p) => !covered.has(p)).sort();

  const patches: CompanyFacts[] = [];
  for (const f of wanted) {
    try {
      const xml = await sec.filingInstance(cik, f.accn);
      const meta = { accn: f.accn, form: f.form, filed: f.filed };
      patches.push(parseXbrlInstance(xml, meta, extensionsFor(ticker), segmentFactsOf(ticker)));
      pulled.push(f.periodEnd);
    } catch (e) {
      failed.push(`${ticker} ${f.periodEnd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // **必须与 companyfacts 合并再算**:实例多数只给累计,单季靠差分 —— 减掉的上一期在 companyfacts 里。
  // 分部科目还要多一步:10-K 只给全年,减掉的 9M 只在上一份 10-Q 的实例里,
  // 而这一批若没同时拉到那一份(--limit 切在中间 / Q3 早就补齐、不在缺口里了)就补不出 Q4。
  // 用库里已有的单季行把那条累计加回来,批次边界就不再影响结果。见 segmentCumulativeFill。
  const base = mergeFacts(facts, ...patches);
  const all = extractFundamentals(ticker, mergeFacts(base, segmentCumulativeFill(base, rows)));
  insertSecFundamentals(db, all);

  const after = getSecFundamentals(db, ticker);
  const now = new Set(after.map((r) => `${r.periodEnd}.${r.concept}`));
  const stillMissing = [...new Set(after.map((r) => r.periodEnd))]
    .flatMap((p) =>
      conceptsAt(p)
        .filter((c) => !now.has(`${p}.${c}`))
        .map((c) => `${p}.${c}`),
    )
    .sort();

  return { ticker, pulled, rowsWritten: all.length, stillMissing, unreachable, failed };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const tickers = argv.filter((a) => !a.startsWith('--'));
  if (!tickers.length)
    throw new Error('用法:bun run src/server/jobs/secBackfillInstances.ts TICKER [TICKER...] [--limit=N]');

  // 默认 12 份实例够补 extension 那类零星缺口;**分部科目要的是全历史**(companyfacts 一期都没有),
  // 那种得显式加大,如 GOOGL 推到 2020Q1 要 --limit=24。
  //
  // 解析不出来就抛,**不退回默认值**:打错一个字符(`--limit=2O`)悄悄按 12 跑,现象与
  // 「SEC 没有更早的数据」一模一样 —— 你会以为历史只能到 2023,而实际只是少拉了十几份。
  const limitArg = argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit 要是正整数,收到 ${JSON.stringify(limitArg)}`);
  }

  const unknown = tickers.filter((t) => !ACTIVE_TICKERS.includes(t));
  if (unknown.length) throw new Error(`未启用或不存在的 ticker: ${unknown.join(', ')}`);

  const db = openDb();
  migrate(db);
  try {
    for (const t of tickers) {
      const r = await backfillFromInstances(db, t, { limit });
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
