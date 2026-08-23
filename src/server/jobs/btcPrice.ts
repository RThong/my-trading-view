/**
 * BTC 现货日 bar 抓取(Deribit BTC-PERPETUAL 主源,Yahoo BTC-USD 降级)→ price_eod。
 * 原在 vrpInputs 的 priceLeg('BTC') 中;独立出来由 7 天的 cryptoDaily 调用,
 * 让 BTC 现货含周末、与 BTC 期权同节奏。增量:since 从 price_eod 已存最新 BTC 日期续抓。
 * opts 仅供测试注入假 fetcher;默认用真实 Deribit / Yahoo。
 */
import type { Database } from 'bun:sqlite';
import { getEarliestPriceDate, getLatestPriceDate, insertPriceEod } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';
import { fetchBtcDailyBars } from '../fetchers/deribitBtcPrice';
import { fetchBitstampBtcDaily } from '../fetchers/bitstampBtcHistory';
import { createYahooFetcher } from '../fetchers/yahoo';
import type { Bar } from '../fetchers/moomooHistoryKL';

type BarsFetcher = (since: Date) => Promise<Bar[]>;

/**
 * BTC 历史起点。比全站 HISTORY_START_DATE(2018-01-01)早得多是刻意的:
 * 1Y 滚动夏普那格要看「每轮周期顶部是否递减」,只有两轮拟合不出来,得把 2013/2017 两轮也纳进来。
 * 早于 Deribit 上线(2018-08)的部分从 Bitstamp 补,见 fetchers/bitstampBtcHistory。
 */
const BTC_HISTORY_START = '2012-01-01';

/**
 * Bitstamp 段的右边界 = Deribit BTC-PERPETUAL 第一根日线(2018-08-14,实测)的前一天。
 * **写死是刻意的**:用「库里最早那天 −1」当边界会让分段随当天增量的结果漂 ——
 * 空库时 Deribit 降级 Yahoo(只到 2014-09)会让 Bitstamp 早停,Deribit 回空数组
 * 更会让 Bitstamp 一路写到今天、把 Deribit 该管的整段占掉。这个边界是历史事实,不会变。
 * 边界落在 Deribit 第一天之前 → 固定区间与 Deribit 的行天然不重叠,upsert 覆盖不到它们。
 */
const BITSTAMP_SEGMENT_END = '2018-08-13';

/**
 * 补 Deribit 之前的历史。判据是「库里最早那天还晚于 BTC_HISTORY_START」——
 * 补齐之后每天都判 false 直接返回,不发请求,所以放在每日 job 里也不浪费。
 * 失败只 warn:历史是静态的,下次触发再补;不能让它拖垮当天的增量更新。
 */
async function backfillPreDeribit(db: Database, fetcher: typeof fetchBitstampBtcDaily): Promise<number> {
  const earliest = getEarliestPriceDate(db, 'BTC');
  if (earliest && earliest <= BTC_HISTORY_START) return 0;

  try {
    const bars = await fetcher(BTC_HISTORY_START, BITSTAMP_SEGMENT_END);
    insertPriceEod(
      db,
      bars.map((b) => ({
        underlying: 'BTC',
        obsDate: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        source: 'bitstamp',
      })),
    );
    return bars.length;
  } catch (e) {
    console.warn(`[btcPrice] Bitstamp 历史回填失败(不影响增量): ${(e as Error).message}`);
    return 0;
  }
}

export async function updateBtcPrice(
  db: Database,
  opts?: { deribit?: BarsFetcher; yahoo?: BarsFetcher; bitstamp?: typeof fetchBitstampBtcDaily },
): Promise<number> {
  const deribit: BarsFetcher = opts?.deribit ?? ((since) => fetchBtcDailyBars(since.getTime(), Date.now()));
  const yahoo: BarsFetcher =
    opts?.yahoo ??
    (async (since) =>
      (await createYahooFetcher().fetchDailyBars('BTC-USD', since)).map((r) => ({
        date: r.tradeDate,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
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
  const backfilled = await backfillPreDeribit(db, opts?.bitstamp ?? fetchBitstampBtcDaily);
  return bars.length + backfilled;
}
