// 期权结构 / 踩踏监控(纯函数):阶段判定、两个转换点、两张清单、滚动分位。
// 服务端 /api/regime 用它出阶段 / 转换点的 0/1 标记序列(「踩踏监控」历史图的背景色带),前端用它算当天读数。
// 规则照付鹏「美股期权微观结构与流动性踩踏监控仪表盘」的结构与绝对阈值,删去我们没有数据的条款(DealerGamma / NetDelta / 朴素 GEX);
// 2018 起回测选定、不再调参(只有 15 个事件),见 docs/options-structure-panel-handoff.md。
import { thirdFriday } from './monthlyExpiry';

export type Point = { date: string; value: number };
export type SeriesMap = Partial<Record<string, Point[]>>;

export type Stage = 1 | 2 | 3 | 4;

type StageInput = { vix: number; vixVix3m: number; vvix: number; skew: number; vixeqVix: number };
const STAGE_KEYS = ['vix', 'vixVix3m', 'vvix', 'skew', 'vixeqVix'] as const;

/** 每日独立判定、无记忆,优先级 三 → 一 → 四 → 二。 */
export function stageOf(x: StageInput): Stage {
  if (x.vix >= 26 && (x.vixVix3m >= 1 || x.vvix >= 110)) return 3;
  if (x.vix < 18 && x.skew < 158) return 1;
  if (x.vixVix3m < 1 && x.vvix < 110 && x.skew < 155 && x.vixeqVix < 2.0) return 4;
  return 2;
}

/** keys 各序列在同一天都有值的日子(按第一条的日期);缺任一条的日子跳过,不前向填充。 */
export function joined<K extends string>(s: SeriesMap, keys: readonly K[]): { date: string; v: Record<K, number> }[] {
  const maps = keys.map((k) => new Map((s[k] ?? []).map((p) => [p.date, p.value])));

  return (s[keys[0]] ?? []).flatMap((p) => {
    const vals = maps.map((m) => m.get(p.date));
    if (vals.some((x) => x === undefined)) return [];
    return [{ date: p.date, v: Object.fromEntries(keys.map((k, i) => [k, vals[i]])) as Record<K, number> }];
  });
}

export function stageSeries(s: SeriesMap): { date: string; stage: Stage }[] {
  return joined(s, STAGE_KEYS).map(({ date, v }) => ({ date, stage: stageOf(v) }));
}

// 分位窗口:截至前一交易日的滚动 5 年(不含当天);不足 5 年用扩张窗口,满 252 个观测才给
const PCTL_YEARS = 5;
const PCTL_MIN_OBS = 252;

/** 窗口起点:含恰好 5 年前那天;2-29 往回 5 年不存在,退到 2-28 */
function windowFrom(d: string): string {
  return `${Number(d.slice(0, 4)) - PCTL_YEARS}${d.slice(4) === '-02-29' ? '-02-28' : d.slice(4)}`;
}

/** x 在 rows[0..end] 里日期 ≥ from 那段的分位(从 end 往回数),中点法处理并列;观测不足 → NaN。 */
function pctlIn(rows: Point[], end: number, from: string, x: number): number {
  let n = 0;
  let below = 0;
  let equal = 0;
  for (let j = end; j >= 0 && rows[j].date >= from; j--) {
    n++;
    if (rows[j].value < x) below++;
    else if (rows[j].value === x) equal++;
  }
  return n < PCTL_MIN_OBS ? NaN : ((below + equal / 2) / n) * 100;
}

/** rows[i] 在它之前 5 年(不含当天)里的分位,0–100,中点法处理并列;观测不足 → NaN。rows 须按日期升序。 */
export function pctlAt(rows: Point[], i: number): number {
  return pctlIn(rows, i - 1, windowFrom(rows[i].date), rows[i].value);
}

