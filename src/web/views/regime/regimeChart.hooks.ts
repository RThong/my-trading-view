// regime 视图的数据层:/api/regime 取数(固定面板的 ChartDoc 与基本面共用)+ 基本面 pane 配置的类型 + spec 构造。
// 固定维度是 ChartDoc(pages/<视角>/docs.ts,views/chartDoc/DocChart 画);这里的 PaneSpec / buildRegimeSpecs 只剩基本面维度用。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { useServerRefresh } from '../../hooks/useServerRefresh';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../../chart/core';
import { percentileRank } from '../../../shared/calc/stats';
import type { SeriesKey } from '../../../shared/regimeSeries';
import type { Interval } from '../../hooks/interval';
import type { PaneDef, LineSpec, HistoSpec, HistoPoint, Spec } from '../../chart/paneChart.types';
import type { ChartDoc } from '../chartDoc/chartDoc';
import { isAggregateMember, type FundTrim, type SecFiled, type SecLag } from '../../../shared/aiChain';
import { getJson, SWR_OPTS } from '../../lib/http';
import { SIGNED_DOWN, SIGNED_UP } from '../../chart/palette';
import { percentileMarks } from '../../chart/percentileMarks';

export type RegimePoint = { date: string; value: number };
export type RegimeData = {
  series: Record<string, RegimePoint[]>;
  unavailable: string[];
  /** 本次现拉失败、服务端用上一份成功数据顶上的序列(面板标「沿用上次」)。 */
  fallback?: string[];
  /** 服务端缓存过期、后台刷新中(见 server/routes/swrCache):先给的是旧数据。 */
  refreshing?: boolean;
  /** 服务端缓存值不完整(有源没拉到,等重试)。 */
  partial?: boolean;
  ohlc?: Record<string, Bar[]>;
  secLag?: SecLag[];
  secTrim?: FundTrim[];
  /** 每家最新一期的期末与申报日(ticker → …),见 storage/repository 的 getSecLatestFiled。 */
  secFiled?: Record<string, SecFiled>;
};
const NO_DATA: RegimeData = { series: {}, unavailable: [] }; // 稳定空引用,避免 render 抖动
/** 三个 regime 视角共用;SWR 按 URL 去重,只发一次 /api/regime。 */
/** enabled = false 时不发请求(图表编辑器图上没用到 regime 序列时,不拉这份大响应)。 */
export function useRegimeData(enabled = true) {
  const {
    data = NO_DATA,
    error,
    isLoading,
    mutate,
  } = useSWR(enabled ? '/api/regime' : null, getJson<RegimeData>, SWR_OPTS);
  useServerRefresh('/api/regime', data, mutate);
  return { data, error: error as Error | undefined, isLoading };
}
export type RegimeDim =
  | 'credit'
  | 'liquidity'
  | 'sentiment'
  | 'macro'
  | 'ism'
  | 'vol'
  | 'ratesVol'
  | 'inflSource'
  | 'policyRepricing'
  | 'ratesDecomp'
  | 'jpy'
  | 'jgbVol'
  | 'jpBanks'
  | 'jpInflation'
  | 'jpGap'
  | 'jpTermPremium'
  | 'valuation'
  | 'concentration'
  | 'oil'
  | 'refinery'
  | 'pump'
  | 'btc'
  | 'btcOnchain'
  | 'compute'
  // 基本面按启用名单派生:一家一个 dim(三格),外加一条买方合计。见 dimPanes / companyPanes。
  | `fundamentals:${string}`;
/** 固定维度(配置写死那些,各是一份 ChartDoc);基本面维度是按名单派生的,不进这张表。 */
export type FixedDim = Exclude<RegimeDim, `fundamentals:${string}`>;
/** 基本面维度:按名单现算 PaneSpec,仍走旧 regime 图(RegimeChart)。 */
export type FundDim = Extract<RegimeDim, `fundamentals:${string}`>;
export function isFundDim(dim: RegimeDim): dim is FundDim {
  return dim.startsWith('fundamentals:');
}
// 每个 pane 自带完整定义:单一 key 既是 pane 身份,也是 data.series[key]/data.ohlc[key] 的数据键。
// 只剩基本面维度用(按名单现算,见 pages/ai/fundamentals);固定维度是 ChartDoc,由 views/chartDoc/DocChart 画。
export type PaneSpec = {
  /** 既是 pane 身份,也是 data.series[key] 的数据键 —— 收窄成后端对外名的全集,拼错即编译错误。 */
  key: SeriesKey;
  label: string; // 工具条 chip 名
  title: string; // 图例 / 命名
  color?: string; // 线色 / 图例色;符号柱与部分蜡烛不需要(留空则图例用默认色)
  desc?: string; // hover ⓘ 说明(谦虚版读法)
  render?: // 图形,默认 line
  // baseline:会穿零的序列画 0 基线(如 YoY)。step:低频序列画阶梯,见 LineSpec.step
    | { kind: 'line'; baseline?: number; step?: boolean }
    | { kind: 'signed' } // 符号柱状图(正绿负红,0 基线),不套分位/徽标
    | { kind: 'candle' }; // 蜡烛(用 data.ohlc[key]),不套分位/背景带;价格轴线性/对数按数据自判
  percentile?: { riskTail?: 'low' | 'high'; since?: string }; // 有=画 P5/P95+徽标;riskTail 决定背景带红/绿方向;since 限定分位窗口
};
/** 一个 regime 图要的全部配置:dim(存储键 / SEC 提示按它认公司)与它的 panes 绑在一起传,不会配错对。 */
export type RegimeView = { dim: FundDim; panes: PaneSpec[] };
/** 一个视角贡献的那几个 dim 的 ChartDoc(pages/<视角>/docs.ts 用 satisfies 对齐,汇总在 pages/regimeDims)。 */
export type RegimeDocs = Partial<Record<FixedDim, ChartDoc>>;

