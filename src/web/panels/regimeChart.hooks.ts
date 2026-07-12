// 宏观 regime 视角的数据层:取数 + 各维度的 pane 配置 + spec 构造。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../lib/chart';
import { percentile, percentileRank } from '../../shared/stats';
import type { Interval } from '../hooks/interval';
import type { PaneDef, LineSpec, HistoSpec, HistoPoint, CandleSpec, Spec } from './assetChart.hooks';

// 分位带阈值(自身历史):想改 5/95 更严就动这里。
const PCTL_LO = 5;
const PCTL_HI = 95;
// 极端期背景带的半透明色:风险端红、机会端绿(方向由各序列 riskTail 决定)。
const BG_RED = 'rgba(239,68,68,0.45)';
const BG_GREEN = 'rgba(34,197,94,0.45)';
const BG_NONE = 'rgba(0,0,0,0)';
// 符号柱状图(期限结构):正=backwardation 绿、负=contango 红。
const SIGNED_UP = '#22c55e';
const SIGNED_DOWN = '#ef4444';

export type RegimePoint = { date: string; value: number };
export type RegimeData = { series: Record<string, RegimePoint[]>; unavailable: string[]; ohlc?: Record<string, Bar[]> };

const NO_DATA: RegimeData = { series: {}, unavailable: [] }; // 稳定空引用,避免 render 抖动
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

/** 三个 regime 视角共用;SWR 按 URL 去重,只发一次 /api/regime。 */
export function useRegimeData() {
  const { data = NO_DATA, error, isLoading } = useSWR('/api/regime', getJson<RegimeData>, SWR_OPTS);
  return { data, error: error as Error | undefined, isLoading };
}

export type RegimeDim = 'credit' | 'liquidity' | 'sentiment' | 'macro' | 'vol' | 'ratesVol' | 'inflSource';

type DimConfig = {
  paneDefs: PaneDef[];               // 一序列一 pane;key = series key
  seriesName: Record<string, string>;
  colors: Record<string, string>;
  baseline?: Record<string, number>; // 会穿零的序列画 0 基线(如回购压力)
  percentiles?: boolean;             // 该维度画 P5/P95 分位带 + 显示当前分位徽标(目前仅情绪)
  riskTail?: Record<string, 'low' | 'high'>; // 哪一端是"风险"(红),另一端为"机会"(绿)
  signed?: string[];                 // 这些序列画符号柱状图(正绿负红,0 基线),不套分位带/徽标(如期限结构)
  candle?: string[];                 // 这些序列画蜡烛(需 data.ohlc 提供 OHLC,如 DXY),不套分位/背景带
};

export const REGIME_DIMS: Record<RegimeDim, DimConfig> = {
  credit: {
    paneDefs: [{ key: 'hyOas', label: '信用利差', series: ['hyOas'] }],
    seriesName: { hyOas: 'HY 信用利差' },
    colors: { hyOas: '#f59e0b' },
  },
  liquidity: {
    paneDefs: [
      { key: 'netLiquidity', label: '净流动性', series: ['netLiquidity'] },
      { key: 'reverseRepo', label: '逆回购', series: ['reverseRepo'] },
      { key: 'repoUsage', label: '回购用量', series: ['repoUsage'] },
      { key: 'repoStress', label: '回购压力', series: ['repoStress'] },
    ],
    seriesName: {
      netLiquidity: '净流动性 (WALCL−TGA−RRP)', reverseRepo: '逆回购 RRP',
      repoUsage: '回购用量 SRF', repoStress: '回购压力 (IORB−SOFR)',
    },
    colors: { netLiquidity: '#22c55e', reverseRepo: '#14b8a6', repoUsage: '#ec4899', repoStress: '#a855f7' },
    baseline: { repoStress: 0 },
  },
  vol: {
    paneDefs: [
      { key: 'vix', label: 'VIX', series: ['vix'] },
      { key: 'vxn', label: 'VXN', series: ['vxn'] },
      { key: 'vixeq', label: 'VIXEQ', series: ['vixeq'] },
      { key: 'vxTerm', label: 'VX1−V3', series: ['vxTermSpread'] },
    ],
    seriesName: { vix: 'VIX', vxn: 'VXN (纳指波动率)', vixeq: '成分股波动率 VIXEQ', vxTermSpread: 'VX1−V3 期限结构' },
    colors: { vix: '#eab308', vxn: '#f97316', vixeq: '#ec4899' },
    percentiles: true,
    // 波动率类一律 低=压扁=自满=风险(逆向,恐慌飙高=机会)。
    riskTail: { vix: 'low', vxn: 'low', vixeq: 'low' },
    signed: ['vxTermSpread'], // 期限结构:符号柱状图,不套分位带
  },
  sentiment: {
    paneDefs: [
      { key: 'fng', label: 'Fear&Greed', series: ['fng'] },
      { key: 'cor1m', label: 'COR1M', series: ['cor1m'] },
      { key: 'rxmSpx', label: 'RXM/SPX', series: ['rxmSpx'] },
    ],
    seriesName: { fng: 'Fear & Greed', cor1m: '隐含相关性 COR1M', rxmSpx: 'RXM/SPX 期权情绪' },
    colors: { fng: '#3b82f6', cor1m: '#22c55e', rxmSpx: '#a855f7' },
    percentiles: true,
    // F&G 高=贪婪=风险;COR1M 低=自满=风险;RXM/SPX 低=melt-up/晚周期=风险。
    riskTail: { fng: 'high', cor1m: 'low', rxmSpx: 'low' },
  },
  macro: {
    paneDefs: [{ key: 'usd', label: '美元 DXY', series: ['usd'] }],
    seriesName: { usd: '美元指数 DXY' },
    colors: { usd: '#38bdf8' },
    candle: ['usd'], // DXY 画蜡烛(用 data.ohlc.usd)
  },
  // 利率水平 + 利率波动率:MOVE 是债市波动率,与利率同宗(和股市 VIX 相关性一般),故与 10Y 收益率配对。
  ratesVol: {
    paneDefs: [
      { key: 'dgs10', label: '10Y 国债', series: ['dgs10'] },
      { key: 'move', label: 'MOVE', series: ['move'] },
    ],
    seriesName: { dgs10: '10Y 国债收益率', move: 'MOVE (债市波动率)' },
    colors: { dgs10: '#22d3ee', move: '#f43f5e' },
    percentiles: true,
    riskTail: { move: 'low' }, // MOVE 压扁=自满=风险;10Y 收益率方向不单一,不设风险端
  },
  // 通胀来源(供给侧):薪资增速 + 服务黏性。与 BEI(市场前瞻预期)并读。高=通胀压力=风险。
  inflSource: {
    paneDefs: [
      { key: 'wages', label: '薪资增速', series: ['wages'] },
      { key: 'stickyCpi', label: '服务黏性', series: ['stickyCpi'] },
    ],
    seriesName: { wages: '薪资增速 (Atlanta Fed)', stickyCpi: 'Sticky CPI (服务黏性)' },
    colors: { wages: '#f59e0b', stickyCpi: '#8b5cf6' },
    percentiles: true,
    riskTail: { wages: 'high', stickyCpi: 'high' }, // 高=通胀压力=风险(红);低=缓解=绿
  },
};