/** 任意值 x 在 rows 最近 5 年(截至最后一个观测、含它)里的分位;给情景模板的假想值定位用。观测不足 → NaN。 */
export function pctlOf(rows: Point[], x: number): number {
  const last = rows.at(-1);
  return last ? pctlIn(rows, rows.length - 1, windowFrom(last.date), x) : NaN;
}

/** 逐日滚动分位,观测不足的头部丢掉。 */
export function rollingPctl(rows: Point[]): Point[] {
  return rows.map((p, i) => ({ date: p.date, value: pctlAt(rows, i) })).filter((p) => !Number.isNaN(p.value));
}

// 断崖:vixeqVix 分位在前 20 个交易日(t−20…t−1)里最高 ≥90,当日 ≤50 ——「VIXEQ/VIX 高位断崖回落」
const CLIFF_LOOKBACK = 20;
const CLIFF_HIGH = 90;
const CLIFF_LOW = 50;

/** 断崖 0/1 逐日标记(输入 vixeqVix 原值)。 */
export function cliffSeries(vixeqVix: Point[]): Point[] {
  const p = rollingPctl(vixeqVix);

  return p.slice(CLIFF_LOOKBACK).map((x, k) => {
    const peak = Math.max(...p.slice(k, k + CLIFF_LOOKBACK).map((y) => y.value));
    return { date: x.date, value: peak >= CLIFF_HIGH && x.value <= CLIFF_LOW ? 1 : 0 };
  });
}

/** 升级(宏观全面防御):指数 P/C ≥1.25 且个股 P/C ≥0.80。 */
export function escalateOn(v: { pcIndex: number; pcEquity: number }): boolean {
  return v.pcIndex >= 1.25 && v.pcEquity >= 0.8;
}

/** 升级逐日 0/1。 */
export function escalateSeries(s: SeriesMap): Point[] {
  return joined(s, ['pcIndex', 'pcEquity'] as const).map(({ date, v }) => ({ date, value: escalateOn(v) ? 1 : 0 }));
}

/** 单日快照(情景模板等):键 → 值,缺的键或 NaN 当没数据。 */
export type Snapshot = Partial<Record<string, number>>;

/** 快照判阶段;五条输入缺任一 → null。 */
export function stageAt(x: Snapshot): Stage | null {
  const vals = STAGE_KEYS.map((k) => x[k]);
  if (!vals.every((v) => v !== undefined && Number.isFinite(v))) return null;
  return stageOf(Object.fromEntries(STAGE_KEYS.map((k, i) => [k, vals[i]])) as StageInput);
}

/** 末尾连续同一阶段的天数与起点(「第 N 天,本轮自 X 起」)。 */
export function currentRun(stages: { date: string; stage: Stage }[]) {
  const last = stages.at(-1);
  if (!last) return null;
  const breakAt = stages.findLastIndex((x) => x.stage !== last.stage);

  return { ...last, days: stages.length - 1 - breakAt, since: stages[breakAt + 1].date };
}

/**
 * 清单的一项:on = null 表示没数据;date = 判定用的那天(各项可能不同天,P/C 晚一天发);
 * na = 这种读法下不适用的原因(如模板没有时间序列),此时 on 为 null。
 */
export type CheckItem = { label: string; on: boolean | null; date?: string; proxy?: string; na?: string };

/** 清单里只看当天几条原值的一项;实盘(latestCheck)与快照(snapCheck)共用同一组谓词。 */
type Rule = { label: string; keys: readonly string[]; pred: (v: Record<string, number>) => boolean };

function rule<K extends string>(label: string, keys: readonly K[], pred: (v: Record<K, number>) => boolean): Rule {
  return { label, keys, pred };
}

