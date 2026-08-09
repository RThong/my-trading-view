/**
 * SEC XBRL 财务事实 → 单季值 → TTM 派生量。纯函数,不碰网络/库(便于用真实 companyfacts 片段测)。
 *
 * 三个坑决定了这里的算法(都是实测出来的,不是理论):
 *
 * 1. **fallback 必须逐期做,不能逐 tag 做**。同一科目各家/各年换过 tag:NVDA 的
 *    `RevenueFromContractWithCustomerExcludingAssessedTax` 只覆盖 2017–2022(28 期),
 *    `Revenues` 才是全历史(276 期)。选定一个 tag 用到底 → 收入稀疏、和成本期间对不齐
 *    → 毛利率算出 87.5%(实际约 62%)。故按期间(start,end)逐个在 tag 链上取第一个有值的。
 *    实测重叠期两 tag 的值完全一致(NVDA 收入 22 期 0 差异、capex 3 期 0 差异),混用不会串口径。
 *
 * 2. **单季值有两条来源,不能只走 YTD 差分**。XBRL 里同时存在直接的单季行(~90d)和
 *    年初至今累计行(H 181d / 9M 272d / FY 363d)。利润表两者都报,现金流多数只报累计。
 *    故:直接单季行优先,缺的用「同 start 分组、按 end 排序、逐条减前一条」补。
 *
 * 3. **同一期间会被后续财报重报**(多个 accn)。按 (start,end) 去重取 filed 最大 = 取重述后的值。
 */

import type { SecFundamentalRow } from '../storage/repository';
import type { Point } from './regime';

export type { Point };

export type Concept = 'revenue' | 'cogs' | 'ocf' | 'capex';
export type FactRow = {
  start?: string;
  end: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
  frame?: string;
};

export type CompanyFacts = {
  facts?: { 'us-gaap'?: Record<string, { units?: Record<string, FactRow[]> }> };
};

/**
 * 各科目的 tag 候选链。**链序 = 口径优先级**(靠前的赢),合并规则见 collectPeriods。
 *
 * ⚠️ 为什么链序赢而不是 filed 赢:**filed 解决的是版本(重述),tag 解决的是经济口径**,
 * 两件事不能用一个比较器裁决。让 filed 跨 tag 竞争 = 让版本号去决定口径,实测会出错:
 * AMZN 的 FY2016 —— `PaymentsToAcquirePropertyPlantAndEquipment` 6.737B(filed 2017-02-10)
 * 对 `PaymentsToAcquireProductiveAssets` 7.804B(filed 2019-02-01),后者含自用软件/网站开发,
 * 是**另一个口径**而不是同一个数的新版本;按 filed 挑就会在序列中间悄悄换口径。
 * 版本问题在 periodsForTag 里(同 tag 内取 filed 最大)已经解决了。
 * 同期两 tag 值不一致 → 交给 tagConflicts 报出来,不在这里静默裁决。
 *
 * 排除的两档(都是七家实测一期都没用到、且是已知陷阱):
 *  · cogs 的 `CostOfGoodsSold`:不含服务成本(是子项,不是总额)。`CostOfGoodsAndServicesSold` 才是「货+服务」。
 *  · revenue 的 `RevenueFromContractWithCustomerIncludingAssessedTax`:含代收税款,会抬高毛利率的分母。
 *  · capex 的 `PaymentsToAcquireOtherPropertyPlantAndEquipment`:PP&E 里的「其他」子项,不是总额。
 *
 * 已知的同名不同义(靠 tagConflicts 兜住,别指望链序):`SalesRevenueNet` 对 AMZN 是总收入(185 期),
 * 对 ORCL 是个值近 0 的残项(17 期,对着 22B 的总收入)。所以它排在链末,`Revenues` 优先。
 *
 * ── 全量实测:链内每一对 tag 在重叠期间的差额(七家 × 四科目,21 组比较)────────────
 * 结论:**17 组差额恰好为 0** —— 那些 tag 切换只是改标签,不是换口径。剩 4 组有真差异,
 * 链序都裁对了。别再按 tag 字面去推「哪个更宽」,得量(NVDA 的 capex 就是反例:
 * 行文写成 "property and equipment and intangible assets",三个重叠期差额全为 0)。
 *
 * 4 组真差异:
 *  · AMZN capex,重叠 1 期(FY2016):6.737B vs 7.804B(+15.8%)。真差口径,见 CAPEX_SCOPE。
 *  · MSFT revenue,`RevenueFromContract…` vs `SalesRevenueNet`,重叠 10 期中 3 期不一致,
 *    最大 2017Q2:25.605B vs 23.317B(−8.9%)。这是 **ASC 606 重述前后两个会计基础**,
 *    链序取前者 = 取与今天可比的那个基础(2018 年后全是 606)。取 `SalesRevenueNet` 反而会
 *    在序列中间留下基础跳变。实测毛利率线在切换点(2016-12-31)无台阶(61.5→62.4→63.1→64.5,
 *    因为 cogs 同期也是重述基础)。**这正是「链序赢而非 filed 赢」的第二个证据**。
 *  · ORCL revenue,`Revenues` vs `RevenueFromContract…`,14 期中 5 期不一致,最大 −1.0%。同上,取前者。
 *  · ORCL revenue,`Revenues` vs `SalesRevenueNet`,14 期全不一致,最大 22.430B vs 0.000B —— 上面那个残项。
 *
 * 顺带证伪一个担心:`…ContinuingOperations` 那档(MU/MSFT/ORCL 都命中过)会不会漏掉终止经营?
 * 三家共 34 个重叠期,**差额全为 0** —— 这几家在这些期间没有终止经营,两个 tag 是同一个数。
 */
