// 净值曲线 → 绩效指标;状态序列 → episode 计数。纯函数。
import type { EquityPoint } from './engine';
import type { DayState } from './signal';

export type Metrics = { cagr: number; mdd: number; sharpe: number; sortino: number; calmar: number };

export function metrics(equity: EquityPoint[], periodsPerYear = 252): Metrics {
  const rets = equity.slice(1).map((e, i) => e.value / equity[i].value - 1);
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const downside = Math.sqrt(rets.filter((r) => r < 0).reduce((a, b) => a + b * b, 0) / n);

  const years = n / periodsPerYear;
  const cagr = (equity[n].value / equity[0].value) ** (1 / years) - 1;

  // 最大回撤:跑动峰值(命令式扫描)。
  let peak = -Infinity;
  let mdd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    mdd = Math.min(mdd, e.value / peak - 1);
  }

  const sharpe = std ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  const sortino = downside ? (mean / downside) * Math.sqrt(periodsPerYear) : 0;
  const calmar = mdd ? cagr / Math.abs(mdd) : 0;
  return { cagr, mdd, sharpe, sortino, calmar };
}

export type EpisodeStat = { days: number; episodes: number };

/** episode = 状态从 false→true 的次数;days = 状态为 true 的天数。 */
export function episodes(states: DayState[], key: 'panic' | 'greed'): EpisodeStat {
  let days = 0;
  let count = 0;
  let prev = false;
  for (const s of states) {
    if (s[key]) {
      days++;
      if (!prev) count++;
    }
    prev = s[key];
  }
  return { days, episodes: count };
}