const RISK_PC = rule('个股 P/C ≥ 0.80 且全市场 P/C ≥ 1.25', ['pcEquity', 'pcTotal'], (v) => {
  return v.pcEquity >= 0.8 && v.pcTotal >= 1.25;
});
const RISK_PC_INDEX = rule('指数 P/C ≥ 1.25', ['pcIndex'], (v) => v.pcIndex >= 1.25);
const RISK_VOL = rule('VIX > 28 且 VIX/VIX3M > 1 且 VVIX ≥ 110', ['vix', 'vixVix3m', 'vvix'], (v) => {
  return v.vix > 28 && v.vixVix3m > 1 && v.vvix >= 110;
});
const PAUSE_VVIX = rule('VVIX < 110', ['vvix'], (v) => v.vvix < 110);
const PAUSE_TERM = rule('VIX/VIX3M < 1 且 VIX9D/VIX < 1', ['vixVix3m', 'vix9dVix'], (v) => {
  return v.vixVix3m < 1 && v.vix9dVix < 1;
});
const PAUSE_DISP = rule('VIXEQ/VIX ≥ 1.70 且 VIX < 25', ['vixeqVix', 'vix'], (v) => v.vixeqVix >= 1.7 && v.vix < 25);

/** 在 keys 都有值的最近一天上判。 */
function latestCheck(r: Rule, s: SeriesMap): CheckItem {
  const last = joined(s, r.keys).at(-1);
  return last ? { label: r.label, on: r.pred(last.v), date: last.date } : { label: r.label, on: null };
}

/** 在快照上判;缺任一键 → null。 */
function snapCheck(r: Rule, x: Snapshot): CheckItem {
  const ok = r.keys.every((k) => Number.isFinite(x[k] ?? NaN));
  return { label: r.label, on: ok ? r.pred(x as Record<string, number>) : null };
}

// 替代项的门槛:原文是 Dealer Agg Gamma / 交割后 GEX + Net Delta,我们只有 Squeezemetrics gex,按它自身分位读
const POST_EXPIRY_DAYS = 5;
const GEX_REBOUND_PP = 20;

function gexLow(pctl: number, date?: string): CheckItem {
  return {
    label: `GEX 分位 ≤ ${GEX_PCTL.red}`,
    on: Number.isNaN(pctl) ? null : pctl <= GEX_PCTL.red,
    date,
    proxy: '原文「Dealer Agg Gamma 跌穿 −8.6B」,无数据,替代',
  };
}

const REBOUND_LABEL = `交割后 ${POST_EXPIRY_DAYS} 日内 GEX 分位回升 ≥ ${GEX_REBOUND_PP}pp`;
const REBOUND_PROXY = '原文「交割后 GEX ≥ −30B 且 Net Delta ≥ 0」,无数据,替代';

/** 风险升级清单(满足越多,向全市场扩散的风险越高)。 */
export function riskChecklist(s: SeriesMap): CheckItem[] {
  const gex = s.gex ?? [];
  const gexPctl = gex.length ? pctlAt(gex, gex.length - 1) : NaN;

  return [
    latestCheck(RISK_PC, s),
    latestCheck(RISK_PC_INDEX, s),
    gexLow(gexPctl, gex.at(-1)?.date),
    latestCheck(RISK_VOL, s),
  ];
}

/** 快照版风险清单:同一组谓词;GEX 项直接给分位(模板没有 GEX 原值)。 */
export function riskChecklistAt(x: Snapshot, gexPctl: number): CheckItem[] {
  return [snapCheck(RISK_PC, x), snapCheck(RISK_PC_INDEX, x), gexLow(gexPctl), snapCheck(RISK_VOL, x)];
}

/** 最近一个 ≤ date 的标准月度交割日(每月第三个周五;假日提前一天不认,差一天对「交割后 5 日」无碍)。 */
function lastExpiry(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const thisMonth = iso(thirdFriday(y, m));
  return thisMonth <= date ? thisMonth : iso(thirdFriday(y, m - 1));
}