export const TAG_CHAINS: Record<Concept, string[]> = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
  cogs: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
  // ocf 取**总额优先**。这一条试过反过来排,更糟,记下来免得再试一遍:
  //
  // 动机是对齐 capex —— us-gaap 的 `PaymentsToAcquirePropertyPlantAndEquipment` 按构造只含持续经营
  // (终止经营那部分走公司自定义 extension)。实测 AMD H1 2025:OCF 总额 2.950B =
  // 持续 2.401B + 终止 0.549B;capex(us-gaap)0.494B,另有
  // amd:PaymentsToAcquirePropertyPlantAndEquipmentFromDiscontinuedOperation 0.022B。
  // 所以「总额 OCF − 持续经营 capex」确实把终止经营的经营现金流白算进了 FCF(FY2025 共 1.216B)。
  //
  // 但**把持续经营排到前面会更糟**:那个 tag 是「有终止经营才报」,报得不全 ——
  // AMD 的 Q1(2024-12-29~2025-03-29)只有总额 0.939B,没有持续经营那一行。逐期 fallback
  // 于是给 Q1 取总额、给 H1 取持续经营,差分出 2.401 − 0.939 = 1.462B,**两条腿基础不同**,
  // 正是本文件开头警告的「在序列中间悄悄换口径」。宁可整条线一致地偏一点,不要中间换基础。
  //
  // 结论:统一用总额,把偏差当**已量化的口径说明**处理(见 COMPANY_NOTES.AMD)。
  // 盲区:某家有终止经营时,它的 FCF 会虚高「终止经营的经营现金流」那一块。AMD 是卖方、
  // FCF 是配角格,影响有限;哪天**买方**出现终止经营(会进合计线),得在这里重新决策。
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
};

/**
 * capex 两档不是同义词,是两个口径 —— 跨公司比 capex / FCF 绝对值时必须知道用的哪个:
 *  · ppe:纯有形固定资产的现金购买(MU / MSFT / ORCL / GOOGL / META)。
 *  · productive_assets:PP&E + 软件及其他无形资产(AMZN 含自用软件/网站开发)。
 *
 * **两档的实际差额靠重叠期量,不靠字面**(两家换 tag 时都留了重叠期,实测结论相反):
 *  · AMZN 换于 2017,唯一重叠期 FY2016:ppe 6.737B vs productive 7.804B → **+15.8%**,真差口径。
 *  · NVDA 换于 2020,三个重叠期(2019-10-27 / 2020-04-26 / 2020-07-26)**差额全为 0** ——
 *    它只是改了标签(行文写成 "property and equipment and intangible assets"),数没变。
 *    所以别按字面认定「NVDA 这档更宽」。
 *
 * 换 tag 那一刻会在序列里留断口,但**两家的断口都已被 trailingContiguous 裁在可见段之外**
 * (AMZN 可见段自 2018-06-30 起,换 tag 前后中间还缺了四个季度)。
 *
 * 拆不开:`PaymentsToAcquireIntangibleAssets` 七家实测一期都没有;AMZN 2026Q2 的实例里也没有任何
 * 自用软件分项(只有 `amzn:VideoAndMusicContentCapitalizedCosts` 与
 * `amzn:ProceedsFromPropertyPlantAndEquipmentSalesAndIncentives` 两个 extension)
 * → 减不出纯 PP&E,那 +15.8% 也无法更新到今天。
 */
export type CapexScope = 'ppe' | 'productive_assets';
const CAPEX_SCOPE: Record<string, CapexScope> = {
  PaymentsToAcquirePropertyPlantAndEquipment: 'ppe',
  PaymentsToAcquireProductiveAssets: 'productive_assets',
};
export const capexScopeOf = (tagUsed: string): CapexScope | undefined => CAPEX_SCOPE[tagUsed];

/** 四个科目缺一个就算不出 FCF(ocf−capex)或毛利率((revenue−cogs)/revenue)。job 的完整性守卫用。
 *  从 TAG_CHAINS 的键派生而非手写:加第 5 个科目时漏改会变成「静默不抽取」,正是要防的那类错。 */
export const CONCEPTS = Object.keys(TAG_CHAINS) as Concept[];

