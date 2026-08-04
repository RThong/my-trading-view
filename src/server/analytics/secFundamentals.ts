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
 */
export const TAG_CHAINS: Record<Concept, string[]> = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
  cogs: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
};

/**
 * capex 两档不是同义词,是两个口径 —— 跨公司比 capex / FCF 绝对值时必须知道用的哪个:
 *  · ppe:纯有形固定资产的现金购买(MU / MSFT / GOOGL / META)。
 *  · productive_assets:PP&E **+ 软件及其他无形资产**(NVDA 那行原文是 "property and equipment
 *    and intangible assets";AMZN 含自用软件/网站开发)。同样的生意,这一档会显得更重、FCF 更低。
 * 拆不开:`PaymentsToAcquireIntangibleAssets` 七家实测一期都没有,没法从 companyfacts 减出纯 PP&E。
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

const PERIODIC_FORMS = new Set(['10-Q', '10-K']);
const DAY_MS = 86_400_000;

const durationDays = (start: string, end: string): number => (Date.parse(end) - Date.parse(start)) / DAY_MS;

/** 一个季度 80~100 天(13~14 周,各家财年周历不同)。YTD 各档为 181 / 272 / 363,差分后同样落这个区间。 */
const isQuarterLength = (d: number): boolean => d >= 80 && d <= 100;

type Period = { start: string; end: string; val: number; tag: string; form: string; accn: string; filed: string };

/** 单个 tag 的期间表:只留 10-Q/10-K + USD + 有 start(时点值无 start,如资产负债表科目),同期间取 filed 最大。 */
function periodsForTag(facts: CompanyFacts, tag: string): Map<string, Period> {
  const rows = facts.facts?.['us-gaap']?.[tag]?.units?.USD ?? [];
  const out = new Map<string, Period>();

  for (const r of rows) {
    if (!r.start || !PERIODIC_FORMS.has(r.form)) continue;

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
      const clash = covering.slice(1).find((p) => p.val !== chosen.val);

      return clash && chosen.end >= cutoff ? [{ concept, period, a: chosen, b: clash }] : [];
    });
  });
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

type DerivedSeries = { gmTtm: QuarterPoint[]; capexTtm: QuarterPoint[]; fcfTtm: QuarterPoint[] };

/** 单季行 → 三条 TTM 派生量。毛利率单位百分点,金额单位百万美元(与 netLiquidity 等现有序列一致)。 */
export function deriveSeries(rows: SecFundamentalRow[]): DerivedSeries {
  const of = (c: Concept) => ttm(rows.filter((r) => r.concept === c));

  const [revenue, cogs, ocf, capex] = [of('revenue'), of('cogs'), of('ocf'), of('capex')];

  return {
    gmTtm: combine(revenue, cogs, (rev, cost) => ((rev - cost) / rev) * 100),
    capexTtm: capex.map((p) => ({ ...p, value: p.value / MILLION })),
    fcfTtm: combine(ocf, capex, (o, c) => (o - c) / MILLION),
  };
}

export const seriesId = (ticker: string, kind: 'GM' | 'CAPEX' | 'FCF'): string => `SEC_${ticker}_${kind}_TTM`;
/** §6.14 判据线:**只汇总买方**(见 shared/secCompanies 的 side)。卖方混进来会让「跌破零轴」永远不成立。 */
export const BUYER_FCF_SERIES = 'SEC_BUYER_FCF_TTM';

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