/** 交割后 5 个交易日内,GEX 分位较交割前最后一个交易日(不含交割日当天)回升 ≥20pp(替代项)。不在窗口内 → false。 */
function gexRebound(gex: Point[]): CheckItem {
  const label = REBOUND_LABEL;
  const proxy = REBOUND_PROXY;
  const last = gex.length - 1;
  if (last < 0) return { label, on: null, proxy };

  const expiry = lastExpiry(gex[last].date);
  const firstAfter = gex.findIndex((p) => p.date > expiry);
  // 第三个周五休市(如 Good Friday)时交割提前到前一交易日:那天没有数据 → 前一个点就是实际交割日,基准再往前退一天。
  // ponytail: 源偶尔缺周五那天的点也会被当成休市,误差一天,不值得接交易日历
  const lastBefore = gex.findLastIndex((p) => p.date < expiry);
  const before = gex.some((p) => p.date === expiry) ? lastBefore : lastBefore - 1;
  // 当天就是交割日(firstAfter = −1)、交割已过 5 日、或交割前没有数据 → 不在窗口
  const inWindow = firstAfter >= 0 && before >= 0 && last - firstAfter < POST_EXPIRY_DAYS;
  const on = inWindow && pctlAt(gex, last) - pctlAt(gex, before) >= GEX_REBOUND_PP;

  return { label, on, date: gex[last].date, proxy };
}

/** 风暴暂歇清单(满足越多,空头回补概率越高)。 */
export function pauseChecklist(s: SeriesMap): CheckItem[] {
  return [gexRebound(s.gex ?? []), latestCheck(PAUSE_VVIX, s), latestCheck(PAUSE_TERM, s), latestCheck(PAUSE_DISP, s)];
}

/** 快照版暂歇清单:第 1 项要比交割前后的 GEX,单日快照没有时间序列 → 不适用。 */
export function pauseChecklistAt(x: Snapshot): CheckItem[] {
  const rebound = { label: REBOUND_LABEL, on: null, proxy: REBOUND_PROXY, na: '单日快照没有交割前后的序列,不适用' };
  return [rebound, snapCheck(PAUSE_VVIX, x), snapCheck(PAUSE_TERM, x), snapCheck(PAUSE_DISP, x)];
}

/** 读数格:最新值、截至前一日的 5 年分位、20 个观测前到现在的变化。 */
export function latestStat(rows: Point[] | undefined) {
  if (!rows?.length) return null;
  const i = rows.length - 1;

  return {
    date: rows[i].date,
    value: rows[i].value,
    pctl: pctlAt(rows, i),
    chg20: i >= 20 ? rows[i].value - rows[i - 20].value : NaN,
  };
}

/** 付鹏线亮灯:红 / 黄 / 正常(null)。 */
export type Level = 'red' | 'yellow' | null;

/** 一行指标的判线规则(卡片配置见 web/pages/stampede/dims)。 */
export type LevelRule = {
  /** vix = 同一天的 VIX(DSPX、SKEW 的红线要看它);pctl = 本条的滚动 5 年分位(GEX 按分位判) */
  level: (v: number, vix: number, pctl: number) => Level;
  /** 按分位判(分位还算不出来时当没数据,不当正常) */
  byPctl?: true;
  /** 红线要看 VIX:VIX 缺时当没数据 */
  needsVix?: true;
};

function above(yellow: number, red: number, strict = false) {
  return (v: number): Level => ((strict ? v > red : v >= red) ? 'red' : v >= yellow ? 'yellow' : null);
}

/** 图卡(期限结构虚线、P/C 柱状对比、GEX 分位条)也要画的几条红线,和 LEVEL_RULES 共用一份 */
export const RED_LINES = { vix: 28, pcEquity: 0.8, pcTotal: 1.25, pcIndex: 1.25 } as const;
/** GEX 没有可用的付鹏线,按自身滚动 5 年分位:≤5 红、≤20 黄(风险清单的替代项也用 ≤5) */
export const GEX_PCTL = { red: 5, yellow: 20 } as const;