/**
 * 定期报告。三类:
 *  · `10-Q` / `10-K` —— 美国本土申报人的季/年报。
 *  · **修订件 `/A`** —— 重述的载体。丢掉它,「同 tag 内取 filed 最大 = 取重述后的值」
 *    那条规则就只覆盖了一半:公司通过 10-Q/A 改数时,库里留下的仍是作废的原始值。
 *  · **`6-K` / `20-F`** —— 外国私人发行人(FPI)的季报与年报。多数 FPI **不给 6-K 做 XBRL 标记**
 *    (实测 TSM 13 份、ASML 46 份里都是 0,所以那两家只能解析 HTML),但**有的做**:
 *    ARM 的 6-K 是完整 inline XBRL,SEC 也聚合进了 companyfacts,90/91 天的单季跨度都在。
 *    不放开这一档,那种公司抽出来是 0 行 —— 而且是**静默的** 0。
 *    20-F 一并放开:FPI 的 Q4 要靠「全年 − 9M」差分还原,少了它每年缺一个季度。
 *
 * 放开 6-K 对本土申报人零影响:它们不交 6-K。8-K 仍然挡着(那是事件报告,
 * 里面的数常是未经核阅的初步值)。
 */
const isPeriodicForm = (form: string): boolean => /^(10-[QK](\/A)?|20-F(\/A)?|6-K)$/.test(form);
const DAY_MS = 86_400_000;

const durationDays = (start: string, end: string): number => (Date.parse(end) - Date.parse(start)) / DAY_MS;

/** 一个季度 80~100 天(13~14 周,各家财年周历不同)。YTD 各档为 181 / 272 / 363,差分后同样落这个区间。 */
const isQuarterLength = (d: number): boolean => d >= 80 && d <= 100;

type Period = { start: string; end: string; val: number; tag: string; form: string; accn: string; filed: string };

/** 单个 tag 的期间表:只留定期报告(见 isPeriodicForm)+ USD + 有 start(时点值无 start,如资产负债表科目),同期间取 filed 最大。 */
function periodsForTag(facts: CompanyFacts, tag: string): Map<string, Period> {
  const rows = facts.facts?.['us-gaap']?.[tag]?.units?.USD ?? [];
  const out = new Map<string, Period>();

  for (const r of rows) {
    if (!r.start || !isPeriodicForm(r.form)) continue;

    const key = `${r.start}~${r.end}`;
    const prior = out.get(key);
    if (prior && prior.filed >= r.filed) continue; // 重述:保留 filed 最新的一条

    out.set(key, { start: r.start, end: r.end, val: r.val, tag, form: r.form, accn: r.accn, filed: r.filed });
  }

  return out;
}

/**
 * 逐期 fallback:某期间由链里**最靠前的、有值的**那个 tag 提供(链序 = 口径优先级,见 TAG_CHAINS)。
 * 版本/重述已在 periodsForTag 里按 filed 解决;这里只裁决口径,filed 不参与。
 */
export function collectPeriods(facts: CompanyFacts, tags: string[]): Period[] {
  const merged = new Map<string, Period>();

  for (const tag of tags) {
    for (const [key, p] of periodsForTag(facts, tag)) {
      if (!merged.has(key)) merged.set(key, p); // 靠前的先占位,后面的只填空缺
    }
  }

  return [...merged.values()].sort((a, b) => a.end.localeCompare(b.end));
}

export type TagConflict = { concept: Concept; period: string; a: Period; b: Period };

/** 冲突只看最近这么多个季度:更早的属于考古,报出来只会把真信号淹掉(实测 ORCL 有 17 期都在 2011 年前)。 */
const CONFLICT_WINDOW_QUARTERS = 8;

/**
 * 不报的 tag 对:**差额有确定含义、且链序已按含义裁决**,报出来只是噪声。
 * 这里只有一对:ocf 的「持续经营 vs 总额」——差额恒等于终止经营的经营现金流,不是「口径变了」。
 * 链序刻意取的是**总额**那档(见 TAG_CHAINS.ocf:持续经营那个 tag「有终止经营才报」,报不全,
 * 逐期 fallback 会在同一个差分组里换基础,更糟)。AMD 有终止经营,这一对会一直差,
 * 报了就是一盏两年不灭的黄灯(同 CAPEX_SCOPE_EXPECTED 的理由)。
 *
 * ⚠️ 只豁免这一对。其余任何两档不一致仍要报 —— 那些差额没有确定含义,必须有人去核报表原文。
 */
const CONFLICT_EXEMPT = new Set([
  'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations|NetCashProvidedByUsedInOperatingActivities',
]);

const exemptPair = (a: string, b: string) => CONFLICT_EXEMPT.has(`${a}|${b}`) || CONFLICT_EXEMPT.has(`${b}|${a}`);

