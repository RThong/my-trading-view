// 期权反解 IV / delta(给 moomoo 的 TLT 历史重算用,见 jobs/repairMoomooOptions):美式 CRR 二叉树 + 分红率,
// 口径对齐 CBOE(2026-11-13 实测,见 docs/data-sources-candidates.md §1.4)。
// ponytail: 只做了美式二叉树;VIX 期权的正确口径是 Black-76 + 同到期远期,要重算 VIX 时再加。

/** 标准正态 CDF(Abramowitz-Stegun 7.1.26 近似 erf,误差 < 1.5e-7)。 */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return 0.5 * (1 + Math.sign(x) * y);
}

/**
 * Black-76 远期 delta(不贴现):call = N(d1),put = N(d1) − 1。F = 同到期远期价,T 年,vol 小数。
 * Deribit 的 greeks.delta 就是这个口径(2026-11-21 对 31 个合约:与 ticker 给的最大差 0.003,多是两次请求间价格在动)。
 */
export function black76Delta(o: { F: number; K: number; T: number; vol: number; call: boolean }): number {
  const { F, K, T, vol, call } = o;
  const d1 = (Math.log(F / K) + 0.5 * vol * vol * T) / (vol * Math.sqrt(T));
  return call ? normCdf(d1) : normCdf(d1) - 1;
}

/** 二分反解:价格对 σ 单调递增。价格落在模型范围外(低于内在价值等)回 NaN。 */
function solveVol(price: number, priceAt: (v: number) => number, lo = 0.005, hi = 5): number {
  if (!(price > priceAt(lo)) || !(price < priceAt(hi))) return Number.NaN;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (priceAt(mid) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export type AmericanInput = { S: number; K: number; T: number; r: number; q: number; call: boolean };

const STEPS = 150;

/** CRR 美式二叉树价格(连续分红率 q);同时回 delta(第一步两个节点的差商)。 */
export function americanPrice({ S, K, T, r, q, call }: AmericanInput, vol: number): { price: number; delta: number } {
  const dt = T / STEPS;
  const u = Math.exp(vol * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  const disc = Math.exp(-r * dt);
  const payoff = (s: number) => Math.max(call ? s - K : K - s, 0);

  const vals = Array.from({ length: STEPS + 1 }, (_, i) => payoff(S * u ** (STEPS - i) * d ** i));
  let level1: number[] = [];
  for (let j = STEPS - 1; j >= 0; j--) {
    for (let i = 0; i <= j; i++) {
      vals[i] = Math.max(disc * (p * vals[i] + (1 - p) * vals[i + 1]), payoff(S * u ** (j - i) * d ** i));
    }
    if (j === 1) level1 = [vals[0], vals[1]];
  }

  return { price: vals[0], delta: (level1[0] - level1[1]) / (S * u - S * d) };
}

/** 美式期权中间价 → IV(小数)与 delta;反解不出回 null。 */
export function americanIvDelta(price: number, inp: AmericanInput): { iv: number; delta: number } | null {
  const iv = solveVol(price, (v) => americanPrice(inp, v).price);
  return Number.isFinite(iv) ? { iv, delta: americanPrice(inp, iv).delta } : null;
}
