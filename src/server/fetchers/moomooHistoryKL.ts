/**
 * moomoo 行情侧的小工具:US 交易日历(fetchUsTradingDates)+ 日线 OHLC 类型 Bar(全站单一真源)。
 * ⚠️ ETF 现货日线**不走 moomoo**(主源且唯一源 Yahoo close,见 jobs/vrpInputs),试过的坑:
 *   - 前复权(rehab=1)每次除息整段改写历史,增量入库拼出两套基准(2026-09 实测 SPY 06-22 前后差 0.25%,09-16 单日毛刺);
 *   - 不复权(rehab=0)连拆股都不调(USO 2020-04-29 合股:2.13 → 18.00),不能回填;
 *   - 高 / 低价偶含场外离谱成交(QQQ 2019-12-03 低 193.78,实际 ~199.2)。
 */
export type Bar = { date: string; open: number | null; high: number | null; low: number | null; close: number };

const TRADE_DATE_MARKET_US = 2; // 注意:TradeDateMarket 枚举(US=2),不是 QotMarket(US=11)

/** 取 US 市场最近 sinceDays 天的交易日列表(moomoo 权威日历,已扣假期),升序 'YYYY-MM-DD'。 */
export async function fetchUsTradingDates(ws: any, sinceDays = 12): Promise<string[]> {
  const now = new Date();
  const begin = new Date(now.getTime() - sinceDays * 86400_000).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  const res = await ws.RequestTradeDate({
    c2s: { market: TRADE_DATE_MARKET_US, beginTime: begin, endTime: end },
  });
  if (res?.retType !== 0) {
    throw new Error(`RequestTradeDate retType=${res?.retType} ${res?.retMsg ?? ''}`);
  }
  return (res?.s2c?.tradeDateList ?? [])
    .map((d: any) => String(d.time ?? '').slice(0, 10))
    .filter((s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s))
    .sort();
}
