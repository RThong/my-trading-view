// 各曲线的期限/序列映射 + 值转换(纯函数,便于单测)。
// Eris ParCouponCurve 的 24 档期限(顺序即曲线 x 轴)。存库 series_id = ERIS_OIS_{tenor}。
export const ERIS_OIS_TENORS: string[] = [
  '1D', '1W', '1M', '3M', '6M', '9M', '12M', '18M', '2Y', '3Y', '4Y', '5Y',
  '6Y', '7Y', '8Y', '9Y', '10Y', '12Y', '15Y', '20Y', '25Y', '30Y', '40Y', '50Y',
];

// 信用利差曲线(FRED ICE BofA OAS,读时现拉,值已是百分点)。
export const CREDIT_RATING: { tenor: string; series: string }[] = [
  { tenor: 'AAA', series: 'BAMLC0A1CAAA' },
  { tenor: 'AA', series: 'BAMLC0A2CAA' },
  { tenor: 'A', series: 'BAMLC0A3CA' },
  { tenor: 'BBB', series: 'BAMLC0A4CBBB' },
  { tenor: 'BB', series: 'BAMLH0A1HYBB' },
  { tenor: 'B', series: 'BAMLH0A2HYB' },
  { tenor: 'CCC', series: 'BAMLH0A3HYC' },
];

export const CREDIT_TERM: { tenor: string; series: string }[] = [
  { tenor: '1-3Y', series: 'BAMLC1A0C13Y' },
  { tenor: '3-5Y', series: 'BAMLC2A0C35Y' },
  { tenor: '5-7Y', series: 'BAMLC3A0C57Y' },
  { tenor: '7-10Y', series: 'BAMLC4A0C710Y' },
  { tenor: '10-15Y', series: 'BAMLC7A0C1015Y' },
  { tenor: '15Y+', series: 'BAMLC8A0C15PY' },
];
