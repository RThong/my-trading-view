/**
 * BTC 现货日 bar 抓取(Deribit BTC-PERPETUAL 主源,Yahoo BTC-USD 降级)→ price_eod。
 * 原在 vrpInputs 的 priceLeg('BTC') 中;独立出来由 7 天的 cryptoDaily 调用,
 * 让 BTC 现货含周末、与 BTC 期权同节奏。增量:since 从 price_eod 已存最新 BTC 日期续抓。
 * opts 仅供测试注入假 fetcher;默认用真实 Deribit / Yahoo。
 */
import type { Database } from 'bun:sqlite';
import { getLatestPriceDate, insertPriceEod } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';
import { fetchBtcDailyBars } from '../fetchers/deribitBtcPrice';
import { createYahooFetcher } from '../fetchers/yahoo';
import type { Bar } from '../fetchers/moomooHistoryKL';

type BarsFetcher = (since: Date) => Promise<Bar[]>;

export async function updateBtcPrice(
  db: Database,
  opts?: { deribit?: BarsFetcher; yahoo?: BarsFetcher },
): Promise<number> {
  const deribit: BarsFetcher = opts?.deribit ?? ((since) => fetchBtcDailyBars(since.getTime(), Date.now()));
  const yahoo: BarsFetcher = opts?.yahoo ?? (async (since) =>
    (await createYahooFetcher().fetchDailyBars('BTC-USD', since)).map((r) => ({
      date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close,
    })));

  const latest = getLatestPriceDate(db, 'BTC');
  const since = latest ? new Date(latest + 'T00:00:00Z') : new Date(HISTORY_START_DATE);

  let bars: Bar[];
  let source: string;
  try {
    bars = await deribit(since);
    source = 'deribit';
  } catch (e) {
    console.warn(`[btcPrice] Deribit 失败,降级 Yahoo: ${(e as Error).message}`);
    bars = await yahoo(since);
    source = 'yahoo';
  }

  insertPriceEod(db, bars.map((b) => ({
    underlying: 'BTC', obsDate: b.date, open: b.open, high: b.high, low: b.low, close: b.close, source,
  })));
  return bars.length;
}
