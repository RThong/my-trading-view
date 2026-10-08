/**
 * 更新 VRP 输入 + 标的现货到库:
 *   隐含腿 → market_series(close):VIX/VXN/GVZ/OVX(CBOE)+ DVOL(Deribit)
 *   标的现货 → price_eod(OHLC):SPY/QQQ/GLD/USO/TLT/NOBL + VIX
 *     - ETF(SPY/QQQ/GLD/USO/TLT/NOBL):Yahoo close(唯一源)、每轮全量重拉
 *       口径 = 只调拆股、不调分红(TradingView 默认 / IBKR TRADES / moomoo App 显示同一个数)
 *     - VIX:CBOE(它既是 SPY 的 IV 腿,又是 .VIX tab 的现货,故两表都写)
 *     - BTC 现货:已移出本 job → cryptoDaily 的 btc_price 组(7 天跑,含周末)。
 *   VRP 的 RV 腿读 price_eod 的 close;基准对应 VIX↔SPY、VXN↔QQQ、GVZ↔GLD、OVX↔USO、DVOL↔BTC
 *   (BTC 的 price_eod 由 cryptoDaily 填,本 job 仍只负责读时无关的隐含腿/ETF 现货)。
 *
 * `updateVrpInputs` 除 ETF 现货外增量更新(按各序列已存最新日期续抓),库空时自动从 HISTORY_START_DATE
 * / DVOL 上线日全量回填。upsert 幂等,可重复跑。
 *
 * 直接运行 = 立即更新一次:bun run src/server/jobs/vrpInputs.ts
 */
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getLatestMarketDate, insertPriceEod, getLatestPriceDate } from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchDvolHistory } from '../fetchers/deribitDvol';
import type { Bar } from '../fetchers/moomooHistoryKL';
import { HISTORY_START_DATE } from '../config';
import { lastClosedTradingDate } from './tradingCalendar';
import { cboeIvLegs, priceLegUnderlyings } from '../../shared/marketCatalog';

const DVOL_START = '2021-01-01'; // DVOL(BTC)上线约 2021 年

export type VrpInputsResult = {
  total: number;
  succeeded: number;
  /** 失败的源,形如 'DVOL: <原因>';由上层 job 据此记 success/partial/failed。 */
  failures: string[];
};

export async function updateVrpInputs(db: Database): Promise<VrpInputsResult> {
  let total = 0;
  let succeeded = 0;
  const failures: string[] = [];

  const add = (id: string, rows: Array<{ obsDate: string; value: number }>) => {
    insertMarketSeries(
      db,
      rows.map((r) => ({ seriesId: id, obsDate: r.obsDate, value: r.value })),
    );
    total += rows.length;
  };
  // 每个源独立容错:一个源失败(抓取/解析出错)只记下来,不中断其它源。
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      succeeded++;
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  };

  const yahoo = createYahooFetcher();
  const yahooBars = async (sym: string, since: Date): Promise<Bar[]> =>
    (await yahoo.fetchDailyBars(sym, since)).map((r) => ({
      date: r.tradeDate,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    }));
  const writePrice = (u: string, bars: Bar[], source: string) => {
    insertPriceEod(
      db,
      bars.map((b) => ({
        underlying: u,
        obsDate: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        source,
      })),
    );
    total += bars.length;
  };

  // ── 隐含腿 → market_series(CBOE:VXN/GVZ/OVX;VIX 走下方 VX 链路双写,DVOL 走 Deribit)──
  for (const sym of cboeIvLegs()) {
    await run(sym, async () => {
      const rows = await fetchCboeIndexAsQuotes({
        cboeSymbol: sym,
        storedSymbol: sym,
        afterDate: getLatestMarketDate(db, sym) ?? undefined,
      });
      add(
        sym,
        rows.map((r) => ({ obsDate: r.tradeDate, value: r.close })),
      );
    });
  }
  // VIX:既是 SPY 的 IV 腿(market_series close),又是 .VIX 的现货(price_eod OHLC),两表都写。
  await run('VIX', async () => {
    const mkt = await fetchCboeIndexAsQuotes({
      cboeSymbol: 'VIX',
      storedSymbol: 'VIX',
      afterDate: getLatestMarketDate(db, 'VIX') ?? undefined,
    });
    add(
      'VIX',
      mkt.map((r) => ({ obsDate: r.tradeDate, value: r.close })),
    );
    const px = await fetchCboeIndexAsQuotes({
      cboeSymbol: 'VIX',
      storedSymbol: 'VIX',
      afterDate: getLatestPriceDate(db, 'VIX') ?? undefined,
    });
    writePrice(
      'VIX',
      px.map((r) => ({ date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close })),
      'cboe',
    );
  });
  await run('DVOL', async () => {
    const dvolLatest = getLatestMarketDate(db, 'DVOL');
    const dvolStart = dvolLatest ? new Date(dvolLatest + 'T00:00:00Z').getTime() : new Date(DVOL_START).getTime();
    const dvol = await fetchDvolHistory('BTC', dvolStart, Date.now());
    add(
      'DVOL',
      dvol.map((d) => ({ obsDate: d.date, value: d.value })),
    );
  });

  // ── 标的现货 OHLC → price_eod ──
  // Yahoo close(唯一源),**每轮全量重拉**:Yahoo 的历史会随新拆股整段改写,增量续抓会把两套基准拼进库
  // (前复权时代的 moomoo 就这么坏过,见 fetchers/moomooHistoryKL)。一次 chart 请求即 2018 起全段,代价可忽略。
  // 不设降级:moomoo 两种口径都接不上(见 fetchers/moomooHistoryKL 顶部);失败只记 failures,库里保留上一轮的整段,下轮自愈。
  // 滤掉未收盘的当天:盘中手动跑时那根是半截价,不该落库。
  const lastClosed = lastClosedTradingDate(); // 整批同一截止日
  for (const u of priceLegUnderlyings()) {
    await run(u, async () => {
      const bars = (await yahooBars(u, new Date(HISTORY_START_DATE))).filter((b) => b.date <= lastClosed);
      if (!bars.length) throw new Error('Yahoo 返回空序列');
      writePrice(u, bars, 'yahoo');
    });
  }

  return { total, succeeded, failures };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total, failures } = await updateVrpInputs(db);
  db.close();
  console.log(`VRP inputs updated: ${total} rows upserted.${failures.length ? ` 失败源: ${failures.join('; ')}` : ''}`);
}