const toLine = (rows: RegimePoint[]): LinePoint[] => rows.map((r) => ({ time: r.date, value: r.value }));

/** 一序列一 pane:pane 下标 = paneDefs 索引;缺失的序列(unavailable)不建 spec,该 pane 留空。
 *  开启 percentiles 的维度:每序列按原始日频值算 P5/P95 作参考线(与显示 interval 无关)。 */
export function buildRegimeSpecs(data: RegimeData, dim: RegimeDim, interval: Interval): Spec[] {
  const cfg = REGIME_DIMS[dim];
  return cfg.paneDefs.flatMap((def, pane): Spec[] => {
    const key = def.series[0];
    if (data.unavailable.includes(key)) return []; // unavailable 权威:不建 spec

    // 蜡烛:用 ohlc(按 interval 聚合 OHLC),涨绿跌红(addSeries 内置)。不套分位/背景带。
    if (cfg.candle?.includes(key)) {
      const bars = data.ohlc?.[key];
      if (!bars?.length) return [];
      const candle: CandleSpec = { key, pane, kind: 'candle', title: cfg.seriesName[key], data: aggregateBars(bars, interval) };
      return [candle];
    }

    const rows = data.series[key];
    if (!rows) return [];
    const line = aggregate(toLine(rows), interval);

    // 符号柱状图(期限结构):正绿负红、0 基线,不套分位带/徽标。
    if (cfg.signed?.includes(key)) {
      const bars: HistoPoint[] = line.map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? SIGNED_UP : SIGNED_DOWN }));
      const histo: HistoSpec = { key, pane, kind: 'histogram', title: cfg.seriesName[key], data: bars, baseline: 0 };
      return [histo];
    }

    const lineSpec: LineSpec = {
      key, pane, kind: 'line', color: cfg.colors[key], title: cfg.seriesName[key], data: line,
      ...(cfg.baseline?.[key] !== undefined ? { baseline: cfg.baseline[key] } : {}),
    };
    if (!cfg.percentiles) return [lineSpec];

    // 分位:P5/P95 参考线用原始日频算(与显示 interval 无关);极端期画满高背景带。
    const vals = rows.map((r) => r.value);
    const lo = percentile(vals, PCTL_LO);
    const hi = percentile(vals, PCTL_HI);
    lineSpec.refLines = [{ price: lo, title: `P${PCTL_LO}` }, { price: hi, title: `P${PCTL_HI}` }];
    const risk = cfg.riskTail?.[key];
    // 背景带 = 风险/机会信号,需已知风险端;无 riskTail 的序列(如 10Y 收益率,高低方向不单一)只留 P5/P95 线,不染背景。
    if (risk === undefined) return [lineSpec];
    // 背景带按原始日频逐日判定极端(不用聚合点),保证与显示 interval 无关。
    const bgData: HistoPoint[] = rows.map((r) => {
      if (r.value < lo) return { time: r.date, value: 1, color: risk === 'low' ? BG_RED : BG_GREEN };
      if (r.value > hi) return { time: r.date, value: 1, color: risk === 'high' ? BG_RED : BG_GREEN };
      return { time: r.date, value: 0, color: BG_NONE };
    });
    const bgSpec: HistoSpec = { key: `${key}-bg`, pane, kind: 'histogram', title: '', data: bgData, priceScaleId: `bg-${key}` };
    return [bgSpec, lineSpec]; // bg 先建 → 画在线的下层
  });
}

/** 各序列最新值在自身历史里的百分位(徽标用,如 { cor1m: 'P3' })。仅 percentiles 维度产出。 */
export function regimePercentiles(data: RegimeData, dim: RegimeDim): Record<string, string> {
  const cfg = REGIME_DIMS[dim];
  if (!cfg.percentiles) return {};

  return Object.fromEntries(
    cfg.paneDefs.flatMap((def) => {
      const key = def.series[0];
      if (cfg.signed?.includes(key)) return []; // 符号柱状图无分位徽标
      if (data.unavailable.includes(key)) return [];
      const rows = data.series[key];
      if (!rows?.length) return [];
      const rank = percentileRank(rows.map((r) => r.value), rows[rows.length - 1].value);
      return Number.isNaN(rank) ? [] : [[key, `P${rank}`]];
    }),
  );
}
