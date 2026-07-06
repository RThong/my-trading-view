// SOFR OIS / Fed 路径两条曲线的期限映射 + 值转换(纯函数,便于单测)。
// 存进 market_series 的是 Pensford 原始值(OIS 小数、FF 价格),这里定义怎么读成百分点。

// OIS:Pensford 只给这几个期限(SOFRSWAP Y{n}),没有 sub-1Y。
export const OIS_TENORS: { tenor: string; symbol: string }[] = [1, 2, 3, 5, 7, 10, 15, 30].map((y) => ({
  tenor: `${y}Y`,
  symbol: `SOFRSWAP Y${y}`,
}));

// Fed Funds 期货:FF1(当月,部分已过)不给,从 FF2 起;FF{n} = 当月+(n-1) 交割 → 标 "+{n-1}m"。
export const FF_CONTRACTS: number[] = Array.from({ length: 24 }, (_, i) => i + 2); // FF2..FF25
export const ffLabel = (n: number): string => `+${n - 1}m`;

export const toPercent = (v: number): number => v * 100;          // OIS 小数 → 百分点
export const impliedFedRate = (price: number): number => 100 - price; // FF 价格 → 隐含利率(已是百分点)
