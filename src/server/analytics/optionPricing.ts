// 期权反解 IV / delta(给 moomoo 的 TLT 历史重算用,见 jobs/repairMoomooOptions):美式 CRR 二叉树 + 分红率,
// 口径对齐 CBOE(2026-11-13 实测,见 docs/data-sources-candidates.md §1.4)。
// ponytail: 只做了美式二叉树;VIX 期权的正确口径是 Black-76 + 同到期远期,要重算 VIX 时再加。

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
