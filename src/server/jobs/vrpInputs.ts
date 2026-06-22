/**
 * 更新 VRP 输入序列到 market_series。隐含腿 = 免费波动率指数,RV 腿 = 对应基准现货:
 *   隐含腿:VIX/VXN/GVZ/OVX (CBOE CSV) + DVOL (Deribit)
 *   RV 腿(日线 close):SPY/QQQ/GLD/USO + BTC
 *     - ETF(SPY/QQQ/GLD/USO):moomoo 历史 K 线为主源(准、前复权),Yahoo 为降级
 *     - BTC:Deribit(BTC-PERPETUAL)为主源,Yahoo(BTC-USD)为降级
 *     - 指数 moomoo 取不到,故 RV 统一用 ETF:SPY≈SPX、QQQ≈NDX,对 RV(百分比收益)可忽略
 *   基准对应:VIX↔SPY、VXN↔QQQ、GVZ↔GLD、OVX↔USO、DVOL↔BTC。
 *   moomoo 主源需 OpenD;OpenD 没起时 ETF 腿整体回退 Yahoo,管线仍跑通。
 *
 * `updateVrpInputs` 增量更新(按各序列已存最新日期续抓),既用于 daily job,
 * 也用于首次全量回填(库空时自动从 HISTORY_START_DATE / DVOL 上线日拉起)。
 * upsert 幂等,可重复跑。
 *
 * 直接运行 = 立即更新一次:bun run src/server/jobs/vrpInputs.ts
 */
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getLatestMarketDate } from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchDvolHistory } from '../fetchers/deribitDvol';
import { fetchBtcDailyClose } from '../fetchers/deribitBtcPrice';
import { connect, disconnect, envConfig } from '../fetchers/moomooClient';
import { fetchDailyClose } from '../fetchers/moomooHistoryKL';
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
    try {
      await fn();
      succeeded++;
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  };

  // 隐含腿:CBOE 免费波动率指数 CSV(VIX=SPX, VXN=NDX, GVZ=GLD, OVX=USO)
  for (const sym of ['VIX', 'VXN', 'GVZ', 'OVX'] as const) {
    await run(sym, async () => {
      const rows = await fetchCboeIndexAsQuotes({ cboeSymbol: sym, storedSymbol: sym, afterDate: getLatestMarketDate(db, sym) ?? undefined });
      add(sym, rows.map((r) => ({ obsDate: r.tradeDate, value: r.close })));
    });
  }

  // RV 腿:基准现货日线 close。ETF 走 moomoo 主 + Yahoo 降级;BTC 走 Deribit 主 + Yahoo 降级。
  const yahoo = createYahooFetcher();
  const sinceFor = (id: string): Date => {
    const latest = getLatestMarketDate(db, id);
    return latest ? new Date(latest + 'T00:00:00Z') : new Date(HISTORY_START_DATE);
  };
  type Pt = { obsDate: string; value: number };
  const yahooClose = async (sym: string, since: Date): Promise<Pt[]> =>
    (await yahoo.fetchDailyBars(sym, since)).map((r) => ({ obsDate: r.tradeDate, value: r.close }));
  // 主源失败就降级 Yahoo:ETF/BTC 同形,收口到一处。
  const close = async (id: string, primary: () => Promise<Pt[]>, fbSym: string, since: Date): Promise<Pt[]> => {
    try { return await primary(); }
    catch (e) {
      console.warn(`[vrpInputs] ${id} 主源失败,降级 Yahoo: ${(e as Error).message}`);
      return yahooClose(fbSym, since);
    }
  };

  // moomoo 连接:连不上(OpenD 没起)→ mooWs=null,ETF 腿整体回退 Yahoo;单标的失败也各自回退。
  let mooWs: any = null;
  try { mooWs = await connect(envConfig()); } catch { /* OpenD 不可用,留 null */ }
  try {
    for (const id of ['SPY', 'QQQ', 'GLD', 'USO'] as const) {
      await run(id, async () => {
        const since = sinceFor(id);
        add(id, await close(id, async () => {
          if (!mooWs) throw new Error('OpenD unavailable');
          return (await fetchDailyClose(mooWs, id, since)).map((k) => ({ obsDate: k.date, value: k.close }));
        }, id, since));
      });
    }
  } finally {
    if (mooWs) disconnect(mooWs);
  }

  // BTC:Deribit(BTC-PERPETUAL)主 + Yahoo(BTC-USD)降级
  await run('BTC', async () => {
    const since = sinceFor('BTC');
    add('BTC', await close('BTC', async () =>
      (await fetchBtcDailyClose(since.getTime(), Date.now())).map((k) => ({ obsDate: k.date, value: k.close })),
      'BTC-USD', since));
  });

  // DVOL(Deribit 波动率指数)
  await run('DVOL', async () => {
    const dvolLatest = getLatestMarketDate(db, 'DVOL');
    const dvolStart = dvolLatest ? new Date(dvolLatest + 'T00:00:00Z').getTime() : new Date(DVOL_START).getTime();
    const dvol = await fetchDvolHistory('BTC', dvolStart, Date.now());
    add('DVOL', dvol.map((d) => ({ obsDate: d.date, value: d.value })));
  });

  return { total, succeeded, failures };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total, failures } = await updateVrpInputs(db);
  db.close();
  console.log(`VRP inputs updated: ${total} rows upserted.${failures.length ? ` 失败源: ${failures.join('; ')}` : ''}`);
}
