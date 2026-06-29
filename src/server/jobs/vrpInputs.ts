/**
 * 更新 VRP 输入 + 标的现货到库:
 *   隐含腿 → market_series(close):VIX/VXN/GVZ/OVX(CBOE)+ DVOL(Deribit)
 *   标的现货 → price_eod(OHLC):SPY/QQQ/GLD/USO/TLT + VIX
 *     - ETF(SPY/QQQ/GLD/USO/TLT):moomoo 历史 K 线为主源(准、前复权),Yahoo 降级
 *     - VIX:CBOE(它既是 SPY 的 IV 腿,又是 .VIX tab 的现货,故两表都写)
 *     - BTC 现货:已移出本 job → cryptoDaily 的 btc_price 组(7 天跑,含周末)。
 *   VRP 的 RV 腿读 price_eod 的 close;基准对应 VIX↔SPY、VXN↔QQQ、GVZ↔GLD、OVX↔USO、DVOL↔BTC
 *   (BTC 的 price_eod 由 cryptoDaily 填,本 job 仍只负责读时无关的隐含腿/ETF 现货)。
 *   moomoo 主源需 OpenD;没起时 ETF 腿整体回退 Yahoo,管线仍跑通。
 *
 * `updateVrpInputs` 增量更新(按各序列已存最新日期续抓),库空时自动从 HISTORY_START_DATE
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
import { connect, disconnect, envConfig } from '../fetchers/moomooClient';
import { fetchDailyBars, type Bar } from '../fetchers/moomooHistoryKL';
import { HISTORY_START_DATE } from '../config';

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
    insertMarketSeries(db, rows.map((r) => ({ seriesId: id, obsDate: r.obsDate, value: r.value })));
    total += rows.length;
  };
  // 每个源独立容错:一个源失败(抓取/解析出错)只记下来,不中断其它源。
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); succeeded++; }
    catch (err) { failures.push(`${name}: ${(err as Error).message}`); }
  };

  const yahoo = createYahooFetcher();
  const yahooBars = async (sym: string, since: Date): Promise<Bar[]> =>
    (await yahoo.fetchDailyBars(sym, since)).map((r) => ({ date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close }));
  const sincePrice = (u: string): Date => {
    const latest = getLatestPriceDate(db, u);
    return latest ? new Date(latest + 'T00:00:00Z') : new Date(HISTORY_START_DATE);
  };
  const writePrice = (u: string, bars: Bar[], source: string) => {
    insertPriceEod(db, bars.map((b) => ({ underlying: u, obsDate: b.date, open: b.open, high: b.high, low: b.low, close: b.close, source })));
    total += bars.length;
  };
  // 标的现货:主源(moomoo/deribit)失败 → 降级 Yahoo,各自标 source。
  const priceLeg = (u: string, primary: (since: Date) => Promise<Bar[]>, primarySrc: string, fbSym: string) =>
    run(u, async () => {
      const since = sincePrice(u);
      try { writePrice(u, await primary(since), primarySrc); }
      catch (e) {
        console.warn(`[vrpInputs] ${u} 主源失败,降级 Yahoo: ${(e as Error).message}`);
        writePrice(u, await yahooBars(fbSym, since), 'yahoo');
      }
    });

  // ── 隐含腿 → market_series ──
  for (const sym of ['VXN', 'GVZ', 'OVX'] as const) {
    await run(sym, async () => {
      const rows = await fetchCboeIndexAsQuotes({ cboeSymbol: sym, storedSymbol: sym, afterDate: getLatestMarketDate(db, sym) ?? undefined });
      add(sym, rows.map((r) => ({ obsDate: r.tradeDate, value: r.close })));
    });
  }
  // VIX:既是 SPY 的 IV 腿(market_series close),又是 .VIX 的现货(price_eod OHLC),两表都写。
  await run('VIX', async () => {
    const mkt = await fetchCboeIndexAsQuotes({ cboeSymbol: 'VIX', storedSymbol: 'VIX', afterDate: getLatestMarketDate(db, 'VIX') ?? undefined });
    add('VIX', mkt.map((r) => ({ obsDate: r.tradeDate, value: r.close })));
    const px = await fetchCboeIndexAsQuotes({ cboeSymbol: 'VIX', storedSymbol: 'VIX', afterDate: getLatestPriceDate(db, 'VIX') ?? undefined });
    writePrice('VIX', px.map((r) => ({ date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close })), 'cboe');
  });
  await run('DVOL', async () => {
    const dvolLatest = getLatestMarketDate(db, 'DVOL');
    const dvolStart = dvolLatest ? new Date(dvolLatest + 'T00:00:00Z').getTime() : new Date(DVOL_START).getTime();
    const dvol = await fetchDvolHistory('BTC', dvolStart, Date.now());
    add('DVOL', dvol.map((d) => ({ obsDate: d.date, value: d.value })));
  });

  // ── 标的现货 OHLC → price_eod ──
  let mooWs: any = null;
  try { mooWs = await connect(envConfig()); } catch { /* OpenD 不可用,ETF 腿整体回退 Yahoo */ }
  try {
    for (const u of ['SPY', 'QQQ', 'GLD', 'USO', 'TLT'] as const) {
      await priceLeg(u, (since) => {
        if (!mooWs) throw new Error('OpenD unavailable');
        return fetchDailyBars(mooWs, u, since);
      }, 'moomoo', u);
    }
  } finally {
    if (mooWs) disconnect(mooWs);
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
