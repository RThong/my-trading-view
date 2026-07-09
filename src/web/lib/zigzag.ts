// 通用 ZigZag 摆动 regime 检测:对任意 {date,value}[] 序列,按 pct 反转阈值划出上行/下行段。
// 纯函数、与业务无关(攻防面板等按需复用)。regime 标签沿用当前唯一消费方(攻防)的语义。
export type Regime = 'defense' | 'offense' | 'neutral';

/** ZigZag 摆动检测(吸附极值):跟踪自上个拐点的波峰/波谷,反转 pct 确认拐点并回贴到极值点。
 *  腿方向 = 走向该腿终点:结束于峰=上行(defense)、结束于谷=下行(offense);首拐点前同理。
 *  末腿(最后拐点之后)未确认 → pending。无拐点 → 全 neutral。 */
export function zigzagRegimes(
  series: { date: string; value: number }[], pct: number,
): { date: string; regime: Regime; pending: boolean }[] {
  const n = series.length;
  if (n === 0) return [];

  type Pivot = { idx: number; kind: 'peak' | 'trough' };
  const pivots: Pivot[] = [];
  let dir: 0 | 1 | -1 = 0; // 0 未定, 1 上行腿, -1 下行腿
  let hiIdx = 0, hiVal = series[0].value;
  let loIdx = 0, loVal = series[0].value;

  for (let i = 1; i < n; i++) {
    const v = series[i].value;
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

  const out = series.map((p) => ({ date: p.date, regime: 'neutral' as Regime, pending: false }));
  if (pivots.length === 0) return out; // 整段无 pct 反转

  // 结束于峰的腿=defense(上行),结束于谷的腿=offense(下行);首拐点前那段同理。
  let start = 0;
  for (const pv of pivots) {
    const reg: Regime = pv.kind === 'peak' ? 'defense' : 'offense';
    for (let i = start; i <= pv.idx; i++) out[i] = { date: series[i].date, regime: reg, pending: false };
    start = pv.idx + 1;
  }
  // 末腿(最后拐点之后)未确认 → pending;峰后下行=offense,谷后上行=defense。
  const last = pivots[pivots.length - 1];
  const tail: Regime = last.kind === 'peak' ? 'offense' : 'defense';
  for (let i = start; i < n; i++) out[i] = { date: series[i].date, regime: tail, pending: true };

  return out;
}