/**
 * 同一期间被链里两个 tag 同时覆盖、**值还不一样** → 口径可能变了(或某档是子项 / 同名不同义),
 * 链序保证了我们取的是优先级高的那个,但这件事本身要报出来让人去核。
 *
 * 只能在抓取时对着原始 facts 做 —— 库里只存了赢的那个值,输的那个没留,事后查不出来。
 * 窗口相对「该公司最新期末」而不是相对今天:测试才有确定结果。
 */
export function tagConflicts(facts: CompanyFacts): TagConflict[] {
  const byConcept = CONCEPTS.map(
    (concept) => [concept, TAG_CHAINS[concept].map((t) => periodsForTag(facts, t))] as const,
  );

  const ends = byConcept.flatMap(([, maps]) => maps.flatMap((m) => [...m.values()].map((p) => p.end)));
  if (ends.length === 0) return [];

  const newest = ends.reduce((m, e) => (e > m ? e : m));
  const cutoff = new Date(Date.parse(newest) - CONFLICT_WINDOW_QUARTERS * 91 * DAY_MS).toISOString().slice(0, 10);

  return byConcept.flatMap(([concept, maps]) => {
    // 期间取**并集**:某家可能压根没有链首那个 tag(如 AMZN 没有 Revenues),
    // 只遍历 maps[0] 会漏掉后两档之间的冲突。
    const periods = [...new Set(maps.flatMap((m) => [...m.keys()]))];

    return periods.flatMap((period) => {
      // covering 按链序,故 [0] 就是我们实际取的那个值。
      const covering = maps.flatMap((m) => (m.has(period) ? [m.get(period)!] : []));
      const chosen = covering[0]!;
      const clash = covering.slice(1).find((p) => p.val !== chosen.val && !exemptPair(chosen.tag, p.tag));

      return clash && chosen.end >= cutoff ? [{ concept, period, a: chosen, b: clash }] : [];
    });
  });
}

// ── 融资租赁漏计守卫 ───────────────────────────────────────────────────────────

/**
 * 走**融资租赁**取得的产能,在 `ocf − capex` 里**完全不出现**:取得时是非现金交易(不进 capex),
 * 本金还款走筹资活动,只有利息进经营。所以同一笔资产改成租的,当年 FCF 就比买的好看一整笔,
 * 而且不是延后 —— 是永远不来。(经营租赁不同:付款全额走经营 → OCF 会吃掉 → FCF 迟早反映。)
 *
 * ⚠️ **必须用「新增 ROU」比 capex,不能用「本金支付」比** —— 这个陷阱掉过一次:
 * 本金支付只反映**旧租约**的现金流(MSFT 最近财年 31 亿),而这批租约是新签的、还没开始还;
 * 新增 ROU(246 亿)才是与年度 capex 同量纲的流量。拿存量的现金流去比流量,差一个数量级,
 * 会得出「只占 2.7%,是噪声」的错误结论。
 *
 * **为什么只报比例、不做成序列**(量过之后的结论,别再试):
 *  · 量级不翻符号 —— 最近一个财年五家买方合计约 358 亿(MSFT 246 + ORCL 49 + AMZN 40 +
 *    GOOGL 16 + META 6),对当时的买方合计 TTM FCF +1,259 亿,是按 −250 亿/季的斜率
 *    **把零轴穿越提前约 1.4 个季度**。这是口径说明的量级,不是判据失效的量级。
 *  · **数据画不出干净的线** —— ORCL 只有 FY 与 9M、**一个季度数都没有**;META 断在 2025-12-31。
 *    合计线要求每季每家都有点(见 aggregateFcf),做出来只能静默丢掉 ORCL,
 *    或者把年度点连成一条不存在的匀速线(同「折线只连点,断档必造假斜率」那条坑)。
 * 所以这里只做**偏离声明式**告警,量化结论写在面板文案(SEC_LEASE_CAVEAT)里。
 */
const FINANCE_LEASE_ADD_TAG = 'RightOfUseAssetObtainedInExchangeForFinanceLeaseLiability';

/** 一个财年 350~380 天(各家财年周历不同,52/53 周都有)。 */
const isFiscalYearLength = (d: number): boolean => d >= 350 && d <= 380;

/**
 * 最近一个完整财年的「融资租赁新增 ROU / 现金 capex」。任一方缺该财年 → undefined(不猜)。
 * 只在抓取时对着原始 facts 做:这个科目**不落库**(不做成序列,理由见上),事后查不出来。
 */
export function financeLeaseShare(facts: CompanyFacts): { fy: string; share: number } | undefined {
  const fiscalYears = (tags: string[]) =>
    collectPeriods(facts, tags).filter((p) => isFiscalYearLength(durationDays(p.start, p.end)));

  const latestLease = fiscalYears([FINANCE_LEASE_ADD_TAG]).at(-1);
  if (!latestLease) return undefined;

  // 必须**同一财年比同一财年**:两个不同期末的数相除得出的比例没有含义。
  const capex = fiscalYears(TAG_CHAINS.capex).find((p) => p.end === latestLease.end);
  if (!capex || capex.val === 0) return undefined;

  return { fy: latestLease.end, share: latestLease.val / capex.val };
}

