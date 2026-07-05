// 日频回测撮合:每日状态 → 目标权重 → 次日 close-to-close 复权收益推进净值。纯函数。
// states 与 prices 按 index 对齐(同日期,由 run.ts 保证)。执行错位:第 t 天状态用 t→t+1 收益。
import type { DayState } from './signal';

export type AlignedRow = { date: string; qqq: number; tqqq: number }; // 复权收盘
export type EquityPoint = { date: string; value: number };

export type EngineConfig = {
  tqqqSleeve: number; // 恐慌时换入 TQQQ 的比例(默认 0.30)
  cashSleeve: number; // 贪婪时转现金的比例(默认 0.20)
  costBps: number;    // 单边换手成本(基点)
  legs: { rotation: boolean; cashInsurance: boolean };
};

type Weights = { qqq: number; tqqq: number; cash: number };

function targetWeights(st: DayState, cfg: EngineConfig): Weights {
  if (cfg.legs.rotation && st.panic) return { qqq: 1 - cfg.tqqqSleeve, tqqq: cfg.tqqqSleeve, cash: 0 };
  if (cfg.legs.cashInsurance && st.greed) return { qqq: 1 - cfg.cashSleeve, tqqq: 0, cash: cfg.cashSleeve };
  return { qqq: 1, tqqq: 0, cash: 0 };
}

export function runBacktest(states: DayState[], prices: AlignedRow[], cfg: EngineConfig): EquityPoint[] {
  const cost = cfg.costBps / 1e4;

  // 净值跨日累积(命令式扫描)。第 t 天定权重 → 吃 t→t+1 收益;换手按 L1 权重变动收成本。
  const equity: EquityPoint[] = [{ date: prices[0].date, value: 1 }];
  let prev: Weights = { qqq: 1, tqqq: 0, cash: 0 };
  let value = 1;
  for (let t = 0; t < prices.length - 1; t++) {
    const w = targetWeights(states[t], cfg);
    const turnover = Math.abs(w.qqq - prev.qqq) + Math.abs(w.tqqq - prev.tqqq) + Math.abs(w.cash - prev.cash);
    const qqqRet = prices[t + 1].qqq / prices[t].qqq - 1;
    const tqqqRet = prices[t + 1].tqqq / prices[t].tqqq - 1;
    const portRet = w.qqq * qqqRet + w.tqqq * tqqqRet; // cash 收益 0

    value = value * (1 + portRet) * (1 - cost * turnover);
    equity.push({ date: prices[t + 1].date, value });
    prev = w;
  }
  return equity;
}
