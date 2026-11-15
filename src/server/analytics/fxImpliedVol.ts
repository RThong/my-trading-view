import type { FxOptionTrade } from '../fetchers/dtccFxOptions';

// 美元/日元 1 个月平值隐含波动率:从 DTCC 场外期权成交的期权费反推(Garman-Kohlhagen),每天取一个数。
//
// 难点是文件**没有成交时刻的即期汇率**,只能用当天日线收盘。估的汇率偏高 → 看涨显得便宜、看跌显得贵,
// 单笔误差能到几个波动率点(2024-11-15 看涨中位 6.6、看跌 13.5)。所以看涨、看跌**各取中位数再平均**:
// 汇率误差在两边一正一反,平均后相消。按成交时刻在开收盘之间插值实测没帮助(|看涨−看跌| 中位 1.83 → 1.76)。
// 原型对照(35 个样本日):隐含 − 1 个月已实现 中位 +1.2 点、71% 的日子为正,符合期权卖方收溢价的常态。

const DAY_MS = 86_400_000;
// 「1 个月」:20~40 个日历天到期
const MIN_DAYS = 20;
const MAX_DAYS = 40;
// 平值附近:行权价离远期 ±2% 以内(深度虚值的成交带着偏度,不是平值波动率)
const MAX_LOG_MONEYNESS = 0.02;
// 看涨、看跌各至少这么多笔才出点:单边只有一两笔时汇率误差没法对消(美国假日常这样)
export const MIN_TRADES_EACH = 3;
// 日元短端利率:ponytail —— 写死常数。取 0.25%~1.25% 结果只差约 0.03 点(1 个月期限里远期点很小);日银大幅加息后再改
const JPY_RATE = 0.0075;

function ncdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 近似 erf,误差 < 1.5e-7,对反推波动率足够
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return 0.5 * (1 + Math.sign(x) * y);
}

/** Garman-Kohlhagen 价格,单位 = 日元 / 每 1 美元名义本金。rd = 日元利率(本币),rf = 美元利率(外币),都是连续复利小数。 */
export function gkPrice(o: {
  spot: number;
  strike: number;
  years: number;
  vol: number;
  rd: number;
  rf: number;
  call: boolean;
}) {
  const { spot, strike, years, vol, rd, rf, call } = o;
  const fwd = spot * Math.exp((rd - rf) * years);
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(fwd / strike) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  const df = Math.exp(-rd * years);

  return call ? df * (fwd * ncdf(d1) - strike * ncdf(d2)) : df * (strike * ncdf(-d2) - fwd * ncdf(-d1));
}

/** 按价格二分反推波动率(小数);价格落在 [0.01%, 200%] 波动率对应的区间外(低于内在价值等)回 null。 */
export function impliedVol(price: number, o: Omit<Parameters<typeof gkPrice>[0], 'vol'>): number | null {
  const at = (vol: number) => gkPrice({ ...o, vol });
  if (!(at(1e-4) < price && price < at(2))) return null;
  let lo = 1e-4;
  let hi = 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < price) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 一组成交(已剔撤销)→ 每天的 1 个月平值隐含波动率(%)。spot = 当天 USD/JPY 收盘(日元 / 美元);
 * usdRate = 当天美元 1 个月利率(小数,undefined = 没有)。没有收盘价 / 利率的那天、看涨或看跌不够 MIN_TRADES_EACH 笔的那天不出点。
 */
export function dailyAtmVol(
  trades: FxOptionTrade[],
  spot: Map<string, number>,
  usdRate: (date: string) => number | undefined,
): { date: string; value: number }[] {
  const byDay = Map.groupBy(trades, (t) => t.date);

  return [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, ts]) => {
      const s = spot.get(date);
      if (!s) return [];
      const rf = usdRate(date);
      if (rf === undefined) return [];
      const ivs = ts.flatMap((t) => {
        const days = (Date.parse(t.expiry) - Date.parse(t.date)) / DAY_MS;
        if (days < MIN_DAYS || days > MAX_DAYS) return [];
        const years = days / 365;
        const fwd = s * Math.exp((JPY_RATE - rf) * years);
        if (Math.abs(Math.log(t.strike / fwd)) > MAX_LOG_MONEYNESS) return [];
        // 期权费换成「日元 / 每 1 美元名义」:美元计的乘汇率,日元计的直接除
        const price = t.premiumCcy === 'USD' ? (t.premium / t.usdNotional) * s : t.premium / t.usdNotional;
        const iv = impliedVol(price, { spot: s, strike: t.strike, years, rd: JPY_RATE, rf, call: t.call });
        return iv === null ? [] : [{ call: t.call, iv }];
      });
      const calls = ivs.filter((x) => x.call).map((x) => x.iv);
      const puts = ivs.filter((x) => !x.call).map((x) => x.iv);
      if (calls.length < MIN_TRADES_EACH || puts.length < MIN_TRADES_EACH) return [];

      return [{ date, value: ((median(calls) + median(puts)) / 2) * 100 }];
    });
}