/** 日历季度:取期间中点所在季度。NVDA 的 11 月~1 月财季中点在 12 月 → Q4,与 SEC 自己的 frame 口径一致。 */
export function calendarQuarter(start: string, end: string): string {
  const mid = new Date((Date.parse(start) + Date.parse(end)) / 2);
  return `${mid.getUTCFullYear()}Q${Math.floor(mid.getUTCMonth() / 3) + 1}`;
}

type QuarterFact = {
  periodEnd: string;
  value: number;
  tagUsed: string;
  form: string;
  accn: string;
  filed: string;
  fiscalQ: string;
};

/**
 * 期间表 → 单季序列。直接单季行优先;其余按同 start 分组差分补齐(YTD 累计还原成单季)。
 * 跨财年天然隔离——start 变了就是新的一组,不会把上一年的累计减进来。
 */
export function toQuarters(periods: Period[]): QuarterFact[] {
  const byEnd = new Map<string, QuarterFact>();
  const fact = (p: Period, periodStart: string, value: number): QuarterFact => ({
    periodEnd: p.end,
    value,
    tagUsed: p.tag,
    form: p.form,
    accn: p.accn,
    filed: p.filed,
    fiscalQ: calendarQuarter(periodStart, p.end),
  });

  for (const p of periods) {
    if (isQuarterLength(durationDays(p.start, p.end))) byEnd.set(p.end, fact(p, p.start, p.val));
  }

  // 差分:同 start 的累计行按 end 升序,相邻两条之差 = 后一条覆盖的那个季度。
  const groups = Map.groupBy(periods, (p) => p.start);
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.end.localeCompare(b.end));

    sorted.slice(1).forEach((cur, i) => {
      const prev = sorted[i]!;
      if (byEnd.has(cur.end) || !isQuarterLength(durationDays(prev.end, cur.end))) return;

      byEnd.set(cur.end, fact(cur, prev.end, cur.val - prev.val));
    });
  }

  return [...byEnd.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

// ── 申报实例兜底 ───────────────────────────────────────────────────────────────

/**
 * 单份申报的 XBRL 实例 → CompanyFacts 形状。**只在 companyfacts 落后于 submissions 时用**
 * (实测 META 的 2026Q2:10-Q 已于 2026-07-30 交上,companyfacts 六天后仍没这一期)。
 *
 * 为什么能安全地和 companyfacts 混:产出的是同一个形状,进的是同一条
 * collectPeriods → toQuarters 流水线,同期去重仍按 filed 最大 —— companyfacts 后来补上时
 * 自然覆盖。它不是第二个真相源,是**同一个源的更早入口**。
 *
 * 筛选规则(为什么够):
 *  · **只要无维度的 context**。实例里同一个 tag 会重复几十次(META 的收入 56 条),多数是分部/
 *    地区/股份类别拆分,全部带 `<segment>`。滤掉后剩的就是合并口径那几条(实测 META 的收入
 *    只剩本季 / 去年同季 / 本年累计 / 去年累计 4 条,与 companyfacts 给的一致)。
 *  · **只要 duration context**(有 startDate/endDate)。资产负债表那些时点值是 instant,本来就不要。
 *  · 只要链里那几个 tag、单位 USD。
 *
 * 不解析 presentation linkbase:这四个科目都是主报表顶层行,附注里的重复披露一律带维度,
 * 上面第一条已经滤掉。真出现「无维度但含义不同」的重复,值会不一致 → tagConflicts 报出来。
 */
export type FilingMeta = { accn: string; form: string; filed: string };

// context 块:命名空间前缀可有可无(实测 META 用默认命名空间 `<context id="c-1">`,
// 别的公司可能是 `<xbrli:context>`)。
const CONTEXT_RE = /<(?:[\w.-]+:)?context\s+id="([^"]+)"([\s\S]*?)<\/(?:[\w.-]+:)?context\s*>/g;
const START_RE = /<(?:[\w.-]+:)?startDate>\s*([\d-]+)\s*</;
const END_RE = /<(?:[\w.-]+:)?endDate>\s*([\d-]+)\s*</;

/** context id → 期间。带 segment(分部/地区/股份类别)的与 instant 的一律不收。 */
function durationContexts(xml: string): Map<string, { start: string; end: string }> {
  const out = new Map<string, { start: string; end: string }>();

  for (const m of xml.matchAll(CONTEXT_RE)) {
    const [, id = '', body = ''] = m;
    if (/<(?:[\w.-]+:)?segment[\s>]/.test(body)) continue;

    const start = START_RE.exec(body)?.[1];
    const end = END_RE.exec(body)?.[1];
    if (start && end) out.set(id, { start, end });
  }

  return out;
}

