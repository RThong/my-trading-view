/**
 * 从 SOFR OIS par 曲线(Eris,见 `analytics/rateCurves` 的 ERIS_OIS_TENORS)反推分段远期,
 * 换算成「市场计入了几次 25bp 加息」。前端快照表与后端历史序列共用这一份。
 *
 * ⚠️ **近似值,精度约几 bp**:节点间隔约 3 个月(1Y 以上更稀),节点之间按分段常数处理,
 * 相邻两次 FOMC 会被抹平 —— 所以只给「N 个月累计计入几次」,**不拆单次会议**
 * (单会议概率看 CME FedWatch 网页)。
 *
 * 口径:
 *  - 基准 = **SOFR 定盘值**(FRED `SOFR`),由调用方传入。不用目标区间中值 —— SOFR 与 EFFR 有几个 bp 的基差;
 *    也**不用 Eris 的 `SOFR1D`**:那是 T+2 起息的 1 天掉期,会提前吃进下次会议(2026-09-08~16 实测比定盘值
 *    高出最多 24bp,约少算 1 次加息)。
 *  - ≤1Y 的 OIS 单次付息:DF = 1/(1 + r·t),ACT/360。
 *  - >1Y 按年付息 par swap bootstrap:1 = r·Σαᵢ·DFᵢ + DFₙ,付息日从到期日每 12 个月倒推(18M = 6M 短首期 + 12M)。
 *  - 分段远期 f = (DF₁/DF₂ − 1)/(t₂ − t₁)。
 */

const HIKE_SIZE = 0.25;

/** 参与计算的节点(Eris 期限 → 月数)。1D / 1W 离 1M 太近,只会放大噪声。 */
const NODES: readonly (readonly [string, number])[] = [
  ['1M', 1],
  ['3M', 3],
  ['6M', 6],
  ['9M', 9],
  ['12M', 12],
  ['18M', 18],
  ['2Y', 24],
  ['3Y', 36],
  ['4Y', 48],
  ['5Y', 60],
];

/** 反推要读的全部 Eris 期限。 */
export const OIS_INPUT_TENORS = NODES.map(([t]) => t);

export type ForwardSegment = {
  fromTenor: string;
  toTenor: string;
  from: string;
  to: string;
  /** 该段远期利率,百分点(与 Eris FairCoupon 同单位)。 */
  rate: number;
};

// ponytail: 起息日直接取估值日、不做 T+2 与节假日调整,误差 < 1bp,远小于分段常数本身的误差。
function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();

  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInMonth));

  return d.toISOString().slice(0, 10);
}

const act360 = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 / 360;

/**
 * par 曲线(期限 → 百分点)→ 分段远期。某档缺失则从那一档起截断(后面的 bootstrap 依赖它)。
 */
export function oisForwards(par: Readonly<Record<string, number>>, asOf: string): ForwardSegment[] {
  const dateOf = new Map<number, string>([[0, asOf]]);
  const df = new Map<number, number>([[0, 1]]);
  const tenorOf = new Map<number, string>([[0, 'O/N']]);

  // 命令式:bootstrap 逐档依赖前一档,且缺档要提前 break。
  for (const [tenor, m] of NODES) {
    const pct = par[tenor];
    if (pct == null || !Number.isFinite(pct)) break;

    const r = pct / 100;
    const end = addMonths(asOf, m);
    dateOf.set(m, end);
    tenorOf.set(m, tenor);

    if (m <= 12) {
      df.set(m, 1 / (1 + r * act360(asOf, end)));
      continue;
    }

    // 付息月:从到期倒推每 12 个月,升序。除最后一期外都必须是已知节点。
    const pays = Array.from({ length: Math.ceil(m / 12) }, (_, k) => m - 12 * k).reverse();
    const earlier = pays.slice(0, -1);
    if (!earlier.every((p) => df.has(p))) break;

    const starts = [0, ...earlier];
    const annuity = earlier.reduce((sum, p, i) => sum + act360(dateOf.get(starts[i])!, dateOf.get(p)!) * df.get(p)!, 0);
    const lastAccrual = act360(dateOf.get(starts.at(-1)!)!, end);
    df.set(m, (1 - r * annuity) / (1 + r * lastAccrual));
  }

  const months = [...df.keys()].sort((a, b) => a - b);

  return months.slice(1).map((m2, i) => {
    const m1 = months[i];
    const from = dateOf.get(m1)!;
    const to = dateOf.get(m2)!;
    return {
      fromTenor: tenorOf.get(m1)!,
      toTenor: tenorOf.get(m2)!,
      from,
      to,
      rate: ((df.get(m1)! / df.get(m2)! - 1) / act360(from, to)) * 100,
    };
  });
}

/** 相对基准累计计入几次 25bp(负 = 降息)。 */
export const hikesPriced = (forward: number, base: number) => (forward - base) / HIKE_SIZE;

/**
 * 某日的远期:在相邻两段的**中点**之间线性插值(首段中点之前 / 末段中点之后取该段值);超出曲线 → null。
 *
 * 不直接取「落在哪一段就用那段」:段值是整段平均,日期靠近段边缘时会被另一头的会议带偏。
 * 2026-12-31 落在 3M–6M(12/24 → 3/24)段首,那段平均里装着 2027 年 1、3 月两次会议,
 * 直接取段值比期货的年底定价(~4.3%)高 13bp;中点插值后对上。
 */
export function forwardAt(segs: readonly ForwardSegment[], date: string): number | null {
  if (!segs.length || date < segs[0].from || date >= segs.at(-1)!.to) return null;

  const t = Date.parse(date);
  const anchors = segs.map((s) => ({ t: (Date.parse(s.from) + Date.parse(s.to)) / 2, rate: s.rate }));
  const i = anchors.findIndex((a) => a.t > t);
  if (i === 0) return anchors[0].rate;
  if (i === -1) return anchors.at(-1)!.rate;

  const a = anchors[i - 1];
  const b = anchors[i];
  return a.rate + ((b.rate - a.rate) * (t - a.t)) / (b.t - a.t);
}

/**
 * 某日的「到 tenor 为止累计计入几次」:以 tenor 结尾那一段的远期 − 当日 SOFR 定盘值。缺档 → null。
 */
export function hikesByTenor(
  par: Readonly<Record<string, number>>,
  asOf: string,
  tenor: string,
  base: number,
): number | null {
  const seg = oisForwards(par, asOf).find((s) => s.toTenor === tenor);
  return seg ? hikesPriced(seg.rate, base) : null;
}

export type DotGap = { date: string; dot: number; market: number; gapBp: number };

/**
 * 点阵图中值 vs 市场远期。点阵图是**政策利率中值**口径,远期是 **SOFR** 口径 ——
 * 把市场那边平移成中值口径(市场隐含中值 = 当前中值 + (远期 − 当前 SOFR))再比,基差就消掉了。
 * gapBp > 0 = 市场比联储更鹰。落在曲线之外的年份(太远 / 已过去)跳过。
 */
export function dotGaps(
  segs: readonly ForwardSegment[],
  dots: readonly { date: string; value: number }[],
  { base, mid }: { base: number; mid: number },
): DotGap[] {
  return dots.flatMap((d) => {
    const f = forwardAt(segs, d.date);
    if (f == null) return [];

    const market = mid + (f - base);
    return [{ date: d.date, dot: d.value, market, gapBp: (market - d.value) * 100 }];
  });
}