/**
 * 付鹏原仪表盘的黄 / 红线(五维度卡的标签与维度分用,不参与阶段判定)。照原样,不调参。
 * redPctl = 该红线在我们 2018 起历史上的分位(卡片横条上的细竖线);GEX 没有可用的付鹏线,按自身分位 ≤5 红、≤20 黄。
 */
export const LEVEL_RULES = {
  vixeqVix: { redPctl: 60, level: (v: number) => (v < 1.85 ? 'red' : v < 2.15 ? 'yellow' : null) },
  dspx: { needsVix: true, level: (v: number, vix: number) => (v < 35 && vix > 25 ? 'red' : v < 39 ? 'yellow' : null) },
  vix: { redPctl: 89, level: above(20, RED_LINES.vix) },
  vvix: { redPctl: 81, level: above(100, 115) },
  vixVix3m: { redPctl: 92, level: above(0.95, 1, true) },
  vix9dVix: { redPctl: 73, level: above(0.95, 1, true) },
  // 崩盘时平值 IV 吞掉尾部溢价,SKEW 反而回落 → 红线是「VIX 高位时 SKEW 低」
  skew: {
    needsVix: true,
    level: (v: number, vix: number) => (vix >= 25 && v < 150 ? 'red' : v >= 160 ? 'yellow' : null),
  },
  pcEquity: { redPctl: 93, level: above(0.68, RED_LINES.pcEquity) },
  pcTotal: { redPctl: 98, level: above(1, RED_LINES.pcTotal) },
  pcIndex: { redPctl: 64, level: above(1.12, RED_LINES.pcIndex) },
  gex: {
    redPctl: GEX_PCTL.red,
    byPctl: true,
    level: (_v: number, _vix: number, pctl: number) =>
      pctl <= GEX_PCTL.red ? 'red' : pctl <= GEX_PCTL.yellow ? 'yellow' : null,
  },
} satisfies Record<string, LevelRule & { redPctl?: number }>;
export type RuleKey = keyof typeof LEVEL_RULES;

/** 一行指标的亮灯;没数据(值 / 该看的分位 / 该看的 VIX 缺)→ undefined,不计入维度分。 */
export function metricLevel(m: LevelRule, value: number, pctl: number, vix: number): Level | undefined {
  const known = Number.isFinite(value) || m.byPctl;
  if (!known || (m.byPctl && !Number.isFinite(pctl)) || (m.needsVix && !Number.isFinite(vix))) return undefined;
  return m.level(value, vix, pctl);
}

const LEVEL_SCORE = { red: 100, yellow: 50 } as const;

/** 维度分 = 各指标(红 100、黄 50、正常 0)的平均,四舍五入;没有一条有数据 → NaN。只表示几条线亮了,不是概率。 */
export function dimScore(levels: (Level | undefined)[]): number {
  const known = levels.filter((l) => l !== undefined);
  if (!known.length) return NaN;

  return Math.round(known.reduce((sum, l) => sum + (l ? LEVEL_SCORE[l] : 0), 0) / known.length);
}

// 偏斜坍塌:SKEW 较前 60 个交易日高点回落 ≥20 点 —— 付鹏 11-21「SKEW 先行 VIX 后至」:冲击落地后机构了结尾部 Put,
// 偏斜溢价坍塌。此时阶段四的「SKEW < 155」是保护被平掉、不是风险消退。2018 起阶段四 79 段:
// 进入时偏斜坍塌的 27 段里 8 段之后 21 日又跌 ≥5%(30%),其余 52 段 7 段(13%)。只做提示,不改阶段(用户 2026-11-21 定)。
const SKEW_COLLAPSE_DROP = 20;
const SKEW_COLLAPSE_LOOKBACK = 60;

