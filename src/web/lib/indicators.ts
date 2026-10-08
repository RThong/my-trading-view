// K 线技术指标纯函数:输入按时间升序的蜡烛,输出与 time 对齐的点;预热不足的开头不出点。
// 口径对齐 TradingView(ta.ema / ta.bb),否则同一根 K 线两边读数对不上。
import type { Bar, LinePoint } from './chart';

/** EMA:第 n 根用前 n 根的 SMA 起算,之后按 α=2/(n+1) 递推(Pine ta.ema 的种子口径)。 */
export function ema(bars: Bar[], n: number): LinePoint[] {
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
