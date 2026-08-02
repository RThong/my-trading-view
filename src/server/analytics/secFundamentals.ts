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

type Concept = 'revenue' | 'cogs' | 'ocf' | 'capex';

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
 * 各科目的 tag 候选链。合并规则见 collectPeriods —— **先比 filed,filed 相同才按链序**,
 * 不是「靠前的直接占位」。故链序只是同 filed 时的裁决依据,不代表覆盖优先级。
 *
 * cogs 不放 `CostOfGoodsSold`:它不含服务成本,而跨 tag 是 filed 大者胜——某家若在重述里
 * 换用它,会盖掉更早 filed 的 `CostOfRevenue`,成本被低估、毛利率虚高。`CostOfGoodsAndServicesSold`
 * 已是「货+服务」口径,够覆盖 MSFT/ORCL 这类公司。哪家两档都不命中,会在开那家时的核对里暴露。
 */
const TAG_CHAINS: Record<Concept, string[]> = {
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
  ],
  cogs: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
    'PaymentsToAcquireOtherPropertyPlantAndEquipment',
  ],
};

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
 * 逐期 fallback。同一 (start,end) 被多个 tag 覆盖时:**先比 filed(取重述后的最新值),
 * filed 相同才按 tag 链顺序定优先**。不能简单「靠前 tag 占位」——公司在重述时换过 tag 的话,
 * 靠前 tag 留着的就是被作废的旧值。
 */
export function collectPeriods(facts: CompanyFacts, tags: string[]): Period[] {
  const merged = new Map<string, Period>();

  tags.forEach((tag, rank) => {
    for (const [key, p] of periodsForTag(facts, tag)) {
      const prior = merged.get(key);
      const priorRank = prior ? tags.indexOf(prior.tag) : Number.POSITIVE_INFINITY;
      const better = !prior || p.filed > prior.filed || (p.filed === prior.filed && rank < priorRank);

      if (better) merged.set(key, p);
    }
  });

  return [...merged.values()].sort((a, b) => a.end.localeCompare(b.end));
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
  return (Object.keys(TAG_CHAINS) as Concept[]).flatMap((concept) =>
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
export const AICHAIN_FCF_SERIES = 'SEC_AICHAIN_FCF_TTM';

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