/** 从 panes[] 派生 PaneChartView 需要的平行 map(pane 定义 / 命名 / 配色 / 说明)。 */
export function derivePaneMeta(panes: PaneSpec[]) {
  return {
    paneDefs: panes.map((p) => ({ key: p.key, label: p.label, series: [p.key] })) as PaneDef[],
    seriesName: Object.fromEntries(panes.map((p) => [p.key, p.title])),
    colors: Object.fromEntries(panes.flatMap((p) => (p.color ? [[p.key, p.color]] : []))),
    desc: Object.fromEntries(panes.flatMap((p) => (p.desc ? [[p.key, p.desc]] : []))),
  };
}
function toLine(rows: RegimePoint[]): LinePoint[] {
  return rows.map((r) => ({ time: r.date, value: r.value }));
}
/** 一序列一 pane:pane 下标 = panes 索引;缺失的序列(unavailable)不建 spec,该 pane 留空。
 *  percentile 的 pane:按原始日频值算 P5/P95 作参考线(与显示 interval 无关)。 */
export function buildRegimeSpecs(data: RegimeData, panes: PaneSpec[], interval: Interval): Spec[] {
  return panes.flatMap((p, pane): Spec[] => {
    const key = p.key;
    if (data.unavailable.includes(key)) return []; // unavailable 权威:不建 spec
    const render = p.render ?? { kind: 'line' as const };

    // 蜡烛:用 ohlc(按 interval 聚合 OHLC),涨绿跌红(addSeries 内置)。不套分位/背景带。
    if (render.kind === 'candle') {
      const bars = data.ohlc?.[key];
      if (!bars?.length) return [];
      return [{ key, pane, kind: 'candle', title: p.title, data: aggregateBars(bars, interval) }];
    }

    const rows = data.series[key];
    if (!rows) return [];
    const line = aggregate(toLine(rows), interval);

    // 符号柱状图:正绿负红、0 基线,不套分位带/徽标。
    if (render.kind === 'signed') {
      const bars: HistoPoint[] = line.map((pt) => ({
        time: pt.time,
        value: pt.value,
        color: pt.value >= 0 ? SIGNED_UP : SIGNED_DOWN,
      }));
      return [{ key, pane, kind: 'histogram', title: p.title, data: bars, baseline: 0 }];
    }

    const lineSpec: LineSpec = {
      key,
      pane,
      kind: 'line',
      color: p.color ?? '#a3a3a3',
      title: p.title,
      data: line,
      ...(render.baseline !== undefined ? { baseline: render.baseline } : {}),
      ...(render.step ? { step: true } : {}),
    };
    if (!p.percentile) return [lineSpec];

    // 分位:P5/P95 参考线用原始日频算(与显示 interval 无关);极端期画满高背景带。
    // since 给了则只用该子窗口算阈值(线仍画全部 rows);阈值再铺回整条线。
    const since = p.percentile.since;
    const vals = (since ? rows.filter((r) => r.date >= since) : rows).map((r) => r.value);
    const marks = percentileMarks(
      vals,
      rows.map((r) => ({ time: r.date, value: r.value })),
      { riskTail: p.percentile.riskTail },
    );
    if (marks) lineSpec.refLines = marks.lines;
    // 背景带 = 风险/机会信号,需已知风险端;无 riskTail 只留 P5/P95 线,不染背景。
    if (!marks?.band) return [lineSpec];
    const bgSpec: HistoSpec = {
      key: `${key}-bg`,
      pane,
      kind: 'histogram',
      title: '',
      data: marks.band,
      priceScaleId: `bg-${key}`,
    };
    return [bgSpec, lineSpec]; // bg 先建 → 画在线的下层
  });
}
/**
 * 「公司已申报、SEC 还没提供那一期」的滞后提示(基本面维度专用)。
 *
 * 判据**不看期末日期差** —— 各家财年季末天然错开两三个月(实测 NVDA 的最新期落后 AMZN 整季
 * 是正常的:它下一季 8 月底才申报),日期差分不清「还没到财报期」和「交了但 SEC 没吃进」。
 * 只有后端拿 submissions 的 filed 与库里 MAX(filed) 比出来的才是确定结论,即 data.secLag。
 *
 * 为什么必须显示:滞后时那条线的末端是三个月前的读数,而这组判据全在读「最新一季转没转负」,
 * 不标注就会把旧点当成最新(实测 META 停在 2026Q1 的 +13.2B,而 Q2 实际是 +1.7B)。
 * 合计那格是**全员齐才出点**,任何一家滞后都顶住整条线的末端,故照样提示。
 */
