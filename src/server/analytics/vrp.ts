/**
 * RV(已实现波动率)与 VRP(波动率风险溢价)计算。纯函数,输入已按日期升序的序列。
 *
 * 口径(与 VIX/DVOL 对齐):
 * - RV = 对数收益的滚动样本标准差 × √(年化周期数) × 100,单位百分点。
 * - SPX:window=21 交易日 ≈ 30 日历天,年化 √252。
 * - BTC:window=30(crypto 每天都有点 ≈ 30 日历天),年化 √365。
 * - VRP = 隐含波动(VIX/DVOL)− RV,按日期 inner join(只保留两边都有的日)。
 *   这是"同期 VRP"(隐含 vs 过去已实现),状态盘的正确口径,非学术前瞻 VRP。
 */
import { mean } from 'remeda';

export type Point = { date: string; value: number };

/** 滚动已实现波动率(年化、百分点)。 */
export function realizedVol(prices: Point[], window: number, periodsPerYear: number): Point[] {
  const rets: Point[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].value;
    const cur = prices[i].value;
    // 跳过非正价格:log(cur/prev) 会出 NaN/Infinity,污染整段 RV。真实收盘价恒正。
    if (prev > 0 && cur > 0) {
      rets.push({ date: prices[i].date, value: Math.log(cur / prev) });
    }
  }
  const out: Point[] = [];
  const ann = Math.sqrt(periodsPerYear) * 100;
  for (let i = window - 1; i < rets.length; i++) {
    const win = rets.slice(i - window + 1, i + 1).map((p) => p.value);
    const avg = mean(win)!;
    const variance = win.reduce((a, b) => a + (b - avg) ** 2, 0) / (win.length - 1); // 样本方差
    out.push({ date: rets[i].date, value: Math.sqrt(variance) * ann });
  }
  return out;
}

export type VrpPoint = { date: string; iv: number; rv: number; vrp: number };

/** VRP = iv − rv,按日期 inner join。iv 与 rv 均为百分点。 */
export function computeVrp(iv: Point[], rv: Point[]): VrpPoint[] {
  const rvByDate = new Map(rv.map((p) => [p.date, p.value]));
  return iv.flatMap((i) => {
    const r = rvByDate.get(i.date);
    return r === undefined ? [] : [{ date: i.date, iv: i.value, rv: r, vrp: i.value - r }];
  });
}