// unit 的 id 是申报人自取的,**不能靠名字猜**:实测 META 用 `usd`、MSFT/ORCL 用 `U_USD`。
// 按 <measure>iso4217:USD</measure> 认,才是口径本身而不是命名习惯。
const UNIT_RE = /<(?:[\w.-]+:)?unit\s+id="([^"]+)"([\s\S]*?)<\/(?:[\w.-]+:)?unit\s*>/g;

function usdUnits(xml: string): Set<string> {
  const ids = [...xml.matchAll(UNIT_RE)].flatMap(([, id = '', body = '']) =>
    /<(?:[\w.-]+:)?measure>\s*(?:[\w.-]+:)?USD\s*</i.test(body) ? [id] : [],
  );

  return new Set(ids);
}

/**
 * 额外要抓的**公司自定义(extension)概念** —— 元素全名(带前缀,如
 * `nvda:PurchasesOfPropertyAndEquipmentAndIntangibleAssets`)→ 落到链里哪个 tag 名下。
 *
 * 为什么需要:companyfacts 只聚合标准 taxonomy,公司拿自定义概念报的那几期在 API 里直接
 * 消失且不报错(实测 NVDA FY2023 的 capex)。实例里有,所以回填这条路能走。
 * 映射到链内 tag 而不是自成一档:下游的去重/差分/TTM 全部照旧,一行不用改。
 */
export type ExtensionMap = Record<string, string>;

export function parseXbrlInstance(xml: string, meta: FilingMeta, extensions: ExtensionMap = {}): CompanyFacts {
  const contexts = durationContexts(xml);
  const usd = usdUnits(xml);

  // [元素全名, 落到哪个 tag]。标准科目前缀恒为 us-gaap:,extension 的前缀各家自取。
  const targets: Array<[string, string]> = [
    ...CONCEPTS.flatMap((c) => TAG_CHAINS[c].map((t) => [`us-gaap:${t}`, t] as [string, string])),
    ...Object.entries(extensions),
  ];

  const entries = targets.flatMap(([element, tag]) => {
    // 自闭合(nil)的事实不匹配 —— 正是要跳过的。
    const re = new RegExp(`<${element}\\s([^>]*)>\\s*(-?[\\d.]+)\\s*</${element}\\s*>`, 'g');

    const rows = [...xml.matchAll(re)].flatMap(([, attrs = '', raw = '']) => {
      const ctx = /contextRef="([^"]+)"/.exec(attrs)?.[1];
      const unit = /unitRef="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const period = ctx ? contexts.get(ctx) : undefined;
      if (!period || !usd.has(unit)) return [];

      const val = Number(raw);
      return Number.isFinite(val) ? [{ ...period, val, ...meta }] : [];
    });

    return rows.length ? [[tag, rows] as const] : [];
  });

  // 同一个 tag 可能同时被标准元素和 extension 命中(换标那年会重叠)——合并而不是后者覆盖前者,
  // 去重照旧交给 periodsForTag 按 filed 裁。
  const merged: Record<string, { units: { USD: FactRow[] } }> = {};
  for (const [tag, rows] of entries) {
    merged[tag] = { units: { USD: [...(merged[tag]?.units.USD ?? []), ...rows] } };
  }

  return { facts: { 'us-gaap': merged } };
}

/**
 * 两份 facts 合并(companyfacts + 单份申报实例)。必须先合并再走 collectPeriods:
 * 现金流多数只报累计,单季靠差分算 —— 实例里只有本年累计(META 的 H1),
 * 减掉的那个 Q1 在 companyfacts 里,分开跑两遍差分算不出本季。
 */
export function mergeFacts(...parts: CompanyFacts[]): CompanyFacts {
  const merged: Record<string, { units?: Record<string, FactRow[]> }> = {};

  for (const p of parts) {
    for (const [tag, node] of Object.entries(p.facts?.['us-gaap'] ?? {})) {
      const usd = [...(merged[tag]?.units?.USD ?? []), ...(node.units?.USD ?? [])];
      merged[tag] = { units: { USD: usd } };
    }
  }

  return { facts: { 'us-gaap': merged } };
}

/** companyfacts → 四个科目的单季行(可直接落 sec_fundamentals)。 */
export function extractFundamentals(ticker: string, facts: CompanyFacts): SecFundamentalRow[] {
  return CONCEPTS.flatMap((concept) =>
    toQuarters(collectPeriods(facts, TAG_CHAINS[concept])).map((q) => ({ ticker, concept, ...q })),
  );
}

// ── TTM ───────────────────────────────────────────────────────────────────────

/** 四个季度跨度应为 ~270 天(3 个季度间隔);超出说明中间缺季,不出值,避免把 3 季当 4 季。 */
const TTM_SPAN_MIN = 250;
const TTM_SPAN_MAX = 300;

/** TTM 点带上窗口末季的日历季度:跨公司合计只能按日历季度对齐(各家财年末不同)。 */
export type QuarterPoint = Point & { fiscalQ: string };

type QuarterInput = { periodEnd: string; value: number; fiscalQ: string };

