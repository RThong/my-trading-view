/**
 * 标准月度期权到期日推算(第二档到期日用)。按「最接近 N 天」挑常会挑中周度合约,流动性差
 * (实测 GLD 11/13 周度近 25Δ call:bid/ask 3.15/3.45、OI 13),所以直接算月度那一天再去查。
 *   - ETF / 个股:每月第三个周五。
 *   - VIX:次月第三个周五往前 30 天的那个周三(= 当月 VX 期货结算日,同一个 SOQ)。
 * 遇假日交易所把到期提前一个交易日,这里不认假日历 → 调用方查链时把前一天也带上。
 */
const DAY_MS = 86_400_000;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** 某月(m 为 0 起)第三个周五。 */
export function thirdFriday(y: number, m: number): Date {
  const firstDow = utc(y, m, 1).getUTCDay();
  return utc(y, m, 1 + ((5 - firstDow + 7) % 7) + 14);
}

/** 某月的标准月度到期日。 */
export function monthlyExpiry(kind: 'equity' | 'vix', y: number, m: number): Date {
  if (kind === 'equity') return thirdFriday(y, m);
  return new Date(thirdFriday(y, m + 1).getTime() - 30 * DAY_MS);
}

/** 从 today 起第一个 DTE ≥ minDte 的标准月度到期日('YYYY-MM-DD')。DTE 落在 [minDte, minDte+35]。 */
export function nextMonthlyExpiry(kind: 'equity' | 'vix', today: Date, minDte: number): string {
  // 按日历日算 DTE:先归到当天 UTC 0 点,否则正好 minDte 天的那个月度会因钟点被挤到下一个月。
  const earliest = utc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()).getTime() + minDte * DAY_MS;
  // 往后最多看 6 个月就一定有;Date.UTC 会把溢出的月份自动进位到下一年。
  const hit = Array.from({ length: 6 }, (_, i) =>
    monthlyExpiry(kind, today.getUTCFullYear(), today.getUTCMonth() + i),
  ).find((d) => d.getTime() >= earliest);

  return iso(hit!);
}
