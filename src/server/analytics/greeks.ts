// Standard normal CDF — Abramowitz-Stegun approximation, error < 7.5e-8.
export function normCdf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

export type BsInputs = {
  spot: number;          // S, underlying price
  strike: number;        // K
  yearsToExpiry: number; // T in years (e.g. 30/365)
  iv: number;            // σ as decimal (0.20 = 20%)
  rate: number;          // r as decimal (0.045 = 4.5%)
};

export function callDelta({ spot, strike, yearsToExpiry, iv, rate }: BsInputs): number {
  if (iv <= 0 || yearsToExpiry <= 0) return spot > strike ? 1 : 0;
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * yearsToExpiry)
           / (iv * Math.sqrt(yearsToExpiry));
  return normCdf(d1);
}

export function putDelta(inp: BsInputs): number {
  return callDelta(inp) - 1;
}
