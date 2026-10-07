/**
 * BTC 现货日 bar 抓取(Bitstamp 主源,Yahoo BTC-USD 降级)→ price_eod。
 * 由 7 天的 cryptoDaily 调用,BTC 现货含周末、与 BTC 期权同节奏。
 * 增量:从 price_eod 已存最新 BTC 日期续抓(空库则从 BTC_HISTORY_START 全量,Bitstamp 分页 ~6 次)。
 * opts 仅供测试注入假 fetcher;默认用真实 Bitstamp / Yahoo。
 *
 * 为什么全段用 Bitstamp(2026-10 从「Bitstamp 补 2018 前 + Deribit 永续」换过来):
 *  - 现货、原生 UTC 0 点切日。Deribit 的日线按 **08:00 UTC** 切(交割时刻),「D 日收盘」实为 D+1 08:00 的价,
 *    与 Yahoo / Glassnode / BRK 最多差 6%;要用它得拉小时线自己聚合。
 *  - 一个源贯通 2012 至今,没有换源接缝。与 Yahoo 对账:2024 起收盘中位差 0.02%,略好于 Deribit 小时聚合(0.03%)。
 *  - DVOL 基于 Deribit 的现货指数(Bitstamp 是成分所),RV 腿用现货比用永续更对口径。
 *  - 代价:单一交易所盘口偶有更深的针(2022 起最低价最大差 4.9%),只影响影线,不进任何指标。
 */
import type { Database } from 'bun:sqlite';
import { getLatestPriceDate, insertPriceEod } from '../storage/repository';
import { fetchBitstampBtcDaily } from '../fetchers/bitstampBtcHistory';
import { createYahooFetcher } from '../fetchers/yahoo';
import type { Bar } from '../fetchers/moomooHistoryKL';

/**
 * BTC 历史起点。比全站 HISTORY_START_DATE(2018-01-01)早得多是刻意的:
 * 1Y 滚动夏普那格要看「每轮周期顶部是否递减」,只有两轮拟合不出来,得把 2013/2017 两轮也纳进来。
 */
const BTC_HISTORY_START = '2012-01-01';

export async function updateBtcPrice(
  db: Database,
  opts?: { bitstamp?: typeof fetchBitstampBtcDaily; yahoo?: (since: string) => Promise<Bar[]> },
): Promise<number> {
  const bitstamp = opts?.bitstamp ?? fetchBitstampBtcDaily;
  const yahoo =
    opts?.yahoo ??
    (async (since: string) =>
      (await createYahooFetcher().fetchDailyBars('BTC-USD', new Date(`${since}T00:00:00Z`))).map((r) => ({
        date: r.tradeDate,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      })));

  // 从库里**最新的 Bitstamp 行**(含)续抓:当天那根是盘中值,下次运行覆盖成收盘值。
  // 只认 bitstamp 来源:Yahoo 降级写进来的行(空库时只到 2014-09)、旧版遗留的 Deribit 行,
  // 都会在 Bitstamp 恢复后的第一次运行里被整段覆盖,不会因为「最新日期已经很新」永久留下。
  const since = getLatestPriceDate(db, 'BTC', 'bitstamp') ?? BTC_HISTORY_START;
  const today = new Date().toISOString().slice(0, 10);

  let bars: Bar[];
  let source: string;
  try {
    bars = await bitstamp(since, today);
    source = 'bitstamp';
  } catch (e) {
    console.warn(`[btcPrice] Bitstamp 失败,降级 Yahoo: ${(e as Error).message}`);
    bars = await yahoo(since);
    source = 'yahoo';
  }

  insertPriceEod(
    db,
    bars.map((b) => ({
      underlying: 'BTC',
      obsDate: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      source,
    })),
  );

  return bars.length;
}
