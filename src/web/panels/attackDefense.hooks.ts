// 攻防指标数据层:NOBL/QQQ 比值 + ZigZag 攻防 regime 分区 + specs 构造。纯逻辑,便于单测。
import useSWR from 'swr';
import { zigzagRegimes, type Regime } from '../lib/zigzag';
import type { Spec } from './paneChart.types';
import type { PriceBar } from './assetChart.hooks';

export const SWING_PCT = 0.2; // 攻防 ZigZag 反转阈值:摆动 ≥20% 才算一次大级别攻防切换

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
export const RATIO_COLOR = '#d4d4d8'; // 中性亮线,压在红绿背景上清楚

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

/** 攻防数据层:拉 QQQ + NOBL,算 NOBL/QQQ 比值 + ZigZag 攻防 regime 分区。 */
export function useAttackDefenseData() {
  const qq = useSWR<PriceBar[]>('/api/price/QQQ', getJson, SWR_OPTS);
  const nb = useSWR<PriceBar[]>('/api/price/NOBL', getJson, SWR_OPTS);
  const qqq = qq.data ?? [];
  const ratio = ratioSeries(nb.data ?? [], qqq);
  return {
    qqq,
    ratio,
    zones: zigzagRegimes(ratio, SWING_PCT),
    error: (qq.error ?? nb.error) as Error | undefined,
    isLoading: qq.isLoading || nb.isLoading,
  };
}

/** 纯函数:QQQ 蜡烛 + NOBL/QQQ 比值线 + regime 背景带 → specs(恒日频,不吃全局 interval)。 */
export function buildAttackDefenseSpecs(
  qqq: PriceBar[],
  ratio: { date: string; value: number }[],
  zones: ReturnType<typeof zigzagRegimes>,
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
      key: 'ad',
      pane: 1,
      kind: 'line',
      color: RATIO_COLOR,
      title: 'NOBL/QQQ',
      data: ratio.map((p) => ({ time: p.date, value: p.value })),
    },
  ];
}