export function ttm(quarters: QuarterInput[]): QuarterPoint[] {
  const sorted = [...quarters].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

  return sorted.flatMap((q, i) => {
    if (i < 3) return [];

    const first = sorted[i - 3]!;
    const span = durationDays(first.periodEnd, q.periodEnd);
    if (span < TTM_SPAN_MIN || span > TTM_SPAN_MAX) return [];

    const value = sorted.slice(i - 3, i + 1).reduce((s, x) => s + x.value, 0);
    return [{ date: q.periodEnd, value, fiscalQ: q.fiscalQ }];
  });
}

const MILLION = 1e6;

/** 同日期对齐两条序列后逐点算。日期不齐的点丢弃(毛利率/FCF 都要求两个科目同期)。 */
function combine(a: QuarterPoint[], b: QuarterPoint[], f: (x: number, y: number) => number): QuarterPoint[] {
  const bm = new Map(b.map((p) => [p.date, p.value]));

  return a.flatMap((p) => {
    const y = bm.get(p.date);
    return y === undefined ? [] : [{ ...p, value: f(p.value, y) }];
  });
}

type DerivedSeries = {
  gmTtm: QuarterPoint[];
  capexTtm: QuarterPoint[];
  fcfTtm: QuarterPoint[];
  fcfQ: QuarterPoint[];
  revTtm: QuarterPoint[];
  revGrowth: QuarterPoint[];
};

/**
 * **单季**营收同比 = Q(t) / Q(t−4) − 1。
 *
 * 为什么按**单季同比**而不是 TTM 同比:同比本身就把季节性去掉了(比的是同一个财季),
 * 而单季比 TTM 早半年反映拐点 —— TTM 同比里当季只占四分之一权重,拐点会被前三季稀释。
 * 这也和公司自己在财报里 headline 的口径一致(「营收同比 +22%」讲的都是单季)。
 *
 * 按 **fiscalQ 对齐**去找去年同季,不按日期减 365 天:各家财季末天然漂移几天
 * (13 周周历),按日期找会错过或配错。前四季不出点(没有可比基期)。
 */
function yoyByQuarter(quarters: QuarterPoint[]): QuarterPoint[] {
  const prior = new Map(quarters.map((p) => [p.fiscalQ, p.value]));

  return quarters.flatMap((p) => {
    const [y, q] = p.fiscalQ.split('Q');
    const base = prior.get(`${Number(y) - 1}Q${q}`);
    // 基期为 0 或负(亏损年的成本类科目)时同比没有意义,不出点。
    return base !== undefined && base > 0 ? [{ ...p, value: (p.value / base - 1) * 100 }] : [];
  });
}

/**
 * 恰好为 0 的单季值一律当缺数据丢掉。**不是「这季真的是 0」,是 tag 的假身份**,两种来源:
 *  · 直接标的 0 —— ORCL 2009-02-28 / 2009-11-30 的 `CostOfRevenue` 就是 0,而当季真实成本约 15 亿:
 *    成本那时记在 `CostOfServices` 下,这个 tag 只是留着占位。
 *  · 差分出的 0 —— 两条累计行同为 0(ORCL FY2009)相减,或某期换 tag 导致两腿是同一个数。
 * 危害在于**不报错**:成本吞掉一季 → TTM 少一截 → 毛利率虚高,图上就是一根真假难辨的尖刺,
 * 而这组判据读的正是毛利率的斜率。丢掉 → 断档 → 一眼看得出是缺数据(同 trailingContiguous 的理由)。
 *
 * 库里原始行保留,只在派生时丢:落库那层要能溯源到底是哪次申报给的这个 0。
 *
 * 上限:某家真有一季 capex 恰好为 0 会被误丢。当前名单全是重资产大盘股,四个科目都不可能。
 * 哪天进了轻资产标的,这里要改成按 concept 区分。
 */
const dropSuspectZero = (rows: SecFundamentalRow[]): SecFundamentalRow[] => rows.filter((r) => r.value !== 0);

