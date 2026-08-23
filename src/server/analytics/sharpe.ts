/**
 * 滚动夏普比率(年化)。口径与 analytics/vrp 的 RV 对齐:对数收益、样本标准差、√periodsPerYear 年化。
 * Sharpe = mean(logRet) / sd(logRet) × √periodsPerYear。
 */
import { mean } from 'remeda';
import { logReturns, type Point } from './vrp';

/**
 * ponytail: 不减无风险利率(纯 return/vol)。BTC 年化波动 ~50%,4% 的 rf 只挪 Sharpe ~0.08,
 * 相对本序列 −2 ~ +3.3 的量程可忽略;真要严格口径就在这里减 DGS3MO 的日频等价。
 *
 * ⚠️ window 数的是**收益点**,不是日历日 —— logReturns 会跳过非正价格那一对,
 * 所以序列缺日时窗口会静默拉长到 >window 天。与 realizedVol 同口径(刻意保持一致)。
 * 现库 BTC 2012 起零缺口,两者此刻完全等价;若哪天源开始缺日,这里要改就得连 RV/VRP 一起改。
 */
export function rollingSharpe(prices: Point[], window: number, periodsPerYear: number): Point[] {
  const rets = logReturns(prices);
  const ann = Math.sqrt(periodsPerYear);

  const out: Point[] = [];
  for (let i = window - 1; i < rets.length; i++) {
    const win = rets.slice(i - window + 1, i + 1).map((p) => p.value);
    const avg = mean(win)!;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - avg) ** 2, 0) / (win.length - 1)); // 样本方差
    // sd=0(全窗零波动,如停牌补值)会出 Infinity,整条线的分位/带就废了 —— 宁可少一根。
    if (sd > 0) out.push({ date: rets[i].date, value: (avg / sd) * ann });
  }
  return out;
}
