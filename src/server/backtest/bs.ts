// Black-Scholes 欧式看跌期权(put)定价。纯函数。回测合成保险腿用。
// σ 用当天 VXN 折算(见 putLeg),r≈0。T≤0 或 σ≤0 退化为内在价值 max(K−S,0)。

// 标准正态 CDF:0.5(1+erf(x/√2));erf 用 Abramowitz-Stegun 7.1.26 近似。
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function bsPut(S: number, K: number, T: number, sigma: number, r = 0): number {
  if (T <= 0 || sigma <= 0) return Math.max(K - S, 0);

  const sqrtT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sqrtT;
  const d2 = d1 - sqrtT;
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
