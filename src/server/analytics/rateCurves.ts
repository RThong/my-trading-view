// 各曲线的期限/序列映射 + 值转换(纯函数,便于单测)。
import { subtractAligned, type Point } from './regime';

// Eris ParCouponCurve 的 24 档期限(顺序即曲线 x 轴)。存库 series_id = ERIS_OIS_{tenor}。
export const ERIS_OIS_TENORS: string[] = [
  '1D',
  '1W',
  '1M',
  '3M',
  '6M',
  '9M',
  '12M',
  '18M',
  '2Y',
  '3Y',
  '4Y',
  '5Y',
  '6Y',
  '7Y',
  '8Y',
  '9Y',
  '10Y',
  '12Y',
  '15Y',
  '20Y',
  '25Y',
  '30Y',
  '40Y',
  '50Y',
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

// AI 资本开支巨头 + 甲骨文 + 新云 CoreWeave 的单名 CDS(ICE Clear Credit 免费 EOD 结算价)。
// ticker = ICE instrumentName 首段;name = 显示名(不依赖 ICE 里的 "Oracle Cop" 等错拼)。
// 存库 series_id = ICE_CDS_{ticker}。顺序:焦点 Oracle 打头,其余按篮子排。
// core = 前端默认展示的 7 家;缺任一即视为数据源异常(见 missingCoreCds)。
// 注:前端默认勾选(tenorHistory.hooks 的 DEFAULT_TENORS.ai_cds)须与 core 名单一致。
// coupon 缺省 = 100bp(投资级惯例);高收益名只挂 500bp 合约,需单独给。
export const AI_CDS: { ticker: string; name: string; core?: boolean; coupon?: number }[] = [
  { ticker: 'ORCLE', name: 'Oracle', core: true },
  { ticker: 'MSFT', name: 'Microsoft', core: true },
  { ticker: 'ALPHINC', name: 'Alphabet', core: true },
  { ticker: 'AMZN', name: 'Amazon', core: true },
  { ticker: 'APLINC', name: 'Apple', core: true },
  { ticker: 'NVIDIA', name: 'Nvidia', core: true },
  { ticker: 'BROINC', name: 'Broadcom' },
  { ticker: 'DELLN', name: 'Dell' },
  { ticker: 'INTC', name: 'Intel' },
  { ticker: 'METAPL', name: 'Meta', core: true },
  // 新云(租算力给巨头、自己举债买卡)= 信贷型脆弱的前线;2026-10-15 起才攒数。
  // 非 core:利差 ~1000bp 量级,默认勾选会把其余几家压成一条线。
  { ticker: 'COREWEI', name: 'CoreWeave', coupon: 500 },
];

// 已抓到的 ticker 集合里,缺哪些 core 标的(→ 显示名)。空 = 默认篮子齐,job success;
// 非空 = ICE 端点可能改了 ticker,让 job failed 告警(非 core 的 Broadcom/Dell/Intel/CoreWeave 缺失容忍)。
export const missingCoreCds = (gotTickers: Set<string>): string[] =>
  AI_CDS.filter((c) => c.core && !gotTickers.has(c.ticker)).map((c) => c.name);

// ICE 给的是「价」(eodPrice,固定票息合约,平价 100)。换成市场报价口径的约定 spread(bp),
// 按 ISDA 报价惯例的思路:违约强度恒定 λ = s / (1 − R),回收率 R = 40%;
//   价 = 100 − (s − 票息) × RPV01(s),RPV01 = ∫₀ᵀ e^{−(r+λ)t} dt = 风险久期(s 越高越短)。
// 价对 s 单调递减 → 二分反解。不用固定 annuity 的线性近似:那会离校准点越远越偏低,
//   困境区(500bp 档价 70:annuity 4.7 线性 → ~1138bp,本模型 ~1717bp)恰在该报警时失真。
// ponytail: 连续付息 + 平坦利率 4% + T 固定 5Y(on-the-run 实际 4.75~5.25Y,误差 1~2%),
//   与完整 ISDA 标准模型(季付、贴现曲线、精确到期)约差 ±10bp;要精确再接贴现曲线 + 合约到期。
const CDS_RECOVERY = 0.4;
const CDS_RATE = 0.04;
const CDS_TENOR_Y = 5;

const cdsPrice = (spreadBp: number, coupon: number): number => {
  const k = CDS_RATE + spreadBp / 1e4 / (1 - CDS_RECOVERY);
  const rpv01 = (1 - Math.exp(-k * CDS_TENOR_Y)) / k;

  return 100 - ((spreadBp - coupon) / 100) * rpv01;
};

// s → ∞ 时价趋近回收价 100×R:价 ≤ 回收价 = 模型无解(市场已按即刻违约定价)→ NaN,由调用方丢点。
// 上界按需倍增,深困境区不被截断。
export const cdsPriceToSpreadBp = (price: number, coupon = 100): number => {
  // 价 ≥ s=0 的理论价 = 负 spread,同样无解(多半是源数据错位),不静默吐 0bp。
  if (!(price > 100 * CDS_RECOVERY) || price >= cdsPrice(0, coupon)) return Number.NaN;

  let lo = 0;
  let hi = 20000;
  while (cdsPrice(hi, coupon) > price) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cdsPrice(mid, coupon) > price) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
};

// 通胀预期曲线:BEI 盈亏平衡通胀 = 名义国债(DGS) − 同期限 TIPS 实际收益(DFII)= 市场为通胀定的价
// (前瞻,领先 CPI)。FRED 只现成发布 5Y/10Y breakeven,故各档两腿自减现算,拼出完整 5–30Y 曲线。
// 值为百分点,可转负(通缩预期),0 轴为通胀/通缩分界。短端止于 5Y(TIPS 无流动短端)。
export const BEI_TENORS: { tenor: string; nominal: string; real: string }[] = [
  { tenor: '5Y', nominal: 'DGS5', real: 'DFII5' },
  { tenor: '7Y', nominal: 'DGS7', real: 'DFII7' },
  { tenor: '10Y', nominal: 'DGS10', real: 'DFII10' },
  { tenor: '20Y', nominal: 'DGS20', real: 'DFII20' },
  { tenor: '30Y', nominal: 'DGS30', real: 'DFII30' },
];

// 各档 BEI = 名义 − TIPS 实际(subtractAligned 按日前向填充对齐)。
// 某腿缺(null/空)或相减后无重叠日 → 该档进 unavailable,不入 series。I/O(拉 FRED)在调用方。
export function computeBeiCurve(legs: { tenor: string; nominal: Point[] | null; real: Point[] | null }[]): {
  tenors: string[];
  series: Record<string, Point[]>;
  unavailable: string[];
} {
  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];

  for (const { tenor, nominal, real } of legs) {
    const bei = nominal?.length && real?.length ? subtractAligned([nominal, real]) : [];
    if (bei.length) series[tenor] = bei;
    else unavailable.push(tenor);
  }

  return { tenors: legs.map((l) => l.tenor), series, unavailable };
}