/** 最新一天的 SKEW 较前 60 个交易日高点回落了多少,是否算坍塌;没数据 → null。 */
export function skewCollapse(skew: Point[]): { drop: number; collapsed: boolean } | null {
  const last = skew.at(-1);
  if (!last) return null;
  const peak = Math.max(...skew.slice(-(SKEW_COLLAPSE_LOOKBACK + 1)).map((p) => p.value));
  const drop = peak - last.value;

  return { drop, collapsed: drop >= SKEW_COLLAPSE_DROP };
}

// 出清(试行,只做提示、不改阶段):SKEW 冲高后坍塌 + VIX 放大 + 防御(XLP)与进攻(XLK)板块一起跌。
// 取自付鹏 2026-11-21「SKEW 先行 VIX 后至」与 11-20「高切低转通杀」两篇;2018 起回测 7 次:5 次两周内见局部低点、
// 之后只再跌 1%~8%;2020-02、2022-05 两次之后又大跌(熊市里通杀一轮接一轮),所以不能当阶段结束。
const FLUSH_VIX = 25;
const FLUSH_FALL = 0.03; // XLP、XLK 10 日都跌这么多
const FLUSH_RECENT = 10; // 最近这么多个交易日内触发过就算「进行中」

/** 出清逐日 0/1(按 SKEW 的日期);缺任一条的日子跳过。xlp / xlk 是收盘价序列。 */
export function flushSeries(s: SeriesMap, xlp: Point[], xlk: Point[]): Point[] {
  const skew = s.skew ?? [];
  const vix = new Map((s.vix ?? []).map((p) => [p.date, p.value]));
  const fall10 = (rows: Point[]) =>
    new Map(rows.slice(10).map((p, i) => [p.date, p.value / rows[i].value - 1] as const));
  const [fp, fk] = [fall10(xlp), fall10(xlk)];

  return skew.flatMap((p, i) => {
    const v = vix.get(p.date);
    const a = fp.get(p.date);
    const b = fk.get(p.date);
    if (v === undefined || a === undefined || b === undefined) return [];
    const peak = Math.max(...skew.slice(Math.max(0, i - 60), i + 1).map((x) => x.value));
    const on = peak - p.value >= SKEW_COLLAPSE_DROP && v >= FLUSH_VIX && a <= -FLUSH_FALL && b <= -FLUSH_FALL;
    return [{ date: p.date, value: on ? 1 : 0 }];
  });
}

/** 最近 10 个交易日内最后一次出清的日期;没有 → null。 */
export function recentFlush(flush: Point[]): string | null {
  return (
    flush
      .slice(-FLUSH_RECENT)
      .filter((p) => p.value === 1)
      .at(-1)?.date ?? null
  );
}

// 综合压力分(0–100,方案 A,用户 2026-11-21 定):照付鹏原页 computeStressIndex 的分段线性给分,
// 做市商 30 分里只有 GEX 一项我们有 —— GEX 保留原页的 12 分、改按自身分位给(口径与原页 $B 不同,原公式套上去几乎恒为 1~2 分);
// Dealer Gamma / Net Delta 的 18 分没数据,按原权重比例匀给其余四块(×88/70)。2019-10 起回测:分数 0–20 之后 21 日回撤 ≥5% 约 9%,60 以上约 28%。
function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}
function lin(v: number, from: number, to: number, pts: number) {
  return clamp(((v - from) / (to - from)) * pts, 0, pts);
}
const REDISTRIBUTE = 88 / 70;

