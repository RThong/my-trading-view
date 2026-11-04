// 油品连续合约的「错月」判定(纯函数)。
//
// Yahoo 的 CL=F / HO=F / RB=F / BZ=F 都是「到期次日换下一个合约」的连续近月(2018-01~2024-04 与 EIA
// Contract 1 逐日 1572 天全等;EIA 那批序列 2024-04 起停更)。但各品种到期日不同:
//  · WTI(CL):交割月前一个月 25 号往前第 3 个营业日(25 号非营业日则从它之前最后一个营业日起算)
//  · 柴油 HO / 汽油 RB / Brent BZ:都在月末最后一个营业日到期 → 下月第一个交易日换月
// 所以每个月被 WTI 到期日切成两段:
//  · 到期日(含)之前:WTI 还是近月 M,产品腿也是 M → 裂解同月;Brent 已是 M+1 → Brent−WTI 错月
//  · 到期日之后到月底:WTI 换成 M+1,产品腿仍是 M → 裂解错月;Brent 也是 M+1 → Brent−WTI 同月
// 错月时差出来的那部分 = 该品种近两月价差(平时 $0.2~1/桶,市场紧时可到 $8+)。

export type RollMismatchKind = 'crack' | 'brentWti';

// 本月数据还没走到 25 号时,用工作日补齐到 25 号再按规则推(不认节假日,最多差一天;数据到了就以真实交易日为准)
function padWeekdaysTo25(month: string, last: string): string[] {
  const end = new Date(`${month}-25T00:00:00Z`);
  const d = new Date(`${last}T00:00:00Z`);
  const out: string[] = [];
  for (d.setUTCDate(d.getUTCDate() + 1); d <= end; d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10));
  return out;
}

/**
 * 每月 WTI 近月合约到期日(YYYY-MM → YYYY-MM-DD)。`dates` = 该序列自己的交易日(升序),
 * 当营业日历用 —— 节假日因此自然扣掉,不用另维护假日表。
 * 规则:锚 = 当月 ≤25 号的最后一个交易日;到期 = 锚往前数 3 个交易日。
 */
export function wtiExpiryByMonth(dates: string[]): Map<string, string> {
  const lastDate = dates.at(-1) ?? '';
  // 先按月分组一次(图表每次重渲染都会调,别每个月都重扫全部日期)
  const byMonth = Map.groupBy(dates, (d) => d.slice(0, 7));

  return new Map(
    [...byMonth].flatMap(([m, days]) => {
      const known = days.filter((d) => d <= `${m}-25`);
      // 只在整份数据还没走到本月 25 号时补:已走过的月份若也补,会把圣诞这类休市日当工作日塞进去
      const pad = lastDate < `${m}-25` && known.length ? padWeekdaysTo25(m, lastDate) : [];
      const expiry = [...known, ...pad].at(-4);
      return expiry ? [[m, expiry] as const] : [];
    }),
  );
}

/** 判定 `dates` 中哪些日子两条腿的合约月份对不上(按 kind 取到期日前 / 后那一段)。 */
export function rollMismatchDates(dates: string[], kind: RollMismatchKind): Set<string> {
  const expiry = wtiExpiryByMonth(dates);
  const afterExpiry = (d: string) => {
    const e = expiry.get(d.slice(0, 7));
    return e !== undefined && d > e;
  };

  return new Set(dates.filter((d) => (kind === 'crack' ? afterExpiry(d) : !afterExpiry(d))));
}
