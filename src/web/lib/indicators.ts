// K 线技术指标纯函数:输入按时间升序的蜡烛,输出与 time 对齐的点;预热不足的开头不出点。
// 口径对齐 TradingView(ta.ema / ta.bb / ta.rsi),MACD 柱按国内软件 ×2;均已与 moomoo 03-30 读数逐位对账。
import type { Bar, LinePoint } from './chart';

type Closes = { time: string; close: number }[];

/** EMA:第 n 根用前 n 根的 SMA 起算,之后按 α=2/(n+1) 递推(Pine ta.ema 的种子口径)。 */
export function ema(bars: Closes, n: number): LinePoint[] {
  if (bars.length < n) return [];

  const alpha = 2 / (n + 1);
  const seed = bars.slice(0, n).reduce((s, b) => s + b.close, 0) / n;
  const out: LinePoint[] = [{ time: bars[n - 1].time, value: seed }];

  // 递推依赖上一个输出,命令式更直白。
  for (const b of bars.slice(n)) {
    out.push({ time: b.time, value: alpha * b.close + (1 - alpha) * out[out.length - 1].value });
  }
  return out;
}

export type BollingerPoint = { time: string; upper: number; mid: number; lower: number };

/** 布林带:SMA(n) ± k·σ。σ 用总体标准差(除以 n),与 Pine ta.stdev 默认 biased=true 一致。 */
export function bollinger(bars: Bar[], n = 20, k = 2): BollingerPoint[] {
  return bars.slice(n - 1).map((b, i) => {
    const win = bars.slice(i, i + n).map((x) => x.close);
    const mid = win.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(win.reduce((s, v) => s + (v - mid) ** 2, 0) / n);

    return { time: b.time, upper: mid + k * sd, mid, lower: mid - k * sd };
  });
}

export type MacdPoint = { time: string; dif: number; dea: number; hist: number };

/** MACD:DIF = EMA(fast) − EMA(slow),DEA = DIF 的 EMA(signal),柱 = 2·(DIF − DEA)(moomoo / 国内口径;TradingView 不乘 2)。 */
export function macd(bars: Closes, fast = 12, slow = 26, signal = 9): MacdPoint[] {
  const slowAt = new Map(ema(bars, slow).map((p) => [p.time, p.value]));
  const dif = ema(bars, fast).flatMap((p) => {
    const s = slowAt.get(p.time);
    return s === undefined ? [] : [{ time: p.time, close: p.value - s }];
  });
  const deaAt = new Map(ema(dif, signal).map((p) => [p.time, p.value]));

  return dif.flatMap((p) => {
    const dea = deaAt.get(p.time);
    return dea === undefined ? [] : [{ time: p.time, dif: p.close, dea, hist: 2 * (p.close - dea) }];
  });
}

/** RSI:Wilder 平滑(α=1/n),种子 = 前 n 个涨跌的简单平均(TradingView ta.rsi / moomoo 同口径)。全无下跌记 100。 */
export function rsi(bars: Closes, n: number): LinePoint[] {
  if (bars.length <= n) return [];

  const changes = bars.slice(1).map((b, i) => b.close - bars[i].close);
  let up = changes.slice(0, n).reduce((s, v) => s + Math.max(v, 0), 0) / n;
  let down = changes.slice(0, n).reduce((s, v) => s + Math.max(-v, 0), 0) / n;
  const value = () => (down === 0 ? 100 : 100 - 100 / (1 + up / down));
  const out: LinePoint[] = [{ time: bars[n].time, value: value() }];

  // Wilder 递推依赖上一步的 up/down 两个量,命令式更直白。
  for (const [i, v] of changes.slice(n).entries()) {
    up = (up * (n - 1) + Math.max(v, 0)) / n;
    down = (down * (n - 1) + Math.max(-v, 0)) / n;
    out.push({ time: bars[n + 1 + i].time, value: value() });
  }
  return out;
}
