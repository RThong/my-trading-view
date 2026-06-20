import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import {
  insertQuotes,
  insertMacro,
  getLatestQuoteDate,
  getLatestMacroDate,
  startJobRun,
  finishJobRun,
  type QuoteRow,
  type MacroRow,
} from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import { createFredFetcher } from '../fetchers/fred';
import { QUOTE_SYMBOLS, MACRO_SERIES, CBOE_INDEX_SYMBOLS, OPTIONS_UNDERLYINGS, DERIBIT_UNDERLYINGS } from '../config';
import { defaultMoomooOptionsClient } from '../fetchers/moomooOptions';
import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';
import { runOptionsSnapshot, type OptionsChainClient } from './optionsSnapshot';
import { fetchVxFrontMonthSeries } from '../fetchers/cboeVx';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';

type QuoteSymbol = { symbol: string; label: string; group: string };
type MacroSpec = { id: string; label: string; unit: string };
type CboeIndexSpec = { symbol: string; cboeSymbol: string; label: string; group: string };

type RunDailyJobOpts = {
  db: Database;
  quoteSymbols: QuoteSymbol[];
  macroSeries: MacroSpec[];
  yahoo: { fetchDailyBars(symbol: string, since: Date): Promise<QuoteRow[]> };
  fred: { fetchSeries(seriesId: string, since: string): Promise<MacroRow[]> };
  historyDays: number;
  cboeIndices?: CboeIndexSpec[];
  /** moomoo 期权标的(如 ['SPY', '.VIX'])。需配合 optionsClient 使用。 */
  optionsUnderlyings?: string[];
  optionsClient?: OptionsChainClient;
  /** Deribit 加密期权标的(如 ['BTC'])。需配合 cryptoOptionsClient 使用。 */
  cryptoOptionsUnderlyings?: string[];
  cryptoOptionsClient?: OptionsChainClient;
  fetchVxFutures?: boolean;
};

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400_000);
}

