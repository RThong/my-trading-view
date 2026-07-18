// 攻防指标数据层:NOBL/QQQ 比值。regime 判定用通用 ZigZag(见 lib/zigzag)。纯函数,便于单测。
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
