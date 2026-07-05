// VX1−V3 期限结构信号 → 每日 {panic, greed} 状态。纯函数,输入 spread 按日期升序。
// 无未来函数:第 t 天的 rank 只用 spread[0..t](含当天);见 signal.test.ts 的锁死测试。
import { percentileRank } from '../../shared/stats';

export type SpreadPoint = { date: string; value: number };
export type PanicEntry = 'A' | 'B' | 'C'; // A: spread>0(backwardation);B: rank≥阈值;C: A||B
export type DayState = { date: string; panic: boolean; greed: boolean };

export type SignalConfig = {
  warmup: number;        // 预热天数,之前不产生信号
  panicEntry: PanicEntry;
  panicEnterRank: number;
  panicExitRank: number;
  greedEnterRank: number;
  greedExitRank: number;
};

export const DEFAULT_SIGNAL: Omit<SignalConfig, 'panicEntry'> = {
  warmup: 252, panicEnterRank: 85, panicExitRank: 50, greedEnterRank: 10, greedExitRank: 30,
};

export function computeStates(spread: SpreadPoint[], cfg: SignalConfig): DayState[] {
  const vals = spread.map((p) => p.value);

  // 状态机跨日累积(带滞后),属命令式扫描;逐日推进 panic/greed。
  const out: DayState[] = [];
  let panic = false;
  let greed = false;
  for (let t = 0; t < spread.length; t++) {
    if (t < cfg.warmup) {
      out.push({ date: spread[t].date, panic: false, greed: false });
      continue;
    }
    const rank = percentileRank(vals.slice(0, t + 1), vals[t]); // 扩张窗口,含当天,无未来
    const backwardation = vals[t] > 0;
    const panicEnter = cfg.panicEntry === 'A' ? backwardation
      : cfg.panicEntry === 'B' ? rank >= cfg.panicEnterRank
      : backwardation || rank >= cfg.panicEnterRank;

    // 滞后:已在场 → 持有到跌破退出阈值;未在场 → 满足进入条件才入场。
    panic = panic ? rank > cfg.panicExitRank : panicEnter;
    greed = greed ? rank < cfg.greedExitRank : rank <= cfg.greedEnterRank;
    // 互斥:变体 A/C 下 spread>0 可在低 rank 时触发 panic 而 greed 也成立;
    // 恐慌(倒挂/急跌)压过贪婪(自满),同日两者都成立时 panic 优先。
    if (panic) greed = false;

    out.push({ date: spread[t].date, panic, greed });
  }
  return out;
}
