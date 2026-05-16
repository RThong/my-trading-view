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
import { QUOTE_SYMBOLS, MACRO_SERIES } from '../config';

type QuoteSymbol = { symbol: string; label: string; group: string };
type MacroSpec = { id: string; label: string; unit: string };

type RunDailyJobOpts = {
  db: Database;
  quoteSymbols: QuoteSymbol[];
  macroSeries: MacroSpec[];
  yahoo: { fetchDailyBars(symbol: string, since: Date): Promise<QuoteRow[]> };
  fred: { fetchSeries(seriesId: string, since: string): Promise<MacroRow[]> };
  historyDays: number;
};

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400_000);
}

export async function runDailyJob(opts: RunDailyJobOpts): Promise<void> {
  // quotes group
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

  // macro group
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
}

// CLI entry
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const fredKey = process.env.FRED_API_KEY ?? '';
  await runDailyJob({
    db,
    quoteSymbols: QUOTE_SYMBOLS,
    macroSeries: MACRO_SERIES,
    yahoo: createYahooFetcher(),
    fred: createFredFetcher({ apiKey: fredKey }),
    historyDays: 180,
  });
  db.close();
  console.log('Daily job complete.');
}
