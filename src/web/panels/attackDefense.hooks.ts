// 攻防指标数据层:NOBL/QQQ 比值 + 均线迟滞 regime。纯函数,便于单测。
import type { PriceBar } from './assetChart.hooks';

export const MA_LEN = 150;   // trailing 均线长度(日),中期
export const BAND = 0.12;    // 迟滞带 ±12%,滤小颠簸

export type Regime = 'defense' | 'offense' | 'neutral';

/** NOBL/QQQ 按日期内联相除(close)。qqq 缺该日或为 0 → 跳过;任一序列空 → []。 */
export function ratioSeries(nobl: PriceBar[], qqq: PriceBar[]): { date: string; value: number }[] {
  if (!nobl.length || !qqq.length) return [];
  const q = new Map(qqq.map((b) => [b.date, b.close]));
  return nobl.flatMap((b) => {
    const qc = q.get(b.date);
    return qc ? [{ date: b.date, value: b.close / qc }] : [];
  });
}

/** trailing SMA(maLen) + 迟滞:偏离 >band→defense,<-band→offense,带内维持上一状态。
 *  前 maLen-1 点无均线 → neutral。因果(不看未来),历史不 repaint。 */
export function regimeZones(
  ratio: { date: string; value: number }[], maLen: number, band: number,
): { date: string; regime: Regime }[] {
  const out: { date: string; regime: Regime }[] = [];
  let regime: Regime = 'neutral';
  let sum = 0;
  const win: number[] = [];

  for (const p of ratio) {
    win.push(p.value);
    sum += p.value;
    if (win.length > maLen) sum -= win.shift()!;

    if (win.length < maLen) {
      out.push({ date: p.date, regime: 'neutral' });
      continue;
    }
    const s = p.value / (sum / maLen) - 1; // 相对均线偏离
    if (s > band) regime = 'defense';
    else if (s < -band) regime = 'offense'; // 否则维持(迟滞)
    out.push({ date: p.date, regime });
  }
  return out;
}
