// 物価連動国債(JGBi)的实际复利收益率:由「实际价格」(JSDA 売買参考統計値的平均値単価,每 100 想定元金額的净价)
// 倒推半年复利收益率,与日本相互证券 BB / 财务省公布的口径逐位一致(2026-08-06 0.806、11-19 0.954)。
//
// 不需要连动系数 / 想定元金額:报价本身就是按想定元金額 100 给的实际价格,现金流按实际口径(票息 + 100)折现即可。
// 本金保底(フロア)的期权价值不单独剥离 —— BB / 财务省也没剥,口径对齐。
const DAY_MS = 86_400_000;

function days(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** 到期日往前每 6 个月一个付息日(同一天号),返回 ≤ settle 的最后一个和 > settle 的全部(升序) */
function couponSchedule(settle: string, maturity: string): { last: string; future: string[] } {
  const [y, m, d] = maturity.split('-').map(Number) as [number, number, number];
  const at = (k: number) => new Date(Date.UTC(y, m - 1 - 6 * k, d)).toISOString().slice(0, 10);
  const n = Math.ceil(days(settle, maturity) / 182) + 2;
  const all = Array.from({ length: n }, (_, k) => at(k)).reverse();

  return { last: all.findLast((c) => c <= settle)!, future: all.filter((c) => c > settle) };
}

/**
 * 净价 → 半年复利收益率(%)。price = 每 100 的净价(不含经过利息),coupon = 年票息 %,
 * settle = 受渡日(报价日的下一营业日),t 按实际天数 / 365。二分求解,精度远小于 0.001%。
 */
export function jgbiCompoundYield(price: number, coupon: number, settle: string, maturity: string): number {
  const { last, future } = couponSchedule(settle, maturity);
  const accrued = (coupon * days(last, settle)) / 365;
  const pv = (r: number) =>
    future.reduce((s, c) => s + coupon / 2 / (1 + r / 2) ** ((2 * days(settle, c)) / 365), 0) +
    100 / (1 + r / 2) ** ((2 * days(settle, maturity)) / 365) -
    accrued;

  // pv 随 r 单调递减
  let lo = -0.05;
  let hi = 0.1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > price) lo = mid;
    else hi = mid;
  }

  return ((lo + hi) / 2) * 100;
}
