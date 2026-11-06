// 分位标记:P5 / P95 两条线 + 风险端背景带。固定面板(regime)与图表编辑器共用这一份规则,两边画出来才一致。
import { percentile } from '../../shared/calc/stats';
import { BAND_CALM, BAND_RISK, TRANSPARENT } from './palette';

export const PCTL_LO = 5;
export const PCTL_HI = 95;

export type MarkLine = { price: number; title: string; color?: string };
export type BandPoint = { time: string; value: number; color: string };

type Options = {
  /** 哪一端是风险(染红,另一端染绿);不给 = 高低哪端是风险不确定,只画线不染背景 */
  riskTail?: 'low' | 'high';
  /** 配了有绝对含义的参考线时,线用它、不画 P5 / P95(不让两套尺并存),背景照样按分位染 */
  refLines?: MarkLine[];
};

/**
 * window:算阈值用的值(调用方已按 since 筛好);pts:要逐点判定染色的点。
 * window 为空(since 晚于全部数据)返回 null:算不出阈值,别画 NaN 价位的线。
 * 背景带每个点都有(段外透明,值恒为 1):各格共享时间轴按点排位,只放极端点的话段与段之间会被挤歪。
 */
export function percentileMarks(
  window: number[],
  pts: { time: string; value: number }[],
  { riskTail, refLines }: Options,
): { lines: MarkLine[]; band: BandPoint[] | null } | null {
  if (window.length === 0) return null;

  const lo = percentile(window, PCTL_LO);
  const hi = percentile(window, PCTL_HI);
  const lines = refLines ?? [
    { price: lo, title: `P${PCTL_LO}` },
    { price: hi, title: `P${PCTL_HI}` },
  ];
  const tint = (p: { time: string; value: number }): BandPoint => {
    if (p.value < lo) return { time: p.time, value: 1, color: riskTail === 'low' ? BAND_RISK : BAND_CALM };
    if (p.value > hi) return { time: p.time, value: 1, color: riskTail === 'high' ? BAND_RISK : BAND_CALM };
    return { time: p.time, value: 1, color: TRANSPARENT };
  };

  return { lines, band: riskTail === undefined ? null : pts.map(tint) };
}
