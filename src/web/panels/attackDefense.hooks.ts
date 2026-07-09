// 攻防指标数据层:NOBL/QQQ 比值 + 均线迟滞 regime。纯函数,便于单测。
import type { PriceBar } from './assetChart.hooks';

export const SWING_PCT = 0.08;  // ZigZag 反转阈值:摆动 ≥8% 才算一次大级别攻防切换

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

/** ZigZag 摆动检测(吸附极值):跟踪自上个拐点的波峰/波谷,反转 pct 确认拐点并回贴到极值点。
 *  腿方向 = 走向该腿终点:结束于峰=上行(defense)、结束于谷=下行(offense);首拐点前同理。
 *  末腿(最后拐点之后)未确认 → pending。无拐点 → 全 neutral。 */
export function regimeZones(
  ratio: { date: string; value: number }[], pct: number,
): { date: string; regime: Regime; pending: boolean }[] {
  const n = ratio.length;
  if (n === 0) return [];

  type Pivot = { idx: number; kind: 'peak' | 'trough' };
  const pivots: Pivot[] = [];
  let dir: 0 | 1 | -1 = 0; // 0 未定, 1 上行腿, -1 下行腿
  let hiIdx = 0, hiVal = ratio[0].value;
  let loIdx = 0, loVal = ratio[0].value;

  for (let i = 1; i < n; i++) {
    const v = ratio[i].value;
    if (v > hiVal) { hiVal = v; hiIdx = i; }
    if (v < loVal) { loVal = v; loIdx = i; }

    const isPeakConfirm = dir >= 0 && v <= hiVal * (1 - pct);
    const isTroughConfirm = dir <= 0 && v >= loVal * (1 + pct);

    // dir=0 时(首次拐点),仅在当前趋势方向触发拐点确认,避免虚假拐点
    if (dir === 0) {
      if (hiIdx > loIdx && isPeakConfirm) {
        pivots.push({ idx: hiIdx, kind: 'peak' });
        dir = -1; loVal = v; loIdx = i;
      } else if (loIdx > hiIdx && isTroughConfirm) {
        pivots.push({ idx: loIdx, kind: 'trough' });
        dir = 1; hiVal = v; hiIdx = i;
      }
    } else if (isPeakConfirm) {
      // 从波峰回落 pct → 确认峰(吸附到 hiIdx),转下行,重置波谷跟踪
      pivots.push({ idx: hiIdx, kind: 'peak' });
      dir = -1; loVal = v; loIdx = i;
    } else if (isTroughConfirm) {
      // 从波谷反弹 pct → 确认谷(吸附到 loIdx),转上行,重置波峰跟踪
      pivots.push({ idx: loIdx, kind: 'trough' });
      dir = 1; hiVal = v; hiIdx = i;
    }
  }

  const out = ratio.map((p) => ({ date: p.date, regime: 'neutral' as Regime, pending: false }));
  if (pivots.length === 0) return out; // 整段无 pct 反转

  // 结束于峰的腿=defense(上行),结束于谷的腿=offense(下行);首拐点前那段同理。
  let start = 0;
  for (const pv of pivots) {
    const reg: Regime = pv.kind === 'peak' ? 'defense' : 'offense';
    for (let i = start; i <= pv.idx; i++) out[i] = { date: ratio[i].date, regime: reg, pending: false };
    start = pv.idx + 1;
  }
  // 末腿(最后拐点之后)未确认 → pending;峰后下行=offense,谷后上行=defense。
  const last = pivots[pivots.length - 1];
  const tail: Regime = last.kind === 'peak' ? 'offense' : 'defense';
  for (let i = start; i < n; i++) out[i] = { date: ratio[i].date, regime: tail, pending: true };

  return out;
}
