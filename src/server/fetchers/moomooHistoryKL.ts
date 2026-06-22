/**
 * moomoo 历史日线收盘(Qot_RequestHistoryKL)。用作 VRP 的 RV 腿主源,
 * 比 Yahoo 准(交易所级、正确处理公司行动)。前复权(rehab=1)保证拆股后序列连续。
 * 仅 ETF/个股可取——美股指数(.SPX/.NDX)这账号无历史权限,故 RV 腿统一用 ETF。
 * ⚠️ 历史 K 线有配额(Qot_RequestHistoryKLQuota);首次多标的全量回填会占额度。
 */
import { QOT_MARKET_US } from './moomooClient';

const KLTYPE_DAY = 2;
const REHAB_FORWARD = 1;
const MAX_KL_PER_REQ = 1000;
const MAX_PAGES = 40; // 40×1000 远超 ~2200 根/标的的需要;纯属死循环兜底

export type Bar = { date: string; open: number | null; high: number | null; low: number | null; close: number };

/** 取某 ETF 自 `since` 起的日线 OHLC(前复权),按 nextReqKey 翻页,升序返回。 */
export async function fetchDailyBars(
  ws: any,
  code: string,
  since: Date,
): Promise<Bar[]> {
  const begin = since.toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const byDate = new Map<string, Bar>();
  let nextReqKey: unknown;

  // 终止靠「这一页不满 MAX_KL_PER_REQ = 最后一页」,而不是判 nextReqKey:
  // moomoo 末页返回的是空 bytes(JS 里 truthy),判 != null 会死循环。MAX_PAGES 再兜一层底。
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ws.RequestHistoryKL({
      c2s: {
        rehabType: REHAB_FORWARD,
        klType: KLTYPE_DAY,
        security: { market: QOT_MARKET_US, code },
        beginTime: begin,
        endTime: end,
        maxAckKLNum: MAX_KL_PER_REQ,
        ...(nextReqKey ? { nextReqKey } : {}),
      },
    });
    if (res?.retType !== 0) {
      throw new Error(`RequestHistoryKL ${code} retType=${res?.retType} ${res?.retMsg ?? ''}`);
    }
    const kl = res?.s2c?.klList ?? [];
    for (const k of kl) {
      const date = String(k.time ?? '').slice(0, 10); // "YYYY-MM-DD 00:00:00" → 日期
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof k.closePrice === 'number') {
        const num = (v: unknown) => (typeof v === 'number' ? v : null);
        byDate.set(date, { date, open: num(k.openPrice), high: num(k.highPrice), low: num(k.lowPrice), close: k.closePrice });
      }
    }
    nextReqKey = res?.s2c?.nextReqKey;
    if (kl.length < MAX_KL_PER_REQ) break; // 不满一页(含空页)即最后一页
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

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
