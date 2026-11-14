import { percentile } from '../../shared/calc/stats';
import { cdsPriceToSpreadBp, type CdsMarket } from './rateCurves';

// DTCC 单名 CDS 成交 → 每日「价」(平价 100,与 ICE 结算价同口径;bp 换算在读时做)。
// 三件事都是 2026-11 拿 ICE 结算价逐日对出来的(见 docs/data-sources-candidates.md §1.1):
// ① 成交里的前端费含应计票息:不扣时比 ICE 系统性低约 3bp,且随距上个付息日的天数线性变大;扣掉后差的中位数 0.0bp。
// ② 公开数据不带付款方向:价可能是 100 − u 也可能是 100 + u,按参照价(邻近一天的价)选近的那个。
// ③ 换新合约那周(3/20、9/20 之后几天)同一合约的成交分成相距 ~1.5 点的两团、笔数相当,中位数会偏 30~40bp;
//    按价位断开成团,取离参照价最近的那团。原因没查明。
//    断团门槛随利差水平放大:高利差名(CoreWeave ~1100bp)日内正常波动就有好几个点,固定 0.5 点会把它切碎、
//    取到离参照价近的那块 → 读数被拖向前一天(实测日均偏差从 10bp 变 15bp)。

const DAY_MS = 86_400_000;
// 同一团内相邻两笔的最大价差 = 参照价折成的利差 × 0.5%(折成点),至少 0.5 点。
// 60bp 的投资级名 → 0.5 点、Oracle ~220bp → ~1.1 点(两团相距 ~1.5 点,能分开);CoreWeave ~1100bp → ~5.5 点(不切)
const GAP_PER_BP = 0.005;
const MIN_GAP = 0.5;

/** 断团门槛(点):参照价对应的利差越高,日内正常波动越大,门槛跟着放大。 */
export function clusterGap(anchor: number, couponBp: number, market?: CdsMarket): number {
  const bp = cdsPriceToSpreadBp(anchor, couponBp, market);
  return Number.isFinite(bp) ? Math.max(MIN_GAP, bp * GAP_PER_BP) : MIN_GAP;
}

// 标准 CDS 每季 3/20、6/20、9/20、12/20 付息;付息日当天应计从头算(含当天)
function lastCouponDate(date: string): string {
  const y = Number(date.slice(0, 4));
  return [`${y - 1}-12-20`, `${y}-03-20`, `${y}-06-20`, `${y}-09-20`, `${y}-12-20`].filter((d) => d <= date).at(-1)!;
}

/** 成交日的应计票息(点):票息 × 距上个付息日的天数 / 360(含起息的 T+1)。 */
// ponytail: 付息日按日历 20 号,不顺延到工作日;最多差 2 天 × 票息 / 360(100bp 票息约 0.006 点)。
export function accruedPts(date: string, couponBp: number): number {
  const days = (Date.parse(date) - Date.parse(lastCouponDate(date))) / DAY_MS + 1;

  return ((couponBp / 100) * days) / 360;
}

/** 一天各笔的 u(前端费 %)→ 当天价:扣应计、按参照价选方向、取离参照价最近的那团的中位数。 */
export function dayPrice(us: number[], acc: number, anchor: number, gap = MIN_GAP): number {
  const nearer = (a: number, b: number) => (Math.abs(a - anchor) <= Math.abs(b - anchor) ? a : b);
  const prices = us.map((u) => nearer(100 - u - acc, 100 + u - acc)).sort((a, b) => a - b);

  const clusters = prices.reduce<number[][]>((cs, p) => {
    const last = cs.at(-1);
    if (last && p - last.at(-1)! <= gap) last.push(p);
    else cs.push([p]);
    return cs;
  }, []);

  return clusters.map((c) => percentile(c, 50)).reduce(nearer);
}

/**
 * 按给定顺序逐日定价,每天的参照价 = 上一天算出的价(第一天用 anchor)。
 * 往后补(日常)按日期升序;往前补(接在 ICE 第一天之前)按降序,从 ICE 第一天的结算价起锚。
 */
export function chainDayPrices(
  days: { date: string; us: number[] }[],
  anchor: number,
  couponBp: number,
  market?: CdsMarket,
): { date: string; price: number }[] {
  return days.reduce<{ date: string; price: number }[]>((out, d) => {
    const ref = out.at(-1)?.price ?? anchor;
    const price = dayPrice(d.us, accruedPts(d.date, couponBp), ref, clusterGap(ref, couponBp, market));
    out.push({ date: d.date, price });
    return out;
  }, []);
}

// 稀疏段不可信:2026 年以前不少名字一年只有几天有成交(Microsoft 2025 全年 19 天、Alphabet 7 天),
// 图上是几个月一个点、中间直线连过去,且多是单笔成交(和 ICE 重叠期核对时单笔日偏差最大)。
// 只保留「之后每个整月都至少有这么多天有成交」的那段 —— 和 ICE 核对过的密度相近。
const MIN_DAYS_PER_MONTH = 8;

function monthsBetween(first: string, last: string): string[] {
  const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
  return Array.from({ length: idx(last) - idx(first) + 1 }, (_, i) => {
    const k = idx(first) + i;
    return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
  });
}

/**
 * 成交日 + 回填段的截止日(ICE 第一天,不含)→ 从哪天起保留(只留 ≥ 返回值的日期)。
 * 从第一笔成交的月份数到截止日所在的月,之后每个整月都要 ≥ MIN_DAYS_PER_MONTH 天有成交;
 * 末尾的空月也算稀疏 —— 拿最后一个有成交的月当终点会让它们漏判。
 * 截止日所在的月是残月,不参与判断、总是保留:它紧挨 ICE 起锚点,偏差最小;
 * 所以整月全都稀疏时回截止月 1 号(只留残月那段)。没有成交 → 回截止日。
 */
export function denseFrom(dates: string[], end: string): string {
  const sorted = [...dates].sort();
  if (!sorted.length) return end;

  const perMonth = Map.groupBy(sorted, (d) => d.slice(0, 7));
  const months = monthsBetween(sorted[0].slice(0, 7), end.slice(0, 7));
  const lastSparse = months.slice(0, -1).findLastIndex((m) => (perMonth.get(m)?.length ?? 0) < MIN_DAYS_PER_MONTH);

  return `${months[lastSparse + 1]}-01`;
}