/** 单季行 → 三条 TTM 派生量。毛利率单位百分点,金额单位百万美元(与 netLiquidity 等现有序列一致)。 */
export function deriveSeries(rows: SecFundamentalRow[]): DerivedSeries {
  const clean = dropSuspectZero(rows);

  const of = (c: Concept) => ttm(clean.filter((r) => r.concept === c));
  // 单季:直接用库里的单季行(TTM 就是在它之上加出来的),不用重算。
  const quarterly = (c: Concept): QuarterPoint[] =>
    clean.filter((r) => r.concept === c).map((r) => ({ date: r.periodEnd, value: r.value, fiscalQ: r.fiscalQ }));

  const [revenue, cogs, ocf, capex] = [of('revenue'), of('cogs'), of('ocf'), of('capex')];

  return {
    // TTM 营收:**需求强度的直接读数**,而且是唯一对「毛利率结构性不动」的公司(如 ARM 这种
    // IP 授权模式,毛利率恒在 97% 上下)仍然有信息量的那一格。
    revTtm: revenue.map((p) => ({ ...p, value: p.value / MILLION })),
    // 同比用**单季**算(见 yoyByQuarter):拐点比 TTM 早半年,且与公司 headline 口径一致。
    revGrowth: yoyByQuarter(quarterly('revenue')),
    gmTtm: combine(revenue, cogs, (rev, cost) => ((rev - cost) / rev) * 100),
    capexTtm: capex.map((p) => ({ ...p, value: p.value / MILLION })),
    fcfTtm: combine(ocf, capex, (o, c) => (o - c) / MILLION),
    // 单季 FCF:转折**当季**就能看见。TTM 看不出来 —— 相邻 TTM 相减是「同比同季变化」
    // (中间三项抵消,剩 Q(t)−Q(t−4)),不是当季值。
    fcfQ: combine(quarterly('ocf'), quarterly('capex'), (o, c) => (o - c) / MILLION),
  };
}

/** TTM 三条用 `_TTM` 后缀;单季那条是 `_FCF_Q`(不是 TTM,别混)。 */
export type SeriesKind = 'GM' | 'CAPEX' | 'FCF' | 'FCFQ' | 'REV' | 'REVG';

/** TTM 那几条用 `_TTM` 后缀;单季 FCF 是 `_FCF_Q`、单季营收同比是 `_REV_YOY`(都不是 TTM,别混)。 */
const SERIES_SUFFIX: Record<SeriesKind, string> = {
  GM: 'GM_TTM',
  CAPEX: 'CAPEX_TTM',
  FCF: 'FCF_TTM',
  FCFQ: 'FCF_Q',
  REV: 'REV_TTM',
  REVG: 'REV_YOY',
};

export const seriesId = (ticker: string, kind: SeriesKind): string => `SEC_${ticker}_${SERIES_SUFFIX[kind]}`;
/** §6.14 判据线:**只汇总买方**(见 shared/aiChain 的 side)。卖方混进来会让「跌破零轴」永远不成立。 */
export const BUYER_FCF_SERIES = 'SEC_BUYER_FCF_TTM';
/** 买方**单季** FCF 合计:判据「跌破零轴」的早期读数(TTM 晚半年)。 */
export const BUYER_FCFQ_SERIES = 'SEC_BUYER_FCF_Q';

/**
 * 只保留**尾部连续段**:从最后一点往前走,相邻点间隔超过 maxGapDays 就断开。
 *
 * 为什么必须裁:折线只连点,断档两端会被连成一条直线,而那条直线的斜率是**编出来的**。
 * 本组判据全在读斜率(「抬升但斜率转平 = 离转折不远」),一条假斜率直接把判据读反。
 * 断档的成因是源的空缺(如 NVDA FY2013–FY2021 的年度 capex 在 XBRL 里不存在,Q4 无从还原),
 * 不是抓取失败,补不回来。库里原始行全保留,只在读时裁。
 *
 * 阈值 120 天:季度点间隔约 91 天,少报一季就是 182 天,故 120 能挡住「缺任一季」。
 */
export function trailingContiguous<T extends { date: string }>(points: T[], maxGapDays = 120): T[] {
  const gapAt = points.findLastIndex((p, i) => i > 0 && durationDays(points[i - 1]!.date, p.date) > maxGapDays);

  return gapAt < 0 ? points : points.slice(gapAt);
}

/**
 * 合计 TTM FCF:**按日历季度对齐**,不按期间末日。各家财年末不同(NVDA 1 月末 / MSFT 6 月末 …),
 * 直接按 date 并集会把不同季度的 TTM 混进同一个合计点;fiscalQ 已按期间中点归好(见 calendarQuarter),
 * 拿它当对齐键才是横比口径。
 *
 * **不做前向填充**:只有当季每家都有点才出合计。否则某家停报/job 断了,它的旧值会被无限期
 * 带进后续每一个合计点,合计线看起来还在更新、其实是陈的。代价是最新一季要等最慢的公司报完,
 * 这对一条季频判据线是正确的行为。
 */
export function aggregateFcf(byTicker: Map<string, QuarterPoint[]>): Point[] {
  const all = [...byTicker.values()];
  if (all.length === 0) return [];

  const byQuarter = all.map((series) => new Map(series.map((p) => [p.fiscalQ, p])));
  const quarters = [...new Set(all.flat().map((p) => p.fiscalQ))].sort();

  return quarters.flatMap((q) => {
    const points = byQuarter.map((m) => m.get(q));
    if (points.some((p) => p === undefined)) return []; // 缺一家就不出点

    // obs_date 取该季各家里最晚的期末——合计要到最后一家的期末才算齐。
    const date = points.map((p) => p!.date).reduce((a, b) => (a > b ? a : b));
    return [{ date, value: points.reduce((s: number, p) => s + p!.value, 0) }];
  });
}