/** 每一项:读哪条、怎么给分(满分已按 ×88/70 放大);gexPctl 是 GEX 的滚动 5 年分位 */
const STRESS_ITEMS: { key: string; pts: (v: number) => number }[] = [
  { key: 'vix', pts: (v) => lin(v, 14, 36, 15) * REDISTRIBUTE },
  { key: 'vvix', pts: (v) => lin(v, 85, 135, 10) * REDISTRIBUTE },
  { key: 'vixVix3m', pts: (v) => lin(v, 0.88, 1.12, 9) * REDISTRIBUTE },
  { key: 'vix9dVix', pts: (v) => lin(v, 0.88, 1.12, 6) * REDISTRIBUTE },
  { key: 'vixeqVix', pts: (v) => lin(v, 2.5, 1.35, 15) * REDISTRIBUTE },
  { key: 'pcEquity', pts: (v) => lin(v, 0.5, 0.9, 6) * REDISTRIBUTE },
  { key: 'pcTotal', pts: (v) => lin(v, 0.8, 1.35, 5) * REDISTRIBUTE },
  { key: 'pcIndex', pts: (v) => lin(v, 1, 1.4, 4) * REDISTRIBUTE },
  // P50 以上 0 分,P5 及以下满分:GEX 是放大器,平静时不加分
  { key: 'gexPctl', pts: (p) => lin(p, 50, 5, 12) },
];

/** 总分读哪些键(gexPctl = GEX 的滚动分位,其余是各序列原值),页面取读数用这份,别另列 */
export const STRESS_KEYS = STRESS_ITEMS.map((it) => it.key);

/** 综合压力分;缺数的项不计分,另报缺几项(同维度分的口径)。 */
export function stressScore(read: Partial<Record<string, number>>): { total: number; missing: number } {
  const known = STRESS_ITEMS.filter((it) => Number.isFinite(read[it.key] ?? NaN));
  const total = known.reduce((sum, it) => sum + it.pts(read[it.key] as number), 0);

  return { total: known.length ? Math.round(total) : NaN, missing: STRESS_ITEMS.length - known.length };
}

// 历史图用:各项按日期取「≤ 当天、最近 5 个日历日内」的最新值(P/C 晚一天发,节假日两边日历不齐),
// 九项都有才出点 —— 缺项的日子不出点,免得历史上某天因缺数被算低
const STRESS_ASOF_DAYS = 5;

/** 逐日综合压力分(按 VIX 的日期);gexPctl 是 GEX 的逐日滚动 5 年分位(rollingPctl(gex))。 */
export function stressSeries(s: SeriesMap, gexPctl: Point[]): Point[] {
  const src: Record<string, Point[]> = Object.fromEntries(
    STRESS_ITEMS.map((it) => [it.key, it.key === 'gexPctl' ? gexPctl : (s[it.key] ?? [])]),
  );
  const cursor: Record<string, number> = Object.fromEntries(STRESS_ITEMS.map((it) => [it.key, -1]));
  const out: Point[] = [];

  for (const p of s.vix ?? []) {
    const limit = new Date(Date.parse(p.date) - STRESS_ASOF_DAYS * 86_400_000).toISOString().slice(0, 10);
    const read: Record<string, number> = {};
    for (const it of STRESS_ITEMS) {
      const rows = src[it.key];
      while (cursor[it.key] + 1 < rows.length && rows[cursor[it.key] + 1].date <= p.date) cursor[it.key]++;
      const hit = rows[cursor[it.key]];
      if (hit && hit.date >= limit) read[it.key] = hit.value;
    }
    const sc = stressScore(read);
    if (sc.missing === 0) out.push({ date: p.date, value: sc.total });
  }
  return out;
}

// 峰值回落看最近 20 个交易日,不跟阶段段落走:阶段每日独立判、会在门槛附近来回跳(用户 2026-11-21 定不加防抖),
// 按段落起点算的话一跳就清零
const STRESS_PEAK_LOOKBACK = 20;

/** 最近 20 个交易日综合压力分的峰值与已回落多少:阶段三里分不出「在加剧」还是「在退潮」,这个读数补上。没有点 → null。 */
export function stressPeak(stress: Point[]): { peak: number; date: string; now: number; drop: number } | null {
  const rows = stress.slice(-STRESS_PEAK_LOOKBACK);
  const last = rows.at(-1);
  if (!last) return null;
  const top = rows.reduce((a, b) => (b.value > a.value ? b : a));

  return { peak: top.value, date: top.date, now: last.value, drop: top.value - last.value };
}
