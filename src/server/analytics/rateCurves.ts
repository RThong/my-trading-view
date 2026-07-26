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

// AI 资本开支巨头 + 甲骨文的单名 CDS(ICE Clear Credit 免费 EOD 结算价)。
// ticker = ICE instrumentName 首段;name = 显示名(不依赖 ICE 里的 "Oracle Cop" 等错拼)。
// 存库 series_id = ICE_CDS_{ticker}。顺序:焦点 Oracle 打头,其余按篮子排。
// core = 前端默认展示的 7 家;缺任一即视为数据源异常(见 missingCoreCds)。
// 注:前端默认勾选(tenorHistory.hooks 的 DEFAULT_TENORS.ai_cds)须与 core 名单一致。
export const AI_CDS: { ticker: string; name: string; core?: boolean }[] = [
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
];

// 已抓到的 ticker 集合里,缺哪些 core 标的(→ 显示名)。空 = 默认篮子齐,job success;
// 非空 = ICE 端点可能改了 ticker,让 job failed 告警(非 core 的 Broadcom/Dell/Intel 缺失容忍)。
export const missingCoreCds = (gotTickers: Set<string>): string[] =>
  AI_CDS.filter((c) => c.core && !gotTickers.has(c.ticker)).map((c) => c.name);

// ICE 给的是「价」(eodPrice,固定票息合约,平价 100)。换成直观的约定 spread(bp):
// 价 = 100 ⟺ spread = 票息;价低于平价 ⟺ spread 高于票息。线性近似(无需回收率):
//   spread ≈ 票息 − (价 − 100) × (100 / annuity),annuity = 5Y 风险久期。
// ponytail: annuity 固定 4.7,拿 Oracle(95.26→~201bp)/Apple(102.89→~38bp)校准到
//   市场公开 CDS 值(Oracle~200bp / Apple~39bp,±几 bp)。要精确再上 ISDA bootstrap(回收率 + hazard)。
// 全篮子皆 XR14.100(100bp 票息)合约;若某名换票息档,此常数需随之改。
const CDS_COUPON_BP = 100;
const CDS_ANNUITY = 4.7;
export const cdsPriceToSpreadBp = (price: number): number => CDS_COUPON_BP - (price - 100) * (100 / CDS_ANNUITY);

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