/** 跑一组期权快照并记一个 job_run(单标的失败 → partial,全失败 → failed)。 */
async function runOptionsGroup(
  db: Database,
  jobName: string,
  underlyings: string[],
  client: OptionsChainClient,
): Promise<void> {
  const runId = startJobRun(db, jobName);
  try {
    const { rows, failures } = await runOptionsSnapshot({ db, underlyings, client });
    if (failures.length === 0) {
      finishJobRun(db, runId, { status: 'success', recordsWritten: rows.length });
    } else if (rows.length === 0) {
      finishJobRun(db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(db, runId, { status: 'partial', recordsWritten: rows.length, error: failures.join('; ') });
    }
  } catch (err) {
    finishJobRun(db, runId, { status: 'failed', error: (err as Error).message });
  }
}

export async function runDailyJob(opts: RunDailyJobOpts): Promise<void> {
  // quotes 分组
  if (opts.quoteSymbols.length > 0) {
    const runId = startJobRun(opts.db, 'quotes');
    const failures: string[] = [];
    let total = 0;
    for (const { symbol } of opts.quoteSymbols) {
      try {
        const latest = getLatestQuoteDate(opts.db, symbol);
        const since = latest ? new Date(latest + 'T00:00:00Z') : daysAgo(opts.historyDays);
        const rows = await opts.yahoo.fetchDailyBars(symbol, since);

        insertQuotes(opts.db, rows, 'yahoo');
        total += rows.length;
      } catch (err) {
        failures.push(`${symbol}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      finishJobRun(opts.db, runId, { status: 'success', recordsWritten: total });
    } else if (failures.length === opts.quoteSymbols.length) {
      finishJobRun(opts.db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(opts.db, runId, { status: 'partial', recordsWritten: total, error: failures.join('; ') });
    }
  }

  // cboe_indices 分组(VIX 系列、SKEW、RXM —— 直接取自 CBOE CDN,含 1990 年至今的历史)
  if (opts.cboeIndices && opts.cboeIndices.length > 0) {
    const runId = startJobRun(opts.db, 'cboe_indices');
    const failures: string[] = [];
    let total = 0;
    for (const spec of opts.cboeIndices) {
      try {
        const latest = getLatestQuoteDate(opts.db, spec.symbol);
        const rows = await fetchCboeIndexAsQuotes({
          cboeSymbol: spec.cboeSymbol,
          storedSymbol: spec.symbol,
          afterDate: latest ?? undefined,
        });

        insertQuotes(opts.db, rows, 'cboe');
        total += rows.length;
      } catch (err) {
        failures.push(`${spec.symbol}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      finishJobRun(opts.db, runId, { status: 'success', recordsWritten: total });
    } else if (failures.length === opts.cboeIndices.length) {
      finishJobRun(opts.db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(opts.db, runId, { status: 'partial', recordsWritten: total, error: failures.join('; ') });
    }
  }

  // macro 分组
  if (opts.macroSeries.length > 0) {
    const runId = startJobRun(opts.db, 'macro');
    const failures: string[] = [];
    let total = 0;
    for (const { id } of opts.macroSeries) {
      try {
        const latest = getLatestMacroDate(opts.db, id);
        const since = latest ?? daysAgo(opts.historyDays).toISOString().slice(0, 10);
        const rows = await opts.fred.fetchSeries(id, since);

        insertMacro(opts.db, rows);
        total += rows.length;
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      finishJobRun(opts.db, runId, { status: 'success', recordsWritten: total });
    } else if (failures.length === opts.macroSeries.length) {
      finishJobRun(opts.db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(opts.db, runId, { status: 'partial', recordsWritten: total, error: failures.join('; ') });
    }
  }

  // options 分组(moomoo OpenD = 股票/ETF/指数;Deribit = 加密)。
  // 两类用不同抓取器,各记一个 job,互不连累。
  if (opts.optionsUnderlyings?.length && opts.optionsClient) {
    await runOptionsGroup(opts.db, 'options', opts.optionsUnderlyings, opts.optionsClient);
  }
  if (opts.cryptoOptionsUnderlyings?.length && opts.cryptoOptionsClient) {
    await runOptionsGroup(opts.db, 'options_crypto', opts.cryptoOptionsUnderlyings, opts.cryptoOptionsClient);
  }

  // vx_futures 分组(CBOE VIX 期货近月连续序列,以 quote_eod symbol='VX1' 存储)
  if (opts.fetchVxFutures) {
    const runId = startJobRun(opts.db, 'vx_futures');
    try {
      // 只重新拉取到期未超过 7 天的合约。它们的历史数据不会变,
      // 但我们想捕捉到任何延迟的结算修正。
      const lookbackStart = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const rows = await fetchVxFrontMonthSeries({ freshSince: lookbackStart });
      insertQuotes(opts.db, rows, 'cboe');
      finishJobRun(opts.db, runId, { status: 'success', recordsWritten: rows.length });
    } catch (err) {
      finishJobRun(opts.db, runId, { status: 'failed', error: (err as Error).message });
    }
  }
}

// CLI 入口
if (import.meta.main) {
  const db = openDb();
  migrate(db);

  const fredKey = process.env.FRED_API_KEY ?? '';

  await runDailyJob({
    db,
    quoteSymbols: QUOTE_SYMBOLS,
    macroSeries: MACRO_SERIES,
    cboeIndices: CBOE_INDEX_SYMBOLS,
    yahoo: createYahooFetcher(),
    fred: createFredFetcher({ apiKey: fredKey }),
    historyDays: 180,
    optionsUnderlyings: OPTIONS_UNDERLYINGS,
    optionsClient: defaultMoomooOptionsClient(),
    cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
    cryptoOptionsClient: defaultDeribitOptionsClient(),
    fetchVxFutures: true,
  });

  db.close();
  console.log('Daily job complete.');
}
