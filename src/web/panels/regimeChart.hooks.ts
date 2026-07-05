// 宏观 regime 视角的数据层:取数 + 各维度的 pane 配置 + spec 构造。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { aggregate, type LinePoint } from '../lib/chart';
import type { Interval } from '../hooks/interval';
import type { PaneDef, LineSpec, Spec } from './assetChart.hooks';

export type RegimePoint = { date: string; value: number };
export type RegimeData = { series: Record<string, RegimePoint[]>; unavailable: string[] };

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

export type RegimeDim = 'credit' | 'liquidity' | 'sentiment';

type DimConfig = {
  paneDefs: PaneDef[];               // 一序列一 pane;key = series key
  seriesName: Record<string, string>;
  colors: Record<string, string>;
  baseline?: Record<string, number>; // 会穿零的序列画 0 基线(如回购压力)
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
  sentiment: {
    paneDefs: [
      { key: 'fng', label: 'Fear&Greed', series: ['fng'] },
      { key: 'cor1m', label: 'COR1M', series: ['cor1m'] },
      { key: 'vixeq', label: 'VIXEQ', series: ['vixeq'] },
    ],
    seriesName: { fng: 'Fear & Greed', cor1m: '隐含相关性 COR1M', vixeq: '成分股波动率 VIXEQ' },
    colors: { fng: '#3b82f6', cor1m: '#22c55e', vixeq: '#ec4899' },
  },
};

const toLine = (rows: RegimePoint[]): LinePoint[] => rows.map((r) => ({ time: r.date, value: r.value }));

/** 一序列一 pane:pane 下标 = paneDefs 索引;缺失的序列(unavailable)不建 spec,该 pane 留空。 */
export function buildRegimeSpecs(data: RegimeData, dim: RegimeDim, interval: Interval): Spec[] {
  const cfg = REGIME_DIMS[dim];
  return cfg.paneDefs.flatMap((def, pane): Spec[] => {
    const key = def.series[0];
    const rows = data.series[key];
    if (!rows) return [];
    const spec: LineSpec = {
      key, pane, kind: 'line', color: cfg.colors[key], title: cfg.seriesName[key],
      data: aggregate(toLine(rows), interval),
      ...(cfg.baseline?.[key] !== undefined ? { baseline: cfg.baseline[key] } : {}),
    };
    return [spec];
  });
}
