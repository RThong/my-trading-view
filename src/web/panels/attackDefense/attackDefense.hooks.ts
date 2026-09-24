// 攻防指标数据层:NOBL/QQQ 比值 + ZigZag 攻防 regime 分区(慢/事后确认)+ 均线滞回快线 + specs 构造。纯逻辑,便于单测。
import useSWR from 'swr';
import { zigzagRegimes, type Regime } from '../../lib/zigzag';
import type { Spec } from '../chart/paneChart.types';
import type { PriceBar } from '../asset/assetChart.hooks';

// 参数均按 2018-01~2026-09 实测选定:以 QQQ ≥10% 回撤(16 次)为靶,量「接住几次 / 滞后 / 假警报」。
// 20% 阈值只接住 2 次(2025-02、2025-10 两轮回撤比值涨 15~19% 都没到 20%);10% 接住 11 次且实时翻防守 9/9 都在回撤期内。
export const SWING_PCT = 0.1; // 攻防 ZigZag 反转阈值:比值反向摆动 ≥10% 才确认一次攻防切换
// 快线:35 日均线 ±2% 滞回。接住 14/16、滞后中位 6 日、假警报 ~1 次/年;更短的 N 只快 1~2 天、假警报翻倍。
// 波动率带(均线 ±kσ)试过 18 组,同等假警报下都慢 4 天左右,不如固定百分比。
export const FAST_MA = 35;
export const FAST_BAND = 0.02;

type Point = { date: string; value: number };

/** 快线:比值相对 N 日均线的滞回判断,只用当日及以前的数据(不像 ZigZag 会回改历史)。
 *  比值 > 均线×(1+band) → defense;< 均线×(1−band) → offense;带内沿用前一状态。
 *  前 N−1 日没有均线 → ma=null、neutral。 */
export function fastRegime(
  ratio: Point[],
  n = FAST_MA,
  band = FAST_BAND,
): { date: string; ma: number | null; regime: Regime }[] {
  let sum = 0;
  let cur: Regime = 'neutral';
  return ratio.map((p, i) => {
    sum += p.value - (i >= n ? ratio[i - n].value : 0);
    const ma = i >= n - 1 ? sum / n : null;
    if (ma !== null && p.value > ma * (1 + band)) cur = 'defense';
    else if (ma !== null && p.value < ma * (1 - band)) cur = 'offense';
    return { date: p.date, ma, regime: cur };
  });
}

/** NOBL/QQQ 按日期内联相除(close)。qqq 缺该日或为 0 → 跳过;任一序列空 → []。 */
export function ratioSeries(nobl: PriceBar[], qqq: PriceBar[]): { date: string; value: number }[] {
  if (!nobl.length || !qqq.length) return [];
  const q = new Map(qqq.map((b) => [b.date, b.close]));
  return nobl.flatMap((b) => {
    const qc = q.get(b.date);
    return qc ? [{ date: b.date, value: b.close / qc }] : [];
  });
}

// ZigZag regime → 背景带色 {确认腿, 待定腿(更淡)}。查表代替嵌套三元。
const BG: Record<Regime, { confirmed: string; pending: string }> = {
  defense: { confirmed: 'rgba(34,197,94,0.35)', pending: 'rgba(34,197,94,0.15)' }, // 防守=绿
  offense: { confirmed: 'rgba(239,68,68,0.35)', pending: 'rgba(239,68,68,0.15)' }, // 进攻=红
  neutral: { confirmed: 'rgba(0,0,0,0)', pending: 'rgba(0,0,0,0)' },
};
// 快线细色带用实色,与背景的半透明区分开:同色 = 快慢一致,反色 = 预警。
const STRIP: Record<Regime, string> = {
  defense: 'rgba(34,197,94,0.9)',
  offense: 'rgba(239,68,68,0.9)',
  neutral: 'rgba(0,0,0,0)',
};
export const RATIO_COLOR = '#d4d4d8'; // 中性亮线,压在红绿背景上清楚
export const MA_COLOR = '#f59e0b';

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

/** 攻防数据层:拉 QQQ + NOBL,算 NOBL/QQQ 比值 + ZigZag 攻防 regime 分区 + 快线。 */
export function useAttackDefenseData() {
  const qq = useSWR<PriceBar[]>('/api/price/QQQ', getJson, SWR_OPTS);
  const nb = useSWR<PriceBar[]>('/api/price/NOBL', getJson, SWR_OPTS);
  const qqq = qq.data ?? [];
  const ratio = ratioSeries(nb.data ?? [], qqq);
  return {
    qqq,
    ratio,
    zones: zigzagRegimes(ratio, SWING_PCT),
    fast: fastRegime(ratio),
    error: (qq.error ?? nb.error) as Error | undefined,
    isLoading: qq.isLoading || nb.isLoading,
  };
}

/** 纯函数:QQQ 蜡烛 + NOBL/QQQ 比值线 + regime 背景带 + 快线(均线 + 底部细色带)→ specs(恒日频,不吃全局 interval)。 */
export function buildAttackDefenseSpecs(
  qqq: PriceBar[],
  ratio: Point[],
  zones: ReturnType<typeof zigzagRegimes>,
  fast: ReturnType<typeof fastRegime>,
): Spec[] {
  return [
    {
      key: 'qqq',
      pane: 0,
      kind: 'candle',
      title: 'QQQ',
      data: qqq.map((b) => ({
        time: b.date,
        open: b.open ?? b.close,
        high: b.high ?? b.close,
        low: b.low ?? b.close,
        close: b.close,
      })),
    },
    {
      key: 'ad-bg',
      pane: 1,
      kind: 'histogram',
      title: '',
      priceScaleId: 'bg-ad',
      data: zones.map((z) => ({
        time: z.date,
        value: z.regime === 'neutral' ? 0 : 1,
        color: BG[z.regime][z.pending ? 'pending' : 'confirmed'],
      })),
    },
    {
      key: 'ad-fast',
      pane: 1,
      kind: 'histogram',
      title: '',
      priceScaleId: 'fast-ad',
      scaleTop: 0.94,
      data: fast.map((f) => ({ time: f.date, value: f.regime === 'neutral' ? 0 : 1, color: STRIP[f.regime] })),
    },
    {
      key: 'ad-ma',
      pane: 1,
      kind: 'line',
      color: MA_COLOR,
      title: `MA${FAST_MA}`,
      data: fast.flatMap((f) => (f.ma === null ? [] : [{ time: f.date, value: f.ma }])),
    },
    {
      key: 'ad',
      pane: 1,
      kind: 'line',
      color: RATIO_COLOR,
      title: 'NOBL/QQQ',
      data: ratio.map((p) => ({ time: p.date, value: p.value })),
    },
  ];
}
