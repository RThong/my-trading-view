// 各曲线的期限/序列映射 + 值转换(纯函数,便于单测)。
import { subtractAligned, type Point } from './regime';
import { AI_CDS } from '../../shared/rateCurveDefs';
import { percentile } from '../../shared/calc/stats';

// 期限 / 名单搬到 shared(图表编辑器也要),这里转出保持原引用路径不变
export { AI_CDS, CREDIT_RATING, CREDIT_TERM, ERIS_OIS_TENORS } from '../../shared/rateCurveDefs';

// 已抓到的 ticker 集合里,缺哪些 core 标的(→ 显示名)。空 = 默认篮子齐,job success;
// 非空 = ICE 端点可能改了 ticker,让 job failed 告警(非 core 的 Broadcom/Dell/Intel/CoreWeave/SpaceX 缺失容忍)。
export function missingCoreCds(gotTickers: Set<string>): string[] {
  return AI_CDS.filter((c) => c.core && !gotTickers.has(c.ticker)).map((c) => c.name);
}

// ICE 给的是「价」(eodPrice,固定票息合约,平价 100;DTCC 软银成交也折成同口径的价)。换成市场报价口径的约定 spread(bp),
// 按 ISDA 报价惯例的思路:违约强度恒定 λ = s / (1 − R),回收率 R 按市场(美元 40%);
//   价 = 100 − (s − 票息) × RPV01(s),RPV01 = ∫₀ᵀ e^{−(r+λ)t} dt = 风险久期(s 越高越短)。
// 价对 s 单调递减 → 二分反解。不用固定 annuity 的线性近似:那会离校准点越远越偏低,
//   困境区(500bp 档价 70:annuity 4.7 线性 → ~1138bp,本模型 ~1717bp)恰在该报警时失真。
// ponytail: 连续付息 + 平坦利率(美元 4%) + T 固定 5Y(on-the-run 实际 4.75~5.25Y,误差 1~2%),
//   与完整 ISDA 标准模型(季付、贴现曲线、精确到期)约差 ±10bp;要精确再接贴现曲线 + 合约到期。
const CDS_TENOR_Y = 5;

// 换算参数按计价市场分:回收率取各市场报价惯例,利率取该币种 5Y 附近的水平。
// 日本:公司 CDS 报价惯例回收率 35%;日元 5Y OIS 2026-11 约 2.1%(DTCC 成交实测)。
// ponytail: 利率写死常数,日元利率大幅变动后要跟着改(差 1 个点约影响 1~2%)。
export type CdsMarket = { recovery: number; rate: number };
export const USD_CDS: CdsMarket = { recovery: 0.4, rate: 0.04 };
export const JPY_CDS: CdsMarket = { recovery: 0.35, rate: 0.02 };

function cdsPrice(spreadBp: number, coupon: number, m: CdsMarket): number {
  const k = m.rate + spreadBp / 1e4 / (1 - m.recovery);
  const rpv01 = (1 - Math.exp(-k * CDS_TENOR_Y)) / k;

  return 100 - ((spreadBp - coupon) / 100) * rpv01;
}

/** 约定 spread(bp)→ 价:cdsPriceToSpreadBp 的反函数(同一模型,来回无损)。DTCC 里 IG 指数按利差报,换成价与 ICE 同口径存。 */
export function cdsSpreadToPrice(spreadBp: number, coupon = 100, m: CdsMarket = USD_CDS): number {
  return cdsPrice(spreadBp, coupon, m);
}

// s → ∞ 时价趋近回收价 100×R:价 ≤ 回收价 = 模型无解(市场已按即刻违约定价)→ NaN,由调用方丢点。
// 上界按需倍增,深困境区不被截断。
export function cdsPriceToSpreadBp(price: number, coupon = 100, m: CdsMarket = USD_CDS): number {
  // 价 ≥ s=0 的理论价 = 负 spread,同样无解(多半是源数据错位),不静默吐 0bp。
  if (!(price > 100 * m.recovery) || price >= cdsPrice(0, coupon, m)) return Number.NaN;

  let lo = 0;
  let hi = 20000;
  while (cdsPrice(hi, coupon, m) > price) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cdsPrice(mid, coupon, m) > price) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}

// 成交披露的 CDS(软银)偶有前端费明显少报的单:同日同合约两笔,一笔折合 ~360bp、另一笔 ~100bp 出头,
// 除名义本金外字段全同,数据里没有能区分的标记 → 只能按统计剔。实测离群点全在低侧,所以只剔低侧:
// 真信用事件是往上跳,不能被当离群值吃掉。邻居取前后各 k 个点(不含自己)的中位数,低于其 ratio 倍即丢。
// 两侧都有邻居才判:末端(最新)的点只有旧水平当邻居,真实的大幅收窄会被误当离群藏好几天;
// 宁可让最新一笔少报的单多显示一天(下个点来了就剔掉),监控看的就是最新那个点。
export function dropLowPrints(points: Point[], ratio = 0.8, k = 3): Point[] {
  return points.filter((p, i) => {
    const left = points.slice(Math.max(0, i - k), i);
    const right = points.slice(i + 1, i + 1 + k);
    if (!left.length || !right.length) return true;

    const med = percentile(
      [...left, ...right].map((q) => q.value),
      50,
    );

    return p.value >= ratio * med;
  });
}

// 通胀预期曲线:BEI 盈亏平衡通胀 = 名义国债 − 同期限 TIPS 实际收益 = 市场为通胀定的价
// (前瞻,领先 CPI)。FRED 只现成发布 5Y/10Y breakeven,故各档两腿自减现算,拼出完整 5–30Y 曲线。
// 值为百分点,可转负(通缩预期),0 轴为通胀/通缩分界。短端止于 5Y(TIPS 无流动短端)。
// 各档 BEI = 名义 − TIPS 实际(subtractAligned 按日前向填充对齐)。
// 某腿缺(null/空)或相减后无重叠日 → 该档进 unavailable,不入 series。I/O(拉财政部两张曲线)在调用方。
export function computeBeiCurve(legs: { tenor: string; nominal: Point[] | null; real: Point[] | null }[]): {
  tenors: string[];
  series: Record<string, Point[]>;
  unavailable: string[];
} {
  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];

  for (const { tenor, nominal, real } of legs) {
    // 两腿末日不同(如某天一张表先发)时,多出的末端会被前向填充成「新名义 − 旧实际」的错点 → 截到两腿共同末日
    const end = [nominal?.at(-1)?.date ?? '', real?.at(-1)?.date ?? ''].sort()[0];
    const bei = nominal?.length && real?.length ? subtractAligned([nominal, real]).filter((p) => p.date <= end) : [];
    if (bei.length) series[tenor] = bei;
    else unavailable.push(tenor);
  }

  return { tenors: legs.map((l) => l.tenor), series, unavailable };
}
