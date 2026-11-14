// regime 视图的数据层:/api/regime 取数(固定面板与基本面的 ChartDoc 共用)+ dim 类型 + 基本面的 SEC 提示。
// 固定维度的配置在 pages/<视角>/docs.ts,基本面按名单现算(pages/ai/fundamentals),都由 views/chartDoc/DocChart 画。
import useSWR from 'swr';
import { useServerRefresh } from '../../hooks/useServerRefresh';
import type { Bar } from '../../chart/core';
import type { ChartDoc } from '../chartDoc/chartDoc';
import { isAggregateMember, type FundTrim, type SecFiled, type SecLag } from '../../../shared/aiChain';
import { getJson, SWR_OPTS } from '../../lib/http';

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
  | 'jpFlows'
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
  // 曲线期限走势(每个期限一条线 + 差值格,见 pages/curveHistory)
  | 'ustHistory'
  | 'oisHistory'
  | 'realHistory'
  | 'beiHistory'
  | 'jgbHistory'
  | 'aiCds'
  // 基本面按启用名单派生:一家一个 dim(6~8 格,按数据源与分部披露),外加一个买方合计。见 pages/ai/fundamentals 的 fundDoc。
  | `fundamentals:${string}`;
/** 固定维度(配置写死那些,各是一份 ChartDoc);基本面维度是按名单派生的,不进这张表。 */
export type FixedDim = Exclude<RegimeDim, `fundamentals:${string}`>;
/** 基本面维度:按公司名单现算 ChartDoc(见 pages/ai/fundamentals 的 fundDoc)。 */
export type FundDim = Extract<RegimeDim, `fundamentals:${string}`>;
export function isFundDim(dim: RegimeDim): dim is FundDim {
  return dim.startsWith('fundamentals:');
}
/** 一个视角贡献的那几个 dim 的 ChartDoc(pages/<视角>/docs.ts 用 satisfies 对齐,汇总在 pages/regimeDims)。 */
export type RegimeDocs = Partial<Record<FixedDim, ChartDoc>>;

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
export function secTrimNote(data: RegimeData, doc: ChartDoc): string | undefined {
  if (!data.secTrim?.length) return undefined;

  const layers = doc.panes.flatMap((p) => p.layers);
  const mine = data.secTrim.filter((t) => layers.some((l) => l.series === t.key));
  if (!mine.length) return undefined;

  const label = (key: string) => layers.find((l) => l.series === key)?.title ?? key;
  const one = (t: FundTrim) => `${label(t.key)} 少 ${t.dropped} 点(断在 ${t.gapFrom} → ${t.gapTo})`;

  return `⚠️ 已裁断档:${mine.map(one).join(';')}`;
}