export function secLagNote(data: RegimeData, dim: RegimeDim): string | undefined {
  if (!data.secLag?.length || !dim.startsWith('fundamentals:')) return undefined;

  const who = dim.slice('fundamentals:'.length);
  const mine = data.secLag.filter((l) => (who === 'buyer' ? isAggregateMember(l.ticker) : l.ticker === who));
  if (!mine.length) return undefined;

  const one = (l: SecLag) => `${l.ticker} 截至 ${l.latestPeriodEnd ?? '无数据'}(${l.remoteFiled} 已申报,SEC 未提供)`;
  return `⚠️ 数据滞后:${mine.map(one).join(';')}`;
}
/**
 * 单家公司 tab 的「最新一期 + 申报日」(工具条末尾那行)。季频线看不出末端是不是刚发的那季。
 * 合计 tab 不标(多家拼的,dim 不是 ticker,查不到)。
 */
export function secFiledNote(data: RegimeData, dim: RegimeDim): string | undefined {
  const f = dim.startsWith('fundamentals:') ? data.secFiled?.[dim.slice('fundamentals:'.length)] : undefined;
  return f && `截至 ${f.periodEnd} · ${f.filed} 申报`;
}
/**
 * 「这一格被断档裁短了」的提示。**裁剪本身是对的,静默才是问题**。
 *
 * 折线只连点,断档两端会被连成一条斜率是编的直线,而这组判据全在读斜率 —— 所以必须裁。
 * 但裁完不说,用户看到的只是一条短线,分不清是「这家上市晚」还是「中间缺了几个季度、
 * TTM 因为凑不满四季而整段作废」。实测量级足以误导:AMZN capex 66 点裁到 33、
 * NVDA 16 裁到 11、买方合计 40 裁到 33。
 *
 * 缺口的成因在源侧(companyfacts 那几期压根没有 capex 行,补 tag 链没用),所以
 * **只在这里说,不在 job 里报警** —— 那会是一盏永远修不掉的常驻黄灯。
 */
export function secTrimNote(data: RegimeData, panes: PaneSpec[]): string | undefined {
  if (!data.secTrim?.length) return undefined;

  const keys = new Set(panes.map((p) => p.key));
  const mine = data.secTrim.filter((t) => keys.has(t.key));
  if (!mine.length) return undefined;

  const label = (key: string) => panes.find((p) => p.key === key)?.label ?? key;
  const one = (t: FundTrim) => `${label(t.key)} 少 ${t.dropped} 点(断在 ${t.gapFrom} → ${t.gapTo})`;

  return `⚠️ 已裁断档:${mine.map(one).join(';')}`;
}
/** 各序列最新值在自身历史里的百分位(徽标用,如 { cor1m: 'P3' })。仅 percentile 的 pane 产出。 */
export function regimePercentiles(data: RegimeData, panes: PaneSpec[]): Record<string, string> {
  return Object.fromEntries(
    panes.flatMap((p) => {
      if (!p.percentile) return []; // 无分位 pane(含 signed / candle)无徽标
      if (data.unavailable.includes(p.key)) return [];
      const rows = data.series[p.key];
      if (!rows?.length) return [];
      // 徽标 = 最新值在分位窗口内的排名(since 给了就只对子窗口排,与 buildRegimeSpecs 阈值同源)。
      const since = p.percentile.since;
      const base = since ? rows.filter((r) => r.date >= since) : rows;
      const rank = percentileRank(
        base.map((r) => r.value),
        rows[rows.length - 1].value,
      );
      return Number.isNaN(rank) ? [] : [[p.key, `P${rank}`]];
    }),
  );
}
